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
const KEEP_S = 8; // resident engine unloaded after this long without a job (600 s by default)
const alive = (pid) => fs.existsSync(`/proc/${pid}`) && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
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
print('[INFO ] backend_fit.cpp:337 -     Vulkan0      Fake Radeon RX                   free  15312 MiB, budget  14800 MiB', flush=True)
print('[INFO ] backend_fit.cpp:485 - auto-fit: --backend "%s"' % (opt('--backend') or 'Vulkan0'), flush=True)
for i in (50, 100):
    print('\\r  |####| %d/100 -   900.00MB/s\\x1b[K' % i, end='\\n' if i == 100 else '', flush=True)
print('[INFO ] model_loader.cpp:1437 - loading tensors completed, taking 1.50s (read: 1.00s, memcpy: 0.10s, convert: 0.00s, copy_to_backend: 0.40s)', flush=True)
steps = int(opt('--steps'))
for i in range(1, steps + 1):
    print('\\r  |=====>   | %d/%d - 0.10s/it\\x1b[K' % (i, steps), end='\\n' if i == steps else '', flush=True)
    time.sleep(30 if 'slow' in opt('-p') else 0.05)
print('[INFO ] image.cpp:1037 - sampling completed, taking 0.40s', flush=True)
w, h = int(opt('-W')), int(opt('-H'))
with open(opt('-o'), 'wb') as f:
    f.write(b'\\x89PNG\\r\\n\\x1a\\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0]) + b'fake pixels')
`;
// Resident engine (sd-server, sdapi): loads once, answers txt2img / img2img on 127.0.0.1 until stopped
const FAKE_SERVER = `#!/usr/bin/env python3
import base64, http.server, json, os, struct, sys, time
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else None
def note(d):
    with open(os.environ['FAKE_GPU_LOG'], 'a') as f:
        f.write(json.dumps(d) + '\\n')
note({'engine': 'sd-server', 'args': a, 'pid': os.getpid()})
if os.path.exists(os.environ['FAKE_GPU_LOG'] + '.server-broken'):
    print('[ERROR] fake: cannot start', flush=True)
    sys.exit(1)
for role in ('--diffusion-model', '--llm', '--vae'):
    assert open(opt(role)).read().startswith('fake'), role
print('ggml_vulkan: 0 = Fake Radeon RX (RADV) | uma: 0', flush=True)
print('[INFO ] backend_fit.cpp:337 -     Vulkan0      Fake Radeon RX                   free  15312 MiB, budget  14800 MiB', flush=True)
print('[INFO ] backend_fit.cpp:485 - auto-fit: --backend "%s"' % opt('--backend'), flush=True)
print('\\r  |####| 100/100 -   900.00MB/s\\x1b[K', flush=True)
print('[INFO ] model_loader.cpp:1437 - loading tensors completed, taking 1.50s (read: 1.00s, memcpy: 0.10s, convert: 0.00s, copy_to_backend: 0.40s)', flush=True)
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        self.send_response(200 if self.path == '/sdapi/v1/options' else 404)
        self.end_headers()
        self.wfile.write(b'{}')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        note({'engine': 'sd-server-request', 'path': self.path, 'pid': os.getpid(), 'init': len(body.pop('init_images', [])), 'body': body})
        steps = body['steps']
        for i in range(1, steps + 1):
            print('\\r  |=====>   | %d/%d - 0.10s/it\\x1b[K' % (i, steps), end='\\n' if i == steps else '', flush=True)
            time.sleep(30 if 'slow' in body['prompt'] else 0.05)
        print('[INFO ] image.cpp:1037 - sampling completed, taking 0.40s', flush=True)
        png = b'\\x89PNG\\r\\n\\x1a\\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', body['width'], body['height']) + bytes([8, 6, 0, 0, 0]) + b'fake'
        out = json.dumps({'images': [base64.b64encode(png).decode()], 'info': '{}'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)
http.server.ThreadingHTTPServer(('127.0.0.1', int(opt('--listen-port'))), Handler).serve_forever()
`;
const FAKE_TRELLIS = `#!/usr/bin/env python3
import json, os, struct, sys
a = sys.argv[1:]
with open(os.environ['FAKE_GPU_LOG'], 'a') as f:
    f.write(json.dumps({'engine': 'trellis', 'args': a, 'env': os.environ.get('GGML_VK_DISABLE_INTEGER_DOT_PRODUCT'),
                        'models': sorted(os.listdir(a[a.index('--models') + 1]))}) + '\\n')
assert open(a[0], 'rb').read(8) == b'\\x89PNG\\r\\n\\x1a\\n', 'input is a PNG'
for i, stage in enumerate(('preprocess', 'DINOv3 conditioning', 'sparse structure flow', 'shape flow', 'FlexiDualGrid shape decode -> mesh', 'texture', 'GLB export'), 1):
    print('[%d/7] %s' % (i, stage), flush=True)
doc = json.dumps({'asset': {'version': '2.0'}, 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1}]}],
                  'accessors': [{'count': 4, 'min': [0, 0, 0], 'max': [1, 2, 0.5]}, {'count': 6}]}).encode()
