// Pix direto (sem gateway): BR Code com CRC16, criação pelo handler, confirmação manual e modo obrigatório ponta a ponta no servidor.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, idem, seedOrder, ownerToken, seedProduct, clientOrder, VALID_CPF } from './helpers.mjs';
import { crc16, buildBrCode, parseBrCode } from '../../supabase/functions/_shared/brcode.ts';
import { ProviderError } from '../../supabase/functions/_shared/types.ts';

const json = async r => ({ status: r.status, body: await r.json() });
const q1 = (c, sql, a = []) => c.pg.query(sql, a).then(r => r.rows);

describe('BR Code Pix (EMV + CRC16)', () => {
  test('CRC16/CCITT-FALSE confere com vetores conhecidos ', () => {
    assert.equal(crc16('123456789'), '29B1');
    assert.equal(crc16(''), 'FFFF'); assert.equal(crc16('A'), 'B915');
  });
  test('gera, decodifica e valida: campos obrigatórios, valor, beneficiário, cidade, txid e CRC', () => {
    const code = buildBrCode({ key: '52998224725', name: 'Quiosque do Zé', city: 'São José', amountCents: 3250, txid: 'RCB' + 'abcdef0123456789abcd' });
    const d = parseBrCode(code);
    assert.ok(d.ok && d.crcOk);
    assert.equal(d.fields['00'], '01'); assert.equal(d.fields['01'], '11'); assert.equal(d.merchant['00'], 'br.gov.bcb.pix'); assert.equal(d.merchant['01'], '52998224725');
    assert.equal(d.fields['52'], '0000'); assert.equal(d.fields['53'], '986'); assert.equal(d.fields['54'], '32.50'); assert.equal(d.fields['58'], 'BR');
    assert.equal(d.fields['59'], 'QUIOSQUE DO ZE'); assert.equal(d.fields['60'], 'SAO JOSE'); assert.equal(d.extra['05'], 'RCBabcdef0123456789abcd');
    assert.ok(code.endsWith(crc16(code.slice(0, -4))) && code.slice(-8, -4) === '6304');
    // adulteração em qualquer ponto invalida o CRC
    const t = code.replace('32.50', '00.50'); assert.equal(parseBrCode(t).crcOk, false);
    assert.equal(parseBrCode(code.slice(0, -1) + (code.at(-1) === '0' ? '1' : '0')).crcOk, false);
  });
  test('limites e entradas inválidas', () => {
    const base = { key: 'a@b.com', name: 'Zé', city: 'Natal', amountCents: 100, txid: 'X1' };
    for (const bad of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 10.5 }, { amountCents: 5_000_001 }, { key: '' }, { key: 'com espaço' }, { name: '???' }, { city: '' }, { txid: '---' }]) {
      assert.throws(() => buildBrCode({ ...base, ...bad }), JSON.stringify(bad));
    }
    const long = parseBrCode(buildBrCode({ ...base, name: 'N'.repeat(60), city: 'C'.repeat(40), txid: 'T'.repeat(60) }));
    assert.equal(long.fields['59'].length, 25); assert.equal(long.fields['60'].length, 15); assert.equal(long.extra['05'].length, 25);
    assert.equal(parseBrCode(buildBrCode({ ...base, amountCents: 5_000_000 })).fields['54'], '50000.00');
  });
});

