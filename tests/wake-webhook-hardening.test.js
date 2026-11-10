import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Wake webhooks: (1) a public hostname resolving to a private address is refused at delivery
// (DNS rebinding / hostile zone), (2) max_retries is honoured for transient failures,
// (3) the payload names the room, (4) a slow target does not delay the others.

process.env.DB_PATH = path.join(os.tmpdir(), `hub-test-wake-unit-${process.pid}.db`);
const { checkWebhookAddress } = await import('../src/wake-targets.js');

const PORT = '4173';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-wake-hardening-${process.pid}-${Date.now()}.db`);
const HOOK_PORT = 4174;
let proc, hook;
const hits = [];       // every webhook request: { path, body }
let flakyRemaining = 0; // number of 503 answers still to give on /flaky

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
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
};

describe('wake webhooks hardening', () => {
  let room, alice, bob, carol;
  before(async () => {
    hook = createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => { body += c; });
      rq.on('end', () => {
        const entry = { path: rq.url, body: JSON.parse(body || '{}'), at: Date.now() };
        hits.push(entry);
        if (rq.url === '/flaky' && flakyRemaining > 0) { flakyRemaining--; rs.writeHead(503); return rs.end(); }
        if (rq.url === '/slow') return setTimeout(() => { rs.writeHead(200); rs.end('{}'); }, 1500);
        rs.writeHead(200); rs.end('{}');
      });
    });
    await new Promise(r => hook.listen(HOOK_PORT, '127.0.0.1', r));

    proc = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, LOG_LEVEL: 'error', HUB_RETENTION_DEFAULT_DAYS: '0' },
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    room = (await req('/api/rooms', { method: 'POST', body: { name: 'Hooks' } })).data;
    const join = async (name) => (await req(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: { name } })).data.member_token;
    alice = await join('Alice'); bob = await join('Bob'); carol = await join('Carol');
  });
  after(() => {
    proc?.kill('SIGTERM');
    hook?.close();
    for (const f of [DB, DB + '-wal', DB + '-shm', process.env.DB_PATH, process.env.DB_PATH + '-wal', process.env.DB_PATH + '-shm']) try { fs.unlinkSync(f); } catch {}
  });

  test('checkWebhookAddress: public name resolving to a private address is refused', async () => {
    const lookup = (h) => Promise.resolve(h === 'evil.example' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    assert.match(await checkWebhookAddress('https://evil.example/hook', lookup), /private address/);
    assert.strictEqual(await checkWebhookAddress('https://good.example/hook', lookup), null);
    assert.match(await checkWebhookAddress('https://nx.example/hook', () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))), /DNS lookup failed/);
    // Literal private hosts were vetted at registration (host-local requests only): no DNS step
    assert.strictEqual(await checkWebhookAddress('http://127.0.0.1:1/hook', () => { throw new Error('must not resolve'); }), null);
    assert.match(await checkWebhookAddress('not a url', lookup), /invalid/);
  });

  test('max_retries: a 503 then 200 target is retried and the payload names the room', async () => {
    flakyRemaining = 1;
    let r = await req('/api/members/wake-target', { method: 'POST', token: bob, body: { type: 'webhook', url: `http://127.0.0.1:${HOOK_PORT}/flaky`, max_retries: 2 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: alice, body: { content: '@Bob retry me' } });
    assert.ok(await until(() => hits.filter(h => h.path === '/flaky').length >= 2), 'two attempts expected');
    const ok = hits.filter(h => h.path === '/flaky');
    assert.strictEqual(ok.length, 2);
    assert.ok(ok[1].at - ok[0].at >= 900, 'backoff of about 1 s before the retry');
    assert.strictEqual(ok[1].body.room_name, 'Hooks');
    assert.strictEqual(ok[1].body.room_token, room.room_token);
    assert.strictEqual(ok[1].body.author, 'Alice');
    assert.match(ok[1].body.content_excerpt, /retry me/);
    const status = await req('/api/members/wake-target', { token: bob });
    assert.strictEqual(status.data.last_error, null);
    assert.ok(status.data.last_notification_at);
  });

  test('max_retries 0: a permanent 503 is reported once, last_error set', async () => {
    flakyRemaining = 99;
    hits.length = 0;
    await req('/api/members/wake-target', { method: 'POST', token: bob, body: { type: 'webhook', url: `http://127.0.0.1:${HOOK_PORT}/flaky`, max_retries: 0 } });
    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: alice, body: { content: '@Bob fail once' } });
    assert.ok(await until(async () => (await req('/api/members/wake-target', { token: bob })).data.last_error));
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(hits.filter(h => h.path === '/flaky').length, 1);
    const status = await req('/api/members/wake-target', { token: bob });
    assert.match(status.data.last_error, /HTTP 503/);
    flakyRemaining = 0;
  });

  test('a slow webhook does not delay the other members', async () => {
    hits.length = 0;
    await req('/api/members/wake-target', { method: 'POST', token: bob, body: { type: 'webhook', url: `http://127.0.0.1:${HOOK_PORT}/slow`, max_retries: 0 } });
    await req('/api/members/wake-target', { method: 'POST', token: carol, body: { type: 'webhook', url: `http://127.0.0.1:${HOOK_PORT}/fast`, max_retries: 0 } });
    const t0 = Date.now();
    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: alice, body: { content: '@Bob @Carol both of you' } });
    assert.ok(await until(() => hits.some(h => h.path === '/fast')), 'fast target must be hit');
    const fast = hits.find(h => h.path === '/fast');
    assert.ok(fast.at - t0 < 1000, `fast target reached after ${fast.at - t0} ms (slow one takes 1500 ms)`);
    assert.ok(hits.some(h => h.path === '/slow'), 'slow target was contacted concurrently');
  });
});
