// E2E no navegador (Chromium/Playwright) contra o index.html REAL, com um "Supabase de mentira" que roda em PGlite
// (migrações reais + RLS/grants reais + Edge Functions reais com o provedor MOCK). Nenhum dinheiro, nenhuma credencial.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { setup, idem, seedOrder } from './helpers.mjs';
import { signMockWebhook } from '../../supabase/functions/_shared/mock.ts';
import { handlePaymentWebhook } from '../../supabase/functions/_shared/handlers.ts';
import { MOCK_SECRET, ORIGIN } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const SB_HOST = 'ifhfacpeskslhumctgpr.supabase.co';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let ctx, server, base, browser;
const seen = [];     // requisições feitas pelo navegador (para provar "flag desligada = nenhuma requisição de pagamento")

function startStatic() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
      const f = path.join(repo, p);
      if (!f.startsWith(repo) || f.includes('/.git/') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); return rsp.end('nf'); }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res(s));
  });
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*', 'access-control-allow-methods': '*' };
async function sbRoute(route) {
  const req = route.request(), url = new URL(req.url());
  const method = req.method();
  seen.push(method + ' ' + url.pathname);
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  try {
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop();
      const args = JSON.parse(req.postData() || '{}');
      const keys = Object.keys(args);
      const vals = keys.map(k => { const v = args[k]; if (Array.isArray(v) && k === 'p_ids') return '{' + v.join(',') + '}'; return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; });
      const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      await ctx.pg.exec('set role anon');
      try {
        const r = await ctx.pg.query(`select to_jsonb(public.${fn}(${named})) as r`, vals);
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(r.rows[0].r) });
      } catch (e) {
        return route.fulfill({ status: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ message: e.message, code: e.code || 'P0001' }) });
      } finally { await ctx.pg.exec('reset role'); }
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.split('/').pop();
      if (!['kiosks', 'products', 'categories', 'umbrellas', 'order_events'].includes(table)) return route.fulfill({ status: 404, headers: CORS, body: '{}' });
      const wh = [], vals = [];
      let order = '', limit = '';
      for (const [k, v] of url.searchParams) {
        if (k === 'select') continue;
        if (k === 'order') { const [c, d] = v.split('.'); if (/^\w+$/.test(c)) order = ` order by "${c}" ${d === 'desc' ? 'desc' : 'asc'}`; continue; }
        if (k === 'limit') { limit = ` limit ${parseInt(v, 10) || 1}`; continue; }
        const m = /^eq\.(.*)$/.exec(v);
        if (m && /^\w+$/.test(k)) { vals.push(m[1]); wh.push(`"${k}"::text = $${vals.length}`); }
      }
      await ctx.pg.exec('set role anon');
      try {
        const r = await ctx.pg.query(`select * from public.${table}${wh.length ? ' where ' + wh.join(' and ') : ''}${order}${limit}`, vals);
        const single = /pgrst\.object/.test(req.headers()['accept'] || '');
        if (single) {
          if (r.rows.length !== 1) return route.fulfill({ status: 406, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'PGRST116', message: 'no rows' }) });
          return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(r.rows[0]) });
        }
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(r.rows) });
      } finally { await ctx.pg.exec('reset role'); }
    }
    if (url.pathname.startsWith('/functions/v1/')) {
      const name = url.pathname.split('/').pop();
      const h = { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '10.1.1.' + (seen.length % 200) };
      const rq = new Request('https://fn.invalid/' + name, { method, headers: h, body: method === 'POST' ? req.postData() : undefined });
      const { handleCreatePayment, handlePaymentStatus, handleOAuth, handleWalletConfig } = await import('../../supabase/functions/_shared/handlers.ts');
      const handler = { 'create-payment': handleCreatePayment, 'payment-status': handlePaymentStatus, 'payments-oauth': handleOAuth, 'wallet-config': handleWalletConfig }[name];
      const out = await handler(rq, ctx.deps);
      return route.fulfill({ status: out.status, headers: { ...CORS, 'content-type': 'application/json' }, body: await out.text() });
    }
  } catch (e) {
    return route.fulfill({ status: 500, headers: CORS, body: JSON.stringify({ message: String(e) }) });
  }
  return route.fulfill({ status: 404, headers: CORS, body: '{}' });
}

// stripe.js FALSO: imita só a superfície usada por wallet.js (Stripe(), elements(), expressCheckout, confirmPayment).
// confirmPayment avisa o "servidor" (rota local) que simula: Stripe captura o pagamento e envia o webhook assinado.
const FAKE_STRIPE_JS = `(function(){
  window.__stripe = { inits: [], elementsOpts: null, ecOpts: null, confirm: null };
  window.Stripe = function(pk, opts){ window.__stripe.inits.push({ pk: pk, opts: opts });
    return {
      elements: function(o){ window.__stripe.elementsOpts = o; var h = {};
        return { submit: function(){ return Promise.resolve({}); },
          create: function(type, co){ window.__stripe.ecOpts = { type: type, co: co };
            return { on: function(ev, cb){ h[ev] = cb; }, destroy: function(){},
              mount: function(el){ el.innerHTML = '<button id="fake-wallet-btn" type="button">Google Pay</button>';
                document.getElementById('fake-wallet-btn').onclick = function(){ h.confirm({}); };
                setTimeout(function(){ h.ready({ availablePaymentMethods: window.__fakeAvail || null }); }, 0); } }; } }; },
      confirmPayment: function(a){ window.__stripe.confirm = { secret: a.clientSecret, redirect: a.redirect };
        if (window.__fakeDecline) return Promise.resolve({ error: { message: 'Cartão recusado (simulado)' } });
        return fetch('/__fake_stripe_capture', { method: 'POST', body: a.clientSecret }).then(function(){ return {}; }); } }; };
})();`;

