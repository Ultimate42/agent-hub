// Agent Hub app (PWA): threads = rooms where the user is a human member.
// Auth is an HttpOnly cookie set by /app/api; this script never stores tokens.

const API = '/app/api';
const PAGE = 50;

const $ = (id) => document.getElementById(id);
const els = {
  layout: $('app'), threads: $('threads'), conn: $('conn'),
  chatName: $('chat-name'), chatMe: $('chat-me'),
  messages: $('messages'), list: $('message-list'), more: $('more-btn'),
  composer: $('composer'), input: $('input'), send: $('send-btn'),
  pushBtn: $('push-btn'), pushHint: $('push-hint'),
  dialog: $('add-dialog'), addForm: $('add-form'), addToken: $('add-token'), addError: $('add-error')
};

const state = {
  threads: new Map(),  // id -> thread view from the API
  current: null,       // open thread id
  messages: [],        // messages of the open thread (ascending ids)
  hasMore: false,
  me: null,
  lastReadAtOpen: 0,
  ws: null,
  wsRetry: 0
};

// --- API helpers ---------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- Formatting ------------------------------------------------------------------

// SQLite gives "YYYY-MM-DD HH:MM:SS" (UTC, no zone); live events give ISO strings.
function parseDate(s) {
  if (!s) return new Date();
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

function formatTime(s) {
  const d = parseDate(s);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  return (name || '?').split(/[\s–-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

const isSystem = (m) => m.type === 'system' || m.author === 'system' || m.author === 'HubWatchdog' || !m.author;

// Text with clickable http(s) links, built with DOM nodes only (no innerHTML).
function renderText(container, text) {
  const re = /https?:\/\/[^\s<>"')]+/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    container.append(text.slice(last, match.index));
    const a = document.createElement('a');
    a.href = match[0];
    a.textContent = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    container.append(a);
    last = match.index + match[0].length;
  }
  container.append(text.slice(last));
}

// --- Thread list -------------------------------------------------------------------

function sortedThreads() {
  return [...state.threads.values()].sort((a, b) => (b.last_message?.id || 0) - (a.last_message?.id || 0));
}

function renderThreads() {
  els.threads.replaceChildren();
  const threads = sortedThreads();
  if (threads.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list';
    li.textContent = 'Aucun fil. Ajoute-en un avec « + ».';
    els.threads.append(li);
  }
  for (const t of threads) {
    const li = document.createElement('li');
    li.className = 'thread';
    li.tabIndex = 0;
    li.dataset.id = t.id;
    li.setAttribute('aria-current', String(t.id === state.current));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(t.room_name);

    const main = document.createElement('div');
    main.className = 'thread-main';
    const name = document.createElement('div');
    name.className = 'thread-name';
    name.textContent = t.room_name || 'Salon';
    const lastLine = document.createElement('div');
    lastLine.className = 'thread-last';
    if (t.last_message) {
      const who = t.last_message.author === t.name ? 'Moi' : t.last_message.author;
      lastLine.textContent = `${who ? who + ' : ' : ''}${t.last_message.content}`.slice(0, 140);
    }
    main.append(name, lastLine);

    const meta = document.createElement('div');
    meta.className = 'thread-meta';
    if (t.last_message) meta.append(formatTime(t.last_message.created_at));
    if (t.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = t.unread > 99 ? '99+' : String(t.unread);
      meta.append(badge);
    }

    li.append(avatar, main, meta);
    els.threads.append(li);
  }
  const total = threads.reduce((n, t) => n + (t.unread || 0), 0);
  document.title = total > 0 ? `(${total}) Agent Hub` : 'Agent Hub';
  navigator.setAppBadge?.(total).catch?.(() => {});
}

async function loadThreads() {
  const { threads } = await api('/threads');
  const prev = state.threads;
  state.threads = new Map(threads.map((t) => {
    // A live event may have arrived while this request was in flight: keep the newer local state
    const old = prev.get(t.id);
    if (old?.last_message?.id > (t.last_message?.id || 0)) {
      return { ...t, last_message: old.last_message, unread: Math.max(t.unread, old.unread) };
    }
    return t;
  }).map(t => [t.id, t]));
  renderThreads();
  // The open thread is already acked locally: do not let a stale list resurrect its badge
  if (state.current) markRead();
  if (state.current && !state.threads.has(state.current)) closeThread();
}

// --- Conversation -------------------------------------------------------------------

function messageNode(m) {
  const li = document.createElement('li');
  li.dataset.id = m.id ?? '';
  if (isSystem(m)) {
    li.className = 'msg system';
  } else {
    li.className = 'msg ' + (m.author === state.me ? 'out' : 'in');
  }
  if (m.pending) li.classList.add('pending');
  if (m.failed) li.classList.add('failed');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  renderText(bubble, m.content || '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (!isSystem(m) && m.author !== state.me) {
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = m.author;
    meta.append(author);
  }
  meta.append(m.failed ? 'Échec de l\'envoi' : m.pending ? 'Envoi…' : formatTime(m.created_at));
  li.append(bubble, meta);
  return li;
}

function renderMessages({ keepScroll = false } = {}) {
  const box = els.messages;
  const fromBottom = box.scrollHeight - box.scrollTop;
  els.list.replaceChildren();
  let sepShown = false;
  for (const m of state.messages) {
    if (!sepShown && state.lastReadAtOpen && m.id > state.lastReadAtOpen && m.author !== state.me && !isSystem(m)) {
      const sep = document.createElement('li');
      sep.className = 'unread-sep';
      sep.textContent = 'Non lus';
      els.list.append(sep);
      sepShown = true;
    }
    els.list.append(messageNode(m));
  }
  els.more.hidden = !state.hasMore;
  box.scrollTop = keepScroll ? box.scrollHeight - fromBottom : box.scrollHeight;
}

function nearBottom() {
  const box = els.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

async function openThread(id) {
  const t = state.threads.get(id);
  if (!t) return;
  state.current = id;
  state.me = t.name;
  state.lastReadAtOpen = t.last_read_id;
  els.layout.dataset.thread = String(id);
  els.layout.dataset.view = 'chat';
  els.chatName.textContent = t.room_name || 'Salon';
  els.chatMe.textContent = `toi : ${t.name}`;
  state.messages = [];
  renderMessages();
  renderThreads();
  history.replaceState(null, '', `#t=${id}`);
  clearNotifications(id);

  const data = await api(`/threads/${id}/messages?limit=${PAGE}`);
  if (state.current !== id) return;
  state.messages = data.messages;
  state.hasMore = data.has_more;
  state.me = data.me;
  renderMessages();
  markRead();
  if (!matchMedia('(pointer: coarse)').matches) els.input.focus();
}

function closeThread() {
  state.current = null;
  delete els.layout.dataset.thread;
  els.layout.dataset.view = 'list';
  history.replaceState(null, '', location.pathname);
  renderThreads();
}

async function loadOlder() {
  const oldest = state.messages.find(m => m.id)?.id;
  if (!state.current || !oldest) return;
  const id = state.current;
  const data = await api(`/threads/${id}/messages?limit=${PAGE}&before_id=${oldest}`);
  if (state.current !== id) return;
  state.messages = [...data.messages, ...state.messages];
  state.hasMore = data.has_more;
  renderMessages({ keepScroll: true });
}

// Ack everything shown in the open thread while the app is visible.
async function markRead() {
  const t = state.threads.get(state.current);
  if (!t || document.visibilityState !== 'visible') return;
  const lastId = state.messages.reduce((n, m) => Math.max(n, m.id || 0), 0);
  if (!lastId || (t.unread === 0 && t.last_read_id >= lastId)) return;
  try {
    const r = await api(`/threads/${t.id}/ack`, { method: 'POST', body: { up_to_id: lastId } });
    // loadThreads() may have replaced the thread object meanwhile: update the current one
    const cur = state.threads.get(t.id);
    if (cur) {
      cur.last_read_id = Math.max(cur.last_read_id || 0, r.last_read_id);
      cur.unread = r.unread_remaining;
    }
    renderThreads();
  } catch { /* retried on next event */ }
}

async function send(text) {
  const id = state.current;
  const temp = { id: null, content: text, author: state.me, pending: true, created_at: new Date().toISOString() };
  state.messages.push(temp);
  renderMessages();
  try {
    const { message } = await api(`/threads/${id}/messages`, { method: 'POST', body: { content: text } });
    if (state.current !== id) return;
    const i = state.messages.indexOf(temp);
    // The live echo may already have arrived as a separate entry: keep a single copy
    if (state.messages.some(m => m !== temp && m.id === message.id)) state.messages.splice(i, 1);
    else state.messages[i] = message;
    const t = state.threads.get(id);
    if (t) { t.last_message = message; t.last_read_id = message.id; t.unread = 0; }
  } catch (err) {
    temp.pending = false;
    temp.failed = true;
    temp.content = text;
    if (err.status === 404) await loadThreads();
  }
  renderMessages();
  renderThreads();
}

// --- Live updates (one WebSocket for every thread) ----------------------------------

function setConn(s) {
  els.conn.dataset.state = s;
  els.conn.title = { on: 'Temps réel connecté', connecting: 'Connexion…', off: 'Hors ligne' }[s];
}

function connect() {
  if (state.ws || state.threads.size === 0) return;
  setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?app=1`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
    setConn('on');
    sendVisibility();
    catchUp();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.thread && msg.id && typeof msg.content === 'string') onLiveMessage(msg);
  };
  ws.onclose = (ev) => {
    state.ws = null;
    setConn('off');
    if (ev.code === 4001) return; // session gone: wait for user action
    const delay = Math.min(30000, 1000 * 2 ** state.wsRetry++);
    setTimeout(connect, delay);
  };
}

// The hub sends Web Push only to sessions with no app visible on screen
function sendVisibility() {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'visibility', visible: document.visibilityState === 'visible' }));
  }
}

function reconnect() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  connect();
}

function onLiveMessage(msg) {
  const t = state.threads.get(msg.thread);
  if (!t) return;
  const { thread, ...message } = msg;
  t.last_message = message;
  const mine = message.author === t.name;
  if (thread === state.current) {
    if (!state.messages.some(m => m.id === message.id)) {
      const atBottom = nearBottom();
      // Own message sent from this tab: the REST response replaces the pending copy
      const pending = mine && state.messages.find(m => m.pending && m.content === message.content);
      if (pending) Object.assign(pending, message, { pending: false });
      else state.messages.push(message);
      renderMessages({ keepScroll: !atBottom });
    }
    if (!mine) {
      t.unread += 1;
      markRead();
    }
  } else if (!mine) {
    t.unread += 1;
  }
  renderThreads();
}

// After a reconnect: refresh counters and the open thread (messages missed while offline).
async function catchUp() {
  await loadThreads();
  if (!state.current) return;
  const id = state.current;
  const data = await api(`/threads/${id}/messages?limit=${PAGE}`);
  if (state.current !== id) return;
  const known = new Set(state.messages.map(m => m.id));
  const fresh = data.messages.filter(m => !known.has(m.id));
  if (fresh.length) {
    state.messages = [...state.messages.filter(m => m.id || m.pending || m.failed), ...fresh]
      .sort((a, b) => (a.id || Infinity) - (b.id || Infinity));
    renderMessages({ keepScroll: !nearBottom() });
    markRead();
  }
}

// --- Web Push ---------------------------------------------------------------------------
// While the app is hidden or closed, the hub sends a Web Push; sw.js shows it and opens the thread on click.

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function urlBase64ToUint8Array(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshPushButton() {
  const btn = els.pushBtn;
  const hint = els.pushHint;
  btn.hidden = true;
  hint.hidden = true;
  if (state.threads.size === 0) return;
  if (!pushSupported()) {
    // iOS only offers Web Push to apps installed on the home screen
    if (isIos() && !isStandalone()) {
      hint.textContent = 'Pour les notifications : Partager › « Sur l\'écran d\'accueil », puis ouvre l\'appli depuis l\'icône.';
      hint.hidden = false;
    }
    return;
  }
  btn.hidden = false;
  btn.disabled = false;
  if (Notification.permission === 'denied') {
    btn.textContent = 'Notifications bloquées (réglages du navigateur)';
    btn.disabled = true;
    return;
  }
  const sub = await currentSubscription().catch(() => null);
  btn.textContent = sub ? 'Désactiver les notifications' : 'Activer les notifications';
  btn.dataset.on = sub ? '1' : '';
}

async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused
  if (sub && sub.options?.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey).join();
    if (current !== urlBase64ToUint8Array(public_key).join()) { await sub.unsubscribe(); sub = null; }
  }
  // subscribe() talks to the browser vendor's push service: never leave the button hanging
  sub ||= await Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(public_key) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('le service de notifications ne répond pas')), 20000))
  ]);
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
}

async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

// Re-register an existing subscription (new session, rotated server key, expired endpoint…)
async function syncPush() {
  const sub = await currentSubscription().catch(() => null);
  if (sub && Notification.permission === 'granted' && state.threads.size) {
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
  }
}

async function clearNotifications(threadId) {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  for (const n of await reg?.getNotifications({ tag: `thread-${threadId}` }) || []) n.close();
}

// --- Adding a thread ----------------------------------------------------------------

async function addThread(token) {
  const { thread } = await api('/threads', { method: 'POST', body: { member_token: token } });
  state.threads.set(thread.id, thread);
  renderThreads();
  reconnect(); // the socket subscribes to the session's threads at connect time
  return thread;
}

function showAddDialog() {
  els.addError.hidden = true;
  els.addToken.value = '';
  els.dialog.showModal();
}

// --- Events --------------------------------------------------------------------------

els.threads.addEventListener('click', (e) => {
  const li = e.target.closest('.thread');
  if (li) openThread(Number(li.dataset.id));
});
els.threads.addEventListener('keydown', (e) => {
  const li = e.target.closest('.thread');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openThread(Number(li.dataset.id)); }
});

$('back-btn').addEventListener('click', closeThread);
els.more.addEventListener('click', loadOlder);
els.messages.addEventListener('scroll', () => {
  if (els.messages.scrollTop < 40 && state.hasMore && !els.more.disabled) {
    els.more.disabled = true;
    loadOlder().finally(() => { els.more.disabled = false; });
  }
});

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || !state.current) return;
  els.input.value = '';
  autosize();
  send(text);
});
els.input.addEventListener('keydown', (e) => {
  // Desktop: Enter sends, Shift+Enter = new line. Touch: the send button sends.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = els.input.scrollHeight + 'px';
}
els.input.addEventListener('input', autosize);

$('add-btn').addEventListener('click', showAddDialog);
$('add-cancel').addEventListener('click', () => els.dialog.close());
els.addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const t = await addThread(els.addToken.value.trim());
    els.dialog.close();
    openThread(t.id);
    refreshPushButton();
  } catch (err) {
    els.addError.textContent = err.status === 403 ? 'Jeton invalide ou membre non humain.' : err.message;
    els.addError.hidden = false;
  }
});

$('remove-btn').addEventListener('click', async () => {
  const t = state.threads.get(state.current);
  if (!t || !confirm(`Retirer « ${t.room_name} » de l'appli ? (Le salon et ses messages restent sur le hub.)`)) return;
  await api(`/threads/${t.id}`, { method: 'DELETE' }).catch(() => {});
  state.threads.delete(t.id);
  closeThread();
  reconnect();
});

$('logout-btn').addEventListener('click', async () => {
  if (!confirm('Se déconnecter de cet appareil ?')) return;
  await disablePush().catch(() => {});
  await api('/logout', { method: 'POST', body: {} }).catch(() => {});
  location.replace(location.pathname);
});

els.pushBtn.addEventListener('click', async () => {
  els.pushBtn.disabled = true;
  try {
    if (els.pushBtn.dataset.on) await disablePush();
    else await enablePush();
  } catch (err) {
    alert(`Notifications indisponibles : ${err.message}`);
  }
  refreshPushButton();
});

document.addEventListener('visibilitychange', () => {
  sendVisibility();
  if (document.visibilityState !== 'visible') return;
  markRead();
  if (state.current) clearNotifications(state.current);
  if (!state.ws) connect();
});

// Click on a notification while the app is already open (sw.js posts the thread to open)
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-thread' && state.threads.has(e.data.thread)) openThread(e.data.thread);
});
window.addEventListener('online', () => { if (!state.ws) connect(); });

// --- Start -----------------------------------------------------------------------------

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});

  // Onboarding link: /app/#add=<member token> (the fragment never reaches the server logs)
  const params = new URLSearchParams(location.hash.slice(1));
  const addToken = params.get('add');
  if (addToken) history.replaceState(null, '', location.pathname);

  await loadThreads();
  let openId = Number(params.get('t')) || null;
  if (addToken) {
    try {
      openId = (await addThread(addToken)).id;
    } catch (err) {
      showAddDialog();
      els.addError.textContent = 'Le lien d\'ajout est invalide ou expiré.';
      els.addError.hidden = false;
    }
  }
  if (state.threads.size === 0 && !els.dialog.open) showAddDialog();
  connect();
  refreshPushButton();
  syncPush();
  if (openId && state.threads.has(openId)) openThread(openId);
  else if (!matchMedia('(max-width: 720px)').matches && state.threads.size) openThread(sortedThreads()[0].id);
}

start();
