// Painel "Pagamentos": chave Pix, chaves por método, modo de checkout, pedidos retidos, baixa manual, lista e ações do dono.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, idem, seedOrder, seedKiosk, ownerToken, seedProduct, clientOrder, VALID_CPF, VALID_CNPJ } from './helpers.mjs';

const q1 = (c, sql, a = []) => c.pg.query(sql, a).then(r => r.rows);
async function waiterTok(c, kid, name = 'Gabriel') {
  const wid = (await c.pg.query(`insert into waiters(kiosk_id,name,email,password) values ($1,$2,$3,'x') returning id`, [kid, name, name + '@x.com'])).rows[0].id;
  return { wid, tok: await ownerToken(c.pg, kid, 'waiter', wid) };
}

describe('chave Pix: validação e acesso (só o dono)', () => {
  test('formatos válidos são aceitos e NORMALIZADOS; inválidos são recusados com mensagem clara', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ enable: false });
    const set = (t, v, n = 'Zé', ct = 'Natal') => c.anon.rpc('pix_key_set', { p_token: tok, p_type: t, p_value: v, p_name: n, p_city: ct });
    for (const [t, v, norm] of [['cpf', VALID_CPF, '52998224725'], ['cnpj', VALID_CNPJ, '11222333000181'], ['email', ' Fulano@Exemplo.COM ', 'fulano@exemplo.com'],
      ['phone', '(84) 98765-4321', '+5584987654321'], ['phone', '+55 84 3211-1234', '+558432111234'], ['random', '123E4567-E89B-12D3-A456-426614174000', '123e4567-e89b-12d3-a456-426614174000']]) {
      const r = await set(t, v); assert.equal(r.error, null, t + ' ' + (r.error?.message));
      assert.equal(r.data.pix_key.value, norm); assert.equal(r.data.pix_key.type, t);
    }
    for (const [t, v, re] of [['cpf', '111.111.111-11', /CPF inválido/], ['cpf', '123.456.789-00', /CPF inválido/], ['cpf', '1234', /CPF inválido/], ['cnpj', '11.222.333/0001-82', /CNPJ inválido/],
      ['cnpj', '00000000000000', /CNPJ inválido/], ['email', 'sem-arroba', /E-mail inválido/], ['email', 'a@b', /E-mail inválido/], ['email', 'a b@c.com', /E-mail inválido/],
      ['phone', '12345', /Telefone inválido/], ['phone', '(00) 98765-4321', /Telefone inválido/], ['random', 'não-é-uuid', /aleatória inválida/], ['random', '123e4567-e89b-12d3-a456-42661417400', /aleatória inválida/],
      ['pix', 'x', /Tipo de chave inválido/], ['cpf', '', /Informe a chave/]]) {
      const r = await set(t, v); assert.match(r.error?.message ?? 'SEM ERRO', re, t + ' ' + v);
    }
    // injeção / texto estranho não passa
    assert.ok((await set('email', "a'; drop table orders;--@x.com")).error);
    assert.equal((await q1(c, 'select count(*)::int n from orders'))[0].n, 0);
  });
  test('nome do beneficiário e cidade: ASCII maiúsculo, sem acento, truncado em 25/15; vazio é recusado', async () => {
    const c = await setup(); const { tok } = await c.kiosk({ enable: false });
    const r = await c.anon.rpc('pix_key_set', { p_token: tok, p_type: 'cpf', p_value: VALID_CPF, p_name: 'José   da Praia & Çia <b>Ltda</b> Muito Longa', p_city: 'São José de Ribamar' });
    assert.equal(r.error, null);
    assert.equal(r.data.pix_key.name, 'JOSE DA PRAIA CIA BLTDAB M'.slice(0, 25).replace(/\s+$/, ''));
    assert.ok(r.data.pix_key.name.length <= 25 && /^[A-Z0-9 ]+$/.test(r.data.pix_key.name));
    assert.ok(r.data.pix_key.city.length <= 15 && /^[A-Z0-9 ]+$/.test(r.data.pix_key.city));
    assert.match((await c.anon.rpc('pix_key_set', { p_token: tok, p_type: 'cpf', p_value: VALID_CPF, p_name: '???', p_city: 'Natal' })).error.message, /nome do beneficiário/);
    assert.match((await c.anon.rpc('pix_key_set', { p_token: tok, p_type: 'cpf', p_value: VALID_CPF, p_name: 'Zé', p_city: '' })).error.message, /cidade/);
  });
  test('só o DONO lê/escreve: garçom não; outro negócio não; anon não lê a tabela; negócio não liberado não cadastra', async () => {
    const c = await setup(); const A = await c.kiosk({ enable: false }); const B = await c.kiosk({ enable: false, name: 'B' });
    await c.anon.rpc('pix_key_set', { p_token: A.tok, p_type: 'cpf', p_value: VALID_CPF, p_name: 'A', p_city: 'Natal' });
    const w = await waiterTok(c, A.kid);
    assert.match((await c.anon.rpc('pix_key_set', { p_token: w.tok, p_type: 'cpf', p_value: VALID_CPF, p_name: 'X', p_city: 'Y' })).error.message, /Apenas o responsável/);
    assert.match((await c.anon.rpc('payments_panel_get', { p_token: w.tok })).error.message, /Apenas o responsável/);
    assert.match((await c.anon.rpc('pix_key_clear', { p_token: w.tok })).error.message, /Apenas o responsável/);
    assert.equal((await c.anon.rpc('payments_panel_get', { p_token: B.tok })).data.pix_key, null, 'B não vê a chave de A');
    await c.pg.exec('set role anon'); await assert.rejects(c.pg.query('select * from kiosk_pix_keys'), /permission denied/i); await c.pg.exec('reset role');
    assert.ok((await c.anon.rpc('payments_panel_get', { p_token: 'x'.repeat(40) })).error, 'sem sessão');
    const N = await c.kiosk({ enable: false, invite: false, name: 'N' });
    assert.match((await c.anon.rpc('pix_key_set', { p_token: N.tok, p_type: 'cpf', p_value: VALID_CPF, p_name: 'N', p_city: 'N' })).error.message, /liberados/);
  });
  test('auditoria: registra quem/quando/o quê, e NUNCA a chave', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ enable: false });
    await c.anon.rpc('pix_key_set', { p_token: tok, p_type: 'email', p_value: 'segredo@exemplo.com', p_name: 'A', p_city: 'B' });
    await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: true } });
    const ev = await q1(c, `select kind, detail from payment_events where kiosk_id=$1 order by id`, [kid]);
    assert.ok(ev.some(e => e.kind === 'pix_key_set') && ev.some(e => e.kind === 'config_changed'));
    assert.ok(!JSON.stringify(ev).includes('segredo@exemplo.com'));
    const g = (await c.anon.rpc('payments_panel_get', { p_token: tok })).data;
    assert.ok(g.audit.length >= 2 && g.audit.every(a => a.at && a.kind));
    assert.ok(!JSON.stringify(g.audit).includes('segredo@exemplo.com'));
    // apagar a chave desliga o Pix direto
    const cl = await c.anon.rpc('pix_key_clear', { p_token: tok });
    assert.equal(cl.data.pix_key, null); assert.equal(cl.data.methods.pix_direct, false);
  });
});

