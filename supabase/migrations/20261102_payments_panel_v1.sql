-- ============ RECEBAA: painel "Pagamentos" do dono — Pix direto, modos de checkout e gestão — NASCE DESLIGADO ============
-- Complementa 20261031 (Pix/cartão, Mercado Pago) e 20261101 (carteiras, Stripe). NÃO aplicar sem ler docs/pagamentos.md (seção 13).
--
--  * Chave Pix própria do negócio (kiosk_pix_keys): só o dono lê/escreve (função SECURITY DEFINER); o público só recebe o
--    BR Code de uma conta aberta (montado na Edge Function a partir de payment_prepare).
--  * Pix direto (method 'pix_direct', provider 'direct'): sem gateway. A confirmação é MANUAL (payment_manual_settle), com autor e hora.
--  * Chaves por método (Pix online, cartão, Pix direto) em kiosk_payments; carteiras continuam em kiosks.wallets_enabled.
--  * Modo de checkout por negócio: 'optional' (padrão, como hoje) ou 'required' (pedido nasce RETIDO: orders.payment_hold,
--    invisível à equipe/cozinha/alerta até o pagamento ser confirmado). O enum order_status NÃO muda.
--  * Tudo nasce desligado / 'optional'. Auditoria mínima em payment_events (sem segredos).

alter table public.kiosk_payments add column if not exists checkout_mode text not null default 'optional';
alter table public.kiosk_payments drop constraint if exists kiosk_payments_checkout_mode_check;
alter table public.kiosk_payments add constraint kiosk_payments_checkout_mode_check check (checkout_mode in ('optional','required'));
alter table public.kiosk_payments add column if not exists pix_online_enabled boolean not null default true;
alter table public.kiosk_payments add column if not exists card_enabled boolean not null default true;
alter table public.kiosk_payments add column if not exists pix_direct_enabled boolean not null default false;

create table if not exists public.kiosk_pix_keys (
  kiosk_id uuid primary key references public.kiosks(id) on delete cascade,
  key_type text not null check (key_type in ('cpf','cnpj','email','phone','random')),
  key_value text not null check (length(key_value) between 1 and 77),
  beneficiary_name text not null check (length(beneficiary_name) between 1 and 25),
  city text not null check (length(city) between 1 and 15),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.kiosk_pix_keys enable row level security;
revoke all on public.kiosk_pix_keys from public, anon, authenticated;

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check check (method in ('pix','card','wallet','pix_direct'));
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('mercadopago','mock','stripe','direct'));
alter table public.payments add column if not exists manual boolean not null default false;
alter table public.payments add column if not exists marked_by uuid;
alter table public.payments add column if not exists marked_by_role text;
alter table public.payments add column if not exists marked_by_name text;
alter table public.payments add column if not exists marked_at timestamptz;
alter table public.payments add column if not exists manual_note text;
alter table public.payments add column if not exists review_resolved_at timestamptz;
alter table public.payments add column if not exists review_resolved_by uuid;
alter table public.payments add column if not exists hold_scope boolean not null default false;   -- cobrança de pedidos RETIDOS (modo obrigatório)
create index if not exists payments_kiosk_created_idx on public.payments(kiosk_id, created_at desc);

-- pedido retido: o enum order_status não muda; "retido" é um campo à parte
alter table public.orders add column if not exists payment_hold boolean not null default false;
alter table public.orders add column if not exists hold_expires_at timestamptz;
alter table public.orders add column if not exists hold_released_at timestamptz;
create index if not exists orders_hold_idx on public.orders(kiosk_id, umbrella_num) where payment_hold;

-- ---------- validação de chave Pix (autoridade: servidor) ----------
create or replace function private.cpf_valid(d text) returns boolean language plpgsql immutable as $$
declare s int; i int; d1 int; d2 int;
begin
  if d !~ '^[0-9]{11}$' or d ~ '^(.)\1{10}$' then return false; end if;
  s := 0; for i in 1..9 loop s := s + substr(d,i,1)::int * (11 - i); end loop;
  d1 := (s * 10) % 11; if d1 = 10 then d1 := 0; end if;
  s := 0; for i in 1..10 loop s := s + substr(d,i,1)::int * (12 - i); end loop;
  d2 := (s * 10) % 11; if d2 = 10 then d2 := 0; end if;
  return d1 = substr(d,10,1)::int and d2 = substr(d,11,1)::int;
end $$;

create or replace function private.cnpj_valid(d text) returns boolean language plpgsql immutable as $$
declare w1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2]; w2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2]; s int; i int; r int; d1 int; d2 int;
begin
  if d !~ '^[0-9]{14}$' or d ~ '^(.)\1{13}$' then return false; end if;
  s := 0; for i in 1..12 loop s := s + substr(d,i,1)::int * w1[i]; end loop;
  r := s % 11; d1 := case when r < 2 then 0 else 11 - r end;
  s := 0; for i in 1..13 loop s := s + substr(d,i,1)::int * w2[i]; end loop;
  r := s % 11; d2 := case when r < 2 then 0 else 11 - r end;
  return d1 = substr(d,13,1)::int and d2 = substr(d,14,1)::int;
end $$;

-- devolve a chave NORMALIZADA ou levanta erro claro
create or replace function private.pix_key_normalize(p_type text, p_val text) returns text language plpgsql immutable as $$
declare v text := btrim(coalesce(p_val, '')); d text;
begin
  if length(v) = 0 or length(v) > 120 then raise exception 'Informe a chave Pix.'; end if;
  if p_type = 'cpf' then
    d := regexp_replace(v, '[.\-\s]', '', 'g');
    if not private.cpf_valid(d) then raise exception 'CPF inválido.'; end if; return d;
  elsif p_type = 'cnpj' then
    d := regexp_replace(v, '[.\-/\s]', '', 'g');
    if not private.cnpj_valid(d) then raise exception 'CNPJ inválido.'; end if; return d;
  elsif p_type = 'email' then
    d := lower(v);
    if length(d) > 77 or d !~ '^[a-z0-9._%+\-]{1,64}@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$' then raise exception 'E-mail inválido.'; end if; return d;
  elsif p_type = 'phone' then
    d := regexp_replace(v, '[^0-9]', '', 'g');
    if length(d) in (12, 13) and left(d, 2) = '55' then d := '+' || d;
    elsif length(d) in (10, 11) then d := '+55' || d;
    else raise exception 'Telefone inválido. Use DDD + número.'; end if;
    if d !~ '^\+55[1-9][0-9][0-9]{8,9}$' then raise exception 'Telefone inválido. Use DDD + número.'; end if; return d;
  elsif p_type = 'random' then
    d := lower(v);
    if d !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Chave aleatória inválida (formato 8-4-4-4-12).'; end if; return d;
  end if;
  raise exception 'Tipo de chave inválido.';
end $$;

