import type { PaymentProvider, Deps, Db } from './types.ts';
import { makeMercadoPago } from './mercadopago.ts';
import { makeMockProvider, MockLedger } from './mock.ts';
import { makeTokenCrypto } from './crypto.ts';

export const mockLedger = new MockLedger();

/** Monta os provedores disponíveis a partir das variáveis de ambiente (segredos só existem aqui). */
export function buildProviders(env: (k: string) => string | undefined, fetchFn: typeof fetch = fetch, ledger: MockLedger = mockLedger): Record<string, PaymentProvider> {
  const out: Record<string, PaymentProvider> = {};
  if (env('MP_CLIENT_ID') && env('MP_CLIENT_SECRET')) {
    out.mercadopago = makeMercadoPago({
      clientId: env('MP_CLIENT_ID')!, clientSecret: env('MP_CLIENT_SECRET')!,
      webhookSecret: env('MP_WEBHOOK_SECRET') || '', redirectUri: env('MP_REDIRECT_URI') || '',
      sandboxInitPoint: env('MP_SANDBOX') === '1',
    }, fetchFn);
  }
  if (env('PAYMENTS_ALLOW_MOCK') === '1' && env('PAYMENTS_MOCK_SECRET')) {
    out.mock = makeMockProvider(env('PAYMENTS_MOCK_SECRET')!, ledger);
  }
  return out;
}

export function buildDeps(db: Db, env: (k: string) => string | undefined, fetchFn: typeof fetch = fetch): Deps {
  return {
    db, env, providers: buildProviders(env, fetchFn), crypto: makeTokenCrypto(env('PAYMENTS_TOKEN_KEY')),
    log: (m, x) => console.log(JSON.stringify({ m, ...x })),
  };
}
