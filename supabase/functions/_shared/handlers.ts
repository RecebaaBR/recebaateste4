// Lógica das Edge Functions (separada do Deno.serve para poder ser testada em Node).
// Regras de ouro:
//  * valor e itens vêm do BANCO (payment_prepare); o corpo da requisição só diz kiosk, mesa, método e chave de idempotência;
//  * webhook: valida assinatura -> localiza a cobrança NOSSA -> CONSULTA o provedor com o token do dono da cobrança -> só então liquida;
//  * segredos só via env; nada de PII em log.
import type { Deps, Seller, PaymentProvider } from './types.ts';
import { ProviderError } from './types.ts';
import { corsHeaders, json, readJson, UUID_RE } from './http.ts';
import { sha256Hex } from './crypto.ts';

const ERR: Record<string, [number, string, string]> = {
  E_PAYMENTS_DISABLED: [403, 'payments_disabled', 'Pagamento online indisponível neste estabelecimento.'],
  E_UMBRELLA_NOT_FOUND: [404, 'umbrella_not_found', 'Mesa não encontrada.'],
  E_NOTHING_TO_PAY: [409, 'nothing_to_pay', 'Não há consumo aceito para pagar agora.'],
  E_ORDER_MISMATCH: [409, 'order_mismatch', 'Há um pedido com valores divergentes. Chame o atendente.'],
  E_PAYMENT_IN_PROGRESS: [409, 'payment_in_progress', 'Já existe um pagamento em andamento para esta mesa. Conclua-o ou aguarde expirar.'],
  E_IDEMPOTENCY_CONFLICT: [409, 'idempotency_conflict', 'Chave de idempotência já usada em outra operação.'],
  E_AMOUNT_TOO_HIGH: [422, 'amount_too_high', 'Valor acima do limite para pagamento online. Chame o atendente.'],
  E_BAD_REQUEST: [400, 'bad_request', 'Requisição inválida.'],
};
function mapDbError(message: string): Response | null {
  const code = Object.keys(ERR).find(c => message.includes(c));
  if (!code) return null;
  const [status, key, msg] = ERR[code];
  return json({ ok: false, error: key, message: msg }, status);
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

function activeProviderName(deps: Deps): string { return deps.env('PAYMENTS_PROVIDER') || 'mercadopago'; }
function globalOn(deps: Deps): boolean { return deps.env('PAYMENTS_GLOBAL_ENABLED') === '1'; }

/** Descriptografa as credenciais do negócio; renova o token OAuth se estiver perto de vencer. */
async function sellerFor(deps: Deps, kioskId: string, conn: any, provider: PaymentProvider): Promise<Seller> {
  if (provider.name === 'direct') {                  // Pix direto: a "conta" é a chave Pix do próprio negócio (não é segredo); sem token
    return { accountId: JSON.stringify({ key: conn?.pix_key ?? '', name: conn?.pix_name ?? '', city: conn?.pix_city ?? '' }), accessToken: '' };
  }
  if (provider.name === 'stripe') {                  // direct charges: chave da plataforma + id da conta conectada; nada a decifrar
    if (!conn || !conn.account_id || !['connected', 'sandbox'].includes(conn.status)) throw new ProviderError('negócio sem conta Stripe', false);
    return { accountId: String(conn.account_id), accessToken: '' };
  }
  if (!conn || !conn.access_enc || !['connected', 'sandbox'].includes(conn.status)) throw new ProviderError('negócio sem conexão', false);
  let access = await deps.crypto.decrypt(conn.access_enc, kioskId);
  const exp = conn.expires_at ? Date.parse(conn.expires_at) : NaN;
  const now = (deps.now ?? Date.now)();
  if (conn.refresh_enc && provider.oauthRefresh && Number.isFinite(exp) && exp - now < 10 * 86_400_000) {
    try {
      const refresh = await deps.crypto.decrypt(conn.refresh_enc, kioskId);
      const t = await provider.oauthRefresh(refresh);
      await deps.db.rpc('payments_store_connection', {
        p_kiosk: kioskId, p_provider: provider.name, p_account_id: t.accountId,
        p_access_enc: await deps.crypto.encrypt(t.accessToken, kioskId), p_refresh_enc: await deps.crypto.encrypt(t.refreshToken, kioskId),
        p_expires_at: new Date(now + t.expiresInSec * 1000).toISOString(), p_status: conn.status,
      });
      access = t.accessToken;
    } catch (e) { deps.log?.('token_refresh_failed', { kiosk: kioskId, err: (e as Error).message.slice(0, 80) }); }
  }
  return { accountId: String(conn.account_id ?? ''), accessToken: access };
}

/** Consulta o provedor e aplica o resultado. Retorna o status local após a liquidação. */
async function reconcile(deps: Deps, paymentId: string, hintProviderPaymentId?: string): Promise<{ result: string; status?: string } | null> {
  const r = await deps.db.rpc('payment_for_webhook', { p_payment_id: paymentId });
  if (r.error || !r.data?.found) return null;
  const row = r.data;
  if (row.provider === 'direct') return { result: 'manual', status: row.status };      // Pix direto: não há o que consultar, a baixa é manual
  const provider = deps.providers[row.provider];
  if (!provider) return null;
  const seller = await sellerFor(deps, row.kiosk_id, row.connection, provider);   // token do DONO da cobrança, nunca outro
  const hint = hintProviderPaymentId ?? row.provider_ref ?? undefined;
  let pp = hint ? await provider.fetchPayment(seller, hint) : null;
  if (!pp || pp.externalReference !== paymentId) pp = await provider.searchByReference(seller, paymentId);
  if (!pp) return { result: 'not_found_at_provider', status: row.status };
  if (pp.currency !== 'BRL') { await deps.db.rpc('payment_event_log', { p_payment_id: paymentId, p_kind: 'bad_currency', p_detail: { currency: pp.currency } }); return { result: 'bad_currency', status: row.status }; }
  const s = await deps.db.rpc('payment_settle', {
    p_payment_id: paymentId, p_status: pp.status, p_paid_cents: pp.amountCents,
    p_provider_payment_id: pp.providerPaymentId, p_ext_ref: pp.externalReference,
    p_raw: null,
  });
  if (s.error) throw new Error('settle: ' + s.error.message);
  return s.data;
}

// ---------------------------------------------------------------- create-payment
export async function handleCreatePayment(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
  if (!globalOn(deps)) return json({ ok: false, error: 'payments_unavailable', message: 'Pagamento online indisponível.' }, 503, cors);

  const body = await readJson(req);
  if (!body) return json({ ok: false, error: 'bad_request' }, 400, cors);
  const kiosk = String(body.kiosk_id ?? ''), umb = String(body.umbrella ?? ''), method = String(body.method ?? ''), idem = String(body.idempotency_key ?? '');
  if (!UUID_RE.test(kiosk) || !/^[0-9]{1,6}$/.test(umb) || !['pix', 'card', 'wallet', 'pix_direct'].includes(method) || !/^[A-Za-z0-9_-]{16,100}$/.test(idem)) {
    return json({ ok: false, error: 'bad_request', message: 'Requisição inválida.' }, 400, cors);
  }

  if (method === 'wallet' && (!deps.providers.stripe || !deps.env('STRIPE_PUBLISHABLE_KEY'))) {
    return json({ ok: false, error: 'payments_unavailable', message: 'Apple Pay / Google Pay indisponível.' }, 503, cors);
  }

  // limite de taxa (por IP anonimizado e por negócio)
  const salt = deps.env('PAYMENTS_IP_SALT') || 'recebaa';
  const ipHash = (await sha256Hex(salt + clientIp(req))).slice(0, 24);
  const [a, b] = await Promise.all([
    deps.db.rpc('payment_rate_hit', { p_bucket: 'pcreate:ip:' + ipHash, p_max: 12, p_window_seconds: 600 }),
    deps.db.rpc('payment_rate_hit', { p_bucket: 'pcreate:k:' + kiosk, p_max: 200, p_window_seconds: 600 }),
  ]);
  if (a.error || b.error) return json({ ok: false, error: 'unavailable' }, 503, cors);
  if (a.data === false || b.data === false) return json({ ok: false, error: 'rate_limited', message: 'Muitas tentativas. Aguarde alguns minutos.' }, 429, cors);

  const prep = await deps.db.rpc('payment_prepare', { p_kiosk: kiosk, p_umbrella: umb, p_method: method, p_idem: idem, p_ttl_minutes: Number(deps.env('PAYMENTS_TTL_MINUTES')) || 20, p_hold: body.hold === true });
  if (prep.error) {
    const mapped = mapDbError(prep.error.message);
    if (mapped) { for (const [k, v] of Object.entries(cors)) mapped.headers.set(k, v); return mapped; }
    deps.log?.('prepare_error', { err: prep.error.message.slice(0, 120) });
    return json({ ok: false, error: 'unavailable', message: 'Não foi possível iniciar o pagamento.' }, 503, cors);
  }
  const p = prep.data;
  const provider = deps.providers[p.provider];
  if (!provider || (p.provider === 'mock' && deps.env('PAYMENTS_ALLOW_MOCK') !== '1')) {
    await deps.db.rpc('payment_mark_failed', { p_payment_id: p.payment_id, p_reason: 'provider_unavailable' });
    return json({ ok: false, error: 'unavailable', message: 'Pagamento online indisponível.' }, 503, cors);
  }

  const view = (x: any) => ({
    id: x.payment_id, status: x.status, method: x.method, amount_cents: x.amount_cents, subtotal_cents: x.subtotal_cents,
    service_cents: x.service_cents, expires_at: x.expires_at, umbrella_num: x.umbrella_num, kiosk_name: x.kiosk_name,
    pix_copy_paste: x.pix_copy_paste ?? null, checkout_url: x.checkout_url ?? null, provider: x.provider,
  });
  // carteira (Stripe): o navegador precisa do client_secret, da chave PUBLICÁVEL e do id da conta conectada (direct charges)
  const walletExtra = (secret: string | null | undefined) => (method === 'wallet' && secret)
    ? { client_secret: secret, publishable_key: deps.env('STRIPE_PUBLISHABLE_KEY'), stripe_account: p.connection?.account_id } : {};

  // repetição: devolve o que já existe (sem tokens — eles só são entregues na primeira resposta)
  if (p.existing && p.provider_ref) return json({ ok: true, payment: view(p), existing: true, ...walletExtra(p.client_secret) }, 200, cors);

  try {
    const seller = await sellerFor(deps, kiosk, p.connection, provider);
    const base = deps.env('PAYMENTS_APP_BASE_URL') || 'https://recebaa.com.br';
    const fnBase = deps.env('PAYMENTS_FUNCTIONS_BASE_URL') || `${deps.env('SUPABASE_URL') ?? ''}/functions/v1`;
    const feePct = Math.max(0, Math.min(10, Number(deps.env('PAYMENTS_APP_FEE_PERCENT')) || 0));
    const expiresAt = new Date(Date.parse(p.expires_at));
    const ch = await provider.createCharge(seller, {
      paymentId: p.payment_id, method: method as 'pix' | 'card' | 'wallet' | 'pix_direct', amountCents: p.amount_cents,
      description: `Consumo - Mesa ${p.umbrella_num} - ${String(p.kiosk_name).slice(0, 40)}`,
      notificationUrl: `${fnBase}/payment-webhook?pid=${p.payment_id}`,
      backUrl: `${base}/?kiosk=${kiosk}&umbrella=${umb}&rpay=${p.payment_id}`,
      expiresAt, feeCents: method === 'pix_direct' ? 0 : Math.round(p.amount_cents * feePct / 100),
      payerEmail: deps.env('PAYMENTS_PAYER_EMAIL') || 'pagamentos@recebaa.com.br',
    });
    const payload: Record<string, string> = {};
    if (ch.pixCopyPaste) payload.pix_copy_paste = ch.pixCopyPaste;
    if (ch.checkoutUrl) payload.checkout_url = ch.checkoutUrl;
    if (ch.clientSecret) payload.client_secret = ch.clientSecret;
    const at = await deps.db.rpc('payment_attach_charge', { p_payment_id: p.payment_id, p_provider_ref: ch.providerRef, p_payload: payload });
    if (at.error) throw new Error('attach: ' + at.error.message);
    return json({
      ok: true, existing: false,
      payment: view({ ...p, status: 'pending', pix_copy_paste: ch.pixCopyPaste, checkout_url: ch.checkoutUrl }),
      ...(p.client_token ? { client_token: p.client_token, receipt_token: p.receipt_token } : {}),
      ...walletExtra(ch.clientSecret),
    }, 200, cors);
  } catch (e) {
    deps.log?.('charge_error', { pid: p.payment_id, err: (e as Error).message.slice(0, 120) });
    await deps.db.rpc('payment_mark_failed', { p_payment_id: p.payment_id, p_reason: (e as Error).message.slice(0, 120) });
    return json({ ok: false, error: 'provider_error', message: 'Não foi possível gerar a cobrança. Tente novamente ou chame o atendente.' }, 502, cors);
  }
}

// ---------------------------------------------------------------- payment-status
export async function handlePaymentStatus(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
  if (!globalOn(deps)) return json({ ok: false, error: 'payments_unavailable' }, 503, cors);
  const body = await readJson(req);
  const pid = String(body?.payment_id ?? ''), tok = String(body?.client_token ?? ''), action = String(body?.action ?? 'get');
  if (!UUID_RE.test(pid) || tok.length < 20 || tok.length > 200 || !['get', 'refresh', 'cancel', 'mock_approve'].includes(action)) {
    return json({ ok: false, error: 'bad_request' }, 400, cors);
  }
  let st = await deps.db.rpc('payment_status', { p_payment_id: pid, p_client_token: tok });
  if (st.error) return json({ ok: false, error: 'rate_limited' }, 429, cors);
  if (!st.data?.found) return json({ ok: false, error: 'not_found' }, 404, cors);

  try {
    if (action === 'mock_approve') {
      if (deps.env('PAYMENTS_ALLOW_MOCK') !== '1' || st.data.provider !== 'mock') return json({ ok: false, error: 'forbidden' }, 403, cors);
      const ledger = deps.mockLedger ?? (await import('./registry.ts')).mockLedger;
      const row = await deps.db.rpc('payment_for_webhook', { p_payment_id: pid });
      if (row.data?.provider_ref) ledger.approve(row.data.provider_ref);
    }
    if (['refresh', 'mock_approve'].includes(action) && ['created', 'pending'].includes(st.data.status)) {
      const lim = await deps.db.rpc('payment_rate_hit', { p_bucket: 'prefresh:' + pid, p_max: 30, p_window_seconds: 60 });
      if (lim.data === false) return json({ ok: false, error: 'rate_limited' }, 429, cors);
      await reconcile(deps, pid);
    }
    if (action === 'cancel' && ['created', 'pending'].includes(st.data.status)) {
      const row = await deps.db.rpc('payment_for_webhook', { p_payment_id: pid });
      const provider = deps.providers[row.data.provider];
      let ok = true;
      if (row.data.provider_ref && provider) {
        const seller = await sellerFor(deps, row.data.kiosk_id, row.data.connection, provider);
        ok = await provider.cancelCharge(seller, row.data.provider_ref, row.data.method);
      }
      if (ok) await deps.db.rpc('payment_cancel_apply', { p_payment_id: pid });
      else await reconcile(deps, pid);     // não conseguiu cancelar: pode já ter sido pago
    }
  } catch (e) {
    deps.log?.('status_action_error', { pid, err: (e as Error).message.slice(0, 120) });
    if (e instanceof ProviderError && !e.retryable) { /* devolve o estado atual */ }
  }
  st = await deps.db.rpc('payment_status', { p_payment_id: pid, p_client_token: tok });
  return json({ ok: true, payment: st.data }, 200, cors);
}

// ---------------------------------------------------------------- payment-webhook
export async function handlePaymentWebhook(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  if (!globalOn(deps)) return json({ ok: false, error: 'payments_unavailable' }, 503);
  const raw = await req.text();
  if (raw.length > 20_000) return json({ ok: false }, 413);
  const url = new URL(req.url);
  // cada provedor tem o seu endpoint: ...?provider=stripe (carteiras); sem parâmetro = provedor padrão (Pix/cartão)
  const wanted = url.searchParams.get('provider') || activeProviderName(deps);
  const provider = ['stripe', 'mercadopago', 'mock'].includes(wanted) ? deps.providers[wanted] : undefined;
  if (!provider) return json({ ok: false }, 503);

  // 1) assinatura ANTES de qualquer acesso ao banco
  const v = await provider.verifyWebhook({ headers: req.headers, url, rawBody: raw });
  if (!v.valid) return json({ ok: false, error: 'invalid_signature' }, 401);

  // 2) só nos interessa notificação de pagamento
  if (v.topic && v.topic !== 'payment') return json({ ok: true, ignored: 'topic' });
  let pid = url.searchParams.get('pid') ?? v.paymentId ?? '';
  if (!UUID_RE.test(pid) && v.providerPaymentId && provider.name === 'stripe') {     // evento de charge sem metadata: acha pelo id do PaymentIntent
    const f = await deps.db.rpc('payment_find_by_ref', { p_provider: 'stripe', p_ref: v.providerPaymentId });
    if (typeof f.data === 'string') pid = f.data;
  }      // Stripe: metadata.pid (id opaco nosso; será revalidado na API)
  if (!UUID_RE.test(pid) || !v.providerPaymentId) return json({ ok: true, ignored: 'no_reference' });

  // 3) NÃO confia no corpo: consulta o provedor (com o token do dono da cobrança) e liquida de forma idempotente
  try {
    const row = await deps.db.rpc('payment_for_webhook', { p_payment_id: pid });
    if (row.error) return json({ ok: false }, 503);
    if (!row.data?.found || row.data.provider !== provider.name) return json({ ok: true, ignored: 'unknown_payment' });
    const r = await reconcile(deps, pid, v.providerPaymentId);
    await deps.db.rpc('payment_event_log', { p_payment_id: pid, p_kind: 'webhook', p_detail: { result: r?.result ?? null } });
    return json({ ok: true, result: r?.result ?? 'none' });
  } catch (e) {
    deps.log?.('webhook_error', { pid, err: (e as Error).message.slice(0, 120) });
    // erro transitório -> 5xx para o provedor tentar de novo; erro permanente -> 200 para não ficar reenviando
    const retry = !(e instanceof ProviderError) || e.retryable;
    return json({ ok: false, error: 'processing_failed' }, retry ? 502 : 200);
  }
}

// ---------------------------------------------------------------- payments-oauth (conectar a conta do estabelecimento)
export async function handleOAuth(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env);
  const base = deps.env('PAYMENTS_APP_BASE_URL') || 'https://recebaa.com.br';
  const provider = deps.providers[activeProviderName(deps)];
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!globalOn(deps)) return req.method === 'GET'
    ? new Response(null, { status: 302, headers: { Location: `${base}/?pagamentos=erro` } })
    : json({ ok: false, error: 'payments_unavailable' }, 503, cors);

  // retorno do provedor (navegador do dono vem redirecionado): GET ?code&state
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const code = u.searchParams.get('code') ?? '', rawState = u.searchParams.get('state') ?? '';
    const bad = () => new Response(null, { status: 302, headers: { Location: `${base}/?pagamentos=erro` } });
    const isStripe = rawState.startsWith('stripe.');                 // o state da Stripe leva o prefixo "stripe."
    const state = isStripe ? rawState.slice(7) : rawState;
    const prov = isStripe ? deps.providers.stripe : provider;
    if (!prov || !code || !state || code.length > 400 || state.length > 100 || !prov.oauthExchange) return bad();
    const st = await deps.db.rpc('payments_oauth_consume', { p_state: state });
    if (st.error || !st.data?.found) return bad();                    // state inválido/expirado/reusado
    try {
      const kid = st.data.kiosk_id as string;
      const t = await prov.oauthExchange(code);
      if (isStripe) {
        // só o id da conta conectada (acct_...) é guardado; "test" no refreshToken = conta de teste
        const sa = await deps.db.rpc('payments_store_stripe_account', { p_kiosk: kid, p_account_id: t.accountId, p_status: t.refreshToken === 'test' ? 'sandbox' : 'connected' });
        return sa.error ? bad() : new Response(null, { status: 302, headers: { Location: `${base}/?pagamentos=conectado` } });
      }
      const s = await deps.db.rpc('payments_store_connection', {
        p_kiosk: kid, p_provider: provider.name, p_account_id: t.accountId,
        p_access_enc: await deps.crypto.encrypt(t.accessToken, kid), p_refresh_enc: await deps.crypto.encrypt(t.refreshToken, kid),
        p_expires_at: new Date((deps.now ?? Date.now)() + t.expiresInSec * 1000).toISOString(),
        p_status: deps.env('MP_SANDBOX') === '1' ? 'sandbox' : 'connected',
      });
      if (s.error) return bad();
      return new Response(null, { status: 302, headers: { Location: `${base}/?pagamentos=conectado` } });
    } catch (e) { deps.log?.('oauth_error', { err: (e as Error).message.slice(0, 80) }); return bad(); }
  }

  if (req.method !== 'POST') return json({ ok: false }, 405, cors);
  const body = await readJson(req);
  const token = String(body?.session_token ?? ''), action = String(body?.action ?? '');
  if (token.length < 20 || token.length > 200) return json({ ok: false, error: 'bad_request' }, 400, cors);
  const lim = await deps.db.rpc('payment_rate_hit', { p_bucket: 'poauth:' + (await sha256Hex(token)).slice(0, 16), p_max: 20, p_window_seconds: 600 });
  if (lim.data === false) return json({ ok: false, error: 'rate_limited' }, 429, cors);

  if (action === 'global_status') return json({ ok: true, global: true }, 200, cors);   // chegou aqui = o kill switch global está LIGADO (desligado responde 503 acima)
  if (action === 'start_wallet') {
    const st = deps.providers.stripe;
    if (!st?.oauthAuthorizeUrl) return json({ ok: false, error: 'unsupported' }, 400, cors);
    const r = await deps.db.rpc('payments_oauth_begin', { p_token: token });
    if (r.error) return json({ ok: false, error: 'forbidden', message: 'Apenas o responsável pelo negócio pode conectar.' }, 403, cors);
    return json({ ok: true, url: st.oauthAuthorizeUrl('stripe.' + r.data.state) }, 200, cors);
  }
  if (action === 'connect_wallet_mock') {
    if (deps.env('PAYMENTS_ALLOW_MOCK') !== '1') return json({ ok: false, error: 'forbidden' }, 403, cors);
    const k = await deps.db.rpc('payments_owner_kiosk', { p_token: token });
    if (k.error) return json({ ok: false, error: 'forbidden' }, 403, cors);
    const sa = await deps.db.rpc('payments_store_stripe_account', { p_kiosk: k.data.kiosk_id, p_account_id: 'acct_mock' + String(k.data.kiosk_id).replace(/-/g, '').slice(0, 12), p_status: 'sandbox' });
    return sa.error ? json({ ok: false }, 500, cors) : json({ ok: true }, 200, cors);
  }
  if (!provider) return json({ ok: false, error: 'payments_unavailable' }, 503, cors);
  if (action === 'start') {
    if (!provider.oauthAuthorizeUrl) return json({ ok: false, error: 'unsupported' }, 400, cors);
    const r = await deps.db.rpc('payments_oauth_begin', { p_token: token });
    if (r.error) return json({ ok: false, error: 'forbidden', message: 'Apenas o responsável pelo negócio pode conectar.' }, 403, cors);
    return json({ ok: true, url: provider.oauthAuthorizeUrl(r.data.state) }, 200, cors);
  }
  if (action === 'connect_mock') {
    if (deps.env('PAYMENTS_ALLOW_MOCK') !== '1' || provider.name !== 'mock') return json({ ok: false, error: 'forbidden' }, 403, cors);
    const k = await deps.db.rpc('payments_owner_kiosk', { p_token: token });
    if (k.error) return json({ ok: false, error: 'forbidden' }, 403, cors);
    const kid = k.data.kiosk_id as string;
    const s = await deps.db.rpc('payments_store_connection', {
      p_kiosk: kid, p_provider: 'mock', p_account_id: 'mock-' + kid.slice(0, 8),
      p_access_enc: await deps.crypto.encrypt('mock-access', kid), p_refresh_enc: await deps.crypto.encrypt('mock-refresh', kid),
      p_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(), p_status: 'sandbox',
    });
    return s.error ? json({ ok: false }, 500, cors) : json({ ok: true }, 200, cors);
  }
  return json({ ok: false, error: 'bad_request' }, 400, cors);
}

