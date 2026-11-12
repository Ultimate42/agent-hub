import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The real launcher + worker against a real hub, generating images and 3D with fake engines. The engines and model
// files are installed exactly as on the PC: from the published catalog (same command lines), archives and files
// fetched by URL (file://) and checked by SHA-256, under <folder>/gpu only.
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const canRun = process.platform === 'linux' && ['python3', 'bash', 'ffmpeg', 'flock'].every(has);
const SRC = path.join(process.cwd(), 'reuse-worker');
const PORT = '4166';
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN = 'reuse-admin-secret-0123456789';
const TOKEN = 'gpu-box-worker-secret-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

const FAKE_SD = `#!/usr/bin/env python3
import json, os, struct, sys, time
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else None
with open(os.environ['FAKE_GPU_LOG'], 'a') as f:
    f.write(json.dumps({'engine': 'sd', 'args': a, 'pid': os.getpid(), 'env': os.environ.get('GGML_VK_DISABLE_INTEGER_DOT_PRODUCT')}) + '\\n')
for role in ('--diffusion-model', '--llm', '--vae'):
    assert open(opt(role)).read().startswith('fake'), role
print('ggml_vulkan: 0 = Fake Radeon RX (RADV) | uma: 0', flush=True)
for i in range(1, 5):
    print('  |=====>   | %d/4 - 0.10s/it' % i, end='\\r', flush=True)
    time.sleep(30 if 'slow' in opt('-p') else 0.1)
w, h = int(opt('-W')), int(opt('-H'))
with open(opt('-o'), 'wb') as f:
    f.write(b'\\x89PNG\\r\\n\\x1a\\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0]) + b'fake pixels')
`;
const FAKE_TRELLIS = `#!/usr/bin/env python3
import json, os, struct, sys
a = sys.argv[1:]
with open(os.environ['FAKE_GPU_LOG'], 'a') as f:
    f.write(json.dumps({'engine': 'trellis', 'args': a, 'env': os.environ.get('GGML_VK_DISABLE_INTEGER_DOT_PRODUCT'),
                        'models': sorted(os.listdir(a[a.index('--models') + 1]))}) + '\\n')
body = b'{"asset":{"version":"2.0"}}  ' + open(a[0], 'rb').read()[:16]
with open(a[1], 'wb') as f:
    f.write(b'glTF' + struct.pack('<II', 2, 12 + len(body)) + body)
`;

function png(width, height, salt = '') {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b[24] = 8; b[25] = 6;
  return Buffer.concat([b, Buffer.from(`pixels-${salt}`)]);
}

