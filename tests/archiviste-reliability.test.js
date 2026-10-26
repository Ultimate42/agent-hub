import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4150';
const MEM_PORT = 4151;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-archiviste-${process.pid}-${Date.now()}.db`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let firstId = 0, hub, memServer, memDelay = 300, memWrites = [];
let memInFlight = 0, memMaxInFlight = 0; // concurrency seen by the memory service
const procs = [];

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(500); }
  throw new Error('timeout until()');
}

async function newRoom(authors) {
  const room = (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Archiviste test' }) })).data;
  const members = {};
  // Archiviste joins first: its server-side read cursor starts before the messages posted below
  await api(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: JSON.stringify({ name: 'Archiviste' }) });
  for (const a of authors) {
    members[a] = (await api(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: JSON.stringify({ name: a }) })).data.member_token;
  }
  return { room: room.room_token, members };
}
const say = (room, tok, content) => api(`/api/rooms/${room}/messages`, {
  method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify({ content, type: 'message' }),
});
async function listMsgs(room, tok) {
  return (await api(`/api/rooms/${room}/messages?limit=200`, { headers: { Authorization: `Bearer ${tok}` } })).data.messages;
}
function startArchiviste(room, stateDir, extraEnv = {}) {
  const p = spawn('node', ['archiviste/archiviste.js'], {
    env: { ...process.env, ROOM_TOKEN: room, AGENT_HUB_URL: BASE, MEMORY_API_URL: `http://localhost:${MEM_PORT}`, ARCHIVISTE_STATE_DIR: stateDir, ...extraEnv },
    stdio: 'pipe',
  });
  p.out = '';
  p.stdout.on('data', d => { p.out += d; });
  p.stderr.on('data', d => { p.out += d; });
  procs.push(p); if (process.env.DBG) p.stdout.on("data", d => process.stderr.write(d));
  return p;
}
const exited = (p) => new Promise(r => p.exitCode !== null ? r() : p.on('exit', r));
function seedState(dir, last) {
  last = last || firstId - 1;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastProcessedMessageId: last, welcomedAt: new Date().toISOString() }));
}
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

