// Intégration : vrai hub sur DB TEMPORAIRE et port dédié, SDK simulé. Ne touche ni à la DB de prod ni au service agent-hub.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { normalizeConfig } from '../runner/lib.js';
import { Runner } from '../runner/runner.js';
import { makeFakeQuery, until } from './runner-helpers.js';

const PORT = '4187';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-it-'));
const DB = path.join(TMP, 'hub.db');
let hub, roomToken, tokens = {};

const api = async (p, method = 'GET', body, token) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const post = (who, content, extra = {}) => api(`/api/rooms/${roomToken}/messages`, 'POST', { content, ...extra }, tokens[who]);
const startHub = async () => {
  hub = spawn('node', ['src/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB }, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 15000);
};
const stopHub = () => new Promise((r) => { hub.once('exit', r); hub.kill('SIGTERM'); });
const flat = (calls) => calls.flatMap((c) => c.inputs).filter((x) => x.startsWith('[Hub'));

describe('runner contre un vrai hub (DB temporaire)', () => {
  before(async () => {
    assert.ok(DB.startsWith(os.tmpdir()));
    await startHub();
    roomToken = (await api('/api/rooms', 'POST', { name: 'salon-test' })).room_token;
    for (const n of ['Alpha', 'Beta', 'Humain']) {
      tokens[n] = (await api(`/api/rooms/${roomToken}/join`, 'POST', { name: n })).member_token;
      fs.writeFileSync(path.join(TMP, `${n}.tok`), `member_token=${tokens[n]}\n`);
    }
    fs.writeFileSync(path.join(TMP, 'room.tok'), roomToken);
  });
  after(async () => { if (hub && hub.exitCode === null) await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

  for (const transport of ['ws', 'poll']) {
    test(`transport ${transport} : étiquetage, filtre, anti-boucle, reconnexion, arrêt propre`, async () => {
      const mk = (name) => ({ name, memberTokenFile: `${name}.tok`, roomTokenFile: 'room.tok', systemPrompt: 'test', cwd: TMP, maxTurns: 0 });
      const cfg = normalizeConfig({ hubUrl: BASE, transport, agents: [mk('Alpha'), mk('Beta')] }, TMP);
      const fq = makeFakeQuery();
      const runner = new Runner(cfg, { queryFn: fq.queryFn, log: () => {} });
      await runner.start();
      await until(() => fq.calls.length === 2 && runner.subs.every((s) => s.started));
      await new Promise((r) => setTimeout(r, 300)); // WS connectée
      const tag = transport;
      const m1 = (await post('Humain', `bonjour ${tag}`)).id ?? (await api(`/api/rooms/${roomToken}/messages?limit=1`, 'GET', null, tokens.Humain)).messages.at(-1).id;
      await until(() => flat(fq.calls).filter((x) => x.includes(`bonjour ${tag}`)).length === 2);
      assert.ok(flat(fq.calls).some((x) => new RegExp(`^\\[Hub salon-test #\\d+ de Humain\\] bonjour ${tag}`).test(x)) || flat(fq.calls).some((x) => /^\[Hub \S+ #\d+ de Humain\]/.test(x)));
      // Alpha parle sans mentionner Beta -> Beta ne reçoit pas ; Alpha ne reçoit pas son propre message
      await post('Alpha', `note perso ${tag}`);
      // Alpha mentionne Beta -> Beta reçoit
      await post('Alpha', `@Beta ping ${tag}`);
      await until(() => flat(fq.calls).some((x) => x.includes(`@Beta ping ${tag}`)));
      const all = fq.calls.map((c) => c.inputs.filter((x) => x.startsWith('[Hub')));
      const betaIdx = runner.bridges.findIndex((b) => b.agent.name === 'Beta');
      const joined = (i) => all[i].join('\n');
      const betaCalls = betaIdx; // les sessions sont créées dans l'ordre Alpha, Beta
      assert.ok(joined(betaCalls).includes(`@Beta ping ${tag}`));
      assert.ok(!joined(betaCalls).includes(`note perso ${tag}`), 'Beta ne doit pas recevoir un message non mentionné d\'un autre agent');
      assert.ok(!joined(0).includes(`ping ${tag}`) && !joined(0).includes(`note perso ${tag}`), 'Alpha ne reçoit pas ses propres messages');
      assert.ok(!joined(0).includes('joined the room'));
      // Reconnexion : redémarrage du hub (même DB temporaire), message ensuite
      await stopHub(); await startHub();
      await new Promise((r) => setTimeout(r, 500));
      await post('Humain', `apres redemarrage ${tag}`);
      await until(() => flat(fq.calls).filter((x) => x.includes(`apres redemarrage ${tag}`)).length === 2, 20000);
      // Arrêt propre
      await runner.stop();
      assert.ok(runner.bridges.every((b) => b.session.running === false));
    });
  }
});
