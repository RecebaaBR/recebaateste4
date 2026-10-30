import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, idem, seedOrder, seedKiosk, ownerToken, MOCK_SECRET } from './helpers.mjs';

const json = async r => ({ status: r.status, body: await r.json() });
async function payFlow(c, kid, umb = 1, method = 'pix') {
  const r = await json(await c.create({ kiosk_id: kid, umbrella: umb, method, idempotency_key: idem() }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

describe('banco: acesso fechado e flag desligada por padrão', () => {
  test('kiosks.payments_enabled nasce false; tabelas de pagamento ilegíveis para anon', async () => {
    const c = await setup();
    const kid = await seedKiosk(c.pg);
    const r = await c.pg.query('select payments_enabled from kiosks where id=$1', [kid]);
    assert.equal(r.rows[0].payments_enabled, false);
    for (const t of ['payments', 'payment_orders', 'payment_events', 'kiosk_payments', 'payments_oauth_states']) {
      await c.pg.exec('set role anon');
      await assert.rejects(c.pg.query(`select * from ${t}`), /permission denied/i, t);
      await assert.rejects(c.pg.query(`insert into ${t} default values`), /permission denied/i, t);
      await c.pg.exec('reset role');
    }
  });

  test('funções que mexem em dinheiro/credenciais NÃO executam para anon', async () => {
    const c = await setup();
    const kid = await seedKiosk(c.pg);
    for (const [fn, args] of [
      ['payment_prepare', { p_kiosk: kid, p_umbrella: '1', p_method: 'pix', p_idem: idem() }],
      ['payment_settle', { p_payment_id: crypto.randomUUID(), p_status: 'paid', p_paid_cents: 1, p_provider_payment_id: 'x', p_ext_ref: 'x' }],
      ['payments_store_connection', { p_kiosk: kid, p_provider: 'mock', p_account_id: 'a', p_access_enc: 'x', p_refresh_enc: 'y', p_expires_at: new Date().toISOString(), p_status: 'connected' }],
      ['payment_for_webhook', { p_payment_id: crypto.randomUUID() }],
      ['payment_rate_hit', { p_bucket: 'x', p_max: 1, p_window_seconds: 1 }],
    ]) {
      const r = await c.anon.rpc(fn, args);
      assert.match(r.error?.message ?? '', /permission denied/i, fn);
    }
  });

  test('dono não liga sem conectar; waiter não mexe; staff_write não aceita payments_enabled', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk({ enable: false });
    let r = await c.anon.rpc('set_payments_settings', { p_token: tok, p_enabled: true });
    assert.match(r.error.message, /Conecte sua conta/);
    const wid = (await c.pg.query(`insert into waiters(kiosk_id,name,email,password) values ($1,'G','g@x.com','x') returning id`, [kid])).rows[0].id;
    const wtok = await ownerToken(c.pg, kid, 'waiter', wid);
    r = await c.anon.rpc('set_payments_settings', { p_token: wtok, p_enabled: true });
    assert.match(r.error.message, /Apenas o responsável/);
    r = await c.anon.rpc('staff_write', { p_token: tok, p_table: 'kiosks', p_op: 'update', p_ids: [kid], p_data: { payments_enabled: true } });
    assert.match(r.error.message, /Nada para atualizar/);
    assert.equal((await c.pg.query('select payments_enabled from kiosks where id=$1', [kid])).rows[0].payments_enabled, false);
  });

  test('negócio NÃO liberado pela plataforma: nem conecta nem liga, e não "está disponível"', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk({ enable: false, invite: false });
    assert.equal((await c.anon.rpc('payments_owner_status', { p_token: tok })).data.available, false);
    assert.equal((await c.oauth({ action: 'connect_mock', session_token: tok })).status, 403);
    assert.equal((await c.oauth({ action: 'start', session_token: tok })).status >= 400, true);
    const r = await c.anon.rpc('set_payments_settings', { p_token: tok, p_enabled: true });
    assert.match(r.error.message, /liberados/);
  });

  test('admin trava o negócio: desliga e impede religar', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk();
    const adm = await ownerToken(c.pg, null, 'admin', crypto.randomUUID());
    const r = await c.anon.rpc('admin_set_payments_access', { p_token: adm, p_kiosk_id: kid, p_allowed: false });
    assert.equal(r.error, null);
    assert.equal((await c.pg.query('select payments_enabled from kiosks where id=$1', [kid])).rows[0].payments_enabled, false);
    const again = await c.anon.rpc('set_payments_settings', { p_token: tok, p_enabled: true });
    assert.match(again.error.message, /liberados|indisponíveis/);
    const lib = await c.anon.rpc('admin_set_payments_access', { p_token: adm, p_kiosk_id: kid, p_allowed: true });
    assert.equal(lib.error, null);
    assert.equal((await c.anon.rpc('payments_owner_status', { p_token: tok })).data.available, true);
    const nonAdmin = await c.anon.rpc('admin_set_payments_access', { p_token: tok, p_kiosk_id: kid, p_allowed: true });
    assert.match(nonAdmin.error.message, /Acesso negado/);
  });
});

