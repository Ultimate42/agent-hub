import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const PORT = '4147';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-cursor-${process.pid}-${Date.now()}.db`);
let proc;
let room;

const rest = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let rpc = 0;
const tool = async (name, args) => {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })
  });
  const j = await r.json();
  const t = j.result.content[0].text;
  return j.result.isError ? { error: t } : JSON.parse(t);
};
const join = async (name) => (await tool('join_room', { room_token: room, name }));
const post = (tok, content) => tool('post_message', { member_token: tok, content });

function start(dbPath) {
  const p = spawn('node', ['src/index.js'], { cwd: process.cwd(), env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: dbPath, HUB_RATE_LIMIT_PER_MINUTE: '100000' }, stdio: 'pipe' });
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  return p;
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
const stop = (p) => new Promise((res) => { p.once('exit', res); p.kill('SIGTERM'); });

describe('Server-side read cursor', () => {
  before(async () => {
    proc = start(DB);
    await ready();
    const r = await rest('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'cursor' }) });
    room = r.data.room_token;
  });
  after(async () => {
    await stop(proc);
    for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(DB + x); } catch {}
  });

  test('disconnect then return: receives ALL unread, paginated, own excluded, with unread_remaining', async () => {
    const a = (await join('Alice')).member_token;
    const b = (await join('Bob')).member_token;
    for (let i = 1; i <= 130; i++) await post(a, `a${i}`);
    await post(b, 'from bob');
    // Bob "disconnects"; comes back with a fresh token (rejoin) -> join reports unread
    const rejoin = await join('Bob');
    assert.equal(rejoin.is_rejoin, true);
    assert.equal(rejoin.unread_count, 130);
    const bt = rejoin.member_token;
    const p1 = await tool('wait_for_messages', { member_token: bt });
    assert.equal(p1.messages.length, 100);
    assert.equal(p1.messages[0].content, 'a1');
    assert.equal(p1.unread_remaining, 30);
    const p2 = await tool('wait_for_messages', { member_token: bt });
    assert.equal(p2.messages.length, 30);
    assert.equal(p2.messages[29].content, 'a130');
    assert.equal(p2.unread_remaining, 0);
    assert.ok(!p2.messages.some(m => m.author === 'Bob'));
    const p3 = await tool('wait_for_messages', { member_token: bt, timeout: 300 });
    assert.equal(p3.messages.length, 0);
  });

  test('two members have independent cursors; /members shows unread_count', async () => {
    const a = (await join('Alice')).member_token;
    const b = (await join('Bob')).member_token;
    await post(a, 'x1'); await post(a, 'x2');
    const mem = await rest(`/api/rooms/${room}/members`, { headers: { Authorization: `Bearer ${a}` } });
    const byName = Object.fromEntries(mem.data.members.map(m => [m.name, m.unread_count]));
    assert.equal(byName.Bob, 2);
    const bm = await tool('wait_for_messages', { member_token: b });
    assert.equal(bm.messages.length, 2);
    const mem2 = await rest(`/api/rooms/${room}/members`, { headers: { Authorization: `Bearer ${a}` } });
    const by2 = Object.fromEntries(mem2.data.members.map(m => [m.name, m.unread_count]));
    assert.equal(by2.Bob, 0);
    assert.equal(by2.Alice, 1, "Alice's cursor is independent: she still has Bob's message unread");
  });

  test('crash before ack (auto_ack=false): messages are re-delivered until ack_messages; cursor never goes back', async () => {
    const a = (await join('Alice')).member_token;
    const c = (await join('Archivist')).member_token;
    const id1 = (await post(a, 'job1')).message_id;
    const id2 = (await post(a, 'job2')).message_id;
    const first = await tool('wait_for_messages', { member_token: c, auto_ack: false });
    assert.deepEqual(first.messages.map(m => m.content), ['job1', 'job2']);
    // crash: nothing acked, client comes back (new token)
    const c2 = (await join('Archivist')).member_token;
    const again = await tool('wait_for_messages', { member_token: c2, auto_ack: false });
    assert.deepEqual(again.messages.map(m => m.content), ['job1', 'job2']);
    const ack1 = await tool('ack_messages', { member_token: c2, up_to_id: id1 });
    assert.equal(ack1.unread_remaining, 1);
    const ack0 = await tool('ack_messages', { member_token: c2, up_to_id: 1 });
    assert.equal(ack0.last_read_id, id1, 'no backward move');
    const rest1 = await tool('wait_for_messages', { member_token: c2, auto_ack: false });
    assert.deepEqual(rest1.messages.map(m => m.id), [id2]);
    await tool('ack_messages', { member_token: c2, up_to_id: id2 });
    const none = await tool('wait_for_messages', { member_token: c2, timeout: 300 });
    assert.equal(none.messages.length, 0);
    // ack beyond the last id is clamped
    const big = await tool('ack_messages', { member_token: c2, up_to_id: 99999999 });
    assert.equal(big.last_read_id, id2);
  });

  test('REST: ack route, history with before_id, explicit since does not skip unread', async () => {
    const a = (await join('Alice')).member_token;
    const d = (await join('Dave')).member_token;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await post(a, `r${i}`)).message_id);
    const H = { Authorization: `Bearer ${d}` };
    // explicit since beyond the cursor: legacy result, cursor untouched
    const s = await rest(`/api/rooms/${room}/messages?since=${ids[1] - 1}`, { headers: H });
    assert.equal(s.data.messages.length, 2);
    assert.equal(s.data.unread_remaining, 3);
    const all = await rest(`/api/rooms/${room}/messages?auto_ack=false`, { headers: H });
    assert.equal(all.data.messages.length, 3);
    assert.equal(all.data.unread_remaining, 3);
    const ack = await rest(`/api/rooms/${room}/ack`, { method: 'POST', headers: H, body: JSON.stringify({ up_to_id: ids[2] }) });
    assert.equal(ack.data.unread_remaining, 0);
    const bad = await rest(`/api/rooms/${room}/ack`, { method: 'POST', headers: H, body: JSON.stringify({ up_to_id: 'x' }) });
    assert.equal(bad.status, 400);
    const h = await rest(`/api/rooms/${room}/messages/history?before_id=${ids[2]}&limit=2`, { headers: H });
    assert.deepEqual(h.data.messages.map(m => m.id), [ids[0] - 0, ids[1]].filter(Boolean).slice(-2));
    assert.equal(h.data.has_more, true);
    const hm = await tool('get_history', { member_token: d, before_id: ids[2], limit: 2 });
    assert.deepEqual(hm.messages.map(m => m.id), h.data.messages.map(m => m.id));
  });

  test('REST long-poll without since wakes on a new message and advances the cursor', async () => {
    const a = (await join('Alice')).member_token;
    const e = (await join('Erin')).member_token;
    const H = { Authorization: `Bearer ${e}` };
    const waiting = rest(`/api/rooms/${room}/messages/wait?timeout=5000`, { headers: H });
    await new Promise(r => setTimeout(r, 300));
    // Erin's own post must not wake her; Alice's does
    await tool('post_message', { member_token: e, content: 'own' });
    await new Promise(r => setTimeout(r, 200));
    await post(a, 'wake');
    const w = await waiting;
    assert.deepEqual(w.data.messages.map(m => m.content), ['wake']);
    assert.equal(w.data.unread_remaining, 0);
  });

  test('restart of the server keeps cursors (persistent), nothing lost', async () => {
    const a = (await join('Alice')).member_token;
    const f = (await join('Frank')).member_token;
    await post(a, 'before restart');
    await stop(proc);
    proc = start(DB);
    await ready();
    const f2 = (await join('Frank')).member_token;
    const r = await tool('wait_for_messages', { member_token: f2 });
    assert.ok(r.messages.some(m => m.content === 'before restart'));
    assert.ok(f);
  });
});

describe('Migration', () => {
  test('legacy DB (no last_read_id) is migrated idempotently, without losing a single row', async () => {
    const legacy = path.join(os.tmpdir(), `hub-test-legacy-${process.pid}-${Date.now()}.db`);
    const db = new Database(legacy);
    db.exec(`
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, admin_token TEXT NOT NULL, name TEXT, directive TEXT, settings TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT 'agent', permissions TEXT DEFAULT 'rw', status TEXT DEFAULT 'normal', coordination_role TEXT, last_heartbeat INTEGER, last_seen DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id INTEGER REFERENCES members(id) ON DELETE SET NULL, type TEXT DEFAULT 'message', content TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO rooms (token, admin_token, name) VALUES ('legacyroomtoken0000000', 'adm', 'legacy');
      INSERT INTO members (room_id, token, name) VALUES (1, 'tokA0000000000000000a', 'Old');
    `);
    for (let i = 0; i < 25; i++) db.prepare('INSERT INTO messages (room_id, member_id, content) VALUES (1, 1, ?)').run(`m${i}`);
    db.close();
    for (let round = 0; round < 2; round++) {   // second boot = idempotent
      const p = start(legacy);
      await ready();
      const r = await rest('/api/rooms/legacyroomtoken0000000/messages?mode=recent&limit=100', { headers: { Authorization: 'Bearer tokA0000000000000000a' } });
      assert.equal(r.data.messages.length, 25);
      assert.equal(r.data.unread_remaining, 0);
      await stop(p);
    }
    const chk = new Database(legacy, { readonly: true });
    assert.equal(chk.prepare('SELECT COUNT(*) n FROM messages').get().n, 25);
    assert.equal(chk.prepare('SELECT last_read_id FROM members').get().last_read_id, 25);
    chk.close();
    for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(legacy + x); } catch {}
  });
});
