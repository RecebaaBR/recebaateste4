-- ============ RECEBAA: pagamentos online (Pix + cartão) — NASCEM DESLIGADOS ============
-- Esta migração NÃO liga nada: kiosks.payments_enabled nasce false e só muda por
-- set_payments_settings() (dono), depois de conectar a conta do estabelecimento no provedor.
--
-- Princípios:
--  * Nenhuma tabela nova é legível/gravável pelas chaves públicas (anon/authenticated): RLS ligada, sem policy, sem grant.
--  * O valor cobrado é SEMPRE calculado aqui, no banco, a partir dos pedidos aceitos (nunca vem do navegador).
--  * Funções que mexem em dinheiro (payment_prepare, payment_settle, ...) só executam para service_role
--    (Edge Functions). O navegador só chama: payment_quote, payment_status, receipt_public_check e as
--    funções de equipe/dono (que exigem token de sessão).
--  * Nunca guardamos dados de cartão. Tokens OAuth do provedor ficam CIFRADOS (AES-GCM na Edge Function).
--  * Nenhum dado pessoal no comprovante: o QR leva um token aleatório (192 bits); só o hash fica no banco.

-- ---------- 1. flag por negócio (pública, inofensiva: só diz se o botão "Pagar agora" aparece) ----------
alter table public.kiosks add column if not exists payments_enabled boolean not null default false;
-- Obs.: NÃO está na lista de colunas de staff_write, então o dono/admin não consegue ligar por ali.

