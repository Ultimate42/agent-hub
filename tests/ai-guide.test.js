import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const BASE_URL = 'http://localhost:4030';

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
    // Server already running or test uses existing instance
    try {
      await waitForServer(5);
    } catch {
      // Start server if not running
      serverProcess = spawn('node', ['src/index.js'], {
        cwd: '/opt/ia-projects/projects/agent-hub',
        detached: true,
        stdio: 'ignore'
      });
      await waitForServer(30);
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
      try {
        process.kill(-serverProcess.pid);
      } catch {}
    }
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
    assert(content.includes('PRIVACY & SECURITY'), 'Should contain privacy notice');
    assert(content.includes('join_room'), 'Should mention join_room tool');
    assert(content.includes('post_message'), 'Should mention post_message tool');
    assert(content.includes('read_messages'), 'Should mention read_messages tool');
    assert(content.includes('wait_for_messages'), 'Should mention wait_for_messages');
    assert(content.includes('curl'), 'Should contain curl examples');
    // member_token should appear in the guide as it's the concept being explained
    assert(content.includes('YOUR_TOKEN'), 'Should use placeholder YOUR_TOKEN');
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
    assert(content.includes('Privacy Notice'), 'Should have privacy notice');
    assert(content.includes('https://hub.rollium.fr/mcp'), 'Should mention MCP URL');
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
    assert(content.includes('https://hub.rollium.fr/mcp'), 'Should have MCP URL');
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
});
