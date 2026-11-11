import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4151';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reuse-'));
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
});

describe('RE-USE queue disabled', () => {
  test('404 on every route when no token is configured', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reuse-off-'));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reuse-cap-'));
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
