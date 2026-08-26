/* Sticker Tracker - frontend (schema-driven, JSONP) */

var PAGE_SIZE = 50;
var user = null;
var config = null;
var lastRes = null;
var state = { page: 1, status: '', search: '' };
var searchTimer = null;

/* ---------- DOM ---------- */
var $ = function (id) { return document.getElementById(id); };
document.addEventListener('DOMContentLoaded', init);

function init() {
  $('brandName').textContent = CONFIG.APP_NAME;
  $('appTitle').textContent = CONFIG.APP_NAME;

  $('loginBtn').onclick = doLogin;
  $('pinInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').onclick = logout;
  $('manageBtn').onclick = openManage;
  $('refreshBtn').onclick = function () { loadOrders(); };
  $('newOrderBtn').onclick = openNewOrder;
  $('prevBtn').onclick = function () { if (state.page > 1) { state.page--; loadOrders(); } };
  $('nextBtn').onclick = function () { state.page++; loadOrders(); };
  $('modalClose').onclick = closeModal;
  $('modalCancel').onclick = closeModal;

  $('searchBox').addEventListener('input', function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.search = e.target.value.trim(); state.page = 1; loadOrders(); }, 400);
  });
  var chips = document.querySelectorAll('#chips .chip');
  chips.forEach(function (c) {
    c.onclick = function () {
      chips.forEach(function (x) { x.classList.remove('active'); });
      c.classList.add('active');
      state.status = c.getAttribute('data-status'); state.page = 1; loadOrders();
    };
  });

  // Auto-login from URL (?pin=) — jab SOMS/IMS se redirect ho
  var urlPin = new URLSearchParams(location.search).get('pin');
  if (urlPin) {
    $('pinInput').value = urlPin;
    history.replaceState(null, '', location.pathname);   // URL se ?pin hata do
    doLogin();
    return;
  }

  var saved = localStorage.getItem('st_user');
  if (saved) { user = JSON.parse(saved); enterApp(); }
}

/* ---------- JSONP ---------- */
function api(params) {
  return new Promise(function (resolve, reject) {
    var cb = 'cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    var s = document.createElement('script');
    var timer = setTimeout(function () { cleanup(); reject(new Error('Request timed out')); }, 20000);
    function cleanup() { try { delete window[cb]; } catch (e) { window[cb] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); clearTimeout(timer); }
    window[cb] = function (res) {
      cleanup();
      if (res && res.ok === false && res.auth === false) forceLogout();
      resolve(res);
    };
    if (user && user.token && params.action !== 'login') params.token = user.token;
    var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    s.src = CONFIG.API_URL + '?' + q + '&callback=' + cb;
    s.onerror = function () { cleanup(); reject(new Error('Network error')); };
    document.body.appendChild(s);
  });
}

/* ---------- auth ---------- */
function showLoginError(m) { $('loginError').textContent = m || ''; }
async function doLogin() {
  var pin = $('pinInput').value.trim();
  if (!pin) { showLoginError('Enter your PIN'); return; }
  $('loginBtn').disabled = true; $('loginBtn').textContent = 'Please wait...';
  try {
    var res = await api({ action: 'login', pin: pin });
    if (!res.ok) { showLoginError(res.error || 'Invalid PIN'); return; }
    user = { name: res.name, role: res.role, vendorTag: res.vendorTag || '', token: res.token || '' };
    localStorage.setItem('st_user', JSON.stringify(user));
    showLoginError('');
    await enterApp();
  } catch (e) { showLoginError(e.message); }
  finally { $('loginBtn').disabled = false; $('loginBtn').textContent = 'Login'; }
}
function logout() {
  localStorage.removeItem('st_user');
  user = null;
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('pinInput').value = '';
}
var _authFailed = false;
function forceLogout() {
  if (_authFailed) return;         // avoid loops / double toasts
  _authFailed = true;
  logout();
  closeModal();
  toast('Session expired — please log in again', true);
  setTimeout(function () { _authFailed = false; }, 3000);
}

