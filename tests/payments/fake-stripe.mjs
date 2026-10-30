// "api.stripe.com" falsa, em memória, para os testes. Só valores de TESTE inventados; nenhuma chamada de rede.
// Comporta-se como a Stripe nos pontos que importam: direct charges (PaymentIntent pertence à conta do cabeçalho Stripe-Account),
// idempotência por Idempotency-Key, 404 para PI de outra conta, assinatura de webhook "t=,v1=".
import { createHmac, randomBytes } from 'node:crypto';

export const STRIPE_TEST = { secret: 'sk_test_FAKE_not_a_real_key', whsec: 'whsec_FAKE_not_a_real_secret', pk: 'pk_test_FAKE_not_a_real_key', connectClient: 'ca_FAKE_not_real' };

export class StripeLedger {
  pis = new Map();          // id -> PI
  idem = new Map();         // `${acct}|${key}` -> id
  calls = [];               // { method, path, account, auth, idem, form }
  down = false;             // simula a Stripe fora do ar
  tamper = null;            // (pi)=>void aplicado na RESPOSTA da API (simula divergência)
  /** o cliente confirmou no Apple Pay / Google Pay e a Stripe capturou */
  pay(id, { amount } = {}) {
    const p = this.pis.get(id); if (!p) throw new Error('PI inexistente');
    p.status = 'succeeded'; p.amount_received = amount ?? p.amount;
    p.latest_charge = { id: 'ch_' + id.slice(3), refunded: false };
  }
  refund(id) { const p = this.pis.get(id); p.latest_charge.refunded = true; }
  byPid(pid) { return [...this.pis.values()].find(p => p.metadata?.pid === pid); }
  /** evento assinado como a Stripe assina */
  event(type, pi, { secret = STRIPE_TEST.whsec, t = Math.floor(Date.now() / 1000), sign = true, mutate = null } = {}) {
    const obj = type.startsWith('charge.') ? { object: 'charge', id: 'ch_x', payment_intent: pi.id, metadata: {} }
      : { object: 'payment_intent', id: pi.id, metadata: pi.metadata, status: pi.status, amount: pi.amount };
    const ev = { id: 'evt_' + randomBytes(6).toString('hex'), object: 'event', type, data: { object: obj } };
    mutate?.(ev);
    const body = JSON.stringify(ev);
    const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return { body, headers: sign ? { 'stripe-signature': `t=${t},v1=${v1}` } : {} };
  }
}

export function makeFakeStripeFetch(ledger) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host !== 'api.stripe.com') throw new Error('fetch inesperado: ' + u.host);
    const h = new Headers(init.headers);
    const account = h.get('stripe-account');
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    ledger.calls.push({ method: init.method || 'GET', path: u.pathname, account, auth: h.get('authorization'), idem: h.get('idempotency-key'), form, ctype: h.get('content-type') });
    if (ledger.down) return json(503, { error: { type: 'api_error' } });
    if (h.get('authorization') !== `Bearer ${STRIPE_TEST.secret}`) return json(401, { error: { type: 'invalid_request_error', code: 'api_key_invalid' } });
    const m = init.method || 'GET';

    if (u.pathname === '/v1/oauth/token' && m === 'POST') {
      if (form.code === 'bad') return json(400, { error: 'invalid_grant' });
      return json(200, { stripe_user_id: 'acct_' + (form.code || 'x').replace(/[^A-Za-z0-9]/g, '').padEnd(10, 'Z').slice(0, 16), livemode: false });
    }
    if (u.pathname === '/v1/payment_intents' && m === 'POST') {
      if (!account) return json(400, { error: { type: 'invalid_request_error', code: 'missing_account' } });
      const k = h.get('idempotency-key');
      if (k && ledger.idem.has(`${account}|${k}`)) return json(200, ledger.pis.get(ledger.idem.get(`${account}|${k}`)));
      const id = 'pi_' + randomBytes(12).toString('hex');
      const pi = {
        id, object: 'payment_intent', account, status: 'requires_payment_method', amount: Number(form.amount), currency: form.currency,
        payment_method_types: Object.entries(form).filter(([a]) => a.startsWith('payment_method_types')).map(([, v]) => v),
        metadata: { pid: form['metadata[pid]'] }, application_fee_amount: form.application_fee_amount ? Number(form.application_fee_amount) : null,
        client_secret: `${id}_secret_${randomBytes(8).toString('hex')}`, latest_charge: null, amount_received: 0, description: form.description,
      };
      ledger.pis.set(id, pi); if (k) ledger.idem.set(`${account}|${k}`, id);
      return json(200, pi);
    }
    const mm = u.pathname.match(/^\/v1\/payment_intents\/(pi_[A-Za-z0-9_]+)(\/cancel)?$/);
    if (mm) {
      const pi = ledger.pis.get(mm[1]);
      if (!pi || pi.account !== account) return json(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });   // outra conta = não existe
      if (mm[2] && m === 'POST') { if (pi.status === 'succeeded') return json(400, { error: { code: 'payment_intent_unexpected_state' } }); pi.status = 'canceled'; return json(200, pi); }
      const out = structuredClone(pi); ledger.tamper?.(out); return json(200, out);
    }
    if (u.pathname === '/v1/payment_intents/search') {
      const q = u.searchParams.get('query') || ''; const mt = q.match(/metadata\['pid'\]:'([^']+)'/);
      return json(200, { data: [...ledger.pis.values()].filter(p => p.account === account && mt && p.metadata.pid === mt[1]) });
    }
    return json(404, { error: { code: 'unknown_route' } });
  };
}