describe('create-payment: valor calculado no servidor', () => {
  test('valor adulterado pelo cliente é IGNORADO (amount/total/items no corpo)', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 2, p: 10 }, { q: 1, p: 5.5 }]);       // R$ 25,50
    const res = await json(await c.create({
      kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem(),
      amount: 0.01, amount_cents: 1, total: 1, transaction_amount: 0.01, items: [{ q: 1, p: 0.01 }], service_cents: 0 }));
    assert.equal(res.status, 200);
    assert.equal(res.body.payment.amount_cents, 2550);
    const row = (await c.pg.query('select amount_cents, subtotal_cents from payments')).rows[0];
    assert.equal(row.amount_cents, 2550);
    const ch = [...c.ledger.charges.values()][0];
    assert.equal(ch.amountCents, 2550, 'o provedor recebeu o valor do servidor');
  });

  test('adulteração no BANCO (total do pedido diverge dos itens) é recusada, falha fechada', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 100 }], { total: 1 });
    const res = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'order_mismatch');
    assert.equal((await c.pg.query('select count(*)::int n from payments')).rows[0].n, 0);
  });

  test('só pedidos ACEITOS entram; pending, cancelados, marcadores e sessões antigas ficam de fora', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    const old = new Date(Date.now() - 3 * 3600e3).toISOString();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 999 }], { createdAt: old });                       // sessão antiga
    await c.pg.query(`insert into orders(kiosk_id,umbrella_num,order_number,customer_name,status,total,created_at) values ($1,'1',0,'ENCERRAMENTO','cancelled',0, now() - interval '1 hour')`, [kid]);
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 20 }]);                                            // aceito: entra
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 50 }], { status: 'pending' });                      // não aceito
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 70 }], { status: 'cancelled' });
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 80 }], { status: 'billed' });
    await seedOrder(c.pg, kid, 2, [{ q: 1, p: 90 }]);                                             // outra mesa
    const q = await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' });
    assert.equal(q.data.enabled, true);
    assert.equal(q.data.amount_cents, 2000);
    assert.equal(q.data.pending_orders, 1);
    const res = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(res.body.payment.amount_cents, 2000);
  });

  test('taxa de serviço configurada pelo dono é somada NO SERVIDOR', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk({ servicePct: 10 });
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 100 }]);
    const res = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'card', idempotency_key: idem(), service_cents: 0 }));
    assert.equal(res.body.payment.subtotal_cents, 10000);
    assert.equal(res.body.payment.service_cents, 1000);
    assert.equal(res.body.payment.amount_cents, 11000);
    assert.ok(res.body.payment.checkout_url.startsWith('https://'));
    const bad = await c.anon.rpc('set_payments_settings', { p_token: tok, p_service_percent: 50 });
    assert.match(bad.error.message, /inválida/);
  });

  test('flag desligada / sem conexão: nenhuma cobrança é criada', async () => {
    const c = await setup();
    const { kid } = await c.kiosk({ enable: false });
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 10 }]);
    const res = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'payments_disabled');
    const q = await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' });
    assert.deepEqual(q.data, { enabled: false });
    assert.equal(c.ledger.charges.size, 0);
  });

  test('kill switch global: PAYMENTS_GLOBAL_ENABLED != 1 => 503', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    c.env.vars.PAYMENTS_GLOBAL_ENABLED = '0';
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 10 }]);
    const res = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(res.status, 503);
  });

  test('entradas inválidas e mesa inexistente', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 10 }]);
    for (const b of [{}, { kiosk_id: 'x' }, { kiosk_id: kid, umbrella: 'abc', method: 'pix', idempotency_key: idem() },
      { kiosk_id: kid, umbrella: 1, method: 'boleto', idempotency_key: idem() }, { kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: 'curta' }]) {
      assert.equal((await c.create(b)).status, 400, JSON.stringify(b));
    }
    const nf = await json(await c.create({ kiosk_id: kid, umbrella: 99, method: 'pix', idempotency_key: idem() }));
    assert.equal(nf.status, 404);
  });

  test('CORS: origem de terceiros não recebe Access-Control-Allow-Origin', async () => {
    const c = await setup();
    const evil = await c.create({}, { origin: 'https://evil.example' });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const ok = await c.create({});
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://recebaa.com.br');
  });

  test('limite de taxa por IP', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    let last;
    for (let i = 0; i < 14; i++) last = await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }, { 'cf-connecting-ip': '9.9.9.9' });
    assert.equal(last.status, 429);
  });
});