describe('Archiviste reliability', () => {
  before(async () => {
    memServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        memMaxInFlight = Math.max(memMaxInFlight, ++memInFlight);
        await sleep(memDelay);
        memInFlight--;
        const j = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/write') { memWrites.push(j.content.description); res.end(JSON.stringify({ success: true, memory_id: 1 })); }
        else res.end(JSON.stringify({ result: `trouvé: ${j.subject}` }));
      });
    }).listen(MEM_PORT);
    hub = spawn('node', ['src/index.js'], { env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB }, stdio: 'pipe' });
    await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 20000);
    // Make sure real ids are > 0 (since=0 means "no since" for the hub long-poll)
    const warm = await newRoom(['warm']);
    await say(warm.room, warm.members.warm, 'warmup');
    firstId = 2; // ids of later messages are >= 2
  });

  after(() => {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    hub?.kill('SIGTERM');
    memServer?.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
  });

  test('concurrent processing, ordered replies, authors with spaces/parentheses', async () => {
    memDelay = 400; memWrites = []; memMaxInFlight = 0;
    const { room, members } = await newRoom(['Claude (Santé)', 'Claude (Coach sport)']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    seedState(dir, 0);
    const toks = Object.values(members);
    for (let i = 0; i < 6; i++) await say(room, toks[i % 2], `retiens: note ${i}`);
    await say(room, toks[0], 'cherche: rotule');
    const t0 = Date.now();
    const p = startArchiviste(room, dir);
    await until(async () => (await listMsgs(room, toks[0])).filter(m => m.author === 'Archiviste').length >= 7);
    const elapsed = Date.now() - t0;
    // Measured at the memory service, not by wall time (a loaded host makes timings unreliable)
    assert.ok(memMaxInFlight >= 2, `expected concurrent processing, max in-flight ${memMaxInFlight} (took ${elapsed}ms)`);
    const replies = (await listMsgs(room, toks[0])).filter(m => m.author === 'Archiviste').map(m => m.content);
    assert.deepStrictEqual(replies.slice(0, 6).map(r => r.match(/note (\d)/)?.[1]), ['0', '1', '2', '3', '4', '5']);
    assert.ok(replies[6].includes('trouvé: rotule'));
    assert.strictEqual(memWrites.length, 6);
    await until(() => readState(dir).lastProcessedMessageId > 0);
    const all = await listMsgs(room, toks[0]);
    assert.ok(readState(dir).lastProcessedMessageId >= Math.max(...all.filter(m => m.author !== 'Archiviste').map(m => m.id)));
    p.kill('SIGTERM'); await exited(p);
  });

  test('SIGTERM mid-message: not lost, not advanced, processed after restart', async () => {
    memDelay = 1500; memWrites = [];
    const { room, members } = await newRoom(['Claude (Santé)']);
    const tok = members['Claude (Santé)'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    seedState(dir, 0);
    const m = (await say(room, tok, 'retiens: test crash')).data;
    const id = m.id ?? m.message?.id;
    const p1 = startArchiviste(room, dir, { ARCHIVISTE_SHUTDOWN_GRACE_MS: '100' });
    await until(() => /Processing msg_id=/.test(p1.out));
    p1.kill('SIGTERM'); await exited(p1);
    const st = readState(dir);
    assert.ok(st.lastProcessedMessageId < (id ?? Infinity), 'must not advance past unfinished message');
    assert.strictEqual((await listMsgs(room, tok)).filter(x => x.author === 'Archiviste').length, 0);
    memDelay = 100;
    const p2 = startArchiviste(room, dir);
    await until(async () => (await listMsgs(room, tok)).some(x => x.author === 'Archiviste' && x.content.includes('test crash')));
    p2.kill('SIGTERM'); await exited(p2);
  });

  test('SIGTERM with grace: in-flight message finishes, is replied once and recorded', async () => {
    memDelay = 800; memWrites = [];
    const { room, members } = await newRoom(['Claude (Santé)']);
    const tok = members['Claude (Santé)'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    seedState(dir, 0);
    await say(room, tok, 'retiens: graceful');
    const p1 = startArchiviste(room, dir);
    await until(() => /Processing msg_id=/.test(p1.out));
    p1.kill('SIGTERM'); await exited(p1);
    const replies = (await listMsgs(room, tok)).filter(x => x.author === 'Archiviste');
    assert.strictEqual(replies.length, 1);
    assert.ok(readState(dir).writtenIds.length === 1);
    const p2 = startArchiviste(room, dir);
    await sleep(1500);
    p2.kill('SIGTERM'); await exited(p2);
    assert.strictEqual((await listMsgs(room, tok)).filter(x => x.author === 'Archiviste').length, 1, 'no duplicate reply');
    assert.strictEqual(memWrites.filter(w => w === 'graceful').length, 1, 'no duplicate write');
  });

  test('crash after write before reply: no duplicate write on retry', async () => {
    memDelay = 50; memWrites = [];
    const { room, members } = await newRoom(['Claude (Santé)']);
    const tok = members['Claude (Santé)'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const id = (await say(room, tok, 'retiens: idem')).data;
    const mid = id.id ?? id.message?.id;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastProcessedMessageId: 1, welcomedAt: 'x', writtenIds: [mid] }));
    const p = startArchiviste(room, dir);
    await until(async () => (await listMsgs(room, tok)).some(x => x.author === 'Archiviste'));
    assert.strictEqual(memWrites.length, 0);
    p.kill('SIGTERM'); await exited(p);
  });

  test('server read cursor: crash before ack -> redelivered even without local state; acked after reply', async () => {
    memDelay = 1500; memWrites = [];
    const { room, members } = await newRoom(['Claude (Santé)']);
    const tok = members['Claude (Santé)'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    seedState(dir, 0);
    await say(room, tok, 'retiens: avant ack');
    const p1 = startArchiviste(room, dir, { ARCHIVISTE_SHUTDOWN_GRACE_MS: '100' });
    await until(() => /Processing msg_id=/.test(p1.out));
    p1.kill('SIGTERM'); await exited(p1);
    const st = readState(dir);
    const arch = st.memberToken;
    const peek = async () => (await api(`/api/rooms/${room}/messages?auto_ack=false`, { headers: { Authorization: `Bearer ${arch}` } })).data;
    const before = await peek();
    assert.ok(before.messages.some(m => m.content.includes('avant ack')) && !before.history, 'still unread on the hub (not acked)');
    // lose the local watermark entirely: the hub cursor alone must redeliver
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...st, lastProcessedMessageId: null, doneIds: [], writtenIds: [] }));
    memDelay = 100;
    const p2 = startArchiviste(room, dir);
    await until(async () => (await listMsgs(room, tok)).some(x => x.author === 'Archiviste' && x.content.includes('avant ack')));
    await until(async () => { const a = await peek(); return a.history === true || a.messages.length === 0; }); // nothing unread left: acked
    p2.kill('SIGTERM'); await exited(p2);
  });
});