async function enterApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userLabel').textContent = user.name + ' | ' + user.role;
  $('newOrderBtn').classList.toggle('hidden', user.role !== 'Admin' && user.role !== 'Receiver');
  $('manageBtn').classList.toggle('hidden', user.role !== 'Admin' && user.role !== 'Receiver');
  buildHead();
  await loadConfig();
  // instant paint from cache, then refresh
  var c = localStorage.getItem('st_orders');
  if (c) { try { renderOrders(JSON.parse(c)); } catch (e) {} }
  loadOrders();
}

/* ---------- config ---------- */
async function loadConfig() {
  var cached = localStorage.getItem('st_config');
  if (cached) { try { config = JSON.parse(cached); } catch (e) {} }
  try {
    var res = await api({ action: 'getConfig' });
    if (res && res.ok) { config = res; localStorage.setItem('st_config', JSON.stringify(res)); }
    else if (res && res.ok === false && res.auth !== false) { toast('Config: ' + (res.error || 'failed'), true); }
  } catch (e) { toast('Config: ' + e.message, true); }
  buildHead();
}
function orderCols() { return (config && config.fields && config.fields.Order) ? config.fields.Order : []; }

function buildHead() {
  var cols = orderCols();
  var html = '<tr><th>Order</th>';
  cols.forEach(function (f) { html += '<th class="' + (f.type === 'number' ? 'num' : '') + '">' + esc(f.label) + '</th>'; });
  html += '<th class="num">Received</th><th class="num">Pending</th><th>Status</th>' +
          '<th class="num">Paid</th><th class="num">Due</th><th>Payment</th><th>Actions</th></tr>';
  $('ordersHead').innerHTML = html;
}

/* ---------- orders ---------- */
function showSkeleton() {
  var cols = Math.max(6, orderCols().length + 9);
  var rows = '';
  for (var r = 0; r < 5; r++) {
    var tds = '';
    for (var c = 0; c < cols; c++) tds += '<td><div class="sk"></div></td>';
    rows += '<tr>' + tds + '</tr>';
  }
  $('ordersBody').innerHTML = rows;
  $('emptyMsg').classList.add('hidden');
}

async function loadOrders() {
  showSkeleton();
  try {
    var res = await api({
      action: 'getOrders', role: user.role, vendorTag: user.vendorTag, name: user.name,
      page: state.page, pageSize: PAGE_SIZE, status: state.status, search: state.search
    });
    if (!res || !res.ok) {
      if (res && res.auth === false) return;               // forceLogout already handled it
      renderError((res && res.error) || 'Failed to load'); return;
    }
    lastRes = res;
    if (state.page === 1 && !state.search && !state.status) localStorage.setItem('st_orders', JSON.stringify(res));
    renderOrders(res);
  } catch (e) { renderError(e.message); }
}

function renderError(msg) {
  $('ordersBody').innerHTML = '';
  var em = $('emptyMsg'); em.textContent = msg; em.classList.remove('hidden');
  $('resultCount').textContent = ''; $('pageInfo').textContent = '';
  $('prevBtn').disabled = true; $('nextBtn').disabled = true;
  toast(msg, true);
}

function badge(kind, txt) {
  var map = { Pending: 'b-pending', Partial: 'b-partial', Received: 'b-received', Unpaid: 'b-unpaid', Paid: 'b-paid', '-': 'b-na' };
  return '<span class="badge ' + (map[txt] || 'b-na') + '">' + esc(txt) + '</span>';
}

