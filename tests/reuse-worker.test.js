import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The worker program (reuse-worker/): pure functions, then the real launcher + worker against a real hub,
// with a fake engine (ffmpeg halves the volume) so the whole loop, self-update and rollback run in seconds.
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const canRun = process.platform === 'linux' && ['python3', 'bash', 'ffmpeg', 'flock'].every(has);
const SRC = path.join(process.cwd(), 'reuse-worker');
const PORT = '4156';
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN = 'reuse-admin-secret-0123456789';
const TOKEN = 'gpu-box-worker-secret-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('worker unit tests (python)', { skip: !has('python3') }, () => {
  const r = spawnSync('python3', ['-I', 'tests/reuse_worker_unit.py'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

describe('worker end to end (launcher, job, self-update, rollback)', { skip: !canRun }, () => {
  let tmp, hub, launcher, pc, publish;
  const admin = async (p, opts = {}) => {
    const res = await fetch(BASE_URL + p, { ...opts, headers: { Authorization: `Bearer ${ADMIN}`, ...(opts.headers || {}) } });
    return opts.raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
  const worker = async () => (await admin('/api/reuse/workers')).workers.find(w => w.name === 'gpu-box');
  async function until(what, fn, seconds = 40) {
    for (let i = 0; i < seconds * 4; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(250);
    }
    const log = path.join(pc, 'logs', 'worker.log');
    assert.fail(`timeout: ${what}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(-15).join('\n') : '(no log)'}`);
  }
  const publishWorker = (edit) => fs.writeFileSync(path.join(publish, 'reuse_worker.py'), edit(fs.readFileSync(path.join(SRC, 'reuse_worker.py'), 'utf8')));

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-worker-'));
    publish = path.join(tmp, 'publish');
    pc = path.join(tmp, 'pc');
    fs.mkdirSync(publish);
    fs.mkdirSync(pc);
    for (const f of ['reuse_worker.py', 'install-and-run.sh']) fs.copyFileSync(path.join(SRC, f), path.join(publish, f));
    fs.copyFileSync(path.join(SRC, 'install-and-run.sh'), path.join(pc, 'install-and-run.sh'));
    const engine = path.join(tmp, 'fake-engine.sh');
    fs.writeFileSync(engine, `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --audio) IN=$2; shift;; --out) OUT=$2; shift;; esac; shift; done
exec ffmpeg -v error -nostdin -y -i "$IN" -af volume=0.5 -c:a pcm_s16le "$OUT"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'model.gguf'), 'fake');
    fs.writeFileSync(path.join(pc, 'reuse-worker.config.json'), JSON.stringify({
      hub_url: BASE_URL, allow_http: true, token: TOKEN, backend: 'cpu', audiocpp_cli: engine, model: path.join(tmp, 'model.gguf')
    }));
    assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.5',
      '-ac', '1', '-ar', '24000', '-c:a', 'flac', path.join(tmp, 'in.flac')]).status, 0);

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
    // Own process group: the launcher and the worker it started are stopped together at the end
    launcher = spawn('bash', [path.join(pc, 'install-and-run.sh'), '--no-startup'], {
      cwd: pc, stdio: 'ignore', detached: true, env: { ...process.env, REUSE_RESTART: '1', REUSE_RETRY: '1', REUSE_RETRY_LONG: '1' }
    });
  });

  after(async () => {
    try { if (launcher?.pid) process.kill(-launcher.pid, 'SIGTERM'); } catch { /* already gone */ }
    hub?.kill('SIGTERM');
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('installs itself from the hub, cleans a job, the hub validates the result', async () => {
    const flac = fs.readFileSync(path.join(tmp, 'in.flac'));
    const { job } = await admin('/api/reuse/jobs?batch=e2e&name=e2e_000.flac', { method: 'POST', body: flac });
    const done = await until('job done', async () => { const j = await admin(`/api/reuse/jobs/${job.id}`); return j.status === 'done' && j; });
    assert.strictEqual(done.worker, 'gpu-box');
    assert.strictEqual(done.backend, 'cpu');
    assert.strictEqual(done.out.rate, 24000);
    const out = await admin(`/api/reuse/jobs/${job.id}/output`, { raw: true });
    assert.strictEqual(out.toString('latin1', 0, 4), 'fLaC');
    assert.notStrictEqual(out.length, flac.length);
    assert.deepStrictEqual(fs.readdirSync(path.join(pc, 'work')), [], 'nothing left behind');
    const w = await worker();
    assert.strictEqual(w.up_to_date, true);
    assert.strictEqual(w.info.state, 'en attente');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pc, 'logs', 'state.json'), 'utf8')).version, w.info.version);
  });

  test('a second worker never starts in the same folder', async () => {
    const r = spawnSync('python3', [path.join(pc, 'app', 'reuse_worker.py'), '--base', pc], { encoding: 'utf8' });
    assert.strictEqual(r.status, 3);
    assert.match(r.stdout, /Un autre worker tourne déjà/);
  });

  test('takes a newly published version by itself and keeps the previous one', async () => {
    const before = (await worker()).info.version;
    publishWorker(src => src + '\n# v2\n');
    const w = await until('updated', async () => { const x = await worker(); return x.up_to_date && x.info.version !== before && x; });
    assert.strictEqual(fs.readFileSync(path.join(pc, 'app.prev', 'version.txt'), 'utf8'), before);
    assert.strictEqual(fs.readFileSync(path.join(pc, 'app', 'version.txt'), 'utf8'), w.info.version);
  });

  test('refuses a version with a syntax error, rolls back one that crashes at startup, then takes the fix', async () => {
    const good = (await worker()).info.version;
    publishWorker(src => src + '\ndef broken(:\n');
    const syntax = (await admin('/api/reuse/workers')).published_version;
    await until('syntax error noticed', () => fs.readFileSync(path.join(pc, 'logs', 'worker.log'), 'utf8').includes(`${good} -> ${syntax}`));
    await sleep(1500);
    assert.strictEqual((await worker()).info.version, good);
    assert.ok(!fs.existsSync(path.join(pc, 'bad-versions.txt')), 'never installed, so never marked bad');

    publishWorker(src => src.replace('\ndef main():\n', '\ndef main():\n    raise RuntimeError("broken release")\n'));
    const crashing = (await admin('/api/reuse/workers')).published_version;
    const rolled = await until('rolled back', async () => { const x = await worker(); return x.info.rolled_back_from === crashing && x.online && x; }, 60);
    assert.strictEqual(rolled.info.version, good);
    assert.strictEqual(rolled.up_to_date, false);
    assert.strictEqual(fs.readFileSync(path.join(pc, 'bad-versions.txt'), 'utf8').trim(), crashing);

    // Still working on the old version
    const { job } = await admin('/api/reuse/jobs?batch=e2e&name=e2e_001.flac', { method: 'POST', body: fs.readFileSync(path.join(tmp, 'in.flac')) });
    await until('job done on the old version', async () => (await admin(`/api/reuse/jobs/${job.id}`)).status === 'done');

    publishWorker(src => src + '\n# v3 fixed\n');
    const fixed = await until('fix taken', async () => { const x = await worker(); return x.up_to_date && x; });
    assert.notStrictEqual(fixed.info.version, good);
    assert.strictEqual(fixed.info.rolled_back_from, undefined);
  });
});
