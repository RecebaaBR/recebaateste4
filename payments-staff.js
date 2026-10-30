/* Recebaa — painel do estabelecimento para pagamentos online (dono e garçom).
 * Só aparece se a plataforma liberou o negócio (payments_owner_status.available).
 * Dono: conectar a conta do provedor (OAuth: o Recebaa nunca vê a senha do dono), ligar/desligar, taxa de serviço, desconectar.
 * Dono e garçom: validar comprovante (QR) e ver pagamentos recentes.
 * Nenhum segredo é guardado no navegador: só o token de sessão do painel, que já existe em memória. */
(function () {
  'use strict';
  var P = window.RecebaaPay;
  var esc = function (s) { return (typeof window.esc === 'function') ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function brl(c) { return 'R$ ' + (Number(c || 0) / 100).toFixed(2).replace('.', ','); }
  function dhm(iso) { try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function toast(m) { try { if (typeof window.toast === 'function') window.toast(m); } catch (e) { /* ok */ } }
  function tok() { return window._sessToken; }

  function injectCss() {
    if (document.getElementById('rpay-css-staff')) return;
    var st = document.createElement('style'); st.id = 'rpay-css-staff';
    st.textContent =
      '#rpay-staff-card{grid-column:1/-1;background:#fff;border:2px solid #10b981;border-radius:var(--r,14px);padding:14px 16px;margin-bottom:16px}' +
      '#rpay-staff-card h4{margin:0 0 4px;font-size:15px}#rpay-staff-card .m{font-size:12px;color:#64748b;line-height:1.5}' +
      '#rpay-staff-card .grid{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}' +
      '.rpay-sbtn{border:0;border-radius:10px;padding:9px 14px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;background:#e2e8f0;color:#0f172a}' +
      '.rpay-sbtn.pri{background:#059669;color:#fff}.rpay-sbtn.dk{background:#0f172a;color:#fff}.rpay-sbtn.red{background:#fee2e2;color:#991b1b}.rpay-sbtn[disabled]{opacity:.5}' +
      '.rpay-chip{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;background:#e2e8f0;color:#334155}.rpay-chip.g{background:#d1fae5;color:#065f46}.rpay-chip.y{background:#fef3c7;color:#92400e}.rpay-chip.r{background:#fee2e2;color:#991b1b}' +
      '#rpay-smodal{position:fixed;inset:0;z-index:99992;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:12px}' +
      '#rpay-smodal .sheet{background:#fff;border-radius:18px;width:100%;max-width:520px;max-height:92vh;overflow:auto;padding:18px;color:#0f172a;font-size:14px}' +
      '#rpay-smodal input[type=text]{width:100%;box-sizing:border-box;padding:11px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px}' +
      '#rpay-smodal .res{border-radius:14px;padding:16px;text-align:center;margin-top:12px;border:2px solid #e2e8f0}#rpay-smodal .res.good{border-color:#10b981;background:#ecfdf5}#rpay-smodal .res.warn{border-color:#f59e0b;background:#fffbeb}#rpay-smodal .res.bad{border-color:#ef4444;background:#fef2f2}' +
      '#rpay-smodal table{width:100%;border-collapse:collapse;font-size:12px}#rpay-smodal td,#rpay-smodal th{padding:6px 4px;border-bottom:1px solid #f1f5f9;text-align:left}' +
      '#rpay-smodal video{width:100%;border-radius:12px;background:#000;margin-top:8px}';
    document.head.appendChild(st);
  }

  var ST = { kiosk: null, status: null, timer: null, stream: null, scanning: false };

  function connChip(s) {
    if (s.connection === 'connected') return '<span class="rpay-chip g">Conectado ' + esc(s.account || '') + '</span>';
    if (s.connection === 'sandbox') return '<span class="rpay-chip y">Conectado (TESTE) ' + esc(s.account || '') + '</span>';
    return '<span class="rpay-chip">Não conectado</span>';
  }

  function render(grid) {
    var s = ST.status; if (!s) return;
    var old = document.getElementById('rpay-staff-card'); if (old) old.remove();
    var owner = s.role === 'kiosk';
    var card = document.createElement('div'); card.id = 'rpay-staff-card';
    var h = '<h4>💳 Pagamentos online (Pix e cartão)</h4>' +
      '<div class="m">O cliente paga pelo celular direto para a <b>sua conta</b> no provedor; o Recebaa não guarda o dinheiro. ' +
      'Ao pagar, o cliente recebe um QR de comprovante para mostrar ao atendente.</div>';
    if (owner) {
      h += '<div class="grid">' + connChip(s) +
        '<span class="rpay-chip ' + (s.enabled ? 'g' : '') + '">' + (s.enabled ? 'ATIVO para os clientes' : 'Desligado') + '</span></div>' +
        '<div class="grid">';
      if (s.connection === 'disconnected') h += '<button type="button" class="rpay-sbtn pri" data-a="connect">Conectar conta Mercado Pago</button>';
      else {
        h += '<button type="button" class="rpay-sbtn ' + (s.enabled ? 'red' : 'pri') + '" data-a="toggle">' + (s.enabled ? 'Desligar pagamentos' : 'Ligar pagamentos') + '</button>' +
          '<label class="m">Taxa de serviço: <select id="rpay-svc" data-a="svc">' + [0, 5, 10, 12].map(function (p) { return '<option value="' + p + '"' + (Number(s.service_percent) === p ? ' selected' : '') + '>' + p + '%</option>'; }).join('') + '</select></label>' +
          '<button type="button" class="rpay-sbtn" data-a="disconnect">Desconectar conta</button>';
      }
      h += '</div>';
    }
    h += '<div class="grid"><button type="button" class="rpay-sbtn dk" data-a="validate">🧾 Validar comprovante</button><button type="button" class="rpay-sbtn" data-a="list">Pagamentos recentes</button></div>';
    card.innerHTML = h;
    card.addEventListener('click', onClick);
    card.addEventListener('change', function (e) { if (e.target && e.target.id === 'rpay-svc') setSettings({ p_service_percent: Number(e.target.value) }); });
    var anchor = document.getElementById('rpay-mesaqr-card');
    if (anchor && anchor.parentNode === grid) grid.insertBefore(card, anchor.nextSibling); else grid.insertBefore(card, grid.children[1] || null);
  }

  function reload() {
    P.invalidateStaffStatus && P.invalidateStaffStatus();
    return sb.rpc('payments_owner_status', { p_token: tok() }).then(function (r) { if (r && r.data) ST.status = r.data; var g = document.getElementById('umb-grid'); if (g) render(g); });
  }

  function setSettings(args) {
    var a = Object.assign({ p_token: tok() }, args);
    return sb.rpc('set_payments_settings', a).then(function (r) {
      if (r.error) { toast('⚠️ ' + r.error.message); return reload(); }
      ST.status = r.data; P.invalidateStaffStatus && P.invalidateStaffStatus();
      var g = document.getElementById('umb-grid'); if (g) render(g);
      toast(args.p_enabled === true ? '✅ Pagamentos online LIGADOS' : args.p_enabled === false ? '⏸️ Pagamentos online desligados' : '✅ Salvo');
    });
  }

  function onClick(e) {
    var t = e.target; while (t && !(t.getAttribute && t.getAttribute('data-a'))) t = t.parentNode;
    if (!t) return;
    var a = t.getAttribute('data-a');
    if (a === 'connect') connect();
    else if (a === 'toggle') {
      var turnOn = !ST.status.enabled;
      if (turnOn && !confirm('Ligar o pagamento online?\n\nOs clientes verão o botão “Pagar agora” e o dinheiro cairá direto na sua conta do provedor (taxas do provedor se aplicam).')) return;
      setSettings({ p_enabled: turnOn });
    }
    else if (a === 'disconnect') { if (confirm('Desconectar a conta de pagamentos? Os pagamentos online serão desligados.')) sb.rpc('payments_disconnect', { p_token: tok() }).then(reload); }
    else if (a === 'validate') openValidate();
    else if (a === 'list') openList();
  }

  function connect() {
    fetch(SUPABASE_URL + '/functions/v1/payments-oauth', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ action: 'start', session_token: tok() })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && /^https:\/\//.test(j.url)) window.location.href = j.url;         // login/autorização acontece no site do provedor
      else if (j && j.error === 'unsupported') connectMock();
      else toast('⚠️ ' + ((j && j.message) || 'Não foi possível iniciar a conexão.'));
    }).catch(function () { toast('⚠️ Sem conexão.'); });
  }
  function connectMock() {
    fetch(SUPABASE_URL + '/functions/v1/payments-oauth', { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, body: JSON.stringify({ action: 'connect_mock', session_token: tok() }) })
      .then(function () { reload(); });
  }

  // ---------- modais ----------
  function modal(inner) {
    injectCss();
    var m = document.getElementById('rpay-smodal'); if (m) m.remove();
    m = document.createElement('div'); m.id = 'rpay-smodal';
    m.innerHTML = '<div class="sheet">' + inner + '</div>';
    m.addEventListener('click', function (e) {
      if (e.target === m) return closeModal();
      var t = e.target; while (t && t !== m && !(t.getAttribute && t.getAttribute('data-a'))) t = t.parentNode;
      if (!t || t === m) return;
      var a = t.getAttribute('data-a');
      if (a === 'close') closeModal();
      else if (a === 'check') doVerify(document.getElementById('rpay-in').value);
      else if (a === 'scan') scan();
    });
    document.body.appendChild(m);
    return m;
  }
  function stopCam() { ST.scanning = false; if (ST.stream) { ST.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ok */ } }); ST.stream = null; } }
  function closeModal() { stopCam(); if (ST.timer) { clearInterval(ST.timer); ST.timer = null; } var m = document.getElementById('rpay-smodal'); if (m) m.remove(); }

  function extract(text) {
    var s = String(text || '').trim();
    var m = /comprovante=([A-Za-z0-9_-]{20,200})/.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{20,200}$/.test(s) ? s : null;
  }

  function openValidate() {
    modal('<h3 style="margin:0 0 4px">Validar comprovante</h3><div class="m" style="font-size:12px;color:#64748b">Leia o QR do cliente com a câmera, ou cole aqui o link/código do comprovante.</div>' +
      '<div style="display:grid;gap:8px;margin-top:12px"><input type="text" id="rpay-in" placeholder="Cole o link ou código do comprovante" autocomplete="off"/>' +
      '<button type="button" class="rpay-sbtn pri" data-a="check">Validar</button>' +
      ('BarcodeDetector' in window ? '<button type="button" class="rpay-sbtn dk" data-a="scan">📷 Ler QR com a câmera</button>' : '<div class="m" style="font-size:12px;color:#64748b">Dica: abra a câmera do celular, aponte para o QR do cliente e toque no link que aparece.</div>') +
      '<button type="button" class="rpay-sbtn" data-a="close">Fechar</button></div><video id="rpay-vid" playsinline muted style="display:none"></video><div id="rpay-res"></div>');
    var inp = document.getElementById('rpay-in');
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doVerify(inp.value); });
    inp.focus();
  }

  function doVerify(text) {
    var t = extract(text), out = document.getElementById('rpay-res'); if (!out) return;
    if (!t) { out.innerHTML = '<div class="res bad"><div style="font-size:36px">❌</div><b>Código inválido</b><div class="m">Cole o link completo do comprovante.</div></div>'; return; }
    out.innerHTML = '<div class="res">Verificando…</div>';
    sb.rpc('verify_payment_receipt', { p_token: tok(), p_receipt: t, p_mark: true }).then(function (r) {
      var d = r && r.data;
      if (r.error || !d) { out.innerHTML = '<div class="res bad"><b>Não foi possível verificar.</b><div class="m">' + esc((r.error && r.error.message) || '') + '</div></div>'; return; }
      var cls, body;
      if (d.valid && d.already_validated) { cls = 'warn'; body = '<div style="font-size:40px">⚠️</div><b>JÁ UTILIZADO</b><div class="m">Primeira baixa em ' + esc(dhm(d.validated_at)) + ' · ' + esc(d.validation_count) + 'ª verificação. Confira antes de liberar.</div>'; }
      else if (d.valid) { cls = 'good'; body = '<div style="font-size:40px">✅</div><b>PAGO — baixa registrada</b>'; }
      else { cls = 'bad'; body = '<div style="font-size:40px">❌</div><b>NÃO VÁLIDO</b><div class="m">' + esc({ not_found: 'Comprovante não encontrado neste estabelecimento.', pending: 'Pagamento ainda não confirmado.', expired: 'Pagamento expirado.', refunded: 'Pagamento estornado.', cancelled: 'Pagamento cancelado.', failed: 'Pagamento não concluído.' }[d.reason] || '') + '</div>'; }
      if (d.amount_cents) body += '<div style="font-size:26px;font-weight:800;margin-top:6px">' + esc(brl(d.amount_cents)) + '</div><div class="m">Mesa/guarda-sol ' + esc(d.umbrella_num) + (d.paid_at ? ' · pago em ' + esc(dhm(d.paid_at)) : '') + (d.method ? ' · ' + (d.method === 'pix' ? 'Pix' : 'Cartão') : '') + '</div>';
      if (d.late_payment) body += '<div class="m" style="color:#92400e">⚠️ Pago após o prazo: conferir no extrato do provedor.</div>';
      out.innerHTML = '<div class="res ' + cls + '">' + body + '</div>';
    });
  }

  function scan() {
    var vid = document.getElementById('rpay-vid');
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) return;
    var det = new window.BarcodeDetector({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      ST.stream = stream; ST.scanning = true; vid.srcObject = stream; vid.style.display = 'block'; vid.play();
      (function loop() {
        if (!ST.scanning) return;
        det.detect(vid).then(function (codes) {
          for (var i = 0; i < codes.length; i++) { var t = extract(codes[i].rawValue); if (t) { stopCam(); vid.style.display = 'none'; var inp = document.getElementById('rpay-in'); if (inp) inp.value = ''; doVerify(t); return; } }
          setTimeout(loop, 350);
        }).catch(function () { setTimeout(loop, 600); });
      })();
    }).catch(function () { toast('⚠️ Não foi possível abrir a câmera.'); });
  }

  var LABEL = { paid: ['Pago', 'g'], pending: ['Aguardando', 'y'], expired: ['Expirou', ''], failed: ['Falhou', 'r'], cancelled: ['Cancelado', ''], refunded: ['Estornado', 'r'] };
  function openList() {
    modal('<h3 style="margin:0 0 8px">Pagamentos recentes</h3><div id="rpay-list" class="m">Carregando…</div><div style="margin-top:12px"><button type="button" class="rpay-sbtn" data-a="close">Fechar</button></div>');
    function load() {
      sb.rpc('payments_list', { p_token: tok(), p_limit: 50 }).then(function (r) {
        var el = document.getElementById('rpay-list'); if (!el) return;
        var rows = (r && r.data) || [];
        if (!rows.length) { el.textContent = 'Nenhum pagamento online ainda.'; return; }
        el.innerHTML = '<table><tr><th>Hora</th><th>Mesa</th><th>Valor</th><th>Situação</th></tr>' + rows.map(function (p) {
          var l = LABEL[p.status] || [p.status, ''];
          return '<tr><td>' + esc(dhm(p.paid_at || p.created_at)) + '</td><td>' + esc(p.umbrella_num) + '</td><td>' + esc(brl(p.amount_cents)) + ' · ' + (p.method === 'pix' ? 'Pix' : 'Cartão') + '</td><td><span class="rpay-chip ' + l[1] + '">' + esc(l[0]) + '</span>' +
            (p.validated_at ? ' <span class="rpay-chip g">baixa</span>' : '') + ((p.late_payment || p.needs_review) ? ' <span class="rpay-chip r">conferir</span>' : '') + '</td></tr>';
        }).join('') + '</table>';
      });
    }
    load(); ST.timer = setInterval(load, 20000);
  }

  P.staff = {
    mount: function (grid, kiosk, status) {
      ST.kiosk = kiosk; ST.status = status;
      injectCss(); render(grid);
    }
  };
})();