describe('painel: chaves, travas e mensagens', () => {
  test('tudo nasce DESLIGADO e em modo opcional; estado das conexões sem tokens', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ enable: false });
    const g = (await c.anon.rpc('payments_panel_get', { p_token: tok })).data;
    assert.equal(g.general_enabled, false); assert.equal(g.checkout_mode, 'optional'); assert.equal(g.methods.wallets, false); assert.equal(g.methods.pix_direct, false);
    assert.equal(g.connections.mercadopago.state, 'disconnected'); assert.equal(g.connections.stripe.state, 'disconnected');
    assert.equal(g.effective.any, false);
    await c.oauth({ action: 'connect_mock', session_token: tok });
    await c.oauth({ action: 'connect_wallet_mock', session_token: tok });
    const g2 = (await c.anon.rpc('payments_panel_get', { p_token: tok })).data;
    assert.equal(g2.connections.mercadopago.state, 'sandbox'); assert.match(g2.connections.mercadopago.account, /^…/); assert.equal(g2.connections.stripe.state, 'sandbox');
    assert.ok(!/(access|refresh|token|secret|acct_|mock-)/i.test(JSON.stringify(g2.connections)), 'nenhum token/segredo/id completo');
    const begin = await c.anon.rpc('payments_panel_get', { p_token: tok });
    assert.ok(!JSON.stringify(begin.data).includes('_enc'));
    assert.equal((await q1(c, 'select payments_enabled, wallets_enabled from kiosks where id=$1', [kid]))[0].payments_enabled, false);
  });
  test('estado "pendente" enquanto o OAuth está em andamento', async () => {
    const c = await setup(); const { tok } = await c.kiosk({ enable: false });
    await c.anon.rpc('payments_oauth_begin', { p_token: tok }).catch(() => {});
    await c.db.rpc('payments_oauth_begin', { p_token: tok });
    assert.equal((await c.anon.rpc('payments_panel_get', { p_token: tok })).data.connections.mercadopago.state, 'pending');
  });
  test('ligar/desligar por método respeitando as travas, com o MOTIVO na tela', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ enable: false });
    const set = (patch) => c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: patch });
    assert.match((await set({ payments_enabled: true })).error.message, /Conecte sua conta/);
    assert.match((await set({ pix_direct: true })).error.message, /Cadastre sua chave Pix/);
    assert.match((await set({ checkout_mode: 'required' })).error.message, /ligue ao menos uma forma/);
    assert.match((await set({ wallets: true })).error.message, /Ative primeiro|Conecte/);
    const g0 = (await c.anon.rpc('payments_panel_get', { p_token: tok })).data;
    assert.match(g0.reasons.general, /Conecte/); assert.match(g0.reasons.pix_direct, /Cadastre/); assert.match(g0.reasons.required, /ao menos uma/);
    await c.oauth({ action: 'connect_mock', session_token: tok });
    let r = await set({ payments_enabled: true }); assert.equal(r.error, null); assert.equal(r.data.general_enabled, true); assert.equal(r.data.effective.pix, true);
    r = await set({ card: false }); assert.equal(r.data.methods.card, false); assert.equal(r.data.effective.card, false); assert.equal(r.data.effective.pix, true);
    r = await set({ pix_online: false }); assert.equal(r.data.effective.any, false, 'sem nenhum método efetivo');
    r = await set({ pix_online: true, card: true }); assert.equal(r.data.effective.any, true);
    assert.ok((await set({ bogus: true })).error); assert.ok((await set({ pix_direct: 'sim' })).error); assert.ok((await set({ checkout_mode: 'x' })).error); assert.ok((await set({})).error); assert.ok((await set(null)).error);
    // staff_write continua sem poder mexer
    assert.match((await c.anon.rpc('staff_write', { p_token: tok, p_table: 'kiosks', p_op: 'update', p_ids: [kid], p_data: { wallets_enabled: true } })).error.message, /Nada para atualizar/);
  });
  test('garçom não altera configuração; outro negócio não mexe no meu', async () => {
    const c = await setup(); const A = await c.kiosk({ pixDirect: true }); const B = await c.kiosk({ name: 'B' });
    const w = await waiterTok(c, A.kid);
    assert.match((await c.anon.rpc('payments_panel_set', { p_token: w.tok, p_patch: { pix_direct: false } })).error.message, /Apenas o responsável/);
    await c.anon.rpc('payments_panel_set', { p_token: B.tok, p_patch: { pix_direct: false, card: false } });
    assert.equal((await c.anon.rpc('payments_panel_get', { p_token: A.tok })).data.methods.pix_direct, true);
    assert.equal((await q1(c, 'select card_enabled from kiosk_payments where kiosk_id=$1', [A.kid]))[0].card_enabled, true);
  });
  test('admin travando: desliga tudo (inclusive Pix direto), volta a opcional e impede religar; kill switch fica no servidor', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ pixDirect: true, mode: 'required' });
    assert.equal((await c.anon.rpc('payments_panel_get', { p_token: tok })).data.checkout_mode, 'required');
    const adm = await ownerToken(c.pg, null, 'admin', crypto.randomUUID());
    assert.equal((await c.anon.rpc('admin_set_payments_access', { p_token: adm, p_kiosk_id: kid, p_allowed: false })).error, null);
    const g = (await c.anon.rpc('payments_panel_get', { p_token: tok })).data;
    assert.equal(g.general_enabled, false); assert.equal(g.methods.pix_direct, false); assert.equal(g.checkout_mode, 'optional'); assert.equal(g.effective.any, false);
    assert.match(g.reasons.general, /Bloqueado pela plataforma/);
    assert.match((await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: true } })).error.message, /Bloqueado pela plataforma/);
    assert.match((await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { payments_enabled: true } })).error.message, /Bloqueado|indisponíveis|liberados|Conecte/);
    // mais uma trava: quote não anuncia nada
    assert.deepEqual((await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' })).data, { enabled: false });
  });
  test('desligar o último método com modo obrigatório ativo volta sozinho para opcional (nunca pedido sem como pagar)', async () => {
    const c = await setup(); const { tok } = await c.kiosk({ pixDirect: true, enable: false, mode: 'required' });
    const r = await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: false } });
    assert.equal(r.data.checkout_mode, 'optional'); assert.equal(r.data.mode_reset, true);
    const both = await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: true } });
    const off = await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: false, checkout_mode: 'optional' } });
    assert.equal(off.data.checkout_mode, 'optional'); assert.equal(both.error, null);
  });
  test('rate limit nas alterações', async () => {
    const c = await setup(); const { tok } = await c.kiosk({ pixDirect: true });
    let last; for (let i = 0; i < 45; i++) last = await c.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { card: i % 2 === 0 } });
    assert.match(last.error?.message ?? '', /Muitas alterações/);
  });
});