function renderOrders(res) {
  var cols = orderCols();
  var rows = res.rows || [];
  var body = $('ordersBody');
  if (!rows.length) { body.innerHTML = ''; $('emptyMsg').textContent = 'No orders found.'; $('emptyMsg').classList.remove('hidden'); }
  else $('emptyMsg').classList.add('hidden');

  body.innerHTML = rows.map(function (o, i) {
    var tds = '<td><b>' + esc(o.OrderID) + '</b></td>';
    cols.forEach(function (f) {
      tds += '<td class="' + (f.type === 'number' ? 'num' : '') + '">' + esc(val(o[f.name])) + '</td>';
    });
    tds += '<td class="num">' + num(o.QtyReceived) + '</td>' +
           '<td class="num">' + num(o.QtyPending) + '</td>' +
           '<td>' + badge('qty', o.Status) + '</td>' +
           '<td class="num">' + num(o.AmountPaid) + '</td>' +
           '<td class="num">' + num(o.AmountPending) + '</td>' +
           '<td>' + badge('pay', o.PayStatus) + '</td>' +
           '<td>' + actions(o.OrderID) + '</td>';
    return '<tr class="row-in" style="animation-delay:' + (i * 22) + 'ms">' + tds + '</tr>';
  }).join('');

  // wire action buttons
  body.querySelectorAll('[data-act]').forEach(function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
      var ord = rows.filter(function (x) { return String(x.OrderID) === String(id); })[0];
      if (act === 'detail') openDetail(id);
      else if (act === 'ship') openShip(ord);
      else if (act === 'pay') openPay(ord);
    };
  });

  var total = res.total || 0, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  var from = total ? ((res.page - 1) * PAGE_SIZE + 1) : 0;
  var to = Math.min(res.page * PAGE_SIZE, total);
  $('resultCount').textContent = total + ' order' + (total === 1 ? '' : 's') + (total ? ' (showing ' + from + '-' + to + ')' : '');
  $('pageInfo').textContent = 'Page ' + res.page + ' / ' + pages;
  $('prevBtn').disabled = res.page <= 1;
  $('nextBtn').disabled = res.page >= pages;
}

function actions(id) {
  var b = '<div class="row-actions">';
  b += '<button class="btn btn-ghost btn-sm" data-act="detail" data-id="' + id + '">View</button>';
  if (user.role === 'Admin' || user.role === 'Vendor')
    b += '<button class="btn btn-ghost btn-sm" data-act="ship" data-id="' + id + '">+ Handover</button>';
  if (user.role === 'Admin') b += '<button class="btn btn-ghost btn-sm" data-act="pay" data-id="' + id + '">+ Payment</button>';
  return b + '</div>';
}

/* ---------- forms ---------- */
function buildForm(fields, record) {
  return fields.map(function (f) {
    var val = record ? (record[f.name] != null ? record[f.name] : '') : '';
    var label = esc(f.label) + (f.required ? ' *' : '');
    var input;
    if (f.name === 'Vendor') {
      var vopts = ['<option value="">Select...</option>'];
      ((config.vendors) || []).forEach(function (v) {
        var lbl = v.phone ? (v.name + ' — ' + v.phone) : v.name;
        vopts.push('<option value="' + esc(v.name) + '"' + (String(v.name) === String(val) ? ' selected' : '') + '>' + esc(lbl) + '</option>');
      });
      input = '<select data-field="' + f.name + '">' + vopts.join('') + '</select>';
    } else if (f.type === 'dropdown') {
      var opts = ['<option value="">Select...</option>'];
      ((config.lists && config.lists[f.list]) || []).forEach(function (o) {
        opts.push('<option' + (String(o) === String(val) ? ' selected' : '') + '>' + esc(o) + '</option>');
      });
      input = '<select data-field="' + f.name + '">' + opts.join('') + '</select>';
    } else if (f.type === 'datalist') {
      var dlId = 'dl_' + f.name;
      var dopts = ((config.lists && config.lists[f.list]) || []).map(function (o) {
        return '<option value="' + esc(o) + '"></option>';
      }).join('');
      input = '<input data-field="' + f.name + '" list="' + dlId + '" value="' + esc(val) + '" autocomplete="off">' +
              '<datalist id="' + dlId + '">' + dopts + '</datalist>';
    } else if (f.type === 'number') {
      input = '<input data-field="' + f.name + '" type="number" step="any" value="' + esc(val) + '">';
    } else if (f.type === 'date') {
      input = '<input data-field="' + f.name + '" type="date" value="' + esc(val || todayStr()) + '">';
    } else {
      input = '<input data-field="' + f.name + '" type="text" value="' + esc(val) + '">';
    }
    return '<div class="field"><label>' + label + '</label>' + input + '</div>';
  }).join('');
}
function collectForm() {
  var o = {};
  $('modalBody').querySelectorAll('[data-field]').forEach(function (el) { o[el.getAttribute('data-field')] = el.value; });
  return o;
}
function firstError(fields, data) {
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], v = data[f.name];
    if (f.required && (v === '' || v == null)) return f.label + ' is required';
    if (f.type === 'number' && v !== '' && (isNaN(Number(v)) || Number(v) < 0)) return f.label + ' must be a positive number';
  }
  return '';
}