-- ---------- 2. conexão do negócio com o provedor (privada) ----------
create table if not exists public.kiosk_payments (
  kiosk_id uuid primary key references public.kiosks(id) on delete cascade,
  provider text check (provider in ('mercadopago','mock')),
  status text not null default 'disconnected' check (status in ('disconnected','connected','sandbox')),
  provider_account_id text,
  access_token_enc text,            -- cifrado na Edge Function (AES-GCM); o banco nunca vê o token em claro
  refresh_token_enc text,
  token_expires_at timestamptz,
  service_percent numeric(4,1) not null default 0 check (service_percent >= 0 and service_percent <= 15),
  invited boolean not null default false,            -- liberação (beta) feita pela plataforma: sem isso o dono nem vê a opção
  platform_blocked boolean not null default false,   -- trava do admin da plataforma
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.kiosk_payments enable row level security;

create table if not exists public.payments_oauth_states (
  state_hash text primary key,
  kiosk_id uuid not null references public.kiosks(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.payments_oauth_states enable row level security;

-- ---------- 3. pagamentos ----------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  kiosk_id uuid not null references public.kiosks(id),
  umbrella_num text not null,
  session_start timestamptz,                          -- início da conta (último ENCERRAMENTO) quando foi criado
  order_ids uuid[] not null,
  subtotal_cents integer not null check (subtotal_cents > 0),
  service_cents integer not null default 0 check (service_cents >= 0),
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 5000000 and amount_cents = subtotal_cents + service_cents),
  currency text not null default 'BRL' check (currency = 'BRL'),
  method text not null check (method in ('pix','card')),
  status text not null default 'created' check (status in ('created','pending','paid','failed','expired','cancelled','refunded')),
  provider text not null check (provider in ('mercadopago','mock')),
  provider_ref text,                                  -- id da cobrança/preferência no provedor
  provider_payment_id text,                           -- id do pagamento efetivo no provedor
  provider_payload jsonb,                             -- só o necessário para retomar: pix_copy_paste, checkout_url (sem dados pessoais)
  idempotency_key text not null,
  client_token_hash text not null,                    -- token do pagador (consultar status)
  confirmation_token_hash text not null,              -- hash do token do comprovante (o que vai no QR)
  expires_at timestamptz not null,
  paid_at timestamptz,
  paid_amount_cents integer,
  late_payment boolean not null default false,        -- pago depois de expirar/cancelar: conferir/estornar à mão
  needs_review boolean not null default false,
  validated_at timestamptz,                           -- 1ª baixa do comprovante pela equipe
  validated_by uuid,
  validation_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_idem_uq unique (kiosk_id, idempotency_key),
  constraint payments_confirm_uq unique (confirmation_token_hash)
);
create index if not exists payments_kiosk_umb_idx on public.payments(kiosk_id, umbrella_num, status);
create index if not exists payments_provider_ref_idx on public.payments(provider, provider_ref) where provider_ref is not null;
alter table public.payments enable row level security;

-- cada pedido só pode estar em UM pagamento ativo (criado/pendente/pago): impede cobrar duas vezes o mesmo consumo
create table if not exists public.payment_orders (
  payment_id uuid not null references public.payments(id) on delete cascade,
  order_id uuid not null references public.orders(id),
  active boolean not null default true,
  primary key (payment_id, order_id)
);
create unique index if not exists payment_orders_active_uq on public.payment_orders(order_id) where active;
alter table public.payment_orders enable row level security;

create table if not exists public.payment_events (
  id bigserial primary key,
  payment_id uuid,
  kiosk_id uuid,
  kind text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payment_events_pay_idx on public.payment_events(payment_id, created_at);
alter table public.payment_events enable row level security;

revoke all on public.kiosk_payments, public.payments_oauth_states, public.payments, public.payment_orders, public.payment_events from public, anon, authenticated;
revoke all on sequence public.payment_events_id_seq from public, anon, authenticated;

-- ---------- 4. auxiliares internos ----------
create or replace function private.pay_event(p_payment uuid, p_kiosk uuid, p_kind text, p_detail jsonb default null)
returns void language sql security definer set search_path = public, extensions as $$
  insert into public.payment_events(payment_id, kiosk_id, kind, detail) values (p_payment, p_kiosk, p_kind, p_detail)
$$;

create or replace function private.pay_deactivate(p_payment uuid)
returns void language sql security definer set search_path = public, extensions as $$
  update public.payment_orders set active = false where payment_id = p_payment and active
$$;

-- expira cobranças vencidas deste negócio/mesa (libera os pedidos para uma nova cobrança)
create or replace function private.pay_expire_stale(p_kiosk uuid, p_umbrella text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  for r in select id from public.payments
            where kiosk_id = p_kiosk and umbrella_num = p_umbrella and status in ('created','pending') and expires_at < now()
            for update loop
    update public.payments set status = 'expired', updated_at = now() where id = r.id;
    perform private.pay_deactivate(r.id);
    perform private.pay_event(r.id, p_kiosk, 'expired');
  end loop;
end $$;

-- início da conta atual da mesa
create or replace function private.pay_session_start(p_kiosk uuid, p_umbrella text)
returns timestamptz language sql stable security definer set search_path = public, extensions as $$
  select max(o.created_at) from public.orders o
   where o.kiosk_id = p_kiosk and o.umbrella_num = p_umbrella and o.customer_name = 'ENCERRAMENTO'
$$;

-- Consumo cobrável da mesa, calculado SÓ do banco:
--  * pedidos da conta atual (depois do último ENCERRAMENTO), reais (não marcadores), ACEITOS pela equipe
--    (pending não entra: o preço ainda não foi conferido por ninguém) e ainda não cobertos por outro pagamento ativo;
--  * valor do pedido = soma(quantidade * preço unitário) dos itens; se o total do pedido divergir dos itens, ou não
--    houver itens, o pedido é marcado como divergente e a cobrança é RECUSADA (falha fechada).
create or replace function private.pay_open_orders(p_kiosk uuid, p_umbrella text)
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
     and o.customer_name not in ('ENCERRAMENTO','PEDIDO DE CONTA','CHAMADA DE ATENDENTE')
     and o.status in ('accepted','preparing','delivering','delivered')
     and not exists (select 1 from public.payment_orders po where po.order_id = o.id and po.active)
   group by o.id, o.total
$$;

-- ---------- 5. cliente (anon): cotação e status ----------
-- Quanto falta pagar na mesa. Só mostra algo se o negócio ligou os pagamentos.
create or replace function public.payment_quote(p_kiosk uuid, p_umbrella text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare en boolean; pct numeric; sub bigint; n int; dv int; pend int; svc bigint; live record; ok boolean;
begin
  select (k.payments_enabled and k.is_active and not coalesce(k.blocked,false)) into en from public.kiosks k where k.id = p_kiosk;
  if not coalesce(en,false) or p_umbrella is null or length(p_umbrella) > 20 then return jsonb_build_object('enabled', false); end if;
  select (kp.status in ('connected','sandbox') and not kp.platform_blocked and kp.invited), kp.service_percent into ok, pct
    from public.kiosk_payments kp where kp.kiosk_id = p_kiosk;
  if not coalesce(ok,false) then return jsonb_build_object('enabled', false); end if;
  perform private.pay_expire_stale(p_kiosk, p_umbrella);
  select coalesce(sum(cents),0), count(*), count(*) filter (where divergent) into sub, n, dv from private.pay_open_orders(p_kiosk, p_umbrella);
  select count(*) into pend from public.orders o
   where o.kiosk_id = p_kiosk and o.umbrella_num = p_umbrella and o.status = 'pending'
     and o.customer_name not in ('ENCERRAMENTO','PEDIDO DE CONTA','CHAMADA DE ATENDENTE')
     and o.created_at > coalesce(private.pay_session_start(p_kiosk, p_umbrella), '-infinity'::timestamptz);
  svc := round(sub * coalesce(pct,0) / 100.0);
  select p.id, p.status, p.method, p.amount_cents, p.expires_at into live from public.payments p
   where p.kiosk_id = p_kiosk and p.umbrella_num = p_umbrella and p.status in ('created','pending') and p.expires_at >= now()
   order by p.created_at desc limit 1;
  return jsonb_build_object('enabled', true, 'subtotal_cents', sub, 'service_cents', svc, 'amount_cents', sub + svc,
    'service_percent', coalesce(pct,0), 'order_count', n, 'divergent_count', dv, 'pending_orders', pend,
    'live_payment', case when live.id is null then null else jsonb_build_object('id', live.id, 'status', live.status,
        'method', live.method, 'amount_cents', live.amount_cents, 'expires_at', live.expires_at) end);
end $$;

-- Status do pagamento, para quem tem o token do pagador (devolvido uma única vez, na criação).
create or replace function public.payment_status(p_payment_id uuid, p_client_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare p public.payments; b text := 'pstat:' || coalesce(p_payment_id::text,'');
begin
  if p_payment_id is null or length(coalesce(p_client_token,'')) < 20 or length(p_client_token) > 200 then
    return jsonb_build_object('found', false);
  end if;
  if private.rate_limited(b, 20, interval '10 minutes') then raise exception 'Muitas tentativas. Aguarde.'; end if;
  select * into p from public.payments x
   where x.id = p_payment_id and x.client_token_hash = encode(extensions.digest(p_client_token, 'sha256'), 'hex');
  if not found then perform private.rate_hit(b); return jsonb_build_object('found', false); end if;
  if p.status in ('created','pending') and p.expires_at < now() then
    perform private.pay_expire_stale(p.kiosk_id, p.umbrella_num);
    select * into p from public.payments x where x.id = p_payment_id;
  end if;
  return jsonb_build_object('found', true, 'id', p.id, 'status', p.status, 'method', p.method,
    'amount_cents', p.amount_cents, 'subtotal_cents', p.subtotal_cents, 'service_cents', p.service_cents,
    'umbrella_num', p.umbrella_num, 'expires_at', p.expires_at, 'paid_at', p.paid_at,
    'pix_copy_paste', case when p.status in ('created','pending') then p.provider_payload->>'pix_copy_paste' end,
    'checkout_url', case when p.status in ('created','pending') then p.provider_payload->>'checkout_url' end,
    'provider', p.provider,
    'kiosk_name', (select k.name from public.kiosks k where k.id = p.kiosk_id));
end $$;

-- Verificação pública do comprovante (quem escaneia o QR com a câmera do celular, sem login).
-- Devolve o mínimo: sem nome de cliente, sem dados do pagador.
create or replace function public.receipt_public_check(p_receipt text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare p public.payments;
begin
  if length(coalesce(p_receipt,'')) < 20 or length(p_receipt) > 200 then return jsonb_build_object('valid', false); end if;
  select * into p from public.payments x where x.confirmation_token_hash = encode(extensions.digest(p_receipt, 'sha256'), 'hex');
  if not found then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object('valid', p.status = 'paid', 'status', p.status, 'amount_cents', p.amount_cents,
    'method', p.method, 'umbrella_num', p.umbrella_num, 'paid_at', p.paid_at,
    'kiosk_name', (select k.name from public.kiosks k where k.id = p.kiosk_id),
    'validated_at', p.validated_at);
end $$;

-- ---------- 6. equipe (token de sessão): validar comprovante, listar ----------
create or replace function public.verify_payment_receipt(p_token text, p_receipt text, p_mark boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; p public.payments; first_time boolean := false;
begin
  s := private.staff_session(p_token);
  if private.rate_limited('pverify:' || s.kiosk_id, 120, interval '1 minute') then raise exception 'Muitas verificações. Aguarde.'; end if;
  perform private.rate_hit('pverify:' || s.kiosk_id);
  if length(coalesce(p_receipt,'')) < 20 or length(p_receipt) > 200 then return jsonb_build_object('valid', false, 'reason', 'not_found'); end if;
  select * into p from public.payments x
   where x.confirmation_token_hash = encode(extensions.digest(p_receipt, 'sha256'), 'hex') and x.kiosk_id = s.kiosk_id;
  if not found then return jsonb_build_object('valid', false, 'reason', 'not_found'); end if;   -- inclusive comprovante de OUTRO negócio
  if p.status <> 'paid' then
    return jsonb_build_object('valid', false, 'reason', p.status, 'amount_cents', p.amount_cents, 'umbrella_num', p.umbrella_num);
  end if;
  if p_mark then
    if p.validated_at is null then
      first_time := true;
      update public.payments set validated_at = now(), validated_by = s.subject_id, validation_count = 1, updated_at = now() where id = p.id
        returning * into p;
    else
      update public.payments set validation_count = validation_count + 1 where id = p.id returning * into p;
    end if;
    perform private.pay_event(p.id, p.kiosk_id, case when first_time then 'receipt_validated' else 'receipt_revalidated' end,
                              jsonb_build_object('by', s.subject_id));
  end if;
  return jsonb_build_object('valid', true, 'reason', 'paid', 'amount_cents', p.amount_cents, 'subtotal_cents', p.subtotal_cents,
    'service_cents', p.service_cents, 'method', p.method, 'umbrella_num', p.umbrella_num, 'paid_at', p.paid_at,
    'already_validated', not first_time and p.validated_at is not null, 'first_validation', first_time,
    'validated_at', p.validated_at, 'validation_count', p.validation_count, 'late_payment', p.late_payment);
end $$;

create or replace function public.payments_list(p_token text, p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.staff_session(p_token);
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select p.id, p.umbrella_num, p.method, p.status, p.amount_cents, p.service_cents, p.paid_at, p.created_at,
           p.validated_at, p.late_payment, p.needs_review
      from public.payments p where p.kiosk_id = s.kiosk_id and p.status <> 'created'
      order by p.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x), '[]'::jsonb);
end $$;

-- ---------- 7. dono: ligar/desligar, serviço, desconectar; admin: travar ----------
create or replace function public.payments_owner_status(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; k public.kiosks; kp public.kiosk_payments;
begin
  s := private.staff_session(p_token);
  select * into k from public.kiosks where id = s.kiosk_id;
  select * into kp from public.kiosk_payments where kiosk_id = s.kiosk_id;
  return jsonb_build_object('role', s.role, 'enabled', coalesce(k.payments_enabled,false),
    'connection', coalesce(kp.status,'disconnected'), 'provider', kp.provider,
    'account', case when kp.provider_account_id is null then null else '…' || right(kp.provider_account_id, 4) end,
    'service_percent', coalesce(kp.service_percent,0), 'platform_blocked', coalesce(kp.platform_blocked,false),
    'available', coalesce(kp.invited,false) and not coalesce(kp.platform_blocked,false));
end $$;

create or replace function public.set_payments_settings(p_token text, p_enabled boolean default null, p_service_percent numeric default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; kp public.kiosk_payments;
begin
  s := private.owner_session(p_token);
  select * into kp from public.kiosk_payments where kiosk_id = s.kiosk_id;
  if kp.kiosk_id is null or not kp.invited then raise exception 'Pagamentos online ainda não foram liberados para este negócio.'; end if;
  if p_service_percent is not null then
    if p_service_percent < 0 or p_service_percent > 15 then raise exception 'Taxa de serviço inválida (0 a 15%%)'; end if;
    insert into public.kiosk_payments(kiosk_id, service_percent) values (s.kiosk_id, p_service_percent)
      on conflict (kiosk_id) do update set service_percent = excluded.service_percent, updated_at = now();
    perform private.pay_event(null, s.kiosk_id, 'service_percent_set', jsonb_build_object('pct', p_service_percent));
  end if;
  if p_enabled is not null then
    if p_enabled then
      if kp.kiosk_id is null or kp.status not in ('connected','sandbox') then
        raise exception 'Conecte sua conta do provedor de pagamentos antes de ativar.';
      end if;
      if kp.platform_blocked then raise exception 'Pagamentos online indisponíveis para este negócio. Fale com o suporte.'; end if;
    end if;
    update public.kiosks set payments_enabled = p_enabled where id = s.kiosk_id;
    perform private.pay_event(null, s.kiosk_id, case when p_enabled then 'enabled' else 'disabled' end, jsonb_build_object('by', s.subject_id));
  end if;
  return public.payments_owner_status(p_token);
end $$;

create or replace function public.payments_disconnect(p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  update public.kiosk_payments set status = 'disconnected', access_token_enc = null, refresh_token_enc = null,
         token_expires_at = null, provider_account_id = null, updated_at = now() where kiosk_id = s.kiosk_id;
  update public.kiosks set payments_enabled = false where id = s.kiosk_id;
  perform private.pay_event(null, s.kiosk_id, 'disconnected', null);
end $$;

-- Libera (beta) ou trava um negócio. Liberar = o dono passa a ver "Pagamentos online" e pode conectar a conta.
-- Travar = desliga a flag na hora e impede religar.
create or replace function public.admin_set_payments_access(p_token text, p_kiosk_id uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.get_session(p_token);
  if s.role <> 'admin' then raise exception 'Acesso negado' using errcode = '42501'; end if;
  insert into public.kiosk_payments(kiosk_id, invited, platform_blocked) values (p_kiosk_id, coalesce(p_allowed,false), not coalesce(p_allowed,false))
    on conflict (kiosk_id) do update set invited = excluded.invited, platform_blocked = excluded.platform_blocked, updated_at = now();
  if not coalesce(p_allowed,false) then update public.kiosks set payments_enabled = false where id = p_kiosk_id; end if;
  perform private.pay_event(null, p_kiosk_id, case when p_allowed then 'platform_allowed' else 'platform_blocked' end, null);
end $$;

-- ---------- 8. SOMENTE service_role (Edge Functions) ----------
create or replace function public.payment_rate_hit(p_bucket text, p_max int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if private.rate_limited(p_bucket, p_max, make_interval(secs => p_window_seconds)) then return false; end if;
  perform private.rate_hit(p_bucket);
  return true;
end $$;

create or replace function public.payments_owner_kiosk(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  if not exists (select 1 from public.kiosk_payments kp where kp.kiosk_id = s.kiosk_id and kp.invited and not kp.platform_blocked) then
    raise exception 'Pagamentos online ainda não foram liberados para este negócio.';
  end if;
  return jsonb_build_object('kiosk_id', s.kiosk_id);
end $$;

create or replace function public.payments_oauth_begin(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; st text;
begin
  s := private.owner_session(p_token);
  if not exists (select 1 from public.kiosk_payments kp where kp.kiosk_id = s.kiosk_id and kp.invited and not kp.platform_blocked) then
    raise exception 'Pagamentos online ainda não foram liberados para este negócio.';
  end if;
  st := encode(extensions.gen_random_bytes(24), 'hex');
  delete from public.payments_oauth_states where expires_at < now();
  insert into public.payments_oauth_states(state_hash, kiosk_id, expires_at)
    values (encode(extensions.digest(st, 'sha256'), 'hex'), s.kiosk_id, now() + interval '15 minutes');
  return jsonb_build_object('state', st, 'kiosk_id', s.kiosk_id);
end $$;

create or replace function public.payments_oauth_consume(p_state text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare k uuid;
begin
  delete from public.payments_oauth_states
   where state_hash = encode(extensions.digest(coalesce(p_state,''), 'sha256'), 'hex') and expires_at > now()
  returning kiosk_id into k;
  if k is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'kiosk_id', k);
end $$;

create or replace function public.payments_store_connection(
  p_kiosk uuid, p_provider text, p_account_id text, p_access_enc text, p_refresh_enc text, p_expires_at timestamptz, p_status text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_status not in ('connected','sandbox') then raise exception 'Estado inválido'; end if;
  insert into public.kiosk_payments(kiosk_id, provider, status, provider_account_id, access_token_enc, refresh_token_enc, token_expires_at, connected_at)
  values (p_kiosk, p_provider, p_status, p_account_id, p_access_enc, p_refresh_enc, p_expires_at, now())
  on conflict (kiosk_id) do update set provider = excluded.provider, status = excluded.status,
    provider_account_id = excluded.provider_account_id, access_token_enc = excluded.access_token_enc,
    refresh_token_enc = excluded.refresh_token_enc, token_expires_at = excluded.token_expires_at,
    connected_at = now(), updated_at = now();
  perform private.pay_event(null, p_kiosk, 'connected', jsonb_build_object('provider', p_provider, 'status', p_status));
end $$;

-- Cria a cobrança (linha local) com o valor calculado AQUI. Idempotente por (negócio, chave).
create or replace function public.payment_prepare(p_kiosk uuid, p_umbrella text, p_method text, p_idem text, p_ttl_minutes int default 20)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  k public.kiosks; kp public.kiosk_payments; ex public.payments; sub bigint; n int; dv int; svc bigint;
  live record; ctok text; rtok text; pid uuid; ords uuid[]; conn jsonb;
begin
  if p_method not in ('pix','card') then raise exception 'E_BAD_REQUEST'; end if;
  if p_umbrella is null or p_umbrella !~ '^[0-9]{1,6}$' then raise exception 'E_BAD_REQUEST'; end if;
  if length(coalesce(p_idem,'')) < 16 or length(p_idem) > 100 then raise exception 'E_BAD_REQUEST'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_kiosk::text || ':' || p_umbrella, 0));

  select * into k from public.kiosks where id = p_kiosk;
  if not found or not k.payments_enabled or not k.is_active or coalesce(k.blocked,false) then raise exception 'E_PAYMENTS_DISABLED'; end if;
  select * into kp from public.kiosk_payments where kiosk_id = p_kiosk;
  if not found or kp.status not in ('connected','sandbox') or kp.platform_blocked or not kp.invited then raise exception 'E_PAYMENTS_DISABLED'; end if;
  if not exists (select 1 from public.umbrellas u where u.kiosk_id = p_kiosk and u.number = p_umbrella::int and u.is_active) then
    raise exception 'E_UMBRELLA_NOT_FOUND';
  end if;

  conn := jsonb_build_object('provider', kp.provider, 'status', kp.status, 'account_id', kp.provider_account_id,
                             'access_enc', kp.access_token_enc, 'refresh_enc', kp.refresh_token_enc, 'expires_at', kp.token_expires_at);

  -- repetição da mesma chave: devolve a mesma cobrança (sem emitir tokens de novo)
  select * into ex from public.payments where kiosk_id = p_kiosk and idempotency_key = p_idem;
  if found then
    if ex.umbrella_num <> p_umbrella or ex.method <> p_method then raise exception 'E_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('existing', true, 'payment_id', ex.id, 'status', ex.status, 'method', ex.method,
      'amount_cents', ex.amount_cents, 'subtotal_cents', ex.subtotal_cents, 'service_cents', ex.service_cents,
      'expires_at', ex.expires_at, 'provider', ex.provider, 'provider_ref', ex.provider_ref, 'umbrella_num', ex.umbrella_num,
      'pix_copy_paste', ex.provider_payload->>'pix_copy_paste', 'checkout_url', ex.provider_payload->>'checkout_url',
      'kiosk_name', k.name, 'connection', conn);
  end if;

  perform private.pay_expire_stale(p_kiosk, p_umbrella);

  select p.id, p.expires_at, p.status into live from public.payments p
   where p.kiosk_id = p_kiosk and p.umbrella_num = p_umbrella and p.status in ('created','pending') order by p.created_at desc limit 1;
  if found then
    perform private.pay_event(live.id, p_kiosk, 'blocked_in_progress', null);
    raise exception 'E_PAYMENT_IN_PROGRESS';
  end if;

  select coalesce(sum(cents),0), count(*), count(*) filter (where divergent), array_agg(order_id)
    into sub, n, dv, ords from private.pay_open_orders(p_kiosk, p_umbrella);
  if n = 0 or sub <= 0 then raise exception 'E_NOTHING_TO_PAY'; end if;
  if dv > 0 then raise exception 'E_ORDER_MISMATCH'; end if;
  svc := round(sub * kp.service_percent / 100.0);
  if sub + svc > 5000000 then raise exception 'E_AMOUNT_TOO_HIGH'; end if;

  ctok := encode(extensions.gen_random_bytes(24), 'hex');
  rtok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.payments(kiosk_id, umbrella_num, session_start, order_ids, subtotal_cents, service_cents, amount_cents, method,
      provider, idempotency_key, client_token_hash, confirmation_token_hash, expires_at)
  values (p_kiosk, p_umbrella, private.pay_session_start(p_kiosk, p_umbrella), ords, sub, svc, sub + svc, p_method,
      kp.provider, p_idem, encode(extensions.digest(ctok, 'sha256'), 'hex'), encode(extensions.digest(rtok, 'sha256'), 'hex'),
      now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 20), 60))))
  returning id into pid;
  insert into public.payment_orders(payment_id, order_id) select pid, unnest(ords);
  perform private.pay_event(pid, p_kiosk, 'created', jsonb_build_object('method', p_method, 'amount_cents', sub + svc));

  return jsonb_build_object('existing', false, 'payment_id', pid, 'status', 'created', 'method', p_method,
    'amount_cents', sub + svc, 'subtotal_cents', sub, 'service_cents', svc,
    'expires_at', (select expires_at from public.payments where id = pid), 'provider', kp.provider,
    'umbrella_num', p_umbrella, 'kiosk_name', k.name, 'client_token', ctok, 'receipt_token', rtok, 'connection', conn);
end $$;

create or replace function public.payment_attach_charge(p_payment_id uuid, p_provider_ref text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.payments set status = 'pending', provider_ref = p_provider_ref, provider_payload = p_payload, updated_at = now()
   where id = p_payment_id and status = 'created';
  perform private.pay_event(p_payment_id, null, 'charge_created', jsonb_build_object('ref', p_provider_ref));
end $$;

create or replace function public.payment_mark_failed(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.payments set status = 'failed', updated_at = now() where id = p_payment_id and status = 'created';
  if found then perform private.pay_deactivate(p_payment_id); end if;
  perform private.pay_event(p_payment_id, null, 'charge_failed', jsonb_build_object('reason', left(coalesce(p_reason,''), 200)));
end $$;

-- Dados para webhook/atualização: negócio, provedor, valor esperado e credenciais cifradas DO NEGÓCIO DONO DA COBRANÇA.
create or replace function public.payment_for_webhook(p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare p public.payments; kp public.kiosk_payments;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return jsonb_build_object('found', false); end if;
  select * into kp from public.kiosk_payments where kiosk_id = p.kiosk_id;
  return jsonb_build_object('found', true, 'payment_id', p.id, 'kiosk_id', p.kiosk_id, 'status', p.status, 'method', p.method,
    'amount_cents', p.amount_cents, 'provider', p.provider, 'provider_ref', p.provider_ref,
    'connection', jsonb_build_object('provider', kp.provider, 'status', kp.status, 'account_id', kp.provider_account_id,
      'access_enc', kp.access_token_enc, 'refresh_enc', kp.refresh_token_enc, 'expires_at', kp.token_expires_at));
end $$;

-- Aplica o resultado CONFIRMADO NO PROVEDOR (a Edge Function consulta o provedor; nunca usa só o corpo do webhook).
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

create or replace function public.payment_cancel_apply(p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare st text;
begin
  update public.payments set status = 'cancelled', updated_at = now()
   where id = p_payment_id and status in ('created','pending') returning status into st;
  if st is null then return jsonb_build_object('cancelled', false); end if;
  perform private.pay_deactivate(p_payment_id);
  perform private.pay_event(p_payment_id, null, 'cancelled', null);
  return jsonb_build_object('cancelled', true);
end $$;

create or replace function public.payment_event_log(p_payment_id uuid, p_kind text, p_detail jsonb default null)
returns void language sql security definer set search_path = public, extensions as $$
  select private.pay_event(p_payment_id, (select kiosk_id from public.payments where id = p_payment_id), left(p_kind, 40), p_detail)
$$;

-- ---------- 9. permissões ----------
revoke execute on function
  public.payment_quote(uuid,text), public.payment_status(uuid,text), public.receipt_public_check(text),
  public.verify_payment_receipt(text,text,boolean), public.payments_list(text,int),
  public.payments_owner_status(text), public.set_payments_settings(text,boolean,numeric), public.payments_disconnect(text),
  public.admin_set_payments_access(text,uuid,boolean),
  public.payment_rate_hit(text,int,int), public.payments_owner_kiosk(text), public.payments_oauth_begin(text),
  public.payments_oauth_consume(text), public.payments_store_connection(uuid,text,text,text,text,timestamptz,text),
  public.payment_prepare(uuid,text,text,text,int), public.payment_attach_charge(uuid,text,jsonb),
  public.payment_mark_failed(uuid,text), public.payment_for_webhook(uuid),
  public.payment_settle(uuid,text,integer,text,text,jsonb), public.payment_cancel_apply(uuid), public.payment_event_log(uuid,text,jsonb)
from public, anon, authenticated;

-- navegador (chave pública): só o que exige token do cliente/equipe ou é cotação sem segredo
grant execute on function
  public.payment_quote(uuid,text), public.payment_status(uuid,text), public.receipt_public_check(text),
  public.verify_payment_receipt(text,text,boolean), public.payments_list(text,int),
  public.payments_owner_status(text), public.set_payments_settings(text,boolean,numeric), public.payments_disconnect(text),
  public.admin_set_payments_access(text,uuid,boolean)
to anon;

-- Edge Functions (service_role): tudo o que mexe em dinheiro/credenciais
grant execute on function
  public.payment_rate_hit(text,int,int), public.payments_owner_kiosk(text), public.payments_oauth_begin(text),
  public.payments_oauth_consume(text), public.payments_store_connection(uuid,text,text,text,text,timestamptz,text),
  public.payment_prepare(uuid,text,text,text,int), public.payment_attach_charge(uuid,text,jsonb),
  public.payment_mark_failed(uuid,text), public.payment_for_webhook(uuid),
  public.payment_settle(uuid,text,integer,text,text,jsonb), public.payment_cancel_apply(uuid), public.payment_event_log(uuid,text,jsonb),
  public.payment_status(uuid,text), public.payments_owner_status(text)
to service_role;