-- texto do BR Code: ASCII maiúsculo, sem acento nem símbolo
create or replace function private.pix_text(p_val text, p_max int) returns text language sql immutable as $$
  select btrim(left(btrim(regexp_replace(regexp_replace(upper(translate(coalesce(p_val, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN')),
    '[^A-Z0-9 ]', '', 'g'), ' +', ' ', 'g')), p_max))
$$;

-- ---------- o que está EFETIVAMENTE disponível (travas: liberação, bloqueio, conexões, chaves) ----------
create or replace function private.pay_methods(p_kiosk uuid) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare k public.kiosks; kp public.kiosk_payments; gw boolean; px boolean; cd boolean; wl boolean; dr boolean;
begin
  select * into k from public.kiosks where id = p_kiosk;
  select * into kp from public.kiosk_payments where kiosk_id = p_kiosk;
  if k.id is null or kp.kiosk_id is null or not k.is_active or coalesce(k.blocked, false) or not kp.invited or kp.platform_blocked then
    return jsonb_build_object('pix', false, 'card', false, 'wallet', false, 'pix_direct', false, 'any', false);
  end if;
  gw := k.payments_enabled and kp.status in ('connected','sandbox');
  px := gw and kp.pix_online_enabled;
  cd := gw and kp.card_enabled;
  wl := gw and k.wallets_enabled and kp.wallets_status in ('connected','sandbox') and kp.stripe_account_id is not null;
  dr := kp.pix_direct_enabled and exists (select 1 from public.kiosk_pix_keys x where x.kiosk_id = p_kiosk);
  return jsonb_build_object('pix', px, 'card', cd, 'wallet', wl, 'pix_direct', dr, 'any', px or cd or wl or dr);
end $$;

-- ---------- pedidos retidos ----------
-- eventos de tempo real: pedido retido NÃO gera evento (sem alerta para a equipe); ao ser liberado, vira um "insert" normal
create or replace function private.log_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text := 'update';
begin
  if new.payment_hold then return null; end if;
  if tg_op = 'INSERT' then k := 'insert';
  elsif old.payment_hold then k := 'insert'; end if;
  insert into public.order_events(kind, id, kiosk_id, umbrella_num, customer_name, status, order_number, total, service_amount, last_updated_by, created_at)
  values (k, new.id, new.kiosk_id, new.umbrella_num,
          case when new.customer_name in ('PEDIDO DE CONTA','CHAMADA DE ATENDENTE','ENCERRAMENTO') then new.customer_name end,
          new.status::text, new.order_number, new.total, new.service_amount, new.last_updated_by, new.created_at);
  if random() < 0.02 then
    delete from public.order_events where event_at < now() - interval '1 hour';
  end if;
  return null;
end $$;

-- descarta (cancela, invisível) pedidos retidos vencidos que não estão ligados a uma cobrança ativa
create or replace function private.hold_sweep(p_kiosk uuid) returns void language sql security definer set search_path = public, extensions as $$
  update public.orders o set status = 'cancelled'
   where o.kiosk_id = p_kiosk and o.payment_hold and o.hold_released_at is null and o.status = 'pending'
     and o.hold_expires_at < now()
     and not exists (select 1 from public.payment_orders po where po.order_id = o.id and po.active)
$$;

-- libera os pedidos retidos de uma cobrança paga (inclusive os já descartados, se o pagamento chegou tarde)
create or replace function private.hold_release(p_payment uuid) returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  update public.orders o set payment_hold = false, hold_released_at = now(), status = 'pending', last_updated_by = 'pagamento'
   where o.payment_hold and o.hold_released_at is null
     and o.id = any (select unnest(p.order_ids) from public.payments p where p.id = p_payment);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function private.pay_hold_orders(p_kiosk uuid, p_umbrella text)
returns table(order_id uuid, cents bigint, divergent boolean)
language sql stable security definer set search_path = public, extensions as $$
  with s as (select private.pay_session_start(p_kiosk, p_umbrella) as t)
  select o.id,
         coalesce(round(sum(i.quantity * i.unit_price) * 100), 0)::bigint,
         (count(i.id) = 0 or abs(round(o.total * 100) - coalesce(round(sum(i.quantity * i.unit_price) * 100), 0)) > 1
          or coalesce(sum(i.quantity * i.unit_price), 0) <= 0)
    from public.orders o
    left join public.order_items i on i.order_id = o.id, s
   where o.kiosk_id = p_kiosk and o.umbrella_num = p_umbrella
     and (s.t is null or o.created_at > s.t)
     and o.payment_hold and o.hold_released_at is null and o.status = 'pending' and o.hold_expires_at >= now()
     and not exists (select 1 from public.payment_orders po where po.order_id = o.id and po.active)
   group by o.id, o.total
$$;

-- preço de pedido retido: o cliente não pode pagar menos que o cardápio (piso = preço/promoção atual do produto do MESMO negócio)
create or replace function private.hold_check_items(p_order uuid) returns void language plpgsql security definer set search_path = public, extensions as $$
declare it record; pr record; kid uuid; floor_p numeric;
begin
  select kiosk_id into kid from public.orders where id = p_order;
  for it in select * from public.order_items where order_id = p_order loop
    if it.product_id is null then raise exception 'Item inválido para pagamento online.'; end if;
    select p.kiosk_id, p.price, p.promo_price, p.promo_active, p.is_available into pr from public.products p where p.id = it.product_id;
    if pr.kiosk_id is distinct from kid or not coalesce(pr.is_available, false) then raise exception 'Item indisponível.'; end if;
    floor_p := case when coalesce(pr.promo_active, false) and pr.promo_price is not null then least(pr.price, pr.promo_price) else pr.price end;
    if it.unit_price < floor_p - 0.001 then raise exception 'Preço divergente do cardápio. Atualize a página e tente de novo.'; end if;
  end loop;
end $$;


-- ---------- leitura: equipe/admin nunca veem pedido retido ----------
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

  if p_token is not null then wh := wh || 'not o.payment_hold'::text; end if;   -- pedidos retidos (aguardando pagamento) não aparecem para a equipe
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

-- ---------- place_order: retenção no modo obrigatório ----------
create or replace function public.place_order(p_order jsonb, p_items jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare kid uuid; ok boolean; n int; obj jsonb; res jsonb; new_id uuid; md text; hold boolean := false; nh int; st text;
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
  -- modo de checkout OBRIGATÓRIO: o pedido do cliente nasce RETIDO (invisível à equipe) até o pagamento ser confirmado.
  -- O status enviado pelo cliente é ignorado (não dá para "furar" o pagamento mandando status 'accepted').
  select kp.checkout_mode into md from public.kiosk_payments kp where kp.kiosk_id = kid;
  st := coalesce(p_order->>'status', 'pending');
  if coalesce(md, 'optional') = 'required' and coalesce(p_order->>'customer_name', '') not in ('PEDIDO DE CONTA','CHAMADA DE ATENDENTE','ENCERRAMENTO') then
    if not (private.pay_methods(kid)->>'any')::boolean then
      raise exception 'Pagamento online indisponível no momento. Chame o atendente para fazer o pedido.';
    end if;
    select count(*) into nh from public.orders o where o.kiosk_id = kid and o.umbrella_num = p_order->>'umbrella_num'
       and o.payment_hold and o.hold_released_at is null and o.status = 'pending';
    if nh >= 9 then raise exception 'Pague ou cancele seus pedidos pendentes antes de enviar outro.'; end if;
    hold := true; st := 'pending';
  end if;
  obj := jsonb_strip_nulls(jsonb_build_object(
    'kiosk_id', kid, 'umbrella_num', p_order->>'umbrella_num', 'customer_name', p_order->>'customer_name',
    'notes', p_order->>'notes', 'status', st,
    'total', coalesce((p_order->>'total')::numeric, 0), 'idempotency_key', p_order->>'idempotency_key',
    'created_by', p_order->>'created_by', 'last_updated_by', p_order->>'last_updated_by',
    'service_amount', (p_order->>'service_amount')::numeric));
  insert into public.orders(kiosk_id, umbrella_num, customer_name, notes, status, total, idempotency_key, created_by, last_updated_by, service_amount, payment_hold, hold_expires_at)
  select r.kiosk_id, r.umbrella_num, r.customer_name, r.notes, r.status, r.total, r.idempotency_key, r.created_by, r.last_updated_by, coalesce(r.service_amount, 0),
         hold, case when hold then now() + interval '30 minutes' end
    from jsonb_populate_record(null::public.orders, obj) r
  returning to_jsonb(orders.*), orders.id into res, new_id;
  if p_items is not null then perform private.insert_items(new_id, p_items); end if;
  return res;
end $$;

-- ---------- itens: pedido retido tem piso de preço do cardápio; pedido pago/em pagamento não muda ----------
create or replace function public.add_order_items(p_items jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; grp record;
begin
  for grp in select (x->>'order_id')::uuid as ord_id, jsonb_agg(x) as arr from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x group by 1 loop
    if not exists (select 1 from public.orders o where o.id = grp.ord_id and o.created_at > now() - interval '15 minutes') then
      raise exception 'Pedido não encontrado ou muito antigo';
    end if;
    if exists (select 1 from public.orders o where o.id = grp.ord_id and o.hold_released_at is not null)
       or exists (select 1 from public.payment_orders po where po.order_id = grp.ord_id and po.active) then
      raise exception 'Pedido já em pagamento ou pago: não pode mais ser alterado.';
    end if;
    n := n + private.insert_items(grp.ord_id, grp.arr);
    if exists (select 1 from public.orders o where o.id = grp.ord_id and o.payment_hold) then perform private.hold_check_items(grp.ord_id); end if;
  end loop;
  return n;
end $$;

-- ---------- cancelar pelo cliente: não cancela pedido já pago nem em pagamento ----------
create or replace function public.client_cancel_order(p_order_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  with u as (update public.orders o set status = 'cancelled' where o.id = p_order_id and o.status = 'pending' and o.hold_released_at is null
       and not exists (select 1 from public.payment_orders po where po.order_id = o.id and po.active) returning o.*)
  select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from u
$$;

-- ---------- liquidação: libera pedidos retidos ----------
create or replace function public.payment_settle(
  p_payment_id uuid, p_status text, p_paid_cents integer, p_provider_payment_id text, p_ext_ref text, p_raw jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare p public.payments; late boolean;
begin
  if p_status not in ('paid','pending','failed','refunded') then raise exception 'E_BAD_REQUEST'; end if;
  select * into p from public.payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if p_ext_ref is distinct from p.id::text then
    perform private.pay_event(p.id, p.kiosk_id, 'ref_mismatch', jsonb_build_object('got', left(coalesce(p_ext_ref,''), 80)));
    return jsonb_build_object('result', 'ref_mismatch');
  end if;

  if p_status = 'paid' then
    if p.status = 'paid' then return jsonb_build_object('result', 'already_paid', 'status', 'paid'); end if;
    if p.status = 'refunded' then return jsonb_build_object('result', 'ignored', 'status', p.status); end if;
    if p_paid_cents is distinct from p.amount_cents then
      update public.payments set needs_review = true, updated_at = now() where id = p.id;
      perform private.pay_event(p.id, p.kiosk_id, 'amount_mismatch', jsonb_build_object('expected', p.amount_cents, 'got', p_paid_cents));
      return jsonb_build_object('result', 'amount_mismatch', 'status', p.status);
    end if;
    late := p.status in ('expired','cancelled','failed');
    update public.payments set status = 'paid', paid_at = now(), paid_amount_cents = p_paid_cents, provider_payment_id = p_provider_payment_id,
           late_payment = late, updated_at = now() where id = p.id;
    -- se o pagamento chegou atrasado, tenta reativar os vínculos; se algum pedido já foi coberto por outro pagamento, sinaliza para revisão
    update public.payment_orders po set active = true where po.payment_id = p.id and not po.active
       and not exists (select 1 from public.payment_orders x where x.order_id = po.order_id and x.active and x.payment_id <> p.id);
    if exists (select 1 from public.payment_orders po where po.payment_id = p.id and not po.active) then
      update public.payments set needs_review = true where id = p.id;
    end if;
    if p.hold_scope then perform private.hold_release(p.id); end if;     -- modo obrigatório: libera o pedido para a equipe
    perform private.pay_event(p.id, p.kiosk_id, case when late then 'paid_late' else 'paid' end,
                              jsonb_build_object('provider_payment_id', p_provider_payment_id));
    return jsonb_build_object('result', 'paid', 'status', 'paid', 'late', late);
  end if;

  if p_status = 'refunded' then
    if p.status = 'paid' then
      update public.payments set status = 'refunded', updated_at = now() where id = p.id;
      perform private.pay_deactivate(p.id);
      perform private.pay_event(p.id, p.kiosk_id, 'refunded', null);
      return jsonb_build_object('result', 'refunded', 'status', 'refunded');
    end if;
    return jsonb_build_object('result', 'ignored', 'status', p.status);
  end if;

  if p_status = 'failed' then
    -- no cartão o comprador pode tentar de novo no checkout hospedado; só o Pix termina em falha
    if p.method = 'pix' and p.status in ('created','pending') then
      update public.payments set status = 'failed', updated_at = now() where id = p.id;
      perform private.pay_deactivate(p.id);
      perform private.pay_event(p.id, p.kiosk_id, 'failed', null);
      return jsonb_build_object('result', 'failed', 'status', 'failed');
    end if;
    return jsonb_build_object('result', 'ignored', 'status', p.status);
  end if;

  update public.payments set provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id), updated_at = now() where id = p.id;
  return jsonb_build_object('result', 'pending', 'status', p.status);
end $$;

-- ---------- payment_prepare: Pix direto, chaves por método e escopo 'retidos' ----------
drop function if exists public.payment_prepare(uuid, text, text, text, int);
create or replace function public.payment_prepare(p_kiosk uuid, p_umbrella text, p_method text, p_idem text, p_ttl_minutes int default 20, p_hold boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  k public.kiosks; kp public.kiosk_payments; ex public.payments; sub bigint; n int; dv int; svc bigint;
  live record; ctok text; rtok text; pid uuid; ords uuid[]; conn jsonb; prov text; pk public.kiosk_pix_keys;
begin
  if p_method not in ('pix','card','wallet','pix_direct') then raise exception 'E_BAD_REQUEST'; end if;
  if p_umbrella is null or p_umbrella !~ '^[0-9]{1,6}$' then raise exception 'E_BAD_REQUEST'; end if;
  if length(coalesce(p_idem,'')) < 16 or length(p_idem) > 100 then raise exception 'E_BAD_REQUEST'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_kiosk::text || ':' || p_umbrella, 0));

  select * into k from public.kiosks where id = p_kiosk;
  if not found or not k.is_active or coalesce(k.blocked,false) then raise exception 'E_PAYMENTS_DISABLED'; end if;
  select * into kp from public.kiosk_payments where kiosk_id = p_kiosk;
  if not found or kp.platform_blocked or not kp.invited then raise exception 'E_PAYMENTS_DISABLED'; end if;
  if p_method = 'pix_direct' then
    -- Pix direto: chave própria do negócio, sem gateway. Confirmação manual pela equipe.
    if not kp.pix_direct_enabled then raise exception 'E_PAYMENTS_DISABLED'; end if;
    select * into pk from public.kiosk_pix_keys where kiosk_id = p_kiosk;
    if pk.kiosk_id is null then raise exception 'E_PAYMENTS_DISABLED'; end if;
    prov := 'direct';
    conn := jsonb_build_object('provider', 'direct', 'status', 'connected', 'pix_key_type', pk.key_type, 'pix_key', pk.key_value,
                               'pix_name', pk.beneficiary_name, 'pix_city', pk.city);
  else
    if not k.payments_enabled or kp.status not in ('connected','sandbox') then raise exception 'E_PAYMENTS_DISABLED'; end if;
    if p_method = 'pix' and not kp.pix_online_enabled then raise exception 'E_PAYMENTS_DISABLED'; end if;
    if p_method = 'card' and not kp.card_enabled then raise exception 'E_PAYMENTS_DISABLED'; end if;
    if p_method = 'wallet' then
      -- carteira: flag própria + conta Stripe conectada do estabelecimento (direct charges)
      if not k.wallets_enabled or kp.wallets_status not in ('connected','sandbox') or kp.stripe_account_id is null then raise exception 'E_PAYMENTS_DISABLED'; end if;
      prov := 'stripe';
      conn := jsonb_build_object('provider', 'stripe', 'status', kp.wallets_status, 'account_id', kp.stripe_account_id);
    else
      prov := kp.provider;
      conn := jsonb_build_object('provider', kp.provider, 'status', kp.status, 'account_id', kp.provider_account_id,
                                 'access_enc', kp.access_token_enc, 'refresh_enc', kp.refresh_token_enc, 'expires_at', kp.token_expires_at);
    end if;
  end if;
  if not exists (select 1 from public.umbrellas u where u.kiosk_id = p_kiosk and u.number = p_umbrella::int and u.is_active) then
    raise exception 'E_UMBRELLA_NOT_FOUND';
  end if;

  select * into ex from public.payments where kiosk_id = p_kiosk and idempotency_key = p_idem;
  if found then
    if ex.umbrella_num <> p_umbrella or ex.method <> p_method then raise exception 'E_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('existing', true, 'payment_id', ex.id, 'status', ex.status, 'method', ex.method,
      'amount_cents', ex.amount_cents, 'subtotal_cents', ex.subtotal_cents, 'service_cents', ex.service_cents,
      'expires_at', ex.expires_at, 'provider', ex.provider, 'provider_ref', ex.provider_ref, 'umbrella_num', ex.umbrella_num,
      'pix_copy_paste', ex.provider_payload->>'pix_copy_paste', 'checkout_url', ex.provider_payload->>'checkout_url',
      'client_secret', ex.provider_payload->>'client_secret', 'kiosk_name', k.name, 'connection', conn);
  end if;

  perform private.pay_expire_stale(p_kiosk, p_umbrella);

  select p.id, p.expires_at, p.status into live from public.payments p
   where p.kiosk_id = p_kiosk and p.umbrella_num = p_umbrella and p.status in ('created','pending') order by p.created_at desc limit 1;
  if found then
    perform private.pay_event(live.id, p_kiosk, 'blocked_in_progress', null);
    raise exception 'E_PAYMENT_IN_PROGRESS';
  end if;

  if p_hold then
    perform private.hold_sweep(p_kiosk);      -- descarta retidos vencidos antes de somar
    select coalesce(sum(cents),0), count(*), count(*) filter (where divergent), array_agg(order_id)
      into sub, n, dv, ords from private.pay_hold_orders(p_kiosk, p_umbrella);
  else
    select coalesce(sum(cents),0), count(*), count(*) filter (where divergent), array_agg(order_id)
      into sub, n, dv, ords from private.pay_open_orders(p_kiosk, p_umbrella);
  end if;
  if n = 0 or sub <= 0 then raise exception 'E_NOTHING_TO_PAY'; end if;
  if dv > 0 then raise exception 'E_ORDER_MISMATCH'; end if;
  svc := round(sub * kp.service_percent / 100.0);
  if sub + svc > 5000000 then raise exception 'E_AMOUNT_TOO_HIGH'; end if;

  ctok := encode(extensions.gen_random_bytes(24), 'hex');
  rtok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.payments(kiosk_id, umbrella_num, session_start, order_ids, subtotal_cents, service_cents, amount_cents, method,
      provider, idempotency_key, client_token_hash, confirmation_token_hash, expires_at, hold_scope)
  values (p_kiosk, p_umbrella, private.pay_session_start(p_kiosk, p_umbrella), ords, sub, svc, sub + svc, p_method,
      prov, p_idem, encode(extensions.digest(ctok, 'sha256'), 'hex'), encode(extensions.digest(rtok, 'sha256'), 'hex'),
      now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 20), 60))), coalesce(p_hold, false))
  returning id into pid;
  insert into public.payment_orders(payment_id, order_id) select pid, unnest(ords);
  perform private.pay_event(pid, p_kiosk, 'created', jsonb_build_object('method', p_method, 'amount_cents', sub + svc));

  return jsonb_build_object('existing', false, 'payment_id', pid, 'status', 'created', 'method', p_method,
    'amount_cents', sub + svc, 'subtotal_cents', sub, 'service_cents', svc,
    'expires_at', (select expires_at from public.payments where id = pid), 'provider', prov,
    'umbrella_num', p_umbrella, 'kiosk_name', k.name, 'client_token', ctok, 'receipt_token', rtok, 'connection', conn);
