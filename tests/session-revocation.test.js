import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// JOIN_GUIDE promises: "Rejoining invalidates all old connections using the previous token".
// Live WebSocket sockets, REST long-polls and MCP wait_for_messages opened with the old token must
// be closed when the token is rotated, when the member leaves, and when the room is deleted.

const PORT = '4171';
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DB = path.join(os.tmpdir(), `hub-test-revocation-${process.pid}-${Date.now()}.db`);
let proc;

async function req(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function newRoom(name) { return (await req('/api/rooms', { method: 'POST', body: { name } })).data; }
async function join(room, name) {
  return (await req(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: { name, role: 'agent' } })).data.member_token;
}
async function mcp(name, args) {
  const r = await req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  return JSON.parse(r.data.result.content[0].text);
}
function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    const closed = new Promise(res => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.on('open', () => resolve({ ws, closed }));
    ws.on('error', reject);
  });
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);

describe('session revocation', () => {
  before(async () => {
    proc = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, LOG_LEVEL: 'error', HUB_RETENTION_DEFAULT_DAYS: '0' },
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
  });
  after(() => {
    proc?.kill('SIGTERM');
    for (const f of [DB, DB + '-wal', DB + '-shm']) try { fs.unlinkSync(f); } catch {}
  });

  test('rejoin (token rotation) closes the old WebSocket and the old long-poll', async () => {
    const room = await newRoom('rot');
    const old = await join(room, 'Agent');
    const other = await join(room, 'Other');
    const { closed } = await openWs(old);
    const otherWs = await openWs(other);
    const seenByOther = [];
    otherWs.ws.on('message', (d) => seenByOther.push(JSON.parse(d.toString())));
    const poll = fetch(`${BASE}/api/rooms/${room.room_token}/messages/wait?timeout=20000`, { headers: { Authorization: `Bearer ${old}` } });
    await new Promise(r => setTimeout(r, 200));

    const fresh = await join(room, 'Agent'); // same name: token rotated
    const c = await withTimeout(closed, 3000, 'ws close after rejoin');
    assert.strictEqual(c.code, 4003);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!seenByOther.some(m => m.type === 'member_left' && m.name === 'Agent'), 'a rotation is not a departure');
    otherWs.ws.close();

    const res = await withTimeout(poll, 3000, 'long-poll release after rejoin');
    assert.strictEqual(res.status, 403);

    // The fresh token works, the old one does not, and Other was not disturbed
    assert.strictEqual((await req(`/api/rooms/${room.room_token}/members`, { token: fresh })).status, 200);
    assert.strictEqual((await req(`/api/rooms/${room.room_token}/members`, { token: old })).status, 403);
    assert.strictEqual((await req(`/api/rooms/${room.room_token}/members`, { token: other })).status, 200);
  });

  test('leave closes the member sockets, other members keep theirs', async () => {
    const room = await newRoom('leave');
    const leaver = await join(room, 'Leaver');
    const stayer = await join(room, 'Stayer');
    const a = await openWs(leaver);
    const b = await openWs(stayer);
    let bClosed = false;
    b.closed.then(() => { bClosed = true; });

    assert.strictEqual((await req(`/api/rooms/${room.room_token}/leave`, { method: 'DELETE', token: leaver })).status, 200);
    const c = await withTimeout(a.closed, 3000, 'ws close after leave');
    assert.strictEqual(c.code, 4003);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(bClosed, false, 'the other member stays connected');
    b.ws.close();
  });

  test('MCP leave_room and join_room rotate / close like REST', async () => {
    const room = await newRoom('mcp');
    const first = (await mcp('join_room', { room_token: room.room_token, name: 'Bot' })).member_token;
    const { closed } = await openWs(first);
    const second = (await mcp('join_room', { room_token: room.room_token, name: 'Bot' })).member_token;
    assert.notStrictEqual(first, second);
    assert.strictEqual((await withTimeout(closed, 3000, 'ws close after mcp rejoin')).code, 4003);

    const ws2 = await openWs(second);
    const left = await mcp('leave_room', { member_token: second });
    assert.strictEqual(left.success, true);
    assert.strictEqual((await withTimeout(ws2.closed, 3000, 'ws close after mcp leave')).code, 4003);
  });

  test('room deletion closes every session of the room (4004) and releases long-polls', async () => {
    const room = await newRoom('del');
    const m1 = await join(room, 'One');
    const m2 = await join(room, 'Two');
    const s1 = await openWs(m1);
    const s2 = await openWs(m2);
    const poll = fetch(`${BASE}/api/rooms/${room.room_token}/messages/wait?timeout=20000`, { headers: { Authorization: `Bearer ${m2}` } });
    await new Promise(r => setTimeout(r, 200));

    assert.strictEqual((await req(`/api/rooms/${room.room_token}`, { method: 'DELETE', token: room.admin_token })).status, 200);
    assert.strictEqual((await withTimeout(s1.closed, 3000, 'ws1 close')).code, 4004);
    assert.strictEqual((await withTimeout(s2.closed, 3000, 'ws2 close')).code, 4004);
    assert.strictEqual((await withTimeout(poll, 3000, 'poll release')).status, 403);
  });

  test('a pending MCP wait_for_messages is released when the token is rotated', async () => {
    const room = await newRoom('mcpwait');
    const tok = (await mcp('join_room', { room_token: room.room_token, name: 'Waiter' })).member_token;
    const waiting = req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wait_for_messages', arguments: { member_token: tok, timeout: 20000 } } } });
    await new Promise(r => setTimeout(r, 300));
    await mcp('join_room', { room_token: room.room_token, name: 'Waiter' });
    const r = await withTimeout(waiting, 3000, 'mcp wait release');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.result.isError, true);
    assert.match(r.data.result.content[0].text, /join_room again/);
  });
});
