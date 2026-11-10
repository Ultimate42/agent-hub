// Wake policy: pure rule (policy x human/agent author x mention x anti-loop) + API on a temporary DB.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { decideWake, agentStreak, normalizePolicy, effectivePolicy, WAKE_POLICIES } from '../src/wake-policy.js';
import { until } from './runner-helpers.js';

const me = { id: 1, name: 'Alice' };
const msg = (o = {}) => ({ author_id: 2, author: 'Bob', author_role: 'agent', content: 'hello', type: 'message', ...o });
const agentChat = (n) => Array.from({ length: n }, (_, i) => ({ author: i % 2 ? 'Bob' : 'Carl', author_role: 'agent', content: 'blah', type: 'message' }));
const run = (policy, m, extra = {}) => decideWake({ policy, member: me, message: m, ...extra });

describe('wake policy rule', () => {
  test('policy names and default', () => {
    assert.deepStrictEqual(WAKE_POLICIES, ['all', 'humans+mentions', 'mentions']);
    assert.strictEqual(effectivePolicy(null), 'humans+mentions');
    assert.strictEqual(normalizePolicy('ALL'), 'all');
    assert.strictEqual(normalizePolicy('nope'), null);
  });

  const cases = [
    // policy, author role, mention, expected wake
    ['all', 'human', false, true], ['all', 'human', true, true], ['all', 'agent', false, true], ['all', 'agent', true, true],
    ['humans+mentions', 'human', false, true], ['humans+mentions', 'human', true, true], ['humans+mentions', 'agent', false, false], ['humans+mentions', 'agent', true, true],
    ['mentions', 'human', false, false], ['mentions', 'human', true, true], ['mentions', 'agent', false, false], ['mentions', 'agent', true, true],
    [null, 'human', false, true], [null, 'agent', false, false]
  ];
  for (const [policy, role, mention, expected] of cases) {
    test(`${policy ?? 'default'} / ${role} / ${mention ? 'mention' : 'no mention'} -> ${expected}`, () => {
      const d = run(policy, msg({ author_role: role, content: mention ? 'salut @Alice' : 'salut' }));
      assert.strictEqual(d.wake, expected, JSON.stringify(d));
    });
  }

  test('own, system and non-chat messages never wake, whatever the policy', () => {
    assert.strictEqual(run('all', msg({ author_id: 1, author: 'Alice' })).reason, 'own');
    assert.strictEqual(run('all', msg({ author_id: null, author: 'alice' })).reason, 'own');
    for (const a of ['system', 'HubWatchdog', 'Transcription', 'Auto-x']) assert.strictEqual(run('all', msg({ author: a })).wake, false, a);
    assert.strictEqual(run('all', msg({ type: 'system' })).reason, 'not-chat');
  });

  test('reply to my message wakes; reply that names only others does not', () => {
    assert.strictEqual(run('mentions', msg({ reply_to_member_id: 1 })).wake, true);
    assert.strictEqual(run('mentions', msg({ reply_to_member_id: 1, content: 'ok @Carl' }), { memberNames: ['Alice', 'Carl'] }).wake, false);
    assert.strictEqual(run('mentions', msg({ reply_to_member_id: 3 })).wake, false);
  });

  test('mention matching is exact (no prefix match)', () => {
    assert.strictEqual(run('mentions', msg({ content: '@Alicexyz' })).wake, false);
    assert.strictEqual(run('mentions', msg({ content: '@alice,' })).wake, true);
  });
});

describe('anti-loop guard', () => {
  test('streak counts consecutive agent messages, stops at a human', () => {
    const recent = [...agentChat(3), { author: 'Flo', author_role: 'human', content: 'x' }, ...agentChat(10)];
    assert.strictEqual(agentStreak(msg(), me, recent, 99), 4);
  });
  test('streak stops at a message that mentions the member', () => {
    const recent = [...agentChat(2), { author: 'Bob', author_role: 'agent', content: '@Alice ping' }, ...agentChat(10)];
    assert.strictEqual(agentStreak(msg(), me, recent, 99), 3);
  });
  test("'all' wakes up to N agent messages then suspends (N=6)", () => {
    assert.strictEqual(run('all', msg(), { recent: agentChat(5), loopLimit: 6 }).wake, true);  // 6th
    const d = run('all', msg(), { recent: agentChat(6), loopLimit: 6 });                          // 7th
    assert.strictEqual(d.wake, false);
    assert.strictEqual(d.reason, 'loop-suspended');
  });
  test('N is configurable', () => {
    assert.strictEqual(run('all', msg(), { recent: agentChat(2), loopLimit: 3 }).wake, true);
    assert.strictEqual(run('all', msg(), { recent: agentChat(3), loopLimit: 3 }).wake, false);
  });
  test('a mention always wakes, even in a suspended loop', () => {
    assert.strictEqual(run('all', msg({ content: '@Alice?' }), { recent: agentChat(20), loopLimit: 6 }).wake, true);
  });
  test('a human message wakes and resumes agent wake-ups afterwards', () => {
    assert.strictEqual(run('all', msg({ author_role: 'human' }), { recent: agentChat(20) }).wake, true);
    const after = [{ author: 'Flo', author_role: 'human', content: 'go' }, ...agentChat(20)];
    assert.strictEqual(run('all', msg(), { recent: after, loopLimit: 6 }).wake, true);
  });
  test('system messages do not count in the streak', () => {
    const recent = [...agentChat(5).slice(0, 2), { author: 'HubWatchdog', author_role: 'observer', content: 'alert' }, ...agentChat(3)];
    assert.strictEqual(agentStreak(msg(), me, recent, 99), 6);
  });
  test('the guard only concerns the all policy', () => {
    assert.strictEqual(run('humans+mentions', msg(), { recent: agentChat(20) }).reason, 'policy');
  });
});

