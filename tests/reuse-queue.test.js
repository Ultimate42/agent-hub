import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { tmpDir } from './tmp.js';

const PORT = '4151';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = tmpDir('hub-reuse-');
const WORKER_DIR = path.join(TMP_DIR, 'worker-files');
const ADMIN = 'reuse-admin-secret-0123456789';
const AMD = 'gpu-box-worker-secret-0123456789';
const NV = 'dev-box-worker-secret-0123456789';
const LEASE_S = 2;

let hubProcess;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Smallest thing the hub accepts as FLAC: a valid STREAMINFO header (the hub never decodes audio). */
function fakeFlac({ rate = 24000, channels = 1, samples = 24000 * 10, salt = '' } = {}) {
  const b = Buffer.alloc(42);
  b.write('fLaC', 0, 'latin1');
  b[4] = 0x80; b[7] = 34;
  b.writeUInt32BE(((rate << 12) | ((channels - 1) << 9) | (23 << 4) | Math.floor(samples / 2 ** 32)) >>> 0, 18);
  b.writeUInt32BE(samples >>> 0, 22);
  return Buffer.concat([b, Buffer.from(`audio-${salt}`)]);
}

async function call(p, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: {
      ...(rawBody ? { 'Content-Type': 'audio/flac' } : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers
    },
    body: rawBody || (body === undefined ? undefined : JSON.stringify(body))
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, data, buf, headers: res.headers };
}

const submit = (name, flac, extra = '') => call(`/api/reuse/jobs?batch=p55&name=${name}${extra}`, { method: 'POST', token: ADMIN, rawBody: flac });
const next = (token, info = {}) => call('/api/reuse/next', { method: 'POST', token, body: { wait: 0, info } });
const result = (id, token, flac, announced = sha(flac)) => call(`/api/reuse/jobs/${id}/result?compute_s=4&backend=vulkan`, {
  method: 'POST', token, rawBody: flac, headers: { 'X-Sha256': announced }
});
const job = async (id) => (await call(`/api/reuse/jobs/${id}`, { token: ADMIN })).data;

