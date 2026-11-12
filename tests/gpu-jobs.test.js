import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// GPU jobs (image, 3D) through the hub: member tokens, catalog validation, sharing the RE-USE workers and schedule.
const PORT = '4161';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gpu-'));
const WORKER_DIR = path.join(TMP_DIR, 'worker-files');
const ADMIN = 'reuse-admin-secret-0123456789';
const AMD = 'gpu-box-worker-secret-0123456789';
const NV = 'dev-box-worker-secret-0123456789';
const LEASE_S = 2;

let hubProcess;
let agent, other, outsider; // member tokens: room 1 (allowed), room 1 other member (allowed), room 2 (not allowed)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function png(width, height, salt = '') {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b[24] = 8; b[25] = 6;
  return Buffer.concat([b, Buffer.from(`pixels-${salt}`)]);
}
function glb(extra = 'mesh') {
  const body = Buffer.from(extra);
  const b = Buffer.alloc(12);
  b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([b, body]);
}
function fakeFlac(salt) {
  const b = Buffer.alloc(42);
  b.write('fLaC', 0, 'latin1'); b[4] = 0x80; b[7] = 34;
  b.writeUInt32BE(((24000 << 12) | (23 << 4)) >>> 0, 18); b.writeUInt32BE(240000, 22);
  return Buffer.concat([b, Buffer.from(`audio-${salt}`)]);
}

async function call(p, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: {
      ...(rawBody ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers
    },
    body: rawBody || (body === undefined ? undefined : JSON.stringify(body))
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, data, buf, headers: res.headers };
}

const poll = (token, gpu) => call('/api/reuse/next', { method: 'POST', token, body: { wait: 0, info: { version: 't', ...(gpu !== undefined ? { gpu } : {}) } } });
const submit = (token, body) => call('/api/gpu/jobs', { method: 'POST', token, body });
const view = async (id, token = ADMIN) => (await call(`/api/gpu/jobs/${id}`, { token })).data;
const send = (id, token, buf, extra = '') => call(`/api/gpu/jobs/${id}/result?compute_s=12.5&backend=vulkan${extra}`, {
  method: 'POST', token, rawBody: buf, headers: { 'X-Sha256': sha(buf) }
});

