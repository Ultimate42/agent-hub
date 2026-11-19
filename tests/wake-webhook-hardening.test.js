import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { tmpDir } from './tmp.js';

// Wake webhooks: (1) a public hostname resolving to a private address is refused and the vetted
// address is the one connected to, (2) max_retries is honoured with a capped backoff, (3) the
// payload names the room but carries no credential, (4) a slow target does not delay the others,
// (5) one delivery chain per member (newer notifications are coalesced), (6) a webhook registered
// from the hub host may resolve to a private address, one registered through a proxy may not.

process.env.DB_PATH = path.join(tmpDir('hub-test-'), 'hub.db');
const { resolveWebhookTarget, notifyWebhook } = await import('../src/wake-targets.js');

const PORT = '4173';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(tmpDir('hub-test-'), 'hub.db');
const HOOK_PORT = 4174;
let proc, hook;
const hits = [];       // every webhook request: { path, body }
let flakyRemaining = 0; // number of 503 answers still to give on /flaky

async function req(p, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('wake webhooks hardening', () => {
  let room, alice, bob, carol;
  before(async () => {
    hook = createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => { body += c; });
      rq.on('end', () => {
        const entry = { path: rq.url, body: JSON.parse(body || '{}'), at: Date.now(), remote: rq.socket.remoteAddress };
        hits.push(entry);
        if (rq.url === '/flaky' && flakyRemaining > 0) { flakyRemaining--; rs.writeHead(503); return rs.end(); }
        if (rq.url === '/slow') return setTimeout(() => { rs.writeHead(200); rs.end('{}'); }, 1500);
        rs.writeHead(200); rs.end('{}');
      });
    });
    await new Promise(r => hook.listen(HOOK_PORT, r)); // dual-stack: "localhost" may resolve to ::1

    proc = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, LOG_LEVEL: 'error', HUB_RETENTION_DEFAULT_DAYS: '0' },
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
      await sleep(250);
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

  test('resolveWebhookTarget: private results refused unless allowPrivate, vetted address returned', async () => {
    const lookup = (h) => Promise.resolve(h === 'evil.example'
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '2001:db8::1', family: 6 }, { address: '93.184.216.34', family: 4 }]);
    assert.match((await resolveWebhookTarget('https://evil.example/hook', { lookup })).error, /private address/);
    assert.deepStrictEqual(await resolveWebhookTarget('https://good.example/hook', { lookup }), { address: '93.184.216.34', family: 4 });
    assert.deepStrictEqual(await resolveWebhookTarget('https://evil.example/hook', { lookup, allowPrivate: true }), { address: '127.0.0.1', family: 4 });
    assert.match((await resolveWebhookTarget('https://nx.example/hook', { lookup: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) })).error, /DNS lookup failed/);
    // Literal addresses never go through DNS
    const noDns = () => { throw new Error('must not resolve'); };
    assert.match((await resolveWebhookTarget('http://127.0.0.1:1/hook', { lookup: noDns })).error, /private address/);
    assert.deepStrictEqual(await resolveWebhookTarget('http://127.0.0.1:1/hook', { lookup: noDns, allowPrivate: true }), { address: '127.0.0.1', family: 4 });
    assert.deepStrictEqual(await resolveWebhookTarget('http://[2001:db8::5]/hook', { lookup: noDns }), { address: '2001:db8::5', family: 6 });
    assert.match((await resolveWebhookTarget('not a url', { lookup })).error, /invalid/);
  });

  test('notifyWebhook: the request goes to the vetted address; backoff is exponential and capped at 30 s', async () => {
    const seen = [];
    const delays = [];
    const lookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    const post = async (url, body, target) => { seen.push(target.address); return { status: 503, statusText: 'Unavailable' }; };
    const r = await notifyWebhook('https://flaky.example/hook', { x: 1 }, { maxRetries: 10, lookup, post, delay: async (ms) => { delays.push(ms); } });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.attempts, 11);
    assert.ok(seen.every(a => a === '93.184.216.34'), 'every attempt connects to the address that was checked');
    assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
    assert.match(r.error, /HTTP 503.*after 11 attempts/);
    // A plain 4xx is final: no retry
    const once = await notifyWebhook('https://flaky.example/hook', {}, { maxRetries: 5, lookup, post: async () => ({ status: 404, statusText: 'Not Found' }), delay: async () => { throw new Error('no delay expected'); } });
    assert.strictEqual(once.attempts, 1);
  });

  test('max_retries: a 503 then 200 target is retried; the payload names the room and carries no token', async () => {
    flakyRemaining = 1;
    let r = await req('/api/members/wake-target', { method: 'POST', token: bob, body: { type: 'webhook', url: `http://127.0.0.1:${HOOK_PORT}/flaky`, max_retries: 2 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: alice, body: { content: '@Bob retry me' } });
    assert.ok(await until(() => hits.filter(h => h.path === '/flaky').length >= 2), 'two attempts expected');
    const ok = hits.filter(h => h.path === '/flaky');
    assert.strictEqual(ok.length, 2);
    assert.ok(ok[1].at - ok[0].at >= 900, 'backoff of about 1 s before the retry');
    assert.strictEqual(ok[1].body.room_name, 'Hooks');
    assert.strictEqual(ok[1].body.author, 'Alice');
    assert.match(ok[1].body.content_excerpt, /retry me/);
    assert.strictEqual(ok[1].body.room_token, undefined, 'the join capability must not be posted to a webhook');
    assert.ok(!JSON.stringify(ok[1].body).includes(room.room_token));
    assert.ok(!JSON.stringify(ok[1].body).includes(bob));
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
    await sleep(300);
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
    await until(() => hits.filter(h => h.path === '/slow').length >= 1 && Date.now() - t0 > 1700, 4000);
  });

  test('one chain per member: notifications arriving during a delivery are coalesced into one follow-up', async () => {
    hits.length = 0;
    // Bob still points at /slow (1.5 s per delivery)
    const ids = [];
    for (const text of ['@Bob one', '@Bob two', '@Bob three']) {
      const r = await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: alice, body: { content: text } });
      ids.push(r.data.id);
    }
    assert.ok(await until(() => hits.filter(h => h.path === '/slow').length >= 2, 6000), 'first delivery then one coalesced follow-up');
    await sleep(2000); // a third delivery would have landed by now
    const slow = hits.filter(h => h.path === '/slow');
    assert.strictEqual(slow.length, 2, 'two deliveries for three messages: the middle one was coalesced');
    assert.strictEqual(slow[0].body.message_id, ids[0]);
    assert.strictEqual(slow[1].body.message_id, ids[2], 'the follow-up carries the latest message');
    assert.ok(slow[1].at - slow[0].at >= 1400, 'the follow-up waited for the chain in flight');
    const status = await req('/api/members/wake-target', { token: bob });
    assert.strictEqual(status.data.last_error, null);
  });

  test('allow_private: a webhook registered from the hub host may resolve to a private address', async () => {
    hits.length = 0;
    // "localhost" is a name: it is resolved at delivery and lands on a loopback address
    let r = await req('/api/members/wake-target', { method: 'POST', token: carol, body: { type: 'webhook', url: `http://localhost:${HOOK_PORT}/private-ok`, max_retries: 0 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    let status = await req('/api/members/wake-target', { token: carol });
    assert.strictEqual(status.data.allow_private, true);
    await req(`/api/rooms/${room.room_token}/messages`, { method: 'POST', token: alice, body: { content: '@Carol lan call' } });
    assert.ok(await until(() => hits.some(h => h.path === '/private-ok')), 'delivered to the private address');

    // Through a proxy (X-Forwarded-For present) the hub host trust does not apply
    r = await req('/api/members/wake-target', { method: 'POST', token: carol, headers: { 'X-Forwarded-For': '203.0.113.9' }, body: { type: 'webhook', url: 'https://hooks.example/notify', max_retries: 0 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    status = await req('/api/members/wake-target', { token: carol });
    assert.strictEqual(status.data.allow_private, false);
    r = await req('/api/members/wake-target', { method: 'POST', token: carol, headers: { 'X-Forwarded-For': '203.0.113.9' }, body: { type: 'webhook', url: `http://localhost:${HOOK_PORT}/x`, max_retries: 0 } });
    assert.strictEqual(r.status, 400, 'literal private host refused when not from the hub host');
  });
});
