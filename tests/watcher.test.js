// Watcher : vrai hub sur DB TEMPORAIRE (port dédié), faux binaire `claude`. Ne touche à aucun service ni salon réel.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { until } from './runner-helpers.js';
import { Watcher, buildConfig, parseArgs, statusOf, generateService, splitArgs, shouldWake } from '../client/hub-watch.mjs';

const PORT = '4193';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-it-'));
let hub, roomToken, tokens = {};
const api = async (p, method = 'GET', body, token) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const post = (who, content, extra = {}) => api(`/api/rooms/${roomToken}/messages`, 'POST', { content, ...extra }, tokens[who]);
const unread = async (who) => (await api(`/api/rooms/${roomToken}/messages/wait?timeout=1&auto_ack=false`, 'GET', null, tokens[who])).messages || [];
const startHub = async () => {
  hub = spawn('node', ['src/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: path.join(TMP, 'hub.db') }, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 15000);
};
const stopHub = () => new Promise((r) => { hub.once('exit', r); hub.kill('SIGTERM'); });

// faux `claude` : journalise argv + stdin ; échoue tant que le fichier FAIL existe ; dort si SLOW existe
const fake = path.join(TMP, 'fakeclaude.mjs');
fs.writeFileSync(fake, `import fs from 'node:fs';
const t = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(TMP, 'calls.log'))}, JSON.stringify({ argv: process.argv.slice(2), stdin: t, at: Date.now() }) + '\\n');
if (fs.existsSync(${JSON.stringify(path.join(TMP, 'FAIL'))})) process.exit(1);
if (fs.existsSync(${JSON.stringify(path.join(TMP, 'SLOW'))})) await new Promise((r) => setTimeout(r, 1200));
`);
const calls = () => (fs.existsSync(path.join(TMP, 'calls.log')) ? fs.readFileSync(path.join(TMP, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const resetCalls = () => fs.rmSync(path.join(TMP, 'calls.log'), { force: true });

const mkCfg = (extra = {}, tag = 'w') => buildConfig(parseArgs([
  '--url', BASE, '--room-token-file', path.join(TMP, 'room.tok'), '--member-token-file', path.join(TMP, 'Agent.tok'), '--name', 'Agent',
  '--state-dir', path.join(TMP, 'state-' + tag), '--max-wakes-per-min', '0', ...Object.entries(extra).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, String(v)])),
]));
const modeClaude = (extra = {}, tag) => mkCfg({ mode: 'claude-code', 'session-id': 'sess-1', 'claude-bin': process.execPath, 'claude-args': `"${fake}"`, ...extra }, tag);

describe('watcher contre un vrai hub (DB temporaire)', () => {
  before(async () => {
    assert.ok(TMP.startsWith(os.tmpdir()));
    await startHub();
    roomToken = (await api('/api/rooms', 'POST', { name: 'salon-test' })).room_token;
    for (const n of ['Agent', 'Humain', 'Pair']) {
      tokens[n] = (await api(`/api/rooms/${roomToken}/join`, 'POST', { name: n, role: n === 'Humain' ? 'human' : 'agent' })).member_token;
      fs.writeFileSync(path.join(TMP, `${n}.tok`), `member_token=${tokens[n]}\n`);
    }
    fs.writeFileSync(path.join(TMP, 'room.tok'), roomToken);
    await unread('Agent'); // purge le backlog (joins)
    const m = await unread('Agent');
    if (m.length) await api(`/api/rooms/${roomToken}/ack`, 'POST', { up_to_id: m.at(-1).id }, tokens.Agent);
  });
  after(async () => { if (hub && hub.exitCode === null) await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

  test('claude-code : réveil < 5 s, --resume, stdin, ack après succès, regroupement, retry après échec', async () => {
    // claude-bin = node ; args = fake script ; on vérifie surtout que --resume/-p sont passés derrière
    const cfg = modeClaude({}, 'cc');
    cfg.claudeArgs = `"${fake}"`;
    // le faux binaire reçoit : fake.mjs -p --resume sess-1 ... : on met le script AVANT via claudeBin wrapper
    const wrapper = path.join(TMP, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(wrapper, process.platform === 'win32' ? `@"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    cfg.claudeBin = wrapper; cfg.claudeArgs = '--permission-mode acceptEdits';
    resetCalls();
    const logs = [];
    const w = new Watcher(cfg, { log: (l) => logs.push(l) });
    await w.start();
    const t0 = Date.now();
    await post('Humain', 'premier message');
    await until(() => calls().length === 1, 8000);
    assert.ok(Date.now() - t0 < 5000);
    const c = calls()[0];
    assert.deepStrictEqual(c.argv.slice(0, 3), ['-p', '--resume', 'sess-1']);
    assert.ok(c.argv.includes('acceptEdits'));
    assert.match(c.stdin, /premier message/);
    await until(async () => (await unread('Agent')).length === 0);
    // son propre message ne réveille pas
    await post('Agent', 'message de moi');
    // échec : pas d'ack, ré-livraison
    fs.writeFileSync(path.join(TMP, 'FAIL'), '1');
    resetCalls();
    await post('Humain', 'doit etre rejoue');
    await until(() => calls().length >= 2, 8000);
    assert.equal((await unread('Agent')).length, 1, 'non acké après échec');
    fs.rmSync(path.join(TMP, 'FAIL'));
    await until(async () => (await unread('Agent')).length === 0, 10000);
    assert.ok(!calls().some((x) => x.stdin.includes('message de moi')));
    // regroupement : 3 messages pendant un tour lent => un seul tour suivant avec les 3
    fs.writeFileSync(path.join(TMP, 'SLOW'), '1');
    resetCalls();
    await post('Humain', 'lent');
    await until(() => calls().length === 1, 8000);
    await post('Humain', 'g1'); await post('Humain', 'g2'); await post('Humain', 'g3');
    await until(() => calls().length === 2, 10000);
    assert.match(calls()[1].stdin, /g1[\s\S]*g2[\s\S]*g3/);
    fs.rmSync(path.join(TMP, 'SLOW'));
    await until(async () => (await unread('Agent')).length === 0, 10000);
    // heartbeat + status
    assert.ok(statusOf(cfg.stateDir).ok);
    // verrou anti double instance
    const w2 = new Watcher(cfg, { log: () => {} });
    const lf = path.join(cfg.stateDir, 'watcher.lock');
    fs.writeFileSync(lf, String(process.ppid)); // pid vivant d'un autre processus
    assert.throws(() => w2.lock(), /already running/);
    fs.writeFileSync(lf, '999999'); // pid mort : verrou périmé ignoré
    w2.lock(); w2.unlock();
    fs.writeFileSync(lf, String(process.pid));
    await w.stop();
    assert.ok(!fs.existsSync(path.join(cfg.stateDir, 'watcher.lock')));
    assert.ok(!statusOf(cfg.stateDir).ok, 'arrêté => KO');
    const joined = logs.join('\n');
    assert.ok(!joined.includes(tokens.Agent) && !joined.includes(roomToken), 'aucun token dans les logs');
  });

  test('--only-mentions : @Nom et réponse seulement ; mode file ; mode exec', async () => {
    const inbox = path.join(TMP, 'inbox');
    const cfg = mkCfg({ mode: 'file', inbox, 'only-mentions': true }, 'file');
    const w = new Watcher(cfg, { log: () => {} });
    await w.start();
    const mine = await post('Agent', 'ma question');
    await post('Humain', 'bavardage sans mention');
    await post('Humain', 'salut @Agent regarde');
    await until(() => fs.existsSync(inbox) && fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).length === 1, 8000);
    await post('Pair', 'je reponds', { reply_to: mine.id });
    await until(() => fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).length === 2, 8000);
    const texts = fs.readdirSync(inbox).map((f) => fs.readFileSync(path.join(inbox, f), 'utf8')).join('');
    assert.ok(!texts.includes('bavardage'));
    await until(async () => (await unread('Agent')).length === 0);
    await w.stop();
    // exec
    const out = path.join(TMP, 'exec.out');
    const cmd = `"${process.execPath}" -e "require('fs').appendFileSync(process.argv[1], process.env.HUB_WATCH_COUNT+':'+require('fs').readFileSync(0,'utf8').length+'\\n')" "${out}"`;
    const w3 = new Watcher(mkCfg({ mode: 'exec', exec: cmd }, 'exec'), { log: () => {} });
    await w3.start();
    await post('Humain', 'pour exec');
    await until(() => fs.existsSync(out), 8000);
    await until(async () => (await unread('Agent')).length === 0);
    await w3.stop();
  });

  test('le kit suit la politique de réveil du hub (agent sans mention : non par défaut, oui avec all)', async () => {
    const inbox = path.join(TMP, 'inbox-policy');
    const w = new Watcher(mkCfg({ mode: 'file', inbox }, 'policy'), { log: () => {} });
    await w.start();
    const files = () => (fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => f.endsWith('.json')) : []);
    await post('Pair', 'agent sans mention (defaut)');
    await post('Humain', 'humain: reveille');
    await until(() => files().length === 1, 8000);
    assert.ok(!fs.readdirSync(inbox).map((f) => fs.readFileSync(path.join(inbox, f), 'utf8')).join('').includes('agent sans mention'));
    const set = await api('/api/members/wake-policy', 'POST', { policy: 'all' }, tokens.Agent);
    assert.equal(set.policy, 'all');
    await post('Pair', 'agent apres policy all');
    await until(() => files().length === 2, 8000);
    await api('/api/members/wake-policy', 'POST', { policy: 'humans+mentions' }, tokens.Agent);
    await until(async () => (await unread('Agent')).length === 0);
    await w.stop();
  });

  test('reconnexion après redémarrage du hub + arrêt propre SIGTERM (processus réel)', async () => {
    resetCalls();
    const inbox = path.join(TMP, 'inbox2');
    const p = spawn(process.execPath, [path.resolve(import.meta.dirname, '../client/hub-watch.mjs'), 'run', '--url', BASE,
      '--room-token-file', path.join(TMP, 'room.tok'), '--member-token-file', path.join(TMP, 'Agent.tok'), '--name', 'Agent',
      '--mode', 'file', '--inbox', inbox, '--state-dir', path.join(TMP, 'state-proc')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    await until(() => /watcher started/.test(out), 8000);
    await stopHub(); await startHub();
    await new Promise((r) => setTimeout(r, 1500));
    await post('Humain', 'apres redemarrage');
    await until(() => fs.existsSync(inbox) && fs.readdirSync(inbox).length >= 1, 20000);
    const code = await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); });
    assert.equal(code, 0);
    assert.ok(!out.includes(tokens.Agent) && !out.includes(roomToken));
  });

  test('unités : install (3 OS), splitArgs, shouldWake, sdk refusé', async () => {
    for (const o of ['linux', 'windows', 'macos']) {
      const s = generateService(o, ['--url', 'https://hub.example.org', '--name', 'Agent'], { node: '/usr/bin/node', script: '/opt/hub-watch.mjs', home: '/home/user' });
      assert.ok(s.content.includes('hub.example.org') && s.install.length > 20);
    }
    assert.match(generateService('linux', ['--x'], { node: 'n', script: 's' }).content, /Restart=always/);
    assert.match(generateService('windows', ['--x'], { node: 'n', script: 's' }).content, /Register-ScheduledTask/);
    assert.match(generateService('macos', ['--x'], { node: 'n', script: 's' }).content, /KeepAlive/);
    assert.deepStrictEqual(splitArgs('--a "b c" d'), ['--a', 'b c', 'd']);
    const cfg = { name: 'Agent', onlyMentions: false };
    assert.equal(await shouldWake({ id: 1, content: 'x', author: 'Agent' }, cfg, async () => false), false);
    assert.equal(await shouldWake({ id: 1, content: 'x', author: 'Auto-ack' }, cfg, async () => false), false);
    assert.equal(await shouldWake({ id: 1, content: 'x', author: 'Humain' }, cfg, async () => false), true);
    const r = await new Promise((res) => { const p = spawn(process.execPath, [path.resolve(import.meta.dirname, '../client/hub-watch.mjs'), 'run', '--mode', 'sdk', '--url', BASE, '--room-token-file', path.join(TMP, 'room.tok')]); let e = ''; p.stderr.on('data', (d) => { e += d; }); p.on('close', (c) => res({ c, e })); });
    assert.equal(r.c, 2); assert.match(r.e, /hub-session-runner/);
  });
});
