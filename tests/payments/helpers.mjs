import { makeDb, rpcClient, seedKiosk, seedOrder, ownerToken } from './harness.mjs';
import { MockLedger, signMockWebhook } from '../../supabase/functions/_shared/mock.ts';
import { buildProviders } from '../../supabase/functions/_shared/registry.ts';
import { makeTokenCrypto } from '../../supabase/functions/_shared/crypto.ts';
import { handleCreatePayment, handlePaymentStatus, handlePaymentWebhook, handleOAuth, handleWalletConfig } from '../../supabase/functions/_shared/handlers.ts';
import { randomBytes } from 'node:crypto';
import { StripeLedger, makeFakeStripeFetch, STRIPE_TEST } from './fake-stripe.mjs';

export const MOCK_SECRET = 'test-mock-secret-not-real';
export const ORIGIN = 'https://recebaa.com.br';

export function makeEnv(extra = {}) {
  const e = {
    PAYMENTS_GLOBAL_ENABLED: '1', PAYMENTS_PROVIDER: 'mock', PAYMENTS_ALLOW_MOCK: '1', PAYMENTS_MOCK_SECRET: MOCK_SECRET,
    PAYMENTS_TOKEN_KEY: randomBytes(32).toString('base64'), PAYMENTS_APP_BASE_URL: ORIGIN,
    STRIPE_SECRET_KEY: STRIPE_TEST.secret, STRIPE_WEBHOOK_SECRET: STRIPE_TEST.whsec, STRIPE_PUBLISHABLE_KEY: STRIPE_TEST.pk, STRIPE_CONNECT_CLIENT_ID: STRIPE_TEST.connectClient,
    PAYMENTS_FUNCTIONS_BASE_URL: 'https://fn.invalid/functions/v1', SUPABASE_URL: 'https://x.supabase.co', ...extra,
  };
  const fn = k => e[k]; fn.vars = e; return fn;
}

/** Ambiente completo: Postgres real (PGlite) + migrações + handlers + provedor mock. */
export async function setup(envExtra = {}) {
  const pg = await makeDb();
  const ledger = new MockLedger();
  const stripe = new StripeLedger();
  const env = makeEnv(envExtra);
  const db = rpcClient(pg, 'service_role');
  const deps = { db, env, providers: buildProviders(env, makeFakeStripeFetch(stripe), ledger), crypto: makeTokenCrypto(env('PAYMENTS_TOKEN_KEY')), mockLedger: ledger, log: () => {} };
  const anon = rpcClient(pg, 'anon');
  let ip = 1;
  const post = (handler, body, headers = {}) => handler(new Request('https://fn.invalid/x', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '10.0.0.' + (ip++), ...headers }, body: JSON.stringify(body) }), deps);
  const ctx = {
    pg, ledger, stripe, env, db, deps, anon, post,
    create: (b, h) => post(handleCreatePayment, b, h),
    status: (b) => post(handlePaymentStatus, b),
    oauth: (b) => post(handleOAuth, b),
    walletConfig: (b, h) => post(handleWalletConfig, b, h),
    /** webhook da Stripe (endpoint ?provider=stripe), assinado como a Stripe assina */
    async stripeWebhook(type, pi, opts = {}) {
      const e = stripe.event(type, pi, opts);
      return handlePaymentWebhook(new Request('https://fn.invalid/functions/v1/payment-webhook?provider=stripe', { method: 'POST', headers: { 'content-type': 'application/json', ...e.headers }, body: opts.body ?? e.body }), deps);
    },
    async webhook({ ref, pid, secret = MOCK_SECRET, sign = true, body = null, topic = 'payment' }) {
      const w = await signMockWebhook(secret, ref, { type: topic });
      const raw = body ?? w.body;
      const headers = { 'content-type': 'application/json' };
      if (sign) headers['x-mock-signature'] = w.signature;
      return handlePaymentWebhook(new Request(`https://fn.invalid/functions/v1/payment-webhook?pid=${pid}`, { method: 'POST', headers, body: raw }), deps);
    },
    /** negócio com mesas, dono logado, conexão mock e pagamentos ligados */
    async kiosk({ enable = true, invite = true, name = 'Quiosque do Zé', servicePct = null, wallets = false, pixDirect = false, mode = null } = {}) {
      const kid = await seedKiosk(pg, { name });
      const tok = await ownerToken(pg, kid);
      if (invite) await pg.query('insert into kiosk_payments(kiosk_id, invited) values ($1, true)', [kid]);
      if (enable) {
        const c = await ctx.oauth({ action: 'connect_mock', session_token: tok });
        if (c.status !== 200) throw new Error('connect_mock falhou: ' + await c.text());
        const a = await anon.rpc('set_payments_settings', { p_token: tok, p_enabled: true, p_service_percent: servicePct });
        if (a.error) throw new Error(a.error.message);
      }
      if (wallets) {
        const w = await ctx.oauth({ action: 'connect_wallet_mock', session_token: tok });
        if (w.status !== 200) throw new Error('connect_wallet_mock falhou: ' + await w.text());
        const a = await anon.rpc('set_payments_settings', { p_token: tok, p_wallets_enabled: true });
        if (a.error) throw new Error(a.error.message);
      }
      if (pixDirect) {
        const k = await anon.rpc('pix_key_set', { p_token: tok, p_type: 'cpf', p_value: VALID_CPF, p_name: 'Quiosque do Zé', p_city: 'Natal' });
        if (k.error) throw new Error(k.error.message);
        const a = await anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: true } });
        if (a.error) throw new Error(a.error.message);
      }
      if (mode) {
        const a = await anon.rpc('payments_panel_set', { p_token: tok, p_patch: { checkout_mode: mode } });
        if (a.error) throw new Error(a.error.message);
      }
      return { kid, tok };
    },
  };
  return ctx;
}
export const VALID_CPF = '529.982.247-25';
export const VALID_CNPJ = '11.222.333/0001-81';
export async function seedProduct(pg, kid, name, price, extra = {}) {
  return (await pg.query(`insert into products(kiosk_id, name, price, promo_price, promo_active) values ($1,$2,$3,$4,$5) returning id`,
    [kid, name, price, extra.promo ?? null, !!extra.promo])).rows[0].id;
}
/** pedido do CLIENTE exatamente como o app faz: place_order (anon) + add_order_items (anon) */
export async function clientOrder(c, kid, umb, items, { status = 'pending', key = null, total = null, customer = 'Maria' } = {}) {
  const sum = items.reduce((a, i) => a + i.q * i.p, 0);
  const o = await c.anon.rpc('place_order', { p_order: { kiosk_id: kid, umbrella_num: String(umb), order_number: 0, customer_name: customer, status, total: total ?? sum, idempotency_key: key || ('k' + Math.random().toString(36).slice(2) + Date.now()) }, p_items: null });
  if (o.error) return { error: o.error };
  const it = await c.anon.rpc('add_order_items', { p_items: items.map(i => ({ order_id: o.data.id, product_id: i.id ?? null, product_name: i.n || 'Item', quantity: i.q, unit_price: i.p })) });
  return { order: o.data, itemsError: it.error };
}
export const idem = () => 'idem-' + randomBytes(12).toString('hex');
export { seedOrder, seedKiosk, ownerToken };
