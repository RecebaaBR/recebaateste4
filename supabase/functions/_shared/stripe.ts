// Stripe — SOMENTE carteiras (Apple Pay / Google Pay). Pix e cartão continuam no Mercado Pago.
// Modelo: Stripe Connect com *direct charges*: o PaymentIntent é criado NA CONTA CONECTADA do estabelecimento
// (cabeçalho Stripe-Account), com a chave secreta da plataforma. O dinheiro vai para o estabelecimento; o Recebaa não custodia.
// PENDENTE DE VALIDAÇÃO (docs/pagamentos.md): Connect com contas conectadas brasileiras e o repasse direto.
// Segredos só por Deno.env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_CLIENT_ID. A chave PUBLICÁVEL pode ir ao front.
import type { PaymentProvider, Seller, ChargeInput, ChargeResult, ProviderPayment, OAuthTokens, NormalizedStatus } from './types.ts';
import { ProviderError } from './types.ts';
import { hmacSha256Hex, timingSafeEqual } from './crypto.ts';

const API = 'https://api.stripe.com';

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  connectClientId?: string;
  redirectUri?: string;
  toleranceSec?: number;          // tolerância de tempo da assinatura (padrão 300 s, igual à da Stripe)
  now?: () => number;             // injetável nos testes
}

/** Eventos que significam "mudou algo no pagamento": o servidor sempre RECONSULTA a API antes de agir. */
const RELEVANT = new Set([
  'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled',
  'payment_intent.processing', 'payment_intent.requires_action', 'charge.refunded', 'charge.dispute.created',
]);

export function normalizeStripeStatus(pi: any): NormalizedStatus {
  const refunded = pi?.latest_charge && typeof pi.latest_charge === 'object' && pi.latest_charge.refunded === true;
  if (pi?.status === 'succeeded') return refunded ? 'refunded' : 'paid';
  if (pi?.status === 'canceled') return 'failed';
  return 'pending';               // requires_payment_method, requires_confirmation, requires_action, processing, requires_capture
}
function toPayment(pi: any): ProviderPayment {
  const paid = pi.status === 'succeeded';
  return {
    providerPaymentId: String(pi.id),
    status: normalizeStripeStatus(pi),
    amountCents: Number(paid ? (pi.amount_received ?? pi.amount) : pi.amount),
    currency: String(pi.currency || '').toUpperCase(),
    externalReference: pi.metadata?.pid != null ? String(pi.metadata.pid) : null,
  };
}

