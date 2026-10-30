import { makeDb, rpcClient, seedKiosk, seedOrder, ownerToken } from './harness.mjs';
import { MockLedger, signMockWebhook } from '../../supabase/functions/_shared/mock.ts';
import { buildProviders } from '../../supabase/functions/_shared/registry.ts';
import { makeTokenCrypto } from '../../supabase/functions/_shared/crypto.ts';
import { handleCreatePayment, handlePaymentStatus, handlePaymentWebhook, handleOAuth } from '../../supabase/functions/_shared/handlers.ts';
import { randomBytes } from 'node:crypto';

export const MOCK_SECRET = 'test-mock-secret-not-real';
export const ORIGIN = 'https://recebaa.com.br';

export function makeEnv(extra = {}) {
  const e = {
    PAYMENTS_GLOBAL_ENABLED: '1', PAYMENTS_PROVIDER: 'mock', PAYMENTS_ALLOW_MOCK: '1', PAYMENTS_MOCK_SECRET: MOCK_SECRET,
    PAYMENTS_TOKEN_KEY: randomBytes(32).toString('base64'), PAYMENTS_APP_BASE_URL: ORIGIN,
    PAYMENTS_FUNCTIONS_BASE_URL: 'https://fn.invalid/functions/v1', SUPABASE_URL: 'https://x.supabase.co', ...extra,
  };
  const fn = k => e[k]; fn.vars = e; return fn;
}

/** Ambiente completo: Postgres real (PGlite) + migrações + handlers + provedor mock. */
export async function setup(envExtra = {}) {
  const pg = await makeDb();
  const ledger = new MockLedger();
  const env = makeEnv(envExtra);
  const db = rpcClient(pg, 'service_role');
  const deps = { db, env, providers: buildProviders(env, fetch, ledger), crypto: makeTokenCrypto(env('PAYMENTS_TOKEN_KEY')), mockLedger: ledger, log: () => {} };
  const anon = rpcClient(pg, 'anon');
  let ip = 1;
  const post = (handler, body, headers = {}) => handler(new Request('https://fn.invalid/x', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '10.0.0.' + (ip++), ...headers }, body: JSON.stringify(body) }), deps);
  const ctx = {
    pg, ledger, env, db, deps, anon, post,
    create: (b, h) => post(handleCreatePayment, b, h),
    status: (b) => post(handlePaymentStatus, b),
    oauth: (b) => post(handleOAuth, b),
    async webhook({ ref, pid, secret = MOCK_SECRET, sign = true, body = null, topic = 'payment' }) {
      const w = await signMockWebhook(secret, ref, { type: topic });
      const raw = body ?? w.body;
      const headers = { 'content-type': 'application/json' };
      if (sign) headers['x-mock-signature'] = w.signature;
      return handlePaymentWebhook(new Request(`https://fn.invalid/functions/v1/payment-webhook?pid=${pid}`, { method: 'POST', headers, body: raw }), deps);
    },
    /** negócio com mesas, dono logado, conexão mock e pagamentos ligados */
    async kiosk({ enable = true, invite = true, name = 'Quiosque do Zé', servicePct = null } = {}) {
      const kid = await seedKiosk(pg, { name });
      const tok = await ownerToken(pg, kid);
      if (invite) await pg.query('insert into kiosk_payments(kiosk_id, invited) values ($1, true)', [kid]);
      if (enable) {
        const c = await ctx.oauth({ action: 'connect_mock', session_token: tok });
        if (c.status !== 200) throw new Error('connect_mock falhou: ' + await c.text());
        const a = await anon.rpc('set_payments_settings', { p_token: tok, p_enabled: true, p_service_percent: servicePct });
        if (a.error) throw new Error(a.error.message);
      }
      return { kid, tok };
    },
  };
  return ctx;
}
export const idem = () => 'idem-' + randomBytes(12).toString('hex');
export { seedOrder, seedKiosk, ownerToken };
