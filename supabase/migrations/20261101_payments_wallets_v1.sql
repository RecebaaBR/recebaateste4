-- ============ RECEBAA: carteiras (Apple Pay / Google Pay) via Stripe — NASCEM DESLIGADAS ============
-- Complementa 20261031_payments_v1.sql (Mercado Pago continua sendo Pix e cartão). NÃO aplicar sem ler docs/pagamentos.md.
--
--  * kiosks.wallets_enabled (default false) é uma flag SEPARADA e só pode ficar ligada se payments_enabled estiver ligada
--    (constraint no banco) e o negócio estiver liberado pela plataforma (invited) e conectado à Stripe.
--  * Modelo de dinheiro: Stripe Connect com *direct charges*: o PaymentIntent é criado NA CONTA CONECTADA do estabelecimento
--    (cabeçalho Stripe-Account), então o Recebaa não custodia. PENDENTE DE VALIDAÇÃO: disponibilidade do Connect para contas
--    brasileiras (ver docs/pagamentos.md). Guardamos só o id da conta (acct_...), nenhum token do estabelecimento.
--  * 'wallet' passa a ser um método em payments; provider 'stripe'.

alter table public.kiosks add column if not exists wallets_enabled boolean not null default false;
alter table public.kiosks drop constraint if exists kiosks_wallets_need_payments;
alter table public.kiosks add constraint kiosks_wallets_need_payments check (not wallets_enabled or payments_enabled);

alter table public.kiosk_payments add column if not exists stripe_account_id text;
alter table public.kiosk_payments add column if not exists wallets_status text not null default 'disconnected';
alter table public.kiosk_payments drop constraint if exists kiosk_payments_wallets_status_check;
alter table public.kiosk_payments add constraint kiosk_payments_wallets_status_check check (wallets_status in ('disconnected','connected','sandbox'));
alter table public.kiosk_payments drop constraint if exists kiosk_payments_stripe_account_format;
alter table public.kiosk_payments add constraint kiosk_payments_stripe_account_format check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]{6,64}$');

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check check (method in ('pix','card','wallet'));
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('mercadopago','mock','stripe'));

-- ---------- cotação: informa se a carteira está disponível ----------
create or replace function public.payment_quote(p_kiosk uuid, p_umbrella text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare en boolean; wl boolean; pct numeric; sub bigint; n int; dv int; pend int; svc bigint; live record; ok boolean; wok boolean;
begin
  select (k.payments_enabled and k.is_active and not coalesce(k.blocked,false)), k.wallets_enabled into en, wl from public.kiosks k where k.id = p_kiosk;
  if not coalesce(en,false) or p_umbrella is null or length(p_umbrella) > 20 then return jsonb_build_object('enabled', false); end if;
  select (kp.status in ('connected','sandbox') and not kp.platform_blocked and kp.invited), kp.service_percent,
         (kp.wallets_status in ('connected','sandbox') and kp.stripe_account_id is not null)
    into ok, pct, wok from public.kiosk_payments kp where kp.kiosk_id = p_kiosk;
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
    'wallets_available', coalesce(wl,false) and coalesce(wok,false),
    'live_payment', case when live.id is null then null else jsonb_build_object('id', live.id, 'status', live.status,
        'method', live.method, 'amount_cents', live.amount_cents, 'expires_at', live.expires_at) end);
end $$;

-- ---------- status: devolve o client_secret da carteira enquanto pendente ----------
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
    'client_secret', case when p.status in ('created','pending') then p.provider_payload->>'client_secret' end,
    'provider', p.provider,
    'kiosk_name', (select k.name from public.kiosks k where k.id = p.kiosk_id));
end $$;

-- ---------- status do dono: inclui carteiras ----------
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
    'available', coalesce(kp.invited,false) and not coalesce(kp.platform_blocked,false),
    'wallets_enabled', coalesce(k.wallets_enabled,false), 'wallets_connection', coalesce(kp.wallets_status,'disconnected'),
    'wallets_account', case when kp.stripe_account_id is null then null else '…' || right(kp.stripe_account_id, 4) end);
end $$;

