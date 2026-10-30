import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, idem, seedOrder, seedKiosk, ownerToken } from './helpers.mjs';
import { StripeLedger, makeFakeStripeFetch, STRIPE_TEST } from './fake-stripe.mjs';
import { makeStripe, verifyStripeSignature, normalizeStripeStatus, form } from '../../supabase/functions/_shared/stripe.ts';
import { ProviderError } from '../../supabase/functions/_shared/types.ts';

const json = async r => ({ status: r.status, body: await r.json() });
const walletCreate = async (c, kid, umb = 1, extra = {}) => {
  const r = await json(await c.create({ kiosk_id: kid, umbrella: umb, method: 'wallet', idempotency_key: idem(), ...extra }));
  return r;
};

describe('Stripe: assinatura do webhook (unitário)', () => {
  const S = 'whsec_unit_test_only', NOW = 1_800_000_000_000, t = NOW / 1000;
  const sig = (body, ts = t, secret = S) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  test('válida; segredo errado, corpo adulterado, sem header, sem v1 => inválida', async () => {
    assert.equal(await verifyStripeSignature(sig('{"a":1}'), '{"a":1}', S, 300, NOW), true);
    assert.equal(await verifyStripeSignature(sig('{"a":1}', t, 'outro'), '{"a":1}', S, 300, NOW), false);
    assert.equal(await verifyStripeSignature(sig('{"a":1}'), '{"a":2}', S, 300, NOW), false);
    assert.equal(await verifyStripeSignature('', '{}', S, 300, NOW), false);
    assert.equal(await verifyStripeSignature(`t=${t}`, '{}', S, 300, NOW), false);
    assert.equal(await verifyStripeSignature(sig('{}'), '{}', '', 300, NOW), false);
  });
  test('expirada e do futuro => inválida; dentro da tolerância => válida', async () => {
    assert.equal(await verifyStripeSignature(sig('{}', t - 301), '{}', S, 300, NOW), false);
    assert.equal(await verifyStripeSignature(sig('{}', t + 301), '{}', S, 300, NOW), false);
    assert.equal(await verifyStripeSignature(sig('{}', t - 299), '{}', S, 300, NOW), true);
  });
  test('vários v1 (rotação de segredo): basta um válido', async () => {
    const h = `t=${t},v1=${'0'.repeat(64)},` + sig('{}').split(',')[1];
    assert.equal(await verifyStripeSignature(h, '{}', S, 300, NOW), true);
  });
});

describe('Stripe: requisições ao provedor (unitário)', () => {
  const input = { paymentId: '11111111-2222-4333-8444-555555555555', method: 'wallet', amountCents: 2550, description: 'Consumo - Mesa 3', notificationUrl: 'x', backUrl: 'y', expiresAt: new Date(), feeCents: 0, payerEmail: 'p@x.com' };
  test('PaymentIntent: direct charge na conta conectada, form-encoded, idempotente, metadata só com id opaco, valor do servidor', async () => {
    const led = new StripeLedger();
    const st = makeStripe({ secretKey: STRIPE_TEST.secret, webhookSecret: STRIPE_TEST.whsec }, makeFakeStripeFetch(led));
    const r = await st.createCharge({ accountId: 'acct_TESTconta1', accessToken: '' }, input);
    const call = led.calls[0];
    assert.equal(call.path, '/v1/payment_intents');
    assert.equal(call.account, 'acct_TESTconta1');
    assert.equal(call.idem, input.paymentId);
    assert.match(call.ctype, /x-www-form-urlencoded/);
    assert.equal(call.form.amount, '2550'); assert.equal(call.form.currency, 'brl');
    assert.deepEqual(Object.keys(call.form).filter(k => k.startsWith('metadata')), ['metadata[pid]']);
    assert.ok(!JSON.stringify(call.form).includes('p@x.com'), 'sem e-mail/PII');
    assert.equal(call.form.application_fee_amount, undefined);
    assert.ok(r.clientSecret.includes('_secret_'));
    await st.createCharge({ accountId: 'acct_TESTconta1', accessToken: '' }, input);
    assert.equal(led.pis.size, 1, 'mesma Idempotency-Key => mesmo PI');
  });
  test('rejeita Pix/cartão, conta inválida; erro não vaza o corpo; 5xx é retryable', async () => {
    const led = new StripeLedger();
    const st = makeStripe({ secretKey: STRIPE_TEST.secret, webhookSecret: STRIPE_TEST.whsec }, makeFakeStripeFetch(led));
    await assert.rejects(st.createCharge({ accountId: 'acct_TESTconta1', accessToken: '' }, { ...input, method: 'pix' }), ProviderError);
    await assert.rejects(st.createCharge({ accountId: 'malformada', accessToken: '' }, input), ProviderError);
    led.down = true;
    await assert.rejects(st.createCharge({ accountId: 'acct_TESTconta1', accessToken: '' }, input), e => e instanceof ProviderError && e.retryable);
  });
  test('status normalizado; consulta de PI de outra conta devolve null', async () => {
    assert.equal(normalizeStripeStatus({ status: 'succeeded' }), 'paid');
    assert.equal(normalizeStripeStatus({ status: 'succeeded', latest_charge: { refunded: true } }), 'refunded');
    assert.equal(normalizeStripeStatus({ status: 'processing' }), 'pending');
    assert.equal(normalizeStripeStatus({ status: 'canceled' }), 'failed');
    const led = new StripeLedger();
    const st = makeStripe({ secretKey: STRIPE_TEST.secret, webhookSecret: STRIPE_TEST.whsec }, makeFakeStripeFetch(led));
    const r = await st.createCharge({ accountId: 'acct_TESTconta1', accessToken: '' }, input);
    assert.ok(await st.fetchPayment({ accountId: 'acct_TESTconta1', accessToken: '' }, r.providerRef));
    assert.equal(await st.fetchPayment({ accountId: 'acct_OUTRAconta', accessToken: '' }, r.providerRef), null);
    assert.equal(form({ a: 1, m: { pid: 'x' }, l: ['a', 'b'] }), 'a=1&m%5Bpid%5D=x&l%5B%5D=a&l%5B%5D=b');
  });
});

