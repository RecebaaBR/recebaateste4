/* Recebaa — aba "Pagamentos" do painel do dono (area separada, [pagamentos]).
 * Carregada por payments-staff.js SOMENTE para o dono de um negócio liberado pela plataforma.
 * Seções: Ajustes (liga/desliga, modo de checkout), Contas e Pix (conexões + chave Pix), Pagamentos (lista, detalhe, ações, CSV).
 * Segurança: nenhum segredo no navegador (conexões mostram só estado e final da conta); toda leitura/escrita passa por funções
 * SECURITY DEFINER que exigem sessão de DONO; todo texto dinâmico passa por esc(); sem onclick inline (data-a + delegação). */
(function () {
  'use strict';
  var P = window.RecebaaPay; if (!P) return;
  var esc = function (s) { return (typeof window.esc === 'function') ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function brl(c) { return 'R$ ' + (Number(c || 0) / 100).toFixed(2).replace('.', ','); }
  function dhm(iso) { try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function toast(m) { try { if (typeof window.toast === 'function') window.toast(m); } catch (e) { /* ok */ } }
  function tok() { return window._sessToken; }

  var PAGE = 25;
  var ST = { tab: 'ajustes', cfg: null, kill: null, rows: [], total: 0, totals: {}, offset: 0, filters: {}, busy: false, mounted: false };
  var METHOD = { pix: 'Pix online', card: 'Cartão', wallet: 'Carteira', pix_direct: 'Pix direto' };
  var STATE = { created: 'Criado', pending: 'Pendente', paid: 'Pago', expired: 'Expirado', cancelled: 'Cancelado', refunded: 'Estornado', failed: 'Falhou' };
  var KEYTYPE = { cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', phone: 'Telefone', random: 'Chave aleatória' };

  function rpc(name, args) {
    return sb.rpc(name, Object.assign({ p_token: tok() }, args || {})).then(function (r) {
      if (r.error) { toast('⚠️ ' + r.error.message); return null; }
      return r.data;
    });
  }
  function hdr() { return { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }; }
  function oauth(action) {
    return fetch(SUPABASE_URL + '/functions/v1/payments-oauth', { method: 'POST', headers: hdr(), body: JSON.stringify({ action: action, session_token: tok() }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j = j || {}; j._status = r.status; return j; }); });
  }

  function injectCss() {
    if (document.getElementById('rpay-css-panel')) return;
    var st = document.createElement('style'); st.id = 'rpay-css-panel';
    st.textContent =
      '#rpay-pp{max-width:980px}#rpay-pp h2{margin:0 0 4px;font-size:20px}#rpay-pp .sub{font-size:12px;color:#64748b;margin-bottom:12px}' +
      '#rpay-pp .tabs{display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap}#rpay-pp .tabs button{border:0;border-radius:99px;padding:8px 14px;font-weight:600;font-size:13px;cursor:pointer;background:#e2e8f0;color:#0f172a;font-family:inherit}#rpay-pp .tabs button.on{background:#0f172a;color:#fff}' +
      '#rpay-pp .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px;margin-bottom:12px}#rpay-pp .card h4{margin:0 0 6px;font-size:14px}' +
      '#rpay-pp .m{font-size:12px;color:#64748b;line-height:1.5}#rpay-pp .row{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f1f5f9;flex-wrap:wrap}#rpay-pp .row:last-child{border-bottom:0}' +
      '#rpay-pp .why{font-size:11.5px;color:#92400e;background:#fffbeb;border-radius:8px;padding:4px 8px;margin-top:4px;display:inline-block}' +
      '#rpay-pp .ban{border-radius:12px;padding:10px 14px;margin-bottom:12px;font-size:13px;line-height:1.5}#rpay-pp .ban.r{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}#rpay-pp .ban.y{background:#fffbeb;border:1px solid #fde68a;color:#92400e}#rpay-pp .ban.g{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}' +
      '#rpay-pp .b{border:0;border-radius:10px;padding:9px 14px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;background:#e2e8f0;color:#0f172a}#rpay-pp .b.pri{background:#059669;color:#fff}#rpay-pp .b.dk{background:#0f172a;color:#fff}#rpay-pp .b.red{background:#fee2e2;color:#991b1b}#rpay-pp .b[disabled]{opacity:.45;cursor:not-allowed}' +
      '#rpay-pp .chip{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;background:#e2e8f0;color:#334155}#rpay-pp .chip.g{background:#d1fae5;color:#065f46}#rpay-pp .chip.y{background:#fef3c7;color:#92400e}#rpay-pp .chip.r{background:#fee2e2;color:#991b1b}' +
      '#rpay-pp input,#rpay-pp select{padding:9px;border:1px solid #cbd5e1;border-radius:10px;font-size:13px;font-family:inherit;box-sizing:border-box;max-width:100%}' +
      '#rpay-pp .frm{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:8px}#rpay-pp .frm label{font-size:11px;color:#64748b;display:grid;gap:3px}' +
      '#rpay-pp .tw{overflow-x:auto}#rpay-pp table{width:100%;border-collapse:collapse;font-size:12px;min-width:640px}#rpay-pp td,#rpay-pp th{padding:7px 5px;border-bottom:1px solid #f1f5f9;text-align:left;white-space:nowrap}#rpay-pp tr.clk{cursor:pointer}#rpay-pp tr.clk:hover{background:#f8fafc}' +
      '#rpay-pp .tot{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}#rpay-pp .tot div{background:#f8fafc;border-radius:10px;padding:8px 12px;font-size:12px}#rpay-pp .tot b{display:block;font-size:15px}' +
      '#rpay-pm{position:fixed;inset:0;z-index:99993;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:12px}#rpay-pm .sheet{background:#fff;border-radius:18px;width:100%;max-width:520px;max-height:92vh;overflow:auto;padding:18px;color:#0f172a;font-size:14px}' +
      '#rpay-pm .kv{display:grid;grid-template-columns:130px 1fr;gap:4px 8px;font-size:13px;margin:10px 0}#rpay-pm .kv span:nth-child(odd){color:#64748b}#rpay-pm .b{border:0;border-radius:10px;padding:9px 14px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;background:#e2e8f0;color:#0f172a;margin:2px}#rpay-pm .b.pri{background:#059669;color:#fff}#rpay-pm .b.red{background:#fee2e2;color:#991b1b}' +
      '#rpay-pm .qr{text-align:center;margin:10px 0}#rpay-pm .ev{font-size:12px;color:#475569;margin:0;padding-left:16px}';
    document.head.appendChild(st);
  }

  // ---------- montagem (idempotente) ----------
  function mount(status) {
    if (window._isWaiterMode || !status || status.role !== 'kiosk' || !status.available) return;
    if (document.getElementById('rpay-panel-nav')) return;
    injectCss();
    var reports = document.getElementById('kpage-reports');
    var nav = null; var btns = document.querySelectorAll('#kiosk-dash .s-item');
    for (var i = 0; i < btns.length; i++) { if ((btns[i].getAttribute('onclick') || '').indexOf("'reports'") > -1) nav = btns[i]; }
    if (!reports || !nav) return;
    var page = document.createElement('div'); page.className = 'kpage'; page.id = 'kpage-pagamentos';
    page.innerHTML = '<div id="rpay-pp"></div>';
    reports.parentNode.insertBefore(page, reports.nextSibling);
    var b = document.createElement('button'); b.className = 's-item'; b.id = 'rpay-panel-nav'; b.type = 'button';
    b.innerHTML = '<span class="s-icon">💳</span>Pagamentos';
    b.addEventListener('click', function () { if (typeof window.kPage === 'function') window.kPage('pagamentos', b); open(); });
    nav.parentNode.insertBefore(b, nav.nextSibling);
    page.addEventListener('click', onClick);
    page.addEventListener('change', onChange);
    ST.mounted = true;
  }
  function root() { return document.getElementById('rpay-pp'); }

  function open() { refresh().then(draw); }
  function refresh() {
    return Promise.all([
      rpc('payments_panel_get'),
      oauth('global_status').then(function (j) { ST.kill = (j._status === 503) ? 'off' : (j.ok ? 'on' : 'unknown'); }).catch(function () { ST.kill = 'unknown'; })
    ]).then(function (r) { if (r[0]) ST.cfg = r[0]; });
  }

  // ---------- desenho ----------
  function draw() {
    var el = root(); if (!el) return;
    var c = ST.cfg;
    var h = '<h2>💳 Pagamentos</h2><div class="sub">Pagamentos online do seu negócio. O dinheiro cai direto na sua conta; o Recebaa não guarda valores.</div>';
    if (!c) { el.innerHTML = h + '<div class="card m">Carregando…</div>'; return; }
    if (ST.kill === 'off') h += '<div class="ban r"><b>Pagamentos online desligados pela plataforma.</b> Nenhum cliente consegue pagar agora (chave geral). Seus pedidos continuam funcionando normalmente, sem pagamento.</div>';
    if (c.platform_blocked) h += '<div class="ban r"><b>Bloqueado pela plataforma.</b> Fale com o suporte do Recebaa. Os pedidos seguem normais, sem pagamento online.</div>';
    h += '<div class="tabs">' + [['ajustes', 'Ajustes'], ['contas', 'Contas e Pix'], ['lista', 'Pagamentos']].map(function (t) {
      return '<button type="button" data-a="tab" data-t="' + t[0] + '" class="' + (ST.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    h += '<div id="rpay-sec"></div>';
    el.innerHTML = h;
    var sec = document.getElementById('rpay-sec');
    if (ST.tab === 'ajustes') sec.innerHTML = secAjustes();
    else if (ST.tab === 'contas') sec.innerHTML = secContas();
    else { sec.innerHTML = secLista(); if (!ST.rows.length && !ST.loaded) loadList(0); else fillList(); }
  }

  function toggleRow(key, label, desc, on, reason, extraChip) {
    return '<div class="row"><div style="flex:1;min-width:200px"><b>' + esc(label) + '</b> ' + (extraChip || '') + '<div class="m">' + esc(desc) + '</div>' +
      (reason ? '<div class="why">' + esc(reason) + '</div>' : '') + '</div>' +
      '<button type="button" class="b ' + (on ? 'red' : 'pri') + '" data-a="sw" data-k="' + esc(key) + '" data-v="' + (on ? '0' : '1') + '"' + ((reason && !on) ? ' disabled' : '') + '>' + (on ? 'Desligar' : 'Ligar') + '</button></div>';
  }
  function eff(ok) { return ok ? '<span class="chip g">disponível ao cliente</span>' : '<span class="chip">indisponível</span>'; }

  function secAjustes() {
    var c = ST.cfg, m = c.methods || {}, e = c.effective || {}, r = c.reasons || {};
    var h = '';
    if (c.checkout_mode === 'required') {
      h += '<div class="ban y"><b>Modo atual: pagamento obrigatório por pedido.</b> Pedidos novos ficam em espera até o pagamento ser confirmado' +
        (c.held_orders ? ' (<b>' + esc(c.held_orders) + '</b> em espera agora)' : '') + '. Se algo der errado, volte para o modo opcional.' +
        '<div style="margin-top:8px"><button type="button" class="b dk" data-a="mode" data-v="optional">Voltar para opcional agora</button></div></div>';
    }
    h += '<div class="card"><h4>Chaves de pagamento</h4><div class="m">Cada forma de pagamento tem a sua chave. O cliente só vê o que está ligado <b>e</b> liberado pela plataforma.</div>' +
      toggleRow('payments_enabled', 'Pagamentos online (geral)', 'Liga ou desliga todo o pagamento pelo celular neste negócio.', !!c.general_enabled, r.general, eff(e.pix || e.card || e.wallet || e.pix_direct)) +
      toggleRow('pix_online', 'Pix online (Mercado Pago)', 'Pix com confirmação automática.', !!m.pix_online, r.pix_online, eff(e.pix)) +
      toggleRow('card', 'Cartão (Mercado Pago)', 'Crédito e débito pelo celular do cliente.', !!m.card, r.card, eff(e.card)) +
      toggleRow('wallets', 'Apple Pay / Google Pay (Stripe)', 'Carteiras do celular. Exige conta Stripe conectada.', !!m.wallets, r.wallets, eff(e.wallet)) +
      toggleRow('pix_direct', 'Pix direto (sua chave Pix)', 'Pix para a sua chave, sem intermediário. A baixa é manual: o atendente confirma que o dinheiro caiu.', !!m.pix_direct, r.pix_direct, eff(e.pix_direct)) +
      '</div>';
    var req = c.checkout_mode === 'required';
    h += '<div class="card"><h4>Quando o cliente paga</h4>' +
      '<div class="row"><div style="flex:1;min-width:220px"><b>Opcional</b> ' + (!req ? '<span class="chip g">atual</span>' : '') + '<div class="m">O pedido vai direto ao atendente. Pagar pelo celular é uma opção do cliente. É o modo padrão e o mais seguro.</div></div>' +
      '<button type="button" class="b" data-a="mode" data-v="optional"' + (!req ? ' disabled' : '') + '>Usar</button></div>' +
      '<div class="row"><div style="flex:1;min-width:220px"><b>Obrigatório por pedido</b> ' + (req ? '<span class="chip y">atual</span>' : '') + '<div class="m">O pedido só aparece para o atendente depois do pagamento confirmado. Pedidos sem pagamento ficam em espera por 30 minutos e depois são descartados.</div>' +
      (r.required ? '<div class="why">' + esc(r.required) + '</div>' : '') + '</div>' +
      '<button type="button" class="b pri" data-a="mode" data-v="required"' + ((req || r.required) ? ' disabled' : '') + '>Usar</button></div></div>';
    if (c.audit && c.audit.length) {
      h += '<div class="card"><h4>Últimas alterações</h4><div class="m">' + c.audit.map(function (a) {
        return esc(dhm(a.at)) + ' · ' + esc(auditLabel(a)) + (a.by_role ? ' (' + esc(a.by_role === 'kiosk' ? 'dono' : a.by_role) + ')' : '');
      }).join('<br>') + '</div></div>';
    }
    return h;
  }
  function auditLabel(a) {
    if (a.kind === 'pix_key_set') return 'Chave Pix cadastrada/alterada';
    if (a.kind === 'pix_key_cleared') return 'Chave Pix removida';
    if (a.kind === 'config_changed') {
      var ks = a.changes ? Object.keys(a.changes).map(function (k) { var v = a.changes[k]; return k === 'checkout_mode' ? 'modo ' + (v === 'required' ? 'obrigatório' : 'opcional') : k + ' ' + (v ? 'ligado' : 'desligado'); }) : [];
      return 'Ajuste: ' + ks.join(', ');
    }
    return a.kind;
  }

  function connRow(name, st, connectA, disconnectA) {
    var chip = st.state === 'connected' ? '<span class="chip g">Conectado ' + esc(st.account || '') + '</span>' : st.state === 'sandbox' ? '<span class="chip y">Conectado (TESTE) ' + esc(st.account || '') + '</span>' : st.state === 'pending' ? '<span class="chip y">Conexão em andamento</span>' : '<span class="chip">Não conectado</span>';
    var on = st.state === 'connected' || st.state === 'sandbox';
    return '<div class="row"><div style="flex:1"><b>' + esc(name) + '</b> ' + chip + '</div>' +
      (on ? '<button type="button" class="b red" data-a="' + disconnectA + '">Desconectar</button>' : '<button type="button" class="b pri" data-a="' + connectA + '">Conectar</button>') + '</div>';
  }
  function secContas() {
    var c = ST.cfg, cn = c.connections || {}, pk = c.pix_key;
    var h = '<div class="card"><h4>Contas de pagamento</h4><div class="m">A conexão acontece no site do provedor: o Recebaa nunca vê a sua senha e o painel nunca mostra chaves de acesso, só o estado e o final da conta.</div>' +
      connRow('Mercado Pago (Pix online e cartão)', cn.mercadopago || {}, 'connect', 'disconnect') +
      connRow('Stripe (Apple Pay e Google Pay)', cn.stripe || {}, 'wconnect', 'wdisconnect') + '</div>';
    h += '<div class="card"><h4>Pix direto: sua chave Pix</h4><div class="m">O cliente paga para a sua chave por um QR Code Pix. Como o banco não avisa o Recebaa, o atendente confirma o recebimento com <b>“Marcar como pago”</b> (fica registrado quem marcou e quando).</div>';
    if (pk) h += '<div class="m" style="margin-top:8px">Chave atual: <b>' + esc(KEYTYPE[pk.type] || pk.type) + '</b> ' + esc(mask(pk.type, pk.value)) + ' · ' + esc(pk.name) + ' · ' + esc(pk.city) + '</div>';
    h += '<div class="frm"><label>Tipo da chave<select id="rpay-kt">' + Object.keys(KEYTYPE).map(function (k) { return '<option value="' + k + '"' + (pk && pk.type === k ? ' selected' : '') + '>' + KEYTYPE[k] + '</option>'; }).join('') + '</select></label>' +
      '<label>Chave<input id="rpay-kv" type="text" autocomplete="off" placeholder="' + (pk ? 'digite para trocar' : 'sua chave Pix') + '"></label>' +
      '<label>Nome do beneficiário (até 25)<input id="rpay-kn" type="text" maxlength="25" value="' + esc(pk ? pk.name : '') + '"></label>' +
      '<label>Cidade (até 15)<input id="rpay-kc" type="text" maxlength="15" value="' + esc(pk ? pk.city : '') + '"></label></div>' +
      '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="b pri" data-a="pixsave">Salvar chave Pix</button>' +
      (pk ? '<button type="button" class="b red" data-a="pixclear">Remover chave</button>' : '') + '</div></div>';
    return h;
  }
  function mask(type, v) {
    v = String(v || ''); if (type === 'email') { var i = v.indexOf('@'); return v.slice(0, 2) + '…' + (i > -1 ? v.slice(i) : ''); }
    return v.length > 6 ? v.slice(0, 3) + '…' + v.slice(-3) : v;
  }

  function secLista() {
    var f = ST.filters;
    return '<div class="card"><h4>Filtros</h4><div class="frm">' +
      '<label>De<input type="date" id="rpay-f-from" value="' + esc(f.from_d || '') + '"></label>' +
      '<label>Até<input type="date" id="rpay-f-to" value="' + esc(f.to_d || '') + '"></label>' +
      '<label>Mesa<input type="text" id="rpay-f-umb" inputmode="numeric" maxlength="6" value="' + esc(f.umbrella || '') + '"></label>' +
      '<label>Método<select id="rpay-f-meth"><option value="">Todos</option>' + Object.keys(METHOD).map(function (k) { return '<option value="' + k + '"' + (f.method === k ? ' selected' : '') + '>' + METHOD[k] + '</option>'; }).join('') + '</select></label>' +
      '<label>Estado<select id="rpay-f-st"><option value="">Todos</option>' +
      [['pending', 'Pendente'], ['paid', 'Pago'], ['expired', 'Expirado'], ['cancelled', 'Cancelado'], ['refunded', 'Estornado'], ['failed', 'Falhou'], ['review', 'Conferir']].map(function (o) { return '<option value="' + o[0] + '"' + (f.state === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div>' +
      '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="b dk" data-a="filter">Filtrar</button><button type="button" class="b" data-a="clear">Limpar</button><button type="button" class="b" data-a="csv">Baixar CSV</button></div></div>' +
      '<div id="rpay-tot"></div><div class="card"><div class="tw" id="rpay-tbl"><div class="m">Carregando…</div></div><div id="rpay-pg" style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div></div>';
  }
  function apiFilters() {
    var f = ST.filters, o = {};
    if (f.from_d) o.from = new Date(f.from_d + 'T00:00:00').toISOString();
    if (f.to_d) { var d = new Date(f.to_d + 'T00:00:00'); d.setDate(d.getDate() + 1); o.to = d.toISOString(); }
    if (f.umbrella) o.umbrella = f.umbrella;
    if (f.method) o.method = f.method;
    if (f.state) o.state = f.state;
    return o;
  }
  function loadList(off) {
    ST.offset = off; ST.loaded = true;
    return rpc('payments_search', { p_filters: apiFilters(), p_limit: PAGE, p_offset: off }).then(function (d) {
      if (!d) return;
      ST.rows = d.rows || []; ST.total = d.total || 0; ST.totals = d.totals || {}; fillList();
    });
  }
  function stateLabel(p) {
    var s = STATE[p.status] || p.status;
    return '<span class="chip ' + (p.status === 'paid' ? 'g' : (p.status === 'pending' || p.status === 'created') ? 'y' : '') + '">' + esc(s) + '</span>' +
      (p.needs_review ? ' <span class="chip r">conferir</span>' : '') + (p.manual ? ' <span class="chip">manual</span>' : '');
  }
  function fillList() {
    var t = document.getElementById('rpay-tbl'); if (!t) return;
    var tt = ST.totals || {};
    var paid = tt.paid || { count: 0, cents: 0 }, pen = tt.pending || { count: 0, cents: 0 }, rev = tt.review || { count: 0, cents: 0 };
    document.getElementById('rpay-tot').innerHTML = '<div class="tot"><div>Pagos<b>' + esc(brl(paid.cents)) + '</b>' + esc(paid.count) + ' pagamento(s)</div><div>Pendentes<b>' + esc(brl(pen.cents)) + '</b>' + esc(pen.count) + '</div><div>Para conferir<b>' + esc(rev.count) + '</b>' + esc(brl(rev.cents)) + '</div></div>';
    if (!ST.rows.length) t.innerHTML = '<div class="m">Nenhum pagamento neste filtro.</div>';
    else t.innerHTML = '<table><tr><th>Data</th><th>Mesa</th><th>Método</th><th>Valor</th><th>Estado</th></tr>' + ST.rows.map(function (p) {
      return '<tr class="clk" data-a="detail" data-id="' + esc(p.id) + '"><td>' + esc(dhm(p.created_at)) + '</td><td>' + esc(p.umbrella_num) + '</td><td>' + esc(METHOD[p.method] || p.method) + '</td><td>' + esc(brl(p.status === 'paid' ? p.paid_amount_cents : p.amount_cents)) + '</td><td>' + stateLabel(p) + '</td></tr>';
    }).join('') + '</table>';
    var from = ST.total ? ST.offset + 1 : 0, to = Math.min(ST.offset + PAGE, ST.total);
    document.getElementById('rpay-pg').innerHTML = '<button type="button" class="b" data-a="prev"' + (ST.offset <= 0 ? ' disabled' : '') + '>‹ Anterior</button><span class="m">' + esc(from) + '–' + esc(to) + ' de ' + esc(ST.total) + '</span><button type="button" class="b" data-a="next"' + (to >= ST.total ? ' disabled' : '') + '>Próxima ›</button>';
  }

  // ---------- detalhe e ações ----------
  function closeM() { var m = document.getElementById('rpay-pm'); if (m) m.remove(); }
  function showM(inner) {
    closeM();
    var m = document.createElement('div'); m.id = 'rpay-pm'; m.innerHTML = '<div class="sheet">' + inner + '</div>';
    m.addEventListener('click', function (e) {
      if (e.target === m) return closeM();
      var t = e.target; while (t && t !== m && !(t.getAttribute && t.getAttribute('data-a'))) t = t.parentNode;
      if (!t || t === m) return;
      var a = t.getAttribute('data-a'), id = t.getAttribute('data-id');
      if (a === 'mclose') closeM();
      else if (a === 'mcancel') { if (confirm('Cancelar esta cobrança pendente? O cliente não poderá mais pagá-la.')) act('payment_owner_cancel', id, 'Cobrança cancelada.'); }
      else if (a === 'mresolve') act('payment_review_resolve', id, 'Marcado como conferido.');
      else if (a === 'mmark') { if (confirm('Confirma que o Pix já caiu na sua conta?\n\nA baixa fica registrada com autor e hora.')) act('payment_manual_settle', id, 'Pagamento baixado.'); }
      else if (a === 'mreissue') reissue(id);
    });
    document.body.appendChild(m);
  }
  function act(fn, id, okMsg) {
    var args = { p_payment_id: id };
    if (fn !== 'payment_manual_settle') args = { p_id: id };
    rpc(fn, args).then(function (d) { if (!d) return; toast('✅ ' + okMsg); closeM(); loadList(ST.offset); refresh().then(function () { if (ST.tab === 'ajustes') draw(); }); });
  }
  function reissue(id) {
    if (!confirm('Reemitir o comprovante? O QR anterior deixa de valer.')) return;
    rpc('payment_reissue_receipt', { p_id: id }).then(function (d) {
      if (!d) return;
      var url = location.origin + '/#comprovante=' + d.receipt_token;
      P.loadQr().then(function () {
        showM('<h3 style="margin:0">Novo comprovante</h3><div class="m" style="font-size:12px;color:#64748b">Mostre ao cliente ou envie o link. O QR anterior foi invalidado.</div>' +
          '<div class="qr">' + P.qrSvg(url, 220) + '</div><input type="text" readonly value="' + esc(url) + '" style="width:100%;box-sizing:border-box;padding:9px;border:1px solid #cbd5e1;border-radius:10px"><div style="margin-top:10px;text-align:right"><button type="button" class="b" data-a="mclose">Fechar</button></div>');
      });
    });
  }
  function detail(id) {
    rpc('payment_detail', { p_id: id }).then(function (p) {
      if (!p) return;
      var kv = function (k, v) { return '<span>' + esc(k) + '</span><span>' + v + '</span>'; };
      var h = '<h3 style="margin:0 0 4px">Pagamento ' + esc(brl(p.amount_cents)) + '</h3><div>' + stateLabel(p) + '</div><div class="kv">' +
        kv('Mesa', esc(p.umbrella_num)) + kv('Método', esc(METHOD[p.method] || p.method)) + kv('Criado', esc(dhm(p.created_at))) +
        kv('Subtotal', esc(brl(p.subtotal_cents))) + kv('Taxa de serviço', esc(brl(p.service_cents))) +
        (p.paid_at ? kv('Pago em', esc(dhm(p.paid_at)) + ' · ' + esc(brl(p.paid_amount_cents))) : '') +
        (p.manual ? kv('Baixa manual', esc(p.marked_by_name || '') + ' (' + esc(p.marked_by_role === 'waiter' ? 'garçom' : 'responsável') + ') · ' + esc(dhm(p.marked_at))) : '') +
        (p.manual_note ? kv('Observação', esc(p.manual_note)) : '') +
        (p.late_payment ? kv('Atenção', 'Pago depois de expirar/cancelar') : '') +
        (p.validation_count ? kv('Comprovante', 'validado ' + esc(p.validation_count) + 'x') : '') +
        kv('Pedidos', esc(p.orders)) + '</div>';
      if (p.events && p.events.length) h += '<div class="m">Histórico</div><ul class="ev">' + p.events.map(function (e) { return '<li>' + esc(dhm(e.at)) + ' · ' + esc(e.kind) + (e.by_name ? ' · ' + esc(e.by_name) : '') + '</li>'; }).join('') + '</ul>';
      h += '<div style="margin-top:12px">';
      var did = esc(p.id);
      if (p.status === 'created' || p.status === 'pending') h += '<button type="button" class="b red" data-a="mcancel" data-id="' + did + '">Cancelar cobrança</button>';
      if (p.method === 'pix_direct' && (p.status === 'pending' || p.status === 'expired' || p.status === 'created')) h += '<button type="button" class="b pri" data-a="mmark" data-id="' + did + '">Marcar como pago</button>';
      if (p.needs_review) h += '<button type="button" class="b pri" data-a="mresolve" data-id="' + did + '">Marcar como conferido</button>';
      if (p.status === 'paid') h += '<button type="button" class="b" data-a="mreissue" data-id="' + did + '">Reemitir comprovante</button>';
      h += '<button type="button" class="b" data-a="mclose">Fechar</button></div>';
      showM(h);
    });
  }

  // ---------- CSV (sem fórmulas: células que começam com = + - @ ganham apóstrofo) ----------
  function cell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv() {
    var all = [], off = 0, guard = 0;
    function next() {
      return rpc('payments_search', { p_filters: apiFilters(), p_limit: 100, p_offset: off }).then(function (d) {
        if (!d) return null;
        all = all.concat(d.rows || []); off += 100; guard++;
        if ((d.rows || []).length === 100 && guard < 50) return next();
        return all;
      });
    }
    next().then(function (rows) {
      if (!rows) return;
      var lines = [['Data', 'Mesa', 'Metodo', 'Estado', 'Valor', 'Pago em', 'Valor pago', 'Baixa manual por', 'Conferir'].map(cell).join(';')];
      rows.forEach(function (p) {
        lines.push([p.created_at, p.umbrella_num, METHOD[p.method] || p.method, STATE[p.status] || p.status, (p.amount_cents / 100).toFixed(2).replace('.', ','), p.paid_at || '',
          p.paid_amount_cents != null ? (p.paid_amount_cents / 100).toFixed(2).replace('.', ',') : '', p.manual ? (p.marked_by_name || '') : '', p.needs_review ? 'sim' : ''].map(cell).join(';'));
      });
      var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pagamentos.csv';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('✅ CSV com ' + rows.length + ' linha(s)');
    });
  }

  // ---------- eventos ----------
  function patch(p, okMsg) {
    return rpc('payments_panel_set', { p_patch: p }).then(function (d) {
      if (!d) return refresh().then(draw);
      ST.cfg = d; if (d.mode_reset) toast('⚠️ Sem forma de pagamento disponível: o modo voltou para opcional.'); else toast('✅ ' + okMsg);
      draw();
    });
  }
  function onChange() { /* campos são lidos no clique de Filtrar/Salvar */ }
  function onClick(e) {
    var t = e.target; while (t && !(t.getAttribute && t.getAttribute('data-a'))) t = t.parentNode;
    if (!t) return;
    var a = t.getAttribute('data-a');
    if (a === 'tab') { ST.tab = t.getAttribute('data-t'); draw(); }
    else if (a === 'sw') {
      var k = t.getAttribute('data-k'), on = t.getAttribute('data-v') === '1', p = {}; p[k] = on;
      if (on && !confirm('Ligar esta forma de pagamento para os clientes?')) return;
      patch(p, on ? 'Ligado' : 'Desligado');
    }
    else if (a === 'mode') {
      var v = t.getAttribute('data-v');
      if (v === 'required' && !confirm('Exigir pagamento em cada pedido?\n\nPedidos novos só chegam ao atendente depois do pagamento confirmado. Você pode voltar ao modo opcional a qualquer momento.')) return;
      patch({ checkout_mode: v }, v === 'required' ? 'Pagamento obrigatório' : 'Pagamento opcional');
    }
    else if (a === 'connect') connect('start', 'connect_mock');
    else if (a === 'wconnect') connect('start_wallet', 'connect_wallet_mock');
    else if (a === 'disconnect') { if (confirm('Desconectar a conta Mercado Pago? Os pagamentos online serão desligados.')) rpc('payments_disconnect').then(function () { refresh().then(draw); }); }
    else if (a === 'wdisconnect') { if (confirm('Desconectar a conta Stripe? As carteiras serão desligadas.')) rpc('payments_disconnect_wallets').then(function () { refresh().then(draw); }); }
    else if (a === 'pixsave') {
      rpc('pix_key_set', { p_type: document.getElementById('rpay-kt').value, p_value: document.getElementById('rpay-kv').value, p_name: document.getElementById('rpay-kn').value, p_city: document.getElementById('rpay-kc').value })
        .then(function (d) { if (d) { ST.cfg = d; toast('✅ Chave Pix salva'); draw(); } });
    }
    else if (a === 'pixclear') { if (confirm('Remover a chave Pix? O Pix direto será desligado.')) rpc('pix_key_clear').then(function (d) { if (d) { ST.cfg = d; draw(); } }); }
    else if (a === 'filter') {
      ST.filters = { from_d: val('rpay-f-from'), to_d: val('rpay-f-to'), umbrella: val('rpay-f-umb'), method: val('rpay-f-meth'), state: val('rpay-f-st') };
      loadList(0);
    }
    else if (a === 'clear') { ST.filters = {}; draw(); loadList(0); }
    else if (a === 'prev') loadList(Math.max(0, ST.offset - PAGE));
    else if (a === 'next') loadList(ST.offset + PAGE);
    else if (a === 'csv') csv();
    else if (a === 'detail') detail(t.getAttribute('data-id'));
  }
  function val(id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; }
  function connect(startAction, mockAction) {
    oauth(startAction).then(function (j) {
      if (j && j.ok && /^https:\/\//.test(j.url)) window.location.href = j.url;
      else if (j && j.error === 'unsupported') return oauth(mockAction).then(function () { return refresh().then(draw); });
      else toast('⚠️ ' + ((j && j.message) || 'Não foi possível iniciar a conexão.'));
    }).catch(function () { toast('⚠️ Sem conexão.'); });
  }

  P.panel = { mount: mount, open: open, _csvCell: cell };
})();
