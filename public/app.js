const STORAGE_KEY = 'lager_local_v4';
const THEME_KEY = 'lager_theme';
const LIVE_TABLE_WEBHOOK = 'https://discord.com/api/webhooks/1448465091199635518/bKMPlZhx32ffSTG3SuXspC8h7N3_R3fsxXEjztUiLrn_RtmgCgFCLne53tSZ2LnfZ0Nl';
const LOGS_WEBHOOK = 'https://discord.com/api/webhooks/1448464870335971433/9U5N7iieNwJRjzGWEl_A9DKzPj4ruWk2eV0naFhsosTKwJs8re33ADjd8I9vjzJLqPrF';
const API_URL = '/api/state';
const POLL_INTERVAL_MS = 3000;
const SAVE_DEBOUNCE_MS = 500;
const MAX_HISTORY = 30;
const MAX_LOGS = 500;
const MAX_STATS = 500;
const DEFAULT_STATE = {
  items: {},
  categories: ['Waffen','Drogen','Materialien'],
  history: {},
  users: [],
  logs: [],
  stats: [],
  settings: {
    lastUserId: '',
    report: {
      title: 'Lagerbericht',
      includeItems: true,
      includeDashboard: true,
      includeLogs: true,
      includeUsers: false,
      includeCharts: true,
      onlyLowStock: false,
      logDays: 30
    },
    webhooks: {
      liveMessageId: ''
    }
  }
};

const COLORS = ['#606770','#7b848e','#9098a3','#a7b0ba','#545c66'];

let state = loadState();
let currentUser = null;

const channel = (window.BroadcastChannel) ? new BroadcastChannel('lager_sync') : null;
const API_ENABLED = location.protocol === 'http:' || location.protocol === 'https:';
let serverMode = false;
let serverState = API_ENABLED ? 'connecting' : 'local';
let serverError = '';
let serverSaveTimer = null;
let pollTimer = null;
let reconnectTimer = null;
const cryptoObj = window.crypto || window.msCrypto;
const clientId = getClientId();

const grid = document.getElementById('itemGrid');
const tooltip = document.getElementById('tooltip');
const adminPanel = document.getElementById('adminPanel');
const userBadge = document.getElementById('userBadge');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const filterInput = document.getElementById('filterInput');
const sortSelect = document.getElementById('sortSelect');
const loginOverlay = document.getElementById('loginOverlay');
const setupOverlay = document.getElementById('setupOverlay');
const syncBadge = document.getElementById('syncBadge');
const statusBtn = document.getElementById('statusBtn');
const logsPanel = document.getElementById('logsPanel');
const statsPanel = document.getElementById('statsPanel');
const themeToggle = document.getElementById('themeToggle');

function setServerState(state, err){
  serverState = state;
  serverError = err || '';
  updateSyncBadge();
}

function updateSyncBadge(){
  if(!syncBadge) return;
  if(!API_ENABLED){
    syncBadge.textContent = 'Sync: lokal';
    syncBadge.title = 'Datei-Modus (nur dieses Geraet)';
    return;
  }
  if(serverState === 'connecting'){
    syncBadge.textContent = 'Sync: server ...';
    syncBadge.title = 'Server wird erreicht';
    return;
  }
  if(serverState === 'ok'){
    syncBadge.textContent = 'Sync: server ok';
    syncBadge.title = 'Server verbunden';
    return;
  }
  if(serverState === 'error'){
    syncBadge.textContent = 'Sync: server fehler';
    syncBadge.title = serverError || 'Server Fehler';
    return;
  }
  syncBadge.textContent = 'Sync: lokal';
}

updateSyncBadge();
function saveState(broadcast = true){
  state.meta = { updatedAt: Date.now(), updatedBy: clientId };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if(broadcast) broadcastSync();
  if(serverMode) scheduleServerSave();
}

function broadcastSync(){
  if(channel) channel.postMessage({ type: 'sync', at: Date.now() });
}

function loadState(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return clone(DEFAULT_STATE);
  try{
    const data = JSON.parse(raw);
    return normalizeState(data);
  }catch(err){
    return clone(DEFAULT_STATE);
  }
}

function normalizeState(data){
  const base = clone(DEFAULT_STATE);
  if(!data || typeof data !== 'object') return base;
  base.items = data.items || {};
  base.categories = Array.isArray(data.categories) ? data.categories : base.categories;
  base.history = data.history || {};
  base.users = Array.isArray(data.users) ? data.users.map(normalizeUser) : [];
  base.logs = Array.isArray(data.logs) ? data.logs : [];
  base.stats = Array.isArray(data.stats) ? data.stats : [];
  base.settings = Object.assign({}, base.settings, data.settings || {});
  base.settings.report = Object.assign({}, base.settings.report, (data.settings && data.settings.report) || {});
  base.settings.webhooks = Object.assign({}, base.settings.webhooks, (data.settings && data.settings.webhooks) || {});
  return base;
}

function clone(obj){
  return JSON.parse(JSON.stringify(obj));
}

function normalizeKey(name){
  return name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-');
}

function categoryColor(category){
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash << 5) - hash + category.charCodeAt(i);
    hash |= 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function normalizeRole(role){
  if(role === 'user') return 'manager';
  if(role === 'admin' || role === 'manager' || role === 'viewer') return role;
  return 'viewer';
}

function normalizeUser(u){
  if(!u || typeof u !== 'object') return u;
  return Object.assign({}, u, { role: normalizeRole(u.role) });
}