async function newPage({ ua = null, avail = null, decline = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 }, permissions: [], ...(ua ? { userAgent: ua } : {}) });
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname === 'js.stripe.com' && u.pathname === '/v3/') { seen.push('STRIPEJS'); return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_STRIPE_JS }); }
    if (u.hostname === '127.0.0.1' && u.pathname === '/__fake_stripe_capture') {
      const id = (route.request().postData() || '').split('_secret_')[0];
      ctx.stripe.pay(id);
      const r = await ctx.stripeWebhook('payment_intent.succeeded', ctx.stripe.pis.get(id));
      return route.fulfill({ status: r.status, body: '{}' });
    }
    if (u.hostname === SB_HOST) return sbRoute(route);
    if (u.hostname === '127.0.0.1') { seen.push('static ' + u.pathname); return route.continue(); }
    return route.abort();                  // nada de internet (fontes, CDN, pixel)
  });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  await page.addInitScript(({ avail, decline }) => { window.__fakeAvail = avail; window.__fakeDecline = decline; }, { avail, decline });
  await page.addInitScript(() => { try { localStorage.setItem('rcb_px', '0'); localStorage.setItem('recebaa-terms-accepted', '1'); } catch (e) {} });
  return page;
}
const FN_CALLS = () => seen.filter(s => s.includes('/functions/v1/'));

before(async () => { 
  ctx = await setup();
  server = await startStatic();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function openTable(page, kid, umb, extra = '') {
  await page.goto(`${base}/?kiosk=${kid}&umbrella=${umb}${extra}`);
  await page.waitForSelector('#client-menu:not(.hidden)', { timeout: 15000 });
}
async function openOrdersTab(page) {
  await page.evaluate(() => document.getElementById('tab-orders').click());
  await page.waitForFunction(() => document.querySelector('#my-orders-list .my-order-card'), null, { timeout: 15000 });
}

describe('QR por mesa', () => {
  test('?kiosk=&umbrella= abre direto o cardápio da mesa; link antigo (?kiosk=) continua pedindo o número', async () => {
    const { kid } = await ctx.kiosk({ enable: false, invite: false, name: 'Quiosque QR' });
    const page = await newPage();
    await openTable(page, kid, 2);
    assert.match(await page.textContent('#umbrella-label'), /2/);
    // retrocompatibilidade: QR antigo só com o negócio
    const old = await newPage();
    await old.goto(`${base}/?kiosk=${kid}`);
    await old.waitForSelector('#umbrella-input', { state: 'visible', timeout: 15000 });
    assert.ok(await old.isVisible('#client-splash'), 'splash com campo do número continua aparecendo');
    assert.equal(await old.isVisible('#client-menu'), false);
    // alias ?mesa=
    const alias = await newPage();
    await alias.goto(`${base}/?kiosk=${kid}&mesa=3`);
    await alias.waitForSelector('#client-menu:not(.hidden)', { timeout: 15000 });
    assert.match(await alias.textContent('#umbrella-label'), /3/);
    // mesa inexistente: não entra
    const bad = await newPage();
    await bad.goto(`${base}/?kiosk=${kid}&umbrella=99`);
    await bad.waitForTimeout(2500);
    assert.equal(await bad.isVisible('#client-menu'), false);
  });

  test('tela de impressão: um QR DIFERENTE por mesa, legível (decodifica) e com o número visível', async () => {
    const { kid } = await ctx.kiosk({ enable: false, invite: false, name: 'Quiosque Impressão' });
    const page = await newPage();
    await page.goto(`${base}/`);
    const umbs = [1, 2, 3, 10].map(n => ({ id: 'u' + n, number: n, is_active: true })).concat([{ id: 'x', number: 7, is_active: false }]);
    await page.evaluate(({ umbs, kid }) => Promise.all([window.RecebaaPay.loadQr(), window.RecebaaPay.load('/mesa-qr.js')]).then(() => window.RecebaaPay.mesaQr.openPrint(umbs, { id: kid, name: 'Quiosque <b>Impressão</b>', business_type: 'quiosque' })), { umbs, kid });
    await page.waitForSelector('#rpay-sheet .rpay-qr-card');
    const cards = await page.$$eval('#rpay-sheet .rpay-qr-card', els => els.map(e => ({ n: e.querySelector('.n').textContent, url: e.querySelector('.u').textContent, svg: e.querySelector('svg path').getAttribute('d'), k: e.querySelector('.k').innerHTML })));
    assert.equal(cards.length, 4, 'mesa inativa não é impressa');
    assert.deepEqual(cards.map(c => c.n), ['Guarda-sol 01', 'Guarda-sol 02', 'Guarda-sol 03', 'Guarda-sol 10']);
    assert.equal(new Set(cards.map(c => c.svg)).size, 4, 'cada QR é diferente');
    assert.equal(new Set(cards.map(c => c.url)).size, 4);
    for (const c of cards) assert.ok(c.url.includes(`kiosk=${kid}&umbrella=`));
    assert.ok(!cards[0].k.includes('<b>'), 'nome do negócio escapado (XSS)');
    // decodifica de verdade cada QR (rasteriza o SVG no navegador e lê com jsQR)
    const pixels = await page.evaluate(async () => {
      const out = [];
      for (const svg of document.querySelectorAll('#rpay-sheet .rpay-qr-card svg')) {
        const xml = new XMLSerializer().serializeToString(svg);
        const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
        await img.decode();
        const cv = document.createElement('canvas'); cv.width = 440; cv.height = 440;
        const c = cv.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(img, 0, 0, 440, 440);
        out.push({ w: 440, h: 440, data: Array.from(c.getImageData(0, 0, 440, 440).data) });
      }
      return out;
    });
    pixels.forEach((p, i) => {
      const r = jsQR(Uint8ClampedArray.from(p.data), p.w, p.h);
      assert.ok(r, 'QR ' + i + ' decodificou');
      assert.equal(r.data, cards[i].url);
    });
    // filtro por faixa
    await page.fill('#rpay-range', '2-3'); await page.click('[data-a=apply]');
    assert.equal((await page.$$('#rpay-sheet .rpay-qr-card')).length, 2);
  });
});

describe('flag DESLIGADA (padrão): nenhuma UI nova de pagamento e nenhuma regressão', () => {
  test('cliente: sem botão, sem payments.js, sem chamadas de pagamento; fluxo atual (pedir a conta) intacto', async () => {
    const { kid } = await ctx.kiosk({ enable: false, invite: false, name: 'Quiosque Off' });
    await seedOrder(ctx.pg, kid, 1, [{ q: 2, p: 12.5, n: 'Cerveja' }]);
    seen.length = 0;
    const page = await newPage();
    await openTable(page, kid, 1);
    await openOrdersTab(page);
    await page.waitForTimeout(1500);
    assert.equal(await page.$('[id^=rpay-]'), null, 'nenhum elemento de pagamento');
    assert.equal(await page.$('#rpay-bar'), null);
    assert.ok(await page.$('#my-orders-list button[onclick*=openBillModal]'), 'botão "Pedir a conta" continua lá');
    assert.ok(!seen.some(s => /payments\.js|payments-staff|mesa-qr/.test(s)), 'não carregou scripts de pagamento: ' + seen.filter(s => /payments|mesa/.test(s)));
    assert.ok(seen.some(s => s.includes('payments-boot.js')));
    assert.equal(FN_CALLS().length, 0, 'nenhuma Edge Function chamada');
    assert.ok(!seen.some(s => /payment_quote|payment_status/.test(s)), 'nenhum RPC de pagamento');
    assert.deepEqual(page.errors, []);
  });

  test('negócio com a flag LIGADA no banco mas "liberação" revogada pelo admin: servidor recusa e UI some', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque Revogado' });
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 30 }]);
    await ctx.pg.query('update kiosk_payments set platform_blocked = true, invited = false where kiosk_id = $1', [kid]);
    await ctx.pg.query('update kiosks set payments_enabled = true where id = $1', [kid]);      // flag "esquecida" ligada
    const page = await newPage();
    await openTable(page, kid, 1);
    await openOrdersTab(page);
    await page.waitForTimeout(1500);
    assert.equal(await page.$('#rpay-bar'), null, 'payment_quote devolve enabled:false');
  });

  test('staff: negócio não liberado não vê o painel de pagamentos (mas vê o QR por mesa)', async () => {
    const { kid, tok } = await ctx.kiosk({ enable: false, invite: false, name: 'Quiosque Staff Off' });
    const page = await newPage();
    await page.goto(`${base}/`);
    await page.evaluate(({ kid, tok }) => {
      window._sessToken = tok; const g = document.createElement('div'); g.id = 'umb-grid'; g.innerHTML = '<div id="first"></div>'; document.body.appendChild(g);
      window.RecebaaPay.afterUmbrellas(g, [{ id: 'a', number: 1, is_active: true }], { id: kid, name: 'X', business_type: 'quiosque' });
    }, { kid, tok });
    await page.waitForSelector('#rpay-mesaqr-card');
    await page.waitForTimeout(800);
    assert.equal(await page.$('#rpay-staff-card'), null);
  });
});