describe('worker: image and 3D generation end to end', { skip: !canRun }, () => {
  let tmp, hub, launcher, pc, publish, fakeLog;
  const admin = async (p, opts = {}) => {
    const res = await fetch(BASE_URL + p, { ...opts, headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    return opts.raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
  const runs = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  async function until(what, fn, seconds = 60) {
    for (let i = 0; i < seconds * 4; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(250);
    }
    const log = path.join(pc, 'logs', 'worker.log');
    assert.fail(`timeout: ${what}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(-15).join('\n') : '(no log)'}`);
  }
  const finished = (id) => until(`job ${id} finished`, async () => {
    const j = await admin(`/api/gpu/jobs/${id}?wait=5`);
    return ['done', 'failed', 'cancelled'].includes(j.status) && j;
  });

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-worker-'));
    publish = path.join(tmp, 'publish');
    pc = path.join(tmp, 'pc');
    const store = path.join(tmp, 'store');
    fakeLog = path.join(tmp, 'fake-gpu.jsonl');
    for (const d of [publish, pc, store]) fs.mkdirSync(d);
    for (const f of ['reuse_worker.py', 'install-and-run.sh']) fs.copyFileSync(path.join(SRC, f), path.join(publish, f));
    fs.copyFileSync(path.join(SRC, 'install-and-run.sh'), path.join(pc, 'install-and-run.sh'));

    // Catalog = the real one (parameters, command lines), with Linux fake engines and small model files
    const catalog = JSON.parse(fs.readFileSync(path.join(SRC, 'gpu-catalog.json'), 'utf8'));
    const asset = (name, exe, script) => {
      const dir = path.join(tmp, `${name}-build`, 'bin');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, exe), script);
      fs.writeFileSync(path.join(dir, 'libggml-vulkan.so'), 'fake library');
      const zip = path.join(store, `${name}.zip`);
      const zipped = spawnSync('python3', ['-I', '-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, path.dirname(dir)]);
      assert.strictEqual(zipped.status, 0, String(zipped.stderr));
      const data = fs.readFileSync(zip);
      return { url: `file://${zip}`, sha256: sha(data), size: data.length, exe };
    };
    catalog.engines.sdcpp.linux = asset('sd', 'sd-cli', FAKE_SD);
    catalog.engines.trellis.linux = asset('trellis', 'trellis-cli', FAKE_TRELLIS);
    for (const type of Object.values(catalog.types)) {
      for (const model of Object.values(type.models)) {
        for (const f of model.files) {
          const data = Buffer.from(`fake ${f.name} ${'x'.repeat(200)}`);
          fs.writeFileSync(path.join(store, f.name), data);
          Object.assign(f, { url: `file://${path.join(store, f.name)}`, sha256: sha(data), size: data.length });
        }
      }
    }
    fs.writeFileSync(path.join(publish, 'gpu-catalog.json'), JSON.stringify(catalog, null, 1));

    const engine = path.join(tmp, 'fake-engine.sh');
    fs.writeFileSync(engine, `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --audio) IN=$2; shift;; --out) OUT=$2; shift;; esac; shift; done
exec ffmpeg -v error -nostdin -y -i "$IN" -af volume=0.5 -c:a pcm_s16le "$OUT"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'model.gguf'), 'fake');
    fs.writeFileSync(path.join(pc, 'reuse-worker.config.json'), JSON.stringify({
      hub_url: BASE_URL, allow_http: true, token: TOKEN, backend: 'cpu', audiocpp_cli: engine, model: path.join(tmp, 'model.gguf'),
      enable_3d: true, gpu_max_gb: 1
    }));

    hub = spawn('node', ['src/index.js'], {
      cwd: process.cwd(), stdio: 'ignore',
      env: {
        ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(tmp, 'hub.db'), HUB_REUSE_ADMIN_TOKEN: ADMIN,
        HUB_REUSE_WORKER_TOKENS: `gpu-box:${TOKEN}`, HUB_REUSE_WORKER_DIR: publish
      }
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }
    launcher = spawn('bash', [path.join(pc, 'install-and-run.sh'), '--no-startup'], {
      cwd: pc, stdio: 'ignore', detached: true,
      env: { ...process.env, REUSE_RESTART: '1', REUSE_RETRY: '1', REUSE_RETRY_LONG: '1', FAKE_GPU_LOG: fakeLog }
    });
  });

  after(async () => {
    try { if (launcher?.pid) process.kill(-launcher.pid, 'SIGTERM'); } catch { /* already gone */ }
    hub?.kill('SIGTERM');
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('announces image and 3d (3d only because enable_3d is set), nothing installed yet', async () => {
    const w = await until('worker online with its GPU types', async () => {
      const x = (await admin('/api/reuse/workers')).workers.find(v => v.name === 'gpu-box');
      return x?.online && x.info.gpu && x;
    });
    assert.strictEqual(w.info.gpu, '3d,image');
    assert.match(w.info.gpu_state, /image : pas encore installé/);
    assert.ok(!fs.existsSync(path.join(pc, 'gpu', 'models')), 'lazy: no model before the first job');
  });

  test('image: installs on first need, prompt passed as one argument, PNG checked by the hub', async () => {
    const prompt = 'a "quoted" teapot; & | $(echo nope) `x` %PATH%';
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt, width: 640, height: 384, seed: 7 }) });
    const done = await finished(job.id);
    assert.strictEqual(done.status, 'done', JSON.stringify(done));
    assert.strictEqual(done.result.device, 'Fake Radeon RX');
    const out = await admin(`/api/gpu/jobs/${job.id}/result`, { raw: true });
    assert.strictEqual(out.readUInt32BE(16), 640);
    assert.strictEqual(out.readUInt32BE(20), 384);
    const run = runs().find(r => r.engine === 'sd');
    assert.strictEqual(run.args[run.args.indexOf('-p') + 1], prompt);
    assert.strictEqual(run.args[run.args.indexOf('-s') + 1], '7');
    assert.strictEqual(run.args[run.args.indexOf('--cfg-scale') + 1], '1');
    assert.ok(!run.args.includes('-i'), 'no input image: no image-to-image arguments');
    // Everything lives under <folder>/gpu; the job folder is gone
    const engines = fs.readdirSync(path.join(pc, 'gpu', 'engines'));
    assert.strictEqual(engines.length, 1, 'only the engine that was needed');
    assert.match(engines[0], /^sdcpp-[0-9a-f]{12}$/);
    assert.deepStrictEqual(fs.readdirSync(path.join(pc, 'gpu', 'models')), ['z-image-turbo']);
    assert.ok(!fs.existsSync(path.join(pc, 'gpu', 'downloads')) || fs.readdirSync(path.join(pc, 'gpu', 'downloads')).length === 0);
    assert.deepStrictEqual(fs.readdirSync(path.join(pc, 'work')), []);
  });

  test('image to image: the input image reaches the engine with the strength', async () => {
    const start = png(512, 512, 'start');
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'same, at night', image: start.toString('base64'), width: 512, height: 512, strength: 0.4 }) });
    const done = await finished(job.id);
    assert.strictEqual(done.status, 'done', JSON.stringify(done));
    const run = runs().filter(r => r.engine === 'sd').pop();
    assert.strictEqual(run.args[run.args.indexOf('--strength') + 1], '0.4');
    assert.match(run.args[run.args.indexOf('-i') + 1], /in\.png$/);
  });

  test('3d: trellis installed on first need, with the RDNA2 workaround, GLB checked by the hub', async () => {
    const photo = png(300, 200, 'object');
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ type: '3d', image: photo.toString('base64'), texture: false }) });
    const done = await finished(job.id);
    assert.strictEqual(done.status, 'done', JSON.stringify(done));
    const out = await admin(`/api/gpu/jobs/${job.id}/result`, { raw: true });
    assert.strictEqual(out.toString('latin1', 0, 4), 'glTF');
    const run = runs().find(r => r.engine === 'trellis');
    assert.strictEqual(run.env, '1');
    assert.ok(run.args.includes('--no-texture'));
    assert.ok(run.args.includes('--require-gpu'));
    assert.strictEqual(run.args[run.args.indexOf('--res') + 1], '512');
    assert.ok(run.models.includes('ss_flow.gguf') && run.models.includes('dinov3.gguf'));
    assert.ok(!run.models.some(n => n.endsWith('.part')));
  });

  test('cancelled while computing: the engine is stopped, the worker takes the next job', async () => {
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'slow one', width: 256, height: 256 }) });
    await until('computing', async () => (await admin(`/api/gpu/jobs/${job.id}`)).progress > 0.3);
    const pid = runs().filter(r => r.engine === 'sd').pop().pid;
    await admin(`/api/gpu/jobs/${job.id}/cancel`, { method: 'POST' });
    await until('engine stopped', () => !fs.existsSync(`/proc/${pid}`) || fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z', 90);
    const { job: next } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'after the cancel', width: 256, height: 256 }) });
    assert.strictEqual((await finished(next.id)).status, 'done');
    assert.match(fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8'), /abandonné : le hub l'a repris ou annulé/);
  });

  test('RE-USE still works on the same worker', async () => {
    assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.5',
      '-ac', '1', '-ar', '24000', '-c:a', 'flac', path.join(tmp, 'in.flac')]).status, 0);
    const { job } = await admin('/api/reuse/jobs?batch=e2e&name=e2e_000.flac', { method: 'POST', body: fs.readFileSync(path.join(tmp, 'in.flac')), headers: { 'Content-Type': 'audio/flac' } });
    await until('RE-USE job done', async () => (await admin(`/api/reuse/jobs/${job.id}`)).status === 'done');
  });
});