describe('flags e banco das carteiras', () => {
  test('wallets_enabled nasce false; constraint exige payments_enabled; staff_write não escreve', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk();
    assert.equal((await c.pg.query('select wallets_enabled from kiosks where id=$1', [kid])).rows[0].wallets_enabled, false);
    await assert.rejects(c.pg.query('update kiosks set wallets_enabled=true, payments_enabled=false where id=$1', [kid]), /kiosks_wallets_need_payments/);
    const r = await c.anon.rpc('staff_write', { p_token: tok, p_table: 'kiosks', p_op: 'update', p_ids: [kid], p_data: { wallets_enabled: true } });
    assert.match(r.error.message, /Nada para atualizar/);
  });
  test('não liga sem pagamentos ligados, sem liberação da plataforma, sem conexão Stripe; waiter não liga', async () => {
    const c = await setup();
    let k = await c.kiosk({ enable: false });
    let r = await c.anon.rpc('set_payments_settings', { p_token: k.tok, p_wallets_enabled: true });
    assert.match(r.error.message, /Ative primeiro|Conecte/);
    k = await c.kiosk({ enable: false, invite: false });
    r = await c.anon.rpc('set_payments_settings', { p_token: k.tok, p_wallets_enabled: true });
    assert.match(r.error.message, /liberados/);
    assert.equal((await c.oauth({ action: 'connect_wallet_mock', session_token: k.tok })).status, 403);   // sem liberação nem conecta
    assert.equal((await c.pg.query('select wallets_enabled from kiosks where id=$1', [k.kid])).rows[0].wallets_enabled, false);
    k = await c.kiosk();      // pagamentos ligados, mas sem Stripe
    r = await c.anon.rpc('set_payments_settings', { p_token: k.tok, p_wallets_enabled: true });
    assert.match(r.error.message, /Conecte sua conta Stripe/);
    await c.oauth({ action: 'connect_wallet_mock', session_token: k.tok });
    const wid = (await c.pg.query(`insert into waiters(kiosk_id,name,email,password) values ($1,'G','g@x.com','x') returning id`, [k.kid])).rows[0].id;
    const wtok = await ownerToken(c.pg, k.kid, 'waiter', wid);
    r = await c.anon.rpc('set_payments_settings', { p_token: wtok, p_wallets_enabled: true });
    assert.match(r.error.message, /Apenas o responsável/);
    r = await c.anon.rpc('set_payments_settings', { p_token: k.tok, p_wallets_enabled: true });
    assert.equal(r.error, null);
  });
  test('desligar pagamentos, desconectar ou bloquear pela plataforma desliga as carteiras', async () => {
    const c = await setup();
    const w = async (f) => { const k = await c.kiosk({ wallets: true }); await f(k); return (await c.pg.query('select wallets_enabled w from kiosks where id=$1', [k.kid])).rows[0].w; };
    assert.equal(await w(async k => { await c.anon.rpc('set_payments_settings', { p_token: k.tok, p_enabled: false }); }), false);
    assert.equal(await w(async k => { await c.anon.rpc('payments_disconnect', { p_token: k.tok }); }), false);
    assert.equal(await w(async k => { await c.anon.rpc('payments_disconnect_wallets', { p_token: k.tok }); }), false);
    const adm = await ownerToken(c.pg, null, 'admin', crypto.randomUUID());
    assert.equal(await w(async k => { await c.anon.rpc('admin_set_payments_access', { p_token: adm, p_kiosk_id: k.kid, p_allowed: false }); }), false);
  });
  test('quote e wallet-config só anunciam carteiras quando tudo está ligado; sem segredo na resposta', async () => {
    const c = await setup();
    const a = await c.kiosk(); await seedOrder(c.pg, a.kid, 1, [{ q: 1, p: 10 }]);
    assert.equal((await c.anon.rpc('payment_quote', { p_kiosk: a.kid, p_umbrella: '1' })).data.wallets_available, false);
    assert.deepEqual((await json(await c.walletConfig({ kiosk_id: a.kid }))).body, { ok: true, enabled: false });
    const b = await c.kiosk({ wallets: true }); await seedOrder(c.pg, b.kid, 1, [{ q: 1, p: 10 }]);
    assert.equal((await c.anon.rpc('payment_quote', { p_kiosk: b.kid, p_umbrella: '1' })).data.wallets_available, true);
    const cfg = await json(await c.walletConfig({ kiosk_id: b.kid }));
    assert.equal(cfg.body.enabled, true); assert.equal(cfg.body.publishable_key, STRIPE_TEST.pk);
    assert.match(cfg.body.stripe_account, /^acct_/);
    assert.ok(!JSON.stringify(cfg.body).includes(STRIPE_TEST.secret) && !JSON.stringify(cfg.body).includes(STRIPE_TEST.whsec));
    c.env.vars.PAYMENTS_GLOBAL_ENABLED = '0';
    assert.equal((await json(await c.walletConfig({ kiosk_id: b.kid }))).body.enabled, false);
  });
  test('carteira recusada com flag das carteiras desligada ou Stripe sem segredo configurado', async () => {
    const c = await setup();
    const a = await c.kiosk(); await seedOrder(c.pg, a.kid, 1, [{ q: 1, p: 10 }]);
    const r = await walletCreate(c, a.kid);
    assert.equal(r.status, 403); assert.equal(c.stripe.pis.size, 0);
    const d = await setup({ STRIPE_SECRET_KEY: '' });
    const b = await d.kiosk({ wallets: true }); await seedOrder(d.pg, b.kid, 1, [{ q: 1, p: 10 }]);
    assert.equal((await walletCreate(d, b.kid)).status, 503);
  });
});