describe('idempotência e concorrência', () => {
  test('mesma chave devolve a MESMA cobrança, sem novos tokens e sem nova cobrança no provedor', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const key = idem();
    const a = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: key }));
    const b = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: key }));
    assert.equal(a.body.payment.id, b.body.payment.id);
    assert.ok(a.body.client_token && a.body.receipt_token);
    assert.equal(b.body.client_token, undefined);
    assert.equal(c.ledger.charges.size, 1);
    assert.equal((await c.pg.query('select count(*)::int n from payments')).rows[0].n, 1);
    const conflict = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'card', idempotency_key: key }));
    assert.equal(conflict.body.error, 'idempotency_conflict');
  });

  test('segunda cobrança para a mesma mesa enquanto há uma em andamento é recusada; cancelar libera', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    const dup = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(dup.body.error, 'payment_in_progress');
    const can = await json(await c.status({ payment_id: a.payment.id, client_token: a.client_token, action: 'cancel' }));
    assert.equal(can.body.payment.status, 'cancelled');
    const again = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'card', idempotency_key: idem() }));
    assert.equal(again.status, 200);
  });

  test('cobrança expirada libera os pedidos', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    await c.pg.query(`update payments set expires_at = now() - interval '1 minute'`);
    const st = await json(await c.status({ payment_id: a.payment.id, client_token: a.client_token }));
    assert.equal(st.body.payment.status, 'expired');
    const again = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(again.status, 200);
  });

  test('pedidos já pagos não são cobrados de novo; pedido novo gera nova cobrança só dele', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 40 }]);
    const a = await payFlow(c, kid);
    const ref = a.payment.id;
    c.ledger.approve('mock_' + ref);
    assert.equal((await c.webhook({ ref: 'mock_' + ref, pid: ref })).status, 200);
    const none = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(none.body.error, 'nothing_to_pay');
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 15 }]);
    const more = await json(await c.create({ kiosk_id: kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(more.body.payment.amount_cents, 1500);
  });
});

