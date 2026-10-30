-- ============ RECEBAA: pedidos deixam de ser legíveis/graváveis diretamente pela chave pública ============
-- Leitura e escrita de pedidos passam por funções que validam login (equipe) ou o guarda-sol (cliente).
-- O tempo real passa a usar order_events (sem nome de cliente nem observações).

-- ---------- eventos de pedido (sem dados pessoais) ----------
create table if not exists public.order_events (
  event_id bigserial primary key,
  kind text not null,
  id uuid not null,
  kiosk_id uuid not null,
  umbrella_num text,
  customer_name text,
  status text,
  order_number integer,
  total numeric,
  service_amount numeric,
  last_updated_by text,
  created_at timestamptz,
  event_at timestamptz not null default now()
);
create index if not exists order_events_kiosk_idx on public.order_events(kiosk_id, event_at);
alter table public.order_events enable row level security;
drop policy if exists order_events_read on public.order_events;
create policy order_events_read on public.order_events for select to anon using (true);
grant select on public.order_events to anon;

create or replace function private.log_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.order_events(kind, id, kiosk_id, umbrella_num, customer_name, status, order_number, total, service_amount, last_updated_by, created_at)
  values (case when tg_op = 'INSERT' then 'insert' else 'update' end, new.id, new.kiosk_id, new.umbrella_num,
          case when new.customer_name in ('PEDIDO DE CONTA','CHAMADA DE ATENDENTE','ENCERRAMENTO') then new.customer_name end,
          new.status::text, new.order_number, new.total, new.service_amount, new.last_updated_by, new.created_at);
  if random() < 0.02 then
    delete from public.order_events where event_at < now() - interval '1 hour';
  end if;
  return null;
end $$;

drop trigger if exists trg_order_events on public.orders;
create trigger trg_order_events after insert or update on public.orders
  for each row execute function private.log_order_event();

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_events') then
    alter publication supabase_realtime add table public.order_events;
  end if;
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime drop table public.orders;
  end if;
end $$;

-- ---------- leitura ----------
create or replace function public.read_orders(
  p_token text default null, p_kiosk uuid default null, p_umbrella text default null,
  p_filters jsonb default '[]'::jsonb, p_order text default 'created_at desc', p_limit int default 1000, p_items boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.app_sessions; wh text[] := array[]::text[]; f jsonb; c text; op text; vals text;
  col text; dir text; lim int; extra text := ''; sql text; res jsonb; hasidem boolean := false;
begin
  if p_token is not null then
    s := private.get_session(p_token);
    if s.role = 'admin' then
      extra := extra || $x$ || jsonb_build_object('kiosks', (select jsonb_build_object('name', k.name) from public.kiosks k where k.id = o.kiosk_id))$x$;
      if p_kiosk is not null then wh := wh || format('o.kiosk_id = %L', p_kiosk); end if;
    else
      s := private.staff_session(p_token);
      wh := wh || format('o.kiosk_id = %L', s.kiosk_id);
    end if;
  end if;

  for f in select * from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) loop
    c := f->>'c'; op := f->>'o';
    if c not in ('id','kiosk_id','umbrella_num','customer_name','status','created_at','idempotency_key','order_number') then
      raise exception 'Filtro inválido';
    end if;
    if c = 'idempotency_key' and op = 'eq' then hasidem := true; end if;
    if op in ('eq','neq','gt','gte','lte') then
      wh := wh || format('o.%I %s %L', c,
        case op when 'eq' then '=' when 'neq' then '<>' when 'gt' then '>' when 'gte' then '>=' else '<=' end, f->>'v');
    elsif op in ('in','nin') then
      select string_agg(format('%L', x), ',') into vals from jsonb_array_elements_text(f->'v') x;
      wh := wh || format('o.%I::text %s (%s)', c, case op when 'in' then 'in' else 'not in' end, coalesce(vals, 'NULL'));
    else
      raise exception 'Operador inválido';
    end if;
  end loop;

  if p_token is null then
    if p_kiosk is not null and p_umbrella is not null then
      wh := wh || format('o.kiosk_id = %L', p_kiosk) || format('o.umbrella_num = %L', p_umbrella);
    elsif not hasidem then
      raise exception 'Acesso negado' using errcode = '42501';
    end if;
  end if;

  col := split_part(coalesce(p_order, 'created_at desc'), ' ', 1);
  dir := case when lower(split_part(coalesce(p_order, ''), ' ', 2)) = 'asc' then 'asc' else 'desc' end;
  if col not in ('created_at','order_number') then col := 'created_at'; end if;
  lim := greatest(1, least(coalesce(p_limit, 1000), 2000));

  if p_items then
    extra := extra || $x$ || jsonb_build_object('order_items', coalesce((select jsonb_agg(to_jsonb(i)) from public.order_items i where i.order_id = o.id), '[]'::jsonb))$x$;
  end if;

  sql := format($q$select coalesce(jsonb_agg(r.j order by r.k %1$s), '[]'::jsonb)
                    from (select (to_jsonb(o) %2$s) as j, o.%3$I as k from public.orders o %4$s order by o.%3$I %1$s limit %5$s) r$q$,
                dir, extra, col,
                case when array_length(wh, 1) is null then '' else 'where ' || array_to_string(wh, ' and ') end, lim);
  execute sql into res;
  return res;
end $$;

create or replace function public.order_items_of(p_order_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) from public.order_items i where i.order_id = p_order_id
$$;

