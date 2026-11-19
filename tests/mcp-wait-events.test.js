import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { tmpDir } from './tmp.js';

// MCP wait_for_messages is woken by the publication itself (no 500 ms DB polling):
// a message posted while an agent waits reaches it at once, and a timeout answer never hides a
// message published just before it.

process.env.DB_PATH = path.join(tmpDir('hub-test-'), 'hub.db');
const { MAX_WAITERS_PER_ROOM } = await import('../src/services/messages.js');

const PORT = '4172';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(tmpDir('hub-test-'), 'hub.db');
let proc;

async function rpc(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  const data = await res.json();
  return { isError: data.result.isError === true, text: data.result.content[0].text, parsed: () => JSON.parse(data.result.content[0].text) };
}

describe('mcp wait_for_messages (event-driven)', () => {
  let room, a, b;
  before(async () => {
    proc = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, LOG_LEVEL: 'error', HUB_RETENTION_DEFAULT_DAYS: '0', HUB_RATE_LIMIT_PER_MINUTE: '100000' },
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    room = (await rpc('create_room', { name: 'wait' })).parsed();
    a = (await rpc('join_room', { room_token: room.room_token, name: 'A' })).parsed().member_token;
    b = (await rpc('join_room', { room_token: room.room_token, name: 'B' })).parsed().member_token;
  });
  after(() => {
    proc?.kill('SIGTERM');
    for (const f of [DB, DB + '-wal', DB + '-shm', process.env.DB_PATH, process.env.DB_PATH + '-wal', process.env.DB_PATH + '-shm']) try { fs.unlinkSync(f); } catch {}
  });

  test('a message posted during the wait is delivered immediately (not at the next poll tick)', async () => {
    const waiting = rpc('wait_for_messages', { member_token: a, timeout: 10000 });
    await new Promise(r => setTimeout(r, 300));
    const t0 = Date.now();
    await rpc('post_message', { member_token: b, content: 'wake up' });
    const r = (await waiting).parsed();
    const latency = Date.now() - t0;
    assert.strictEqual(r.messages.length, 1);
    assert.strictEqual(r.messages[0].content, 'wake up');
    assert.ok(latency < 350, `delivered in ${latency} ms`);
  });

  test('REST long-poll (cursor mode) is woken the same way and the cursor advances', async () => {
    const waiting = fetch(`${BASE}/api/rooms/${room.room_token}/messages/wait?timeout=10000`, { headers: { Authorization: `Bearer ${a}` } });
    await new Promise(r => setTimeout(r, 200));
    await rpc('post_message', { member_token: b, content: 'rest wake' });
    const r = await (await waiting).json();
    assert.strictEqual(r.messages.length, 1);
    assert.strictEqual(r.messages[0].content, 'rest wake');
    assert.strictEqual(r.unread_remaining, 0);
  });

  test('timeout answer: nothing pending, unread_remaining 0, then a late message is not lost', async () => {
    const t0 = Date.now();
    const r = (await rpc('wait_for_messages', { member_token: a, timeout: 600 })).parsed();
    assert.strictEqual(r.messages.length, 0);
    assert.strictEqual(r.unread_remaining, 0);
    assert.ok(Date.now() - t0 >= 550);
    await rpc('post_message', { member_token: b, content: 'after timeout' });
    const again = (await rpc('wait_for_messages', { member_token: a, timeout: 5000 })).parsed();
    assert.strictEqual(again.messages.map(m => m.content).join(), 'after timeout');
  });

  test('own messages do not wake the author; several waiters of one member all get the message', async () => {
    const w1 = rpc('wait_for_messages', { member_token: a, timeout: 3000 });
    const w2 = rpc('wait_for_messages', { member_token: a, timeout: 3000 });
    await new Promise(r => setTimeout(r, 200));
    await rpc('post_message', { member_token: a, content: 'mine' });
    await new Promise(r => setTimeout(r, 200));
    await rpc('post_message', { member_token: b, content: 'theirs' });
    const [r1, r2] = (await Promise.all([w1, w2])).map(x => x.parsed());
    assert.deepStrictEqual(r1.messages.map(m => m.content), ['theirs']);
    // second waiter: either delivered the same page (auto-ack raced) or empty after the ack
    assert.ok(r2.messages.every(m => m.content === 'theirs'));
  });

  test('the connector dropping the request frees the waiter slot (room filled to the cap)', async () => {
    const wait = (signal) => fetch(`${BASE}/mcp`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_messages', arguments: { member_token: a, timeout: 20000 } } })
    });
    const controllers = [];
    const pending = [];
    for (let i = 0; i < MAX_WAITERS_PER_ROOM; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      pending.push(wait(ac.signal).catch(() => null));
    }
    await new Promise(r => setTimeout(r, 800));
    // The room is full: one more is refused
    const full = (await rpc('wait_for_messages', { member_token: a, timeout: 300 }));
    assert.strictEqual(full.isError, true);
    assert.match(full.text, /Too many concurrent wait_for_messages/);

    // Drop one connection: its slot is freed and a new wait is accepted
    controllers[0].abort();
    await pending[0];
    await new Promise(r => setTimeout(r, 300));
    const r = (await rpc('wait_for_messages', { member_token: a, timeout: 300 })).parsed();
    assert.strictEqual(r.messages.length, 0);

    for (const ac of controllers) ac.abort();
    await Promise.all(pending);
    await new Promise(r => setTimeout(r, 300));
    // Every slot is back: a message now reaches a fresh waiter
    const again = rpc('wait_for_messages', { member_token: a, timeout: 5000 });
    await new Promise(r => setTimeout(r, 200));
    await rpc('post_message', { member_token: b, content: 'room drained' });
    assert.strictEqual((await again).parsed().messages.map(m => m.content).join(), 'room drained');
  });

  test('a join does not wake a since-mode long-poll with a synthetic id-less entry', async () => {
    const hist = await (await fetch(`${BASE}/api/rooms/${room.room_token}/messages?limit=1`, { headers: { Authorization: `Bearer ${a}` } })).json();
    const lastId = hist.messages.length ? hist.messages[hist.messages.length - 1].id : 0;
    const t0 = Date.now();
    const poll = fetch(`${BASE}/api/rooms/${room.room_token}/messages/wait?since=${lastId}&timeout=1200`, { headers: { Authorization: `Bearer ${a}` } });
    await new Promise(r => setTimeout(r, 200));
    const j = await fetch(`${BASE}/api/rooms/${room.room_token}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Newcomer' }) });
    assert.strictEqual(j.status, 201);
    const r = await (await poll).json();
    assert.deepStrictEqual(r.messages, []);
    assert.ok(Date.now() - t0 >= 1100, 'the poll ran to its timeout');
    assert.ok(r.messages.every(m => m.id !== undefined));
  });
});