describe('carteira: fluxo completo com Stripe mock', () => {
  async function ready(c, price = 42) {
    const k = await c.kiosk({ wallets: true });
    await seedOrder(c.pg, k.kid, 1, [{ q: 1, p: price }]);
    return k;
  }
  test('criar -> webhook assinado -> pago -> comprovante -> validação pela equipe (uma vez)', async () => {
    const c = await setup();
    const { kid, tok } = await ready(c);
    const r = await walletCreate(c, kid);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.payment.method, 'wallet'); assert.equal(b.payment.amount_cents, 4200);
    assert.ok(b.client_secret && b.publishable_key === STRIPE_TEST.pk && /^acct_/.test(b.stripe_account));
    const pi = c.stripe.byPid(b.payment.id);
    assert.equal(pi.amount, 4200); assert.equal(pi.account, b.stripe_account);
    assert.deepEqual(pi.metadata, { pid: b.payment.id }, 'metadata só com id opaco');
    // pendente enquanto o cliente não confirmou
    let st = await json(await c.status({ payment_id: b.payment.id, client_token: b.client_token }));
    assert.equal(st.body.payment.status, 'pending');
    c.stripe.pay(pi.id);
    const w = await json(await c.stripeWebhook('payment_intent.succeeded', pi));
    assert.equal(w.status, 200); assert.equal(w.body.result, 'paid');
    st = await json(await c.status({ payment_id: b.payment.id, client_token: b.client_token }));
    assert.equal(st.body.payment.status, 'paid');
    assert.equal(st.body.payment.client_secret ?? undefined, undefined, 'client_secret some depois de pago');
    const pub = await c.anon.rpc('receipt_public_check', { p_receipt: b.receipt_token });
    assert.equal(pub.data.valid, true); assert.equal(pub.data.method, 'wallet'); assert.equal(pub.data.amount_cents, 4200);
    const v1 = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: b.receipt_token });
    assert.equal(v1.data.first_validation, true);
    const v2 = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: b.receipt_token });
    assert.equal(v2.data.already_validated, true);
  });
  test('valor adulterado pelo cliente é ignorado; a Stripe recebe o valor do banco', async () => {
    const c = await setup();
    const { kid } = await ready(c, 30);
    const r = await walletCreate(c, kid, 1, { amount: 1, amount_cents: 1, total: 1, items: [{ q: 1, p: 0.01 }] });
    assert.equal(r.body.payment.amount_cents, 3000);
    assert.equal(c.stripe.byPid(r.body.payment.id).amount, 3000);
  });
  test('assinatura inválida, ausente, expirada e corpo adulterado => 401 e nada muda', async () => {
    const c = await setup();
    const { kid } = await ready(c);
    const b = (await walletCreate(c, kid)).body; const pi = c.stripe.byPid(b.payment.id); c.stripe.pay(pi.id);
    const now = Math.floor(Date.now() / 1000);
    for (const o of [{ secret: 'whsec_errado' }, { sign: false }, { t: now - 3600 }, { t: now + 3600 }]) {
      assert.equal((await c.stripeWebhook('payment_intent.succeeded', pi, o)).status, 401, JSON.stringify(o));
    }
    const e = c.stripe.event('payment_intent.succeeded', pi);
    assert.equal((await c.stripeWebhook('payment_intent.succeeded', pi, { body: e.body.replace('succeeded', 'succeeded ') })).status, 401);
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'pending');
  });
  test('webhook repetido não duplica (already_paid; um evento paid)', async () => {
    const c = await setup();
    const { kid } = await ready(c);
    const b = (await walletCreate(c, kid)).body; const pi = c.stripe.byPid(b.payment.id); c.stripe.pay(pi.id);
    const r = [];
    for (let i = 0; i < 3; i++) r.push((await json(await c.stripeWebhook('payment_intent.succeeded', pi))).body.result);
    assert.deepEqual(r, ['paid', 'already_paid', 'already_paid']);
    const q = await c.pg.query(`select (select count(*)::int from payments where status='paid') p, (select count(*)::int from payment_events where kind='paid') e`);
    assert.deepEqual(q.rows[0], { p: 1, e: 1 });
  });
  test('webhook "succeeded" falso: a API diz que não foi pago => continua pendente (não confia no corpo)', async () => {
    const c = await setup();
    const { kid } = await ready(c);
    const b = (await walletCreate(c, kid)).body; const pi = c.stripe.byPid(b.payment.id);
    const w = await c.stripeWebhook('payment_intent.succeeded', { ...pi, status: 'succeeded' });
    assert.equal(w.status, 200);
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'pending');
  });
  test('valor recebido diferente do esperado NÃO liquida (needs_review)', async () => {
    const c = await setup();
    const { kid } = await ready(c);
    const b = (await walletCreate(c, kid)).body; const pi = c.stripe.byPid(b.payment.id);
    c.stripe.pay(pi.id, { amount: 100 });
    await c.stripeWebhook('payment_intent.succeeded', pi);
    const p = (await c.pg.query('select status, needs_review from payments')).rows[0];
    assert.notEqual(p.status, 'paid'); assert.equal(p.needs_review, true);
  });
  test('PI de OUTRO negócio / outra conta com o mesmo pid não liquida a cobrança', async () => {
    const c = await setup();
    const A = await ready(c); const B = await c.kiosk({ wallets: true, name: 'Outro' });
    const a = (await walletCreate(c, A.kid)).body;
    // atacante cria, na SUA conta, um PI pago com metadata.pid da cobrança de A
    const evil = { id: 'pi_evilevilevil0000', object: 'payment_intent', account: 'acct_ATACANTE001', status: 'succeeded', amount: 4200, amount_received: 4200, currency: 'brl', metadata: { pid: a.payment.id }, latest_charge: { refunded: false } };
    c.stripe.pis.set(evil.id, evil);
    const w = await c.stripeWebhook('payment_intent.succeeded', evil);
    assert.equal(w.status, 200);
    assert.equal((await c.pg.query(`select status from payments where id=$1`, [a.payment.id])).rows[0].status, 'pending');
    assert.ok(B.kid);
  });
  test('a mesa de A não pode ser cobrada pelo negócio B e o webhook de provedor errado é ignorado', async () => {
    const c = await setup();
    const A = await ready(c); const B = await c.kiosk({ wallets: true });
    const r = await walletCreate(c, B.kid, 1);      // B não tem pedidos na mesa 1
    assert.ok([404, 409, 400].includes(r.status), String(r.status));
    const a = (await walletCreate(c, A.kid)).body;
    c.stripe.pay(c.stripe.byPid(a.payment.id).id);
    assert.equal((await c.pg.query('select provider from payments')).rows[0].provider, 'stripe');
    const w = await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id });      // endpoint mock com pid de pagamento Stripe
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'pending');
    assert.ok(w.status === 200 || w.status === 401);
  });
  test('Stripe fora do ar => 502 para reenvio; evento irrelevante é ignorado; estorno inverte', async () => {
    const c = await setup();
    const { kid } = await ready(c);
    const b = (await walletCreate(c, kid)).body; const pi = c.stripe.byPid(b.payment.id); c.stripe.pay(pi.id);
    c.stripe.down = true;
    assert.equal((await c.stripeWebhook('payment_intent.succeeded', pi)).status, 502);
    c.stripe.down = false;
    const irr = await json(await c.stripeWebhook('customer.created', pi));
    assert.equal(irr.body.ignored, 'topic');
    await c.stripeWebhook('payment_intent.succeeded', pi);
    c.stripe.refund(pi.id);
    await c.stripeWebhook('charge.refunded', pi);
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'refunded');
  });
  test('cancelar cancela o PI na Stripe; idempotência devolve a mesma cobrança com o client_secret', async () => {
    const c = await setup();
    const { kid } = await ready(c);
    const key = idem();
    const a = (await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'wallet', idempotency_key: key }))).body;
    const a2 = (await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'wallet', idempotency_key: key }))).body;
    assert.equal(a.payment.id, a2.payment.id); assert.equal(a2.client_secret, a.client_secret); assert.equal(c.stripe.pis.size, 1);
    const can = await json(await c.status({ payment_id: a.payment.id, client_token: a.client_token, action: 'cancel' }));
    assert.equal(can.body.payment.status, 'cancelled');
    assert.equal(c.stripe.byPid(a.payment.id).status, 'canceled');
  });
});

