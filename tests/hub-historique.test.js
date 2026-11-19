import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { search, createServer, defaultDir } from '../client/hub-historique.mjs';

// hub-historique: search in the private Claude Code transcripts of an agent.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
const L = (o) => JSON.stringify(o);
const u = (ts, text) => L({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const a = (ts, blocks) => L({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks } });
const big = L({ type: 'api-request-blob', message: { content: 'Plan credits 2430 ' + 'x'.repeat(2e6) } });
fs.writeFileSync(path.join(dir, 'old.jsonl'), [u('2026-01-10T16:00:00.000Z', 'My plan balance is 2430 credits out of 3000.'),
  a('2026-01-10T16:00:05.000Z', [{ type: 'thinking', thinking: 'Plan 2430 secret' }, { type: 'text', text: 'Noted.' }])].join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'current.jsonl'), [big, u('2026-03-19T11:00:00.000Z', 'Reminder: cancel the Plan later.'),
  a('2026-03-19T11:01:00.000Z', [{ type: 'tool_use', id: 't1', name: 'mcp__history__historique_chercher', input: { q: 'plan credits' } }]),
  L({ type: 'user', timestamp: '2026-03-19T11:01:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Plan credits themselves' }] } }),
  a('2026-03-19T11:02:00.000Z', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo plan' } }]),
  L({ type: 'user', timestamp: '2026-03-19T11:02:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'plan output é' }] } }),
  'broken line'].join('\n') + '\n');
const sub = path.join(dir, 'sess', 'subagents'); fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), u('2026-02-01T10:00:00.000Z', 'Sub-agent saw the Plan renewal.') + '\n');
const o = { dir };
const R = (ts, text) => u(ts, 'Visible words <system-reminder>\nhidden-reminder ' + text + '\n</system-reminder> end');

