import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4160';
const MEM_PORT = 4161;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `hub-test-archiviste-hint-${process.pid}-${Date.now()}.db`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TREE = 'sport\n blessures\n  genou_gauche(1)\n  epaule_droite(7)\n profil\n  force(2)\n  suivi(1)\n objectifs(1)\nprofil\n objectifs(3)\nnutrition\n aliments(66)\n';

let hub, memServer, memBodies = [], procs = [];

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); }
  throw new Error('timeout until()');
}

describe('Archiviste [Categorie] -> hint', () => {
  before(async () => {
    memServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        if (req.method === 'GET' && req.url === '/tree/coach') { res.setHeader('Content-Type', 'text/plain'); return res.end(TREE); }
        const j = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/write') { memBodies.push(j); res.end(JSON.stringify({ success: true, memory_id: 1 })); }
        else res.end(JSON.stringify({ result: 'ok' }));
      });
    }).listen(MEM_PORT);
    hub = spawn('node', ['src/index.js'], { env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB }, stdio: 'pipe' });
    await until(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, 20000);
  });
  after(() => {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    hub?.kill('SIGTERM');
    memServer?.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
  });

  test('maps labels to existing paths, falls back to label, keeps plain notes unchanged', async () => {
    const room = (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Hint test' }) })).data;
    await api(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: JSON.stringify({ name: 'Archiviste' }) });
    const tok = (await api(`/api/rooms/${room.room_token}/join`, { method: 'POST', body: JSON.stringify({ name: 'Claude (Coach sport)' }) })).data.member_token;
    const say = (c) => api(`/api/rooms/${room.room_token}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify({ content: c, type: 'message' }) });
    await say('warmup');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastProcessedMessageId: 0, welcomedAt: new Date().toISOString() }));
    for (const c of ['retiens: [Genou gauche] douleur', 'retiens: [Charges actuelles mi-octobre 2026] squat 100',
      'retiens: [Sommeil] 7h', 'retiens: [Objectifs] x', 'retiens: sans categorie']) await say(c);
    const p = spawn('node', ['archiviste/archiviste.js'], {
      env: { ...process.env, ROOM_TOKEN: room.room_token, AGENT_HUB_URL: BASE, MEMORY_API_URL: `http://localhost:${MEM_PORT}`, ARCHIVISTE_STATE_DIR: dir },
      stdio: 'pipe',
    });
    procs.push(p); if (process.env.DBG) { p.stdout.on("data", d => process.stderr.write(d)); p.stderr.on("data", d => process.stderr.write(d)); }
    await until(() => memBodies.length >= 5);
    const by = (txt) => memBodies.find(b => b.content.description.includes(txt));
    assert.strictEqual(by('douleur').hint, 'sport/blessures/genou_gauche');
    assert.strictEqual(by('douleur').path, undefined);
    assert.strictEqual(by('squat 100').hint, 'sport/profil/force');
    assert.strictEqual(by('7h').hint, 'Sommeil');
    assert.strictEqual(by('x').hint, 'sport/objectifs');
    assert.strictEqual(by('sans categorie').hint, undefined);
    assert.ok(by('sans categorie').path);
    p.kill('SIGTERM');
  });
});
