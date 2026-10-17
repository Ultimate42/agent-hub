import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4131';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-reply-to-${process.pid}-${Date.now()}.db`);

let serverProcess;
let roomToken;
let member1Token;
let member2Token;
let messageId1;

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

describe('Reply-to validation (FOREIGN KEY fix)', () => {
  before(async () => {
    // Record stat before test
    try {
      const stat = fs.statSync('/opt/ia-projects/projects/agent-hub/data/hub.db');
      global.prodDbSizeBefore = stat.size;
      global.prodDbMtimeBefore = stat.mtimeMs;
    } catch {
      global.prodDbSizeBefore = null;
      global.prodDbMtimeBefore = null;
    }

    // Start server
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: TEST_DB_PATH },
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    await waitForServer();
    console.log('Server started for reply-to validation tests');
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Wait a bit for clean shutdown
      await new Promise(r => setTimeout(r, 500));
    }
    // Clean up test DB files
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}

    // Verify production DB unchanged
    if (global.prodDbSizeBefore !== null) {
      const stat = fs.statSync('/opt/ia-projects/projects/agent-hub/data/hub.db');
      assert.strictEqual(stat.size, global.prodDbSizeBefore, 'Production hub.db size changed!');
      assert.strictEqual(stat.mtimeMs, global.prodDbMtimeBefore, 'Production hub.db modified!');
    }
  });

  test('Setup: create room', async () => {
    const { status, data } = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Reply Test Room' })
    });
    assert.strictEqual(status, 201);
    roomToken = data.room_token;
  });

  test('Setup: join member 1', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent1' })
    });
    assert.strictEqual(status, 201);
    member1Token = data.member_token;
  });

  test('Setup: join member 2', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent2' })
    });
    assert.strictEqual(status, 201);
    member2Token = data.member_token;
  });

  test('Setup: post initial message', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'First message' })
    });
    assert.strictEqual(status, 201);
    assert.ok(data.id);
    messageId1 = data.id;
  });

  test('HTTP: reply_to with inexistent ID returns 400, not 500', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        content: 'Reply to non-existent',
        reply_to: 999999
      })
    });
    assert.strictEqual(status, 400, `Expected 400 but got ${status}: ${JSON.stringify(data)}`);
    assert.strictEqual(data.error, 'reply_to not found');
  });

  test('HTTP: reply_to from other room is rejected', async () => {
    // Create another room
    const { data: room2Data } = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Other Room' })
    });
    const otherRoomToken = room2Data.room_token;

    // Join with same member
    const { data: joinData } = await request(`/api/rooms/${otherRoomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent1' })
    });
    const otherMemberToken = joinData.member_token;

    // Try to reply to a message from the first room
    const { status, data } = await request(`/api/rooms/${otherRoomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${otherMemberToken}` },
      body: JSON.stringify({
        content: 'Try cross-room reply',
        reply_to: messageId1
      })
    });
    assert.strictEqual(status, 400);
    assert.strictEqual(data.error, 'reply_to not found');
  });

  test('HTTP: valid reply_to succeeds', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        content: 'Valid reply',
        reply_to: messageId1
      })
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(data.reply_to, messageId1);
  });

  test('HTTP: message without reply_to still works', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Normal message' })
    });
    assert.strictEqual(status, 201);
    assert.ok(data.reply_to === null || data.reply_to === undefined);
  });

  test('MCP: reply_to with inexistent ID returns error message', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: {
          name: 'post_message',
          arguments: {
            member_token: member1Token,
            content: 'MCP reply to non-existent',
            reply_to: 999999
          }
        }
      })
    });
    assert.strictEqual(status, 200);
    // MCP returns result with isError: true and error message
    assert.ok(data.result.isError === true);
    assert.ok(data.result.content[0].text.includes('reply_to not found'));
  });

  test('MCP: valid reply_to succeeds', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'post_message',
          arguments: {
            member_token: member2Token,
            content: 'MCP valid reply',
            reply_to: messageId1
          }
        }
      })
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.result.isError, undefined);
    const result = JSON.parse(data.result.content[0].text);
    assert.ok(result.success);
  });

  test('Check autoincrement did NOT skip on failed insert', async () => {
    // Post a normal message after the failed insert
    const { status: status1, data: data1 } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Test autoincrement' })
    });
    assert.strictEqual(status1, 201);
    const id1 = data1.id;

    // IDs should be sequential (no gaps from failed INSERT)
    const { status: status2, data: data2 } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Next message' })
    });
    assert.strictEqual(status2, 201);
    const id2 = data2.id;

    // id2 should be id1 + 1, no gaps
    assert.strictEqual(id2, id1 + 1, `IDs not sequential: ${id1} -> ${id2}`);
  });
});