describe('RE-USE cleaning queue', () => {
  before(async () => {
    fs.mkdirSync(WORKER_DIR);
    fs.writeFileSync(path.join(WORKER_DIR, 'reuse_worker.py'), 'print("v1")\n');
    fs.writeFileSync(path.join(WORKER_DIR, 'reuse-worker.config.json'), '{"token":"must never be served"}');
    fs.writeFileSync(path.join(WORKER_DIR, 'README.md'), 'doc');
    hubProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db'),
        HUB_REUSE_ADMIN_TOKEN: ADMIN, HUB_REUSE_WORKER_TOKENS: `gpu-box:${AMD},dev-box:${NV}`,
        HUB_REUSE_WORKER_DIR: WORKER_DIR, HUB_REUSE_LEASE_SECONDS: String(LEASE_S), HUB_RATE_LIMIT_PER_MINUTE: '20'
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }
  });

  after(() => {
    hubProcess?.kill('SIGTERM');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('tokens: none, wrong, and wrong role are refused', async () => {
    assert.strictEqual((await call('/api/reuse/jobs')).status, 403);
    assert.strictEqual((await call('/api/reuse/jobs', { token: 'x'.repeat(30) })).status, 403);
    assert.strictEqual((await call('/api/reuse/jobs', { token: AMD })).status, 403, 'a worker cannot list jobs');
    assert.strictEqual((await next(ADMIN)).status, 403, 'the admin token cannot claim');
    assert.strictEqual((await submit('x.flac', fakeFlac())).status, 201);
    assert.strictEqual((await call('/api/reuse/jobs?batch=p55&name=y.flac', { method: 'POST', token: AMD, rawBody: fakeFlac() })).status, 403);
    await call('/api/reuse/batches/p55', { method: 'DELETE', token: ADMIN });
  });

  test('submit: only mono FLAC with a known length; idempotent; never replaces audio', async () => {
    assert.strictEqual((await submit('a.flac', Buffer.from('RIFF not flac at all, just some bytes to be long enough'))).status, 422);
    assert.strictEqual((await submit('a.flac', fakeFlac({ channels: 2 }))).status, 422);
    assert.strictEqual((await submit('a.flac', fakeFlac({ samples: 0 }))).status, 422);
    assert.strictEqual((await submit('../a.flac', fakeFlac())).status, 400);
    const flac = fakeFlac({ salt: 'a' });
    const first = await submit('p55_000.flac', flac, '&chunk_s=5&overlap_s=2.5');
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.data.job.duration_s, 10);
    assert.deepStrictEqual(first.data.job.params, { chunk_s: 5, overlap_s: 2.5 });
    const again = await submit('p55_000.flac', flac);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.data.job.id, first.data.job.id);
    assert.strictEqual((await submit('p55_000.flac', fakeFlac({ salt: 'other' }))).status, 409);
  });

  test('claim, download, heartbeat, result: full path with hub-side checks', async () => {
    const flacSize = fakeFlac({ salt: 'a' }).length;
    const polled = await next(AMD, { version: 'abc', backend: 'vulkan', device: 'Radeon RX 7900 XTX' });
    assert.strictEqual(polled.status, 200);
    const j = polled.data.job;
    assert.strictEqual(j.name, 'p55_000.flac');
    assert.strictEqual(j.attempt, 1);
    assert.deepStrictEqual(j.params, { chunk_s: 5, overlap_s: 2.5 });

    // The other worker gets nothing and cannot touch the job
    assert.strictEqual((await next(NV)).data.job, null);
    assert.strictEqual((await call(`/api/reuse/jobs/${j.id}/input`, { token: NV })).status, 409);
    assert.strictEqual((await call(`/api/reuse/jobs/${j.id}/heartbeat`, { method: 'POST', token: NV, body: {} })).status, 409);

    const input = await call(`/api/reuse/jobs/${j.id}/input`, { token: AMD });
    assert.strictEqual(input.status, 200);
    assert.strictEqual(sha(input.buf), j.sha256);
    assert.strictEqual(input.headers.get('x-sha256'), j.sha256);

    const hb = await call(`/api/reuse/jobs/${j.id}/heartbeat`, { method: 'POST', token: AMD, body: { progress: 0.5, info: { version: 'abc', state: 'nettoyage', job: j.name } } });
    assert.strictEqual(hb.status, 200);
    assert.strictEqual((await job(j.id)).progress, 0.5);
    // The heartbeat is also what keeps a busy worker visible, with what it is doing
    const busy = (await call('/api/reuse/workers', { token: ADMIN })).data.workers.find(w => w.name === 'gpu-box');
    assert.strictEqual(busy.online, true);
    assert.strictEqual(busy.info.state, 'nettoyage');
    assert.strictEqual(busy.info.job, 'p55_000.flac');

    // A corrupted transfer is refused without burning an attempt
    const out = fakeFlac({ salt: 'clean' });
    assert.strictEqual((await result(j.id, AMD, out, 'deadbeef')).status, 400);
    assert.strictEqual((await job(j.id)).status, 'claimed');

    const done = await result(j.id, AMD, out);
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.data.job.status, 'done');
    assert.strictEqual(done.data.job.compute_s, 4);
    assert.strictEqual((await result(j.id, AMD, out)).status, 409, 'a result is accepted once');

    const fetched = await call(`/api/reuse/jobs/${j.id}/output`, { token: ADMIN });
    assert.strictEqual(fetched.status, 200);
    assert.ok(fetched.buf.equals(out));
    assert.match(fetched.headers.get('content-disposition'), /p55_000_clean\.flac/);
    assert.strictEqual((await call(`/api/reuse/jobs/${j.id}/output`, { token: AMD })).status, 403, 'workers never read outputs');

    const list = (await call('/api/reuse/jobs?batch=p55', { token: ADMIN })).data;
    assert.strictEqual(list.summary.done, 1);
    assert.strictEqual(list.summary.hub_storage.used_bytes, flacSize + out.length);
    assert.strictEqual(list.summary.measured_rtf, 0.4);
  });

  test('a result that is not a faithful cleaning is refused and the job re-queued, then failed after 3 attempts', async () => {
    const id = (await submit('p55_001.flac', fakeFlac({ salt: 'b' }))).data.job.id;
    const bad = [
      fakeFlac({ rate: 16000, samples: 160000, salt: 'x' }),   // 16 kHz
      fakeFlac({ samples: 24000 * 10 - 2400, salt: 'x' }),      // 0.1 s short
      fakeFlac({ channels: 2, salt: 'x' })                      // stereo
    ];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const j = (await next(AMD)).data.job;
      assert.strictEqual(j.id, id);
      assert.strictEqual(j.attempt, attempt);
      const r = await result(id, AMD, bad[attempt - 1]);
      assert.strictEqual(r.status, 422);
      assert.strictEqual(r.data.retry, attempt < 3);
    }
    const failed = await job(id);
    assert.strictEqual(failed.status, 'failed');
    assert.match(failed.error, /gpu-box: output has 2 channels/);
    assert.strictEqual((await next(AMD)).data.job, null, 'a failed job is not handed out again');

    // The admin can put it back; an input identical to the output is refused too
    assert.strictEqual((await call(`/api/reuse/jobs/${id}/retry`, { method: 'POST', token: ADMIN })).status, 200);
    const j = (await next(NV)).data.job;
    assert.strictEqual(j.attempt, 1);
    assert.strictEqual((await result(id, NV, fakeFlac({ salt: 'b' }))).status, 422);
    assert.strictEqual((await call(`/api/reuse/jobs/${id}/cancel`, { method: 'POST', token: ADMIN })).status, 200);
  });

  test('lease: a silent worker loses the job to another one; a restarted worker resumes its own job', async () => {
    const id = (await submit('p55_002.flac', fakeFlac({ salt: 'c' }))).data.job.id;
    assert.strictEqual((await next(AMD)).data.job.id, id);
    // Restart of the same worker inside the lease: same job, no new attempt
    const resumed = (await next(AMD)).data.job;
    assert.strictEqual(resumed.id, id);
    assert.strictEqual(resumed.attempt, 1);
    // Heartbeats keep it past the initial lease
    await sleep(LEASE_S * 600);
    assert.strictEqual((await call(`/api/reuse/jobs/${id}/heartbeat`, { method: 'POST', token: AMD, body: {} })).status, 200);
    await sleep(LEASE_S * 600);
    assert.strictEqual((await next(NV)).data.job, null, 'still leased thanks to the heartbeat');
    // Silence: the lease expires, the other worker takes over
    await sleep(LEASE_S * 1000 + 300);
    assert.strictEqual((await job(id)).status, 'pending', 'an expired lease shows as pending');
    const taken = (await next(NV)).data.job;
    assert.strictEqual(taken.id, id);
    assert.strictEqual(taken.attempt, 2);
    // The first worker comes back too late: everything it sends is refused
    assert.strictEqual((await call(`/api/reuse/jobs/${id}/heartbeat`, { method: 'POST', token: AMD, body: {} })).status, 409);
    assert.strictEqual((await result(id, AMD, fakeFlac({ salt: 'late' }))).status, 409);
    assert.strictEqual((await result(id, NV, fakeFlac({ salt: 'c-clean' }))).status, 200);
  });

  test('a late result is still accepted when nobody took the job over', async () => {
    const id = (await submit('p55_003.flac', fakeFlac({ salt: 'd' }))).data.job.id;
    assert.strictEqual((await next(AMD)).data.job.id, id);
    await sleep(LEASE_S * 1000 + 300);
    assert.strictEqual((await result(id, AMD, fakeFlac({ salt: 'd-clean' }))).status, 200);
  });

  test('priority first, then submission order; two workers never get the same job', async () => {
    const low = (await submit('p55_010.flac', fakeFlac({ salt: 'e' }))).data.job.id;
    const low2 = (await submit('p55_011.flac', fakeFlac({ salt: 'f' }))).data.job.id;
    const urgent = (await submit('clip.flac', fakeFlac({ salt: 'g' }), '&priority=5')).data.job.id;
    const [a, b] = await Promise.all([next(AMD), next(NV)]);
    assert.deepStrictEqual([a.data.job.id, b.data.job.id].sort(), [low, urgent].sort());
    for (const [tok, r] of [[AMD, a], [NV, b]]) await result(r.data.job.id, tok, fakeFlac({ salt: `out${r.data.job.id}` }));
    assert.strictEqual((await next(AMD)).data.job.id, low2);
    await call(`/api/reuse/jobs/${low2}/fail`, { method: 'POST', token: AMD, body: { error: 'GPU lost' } });
    assert.match((await job(low2)).error, /gpu-box: GPU lost/);
    assert.strictEqual((await job(low2)).status, 'pending');
    await call(`/api/reuse/jobs/${low2}/cancel`, { method: 'POST', token: ADMIN });
  });

  test('remote orders: pause, resume, forced update acknowledged once', async () => {
    const id = (await submit('p55_020.flac', fakeFlac({ salt: 'h' }))).data.job.id;
    assert.strictEqual((await call('/api/reuse/workers/nobody/order', { method: 'POST', token: ADMIN, body: { pause: true } })).status, 404);
    assert.strictEqual((await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: {} })).status, 400);
    assert.strictEqual((await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: AMD, body: { pause: true } })).status, 403);
    assert.strictEqual((await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: true } })).status, 200);

    const paused = await next(AMD);
    assert.strictEqual(paused.data.job, null);
    assert.strictEqual(paused.data.orders.paused, true);

    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: false, update: true } });
    const ordered = await next(AMD, { version: 'old' });
    const orderId = ordered.data.orders.update;
    assert.ok(orderId > 0);
    assert.strictEqual(ordered.data.job.id, id, 'resumed: it gets the job');
    await result(id, AMD, fakeFlac({ salt: 'h-clean' }));

    // The order stands until the restarted worker echoes its id, then disappears for good
    assert.strictEqual((await next(AMD, { version: 'old' })).data.orders.update, orderId);
    assert.strictEqual((await next(AMD, { version: 'new', update_ack: orderId })).data.orders.update, 0);
    assert.strictEqual((await next(AMD, { version: 'new' })).data.orders.update, 0);

    // A status report never claims a job and still carries the orders (startup, install failure)
    const waiting = (await submit('p55_021.flac', fakeFlac({ salt: 'h2' }))).data.job.id;
    const report = await call('/api/reuse/worker/status', { method: 'POST', token: AMD, body: { info: { version: 'new', last_error: 'installation : pas de pilote' } } });
    assert.strictEqual(report.status, 200);
    assert.strictEqual(report.data.orders.paused, false);
    assert.strictEqual((await job(waiting)).status, 'pending');
    assert.strictEqual((await call('/api/reuse/worker/status', { method: 'POST', token: ADMIN, body: {} })).status, 403);
    await call(`/api/reuse/jobs/${waiting}/cancel`, { method: 'POST', token: ADMIN });

    const workers = (await call('/api/reuse/workers', { token: ADMIN })).data;
    const amd = workers.workers.find(w => w.name === 'gpu-box');
    assert.strictEqual(amd.online, true);
    assert.strictEqual(amd.paused, false);
    assert.strictEqual(amd.info.version, 'new');
    assert.strictEqual(amd.info.last_error, 'installation : pas de pilote');
    assert.ok(amd.done >= 3 && amd.rtf > 0);
    assert.ok(workers.workers.some(w => w.name === 'dev-box'));
  });

  test('worker program: manifest with checksums, version follows the content, config and docs never served', async () => {
    const m1 = (await call('/api/reuse/worker/manifest', { token: AMD })).data;
    assert.deepStrictEqual(m1.files.map(f => f.name), ['reuse_worker.py']);
    const file = await call('/api/reuse/worker/files/reuse_worker.py', { token: AMD });
    assert.strictEqual(sha(file.buf), m1.files[0].sha256);
    for (const name of ['reuse-worker.config.json', 'README.md', '..%2Fpackage.json', 'nope.py']) {
      assert.strictEqual((await call(`/api/reuse/worker/files/${name}`, { token: AMD })).status, 404, name);
    }
    assert.strictEqual((await call('/api/reuse/worker/manifest')).status, 403);
    assert.strictEqual((await next(AMD)).data.orders.worker_version, m1.version);

    await sleep(20);
    fs.writeFileSync(path.join(WORKER_DIR, 'reuse_worker.py'), 'print("v2, longer")\n');
    const m2 = (await call('/api/reuse/worker/manifest', { token: AMD })).data;
    assert.notStrictEqual(m2.version, m1.version, 'publishing = replacing the file, no hub restart');
    assert.strictEqual((await next(AMD)).data.orders.worker_version, m2.version);
  });

  test('a valid RE-USE token is not rate limited; a batch can be deleted once nothing is computing', async () => {
    // HUB_RATE_LIMIT_PER_MINUTE=20 in this hub; well over that many calls were already made, 30 more to be sure
    for (let i = 0; i < 30; i++) assert.strictEqual((await call('/api/reuse/workers', { token: ADMIN })).status, 200);

    const id = (await submit('p55_030.flac', fakeFlac({ salt: 'i' }))).data.job.id;
    await next(NV);
    assert.strictEqual((await call('/api/reuse/batches/p55', { method: 'DELETE', token: ADMIN })).status, 409);
    await call(`/api/reuse/jobs/${id}/cancel`, { method: 'POST', token: ADMIN });
    const del = await call('/api/reuse/batches/p55', { method: 'DELETE', token: ADMIN });
    assert.strictEqual(del.status, 200);
    assert.ok(del.data.deleted >= 8);
    assert.strictEqual((await call('/api/reuse/jobs?batch=p55', { token: ADMIN })).data.jobs.length, 0);
    assert.deepStrictEqual(fs.readdirSync(path.join(TMP_DIR, 'reuse')), [], 'audio removed from disk');
    assert.strictEqual((await call('/api/reuse/batches/p55', { method: 'DELETE', token: ADMIN })).status, 404);
  });

  test('schedule: outside its window a worker gets no new job, finishes the one it holds, and the state is visible', async () => {
    const put = (name, schedule, token = ADMIN) => call(`/api/reuse/workers/${name}/schedule`, { method: 'PUT', token, body: schedule });
    const worker = async (name) => (await call('/api/reuse/workers', { token: ADMIN })).data.workers.find(w => w.name === name);
    const NEVER = { timezone: 'Europe/Paris', days: {} };
    const ALWAYS = { timezone: 'Europe/Paris', days: { mon: ['00:00-24:00'], tue: ['00:00-24:00'], wed: ['00:00-24:00'], thu: ['00:00-24:00'], fri: ['00:00-24:00'], sat: ['00:00-24:00'], sun: ['00:00-24:00'] } };

    // No schedule: always available, and the admin view says so
    assert.deepStrictEqual((await call('/api/reuse/workers/gpu-box/schedule', { token: ADMIN })).data,
      { success: true, worker: 'gpu-box', schedule: null, in_window: true, next_window_start: null, next_window_end: null });
    assert.strictEqual((await worker('gpu-box')).in_window, true);
    assert.strictEqual((await worker('gpu-box')).schedule, null);

    // Admin only, known worker only, valid schedule only
    assert.strictEqual((await put('gpu-box', NEVER, AMD)).status, 403);
    assert.strictEqual((await call('/api/reuse/workers/gpu-box/schedule', { token: AMD })).status, 403);
    assert.strictEqual((await put('nobody', NEVER)).status, 404);
    assert.strictEqual((await put('gpu-box', { timezone: 'Europe/Paris', days: { monday: ['20:00-08:00'] } })).status, 400);
    assert.strictEqual((await put('gpu-box', {})).status, 400);

    // gpu-box holds a job when its window closes
    const held = (await submit('p55_040.flac', fakeFlac({ salt: 'j' }))).data.job.id;
    const waiting = (await submit('p55_041.flac', fakeFlac({ salt: 'k' }))).data.job.id;
    assert.strictEqual((await next(AMD)).data.job.id, held);
    const closed = await put('gpu-box', NEVER);
    assert.strictEqual(closed.status, 200);
    assert.strictEqual(closed.data.in_window, false);

    // The job in progress goes on: heartbeat, resume after a restart, result
    assert.strictEqual((await call(`/api/reuse/jobs/${held}/heartbeat`, { method: 'POST', token: AMD, body: { progress: 0.5 } })).status, 200);
    assert.strictEqual((await next(AMD)).data.job.id, held, 'restarted mid-job: it resumes its own job');
    assert.strictEqual((await result(held, AMD, fakeFlac({ salt: 'j-clean' }))).status, 200);

    // ... but no new one: same answer as an empty queue, which every worker version already handles
    const refused = await next(AMD);
    assert.strictEqual(refused.status, 200);
    assert.strictEqual(refused.data.job, null);
    assert.strictEqual(refused.data.orders.paused, false, 'not a pause: the worker is told nothing new');
    assert.strictEqual((await job(waiting)).status, 'pending');
    assert.strictEqual((await job(waiting)).attempts, 0);

    // Still online (it keeps polling), shown out of window with its schedule
    const amd = await worker('gpu-box');
    assert.strictEqual(amd.online, true);
    assert.strictEqual(amd.in_window, false);
    assert.deepStrictEqual(amd.schedule, NEVER);
    assert.strictEqual(amd.next_window_start, null);
    assert.strictEqual((await worker('dev-box')).in_window, true, 'the other worker is not concerned');

    // A weekly schedule announces its next window
    const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.now() + 2 * 24 * 3600 * 1000).getUTCDay()];
    const later = await put('gpu-box', { timezone: 'UTC', days: { [day]: ['00:00-06:00'] } });
    assert.strictEqual(later.data.in_window, false);
    assert.ok(Date.parse(later.data.next_window_start) > Date.now());
    assert.strictEqual(Date.parse(later.data.next_window_end) - Date.parse(later.data.next_window_start), 6 * 3600 * 1000);
    assert.strictEqual((await next(AMD)).data.job, null);

    // Window open again: the waiting job is served. Then the schedule is removed.
    assert.strictEqual((await put('gpu-box', ALWAYS)).data.in_window, true);
    assert.strictEqual((await next(AMD)).data.job.id, waiting);
    await result(waiting, AMD, fakeFlac({ salt: 'k-clean' }));
    await put('gpu-box', NEVER);
    const cleared = await call('/api/reuse/workers/gpu-box/schedule', { method: 'DELETE', token: ADMIN });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.data.schedule, null);
    assert.strictEqual(cleared.data.in_window, true);
    const last = (await submit('p55_042.flac', fakeFlac({ salt: 'l' }))).data.job.id;
    assert.strictEqual((await next(AMD)).data.job.id, last, 'no schedule: served again');
    await call(`/api/reuse/jobs/${last}/cancel`, { method: 'POST', token: ADMIN });
  });
});

