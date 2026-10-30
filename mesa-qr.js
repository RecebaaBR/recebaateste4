/* Recebaa — QR Code POR MESA (um QR diferente para cada guarda-sol/mesa).
 * Link da mesa: <site>/?kiosk=<id do negócio>&umbrella=<número>  (abre direto no cardápio daquela mesa).
 * Os QR antigos (?kiosk=<id>) continuam funcionando: o cliente só digita o número, como sempre.
 * Carregado por payments-boot.js quando o painel abre a aba de guarda-sóis. Gera o QR no próprio navegador. */
(function () {
  'use strict';
  var P = window.RecebaaPay;
  function esc(s) { return (typeof window.esc === 'function') ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function baseUrl() { return (typeof window.getKioskUrl === 'function') ? window.getKioskUrl() : (location.origin + location.pathname); }
  function tableUrl(kid, n) { return baseUrl() + '?kiosk=' + encodeURIComponent(kid) + '&umbrella=' + encodeURIComponent(n); }
  function word(kiosk) { return (kiosk && kiosk.business_type === 'bar_restaurante') ? 'Mesa' : 'Guarda-sol'; }
  function pad(n) { return String(n).padStart(2, '0'); }

  function injectCss() {
    if (document.getElementById('rpay-css-qr')) return;
    var st = document.createElement('style'); st.id = 'rpay-css-qr';
    st.textContent =
      '#rpay-print{position:fixed;inset:0;z-index:99998;background:#f1f5f9;overflow:auto;font-family:inherit}' +
      '#rpay-print .rpay-bar{position:sticky;top:0;background:#0f172a;color:#fff;padding:12px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}' +
      '#rpay-print .rpay-bar input{padding:8px 10px;border-radius:8px;border:0;min-width:160px}' +
      '#rpay-print .rpay-bar button{padding:9px 14px;border-radius:8px;border:0;cursor:pointer;font-weight:600}' +
      '#rpay-print .rpay-sheet{display:flex;flex-wrap:wrap;gap:12px;padding:16px;justify-content:center}' +
      '#rpay-print .rpay-qr-card{background:#fff;border:2px dashed #94a3b8;border-radius:14px;width:300px;padding:16px;text-align:center;break-inside:avoid;page-break-inside:avoid}' +
      '#rpay-print .rpay-qr-card .k{font-size:14px;color:#334155;font-weight:600}' +
      '#rpay-print .rpay-qr-card .n{font-size:40px;font-weight:800;color:#0f172a;line-height:1.1;margin:4px 0}' +
      '#rpay-print .rpay-qr-card .h{font-size:12px;color:#475569;margin-top:6px}' +
      '#rpay-print .rpay-qr-card .u{font-size:8px;color:#94a3b8;word-break:break-all;margin-top:6px}' +
      '@media print{body>*:not(#rpay-print){display:none!important}#rpay-print{position:static;background:#fff;overflow:visible}' +
      '#rpay-print .rpay-bar{display:none}#rpay-print .rpay-sheet{gap:8mm;padding:0;justify-content:flex-start}' +
      '#rpay-print .rpay-qr-card{width:88mm;border:1px dashed #999}}';
    document.head.appendChild(st);
  }

  /** "1-10, 15" -> {1..10,15}; vazio = todas */
  function parseRange(text) {
    var set = {}, any = false;
    String(text || '').split(/[,;\s]+/).forEach(function (part) {
      var m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part.trim());
      if (!m) return;
      var a = +m[1], b = m[2] ? +m[2] : a;
      if (b < a) { var t = a; a = b; b = t; }
      if (b - a > 500) b = a + 500;
      for (var i = a; i <= b; i++) set[i] = true;
      any = true;
    });
    return any ? set : null;
  }

  function openPrint(umbs, kiosk) {
    injectCss();
    var old = document.getElementById('rpay-print'); if (old) old.remove();
    var list = (umbs || []).filter(function (u) { return u && u.is_active !== false && isFinite(+u.number); })
      .sort(function (a, b) { return +a.number - +b.number; });
    var ov = document.createElement('div'); ov.id = 'rpay-print';
    ov.innerHTML =
      '<div class="rpay-bar"><b>QR Code por ' + esc(word(kiosk).toLowerCase()) + '</b>' +
      '<input id="rpay-range" placeholder="Todas (ou: 1-10, 15)" aria-label="Quais mesas imprimir"/>' +
      '<button type="button" data-a="apply" style="background:#e2e8f0">Filtrar</button>' +
      '<button type="button" data-a="print" style="background:#22c55e;color:#fff">🖨️ Imprimir</button>' +
      '<button type="button" data-a="close" style="background:#475569;color:#fff">Fechar</button>' +
      '<span style="font-size:12px;opacity:.8">Cada QR abre direto o cardápio da sua mesa.</span></div>' +
      '<div class="rpay-sheet" id="rpay-sheet"></div>';
    document.body.appendChild(ov);

    function render() {
      var sel = parseRange(document.getElementById('rpay-range').value);
      var sheet = document.getElementById('rpay-sheet'), html = '', n = 0;
      list.forEach(function (u) {
        if (sel && !sel[+u.number]) return;
        var url = tableUrl(kiosk.id, +u.number);
        html += '<div class="rpay-qr-card"><div class="k">' + esc(kiosk.name || '') + '</div>' +
          '<div class="n">' + esc(word(kiosk)) + ' ' + esc(pad(+u.number)) + '</div>' +
          P.qrSvg(url, 220) +
          '<div class="h">Aponte a câmera do celular para ver o cardápio e pedir</div>' +
          '<div class="u">' + esc(url) + '</div></div>';
        n++;
      });
      sheet.innerHTML = n ? html : '<div style="padding:40px;color:#475569">Nenhuma mesa ativa para imprimir.</div>';
    }
    ov.addEventListener('click', function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
      if (a === 'close') ov.remove();
      else if (a === 'apply') render();
      else if (a === 'print') window.print();
    });
    document.getElementById('rpay-range').addEventListener('keydown', function (e) { if (e.key === 'Enter') render(); });
    P.loadQr().then(render).catch(function () { document.getElementById('rpay-sheet').textContent = 'Não foi possível carregar o gerador de QR.'; });
  }

  var statusCache = { token: null, at: 0, value: null };
  function staffStatus() {
    var tok = window._sessToken;
    if (!tok || typeof sb === 'undefined') return Promise.resolve(null);
    if (statusCache.token === tok && Date.now() - statusCache.at < 60000) return Promise.resolve(statusCache.value);
    return sb.rpc('payments_owner_status', { p_token: tok }).then(function (r) {
      statusCache = { token: tok, at: Date.now(), value: (r && r.data) || null };
      return statusCache.value;
    }).catch(function () { return null; });
  }
  P.invalidateStaffStatus = function () { statusCache = { token: null, at: 0, value: null }; };
  P.staffStatus = staffStatus;

  function mount(grid, umbs, kiosk) {
    if (!grid || !kiosk || !kiosk.id || kiosk.id === 'demo') return;
    var old = document.getElementById('rpay-mesaqr-card'); if (old) old.remove();
    var card = document.createElement('div');
    card.id = 'rpay-mesaqr-card';
    card.style.cssText = 'grid-column:1/-1;background:#fff;border-radius:var(--r,14px);border:1px solid var(--sand-100,#e7e5e4);padding:14px 16px;margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between';
    card.innerHTML = '<div style="min-width:220px;flex:1"><div style="font-size:14px;font-weight:600;color:var(--sl-800,#1e293b)">📱 QR Code de cada ' + esc(word(kiosk).toLowerCase()) + '</div>' +
      '<div style="font-size:12px;color:var(--sl-400,#94a3b8);margin-top:2px">Um QR diferente por ' + esc(word(kiosk).toLowerCase()) + ', já abrindo o cardápio certo. Os QR antigos continuam funcionando.</div></div>' +
      '<button type="button" class="btn btn-ocean btn-sm" data-a="print">🖨️ Imprimir QR das mesas</button>';
    card.addEventListener('click', function (e) {
      var t = e.target; while (t && t !== card && !(t.getAttribute && t.getAttribute('data-a'))) t = t.parentNode;
      if (t && t.getAttribute && t.getAttribute('data-a') === 'print') openPrint(umbs, kiosk);
    });
    var anchor = grid.children[1] || null;
    grid.insertBefore(card, anchor);

    // painel de pagamentos online (só aparece se a plataforma liberou o negócio)
    staffStatus().then(function (st) {
      if (st && st.available) return P.load('/payments-staff.js').then(function () { if (P.staff) P.staff.mount(grid, kiosk, st); });
    }).catch(function () {});
  }

  P.mesaQr = { mount: mount, openPrint: openPrint, tableUrl: tableUrl, parseRange: parseRange };
})();
