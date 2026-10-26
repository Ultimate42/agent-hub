#!/usr/bin/env node
// Transcription worker for Agent Hub: plugs an existing speech-to-text service into the hub.
// It claims voice messages from the hub, sends each file to YOUR service, and posts the text back.
// Zero dependencies (Node >= 20). The hub never loads a model itself.
//
// Required:
//   HUB_URL                 e.g. https://hub.example.com
//   HUB_TRANSCRIBE_TOKEN    same secret as the hub's HUB_TRANSCRIBE_TOKEN
// Then ONE of:
//   TRANSCRIBE_HTTP_URL     multipart POST of the audio file to your service, e.g.
//                           http://127.0.0.1:9000/v1/audio/transcriptions (OpenAI-compatible)
//                           http://127.0.0.1:8080/inference              (whisper.cpp server)
//     TRANSCRIBE_HTTP_FIELD       form field of the file (default "file")
//     TRANSCRIBE_HTTP_FIELDS      extra form fields as JSON, e.g. {"model":"whisper-1","language":"fr"}
//     TRANSCRIBE_HTTP_AUTH        value of the Authorization header, e.g. "Bearer sk-..."
//     TRANSCRIBE_HTTP_JSON_FIELD  field holding the text in a JSON response (default "text")
//     TRANSCRIBE_HTTP_BODY=path   instead of uploading, write the audio to a local file and POST
//                                 JSON {"path": "/tmp/..."} (for a service on the same host that
//                                 reads files, e.g. stt-server); extra TRANSCRIBE_HTTP_FIELDS are
//                                 merged into that JSON
//   TRANSCRIBE_CMD          shell command; the audio file path is "$1" (or {file}); stdout = text,
//                           e.g. TRANSCRIBE_CMD='my-whisper-client "$1"'
// Optional:
//   TRANSCRIBE_TIMEOUT_MS   per-file timeout (default 300000)

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HUB_URL = (process.env.HUB_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.HUB_TRANSCRIBE_TOKEN;
const HTTP_URL = process.env.TRANSCRIBE_HTTP_URL;
const CMD = process.env.TRANSCRIBE_CMD;
const TIMEOUT_MS = parseInt(process.env.TRANSCRIBE_TIMEOUT_MS || '300000', 10);

function log(msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));
}

/** Write the audio to a fresh temp dir; returns { file, cleanup }. */
function writeTemp(data, job, readableByOthers = false) {
  const dir = mkdtempSync(path.join(tempRoot(), 'hub-transcribe-'));
  const ext = path.extname(job.filename).replace(/[^.\w]/g, '') || '.audio';
  const file = path.join(dir, `audio${ext}`);
  writeFileSync(file, data);
  // A service running as another user must be able to read it
  if (readableByOthers) { chmodSync(dir, 0o755); chmodSync(file, 0o644); }
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tempRoot() {
  return process.env.TRANSCRIBE_TMP_DIR || tmpdir();
}

async function readText(res, env) {
  const body = await res.text();
  if (!res.ok) throw new Error(`service answered ${res.status}: ${body.slice(0, 200)}`);
  try {
    const json = JSON.parse(body);
    const text = json[env.TRANSCRIBE_HTTP_JSON_FIELD || 'text'];
    if (typeof text !== 'string') throw new Error('no text field in JSON response');
    return text;
  } catch (err) {
    if (err instanceof SyntaxError) return body; // plain-text response
    throw err;
  }
}

export async function transcribeHttp(data, job, env = process.env) {
  if (env.TRANSCRIBE_HTTP_BODY === 'path') {
    const { file, cleanup } = writeTemp(data, job, true);
    try {
      const res = await fetch(env.TRANSCRIBE_HTTP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.TRANSCRIBE_HTTP_AUTH ? { Authorization: env.TRANSCRIBE_HTTP_AUTH } : {})
        },
        body: JSON.stringify({ ...JSON.parse(env.TRANSCRIBE_HTTP_FIELDS || '{}'), path: file }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      return await readText(res, env);
    } finally {
      cleanup();
    }
  }

  const form = new FormData();
  form.append(env.TRANSCRIBE_HTTP_FIELD || 'file', new Blob([data], { type: job.mime_type }), job.filename);
  for (const [k, v] of Object.entries(JSON.parse(env.TRANSCRIBE_HTTP_FIELDS || '{}'))) form.append(k, String(v));
  const res = await fetch(env.TRANSCRIBE_HTTP_URL, {
    method: 'POST',
    body: form,
    headers: env.TRANSCRIBE_HTTP_AUTH ? { Authorization: env.TRANSCRIBE_HTTP_AUTH } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return readText(res, env);
}

export function transcribeCmd(data, job, cmd = CMD) {
  const { file, cleanup } = writeTemp(data, job);
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd.replaceAll('{file}', `"${file}"`), 'transcribe', file], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve(out);
      else reject(new Error(`command exited with ${code}: ${err.slice(0, 200)}`));
    });
  });
}

async function hub(p, options = {}) {
  return fetch(HUB_URL + p, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...options.headers }
  });
}

async function handle(job) {
  log('job claimed', { id: job.id, filename: job.filename, size: job.size, attempt: job.attempt });
  let result;
  try {
    const audio = await fetch(job.url);
    if (!audio.ok) throw new Error(`download failed: ${audio.status}`);
    const data = Buffer.from(await audio.arrayBuffer());
    const text = HTTP_URL ? await transcribeHttp(data, job) : await transcribeCmd(data, job);
    result = { text: text.trim() };
    log('job transcribed', { id: job.id, chars: result.text.length });
  } catch (err) {
    result = { error: err.message };
    log('job failed', { id: job.id, error: err.message });
  }
  const res = await hub(`/api/transcriptions/${job.id}`, { method: 'POST', body: JSON.stringify(result) });
  if (!res.ok) log('hub refused result', { id: job.id, status: res.status, body: await res.text() });
}

async function main() {
  if (!HUB_URL || !TOKEN || (!HTTP_URL && !CMD)) {
    console.error('Set HUB_URL, HUB_TRANSCRIBE_TOKEN and TRANSCRIBE_HTTP_URL or TRANSCRIBE_CMD (see header).');
    process.exit(1);
  }
  log('worker started', { hub: HUB_URL, mode: HTTP_URL ? 'http' : 'cmd' });
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  while (!stopping) {
    try {
      const res = await hub('/api/transcriptions/next?wait=25');
      if (res.status === 200) {
        await handle(await res.json());
      } else if (res.status !== 204) {
        log('hub error', { status: res.status, body: (await res.text()).slice(0, 200) });
        await new Promise(r => setTimeout(r, 10000));
      }
    } catch (err) {
      log('hub unreachable', { error: err.message });
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  log('worker stopped');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
