/* Recebaa — pagamento online do cliente (Pix + cartão por checkout hospedado) e verificação do comprovante.
 * Só é carregado quando o negócio ligou kiosks.payments_enabled (ou ao abrir um link #comprovante=...).
 * - O VALOR nunca sai daqui: o servidor calcula a partir dos pedidos aceitos (função payment_prepare).
 * - Nenhum dado de cartão passa por esta página: o cartão é pago no checkout hospedado do provedor (redirecionamento).
 * - O QR do comprovante guarda só um token aleatório; a verificação é feita no servidor.
 * Todo texto dinâmico passa por esc(). Sem onclick inline: eventos por data-a + delegação. */
(function () {
  'use strict';
  var P = window.RecebaaPay;
  var esc = function (s) { return (typeof window.esc === 'function') ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function brl(c) { return 'R$ ' + (Number(c || 0) / 100).toFixed(2).replace('.', ','); }
  function hhmm(iso) { try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function dhm(iso) { try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function toast(m) { try { if (typeof window.toast === 'function') window.toast(m); } catch (e) { /* ok */ } }

  // ---------- armazenamento local (só tokens do próprio pagador) ----------
  var KEY = 'rpay:v1:';
  function sget(k) { try { return JSON.parse(localStorage.getItem(KEY + k) || 'null'); } catch (e) { return null; } }
  function sset(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* modo privado */ } }
  function lastKey(kid, umb) { return 'last:' + kid + ':' + umb; }
  function saveRec(rec) { sset('p:' + rec.pid, rec); sset(lastKey(rec.kiosk, rec.umb), rec.pid); }
  function loadRec(pid) { return pid ? sget('p:' + pid) : null; }
  function lastRec(kid, umb) { var pid = sget(lastKey(kid, umb)); return loadRec(pid); }

  // ---------- chamadas ----------
  function fnCall(name, body) {
    return fetch(SUPABASE_URL + '/functions/v1/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }
  function rid() { var a = new Uint8Array(16); crypto.getRandomValues(a); return 'k' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  // ---------- CSS ----------
  function injectCss() {
    if (document.getElementById('rpay-css')) return;
    var st = document.createElement('style'); st.id = 'rpay-css';
    st.textContent =
      '#rpay-bar{background:#ecfdf5;border:1px solid #6ee7b7;border-radius:14px;padding:12px 14px;margin-bottom:12px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
      '#rpay-bar .t{font-size:13px;color:#065f46;line-height:1.35;flex:1;min-width:150px}#rpay-bar .t b{font-size:16px;display:block}' +
      '.rpay-btn{border:0;border-radius:99px;padding:12px 18px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}' +
      '.rpay-btn.pri{background:#059669;color:#fff}.rpay-btn.sec{background:#e2e8f0;color:#0f172a}.rpay-btn.dark{background:#0f172a;color:#fff}.rpay-btn[disabled]{opacity:.55;cursor:default}' +
      '#rpay-modal{position:fixed;inset:0;z-index:99990;background:rgba(15,23,42,.6);display:flex;align-items:flex-end;justify-content:center}' +
      '#rpay-modal .sheet{background:#fff;width:100%;max-width:460px;max-height:94vh;overflow:auto;border-radius:20px 20px 0 0;padding:20px 18px 24px;color:#0f172a;font-size:14px}' +
      '@media(min-width:520px){#rpay-modal{align-items:center}#rpay-modal .sheet{border-radius:20px}}' +
      '#rpay-modal h3{margin:0 0 4px;font-size:18px}#rpay-modal .sub{color:#64748b;font-size:12px;margin-bottom:14px}' +
      '#rpay-modal .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9}#rpay-modal .row.tot{font-weight:800;font-size:17px;border-bottom:0}' +
      '#rpay-modal .opts{display:grid;gap:10px;margin:16px 0 10px}#rpay-modal .note{font-size:11px;color:#64748b;line-height:1.5;margin-top:12px}' +
      '#rpay-modal .qr{text-align:center;margin:10px 0}#rpay-modal .qr svg{max-width:100%;height:auto;border:1px solid #e2e8f0;border-radius:12px}' +
      '#rpay-modal textarea{width:100%;font-size:11px;border:1px solid #cbd5e1;border-radius:10px;padding:8px;resize:none;height:64px;font-family:monospace;box-sizing:border-box}' +
      '#rpay-modal .st{text-align:center;color:#475569;margin:10px 0;font-size:13px}#rpay-modal .ok{color:#059669;font-size:48px;text-align:center;line-height:1}' +
      '#rpay-modal .err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:10px;font-size:13px;margin:10px 0}' +
      '#rpay-modal .acts{display:grid;gap:8px;margin-top:12px}#rpay-modal a{color:#0369a1}' +
      '#rpay-receipt{position:fixed;inset:0;z-index:99991;background:#f8fafc;overflow:auto;padding:24px 16px;text-align:center;font-family:inherit;color:#0f172a}' +
      '#rpay-receipt .card{max-width:420px;margin:0 auto;background:#fff;border-radius:18px;padding:22px;border:2px solid #e2e8f0}' +
      '#rpay-receipt .card.good{border-color:#10b981}#rpay-receipt .card.warn{border-color:#f59e0b}#rpay-receipt .card.bad{border-color:#ef4444}';
    document.head.appendChild(st);
  }

  // ---------- estado ----------
  var S = { kiosk: null, umb: null, quote: null, quoteAt: 0, rec: null, tick: null, clock: null, ticks: 0, busy: false, idem: {}, loading: false };
  // modo de checkout OBRIGATÓRIO: pedidos retidos aguardam o pagamento; a cobrança é só deles (hold) e o valor vem do servidor
  function scopeHold() { var q = S.quote; return !!(q && q.held && q.held.count > 0); }
  function amounts(q) {
    if (q && q.held && q.held.count > 0) return { sub: q.held.subtotal_cents, svc: q.held.service_cents, total: q.held.amount_cents };
    return { sub: q ? q.subtotal_cents : 0, svc: q ? q.service_cents : 0, total: q ? q.amount_cents : 0 };
  }
  var LABELS = { pix: 'Pix', card: 'Cartão', wallet: 'Carteira', pix_direct: 'Pix direto' };
  function word() { return (S.kiosk && S.kiosk.business_type === 'bar_restaurante') ? 'Mesa' : 'Guarda-sol'; }

  function refreshQuote(force) {
    if (!S.kiosk || typeof sb === 'undefined') return Promise.resolve();
    if (!force && S.loading) return Promise.resolve();
    if (!force && Date.now() - S.quoteAt < 8000) return Promise.resolve();
    S.loading = true;
    return sb.rpc('payment_quote', { p_kiosk: S.kiosk.id, p_umbrella: String(S.umb) }).then(function (r) {
      S.quote = (r && r.data) || null; S.quoteAt = Date.now(); S.loading = false;
      watchOrders();
      renderBar();
    }).catch(function () { S.loading = false; });
  }

  // ---------- barra "Pagar agora" na aba de pedidos ----------
  function renderBar(host) {
    host = host || document.getElementById('my-orders-list');
    if (!host) return;
    var old = document.getElementById('rpay-bar'); if (old) old.remove();
    var q = S.quote;
    if (!q || !q.enabled) return;
    var rec = S.rec || lastRec(S.kiosk.id, S.umb);
    var paid = rec && rec.status === 'paid' ? rec : null;
    var live = q.live_payment;
    var html = '';
    var heldQ = q.held && q.held.count > 0 ? q.held : null;
    if (heldQ && !live) {
      html = '<div class="t"><b>Pedido aguardando pagamento</b>' + esc(brl(heldQ.amount_cents)) + '<br><small>Seu pedido só é enviado ao atendente depois do pagamento.</small></div>' +
        '<button type="button" class="rpay-btn pri" data-a="open">Pagar e enviar pedido</button><button type="button" class="rpay-btn sec" data-a="holdcancel">Cancelar pedido</button>';
    } else if (q.amount_cents > 0 && !live) {
      html = '<div class="t"><b>' + esc(brl(q.amount_cents)) + '</b>Pague agora direto no celular' +
        (q.pending_orders ? '<br><small>' + esc(q.pending_orders) + ' pedido(s) aguardando aceite não entram na conta.</small>' : '') + '</div>' +
        '<button type="button" class="rpay-btn pri" data-a="open">💳 Pagar agora</button>';
    } else if (live) {
      var mine = rec && rec.pid === live.id;
      html = '<div class="t"><b>Pagamento em andamento</b>' + esc(brl(live.amount_cents)) + (mine ? '' : ' · iniciado em outro aparelho') + '</div>' +
        (mine ? '<button type="button" class="rpay-btn pri" data-a="resume">Continuar</button>' : '');
    } else if (paid) {
      html = '<div class="t"><b>Conta paga ✅</b>' + esc(brl(paid.amount)) + '</div><button type="button" class="rpay-btn dark" data-a="receipt">🧾 Ver comprovante</button>';
    } else { return; }
    var bar = document.createElement('div'); bar.id = 'rpay-bar'; bar.innerHTML = html;
    if (paid && !live && !(q.amount_cents > 0)) bar.style.background = '#f0f9ff';
    host.insertBefore(bar, host.firstChild);
  }

  document.addEventListener('click', function (e) {
    var t = e.target; while (t && t !== document && !(t.getAttribute && t.getAttribute('data-a') && (t.closest('#rpay-bar') || t.closest('#rpay-modal') || t.closest('#rpay-receipt')))) t = t.parentNode;
    if (!t || t === document) return;
    var a = t.getAttribute('data-a');
    if (a === 'open') openChoose();
    else if (a === 'resume') resume();
    else if (a === 'receipt') showReceipt();
    else if (a === 'close') closeModal();
    else if (a === 'pix') start('pix');
    else if (a === 'card') start('card');
    else if (a === 'pixdirect') start('pix_direct');
    else if (a === 'holdcancel') holdCancel();
    else if (a === 'copy') copyCode();
    else if (a === 'check') checkNow();
    else if (a === 'cancel') cancelPay();
    else if (a === 'retry') openChoose();
    else if (a === 'copylink') copyLink();
    else if (a === 'closereceipt') { var r = document.getElementById('rpay-receipt'); if (r) r.remove(); }
  });

  // ---------- modal ----------
  function modal(inner) {
    injectCss();
    var m = document.getElementById('rpay-modal');
    if (!m) { m = document.createElement('div'); m.id = 'rpay-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
    m.innerHTML = '<div class="sheet">' + inner + '</div>';
    return m;
  }
  function stopTimers() { if (S.tick) { clearInterval(S.tick); S.tick = null; } if (S.clock) { clearInterval(S.clock); S.clock = null; } }
  function closeModal() { stopTimers(); var m = document.getElementById('rpay-modal'); if (m) m.remove(); refreshQuote(true); }

  function openChoose(errMsg) {
    stopTimers();
    var q = S.quote, a = amounts(q), hold = scopeHold();
    if (!q || !q.enabled || !(a.total > 0)) { toast('Não há consumo aceito para pagar agora.'); return; }
    var m = q.methods || { pix: true, card: true, wallet: !!q.wallets_available, pix_direct: false };
    var btns = '';
    if (m.pix) btns += '<button type="button" class="rpay-btn pri" data-a="pix">Pagar com Pix</button>';
    if (m.card) btns += '<button type="button" class="rpay-btn dark" data-a="card">Pagar com cartão</button>';
    if (m.pix_direct) btns += '<button type="button" class="rpay-btn ' + (m.pix ? 'sec' : 'pri') + '" data-a="pixdirect">Pix direto <small>(o atendente confirma)</small></button>';
    if (!btns && !m.wallet) btns = '<div class="err">Nenhuma forma de pagamento está disponível agora. ' + (hold ? 'Seu pedido ainda NÃO foi enviado: cancele e chame o atendente.' : 'Chame o atendente.') + '</div>';
    modal('<h3>' + (hold ? 'Pagar para enviar o pedido' : 'Pagar a conta') + ' · ' + esc(word()) + ' ' + esc(S.umb) + '</h3><div class="sub">' + esc(S.kiosk.name || '') + '</div>' +
      (hold ? '<div class="note" style="margin:0 0 8px"><b>Seu pedido só será enviado ao atendente depois que o pagamento for confirmado.</b></div>' : '') +
      '<div class="row"><span>Consumo</span><span>' + esc(brl(a.sub)) + '</span></div>' +
      (a.svc > 0 ? '<div class="row"><span>Serviço (' + esc(q.service_percent) + '%)</span><span>' + esc(brl(a.svc)) + '</span></div>' : '') +
      '<div class="row tot"><span>Total</span><span>' + esc(brl(a.total)) + '</span></div>' +
      (!hold && q.pending_orders ? '<div class="note">' + esc(q.pending_orders) + ' pedido(s) ainda não aceito(s) pelo atendente ficam de fora e podem ser pagos depois.</div>' : '') +
      (errMsg ? '<div class="err">' + esc(errMsg) + (hold ? ' Seu pedido ainda NÃO foi enviado ao atendente.' : '') + '</div>' : '') +
      (m.wallet ? '<div id="rpay-wallet" class="rpay-wallet" hidden></div>' : '') +
      '<div class="opts">' + btns +
      (hold ? '<button type="button" class="rpay-btn sec" data-a="close">Voltar</button><button type="button" class="rpay-btn sec" data-a="holdcancel">Cancelar pedido</button>' : '<button type="button" class="rpay-btn sec" data-a="close">Voltar</button>') + '</div>' +
      '<div class="note">O pagamento vai direto para ' + esc(S.kiosk.name || 'o estabelecimento') + '. O Recebaa não guarda seu dinheiro e não vê nem armazena dados do seu cartão (o cartão é digitado no ambiente seguro do provedor de pagamento). ' +
      'Ao continuar, você concorda com os <a href="/terms.html" target="_blank" rel="noopener">Termos</a> e a <a href="/privacy.html" target="_blank" rel="noopener">Política de Privacidade</a>.</div>');
    mountWallet(q);
  }

  // ---------- carteiras (Apple Pay / Google Pay via Stripe) [pagamentos] ----------
  // Só se o servidor disse que as carteiras estão ligadas (quote.wallets_available). O wallet.js (e, dele, o stripe.js)
  // só é baixado neste caso, e o botão só aparece se o navegador realmente tiver a carteira.
  function mountWallet(q) {
    if (!q || !(q.wallets_available === true || (q.methods && q.methods.wallet === true))) return;
    var host = document.getElementById('rpay-wallet'); if (!host) return;
    P.load('/wallet.js').then(function () {
      if (!P.wallet || !document.getElementById('rpay-wallet')) return;
      P.wallet.mount(document.getElementById('rpay-wallet'), {
        kioskId: S.kiosk.id, amountCents: amounts(q).total,
        create: walletCreate, paid: walletPaid, failed: walletFailed
      });
    }).catch(function () { /* sem carteira: Pix e cartão continuam */ });
  }
  // cria a cobrança no servidor (valor calculado lá) e devolve o client_secret
  function walletCreate() {
    if (S.busy) return Promise.reject(new Error('Aguarde'));
    S.busy = true;
    var key = S.idem.wallet || (S.idem.wallet = rid());
    return fnCall('create-payment', { kiosk_id: S.kiosk.id, umbrella: Number(S.umb), method: 'wallet', idempotency_key: key, hold: scopeHold() }).then(function (r) {
      S.busy = false;
      var b = r.body || {};
      if (!b.ok) { if (r.status >= 400 && r.status < 500) delete S.idem.wallet; throw new Error(b.message || 'Não foi possível iniciar o pagamento.'); }
      delete S.idem.wallet;
      var p = b.payment;
      var rec = (b.client_token && b.receipt_token)
        ? { pid: p.id, ct: b.client_token, rt: b.receipt_token, kiosk: S.kiosk.id, umb: String(S.umb), method: 'wallet', amount: p.amount_cents, status: 'pending', hold: scopeHold(), ts: Date.now() }
        : loadRec(p.id);
      if (!rec) throw new Error('Este pagamento já foi iniciado em outro aparelho.');
      S.rec = rec; saveRec(rec);
      return { clientSecret: b.client_secret, amountCents: p.amount_cents, returnUrl: location.origin + '/?kiosk=' + encodeURIComponent(S.kiosk.id) + '&umbrella=' + encodeURIComponent(S.umb) + '&rpay=' + encodeURIComponent(p.id) };
    }, function (e) { S.busy = false; throw e; });
  }
  function walletPaid() {
    modal('<h3>Confirmando seu pagamento…</h3><div class="st" id="rpay-st">⏳ Aguarde um instante.</div><div class="acts"><button type="button" class="rpay-btn sec" data-a="check">Já paguei</button></div>');
    startPolling();
  }
  function walletFailed(msg) {
    var rec = S.rec;
    var back = function () { S.quoteAt = 0; refreshQuote(true).then(function () { openChoose(msg || 'Pagamento não concluído. Nada foi cobrado.'); }); };
    if (!rec) return back();
    fnCall('payment-status', { payment_id: rec.pid, client_token: rec.ct, action: 'cancel' }).then(function (r) {
      var st = r.body && r.body.payment;
      if (st && st.status === 'paid') return onStatus(st);
      rec.status = (st && st.status) || 'cancelled'; saveRec(rec); back();
    }).catch(back);
  }

  function start(method) {
    if (S.busy) return;
    S.busy = true;
    var hold = scopeHold(), ik = method + (hold ? ':h' : '');
    var key = S.idem[ik] || (S.idem[ik] = rid());
    modal('<h3>Preparando pagamento…</h3><div class="st">Aguarde um instante.</div>');
    fnCall('create-payment', { kiosk_id: S.kiosk.id, umbrella: Number(S.umb), method: method, idempotency_key: key, hold: hold }).then(function (r) {
      S.busy = false;
      var b = r.body || {};
      if (!b.ok) {
        if (r.status >= 400 && r.status < 500) delete S.idem[ik];   // erro definitivo: próxima tentativa usa chave nova
        openChoose(b.message || 'Não foi possível iniciar o pagamento. Tente novamente.');
        return;
      }
      delete S.idem[ik];
      var p = b.payment;
      var rec = (b.client_token && b.receipt_token)
        ? { pid: p.id, ct: b.client_token, rt: b.receipt_token, kiosk: S.kiosk.id, umb: String(S.umb), method: method, amount: p.amount_cents, status: 'pending', hold: hold, ts: Date.now() }
        : loadRec(p.id);
      if (!rec) { openChoose('Este pagamento já foi iniciado em outro aparelho. Aguarde ele expirar ou chame o atendente.'); return; }
      S.rec = rec; saveRec(rec);
      if (method === 'card' && p.checkout_url) { goCheckout(p.checkout_url); return; }
      showPay(Object.assign({ method: method }, p));
    }).catch(function () { S.busy = false; openChoose('Sem conexão. Verifique a internet e tente de novo.'); });
  }

  function goCheckout(url) {
    modal('<h3>Abrindo o pagamento seguro…</h3><div class="st">Você será levado ao ambiente do provedor para digitar o cartão. Depois do pagamento, volte para esta página.</div>' +
      '<div class="acts"><button type="button" class="rpay-btn sec" data-a="check">Já paguei</button><button type="button" class="rpay-btn sec" data-a="cancel">Cancelar</button></div>');
    startPolling();
    if (/^https:\/\//.test(url)) setTimeout(function () { window.location.href = url; }, 400);
  }

  function showPay(p) {
    var code = p.pix_copy_paste || '';
    P.loadQr().then(function () {
      modal('<h3>Pague com Pix' + (p.method === 'pix_direct' ? ' direto' : '') + '</h3><div class="sub">' + esc(S.kiosk.name || '') + ' · ' + esc(word()) + ' ' + esc(S.umb) + '</div>' +
        '<div class="row tot"><span>Total</span><span>' + esc(brl(p.amount_cents)) + '</span></div>' +
        '<div class="qr">' + (code ? P.qrSvg(code, 220) : '') + '</div>' +
        '<div class="note" style="margin-top:0">Abra o app do seu banco, escolha Pix e leia o QR Code ou use o “copia e cola”.' + (p.method === 'pix_direct' ? '<br><b>Este Pix vai direto para a conta do estabelecimento. Depois de pagar, o atendente confirma o recebimento e esta tela atualiza sozinha.</b>' : '') + '</div>' +
        '<textarea id="rpay-code" readonly aria-label="Código Pix copia e cola"></textarea>' +
        '<div class="acts"><button type="button" class="rpay-btn pri" data-a="copy">📋 Copiar código Pix</button>' +
        '<button type="button" class="rpay-btn sec" data-a="check">Já paguei</button>' +
        '<button type="button" class="rpay-btn sec" data-a="cancel">Cancelar / trocar forma de pagamento</button></div>' +
        '<div class="st" id="rpay-st">' + (p.method === 'pix_direct' ? '⏳ Aguardando o atendente confirmar o pagamento…' : '⏳ Aguardando pagamento…') + ' <span id="rpay-left"></span></div>');
      var ta = document.getElementById('rpay-code'); if (ta) ta.value = code;
      startClock(p.expires_at);
      startPolling();
    }).catch(function () { modal('<h3>Erro</h3><div class="err">Não foi possível exibir o QR Code. Use o código copia e cola.</div><textarea id="rpay-code" readonly></textarea>'); var ta = document.getElementById('rpay-code'); if (ta) ta.value = code; });
  }

  function startClock(expiresAt) {
    if (S.clock) clearInterval(S.clock);
    var end = Date.parse(expiresAt);
    function t() {
      var el = document.getElementById('rpay-left'); if (!el) return;
      var s = Math.max(0, Math.round((end - Date.now()) / 1000));
      el.textContent = '(expira em ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + ')';
    }
    t(); S.clock = setInterval(t, 1000);
  }

  function setStatus(msg) { var el = document.getElementById('rpay-st'); if (el) el.textContent = msg; }

  function startPolling() {
    if (S.tick) clearInterval(S.tick);
    S.ticks = 0;
    S.tick = setInterval(function () { S.ticks++; poll(S.ticks % 5 === 0); }, 3000);
    poll(false);
  }

  function poll(refresh) {
    var rec = S.rec; if (!rec) return Promise.resolve();
    var p = refresh
      ? fnCall('payment-status', { payment_id: rec.pid, client_token: rec.ct, action: 'refresh' }).then(function (r) { return r.body && r.body.payment; })
      : sb.rpc('payment_status', { p_payment_id: rec.pid, p_client_token: rec.ct }).then(function (r) { return r && r.data; });
    return p.then(onStatus).catch(function () { /* rede instável: tenta no próximo ciclo */ });
  }

  function onStatus(st) {
    if (!st || st.found === false) return;
    var rec = S.rec; if (!rec) return;
    if (st.status === 'paid') {
      stopTimers(); rec.status = 'paid'; rec.paid_at = st.paid_at; rec.amount = st.amount_cents; rec.kname = st.kiosk_name; saveRec(rec);
      showReceiptInModal(st);
      refreshQuote(true);
    } else if (['expired', 'failed', 'cancelled', 'refunded'].indexOf(st.status) > -1) {
      stopTimers(); rec.status = st.status; saveRec(rec);
      var msg = { expired: 'O tempo para pagar acabou.', failed: 'O pagamento não foi concluído.', cancelled: 'Pagamento cancelado.', refunded: 'Pagamento estornado.' }[st.status];
      modal('<h3>' + esc(msg) + '</h3><div class="st">Nada foi cobrado.' + (st.status === 'refunded' ? ' O valor foi devolvido pelo provedor.' : '') + '</div>' +
        '<div class="acts"><button type="button" class="rpay-btn pri" data-a="retry">Tentar de novo</button><button type="button" class="rpay-btn sec" data-a="close">Fechar</button></div>');
    } else { setStatus('⏳ Aguardando pagamento…'); }
  }

  function checkNow() { setStatus('Verificando…'); poll(true).then(function () { setTimeout(function () { var el = document.getElementById('rpay-st'); if (el && el.textContent === 'Verificando…') setStatus('Ainda não identificamos o pagamento. Aguarde alguns segundos.'); }, 1500); }); }

  function cancelPay() {
    var rec = S.rec; if (!rec) return closeModal();
    stopTimers();
    fnCall('payment-status', { payment_id: rec.pid, client_token: rec.ct, action: 'cancel' }).then(function (r) {
      var st = r.body && r.body.payment;
      if (st && st.status === 'paid') return onStatus(st);          // pagou no meio do cancelamento
      rec.status = (st && st.status) || 'cancelled'; saveRec(rec);
      S.quoteAt = 0; refreshQuote(true).then(function () { openChoose(); });
    }).catch(function () { toast('Não foi possível cancelar agora.'); startPolling(); });
  }

  function copyCode() {
    var ta = document.getElementById('rpay-code'); if (!ta) return;
    var done = function () { toast('✅ Código Pix copiado!'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done).catch(function () { ta.select(); try { document.execCommand('copy'); done(); } catch (e) { /* ok */ } });
    else { ta.select(); try { document.execCommand('copy'); done(); } catch (e) { /* ok */ } }
  }

  function resume() {
    var rec = S.rec || lastRec(S.kiosk.id, S.umb);
    if (!rec) return;
    S.rec = rec;
    sb.rpc('payment_status', { p_payment_id: rec.pid, p_client_token: rec.ct }).then(function (r) {
      var st = r && r.data;
      if (!st || !st.found) { toast('Pagamento não encontrado.'); return; }
      if (st.status === 'paid') return onStatus(st);
      if (['created', 'pending'].indexOf(st.status) > -1) {
        if ((st.method === 'pix' || st.method === 'pix_direct') && st.pix_copy_paste) return showPay({ method: st.method, amount_cents: st.amount_cents, expires_at: st.expires_at, pix_copy_paste: st.pix_copy_paste });
        if (st.checkout_url) return goCheckout(st.checkout_url);
        if (st.method === 'wallet') { return walletPaid(); }
      }
      onStatus(st);
    });
  }

  // ---------- modo obrigatório: cancelar o pedido retido, abrir o checkout assim que o pedido é enviado ----------
  function holdCancel() {
    if (!confirm('Cancelar o pedido que ainda não foi pago?')) return;
    sb.rpc('read_orders', { p_token: null, p_kiosk: S.kiosk.id, p_umbrella: String(S.umb), p_filters: [], p_order: 'created_at desc', p_limit: 50, p_items: false }).then(function (r) {
      var rows = (r && r.data) || [];
      var held = rows.filter(function (o) { return o.payment_hold && !o.hold_released_at && o.status === 'pending'; });
      return Promise.all(held.map(function (o) { return sb.rpc('client_cancel_order', { p_order_id: o.id }); }));
    }).then(function () {
      toast('Pedido cancelado.'); stopTimers();
      var m = document.getElementById('rpay-modal'); if (m) m.remove();
      S.quoteAt = 0; refreshQuote(true);
    }).catch(function () { toast('Não foi possível cancelar agora.'); });
  }
  // Sem alterar o index.html: observa o envio dos itens do pedido (add_order_items) e, no modo obrigatório, abre o pagamento na hora.
  var watching = false;
  function watchOrders() {
    if (watching || !S.quote || S.quote.checkout_mode !== 'required' || typeof sb === 'undefined' || typeof sb.rpc !== 'function') return;
    watching = true;
    var orig = sb.rpc.bind(sb);
    sb.rpc = function (name, args) {
      var pr = orig(name, args);
      if (name === 'add_order_items') {
        // o retorno do supabase-js é um "thenable" que DISPARA a requisição a cada .then(): consumir uma única vez
        // e devolver a promessa já resolvida, senão o RPC rodaria duas vezes (itens duplicados)
        var real = Promise.resolve(pr);
        real.then(function (r) {
          if (r && !r.error) setTimeout(function () {
            S.quoteAt = 0;
            refreshQuote(true).then(function () { if (scopeHold() && !(S.quote && S.quote.live_payment) && !document.getElementById('rpay-modal')) openChoose(); });
          }, 400);
        }).catch(function () { /* ok */ });
        return real;
      }
      return pr;
    };
  }

  // ---------- comprovante (QR) ----------
  function receiptUrl(rt) { return location.origin + '/#comprovante=' + rt; }
  function receiptHtml(rec, st) {
    return '<div class="ok">✅</div><h3 style="text-align:center">Pagamento confirmado</h3>' +
      '<div style="text-align:center;font-size:26px;font-weight:800;margin:6px 0">' + esc(brl(st.amount_cents != null ? st.amount_cents : rec.amount)) + '</div>' +
      '<div class="sub" style="text-align:center">' + esc(st.kiosk_name || rec.kname || '') + ' · ' + esc(word()) + ' ' + esc(rec.umb) + ' · ' + esc(dhm(st.paid_at || rec.paid_at)) + '</div>' +
      '<div class="qr">' + P.qrSvg(receiptUrl(rec.rt), 230) + '</div>' +
      (rec.hold ? '<div class="note" style="text-align:center"><b>Pedido enviado ao atendente.</b></div>' : '') + '<div class="note" style="text-align:center;margin-top:0"><b>Mostre este QR ao atendente.</b> Ele confirma no sistema que o pagamento foi feito. Dica: tire uma captura de tela.</div>';
  }
  function showReceiptInModal(st) {
    var rec = S.rec;
    P.loadQr().then(function () {
      modal(receiptHtml(rec, st) + '<div class="acts"><button type="button" class="rpay-btn sec" data-a="copylink">Copiar link do comprovante</button><button type="button" class="rpay-btn pri" data-a="close">Fechar</button></div>');
    });
  }
  function showReceipt() {
    var rec = S.rec || lastRec(S.kiosk.id, S.umb); if (!rec) return;
    S.rec = rec;
    sb.rpc('payment_status', { p_payment_id: rec.pid, p_client_token: rec.ct }).then(function (r) {
      var st = (r && r.data && r.data.found) ? r.data : { amount_cents: rec.amount, paid_at: rec.paid_at, kiosk_name: rec.kname };
      showReceiptInModal(st);
    });
  }
  function copyLink() {
    var rec = S.rec; if (!rec) return;
    if (navigator.clipboard) navigator.clipboard.writeText(receiptUrl(rec.rt)).then(function () { toast('✅ Link copiado!'); });
  }

  // ---------- verificação (quem escaneia o QR) ----------
  var receiptView = {
    fromHash: function () {
      var m = /(?:^#|&)comprovante=([A-Za-z0-9_-]{20,200})/.exec(location.hash);
      if (!m) return;
      var token = m[1];
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ok */ }
      injectCss();
      var ov = document.createElement('div'); ov.id = 'rpay-receipt';
      ov.innerHTML = '<div class="card"><div class="st">Verificando comprovante…</div></div>';
      document.body.appendChild(ov);
      var staff = window._sessToken
        ? sb.rpc('verify_payment_receipt', { p_token: window._sessToken, p_receipt: token, p_mark: true })
        : null;
      Promise.resolve(staff).then(function (sr) {
        if (sr && sr.data && sr.data.valid !== undefined && !sr.error) return { staff: sr.data };
        return sb.rpc('receipt_public_check', { p_receipt: token }).then(function (pr) { return { pub: pr && pr.data }; });
      }).then(function (res) {
        var c = ov.querySelector('.card'), cls, body;
        if (res.staff) {
          var d = res.staff;
          if (d.valid && d.already_validated) { cls = 'warn'; body = '<div style="font-size:42px">⚠️</div><h3>Comprovante JÁ UTILIZADO</h3><div class="sub">Primeira baixa em ' + esc(dhm(d.validated_at)) + ' (' + esc(d.validation_count) + 'ª verificação)</div>'; }
          else if (d.valid) { cls = 'good'; body = '<div style="font-size:42px">✅</div><h3>PAGO — baixa registrada</h3>'; }
          else { cls = 'bad'; body = '<div style="font-size:42px">❌</div><h3>Comprovante inválido</h3><div class="sub">' + esc({ not_found: 'Não encontrado neste estabelecimento.', pending: 'Pagamento ainda não confirmado.', expired: 'Pagamento expirado.', refunded: 'Pagamento estornado.', cancelled: 'Pagamento cancelado.', failed: 'Pagamento não concluído.' }[d.reason] || '') + '</div>'; }
          if (d.valid || d.amount_cents) body += '<div style="font-size:28px;font-weight:800;margin:8px 0">' + esc(brl(d.amount_cents)) + '</div><div class="sub">Mesa/guarda-sol ' + esc(d.umbrella_num) + (d.paid_at ? ' · pago em ' + esc(dhm(d.paid_at)) : '') + '</div>';
        } else {
          var p = res.pub || {};
          if (p.valid) { cls = 'good'; body = '<div style="font-size:42px">✅</div><h3>Pagamento confirmado</h3><div style="font-size:28px;font-weight:800;margin:8px 0">' + esc(brl(p.amount_cents)) + '</div><div class="sub">' + esc(p.kiosk_name) + ' · mesa/guarda-sol ' + esc(p.umbrella_num) + ' · ' + esc(dhm(p.paid_at)) + '</div>' + (p.validated_at ? '<div class="note">Este comprovante já foi conferido pelo estabelecimento em ' + esc(dhm(p.validated_at)) + '.</div>' : '') + '<div class="note">Para dar baixa, o estabelecimento usa “Validar comprovante” no painel.</div>'; }
          else { cls = 'bad'; body = '<div style="font-size:42px">❌</div><h3>Comprovante inválido</h3><div class="sub">Não encontrado ou pagamento não confirmado.</div>'; }
        }
        c.className = 'card ' + cls;
        c.innerHTML = body + '<div class="acts"><button type="button" class="rpay-btn dark" data-a="closereceipt">Fechar</button></div>';
      }).catch(function () { ov.querySelector('.card').innerHTML = '<div class="err">Não foi possível verificar agora. Tente novamente.</div><div class="acts"><button type="button" class="rpay-btn dark" data-a="closereceipt">Fechar</button></div>'; });
    }
  };

  // ---------- inicialização ----------
  var client = {
    init: function (kiosk, umb) {
      S.kiosk = kiosk; S.umb = umb; S.quote = null; S.quoteAt = 0; S.rec = null;
      injectCss();
      refreshQuote(true);
      // volta do checkout do cartão: ?rpay=<id>
      try {
        var sp = new URLSearchParams(location.search), rp = sp.get('rpay');
        if (rp) {
          sp.delete('rpay');
          history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp.toString() : ''));
          var rec = loadRec(rp);
          if (rec && rec.kiosk === kiosk.id) { S.rec = rec; modal('<h3>Confirmando seu pagamento…</h3><div class="st" id="rpay-st">⏳ Aguarde um instante.</div><div class="acts"><button type="button" class="rpay-btn sec" data-a="check">Já paguei</button><button type="button" class="rpay-btn sec" data-a="close">Fechar</button></div>'); startPolling(); }
        }
      } catch (e) { /* ok */ }
    },
    afterMyOrders: function (el) {
      if (!S.kiosk) return;
      renderBar(el);
      refreshQuote(false);
    }
  };
  P.client = client;
  P.receiptView = receiptView;
})();