end $$;

-- ---------- cotação (cliente): métodos, modo e pedidos retidos ----------
create or replace function public.payment_quote(p_kiosk uuid, p_umbrella text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m jsonb; kp public.kiosk_payments; pct numeric; sub bigint; n int; dv int; pend int; svc bigint; live record;
        hsub bigint; hn int; hdv int; hsvc bigint; hexp timestamptz;
begin
  if p_umbrella is null or length(p_umbrella) > 20 then return jsonb_build_object('enabled', false); end if;
  m := private.pay_methods(p_kiosk);
  if not (m->>'any')::boolean then return jsonb_build_object('enabled', false); end if;
  select * into kp from public.kiosk_payments where kiosk_id = p_kiosk;
  pct := kp.service_percent;
  perform private.pay_expire_stale(p_kiosk, p_umbrella);
  perform private.hold_sweep(p_kiosk);
  select coalesce(sum(cents),0), count(*), count(*) filter (where divergent) into sub, n, dv from private.pay_open_orders(p_kiosk, p_umbrella);
  select coalesce(sum(cents),0), count(*), count(*) filter (where divergent) into hsub, hn, hdv from private.pay_hold_orders(p_kiosk, p_umbrella);
  select min(o.hold_expires_at) into hexp from public.orders o
   where o.kiosk_id = p_kiosk and o.umbrella_num = p_umbrella and o.payment_hold and o.hold_released_at is null and o.status = 'pending';
  select count(*) into pend from public.orders o
   where o.kiosk_id = p_kiosk and o.umbrella_num = p_umbrella and o.status = 'pending' and not o.payment_hold
     and o.customer_name not in ('ENCERRAMENTO','PEDIDO DE CONTA','CHAMADA DE ATENDENTE')
     and o.created_at > coalesce(private.pay_session_start(p_kiosk, p_umbrella), '-infinity'::timestamptz);
  svc := round(sub * coalesce(pct,0) / 100.0);
  hsvc := round(hsub * coalesce(pct,0) / 100.0);
  select p.id, p.status, p.method, p.amount_cents, p.expires_at, p.hold_scope into live from public.payments p
   where p.kiosk_id = p_kiosk and p.umbrella_num = p_umbrella and p.status in ('created','pending') and p.expires_at >= now()
   order by p.created_at desc limit 1;
  return jsonb_build_object('enabled', true, 'subtotal_cents', sub, 'service_cents', svc, 'amount_cents', sub + svc,
    'service_percent', coalesce(pct,0), 'order_count', n, 'divergent_count', dv, 'pending_orders', pend,
    'methods', jsonb_build_object('pix', m->'pix', 'card', m->'card', 'wallet', m->'wallet', 'pix_direct', m->'pix_direct'),
    'wallets_available', (m->>'wallet')::boolean,
    'checkout_mode', kp.checkout_mode,
    'held', jsonb_build_object('count', hn, 'subtotal_cents', hsub, 'service_cents', hsvc, 'amount_cents', hsub + hsvc,
        'divergent_count', hdv, 'expires_at', hexp),
    'live_payment', case when live.id is null then null else jsonb_build_object('id', live.id, 'status', live.status,
        'method', live.method, 'amount_cents', live.amount_cents, 'expires_at', live.expires_at, 'hold', live.hold_scope) end);
end $$;

-- ---------- baixa MANUAL do Pix direto (equipe) ----------
create or replace function public.payment_manual_settle(p_token text, p_payment_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; p public.payments; nm text; late boolean;
begin
  s := private.staff_session(p_token);
  if private.rate_limited('pmanual:' || s.kiosk_id, 60, interval '10 minutes') then raise exception 'Muitas baixas seguidas. Aguarde.'; end if;
  perform private.rate_hit('pmanual:' || s.kiosk_id);
  select * into p from public.payments x where x.id = p_payment_id and x.kiosk_id = s.kiosk_id for update;
  if not found then raise exception 'Pagamento não encontrado.'; end if;
  if p.method <> 'pix_direct' then raise exception 'Somente o Pix direto é confirmado manualmente.'; end if;
  if p.status = 'paid' then
    return jsonb_build_object('result', 'already_paid', 'status', 'paid', 'marked_at', p.marked_at, 'marked_by_name', p.marked_by_name);
  end if;
  if p.status in ('refunded','failed') then raise exception 'Este pagamento não pode ser baixado (%).', p.status; end if;
  nm := case when s.role = 'waiter' then coalesce((select w.name from public.waiters w where w.id = s.subject_id), 'Garçom') else 'Responsável' end;
  late := p.status in ('expired','cancelled');
  update public.payments set status = 'paid', paid_at = now(), paid_amount_cents = amount_cents, manual = true,
         marked_by = s.subject_id, marked_by_role = s.role, marked_by_name = left(nm, 60), marked_at = now(),
         manual_note = nullif(left(btrim(coalesce(p_note, '')), 200), ''),
         late_payment = late, needs_review = needs_review or late, updated_at = now()
   where id = p.id;
  update public.payment_orders po set active = true where po.payment_id = p.id and not po.active
     and not exists (select 1 from public.payment_orders x where x.order_id = po.order_id and x.active and x.payment_id <> p.id);
  if exists (select 1 from public.payment_orders po where po.payment_id = p.id and not po.active) then
    update public.payments set needs_review = true where id = p.id;
  end if;
  if p.hold_scope then perform private.hold_release(p.id); end if;
  perform private.pay_event(p.id, p.kiosk_id, 'manual_paid', jsonb_build_object('by_role', s.role, 'by_name', left(nm, 60), 'late', late));
  return jsonb_build_object('result', 'paid', 'status', 'paid', 'late', late, 'marked_by_name', left(nm, 60));
end $$;

-- ---------- lista / detalhe / ações do dono ----------
create or replace function public.payments_search(p_token text, p_filters jsonb default '{}'::jsonb, p_limit int default 25, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; f jsonb := coalesce(p_filters, '{}'::jsonb); dfrom timestamptz; dto timestamptz; umb text; meth text; st text;
        rws jsonb; tot int; totals jsonb; lim int; offs int;
begin
  s := private.owner_session(p_token);
  if private.rate_limited('psearch:' || s.kiosk_id, 120, interval '1 minute') then raise exception 'Muitas consultas. Aguarde.'; end if;
  perform private.rate_hit('psearch:' || s.kiosk_id);
  begin
    dfrom := nullif(f->>'from', '')::timestamptz; dto := nullif(f->>'to', '')::timestamptz;
  exception when others then raise exception 'Período inválido.'; end;
  umb := nullif(f->>'umbrella', ''); meth := nullif(f->>'method', ''); st := nullif(f->>'state', '');
  if umb is not null and umb !~ '^[0-9]{1,6}$' then raise exception 'Mesa inválida.'; end if;
  if meth is not null and meth not in ('pix','card','wallet','pix_direct') then raise exception 'Método inválido.'; end if;
  if st is not null and st not in ('pending','paid','expired','cancelled','refunded','failed','review') then raise exception 'Estado inválido.'; end if;
  lim := greatest(1, least(coalesce(p_limit, 25), 100)); offs := greatest(0, least(coalesce(p_offset, 0), 100000));

  select coalesce(jsonb_object_agg(g, v), '{}'::jsonb) into totals from (
    select case when x.needs_review then 'review' when x.status in ('created','pending') then 'pending' else x.status end as g,
           jsonb_build_object('count', count(*), 'cents', coalesce(sum(case when x.status = 'paid' then x.paid_amount_cents else x.amount_cents end), 0)) as v
      from public.payments x
     where x.kiosk_id = s.kiosk_id and (dfrom is null or x.created_at >= dfrom) and (dto is null or x.created_at < dto)
       and (umb is null or x.umbrella_num = umb) and (meth is null or x.method = meth)
     group by 1) t;
  select count(*) into tot from public.payments x
   where x.kiosk_id = s.kiosk_id and (dfrom is null or x.created_at >= dfrom) and (dto is null or x.created_at < dto)
     and (umb is null or x.umbrella_num = umb) and (meth is null or x.method = meth)
     and (st is null or (st = 'review' and x.needs_review) or (st = 'pending' and x.status in ('created','pending'))
          or (st not in ('review','pending') and x.status = st));
  select coalesce(jsonb_agg(r order by r.created_at desc), '[]'::jsonb) into rws from (
    select x.id, x.created_at, x.umbrella_num, x.method, x.status, x.amount_cents, x.subtotal_cents, x.service_cents, x.paid_at,
           x.paid_amount_cents, x.expires_at, x.needs_review, x.late_payment, x.manual, x.marked_by_name, x.marked_at, x.validated_at,
           x.validation_count, x.hold_scope, x.review_resolved_at
      from public.payments x
     where x.kiosk_id = s.kiosk_id and (dfrom is null or x.created_at >= dfrom) and (dto is null or x.created_at < dto)
       and (umb is null or x.umbrella_num = umb) and (meth is null or x.method = meth)
       and (st is null or (st = 'review' and x.needs_review) or (st = 'pending' and x.status in ('created','pending'))
            or (st not in ('review','pending') and x.status = st))
     order by x.created_at desc limit lim offset offs) r;
  return jsonb_build_object('rows', rws, 'total', tot, 'totals', totals, 'limit', lim, 'offset', offs);
end $$;

create or replace function public.payment_detail(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; p public.payments;
begin
  s := private.owner_session(p_token);
  select * into p from public.payments x where x.id = p_id and x.kiosk_id = s.kiosk_id;
  if not found then raise exception 'Pagamento não encontrado.'; end if;
  return jsonb_build_object('id', p.id, 'created_at', p.created_at, 'umbrella_num', p.umbrella_num, 'method', p.method, 'status', p.status,
    'amount_cents', p.amount_cents, 'subtotal_cents', p.subtotal_cents, 'service_cents', p.service_cents, 'paid_at', p.paid_at,
    'paid_amount_cents', p.paid_amount_cents, 'expires_at', p.expires_at, 'needs_review', p.needs_review, 'late_payment', p.late_payment,
    'manual', p.manual, 'marked_by_name', p.marked_by_name, 'marked_by_role', p.marked_by_role, 'marked_at', p.marked_at, 'manual_note', p.manual_note,
    'validated_at', p.validated_at, 'validation_count', p.validation_count, 'hold_scope', p.hold_scope, 'review_resolved_at', p.review_resolved_at,
    'orders', (select count(*) from public.payment_orders po where po.payment_id = p.id),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.created_at, 'by_role', e.detail->>'by_role', 'by_name', e.detail->>'by_name') order by e.created_at, e.id)
                          from public.payment_events e where e.payment_id = p.id), '[]'::jsonb));
