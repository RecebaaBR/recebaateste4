/* Recebaa — pagamentos: ponto de entrada (sempre carregado, ~2 KB, SEM rede ao carregar).
 *
 * O index.html só chama os ganchos abaixo; enquanto o pagamento online estiver desligado no negócio
 * (kiosks.payments_enabled = false) nada daqui aparece nem faz requisição:
 *   - clientReady(kiosk, umb)        : chamado em goToMenu(); só carrega /payments.js se kiosk.payments_enabled === true
 *   - afterMyOrders(el)              : chamado ao fim de renderMyOrders(); no-op se payments.js não foi carregado
 *   - afterUmbrellas(grid, umbs, k)  : chamado ao fim de renderUmbrellas() (painel); carrega /mesa-qr.js (QR por mesa)
 * Também trata os links: #comprovante=<token> (verificação do QR), ?rpay=<id> (volta do checkout do cartão)
 * e ?pagamentos=conectado|erro (volta da conexão com o provedor).
 * Ver docs/pagamentos.md ("Pontos de ancoragem no index.html").
 */
(function () {
  'use strict';
  var P = window.RecebaaPay = window.RecebaaPay || {};
  var cache = {};
  function noop() {}

  P.load = function (src) {
    if (cache[src]) return cache[src];
    cache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { delete cache[src]; reject(new Error('falha ao carregar ' + src)); };
      document.head.appendChild(s);
    });
    return cache[src];
  };
  P.loadQr = function () { return P.load('/vendor/qrcode-generator-1.4.4.js'); };

  /** QR em SVG gerado LOCALMENTE (nada é enviado a serviços de terceiros). Exige P.loadQr() antes. */
  P.qrSvg = function (text, px) {
    var qr = window.qrcode(0, 'M');
    qr.addData(String(text)); qr.make();
    var n = qr.getModuleCount(), d = '', q = 4;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    var size = n + q * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + (px || 220) + '" height="' + (px || 220) +
      '" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  };

  P.clientReady = function (kiosk, umb) {
    try {
      // desligado por padrão: sem a flag do negócio não carrega nada e não faz nenhuma requisição
      if (!(kiosk && kiosk.id && kiosk.id !== 'demo' && kiosk.payments_enabled === true)) return;
      P.load('/payments.js').then(function () { if (P.client) P.client.init(kiosk, umb); }).catch(noop);
    } catch (e) { /* nunca quebra o app */ }
  };

  P.afterMyOrders = function (el) {
    try { if (P.client && P.client.afterMyOrders) P.client.afterMyOrders(el); } catch (e) { /* idem */ }
  };

  P.afterUmbrellas = function (grid, umbs, kiosk) {
    try {
      P.load('/mesa-qr.js').then(function () { if (P.mesaQr) P.mesaQr.mount(grid, umbs, kiosk); }).catch(noop);
    } catch (e) { /* idem */ }
  };

  function say(msg) { try { if (typeof window.toast === 'function') window.toast(msg); } catch (e) { /* idem */ } }

  // links especiais (executa depois que o app terminou de carregar)
  function onReady() {
    try {
      if (/(^|[#&])comprovante=/.test(location.hash)) {
        P.load('/payments.js').then(function () { if (P.receiptView) P.receiptView.fromHash(); }).catch(noop);
      }
      var sp = new URLSearchParams(location.search), st = sp.get('pagamentos');
      if (st === 'conectado' || st === 'erro') {
        sp.delete('pagamentos');
        try { history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp.toString() : '') + location.hash); } catch (e) { /* idem */ }
        setTimeout(function () {
          say(st === 'conectado' ? '✅ Conta de pagamentos conectada! Agora ative em Pagamentos online.' : '⚠️ Não foi possível conectar a conta. Tente novamente.');
        }, 800);
      }
    } catch (e) { /* idem */ }
  }
  if (document.readyState === 'complete') onReady(); else window.addEventListener('load', onReady);
})();
