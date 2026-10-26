import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = '4149';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-actions-'));

let serverProcess;
let roomToken, alice, bob;

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* markdown */ }
  return { status: res.status, data, headers: res.headers };
}

const post = (token, body) => api(`/api/rooms/${roomToken}/messages`, { method: 'POST', token, body });

async function mcp(name, args) {
  const res = await fetch(BASE_URL + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  return (await res.json()).result;
}

describe('Edit, delete, reactions, search, export, live directive', () => {
  before(async () => {
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db') },
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    roomToken = (await api('/api/rooms', { method: 'POST', body: { name: 'Actions' } })).data.room_token;
    alice = (await api(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Alice' } })).data.member_token;
    bob = (await api(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Bob' } })).data.member_token;
  });

  after(() => {
    serverProcess?.kill('SIGTERM');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('edit: only the author, marked edited, visible in reads', async () => {
    const m = (await post(alice, { content: 'first draft' })).data;
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'PATCH', token: bob, body: { content: 'hack' } })).status, 403);
    const ok = await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'PATCH', token: alice, body: { content: 'final' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.content, 'final');
    assert.ok(ok.data.edited_at);
    const hist = await api(`/api/rooms/${roomToken}/messages/history`, { token: bob });
    const read = hist.data.messages.find(x => x.id === m.id);
    assert.strictEqual(read.content, 'final');
    assert.ok(read.edited_at);
    assert.strictEqual(read.deleted, undefined);
  });

  test('delete: soft delete, files removed, replies keep their parent', async () => {
    const up = await fetch(`${BASE_URL}/api/rooms/${roomToken}/files?filename=a.txt`, {
      method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'text/plain' }, body: 'bye'
    }).then(r => r.json());
    const m = (await post(alice, { content: 'secret', attachments: [up.id] })).data;
    const reply = (await post(bob, { content: 'noted', reply_to: m.id })).data;
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'DELETE', token: bob })).status, 403);
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'DELETE', token: alice })).status, 200);
    assert.strictEqual((await fetch(up.url)).status, 404);
    const hist = await api(`/api/rooms/${roomToken}/messages/history`, { token: bob });
    const gone = hist.data.messages.find(x => x.id === m.id);
    assert.strictEqual(gone.deleted, true);
    assert.strictEqual(gone.content, '');
    assert.strictEqual(gone.attachments, undefined);
    assert.strictEqual(hist.data.messages.find(x => x.id === reply.id).reply_to, m.id);
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'PATCH', token: alice, body: { content: 'x' } })).status, 400);
  });

  test('reactions toggle and are grouped per emoji', async () => {
    const m = (await post(alice, { content: 'deploy done' })).data;
    const url = `/api/rooms/${roomToken}/messages/${m.id}/reactions`;
    await api(url, { method: 'POST', token: alice, body: { emoji: '👍' } });
    const r = await api(url, { method: 'POST', token: bob, body: { emoji: '👍' } });
    assert.deepStrictEqual(r.data.reactions, [{ emoji: '👍', count: 2, members: ['Alice', 'Bob'] }]);
    const off = await api(url, { method: 'POST', token: bob, body: { emoji: '👍' } });
    assert.deepStrictEqual(off.data.reactions, [{ emoji: '👍', count: 1, members: ['Alice'] }]);
    assert.strictEqual((await api(url, { method: 'POST', token: bob, body: { emoji: 'a b' } })).status, 400);
    const hist = await api(`/api/rooms/${roomToken}/messages/history`, { token: bob });
    assert.strictEqual(hist.data.messages.find(x => x.id === m.id).reactions[0].count, 1);
  });

  test('search: case-insensitive, LIKE wildcards escaped, deleted excluded', async () => {
    await post(bob, { content: 'The Quarterly REPORT is ready' });
    await post(bob, { content: '100% sure' });
    const r = await api(`/api/rooms/${roomToken}/messages/search?q=quarterly report`, { token: alice });
    assert.strictEqual(r.data.messages.length, 1);
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/search?q=${encodeURIComponent('%')}`, { token: alice })).data.messages.length, 1);
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/search?q=secret`, { token: alice })).data.messages.length, 0);
    assert.strictEqual((await api(`/api/rooms/${roomToken}/messages/search?q=`, { token: alice })).status, 400);
  });

  test('export as Markdown and JSON', async () => {
    const md = await api(`/api/rooms/${roomToken}/export?format=md`, { token: alice });
    assert.strictEqual(md.status, 200);
    assert.match(md.headers.get('content-disposition'), /Actions\.md/);
    assert.match(md.data, /^# Actions/);
    assert.match(md.data, /\*\*Alice\*\* · #\d+ · .* · edited/);
    assert.match(md.data, /_\(message deleted\)_/);
    assert.match(md.data, /👍 1/);
    const json = await api(`/api/rooms/${roomToken}/export?format=json`, { token: alice });
    assert.strictEqual(json.data.room.name, 'Actions');
    assert.ok(json.data.messages.length >= 6);
    assert.strictEqual((await api(`/api/rooms/${roomToken}/export`, {})).status, 401);
  });

  test('directive changes and edits are pushed live on WebSocket', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${bob}`);
    const events = [];
    ws.on('message', d => events.push(JSON.parse(d.toString())));
    await new Promise(r => ws.on('open', r));
    await api(`/api/rooms/${roomToken}/directive`, { method: 'POST', token: alice, body: { content: 'Ship it' } });
    const m = (await post(alice, { content: 'v1' })).data;
    await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'PATCH', token: alice, body: { content: 'v2' } });
    await api(`/api/rooms/${roomToken}/messages/${m.id}/reactions`, { method: 'POST', token: bob, body: { emoji: '✅' } });
    await api(`/api/rooms/${roomToken}/messages/${m.id}`, { method: 'DELETE', token: alice });
    await new Promise(r => setTimeout(r, 300));
    ws.close();
    assert.ok(events.some(e => e.type === 'directive_updated' && e.directive === 'Ship it' && e.author === 'Alice'));
    assert.ok(events.some(e => e.type === 'message_updated' && e.message.id === m.id && e.message.content === 'v2'));
    assert.ok(events.some(e => e.type === 'reaction' && e.message_id === m.id && e.reactions[0].emoji === '✅'));
    assert.ok(events.some(e => e.type === 'message_deleted' && e.id === m.id));
  });

  test('MCP: edit_message, react, search_messages, export_conversation, delete_message', async () => {
    const m = (await post(alice, { content: 'mcp original' })).data;
    const ed = await mcp('edit_message', { member_token: alice, message_id: m.id, content: 'mcp edited' });
    assert.ok(!ed.isError, ed.content[0].text);
    assert.ok((await mcp('edit_message', { member_token: bob, message_id: m.id, content: 'no' })).isError);
    const re = await mcp('react', { member_token: bob, message_id: m.id, emoji: '👀' });
    assert.strictEqual(JSON.parse(re.content[0].text).reactions[0].emoji, '👀');
    const se = await mcp('search_messages', { member_token: bob, query: 'MCP EDITED' });
    assert.strictEqual(JSON.parse(se.content[0].text).messages[0].id, m.id);
    const ex = await mcp('export_conversation', { member_token: bob });
    assert.match(ex.content[0].text, /mcp edited/);
    const de = await mcp('delete_message', { member_token: alice, message_id: m.id });
    assert.ok(!de.isError);
  });
});
