import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Remote control of a worker machine from the hub: settings overrides (enable_3d...) and GPU tests
// (remote --gpu-test, ComfyUI bench), driven by the admin token, run by the worker between two jobs.

const PORT = '4198';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wctl-'));
const WORKER_DIR = path.join(TMP_DIR, 'worker-files');
const ADMIN = 'reuse-admin-secret-wctl-0123456789';
const AMD = 'gpu-box-worker-secret-wctl-0123456789';
const NV = 'dev-box-worker-secret-wctl-0123456789';

let hubProcess;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(p, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { 'Content-Type': rawBody ? 'audio/flac' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody || (body === undefined ? undefined : JSON.stringify(body))
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, data };
}

function fakeFlac(salt) {
  const b = Buffer.alloc(42);
  b.write('fLaC', 0, 'latin1');
  b[4] = 0x80; b[7] = 34;
  b.writeUInt32BE(((24000 << 12) | (23 << 4)) >>> 0, 18);
  b.writeUInt32BE(240000, 22);
  return Buffer.concat([b, Buffer.from(`audio-${salt}`)]);
}

const next = (token, info = {}) => call('/api/reuse/next', { method: 'POST', token, body: { wait: 0, info } });
const settings = (name, body, token = ADMIN) => call(`/api/reuse/workers/${name}/settings`, { method: 'POST', token, body });
const ask = (name, body, token = ADMIN) => call(`/api/reuse/workers/${name}/tests`, { method: 'POST', token, body });
const report = (id, body, token = AMD) => call(`/api/reuse/worker/tests/${id}`, { method: 'POST', token, body });
const readTest = async (id, name = 'gpu-box') => (await call(`/api/reuse/workers/${name}/tests/${id}`, { token: ADMIN })).data.test;
const NEW_WORKER = { version: 'v2', tests: 'image,3d,comfyui,comfyui_remove' };

