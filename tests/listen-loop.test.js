import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { isMentioned } from '../src/utils/mentions.js';

const PORT = '4150';
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-${process.pid}-${Date.now()}-loop.db`);
let proc, roomToken;

async function rpc(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  const j = await res.json();
  return JSON.parse(j.result.content[0].text);
}
const text = async (p) => (await fetch(`${BASE}${p}`)).text();

describe('Listen loop wording', () => {
  before(async () => {
    proc = spawn('node', ['src/index.js'], {
      cwd: '/opt/ia-projects/projects/agent-hub',
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB },
      stdio: 'pipe'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    roomToken = (await rpc('create_room', { name: 'Loop' })).room_token;
  });
  after(() => {
    proc?.kill('SIGTERM');
    for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(DB + s); } catch {}
  });

  test('join_room and post_message end with next-step reminder', async () => {
    const j = await rpc('join_room', { room_token: roomToken, name: 'Claude (Santé)' });
    assert.match(j.next_step, /appelle wait_for_messages maintenant/);
    assert.match(j.loop_rule, /BOUCLE OBLIGATOIRE/);
    assert.strictEqual(Object.keys(j).pop(), 'next_step');
    const p = await rpc('post_message', { member_token: j.member_token, content: 'hi' });
    assert.match(p.next_step, /appelle wait_for_messages maintenant/);
  });

  test('wait_for_messages timeout tells to call again', async () => {
    const j = await rpc('join_room', { room_token: roomToken, name: 'Waiter' });
    const w = await rpc('wait_for_messages', { member_token: j.member_token, since: 999999, timeout: 600 });
    assert.deepStrictEqual(w.messages, []);
    assert.match(w.next_step, /Rappelle wait_for_messages immédiatement \(ne réponds pas à l'humain\)/);
  });

  test('wait_for_messages with messages tells to loop; timeout capped <= 50s', async () => {
    const a = await rpc('join_room', { room_token: roomToken, name: 'A1' });
    const b = await rpc('join_room', { room_token: roomToken, name: 'B1' });
    const wp = rpc('wait_for_messages', { member_token: b.member_token, timeout: 5000 });
    await new Promise(r => setTimeout(r, 300));
    await rpc('post_message', { member_token: a.member_token, content: 'yo' });
    const w = await wp;
    assert.ok(w.messages.length > 0);
    assert.match(w.next_step, /rappelle wait_for_messages/);
    const tools = (await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json()).result.tools;
    const wt = tools.find(t => t.name === 'wait_for_messages');
    assert.match(wt.description, /never answer the human|never end your turn/);
    assert.match(wt.description, /25 seconds/);
  });

  test('guides contain loop rule and presence guidance', async () => {
    for (const p of [`/r/${roomToken}/join.txt`, `/r/${roomToken}`, `/r/${roomToken}/setup?agent=claude-chat`, '/llms.txt']) {
      const t = await text(p);
      assert.ok(t.includes('BOUCLE OBLIGATOIRE'), p);
      assert.ok(t.includes('MANDATORY LOOP'), p);
      assert.ok(t.includes('same response') || t.includes('même réponse'), p);
    }
    const g = fs.readFileSync('/opt/ia-projects/projects/agent-hub/JOIN_GUIDE.txt', 'utf8');
    assert.ok(g.includes('BOUCLE OBLIGATOIRE'));
  });

  test('mentions with spaces/parentheses are detected', () => {
    assert.ok(isMentioned('Salut @Claude (Santé) ?', 'Claude (Santé)'));
    assert.ok(isMentioned('@Claude (Coach sport)', 'Claude (Coach sport)'));
    assert.ok(isMentioned('hey @archiviste.', 'Archiviste'));
    assert.ok(!isMentioned('@Archivistes', 'Archiviste'));
    assert.ok(!isMentioned('Claude (Santé)', 'Claude (Santé)'));
  });
});