/* ---------- modal ---------- */
function openModal(title, bodyHTML, onSave) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  $('modalWrap').classList.remove('hidden');
  var m = $('modal') || document.querySelector('.modal');
  m.classList.remove('pop-in'); void m.offsetWidth; m.classList.add('pop-in');
  $('modalFoot').classList.toggle('hidden', !onSave);
  $('modalSave').onclick = onSave || null;
}
function closeModal() { $('modalWrap').classList.add('hidden'); }

function openNewOrder() {
  var fields = config.fields.Order;
  openModal('New Order', buildForm(fields, null), async function () {
    var data = collectForm();
    var e = firstError(fields, data); if (e) { toast(e, true); return; }
    await save('addOrder', data, 'Order created');
  });
  // live total = qty * rate
  var q = $('modalBody').querySelector('[data-field="QtyOrdered"]');
  var r = $('modalBody').querySelector('[data-field="Rate"]');
  var t = $('modalBody').querySelector('[data-field="TotalAmount"]');
  if (q && r && t) {
    var calc = function () { var rate = Number(r.value) || 0; if (rate > 0) t.value = (Number(q.value) || 0) * rate; };
    q.addEventListener('input', calc); r.addEventListener('input', calc);
  }
}

function openShip(o) {
  if (!o) return;
  var fields = config.fields.Shipment;
  var pending = Number(o.QtyPending != null ? o.QtyPending : (o.QtyOrdered - o.QtyReceived)) || 0;
  var head = '<div class="summary-box"><b>' + esc(o.OrderID) + '</b> &middot; ' + esc(val(o.StickerName)) +
             '<br>Ordered <b>' + num(o.QtyOrdered) + '</b> &middot; Handed Over <b>' + num(o.QtyReceived) +
             '</b> &middot; Pending <b><span id="pendLive">' + pending + '</span></b></div>';
  openModal('Handover', head + buildForm(fields, null), async function () {
    var data = collectForm(); data.OrderID = o.OrderID;
    var e = firstError(fields, data); if (e) { toast(e, true); return; }
    if ((Number(data.Qty) || 0) > pending) { toast('Qty exceeds pending (' + pending + ')', true); return; }
    await save('addShipment', data, 'Handover saved', { loggedBy: user.name });
  });

  var qEl = $('modalBody').querySelector('[data-field="Qty"]');
  var pendEl = $('pendLive');
  if (qEl && pendEl) {
    qEl.addEventListener('input', function () {
      var entered = Number(qEl.value) || 0;
      var remain = pending - entered;
      pendEl.textContent = remain;
      pendEl.style.color = remain < 0 ? 'var(--danger)' : '';
    });
  }
}

function openPay(o) {
  if (!o) return;
  var fields = config.fields.Payment;
  var total = Number(o.TotalAmount) || 0;
  var due = Number(o.AmountPending != null ? o.AmountPending : (total - o.AmountPaid)) || 0;
  var head = '<div class="summary-box"><b>' + esc(o.OrderID) + '</b> &middot; Total <b>' + num(total) +
             '</b> &middot; Paid <b>' + num(o.AmountPaid) + '</b> &middot; Due <b>' + num(due) + '</b></div>';
  openModal('Add Payment', head + buildForm(fields, null), async function () {
    var data = collectForm(); data.OrderID = o.OrderID;
    var e = firstError(fields, data); if (e) { toast(e, true); return; }
    if (total > 0 && (Number(data.Amount) || 0) > due) { toast('Amount exceeds due (' + due + ')', true); return; }
    await save('addPayment', data, 'Payment saved');
  });
}

