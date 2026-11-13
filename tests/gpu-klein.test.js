import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// FLUX 3 Klein through POST /api/gpu/jobs: reference images (validation, storage, worker download) and the machines
// that may take such a job (they announce the model: it needs ComfyUI installed, not only the image engine).
const PORT = '4199';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-klein-'));
const WORKER_DIR = path.join(TMP_DIR, 'worker-files');
const ADMIN = 'reuse-admin-secret-klein-0123456789';
const AMD = 'gpu-box-worker-secret-klein-0123456789';
const NV = 'dev-box-worker-secret-klein-0123456789';

let hubProcess;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function png(width, height, salt = '', pad = 0) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b[24] = 8; b[25] = 6;
  return Buffer.concat([b, Buffer.from(`pixels-${salt}`), Buffer.alloc(pad)]);
}
const jpg = (salt = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-body-${salt}-padding`)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);

async function call(p, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { 'Content-Type': rawBody ? 'application/octet-stream' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody || (body === undefined ? undefined : JSON.stringify(body))
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, data, buf, headers: res.headers };
}
const poll = (token, info) => call('/api/reuse/next', { method: 'POST', token, body: { wait: 0, info: { version: 't', ...info } } });
const submit = (body, token = ADMIN) => call('/api/gpu/jobs', { method: 'POST', token, body });
const klein = (extra = {}) => ({ type: 'image', model: 'flux3-klein', prompt: 'a red ceramic mug on an oak table, morning light', ...extra });

describe('FLUX 3 Klein: references and model announcement', () => {
  before(async () => {
    fs.mkdirSync(WORKER_DIR);
    fs.writeFileSync(path.join(WORKER_DIR, 'reuse_worker.py'), 'print("v1")\n');
    fs.copyFileSync(path.join(process.cwd(), 'reuse-worker', 'gpu-catalog.json'), path.join(WORKER_DIR, 'gpu-catalog.json'));
    hubProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: {
        ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db'),
        HUB_REUSE_ADMIN_TOKEN: ADMIN, HUB_REUSE_WORKER_TOKENS: `gpu-box:${AMD},dev-box:${NV}`, HUB_REUSE_WORKER_DIR: WORKER_DIR
      }
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

  test('refused (409) while no machine announces the model, even if one offers "image"', async () => {
    await poll(NV, { gpu: 'image' });   // image engine only (old version, or no ComfyUI)
    const r = await submit(klein());
    assert.strictEqual(r.status, 409);
    assert.match(r.data.error, /flux3-klein.*ComfyUI/);
    assert.strictEqual((await submit({ prompt: 'default model still fine' })).status, 201, 'z-image-turbo unchanged');
  });

  test('references: strict validation (count, format, size, not with image)', async () => {
    await poll(AMD, { gpu: 'image', gpu_models: 'flux3-klein' });
    const b64 = (buf) => buf.toString('base64');
    const one = png(64, 64, 'a');
    assert.strictEqual((await submit(klein({ references: b64(one) }))).status, 400, 'a list, not a string');
    assert.match((await submit(klein({ references: Array(5).fill(b64(one)) }))).data.error, /at most 4/);
    assert.match((await submit(klein({ references: [b64(webp())] }))).data.error, /references\[0\]: PNG or JPG only, not WEBP/);
    assert.match((await submit(klein({ references: ['%%%'] }))).data.error, /references\[0\]: image is not valid base64/);
    const big = await submit(klein({ references: [b64(png(64, 64, 'big', 4 * 1024 * 1024))] }));
    assert.strictEqual(big.status, 413);
    assert.match(big.data.error, /larger than 4 MB/);
    assert.match((await submit(klein({ image: b64(one), references: [b64(one)] }))).data.error, /takes "references"/);
    assert.match((await submit(klein({ image: b64(one) }))).data.error, /takes "references"/);
    assert.match((await submit({ prompt: 'z', references: [b64(one)] })).data.error, /takes no references/);
    const sized = await submit(klein({ size: '1000x770' }));
    assert.strictEqual(sized.status, 201);
    assert.deepStrictEqual([sized.data.job.params.width, sized.data.job.params.height], [1008, 768], 'multiples of 16');
    assert.strictEqual(sized.data.job.params.steps, 16);
  });

  test('accepted with 4 references; only the machine announcing the model gets it, with the references to fetch', async () => {
    const refs = [png(800, 600, 'r0'), jpg('r1'), png(64, 64, 'r2'), jpg('r3')];
    const r = await submit(klein({ references: refs.map(b => `data:image/png;base64,${b.toString('base64')}`), seed: 9, steps: 12 }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const id = r.data.job.id;
    assert.deepStrictEqual(r.data.job.references.map(x => x.format), ['png', 'jpg', 'png', 'jpg']);

    // dev-box offers "image" but not the model: never gets a Klein job (the plain image job of the first test, yes)
    const dev = await poll(NV, { gpu: 'image' });
    assert.notStrictEqual(dev.data.job?.model, 'flux3-klein');
    if (dev.data.job) await call(`/api/gpu/jobs/${dev.data.job.id}/cancel`, { method: 'POST', token: ADMIN });
    assert.strictEqual((await poll(NV, { gpu: 'image' })).data.job, null);

    let got;
    for (let i = 0; i < 3 && got?.id !== id; i++) {   // the 1008x768 job from the previous test comes first
      got = (await poll(AMD, { gpu: 'image', gpu_models: 'flux3-klein' })).data.job;
      if (got && got.id !== id) await call(`/api/gpu/jobs/${got.id}/cancel`, { method: 'POST', token: ADMIN });
    }
    assert.strictEqual(got.id, id);
    assert.strictEqual(got.model, 'flux3-klein');
    assert.deepStrictEqual(got.params, { width: 1024, height: 1024, steps: 12, seed: 9, unet_dtype: 'default', attention: 'quad', dynamic_vram: false, ref_megapixels: 1, vram_mode: 'high', text_encoder: 'gpu', comfyui_options: 'alloc_expandable,no_comfy_compiler' });
    assert.deepStrictEqual(got.references.map(x => [x.n, x.format, x.size, x.sha256]), refs.map((b, n) => [n, n % 2 ? 'jpg' : 'png', b.length, sha(b)]));
    for (const [n, b] of refs.entries()) {
      const dl = await call(`/api/gpu/jobs/${id}/references/${n}`, { token: AMD });
      assert.strictEqual(dl.status, 200);
      assert.ok(dl.buf.equals(b), `reference ${n} intact`);
      assert.strictEqual(dl.headers.get('x-sha256'), sha(b));
    }
    assert.strictEqual((await call(`/api/gpu/jobs/${id}/references/4`, { token: AMD })).status, 404);
    assert.strictEqual((await call(`/api/gpu/jobs/${id}/references/0`, { token: NV })).status, 409, 'not the worker holding it');
    assert.strictEqual((await call(`/api/gpu/jobs/${id}/references/0`, { token: ADMIN })).status, 200);

    // A worker that stops announcing the model gives the job back instead of computing it with the wrong engine
    const back = await poll(AMD, { gpu: 'image' });
    assert.strictEqual(back.data.job, null);
    const v = (await call(`/api/gpu/jobs/${id}`, { token: ADMIN })).data;
    assert.strictEqual(v.status, 'pending');
    assert.match(v.error, /no longer offers "image" \(flux3-klein\)/);

    // Result checked like any image, then files removed with the job
    const again = (await poll(AMD, { gpu: 'image', gpu_models: 'flux3-klein' })).data.job;
    assert.strictEqual(again.id, id);
    const out = png(1024, 1024, 'out');
    const done = await call(`/api/gpu/jobs/${id}/result?compute_s=140&backend=rocm`, { method: 'POST', token: AMD, rawBody: out, headers: { 'X-Sha256': sha(out) } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.data));
    assert.strictEqual((await call(`/api/gpu/jobs/${id}`, { method: 'DELETE', token: ADMIN })).status, 200);
    const left = fs.readdirSync(path.join(TMP_DIR, 'reuse', 'gpu')).filter(n => n.startsWith(`${id}.`));
    assert.deepStrictEqual(left, [], 'references deleted with the job');
  });

  test('a failure the worker marks final is not retried; an ordinary one is', async () => {
    const a = (await submit(klein({ seed: 1 }))).data.job.id;
    const got = (await poll(AMD, { gpu: 'image', gpu_models: 'flux3-klein' })).data.job;
    assert.strictEqual(got.id, a);
    const f = await call(`/api/gpu/jobs/${a}/fail`, { method: 'POST', token: AMD, body: { error: 'génération trop lent : 232.0 s par étape', final: true } });
    assert.strictEqual(f.data.retry, false);
    const v = (await call(`/api/gpu/jobs/${a}`, { token: ADMIN })).data;
    assert.strictEqual(v.status, 'failed');
    assert.match(v.error, /232\.0 s par étape/);
    const b = (await submit(klein({ seed: 2 }))).data.job.id;
    assert.strictEqual((await poll(AMD, { gpu: 'image', gpu_models: 'flux3-klein' })).data.job.id, b);
    assert.strictEqual((await call(`/api/gpu/jobs/${b}/fail`, { method: 'POST', token: AMD, body: { error: 'hub injoignable' } })).data.retry, true);
    assert.strictEqual((await call(`/api/gpu/jobs/${b}`, { token: ADMIN })).data.status, 'pending');
    await call(`/api/gpu/jobs/${b}/cancel`, { method: 'POST', token: ADMIN });
  });

  test('admin tuning of the ComfyUI flags; a member cannot change them', async () => {
    const r = await submit(klein({ unet_dtype: 'default', attention: 'split', dynamic_vram: true, ref_megapixels: 0.5 }));
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.data.job.params.unet_dtype, r.data.job.params.attention, r.data.job.params.dynamic_vram, r.data.job.params.ref_megapixels],
      ['default', 'split', true, 0.5]);
    const d = await submit(klein());
    assert.deepStrictEqual([d.data.job.params.unet_dtype, d.data.job.params.dynamic_vram], ['default', false], 'defaults');
    for (const id of [r.data.job.id, d.data.job.id]) await call(`/api/gpu/jobs/${id}/cancel`, { method: 'POST', token: ADMIN });
  });

  test('capabilities list the references limits and who offers the model', async () => {
    const caps = (await call('/api/gpu/capabilities', { token: ADMIN })).data;
    const m = caps.types.image.models.find(x => x.id === 'flux3-klein');
    assert.deepStrictEqual(m.references, { max: 4, max_bytes: 4194304, formats: ['png', 'jpg'] });
    assert.deepStrictEqual(m.offered_by, ['gpu-box']);
    assert.strictEqual(caps.types.image.default_model, 'z-image-turbo');
  });
});