// ---------------------------------------------------------------- wallet-config (chave PUBLICÁVEL da Stripe + conta conectada)
// Só responde se as carteiras estiverem efetivamente ligadas para o negócio. Nunca devolve segredo.
export async function handleWalletConfig(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
  const off = () => json({ ok: true, enabled: false }, 200, cors);
  if (!globalOn(deps) || !deps.providers.stripe || !deps.env('STRIPE_PUBLISHABLE_KEY')) return off();
  const body = await readJson(req, 1024);
  const kiosk = String(body?.kiosk_id ?? '');
  if (!UUID_RE.test(kiosk)) return json({ ok: false, error: 'bad_request' }, 400, cors);
  const ipHash = (await sha256Hex((deps.env('PAYMENTS_IP_SALT') || 'recebaa') + clientIp(req))).slice(0, 24);
  const lim = await deps.db.rpc('payment_rate_hit', { p_bucket: 'pwcfg:ip:' + ipHash, p_max: 60, p_window_seconds: 600 });
  if (lim.data === false) return json({ ok: false, error: 'rate_limited' }, 429, cors);
  const r = await deps.db.rpc('wallet_public_config', { p_kiosk: kiosk });
  if (r.error || !r.data?.enabled) return off();
  return json({ ok: true, enabled: true, publishable_key: deps.env('STRIPE_PUBLISHABLE_KEY'), stripe_account: r.data.stripe_account }, 200, cors);
}