describe('create-payment: Pix direto', () => {
  test('gera o copia-e-cola com o valor do BANCO, a chave do negócio e o identificador da cobrança; valor do cliente é ignorado; nenhum gateway é chamado', async () => {
    const c = await setup(); const { kid } = await c.kiosk({ enable: false, pixDirect: true, name: 'Quiosque do Zé' });
    await seedOrder(c.pg, kid, 1, [{ q: 2, p: 12.5 }, { q: 1, p: 7.5 }]);
    const r = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem(), amount: 1, amount_cents: 1, total: 1 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment.method, 'pix_direct'); assert.equal(r.body.payment.amount_cents, 3250); assert.equal(r.body.payment.provider, 'direct');
    const d = parseBrCode(r.body.payment.pix_copy_paste);
    assert.ok(d.ok && d.crcOk); assert.equal(d.fields['54'], '32.50'); assert.equal(d.merchant['01'], '52998224725'); assert.equal(d.fields['59'], 'QUIOSQUE DO ZE'); assert.equal(d.fields['60'], 'NATAL');
    assert.equal(d.extra['05'], 'RCB' + r.body.payment.id.replace(/-/g, '').slice(0, 20), 'identificador liga o Pix à cobrança/mesa');
    assert.ok(r.body.client_token && r.body.receipt_token);
    assert.equal(c.ledger.charges.size, 0); assert.equal(c.stripe.pis.size, 0);
    // o cliente consegue acompanhar e a chave não vaza além do copia-e-cola
    const st = await json(await c.status({ payment_id: r.body.payment.id, client_token: r.body.client_token }));
    assert.equal(st.body.payment.status, 'pending');
    assert.ok(!JSON.stringify(st.body).includes('52998224725') || st.body.payment.pix_copy_paste.includes('52998224725'));
    const rf = await json(await c.status({ payment_id: r.body.payment.id, client_token: r.body.client_token, action: 'refresh' }));
    assert.equal(rf.body.payment.status, 'pending', 'não há o que consultar: segue pendente até a baixa manual');
  });
  test('flag do Pix direto desligada / sem chave / negócio de outro => nada é gerado; pix online e cartão respeitam as chaves por método', async () => {
    const c = await setup(); const A = await c.kiosk({ enable: true }); await seedOrder(c.pg, A.kid, 1, [{ q: 1, p: 10 }]);
    const mk = async (m, kid = A.kid) => json(await c.create({ kiosk_id: kid, umbrella: 1, method: m, idempotency_key: idem() }));
    assert.equal((await mk('pix_direct')).status, 403);
    await c.anon.rpc('payments_panel_set', { p_token: A.tok, p_patch: { card: false } });
    assert.equal((await mk('card')).status, 403); assert.equal((await mk('pix')).status, 200);
    const can = await json(await c.status({ payment_id: (await q1(c, 'select id from payments'))[0].id, client_token: 'z'.repeat(30), action: 'cancel' }));
    assert.equal(can.status, 404);
    await c.anon.rpc('payments_panel_set', { p_token: A.tok, p_patch: { pix_online: false } });
    await c.pg.query(`update payments set status='cancelled'`); await c.pg.query(`update payment_orders set active=false`);
    assert.equal((await mk('pix')).status, 403);
    c.env.vars.PAYMENTS_GLOBAL_ENABLED = '0';
    assert.equal((await mk('pix_direct')).status, 503, 'kill switch derruba também o Pix direto');
  });
  test('a mesa de um negócio não é cobrada pela chave de outro; chaves distintas por negócio', async () => {
    const c = await setup(); const A = await c.kiosk({ enable: false, pixDirect: true, name: 'A' }); const B = await c.kiosk({ enable: false, pixDirect: true, name: 'B' });
    await c.anon.rpc('pix_key_set', { p_token: B.tok, p_type: 'email', p_value: 'b@exemplo.com', p_name: 'Quiosque B', p_city: 'Recife' });
    await seedOrder(c.pg, A.kid, 1, [{ q: 1, p: 10 }]); await seedOrder(c.pg, B.kid, 1, [{ q: 1, p: 20 }]);
    const a = await json(await c.create({ kiosk_id: A.kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem() }));
    const b = await json(await c.create({ kiosk_id: B.kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem() }));
    assert.equal(parseBrCode(a.body.payment.pix_copy_paste).merchant['01'], '52998224725');
    assert.equal(parseBrCode(b.body.payment.pix_copy_paste).merchant['01'], 'b@exemplo.com');
    assert.equal(parseBrCode(b.body.payment.pix_copy_paste).fields['54'], '20.00');
  });
  test('webhook não existe para o Pix direto (?provider=direct é recusado) e baixa por token do cliente não é possível', async () => {
    const c = await setup(); const { kid } = await c.kiosk({ enable: false, pixDirect: true });
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 10 }]);
    const r = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem() }));
    const { handlePaymentWebhook } = await import('../../supabase/functions/_shared/handlers.ts');
    const w = await handlePaymentWebhook(new Request('https://fn.invalid/payment-webhook?provider=direct&pid=' + r.body.payment.id, { method: 'POST', body: '{}' }), c.deps);
    assert.ok([401, 503].includes(w.status));
    assert.equal((await q1(c, 'select status from payments'))[0].status, 'pending');
    const bad = await c.anon.rpc('payment_manual_settle', { p_token: r.body.client_token, p_payment_id: r.body.payment.id });
    assert.ok(bad.error, 'token do cliente não serve de sessão');
  });
});