describe('flag LIGADA: Pix completo (criar -> pagar -> webhook -> comprovante QR -> validação)', () => {
  test('fluxo ponta a ponta', async () => {
    const { kid, tok } = await ctx.kiosk({ name: 'Quiosque do Mar' });
    await seedOrder(ctx.pg, kid, 1, [{ q: 2, p: 12.5, n: 'Cerveja' }, { q: 1, p: 7.5, n: 'Porção' }]);      // R$ 32,50
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 99 }], { status: 'pending' });                                // não aceito: fora da conta
    seen.length = 0;
    const page = await newPage();
    await openTable(page, kid, 1);
    await openOrdersTab(page);
    await page.waitForSelector('#rpay-bar [data-a=open]', { timeout: 15000 });
    assert.match(await page.textContent('#rpay-bar'), /R\$ 32,50/);
    assert.match(await page.textContent('#rpay-bar'), /1 pedido\(s\) aguardando aceite/);

    await page.click('#rpay-bar [data-a=open]');
    await page.waitForSelector('#rpay-modal [data-a=pix]');
    assert.match(await page.textContent('#rpay-modal'), /Total\s*R\$ 32,50/);
    await page.click('#rpay-modal [data-a=pix]');
    await page.waitForSelector('#rpay-code', { timeout: 15000 });
    const code = await page.inputValue('#rpay-code');
    assert.match(code, /^000201MOCKPIX3250mock_/);
    assert.ok(await page.$('#rpay-modal .qr svg'), 'QR do Pix gerado localmente (SVG)');
    assert.ok(!seen.some(s => s.includes('qrserver')), 'nenhum serviço externo de QR');

    // o provedor aprova e envia o webhook assinado
    const pid = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('rpay:v1:p:'))[0].slice(10));
    ctx.ledger.approve('mock_' + pid);
    const w = await signMockWebhook(MOCK_SECRET, 'mock_' + pid);
    const wr = await handlePaymentWebhook(new Request(`https://fn.invalid/payment-webhook?pid=${pid}`, { method: 'POST', headers: { 'x-mock-signature': w.signature }, body: w.body }), ctx.deps);
    assert.equal(wr.status, 200);

    // a tela detecta (polling) e mostra o comprovante em QR
    await page.waitForSelector('#rpay-modal .ok', { timeout: 15000 });
    assert.match(await page.textContent('#rpay-modal'), /Pagamento confirmado/);
    assert.match(await page.textContent('#rpay-modal'), /R\$ 32,50/);
    const rt = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).filter(k => k.startsWith('rpay:v1:p:'))[0])).rt);
    // o QR contém só o link com token opaco — sem nome, sem valor, sem mesa
    const px = await page.evaluate(async () => {
      const svg = document.querySelector('#rpay-modal .qr svg'); const xml = new XMLSerializer().serializeToString(svg);
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
      const cv = document.createElement('canvas'); cv.width = 460; cv.height = 460; const c = cv.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(img, 0, 0, 460, 460);
      return Array.from(c.getImageData(0, 0, 460, 460).data);
    });
    const dec = jsQR(Uint8ClampedArray.from(px), 460, 460);
    assert.equal(dec.data, `${base}/#comprovante=${rt}`);
    assert.match(rt, /^[0-9a-f]{48}$/);
    assert.ok(!/Quiosque|Maria|32|mesa/i.test(dec.data.replace(base, '').replace(rt, '')));      // o token hex aleatório pode conter "32" por acaso: testa só o restante do link;

    // quem escaneia (sem login) vê a verificação pública; token inválido não valida
    const scanner = await newPage();
    await scanner.goto(`${base}/#comprovante=${rt}`);
    await scanner.waitForSelector('#rpay-receipt .card.good', { timeout: 15000 });
    assert.match(await scanner.textContent('#rpay-receipt'), /Pagamento confirmado[\s\S]*R\$ 32,50/);
    assert.equal(new URL(scanner.url()).hash, '', 'token some da barra de endereço');
    const fake = await newPage();
    await fake.goto(`${base}/#comprovante=${'ab'.repeat(24)}`);
    await fake.waitForSelector('#rpay-receipt .card.bad', { timeout: 15000 });
    assert.match(await fake.textContent('#rpay-receipt'), /inválido/);

    // a equipe valida pelo painel: 1ª vez = baixa, 2ª = "já utilizado"
    const staff = await newPage();
    await staff.goto(`${base}/`);
    await staff.evaluate(({ kid, tok }) => {
      window._sessToken = tok; const g = document.createElement('div'); g.id = 'umb-grid'; g.innerHTML = '<div id="first"></div>'; document.body.appendChild(g);
      window.RecebaaPay.afterUmbrellas(g, [{ id: 'a', number: 1, is_active: true }], { id: kid, name: 'Quiosque do Mar', business_type: 'quiosque' });
    }, { kid, tok });
    await staff.waitForSelector('#rpay-staff-card [data-a=validate]', { timeout: 15000 });
    await staff.click('#rpay-staff-card [data-a=validate]');
    await staff.fill('#rpay-in', `https://recebaa.com.br/#comprovante=${rt}`);
    await staff.click('#rpay-smodal [data-a=check]');
    await staff.waitForSelector('#rpay-res .res.good');
    assert.match(await staff.textContent('#rpay-res'), /baixa registrada[\s\S]*R\$ 32,50/);
    await staff.click('#rpay-smodal [data-a=check]');
    await staff.waitForSelector('#rpay-res .res.warn');
    assert.match(await staff.textContent('#rpay-res'), /JÁ UTILIZADO/);
    await staff.fill('#rpay-in', 'a'.repeat(48)); await staff.click('#rpay-smodal [data-a=check]');
    await staff.waitForSelector('#rpay-res .res.bad');
    assert.deepEqual(page.errors.concat(staff.errors, scanner.errors), []);

    // depois de pago, a conta fica zerada e o cliente vê "Conta paga"
    await page.evaluate(() => document.querySelector('#rpay-modal [data-a=close]').click());
    await page.waitForSelector('#rpay-bar [data-a=receipt]', { timeout: 15000 });
    assert.match(await page.textContent('#rpay-bar'), /Conta paga/);
  });

  test('valor adulterado no navegador (chamando a função direto) é ignorado', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque Adulterado' });
    await seedOrder(ctx.pg, kid, 3, [{ q: 1, p: 50 }]);
    const page = await newPage();
    await page.goto(`${base}/`);
    const r = await page.evaluate(async ({ kid, key }) => {
      const res = await fetch('https://ifhfacpeskslhumctgpr.supabase.co/functions/v1/create-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kiosk_id: kid, umbrella: 3, method: 'pix', idempotency_key: key, amount: 0.01, amount_cents: 1, total: 0.01 }) });
      return res.json();
    }, { kid, key: idem() });
    assert.equal(r.payment.amount_cents, 5000);
  });

  test('cartão: checkout hospedado (redireciona; nada de campos de cartão na página)', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque Cartão', servicePct: 10 });
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 100 }]);
    const page = await newPage();
    await openTable(page, kid, 1);
    await openOrdersTab(page);
    await page.waitForSelector('#rpay-bar [data-a=open]', { timeout: 15000 });
    await page.click('#rpay-bar [data-a=open]');
    assert.match(await page.textContent('#rpay-modal'), /Serviço \(10%\)[\s\S]*R\$ 10,00[\s\S]*R\$ 110,00/);
    assert.equal(await page.$('#rpay-modal input'), null, 'a página nunca pede número de cartão');
    await page.click('#rpay-modal [data-a=card]');
    await page.waitForFunction(() => document.querySelector('#rpay-modal') && /pagamento seguro/i.test(document.querySelector('#rpay-modal').textContent), null, { timeout: 15000 });
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('rpay:v1:p:')).length);
    assert.equal(stored, 1, 'tokens guardados antes de sair para o checkout');
  });

  test('dono liga pelo painel: conectar (sandbox) -> ligar -> flag no banco; desligar volta ao padrão', async () => {
    const { kid, tok } = await ctx.kiosk({ enable: false, name: 'Quiosque Painel' });
    const page = await newPage();
    await page.goto(`${base}/`);
    const mount = () => page.evaluate(({ kid, tok }) => {
      document.getElementById('umb-grid')?.remove();
      window._sessToken = tok; const g = document.createElement('div'); g.id = 'umb-grid'; g.innerHTML = '<div id="first"></div>'; document.body.appendChild(g);
      window.RecebaaPay.invalidateStaffStatus && window.RecebaaPay.invalidateStaffStatus();
      window.RecebaaPay.afterUmbrellas(g, [{ id: 'a', number: 1, is_active: true }], { id: kid, name: 'Painel', business_type: 'quiosque' });
    }, { kid, tok });
    await mount();
    await page.waitForSelector('#rpay-staff-card [data-a=connect]', { timeout: 15000 });
    await page.click('[data-a=connect]');
    await page.waitForSelector('#rpay-staff-card [data-a=toggle]', { timeout: 15000 });
    assert.match(await page.textContent('#rpay-staff-card'), /Conectado \(TESTE\)/);
    assert.equal((await ctx.pg.query('select payments_enabled from kiosks where id=$1', [kid])).rows[0].payments_enabled, false);
    await page.click('[data-a=toggle]');
    await page.waitForFunction(() => /ATIVO para os clientes/.test(document.querySelector('#rpay-staff-card')?.textContent || ''), null, { timeout: 15000 });
    assert.equal((await ctx.pg.query('select payments_enabled from kiosks where id=$1', [kid])).rows[0].payments_enabled, true);
    await page.click('[data-a=toggle]');
    await page.waitForFunction(() => /Desligado/.test(document.querySelector('#rpay-staff-card')?.textContent || ''), null, { timeout: 15000 });
    assert.equal((await ctx.pg.query('select payments_enabled from kiosks where id=$1', [kid])).rows[0].payments_enabled, false);
    assert.deepEqual(page.errors, []);
  });
});

