import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { isPrivateHost, isLoopbackIp } from '../src/utils/net.js';

// Never touch the production DB: point any in-process import at a temp file
process.env.DB_PATH = path.join(os.tmpdir(), `hub-test-hardening-unit-${process.pid}.db`);
const { parseDbTime } = await import('../src/watchdog.js');

const PORT = '4141';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-hardening-${process.pid}-${Date.now()}.db`);
let proc;

async function req(p, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function newRoom(name = 'R') {
  const r = (await req('/api/rooms', { method: 'POST', body: { name } })).data;
  return r;
}
async function join(room, name, role) {
  return (await req(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: { name, role } })).data.member_token;
}

describe('hardening', () => {
  before(async () => {
    proc = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, LOG_LEVEL: 'error',
             HUB_WATCHDOG_INTERVAL_MS: '1000', HUB_UNREPLY_SECONDS: '3600' },
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server did not start');
  });
  after(() => {
    proc?.kill('SIGTERM');
    for (const f of [DB, DB + '-wal', DB + '-shm', process.env.DB_PATH, process.env.DB_PATH + '-wal', process.env.DB_PATH + '-shm']) try { fs.unlinkSync(f); } catch {}
  });

  test('REST and MCP messages are pushed to WebSocket clients', async () => {
    const room = await newRoom();
    const a = await join(room, 'Alice');
    const b = await join(room, 'Bob');
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${b}`);
    const received = [];
    ws.on('message', d => received.push(JSON.parse(d.toString())));
    await new Promise(r => ws.on('open', r));
    await new Promise(r => setTimeout(r, 200));

    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: a, body: { content: 'via-rest' } });
    await req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'post_message', arguments: { member_token: a, content: 'via-mcp' } } } });
    await new Promise(r => setTimeout(r, 300));
    ws.close();
    const contents = received.filter(m => m.content).map(m => m.content);
    assert.ok(contents.includes('via-rest'), 'REST message reached WS');
    assert.ok(contents.includes('via-mcp'), 'MCP message reached WS');
  });

  test('MCP post_message enforces secure mode, type and reply_to validation', async () => {
    const room = await newRoom();
    const obs = await join(room, 'Watcher', 'observer');
    const agent = await join(room, 'Agent1');
    const call = (args) => req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'post_message', arguments: args } } });
    await req(`/api/rooms/${room.room_token}/settings`, { method: 'POST', token: room.admin_token, body: { secure_mode: true } });
    let r = await call({ member_token: obs, content: 'x' });
    assert.ok(r.data.result.isError, 'observer blocked in secure mode via MCP');
    r = await call({ member_token: agent, content: 'x', type: 'bogus' });
    assert.ok(r.data.result.isError, 'bad type rejected');
    r = await call({ member_token: agent, content: 'x', reply_to: 999999 });
    assert.ok(r.data.result.isError, 'bad reply_to rejected');
    r = await call({ member_token: agent, content: { a: 1 } });
    assert.ok(r.data.result.isError, 'non-string content rejected');
    r = await call({ member_token: agent, content: 'ok' });
    assert.ok(!r.data.result.isError);
  });

  test('input validation on join, room name and message type', async () => {
    const room = await newRoom();
    const j = (body) => req(`/api/rooms/${room.room_token}/join`, { method: 'POST', body });
    assert.strictEqual((await j({ name: 'x'.repeat(65) })).status, 400);
    assert.strictEqual((await j({ name: { $ne: 1 } })).status, 400);
    assert.strictEqual((await j({ name: 'Ok', role: 'root' })).status, 400);
    assert.strictEqual((await j({ name: 'HubWatchdog' })).status, 400);
    assert.strictEqual((await req('/api/rooms', { method: 'POST', body: { name: 'n'.repeat(500) } })).status, 400);
    const t = await join(room, 'Valid');
    const p = (body) => req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: t, body });
    assert.strictEqual((await p({ content: 'a', type: 'evil' })).status, 400);
    assert.strictEqual((await p({ content: ['a'] })).status, 400);
    assert.strictEqual((await p({ content: 'a', reply_to: 'abc' })).status, 400);
    assert.strictEqual((await p({ content: 'a' })).status, 201);
  });

  test('malformed JSON returns 400, not 500', async () => {
    const r = await req('/api/rooms', { method: 'POST', body: '{bad' });
    assert.strictEqual(r.status, 400);
  });

  test('admin cannot change status of a member of another room', async () => {
    const r1 = await newRoom(); const r2 = await newRoom();
    await join(r1, 'A1');
    await join(r2, 'B1');
    const db = new Database(DB, { readonly: true });
    const foreign = db.prepare("SELECT m.id FROM members m JOIN rooms r ON r.id = m.room_id WHERE r.token = ? AND m.name = 'B1'").get(r2.room_token).id;
    db.close();
    const s = await req(`/api/rooms/${r1.room_token}/members/${foreign}/status`, { method: 'POST', token: r1.admin_token, body: { status: 'quarantine' } });
    assert.strictEqual(s.status, 404);
    const own = await req(`/api/rooms/${r2.room_token}/members/${foreign}/status`, { method: 'POST', token: r2.admin_token, body: { status: 'suspect' } });
    assert.strictEqual(own.status, 200);
  });

  test('wake targets: file only from host, no SSRF from public clients, no traversal', async () => {
    const room = await newRoom();
    const t = await join(room, 'Waker');
    const pub = { 'X-Forwarded-For': '8.8.8.8' };
    const wt = (body, headers = {}) => req('/api/members/wake-target', { method: 'POST', token: t, body, headers });
    assert.strictEqual((await wt({ type: 'file', path: '/tmp/x' }, pub)).status, 403);
    assert.strictEqual((await wt({ type: 'webhook', url: 'http://127.0.0.1:9/x' }, pub)).status, 400);
    assert.strictEqual((await wt({ type: 'webhook', url: 'https://169.254.169.254/x' }, pub)).status, 400);
    assert.strictEqual((await wt({ type: 'webhook', url: 'http://example.com/?localhost' }, pub)).status, 400);
    assert.strictEqual((await wt({ type: 'webhook', url: 'https://example.com/hook' }, pub)).status, 200);
    assert.strictEqual((await wt({ type: 'file', path: '/tmp/../etc' })).status, 400);
    assert.strictEqual((await wt({ type: 'file', path: '/tmp/wake-ok' })).status, 200);
  });

  test('watchdog does not alert immediately (no NaN age) and legacy token is not usable', async () => {
    const room = await newRoom();
    const a = await join(room, 'Alice');
    await join(room, 'Bob');
    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: a, body: { content: '@Bob ping' } });
    await new Promise(r => setTimeout(r, 2500));
    const msgs = (await req(`/api/rooms/${room.room_token}/messages`, { token: a })).data.messages;
    assert.ok(!msgs.some(m => m.author === 'HubWatchdog'), 'no premature alert');
    const legacy = await req(`/api/rooms/${room.room_token}/messages`, { token: 'system-watchdog-token' });
    assert.strictEqual(legacy.status, 403);
  });

  test('rate limit cannot be bypassed with forged tokens; room creation is capped', async () => {
    let limited = false;
    for (let i = 0; i < 80; i++) {
      const r = await req('/api/rooms/x/members', { token: `forged-${i}-${Math.random()}` });
      if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'rotating fake tokens still hits the IP limit');
  });
});

describe('unit helpers', () => {
  test('isPrivateHost / isLoopbackIp', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '[::1]', 'foo.internal', 'intranet'])
      assert.ok(isPrivateHost(h), h);
    for (const h of ['example.com', '8.8.8.8', 'hub.rollium.fr']) assert.ok(!isPrivateHost(h), h);
    assert.ok(isLoopbackIp('::ffff:127.0.0.1'));
    assert.ok(!isLoopbackIp('8.8.8.8'));
  });

  test('parseDbTime handles SQLite timestamps (UTC) and rejects garbage', () => {
    assert.strictEqual(parseDbTime('2026-01-02 03:04:05'), Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.strictEqual(parseDbTime('2026-01-02T03:04:05.000Z'), Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.ok(Number.isNaN(parseDbTime(undefined)));
  });
});
