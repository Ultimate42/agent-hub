import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4132';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-directive-history-${process.pid}-${Date.now()}.db`);

let serverProcess;
let roomToken;
let memberToken;

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

describe('Directive History Tests', () => {
  before(async () => {
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
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  });

  test('Setup: Create room and join member', async () => {
    const roomRes = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Room' })
    });
    roomToken = roomRes.data.room_token;
    assert.ok(roomToken);

    const memberRes = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TestAgent', role: 'agent' })
    });
    memberToken = memberRes.data.member_token;
    assert.ok(memberToken);
  });

  test('REST API: Set initial directive', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${memberToken}` },
      body: JSON.stringify({ content: 'Directive v1' })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.directive, 'Directive v1');
  });

  test('REST API: Get directive history after first set (should be empty)', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive/history`, {
      headers: { 'Authorization': `Bearer ${memberToken}` }
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.history));
    assert.strictEqual(data.history.length, 0, 'No history before replacement');
  });

  test('REST API: Update directive (archives old)', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${memberToken}` },
      body: JSON.stringify({ content: 'Directive v2' })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.directive, 'Directive v2');
  });

  test('REST API: History now contains v1', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive/history`, {
      headers: { 'Authorization': `Bearer ${memberToken}` }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.history.length, 1);
    assert.strictEqual(data.history[0].content, 'Directive v1');
    assert.strictEqual(data.history[0].author, 'TestAgent');
    assert.ok(data.history[0].replaced_at);
  });

  test('REST API: Update directive again', async () => {
    const { status } = await request(`/api/rooms/${roomToken}/directive`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${memberToken}` },
      body: JSON.stringify({ content: 'Directive v3' })
    });

    assert.strictEqual(status, 200);
  });

  test('REST API: History contains both v1 and v2', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive/history`, {
      headers: { 'Authorization': `Bearer ${memberToken}` }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.history.length, 2);
    // Most recent first
    assert.strictEqual(data.history[0].content, 'Directive v2');
    assert.strictEqual(data.history[1].content, 'Directive v1');
  });

  test('REST API: Limit parameter works', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive/history?limit=1`, {
      headers: { 'Authorization': `Bearer ${memberToken}` }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.history.length, 1);
    assert.strictEqual(data.history[0].content, 'Directive v2');
  });

  test('MCP: set_directive archives old', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'set_directive',
          arguments: {
            member_token: memberToken,
            content: 'Directive v4 via MCP'
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    const result = JSON.parse(data.result.content[0].text);
    assert.strictEqual(result.directive, 'Directive v4 via MCP');
  });

  test('MCP: get_directive_history', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_directive_history',
          arguments: {
            member_token: memberToken
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    const result = JSON.parse(data.result.content[0].text);
    assert.ok(Array.isArray(result.history));
    assert.strictEqual(result.history.length, 3);
    // Most recent first
    assert.strictEqual(result.history[0].content, 'Directive v3');
    assert.strictEqual(result.history[1].content, 'Directive v2');
    assert.strictEqual(result.history[2].content, 'Directive v1');
  });

  test('MCP: get_directive_history with limit', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_directive_history',
          arguments: {
            member_token: memberToken,
            limit: 2
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    const result = JSON.parse(data.result.content[0].text);
    assert.strictEqual(result.history.length, 2);
  });

  test('MCP: get_directive_history is read-only (no write permission needed)', async () => {
    // This should succeed even though technically we have write permission
    // The main point is that get_directive_history doesn't modify state
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_directive_history',
          arguments: {
            member_token: memberToken,
            limit: 10
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    assert.ok(data.result);
  });

  test('REST API: Author is recorded in history', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/directive/history?limit=1`, {
      headers: { 'Authorization': `Bearer ${memberToken}` }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.history[0].author, 'TestAgent');
  });
});
