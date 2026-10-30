import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';
import { makeTokenCrypto, timingSafeEqual } from '../../supabase/functions/_shared/crypto.ts';
import { makeMercadoPago, normalizeMpStatus } from '../../supabase/functions/_shared/mercadopago.ts';
import { ProviderError } from '../../supabase/functions/_shared/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const CFG = { clientId: '123456', clientSecret: 'cs-test-value', webhookSecret: 'whsec-test-value', redirectUri: 'https://x.supabase.co/functions/v1/payments-oauth' };
const SELLER = { accountId: '777', accessToken: 'SELLER-TOKEN-TEST' };

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await handler(call);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls; return f;
}
const input = { paymentId: '11111111-2222-4333-8444-555555555555', method: 'pix', amountCents: 2550, description: 'Consumo - Mesa 3',
  notificationUrl: 'https://x/functions/v1/payment-webhook?pid=1', backUrl: 'https://recebaa.com.br/?x=1', expiresAt: new Date('2026-10-30T15:00:00Z'), feeCents: 0, payerEmail: 'p@recebaa.com.br' };

describe('cifra de tokens (AES-GCM)', () => {
  const key = randomBytes(32).toString('base64');
  test('ida e volta; AAD errado e adulteração falham; chave inválida falha', async () => {
    const c = makeTokenCrypto(key);
    const blob = await c.encrypt('token-secreto', 'kiosk-1');
    assert.ok(!blob.includes('token-secreto'));
    assert.equal(await c.decrypt(blob, 'kiosk-1'), 'token-secreto');
    await assert.rejects(c.decrypt(blob, 'kiosk-2'));
    const parts = blob.split('.'); const bad = [parts[0], parts[1], parts[2].slice(0, -4) + 'AAAA'].join('.');
    await assert.rejects(c.decrypt(bad, 'kiosk-1'));
    await assert.rejects(makeTokenCrypto(randomBytes(16).toString('base64')).encrypt('x', 'a'));
    await assert.rejects(makeTokenCrypto(undefined).encrypt('x', 'a'));
    assert.notEqual(await c.encrypt('token-secreto', 'kiosk-1'), blob, 'IV aleatório');
  });
  test('timingSafeEqual', () => { assert.ok(timingSafeEqual('abc', 'abc')); assert.ok(!timingSafeEqual('abc', 'abd')); assert.ok(!timingSafeEqual('abc', 'abcd')); });
});

describe('Mercado Pago: assinatura do webhook', () => {
  const mp = makeMercadoPago(CFG, fakeFetch(() => ({})));
  const sign = (dataId, reqId, ts, secret = CFG.webhookSecret) => `ts=${ts},v1=${createHmac('sha256', secret).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex')}`;
  const mk = (xsig, reqId = 'req-1', q = 'data.id=987654321&type=payment') =>
    ({ headers: new Headers({ 'x-signature': xsig, 'x-request-id': reqId }), url: new URL('https://x/payment-webhook?pid=abc&' + q), rawBody: '{"type":"payment","data":{"id":"987654321"}}' });
  test('válida', async () => {
    const r = await mp.verifyWebhook(mk(sign('987654321', 'req-1', 1700000000)));
    assert.deepEqual(r, { valid: true, topic: 'payment', providerPaymentId: '987654321' });
  });
  test('segredo errado, id adulterado, request-id adulterado, sem header => inválida', async () => {
    assert.equal((await mp.verifyWebhook(mk(sign('987654321', 'req-1', 1700000000, 'outro-segredo')))).valid, false);
    assert.equal((await mp.verifyWebhook(mk(sign('111', 'req-1', 1700000000)))).valid, false);
    assert.equal((await mp.verifyWebhook(mk(sign('987654321', 'req-X', 1700000000)))).valid, false);
    assert.equal((await mp.verifyWebhook(mk(''))).valid, false);
    assert.equal((await mp.verifyWebhook(mk('ts=1,v1='))).valid, false);
    assert.equal((await makeMercadoPago({ ...CFG, webhookSecret: '' }, fakeFetch(() => ({}))).verifyWebhook(mk(sign('987654321', 'req-1', 1)))).valid, false);
  });
});

