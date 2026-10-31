-- Código secreto por mesa/guarda-sol (opção 2 do QR por mesa).
-- NÃO APLICADO EM PRODUÇÃO. Rodar só depois de aprovado.
-- Ativação gradual: a coluna kiosks.require_umbrella_code começa em false; nada muda
-- para ninguém até o dono imprimir os QRs novos e ligar a exigência.

create schema if not exists private;

create table if not exists private.umbrella_codes (
  umbrella_id uuid primary key references public.umbrellas(id) on delete cascade,
  kiosk_id uuid not null references public.kiosks(id) on delete cascade,
  code text not null
);
revoke all on private.umbrella_codes from public, anon, authenticated;

alter table public.kiosks add column if not exists require_umbrella_code boolean not null default false;

create or replace function private.new_umbrella_code() returns text
language sql as $$ select substr(translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=', 'xyz'), 1, 10) $$;

create or replace function private.umbrella_code_trg() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into private.umbrella_codes(umbrella_id, kiosk_id, code) values (new.id, new.kiosk_id, private.new_umbrella_code())
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists umbrella_code_ins on public.umbrellas;
create trigger umbrella_code_ins after insert on public.umbrellas for each row execute function private.umbrella_code_trg();

-- códigos para as mesas que já existem
insert into private.umbrella_codes(umbrella_id, kiosk_id, code)
select u.id, u.kiosk_id, private.new_umbrella_code() from public.umbrellas u
on conflict do nothing;

-- confere o código de uma mesa (sem revelar o código certo)
create or replace function private.code_ok(p_kiosk uuid, p_umbrella text, p_code text) returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.umbrellas u join private.umbrella_codes c on c.umbrella_id = u.id
     where u.kiosk_id = p_kiosk and u.number::text = p_umbrella and u.is_active
       and c.code = coalesce(p_code, '')
  )
$$;

-- cliente: a mesa exige código? o código do link está certo?
create or replace function public.umbrella_access(p_kiosk uuid, p_umbrella text, p_code text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare req boolean;
begin
  select coalesce(k.require_umbrella_code, false) into req from public.kiosks k where k.id = p_kiosk;
  return jsonb_build_object('required', coalesce(req, false),
                            'ok', (not coalesce(req, false)) or private.code_ok(p_kiosk, p_umbrella, p_code));
end $$;

-- dono/garçom: lista os códigos do próprio negócio (para imprimir os QRs)
create or replace function public.staff_umbrella_codes(p_token text)
returns table(umbrella_id uuid, number int, code text)
language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.staff_session(p_token);
  return query select u.id, u.number, c.code from public.umbrellas u
    join private.umbrella_codes c on c.umbrella_id = u.id where u.kiosk_id = s.kiosk_id order by u.number;
end $$;

-- dono: troca o código de uma mesa (QR antigo para de funcionar)
create or replace function public.staff_rotate_umbrella_code(p_token text, p_umbrella_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; nc text;
begin
  s := private.owner_session(p_token);
  nc := private.new_umbrella_code();
  update private.umbrella_codes set code = nc where umbrella_id = p_umbrella_id and kiosk_id = s.kiosk_id;
  if not found then raise exception 'Mesa não encontrada'; end if;
  return nc;
end $$;

-- dono: liga/desliga a exigência do código (p_value nulo apenas consulta o estado atual)
create or replace function public.staff_set_require_code(p_token text, p_value boolean)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; cur boolean;
begin
  s := private.owner_session(p_token);
  if p_value is not null then
    update public.kiosks set require_umbrella_code = p_value where id = s.kiosk_id;
  end if;
  select coalesce(k.require_umbrella_code, false) into cur from public.kiosks k where k.id = s.kiosk_id;
  return cur;
end $$;

-- place_order: exige o código quando o negócio ligou a exigência.
-- Pedido lançado pela equipe (sessão válida do mesmo negócio) não precisa de código.
create or replace function public.place_order(p_order jsonb, p_items jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare kid uuid; ok boolean; n int; obj jsonb; res jsonb; new_id uuid; req boolean; is_staff boolean := false; ss public.app_sessions;
begin
  kid := (p_order->>'kiosk_id')::uuid;
  select (k.is_active and not coalesce(k.blocked, false)), coalesce(k.require_umbrella_code, false) into ok, req from public.kiosks k where k.id = kid;
  if not coalesce(ok, false) then raise exception 'Negócio indisponível'; end if;
  if req then
    if coalesce(p_order->>'staff_token', '') <> '' then
      begin
        ss := private.staff_session(p_order->>'staff_token');
        is_staff := (ss.kiosk_id = kid);
      exception when others then is_staff := false;
      end;
    end if;
    if not is_staff and not private.code_ok(kid, p_order->>'umbrella_num', p_order->>'access_code') then
      raise exception 'QR inválido para esta mesa. Escaneie o QR da sua mesa.';
    end if;
  end if;
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
  select r.kiosk_id, r.umbrella_num, r.customer_name, r.notes, r.status, r.total, r.idempotency_key, r.created_by, r.last_updated_by, coalesce(r.service_amount, 0)
    from jsonb_populate_record(null::public.orders, obj) r
  returning to_jsonb(orders.*), orders.id into res, new_id;
  if p_items is not null then perform private.insert_items(new_id, p_items); end if;
  return res;
end $$;

revoke execute on function public.umbrella_access(uuid,text,text), public.staff_umbrella_codes(text),
  public.staff_rotate_umbrella_code(text,uuid), public.staff_set_require_code(text,boolean) from public, anon, authenticated;
grant execute on function public.umbrella_access(uuid,text,text), public.staff_umbrella_codes(text),
  public.staff_rotate_umbrella_code(text,uuid), public.staff_set_require_code(text,boolean) to anon;