describe('carteiras (Apple Pay / Google Pay via Stripe): E2E com stripe.js falso e webhook assinado', () => {
  const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
  const stripeSeen = () => seen.filter(x => x === 'STRIPEJS' || /wallet\.js|wallet-config/.test(x));

  test('flag das carteiras DESLIGADA (Pix/cartão ligados): sem wallet.js, sem stripe.js, sem wallet-config e sem UI nova', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque Sem Carteira' });
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 20 }]);
    seen.length = 0;
    const page = await newPage({ ua: CHROME, avail: { googlePay: true } });
    await openTable(page, kid, 1); await openOrdersTab(page); 
    await page.click('#rpay-bar [data-a=open]'); await page.waitForSelector('#rpay-modal [data-a=pix]'); 
    await page.waitForTimeout(1200);
    assert.deepEqual(stripeSeen(), [], 'nada de Stripe: ' + stripeSeen());
    assert.equal(await page.$('#rpay-wallet') === null, true);
    assert.ok(await page.$('#rpay-modal [data-a=pix]') && await page.$('#rpay-modal [data-a=card]'), 'Pix e cartão intactos');
    assert.deepEqual(page.errors, []);
  });

  test('navegador SEM carteira provável (Firefox): stripe.js nem é baixado e não há botão', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque FF', wallets: true });
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 20 }]);
    seen.length = 0;
    const page = await newPage({ ua: FIREFOX, avail: { googlePay: true } });
    await openTable(page, kid, 1); await openOrdersTab(page); 
    await page.click('#rpay-bar [data-a=open]'); await page.waitForSelector('#rpay-modal [data-a=pix]'); 
    await page.waitForTimeout(1200);
    assert.ok(!seen.includes('STRIPEJS'), 'stripe.js não deve ser requisitado');
    assert.ok(!seen.some(x => /wallet-config/.test(x)));
    assert.equal(await page.isVisible('#rpay-wallet'), false);
  });

  test('stripe.js carregado mas a carteira NÃO está disponível: o botão não aparece', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque Sem Wallet', wallets: true });
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 20 }]);
    seen.length = 0;
    const page = await newPage({ ua: CHROME, avail: null });
    await openTable(page, kid, 1); await openOrdersTab(page);
    await page.click('#rpay-bar [data-a=open]'); await page.waitForSelector('#rpay-modal [data-a=pix]');
    await page.waitForFunction(() => window.__stripe && window.__stripe.inits.length === 1, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    assert.equal(await page.isVisible('#rpay-wallet'), false, 'contêiner escondido');
    assert.equal(await page.isVisible('#fake-wallet-btn'), false);
  });

  test('fluxo completo: botão aparece, paga, webhook assinado, comprovante em QR, validação pela equipe', async () => {
    const { kid, tok } = await ctx.kiosk({ name: 'Quiosque Carteira', wallets: true });
    await seedOrder(ctx.pg, kid, 1, [{ q: 2, p: 12.5, n: 'Cerveja' }, { q: 1, p: 7.5, n: 'Porção' }]);      // R$ 32,50
    seen.length = 0;
    const page = await newPage({ ua: CHROME, avail: { googlePay: true, applePay: false } });
    await openTable(page, kid, 1); await openOrdersTab(page);
    await page.click('#rpay-bar [data-a=open]');
    await page.waitForSelector('#rpay-wallet:not([hidden]) #fake-wallet-btn', { timeout: 15000 });
    assert.ok(seen.includes('STRIPEJS'));
    const init = await page.evaluate(() => window.__stripe);
    assert.equal(init.inits[0].pk, 'pk_test_FAKE_not_a_real_key');
    assert.match(init.inits[0].opts.stripeAccount, /^acct_/, 'direct charge: conta conectada');
    assert.deepEqual(init.elementsOpts, { mode: 'payment', amount: 3250, currency: 'brl' });
    assert.equal(init.ecOpts.co.paymentMethods.link, 'never');
    await page.click('#fake-wallet-btn');
    await page.waitForSelector('#rpay-modal .ok', { timeout: 20000 });
    assert.match(await page.textContent('#rpay-modal'), /Pagamento confirmado[\s\S]*R\$ 32,50/);
    const conf = await page.evaluate(() => window.__stripe.confirm);
    assert.equal(conf.redirect, 'if_required');
    const pi = [...ctx.stripe.pis.values()].at(-1);
    assert.equal(pi.amount, 3250); assert.ok(conf.secret.startsWith(pi.id));
    const rt = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).filter(k => k.startsWith('rpay:v1:p:'))[0])).rt);
    const scanner = await newPage();
    await scanner.goto(`${base}/#comprovante=${rt}`);
    await scanner.waitForSelector('#rpay-receipt .card.good', { timeout: 15000 });
    const v = await ctx.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: rt });
    assert.equal(v.data.valid, true); assert.equal(v.data.first_validation, true);
    assert.deepEqual(page.errors, []);
  });

  test('carteira recusada: pagamento cancelado, volta às opções com aviso, nada cobrado', async () => {
    const { kid } = await ctx.kiosk({ name: 'Quiosque Recusa', wallets: true });
    await seedOrder(ctx.pg, kid, 1, [{ q: 1, p: 25 }]);
    const page = await newPage({ ua: CHROME, avail: { googlePay: true }, decline: true });
    await openTable(page, kid, 1); await openOrdersTab(page);
    await page.click('#rpay-bar [data-a=open]');
    await page.waitForSelector('#fake-wallet-btn', { state: 'visible', timeout: 15000 });
    await page.click('#fake-wallet-btn');
    await page.waitForSelector('#rpay-modal .err', { timeout: 20000 });
    assert.match(await page.textContent('#rpay-modal .err'), /recusado/);
    assert.equal((await ctx.pg.query(`select status from payments where kiosk_id=$1`, [kid])).rows[0].status, 'cancelled');
    assert.equal([...ctx.stripe.pis.values()].at(-1).status, 'canceled');
  });
});

