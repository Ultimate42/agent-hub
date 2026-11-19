import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { tmpDir } from './tmp.js';

// the machine owner's ComfyUI workshop on a worker machine, end to end: the real launcher + worker against a real hub, a fake
// ComfyUI for the workshop and a fake image engine for the hub's jobs. Turned on and off from the hub; while it computes
// the machine takes no job from the hub, a running GPU job is given back without counting the attempt, and before a
// GPU job the workshop is asked to free the card (POST /free).
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const canRun = process.platform === 'linux' && ['python3', 'bash', 'ffmpeg', 'flock'].every(has);
const SRC = path.join(process.cwd(), 'reuse-worker');
const PORT = '4167';
const ATELIER_PORT = 41887;
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN = 'reuse-admin-secret-atelier-0123456789';
const TOKEN = 'gpu-box-worker-secret-atelier-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const alive = (pid) => fs.existsSync(`/proc/${pid}`) && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';

const FAKE_SD = `#!/usr/bin/env python3
import os, struct, sys, time
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else None
print('ggml_vulkan: 0 = Fake Radeon RX (RADV) | uma: 0', flush=True)
steps = int(opt('--steps'))
for i in range(1, steps + 1):
    print('\\r  |=====>   | %d/%d - 0.10s/it\\x1b[K' % (i, steps), end='\\n' if i == steps else '', flush=True)
    time.sleep(30 if 'slow' in opt('-p') else 0.05)
w, h = int(opt('-W')), int(opt('-H'))
with open(opt('-o'), 'wb') as f:
    f.write(b'\\x89PNG\\r\\n\\x1a\\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0]) + b'fake pixels')
`;

// The workshop's ComfyUI: /queue says busy while the file <base>/busy exists; /free is noted in <base>/free-calls
const FAKE_ATELIER = `
import http.server, json, os, sys
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else None
base, port = opt('--base-directory'), int(opt('--port'))
os.makedirs(base, exist_ok=True)
with open(os.path.join(base, 'argv.jsonl'), 'a') as f:
    f.write(json.dumps({'args': a, 'pid': os.getpid(), 'hip': os.environ.get('HIP_VISIBLE_DEVICES')}) + '\\n')
card = 'AMD Radeon RX 6950 XT' if os.environ.get('HIP_VISIBLE_DEVICES') == '1' else 'AMD Radeon(TM) Graphics'   # Windows : la n° 0 seule
held = {'mib': 9000}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *x):
        pass
    def answer(self, code, body):
        out = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        if self.path == '/queue':
            busy = os.path.exists(os.path.join(base, 'busy'))
            return self.answer(200, {'queue_running': [[1, 'p1', {}, {}, []]] if busy else [], 'queue_pending': []})
        if self.path == '/system_stats':
            return self.answer(200, {'devices': [{'name': 'cuda:0 %s : native' % card, 'vram_total': 16384 * 1048576,
                                                  'vram_free': (16384 - held['mib']) * 1048576, 'torch_vram_total': held['mib'] * 1048576}]})
        return self.answer(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if self.path == '/free':
            with open(os.path.join(base, 'free-calls'), 'a') as f:
                f.write(json.dumps(body, sort_keys=True) + '\\n')
            held['mib'] = 300
            self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
            return
        return self.answer(404, {})
print('Starting server', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
`;