describe('webhook', () => {
  test('SEM assinatura é rejeitado (401) e nada muda', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    c.ledger.approve('mock_' + a.payment.id);                    // mesmo que o provedor tenha aprovado de fato
    const r = await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id, sign: false });
    assert.equal(r.status, 401);
    const bad = await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id, secret: 'segredo-errado' });
    assert.equal(bad.status, 401);
    // corpo adulterado depois de assinado
    const tampered = await c.webhook({ ref: 'mock_x', pid: a.payment.id, body: JSON.stringify({ type: 'payment', data: { id: 'mock_' + a.payment.id }, status: 'approved' }) });
    assert.equal(tampered.status, 401);
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'pending');
  });

  test('assinatura válida mas o PROVEDOR diz que não foi pago: continua pendente (não confia no corpo)', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    const w = await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id });
    assert.equal(w.status, 200);
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'pending');
  });

  test('webhook REPETIDO não duplica: um único pago, mesmo paid_at, um evento "paid"', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    c.ledger.approve('mock_' + a.payment.id);
    const r1 = await json(await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id }));
    const paidAt = (await c.pg.query('select paid_at from payments')).rows[0].paid_at;
    const r2 = await json(await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id }));
    const r3 = await json(await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id }));
    assert.equal(r1.body.result, 'paid');
    assert.equal(r2.body.result, 'already_paid');
    assert.equal(r3.body.result, 'already_paid');
    const q = await c.pg.query(`select (select count(*)::int from payments where status='paid') paid, (select count(*)::int from payment_events where kind='paid') ev, (select paid_at from payments) pa`);
    assert.equal(q.rows[0].paid, 1);
    assert.equal(q.rows[0].ev, 1);
    assert.equal(new Date(q.rows[0].pa).getTime(), new Date(paidAt).getTime());
  });

  test('valor pago diferente do esperado NÃO liquida (needs_review)', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    c.ledger.approve('mock_' + a.payment.id, 100);               // pagou R$1,00 em vez de R$30,00
    await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id });
    const row = (await c.pg.query('select status, needs_review from payments')).rows[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.needs_review, true);
  });

  test('pagamento de OUTRO negócio não liquida cobrança alheia (token do dono da cobrança é que consulta)', async () => {
    const c = await setup();
    const A = await c.kiosk({ name: 'A' });
    const B = await c.kiosk({ name: 'B' });
    await seedOrder(c.pg, A.kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, A.kid);
    // atacante com conta no negócio B cria cobrança aprovada, mas apontando para a referência da cobrança de A
    c.ledger.charges.set('mock_fake', { ref: 'mock_fake', paymentId: a.payment.id, amountCents: 3000, method: 'pix', status: 'approved', paidCents: 3000, sellerAccount: 'mock-' + B.kid.slice(0, 8) });
    const w = await c.webhook({ ref: 'mock_fake', pid: a.payment.id });
    assert.equal(w.status, 200);
    assert.equal((await c.pg.query('select status from payments')).rows[0].status, 'pending');
  });

  test('a mesa/pedido de A não pode ser cobrado pelo negócio B', async () => {
    const c = await setup();
    const A = await c.kiosk({ name: 'A' });
    const B = await c.kiosk({ name: 'B' });
    await seedOrder(c.pg, A.kid, 1, [{ q: 1, p: 30 }]);
    // B tem a mesa 1 também (números repetem entre negócios), mas sem consumo: nada a pagar
    const r = await json(await c.create({ kiosk_id: B.kid, umbrella: 1, method: 'pix', idempotency_key: idem() }));
    assert.equal(r.body.error, 'nothing_to_pay');
    // B com mesa que não existe nele (A tem a 3? ambos têm 1..3) -> usa 7
    const r2 = await json(await c.create({ kiosk_id: B.kid, umbrella: 7, method: 'pix', idempotency_key: idem() }));
    assert.equal(r2.body.error, 'umbrella_not_found');
    // e o status de uma cobrança de A não abre com token de outra
    await seedOrder(c.pg, B.kid, 1, [{ q: 1, p: 5 }]);
    const a = await payFlow(c, A.kid);
    const b = await payFlow(c, B.kid);
    const cross = await json(await c.status({ payment_id: a.payment.id, client_token: b.client_token }));
    assert.equal(cross.status, 404);
  });

  test('tópico irrelevante e pid inexistente são ignorados com 200; provedor fora do ar => 502 (reenvio)', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    assert.equal((await json(await c.webhook({ ref: 'x', pid: a.payment.id, topic: 'merchant_order' }))).body.ignored, 'topic');
    assert.equal((await json(await c.webhook({ ref: 'x', pid: crypto.randomUUID() }))).body.ignored, 'unknown_payment');
    c.deps.providers.mock.searchByReference = async () => { const { ProviderError } = await import('../../supabase/functions/_shared/types.ts'); throw new ProviderError('timeout', true); };
    c.deps.providers.mock.fetchPayment = async () => { const { ProviderError } = await import('../../supabase/functions/_shared/types.ts'); throw new ProviderError('timeout', true); };
    assert.equal((await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id })).status, 502);
  });

  test('pagamento tardio (depois de expirar) é aceito e sinalizado; estorno inverte', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    await seedOrder(c.pg, kid, 1, [{ q: 1, p: 30 }]);
    const a = await payFlow(c, kid);
    await c.pg.query(`update payments set expires_at = now() - interval '1 minute'`);
    await c.status({ payment_id: a.payment.id, client_token: a.client_token });          // marca expired
    c.ledger.approve('mock_' + a.payment.id);
    await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id });
    let row = (await c.pg.query('select status, late_payment from payments')).rows[0];
    assert.equal(row.status, 'paid'); assert.equal(row.late_payment, true);
    c.ledger.set('mock_' + a.payment.id, { status: 'refunded' });
    await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id });
    row = (await c.pg.query('select status from payments')).rows[0];
    assert.equal(row.status, 'refunded');
    const v = await c.anon.rpc('receipt_public_check', { p_receipt: a.receipt_token });
    assert.equal(v.data.valid, false);
  });
});