// ============ aba "Pagamentos" do dono, Pix direto e modo obrigatório (Tarefa 3) ============
import { ownerToken, VALID_CPF, clientOrder, seedProduct } from './helpers.mjs';
import { parseBrCode } from '../../supabase/functions/_shared/brcode.ts';

async function mountPanel(page, kid, tok, { waiter = false } = {}) {
  await page.goto(`${base}/`);
  await page.evaluate(({ kid, tok, waiter }) => {
    window._sessToken = tok; if (waiter) window._isWaiterMode = true;
    const g = document.createElement('div'); g.id = 'umb-grid'; g.innerHTML = '<div id="first"></div>'; document.body.appendChild(g);
    window.RecebaaPay.afterUmbrellas(g, [{ id: 'a', number: 1, is_active: true }], { id: kid, name: 'Q', business_type: 'quiosque' });
  }, { kid, tok, waiter });
}
const jc = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);   // o dashboard real fica oculto fora do login: clique via DOM
const PP = '#rpay-pp';
async function openPanel(page, tab) {
  await page.waitForSelector('#rpay-panel-nav', { state: 'attached', timeout: 15000 });
  await jc(page, '#rpay-panel-nav');
  await page.waitForSelector(PP + ' .tabs', { state: 'attached', timeout: 15000 });
  if (tab) { await jc(page, `${PP} [data-a=tab][data-t=${tab}]`); await page.waitForTimeout(150); }
}
const wsel = (page, sel, t = 15000) => page.waitForSelector(sel, { state: 'attached', timeout: t });