describe('modo obrigatório: ponta a ponta no servidor', () => {
  async function req(extra = {}) {
    const c = await setup(); const k = await c.kiosk({ pixDirect: true, mode: 'required', ...extra });
    const prod = await seedProduct(c.pg, k.kid, 'Cerveja', 12.5);
    return { c, ...k, prod };
  }
  const place = async (c, kid, prod, umb = 1) => (await clientOrder(c, kid, umb, [{ id: prod, n: 'Cerveja', q: 2, p: 12.5 }])).order;

  test('retido -> create-payment(hold) -> baixa manual -> liberado; comprovante vale; o pedido não aparece antes', async () => {
    const { c, kid, tok, prod } = await req({ enable: false });
    await place(c, kid, prod);
    assert.deepEqual((await c.anon.rpc('read_orders', { p_token: tok })).data, []);
    const noHold = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem() }));
    assert.equal(noHold.body.error, 'nothing_to_pay', 'sem hold:true só cobra pedidos aceitos');
    const r = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem(), hold: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.payment.amount_cents, 2500);
    assert.equal(parseBrCode(r.body.payment.pix_copy_paste).fields['54'], '25.00');
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 0);
    const m = await c.anon.rpc('payment_manual_settle', { p_token: tok, p_payment_id: r.body.payment.id });
    assert.equal(m.data.result, 'paid');
    const vis = (await c.anon.rpc('read_orders', { p_token: tok })).data;
    assert.equal(vis.length, 1); assert.equal(vis[0].payment_hold, false);
    const pub = await c.anon.rpc('receipt_public_check', { p_receipt: r.body.receipt_token });
    assert.equal(pub.data.valid, true); assert.equal(pub.data.method, 'pix_direct'); assert.equal(pub.data.amount_cents, 2500);
    const v = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: r.body.receipt_token });
    assert.equal(v.data.first_validation, true);
    const st = await json(await c.status({ payment_id: r.body.payment.id, client_token: r.body.client_token }));
    assert.equal(st.body.payment.status, 'paid');
  });
  test('gateway (mock) no modo obrigatório: webhook assinado libera o pedido; repetido não duplica; valor errado não libera', async () => {
    const { c, kid, tok, prod } = await req({ pixDirect: false });
    await place(c, kid, prod);
    const r = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem(), hold: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 0);
    c.ledger.approve('mock_' + r.body.payment.id, 100);                 // pagou valor errado
    await c.webhook({ ref: 'mock_' + r.body.payment.id, pid: r.body.payment.id });
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 0, 'valor divergente não libera');
    assert.equal((await q1(c, 'select needs_review r from payments'))[0].r, true);
    c.ledger.approve('mock_' + r.body.payment.id);
    for (let i = 0; i < 3; i++) await c.webhook({ ref: 'mock_' + r.body.payment.id, pid: r.body.payment.id });
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 1);
    assert.equal((await q1(c, `select count(*)::int n from order_events where kind='insert'`))[0].n, 1, 'um único alerta para a equipe');
  });
  test('provedor fora do ar no modo obrigatório: falha clara, nada é cobrado, pedido segue retido e dá para pagar por outro meio', async () => {
    const { c, kid, tok, prod } = await req({ pixDirect: true });
    await place(c, kid, prod);
    c.deps.providers.mock.createCharge = async () => { throw new ProviderError('indisponível', true); };
    const f = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem(), hold: true }));
    assert.equal(f.status, 502); assert.match(f.body.message, /Não foi possível gerar a cobrança/);
    assert.equal((await q1(c, `select status from payments`))[0].status, 'failed');
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 0, 'nada vaza para a equipe');
    const q = (await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' })).data;
    assert.equal(q.held.count, 1, 'continua retido (até expirar)');
    const alt = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem(), hold: true }));
    assert.equal(alt.status, 200);
    // dono troca para opcional em um clique: novos pedidos passam direto; o retido continua retido até pagar/expirar
    const sw = await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { checkout_mode: 'optional' } });
    assert.equal(sw.data.checkout_mode, 'optional');
    const direct = await clientOrder(c, kid, 2, [{ id: prod, n: 'Cerveja', q: 1, p: 12.5 }]);
    assert.equal(direct.order.payment_hold, false);
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 1);
  });
  test('kill switch com pedido retido: create-payment responde 503 e o pedido não vira pedido visível', async () => {
    const { c, kid, tok, prod } = await req({ enable: false });
    await place(c, kid, prod);
    c.env.vars.PAYMENTS_GLOBAL_ENABLED = '0';
    assert.equal((await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix_direct', idempotency_key: idem(), hold: true })).status, 503);
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 0);
  });
  test('"global_status" informa o kill switch ao painel', async () => {
    const c = await setup(); const { tok } = await c.kiosk({ enable: false });
    const on = await json(await c.oauth({ action: 'global_status', session_token: tok })); assert.equal(on.body.global, true);
    c.env.vars.PAYMENTS_GLOBAL_ENABLED = '0';
    assert.equal((await c.oauth({ action: 'global_status', session_token: tok })).status, 503);
  });
});