describe('comprovante (QR) e validação pela equipe', () => {
  async function paid(c, kid, umb = 1, price = 42) {
    await seedOrder(c.pg, kid, umb, [{ q: 1, p: price }]);
    const a = await payFlow(c, kid, umb);
    c.ledger.approve('mock_' + a.payment.id);
    await c.webhook({ ref: 'mock_' + a.payment.id, pid: a.payment.id });
    return a;
  }
  test('fluxo completo: criar -> webhook -> status pago -> comprovante -> baixa pela equipe (uma vez)', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk();
    const a = await paid(c, kid);
    const st = await json(await c.status({ payment_id: a.payment.id, client_token: a.client_token }));
    assert.equal(st.body.payment.status, 'paid');
    assert.equal(st.body.payment.pix_copy_paste, null);       // não expõe mais o código depois de pago
    const pub = await c.anon.rpc('receipt_public_check', { p_receipt: a.receipt_token });
    assert.equal(pub.data.valid, true);
    assert.equal(pub.data.amount_cents, 4200);
    assert.deepEqual(Object.keys(pub.data).sort(), ['amount_cents', 'kiosk_name', 'method', 'paid_at', 'status', 'umbrella_num', 'valid', 'validated_at']);
    const v1 = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: a.receipt_token });
    assert.equal(v1.data.valid, true); assert.equal(v1.data.first_validation, true); assert.equal(v1.data.already_validated, false);
    const v2 = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: a.receipt_token });
    assert.equal(v2.data.valid, true); assert.equal(v2.data.already_validated, true); assert.equal(v2.data.validation_count, 2);
  });

  test('token de comprovante INVÁLIDO não valida (aleatório, adulterado, vazio, de pagamento não pago)', async () => {
    const c = await setup();
    const { kid, tok } = await c.kiosk();
    const a = await paid(c, kid);
    const unpaid = await (async () => { await seedOrder(c.pg, kid, 2, [{ q: 1, p: 9 }]); return payFlow(c, kid, 2); })();
    const wrong = [a.receipt_token.slice(0, -1) + (a.receipt_token.endsWith('0') ? '1' : '0'), 'a'.repeat(48), '', 'x', a.client_token, "' or 1=1 --", a.receipt_token.toUpperCase()];
    for (const t of wrong) {
      const r = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: t });
      assert.equal(r.data?.valid, false, 'staff: ' + t);
      const p = await c.anon.rpc('receipt_public_check', { p_receipt: t });
      assert.equal(p.data?.valid, false, 'public: ' + t);
    }
    const u = await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: unpaid.receipt_token });
    assert.equal(u.data.valid, false); assert.equal(u.data.reason, 'pending');
    const pu = await c.anon.rpc('receipt_public_check', { p_receipt: unpaid.receipt_token });
    assert.equal(pu.data.valid, false);
  });

  test('comprovante de OUTRO negócio não valida para a equipe daqui (e não revela que existe)', async () => {
    const c = await setup();
    const A = await c.kiosk({ name: 'A' }); const B = await c.kiosk({ name: 'B' });
    const a = await paid(c, A.kid);
    const r = await c.anon.rpc('verify_payment_receipt', { p_token: B.tok, p_receipt: a.receipt_token });
    assert.deepEqual(r.data, { valid: false, reason: 'not_found' });
    const none = await c.anon.rpc('verify_payment_receipt', { p_token: B.tok, p_receipt: 'z'.repeat(48) });
    assert.deepEqual(none.data, r.data);
  });

  test('sem sessão de equipe não valida; token do cliente não serve de sessão', async () => {
    const c = await setup();
    const { kid } = await c.kiosk();
    const a = await paid(c, kid);
    for (const t of [null, '', 'abc', a.client_token]) {
      const r = await c.anon.rpc('verify_payment_receipt', { p_token: t, p_receipt: a.receipt_token });
      assert.ok(r.error, String(t));
    }
  });

  test('payments_list: só do próprio negócio, sem dados pessoais', async () => {
    const c = await setup();
    const A = await c.kiosk({ name: 'A' }); const B = await c.kiosk({ name: 'B' });
    await paid(c, A.kid);
    assert.equal((await c.anon.rpc('payments_list', { p_token: A.tok })).data.length, 1);
    assert.equal((await c.anon.rpc('payments_list', { p_token: B.tok })).data.length, 0);
  });
});