async function openDetail(id) {
  openModal('Order Detail', '<div class="sk" style="height:60px"></div>', null);
  try {
    var res = await api({ action: 'getDetail', orderId: id });
    if (!res || !res.ok) { toast((res && res.error) || 'Failed', true); closeModal(); return; }
    var o = res.order;
    var pend = Number(o.QtyPending) || 0, due = Number(o.AmountPending) || 0;
    var html = '<div class="summary-box"><b>' + esc(o.OrderID) + '</b> &middot; ' + esc(val(o.StickerName)) +
      ' &middot; ' + esc(val(o.Vendor)) +
      '<br>Ordered <b>' + num(o.QtyOrdered) + '</b> &middot; Received <b>' + num(o.QtyReceived) + '</b> &middot; Pending <b>' + pend + '</b>' +
      '<br>Total <b>' + num(o.TotalAmount) + '</b> &middot; Paid <b>' + num(o.AmountPaid) + '</b> &middot; Due <b>' + due + '</b></div>';

    html += '<div class="detail-sub">Receipts</div>';
    if (res.shipments.length) {
      html += '<table class="mini-table"><tr><th>Date</th><th>Qty</th><th>Handover</th><th>By</th></tr>';
      res.shipments.forEach(function (s) {
        html += '<tr><td>' + esc(val(s.Date)) + '</td><td>' + num(s.Qty) + '</td><td>' + esc(val(s.HandoverTo)) + '</td><td>' + esc(val(s.LoggedBy)) + '</td></tr>';
      });
      html += '</table>';
    } else html += '<p class="empty">No receipts yet.</p>';

    html += '<div class="detail-sub">Payments</div>';
    if (res.payments.length) {
      html += '<table class="mini-table"><tr><th>Date</th><th>Amount</th><th>Mode</th></tr>';
      res.payments.forEach(function (p) {
        html += '<tr><td>' + esc(val(p.PayDate)) + '</td><td>' + num(p.Amount) + '</td><td>' + esc(val(p.Mode)) + '</td></tr>';
      });
      html += '</table>';
    } else html += '<p class="empty">No payments yet.</p>';

    $('modalBody').innerHTML = html;
  } catch (e) { toast(e.message, true); closeModal(); }
}

async function save(action, data, okMsg, extra) {
  $('modalSave').disabled = true; $('modalSave').textContent = 'Saving...';
  try {
    var params = { action: action, data: JSON.stringify(data) };
    if (extra) for (var k in extra) params[k] = extra[k];
    var res = await api(params);
    if (!res || !res.ok) { toast((res && res.error) || 'Save failed', true); return; }
    toast(okMsg);
    closeModal();
    loadOrders();
  } catch (e) { toast(e.message, true); }
  finally { $('modalSave').disabled = false; $('modalSave').textContent = 'Save'; }
}

/* ---------- manage (master data) ---------- */
var manageTab = 'lists';

function openManage() {
  manageTab = 'lists';
  renderManage();
}

function renderManage() {
  var tabs = '<div class="mtabs">' +
    '<button class="mtab' + (manageTab === 'lists' ? ' active' : '') + '" data-mtab="lists">Lists</button>' +
    '<button class="mtab' + (manageTab === 'vendors' ? ' active' : '') + '" data-mtab="vendors">Vendors</button>' +
    '</div>';
  var body = manageTab === 'lists' ? manageListsHTML() : manageVendorsHTML();
  openModal('Manage Data', tabs + '<div id="manageBody">' + body + '</div>', null);

  $('modalBody').querySelectorAll('[data-mtab]').forEach(function (b) {
    b.onclick = function () { manageTab = b.getAttribute('data-mtab'); renderManage(); };
  });
  wireManage();
}

function manageListsHTML() {
  var editable = (config && config.editableLists) || [];
  if (!editable.length) return '<p class="empty">No editable lists.</p>';
  var html = '';
  editable.forEach(function (ln) {
    var vals = (config.lists && config.lists[ln]) || [];
    html += '<div class="mlist"><div class="mlist-head">' + esc(ln) + '</div>';
    html += '<div class="mlist-items">';
    if (vals.length) {
      vals.forEach(function (v) {
        html += '<div class="mrow" data-list="' + esc(ln) + '" data-val="' + esc(v) + '">' +
                '<span class="mrow-txt">' + esc(v) + '</span>' +
                '<button class="btn btn-ghost btn-sm mrow-edit">Edit</button></div>';
      });
    } else html += '<p class="empty" style="padding:8px">Empty</p>';
    html += '</div>';
    html += '<div class="madd"><input class="search madd-in" placeholder="Add to ' + esc(ln) + '..." data-list="' + esc(ln) + '">' +
            '<button class="btn btn-primary btn-sm madd-btn" data-list="' + esc(ln) + '">Add</button></div>';
    html += '</div>';
  });
  return html;
}