create or replace function public.staff_item(p_token text, p_item_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; r jsonb;
begin
  s := private.staff_session(p_token);
  select to_jsonb(i) into r from public.order_items i join public.orders o on o.id = i.order_id
   where i.id = p_item_id and o.kiosk_id = s.kiosk_id;
  return r;
end $$;

-- ---------- escrita ----------
create or replace function private.insert_items(p_order_id uuid, p_items jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare it jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce((it->>'quantity')::int, 0) < 1 or (it->>'quantity')::int > 999 then raise exception 'Quantidade inválida'; end if;
    if coalesce((it->>'unit_price')::numeric, 0) < 0 or coalesce((it->>'unit_price')::numeric, 0) > 100000 then raise exception 'Preço inválido'; end if;
    if length(coalesce(it->>'product_name', '')) < 1 or length(it->>'product_name') > 200 then raise exception 'Item inválido'; end if;
    if length(coalesce(it->>'notes', '')) > 1000 then raise exception 'Observação muito longa'; end if;
    insert into public.order_items(order_id, product_id, product_name, quantity, unit_price, cost_price, notes, emoji, is_promo)
    select p_order_id, r.product_id, r.product_name, r.quantity, coalesce(r.unit_price, 0), r.cost_price, r.notes, r.emoji, coalesce(r.is_promo, false)
      from jsonb_populate_record(null::public.order_items, it) r;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.place_order(p_order jsonb, p_items jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare kid uuid; ok boolean; n int; obj jsonb; res jsonb; new_id uuid;
begin
  kid := (p_order->>'kiosk_id')::uuid;
  select (k.is_active and not coalesce(k.blocked, false)) into ok from public.kiosks k where k.id = kid;
  if not coalesce(ok, false) then raise exception 'Negócio indisponível'; end if;
  select count(*) into n from public.orders o where o.kiosk_id = kid and o.created_at > now() - interval '1 minute';
  if n >= 120 then raise exception 'Muitos pedidos em pouco tempo. Tente novamente.'; end if;
  if length(coalesce(p_order->>'customer_name', '')) > 80 or length(coalesce(p_order->>'notes', '')) > 2000
     or length(coalesce(p_order->>'umbrella_num', '')) > 20 or length(coalesce(p_order->>'idempotency_key', '')) > 100
     or length(coalesce(p_order->>'created_by', '')) > 80 or length(coalesce(p_order->>'last_updated_by', '')) > 80 then
    raise exception 'Dados inválidos';
  end if;
  if coalesce((p_order->>'total')::numeric, 0) < 0 or coalesce((p_order->>'total')::numeric, 0) > 1000000
     or coalesce((p_order->>'service_amount')::numeric, 0) < 0 or coalesce((p_order->>'service_amount')::numeric, 0) > 1000000 then
    raise exception 'Total inválido';
  end if;
  obj := jsonb_strip_nulls(jsonb_build_object(
    'kiosk_id', kid, 'umbrella_num', p_order->>'umbrella_num', 'customer_name', p_order->>'customer_name',
    'notes', p_order->>'notes', 'status', coalesce(p_order->>'status', 'pending'),
    'total', coalesce((p_order->>'total')::numeric, 0), 'idempotency_key', p_order->>'idempotency_key',
    'created_by', p_order->>'created_by', 'last_updated_by', p_order->>'last_updated_by',
    'service_amount', (p_order->>'service_amount')::numeric));
  insert into public.orders(kiosk_id, umbrella_num, customer_name, notes, status, total, idempotency_key, created_by, last_updated_by, service_amount)
  select r.kiosk_id, r.umbrella_num, r.customer_name, r.notes, r.status, r.total, r.idempotency_key, r.created_by, r.last_updated_by, r.service_amount
    from jsonb_populate_record(null::public.orders, obj) r
  returning to_jsonb(orders.*), orders.id into res, new_id;
  if p_items is not null then perform private.insert_items(new_id, p_items); end if;
  return res;
end $$;

create or replace function public.add_order_items(p_items jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; grp record;
begin
  for grp in select (x->>'order_id')::uuid as ord_id, jsonb_agg(x) as arr from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x group by 1 loop
    if not exists (select 1 from public.orders o where o.id = grp.ord_id and o.created_at > now() - interval '15 minutes') then
      raise exception 'Pedido não encontrado ou muito antigo';
    end if;
    n := n + private.insert_items(grp.ord_id, grp.arr);
  end loop;
  return n;
end $$;

create or replace function public.client_cancel_order(p_order_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  with u as (update public.orders o set status = 'cancelled' where o.id = p_order_id and o.status = 'pending' returning o.*)
  select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from u
$$;

-- ---------- fecha o acesso direto ----------
drop policy if exists orders_read on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists order_items_read on public.order_items;
drop policy if exists order_items_insert on public.order_items;
revoke all on public.orders, public.order_items from anon, authenticated;

revoke execute on function
  public.read_orders(text,uuid,text,jsonb,text,int,boolean), public.order_items_of(uuid), public.staff_item(text,uuid),
  public.place_order(jsonb,jsonb), public.add_order_items(jsonb), public.client_cancel_order(uuid)
from public, anon, authenticated;
grant execute on function
  public.read_orders(text,uuid,text,jsonb,text,int,boolean), public.order_items_of(uuid), public.staff_item(text,uuid),
  public.place_order(jsonb,jsonb), public.add_order_items(jsonb), public.client_cancel_order(uuid)
to anon;