describe('Mercado Pago: criação de cobrança usa o token do VENDEDOR e nunca toca em cartão', () => {
  test('Pix', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { id: 5550001, point_of_interaction: { transaction_data: { qr_code: '000201PIXCODE', qr_code_base64: 'AAAA' } } } }));
    const r = await makeMercadoPago(CFG, f).createCharge(SELLER, input);
    assert.deepEqual(r, { providerRef: '5550001', pixCopyPaste: '000201PIXCODE' });
    const c = f.calls[0];
    assert.equal(c.url, 'https://api.mercadopago.com/v1/payments');
    assert.equal(c.headers['Authorization'], 'Bearer SELLER-TOKEN-TEST');
    assert.equal(c.headers['X-Idempotency-Key'], input.paymentId);
    assert.equal(c.body.transaction_amount, 25.5);
    assert.equal(c.body.payment_method_id, 'pix');
    assert.equal(c.body.external_reference, input.paymentId);
    assert.equal(c.body.notification_url, input.notificationUrl);
    assert.match(c.body.date_of_expiration, /-03:00$/);
    assert.equal(c.body.application_fee, undefined);
    assert.ok(!JSON.stringify(f.calls).includes(CFG.clientSecret));
  });
  test('Cartão = checkout hospedado (preferência); só redireciona; sem campos de cartão', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { id: 'pref-1', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1' } }));
    const r = await makeMercadoPago(CFG, f).createCharge(SELLER, { ...input, method: 'card' });
    assert.equal(r.checkoutUrl, 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1');
    const c = f.calls[0];
    assert.equal(c.url, 'https://api.mercadopago.com/checkout/preferences');
    assert.equal(c.headers['Authorization'], 'Bearer SELLER-TOKEN-TEST');
    assert.equal(c.body.items[0].unit_price, 25.5);
    assert.equal(c.body.payment_methods.installments, 1);
    assert.ok(c.body.payment_methods.excluded_payment_types.some(x => x.id === 'ticket'));
    assert.ok(!/card_number|security_code|cardholder|"token"/i.test(JSON.stringify(c.body)));
  });
  test('taxa da plataforma só entra quando > 0', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { id: 1, point_of_interaction: { transaction_data: { qr_code: 'x' } } } }));
    await makeMercadoPago(CFG, f).createCharge(SELLER, { ...input, feeCents: 100 });
    assert.equal(f.calls[0].body.application_fee, 1);
  });
  test('erro do provedor vira ProviderError sem vazar o corpo; 5xx é retryable, 4xx não', async () => {
    for (const [status, retry] of [[500, true], [400, false]]) {
      const f = fakeFetch(() => ({ status, body: { message: 'x'.repeat(500), payer: { email: 'fulano@x.com' } } }));
      await assert.rejects(makeMercadoPago(CFG, f).createCharge(SELLER, input), e => e instanceof ProviderError && e.retryable === retry && !e.message.includes('fulano') && e.message.length < 200);
    }
  });
  test('resposta sem qr_code / init_point http => erro', async () => {
    await assert.rejects(makeMercadoPago(CFG, fakeFetch(() => ({ status: 201, body: { id: 1 } }))).createCharge(SELLER, input));
    await assert.rejects(makeMercadoPago(CFG, fakeFetch(() => ({ status: 201, body: { id: 1, init_point: 'http://inseguro' } }))).createCharge(SELLER, { ...input, method: 'card' }));
  });
});

describe('Mercado Pago: consulta e status', () => {
  test('normalização de status', () => {
    for (const [s, n] of [['approved', 'paid'], ['pending', 'pending'], ['in_process', 'pending'], ['authorized', 'pending'], ['rejected', 'failed'], ['cancelled', 'failed'], ['refunded', 'refunded'], ['charged_back', 'refunded'], [undefined, 'pending']]) assert.equal(normalizeMpStatus(s), n, s);
  });
  test('fetchPayment: usa o token do vendedor, converte centavos, 404/403 => null', async () => {
    const f = fakeFetch(c => c.url.endsWith('/404') ? { status: 404 } : { body: { id: 321, status: 'approved', transaction_amount: 25.5, currency_id: 'BRL', external_reference: 'ref-1' } });
    const mp = makeMercadoPago(CFG, f);
    assert.deepEqual(await mp.fetchPayment(SELLER, '321'), { providerPaymentId: '321', status: 'paid', amountCents: 2550, currency: 'BRL', externalReference: 'ref-1' });
    assert.equal(f.calls[0].headers['Authorization'], 'Bearer SELLER-TOKEN-TEST');
    assert.equal(await makeMercadoPago(CFG, fakeFetch(() => ({ status: 404 }))).fetchPayment(SELLER, '404'), null);
    assert.equal(await mp.fetchPayment(SELLER, '../../etc'), null, 'id fora do padrão nem é consultado');
    assert.equal(f.calls.length, 1);
  });
  test('0,1+0,2 e outros decimais viram centavos exatos', async () => {
    const f = fakeFetch(() => ({ body: { id: 1, status: 'approved', transaction_amount: 10.07, currency_id: 'BRL', external_reference: 'r' } }));
    assert.equal((await makeMercadoPago(CFG, f).fetchPayment(SELLER, '123')).amountCents, 1007);
  });
  test('searchByReference prefere o aprovado e ignora referência diferente', async () => {
    const f = fakeFetch(() => ({ body: { results: [
      { id: 1, status: 'rejected', transaction_amount: 5, currency_id: 'BRL', external_reference: 'r' },
      { id: 2, status: 'approved', transaction_amount: 5, currency_id: 'BRL', external_reference: 'r' },
      { id: 3, status: 'approved', transaction_amount: 5, currency_id: 'BRL', external_reference: 'outra' }] } }));
    const r = await makeMercadoPago(CFG, f).searchByReference(SELLER, 'r');
    assert.equal(r.providerPaymentId, '2');
  });
  test('OAuth: URL de autorização não contém o client_secret; troca de código usa o segredo só no corpo', async () => {
    const f = fakeFetch(() => ({ body: { access_token: 'AT', refresh_token: 'RT', user_id: 777, expires_in: 15552000 } }));
    const mp = makeMercadoPago(CFG, f);
    const u = mp.oauthAuthorizeUrl('STATE123');
    assert.ok(u.startsWith('https://auth.mercadopago.com.br/authorization?') && u.includes('state=STATE123') && u.includes('client_id=123456') && !u.includes(CFG.clientSecret));
    const t = await mp.oauthExchange('CODE');
    assert.deepEqual(t, { accountId: '777', accessToken: 'AT', refreshToken: 'RT', expiresInSec: 15552000 });
    assert.equal(f.calls[0].body.grant_type, 'authorization_code');
  });
});

