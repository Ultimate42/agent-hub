import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4130';
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-${process.pid}-${Date.now()}.db`);

let serverProcess;
let roomToken;
let adminToken;
let member1Token;
let member2Token;

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

describe('Agent Hub Integration Tests', () => {
  before(async () => {
    // Start server
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: TEST_DB_PATH },
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    await waitForServer();
    console.log('Server started');
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    // Clean up test DB files
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  });

  test('Health check', async () => {
    const { status, data } = await request('/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.status, 'ok');
  });

  test('Create room', async () => {
    const { status, data } = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Room' })
    });

    assert.strictEqual(status, 201);
    assert.ok(data.room_token);
    assert.ok(data.admin_token);
    assert.strictEqual(data.name, 'Test Room');
    assert.ok(data.url.includes(data.room_token));

    roomToken = data.room_token;
    adminToken = data.admin_token;
  });

  test('Join room - member 1', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent1', role: 'agent' })
    });

    assert.strictEqual(status, 201);
    assert.ok(data.member_token);
    assert.strictEqual(data.room_name, 'Test Room');

    member1Token = data.member_token;
  });

  test('Join room - member 2', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent2', role: 'agent' })
    });

    assert.strictEqual(status, 201);
    assert.ok(data.member_token);

    member2Token = data.member_token;
  });

  test('Post message', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Hello from Agent1!' })
    });

    assert.strictEqual(status, 201);
    assert.ok(data.id);
    assert.strictEqual(data.content, 'Hello from Agent1!');
    assert.strictEqual(data.author, 'Agent1');
  });

  test('Read messages', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.messages));
    assert.ok(data.messages.length > 0);
    assert.strictEqual(data.messages[0].content, 'Hello from Agent1!');
  });

  test('List members', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/members`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.members));
    assert.strictEqual(data.members.length, 2);
  });

  test('Set directive', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'This is the room directive' })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.directive, 'This is the room directive');
  });

  test('Invalid token rejected', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages`, {
      headers: { 'Authorization': 'Bearer invalid_token_here' }
    });

    assert.strictEqual(status, 403);
    assert.strictEqual(data.error, 'Invalid token');
  });

  test('MCP initialize', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {}
      })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.jsonrpc, '2.0');
    assert.strictEqual(data.id, 1);
    assert.ok(data.result.protocolVersion);
    assert.ok(data.result.serverInfo.name === 'agent-hub');
  });

  test('MCP tools/list', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      })
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.result.tools));
    assert.ok(data.result.tools.some(t => t.name === 'create_room'));
    assert.ok(data.result.tools.some(t => t.name === 'post_message'));
    assert.ok(data.result.tools.some(t => t.name === 'wait_for_messages'));
  });

  test('MCP tools/call - join_room', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'join_room',
          arguments: {
            room_token: roomToken,
            name: 'MCP Agent',
            role: 'agent'
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    assert.ok(data.result.content[0].text.includes('member_token'));
  });

  test('MCP tools/call - post_message', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'post_message',
          arguments: {
            member_token: member1Token,
            content: 'Hello from MCP!'
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    assert.ok(data.result.content[0].text.includes('success'));
  });

  test('MCP tools/call - read_messages', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'read_messages',
          arguments: {
            member_token: member1Token
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    const result = JSON.parse(data.result.content[0].text);
    assert.ok(Array.isArray(result.messages));
  });

  test('WebSocket communication', async () => {
    return new Promise((resolve, reject) => {
      const ws1 = new WebSocket(`${WS_URL}?token=${member1Token}`);
      const ws2 = new WebSocket(`${WS_URL}?token=${member2Token}`);

      let ws1Connected = false;
      let ws2Connected = false;
      let messageReceived = false;

      const checkDone = () => {
        if (ws1Connected && ws2Connected && messageReceived) {
          ws1.close();
          ws2.close();
          resolve();
        }
      };

      ws1.on('open', () => {
        ws1Connected = true;
        checkDone();
      });

      ws2.on('open', () => {
        ws2Connected = true;
        // Send message from ws2
        ws2.send(JSON.stringify({
          type: 'message',
          content: 'Hello via WebSocket!'
        }));
      });

      ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'message' && msg.content === 'Hello via WebSocket!') {
          messageReceived = true;
          checkDone();
        }
      });

      ws1.on('error', reject);
      ws2.on('error', reject);

      setTimeout(() => {
        ws1.close();
        ws2.close();
        reject(new Error('WebSocket test timeout'));
      }, 5000);
    });
  });

  test('Setup endpoint for claude-code', async () => {
    const { status, data } = await request(`/r/${roomToken}/setup?agent=claude-code`, {
      headers: { 'Accept': 'application/json' }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.title, 'Claude Code Setup');
    assert.ok(data.content.includes('claude mcp add'));
  });

  test('Setup endpoint for claude-chat', async () => {
    const { status, data } = await request(`/r/${roomToken}/setup?agent=claude-chat`, {
      headers: { 'Accept': 'application/json' }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.title, 'Claude Chat (Web) Setup');
    assert.ok(data.content.includes('cannot receive push'));
  });

  test('Long-poll returns immediately with new messages', async () => {
    // Post a message first
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Message for long-poll test' })
    });

    // Get last message ID
    const { data: msgsData } = await request(`/api/rooms/${roomToken}/messages`, {
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });
    const lastId = msgsData.last_id;

    // Post another message
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'New message after lastId' })
    });

    // Long-poll should return immediately
    const start = Date.now();
    const { status, data } = await request(`/api/rooms/${roomToken}/messages/wait?since=${lastId}&timeout=5000`, {
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    const elapsed = Date.now() - start;

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.messages));
    assert.ok(data.messages.length > 0);
    assert.ok(elapsed < 1000, 'Should return immediately when messages exist');
  });

  test('Delete room with admin token', async () => {
    // Create a new room to delete
    const { data: newRoom } = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'To Delete' })
    });

    const { status } = await request(`/api/rooms/${newRoom.room_token}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${newRoom.admin_token}` }
    });

    assert.strictEqual(status, 200);
  });

  test('Leave room', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/leave`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.success, true);
  });
});
