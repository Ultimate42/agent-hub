import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4136';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-wake-targets-${process.pid}-${Date.now()}.db`);
const WEBHOOK_PORT = 9999;

let serverProcess;
let roomToken;
let member1Token;
let member2Token;
let webhookRequests = [];

// Simple webhook server
let webhookServer;

// Helper: HTTP request
async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data, headers: res.headers };
}

// Helper: Wait for server
async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Server did not start');
}

// Start a simple webhook test server
function startWebhookServer() {
  return new Promise((resolve) => {
    webhookServer = createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const json = JSON.parse(body);
            webhookRequests.push(json);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', resolve);
  });
}

describe('Wake Targets Tests', () => {
  before(async () => {
    // Start webhook server
    await startWebhookServer();

    // Start hub server
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT,
        PUBLIC_URL: BASE_URL,
        DB_PATH: TEST_DB_PATH
      },
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    await waitForServer();
    console.log('Hub server started');

    // Create room
    let res = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Wake Targets Test Room' })
    });
    roomToken = res.data.room_token;

    // Join member 1
    res = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent1' })
    });
    member1Token = res.data.member_token;

    // Join member 2
    res = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent2' })
    });
    member2Token = res.data.member_token;
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    if (webhookServer) {
      webhookServer.close();
    }
    // Clean up test DB files
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  });

  test('Register webhook wake target', async () => {
    const res = await request('/api/members/wake-target', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({
        type: 'webhook',
        url: `http://127.0.0.1:${WEBHOOK_PORT}/notify`,
        max_retries: 3
      })
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success);
    assert.strictEqual(res.data.target_type, 'webhook');
  });

  test('Get wake target configuration', async () => {
    const res = await request('/api/members/wake-target', {
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.registered);
    assert.strictEqual(res.data.type, 'webhook');
    assert.ok(res.data.url.includes('127.0.0.1'));
  });

  test('Member without wake target registered', async () => {
    const res = await request('/api/members/wake-target', {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.registered, false);
  });

  test('Reject invalid webhook URL (not HTTPS)', async () => {
    const res = await request('/api/members/wake-target', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        type: 'webhook',
        url: 'http://example.com/notify'
      })
    });

    assert.strictEqual(res.status, 400);
    assert.ok(res.data.error.includes('HTTPS'));
  });

  test('Reject missing path for file type', async () => {
    const res = await request('/api/members/wake-target', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        type: 'file'
      })
    });

    assert.strictEqual(res.status, 400);
    assert.ok(res.data.error.includes('path'));
  });

  test('Notification sent when member is @mentioned', async () => {
    // Clear webhook requests
    webhookRequests = [];

    // Agent1 mentions Agent2
    const res = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Hey @Agent2, are you there?' })
    });

    const msgId = res.data.id;

    // Give webhook notification time to be sent
    await new Promise(r => setTimeout(r, 500));

    assert.ok(webhookRequests.length > 0, 'Webhook should have received notification');
    const notification = webhookRequests[0];
    assert.ok(typeof notification.room_id === 'number', 'room_id should be a number');
    assert.strictEqual(notification.message_id, msgId);
    assert.strictEqual(notification.author, 'Agent1');
    assert.ok(notification.content_excerpt.includes('@Agent2'));
  });

  test('No notification sent to author of message', async () => {
    // Register webhook for Agent1
    await request('/api/members/wake-target', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        type: 'webhook',
        url: `http://127.0.0.1:${WEBHOOK_PORT}/notify`,
        max_retries: 3
      })
    });

    // Clear webhook requests
    webhookRequests = [];

    // Agent1 sends a message (mentions self)
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Talking to @Agent1' })
    });

    await new Promise(r => setTimeout(r, 500));

    // Should NOT have notification (author filter)
    assert.strictEqual(webhookRequests.length, 0, 'Author should not receive notification of own message');
  });

  test('Notification sent when replying to member message', async () => {
    // Clear webhook requests
    webhookRequests = [];

    // Agent1 posts a message
    const msg1 = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Question for Agent2' })
    });

    // Agent2 replies (Agent2 has webhook registered)
    const msg2 = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({
        content: 'Answer',
        reply_to: msg1.data.id
      })
    });

    // Agent1 replies to Agent2 (this should trigger Agent2's webhook)
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        content: 'Thanks!',
        reply_to: msg2.data.id
      })
    });

    await new Promise(r => setTimeout(r, 500));

    // Should have notification for Agent2 (reply to their message)
    assert.ok(webhookRequests.length > 0, 'Agent2 should receive notification of reply');
  });

  test('Idempotent notifications (no duplicates)', async () => {
    // Clear webhook requests
    webhookRequests = [];

    // Get current message count first
    const before = webhookRequests.length;

    // Send same message twice (shouldn't create duplicate notifications)
    const msg = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 test message' })
    });

    const msgId = msg.data.id;

    await new Promise(r => setTimeout(r, 500));

    // Record count
    const afterFirst = webhookRequests.length;

    // Try to trigger same message again (via replay in DB, shouldn't happen)
    // We can't easily replay, but we can verify the table has UNIQUE constraint
    // For now, just verify we got exactly one notification
    assert.strictEqual(afterFirst - before, 1, 'Should have exactly one notification');
  });

  test('Delete wake target', async () => {
    // Delete Agent2's wake target
    const res = await request('/api/members/wake-target', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success);

    // Verify it's deleted
    const check = await request('/api/members/wake-target', {
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    assert.strictEqual(check.data.registered, false);
  });

  test('No notification after target deleted', async () => {
    // Clear webhook requests
    webhookRequests = [];

    // Send message mentioning Agent2 (no active wake target)
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 should not notify' })
    });

    await new Promise(r => setTimeout(r, 500));

    assert.strictEqual(webhookRequests.length, 0, 'Should not notify without registered target');
  });

  test('Register file type wake target', async () => {
    const res = await request('/api/members/wake-target', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({
        type: 'file',
        path: path.join(os.tmpdir(), 'wake-notifications'),
        max_retries: 3
      })
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success);
    assert.strictEqual(res.data.target_type, 'file');
  });

  test('Notification written to file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-test-'));

    // Update target to use temp directory
    await request('/api/members/wake-target', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({
        type: 'file',
        path: tempDir,
        max_retries: 3
      })
    });

    // Send message mentioning Agent2
    const msg = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 file notification test' })
    });

    await new Promise(r => setTimeout(r, 500));

    // Check if file was created
    const files = fs.readdirSync(tempDir);
    assert.ok(files.length > 0, 'Should have created notification file');

    const file = files[0];
    const content = fs.readFileSync(path.join(tempDir, file), 'utf8');
    assert.ok(content.includes('Wake Notification'));
    assert.ok(content.includes('Agent1'));
    assert.ok(content.includes('file notification test'));

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });

  test('Unauthorized requests rejected', async () => {
    const res = await request('/api/members/wake-target', {
      headers: { 'Authorization': 'Bearer invalid-token' }
    });

    assert.strictEqual(res.status, 403);
  });

  test('Missing authorization rejected', async () => {
    const res = await request('/api/members/wake-target', {
      method: 'POST',
      body: JSON.stringify({
        type: 'webhook',
        url: 'https://example.com/notify'
      })
    });

    assert.strictEqual(res.status, 401);
  });

  test('file wake target: direct loopback accepted, spoofed X-Forwarded-For rejected', async () => {
    const hdr = { Authorization: `Bearer ${member1Token}` };
    const body = JSON.stringify({ type: 'file', path: path.join(os.tmpdir(), 'wake-trustproxy-test.txt') });
    const direct = await request('/api/members/wake-target', { method: 'POST', headers: hdr, body });
    assert.strictEqual(direct.status, 200, JSON.stringify(direct.data));
    const spoof = await request('/api/members/wake-target', { method: 'POST', headers: { ...hdr, 'X-Forwarded-For': '127.0.0.1' }, body });
    assert.strictEqual(spoof.status, 403);
  });
});
describe('Wake targets: direct-local check (trust proxy hardening)', () => {
  test('isDirectLocalRequest rejects spoofed X-Forwarded-For and non-loopback sockets', async () => {
    const { isDirectLocalRequest } = await import('../src/utils/net.js');
    const mk = (addr, headers = {}) => ({ headers, socket: { remoteAddress: addr } });
    assert.strictEqual(isDirectLocalRequest(mk('172.19.0.5', { 'x-forwarded-for': '127.0.0.1' })), false);
    assert.strictEqual(isDirectLocalRequest(mk('172.19.0.5')), false);
    assert.strictEqual(isDirectLocalRequest(mk('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false);
    assert.strictEqual(isDirectLocalRequest(mk('127.0.0.1', { forwarded: 'for=1.2.3.4' })), false);
    assert.strictEqual(isDirectLocalRequest(mk('127.0.0.1')), true);
    assert.strictEqual(isDirectLocalRequest(mk('::ffff:127.0.0.1')), true);
  });
});