describe('higiene do repositório', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p); } else files.push(p); } })(path.join(repo, 'supabase/functions'));
  for (const f of ['payments-boot.js', 'payments.js', 'payments-staff.js', 'payments-panel.js', 'mesa-qr.js', 'wallet.js', 'docs/pagamentos.md', 'supabase/migrations/20261031_payments_v1.sql', 'supabase/migrations/20261101_payments_wallets_v1.sql', 'supabase/migrations/20261102_payments_panel_v1.sql']) if (fs.existsSync(path.join(repo, f))) files.push(path.join(repo, f));
  test('nenhum segredo/chave de provedor no código novo', () => {
    const bad = /(APP_USR-[0-9a-f-]{8,}|TEST-[0-9a-f]{12,}|sk_live_|sk_test_|whsec_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE|service_role['"]?\s*[:=]\s*['"]eyJ)/;
    for (const f of files) assert.ok(!bad.test(fs.readFileSync(f, 'utf8')), f);
  });
  test('Stripe: só a chave PUBLICÁVEL pode aparecer no front; segredos só no servidor via Deno.env', () => {
    const st = fs.readFileSync(path.join(repo, 'supabase/functions/_shared/stripe.ts'), 'utf8');
    assert.ok(!/sk_(live|test)_|whsec_[A-Za-z0-9]/.test(st));
    const reg = fs.readFileSync(path.join(repo, 'supabase/functions/_shared/registry.ts'), 'utf8');
    assert.ok(/env\('STRIPE_SECRET_KEY'\)/.test(reg) && /env\('STRIPE_WEBHOOK_SECRET'\)/.test(reg));
    const idx = fs.readFileSync(path.join(repo, 'supabase/functions/wallet-config/index.ts'), 'utf8');
    assert.ok(/Deno\.env\.get/.test(idx));
    for (const f of ['index.html', 'wallet.js', 'payments.js']) assert.ok(!/pk_(live|test)_[A-Za-z0-9]/.test(fs.readFileSync(path.join(repo, f), 'utf8')), f + ': nem a publicável fica no código');
  });
  test('Edge Functions leem segredos só de Deno.env (nada hardcoded) e o front não referencia segredos', () => {
    const idx = fs.readFileSync(path.join(repo, 'supabase/functions/create-payment/index.ts'), 'utf8');
    assert.ok(/Deno\.env\.get/.test(idx));
    for (const f of ['payments-boot.js', 'payments.js', 'payments-staff.js', 'payments-panel.js', 'mesa-qr.js', 'wallet.js']) {
      const p = path.join(repo, f); if (!fs.existsSync(p)) continue;
      const s = fs.readFileSync(p, 'utf8');
      assert.ok(!/(access_token|MP_CLIENT|SERVICE_ROLE|webhook_secret|STRIPE_SECRET|STRIPE_WEBHOOK|sk_(live|test)_|whsec_|card_number|cardNumber|security_code|cvv)/i.test(s), f + ' menciona segredo/cartão');
    }
  });
});