/** application/x-www-form-urlencoded no estilo da Stripe (chaves aninhadas e listas). */
export function form(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => parts.push(typeof x === 'object' ? form(x as any, `${key}[${i}]`) : `${encodeURIComponent(key + '[]')}=${encodeURIComponent(String(x))}`));
    else if (typeof v === 'object') parts.push(form(v as any, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

/** Verifica o cabeçalho Stripe-Signature ("t=<unix>,v1=<hex>[,v1=<hex>]"): HMAC-SHA256 de `${t}.${corpo}` + tolerância de tempo. */
export async function verifyStripeSignature(header: string, rawBody: string, secret: string, toleranceSec: number, nowMs: number): Promise<boolean> {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!/^\d{9,12}$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;          // expirada (ou relógio absurdo): protege contra replay
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  let ok = false;
  for (const s of sigs) if (timingSafeEqual(s, expected)) ok = true;
  return ok;
}

export function makeStripe(cfg: StripeConfig, fetchFn: typeof fetch = fetch): PaymentProvider {
  const tol = cfg.toleranceSec ?? 300;
  async function call(method: string, path: string, account: string | null, body?: Record<string, unknown>, idem?: string): Promise<{ status: number; data: any }> {
    let res: Response;
    try {
      res = await fetchFn(API + path, {
        method,
        headers: {
          'Authorization': `Bearer ${cfg.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(account ? { 'Stripe-Account': account } : {}),
          ...(idem ? { 'Idempotency-Key': idem } : {}),
        },
        body: body ? form(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { throw new ProviderError('rede: ' + (e as Error).message, true); }
    let data: any = null; try { data = await res.json(); } catch { /* vazio */ }
    return { status: res.status, data };
  }
  function fail(r: { status: number; data: any }, what: string): never {
    const cause = r.data?.error?.code || r.data?.error?.type || '';       // nunca o corpo inteiro
    throw new ProviderError(`${what}: HTTP ${r.status} ${String(cause).slice(0, 80)}`, r.status >= 500 || r.status === 429);
  }
  const acct = (s: Seller) => {
    if (!/^acct_[A-Za-z0-9]{6,64}$/.test(s.accountId)) throw new ProviderError('conta Stripe inválida', false);
    return s.accountId;
  };

  return {
    name: 'stripe',

    async createCharge(seller: Seller, i: ChargeInput): Promise<ChargeResult> {
      if (i.method !== 'wallet') throw new ProviderError('Stripe só processa carteiras neste projeto', false);
      // PaymentIntent na conta do estabelecimento; valor vem do servidor (banco); metadata só com id opaco (sem PII)
      const r = await call('POST', '/v1/payment_intents', acct(seller), {
        amount: i.amountCents,
        currency: 'brl',
        payment_method_types: ['card'],            // Apple Pay e Google Pay trafegam como cartão tokenizado pela carteira
        description: i.description,
        metadata: { pid: i.paymentId },
        ...(i.feeCents > 0 ? { application_fee_amount: i.feeCents } : {}),
      }, i.paymentId);
      if (r.status !== 200) fail(r, 'criar payment_intent');
      if (!r.data?.id || !r.data?.client_secret) throw new ProviderError('criar payment_intent: resposta incompleta', false);
      return { providerRef: String(r.data.id), clientSecret: String(r.data.client_secret) };
    },

    async fetchPayment(seller, id) {
      if (!/^pi_[A-Za-z0-9_]{6,80}$/.test(id)) return null;
      const r = await call('GET', `/v1/payment_intents/${id}?expand[]=latest_charge`, acct(seller));
      if (r.status === 404 || r.status === 403 || r.status === 401) return null;     // inexistente ou de outra conta
      if (r.status !== 200) fail(r, 'consultar payment_intent');
      return toPayment(r.data);
    },

    async searchByReference(seller, ext) {
      if (!/^[0-9a-f-]{36}$/i.test(ext)) return null;
      const q = encodeURIComponent(`metadata['pid']:'${ext}'`);
      const r = await call('GET', `/v1/payment_intents/search?query=${q}&limit=5`, acct(seller));
      if (r.status !== 200) { if ([401, 403, 404].includes(r.status)) return null; fail(r, 'buscar payment_intent'); }
      const list: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
      const mine = list.filter(p => String(p.metadata?.pid) === ext);
      const pick = mine.find(p => p.status === 'succeeded') ?? mine[0];
      return pick ? toPayment(pick) : null;
    },

    async cancelCharge(seller, ref) {
      if (!/^pi_[A-Za-z0-9_]{6,80}$/.test(ref)) return false;
      const r = await call('POST', `/v1/payment_intents/${ref}/cancel`, acct(seller), {});
      return r.status === 200;
    },

    async verifyWebhook({ headers, rawBody }) {
      const ok = await verifyStripeSignature(headers.get('stripe-signature') || '', rawBody, cfg.webhookSecret, tol, (cfg.now ?? Date.now)());
      if (!ok) return { valid: false };
      let ev: any; try { ev = JSON.parse(rawBody); } catch { return { valid: false }; }
      const type = String(ev?.type ?? '');
      if (!RELEVANT.has(type)) return { valid: true, topic: type };
      const obj = ev?.data?.object ?? {};
      // payment_intent.* traz o PI; charge.* traz o charge com payment_intent. Só ids: o conteúdo será reconsultado na API.
      const piId = obj.object === 'charge' ? obj.payment_intent : obj.id;
      const pid = obj.metadata?.pid;
      return { valid: true, topic: 'payment', providerPaymentId: piId ? String(piId) : undefined, paymentId: pid ? String(pid) : undefined };
    },

    // Conexão do estabelecimento (Connect Standard via OAuth). Só o id da conta é guardado: nenhum token do estabelecimento.
    oauthAuthorizeUrl(state) {
      const q = new URLSearchParams({ response_type: 'code', client_id: cfg.connectClientId || '', scope: 'read_write', state, ...(cfg.redirectUri ? { redirect_uri: cfg.redirectUri } : {}) });
      return `https://connect.stripe.com/oauth/authorize?${q}`;
    },
    async oauthExchange(code): Promise<OAuthTokens> {
      const r = await call('POST', '/v1/oauth/token', null, { grant_type: 'authorization_code', code });
      if (r.status !== 200 || !/^acct_/.test(String(r.data?.stripe_user_id))) throw new ProviderError(`oauth: HTTP ${r.status}`, r.status >= 500);
      // livemode=false => conta de teste (sandbox)
      return { accountId: String(r.data.stripe_user_id), accessToken: '', refreshToken: r.data.livemode === false ? 'test' : 'live', expiresInSec: 0 };
    },
  };
}
