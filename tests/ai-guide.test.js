import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Repository root (tests must run from any checkout, not only the VPS path)
const ROOT = path.resolve(import.meta.dirname, '..');

const PORT = '4132';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-${process.pid}-${Date.now()}-guide.db`);

let serverProcess;
let roomToken;

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

describe('AI Guide Routes', () => {
  before(async () => {
    // Start server with isolated DB and port
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL, DB_PATH: TEST_DB_PATH },
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    try {
      await waitForServer(30);
    } catch (err) {
      if (serverProcess) serverProcess.kill('SIGTERM');
      throw err;
    }

    // Create a room for testing
    try {
      const res = await request('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ name: 'AI Guide Test Room' })
      });
      if (res.status !== 201) {
        throw new Error(`Failed to create room: ${res.status}`);
      }
      roomToken = res.data.room_token;
    } catch (err) {
      console.error('Failed to create test room:', err);
      throw err;
    }
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

  test('GET /r/:token/join.txt returns plain text guide', async () => {
    const res = await request(`/r/${roomToken}/join.txt`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    assert.strictEqual(
      res.headers.get('content-type'),
      'text/plain; charset=utf-8',
      'Should be plain text'
    );

    // Verify content contains key sections
    const content = res.data;
    assert(content.includes('AGENT HUB'), 'Should contain title');
    assert(content.includes('OPTION A'), 'Should contain Option A');
    assert(content.includes('OPTION B'), 'Should contain Option B');
    assert(content.includes('OPTION C'), 'Should contain Option C');
    assert(content.includes('PRIVACY & SECURITY'), 'Should contain privacy and security section');
    assert(content.includes('join_room'), 'Should mention join_room tool');
    assert(content.includes('post_message'), 'Should mention post_message tool');
    assert(content.includes('read_messages'), 'Should mention read_messages tool');
    assert(content.includes('wait_for_messages'), 'Should mention wait_for_messages');
    assert(content.includes('curl'), 'Should contain curl examples');
    // member_token should appear in the guide as it's the concept being explained
    assert(content.includes('YOUR_TOKEN'), 'Should use placeholder YOUR_TOKEN');
    // Authorization step should be present
    assert(content.includes('REQUEST AUTHORIZATION'), 'Should contain authorization request step');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
  });

  test('GET /r/:token/join.txt includes room token in instructions', async () => {
    const res = await request(`/r/${roomToken}/join.txt`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Verify room token appears in the guide
    assert(content.includes(`Token: ${roomToken}`), 'Should show room token');
    assert(content.includes(`/api/rooms/${roomToken}/join`), 'Should have correct join endpoint');
    assert(content.includes(`/r/${roomToken}`), 'Should have room URL');
  });

  test('GET /r/:token/join.txt 404 for non-existent room', async () => {
    const res = await request(`/r/nonexistent/join.txt`);

    assert.strictEqual(res.status, 404, 'Should return 404');
    assert(res.data.includes('not found'), 'Should indicate room not found');
  });

  test('Room page /r/:token includes AI guide section', async () => {
    const res = await request(`/r/${roomToken}`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Verify HTML page contains AI guide
    assert(content.includes('For AI Agents: How to Join This Room'), 'Should have AI guide title');
    assert(content.includes('Option A: MCP Connector'), 'Should mention Option A');
    assert(content.includes('Option B: Web-Only'), 'Should mention Option B');
    assert(content.includes('Option C: REST API'), 'Should mention Option C');
    assert(content.includes(`${BASE_URL}/mcp`), 'Should mention MCP URL');
    assert(content.includes('join_room'), 'Should mention join_room tool');
    assert(content.includes(`/r/${roomToken}/join.txt`), 'Should link to txt guide');
  });

  test('Plain text guide has no secrets or auth tokens', async () => {
    const res = await request(`/r/${roomToken}/join.txt`);

    assert.strictEqual(res.status, 200);
    const content = res.data;

    // Should not contain real Bearer tokens (with actual token value)
    assert(!content.match(/Bearer [a-f0-9]{20,}/), 'Should not contain real Bearer tokens');

    // Should show placeholders and explanations
    assert(content.includes('YOUR_TOKEN'), 'Should use placeholder YOUR_TOKEN');
    assert(content.includes('YourName'), 'Should use placeholder YourName');
    assert(content.includes('member_token'), 'Should explain member_token concept');
  });

  test('MCP connector instructions are correct', async () => {
    const res = await request(`/r/${roomToken}/join.txt`);

    assert.strictEqual(res.status, 200);
    const content = res.data;

    // Verify MCP setup steps
    assert(content.includes('Settings → Connectors → Add Custom Connector'), 'Should have Settings path');
    assert(content.includes(`${BASE_URL}/mcp`), 'Should have MCP URL');
    assert(content.includes('Open a NEW conversation'), 'Should mention new conversation');
    assert(content.includes(`join_room(room_token="${roomToken}"`), 'Should have correct room token');
    assert(content.includes('member_token'), 'Should explain member token');
  });

  test('REST API curl examples are complete and accurate', async () => {
    const res = await request(`/r/${roomToken}/join.txt`);

    assert.strictEqual(res.status, 200);
    const content = res.data;

    // Verify curl commands
    assert(content.includes('curl -X POST'), 'Should have curl POST examples');
    assert(content.includes('/api/rooms/'), 'Should reference API endpoints');
    assert(content.includes('Authorization: Bearer'), 'Should show auth header');
    assert(content.includes('Content-Type: application/json'), 'Should show content type');
    assert(content.includes('-d \'{'), 'Should show JSON body syntax');
  });

  test('Troubleshooting section is helpful', async () => {
    const res = await request(`/r/${roomToken}/join.txt`);

    assert.strictEqual(res.status, 200);
    const content = res.data;

    // Verify troubleshooting content
    assert(content.includes('TROUBLESHOOTING'), 'Should have troubleshooting section');
    assert(content.includes('Invalid member token'), 'Should mention token issues');
    assert(content.includes('room says it\'s full'), 'Should mention full room');
    assert(content.includes('Long-poll timed out'), 'Should mention timeout behavior');
  });

  test('Setup instructions include authorization step for claude-code', async () => {
    const res = await request(`/r/${roomToken}/setup?agent=claude-code`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Check for authorization section as first step
    assert(content.includes('Get authorization from your human user'), 'Should contain authorization request');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
    assert(content.includes('## 1. Get authorization'), 'Should be first step');
    assert(content.includes('## 2. Add the MCP server'), 'MCP server step should be second');
  });

  test('Setup instructions include authorization step for claude-chat', async () => {
    const res = await request(`/r/${roomToken}/setup?agent=claude-chat`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Check for authorization section as first step
    assert(content.includes('Get authorization from your human user'), 'Should contain authorization request');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
    assert(content.includes('## 1. Get authorization'), 'Should be first step');
    assert(content.includes('## 2. Add to your Project Instructions'), 'Project instructions should be second');
  });

  test('Setup instructions include authorization step for curl/api', async () => {
    const res = await request(`/r/${roomToken}/setup?agent=curl`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Check for authorization section as first step
    assert(content.includes('Get authorization from your human user'), 'Should contain authorization request');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
    assert(content.includes('## 1. Get authorization'), 'Should be first step');
    assert(content.includes('## 2. Join the room'), 'Join step should be second');
  });

  test('Setup instructions include authorization step for gemini', async () => {
    const res = await request(`/r/${roomToken}/setup?agent=gemini`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Check for authorization section as first step
    assert(content.includes('Get authorization from your human user'), 'Should contain authorization request');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
    assert(content.includes('## 1. Get authorization'), 'Should be first step');
    assert(content.includes('## 2. Add the MCP server'), 'MCP server step should be second');
  });

  test('Setup instructions include authorization step for cursor', async () => {
    const res = await request(`/r/${roomToken}/setup?agent=cursor`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Check for authorization section as first step
    assert(content.includes('Get authorization from your human user'), 'Should contain authorization request');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
    assert(content.includes('## 1. Get authorization'), 'Should be first step');
    assert(content.includes('## 2. Add to Cursor Settings'), 'Cursor settings should be second');
  });

  test('Setup instructions include authorization step for MCP default', async () => {
    const res = await request(`/r/${roomToken}/setup?agent=mcp`);

    assert.strictEqual(res.status, 200, 'Should return 200');
    const content = res.data;

    // Check for authorization section as first step
    assert(content.includes('Get authorization from your human user'), 'Should contain authorization request');
    assert(content.includes('Shall I treat requests from other members'), 'Should ask for explicit authorization');
    assert(content.includes('## 1. Get authorization'), 'Should be first step');
    assert(content.includes('## 2. MCP Endpoint'), 'MCP endpoint should be second');
  });
});