describe('RE-USE worker remote control', () => {
  before(async () => {
    fs.mkdirSync(WORKER_DIR);
    fs.writeFileSync(path.join(WORKER_DIR, 'reuse_worker.py'), 'print("v2")\n');
    hubProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db'),
        HUB_REUSE_ADMIN_TOKEN: ADMIN, HUB_REUSE_WORKER_TOKENS: `gpu-box:${AMD},dev-box:${NV}`, HUB_REUSE_WORKER_DIR: WORKER_DIR
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

  test('settings: admin only, known keys and bounds only, all or nothing', async () => {
    assert.strictEqual((await settings('gpu-box', { enable_3d: true }, AMD)).status, 403);
    assert.strictEqual((await call('/api/reuse/workers/gpu-box/settings', { token: AMD })).status, 403);
    assert.strictEqual((await settings('nobody', { enable_3d: true })).status, 404);
    assert.strictEqual((await settings('gpu-box', {})).status, 400);
    assert.strictEqual((await settings('gpu-box', { token: 'x' })).status, 400, 'never a key outside the list');
    assert.strictEqual((await settings('gpu-box', { hub_url: 'https://evil' })).status, 400);
    assert.strictEqual((await settings('gpu-box', { enable_3d: 'yes' })).status, 400);
    assert.strictEqual((await settings('gpu-box', { gpu_max_gb: 500 })).status, 400);
    assert.strictEqual((await settings('gpu-box', { gpu_keep_loaded_s: 1.5 })).status, 400);
    const mixed = await settings('gpu-box', { enable_3d: true, gpu_max_gb: 1 });
    assert.strictEqual(mixed.status, 400);
    assert.deepStrictEqual((await call('/api/reuse/workers/gpu-box/settings', { token: ADMIN })).data.settings, {}, 'nothing applied from a refused patch');
  });

  test('settings: sent with every order, visible to the admin, journaled, removed by null', async () => {
    const set = await settings('gpu-box', { enable_3d: true, gpu_max_gb: 45 });
    assert.strictEqual(set.status, 200);
    assert.deepStrictEqual(set.data.settings, { enable_3d: true, gpu_max_gb: 45 });
    assert.deepStrictEqual(set.data.changed, [{ key: 'enable_3d', from: null, to: true }, { key: 'gpu_max_gb', from: null, to: 45 }]);

    const polled = await next(AMD, NEW_WORKER);
    assert.deepStrictEqual(polled.data.orders.settings, { enable_3d: true, gpu_max_gb: 45 });
    assert.deepStrictEqual((await next(NV)).data.orders.settings, {}, 'per machine');
    const listed = (await call('/api/reuse/workers', { token: ADMIN })).data.workers.find(w => w.name === 'gpu-box');
    assert.deepStrictEqual(listed.settings, { enable_3d: true, gpu_max_gb: 45 });

    // Same value again: nothing changes, nothing journaled
    assert.deepStrictEqual((await settings('gpu-box', { enable_3d: true })).data.changed, []);
    const back = await settings('gpu-box', { enable_3d: null, gpu_max_gb: null });
    assert.deepStrictEqual(back.data.settings, {});
    assert.deepStrictEqual((await next(AMD, NEW_WORKER)).data.orders.settings, {});

    const { history } = (await call('/api/reuse/workers/gpu-box/settings', { token: ADMIN })).data;
    assert.strictEqual(history.length, 2, 'one entry per effective change');
    assert.strictEqual(history[0].what, 'settings');
    assert.deepStrictEqual(history[0].changed, [{ key: 'enable_3d', from: true, to: null }, { key: 'gpu_max_gb', from: 45, to: null }]);
    assert.ok(history[0].at);
  });

  test('tests: validated, one open per worker, a warning when the machine cannot run it yet', async () => {
    assert.strictEqual((await ask('gpu-box', { kind: '3d' }, AMD)).status, 403);
    assert.strictEqual((await ask('nobody', { kind: '3d' })).status, 404);
    assert.strictEqual((await ask('gpu-box', { kind: 'shell' })).status, 400);
    assert.strictEqual((await ask('gpu-box', { kind: '3d', params: { res: '2048' } })).status, 400);
    assert.strictEqual((await ask('gpu-box', { kind: '3d', params: { command: 'x' } })).status, 400, 'unknown parameter refused');
    assert.strictEqual((await ask('gpu-box', { kind: 'comfyui', params: { width: 1000 } })).status, 400, 'multiple of 64');
    assert.strictEqual((await ask('gpu-box', { kind: 'comfyui', params: { steps: 8.5 } })).status, 400);

    // dev-box never said it runs remote tests (old version): accepted, with the reason it will wait
    await next(NV, { version: 'v1' });
    const old = await ask('dev-box', { kind: 'image' });
    assert.strictEqual(old.status, 201);
    assert.match(old.data.warning, /has not announced "image" tests/);
    assert.strictEqual((await ask('dev-box', { kind: 'image' })).status, 409, 'one open test per machine');
    assert.strictEqual((await call(`/api/reuse/workers/dev-box/tests/${old.data.test.id}/cancel`, { method: 'POST', token: ADMIN })).status, 200);
    assert.strictEqual((await readTest(old.data.test.id, 'dev-box')).status, 'cancelled');
    assert.strictEqual((await call(`/api/reuse/workers/gpu-box/tests/${old.data.test.id}`, { token: ADMIN })).status, 404, 'tests are per worker');
  });

  test('auto-repair: verify_models and comfyui_reinstall validated; the worker journals its repair steps, the admin reads them', async () => {
    const bad = [{ model: '../x' }, { model: 'Flux' }, { model: 7 }, { repair: 'yes' }, { env: 1 }, { path: 'C:/' }];
    for (const params of bad) assert.strictEqual((await ask('gpu-box', { kind: 'verify_models', params })).status, 400, JSON.stringify(params));
    assert.strictEqual((await ask('gpu-box', { kind: 'comfyui_reinstall', params: { model: 'x' } })).status, 400);
    const v = await ask('gpu-box', { kind: 'verify_models', params: { model: 'flux3-klein', repair: true, env: false } });
    assert.strictEqual(v.status, 201);
    assert.deepStrictEqual(v.data.test.params, { model: 'flux3-klein', repair: true, env: false });
    assert.match(v.data.warning, /has not announced "verify_models" tests/, 'a worker version without it: the reason is given');
    assert.strictEqual((await call(`/api/reuse/workers/gpu-box/tests/${v.data.test.id}/cancel`, { method: 'POST', token: ADMIN })).status, 200);
    const r = await ask('gpu-box', { kind: 'comfyui_reinstall' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await call(`/api/reuse/workers/gpu-box/tests/${r.data.test.id}/cancel`, { method: 'POST', token: ADMIN })).status, 200);

    // Steps the worker reports on its own: kept in its journal, worker token only, repair_*/verify_* only, detail clipped
    const ev = (body, token = AMD) => call('/api/reuse/worker/events', { method: 'POST', token, body });
    assert.strictEqual((await ev({ what: 'repair_file', detail: {} }, ADMIN)).status, 403);
    assert.strictEqual((await ev({ what: 'settings', detail: {} })).status, 400, 'never an admin event');
    assert.strictEqual((await ev({ what: 'repair_file', detail: ['x'] })).status, 400);
    const step = { model: 'flux3-klein', job: 187, file: 'qwen3vl_4b_bf16.safetensors', state: 'empreinte', action: 'effacé ; retéléchargé et vérifié',
      at: 'forged', what: 'forged' };
    assert.strictEqual((await ev({ what: 'repair_file', detail: step })).status, 200);
    assert.strictEqual((await ev({ what: 'repair_finished', detail: { summary: 's'.repeat(20000), replay: true } })).status, 200);
    const history = (await call('/api/reuse/workers/gpu-box/settings', { token: ADMIN })).data.history;
    const file = history.find(e => e.what === 'repair_file');
    assert.strictEqual(file.file, 'qwen3vl_4b_bf16.safetensors');
    assert.strictEqual(file.state, 'empreinte');
    assert.notStrictEqual(file.at, 'forged', 'the journal keeps its own time');
    const fin = history.find(e => e.what === 'repair_finished');
    assert.ok(JSON.stringify(fin).length < 4500, 'a huge detail is cut, not refused');
    assert.ok(history.findIndex(e => e.what === 'repair_finished') < history.findIndex(e => e.what === 'repair_file'), 'most recent first');
  });

  test('tests: handed out at once, no new job meanwhile, progress then report readable by the admin', async () => {
    const queued = await call('/api/reuse/jobs?batch=t&name=t_000.flac', { method: 'POST', token: ADMIN, rawBody: fakeFlac('a') });
    assert.strictEqual(queued.status, 201);
    const asked = await ask('gpu-box', { kind: '3d', params: { res: '512', steps: 12 } });
    assert.strictEqual(asked.status, 201);
    assert.strictEqual(asked.data.warning, undefined);
    const id = asked.data.test.id;
    assert.strictEqual(asked.data.test.status, 'pending');

    // The long poll answers at once with the order, and no job: the machine stays free for the test
    const t0 = Date.now();
    const got = await call('/api/reuse/next', { method: 'POST', token: AMD, body: { wait: 20, info: NEW_WORKER } });
    assert.ok(Date.now() - t0 < 5000, 'not held for the whole long poll');
    assert.strictEqual(got.data.job, null);
    assert.deepStrictEqual(got.data.orders.gpu_test, { id, kind: '3d', params: { res: '512', steps: 12 } });

    // Another worker still gets the RE-USE job
    assert.strictEqual((await next(NV)).data.job.name, 't_000.flac');

    // Another worker cannot report on it
    assert.strictEqual((await report(id, { status: 'running' }, NV)).status, 404);
    const running = await report(id, { status: 'running', stage: 'téléchargement de ss_flow.gguf', progress: 0.2 });
    assert.strictEqual(running.status, 200);
    assert.strictEqual(running.data.cancel, false);
    assert.strictEqual(running.data.orders.gpu_test, null, 'a running test is never handed out again (a restart does not loop)');
    let t = await readTest(id);
    assert.strictEqual(t.status, 'running');
    assert.strictEqual(t.stage, 'téléchargement de ss_flow.gguf');
    assert.strictEqual(t.progress, 0.2);
    assert.ok(t.started_at);

    const done = await report(id, {
      status: 'done',
      report: { ok: true, kind: '3d', compute_s: 412.5, device: 'AMD Radeon RX 6950 XT', size: 123456, log: ['[1/7] preprocess', '[7/7] glb written'] }
    });
    assert.strictEqual(done.status, 200);
    t = await readTest(id);
    assert.strictEqual(t.status, 'done');
    assert.strictEqual(t.ok, true);
    assert.strictEqual(t.result.compute_s, 412.5);
    assert.deepStrictEqual(t.result.log, ['[1/7] preprocess', '[7/7] glb written']);
    assert.ok(t.finished_at);
    assert.strictEqual((await report(id, { status: 'running' })).status, 409, 'a finished test stays finished');

    const list = (await call('/api/reuse/workers/gpu-box/tests', { token: ADMIN })).data.tests;
    assert.strictEqual(list[0].id, id);
    const history = (await call('/api/reuse/workers/gpu-box/settings', { token: ADMIN })).data.history.map(e => e.what);
    assert.deepStrictEqual(history.slice(0, 3), ['test_finished', 'test_started', 'test_requested']);
  });

  test('tests: the file a test made is checked, kept, and served to the admin only', async () => {
    const id = (await ask('gpu-box', { kind: 'image' })).data.test.id;
    await report(id, { status: 'running' });
    const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image')]);
    const hash = crypto.createHash('sha256').update(pngBytes).digest('hex');
    const up = (body, ext, sha, token = AMD) => call(`/api/reuse/worker/tests/${id}/output?ext=${ext}`, {
      method: 'POST', token, rawBody: body, headers: { 'X-Sha256': sha, 'Content-Type': 'application/octet-stream' }
    });
    assert.strictEqual((await up(pngBytes, 'exe', hash)).status, 400);
    assert.strictEqual((await up(pngBytes, 'png', 'bad')).status, 400);
    assert.strictEqual((await up(Buffer.from('not a png'), 'png', crypto.createHash('sha256').update('not a png').digest('hex'))).status, 422);
    assert.strictEqual((await up(pngBytes, 'png', hash, NV)).status, 404, 'not this worker\'s test');
    assert.strictEqual((await up(pngBytes, 'png', hash, ADMIN)).status, 403);
    assert.strictEqual((await up(pngBytes, 'png', hash)).status, 200);
    await report(id, { status: 'done', report: { ok: true, compute_s: 3 } });
    const t = await readTest(id);
    assert.deepStrictEqual({ ...t.output, url: undefined }, { ext: 'png', size: pngBytes.length, sha256: hash, url: undefined });
    const res = await fetch(BASE_URL + t.output.url, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(pngBytes));
    assert.strictEqual((await fetch(BASE_URL + t.output.url, { headers: { Authorization: `Bearer ${AMD}` } })).status, 403);
  });

  test('tests: a failure keeps its reason and the end of the engine log; a huge report is cut, not refused', async () => {
    const id = (await ask('gpu-box', { kind: 'comfyui', params: { width: 1024, height: 1024, steps: 8 } })).data.test.id;
    const log = Array.from({ length: 3000 }, (_, i) => `ligne ${i} ${'x'.repeat(50)}`);
    const r = await report(id, { status: 'failed', report: { ok: false, error: 'torch: HIP error: invalid device function', log } });
    assert.strictEqual(r.status, 200);
    const t = await readTest(id);
    assert.strictEqual(t.status, 'failed');
    assert.strictEqual(t.ok, false);
    assert.strictEqual(t.error, 'torch: HIP error: invalid device function');
    assert.strictEqual(t.result.truncated, true);
    assert.strictEqual(t.result.log.at(-1).startsWith('ligne 2999'), true, 'the end of the log, which says why');
  });

  test('tests: cancelled while running, the worker is told to stop', async () => {
    const id = (await ask('gpu-box', { kind: 'image' })).data.test.id;
    assert.strictEqual((await next(AMD, NEW_WORKER)).data.orders.gpu_test.id, id);
    await report(id, { status: 'running', stage: 'calcul', progress: 0.5 });
    assert.strictEqual((await call(`/api/reuse/workers/gpu-box/tests/${id}/cancel`, { method: 'POST', token: ADMIN })).status, 200);
    const r = await report(id, { status: 'running', progress: 0.6 });
    assert.strictEqual(r.data.cancel, true);
    assert.strictEqual((await readTest(id)).status, 'cancelled');
    assert.strictEqual((await call(`/api/reuse/workers/gpu-box/tests/${id}/cancel`, { method: 'POST', token: ADMIN })).status, 409);
  });

  test('tests: a worker that does not run that kind of test keeps getting jobs; the reason is readable while it waits', async () => {
    const id = (await ask('dev-box', { kind: '3d' })).data.test.id;
    await call('/api/reuse/workers/dev-box/order', { method: 'POST', token: ADMIN, body: { pause: false } });
    const done = (j) => call(`/api/reuse/jobs/${j.id}/result?compute_s=1`, { method: 'POST', token: NV, rawBody: fakeFlac(`${j.name}-clean`),
      headers: { 'X-Sha256': crypto.createHash('sha256').update(fakeFlac(`${j.name}-clean`)).digest('hex') } });
    const held = (await next(NV, { version: 'v1' })).data.job;   // the job dev-box took earlier: finished first
    if (held) assert.strictEqual((await done(held)).status, 200);
    await call('/api/reuse/jobs?batch=t&name=t_old.flac', { method: 'POST', token: ADMIN, rawBody: fakeFlac('old') });
    const got = await next(NV, { version: 'v1' });            // old version, no info.tests: never blocked
    assert.strictEqual(got.data.job?.name, 't_old.flac');
    assert.strictEqual(got.data.orders.gpu_test.id, id, 'still offered: an updated worker will take it');
    const t = await readTest(id, 'dev-box');
    assert.strictEqual(t.status, 'pending');
    assert.match(t.warning, /has not announced "3d" tests: it keeps getting jobs/);
    const listed = (await call('/api/reuse/workers/dev-box/tests', { token: ADMIN })).data.tests.find(x => x.id === id);
    assert.match(listed.warning, /has not announced/);
    // A version that announces other kinds only is not blocked either
    assert.strictEqual((await done(got.data.job)).status, 200);
    await call('/api/reuse/jobs?batch=t&name=t_old2.flac', { method: 'POST', token: ADMIN, rawBody: fakeFlac('old2') });
    assert.strictEqual((await next(NV, { version: 'v2', tests: 'image' })).data.job?.name, 't_old2.flac');
    assert.strictEqual((await call(`/api/reuse/workers/dev-box/tests/${id}/cancel`, { method: 'POST', token: ADMIN })).status, 200);
  });

  test('tests: paused while running, the worker is told to stop; the report it still sends is kept', async () => {
    const id = (await ask('gpu-box', { kind: 'comfyui' })).data.test.id;
    assert.strictEqual((await next(AMD, NEW_WORKER)).data.orders.gpu_test.id, id);
    assert.strictEqual((await report(id, { status: 'running', stage: 'pip' })).data.cancel, false);
    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: true } });
    const told = await report(id, { status: 'running', stage: 'téléchargement' });
    assert.strictEqual(told.data.cancel, true);
    assert.match(told.data.reason, /paused/);
    const last = await report(id, { status: 'failed', report: { ok: false, error: 'annulé : téléchargement interrompu', disk: { need_gb: 20.7 } } });
    assert.strictEqual(last.status, 200);
    const t = await readTest(id);
    assert.strictEqual(t.status, 'cancelled');
    assert.match(t.error, /stopped: paused by the admin/);
    assert.strictEqual(t.result.disk.need_gb, 20.7, 'what it got before stopping is kept');
    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: false } });
  });

  test('tests: never handed out while paused or out of the schedule; then the queue resumes', async () => {
    const id = (await ask('gpu-box', { kind: 'image' })).data.test.id;
    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: true } });
    assert.strictEqual((await next(AMD, NEW_WORKER)).data.orders.gpu_test, null);
    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: false } });

    const never = await call('/api/reuse/workers/gpu-box/schedule', { method: 'PUT', token: ADMIN, body: { timezone: 'Europe/Paris', days: {} } });
    assert.strictEqual(never.status, 200);
    assert.strictEqual((await next(AMD, NEW_WORKER)).data.orders.gpu_test, null, 'Alice uses his PC: nothing starts');
    await call('/api/reuse/workers/gpu-box/schedule', { method: 'DELETE', token: ADMIN });
    assert.strictEqual((await next(AMD, NEW_WORKER)).data.orders.gpu_test.id, id);

    await report(id, { status: 'done', report: { ok: true, compute_s: 30 } });
    // Test over: the machine gets jobs again
    await call('/api/reuse/jobs?batch=t&name=t_001.flac', { method: 'POST', token: ADMIN, rawBody: fakeFlac('b') });
    assert.strictEqual((await next(AMD, NEW_WORKER)).data.job.name, 't_001.flac');
  });
});