end $$;

create or replace function public.payment_owner_cancel(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; p public.payments;
begin
  s := private.owner_session(p_token);
  perform pg_advisory_xact_lock(hashtextextended('pown:' || s.kiosk_id, 0));
  select * into p from public.payments x where x.id = p_id and x.kiosk_id = s.kiosk_id for update;
  if not found then raise exception 'Pagamento não encontrado.'; end if;
  if p.status not in ('created','pending') then raise exception 'Só é possível cancelar cobranças pendentes.'; end if;
  update public.payments set status = 'cancelled', updated_at = now() where id = p.id;
  perform private.pay_deactivate(p.id);
  perform private.pay_event(p.id, p.kiosk_id, 'owner_cancelled', jsonb_build_object('by_role', s.role));
  return jsonb_build_object('status', 'cancelled');
end $$;

create or replace function public.payment_review_resolve(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; p public.payments;
begin
  s := private.owner_session(p_token);
  select * into p from public.payments x where x.id = p_id and x.kiosk_id = s.kiosk_id for update;
  if not found then raise exception 'Pagamento não encontrado.'; end if;
  if not p.needs_review then return jsonb_build_object('needs_review', false); end if;
  update public.payments set needs_review = false, review_resolved_at = now(), review_resolved_by = s.subject_id, updated_at = now() where id = p.id;
  perform private.pay_event(p.id, p.kiosk_id, 'review_resolved', jsonb_build_object('by_role', s.role));
  return jsonb_build_object('needs_review', false);
end $$;

-- reemite o comprovante: gera outro token (o QR antigo deixa de valer). O token só é devolvido agora; no banco fica o hash.
create or replace function public.payment_reissue_receipt(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; p public.payments; rtok text;
begin
  s := private.owner_session(p_token);
  if private.rate_limited('preissue:' || s.kiosk_id, 20, interval '10 minutes') then raise exception 'Muitas reemissões. Aguarde.'; end if;
  perform private.rate_hit('preissue:' || s.kiosk_id);
  select * into p from public.payments x where x.id = p_id and x.kiosk_id = s.kiosk_id for update;
  if not found then raise exception 'Pagamento não encontrado.'; end if;
  if p.status <> 'paid' then raise exception 'Só há comprovante de pagamento confirmado.'; end if;
  rtok := encode(extensions.gen_random_bytes(24), 'hex');
  update public.payments set confirmation_token_hash = encode(extensions.digest(rtok, 'sha256'), 'hex'),
         validated_at = null, validated_by = null, validation_count = 0, updated_at = now() where id = p.id;
  perform private.pay_event(p.id, p.kiosk_id, 'receipt_reissued', jsonb_build_object('by_role', s.role));
  return jsonb_build_object('receipt_token', rtok, 'amount_cents', p.amount_cents, 'umbrella_num', p.umbrella_num, 'paid_at', p.paid_at);
end $$;

-- ---------- chave Pix do negócio (só o dono) ----------
create or replace function public.pix_key_set(p_token text, p_type text, p_value text, p_name text, p_city text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; v text; nm text; ct text;
begin
  s := private.owner_session(p_token);
  if private.rate_limited('ppixkey:' || s.kiosk_id, 20, interval '10 minutes') then raise exception 'Muitas alterações. Aguarde.'; end if;
  perform private.rate_hit('ppixkey:' || s.kiosk_id);
  if not exists (select 1 from public.kiosk_payments kp where kp.kiosk_id = s.kiosk_id and kp.invited and not kp.platform_blocked) then
    raise exception 'Pagamentos online ainda não foram liberados para este negócio.';
  end if;
  v := private.pix_key_normalize(p_type, p_value);
  nm := private.pix_text(p_name, 25); ct := private.pix_text(p_city, 15);
  if length(nm) < 1 then raise exception 'Informe o nome do beneficiário (letras e números).'; end if;
  if length(ct) < 1 then raise exception 'Informe a cidade (letras e números).'; end if;
  insert into public.kiosk_pix_keys(kiosk_id, key_type, key_value, beneficiary_name, city, updated_by, updated_at)
  values (s.kiosk_id, p_type, v, nm, ct, s.subject_id, now())
  on conflict (kiosk_id) do update set key_type = excluded.key_type, key_value = excluded.key_value,
     beneficiary_name = excluded.beneficiary_name, city = excluded.city, updated_by = excluded.updated_by, updated_at = now();
  perform private.pay_event(null, s.kiosk_id, 'pix_key_set', jsonb_build_object('by_role', s.role, 'type', p_type));   -- a chave NÃO vai para o log
  return public.payments_panel_get(p_token);
end $$;

create or replace function public.pix_key_clear(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  delete from public.kiosk_pix_keys where kiosk_id = s.kiosk_id;
  update public.kiosk_payments set pix_direct_enabled = false, updated_at = now() where kiosk_id = s.kiosk_id;
  if not (private.pay_methods(s.kiosk_id)->>'any')::boolean then
    update public.kiosk_payments set checkout_mode = 'optional' where kiosk_id = s.kiosk_id;
  end if;
  perform private.pay_event(null, s.kiosk_id, 'pix_key_cleared', jsonb_build_object('by_role', s.role));
  return public.payments_panel_get(p_token);
end $$;

-- ---------- painel: leitura e escrita da configuração (só o dono) ----------
create or replace function public.payments_panel_get(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; k public.kiosks; kp public.kiosk_payments; pk public.kiosk_pix_keys; m jsonb; avail boolean;
        gw_ok boolean; mp_state text; st_state text; reasons jsonb; held int;
begin
  s := private.owner_session(p_token);
  select * into k from public.kiosks where id = s.kiosk_id;
  select * into kp from public.kiosk_payments where kiosk_id = s.kiosk_id;
  select * into pk from public.kiosk_pix_keys where kiosk_id = s.kiosk_id;
  m := private.pay_methods(s.kiosk_id);
  avail := coalesce(kp.invited, false) and not coalesce(kp.platform_blocked, false);
  mp_state := coalesce(kp.status, 'disconnected');
  if mp_state = 'disconnected' and exists (select 1 from public.payments_oauth_states o where o.kiosk_id = s.kiosk_id and o.expires_at > now()) then mp_state := 'pending'; end if;
  st_state := coalesce(kp.wallets_status, 'disconnected');
  gw_ok := coalesce(kp.status, 'disconnected') in ('connected','sandbox');
  reasons := jsonb_build_object(
    'general', case when not avail and coalesce(kp.platform_blocked, false) then 'Bloqueado pela plataforma. Fale com o suporte.'
                    when not avail then 'Pagamentos online ainda não foram liberados para este negócio pela plataforma.'
                    when not gw_ok then 'Conecte sua conta do Mercado Pago antes de ligar.' end,
    'pix_online', case when not avail then 'Aguardando liberação da plataforma.' when not k.payments_enabled then 'Ligue primeiro os pagamentos online.' end,
    'card', case when not avail then 'Aguardando liberação da plataforma.' when not k.payments_enabled then 'Ligue primeiro os pagamentos online.' end,
    'wallets', case when not avail then 'Aguardando liberação da plataforma.' when not k.payments_enabled then 'Ligue primeiro os pagamentos online.'
                    when st_state not in ('connected','sandbox') then 'Conecte sua conta Stripe.' end,
    'pix_direct', case when not avail and coalesce(kp.platform_blocked, false) then 'Bloqueado pela plataforma. Fale com o suporte.'
                       when not avail then 'Aguardando liberação da plataforma.' when pk.kiosk_id is null then 'Cadastre sua chave Pix.' end,
    'required', case when not (m->>'any')::boolean then 'Ligue ao menos uma forma de pagamento disponível para exigir o pagamento.' end);
  select count(*) into held from public.orders o where o.kiosk_id = s.kiosk_id and o.payment_hold and o.hold_released_at is null and o.status = 'pending';
  return jsonb_build_object(
    'available', avail, 'platform_blocked', coalesce(kp.platform_blocked, false),
    'general_enabled', coalesce(k.payments_enabled, false),
    'connections', jsonb_build_object(
      'mercadopago', jsonb_build_object('state', mp_state, 'account', case when kp.provider_account_id is null then null else '…' || right(kp.provider_account_id, 4) end, 'test', kp.status = 'sandbox'),
      'stripe', jsonb_build_object('state', st_state, 'account', case when kp.stripe_account_id is null then null else '…' || right(kp.stripe_account_id, 4) end, 'test', kp.wallets_status = 'sandbox')),
    'methods', jsonb_build_object('pix_online', coalesce(kp.pix_online_enabled, true), 'card', coalesce(kp.card_enabled, true),
                                  'wallets', coalesce(k.wallets_enabled, false), 'pix_direct', coalesce(kp.pix_direct_enabled, false)),
    'effective', m,
    'reasons', reasons,
    'checkout_mode', coalesce(kp.checkout_mode, 'optional'),
    'held_orders', held,
    'service_percent', coalesce(kp.service_percent, 0),
    'pix_key', case when pk.kiosk_id is null then null else jsonb_build_object('type', pk.key_type, 'value', pk.key_value, 'name', pk.beneficiary_name, 'city', pk.city, 'updated_at', pk.updated_at) end,
    'audit', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'at', a.created_at, 'by_role', a.detail->>'by_role', 'changes', a.detail->'changes') order by a.created_at desc)
                         from (select e.kind, e.created_at, e.detail from public.payment_events e
                                where e.kiosk_id = s.kiosk_id and e.payment_id is null
                                  and e.kind in ('config_changed','pix_key_set','pix_key_cleared','enabled','disabled','wallets_enabled','wallets_disabled')
                                order by e.created_at desc, e.id desc limit 10) a), '[]'::jsonb));
end $$;

create or replace function public.payments_panel_set(p_token text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; kp public.kiosk_payments; key text; v jsonb; m jsonb; changes jsonb := '{}'::jsonb; mode_reset boolean := false;
begin
  s := private.owner_session(p_token);
  if private.rate_limited('ppanel:' || s.kiosk_id, 40, interval '10 minutes') then raise exception 'Muitas alterações. Aguarde.'; end if;
  perform private.rate_hit('ppanel:' || s.kiosk_id);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then raise exception 'Nada para alterar.'; end if;
  for key in select jsonb_object_keys(p_patch) loop
    if key not in ('payments_enabled','pix_online','card','wallets','pix_direct','checkout_mode') then raise exception 'Campo não permitido: %', left(key, 40); end if;
    v := p_patch->key;
    if key = 'checkout_mode' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('optional','required') then raise exception 'Modo inválido.'; end if;
    elsif jsonb_typeof(v) <> 'boolean' then raise exception 'Valor inválido para %.', key; end if;
    changes := changes || jsonb_build_object(key, v);
  end loop;
  select * into kp from public.kiosk_payments where kiosk_id = s.kiosk_id;
  if kp.platform_blocked then raise exception 'Bloqueado pela plataforma. Fale com o suporte.'; end if;
  if kp.kiosk_id is null or not kp.invited then raise exception 'Pagamentos online ainda não foram liberados para este negócio.'; end if;

  -- desligar vem antes de ligar, para que "desligar tudo e trocar para opcional" funcione em um só pedido
  if p_patch ? 'payments_enabled' and not (p_patch->>'payments_enabled')::boolean then
    perform public.set_payments_settings(p_token, false, null, null);
  end if;
  if p_patch ? 'payments_enabled' and (p_patch->>'payments_enabled')::boolean then
    perform public.set_payments_settings(p_token, true, null, null);
  end if;
  if p_patch ? 'wallets' then perform public.set_payments_settings(p_token, null, null, (p_patch->>'wallets')::boolean); end if;
  if p_patch ? 'pix_online' then update public.kiosk_payments set pix_online_enabled = (p_patch->>'pix_online')::boolean, updated_at = now() where kiosk_id = s.kiosk_id; end if;
  if p_patch ? 'card' then update public.kiosk_payments set card_enabled = (p_patch->>'card')::boolean, updated_at = now() where kiosk_id = s.kiosk_id; end if;
  if p_patch ? 'pix_direct' then
    if (p_patch->>'pix_direct')::boolean then
      if kp.platform_blocked then raise exception 'Bloqueado pela plataforma. Fale com o suporte.'; end if;
      if not exists (select 1 from public.kiosk_pix_keys x where x.kiosk_id = s.kiosk_id) then raise exception 'Cadastre sua chave Pix antes de ligar o Pix direto.'; end if;
    end if;
    update public.kiosk_payments set pix_direct_enabled = (p_patch->>'pix_direct')::boolean, updated_at = now() where kiosk_id = s.kiosk_id;
  end if;
  m := private.pay_methods(s.kiosk_id);
  if p_patch ? 'checkout_mode' then
    if (p_patch->>'checkout_mode') = 'required' and not (m->>'any')::boolean then
      raise exception 'Para exigir o pagamento, ligue ao menos uma forma de pagamento disponível.';
    end if;
    update public.kiosk_payments set checkout_mode = p_patch->>'checkout_mode', updated_at = now() where kiosk_id = s.kiosk_id;
  end if;
  -- segurança: modo obrigatório sem nenhuma forma de pagamento disponível volta para opcional
  select * into kp from public.kiosk_payments where kiosk_id = s.kiosk_id;
  if kp.checkout_mode = 'required' and not (m->>'any')::boolean then
    update public.kiosk_payments set checkout_mode = 'optional', updated_at = now() where kiosk_id = s.kiosk_id;
    mode_reset := true;
  end if;
  perform private.pay_event(null, s.kiosk_id, 'config_changed', jsonb_build_object('by_role', s.role, 'changes', changes, 'mode_reset', mode_reset));
  return public.payments_panel_get(p_token) || jsonb_build_object('mode_reset', mode_reset);
end $$;

-- admin: ao travar um negócio, desliga também o Pix direto e volta o checkout para opcional
create or replace function public.admin_set_payments_access(p_token text, p_kiosk_id uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.get_session(p_token);
  if s.role <> 'admin' then raise exception 'Acesso negado' using errcode = '42501'; end if;
  insert into public.kiosk_payments(kiosk_id, invited, platform_blocked) values (p_kiosk_id, coalesce(p_allowed,false), not coalesce(p_allowed,false))
    on conflict (kiosk_id) do update set invited = excluded.invited, platform_blocked = excluded.platform_blocked, updated_at = now();
  if not coalesce(p_allowed,false) then
    update public.kiosks set payments_enabled = false, wallets_enabled = false where id = p_kiosk_id;
    update public.kiosk_payments set pix_direct_enabled = false, checkout_mode = 'optional' where kiosk_id = p_kiosk_id;
  end if;
  perform private.pay_event(null, p_kiosk_id, case when p_allowed then 'platform_allowed' else 'platform_blocked' end, null);
end $$;

-- ---------- sinal público "há alguma forma de pagamento disponível" ----------
-- O app do cliente só baixa o módulo de pagamentos quando kiosks.payments_enabled OU kiosks.pay_ui for true.
-- pay_ui nasce false e é mantido por gatilhos a partir de pay_methods(): com tudo desligado, nada de pagamento é carregado nem requisitado.
alter table public.kiosks add column if not exists pay_ui boolean not null default false;

create or replace function private.pay_ui_sync(p_kiosk uuid) returns void language plpgsql security definer set search_path = public, extensions as $$
declare v boolean;
begin
  v := coalesce((private.pay_methods(p_kiosk)->>'any')::boolean, false);
  update public.kiosks set pay_ui = v where id = p_kiosk and pay_ui is distinct from v;
end $$;

create or replace function private.tg_pay_ui() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_table_name = 'kiosks' then perform private.pay_ui_sync(new.id);
  elsif tg_op = 'DELETE' then perform private.pay_ui_sync(old.kiosk_id);
  else perform private.pay_ui_sync(new.kiosk_id); end if;
  return null;
end $$;

drop trigger if exists trg_pay_ui on public.kiosk_payments;
create trigger trg_pay_ui after insert or update on public.kiosk_payments for each row execute function private.tg_pay_ui();
drop trigger if exists trg_pay_ui on public.kiosk_pix_keys;
create trigger trg_pay_ui after insert or update or delete on public.kiosk_pix_keys for each row execute function private.tg_pay_ui();
drop trigger if exists trg_pay_ui on public.kiosks;
create trigger trg_pay_ui after update of payments_enabled, wallets_enabled, is_active, blocked on public.kiosks for each row execute function private.tg_pay_ui();

select private.pay_ui_sync(kiosk_id) from public.kiosk_payments;


-- ---------- permissões ----------
revoke execute on function
  public.payment_manual_settle(text,uuid,text), public.payments_search(text,jsonb,int,int), public.payment_detail(text,uuid),
  public.payment_owner_cancel(text,uuid), public.payment_review_resolve(text,uuid), public.payment_reissue_receipt(text,uuid),
  public.pix_key_set(text,text,text,text,text), public.pix_key_clear(text), public.payments_panel_get(text), public.payments_panel_set(text,jsonb),
  public.payment_prepare(uuid,text,text,text,int,boolean)
from public, anon, authenticated;
grant execute on function
  public.payment_manual_settle(text,uuid,text), public.payments_search(text,jsonb,int,int), public.payment_detail(text,uuid),
  public.payment_owner_cancel(text,uuid), public.payment_review_resolve(text,uuid), public.payment_reissue_receipt(text,uuid),
  public.pix_key_set(text,text,text,text,text), public.pix_key_clear(text), public.payments_panel_get(text), public.payments_panel_set(text,jsonb)
to anon;
grant execute on function public.payment_prepare(uuid,text,text,text,int,boolean) to service_role;
