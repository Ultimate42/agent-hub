import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseWorkerTokens, parseWorkerMembers } from '../src/config.js';

const PORT = '4149';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-transcribe-lb-'));
const LEGACY = 'legacy-transcribe-secret-0123456789';
const PC = 'dev-box-worker-secret-0123456789';

let hubProcess, roomToken, aliceToken;

async function json(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function postVoice(name = 'voice.ogg') {
  const up = await fetch(`${BASE_URL}/api/rooms/${roomToken}/files?filename=${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'audio/ogg' }, body: Buffer.from('OggS fake')
  }).then(r => r.json());
  return (await json(`/api/rooms/${roomToken}/messages`, { method: 'POST', token: aliceToken, body: { attachments: [up.id] } })).data;
}

const history = async () => (await json(`/api/rooms/${roomToken}/messages/history`, { token: aliceToken })).data.messages;
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('Transcription load balancing (worker identity, min_age, failures, shadow)', () => {
  before(async () => {
    hubProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db'),
        HUB_TRANSCRIBE_TOKEN: LEGACY, HUB_TRANSCRIBE_WORKER_TOKENS: `dev-box:${PC}, junk, x:short`,
        HUB_TRANSCRIBE_WORKER_MEMBERS: 'Claude-Helper@1:dev-box, Bad Entry, NoRoom:w'
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }
    roomToken = (await json('/api/rooms', { method: 'POST', body: { name: 'Voice' } })).data.room_token;
    aliceToken = (await json(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Alice', role: 'human' } })).data.member_token;
  });

  after(() => {
    hubProcess?.kill('SIGTERM');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('parseWorkerTokens keeps valid name:token pairs only', () => {
    assert.deepStrictEqual(parseWorkerTokens('a:0123456789abcdef, bad, b:short, c d:0123456789abcdef'),
      [{ name: 'a', token: '0123456789abcdef' }]);
    assert.deepStrictEqual(parseWorkerTokens(undefined), []);
  });

  test('parseWorkerMembers keeps Member@room:worker entries only', () => {
    assert.deepStrictEqual(parseWorkerMembers('Claude-Helper@12:dev-box, nocolon, :x, A B@2:w2, NoRoom:w, X@y:z'),
      [{ member: 'Claude-Helper', roomId: 12, name: 'dev-box' }, { member: 'A B', roomId: 2, name: 'w2' }]);
  });

  test('member token of a listed member acts as its worker; other members refused', async () => {
    const del = (await json(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Claude-Helper', role: 'agent' } })).data.member_token;
    assert.strictEqual((await json('/api/transcriptions/next?worker=spoof', { token: del })).status, 204);
    assert.strictEqual((await json('/api/transcriptions/next', { token: aliceToken })).status, 403);
    const { data } = await json('/api/transcriptions/workers', { token: del });
    const names = data.workers.map(w => w.name);
    assert.ok(names.includes('dev-box'));
    assert.ok(!names.includes('spoof'));
    // same name in another room (anyone can create a room): refused
    const other = (await json('/api/rooms', { method: 'POST', body: { name: 'Other' } })).data.room_token;
    const fake = (await json(`/api/rooms/${other}/join`, { method: 'POST', body: { name: 'Claude-Helper', role: 'agent' } })).data.member_token;
    assert.strictEqual((await json('/api/transcriptions/next', { token: fake })).status, 403);
  });

  test('per-worker token works, legacy token stays valid, others refused', async () => {
    assert.strictEqual((await json('/api/transcriptions/next', { token: PC })).status, 204);
    assert.strictEqual((await json('/api/transcriptions/next?worker=vps', { token: LEGACY })).status, 204);
    assert.strictEqual((await json('/api/transcriptions/next', { token: 'nope' })).status, 403);
    assert.strictEqual((await json('/api/transcriptions/workers')).status, 403);
  });

  test('hub remembers the last poll per worker (token name wins over announced name)', async () => {
    await json('/api/transcriptions/next?worker=spoof', { token: PC });
    const { data } = await json('/api/transcriptions/workers', { token: LEGACY });
    const byName = Object.fromEntries(data.workers.map(w => [w.name, w]));
    assert.ok(byName['dev-box'] && byName.vps);
    assert.ok(!byName.spoof);
    assert.ok(byName['dev-box'].age_s <= 2);
    assert.strictEqual(byName['dev-box'].shadow, false);
  });

  test('min_age leaves fresh notes to the preferred worker, then lets the fallback take them', async () => {
    const msg = await postVoice();
    const id = msg.attachments[0].id;
    assert.strictEqual((await json('/api/transcriptions/next?worker=vps&min_age=2', { token: LEGACY })).status, 204);
    await sleep(2100);
    const job = await json('/api/transcriptions/next?worker=vps&min_age=2', { token: LEGACY });
    assert.strictEqual(job.data.id, id);
    await json(`/api/transcriptions/${id}`, { method: 'POST', token: LEGACY, body: { text: 'ok' } });
    const pcJob = await json('/api/transcriptions/next', { token: PC });
    assert.strictEqual(pcJob.status, 204);
  });

  test('preferred worker claims immediately without min_age', async () => {
    const msg = await postVoice('b.ogg');
    const job = await json('/api/transcriptions/next', { token: PC });
    assert.strictEqual(job.data.id, msg.attachments[0].id);
    await json(`/api/transcriptions/${job.data.id}`, { method: 'POST', token: PC, body: { text: 'bonjour' } });
  });

  test('permanent failure leaves a trace: attachment field, workers endpoint, no message', async () => {
    const msg = await postVoice('bad.ogg');
    const id = msg.attachments[0].id;
    for (let i = 0; i < 3; i++) {
      const job = await json('/api/transcriptions/next', { token: PC });
      assert.strictEqual(job.data.id, id);
      await json(`/api/transcriptions/${id}`, { method: 'POST', token: PC, body: { error: `boom ${i}` } });
    }
    const att = (await history()).find(m => m.id === msg.id).attachments[0];
    assert.strictEqual(att.transcript_status, 'failed');
    assert.strictEqual(att.transcript_error, 'dev-box: boom 2');
    const { data } = await json('/api/transcriptions/workers', { token: PC });
    assert.strictEqual(data.failed_jobs[0].id, id);
    assert.strictEqual(data.failed_jobs[0].error, 'dev-box: boom 2');
    assert.ok(!(await history()).some(m => m.reply_to === msg.id), 'nothing posted for a failure');
  });

  test('shadow mode: re-transcribes finished notes, stores the text aside, posts nothing', async () => {
    // cursor starts at the newest finished note: first poll sees nothing
    assert.strictEqual((await json('/api/transcriptions/next?shadow=1', { token: PC })).status, 204);
    const msg = await postVoice('s.ogg');
    const id = msg.attachments[0].id;
    // not finished yet: nothing to shadow, and a shadow poll never claims the real job
    assert.strictEqual((await json('/api/transcriptions/next?shadow=1', { token: PC })).status, 204);
    const real = await json('/api/transcriptions/next?worker=vps', { token: LEGACY });
    assert.strictEqual(real.data.id, id);
    await json(`/api/transcriptions/${id}`, { method: 'POST', token: LEGACY, body: { text: 'texte de référence' } });

    const sh = await json('/api/transcriptions/next?shadow=1', { token: PC });
    assert.strictEqual(sh.data.id, id);
    assert.strictEqual(sh.data.shadow, true);
    const before = (await history()).length;
    await json(`/api/transcriptions/${id}?shadow=1`, { method: 'POST', token: PC, body: { text: 'texte du pc' } });
    assert.strictEqual((await history()).length, before, 'no message posted');
    assert.strictEqual((await json('/api/transcriptions/next?shadow=1', { token: PC })).status, 204, 'offered once');

    const att = (await history()).find(m => m.id === msg.id).attachments[0];
    assert.strictEqual(att.transcript, 'texte de référence');
    const { data } = await json('/api/transcriptions/workers', { token: PC });
    assert.deepStrictEqual(
      [data.shadows[0].worker, data.shadows[0].shadow_text, data.shadows[0].reference_text],
      ['dev-box', 'texte du pc', 'texte de référence']);
    assert.strictEqual(data.workers.find(w => w.name === 'dev-box').shadow, true);
  });
});