describe('wake policy API (temporary DB)', () => {
  const PORT = '4196';
  const BASE = `http://localhost:${PORT}`;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wakepol-'));
  let hub, roomToken; const tok = {};
  const api = async (p, method = 'GET', body, token) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const post = async (who, content) => (await api(`/api/rooms/${roomToken}/messages`, 'POST', { content }, tok[who])).body.id;
  const check = async (who, ids) => (await api(`/api/rooms/${roomToken}/wake-check`, 'POST', { message_ids: ids }, tok[who])).body;

  before(async () => {
    hub = spawn('node', ['src/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: path.join(TMP, 'hub.db'), HUB_WAKE_LOOP_LIMIT: '3' }, stdio: 'ignore' });
    await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 15000);
    roomToken = (await api('/api/rooms', 'POST', { name: 'wp' })).body.room_token;
    for (const [n, role] of [['Human', 'human'], ['Alice', 'agent'], ['Bob', 'agent'], ['Carl', 'agent']]) {
      tok[n] = (await api(`/api/rooms/${roomToken}/join`, 'POST', { name: n, role })).body.member_token;
    }
  });
  after(() => { hub?.kill('SIGTERM'); fs.rmSync(TMP, { recursive: true, force: true }); });

  test('default policy, change, validation, journal', async () => {
    let r = await api('/api/members/wake-policy', 'GET', null, tok.Alice);
    assert.strictEqual(r.body.policy, 'humans+mentions');
    assert.strictEqual(r.body.loop_limit, 3);
    r = await api('/api/members/wake-policy', 'POST', { policy: 'bogus' }, tok.Alice);
    assert.strictEqual(r.status, 400);
    r = await api('/api/members/wake-policy', 'PUT', { policy: 'all' }, tok.Alice);
    assert.strictEqual(r.body.policy, 'all');
    assert.strictEqual(r.body.history[0].old_policy, null);
    assert.strictEqual(r.body.history[0].new_policy, 'all');
    assert.strictEqual(r.body.history[0].changed_by, 'Alice');
    assert.strictEqual((await api('/api/members/wake-policy', 'GET', null, tok.Bob)).body.policy, 'humans+mentions'); // per member
    assert.strictEqual((await api('/api/members/wake-policy', 'GET')).status, 401);
  });

  test('wake-check applies the policy and the anti-loop guard', async () => {
    const h = await post('Human', 'bonjour');
    const a1 = await post('Bob', 'a'); const a2 = await post('Carl', 'b'); const a3 = await post('Bob', 'c'); const a4 = await post('Carl', 'd');
    const mention = await post('Bob', '@Alice un avis ?');
    const a5 = await post('Carl', 'e');
    const alice = await check('Alice', [h, a1, a2, a3, a4, mention, a5]);
    const w = Object.fromEntries(alice.decisions.map((d) => [d.id, d]));
    assert.strictEqual(w[h].reason, 'human');
    assert.strictEqual(w[a1].wake, true); assert.strictEqual(w[a2].wake, true); assert.strictEqual(w[a3].wake, true);
    assert.deepStrictEqual([w[a4].wake, w[a4].reason], [false, 'loop-suspended']);
    assert.strictEqual(w[mention].reason, 'mention');
    assert.strictEqual(w[a5].wake, true); // counter restarted at the mention
    // Bob keeps the default policy: agent messages without mention do not wake him
    const bob = await check('Bob', [a2, a4]);
    assert.ok(bob.decisions.every((d) => !d.wake));
    // a human message resumes everything
    const h2 = await post('Human', 'on reprend');
    const a6 = await post('Carl', 'f');
    assert.strictEqual((await check('Alice', [h2, a6])).decisions.every((d) => d.wake), true);
  });

  test('MCP tools get/set_wake_policy', async () => {
    const call = async (name, args) => (await api('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
    const set = await call('set_wake_policy', { member_token: tok.Carl, policy: 'mentions' });
    assert.ok(!set.isError, JSON.stringify(set));
    const got = JSON.parse((await call('get_wake_policy', { member_token: tok.Carl })).content[0].text);
    assert.strictEqual(got.policy, 'mentions');
    assert.ok((await call('set_wake_policy', { member_token: tok.Carl, policy: 'x' })).isError);
  });
});