-- ---------- ligar/desligar (assinatura nova: + p_wallets_enabled) ----------
drop function if exists public.set_payments_settings(text, boolean, numeric);
create or replace function public.set_payments_settings(p_token text, p_enabled boolean default null, p_service_percent numeric default null, p_wallets_enabled boolean default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions; kp public.kiosk_payments; k public.kiosks;
begin
  s := private.owner_session(p_token);
  select * into kp from public.kiosk_payments where kiosk_id = s.kiosk_id;
  if kp.kiosk_id is null or not kp.invited then raise exception 'Pagamentos online ainda não foram liberados para este negócio.'; end if;
  if p_service_percent is not null then
    if p_service_percent < 0 or p_service_percent > 15 then raise exception 'Taxa de serviço inválida (0 a 15%%)'; end if;
    update public.kiosk_payments set service_percent = p_service_percent, updated_at = now() where kiosk_id = s.kiosk_id;
    perform private.pay_event(null, s.kiosk_id, 'service_percent_set', jsonb_build_object('pct', p_service_percent));
  end if;
  if p_enabled is not null then
    if p_enabled then
      if kp.status not in ('connected','sandbox') then raise exception 'Conecte sua conta do provedor de pagamentos antes de ativar.'; end if;
      if kp.platform_blocked then raise exception 'Pagamentos online indisponíveis para este negócio. Fale com o suporte.'; end if;
      update public.kiosks set payments_enabled = true where id = s.kiosk_id;
    else
      update public.kiosks set payments_enabled = false, wallets_enabled = false where id = s.kiosk_id;   -- carteiras dependem dos pagamentos
    end if;
    perform private.pay_event(null, s.kiosk_id, case when p_enabled then 'enabled' else 'disabled' end, jsonb_build_object('by', s.subject_id));
  end if;
  if p_wallets_enabled is not null then
    if p_wallets_enabled then
      select * into k from public.kiosks where id = s.kiosk_id;
      if not k.payments_enabled then raise exception 'Ative primeiro os pagamentos online (Pix e cartão).'; end if;
      if kp.platform_blocked then raise exception 'Pagamentos online indisponíveis para este negócio. Fale com o suporte.'; end if;
      if kp.wallets_status not in ('connected','sandbox') or kp.stripe_account_id is null then
        raise exception 'Conecte sua conta Stripe antes de ativar Apple Pay e Google Pay.';
      end if;
    end if;
    update public.kiosks set wallets_enabled = p_wallets_enabled where id = s.kiosk_id;
    perform private.pay_event(null, s.kiosk_id, case when p_wallets_enabled then 'wallets_enabled' else 'wallets_disabled' end, jsonb_build_object('by', s.subject_id));
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
  update public.kiosks set payments_enabled = false, wallets_enabled = false where id = s.kiosk_id;
  perform private.pay_event(null, s.kiosk_id, 'disconnected', null);
end $$;

create or replace function public.payments_disconnect_wallets(p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.owner_session(p_token);
  update public.kiosk_payments set wallets_status = 'disconnected', stripe_account_id = null, updated_at = now() where kiosk_id = s.kiosk_id;
  update public.kiosks set wallets_enabled = false where id = s.kiosk_id;
  perform private.pay_event(null, s.kiosk_id, 'wallets_disconnected', null);
end $$;

create or replace function public.admin_set_payments_access(p_token text, p_kiosk_id uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.app_sessions;
begin
  s := private.get_session(p_token);
  if s.role <> 'admin' then raise exception 'Acesso negado' using errcode = '42501'; end if;
  insert into public.kiosk_payments(kiosk_id, invited, platform_blocked) values (p_kiosk_id, coalesce(p_allowed,false), not coalesce(p_allowed,false))
    on conflict (kiosk_id) do update set invited = excluded.invited, platform_blocked = excluded.platform_blocked, updated_at = now();
  if not coalesce(p_allowed,false) then update public.kiosks set payments_enabled = false, wallets_enabled = false where id = p_kiosk_id; end if;
  perform private.pay_event(null, p_kiosk_id, case when p_allowed then 'platform_allowed' else 'platform_blocked' end, null);
end $$;

-- ---------- service_role: conexão Stripe, configuração pública, prepare e webhook ----------
create or replace function public.payments_store_stripe_account(p_kiosk uuid, p_account_id text, p_status text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_status not in ('connected','sandbox') then raise exception 'Estado inválido'; end if;
  if p_account_id !~ '^acct_[A-Za-z0-9]{6,64}$' then raise exception 'Conta inválida'; end if;
  insert into public.kiosk_payments(kiosk_id, stripe_account_id, wallets_status) values (p_kiosk, p_account_id, p_status)
  on conflict (kiosk_id) do update set stripe_account_id = excluded.stripe_account_id, wallets_status = excluded.wallets_status, updated_at = now();
  perform private.pay_event(null, p_kiosk, 'wallets_connected', jsonb_build_object('status', p_status));
end $$;

-- o front só descobre a conta conectada se as carteiras estiverem efetivamente ligadas
create or replace function public.wallet_public_config(p_kiosk uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare k public.kiosks; kp public.kiosk_payments;
begin
  select * into k from public.kiosks where id = p_kiosk;
  select * into kp from public.kiosk_payments where kiosk_id = p_kiosk;
  if not found or k.id is null or not k.payments_enabled or not k.wallets_enabled or not k.is_active or coalesce(k.blocked,false)
     or not kp.invited or kp.platform_blocked or kp.status not in ('connected','sandbox')
     or kp.wallets_status not in ('connected','sandbox') or kp.stripe_account_id is null then
    return jsonb_build_object('enabled', false);
  end if;
  return jsonb_build_object('enabled', true, 'stripe_account', kp.stripe_account_id);
end $$;

create or replace function public.payment_for_webhook(p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare p public.payments; kp public.kiosk_payments;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return jsonb_build_object('found', false); end if;
  select * into kp from public.kiosk_payments where kiosk_id = p.kiosk_id;
  return jsonb_build_object('found', true, 'payment_id', p.id, 'kiosk_id', p.kiosk_id, 'status', p.status, 'method', p.method,
    'amount_cents', p.amount_cents, 'provider', p.provider, 'provider_ref', p.provider_ref,
    'connection', case when p.provider = 'stripe'
      then jsonb_build_object('provider', 'stripe', 'status', kp.wallets_status, 'account_id', kp.stripe_account_id)
      else jsonb_build_object('provider', kp.provider, 'status', kp.status, 'account_id', kp.provider_account_id,
        'access_enc', kp.access_token_enc, 'refresh_enc', kp.refresh_token_enc, 'expires_at', kp.token_expires_at) end);
end $$;

create or replace function public.payment_prepare(p_kiosk uuid, p_umbrella text, p_method text, p_idem text, p_ttl_minutes int default 20)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  k public.kiosks; kp public.kiosk_payments; ex public.payments; sub bigint; n int; dv int; svc bigint;
  live record; ctok text; rtok text; pid uuid; ords uuid[]; conn jsonb; prov text;
begin
  if p_method not in ('pix','card','wallet') then raise exception 'E_BAD_REQUEST'; end if;
  if p_umbrella is null or p_umbrella !~ '^[0-9]{1,6}$' then raise exception 'E_BAD_REQUEST'; end if;
  if length(coalesce(p_idem,'')) < 16 or length(p_idem) > 100 then raise exception 'E_BAD_REQUEST'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_kiosk::text || ':' || p_umbrella, 0));

  select * into k from public.kiosks where id = p_kiosk;
  if not found or not k.payments_enabled or not k.is_active or coalesce(k.blocked,false) then raise exception 'E_PAYMENTS_DISABLED'; end if;
  select * into kp from public.kiosk_payments where kiosk_id = p_kiosk;
  if not found or kp.status not in ('connected','sandbox') or kp.platform_blocked or not kp.invited then raise exception 'E_PAYMENTS_DISABLED'; end if;
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
      prov, p_idem, encode(extensions.digest(ctok, 'sha256'), 'hex'), encode(extensions.digest(rtok, 'sha256'), 'hex'),
      now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 20), 60))))
  returning id into pid;
  insert into public.payment_orders(payment_id, order_id) select pid, unnest(ords);
  perform private.pay_event(pid, p_kiosk, 'created', jsonb_build_object('method', p_method, 'amount_cents', sub + svc));

  return jsonb_build_object('existing', false, 'payment_id', pid, 'status', 'created', 'method', p_method,
    'amount_cents', sub + svc, 'subtotal_cents', sub, 'service_cents', svc,
    'expires_at', (select expires_at from public.payments where id = pid), 'provider', prov,
    'umbrella_num', p_umbrella, 'kiosk_name', k.name, 'client_token', ctok, 'receipt_token', rtok, 'connection', conn);
end $$;

-- ---------- permissões ----------
revoke execute on function
  public.set_payments_settings(text,boolean,numeric,boolean), public.payments_disconnect_wallets(text),
  public.payments_store_stripe_account(uuid,text,text), public.wallet_public_config(uuid)
from public, anon, authenticated;
grant execute on function public.set_payments_settings(text,boolean,numeric,boolean), public.payments_disconnect_wallets(text) to anon;
grant execute on function public.payments_store_stripe_account(uuid,text,text), public.wallet_public_config(uuid) to service_role;