function manageVendorsHTML() {
  var vendors = (config && config.vendors) || [];
  var html = '<div class="mlist"><div class="mlist-head">Add Vendor</div>' +
    '<div class="field"><label>Name *</label><input id="vName" type="text"></div>' +
    '<div class="field"><label>Phone</label><input id="vPhone" type="text"></div>' +
    '<div class="field"><label>City</label><input id="vCity" type="text"></div>' +
    '<div class="field"><label>Address</label><input id="vAddress" type="text"></div>' +
    '<button class="btn btn-primary btn-block" id="vAddBtn">Add Vendor</button></div>';
  html += '<div class="mlist"><div class="mlist-head">Vendors (' + vendors.length + ')</div><div class="mlist-items">';
  if (vendors.length) {
    vendors.forEach(function (v) {
      var sub = [v.phone, v.city].filter(Boolean).join(' · ');
      html += '<div class="mrow"><span class="mrow-txt"><b>' + esc(v.name) + '</b>' +
              (sub ? '<br><small style="color:var(--muted)">' + esc(sub) + '</small>' : '') + '</span></div>';
    });
  } else html += '<p class="empty" style="padding:8px">No vendors yet</p>';
  html += '</div></div>';
  return html;
}

function wireManage() {
  // add to list
  $('modalBody').querySelectorAll('.madd-btn').forEach(function (b) {
    b.onclick = async function () {
      var ln = b.getAttribute('data-list');
      var inp = $('modalBody').querySelector('.madd-in[data-list="' + cssq(ln) + '"]');
      var val = (inp.value || '').trim();
      if (!val) { toast('Enter a value', true); return; }
      b.disabled = true;
      var res = await api({ action: 'addListValue', list: ln, value: val });
      b.disabled = false;
      if (!res || !res.ok) { toast((res && res.error) || 'Failed', true); return; }
      toast('Added');
      await loadConfig();
      renderManage();
    };
  });
  // edit list value
  $('modalBody').querySelectorAll('.mrow-edit').forEach(function (b) {
    b.onclick = function () {
      var row = b.closest('.mrow');
      var ln = row.getAttribute('data-list'), old = row.getAttribute('data-val');
      var nv = prompt('Rename "' + old + '" to:', old);
      if (nv == null) return;
      nv = nv.trim();
      if (!nv || nv === old) return;
      (async function () {
        var res = await api({ action: 'editListValue', list: ln, oldValue: old, newValue: nv });
        if (!res || !res.ok) { toast((res && res.error) || 'Failed', true); return; }
        toast('Updated');
        await loadConfig();
        renderManage();
      })();
    };
  });
  // add vendor
  var vBtn = $('vAddBtn');
  if (vBtn) vBtn.onclick = async function () {
    var data = { Name: $('vName').value.trim(), Phone: $('vPhone').value.trim(),
                 City: $('vCity').value.trim(), Address: $('vAddress').value.trim() };
    if (!data.Name) { toast('Vendor name required', true); return; }
    vBtn.disabled = true;
    var res = await api({ action: 'addVendor', data: JSON.stringify(data) });
    vBtn.disabled = false;
    if (!res || !res.ok) { toast((res && res.error) || 'Failed', true); return; }
    toast('Vendor added');
    await loadConfig();
    renderManage();
  };
}

function cssq(s) { return String(s).replace(/"/g, '\\"'); }

/* ---------- utils ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function val(v) { return v == null ? '' : v; }
function num(v) { var n = Number(v); return isNaN(n) ? '0' : String(n); }
function todayStr() { var d = new Date(); return d.toISOString().slice(0, 10); }
function toast(msg, isErr) {
  var t = $('toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err-toast' : '');
  t.classList.remove('hidden'); void t.offsetWidth; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(t._h); t._h = setTimeout(function () { t.classList.add('hidden'); }, 2600);
}