describe('Aba Pagamentos (dono)', () => {
  test('negócio NÃO liberado / garçom: a aba não existe', async () => {
    const off = await ctx.kiosk({ enable: false, invite: false, name: 'Q Off' });
    const p1 = await newPage(); await mountPanel(p1, off.kid, off.tok); await p1.waitForSelector('#rpay-mesaqr-card'); await p1.waitForTimeout(800);
    assert.equal(await p1.$('#rpay-panel-nav'), null);
    assert.equal(await p1.$('#kpage-pagamentos'), null);
    const on = await ctx.kiosk({ name: 'Q On' });
    const wid = (await ctx.pg.query(`insert into waiters(kiosk_id,name,email,password) values ($1,'Gabriel','g@x.com','x') returning id`, [on.kid])).rows[0].id;
    const wtok = await ownerToken(ctx.pg, on.kid, 'waiter', wid);
    const p2 = await newPage(); await mountPanel(p2, on.kid, wtok); await p2.waitForSelector('#rpay-mesaqr-card'); await p2.waitForTimeout(800);
    assert.equal(await p2.$('#rpay-panel-nav'), null, 'garçom não vê a aba');
    const p3 = await newPage(); await mountPanel(p3, on.kid, on.tok, { waiter: true }); await p3.waitForSelector('#rpay-mesaqr-card'); await p3.waitForTimeout(800);
    assert.equal(await p3.$('#rpay-panel-nav'), null, 'modo garçom não monta');
    // o servidor também recusa o garçom
    const r = await ctx.anon.rpc('payments_panel_get', { p_token: wtok });
    assert.ok(r.error);
    assert.deepEqual(p1.errors.concat(p2.errors, p3.errors), []);
  });

  test('Ajustes: motivos na tela, chave Pix validada no servidor, liga Pix direto, modo obrigatório e volta para opcional com 1 clique', async () => {
    const { kid, tok } = await ctx.kiosk({ enable: false, name: 'Q Ajustes' });
    const page = await newPage(); await mountPanel(page, kid, tok); await openPanel(page);
    await wsel(page, PP + ' [data-a=sw][data-k=pix_direct]');
    const txt = await page.textContent(PP);
    assert.match(txt, /Conecte sua conta do Mercado Pago/);
    assert.match(txt, /Cadastre sua chave Pix/);
    assert.match(txt, /Ligue ao menos uma forma de pagamento/);
    assert.equal(await page.getAttribute(`${PP} [data-a=sw][data-k=pix_direct]`, 'disabled') !== null, true);
    assert.equal(await page.getAttribute(`${PP} [data-a=mode][data-v=required]`, 'disabled') !== null, true);
    // chave inválida: o servidor recusa e nada é gravado
    await jc(page, `${PP} [data-a=tab][data-t=contas]`);
    await wsel(page, '#rpay-kv');
    await page.evaluate(() => { document.getElementById('rpay-kv').value = '111.111.111-11'; document.getElementById('rpay-kn').value = 'Quiosque Ajustes'; document.getElementById('rpay-kc').value = 'Natal'; });
    await jc(page, `${PP} [data-a=pixsave]`); await page.waitForTimeout(600);
    assert.equal((await ctx.pg.query('select count(*)::int n from kiosk_pix_keys where kiosk_id=$1', [kid])).rows[0].n, 0);
    await page.evaluate(v => { document.getElementById('rpay-kv').value = v; }, VALID_CPF);
    await jc(page, `${PP} [data-a=pixsave]`);
    await page.waitForFunction(() => /Chave atual/.test(document.getElementById('rpay-pp').textContent), null, { timeout: 15000 });
    const row = (await ctx.pg.query('select * from kiosk_pix_keys where kiosk_id=$1', [kid])).rows[0];
    assert.equal(row.key_value, '52998224725'); assert.equal(row.city, 'NATAL');
    assert.ok(!(await page.textContent(PP)).includes('52998224725'), 'a chave aparece mascarada');
    // liga o Pix direto e exige pagamento
    await jc(page, `${PP} [data-a=tab][data-t=ajustes]`); await page.waitForTimeout(150);
    assert.equal(await page.getAttribute(`${PP} [data-a=sw][data-k=pix_direct]`, 'disabled'), null);
    await jc(page, `${PP} [data-a=sw][data-k=pix_direct]`);
    await page.waitForFunction(() => document.querySelector('#rpay-pp [data-a=sw][data-k=pix_direct]')?.textContent === 'Desligar', null, { timeout: 15000 });
    assert.equal((await ctx.pg.query('select pix_direct_enabled from kiosk_payments where kiosk_id=$1', [kid])).rows[0].pix_direct_enabled, true);
    await jc(page, `${PP} [data-a=mode][data-v=required]`);
    await wsel(page, PP + ' .ban.y');
    assert.match(await page.textContent(PP + ' .ban.y'), /obrigatório por pedido/);
    assert.equal((await ctx.pg.query('select checkout_mode from kiosk_payments where kiosk_id=$1', [kid])).rows[0].checkout_mode, 'required');
    await jc(page, `${PP} .ban.y [data-a=mode][data-v=optional]`);
    await page.waitForFunction(() => !document.querySelector('#rpay-pp .ban.y'), null, { timeout: 15000 });
    assert.equal((await ctx.pg.query('select checkout_mode from kiosk_payments where kiosk_id=$1', [kid])).rows[0].checkout_mode, 'optional');
    const ev = (await ctx.pg.query(`select kind from payment_events where kiosk_id=$1 and kind in ('config_changed','pix_key_set') `, [kid])).rows.map(r => r.kind);
    assert.ok(ev.includes('config_changed') && ev.includes('pix_key_set'), 'auditoria gravada');
    assert.ok(!JSON.stringify((await ctx.pg.query('select detail from payment_events where kiosk_id=$1', [kid])).rows).includes('52998224725'), 'chave fora do log');
    assert.deepEqual(page.errors, []);
  });

  test('bloqueio do admin: painel avisa e não deixa religar', async () => {
    const { kid, tok } = await ctx.kiosk({ pixDirect: true, name: 'Q Bloq' });
    await ctx.pg.query('update kiosk_payments set platform_blocked = true, invited = false where kiosk_id = $1', [kid]);
    const r = await ctx.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: true } });
    assert.match(r.error.message, /Bloqueado pela plataforma/);
  });

  test('Pix direto ponta a ponta: pedido em espera -> BR Code (decodificado) -> baixa manual pelo painel -> pedido liberado -> comprovante', async () => {
    const { kid, tok } = await ctx.kiosk({ enable: false, pixDirect: true, mode: 'required', name: 'Q Direto' });
    const pc = await seedProduct(ctx.pg, kid, 'Cerveja', 12.5), pp = await seedProduct(ctx.pg, kid, 'Porção', 7.5);
    const placed = await clientOrder(ctx, kid, 1, [{ id: pc, q: 2, p: 12.5, n: 'Cerveja' }, { id: pp, q: 1, p: 7.5, n: 'Porção' }]);      // R$ 32,50
    assert.ok(!placed.error && !placed.itemsError, JSON.stringify(placed));
    const held = (await ctx.pg.query('select payment_hold, status from orders where kiosk_id=$1', [kid])).rows[0];
    assert.equal(held.payment_hold, true);
    const staffView = await ctx.anon.rpc('read_orders', { p_token: tok });
    assert.equal(staffView.data.length, 0, 'invisível para a equipe enquanto não paga');
    const page = await newPage(); await openTable(page, kid, 1);
    await openOrdersTab(page);
    await page.waitForSelector('#rpay-bar [data-a=open]', { timeout: 15000 });
    assert.match(await page.textContent('#rpay-bar'), /aguardando pagamento/i);
    await page.click('#rpay-bar [data-a=open]');
    await page.waitForSelector('#rpay-modal [data-a=pixdirect]');
    assert.equal(await page.$('#rpay-modal [data-a=pix]'), null, 'Pix online/cartão não ligados: só o direto');
    await page.click('#rpay-modal [data-a=pixdirect]');
    await page.waitForSelector('#rpay-code', { timeout: 15000 });
    const code = await page.inputValue('#rpay-code');
    const d = parseBrCode(code);
    assert.ok(d.ok && d.crcOk); assert.equal(d.fields['54'], '32.50'); assert.equal(d.merchant['01'], '52998224725');
    assert.ok(await page.$('#rpay-modal .qr svg'));
    // ainda segue em espera
    assert.equal((await ctx.anon.rpc('read_orders', { p_token: tok })).data.length, 0);
    // o dono baixa pelo painel
    const owner = await newPage(); await mountPanel(owner, kid, tok); await openPanel(owner, 'lista');
    await wsel(owner, PP + ' tr.clk');
    assert.match(await owner.textContent(PP + ' #rpay-tbl'), /Pix direto[\s\S]*Pendente/);
    await jc(owner, PP + ' tr.clk');
    await wsel(owner, '#rpay-pm [data-a=mmark]');
    await jc(owner, '#rpay-pm [data-a=mmark]');
    await owner.waitForFunction(() => /Pago/.test(document.querySelector('#rpay-pp #rpay-tbl')?.textContent || ''), null, { timeout: 15000 });
    const pay = (await ctx.pg.query('select status, manual, marked_by_role, marked_at from payments where kiosk_id=$1', [kid])).rows[0];
    assert.equal(pay.status, 'paid'); assert.equal(pay.manual, true); assert.equal(pay.marked_by_role, 'kiosk'); assert.ok(pay.marked_at);
    // cliente vê o comprovante; pedido foi liberado para a equipe
    await page.waitForSelector('#rpay-modal .ok', { timeout: 20000 });
    assert.match(await page.textContent('#rpay-modal'), /Pagamento confirmado[\s\S]*R\$ 32,50/);
    assert.match(await page.textContent('#rpay-modal'), /Pedido enviado ao atendente/);
    const after = (await ctx.anon.rpc('read_orders', { p_token: tok })).data;
    assert.equal(after.length, 1); assert.equal(after[0].status, 'pending');
    // detalhe: baixa registrada com autor; reemitir comprovante gera outro QR e invalida o antigo
    await jc(owner, PP + ' tr.clk'); await wsel(owner, '#rpay-pm [data-a=mreissue]');
    assert.match(await owner.textContent('#rpay-pm'), /Baixa manual[\s\S]*Responsável/);
    const oldRt = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).filter(k => k.startsWith('rpay:v1:p:'))[0])).rt);
    await jc(owner, '#rpay-pm [data-a=mreissue]');
    await wsel(owner, '#rpay-pm .qr svg');
    const link = await owner.inputValue('#rpay-pm input[readonly]');
    assert.match(link, /#comprovante=[0-9a-f]{48}$/); assert.ok(!link.endsWith(oldRt));
    const v = await ctx.anon.rpc('verify_payment_receipt', { p_token: tok, p_receipt: oldRt });
    assert.equal(v.data.valid, false, 'QR antigo invalidado');
    assert.deepEqual(page.errors.concat(owner.errors), []);
  });

  test('modo obrigatório: ao confirmar o pedido o pagamento abre sozinho; sem forma de pagamento, volta para opcional (nada fica preso)', async () => {
    const { kid, tok } = await ctx.kiosk({ enable: false, pixDirect: true, mode: 'required', name: 'Q Auto' });
    const prod = await seedProduct(ctx.pg, kid, 'Cerveja', 12.5);
    const page = await newPage(); await openTable(page, kid, 2);
    await page.waitForFunction(() => window.RecebaaPay && document.getElementById('tab-orders'), null, { timeout: 15000 });
    await page.evaluate(() => document.getElementById('tab-orders').click());
    await page.waitForTimeout(1500);            // quote carregada (checkout_mode=required)
    await page.evaluate(async ({ kid, prod }) => {
      const o = await sb.rpc('place_order', { p_order: { kiosk_id: kid, umbrella_num: '2', order_number: 0, customer_name: 'Maria', status: 'pending', total: 12.5, idempotency_key: 'auto-' + Date.now() }, p_items: null });
      await sb.rpc('add_order_items', { p_items: [{ order_id: o.data.id, product_id: prod, product_name: 'Cerveja', quantity: 1, unit_price: 12.5 }] });
    }, { kid, prod });
    await page.waitForSelector('#rpay-modal [data-a=pixdirect]', { timeout: 20000 });
    assert.match(await page.textContent('#rpay-modal'), /só será enviado ao atendente depois que o pagamento for confirmado/);
    assert.equal((await ctx.pg.query('select count(*)::int n from order_items i join orders o on o.id=i.order_id where o.kiosk_id=$1', [kid])).rows[0].n, 1, 'item gravado uma única vez');
    assert.match(await page.textContent('#rpay-modal'), /R\$ 12,50/);
    // dono desliga o Pix direto: nenhum método disponível => modo volta a ser opcional e o pedido em espera segue seu caminho
    const r = await ctx.anon.rpc('payments_panel_set', { p_token: tok, p_patch: { pix_direct: false } });
    assert.equal(r.data.mode_reset, true); assert.equal(r.data.checkout_mode, 'optional');
  });

  test('lista: filtros (mesa, método, estado conferir), totais, paginação e CSV sem injeção de fórmula', async () => {
    const { kid, tok } = await ctx.kiosk({ pixDirect: true, name: 'Q Lista' });
    for (const [u, amt] of [[1, 10], [2, 20], [3, 30]]) {
      await seedOrder(ctx.pg, kid, u, [{ q: 1, p: amt }]);
      const r = await ctx.create({ kiosk_id: kid, umbrella: u, method: u === 3 ? 'pix_direct' : 'pix_direct', idempotency_key: idem() });
      assert.equal(r.status, 200);
    }
    const ids = (await ctx.pg.query('select id, umbrella_num from payments where kiosk_id=$1 order by umbrella_num', [kid])).rows;
    await ctx.anon.rpc('payment_manual_settle', { p_token: tok, p_payment_id: ids[0].id });
    await ctx.pg.query(`update payments set needs_review = true where id = $1`, [ids[1].id]);
    const page = await newPage(); await mountPanel(page, kid, tok); await openPanel(page, 'lista');
    await wsel(page, PP + ' tr.clk');
    assert.equal((await page.$$(PP + ' tr.clk')).length, 3);
    assert.match(await page.textContent(PP + ' .tot'), /R\$ 10,00[\s\S]*Para conferir/);
    await page.evaluate(() => { document.getElementById('rpay-f-st').value = 'review'; });
    await jc(page, PP + ' [data-a=filter]');
    await page.waitForFunction(() => document.querySelectorAll('#rpay-pp tr.clk').length === 1, null, { timeout: 15000 });
    assert.match(await page.textContent(PP + ' tr.clk'), /conferir/);
    await jc(page, PP + ' [data-a=clear]'); await jc(page, PP + ' [data-a=tab][data-t=lista]');
    await page.evaluate(() => { document.getElementById('rpay-f-umb').value = '3'; });
    await jc(page, PP + ' [data-a=filter]');
    await page.waitForFunction(() => document.querySelectorAll('#rpay-pp tr.clk').length === 1, null, { timeout: 15000 });
    // resolver "conferir"
    await jc(page, PP + ' [data-a=clear]'); await page.waitForFunction(() => document.querySelectorAll('#rpay-pp tr.clk').length === 3, null, { timeout: 15000 });
    const csv = await page.evaluate(() => [window.RecebaaPay.panel._csvCell('=HYPERLINK("x")'), window.RecebaaPay.panel._csvCell('+1'), window.RecebaaPay.panel._csvCell('ok "q"')]);
    assert.deepEqual(csv, ['"\'=HYPERLINK(""x"")"', '"\'+1"', '"ok ""q"""']);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), jc(page, PP + ' [data-a=csv]')]);
    const body = fs.readFileSync(await dl.path(), 'utf8');
    assert.equal(body.trim().split(/\r?\n/).length, 4);
    // cancelar cobrança pendente pelo detalhe
    await jc(page, PP + ' tr.clk'); await wsel(page, '#rpay-pm [data-a=mcancel]');
    await jc(page, '#rpay-pm [data-a=mcancel]');
    await page.waitForFunction(() => !document.getElementById('rpay-pm'), null, { timeout: 15000 });
    assert.equal((await ctx.pg.query(`select count(*)::int n from payments where kiosk_id=$1 and status='cancelled'`, [kid])).rows[0].n, 1);
    assert.deepEqual(page.errors, []);
  });
});