describe('OAuth / conexão', () => {
  test('connect_mock exige sessão de DONO; tokens ficam cifrados no banco', async () => {
    const c = await setup();
    const kid = await seedKiosk(c.pg);
    const noAuth = await c.oauth({ action: 'connect_mock', session_token: 'x'.repeat(64) });
    assert.equal(noAuth.status, 403);
    const tok = await ownerToken(c.pg, kid);
    assert.equal((await c.oauth({ action: 'connect_mock', session_token: tok })).status, 403, 'sem liberação da plataforma');
    await c.pg.query('insert into kiosk_payments(kiosk_id, invited) values ($1, true)', [kid]);
    assert.equal((await c.oauth({ action: 'connect_mock', session_token: tok })).status, 200);
    const row = (await c.pg.query('select access_token_enc, refresh_token_enc from kiosk_payments')).rows[0];
    assert.match(row.access_token_enc, /^v1\./);
    assert.ok(!row.access_token_enc.includes('mock-access'));
    // cifrado com AAD = kiosk_id: não decifra para outro negócio
    await assert.rejects(c.deps.crypto.decrypt(row.access_token_enc, crypto.randomUUID()));
    assert.equal(await c.deps.crypto.decrypt(row.access_token_enc, kid), 'mock-access');
  });

  test('mock desligado (PAYMENTS_ALLOW_MOCK != 1) => connect_mock recusado e provedor mock inexistente', async () => {
    const c = await setup({ PAYMENTS_ALLOW_MOCK: '0', PAYMENTS_PROVIDER: 'mercadopago' });
    const kid = await seedKiosk(c.pg); const tok = await ownerToken(c.pg, kid);
    assert.ok(!c.deps.providers.mock);
    const r = await c.oauth({ action: 'connect_mock', session_token: tok });
    assert.ok([403, 503].includes(r.status));
  });

  test('callback OAuth: state inválido/reusado é recusado', async () => {
    const c = await setup({ PAYMENTS_PROVIDER: 'mock' });
    const { handleOAuth } = await import('../../supabase/functions/_shared/handlers.ts');
    const r = await handleOAuth(new Request('https://fn.invalid/payments-oauth?code=abc&state=inexistente'), c.deps);
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /pagamentos=erro/);
  });
});