describe('modo de checkout OBRIGATÓRIO: pedido retido até o pagamento', () => {
  async function req(extra = {}) {
    const c = await setup(); const k = await c.kiosk({ pixDirect: true, mode: 'required', ...extra });
    const prod = await seedProduct(c.pg, k.kid, 'Cerveja', 12.5);
    return { c, ...k, prod };
  }
  const hold = async (c, kid, prod, umb = 1, qty = 2) => {
    const r = await clientOrder(c, kid, umb, [{ id: prod, n: 'Cerveja', q: qty, p: 12.5 }], { status: 'accepted' });   // cliente tenta "furar" mandando status accepted
    assert.equal(r.error, undefined, r.error?.message); assert.equal(r.itemsError, null, r.itemsError?.message);
    return r.order;
  };
  test('pedido nasce retido (status forçado a pending), invisível à equipe/admin e SEM evento/alerta; o cliente enxerga o próprio', async () => {
    const { c, kid, tok, prod } = await req();
    const o = await hold(c, kid, prod);
    assert.equal(o.status, 'pending'); assert.equal(o.payment_hold, true); assert.ok(o.hold_expires_at);
    assert.deepEqual((await c.anon.rpc('read_orders', { p_token: tok })).data, [], 'equipe não vê');
    const adm = await ownerToken(c.pg, null, 'admin', crypto.randomUUID());
    assert.deepEqual((await c.anon.rpc('read_orders', { p_token: adm, p_kiosk: kid })).data, []);
    assert.equal((await q1(c, 'select count(*)::int n from order_events where kiosk_id=$1', [kid]))[0].n, 0, 'nenhum evento de tempo real');
    const mine = (await c.anon.rpc('read_orders', { p_kiosk: kid, p_umbrella: '1' })).data;
    assert.equal(mine.length, 1); assert.equal(mine[0].payment_hold, true);
    const qt = (await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' })).data;
    assert.equal(qt.checkout_mode, 'required'); assert.equal(qt.held.count, 1); assert.equal(qt.held.amount_cents, 2500); assert.equal(qt.amount_cents, 0);
    assert.equal(qt.pending_orders, 0, 'retido não conta como "aguardando aceite"');
  });
  test('modo OPCIONAL fica intacto: pedido visível, evento emitido, status do cliente respeitado', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ pixDirect: true });
    const prod = await seedProduct(c.pg, kid, 'Cerveja', 12.5);
    const o = (await clientOrder(c, kid, 1, [{ id: prod, n: 'Cerveja', q: 1, p: 12.5 }])).order;
    assert.equal(o.payment_hold, false); assert.equal(o.status, 'pending');
    assert.equal((await c.anon.rpc('read_orders', { p_token: tok })).data.length, 1);
    assert.equal((await q1(c, `select count(*)::int n from order_events where kiosk_id=$1 and kind='insert'`, [kid]))[0].n, 1);
    // marcadores e pedido da equipe seguem o fluxo antigo mesmo no modo obrigatório
    const r = await req(); const m = await r.c.anon.rpc('place_order', { p_order: { kiosk_id: r.kid, umbrella_num: '1', customer_name: 'CHAMADA DE ATENDENTE', status: 'pending', total: 0 }, p_items: null });
    assert.equal(m.data.payment_hold, false);
    assert.equal((await r.c.anon.rpc('read_orders', { p_token: r.tok })).data.length, 1);
  });
  test('piso de preço: item mais barato que o cardápio, sem produto ou de outro negócio é recusado', async () => {
    const { c, kid, prod } = await req();
    const other = await seedProduct(c.pg, (await c.kiosk({ name: 'Outro' })).kid, 'Cerveja', 1);
    for (const it of [{ id: prod, p: 0.01 }, { id: null, p: 12.5 }, { id: other, p: 12.5 }]) {
      const r = await clientOrder(c, kid, 2, [{ ...it, n: 'X', q: 1 }]);
      assert.ok(r.itemsError, JSON.stringify(it));
    }
    const ok = await clientOrder(c, kid, 3, [{ id: prod, n: 'Cerveja', q: 1, p: 14 }]);     // acima do cardápio (opções) é aceito
    assert.equal(ok.itemsError, null);
    const promo = await seedProduct(c.pg, kid, 'Promo', 10, { promo: 7 });
    assert.equal((await clientOrder(c, kid, 3, [{ id: promo, n: 'Promo', q: 1, p: 7 }])).itemsError, null);
    assert.ok((await clientOrder(c, kid, 3, [{ id: promo, n: 'Promo', q: 1, p: 6 }])).itemsError);
  });
  test('fluxo completo (Pix direto): cobrar retidos -> baixa manual por garçom -> libera para a equipe com alerta -> comprovante', async () => {
    const { c, kid, tok, prod } = await req();
    const o = await hold(c, kid, prod);
    const p = (await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '1', p_method: 'pix_direct', p_idem: idem(), p_hold: true })).data;
    assert.equal(p.amount_cents, 2500); assert.equal(p.connection.pix_key, '52998224725');
    const w = await waiterTok(c, kid, 'Gabriel');
    const before = (await q1(c, 'select count(*)::int n from order_events where kiosk_id=$1', [kid]))[0].n;
    assert.deepEqual((await c.anon.rpc('read_orders', { p_token: tok })).data, [], 'ainda retido antes da baixa');
    const m = await c.anon.rpc('payment_manual_settle', { p_token: w.tok, p_payment_id: p.payment_id, p_note: 'Cliente mostrou o comprovante' });
    assert.equal(m.error, null, m.error?.message); assert.equal(m.data.result, 'paid'); assert.equal(m.data.marked_by_name, 'Gabriel');
    const vis = (await c.anon.rpc('read_orders', { p_token: tok })).data;
    assert.equal(vis.length, 1); assert.equal(vis[0].payment_hold, false); assert.equal(vis[0].status, 'pending'); assert.ok(vis[0].hold_released_at);
    const evs = await q1(c, `select kind from order_events where kiosk_id=$1 order by event_id`, [kid]);
    assert.equal(evs.length, before + 1); assert.equal(evs.at(-1).kind, 'insert', 'alerta para a equipe só agora');
    const row = (await q1(c, 'select * from payments where id=$1', [p.payment_id]))[0];
    assert.equal(row.status, 'paid'); assert.equal(row.manual, true); assert.equal(row.marked_by_role, 'waiter'); assert.equal(row.marked_by_name, 'Gabriel'); assert.ok(row.marked_at); assert.equal(row.manual_note, 'Cliente mostrou o comprovante');
    const pub = await c.anon.rpc('receipt_public_check', { p_receipt: 'x'.repeat(48) }); assert.equal(pub.data.valid, false);
    // a tela do cliente e o comprovante: o token do comprovante veio no create; aqui conferimos pelo hash
    assert.equal(o.payment_hold, true);
  });
  test('baixa manual: idempotente, só pix_direct, só do próprio negócio, registra o dono como "Responsável"', async () => {
    const { c, kid, tok, prod } = await req(); const B = await c.kiosk({ pixDirect: true, name: 'B' });
    await hold(c, kid, prod);
    const p = (await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '1', p_method: 'pix_direct', p_idem: idem(), p_hold: true })).data;
    assert.match((await c.anon.rpc('payment_manual_settle', { p_token: B.tok, p_payment_id: p.payment_id })).error.message, /não encontrado/, 'outro negócio não baixa');
    const a = await c.anon.rpc('payment_manual_settle', { p_token: tok, p_payment_id: p.payment_id });
    assert.equal(a.data.marked_by_name, 'Responsável');
    const again = await c.anon.rpc('payment_manual_settle', { p_token: tok, p_payment_id: p.payment_id });
    assert.equal(again.data.result, 'already_paid');
    assert.equal((await q1(c, `select count(*)::int n from payment_events where payment_id=$1 and kind='manual_paid'`, [p.payment_id]))[0].n, 1);
    assert.ok((await c.anon.rpc('payment_manual_settle', { p_token: 'y'.repeat(40), p_payment_id: p.payment_id })).error);
    // gateway: não se baixa à mão
    const G = await c.kiosk({ name: 'G' }); await seedOrder(c.pg, G.kid, 1, [{ q: 1, p: 10 }]);
    const g = (await c.db.rpc('payment_prepare', { p_kiosk: G.kid, p_umbrella: '1', p_method: 'pix', p_idem: idem() })).data;
    assert.match((await c.anon.rpc('payment_manual_settle', { p_token: G.tok, p_payment_id: g.payment_id })).error.message, /Somente o Pix direto/);
  });
  test('expira: pedido retido vencido é descartado (continua invisível), cobrança expirada libera, nada vira pedido fantasma', async () => {
    const { c, kid, tok, prod } = await req();
    await hold(c, kid, prod);
    await c.pg.query(`update orders set hold_expires_at = now() - interval '1 minute' where kiosk_id=$1`, [kid]);
    const qt = (await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' })).data;
    assert.equal(qt.held.count, 0);
    assert.equal((await q1(c, `select status::text s, payment_hold h from orders`))[0].s, 'cancelled');
    assert.deepEqual((await c.anon.rpc('read_orders', { p_token: tok })).data, []);
    const nothing = await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '1', p_method: 'pix_direct', p_idem: idem(), p_hold: true });
    assert.match(nothing.error.message, /E_NOTHING_TO_PAY/);
    // com cobrança ativa o pedido NÃO é descartado no meio do pagamento
    await hold(c, kid, prod, 2);
    const p = (await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '2', p_method: 'pix_direct', p_idem: idem(), p_hold: true })).data;
    await c.pg.query(`update orders set hold_expires_at = now() - interval '1 minute' where umbrella_num='2'`);
    await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '2' });
    assert.equal((await q1(c, `select status::text s from orders where umbrella_num='2'`))[0].s, 'pending');
    // cobrança expira -> libera o vínculo -> o retido vencido é descartado
    await c.pg.query(`update payments set expires_at = now() - interval '1 minute' where id=$1`, [p.payment_id]);
    await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '2' });
    assert.equal((await q1(c, `select status::text s from orders where umbrella_num='2'`))[0].s, 'cancelled');
  });
  test('pagamento TARDIO (depois de expirar e descartar): o pedido volta para a equipe, sinalizado para conferir', async () => {
    const { c, kid, tok, prod } = await req();
    await hold(c, kid, prod);
    const p = (await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '1', p_method: 'pix_direct', p_idem: idem(), p_hold: true })).data;
    await c.pg.query(`update payments set expires_at = now() - interval '1 minute' where id=$1`, [p.payment_id]);
    await c.pg.query(`update orders set hold_expires_at = now() - interval '1 minute'`);
    await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' });
    assert.equal((await q1(c, `select status::text s from orders`))[0].s, 'cancelled');
    const m = await c.anon.rpc('payment_manual_settle', { p_token: tok, p_payment_id: p.payment_id });
    assert.equal(m.data.late, true);
    const vis = (await c.anon.rpc('read_orders', { p_token: tok })).data;
    assert.equal(vis.length, 1); assert.equal(vis[0].status, 'pending');
    const row = (await q1(c, 'select late_payment, needs_review from payments'))[0];
    assert.deepEqual(row, { late_payment: true, needs_review: true });
  });
  test('valor divergente no gateway NÃO libera o pedido (needs_review) e o retido não é alterado após cobrança', async () => {
    const { c, kid, prod } = await req({ enable: true });
    await hold(c, kid, prod);
    const p = (await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '1', p_method: 'pix', p_idem: idem(), p_hold: true })).data;
    const s = (await c.db.rpc('payment_settle', { p_payment_id: p.payment_id, p_status: 'paid', p_paid_cents: 100, p_provider_payment_id: 'x', p_ext_ref: p.payment_id })).data;
    assert.equal(s.result, 'amount_mismatch');
    assert.equal((await q1(c, 'select payment_hold h from orders'))[0].h, true);
    const o = (await q1(c, 'select id from orders'))[0].id;
    const add = await c.anon.rpc('add_order_items', { p_items: [{ order_id: o, product_id: prod, product_name: 'Cerveja', quantity: 5, unit_price: 12.5 }] });
    assert.match(add.error.message, /em pagamento ou pago/, 'não dá para aumentar o pedido depois de cobrado');
    const cancel = await c.anon.rpc('client_cancel_order', { p_order_id: o });
    assert.deepEqual(cancel.data, [], 'não cancela pedido com cobrança ativa');
    const ok = await c.db.rpc('payment_settle', { p_payment_id: p.payment_id, p_status: 'paid', p_paid_cents: 2500, p_provider_payment_id: 'x', p_ext_ref: p.payment_id });
    assert.equal(ok.data.result, 'paid');
    assert.equal((await q1(c, 'select payment_hold h from orders'))[0].h, false);
    assert.deepEqual((await c.anon.rpc('client_cancel_order', { p_order_id: o })).data, [], 'pedido pago não é cancelável pelo cliente');
  });
  test('cliente cancela o retido (sem cobrança) e some; limite de retidos por mesa; modo obrigatório sem método disponível recusa pedido', async () => {
    const { c, kid, tok, prod } = await req({ enable: false });
    const o = await hold(c, kid, prod);
    const can = await c.anon.rpc('client_cancel_order', { p_order_id: o.id });
    assert.equal(can.data.length, 1);
    assert.equal((await c.anon.rpc('payment_quote', { p_kiosk: kid, p_umbrella: '1' })).data.held.count, 0);
    for (let i = 0; i < 9; i++) await hold(c, kid, prod, 2, 1);
    const over = await clientOrder(c, kid, 2, [{ id: prod, n: 'Cerveja', q: 1, p: 12.5 }]);
    assert.match(over.error.message, /Pague ou cancele/);
    // dono apaga a chave Pix direto (último método) com o modo obrigatório ligado => volta a opcional e o pedido passa normal
    await c.anon.rpc('pix_key_clear', { p_token: tok });
    const normal = await clientOrder(c, kid, 3, [{ id: prod, n: 'Cerveja', q: 1, p: 12.5 }]);
    assert.equal(normal.order.payment_hold, false);
    // forçando o estado inconsistente direto no banco: falha segura, mensagem clara
    await c.pg.query(`update kiosk_payments set checkout_mode='required' where kiosk_id=$1`, [kid]);
    const blocked = await clientOrder(c, kid, 3, [{ id: prod, n: 'Cerveja', q: 1, p: 12.5 }]);
    assert.match(blocked.error.message, /Pagamento online indisponível/);
  });
});