test('finds an old fact, accents and case ignored, without reasoning or request lines', async () => {
  const r = await search({ q: 'PLAN credits 2430' }, o);
  assert.equal(r.found, 1); assert.match(r.results[0].excerpt, /out of 3000/); assert.equal(r.results[0].when, '2026-01-10T16:00:00.000Z');
});
test('all words in the same message; newest first by default; depuis/jusqua filter', async () => {
  const r = await search({ q: 'plan' }, o);
  assert.deepEqual(r.results.map((x) => x.when.slice(0, 10)), ['2026-03-19', '2026-01-10']);
  assert.equal((await search({ q: 'plan', depuis: '2026-03-01' }, o)).found, 1);
  assert.equal((await search({ q: 'plan', jusqua: '2026-01-10' }, o)).found, 1);
  assert.equal((await search({ q: 'plan', depuis: '2026-03-19', jusqua: '2026-03-19' }, o)).found, 1);
  assert.equal((await search({ q: 'plan nothing' }, o)).found, 0);
});
test('ordre=oldest puts the origin first; max bounds the list and stays exact in both orders', async () => {
  const r = await search({ q: 'plan', ordre: 'oldest' }, o);
  assert.equal(r.results[0].when.slice(0, 10), '2026-01-10');
  assert.equal((await search({ q: 'plan', max: 1 }, o)).results[0].when.slice(0, 10), '2026-03-19');
  assert.equal((await search({ q: 'plan', max: 1, ordre: 'oldest' }, o)).results[0].when.slice(0, 10), '2026-01-10');
  await assert.rejects(search({ q: 'plan', ordre: 'x' }, o));
});
test('the search does not find itself (call and result), in both orders', async () => {
  for (const ordre of ['recent', 'oldest']) {
    const r = await search({ q: 'themselves', ordre, outils: true }, o); assert.equal(r.found, 0); assert.ok(r.note);
  }
  assert.equal((await search({ q: 'plan output', outils: true }, o)).found, 1); // another tool's result is searchable on request
});
test('sub-agent transcripts only on request', async () => {
  assert.ok(!(await search({ q: 'renewal' }, o)).found);
  assert.equal((await search({ q: 'renewal' }, { ...o, subagents: true })).found, 1);
});
test('time budget: announced stop with the point reached, never a block', async () => {
  const r = await search({ q: 'plan' }, { ...o, budgetMs: -1 }); assert.ok(r.truncated);
});
test('recent order keeps the newest when the budget expires inside one big file', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-big-'));
  const rows = []; for (let i = 0; i < 40000; i++) rows.push(u(new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), 'filler message number ' + i + ' ' + 'y'.repeat(200)));
  rows.push(u('2026-12-31T00:00:00.000Z', 'needle recent')); fs.writeFileSync(path.join(d, 'f.jsonl'), rows.join('\n') + '\n');
  const r = await search({ q: 'needle', max: 1 }, { dir: d, budgetMs: 8000 });
  assert.equal(r.found, 1); assert.ok(!r.truncated);
  const t0 = Date.now(); assert.equal((await search({ q: 'filler number 5', max: 3 }, { dir: d })).found, 3); assert.ok(Date.now() - t0 < 2000);
});
test('lines longer than a chunk are read whole, in both directions', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-long-'));
  const long = u('2026-05-01T00:00:00.000Z', 'start ' + 'é'.repeat(700000) + ' needle-long');
  fs.writeFileSync(path.join(d, 'f.jsonl'), [long, u('2026-05-02T00:00:00.000Z', 'tail')].join('\n'));
  for (const ordre of ['recent', 'oldest']) assert.equal((await search({ q: 'needle-long', ordre }, { dir: d })).found, 1);
});
test('missing folder: empty answer; empty q refused', async () => {
  assert.equal((await search({ q: 'plan' }, { dir: '/nonexistent' })).found, 0);
  await assert.rejects(search({ q: ' ' }, o));
});
test('default folder follows the Claude Code project naming', () => {
  assert.equal(defaultDir('/srv/my app/x', { CLAUDE_CONFIG_DIR: '/c' }), '/c/projects/-srv-my-app-x');
});
test('tool arguments and results are not searched by default, only with outils; system reminders never', async () => {
  assert.equal((await search({ q: 'plan output' }, o)).found, 0);
  assert.equal((await search({ q: 'echo plan' }, o)).found, 0);
  assert.equal((await search({ q: 'echo plan', outils: true }, o)).found, 1);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-rem-'));
  fs.writeFileSync(path.join(d, 'f.jsonl'), R('2026-04-01T00:00:00.000Z', 'secret-sauce') + '\n');
  assert.equal((await search({ q: 'secret-sauce' }, { dir: d })).found, 0);
  assert.equal((await search({ q: 'secret-sauce', outils: true }, { dir: d })).found, 0);
  assert.equal((await search({ q: 'visible words' }, { dir: d })).found, 1);
});
test('a huge line is not assembled in memory: bounded, skipped, neighbours still read, both directions', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-huge-'));
  const f = path.join(d, 'f.jsonl'), fd = fs.openSync(f, 'w');
  fs.writeSync(fd, u('2026-06-01T00:00:00.000Z', 'before needle-x') + '\n');
  fs.writeSync(fd, '{"type":"api-request","x":"'); const blk = 'z'.repeat(1 << 20);
  for (let i = 0; i < 40; i++) fs.writeSync(fd, blk); fs.writeSync(fd, '"}\n');
  fs.writeSync(fd, u('2026-06-03T00:00:00.000Z', 'after needle-x') + '\n'); fs.closeSync(fd);
  const base = process.memoryUsage().rss;
  for (const ordre of ['recent', 'oldest']) {
    const r = await search({ q: 'needle-x', ordre }, { dir: d }); assert.equal(r.found, 2);
  }
  assert.ok(process.memoryUsage().rss - base < 120e6, 'rss grew by ' + (process.memoryUsage().rss - base));
});
test('MCP stdio: initialize, tools/list, tools/call, over a real process', async () => {
  await mcpRoundTrip();
});
test('MCP stdio: robust to JSON that is not a request, client responses, and end of input', async () => {
  const bin = new URL('../client/hub-historique.mjs', import.meta.url).pathname;
  const run = (input) => new Promise((res) => { const p = spawn('node', [bin, '--dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] }); let o = '', e = '';
    p.stdout.on('data', (c) => o += c); p.stderr.on('data', (c) => e += c); p.on('close', (code) => res({ o, e, code })); p.stdin.end(input); });
  const r = await run('null\n123\n[1]\n{"jsonrpc":"2.0","id":9,"result":{}}\n{"jsonrpc":"2.0","id":5,"method":"ping"}\n');
  const lines = r.o.trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(r.code, 0); assert.equal(r.e, '');
  assert.deepEqual(lines.slice(0, 3).map((x) => x.error.code), [-32600, -32600, -32600]);
  assert.equal(lines.length, 4); assert.equal(lines[3].id, 5); // the client response got no answer
  // a request followed at once by the end of input is still answered (printf request | node ...)
  const q = await run(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'historique_chercher', arguments: { q: 'balance' } } }) + '\n');
  assert.equal(JSON.parse(JSON.parse(q.o).result.content[0].text).found, 1);
});
test('a file truncated during the read ends cleanly', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-trunc-')); const f = path.join(d, 'f.jsonl');
  fs.writeFileSync(f, u('2026-07-01T00:00:00.000Z', 'x'.repeat(600000) + ' needle-t') + '\n');
  const orig = fs.promises.open; let first = true;
  fs.promises.open = async (...a) => { const fh = await orig(...a); const rd = fh.read.bind(fh); fh.read = async (...r) => { if (first) { first = false; return rd(...r); } return { bytesRead: 0, buffer: r[0] }; }; return fh; };
  try { const r = await search({ q: 'needle-t' }, { dir: d }); assert.equal(r.found, 0); } finally { fs.promises.open = orig; }
});
async function mcpRoundTrip() {
  const p = spawn('node', [new URL('../client/hub-historique.mjs', import.meta.url).pathname, '--dir', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = []; let buf = ''; p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'historique_chercher', arguments: { q: 'balance' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'nope' });
  for (let i = 0; i < 100 && out.length < 4; i++) await new Promise((r) => setTimeout(r, 50));
  p.stdin.end();
  assert.equal(out.length, 4); out.sort((x, y) => x.id - y.id);
  assert.equal(out[0].result.protocolVersion, '2025-03-26');
  assert.equal(out[1].result.tools[0].name, 'historique_chercher');
  assert.equal(JSON.parse(out[2].result.content[0].text).found, 1);
  assert.equal(out[3].error.code, -32601);
}
