// Mercado Pago (Marketplace / OAuth): cada estabelecimento conecta a PRÓPRIA conta; a cobrança é criada com o
// token DELE, então o dinheiro cai direto na conta do estabelecimento (o Recebaa não custodia nada).
// Referência de API: https://www.mercadopago.com.br/developers  (validar no sandbox antes de ativar — ver docs/pagamentos.md)
import type { PaymentProvider, Seller, ChargeInput, ChargeResult, ProviderPayment, OAuthTokens, NormalizedStatus } from './types.ts';
import { ProviderError } from './types.ts';
import { hmacSha256Hex, timingSafeEqual } from './crypto.ts';

const API = 'https://api.mercadopago.com';

export interface MpConfig { clientId: string; clientSecret: string; webhookSecret: string; redirectUri: string; sandboxInitPoint?: boolean }

function brt(d: Date): string { return new Date(d.getTime() - 3 * 3600_000).toISOString().replace('Z', '-03:00'); }

export function normalizeMpStatus(s: string | undefined): NormalizedStatus {
  switch (s) {
    case 'approved': return 'paid';
    case 'refunded': case 'charged_back': return 'refunded';
    case 'cancelled': case 'rejected': return 'failed';
    default: return 'pending';       // pending, in_process, authorized, in_mediation...
  }
}
function toPayment(p: any): ProviderPayment {
  return {
    providerPaymentId: String(p.id),
    status: normalizeMpStatus(p.status),
    amountCents: Math.round(Number(p.transaction_amount) * 100),
    currency: String(p.currency_id || ''),
    externalReference: p.external_reference != null ? String(p.external_reference) : null,
  };
}