describe('painel de pagamentos: higiene do front', () => {
  const FILES = ['payments.js', 'payments-staff.js', 'payments-panel.js', 'wallet.js', 'mesa-qr.js'];
  test('sem onclick/eval/document.write inline: eventos por data-a + delegação', () => {
    for (const f of FILES) {
      const s = fs.readFileSync(path.join(repo, f), 'utf8');
      assert.ok(!/\bonclick\s*=/.test(s), f + ' usa onclick inline');
      assert.ok(!/\beval\(|new Function\(|document\.write\(/.test(s), f + ' usa eval/document.write');
    }
  });
  test('todo texto vindo do banco no painel passa por esc() (campos de texto livre)', () => {
    const s = fs.readFileSync(path.join(repo, 'payments-panel.js'), 'utf8');
    for (const field of ['p.manual_note', 'p.marked_by_name', 'pk.name', 'pk.city', 'p.umbrella_num', 'e.by_name']) {
      const re = new RegExp('(?<!esc\\()' + field.replace('.', '\\.') + '(?![\\w])', 'g');
      for (const m of s.matchAll(re)) {
        const line = s.slice(s.lastIndexOf('\n', m.index) + 1, s.indexOf('\n', m.index));
        if (line.includes('toFixed(2)')) continue;            // linha do CSV (não é HTML)
        assert.ok(line.includes('esc('), field + ' sem esc() em: ' + line.trim().slice(0, 120));
      }
    }
  });
  test('CSV: células com = + - @ ganham apóstrofo (sem injeção de fórmula)', () => {
    const s = fs.readFileSync(path.join(repo, 'payments-panel.js'), 'utf8');
    assert.ok(/\^\[=\+\\-@\\t\\r\]/.test(s));
  });
  test('a chave Pix nunca vai para o log de eventos nem para o payload do BR Code de leitura pública', () => {
    const mig = fs.readFileSync(path.join(repo, 'supabase/migrations/20261102_payments_panel_v1.sql'), 'utf8');
    for (const m of mig.matchAll(/pay_event\([^;]*pix_key[^;]*;/g)) assert.ok(!/key_value|p_value|\bv\b/.test(m[0].replace(/'pix_key_(set|cleared)'/, '')), m[0]);
    assert.ok(/alter table public\.kiosk_pix_keys enable row level security/i.test(mig));
    assert.ok(/revoke all on public\.kiosk_pix_keys from public, anon, authenticated/i.test(mig));
  });
});

describe('vercel.json (CSP / Permissions-Policy / Apple Pay)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
  const all = Object.fromEntries(v.headers.find(h => h.source === '/(.*)').headers.map(h => [h.key, h.value]));
  const dir = (name) => (all['Content-Security-Policy'].split(';').map(x => x.trim()).find(x => x.startsWith(name + ' ')) || '').split(/\s+/).slice(1);
  test('CSP libera SÓ os domínios da Stripe necessários e mantém o restante restritivo', () => {
    assert.ok(dir('script-src').includes('https://js.stripe.com'));
    assert.ok(dir('connect-src').includes('https://api.stripe.com') && dir('connect-src').includes('https://m.stripe.network'));
    for (const d of ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://m.stripe.network']) assert.ok(dir('frame-src').includes(d), d);
    assert.ok(dir('img-src').includes('https://*.stripe.com'));
    assert.deepEqual(dir('default-src'), ["'self'"]); assert.deepEqual(dir('frame-ancestors'), ["'none'"]); assert.deepEqual(dir('object-src'), ["'none'"]);
    assert.ok(!/\*(?!\.stripe)/.test(all['Content-Security-Policy'].replace(/https:\/\/\*\.stripe\.com/g, '')), 'sem curinga solto');
  });
  test('Permissions-Policy permite Payment Request só para o próprio site e js.stripe.com', () => {
    assert.match(all['Permissions-Policy'], /payment=\(self "https:\/\/js\.stripe\.com"\)/);
    assert.match(all['Permissions-Policy'], /geolocation=\(\)/);
  });
  test('arquivo de verificação do Apple Pay: regra de cabeçalho text/plain, sem redirect/rewrite, placeholder presente e NÃO falso', () => {
    const rule = v.headers.find(h => h.source === '/.well-known/apple-developer-merchantid-domain-association');
    assert.ok(rule && rule.headers.some(h => h.key === 'Content-Type' && /^text\/plain/.test(h.value)));
    assert.ok(!v.redirects && !v.rewrites, 'nenhum redirect/rewrite que quebre a verificação');
    const f = fs.readFileSync(path.join(repo, '.well-known/apple-developer-merchantid-domain-association'), 'utf8');
    assert.match(f, /PLACEHOLDER/);
  });
});
