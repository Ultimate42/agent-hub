import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';

const PORT = '4147';
const BASE_URL = `http://localhost:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-'));
const TEST_DB_PATH = path.join(TMP_DIR, 'hub.db');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let serverProcess;
let roomToken, adminToken, aliceToken, bobToken;

async function json(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

async function upload(filename, data, type, token = aliceToken) {
  const res = await fetch(`${BASE_URL}/api/rooms/${roomToken}/files?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body: data
  });
  return { status: res.status, data: await res.json() };
}

async function mcp(name, args) {
  const res = await fetch(BASE_URL + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  return (await res.json()).result;
}

describe('Shared files (attachments)', () => {
  before(async () => {
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: TEST_DB_PATH, HUB_MAX_FILE_SIZE: String(200 * 1024) },
      stdio: 'ignore'
    });
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    const room = await json('/api/rooms', { method: 'POST', body: { name: 'Files' } });
    roomToken = room.data.room_token;
    adminToken = room.data.admin_token;
    aliceToken = (await json(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Alice' } })).data.member_token;
    bobToken = (await json(`/api/rooms/${roomToken}/join`, { method: 'POST', body: { name: 'Bob' } })).data.member_token;
  });

  after(() => {
    serverProcess?.kill('SIGTERM');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('upload an image, attach it to a message, download it', async () => {
    const up = await upload('pixel.png', PNG, 'image/png');
    assert.strictEqual(up.status, 201);
    assert.strictEqual(up.data.mime_type, 'image/png');
    assert.strictEqual(up.data.size, PNG.length);
    assert.match(up.data.url, /\/files\/[A-Za-z0-9_-]+\/pixel\.png$/);

    const post = await json(`/api/rooms/${roomToken}/messages`, {
      method: 'POST', token: aliceToken, body: { content: 'look', attachments: [up.data.id] }
    });
    assert.strictEqual(post.status, 201);
    assert.strictEqual(post.data.attachments[0].id, up.data.id);

    const read = await json(`/api/rooms/${roomToken}/messages`, { token: bobToken });
    const msg = read.data.messages.find(m => m.id === post.data.id);
    assert.strictEqual(msg.attachments.length, 1);

    const dl = await fetch(msg.attachments[0].url);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.headers.get('content-type'), 'image/png');
    assert.match(dl.headers.get('content-disposition'), /^inline/);
    assert.deepStrictEqual(Buffer.from(await dl.arrayBuffer()), PNG);
  });

  test('message with only attachments (no text) is allowed', async () => {
    const up = await upload('beep.wav', Buffer.from('RIFF....WAVE'), 'audio/wav');
    const post = await json(`/api/rooms/${roomToken}/messages`, {
      method: 'POST', token: aliceToken, body: { attachments: [up.data.id] }
    });
    assert.strictEqual(post.status, 201);
    assert.strictEqual(post.data.content, '');
  });

  test('an attachment can only be used once, by its uploader', async () => {
    const up = await upload('a.txt', Buffer.from('hello'), 'text/plain');
    const byBob = await json(`/api/rooms/${roomToken}/messages`, {
      method: 'POST', token: bobToken, body: { content: 'steal', attachments: [up.data.id] }
    });
    assert.strictEqual(byBob.status, 400);
    const first = await json(`/api/rooms/${roomToken}/messages`, {
      method: 'POST', token: aliceToken, body: { content: 'x', attachments: [up.data.id] }
    });
    assert.strictEqual(first.status, 201);
    const again = await json(`/api/rooms/${roomToken}/messages`, {
      method: 'POST', token: aliceToken, body: { content: 'y', attachments: [up.data.id] }
    });
    assert.strictEqual(again.status, 400);
  });

  test('downloads support Range requests (Safari audio/video) and ETag', async () => {
    const data = Buffer.from('0123456789abcdefghij');
    const up = await upload('clip.mp3', data, 'audio/mpeg');
    const full = await fetch(up.data.url);
    assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(full.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(full.headers.get('cache-control'), 'private, max-age=86400');
    assert.ok(full.headers.get('etag'));

    const part = await fetch(up.data.url, { headers: { Range: 'bytes=5-9' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers.get('content-range'), `bytes 5-9/${data.length}`);
    assert.strictEqual(part.headers.get('content-length'), '5');
    assert.strictEqual(Buffer.from(await part.arrayBuffer()).toString(), '56789');

    // fetch() adds Cache-Control: no-cache to conditional requests, so use a raw request
    const status = await new Promise((resolve, reject) => {
      http.get(up.data.url, { headers: { 'If-None-Match': full.headers.get('etag') } }, r => { r.resume(); resolve(r.statusCode); })
        .on('error', reject);
    });
    assert.strictEqual(status, 304);
  });

  test('room gallery lists attached files, newest first, filtered by type', async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${roomToken}/files?type=image`, { headers: { Authorization: `Bearer ${bobToken}` } });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(data.files.length >= 1);
    assert.ok(data.files.every(f => f.mime_type.startsWith('image/')));
    assert.ok(data.files.every(f => f.author && f.message_id && f.url));
    const ids = data.files.map(f => f.id);
    assert.deepStrictEqual(ids, [...ids].sort((a, b) => b - a));
    assert.strictEqual((await fetch(`${BASE_URL}/api/rooms/${roomToken}/files`)).status, 401);
  });

  test('HTML/SVG are served as downloads, never inline', async () => {
    const up = await upload('evil.svg', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    const dl = await fetch(up.data.url);
    assert.strictEqual(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  });

  test('upload rejects bad token, missing filename and oversize files', async () => {
    assert.strictEqual((await upload('x.bin', Buffer.from('x'), 'application/octet-stream', 'nope')).status, 403);
    const noName = await fetch(`${BASE_URL}/api/rooms/${roomToken}/files`, {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` }, body: Buffer.from('x')
    });
    assert.strictEqual(noName.status, 400);
    assert.strictEqual((await upload('big.bin', Buffer.alloc(300 * 1024), 'application/octet-stream')).status, 413);
  });

  test('MCP: upload_file + post_message(attachments) + get_file', async () => {
    const up = await mcp('upload_file', { member_token: aliceToken, filename: 'chart.png', data_base64: PNG.toString('base64') });
    assert.ok(!up.isError, up.content[0].text);
    const file = JSON.parse(up.content[0].text);
    const post = await mcp('post_message', { member_token: aliceToken, content: 'chart', attachments: [file.id] });
    assert.ok(!post.isError, post.content[0].text);

    const got = await mcp('get_file', { member_token: bobToken, file_id: file.id });
    assert.strictEqual(got.content[1].type, 'image');
    assert.strictEqual(got.content[1].data, PNG.toString('base64'));

    const txt = await mcp('upload_file', { member_token: aliceToken, filename: 'notes.md', text: '# hi' });
    const txtId = JSON.parse(txt.content[0].text).id;
    const gotTxt = await mcp('get_file', { member_token: bobToken, file_id: txtId });
    assert.strictEqual(gotTxt.content[1].text, '# hi');
  });

  test('deleting the room removes its files', async () => {
    const up = await upload('gone.txt', Buffer.from('bye'), 'text/plain');
    const del = await json(`/api/rooms/${roomToken}`, { method: 'DELETE', token: adminToken });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await fetch(up.data.url)).status, 404);
  });
});

