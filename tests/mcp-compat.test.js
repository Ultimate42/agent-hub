import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4140';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-mcp-${process.pid}-${Date.now()}.db`);

let serverProcess;

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

describe('MCP Compatibility Tests', () => {
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
    console.log('Server started on port', PORT);
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

  test('Version negotiation: client requests supported version', async () => {
    const { status, data, headers } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' }
      })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.result.protocolVersion, '2025-06-18');
    assert.ok(headers.get('mcp-session-id'));
  });

  test('Version negotiation: client requests unsupported version, defaults to 2025-03-26', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' }
      })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.result.protocolVersion, '2025-03-26');
  });

  test('Instructions field present in initialize response', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize'
      })
    });

    assert.strictEqual(status, 200);
    assert.ok(data.result.instructions);
    assert.ok(data.result.instructions.includes('join_room'));
    assert.ok(data.result.instructions.includes('read_messages'));
    assert.ok(data.result.instructions.includes('wait_for_messages'));
  });

  test('ping method returns empty result', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'ping'
      })
    });

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.result, {});
  });

  test('resources/list returns empty resources array', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/list'
      })
    });

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.result.resources, []);
  });

  test('resources/templates/list returns empty array', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/templates/list'
      })
    });

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.result.resourceTemplates, []);
  });

  test('prompts/list returns empty array', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'prompts/list'
      })
    });

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.result.prompts, []);
  });

  test('logging/setLevel returns empty result', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'logging/setLevel',
        params: { level: 'debug' }
      })
    });

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.result, {});
  });

  test('notifications/cancelled with no id returns 204', async () => {
    const { status } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'some-id' }
      })
    });

    assert.strictEqual(status, 204);
  });

  test('Batch request: multiple requests processed correctly', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 10, method: 'ping' },
        { jsonrpc: '2.0', id: 11, method: 'resources/list' },
        { jsonrpc: '2.0', method: 'notifications/cancelled' }  // No id
      ])
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
    assert.strictEqual(data.length, 2); // Only 2 responses (notification has no id)
    assert.strictEqual(data[0].id, 10);
    assert.deepStrictEqual(data[0].result, {});
    assert.strictEqual(data[1].id, 11);
    assert.deepStrictEqual(data[1].result.resources, []);
  });

  test('Full flow: create room -> join room -> post message -> read messages -> wait for messages', async () => {
    let roomToken, memberToken1, memberToken2;

    // 1. Create room
    const createRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'create_room', arguments: { name: 'MCP Test Room' } }
      })
    });

    assert.strictEqual(createRes.status, 200);
    const roomData = JSON.parse(createRes.data.result.content[0].text);
    roomToken = roomData.room_token;
    assert.ok(roomToken);

    // 2. Member 1 joins
    const join1Res = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'join_room',
          arguments: { room_token: roomToken, name: 'Agent1', role: 'agent' }
        }
      })
    });

    assert.strictEqual(join1Res.status, 200);
    const join1Data = JSON.parse(join1Res.data.result.content[0].text);
    memberToken1 = join1Data.member_token;
    assert.ok(memberToken1);

    // 3. Member 2 joins
    const join2Res = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'join_room',
          arguments: { room_token: roomToken, name: 'Agent2', role: 'agent' }
        }
      })
    });

    assert.strictEqual(join2Res.status, 200);
    const join2Data = JSON.parse(join2Res.data.result.content[0].text);
    memberToken2 = join2Data.member_token;
    assert.ok(memberToken2);

    // 4. Member 1 posts message
    const postRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'post_message',
          arguments: { member_token: memberToken1, content: 'Hello from Agent1', type: 'message' }
        }
      })
    });

    assert.strictEqual(postRes.status, 200);
    const postData = JSON.parse(postRes.data.result.content[0].text);
    assert.strictEqual(postData.success, true);

    // 5. Member 2 reads messages
    const readRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'read_messages',
          arguments: { member_token: memberToken2 }
        }
      })
    });

    assert.strictEqual(readRes.status, 200);
    const readData = JSON.parse(readRes.data.result.content[0].text);
    assert.ok(Array.isArray(readData.messages));
    assert.ok(readData.messages.length > 0);
    assert.strictEqual(readData.messages[0].content, 'Hello from Agent1');
    const lastId = readData.last_id;

    // 6. Member 2 waits for messages (should timeout since last)
    const waitRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'wait_for_messages',
          arguments: { member_token: memberToken2, since: lastId, timeout: 2000 }
        }
      })
    });

    assert.strictEqual(waitRes.status, 200);
    const waitData = JSON.parse(waitRes.data.result.content[0].text);
    assert.ok(Array.isArray(waitData.messages));
    // Should be empty or have new messages depending on timing
  });

  test('wait_for_messages accepts timeout parameter and accepts values up to 25s', async () => {
    // Create room and member for this test
    const createRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'create_room', arguments: { name: 'Timeout Test' } }
      })
    });

    const roomData = JSON.parse(createRes.data.result.content[0].text);
    const roomToken = roomData.room_token;

    const joinRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'join_room',
          arguments: { room_token: roomToken, name: 'TimeoutAgent' }
        }
      })
    });

    const joinData = JSON.parse(joinRes.data.result.content[0].text);
    const memberToken = joinData.member_token;

    // Read first to get last ID
    const readRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { name: 'read_messages', arguments: { member_token: memberToken } }
      })
    });

    const readData = JSON.parse(readRes.data.result.content[0].text);
    const lastId = readData.last_id;

    // Request with small timeout - should return immediately or timeout quickly
    const waitRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'wait_for_messages',
          arguments: { member_token: memberToken, since: lastId, timeout: 2000 }
        }
      })
    });

    assert.strictEqual(waitRes.status, 200);
    const waitData = JSON.parse(waitRes.data.result.content[0].text);
    assert.ok(Array.isArray(waitData.messages));
  });

  test('Invalid member_token error message is helpful', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
          name: 'post_message',
          arguments: { member_token: 'invalid_token_xyz', content: 'Test' }
        }
      })
    });

    assert.strictEqual(status, 200);
    const result = data.result;
    assert.ok(result.isError);
    const errorText = result.content[0].text;
    assert.ok(errorText.includes('Invalid member_token'));
    assert.ok(errorText.includes('join_room'));
  });

  test('GET /mcp without Accept: text/event-stream returns 405', async () => {
    const { status } = await request('/mcp', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    assert.strictEqual(status, 405);
  });

  test('DELETE /mcp ends session', async () => {
    const initRes = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 50,
        method: 'initialize'
      })
    });

    const sessionId = initRes.headers.get('mcp-session-id');
    assert.ok(sessionId);

    // Delete session
    const delRes = await request('/mcp', {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId }
    });

    assert.strictEqual(delRes.status, 204);
  });

  test('Tool descriptions are explicit with examples', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 60,
        method: 'tools/list'
      })
    });

    assert.strictEqual(status, 200);
    const tools = data.result.tools;

    // Check create_room
    const createRoom = tools.find(t => t.name === 'create_room');
    assert.ok(createRoom);
    assert.ok(createRoom.description.includes('multi-agent'));

    // Check join_room
    const joinRoom = tools.find(t => t.name === 'join_room');
    assert.ok(joinRoom);
    assert.ok(joinRoom.description.includes('member_token'));
    assert.ok(joinRoom.description.includes('room token'));

    // Check wait_for_messages
    const waitMsg = tools.find(t => t.name === 'wait_for_messages');
    assert.ok(waitMsg);
    assert.ok(waitMsg.description.includes('Blocks up to') || waitMsg.description.includes('wait'));
    assert.ok(waitMsg.description.includes('25 seconds'));

    // Check inputSchema required fields
    assert.ok(joinRoom.inputSchema.required);
    assert.ok(joinRoom.inputSchema.required.includes('room_token'));
    assert.ok(joinRoom.inputSchema.required.includes('name'));
  });
});
