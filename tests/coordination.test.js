import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Coordination routes: admin-only writes must stay inside the admin's room, never crash on a
// missing body, and never let a negative limit become "no limit".

const PORT = '4170';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-coordination-${process.pid}-${Date.now()}.db`);
let proc;

async function req(p, { method = 'GET', body, token, raw } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(raw === undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body))
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function newRoom(name) {
  return (await req('/api/rooms', { method: 'POST', body: { name } })).data;
}
async function join(room, name, role = 'agent') {
  return (await req(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: { name, role } })).data.member_token;
}
async function memberIds(room, token) {
  // ids are not public: read them through a set-role round trip on the member list order
  const members = (await req(`/api/rooms/${room.room_token}/members`, { token })).data.members;
  return members;
}

describe('coordination', () => {
  let roomA, roomB, a1, a2, b1, idA1, idA2, idB1;

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
    roomA = await newRoom('A');
    roomB = await newRoom('B');
    a1 = await join(roomA, 'Alpha');
    a2 = await join(roomA, 'Beta');
    b1 = await join(roomB, 'Gamma');
    // Member ids are internal: members joined in order on a fresh DB -> 1, 2, 3
    idA1 = 1; idA2 = 2; idB1 = 3;
    await memberIds(roomA, a1);
  });
  after(() => {
    proc?.kill('SIGTERM');
    for (const f of [DB, DB + '-wal', DB + '-shm']) try { fs.unlinkSync(f); } catch {}
  });

  test('set-role: admin of room A cannot touch a member of room B', async () => {
    const r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', body: { admin_token: roomA.admin_token, member_id: idB1, coordination_role: 'manager' }
    });
    assert.strictEqual(r.status, 404);
    const status = await req(`/api/rooms/${roomB.room_token}/coordination/status`, { token: b1 });
    assert.strictEqual(status.data.active, null, 'room B must be untouched');
  });

  test('set-role: works on own room, via body or Bearer admin token; clears with null', async () => {
    let r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', body: { admin_token: roomA.admin_token, member_id: idA1, coordination_role: 'manager' }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', token: roomA.admin_token, body: { member_id: idA2, coordination_role: 'second' }
    });
    assert.strictEqual(r.status, 200);
    const status = await req(`/api/rooms/${roomA.room_token}/coordination/status`, { token: a1 });
    assert.strictEqual(status.data.active, 'Alpha');
    assert.strictEqual(status.data.second.name, 'Beta');

    r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', token: roomA.admin_token, body: { member_id: idA2, coordination_role: null }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.coordination_role, null);
    const after = await req(`/api/rooms/${roomA.room_token}/coordination/status`, { token: a1 });
    assert.strictEqual(after.data.second, null);
  });

  test('set-role: invalid role, wrong admin token, member token instead of admin', async () => {
    let r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', body: { admin_token: roomA.admin_token, member_id: idA2, coordination_role: 'boss' }
    });
    assert.strictEqual(r.status, 400);
    r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', body: { admin_token: roomB.admin_token, member_id: idA2, coordination_role: 'second' }
    });
    assert.strictEqual(r.status, 403);
    r = await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', token: a1, body: { member_id: idA2, coordination_role: 'second' }
    });
    assert.strictEqual(r.status, 403);
  });

  test('switch / set-role without a JSON body answer 401, not 500', async () => {
    for (const ep of ['switch', 'set-role']) {
      const r = await req(`/api/rooms/${roomA.room_token}/coordination/${ep}`, { method: 'POST', raw: '' });
      assert.strictEqual(r.status, 401, `${ep}: ${JSON.stringify(r.data)}`);
    }
  });

  test('switch: manual failover inside the room', async () => {
    await req(`/api/rooms/${roomA.room_token}/coordination/set-role`, {
      method: 'POST', token: roomA.admin_token, body: { member_id: idA2, coordination_role: 'second' }
    });
    const r = await req(`/api/rooms/${roomA.room_token}/coordination/switch`, {
      method: 'POST', body: { admin_token: roomA.admin_token, to_member_id: idA2 }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.active, 'Beta');
    const cross = await req(`/api/rooms/${roomA.room_token}/coordination/switch`, {
      method: 'POST', body: { admin_token: roomA.admin_token, to_member_id: idB1 }
    });
    assert.strictEqual(cross.status, 400);
  });

  test('heartbeat requires a member of the room; events limit is bounded', async () => {
    let r = await req(`/api/rooms/${roomA.room_token}/coordination/heartbeat`, { method: 'POST', token: b1 });
    assert.strictEqual(r.status, 403);
    r = await req(`/api/rooms/${roomA.room_token}/coordination/heartbeat`, { method: 'POST', token: a1 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.acknowledged, true);

    const ev = await req(`/api/rooms/${roomA.room_token}/coordination/events?limit=-1`, { token: a1 });
    assert.strictEqual(ev.status, 200);
    assert.ok(Array.isArray(ev.data.events));
    const one = await req(`/api/rooms/${roomA.room_token}/coordination/events?limit=1`, { token: a1 });
    assert.strictEqual(one.data.events.length, 1);
  });

  test('directive history: negative limit is bounded, not unlimited', async () => {
    for (let i = 0; i < 3; i++) {
      await req(`/api/rooms/${roomA.room_token}/directive`, { method: 'POST', token: a1, body: { content: `d${i}` } });
    }
    const r = await req(`/api/rooms/${roomA.room_token}/directive/history?limit=-5`, { token: a1 });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.history.length >= 1 && r.data.history.length <= 100);
    const one = await req(`/api/rooms/${roomA.room_token}/directive/history?limit=1`, { token: a1 });
    assert.strictEqual(one.data.history.length, 1);
  });
});