doc += b' ' * (-len(doc) % 4)
body = struct.pack('<I4s', len(doc), b'JSON') + doc
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
    const asset = (name, exe, script, extra = {}) => {
      const dir = path.join(tmp, `${name}-build`, 'bin');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, exe), script);
      for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
      fs.writeFileSync(path.join(dir, 'libggml-vulkan.so'), 'fake library');
      const zip = path.join(store, `${name}.zip`);
      const zipped = spawnSync('python3', ['-I', '-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, path.dirname(dir)]);
      assert.strictEqual(zipped.status, 0, String(zipped.stderr));
      const data = fs.readFileSync(zip);
      return { url: `file://${zip}`, sha256: sha(data), size: data.length, exe };
    };
    catalog.engines.sdcpp.linux = asset('sd', 'sd-cli', FAKE_SD, { 'sd-server': FAKE_SERVER });
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
      enable_3d: true, gpu_max_gb: 1, gpu_keep_free_gb: 0, gpu_keep_loaded_s: KEEP_S
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

  test('image: installs on first need, resident engine started on the GPU, prompt intact, PNG checked by the hub', async () => {
    const prompt = 'a "quoted" teapot; & | $(echo nope) `x` %PATH% é';
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt, width: 640, height: 384, seed: 7 }) });
    const done = await finished(job.id);
    assert.strictEqual(done.status, 'done', JSON.stringify(done));
    assert.strictEqual(done.result.device, 'Fake Radeon RX');
    assert.strictEqual(done.result.backend, 'te=cpu,gpu', 'text encoder on the CPU, the rest on the discrete GPU, as the engine reports');
    assert.strictEqual(done.backend, 'te=cpu,gpu');
    assert.strictEqual(done.result.s_per_step, 0.1);
    assert.strictEqual(done.result.load_s, 1.5);
    assert.strictEqual(done.result.vram_free_mib, 15312);
    assert.ok(done.result.server_start_s >= 0, 'first job of a series: the engine was started (weights loaded)');
    assert.strictEqual(typeof done.result.prefetch_mb_s, 'number', 'weights read once, sequentially, before the engine (speed reported)');
    assert.ok(done.engine.log.some(l => /auto-fit: --backend "te=cpu,gpu"/.test(l)), JSON.stringify(done.engine));
    const out = await admin(`/api/gpu/jobs/${job.id}/result`, { raw: true });
    assert.strictEqual(out.readUInt32BE(16), 640);
    assert.strictEqual(out.readUInt32BE(20), 384);
    const server = runs().find(r => r.engine === 'sd-server');
    assert.strictEqual(server.args[server.args.indexOf('--listen-ip') + 1], '127.0.0.1');
    assert.strictEqual(server.args[server.args.indexOf('--backend') + 1], 'te=cpu,gpu');
    assert.strictEqual(server.args[server.args.indexOf('--flash-attn') + 1], 'auto', 'sd.cpp decides (measured: forcing it is slower on RDNA2)');
    assert.ok(server.args.includes('--vae-tiling'));
    assert.ok(!server.args.includes('-t'), 'threads left to the engine by default');
    assert.ok(server.args.includes('--mmap'), 'weights mapped, not read through std::ifstream (25 MB/s on gpu-box)');
    const req = runs().find(r => r.engine === 'sd-server-request');
    assert.strictEqual(req.path, '/sdapi/v1/txt2img');
    assert.deepStrictEqual([req.body.prompt, req.body.seed, req.body.cfg_scale, req.body.steps, req.body.sampler_name], [prompt, 7, 1, 8, 'euler']);
    assert.ok(!runs().some(r => r.engine === 'sd'), 'no one-shot sd-cli run');
    // Everything lives under <folder>/gpu; the job folder is gone
    const engines = fs.readdirSync(path.join(pc, 'gpu', 'engines'));
    assert.strictEqual(engines.length, 1, 'only the engine that was needed');
    assert.match(engines[0], /^sdcpp-[0-9a-f]{12}$/);
    assert.deepStrictEqual(fs.readdirSync(path.join(pc, 'gpu', 'models')), ['z-image-turbo']);
    assert.ok(!fs.existsSync(path.join(pc, 'gpu', 'downloads')) || fs.readdirSync(path.join(pc, 'gpu', 'downloads')).length === 0);
    assert.deepStrictEqual(fs.readdirSync(path.join(pc, 'work')), []);
  });

  test('a series of jobs reuses the loaded engine (image to image included), then it is unloaded when idle', async () => {
    const start = png(512, 512, 'start');
    const a = (await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'same, at night', image: start.toString('base64'), width: 512, height: 512, strength: 0.4 }) })).job;
    const b = (await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'another one', width: 256, height: 256 }) })).job;
    const [da, db] = [await finished(a.id), await finished(b.id)];
    assert.strictEqual(da.status, 'done', JSON.stringify(da));
    assert.strictEqual(db.status, 'done', JSON.stringify(db));
    assert.strictEqual(da.result.server_reused, true);
    assert.strictEqual(db.result.server_reused, true);
    assert.strictEqual(db.result.prefetch_mb_s, undefined, 'engine already loaded: nothing read again');
    assert.strictEqual(runs().filter(r => r.engine === 'sd-server').length, 1, 'weights loaded once for the series');
    const img2img = runs().filter(r => r.engine === 'sd-server-request').find(r => r.body.prompt === 'same, at night');
    assert.strictEqual(img2img.path, '/sdapi/v1/img2img');
    assert.strictEqual(img2img.init, 1);
    assert.strictEqual(img2img.body.denoising_strength, 0.4);

    const pid = runs().find(r => r.engine === 'sd-server').pid;
    assert.ok(alive(pid));
    await until('engine unloaded after the idle delay', () => !alive(pid), KEEP_S + 60);
    assert.match(fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8'), /Moteur image résident arrêté \(8 s sans travail\)/);
  });

  test('admin tuning restarts the resident engine with the new flags; the same flags reuse it', async () => {
    const before = runs().filter(r => r.engine === 'sd-server').length;
    const tuned = { prompt: 'tuned', width: 256, height: 256, flash_attn: 'diffusion', vae_tiling: false, threads: 2, text_encoder: 'cpu', mmap: false };
    const a = (await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify(tuned) })).job;
    const b = (await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ ...tuned, prompt: 'tuned again' }) })).job;
    assert.strictEqual((await finished(a.id)).status, 'done');
    const db = await finished(b.id);
    assert.strictEqual(db.status, 'done');
    assert.strictEqual(db.result.server_reused, true);
    const servers = runs().filter(r => r.engine === 'sd-server');
    assert.strictEqual(servers.length, before + 1, 'one restart for the new flags, then reused');
    const args = servers.pop().args;
    assert.strictEqual(args[args.indexOf('--flash-attn') + 1], 'auto,diffusion=on');
    assert.strictEqual(args[args.indexOf('--backend') + 1], 'te=cpu,gpu', 'text encoder on the CPU, the rest on the GPU');
    assert.ok(!args.includes('--vae-tiling'));
    assert.ok(!args.includes('--mmap'));
    assert.strictEqual(args[args.indexOf('-t') + 1], '2');
  });

  test('cancelled while computing: the resident engine is stopped (card freed), the next job starts a new one', async () => {
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'slow one', width: 256, height: 256 }) });
    await until('computing', async () => (await admin(`/api/gpu/jobs/${job.id}`)).progress > 0.35);
    const pid = runs().filter(r => r.engine === 'sd-server').pop().pid;
    assert.match((await admin(`/api/gpu/jobs/${job.id}`)).stage, /^étape \d\/8/);
    await admin(`/api/gpu/jobs/${job.id}/cancel`, { method: 'POST' });
    await until('engine stopped', () => !alive(pid), 90);
    const { job: next } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'after the cancel', width: 256, height: 256 }) });
    const done = await finished(next.id);
    assert.strictEqual(done.status, 'done');
    assert.ok(done.result.server_start_s >= 0, 'a new engine was started');
    assert.match(fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8'), /abandonné : le hub l'a repris ou annulé/);
  });

  test('an engine that will not start: one-shot sd-cli instead, prompt passed as one argument', async () => {
    const pid = runs().filter(r => r.engine === 'sd-server').pop().pid;
    await until('engine unloaded', () => !alive(pid), KEEP_S + 60);
    fs.writeFileSync(`${fakeLog}.server-broken`, '');
    const prompt = 'a "quoted" teapot; & | $(echo nope)';
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt, width: 320, height: 256, seed: 9 }) });
    const done = await finished(job.id);
    assert.strictEqual(done.status, 'done', JSON.stringify(done));
    const run = runs().find(r => r.engine === 'sd');
    assert.strictEqual(run.args[run.args.indexOf('-p') + 1], prompt);
    assert.strictEqual(run.args[run.args.indexOf('-s') + 1], '9');
    assert.strictEqual(run.args[run.args.indexOf('--backend') + 1], 'te=cpu,gpu');
    assert.match(fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8'), /Moteur résident indisponible/);
    // Not retried for every job: the next one goes straight to sd-cli
    const launches = runs().filter(r => r.engine === 'sd-server').length;
    const { job: again } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'again', width: 256, height: 256 }) });
    assert.strictEqual((await finished(again.id)).status, 'done');
    assert.strictEqual(runs().filter(r => r.engine === 'sd-server').length, launches);
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

  test('settings from the hub: 3d switched off then back to the config file, without touching the PC', async () => {
    const announced = async () => (await admin('/api/reuse/workers')).workers.find(v => v.name === 'gpu-box').info.gpu;
    const set = await admin('/api/reuse/workers/gpu-box/settings', { method: 'POST', body: JSON.stringify({ enable_3d: false }) });
    assert.deepStrictEqual(set.settings, { enable_3d: false });
    await until('3d no longer announced', async () => (await announced()) === 'image');
    await admin('/api/reuse/workers/gpu-box/settings', { method: 'POST', body: JSON.stringify({ enable_3d: null }) });
    await until('3d announced again (config file)', async () => (await announced()) === '3d,image');
    assert.match(fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8'), /Réglages du hub appliqués \(enable_3d : True -> False\)/);
  });

  test('remote GPU test: 3d ordered by the admin, image made first, report with GLB figures readable on the hub', async () => {
    fs.rmSync(path.join(pc, 'logs', 'gpu-test.png'), { force: true });
    const asked = await admin('/api/reuse/workers/gpu-box/tests', { method: 'POST', body: JSON.stringify({ kind: '3d', params: { steps: 6 } }) });
    assert.strictEqual(asked.test.status, 'pending', JSON.stringify(asked));
    assert.strictEqual(asked.warning, undefined, 'this worker announces remote tests');
    const t = await until('test finished', async () => {
      const r = await admin(`/api/reuse/workers/gpu-box/tests/${asked.test.id}`);
      return ['done', 'failed'].includes(r.test.status) && r.test;
    });
    assert.strictEqual(t.status, 'done', JSON.stringify(t));
    assert.strictEqual(t.result.input_image.ok, true, 'no input image: the image test ran first');
    assert.deepStrictEqual(t.result.glb, { vertices: 4, triangles: 2, meshes: 1, textures: 0, materials: 0, bbox_size: [1, 2, 0.5] });
    assert.strictEqual(t.result.params.steps, 6);
    assert.ok(t.result.compute_s >= 0);
    assert.ok(t.result.log.some(l => l.includes('[7/7] GLB export')), JSON.stringify(t.result.log));
    assert.deepStrictEqual(t.result.nan_lines, []);
    const run = runs().filter(r => r.engine === 'trellis').at(-1);
    assert.strictEqual(run.args[run.args.indexOf('--steps') + 1], '6');
    assert.strictEqual(run.env, '1', 'RDNA2 workaround passed to the test too');
    assert.ok(fs.existsSync(path.join(pc, 'logs', 'gpu-test.glb')));
    // The GLB itself, to look at: on the hub, same bytes as on the PC
    assert.strictEqual(t.output.ext, 'glb');
    assert.strictEqual(t.result.output_sent, true);
    const glb = await admin(t.output.url, { raw: true });
    assert.ok(glb.equals(fs.readFileSync(path.join(pc, 'logs', 'gpu-test.glb'))));
    const history = (await admin('/api/reuse/workers/gpu-box/settings')).history.map(e => e.what);
    assert.deepStrictEqual(history.slice(0, 3), ['test_finished', 'test_started', 'test_requested']);
  });

  test('RE-USE still works on the same worker', async () => {
    assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.5',
      '-ac', '1', '-ar', '24000', '-c:a', 'flac', path.join(tmp, 'in.flac')]).status, 0);
    const { job } = await admin('/api/reuse/jobs?batch=e2e&name=e2e_000.flac', { method: 'POST', body: fs.readFileSync(path.join(tmp, 'in.flac')), headers: { 'Content-Type': 'audio/flac' } });
    await until('RE-USE job done', async () => (await admin(`/api/reuse/jobs/${job.id}`)).status === 'done');
  });
});