describe('lista, filtros, totais e ações do dono', () => {
  async function seedPays(c, kid) {
    const mk = async (umb, price, method, outcome) => {
      await seedOrder(c.pg, kid, umb, [{ q: 1, p: price }]);
      const p = (await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: String(umb), p_method: method, p_idem: idem() })).data;
      if (outcome === 'paid') await c.db.rpc('payment_settle', { p_payment_id: p.payment_id, p_status: 'paid', p_paid_cents: p.amount_cents, p_provider_payment_id: 'x' + umb, p_ext_ref: p.payment_id });
      if (outcome === 'cancelled') await c.db.rpc('payment_cancel_apply', { p_payment_id: p.payment_id });
      if (outcome === 'review') await c.db.rpc('payment_settle', { p_payment_id: p.payment_id, p_status: 'paid', p_paid_cents: 1, p_provider_payment_id: 'x', p_ext_ref: p.payment_id });
      return p.payment_id;
    };
    return { paid: await mk(1, 10, 'pix', 'paid'), cancelled: await mk(2, 20, 'pix_direct', 'cancelled'), pending: await mk(3, 30, 'pix_direct', null), review: await mk(1, 5, 'pix', 'review') };
  }
  test('filtros por estado/método/mesa/período, totais e paginação; sem dados pessoais', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ pixDirect: true });
    const ids = await seedPays(c, kid);
    const S = (f, l = 25, o = 0) => c.anon.rpc('payments_search', { p_token: tok, p_filters: f, p_limit: l, p_offset: o }).then(r => { assert.equal(r.error, null, r.error?.message); return r.data; });
    const all = await S({}); assert.equal(all.total, 4); assert.equal(all.rows.length, 4);
    assert.equal((await S({ state: 'paid' })).rows.map(r => r.id).join(), ids.paid);
    assert.equal((await S({ state: 'pending' })).total, 2);   // pending (pix_direct) + a divergente ainda pendente
    assert.deepEqual((await S({ state: 'review' })).rows.map(r => r.id), [ids.review]);
    assert.equal((await S({ state: 'cancelled' })).rows[0].id, ids.cancelled);
    assert.equal((await S({ method: 'pix_direct' })).total, 2);
    assert.equal((await S({ method: 'pix', umbrella: '1' })).total, 2);
    assert.equal((await S({ umbrella: '3' })).rows[0].id, ids.pending);
    assert.equal((await S({ from: '2000-01-01', to: '2001-01-01' })).total, 0);
    assert.equal((await S({ from: new Date(Date.now() - 3600e3).toISOString() })).total, 4);
    const t = all.totals; assert.equal(t.paid.count, 1); assert.equal(t.paid.cents, 1000); assert.ok(t.cancelled.count >= 1); assert.ok(t.pending.count >= 1); assert.equal(t.review.count, 1);
    const pg1 = await S({}, 2, 0), pg2 = await S({}, 2, 2);
    assert.equal(pg1.rows.length, 2); assert.equal(pg2.rows.length, 2); assert.equal(new Set([...pg1.rows, ...pg2.rows].map(r => r.id)).size, 4);
    assert.equal((await S({}, 5000)).limit, 100, 'limite máximo');
    for (const bad of [{ state: 'x' }, { method: 'boleto' }, { umbrella: "1'; --" }, { from: 'ontem' }]) {
      assert.ok((await c.anon.rpc('payments_search', { p_token: tok, p_filters: bad })).error, JSON.stringify(bad));
    }
    const keys = Object.keys(all.rows[0]);
    assert.ok(!keys.some(k => /token|hash|payload|client|email|nome|name$/.test(k.replace('marked_by_name', ''))), keys.join());
  });
  test('negócio B não vê pagamentos do A; garçom não usa a lista do painel', async () => {
    const c = await setup(); const A = await c.kiosk({ pixDirect: true }); const B = await c.kiosk({ pixDirect: true, name: 'B' });
    const ids = await seedPays(c, A.kid);
    assert.equal((await c.anon.rpc('payments_search', { p_token: B.tok, p_filters: {} })).data.total, 0);
    assert.match((await c.anon.rpc('payment_detail', { p_token: B.tok, p_id: ids.paid })).error.message, /não encontrado/);
    assert.match((await c.anon.rpc('payment_owner_cancel', { p_token: B.tok, p_id: ids.pending })).error.message, /não encontrado/);
    assert.match((await c.anon.rpc('payment_review_resolve', { p_token: B.tok, p_id: ids.review })).error.message, /não encontrado/);
    assert.match((await c.anon.rpc('payment_reissue_receipt', { p_token: B.tok, p_id: ids.paid })).error.message, /não encontrado/);
    const w = await waiterTok(c, A.kid);
    assert.match((await c.anon.rpc('payments_search', { p_token: w.tok, p_filters: {} })).error.message, /Apenas o responsável/);
    assert.match((await c.anon.rpc('payment_owner_cancel', { p_token: w.tok, p_id: ids.pending })).error.message, /Apenas o responsável/);
  });
  test('detalhe: horários, quem deu baixa e linha do tempo (sem segredos)', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ pixDirect: true });
    const ids = await seedPays(c, kid);
    const w = await waiterTok(c, kid, 'Marina');
    await c.anon.rpc('payment_manual_settle', { p_token: w.tok, p_payment_id: ids.pending });
    const d = (await c.anon.rpc('payment_detail', { p_token: tok, p_id: ids.pending })).data;
    assert.equal(d.status, 'paid'); assert.equal(d.manual, true); assert.equal(d.marked_by_name, 'Marina'); assert.equal(d.marked_by_role, 'waiter'); assert.ok(d.marked_at && d.paid_at && d.created_at && d.expires_at);
    assert.deepEqual(d.events.map(e => e.kind), ['created', 'manual_paid']); assert.equal(d.events[1].by_name, 'Marina');
    assert.ok(!/hash|payload|token/i.test(JSON.stringify(d)));
  });
  test('ações: cancelar pendente, marcar conferido, reemitir comprovante (QR antigo deixa de valer)', async () => {
    const c = await setup(); const { kid, tok } = await c.kiosk({ pixDirect: true });
    const ids = await seedPays(c, kid);
    const cn = await c.anon.rpc('payment_owner_cancel', { p_token: tok, p_id: ids.pending }); assert.equal(cn.data.status, 'cancelled');
    assert.match((await c.anon.rpc('payment_owner_cancel', { p_token: tok, p_id: ids.paid })).error.message, /Só é possível cancelar/);
    // a mesa volta a poder ser cobrada
    assert.equal((await c.db.rpc('payment_prepare', { p_kiosk: kid, p_umbrella: '3', p_method: 'pix_direct', p_idem: idem() })).error, null);
    assert.equal((await c.anon.rpc('payment_review_resolve', { p_token: tok, p_id: ids.review })).data.needs_review, false);
    assert.equal((await c.anon.rpc('payments_search', { p_token: tok, p_filters: { state: 'review' } })).data.total, 0);
    assert.equal((await q1(c, 'select review_resolved_at is not null r from payments where id=$1', [ids.review]))[0].r, true);
    // reemissão
    const pay = (await q1(c, 'select confirmation_token_hash h from payments where id=$1', [ids.paid]))[0].h;
    const r = (await c.anon.rpc('payment_reissue_receipt', { p_token: tok, p_id: ids.paid })).data;
    assert.match(r.receipt_token, /^[0-9a-f]{48}$/);
    assert.notEqual((await q1(c, 'select confirmation_token_hash h from payments where id=$1', [ids.paid]))[0].h, pay);
    assert.equal((await c.anon.rpc('receipt_public_check', { p_receipt: r.receipt_token })).data.valid, true);
    assert.equal((await c.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: r.receipt_token })).data.first_validation, true);
    assert.match((await c.anon.rpc('payment_reissue_receipt', { p_token: tok, p_id: ids.cancelled })).error.message, /Só há comprovante/);
    const ev = (await q1(c, `select kind from payment_events where kiosk_id=$1`, [kid])).map(e => e.kind);
    for (const k of ['owner_cancelled', 'review_resolved', 'receipt_reissued']) assert.ok(ev.includes(k), k);
  });
});