describe('worker-control: expiry (clock passed in)', () => {
  let wc;
  const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wctl-db-'));
  before(async () => {
    process.env.DB_PATH = path.join(DB_DIR, 'hub.db');
    wc = await import('../src/services/worker-control.js');
  });
  after(() => fs.rmSync(DB_DIR, { recursive: true, force: true }));

  test('a running test the worker stopped reporting on fails after 15 min; a pending one after 24 h', () => {
    const t0 = Date.parse('2026-11-13T18:00:00Z');
    const a = wc.createTest('pc-x', { kind: '3d' }, t0).test.id;
    wc.reportTest('pc-x', a, { status: 'running', stage: 'calcul' }, t0 + 1000);
    assert.strictEqual(wc.getTest('pc-x', a, t0 + wc.TEST_SILENT_MS).test.status, 'running');
    const lost = wc.getTest('pc-x', a, t0 + 1000 + wc.TEST_SILENT_MS + 1).test;
    assert.strictEqual(lost.status, 'failed');
    assert.match(lost.error, /stopped reporting/);

    const b = wc.createTest('pc-x', { kind: 'image' }, t0).test.id;
    assert.deepStrictEqual(wc.pendingTest('pc-x', t0 + 1000), { id: b, kind: 'image', params: {} });
    assert.strictEqual(wc.pendingTest('pc-x', t0 + wc.TEST_PENDING_MS + 1), null);
    assert.match(wc.getTest('pc-x', b, t0 + wc.TEST_PENDING_MS + 1).test.error, /not started within 24 h/);
    const events = wc.workerEvents('pc-x').map(e => e.what);
    assert.ok(events.includes('test_lost') && events.includes('test_expired'));
  });

  test('a cut report is always valid JSON, whatever is too big', () => {
    const huge = { ok: false, error: 'e'.repeat(5000), note: 'n'.repeat(40000), log: Array.from({ length: 100 }, () => 'l'.repeat(300)) };
    for (const max of [32768, 4000, 600, 200]) {
      const out = wc.clip(huge, max);
      assert.ok(out.length <= max, `${out.length} > ${max}`);
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.truncated, true);
      assert.strictEqual(parsed.ok, false);
    }
  });

  test('worker events: what is checked, detail cut to valid JSON, reserved fields dropped', () => {
    assert.strictEqual(wc.workerEvent('pc-z', { what: 'repair_' }).status, 400);
    assert.strictEqual(wc.workerEvent('pc-z', { what: 'repair_X' }).status, 400);
    assert.strictEqual(wc.workerEvent('pc-z', { what: 'test_finished' }).status, 400);
    assert.strictEqual(wc.workerEvent('pc-z', { what: 'verify_finished', detail: 'x' }).status, 400);
    assert.strictEqual(wc.workerEvent('pc-z', { what: 'verify_finished', detail: { ok: true, summary: 'y'.repeat(9000), at: 1 } }).ok, true);
    const [e] = wc.workerEvents('pc-z');
    assert.strictEqual(e.what, 'verify_finished');
    assert.strictEqual(e.ok, true);
    assert.match(e.at, /^\d{4}-/);
    assert.ok(e.summary.length <= 2000);
  });

  test('a setting of 0 is kept (not mistaken for absent); an unknown test id is a 404', () => {
    assert.strictEqual(wc.patchWorkerSettings('pc-y', { gpu_keep_loaded_s: 0 }).ok, true);
    assert.deepStrictEqual(wc.workerSettings('pc-y'), { gpu_keep_loaded_s: 0 });
    assert.strictEqual(wc.reportTest('pc-y', 'abc', { status: 'running' }).status, 404);
  });
});