describe('GPU jobs (image, 3D) on the RE-USE workers', () => {
  before(async () => {
    fs.mkdirSync(WORKER_DIR);
    fs.writeFileSync(path.join(WORKER_DIR, 'reuse_worker.py'), 'print("v1")\n');
    fs.copyFileSync(path.join(process.cwd(), 'reuse-worker', 'gpu-catalog.json'), path.join(WORKER_DIR, 'gpu-catalog.json'));
    hubProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db'),
        HUB_REUSE_ADMIN_TOKEN: ADMIN, HUB_REUSE_WORKER_TOKENS: `gpu-box:${AMD},dev-box:${NV}`,
        HUB_REUSE_WORKER_DIR: WORKER_DIR, HUB_REUSE_LEASE_SECONDS: String(LEASE_S), HUB_GPU_LEASE_SECONDS: String(LEASE_S),
        HUB_GPU_MEMBERS: '@1,Bad entry', HUB_RATE_LIMIT_PER_MINUTE: '1000', HUB_GPU_MAX_WAITING: '6'
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }
    const room1 = (await call('/api/rooms', { method: 'POST', body: { name: 'Agents' } })).data;
    const room2 = (await call('/api/rooms', { method: 'POST', body: { name: 'Elsewhere' } })).data;
    const join = async (room, name) => (await call(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: { name, role: 'agent' } })).data.member_token;
    agent = await join(room1, 'Agent-PC');
    other = await join(room1, 'Agent-2');
    outsider = await join(room2, 'Stranger');
  });

  after(() => {
    hubProcess?.kill('SIGTERM');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('authentication: member token of an allowed room, admin; others refused', async () => {
    assert.strictEqual((await call('/api/gpu/capabilities')).status, 401);
    assert.strictEqual((await call('/api/gpu/capabilities', { token: 'not-a-token-at-all-000000' })).status, 403);
    const refused = await call('/api/gpu/capabilities', { token: outsider });
    assert.strictEqual(refused.status, 403);
    assert.match(refused.data.error, /HUB_GPU_MEMBERS/);
    assert.strictEqual((await call('/api/gpu/capabilities', { token: agent })).status, 200);
    assert.strictEqual((await call('/api/gpu/capabilities', { token: ADMIN })).status, 200);
    // A worker token answers jobs, it does not submit them
    assert.strictEqual((await submit(AMD, { prompt: 'x' })).status, 403);
  });

  test('a type no worker has announced is refused with a pointer to the capabilities', async () => {
    const r = await submit(agent, { prompt: 'a cat' });
    assert.strictEqual(r.status, 409);
    assert.match(r.data.error, /capabilities/);
  });

  test('validation: defaults, aliases, clamping, ignored keys, clear errors', async () => {
    await poll(AMD, 'image');
    const ok = await submit(agent, { prompt: 'a red teapot', size: '1000x700', cfg: 1.5, foo: 1 });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
    const j = ok.data.job;
    assert.strictEqual(j.type, 'image');
    assert.strictEqual(j.model, 'z-image-turbo');
    assert.strictEqual(j.status, 'pending');
    assert.strictEqual(j.owner, 'Agent-PC@1');
    assert.deepStrictEqual([j.params.width, j.params.height, j.params.steps, j.params.cfg_scale, j.params.sampler], [1024, 704, 8, 1.5, 'euler']);
    assert.ok(Number.isInteger(j.params.seed), 'a seed is always chosen, so the image can be made again');
    assert.strictEqual(j.params.strength, undefined, 'image-to-image strength only with an input image');
    assert.deepStrictEqual(ok.data.adjusted, ['width 1000 -> 1024', 'height 700 -> 704']);
    assert.deepStrictEqual(ok.data.ignored, ['foo']);
    assert.strictEqual(j.queue_position, 1);
    await call(`/api/gpu/jobs/${j.id}/cancel`, { method: 'POST', token: agent });

    for (const [body, re] of [
      [{}, /prompt is required/],
      [{ prompt: 'x', model: 'sdxl' }, /Unknown model "sdxl".*z-image-turbo/],
      [{ prompt: 'x', sampler: 'magic' }, /sampler must be one of/],
      [{ prompt: 'x', steps: 'many' }, /steps must be a number/],
      [{ type: 'video', prompt: 'x' }, /Unknown type "video"/],
      [{ prompt: 'x', image: 'not base64 !' }, /base64/],
      [{ prompt: 'x', image: Buffer.from('GIF89a-not-accepted').toString('base64') }, /PNG, JPEG or WebP/],
      [{ type: '3d' }, /image .* is required for 3d/],
      [{ prompt: 'x'.repeat(4001) }, /longer than 4000/]
    ]) {
      const r = await submit(agent, body);
      assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.status}`);
      assert.match(r.data.error, re);
    }
    // 3D is in the catalog but experimental: no worker offers it yet
    const r3 = await submit(agent, { type: '3d', image: png(64, 64).toString('base64') });
    assert.strictEqual(r3.status, 409);
    assert.match(r3.data.error, /experimental/);
  });

  test('scheduling: GPU job only to a worker announcing the type, before RE-USE, never interrupting a RE-USE job', async () => {
    // RE-USE piece queued first
    const reuse = await call('/api/reuse/jobs?batch=b&name=a.flac', { method: 'POST', token: ADMIN, rawBody: fakeFlac('a') });
    assert.strictEqual(reuse.status, 201);
    const img = (await submit(agent, { prompt: 'a lighthouse', width: 512, height: 512 })).data.job;

    // dev-box announces nothing (older worker): it gets the RE-USE piece, never the image
    const dev = await poll(NV);
    assert.strictEqual(dev.data.job.kind, 'reuse');
    assert.strictEqual(dev.data.job.id, reuse.data.job.id);

    const amd = await poll(AMD, 'image');
    assert.strictEqual(amd.data.job.kind, 'image');
    assert.strictEqual(amd.data.job.id, img.id);
    assert.strictEqual(amd.data.job.prompt, 'a lighthouse');
    assert.strictEqual(amd.data.job.params.width, 512);
    // Restarted mid-job: the same job again, nothing else
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);

    const hb = await call(`/api/gpu/jobs/${img.id}/heartbeat`, { method: 'POST', token: AMD, body: { progress: 0.5, stage: 'calcul' } });
    assert.strictEqual(hb.status, 200);
    const v = await view(img.id, agent);
    assert.strictEqual(v.status, 'claimed');
    assert.strictEqual(v.progress, 0.5);
    assert.strictEqual(v.stage, 'calcul');
    assert.strictEqual(v.worker, 'gpu-box');

    // Another worker cannot act on it
    assert.strictEqual((await send(img.id, NV, png(512, 512))).status, 409);
    // Not what was asked: refused, attempt counted, back in the queue
    const wrong = await send(img.id, AMD, png(256, 256));
    assert.strictEqual(wrong.status, 422);
    assert.match(wrong.data.error, /256x256, 512x512 was asked/);
    assert.strictEqual(wrong.data.retry, true);
    assert.strictEqual((await send(img.id, AMD, Buffer.from('not an image at all'))).status, 409, 'job no longer held');

    const again = await poll(AMD, 'image');
    assert.strictEqual(again.data.job.id, img.id);
    assert.strictEqual(again.data.job.attempt, 2);
    const image = png(512, 512, 'final');
    const bad = await call(`/api/gpu/jobs/${img.id}/result`, { method: 'POST', token: AMD, rawBody: image, headers: { 'X-Sha256': sha(Buffer.from('x')) } });
    assert.strictEqual(bad.status, 400, 'transfer damage: no attempt burnt');
    const done = await send(img.id, AMD, image, `&meta=${encodeURIComponent(JSON.stringify({ device: 'AMD Radeon RX 6950 XT', '../x': 1 }))}`);
    assert.strictEqual(done.status, 200, JSON.stringify(done.data));
    assert.strictEqual(done.data.job.status, 'done');
    assert.deepStrictEqual(done.data.job.result, { url: `/api/gpu/jobs/${img.id}/result`, format: 'png', size: image.length, sha256: sha(image), device: 'AMD Radeon RX 6950 XT' });

    const file = await call(`/api/gpu/jobs/${img.id}/result`, { token: agent });
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.headers.get('content-type'), 'image/png');
    assert.strictEqual(file.headers.get('x-sha256'), sha(image));
    assert.ok(file.buf.equals(image));

    // dev-box's RE-USE job was never touched; once dev-box drops it, gpu-box takes it
    assert.strictEqual((await call(`/api/reuse/jobs/${reuse.data.job.id}`, { token: ADMIN })).data.worker, 'dev-box');
  });

  test('a worker computing a RE-USE job is not given a GPU job until it is finished', async () => {
    await call('/api/reuse/jobs/1/cancel', { method: 'POST', token: ADMIN });
    const piece = await call('/api/reuse/jobs?batch=b&name=b.flac', { method: 'POST', token: ADMIN, rawBody: fakeFlac('b') });
    const held = await poll(AMD, 'image');
    assert.strictEqual(held.data.job.kind, 'reuse');
    assert.strictEqual(held.data.job.id, piece.data.job.id);
    const img = (await submit(agent, { prompt: 'waits for the cleaning' })).data.job;
    const meanwhile = await poll(AMD, 'image');
    assert.strictEqual(meanwhile.data.job.kind, 'reuse', 'the RE-USE job it holds comes back, not the image');
    const caps = (await call('/api/gpu/capabilities', { token: agent })).data;
    const amd = caps.workers.find(w => w.name === 'gpu-box');
    assert.strictEqual(amd.busy, 'reuse');
    assert.strictEqual(amd.ready_now, false);
    assert.strictEqual(caps.types.image.waiting_jobs, 1);

    await call(`/api/reuse/jobs/${piece.data.job.id}/cancel`, { method: 'POST', token: ADMIN });
    const next = await poll(AMD, 'image');
    assert.strictEqual(next.data.job.kind, 'image');
    assert.strictEqual(next.data.job.id, img.id);
    // Cancelled by its owner while computed: the worker's next heartbeat says stop
    assert.strictEqual((await call(`/api/gpu/jobs/${img.id}/cancel`, { method: 'POST', token: agent })).status, 200);
    assert.strictEqual((await call(`/api/gpu/jobs/${img.id}/heartbeat`, { method: 'POST', token: AMD, body: {} })).status, 409);
    assert.strictEqual((await view(img.id)).status, 'cancelled');
  });

  test('pause and schedule: no new GPU job, the one held is resumed', async () => {
    const img = (await submit(agent, { prompt: 'night only' })).data.job;
    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: true } });
    assert.strictEqual((await poll(AMD, 'image')).data.job, null);
    await call('/api/reuse/workers/gpu-box/order', { method: 'POST', token: ADMIN, body: { pause: false } });

    // A window that is never open now: the day after today, in UTC
    const tomorrow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][(new Date().getUTCDay() + 2) % 7];
    const put = await call('/api/reuse/workers/gpu-box/schedule', { method: 'PUT', token: ADMIN, body: { timezone: 'UTC', days: { [tomorrow]: ['10:00-11:00'] } } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.data));
    assert.strictEqual((await poll(AMD, 'image')).data.job, null, 'outside its window');
    const caps = (await call('/api/gpu/capabilities', { token: agent })).data;
    assert.strictEqual(caps.types.image.ready_now, false);
    assert.ok(caps.types.image.next_start_at, 'says when the next window opens');
    assert.strictEqual(caps.workers.find(w => w.name === 'gpu-box').in_window, false);

    await call('/api/reuse/workers/gpu-box/schedule', { method: 'DELETE', token: ADMIN });
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);
    await call('/api/reuse/workers/gpu-box/schedule', { method: 'PUT', token: ADMIN, body: { timezone: 'UTC', days: { [tomorrow]: ['10:00-11:00'] } } });
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id, 'a held job is resumed outside the window');
    await call('/api/reuse/workers/gpu-box/schedule', { method: 'DELETE', token: ADMIN });
    await call(`/api/gpu/jobs/${img.id}/cancel`, { method: 'POST', token: agent });
  });

  test('a lease that runs out puts the job back; two lost attempts = failed', async () => {
    const img = (await submit(agent, { prompt: 'lost twice' })).data.job;
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);
    await sleep(LEASE_S * 1000 + 300);
    assert.strictEqual((await view(img.id)).status, 'pending');
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);
    await sleep(LEASE_S * 1000 + 300);
    assert.strictEqual((await poll(AMD, 'image')).data.job, null);
    const v = await view(img.id);
    assert.strictEqual(v.status, 'failed');
    assert.match(v.error, /lease expired/);
  });

  test('a held GPU job is never handed to a worker that no longer announces its type (rolled back): it goes back to the queue', async () => {
    const img = (await submit(agent, { prompt: 'rollback' })).data.job;
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);
    const old = (await poll(AMD)).data.job; // older worker: no info.gpu, would read any job as a RE-USE one
    assert.ok(!old || old.kind === 'reuse', `got ${JSON.stringify(old)}`);
    const v = await view(img.id);
    assert.strictEqual(v.status, 'pending');
    assert.match(v.error, /no longer offers "image"/);
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id, 'taken again by a worker that offers it');
    await call(`/api/gpu/jobs/${img.id}/cancel`, { method: 'POST', token: agent });
  });

  test('a model or type named after an Object.prototype key is unknown; 3D takes PNG or JPEG only', async () => {
    for (const body of [{ prompt: 'x', model: 'constructor' }, { prompt: 'x', type: 'constructor' }]) {
      const r = await submit(agent, body);
      assert.strictEqual(r.status, 400, JSON.stringify(r.data));
    }
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
    const r = await submit(agent, { type: '3d', image: webp.toString('base64') });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /PNG or JPG/);
  });

  test('owners only see their own jobs; admin sees all; wait returns as soon as the job ends', async () => {
    const mine = (await submit(agent, { prompt: 'mine' })).data.job;
    assert.strictEqual((await call(`/api/gpu/jobs/${mine.id}`, { token: other })).status, 404);
    assert.strictEqual((await call(`/api/gpu/jobs/${mine.id}/result`, { token: other })).status, 404);
    assert.strictEqual((await call(`/api/gpu/jobs/${mine.id}/cancel`, { method: 'POST', token: other })).status, 404);
    assert.ok((await call('/api/gpu/jobs', { token: agent })).data.jobs.every(j => j.owner === 'Agent-PC@1'));
    assert.strictEqual((await call('/api/gpu/jobs', { token: other })).data.jobs.length, 0);
    assert.ok((await call('/api/gpu/jobs', { token: ADMIN })).data.jobs.some(j => j.id === mine.id));
    assert.strictEqual((await call(`/api/gpu/jobs/${mine.id}/result`, { token: agent })).status, 409);

    const t0 = Date.now();
    const waiting = call(`/api/gpu/jobs/${mine.id}?wait=20`, { token: agent });
    await sleep(500);
    const claimed = await poll(AMD, 'image');
    await send(claimed.data.job.id, AMD, png(1024, 1024));
    const r = await waiting;
    assert.strictEqual(r.data.status, 'done');
    assert.ok(Date.now() - t0 < 8000);

    assert.strictEqual((await call(`/api/gpu/jobs/${mine.id}`, { method: 'DELETE', token: agent })).status, 200);
    assert.strictEqual((await call(`/api/gpu/jobs/${mine.id}`, { token: agent })).status, 404);
  });

  test('what the engine says (device, memory plan, timings, useful lines) is kept with the job, per attempt', async () => {
    const img = (await submit(agent, { prompt: 'diagnostics', width: 512, height: 512 })).data.job;
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);
    const lines = ['   12s auto-fit: --backend "gpu"', ...Array.from({ length: 150 }, (_, i) => `line ${i} ${'x'.repeat(400)}`)];
    const hb = await call(`/api/gpu/jobs/${img.id}/heartbeat`, {
      method: 'POST', token: AMD,
      body: { progress: 0.5, stage: 'étape 3/8 (4.2 s par étape)', log: lines, meta: { device: 'AMD Radeon RX 6950 XT', s_per_step: 4.2, 'Bad-Key': 1, nested: { a: 1 } } }
    });
    assert.strictEqual(hb.status, 200);
    const v = await view(img.id, agent);
    assert.strictEqual(v.stage, 'étape 3/8 (4.2 s par étape)');
    assert.strictEqual(v.engine.device, 'AMD Radeon RX 6950 XT');
    assert.strictEqual(v.engine.s_per_step, 4.2);
    assert.strictEqual(v.engine['Bad-Key'], undefined);
    assert.strictEqual(v.engine.nested, undefined);
    assert.strictEqual(v.engine.log.length, 100, 'bounded');
    assert.ok(v.engine.log.every(l => l.length <= 300));
    // A heartbeat without log keeps what was said; a new attempt starts clean
    await call(`/api/gpu/jobs/${img.id}/heartbeat`, { method: 'POST', token: AMD, body: { progress: 0.6 } });
    assert.strictEqual((await view(img.id)).engine.device, 'AMD Radeon RX 6950 XT');
    await call(`/api/gpu/jobs/${img.id}/fail`, { method: 'POST', token: AMD, body: { error: 'test' } });
    assert.strictEqual((await poll(AMD, 'image')).data.job.id, img.id);
    assert.strictEqual((await view(img.id)).engine, undefined);
    const image = png(512, 512);
    const done = await call(`/api/gpu/jobs/${img.id}/result?compute_s=790&backend=cpu&meta=${encodeURIComponent(JSON.stringify({ backend: 'cpu', load_s: 412.2 }))}`, {
      method: 'POST', token: AMD, rawBody: image, headers: { 'X-Sha256': sha(image) }
    });
    assert.strictEqual(done.data.job.backend, 'cpu');
    assert.strictEqual(done.data.job.result.load_s, 412.2);
  });

  test('a caller cannot flood the queue', async () => {
    const ids = [];
    let last;
    for (let i = 0; i < 7; i++) {
      last = await submit(other, { prompt: `n${i}` });
      if (last.status === 201) ids.push(last.data.job.id);
    }
    assert.strictEqual(ids.length, 6);
    assert.strictEqual(last.status, 429);
    for (const id of ids) await call(`/api/gpu/jobs/${id}/cancel`, { method: 'POST', token: other });
  });

  test('3D (when a machine enables it): input image to the worker holding the job, GLB checked', async () => {
    await poll(NV, 'image,3d');
    const photo = png(640, 480, 'photo');
    const sub = await submit(agent, { image: `data:image/png;base64,${photo.toString('base64')}`, res: 1024, texture: false });
    assert.strictEqual(sub.status, 201, JSON.stringify(sub.data));
    const j = sub.data.job;
    assert.strictEqual(j.type, '3d', 'an image without a prompt means 3D');
    assert.deepStrictEqual([j.params.res, j.params.texture, j.params.steps], ['1024', false, 12]);
    assert.deepStrictEqual(j.input, { sha256: sha(photo), size: photo.length, format: 'png' });

    assert.strictEqual((await poll(AMD, 'image')).data.job, null, 'gpu-box does not offer 3d');
    const claim = (await poll(NV, 'image,3d')).data.job;
    assert.strictEqual(claim.kind, '3d');
    assert.deepStrictEqual(claim.input, { sha256: sha(photo), size: photo.length, format: 'png' });
    assert.strictEqual((await call(`/api/gpu/jobs/${j.id}/input`, { token: AMD })).status, 409, 'not the holder');
    const input = await call(`/api/gpu/jobs/${j.id}/input`, { token: NV });
    assert.strictEqual(input.status, 200);
    assert.ok(input.buf.equals(photo));

    const notGlb = await send(j.id, NV, png(10, 10));
    assert.strictEqual(notGlb.status, 422);
    assert.match(notGlb.data.error, /GLB/);
    assert.strictEqual((await poll(NV, 'image,3d')).data.job.id, j.id);
    const model = glb('a mesh with some vertices');
    const ok = await send(j.id, NV, model);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
    const file = await call(`/api/gpu/jobs/${j.id}/result`, { token: agent });
    assert.strictEqual(file.headers.get('content-type'), 'model/gltf-binary');
    assert.ok(file.buf.equals(model));
  });

  test('capabilities: types, models with their parameters, who offers what', async () => {
    const caps = (await call('/api/gpu/capabilities', { token: agent })).data;
    assert.strictEqual(caps.types.image.default_model, 'z-image-turbo');
    assert.strictEqual(caps.types.image.models[0].license, 'Apache-2.0');
    assert.strictEqual(caps.types.image.models[0].params.steps.default, 8);
    assert.deepStrictEqual(caps.types.image.offered_by.sort(), ['gpu-box', 'dev-box']);
    assert.deepStrictEqual(caps.types['3d'].offered_by, ['dev-box']);
    assert.strictEqual(caps.types['3d'].experimental, true);
    assert.strictEqual(caps.types.image.ready_now, true);
    const amd = caps.workers.find(w => w.name === 'gpu-box');
    assert.deepStrictEqual(amd.types, ['image']);
    assert.strictEqual(amd.online, true);
    assert.ok(caps.limits.max_input_bytes > 0);
    assert.ok(!JSON.stringify(caps).includes('url"'), 'download URLs of the catalog are not needed by clients');
  });

  test('without a published catalog the GPU API is off; RE-USE is untouched', async () => {
    fs.renameSync(path.join(WORKER_DIR, 'gpu-catalog.json'), path.join(WORKER_DIR, 'gpu-catalog.off'));
    try {
      assert.strictEqual((await call('/api/gpu/capabilities', { token: agent })).status, 404);
      assert.strictEqual((await call('/api/reuse/workers', { token: ADMIN })).status, 200);
    } finally {
      fs.renameSync(path.join(WORKER_DIR, 'gpu-catalog.off'), path.join(WORKER_DIR, 'gpu-catalog.json'));
    }
  });
});