describe('OAuth Stripe (Connect)', () => {
  test('start_wallet devolve URL de connect.stripe.com sem segredo e com state "stripe."; callback guarda só o acct_', async () => {
    const c = await setup();
    const k = await c.kiosk({ enable: true });
    const r = await json(await c.oauth({ action: 'start_wallet', session_token: k.tok }));
    assert.equal(r.status, 200);
    const u = new URL(r.body.url);
    assert.equal(u.host, 'connect.stripe.com');
    assert.ok(u.searchParams.get('state').startsWith('stripe.'));
    assert.ok(!r.body.url.includes(STRIPE_TEST.secret));
    const cb = await c.deps.providers.stripe && (await (await import('../../supabase/functions/_shared/handlers.ts')).handleOAuth(
      new Request(`https://fn.invalid/cb?code=abcCODE12345&state=${encodeURIComponent(u.searchParams.get('state'))}`, { method: 'GET' }), c.deps));
    assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /pagamentos=conectado/);
    const row = (await c.pg.query('select stripe_account_id, wallets_status from kiosk_payments where kiosk_id=$1', [k.kid])).rows[0];
    assert.match(row.stripe_account_id, /^acct_/); assert.equal(row.wallets_status, 'sandbox');
    // state reutilizado é recusado
    const again = await (await import('../../supabase/functions/_shared/handlers.ts')).handleOAuth(
      new Request(`https://fn.invalid/cb?code=abcCODE12345&state=${encodeURIComponent(u.searchParams.get('state'))}`), c.deps);
    assert.match(again.headers.get('location'), /pagamentos=erro/);
  });
  test('start_wallet exige dono; connect_wallet_mock exige PAYMENTS_ALLOW_MOCK', async () => {
    const c = await setup();
    const k = await c.kiosk({ enable: false });
    const wid = (await c.pg.query(`insert into waiters(kiosk_id,name,email,password) values ($1,'G','g@x.com','x') returning id`, [k.kid])).rows[0].id;
    const wtok = await ownerToken(c.pg, k.kid, 'waiter', wid);
    assert.equal((await c.oauth({ action: 'start_wallet', session_token: wtok })).status, 403);
    c.env.vars.PAYMENTS_ALLOW_MOCK = '0';
    assert.equal((await c.oauth({ action: 'connect_wallet_mock', session_token: k.tok })).status, 403);
  });
});