describe('worker: ComfyUI workshop beside the hub jobs', { skip: !canRun }, () => {
  let tmp, hub, launcher, pc, publish, data;
  const admin = async (p, opts = {}) => {
    const res = await fetch(BASE_URL + p, { ...opts, headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    return res.json();
  };
  const workshop = async () => (await admin('/api/reuse/workers/gpu-box/atelier'));
  async function until(what, fn, seconds = 60) {
    for (let i = 0; i < seconds * 4; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(250);
    }
    const log = path.join(pc, 'logs', 'worker.log');
    assert.fail(`timeout: ${what}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(-20).join('\n') : '(no log)'}`);
  }
  const workerLog = () => fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8');
  const freeCalls = () => (fs.existsSync(path.join(data, 'free-calls')) ? fs.readFileSync(path.join(data, 'free-calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const runs = () => (fs.existsSync(path.join(data, 'argv.jsonl')) ? fs.readFileSync(path.join(data, 'argv.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);

  before(async () => {
    tmp = tmpDir('atelier-worker-');
    publish = path.join(tmp, 'publish');
    pc = path.join(tmp, 'pc');
    const store = path.join(tmp, 'store');
    for (const d of [publish, pc, store]) fs.mkdirSync(d);
    for (const f of ['reuse_worker.py', 'atelier_relay.py', 'install-and-run.sh']) fs.copyFileSync(path.join(SRC, f), path.join(publish, f));
    fs.copyFileSync(path.join(SRC, 'install-and-run.sh'), path.join(pc, 'install-and-run.sh'));

    // Catalog = the real one, with a Linux fake image engine and small model files
    const catalog = JSON.parse(fs.readFileSync(path.join(SRC, 'gpu-catalog.json'), 'utf8'));
    const dir = path.join(tmp, 'sd-build', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    for (const exe of ['sd-cli', 'sd-server']) fs.writeFileSync(path.join(dir, exe), FAKE_SD);
    fs.writeFileSync(path.join(dir, 'libggml-vulkan.so'), 'fake library');
    const zip = path.join(store, 'sd.zip');
    const zipped = spawnSync('python3', ['-I', '-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, path.dirname(dir)]);
    assert.strictEqual(zipped.status, 0, String(zipped.stderr));
    const z = fs.readFileSync(zip);
    catalog.engines.sdcpp.linux = { url: `file://${zip}`, sha256: sha(z), size: z.length, exe: 'sd-cli' };
    for (const type of Object.values(catalog.types)) {
      for (const model of Object.values(type.models)) {
        for (const f of model.files) {
          const d = Buffer.from(`fake ${f.name} ${'x'.repeat(200)}`);
          fs.writeFileSync(path.join(store, f.name), d);
          Object.assign(f, { url: `file://${path.join(store, f.name)}`, sha256: sha(d), size: d.length });
        }
      }
    }
    // gpu-box as ROCm sees it: the Ryzen integrated graphics first (no kernel in the gfx1030 wheels), then the RX 6950 XT
    catalog.benchmarks.comfyui.torch.check = "print('TORCH 2.13.0+rocm10.0.0 7.15 True 2'); print('DEV 0 gfx1036 13065000000 AMD Radeon(TM) Graphics'); "
      + "print('DEV 1 gfx1030 17163091968 AMD Radeon RX 6950 XT')";
    fs.writeFileSync(path.join(publish, 'gpu-catalog.json'), JSON.stringify(catalog, null, 1));

    // The jobs' ComfyUI environment is already installed on the PC (the workshop clones it): markers computed by the worker
    const spec = catalog.benchmarks.comfyui;
    const comfy = path.join(pc, 'gpu', 'comfyui');
    fs.mkdirSync(path.join(comfy, 'python', 'bin'), { recursive: true });
    fs.symlinkSync(spawnSync('python3', ['-c', 'import sys; print(sys.executable)']).stdout.toString().trim(), path.join(comfy, 'python', 'bin', 'python3'));
    const marks = spawnSync('python3', ['-I', '-c', `
import importlib.util, json, sys
sys.dont_write_bytecode = True
s = importlib.util.spec_from_file_location('w', sys.argv[1]); w = importlib.util.module_from_spec(s); s.loader.exec_module(w)
spec = json.load(open(sys.argv[2]))['benchmarks']['comfyui']
print(json.dumps({k: w.comfy_marker(spec, k) for k in ('python', 'pip', 'source', 'torch', 'requirements')}))`,
    path.join(SRC, 'reuse_worker.py'), path.join(publish, 'gpu-catalog.json')]);
    assert.strictEqual(marks.status, 0, String(marks.stderr));
    for (const [k, v] of Object.entries(JSON.parse(marks.stdout))) fs.writeFileSync(path.join(comfy, `.ok-${k}`), v);
    fs.mkdirSync(path.join(comfy, 'data', 'models', 'vae'), { recursive: true });
    const src = path.join(pc, 'atelier', spec.source.root);
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'main.py'), FAKE_ATELIER);
    data = path.join(pc, 'atelier', 'data');

    const engine = path.join(tmp, 'fake-engine.sh');
    fs.writeFileSync(engine, `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --audio) IN=$2; shift;; --out) OUT=$2; shift;; esac; shift; done
exec ffmpeg -v error -nostdin -y -i "$IN" -af volume=0.5 -c:a pcm_s16le "$OUT"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'model.gguf'), 'fake');
    fs.writeFileSync(path.join(pc, 'reuse-worker.config.json'), JSON.stringify({
      hub_url: BASE_URL, allow_http: true, token: TOKEN, backend: 'cpu', audiocpp_cli: engine, model: path.join(tmp, 'model.gguf'),
      // Without sleep at first (ComfyUI straight on the workshop's port, as before the relay); the sleep is turned on from the hub below
      gpu_max_gb: 1, gpu_keep_free_gb: 0, gpu_keep_loaded_s: 0, comfyui_any_os: true, atelier_port: ATELIER_PORT, atelier_idle_stop_minutes: 0,
      atelier_backend_port: ATELIER_PORT + 1
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
      cwd: pc, stdio: 'ignore', detached: true, env: { ...process.env, REUSE_RESTART: '1', REUSE_RETRY: '1', REUSE_RETRY_LONG: '1' }
    });
  });

  after(async () => {
    try { if (launcher?.pid) process.kill(-launcher.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (const r of runs()) { try { if (alive(r.pid)) process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
    hub?.kill('SIGTERM');
    if (process.env.KEEP_ATELIER_TEST) console.log('kept', tmp);
    else if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('off by default; said so to the hub', async () => {
    const w = await until('worker online with its workshop state', async () => {
      const a = await workshop();
      return a.online && a.atelier && a;
    });
    assert.deepStrictEqual(w.atelier, { enabled: false, state: 'éteint', tasks: 'install_nodes,remove_nodes,download_model,remove_model,undo' });
    assert.strictEqual(w.settings.atelier_enabled, null);
    assert.deepStrictEqual(runs(), [], 'nothing launched');
  });

  test('turned on from the hub: launched on 127.0.0.1 only (no Tailscale, no firewall here), state reported', async () => {
    assert.strictEqual((await admin('/api/reuse/workers/gpu-box/atelier', { method: 'POST', body: JSON.stringify({ on: 'yes' }) })).error, 'Expected {on: true|false}');
    const on = await admin('/api/reuse/workers/gpu-box/atelier', { method: 'POST', body: JSON.stringify({ on: true }) });
    assert.deepStrictEqual(on.changed, [{ key: 'atelier_enabled', from: null, to: true }]);
    const a = await until('workshop running', async () => (await workshop()).atelier?.state === 'en marche' && (await workshop()).atelier);
    assert.strictEqual(a.port, ATELIER_PORT);
    assert.strictEqual(a.listen, '127.0.0.1');
    assert.strictEqual(a.busy, false);
    assert.ok(a.pid > 0 && alive(a.pid));
    const args = runs()[0].args;
    assert.strictEqual(args[args.indexOf('--listen') + 1], '127.0.0.1');
    assert.strictEqual(runs()[0].hip, '1', 'the workshop picks its card itself, before any Klein job: never the integrated graphics');
    assert.strictEqual((await until('card reported', async () => (await workshop()).atelier?.device)), 'cuda:0 AMD Radeon RX 6950 XT : native');
    assert.ok(!args.includes('--disable-all-custom-nodes'), 'custom nodes allowed in the workshop');
    assert.ok(fs.existsSync(path.join(pc, 'atelier', 'python', 'bin', 'python3')), 'environment cloned from the jobs one');
    assert.strictEqual((await (await fetch(`http://127.0.0.1:${ATELIER_PORT}/queue`)).json()).queue_running.length, 0);
    const settings = await admin('/api/reuse/workers/gpu-box/settings');
    assert.strictEqual(settings.history[0].what, 'settings', 'journaled like any setting');
  });

  test('while the workshop computes, no job is taken; then the card is freed before the job', async () => {
    fs.writeFileSync(path.join(data, 'busy'), '1');
    await until('worker sees the workshop busy', async () => (await workshop()).atelier?.busy === true);
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'a teapot', width: 256, height: 256 }) });
    await sleep(15000);
    const waiting = await admin(`/api/gpu/jobs/${job.id}`);
    assert.strictEqual(waiting.status, 'pending', JSON.stringify(waiting));
    assert.strictEqual(waiting.attempts, 0);
    assert.match(workerLog(), /L'atelier ComfyUI calcule : aucun travail du hub/);
    const before = freeCalls().length;
    fs.unlinkSync(path.join(data, 'busy'));
    const done = await until('job done', async () => {
      const j = await admin(`/api/gpu/jobs/${job.id}?wait=5`);
      return j.status === 'done' && j;
    }, 120);
    assert.strictEqual(done.attempts, 1);
    assert.ok(freeCalls().length > before, 'POST /free sent to the workshop before the job');
    assert.deepStrictEqual(JSON.parse(freeCalls().at(-1)), { free_memory: true, unload_models: true });
    assert.match(workerLog(), /Atelier : carte rendue \(travail image \d+ du hub\)/);
  });

  test('a GPU job running when Alice starts computing is given back, attempt not counted', async () => {
    const { job } = await admin('/api/gpu/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'slow one', width: 256, height: 256 }) });
    await until('computing', async () => (await admin(`/api/gpu/jobs/${job.id}`)).status === 'claimed', 90);
    fs.writeFileSync(path.join(data, 'busy'), '1');
    const back = await until('job back in the queue', async () => {
      const j = await admin(`/api/gpu/jobs/${job.id}`);
      return j.status === 'pending' && j.error && j;
    }, 90);
    assert.strictEqual(back.attempts, 0, 'not counted as a failure');
    assert.match(back.error, /atelier ComfyUI en calcul/);
    assert.match(workerLog(), /rendu au hub sans compter l'essai/);
    await sleep(12000);
    assert.strictEqual((await admin(`/api/gpu/jobs/${job.id}`)).status, 'pending', 'not taken again while the workshop computes');
    await admin(`/api/gpu/jobs/${job.id}/cancel`, { method: 'POST' });
    fs.unlinkSync(path.join(data, 'busy'));
  });

  test('workshop tasks from the hub: checked, run by the worker, journaled, undone', async () => {
    const tasks = '/api/reuse/workers/gpu-box/atelier/tasks';
    const post = (body) => admin(tasks, { method: 'POST', body: JSON.stringify(body) });
    assert.match((await post({ action: 'install_nodes', url: 'https://github.com/a/b', commit: 'main' })).error, /40-character/);
    assert.match((await post({ action: 'download_model', url: 'https://x/a.safetensors', sha256: 'b'.repeat(64), folder: '../x' })).error, /folder/);
    assert.match((await post({ action: 'download_model', url: 'http://x/a.safetensors', sha256: 'b'.repeat(64), folder: 'loras' })).error, /https/);
    const zip = { action: 'download_model', url: 'https://x/r.zip', sha256: 'b'.repeat(64), folder: 'upscale_models', member: 'R-1.0/Models/up.safetensors' };
    assert.match((await post(zip)).error, /member needs archive_sha256/);
    for (const member of ['R-1.0/../up.safetensors', '/up.safetensors', 'R\\up.safetensors', 'C:/up.safetensors', 'R//up.safetensors']) {
      assert.match((await post({ ...zip, member, archive_sha256: 'c'.repeat(64) })).error, /member: relative path/, member);
    }
    assert.match((await post({ ...zip, member: undefined, name: 'up.safetensors', archive_sha256: 'c'.repeat(64) })).error, /go with member/);
    assert.match((await post({ action: 'rm -rf' })).error, /action must be one of/);
    const lora = path.join(data, 'models', 'loras', 'style.safetensors');
    fs.mkdirSync(path.dirname(lora), { recursive: true });
    fs.writeFileSync(lora, 'weights');
    const done = async (id) => until(`task ${id} finished`, async () => {
      const t = (await admin(`${tasks}/${id}`)).task;
      return ['done', 'failed', 'cancelled'].includes(t.status) && t;
    }, 90);
    const removed = await done((await post({ action: 'remove_model', folder: 'loras', name: 'style.safetensors' })).task.id);
    assert.strictEqual(removed.status, 'done', JSON.stringify(removed));
    assert.ok(!fs.existsSync(lora) && fs.existsSync(removed.result.trash), 'moved to the trash, not deleted');
    const undone = await done((await post({ action: 'undo', task: removed.id })).task.id);
    assert.strictEqual(undone.status, 'done', JSON.stringify(undone));
    assert.strictEqual(fs.readFileSync(lora, 'utf8'), 'weights');
    const missing = await done((await post({ action: 'remove_nodes', name: 'NoSuchPack' })).task.id);
    assert.strictEqual(missing.status, 'failed');
    assert.match(missing.error, /pas de pack NoSuchPack/);
    const history = (await admin('/api/reuse/workers/gpu-box/settings')).history.map(e => e.what);
    for (const what of ['atelier_task_requested', 'atelier_task_started', 'atelier_task_finished']) assert.ok(history.includes(what), what);
    assert.strictEqual((await admin(tasks)).tasks.length, 3);
  });

  test('sleep from the hub: a relay keeps the port, a call wakes ComfyUI behind it, idle it stops; journaled, reversible', async () => {
    const set = (body) => admin('/api/reuse/workers/gpu-box/settings', { method: 'POST', body: JSON.stringify(body) });
    assert.match((await set({ atelier_idle_stop_minutes: -1 })).error, /atelier_idle_stop_minutes must be a number from 0 to 1440/);
    const direct = (await workshop()).atelier.pid;
    // 3 s of idle for the test (10 minutes by default)
    assert.deepStrictEqual((await set({ atelier_idle_stop_minutes: 0.05 })).changed, [{ key: 'atelier_idle_stop_minutes', from: null, to: 0.05 }]);
    const asleep = await until('relay on the port, ComfyUI stopped', async () => {
      const a = (await workshop()).atelier;
      return a?.mode === 'relais' && a.state === 'en veille' && a.relay === 'en veille' && a;
    }, 90);
    assert.ok(!alive(direct), 'ComfyUI (direct) gave the port to the relay');
    assert.strictEqual(asleep.port, ATELIER_PORT);
    assert.strictEqual(asleep.listen, '127.0.0.1');
    assert.ok(asleep.relay_pid > 0 && alive(asleep.relay_pid));
    assert.strictEqual(asleep.pid, undefined, 'no ComfyUI process at rest');
    // A call of the dev PC: answered once ComfyUI is up behind the relay, on 127.0.0.1 and its own port
    const before = runs().length;
    const r = await fetch(`http://127.0.0.1:${ATELIER_PORT}/queue`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { queue_running: [], queue_pending: [] });
    const woken = runs().at(-1);
    assert.strictEqual(runs().length, before + 1);
    assert.strictEqual(woken.args[woken.args.indexOf('--listen') + 1], '127.0.0.1');
    assert.strictEqual(woken.args[woken.args.indexOf('--port') + 1], String(ATELIER_PORT + 1));
    // Idle: stopped (queue read empty), the relay stays; RAM given back said in the journal
    const slept = await until('back to sleep', async () => {
      const a = (await workshop()).atelier;
      return a?.state === 'en veille' && a.sleeps >= 1 && a;
    }, 60);
    assert.ok(!alive(woken.pid), 'ComfyUI process gone');
    assert.ok(alive(slept.relay_pid));
    assert.match(slept.last_sleep, /Mio de mémoire vive rendus/);
    assert.match(slept.last_wake, /appel GET \/queue \(127\.0\.0\.1\), prêt en/);
    assert.strictEqual(slept.backend_port, ATELIER_PORT + 1);
    const history = (await admin('/api/reuse/workers/gpu-box/settings')).history;
    for (const what of ['atelier_relay', 'atelier_wake', 'atelier_sleep']) assert.ok(history.some(e => e.what === what), what);
    assert.match(history.find(e => e.what === 'atelier_wake').cause, /GET \/queue/);
    assert.ok(history.find(e => e.what === 'atelier_sleep').mem_mib > 0);
    // Reversible: the override removed, the PC's own 0 applies again: relay stopped, ComfyUI always on, on the port
    await set({ atelier_idle_stop_minutes: null });
    const back = await until('direct again', async () => {
      const a = (await workshop()).atelier;
      return a?.mode === 'direct' && a.state === 'en marche' && a;
    }, 90);
    assert.ok(!alive(slept.relay_pid), 'relay stopped');
    assert.strictEqual(back.port, ATELIER_PORT);
    assert.strictEqual((await fetch(`http://127.0.0.1:${ATELIER_PORT}/queue`)).status, 200);
  });

  test('turned off from the hub: the process is stopped', async () => {
    const pid = (await workshop()).atelier.pid;
    await admin('/api/reuse/workers/gpu-box/atelier', { method: 'POST', body: JSON.stringify({ on: false }) });
    await until('workshop stopped', async () => (await workshop()).atelier?.state === 'éteint' && !alive(pid));
    assert.ok(!fs.existsSync(path.join(pc, 'atelier', 'atelier.json')));
  });
});
