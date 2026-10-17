import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4131';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-exclude-self-${process.pid}-${Date.now()}.db`);

let serverProcess;
let roomToken;
let member1Token;
let member2Token;

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

describe('exclude_self Messages Tests', () => {
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

  test('Setup: Create room and join members', async () => {
    const roomRes = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Room' })
    });
    roomToken = roomRes.data.room_token;
    assert.ok(roomToken);

    const m1Res = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', role: 'agent' })
    });
    member1Token = m1Res.data.member_token;
    assert.ok(member1Token);

    const m2Res = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Bob', role: 'agent' })
    });
    member2Token = m2Res.data.member_token;
    assert.ok(member2Token);
  });

  test('POST messages from both members', async () => {
    // Alice posts
    const alice1 = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Message from Alice 1' })
    });
    assert.strictEqual(alice1.status, 201);

    // Bob posts
    const bob1 = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({ content: 'Message from Bob 1' })
    });
    assert.strictEqual(bob1.status, 201);

    // Alice posts again
    const alice2 = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Message from Alice 2' })
    });
    assert.strictEqual(alice2.status, 201);
  });

  test('REST API: read_messages without exclude_self returns all messages', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages?mode=recent`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.messages));
    assert.strictEqual(data.messages.length, 3, 'Should have 3 total messages');

    // Check all messages present
    const authors = data.messages.map(m => m.author);
    assert.ok(authors.includes('Alice'));
    assert.ok(authors.includes('Bob'));
  });

  test('REST API: read_messages with exclude_self=true excludes own messages', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages?exclude_self=true`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.messages));
    assert.strictEqual(data.messages.length, 1, 'Alice should only see Bob\'s 1 message');
    assert.strictEqual(data.messages[0].author, 'Bob');
    assert.strictEqual(data.messages[0].content, 'Message from Bob 1');
  });

  test('REST API: Member 2 with exclude_self=true excludes only their messages', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/messages?exclude_self=true`, {
      headers: { 'Authorization': `Bearer ${member2Token}` }
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.messages.length, 2, 'Bob should see 2 messages from Alice');
    const authors = data.messages.map(m => m.author);
    assert.ok(authors.every(a => a === 'Alice'));
  });

  test('MCP: read_messages with exclude_self=true', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'read_messages',
          arguments: {
            member_token: member1Token,
            exclude_self: true
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    assert.ok(data.result);
    const messages = data.result.content[0].text;
    const parsed = JSON.parse(messages);
    assert.ok(parsed.messages);
    assert.strictEqual(parsed.messages.length, 1);
    assert.strictEqual(parsed.messages[0].author, 'Bob');
  });

  test('MCP: read_messages without exclude_self returns all messages', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
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
    const messages = data.result.content[0].text;
    const parsed = JSON.parse(messages);
    assert.strictEqual(parsed.messages.length, 3);
  });

  test('MCP: read_messages with exclude_self=false explicitly', async () => {
    const { status, data } = await request('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'read_messages',
          arguments: {
            member_token: member2Token,
            exclude_self: false
          }
        }
      })
    });

    assert.strictEqual(status, 200);
    const messages = data.result.content[0].text;
    const parsed = JSON.parse(messages);
    assert.strictEqual(parsed.messages.length, 3);
  });
});