export function makeMercadoPago(cfg: MpConfig, fetchFn: typeof fetch = fetch): PaymentProvider {
  async function call(method: string, path: string, token: string, body?: unknown, idem?: string): Promise<{ status: number; data: any }> {
    let res: Response;
    try {
      res = await fetchFn(API + path, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
          ...(idem ? { 'X-Idempotency-Key': idem } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { throw new ProviderError('rede: ' + (e as Error).message, true); }
    let data: any = null; try { data = await res.json(); } catch { /* corpo vazio */ }
    return { status: res.status, data };
  }
  function fail(r: { status: number; data: any }, what: string): never {
    // nunca inclui o corpo inteiro (pode ter dados do pagador) — só código e causa curta
    const cause = r.data?.message || r.data?.error || '';
    throw new ProviderError(`${what}: HTTP ${r.status} ${String(cause).slice(0, 120)}`, r.status >= 500 || r.status === 429);
  }

  const tokenReq = async (params: Record<string, string>): Promise<OAuthTokens> => {
    let res: Response;
    try {
      res = await fetchFn(API + '/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { throw new ProviderError('rede: ' + (e as Error).message, true); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) throw new ProviderError(`oauth: HTTP ${res.status}`, res.status >= 500);
    return { accountId: String(d.user_id), accessToken: d.access_token, refreshToken: d.refresh_token, expiresInSec: Number(d.expires_in) || 15_552_000 };
  };

  return {
    name: 'mercadopago',

    async createCharge(seller: Seller, i: ChargeInput): Promise<ChargeResult> {
      const amount = i.amountCents / 100;
      if (i.method === 'pix') {
        const r = await call('POST', '/v1/payments', seller.accessToken, {
          transaction_amount: amount,
          description: i.description,
          payment_method_id: 'pix',
          payer: { email: i.payerEmail },
          external_reference: i.paymentId,
          notification_url: i.notificationUrl,
          date_of_expiration: brt(i.expiresAt),
          ...(i.feeCents > 0 ? { application_fee: i.feeCents / 100 } : {}),
        }, i.paymentId);
        if (r.status !== 201 && r.status !== 200) fail(r, 'criar pix');
        const code = r.data?.point_of_interaction?.transaction_data?.qr_code;
        if (!code) throw new ProviderError('criar pix: resposta sem qr_code', false);
        return { providerRef: String(r.data.id), pixCopyPaste: String(code) };
      }
      // Cartão: checkout HOSPEDADO (Checkout Pro). O número do cartão nunca passa pelo Recebaa nem pelo nosso site.
      const r = await call('POST', '/checkout/preferences', seller.accessToken, {
        items: [{ id: i.paymentId, title: i.description, quantity: 1, currency_id: 'BRL', unit_price: amount }],
        external_reference: i.paymentId,
        notification_url: i.notificationUrl,
        back_urls: { success: i.backUrl, pending: i.backUrl, failure: i.backUrl },
        auto_return: 'approved',
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' }], installments: 1 },
        expires: true, expiration_date_to: brt(i.expiresAt),
        ...(i.feeCents > 0 ? { marketplace_fee: i.feeCents / 100 } : {}),
      }, i.paymentId);
      if (r.status !== 201 && r.status !== 200) fail(r, 'criar checkout');
      const url = cfg.sandboxInitPoint ? r.data?.sandbox_init_point : r.data?.init_point;
      if (!url || !String(url).startsWith('https://')) throw new ProviderError('criar checkout: resposta sem init_point', false);
      return { providerRef: String(r.data.id), checkoutUrl: String(url) };
    },

    async fetchPayment(seller, id) {
      if (!/^\d{3,20}$/.test(id)) return null;
      const r = await call('GET', `/v1/payments/${id}`, seller.accessToken);
      if (r.status === 404 || r.status === 403 || r.status === 401) return null;
      if (r.status !== 200) fail(r, 'consultar pagamento');
      return toPayment(r.data);
    },

    async searchByReference(seller, ext) {
      const r = await call('GET', `/v1/payments/search?external_reference=${encodeURIComponent(ext)}&sort=date_created&criteria=desc&limit=10`, seller.accessToken);
      if (r.status !== 200) { if (r.status === 404 || r.status === 401 || r.status === 403) return null; fail(r, 'buscar pagamento'); }
      const list: any[] = Array.isArray(r.data?.results) ? r.data.results : [];
      const mine = list.filter(p => String(p.external_reference) === ext);
      const pick = mine.find(p => p.status === 'approved') ?? mine[0];
      return pick ? toPayment(pick) : null;
    },

    async cancelCharge(seller, ref, method) {
      if (method === 'card') return true;     // preferência não se cancela: expira sozinha (expiration_date_to)
      const r = await call('PUT', `/v1/payments/${ref}`, seller.accessToken, { status: 'cancelled' }, `cancel-${ref}`);
      return r.status === 200;
    },

    async verifyWebhook({ headers, url, rawBody }) {
      // x-signature: "ts=1704908010,v1=<hex>"; manifest = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
      const xsig = headers.get('x-signature') || '';
      const reqId = headers.get('x-request-id') || '';
      const parts = Object.fromEntries(xsig.split(',').map(p => { const [k, ...v] = p.trim().split('='); return [k, v.join('=')]; }));
      const ts = parts['ts'], v1 = parts['v1'];
      let body: any = null; try { body = JSON.parse(rawBody); } catch { /* alguns tópicos vêm sem corpo */ }
      let dataId = url.searchParams.get('data.id') ?? (body?.data?.id != null ? String(body.data.id) : '');
      if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();
      if (!ts || !v1 || !cfg.webhookSecret) return { valid: false };
      const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
      const expected = await hmacSha256Hex(cfg.webhookSecret, manifest);
      if (!timingSafeEqual(v1, expected)) return { valid: false };
      const topic = url.searchParams.get('type') ?? body?.type ?? '';
      return { valid: true, topic: String(topic), providerPaymentId: dataId || undefined };
    },

    oauthAuthorizeUrl(state) {
      const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', platform_id: 'mp', state, redirect_uri: cfg.redirectUri });
      return `https://auth.mercadopago.com.br/authorization?${q}`;
    },
    oauthExchange: (code) => tokenReq({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }),
    oauthRefresh: (rt) => tokenReq({ grant_type: 'refresh_token', refresh_token: rt }),
  };
}