describe('RE-USE queue disabled', () => {
  test('404 on every route when no token is configured', async () => {
    const tmp = tmpDir('hub-reuse-off-');
    const env = { ...process.env, PORT: '4152', DB_PATH: path.join(tmp, 'hub.db') };
    delete env.HUB_REUSE_ADMIN_TOKEN; delete env.HUB_REUSE_WORKER_TOKENS;
    const hub = spawn('node', ['src/index.js'], { cwd: process.cwd(), env, stdio: 'ignore' });
    try {
      for (let i = 0; i < 75; i++) {
        try { if ((await fetch('http://localhost:4152/health')).ok) break; } catch { /* starting */ }
        await sleep(200);
      }
      for (const p of ['/api/reuse/jobs', '/api/reuse/workers', '/api/reuse/worker/manifest']) {
        assert.strictEqual((await fetch(`http://localhost:4152${p}`, { headers: { Authorization: 'Bearer whatever-0123456789' } })).status, 404);
      }
    } finally {
      hub.kill('SIGTERM');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('RE-USE queue storage cap', () => {
  test('507 instead of filling the disk; room comes back when a batch is deleted', async () => {
    const tmp = tmpDir('hub-reuse-cap-');
    const flac = fakeFlac({ salt: 'cap' });
    const hub = spawn('node', ['src/index.js'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: { ...process.env, PORT: '4157', DB_PATH: path.join(tmp, 'hub.db'), HUB_REUSE_ADMIN_TOKEN: ADMIN, HUB_REUSE_MAX_STORAGE: String(flac.length * 3) }
    });
    const post = (name) => fetch(`http://localhost:4157/api/reuse/jobs?batch=cap&name=${name}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` }, body: fakeFlac({ salt: 'cap' })
    }).then(r => r.status);
    try {
      for (let i = 0; i < 75; i++) {
        try { if ((await fetch('http://localhost:4157/health')).ok) break; } catch { /* starting */ }
        await sleep(200);
      }
      assert.strictEqual(await post('a.flac'), 201);
      assert.strictEqual(await post('b.flac'), 507, 'source + future result would not fit');
      assert.strictEqual(await post('a.flac'), 200, 'an already stored piece is still acknowledged');
      await fetch('http://localhost:4157/api/reuse/batches/cap', { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } });
      assert.strictEqual(await post('b.flac'), 201);
    } finally {
      hub.kill('SIGTERM');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('RE-USE queue hardening', () => {
  const P = '4158';
  const URL_ = `http://localhost:${P}`;
  const MAX_FILE = 4096;
  let tmp, reuseDir, workerDir, hub;
  const startHub = async () => {
    hub = spawn('node', ['src/index.js'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: {
        ...process.env, PORT: P, PUBLIC_URL: URL_, DB_PATH: path.join(tmp, '.state', 'hub.db'), HUB_REUSE_ADMIN_TOKEN: ADMIN,
        HUB_REUSE_WORKER_TOKENS: `gpu-box:${AMD}`, HUB_REUSE_WORKER_DIR: workerDir,
        HUB_REUSE_MAX_FILE_SIZE: String(MAX_FILE), HUB_REUSE_MAX_STORAGE: '1000', HUB_RATE_LIMIT_PER_MINUTE: '1000'
      }
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${URL_}/health`)).ok) return; } catch { /* starting */ }
      await sleep(200);
    }
    assert.fail('hub did not start');
  };
  const stopHub = async () => {
    const gone = new Promise(r => hub.once('exit', r));
    hub.kill('SIGTERM');
    await gone;
  };
  const http = async (p, { method = 'GET', token, body, headers = {} } = {}) => {
    const res = await fetch(URL_ + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });
    const buf = Buffer.from(await res.arrayBuffer());
    let data = null;
    try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
    return { status: res.status, data, buf };
  };
  const put = (name, flac, q = `batch=h&name=${name}`) => http(`/api/reuse/jobs?${q}`, { method: 'POST', token: ADMIN, body: flac });
  const claim = () => http('/api/reuse/next', { method: 'POST', token: AMD, body: JSON.stringify({ wait: 0 }), headers: { 'Content-Type': 'application/json' } });
  const send = (id, flac) => http(`/api/reuse/jobs/${id}/result?compute_s=1&backend=cpu`, { method: 'POST', token: AMD, body: flac, headers: { 'X-Sha256': sha(flac) } });
  const view = async (id) => (await http(`/api/reuse/jobs/${id}`, { token: ADMIN })).data;

  before(async () => {
    tmp = tmpDir('hub-reuse-hard-');
    reuseDir = path.join(tmp, '.state', 'reuse'); // under a dot folder on purpose (downloads must still work)
    workerDir = path.join(tmp, 'worker-files');
    fs.mkdirSync(path.join(tmp, '.state'));
    fs.mkdirSync(workerDir);
    fs.writeFileSync(path.join(workerDir, 'reuse_worker.py'), 'print("v1")\n');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'not part of the worker program');
    fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(workerDir, 'linked.txt'));
    await startHub();
  });

  after(async () => {
    hub?.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the token is checked before the body is read: no token, no upload held in memory', async () => {
    const big = Buffer.concat([fakeFlac(), Buffer.alloc(MAX_FILE * 2)]);
    // Before the fix the body parser ran first and these answered 413: the body had been read
    assert.strictEqual((await http('/api/reuse/jobs?batch=h&name=big.flac', { method: 'POST', body: big })).status, 403);
    assert.strictEqual((await http('/api/reuse/jobs?batch=h&name=big.flac', { method: 'POST', token: 'wrong-token-0123456789', body: big })).status, 403);
    assert.strictEqual((await http('/api/reuse/jobs/1/result', { method: 'POST', token: ADMIN, body: big })).status, 403, 'admin is not a worker');
    const tooBig = await put('big.flac', big);
    assert.strictEqual(tooBig.status, 413);
    assert.match(tooBig.data.error, /Audio file too large/);
  });

  test('a query parameter given as a list is refused, never a 500', async () => {
    assert.strictEqual((await put('x.flac', fakeFlac(), 'batch[]=h&name=x.flac')).status, 400);
    assert.strictEqual((await put('x.flac', fakeFlac(), 'batch=h&name=x.flac&name=y.flac')).status, 400);
    assert.strictEqual((await http('/api/reuse/jobs?batch[]=h&status[]=done', { token: ADMIN })).status, 200);
  });

  test('audio is served even when the storage folder sits under a dot folder', async () => {
    const flac = fakeFlac({ salt: 'dot' });
    const id = (await put('dot.flac', flac)).data.job.id;
    assert.strictEqual((await claim()).data.job.id, id);
    const input = await http(`/api/reuse/jobs/${id}/input`, { token: AMD });
    assert.strictEqual(input.status, 200);
    assert.strictEqual(sha(input.buf), sha(flac));
    const out = fakeFlac({ salt: 'dot-clean' });
    assert.strictEqual((await send(id, out)).status, 200);
    const got = await http(`/api/reuse/jobs/${id}/output`, { token: ADMIN });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(sha(got.buf), sha(out));
  });

  test('a result that would push the disk past the cap is refused without burning the attempt', async () => {
    const id = (await put('fat.flac', fakeFlac({ salt: 'fat' }))).data.job.id;
    assert.strictEqual((await claim()).data.job.id, id);
    const fat = fakeFlac({ salt: 'x'.repeat(900) });
    assert.ok(fat.length < MAX_FILE);
    const refused = await send(id, fat);
    assert.strictEqual(refused.status, 507);
    assert.ok(!fs.existsSync(path.join(reuseDir, `${id}.out.flac`)));
    const j = await view(id);
    assert.strictEqual(j.status, 'claimed');
    assert.strictEqual(j.attempts, 1);
    assert.strictEqual((await send(id, fakeFlac({ salt: 'fat-clean' }))).status, 200, 'same attempt, a result that fits');
  });

  test('a job whose source audio is gone is failed for good instead of being handed out again', async () => {
    const id = (await put('gone.flac', fakeFlac({ salt: 'gone' }))).data.job.id;
    assert.strictEqual((await claim()).data.job.id, id);
    fs.rmSync(path.join(reuseDir, `${id}.in.flac`));
    assert.strictEqual((await http(`/api/reuse/jobs/${id}/input`, { token: AMD })).status, 404);
    const j = await view(id);
    assert.strictEqual(j.status, 'failed');
    assert.match(j.error, /missing on the hub/);
    assert.strictEqual((await claim()).data.job, null, 'before the fix the same job came back at every poll');
  });

  test('worker program: a symbolic link is never published', async () => {
    const manifest = (await http('/api/reuse/worker/manifest', { token: AMD })).data;
    assert.deepStrictEqual(manifest.files.map(f => f.name), ['reuse_worker.py']);
    assert.strictEqual((await http('/api/reuse/worker/files/linked.txt', { token: AMD })).status, 404);
  });

  test('startup sweep: orphan audio and half-written files go, known audio stays, a job without source fails', async () => {
    const kept = (await put('kept.flac', fakeFlac({ salt: 'kept' }))).data.job.id;
    const lost = (await put('lost.flac', fakeFlac({ salt: 'lost' }))).data.job.id;
    const done = (await http('/api/reuse/jobs?batch=h&status=done', { token: ADMIN })).data.jobs[0].id;
    await stopHub();
    fs.rmSync(path.join(reuseDir, `${lost}.in.flac`));
    const orphans = ['99999.in.flac', '99999.out.flac', `${kept}.out.flac`, `${kept}.in.flac.4242.tmp`, '99998.out.flac.4242.tmp'];
    for (const n of orphans) fs.writeFileSync(path.join(reuseDir, n), 'orphan');
    fs.writeFileSync(path.join(reuseDir, 'notes.txt'), 'not ours: never touched');
    await startHub();
    const left = fs.readdirSync(reuseDir);
    for (const n of orphans) assert.ok(!left.includes(n), `${n} removed`);
    for (const n of [`${kept}.in.flac`, `${done}.in.flac`, `${done}.out.flac`, 'notes.txt']) assert.ok(left.includes(n), `${n} kept`);
    assert.strictEqual((await view(lost)).status, 'failed');
    assert.strictEqual((await claim()).data.job.id, kept);
  });
});

describe('RE-USE portable Python fallback', () => {
  const P = '4159';
  const URL_ = `http://localhost:${P}`;
  const zip = Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(2000)]);
  const launcher = (digest, version = '3.14.10') => `$PyVersion = '${version}'\n$PySha256 = '${digest}'\n`;
  let tmp, workerDir, hub, origin, originUrl, hits, served;
  const get = async (token) => {
    const res = await fetch(`${URL_}/api/reuse/worker/python`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const cached = () => path.join(tmp, 'reuse', 'runtime', 'python-3.14.10-embed-amd64.zip');
  const publish = (text) => fs.writeFileSync(path.join(workerDir, 'install-and-run.ps1'), text);

  before(async () => {
    tmp = tmpDir('hub-reuse-py-');
    workerDir = path.join(tmp, 'worker-files');
    fs.mkdirSync(workerDir);
    fs.writeFileSync(path.join(workerDir, 'reuse_worker.py'), 'print("v1")\n');
    hits = [];
    served = zip;
    origin = http.createServer((req, res) => {
      hits.push(req.url);
      if (!served) { res.writeHead(403); return res.end('Forbidden'); }
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(served);
    });
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    originUrl = `http://127.0.0.1:${origin.address().port}/ftp/python`;
    hub = spawn('node', ['src/index.js'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: {
        ...process.env, PORT: P, PUBLIC_URL: URL_, DB_PATH: path.join(tmp, 'hub.db'), HUB_REUSE_ADMIN_TOKEN: ADMIN,
        HUB_REUSE_WORKER_TOKENS: `gpu-box:${AMD}`, HUB_REUSE_WORKER_DIR: workerDir, HUB_REUSE_PYTHON_BASE_URL: originUrl
      }
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${URL_}/health`)).ok) return; } catch { /* starting */ }
      await sleep(200);
    }
    assert.fail('hub did not start');
  });

  after(() => {
    hub?.kill('SIGTERM');
    origin?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('needs a RE-USE token, and a published Windows launcher', async () => {
    assert.strictEqual((await get()).status, 403);
    assert.strictEqual((await get('x'.repeat(30))).status, 403);
    assert.strictEqual((await get(AMD)).status, 404, 'no install-and-run.ps1 published: nothing to serve');
    assert.deepStrictEqual(hits, [], 'nothing fetched for an unknown caller or an unknown version');
  });

  test('an archive whose checksum is not the launcher\'s is never cached nor served', async () => {
    publish(launcher(sha(Buffer.from('another archive'))));
    const res = await get(AMD);
    assert.strictEqual(res.status, 502);
    assert.ok(!res.buf.includes(zip.subarray(0, 64)), 'the refused bytes do not leak into the answer');
    assert.ok(!fs.existsSync(cached()));
    assert.deepStrictEqual(hits, ['/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip']);
  });

  test('an origin that refuses (403) gives a clear 502', async () => {
    publish(launcher(sha(zip)));
    served = null;
    const res = await get(AMD);
    assert.strictEqual(res.status, 502);
    assert.match(JSON.parse(res.buf.toString()).error, /HTTP 403/);
    served = zip;
  });

  test('fetched once, verified, then served from the cache to workers and admin', async () => {
    hits.length = 0;
    const [a, b] = await Promise.all([get(AMD), get(AMD)]);
    for (const res of [a, b, await get(ADMIN)]) {
      assert.strictEqual(res.status, 200);
      assert.ok(res.buf.equals(zip));
      assert.strictEqual(res.headers.get('x-sha256'), sha(zip));
    }
    assert.strictEqual(hits.length, 1, 'concurrent and later requests share one download');
    assert.ok(fs.readFileSync(cached()).equals(zip));
    served = null; // python.org now unreachable: the cache is enough
    assert.strictEqual((await get(AMD)).status, 200);
  });

  test('a cached file that no longer matches is fetched again, not served', async () => {
    fs.writeFileSync(cached(), 'tampered');
    assert.strictEqual((await get(AMD)).status, 502, 'origin down: refuses rather than serving the tampered file');
    served = zip;
    const res = await get(AMD);
    assert.strictEqual(res.status, 200);
    assert.ok(res.buf.equals(zip));
  });
});

describe('RE-USE tokens declared by fingerprint', () => {
  const P = '4163', URL_ = `http://localhost:${P}`;
  const HASHED = 'pc-hash-token-made-on-the-pc-0123456789';   // never given to the hub
  const UPPER = 'pc-upper-token-made-on-the-pc-0123456789';
  const ADMIN_LOCAL = 'admin-token-made-locally-0123456789';
  const LOST = 'token-pasted-without-a-name-0123456789';
  const BARE = sha('a fingerprint pasted without its prefix');
  const fp = (t) => `sha256:${sha(t)}`;
  let hub, tmp, out = '';

  before(async () => {
    tmp = tmpDir('hub-reuse-fp-');
    hub = spawn('node', ['src/index.js'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, PORT: P, PUBLIC_URL: URL_, DB_PATH: path.join(tmp, 'hub.db'), LOG_LEVEL: 'info',
        HUB_REUSE_ADMIN_TOKEN: fp(ADMIN_LOCAL),
        HUB_REUSE_WORKER_TOKENS: [
          `gpu-box:${AMD}`, `pc-hash:${fp(HASHED)}`, `pc-upper:SHA256:${sha(UPPER).toUpperCase()}`,
          LOST, 'pc-bad:sha256:abc123', 'pc-short:tooshort', `bad name:${NV}`, `pc-bare:${BARE}`, ''
        ].join(', ')
      }
    });
    hub.stdout.on('data', d => { out += d; });
    hub.stderr.on('data', d => { out += d; });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${URL_}/health`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }
  });

  after(() => {
    hub?.kill('SIGTERM');
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const claim = async (token) => (await fetch(`${URL_}/api/reuse/next`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"wait":0}'
  })).status;
  const workers = async (token) => {
    const res = await fetch(`${URL_}/api/reuse/workers`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, data: res.status === 200 ? await res.json() : null };
  };

  test('a worker declared by fingerprint is accepted with its token, any hex case; a clear entry still works', async () => {
    assert.strictEqual(await claim(HASHED), 200);
    assert.strictEqual(await claim(UPPER), 200);
    assert.strictEqual(await claim(AMD), 200, 'clear entry, as before');
    const list = await workers(ADMIN_LOCAL);
    assert.strictEqual(list.status, 200, 'admin declared by fingerprint');
    const byName = Object.fromEntries(list.data.workers.map(w => [w.name, w]));
    for (const name of ['gpu-box', 'pc-hash', 'pc-upper']) assert.strictEqual(byName[name]?.has_token, true, name);
    for (const name of ['pc-bad', 'pc-short', 'bad name']) assert.strictEqual(byName[name], undefined, name);
  });

  test('a wrong token is refused, and a fingerprint is never a token', async () => {
    assert.strictEqual(await claim(`${HASHED}x`), 403);
    assert.strictEqual(await claim(HASHED.slice(0, -1)), 403);
    assert.strictEqual(await claim(fp(HASHED)), 403, 'the published fingerprint does not open the door');
    assert.strictEqual(await claim(sha(HASHED)), 403);
    assert.strictEqual(await claim(sha(UPPER).toUpperCase()), 403);
    assert.strictEqual((await workers(fp(ADMIN_LOCAL))).status, 403);
    assert.strictEqual((await workers(sha(ADMIN_LOCAL))).status, 403);
    assert.strictEqual((await workers(HASHED)).status, 403, 'a worker is not the admin');
    assert.strictEqual(await claim(ADMIN_LOCAL), 403, 'the admin is not a worker');
    for (const refused of [LOST, 'abc123', 'tooshort', NV]) assert.strictEqual(await claim(refused), 403);
  });

  test('a malformed entry is reported at startup by its position, never by its value', async () => {
    const warned = out.split('\n').filter(l => l.includes('RE-USE tokens:'));
    for (const n of [4, 5, 6, 7]) assert.ok(warned.some(l => l.includes(`entry ${n} ignored`)), `entry ${n} reported:\n${warned.join('\n')}`);
    assert.ok(warned.some(l => l.includes('entry 8') && l.includes('without its \\"sha256:\\" prefix')), 'bare fingerprint pointed out');
    assert.strictEqual(warned.length, 5, 'valid entries and the empty one are not reported');
    assert.ok(warned.every(l => JSON.parse(l).level === 'warn'));
    for (const secret of [LOST, LOST.slice(0, 12), 'abc123', 'tooshort', NV, AMD, HASHED, BARE, sha(HASHED), ADMIN_LOCAL, 'pc-bad', 'pc-short', 'bad name']) {
      assert.ok(!out.includes(secret), 'nothing of a refused or accepted entry reaches the log');
    }
  });
});

describe('RE-USE token parsing', () => {
  test('clear and fingerprint forms give the same digest; malformed forms give a reason without the value', async () => {
    const { parseTokenSpec, parseReuseWorkerTokens, parseReuseAdminToken } = await import('../src/config.js');
    const token = 'made-on-the-pc-0123456789';
    const digest = crypto.createHash('sha256').update(token).digest();
    assert.deepStrictEqual(parseTokenSpec(token), { digest });
    assert.deepStrictEqual(parseTokenSpec(`sha256:${sha(token)}`), { digest });
    assert.deepStrictEqual(parseTokenSpec(`sha256:${sha(token).toUpperCase()}`), { digest });
    for (const bad of ['', 'short', 'sha256:', 'sha256:xyz', `sha256:${sha(token)}0`, `sha256:${sha(token).slice(1)}`, `sha256: ${sha(token)}`, `sha256:${'g'.repeat(64)}`]) {
      const r = parseTokenSpec(bad);
      assert.ok(r.problem && !r.digest, bad);
      if (bad.length > 7) assert.ok(!r.problem.includes(bad.slice(7)), 'reason without the value');
    }
    const parsed = parseReuseWorkerTokens(` a:${token} ,, b:sha256:${sha(token)}, c:sha256:12, ${token}, d:with:colons-0123456789 `);
    assert.deepStrictEqual(parsed.workers.map(w => w.name), ['a', 'b', 'd']);
    assert.ok(parsed.workers[0].digest.equals(digest) && parsed.workers[1].digest.equals(digest));
    assert.ok(parsed.workers[2].digest.equals(crypto.createHash('sha256').update('with:colons-0123456789').digest()), 'a clear token may contain colons');
    assert.strictEqual(parsed.problems.length, 2);
    assert.match(parsed.problems[0], /entry 4 ignored/);
    assert.match(parsed.problems[1], /entry 5 ignored/);
    assert.ok(!parsed.problems.join(' ').includes(token));
    assert.deepStrictEqual(parseReuseWorkerTokens(undefined), { workers: [], problems: [] });
    assert.deepStrictEqual(parseReuseAdminToken(undefined), { digest: null, problems: [] });
    assert.ok(parseReuseAdminToken(`sha256:${sha(token)}`).digest.equals(digest));
    assert.ok(parseReuseAdminToken(token).digest.equals(digest));
    const short = parseReuseAdminToken('tooshort');
    assert.strictEqual(short.digest, null);
    assert.strictEqual(short.problems.length, 1);
    assert.ok(!short.problems[0].includes('tooshort'));
  });
});
