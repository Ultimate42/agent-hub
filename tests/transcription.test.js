import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { transcribeCmd, transcribeHttp } from '../scripts/transcribe-worker.mjs';

const PORT = '4148';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-transcribe-'));
const WORKER_TOKEN = 'test-transcribe-secret-0123456789';

let hubProcess, workerProcess, fakeWhisper, whisperPort;
let roomToken, aliceToken;
const received = [];

async function json(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function postVoice(bytes = Buffer.from('OggS fake voice'), name = 'voice.ogg') {
  const up = await fetch(`${BASE_URL}/api/rooms/${roomToken}/files?filename=${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'audio/ogg' }, body: bytes
  }).then(r => r.json());
  return (await json(`/api/rooms/${roomToken}/messages`, { method: 'POST', token: aliceToken, body: { attachments: [up.id] } })).data;
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('timeout');
}

describe('Voice transcription via external worker', () => {
  before(async () => {
    // Fake speech-to-text service (multipart in, JSON {text} out)
    fakeWhisper = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: ' Bonjour les agents ' }));
      });
    });
    await new Promise(r => fakeWhisper.listen(0, r));
    whisperPort = fakeWhisper.address().port;

    hubProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: path.join(TMP_DIR, 'hub.db'), HUB_TRANSCRIBE_TOKEN: WORKER_TOKEN },
      stdio: 'ignore'
    });
    await waitFor(async () => { try { return (await fetch(`${BASE_URL}/health`)).ok; } catch { return false; } });

    roomToken = (await json('/api/rooms', { method: 'POST', body: { name: 'Voice' } })).data.room_token;
    aliceToken = (await json(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Alice', role: 'human' } })).data.member_token;
  });

  after(() => {
    workerProcess?.kill('SIGKILL');
    hubProcess?.kill('SIGTERM');
    fakeWhisper?.close();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('worker API requires the worker token', async () => {
    assert.strictEqual((await json('/api/transcriptions/next')).status, 403);
    assert.strictEqual((await json('/api/transcriptions/next', { token: aliceToken })).status, 403);
    assert.strictEqual((await json('/api/transcriptions/next', { token: WORKER_TOKEN })).status, 204);
  });

  test('failed attempts are retried, then marked failed', async () => {
    const msg = await postVoice();
    const id = msg.attachments[0].id;
    assert.strictEqual(msg.attachments[0].transcript_status, 'pending');
    for (let i = 0; i < 3; i++) {
      const job = await json('/api/transcriptions/next', { token: WORKER_TOKEN });
      assert.strictEqual(job.data.id, id);
      assert.strictEqual(job.data.attempt, i + 1);
      await json(`/api/transcriptions/${id}`, { method: 'POST', token: WORKER_TOKEN, body: { error: 'boom' } });
    }
    assert.strictEqual((await json('/api/transcriptions/next', { token: WORKER_TOKEN })).status, 204);
    const hist = await json(`/api/rooms/${roomToken}/messages/history`, { token: aliceToken });
    assert.strictEqual(hist.data.messages.find(m => m.id === msg.id).attachments[0].transcript_status, 'failed');
  });

  test('worker transcribes a voice message and the text is posted as a reply', async () => {
    workerProcess = spawn('node', ['scripts/transcribe-worker.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_URL: BASE_URL,
        HUB_TRANSCRIBE_TOKEN: WORKER_TOKEN,
        TRANSCRIBE_HTTP_URL: `http://127.0.0.1:${whisperPort}/v1/audio/transcriptions`,
        TRANSCRIBE_HTTP_FIELDS: '{"model":"whisper-1","language":"fr"}',
        TRANSCRIBE_HTTP_AUTH: 'Bearer local-key'
      },
      stdio: 'ignore'
    });
    const msg = await postVoice();
    const reply = await waitFor(async () => {
      const h = await json(`/api/rooms/${roomToken}/messages/history`, { token: aliceToken });
      return h.data.messages.find(m => m.reply_to === msg.id);
    });
    assert.strictEqual(reply.author, 'Transcription');
    assert.strictEqual(reply.content, '🎙️ voice.ogg: Bonjour les agents');

    const h = await json(`/api/rooms/${roomToken}/messages/history`, { token: aliceToken });
    const att = h.data.messages.find(m => m.id === msg.id).attachments[0];
    assert.strictEqual(att.transcript_status, 'done');
    assert.strictEqual(att.transcript, 'Bonjour les agents');

    const sent = received.at(-1);
    assert.strictEqual(sent.auth, 'Bearer local-key');
    assert.match(sent.body, /name="model"\r\n\r\nwhisper-1/);
    assert.match(sent.body, /filename="voice.ogg"/);
    assert.match(sent.body, /OggS fake voice/);
  });

  test('"Transcription" is a reserved member name', async () => {
    assert.strictEqual((await json(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'transcription' } })).status, 400);
  });

  test('HTTP path mode posts {"path"} of a readable local file (stt-server style)', async () => {
    let seen;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        seen = JSON.parse(body);
        const st = fs.statSync(seen.path);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: fs.readFileSync(seen.path, 'utf8'), mode: (st.mode & 0o777).toString(8) }));
      });
    });
    await new Promise(r => srv.listen(0, r));
    const text = await transcribeHttp(Buffer.from('salut'), { filename: 'n.webm', mime_type: 'audio/webm' }, {
      TRANSCRIBE_HTTP_URL: `http://127.0.0.1:${srv.address().port}/transcribe`,
      TRANSCRIBE_HTTP_BODY: 'path',
      TRANSCRIBE_HTTP_FIELDS: '{"language":"fr"}'
    });
    srv.close();
    assert.strictEqual(text, 'salut');
    assert.strictEqual(seen.language, 'fr');
    assert.match(seen.path, /audio\.webm$/);
    assert.ok(!fs.existsSync(seen.path), 'temp file removed after transcription');
  });

  test('command mode passes the audio file path to the command', async () => {
    const text = await transcribeCmd(Buffer.from('abc'), { filename: 'v.webm' }, 'printf "%s|" "$(cat "$1")"; basename {file}');
    assert.strictEqual(text.trim(), 'abc|audio.webm');
  });
});