describe('Pending file sweeper', () => {
  test('deletes uploads never attached to a message, keeps attached ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sweep-'));
    process.env.DB_PATH = path.join(dir, 'hub.db');
    const { database } = await import('../src/db.js');
    const { storeFile, sweepPendingFiles, attachmentPath } = await import('../src/services/files.js');
    const roomId = Number(database.createRoom('sweepRoomToken', 'sweepAdminToken', 'S'));
    const memberId = Number(database.createMember(roomId, 'sweepMemberToken', 'M'));
    const member = database.getMemberByToken('sweepMemberToken');

    const pending = storeFile(member, { filename: 'p.txt', data: Buffer.from('p') }).attachment;
    const used = storeFile(member, { filename: 'u.txt', data: Buffer.from('u') }).attachment;
    const msgId = Number(database.createMessage(roomId, memberId, 'message', 'x'));
    database.linkAttachments(msgId, [used.id]);
    database.db.prepare(`UPDATE attachments SET created_at = datetime('now', '-2 days')`).run();

    const pendingPath = attachmentPath(database.getAttachmentById(pending.id));
    assert.strictEqual(sweepPendingFiles(24 * 3600 * 1000), 1);
    assert.strictEqual(database.getAttachmentById(pending.id), undefined);
    assert.ok(!fs.existsSync(pendingPath));
    assert.ok(fs.existsSync(attachmentPath(database.getAttachmentById(used.id))));
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
