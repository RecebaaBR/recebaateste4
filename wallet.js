/* Recebaa — carteiras Apple Pay / Google Pay (Stripe Express Checkout Element). [pagamentos]
 * Carregado SOMENTE por payments.js e SOMENTE quando o servidor informa wallets_available (flag por negócio ligada).
 * - stripe.js (https://js.stripe.com/v3/) é baixado sob demanda, só se o navegador PROVAVELMENTE tem carteira.
 * - O botão só aparece depois que a Stripe informa (evento "ready") que Apple Pay ou Google Pay estão realmente disponíveis.
 * - Nenhum segredo aqui: só a chave PUBLICÁVEL (vem de wallet-config) e o client_secret do pagamento criado no servidor.
 * - O valor cobrado é o do servidor; o valor mostrado no elements é só visual (a Stripe recusa se divergir do PaymentIntent). */
(function () {
  'use strict';
  var P = window.RecebaaPay; if (!P) return;
  var STRIPE_SRC = 'https://js.stripe.com/v3/';

  // Pré-checagem barata, sem rede: Apple Pay existe no Safari/iOS; Google Pay funciona em Chrome/Chromium/Android.
  function plausible() {
    var ua = navigator.userAgent || '';
    if (window.ApplePaySession) return true;
    if (/Firefox\/|FxiOS/.test(ua)) return false;
    return /Chrome\/|CriOS|Chromium|Android/.test(ua) && !/OPR\/|Opera/.test(ua);
  }
  function loadStripe() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = STRIPE_SRC; s.async = true;
      s.onload = function () { window.Stripe ? ok(window.Stripe) : no(new Error('stripe')); };
      s.onerror = function () { no(new Error('stripe')); };
      document.head.appendChild(s);
    });
  }
  function config(kioskId) {
    return fetch(SUPABASE_URL + '/functions/v1/wallet-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ kiosk_id: kioskId })
    }).then(function (r) { return r.json(); });
  }

  var mounted = null;
  P.wallet = {
    plausible: plausible,
    mount: function (host, ctx) {
      if (!host || !plausible()) return;                          // navegador sem carteira provável: nada é baixado
      if (mounted) { try { mounted.destroy(); } catch (e) { /* ok */ } mounted = null; }
      config(ctx.kioskId).then(function (cfg) {
        if (!cfg || !cfg.ok || !cfg.enabled || !cfg.publishable_key || !cfg.stripe_account) return;
        return loadStripe().then(function (Stripe) {
          if (!document.body.contains(host)) return;
          var stripe = Stripe(cfg.publishable_key, { stripeAccount: cfg.stripe_account, locale: 'pt-BR' });
          var elements = stripe.elements({ mode: 'payment', amount: ctx.amountCents, currency: 'brl' });
          var ece = elements.create('expressCheckout', {
            paymentMethods: { applePay: 'always', googlePay: 'always', link: 'never', amazonPay: 'never', paypal: 'never' },
            buttonHeight: 44
          });
          mounted = ece;
          ece.on('ready', function (e) {
            var m = (e && e.availablePaymentMethods) || null;
            if (m && (m.applePay || m.googlePay)) {
              host.hidden = false;
              host.insertAdjacentHTML('afterbegin', '<div class="note" style="margin:0 0 6px">Pagar com a carteira do celular</div>');
              host.insertAdjacentHTML('beforeend', '<div class="note" style="text-align:center">ou escolha abaixo</div>');
            } else { host.hidden = true; }
          });
          ece.on('confirm', function () {
            elements.submit().then(function (sub) {
              if (sub && sub.error) throw new Error(sub.error.message || 'Pagamento não concluído.');
              return ctx.create();
            }).then(function (c) {
              return stripe.confirmPayment({ elements: elements, clientSecret: c.clientSecret, confirmParams: { return_url: c.returnUrl }, redirect: 'if_required' });
            }).then(function (res) {
              if (res && res.error) throw new Error(res.error.message || 'Pagamento recusado.');
              ctx.paid();
            }).catch(function (err) { ctx.failed(err && err.message); });
          });
          var box = document.createElement('div'); host.appendChild(box);
          ece.mount(box);
        });
      }).catch(function () { host.hidden = true; });
    }
  };
})();