function randomSalt(){
  const buf = new Uint8Array(16);
  if (cryptoObj && cryptoObj.getRandomValues) {
    cryptoObj.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function hashPin(pin, salt){
  const value = pin + ':' + salt;
  if (cryptoObj && cryptoObj.subtle) {
    const enc = new TextEncoder();
    const data = enc.encode(value);
    const digest = await cryptoObj.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  return simpleHash(value);
}

function simpleHash(str){
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
}

function getClientId(){
  const key = 'lager_client_id';
  let id = localStorage.getItem(key);
  if(id) return id;
  id = (cryptoObj && cryptoObj.randomUUID) ? cryptoObj.randomUUID() : String(Date.now()) + String(Math.random()).slice(2);
  localStorage.setItem(key, id);
  return id;
}
function initServerMode(){
  if(!API_ENABLED){
    serverMode = false;
    setServerState('local');
    return;
  }
  setServerState('connecting');
}

async function loadFromServer(){
  if(!API_ENABLED) return false;
  try{
    const res = await fetch(API_URL, { cache: 'no-store' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(data && typeof data === 'object'){
      state = normalizeState(data);
    }
    serverMode = true;
    setServerState('ok');
    return true;
  }catch(err){
    serverMode = false;
    setServerState('error', (err && err.message) ? err.message : String(err));
    console.warn('Server load failed', err);
    return false;
  }
}

function scheduleServerSave(){
  if(!serverMode) return;
  if(serverSaveTimer) clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => saveToServer(), SAVE_DEBOUNCE_MS);
}

async function saveToServer(){
  if(!serverMode) return;
  try{
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    setServerState('ok');
  }catch(err){
    setServerState('error', (err && err.message) ? err.message : String(err));
    console.warn('Server save failed', err);
  }
}

function startPolling(){
  if(!serverMode) return;
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => syncFromServer(), POLL_INTERVAL_MS);
}

async function syncFromServer(){
  if(!serverMode) return;
  try{
    const res = await fetch(API_URL, { cache: 'no-store' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const remoteTs = data && data.meta && data.meta.updatedAt ? data.meta.updatedAt : 0;
    const localTs = state && state.meta && state.meta.updatedAt ? state.meta.updatedAt : 0;
    const remoteBy = data && data.meta ? data.meta.updatedBy : '';
    if(remoteTs > localTs && remoteBy !== clientId){
      state = normalizeState(data);
      render();
    }
    setServerState('ok');
  }catch(err){
    setServerState('error', (err && err.message) ? err.message : String(err));
  }
}

function startReconnectLoop(){
  if(!API_ENABLED) return;
  if(reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = setInterval(async () => {
    if(serverMode) return;
    await loadFromServer();
    if(serverMode) startPolling();
  }, 5000);
}

async function checkServerStatus(){
  if(!API_ENABLED){
    alert('Status: lokal (Datei-Modus). Bitte ueber http:// starten.');
    return;
  }
  try{
    const res = await fetch(API_URL, { cache: 'no-store' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const count = data && data.items ? Object.keys(data.items).length : 0;
    alert('Server OK. Items: ' + count);
  }catch(err){
    alert('Server Fehler: ' + ((err && err.message) ? err.message : String(err)));
  }
}

function getInitialTheme(){
  const stored = localStorage.getItem(THEME_KEY);
  if(stored === 'dark' || stored === 'light') return stored;
  return 'dark';
}

function applyTheme(theme){
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  if(themeToggle) themeToggle.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
}
function roleLabel(role){
  if(role === 'admin') return 'Admin';
  if(role === 'manager') return 'Rechte Hand';
  if(role === 'viewer') return 'Zuschauer';
  return role || '';
}

function canManage(){
  return !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'manager');
}

function canEdit(){
  return canManage();
}

function canViewLogs(){
  return canManage();
}

function canViewStats(){
  return canManage();
}

function ensureLoggedIn(){
  if(!currentUser){
    showLogin();
    alert('Bitte anmelden.');
    return false;
  }
  return true;
}

function ensureAdmin(){
  if(!ensureLoggedIn()) return false;
  if(!canManage()){
    alert('Nur Admin oder Rechte Hand.');
    return false;
  }
  return true;
}

function ensureCanEdit(){
  if(!ensureLoggedIn()) return false;
  if(!canEdit()){
    alert('Nur Admin oder Rechte Hand.');
    return false;
  }
  return true;
}

function setCurrentUser(user){
  currentUser = user || null;
  if (currentUser) state.settings.lastUserId = currentUser.id;
  saveState();
  render();
}

function render(){
  renderUserBadge();
  renderCategories();
  renderItems();
  renderDashboard();
  renderAdmin();
  renderBadges();
  renderLogs();
  renderCharts();
}

function renderUserBadge(){
  if(currentUser){
    userBadge.textContent = currentUser.name + ' (' + roleLabel(currentUser.role) + ')';
    loginBtn.style.display = 'none';
    logoutBtn.style.display = 'inline-block';
  }else{
    userBadge.textContent = 'Nicht angemeldet';
    loginBtn.style.display = 'inline-block';
    logoutBtn.style.display = 'none';
  }
}

function renderCategories(){
  const list = document.getElementById('categoryList');
  list.innerHTML = '';
  state.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    list.appendChild(opt);
  });
}

function renderBadges(){
  document.getElementById('totalItemsBadge').textContent = 'Items: ' + Object.keys(state.items).length;
  document.getElementById('totalUsersBadge').textContent = 'Benutzer: ' + state.users.length;
  document.getElementById('totalStockBadge').textContent = 'Bestand: ' + totalStock();
}

function getFilteredKeys(){
  const filter = filterInput.value.trim().toLowerCase();
  let keys = Object.keys(state.items);
  if(filter){
    keys = keys.filter(k => {
      const it = state.items[k];
      return it.name.toLowerCase().includes(filter) || it.category.toLowerCase().includes(filter);
    });
  }
  const mode = sortSelect.value;
  keys.sort((a,b) => {
    const A = state.items[a];
    const B = state.items[b];
    if(mode === 'name-asc') return A.name.localeCompare(B.name);
    if(mode === 'name-desc') return B.name.localeCompare(A.name);
    if(mode === 'stock-desc') return (B.stock||0) - (A.stock||0);
    if(mode === 'stock-asc') return (A.stock||0) - (B.stock||0);
    if(mode === 'price-desc') return (B.price||0) - (A.price||0);
    if(mode === 'price-asc') return (A.price||0) - (B.price||0);
    return 0;
  });
  return keys;
}

function isLowStock(item){
  const max = item.max_stock || 0;
  if(max <= 0) return false;
  return (item.stock / max) < 0.2;
}
function renderItems(){
  grid.innerHTML = '';
  const keys = getFilteredKeys();
  if(!keys.length){
    grid.innerHTML = '<div class="empty">Keine Items gefunden.</div>';
    return;
  }
  keys.forEach((key, idx) => {
    const it = state.items[key];
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = key;
    card.style.animationDelay = (idx * 30) + 'ms';

    const color = categoryColor(it.category);

    const h = document.createElement('h3');
    h.textContent = it.name + ' ($' + it.price + ')';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Kategorie: ' + it.category;

    const stock = document.createElement('div');
    stock.className = 'stock';
    stock.innerHTML = 'Bestand: <span class="stock-value">' + it.stock + '</span>';

    const progress = document.createElement('div');
    progress.className = 'progress';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.background = color;
    const max = it.max_stock || 0;
    const pct = max > 0 ? Math.min(100, (it.stock / max) * 100) : 0;
    bar.style.width = pct + '%';
    progress.appendChild(bar);

    if(isLowStock(it)){
      card.classList.add('low');
    }

    if(canEdit()){
      const actions = document.createElement('div');
      actions.className = 'actions';

      const inputSell = document.createElement('input');
      inputSell.type = 'number';
      inputSell.min = 0;
      inputSell.placeholder = 'Menge';

      const btnSell = document.createElement('button');
      btnSell.className = 'btn';
      btnSell.textContent = 'Verkaufen';
      btnSell.onclick = () => changeStock(key, 'verkaufen', inputSell.value, card);

      const inputStore = document.createElement('input');
      inputStore.type = 'number';
      inputStore.min = 0;
      inputStore.placeholder = 'Menge';

      const btnIn = document.createElement('button');
      btnIn.className = 'btn';
      btnIn.textContent = 'Einlagern';
      btnIn.onclick = () => changeStock(key, 'einlagern', inputStore.value, card);

      const btnOut = document.createElement('button');
      btnOut.className = 'btn btn-ghost';
      btnOut.textContent = 'Auslagern';
      btnOut.onclick = () => changeStock(key, 'auslagern', inputStore.value, card);

      actions.appendChild(inputSell);
      actions.appendChild(btnSell);
      actions.appendChild(inputStore);
      actions.appendChild(btnIn);
      actions.appendChild(btnOut);
      card.appendChild(actions);
    }else{
      const viewOnly = document.createElement('div');
      viewOnly.className = 'meta';
      viewOnly.textContent = currentUser ? 'Nur Ansicht' : 'Anmelden fuer Aktionen';
      card.appendChild(viewOnly);
    }

    card.appendChild(h);
    card.appendChild(meta);
    card.appendChild(stock);
    card.appendChild(progress);
    if(canManage()){
      const remove = document.createElement('button');
      remove.className = 'btn btn-danger';
      remove.textContent = 'Entfernen';
      remove.onclick = () => removeItem(key);
      card.appendChild(remove);
    }

    card.onmouseenter = (e) => showTooltip(key, e);
    card.onmousemove = moveTooltip;
    card.onmouseleave = hideTooltip;

    grid.appendChild(card);
  });
}

function renderDashboard(){
  const body = document.getElementById('dashboardBody');
  body.innerHTML = '';
  Object.keys(state.items).forEach(key => {
    const it = state.items[key];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    const td3 = document.createElement('td');
    const td4 = document.createElement('td');
    td1.textContent = it.name;
    td2.textContent = it.category;
    td3.textContent = it.stock;
    td4.textContent = '$' + it.price;
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tr.appendChild(td4);
    body.appendChild(tr);
  });
}

function renderAdmin(){
  adminPanel.style.display = canManage() ? 'flex' : 'none';
  if(logsPanel) logsPanel.style.display = canViewLogs() ? 'block' : 'none';
  if(statsPanel) statsPanel.style.display = canViewStats() ? 'block' : 'none';
  renderUserTable();
  syncReportSettingsToUI();
}

function renderUserTable(){
  const body = document.querySelector('#userTable tbody');
  body.innerHTML = '';
  state.users.forEach(user => {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    const td3 = document.createElement('td');

    td1.textContent = user.name;
    td2.textContent = roleLabel(user.role);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-ghost';
    resetBtn.textContent = 'PIN reset';
    resetBtn.onclick = () => resetUserPin(user.id);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger';
    removeBtn.textContent = 'Loeschen';
    removeBtn.onclick = () => removeUser(user.id);

    td3.appendChild(resetBtn);
    td3.appendChild(removeBtn);

    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    body.appendChild(tr);
  });
}
function addItem(){
  if(!ensureAdmin()) return;
  const name = document.getElementById('newItemName').value.trim();
  const category = document.getElementById('newItemCategory').value.trim();
  const price = parseInt(document.getElementById('newItemPrice').value, 10) || 0;
  const stock = parseInt(document.getElementById('newItemStock').value, 10) || 0;

  if(!name || !category){
    alert('Name und Kategorie benoetigt.');
    return;
  }

  const key = normalizeKey(name);
  if(!key){
    alert('Ungueltiger Name.');
    return;
  }
  if(state.items[key]){
    alert('Item existiert bereits.');
    return;
  }

  state.items[key] = { name, category, price, stock, max_stock: Math.max(stock, 0) };
  if(!state.categories.includes(category)) state.categories.push(category);
  state.history[key] = state.history[key] || [];
  recordLog('item_add', key, 0, 'Item erstellt');
  recordStat();
  saveState();
  render();
  scheduleLiveTableUpdate();
}

function removeItem(key){
  if(!ensureAdmin()) return;
  if(!confirm('Item wirklich loeschen?')) return;
  recordLog('item_remove', key, 0, 'Item entfernt');
  delete state.items[key];
  delete state.history[key];
  recordStat();
  saveState();
  render();
  scheduleLiveTableUpdate();
}

function changeStock(key, action, amountRaw, card){
  if(!ensureCanEdit()) return;
  const amount = parseInt(amountRaw, 10) || 0;
  if(amount <= 0){
    alert('Menge?');
    return;
  }

  const item = state.items[key];
  if(!item) return;

  const before = item.stock;
  if(action === 'einlagern'){
    item.stock += amount;
    item.max_stock = Math.max(item.max_stock || 0, item.stock);
  }else{
    if(item.stock < amount){
      alert('Nicht genug Bestand.');
      return;
    }
    item.stock -= amount;
  }

  const now = Date.now();
  const historyLine = formatShortDate(now) + ' - ' + action + ' ' + amount + ' Stueck (' + currentUser.name + ')';
  state.history[key] = state.history[key] || [];
  state.history[key].push(historyLine);
  if(state.history[key].length > MAX_HISTORY) state.history[key] = state.history[key].slice(-MAX_HISTORY);

  const delta = (action === 'einlagern') ? amount : -amount;
  recordLog(action, key, delta, '');
  recordStat();

  saveState();
  render();
  scheduleLiveTableUpdate();

  const after = item.stock;
  if(card){
    animateStock(card, before, after, item.max_stock || 0, delta);
  }
}

function animateStock(card, from, to, max, delta){
  const stockEl = card.querySelector('.stock-value');
  const bar = card.querySelector('.progress-bar');
  const changeEl = document.createElement('div');
  changeEl.className = 'stock-change';
  changeEl.style.color = delta >= 0 ? '#2f9e6b' : '#d64545';
  changeEl.textContent = (delta >= 0 ? '+' : '') + delta;
  card.appendChild(changeEl);
  setTimeout(() => changeEl.remove(), 900);

  let current = from;
  const step = from < to ? 1 : -1;
  const interval = setInterval(() => {
    if(current === to){
      clearInterval(interval);
      return;
    }
    current += step;
    stockEl.textContent = current;
    const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
    bar.style.width = pct + '%';
  }, 20);
}

function showTooltip(key, e){
  const it = state.items[key];
  const history = (state.history[key] || []).slice(-5).reverse().join('\n') || 'Keine';
  tooltip.textContent = it.name + '\nKategorie: ' + it.category + '\nPreis: $' + it.price + '\nBestand: ' + it.stock + '\nLetzte Aktionen:\n' + history;
  tooltip.classList.add('visible');
  moveTooltip(e);
}

function moveTooltip(e){
  tooltip.style.top = (e.pageY + 15) + 'px';
  tooltip.style.left = (e.pageX + 15) + 'px';
}

function hideTooltip(){
  tooltip.classList.remove('visible');
}

function showLogin(){
  if(state.users.length === 0){
    setupOverlay.classList.add('show');
    return;
  }
  const select = document.getElementById('loginUser');
  select.innerHTML = '';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name + ' (' + roleLabel(u.role) + ')';
    select.appendChild(opt);
  });
  if(state.settings.lastUserId){
    select.value = state.settings.lastUserId;
  }
  document.getElementById('loginPin').value = '';
  loginOverlay.classList.add('show');
}

function hideLogin(){
  loginOverlay.classList.remove('show');
}

async function login(){
  const userId = document.getElementById('loginUser').value;
  const pin = document.getElementById('loginPin').value;
  const user = state.users.find(u => u.id === userId);
  if(!user){
    alert('Benutzer nicht gefunden.');
    return;
  }
  if(!pin || pin.length < 4){
    alert('PIN ungueltig.');
    return;
  }
  const hash = await hashPin(pin, user.salt);
  if(hash === user.hash){
    setCurrentUser(user);
    hideLogin();
  }else{
    alert('Falscher PIN.');
  }
}

function logout(){
  setCurrentUser(null);
}

async function createAdmin(){
  const name = document.getElementById('setupName').value.trim();
  const p1 = document.getElementById('setupPin').value;
  const p2 = document.getElementById('setupPin2').value;
  if(!name){
    alert('Name fehlt.');
    return;
  }
  if(!p1 || p1.length < 4){
    alert('PIN zu kurz.');
    return;
  }
  if(p1 !== p2){
    alert('PIN stimmt nicht.');
    return;
  }
  const salt = randomSalt();
  const hash = await hashPin(p1, salt);
  const user = { id: newId(), name, role: 'admin', salt, hash };
  state.users.push(user);
  recordLog('user_add', null, 0, 'Admin erstellt: ' + name);
  saveState();
  setupOverlay.classList.remove('show');
  setCurrentUser(user);
}

function newId(){
  if (cryptoObj && cryptoObj.randomUUID) return cryptoObj.randomUUID();
  return String(Date.now()) + String(Math.random()).slice(2);
}

async function addUser(){
  if(!ensureAdmin()) return;
  const name = document.getElementById('newUserName').value.trim();
  const pin = document.getElementById('newUserPin').value;
  const role = normalizeRole(document.getElementById('newUserRole').value);
  if(!name){
    alert('Name fehlt.');
    return;
  }
  if(!pin || pin.length < 4){
    alert('PIN zu kurz.');
    return;
  }
  if(state.users.some(u => u.name.toLowerCase() === name.toLowerCase())){
    alert('Name existiert bereits.');
    return;
  }
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  state.users.push({ id: newId(), name, role, salt, hash });
  recordLog('user_add', null, 0, 'User erstellt: ' + name);
  saveState();
  render();
}

async function resetUserPin(userId){
  if(!ensureAdmin()) return;
  const user = state.users.find(u => u.id === userId);
  if(!user) return;
  const pin = prompt('Neuer PIN fuer ' + user.name + ':');
  if(!pin || pin.length < 4){
    alert('PIN zu kurz.');
    return;
  }
  user.salt = randomSalt();
  user.hash = await hashPin(pin, user.salt);
  recordLog('pin_reset', null, 0, 'PIN reset fuer ' + user.name);
  saveState();
  render();
}

function removeUser(userId){
  if(!ensureAdmin()) return;
  const user = state.users.find(u => u.id === userId);
  if(!user) return;
  if(user.role === 'admin'){
    const admins = state.users.filter(u => u.role === 'admin');
    if(admins.length <= 1){
      alert('Mindestens ein Admin ist erforderlich.');
      return;
    }
  }
  if(!confirm('Benutzer loeschen?')) return;
  state.users = state.users.filter(u => u.id !== userId);
  if(currentUser && currentUser.id === userId) currentUser = null;
  recordLog('user_remove', null, 0, 'User entfernt: ' + user.name);
  saveState();
  render();
}
function exportJson(){
  if(!ensureAdmin()) return;
  const data = JSON.stringify(state, null, 2);
  downloadFile('lager-backup.json', data, 'application/json');
}

function exportCsv(){
  if(!ensureAdmin()) return;
  const rows = [['Name','Kategorie','Preis','Bestand','MaxBestand']];
  const keys = Object.keys(state.items).sort();
  keys.forEach(k => {
    const it = state.items[k];
    rows.push([it.name, it.category, it.price, it.stock, it.max_stock || 0]);
  });
  const csv = rows.map(r => r.map(escapeCsv).join(';')).join('\n');
  downloadFile('lager-export.csv', csv, 'text/csv');
}

function exportLogsCsv(){
  if(!ensureAdmin()) return;
  const rows = [['Zeit','Benutzer','Aktion','Item','Kategorie','Delta','Notiz']];
  state.logs.forEach(l => {
    rows.push([
      formatDateTime(l.t),
      l.user || '',
      actionLabel(l.action),
      l.item || '',
      l.category || '',
      l.delta || '',
      l.note || ''
    ]);
  });
  const csv = rows.map(r => r.map(escapeCsv).join(';')).join('\n');
  downloadFile('lager-logs.csv', csv, 'text/csv');
}

function exportChartsPng(){
  if(!ensureAdmin()) return;
  renderCharts();
  const stockCanvas = document.getElementById('stockChart');
  const catCanvas = document.getElementById('categoryChart');
  if(stockCanvas) downloadDataUrl('lager-chart-gesamt.png', stockCanvas.toDataURL('image/png'));
  if(catCanvas) downloadDataUrl('lager-chart-kategorie.png', catCanvas.toDataURL('image/png'));
}

function escapeCsv(value){
  const str = String(value ?? '');
  if (str.includes(';') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g,'""') + '"';
  }
  return str;
}

function downloadFile(filename, data, type){
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(filename, dataUrl){
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function importData(file){
  if(!ensureAdmin()) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      state = normalizeState(data);
      recordStat();
      saveState();
      render();
      scheduleLiveTableUpdate();
    }catch(err){
      alert('Fehler beim Import.');
    }
  };
  reader.readAsText(file);
}

function resetAll(){
  if(!ensureAdmin()) return;
  if(!confirm('Alles loeschen?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = clone(DEFAULT_STATE);
  currentUser = null;
  render();
  setupOverlay.classList.add('show');
  scheduleLiveTableUpdate();
}

function totalStock(){
  return Object.values(state.items).reduce((sum, it) => sum + (it.stock || 0), 0);
}

function recordLog(action, key, delta, note){
  const it = key ? state.items[key] : null;
  const entry = {
    t: Date.now(),
    user: currentUser ? currentUser.name : 'System',
    action,
    item: it ? it.name : '',
    category: it ? it.category : '',
    delta: delta || 0,
    note: note || ''
  };
  state.logs.push(entry);
  if(state.logs.length > MAX_LOGS) state.logs = state.logs.slice(-MAX_LOGS);
  sendLogWebhook(entry);
}

function recordStat(){
  state.stats.push({ t: Date.now(), total: totalStock() });
  if(state.stats.length > MAX_STATS) state.stats = state.stats.slice(-MAX_STATS);
}

function formatShortDate(ts){
  const d = new Date(ts);
  return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
}

function buildLiveTableContent(){
  const keys = Object.keys(state.items).sort();
  const lines = [];
  lines.push('Name | Kategorie | Bestand | Preis');
  lines.push('-----|-----------|---------|------');
  for (let i = 0; i < keys.length; i++) {
    const it = state.items[keys[i]];
    lines.push(it.name + ' | ' + it.category + ' | ' + it.stock + ' | $' + it.price);
  }
  let body = lines.join('\n');
  if(body.length > 1800){
    const trimmed = [];
    let size = 0;
    for (let i = 0; i < lines.length; i++) {
      const next = lines[i] + '\n';
      if(size + next.length > 1700){
        trimmed.push('... (gekuerzt)');
        break;
      }
      trimmed.push(lines[i]);
      size += next.length;
    }
    body = trimmed.join('\n');
  }
  const stamp = formatDateTime(Date.now());
  return 'Aktueller Bestand (' + keys.length + ' Items)\\nStand: ' + stamp + '\\n```\\n' + body + '\\n```';
}

let liveUpdateTimer = null;
function scheduleLiveTableUpdate(){
  if(!LIVE_TABLE_WEBHOOK) return;
  if(liveUpdateTimer) clearTimeout(liveUpdateTimer);
  liveUpdateTimer = setTimeout(() => sendLiveTableWebhook(), 500);
}

async function sendLiveTableWebhook(){
  if(!LIVE_TABLE_WEBHOOK) return;
  const payload = { content: buildLiveTableContent() };
  const msgId = state.settings.webhooks && state.settings.webhooks.liveMessageId;
  try{
    if(msgId){
      const res = await fetch(LIVE_TABLE_WEBHOOK + '/messages/' + msgId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        if(res.status === 404){
          state.settings.webhooks.liveMessageId = '';
          saveState(false);
        }
      }
    }else{
      const res = await fetch(LIVE_TABLE_WEBHOOK + '?wait=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(res.ok){
        const data = await res.json();
        if(data && data.id){
          state.settings.webhooks.liveMessageId = data.id;
          saveState(false);
        }
      }
    }
  }catch(err){
    console.warn('Live webhook error', err);
  }
}

function sendLogWebhook(entry){
  if(!LOGS_WEBHOOK) return;
  const content = '[' + formatDateTime(entry.t) + '] ' + (entry.user || '-') +
    ' - ' + actionLabel(entry.action) +
    (entry.item ? (' - ' + entry.item) : '') +
    (entry.delta ? (' (' + (entry.delta > 0 ? '+' : '') + entry.delta + ')') : '') +
    (entry.note ? (' - ' + entry.note) : '');
  fetch(LOGS_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).catch(err => console.warn('Logs webhook error', err));
}
function formatDateTime(ts){
  const d = new Date(ts);
  return d.toLocaleString('de-DE');
}

function cssVar(name, fallback){
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function renderLogs(){
  const body = document.getElementById('logsBody');
  body.innerHTML = '';
  if(!canViewLogs()){
    body.innerHTML = '<tr><td colspan="6" class="empty">Keine Berechtigung.</td></tr>';
    return;
  }
  if(!currentUser){
    body.innerHTML = '<tr><td colspan="6" class="empty">Bitte anmelden.</td></tr>';
    return;
  }
  const logs = state.logs.slice(-200).reverse();
  if(!logs.length){
    body.innerHTML = '<tr><td colspan="6" class="empty">Keine Logs.</td></tr>';
    return;
  }
  logs.forEach(l => {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    const td3 = document.createElement('td');
    const td4 = document.createElement('td');
    const td5 = document.createElement('td');
    const td6 = document.createElement('td');
    td1.textContent = formatDateTime(l.t);
    td2.textContent = l.user || '-';
    td3.textContent = actionLabel(l.action);
    td4.textContent = l.item || '-';
    td5.textContent = l.delta ? (l.delta > 0 ? '+' + l.delta : l.delta) : '';
    td5.style.color = l.delta > 0 ? '#2f9e6b' : (l.delta < 0 ? '#d64545' : '#555');
    td6.textContent = l.note || '';
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tr.appendChild(td4);
    tr.appendChild(td5);
    tr.appendChild(td6);
    body.appendChild(tr);
  });
}

function actionLabel(a){
  const map = {
    einlagern: 'Einlagern',
    auslagern: 'Auslagern',
    verkaufen: 'Verkaufen',
    item_add: 'Item erstellt',
    item_remove: 'Item entfernt',
    user_add: 'User erstellt',
    user_remove: 'User entfernt',
    pin_reset: 'PIN reset'
  };
  return map[a] || a;
}
function prepareCanvas(canvas){
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * ratio;
  const h = canvas.clientHeight * ratio;
  if(canvas.width !== w || canvas.height !== h){
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, ratio };
}

function drawLineChart(canvas, series){
  const { w, h } = prepareCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = cssVar('--canvas-bg','#111');
  ctx.fillRect(0,0,w,h);

  const data = series.slice(-60);
  if(data.length < 2){
    ctx.fillStyle = cssVar('--canvas-text','#c6cbd2');
    ctx.font = '12px Segoe UI, Arial';
    ctx.fillText('Keine Daten', 12, 20);
    return;
  }

  const pad = 24;
  const values = data.map(d => d.total);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if(min === max) { max = min + 1; }

  ctx.strokeStyle = cssVar('--canvas-grid','rgba(255,255,255,0.08)');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.strokeStyle = cssVar('--canvas-line','#8ab4ff');
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad*2);
    const y = h - pad - ((d.total - min) / (max - min)) * (h - pad*2);
    if(i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = data[data.length - 1];
  ctx.fillStyle = cssVar('--canvas-text','#c6cbd2');
  ctx.font = '12px Segoe UI, Arial';
  ctx.fillText('Letzter: ' + last.total, pad, pad - 6);
}

function drawBarChart(canvas, data){
  const { w, h } = prepareCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = cssVar('--canvas-bg','#111');
  ctx.fillRect(0,0,w,h);

  if(!data.length){
    ctx.fillStyle = cssVar('--canvas-text','#c6cbd2');
    ctx.font = '12px Segoe UI, Arial';
    ctx.fillText('Keine Daten', 12, 20);
    return;
  }

  const pad = 24;
  const max = Math.max(...data.map(d => d.value)) || 1;
  const barW = (w - pad*2) / data.length - 10;

  data.forEach((d, i) => {
    const x = pad + i * (barW + 10);
    const barH = ((d.value / max) * (h - pad*2));
    const y = h - pad - barH;
    ctx.fillStyle = categoryColor(d.label);
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = cssVar('--canvas-text','#c6cbd2');
    ctx.font = '11px Segoe UI, Arial';
    ctx.fillText(d.label, x, h - 8);
  });
}

function renderCharts(){
  if(!canViewStats()) return;
  const stockCanvas = document.getElementById('stockChart');
  const catCanvas = document.getElementById('categoryChart');
  const series = state.stats.length ? state.stats : [{t:Date.now(), total: totalStock()}];
  drawLineChart(stockCanvas, series);

  const categoryTotals = {};
  Object.values(state.items).forEach(it => {
    categoryTotals[it.category] = (categoryTotals[it.category] || 0) + (it.stock || 0);
  });
  const data = Object.keys(categoryTotals).map(k => ({ label: k, value: categoryTotals[k] }));
  drawBarChart(catCanvas, data);
}
function syncReportSettingsToUI(){
  const s = state.settings.report;
  document.getElementById('reportTitle').value = s.title || '';
  document.getElementById('reportItems').checked = !!s.includeItems;
  document.getElementById('reportDashboard').checked = !!s.includeDashboard;
  document.getElementById('reportLogs').checked = !!s.includeLogs;
  document.getElementById('reportUsers').checked = !!s.includeUsers;
  document.getElementById('reportCharts').checked = !!s.includeCharts;
  document.getElementById('reportLowOnly').checked = !!s.onlyLowStock;
  document.getElementById('reportDays').value = s.logDays || 30;
}

function updateReportSettings(){
  const s = state.settings.report;
  s.title = document.getElementById('reportTitle').value.trim() || 'Lagerbericht';
  s.includeItems = document.getElementById('reportItems').checked;
  s.includeDashboard = document.getElementById('reportDashboard').checked;
  s.includeLogs = document.getElementById('reportLogs').checked;
  s.includeUsers = document.getElementById('reportUsers').checked;
  s.includeCharts = document.getElementById('reportCharts').checked;
  s.onlyLowStock = document.getElementById('reportLowOnly').checked;
  s.logDays = parseInt(document.getElementById('reportDays').value, 10) || 30;
  saveState();
}

function buildReport(){
  const s = state.settings.report;
  const now = formatDateTime(Date.now());
  const report = document.getElementById('reportView');
  const itemKeys = Object.keys(state.items);
  const items = itemKeys.map(k => state.items[k]).filter(it => !s.onlyLowStock || isLowStock(it));

  let html = '';
  html += '<div class="report-page">';
  html += '<h1>' + escapeHtml(s.title || 'Lagerbericht') + '</h1>';
  html += '<div class="report-meta">Erstellt: ' + escapeHtml(now) + '</div>';
  html += '<div class="report-section"><strong>Zusammenfassung</strong><br>';
  html += 'Items: ' + itemKeys.length + ' | Gesamtbestand: ' + totalStock() + ' | Benutzer: ' + state.users.length;
  html += '</div>';

  if(s.includeCharts){
    renderCharts();
    const stockUrl = document.getElementById('stockChart').toDataURL('image/png');
    const catUrl = document.getElementById('categoryChart').toDataURL('image/png');
    html += '<div class="report-section"><strong>Charts</strong>';
    html += '<div class="report-charts">';
    html += '<img src="' + stockUrl + '" alt="Stock Chart">';
    html += '<img src="' + catUrl + '" alt="Category Chart">';
    html += '</div></div>';
  }

  if(s.includeItems){
    html += '<div class="report-section"><strong>Items</strong>';
    html += '<table><thead><tr><th>Name</th><th>Kategorie</th><th>Bestand</th><th>Preis</th></tr></thead><tbody>';
    items.forEach(it => {
      html += '<tr><td>' + escapeHtml(it.name) + '</td><td>' + escapeHtml(it.category) + '</td><td>' + it.stock + '</td><td>$' + it.price + '</td></tr>';
    });
    if(!items.length) html += '<tr><td colspan="4">Keine Items</td></tr>';
    html += '</tbody></table></div>';
  }

  if(s.includeDashboard){
    html += '<div class="report-section"><strong>Dashboard</strong>';
    html += '<table><thead><tr><th>Item</th><th>Kategorie</th><th>Bestand</th><th>Preis</th></tr></thead><tbody>';
    itemKeys.forEach(k => {
      const it = state.items[k];
      html += '<tr><td>' + escapeHtml(it.name) + '</td><td>' + escapeHtml(it.category) + '</td><td>' + it.stock + '</td><td>$' + it.price + '</td></tr>';
    });
    if(!itemKeys.length) html += '<tr><td colspan="4">Keine Items</td></tr>';
    html += '</tbody></table></div>';
  }

  if(s.includeLogs){
    const days = Math.max(1, s.logDays || 30);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const logs = state.logs.filter(l => l.t >= since).slice(-200);
    html += '<div class="report-section"><strong>Logs (letzte ' + days + ' Tage)</strong>';
    html += '<table><thead><tr><th>Zeit</th><th>Benutzer</th><th>Aktion</th><th>Item</th><th>Delta</th><th>Notiz</th></tr></thead><tbody>';
    logs.forEach(l => {
      const delta = l.delta ? (l.delta > 0 ? '+' + l.delta : l.delta) : '';
      html += '<tr><td>' + escapeHtml(formatDateTime(l.t)) + '</td><td>' + escapeHtml(l.user || '-') + '</td><td>' + escapeHtml(actionLabel(l.action)) + '</td><td>' + escapeHtml(l.item || '-') + '</td><td>' + delta + '</td><td>' + escapeHtml(l.note || '') + '</td></tr>';
    });
    if(!logs.length) html += '<tr><td colspan="6">Keine Logs</td></tr>';
    html += '</tbody></table></div>';
  }

  if(s.includeUsers){
    html += '<div class="report-section"><strong>Benutzer</strong>';
    html += '<table><thead><tr><th>Name</th><th>Rolle</th></tr></thead><tbody>';
    state.users.forEach(u => {
      html += '<tr><td>' + escapeHtml(u.name) + '</td><td>' + escapeHtml(roleLabel(u.role)) + '</td></tr>';
    });
    if(!state.users.length) html += '<tr><td colspan="2">Keine Benutzer</td></tr>';
    html += '</tbody></table></div>';
  }

  html += '</div>';
  report.innerHTML = html;
}

function escapeHtml(str){
  return String(str || '').replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
}

function printReport(){
  if(!ensureAdmin()) return;
  updateReportSettings();
  buildReport();
  setTimeout(() => window.print(), 50);
}
function syncFromStorage(){
  if(serverMode) return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return;
  try{
    const data = JSON.parse(raw);
    const oldUserId = currentUser && currentUser.id;
    state = normalizeState(data);
    if(oldUserId){
      const u = state.users.find(x => x.id === oldUserId);
      currentUser = u || null;
    }
    render();
  }catch(err){
    // ignore
  }
}

loginBtn.addEventListener('click', showLogin);
logoutBtn.addEventListener('click', logout);
document.getElementById('loginConfirm').addEventListener('click', login);
document.getElementById('loginCancel').addEventListener('click', hideLogin);

filterInput.addEventListener('input', renderItems);
sortSelect.addEventListener('change', renderItems);
if(statusBtn){
  statusBtn.addEventListener('click', checkServerStatus);
}

document.getElementById('addItemBtn').addEventListener('click', addItem);
document.getElementById('addUserBtn').addEventListener('click', addUser);
document.getElementById('exportJsonBtn').addEventListener('click', exportJson);
document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
document.getElementById('exportLogsBtn').addEventListener('click', exportLogsCsv);
document.getElementById('exportChartsBtn').addEventListener('click', exportChartsPng);
document.getElementById('resetBtn').addEventListener('click', resetAll);
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(file) importData(file);
  e.target.value = '';
});

document.getElementById('setupConfirm').addEventListener('click', createAdmin);
document.getElementById('setupSkip').addEventListener('click', () => {
  setupOverlay.classList.remove('show');
});

document.getElementById('reportTitle').addEventListener('input', updateReportSettings);
document.getElementById('reportItems').addEventListener('change', updateReportSettings);
document.getElementById('reportDashboard').addEventListener('change', updateReportSettings);
document.getElementById('reportLogs').addEventListener('change', updateReportSettings);
document.getElementById('reportUsers').addEventListener('change', updateReportSettings);
document.getElementById('reportCharts').addEventListener('change', updateReportSettings);
document.getElementById('reportLowOnly').addEventListener('change', updateReportSettings);
document.getElementById('reportDays').addEventListener('input', updateReportSettings);
document.getElementById('printReportBtn').addEventListener('click', printReport);
if(themeToggle){
  themeToggle.addEventListener('click', () => {
    const current = document.body.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

window.addEventListener('storage', (e) => {
  if(e.key === STORAGE_KEY) syncFromStorage();
});
if(channel){
  channel.onmessage = (ev) => {
    if(ev.data && ev.data.type === 'sync') syncFromStorage();
  };
}

async function init(){
  applyTheme(getInitialTheme());
  initServerMode();
  if(API_ENABLED){
    await loadFromServer();
  }
  if(state.stats.length === 0) recordStat();
  render();
  if(serverMode) startPolling();
  startReconnectLoop();
  if(Object.keys(state.items).length > 0) scheduleLiveTableUpdate();
}

init();
