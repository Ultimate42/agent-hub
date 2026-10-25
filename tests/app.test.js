import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = '4191';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-app-${process.pid}-${Date.now()}.db`);
let proc;

const rest = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
};
const createRoom = async (name) => (await rest('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) })).data.room_token;
const join = async (room, name, role) =>
  (await rest(`/api/rooms/${room}/join`, { method: 'POST', body: JSON.stringify({ name, role }) })).data.member_token;
const postAs = (room, token, content) => rest(`/api/rooms/${room}/messages`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ content })
});

// Minimal cookie jar: one app session
function appClient() {
  let cookie = null;
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(BASE + '/app/api' + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, setCookie: set, data: await r.json().catch(() => null) };
  };
  return { call, cookie: () => cookie };
}

function openAppSocket(cookie, origin = BASE) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?app=1`, { headers });
  const received = [];
  ws.on('message', (d) => received.push(JSON.parse(d.toString())));
  const closed = new Promise((res) => ws.on('close', (code) => res(code)));
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return { ws, received, closed, opened };
}
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};

describe('PWA app (/app)', () => {
  let coachRoom, managerRoom, florentCoach, florentManager, coach, manager;

  before(async () => {
    proc = spawn('node', ['src/index.js'], {
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, HUB_RATE_LIMIT_PER_MINUTE: '100000' }, stdio: 'pipe'
    });
    proc.stdout.on('data', () => {}); proc.stderr.on('data', (d) => process.env.DEBUG_APP_TEST && process.stderr.write(d));
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    coachRoom = await createRoom('Coach de vie');
    managerRoom = await createRoom('Manager');
    florentCoach = await join(coachRoom, 'Florent', 'human');
    florentManager = await join(managerRoom, 'Florent', 'human');
    coach = await join(coachRoom, 'Coach', 'agent');
    manager = await join(managerRoom, 'CoachManager', 'agent');
  });

  after(async () => {
    await new Promise((res) => { proc.once('exit', res); proc.kill('SIGTERM'); });
    for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(DB + x); } catch {}
  });

  test('serves the app shell with a strict CSP (no inline script)', async () => {
    const r = await fetch(BASE + '/app/');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<script type="module" src="app.js">/);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const sw = await fetch(BASE + '/app/sw.js');
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(BASE + '/app/manifest.webmanifest')).status, 200);
  });

  test('refuses invalid and non-human tokens without creating a session', async () => {
    const c = appClient();
    let r = await c.call('/threads', { method: 'POST', body: { member_token: 'nope-nope-nope-nope' } });
    assert.equal(r.status, 403);
    assert.equal(r.setCookie, null);
    r = await c.call('/threads', { method: 'POST', body: { member_token: coach } });
    assert.equal(r.status, 403);
    assert.equal(r.setCookie, null);
    assert.deepEqual((await c.call('/threads')).data, { threads: [] });
    assert.equal((await c.call('/threads/1/messages')).status, 401);
  });

  test('cookie session: threads, history, post, ack; token never echoed', async () => {
    await postAs(coachRoom, coach, 'Bonjour Florent');
    const c = appClient();
    const r = await c.call('/threads', { method: 'POST', body: { member_token: florentCoach } });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /SameSite=Strict/);
    assert.ok(!JSON.stringify(r.data).includes(florentCoach), 'member token must not be returned');
    assert.equal(r.data.thread.room_name, 'Coach de vie');
    assert.equal(r.data.thread.unread, 1);

    await c.call('/threads', { method: 'POST', body: { member_token: florentManager } });
    const list = (await c.call('/threads')).data.threads;
    assert.deepEqual(list.map(t => t.room_name).sort(), ['Coach de vie', 'Manager']);
    assert.ok(!JSON.stringify(list).includes('token'));

    const id = r.data.thread.id;
    const hist = (await c.call(`/threads/${id}/messages`)).data;
    assert.equal(hist.me, 'Florent');
    assert.equal(hist.messages.at(-1).content, 'Bonjour Florent');

    const sent = await c.call(`/threads/${id}/messages`, { method: 'POST', body: { content: 'Salut coach' } });
    assert.equal(sent.status, 201);
    assert.equal(sent.data.message.author, 'Florent');
    // the agent sees it through the regular API
    const seen = await rest(`/api/rooms/${coachRoom}/messages?mode=recent`, { headers: { Authorization: `Bearer ${coach}` } });
    assert.ok(seen.data.messages.some(m => m.content === 'Salut coach' && m.author === 'Florent'));
    // posting marked the thread as read
    assert.equal((await c.call('/threads')).data.threads.find(t => t.id === id).unread, 0);

    await postAs(coachRoom, coach, 'Comment vas-tu ?');
    let t = (await c.call('/threads')).data.threads.find(x => x.id === id);
    assert.equal(t.unread, 1);
    await c.call(`/threads/${id}/ack`, { method: 'POST', body: { up_to_id: t.last_message.id } });
    t = (await c.call('/threads')).data.threads.find(x => x.id === id);
    assert.equal(t.unread, 0);

    // another session cannot reach this thread by id
    const other = appClient();
    await other.call('/threads', { method: 'POST', body: { member_token: florentManager } });
    assert.equal((await other.call(`/threads/${id}/messages`)).status, 404);
  });

  test('CSRF guards: cross-origin and non-JSON writes are refused', async () => {
    const c = appClient();
    await c.call('/threads', { method: 'POST', body: { member_token: florentCoach } });
    const id = (await c.call('/threads')).data.threads[0].id;
    let r = await c.call(`/threads/${id}/messages`, { method: 'POST', body: { content: 'x' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await c.call(`/threads/${id}/messages`, { method: 'POST', body: 'content=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
  });

  test('rotating the member token revokes the thread', async () => {
    const room = await createRoom('Rotation');
    const tok = await join(room, 'Florent', 'human');
    const c = appClient();
    const { data } = await c.call('/threads', { method: 'POST', body: { member_token: tok } });
    assert.equal((await c.call(`/threads/${data.thread.id}/messages`)).status, 200);
    await join(room, 'Florent', 'human'); // rejoin = new token, old one invalid
    assert.equal((await c.call(`/threads/${data.thread.id}/messages`)).status, 404);
    assert.ok(!(await c.call('/threads')).data.threads.some(t => t.id === data.thread.id));
  });

  test('one WebSocket receives every thread, tagged; cookie and origin are required', async () => {
    const c = appClient();
    const a = await c.call('/threads', { method: 'POST', body: { member_token: florentCoach } });
    const b = await c.call('/threads', { method: 'POST', body: { member_token: florentManager } });

    const s = openAppSocket(c.cookie());
    await s.opened;
    assert.ok(await until(() => s.received.some(m => m.type === 'connected')));
    await postAs(coachRoom, coach, 'live coach');
    await postAs(managerRoom, manager, 'live manager');
    assert.ok(await until(() => s.received.filter(m => m.content?.startsWith('live ')).length === 2));
    const byContent = Object.fromEntries(s.received.filter(m => m.content).map(m => [m.content, m.thread]));
    assert.equal(byContent['live coach'], a.data.thread.id);
    assert.equal(byContent['live manager'], b.data.thread.id);
    s.ws.close();

    const noCookie = openAppSocket(null);
    assert.equal(await noCookie.closed, 4001);
    const evil = openAppSocket(c.cookie(), 'https://evil.example');
    assert.equal(await evil.closed, 4003);
  });

  test('logout destroys the session', async () => {
    const c = appClient();
    await c.call('/threads', { method: 'POST', body: { member_token: florentCoach } });
    const r = await c.call('/logout', { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /Max-Age=0/);
    assert.equal((await c.call('/threads')).data.threads.length, 0);
    assert.equal((await c.call('/threads/1/messages')).status, 401);
  });
});
