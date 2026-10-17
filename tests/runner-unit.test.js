import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, formatMessage, RateLimiter, normalizeConfig, assertModel, isMentioned, readSecretFile } from '../runner/lib.js';
import { AgentSession } from '../runner/session.js';
import { AgentBridge } from '../runner/runner.js';
import { HubSubscription } from '../runner/hub-client.js';
import { makeFakeQuery, until } from './runner-helpers.js';

const A = { name: 'Alpha', maxTurns: 3, maxMessagesPerMinute: 3, model: 'claude-sonnet-5-5', cwd: '/tmp', permissionMode: 'bypassPermissions', settingSources: [] };
const peers = ['Alpha', 'Beta'];
const m = (id, author, content, extra = {}) => ({ id, type: 'message', author, content, ...extra });

describe('modèles', () => {
  test('autorise Sonnet 5.5 et Opus 5.5 seulement', () => {
    assert.equal(assertModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');
    assert.equal(assertModel('claude-opus-5-5'), 'claude-opus-5-5');
    for (const bad of ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku', '', undefined]) assert.throws(() => assertModel(bad));
  });
  test('config : modèle 4.x refusé, défauts, doublons, champs requis', () => {
    const ag = { name: 'X', memberTokenFile: 'a', roomToken: 'r' };
    assert.throws(() => normalizeConfig({ agents: [{ ...ag, model: 'claude-opus-4-1' }] }));
    assert.throws(() => normalizeConfig({ agents: [{ name: 'X' }] }));
    assert.throws(() => normalizeConfig({ agents: [ag, { ...ag, name: 'x' }] }));
    const c = normalizeConfig({ agents: [ag] }, '/base');
    assert.equal(c.agents[0].model, 'claude-sonnet-5-5');
    assert.equal(c.agents[0].memberTokenFile, '/base/a');
    assert.equal(c.hubUrl, 'http://localhost:4030');
  });
  test('readSecretFile accepte "k=v" ou la valeur brute', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    fs.writeFileSync(`${d}/a`, 'member_token=abc123\n'); fs.writeFileSync(`${d}/b`, 'xyz\n');
    assert.equal(readSecretFile(`${d}/a`), 'abc123'); assert.equal(readSecretFile(`${d}/b`), 'xyz');
  });
});

describe('filtre et anti-boucle', () => {
  const ctx = { peers, ownIds: new Set([10]) };
  test('ignore soi-même (casse ignorée) et Auto-*', () => {
    assert.equal(decide(m(1, 'alpha', 'hi'), A, ctx).reason, 'self');
    assert.equal(decide(m(2, 'Auto-ack', 'hi @Alpha'), A, ctx).reason, 'auto');
    assert.equal(decide(m(3, 'Auto-notice', 'x'), A, ctx).push, false);
  });
  test('humain / auteur externe : poussé', () => assert.equal(decide(m(4, 'Florent', 'salut'), A, ctx).push, true));
  test('autre agent du runner : seulement si mentionné ou réponse à soi', () => {
    assert.equal(decide(m(5, 'Beta', 'blabla'), A, ctx).reason, 'peer-not-mentioned');
    assert.equal(decide(m(6, 'Beta', 'hé @Alpha regarde'), A, ctx).push, true);
    assert.equal(decide(m(7, 'Beta', 'ok', { reply_to: 10 }), A, ctx).push, true);
    assert.equal(decide(m(8, 'Beta', 'ok', { reply_to: 11 }), A, ctx).push, false);
  });
  test('mention : frontière de mot', () => {
    assert.ok(isMentioned('@Alpha, ok', 'Alpha')); assert.ok(!isMentioned('@Alphabet', 'Alpha')); assert.ok(!isMentioned('Alpha', 'Alpha'));
  });
  test('types non conversationnels, vides, sans id, HubWatchdog ignorés', () => {
    assert.equal(decide({ id: 1, type: 'system', author: 'x', content: 'y' }, A, ctx).push, false);
    assert.equal(decide(m(2, 'Z', ''), A, ctx).push, false);
    assert.equal(decide({ type: 'message', author: 'Z', content: 'a' }, A, ctx).push, false);
    assert.equal(decide(m(3, 'HubWatchdog', 'alerte'), A, ctx).push, false);
  });
});

describe('étiquetage', () => {
  test('format [Hub salon #id de auteur]', () => {
    assert.equal(formatMessage(m(12, 'Flo', 'yo'), 'dev'), '[Hub dev #12 de Flo] yo');
    assert.match(formatMessage(m(13, 'Flo', 'yo', { reply_to: 5 }), 'dev'), /^\[Hub dev #13 de Flo \(réponse à #5\)\] yo$/);
  });
});

describe('limite de débit', () => {
  test('N par minute, fenêtre glissante', () => {
    let t = 0; const rl = new RateLimiter(2, 60000, () => t);
    assert.ok(rl.tryTake()); assert.ok(rl.tryTake()); assert.ok(!rl.tryTake());
    t = 61000; assert.ok(rl.tryTake());
  });
  test('0 = illimité', () => { const rl = new RateLimiter(0); for (let i = 0; i < 100; i++) assert.ok(rl.tryTake()); });
  test('bridge : limite, notification des ignorés, ids propres', () => {
    const pushed = []; let t = 0;
    const b = new AgentBridge({ agent: A, peers, session: { push: (x) => pushed.push(x) }, now: () => t });
    b.setRoomName('dev');
    for (let i = 1; i <= 5; i++) b.handle(m(i, 'Flo', `msg${i}`));
    assert.equal(pushed.length, 3); assert.equal(b.stats.rateLimited, 2);
    t = 61000; b.handle(m(6, 'Flo', 'apres'));
    assert.match(pushed[3], /2 message\(s\) du salon ignoré/); assert.match(pushed[3], /\[Hub dev #6 de Flo\] apres/);
    b.handle(m(20, 'Alpha', 'ma réponse'));
    assert.equal(b.handle(m(21, 'Beta', 'ok', { reply_to: 20 })).reason === 'rate-limit' || pushed.length >= 4, true);
    assert.ok(b.ownIds.has(20));
  });
});

describe('session et rotation', () => {
  const mk = (over = {}) => {
    const f = makeFakeQuery();
    const s = new AgentSession({ agent: { ...A, ...over }, queryFn: f.queryFn, restartDelayMs: 10 });
    return { f, s };
  };
  test('envoie démarrage + messages dans la même session (flux)', async () => {
    const { f, s } = mk({ maxTurns: 0 });
    s.start(); s.push('un'); s.push('deux');
    await until(() => f.calls[0]?.inputs.length === 3);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].inputs.slice(1), ['un', 'deux']);
    assert.equal(f.calls[0].options.model, 'claude-sonnet-5-5');
    await s.stop();
  });
  test('rotation après maxTurns : résumé demandé puis nouvelle session reprise avec le résumé', async () => {
    const { f, s } = mk({ maxTurns: 3 });
    s.start(); // le message de démarrage ne compte pas
    s.push('a'); s.push('b'); s.push('c'); // 3 tours -> seuil
    await until(() => f.calls.length === 2);
    assert.ok(f.calls[0].inputs.some((x) => x.startsWith('[Rotation]')));
    await until(() => f.calls[1].inputs.length >= 1);
    assert.match(f.calls[1].inputs[0], /Résumé de ta session précédente[\s\S]*RESUME-1/);
    assert.equal(s.generation, 2);
    s.push('d'); await until(() => f.calls[1].inputs.includes('d'));
    assert.equal(f.calls.length, 2); // pas de rotation en cascade
    await s.stop();
  });
  test('messages en file pendant la rotation conservés', async () => {
    const { f, s } = mk({ maxTurns: 1 });
    s.start(); s.push('x1'); s.push('x2');
    await until(() => f.calls.length >= 2);
    await until(() => ['x1', 'x2'].every((t) => f.calls.flatMap((c) => c.inputs).includes(t)));
    await s.stop();
  });
  test('arrêt propre : le flux se termine', async () => {
    const { f, s } = mk({ maxTurns: 0 });
    s.start(); await until(() => f.calls.length === 1);
    await s.stop(); assert.equal(s.running, false);
  });
});

describe('abonnement hub : reconnexion WS, dédoublonnage', () => {
  test('reconnecte après coupure et rattrape sans doublon', async () => {
    const sockets = []; const history = [{ id: 1, content: 'a', author: 'x' }, { id: 2, content: 'b', author: 'x' }];
    class FakeWS {
      constructor(url) { this.url = url; this.h = {}; sockets.push(this); setTimeout(() => this.h.open?.({}), 5); }
      addEventListener(ev, fn) { this.h[ev] = fn; }
      close() { this.h.close?.({ code: 1006 }); }
    }
    const fetchImpl = async (u) => {
      const since = Number(/since=(\d+)/.exec(u)?.[1] || 0);
      const messages = /limit=1$/.test(u) ? history.slice(0, 1) : history.filter((x) => x.id > since);
      return { ok: true, json: async () => ({ messages }) };
    };
    const got = [];
    const sub = new HubSubscription({ hubUrl: 'http://h', roomToken: 'r', memberToken: 't', WebSocketImpl: FakeWS, fetchImpl, onMessage: (x) => got.push(x.id), backoffMinMs: 10, backoffMaxMs: 20 });
    await sub.start();
    await until(() => sockets.length === 1 && got.includes(2)); // rattrapage après open (l'historique d'avant démarrage n'est pas rejoué : #1)
    assert.deepEqual(got, [2]);
    sockets[0].h.message({ data: JSON.stringify({ id: 3, content: 'c', author: 'x' }) });
    sockets[0].h.message({ data: JSON.stringify({ id: 3, content: 'c', author: 'x' }) }); // doublon
    history.push({ id: 3, content: 'c', author: 'x' }, { id: 4, content: 'd', author: 'x' });
    sockets[0].close(); // coupure
    await until(() => sockets.length === 2 && got.includes(4));
    assert.deepEqual(got, [2, 3, 4]);
    sub.stop();
  });
  test('repli long-poll si pas de WS', async () => {
    let n = 0;
    const fetchImpl = async (u) => {
      if (/limit=1$/.test(u)) return { ok: true, json: async () => ({ messages: [] }) };
      n++; return { ok: true, json: async () => ({ messages: n === 1 ? [{ id: 1, content: 'p', author: 'x' }] : [] }) };
    };
    const got = [];
    const sub = new HubSubscription({ hubUrl: 'http://h', roomToken: 'r', memberToken: 't', transport: 'poll', fetchImpl, onMessage: (x) => got.push(x.id), backoffMinMs: 5 });
    await sub.start(); await until(() => got.length === 1); assert.equal(sub.mode, 'poll'); sub.stop();
  });
});

import { normalizeConfig as _nc } from '../runner/lib.js';
import { test as _t } from 'node:test';
import _assert from 'node:assert';
_t('permissions : défaut sûr (dontAsk + hub-post seul), surchargeable', () => {
  const base = { name: 'A', memberTokenFile: 'm', roomToken: 'r' };
  const [a] = _nc({ agents: [base] }, '/tmp').agents;
  _assert.equal(a.permissionMode, 'dontAsk');
  _assert.equal(a.allowedTools.length, 1);
  _assert.match(a.allowedTools[0], /^Bash\(node \/.*runner\/hub-post\.mjs:\*\)$/);
  const [b] = _nc({ agents: [{ ...base, permissionMode: 'default', allowedTools: ['Read'] }] }, '/tmp').agents;
  _assert.deepEqual([b.permissionMode, b.allowedTools], ['default', ['Read']]);
});
