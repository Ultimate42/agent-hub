// Client CLI : vrai hub sur DB TEMPORAIRE et port dédié.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { until } from './runner-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = '4188';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'client-it-'));
let hub, roomToken, bob;
const api = async (p, method = 'GET', body, token) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const cli = (script, ...a) => spawnSync('node', [path.join(ROOT, 'client', script), '--url', BASE, '--room-token-file', path.join(TMP, 'room.tok'), ...a], { encoding: 'utf8', timeout: 20000 });
const lines = (r) => r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('client CLI', () => {
  before(async () => {
    hub = spawn('node', ['src/index.js'], { cwd: ROOT, env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: path.join(TMP, 'hub.db') }, stdio: 'ignore' });
    await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 15000);
    roomToken = (await api('/api/rooms', 'POST', { name: 'salon-client' })).room_token;
    bob = (await api(`/api/rooms/${roomToken}/join`, 'POST', { name: 'Bob' })).member_token;
    fs.writeFileSync(path.join(TMP, 'room.tok'), roomToken);
    fs.writeFileSync(path.join(TMP, 'bob.tok'), `member_token=${bob}\n`);
  });
  after(async () => { hub?.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 200)); fs.rmSync(TMP, { recursive: true, force: true }); });

  test('--join cree le fichier token ; send puis listen --once recoit et ack (2e appel vide)', () => {
    const mf = path.join(TMP, 'ann.tok');
    let r = cli('hub-listen.mjs', '--member-token-file', mf, '--join', 'Ann', '--once');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '');
    assert.ok(fs.existsSync(mf));
    r = cli('hub-send.mjs', '--member-token-file', path.join(TMP, 'bob.tok'), 'salut Ann');
    assert.strictEqual(r.status, 0, r.stderr);
    r = cli('hub-listen.mjs', '--member-token-file', mf, '--once');
    const out = lines(r);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(Object.keys(out[0]), ['id', 'room', 'author', 'created_at', 'text']);
    assert.strictEqual(out[0].text, 'salut Ann');
    assert.strictEqual(out[0].author, 'Bob');
    assert.strictEqual(out[0].room, 'salon-client');
    assert.ok(!r.stdout.includes(roomToken) && !r.stdout.includes(bob));
    assert.strictEqual(lines(cli('hub-listen.mjs', '--member-token-file', mf, '--once')).length, 0);
  });

  test('--exec : ack seulement si exit 0', () => {
    const mf = path.join(TMP, 'ann.tok');
    cli('hub-send.mjs', '--member-token-file', path.join(TMP, 'bob.tok'), 'cmd test');
    const node = JSON.stringify(process.execPath);
    let r = cli('hub-listen.mjs', '--member-token-file', mf, '--once', '--exec', `${node} -e "process.exit(1)"`);
    assert.strictEqual(lines(cli('hub-listen.mjs', '--member-token-file', mf, '--once')).length, 1); // re-livré (et acké)
    cli('hub-send.mjs', '--member-token-file', path.join(TMP, 'bob.tok'), 'cmd ok');
    const sink = path.join(TMP, 'sink.txt');
    const helper = path.join(TMP, 'sink.mjs');
    fs.writeFileSync(helper, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(sink)}, fs.readFileSync(0, 'utf8'));`);
    r = cli('hub-listen.mjs', '--member-token-file', mf, '--once', '--exec', `${node} ${JSON.stringify(helper)}`);
    assert.match(fs.readFileSync(sink, 'utf8'), /cmd ok/);
    assert.strictEqual(lines(cli('hub-listen.mjs', '--member-token-file', mf, '--once')).length, 0);
  });

  test('route de telechargement', async () => {
    for (const f of ['hub-listen.mjs', 'hub-send.mjs']) {
      const r = await fetch(`${BASE}/client/${f}`);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/plain/);
      assert.strictEqual(await r.text(), fs.readFileSync(path.join(ROOT, 'client', f), 'utf8'));
    }
    assert.strictEqual((await fetch(`${BASE}/client/..%2fpackage.json`)).status, 404);
    const setup = await (await fetch(`${BASE}/r/${roomToken}/setup`, { headers: { Accept: 'application/json' } })).json();
    assert.match(setup.content, /client\/hub-listen\.mjs/);
  });
});
