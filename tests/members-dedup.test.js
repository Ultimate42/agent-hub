import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const PORT = '4031';
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess;
let roomToken;
let member1Token;

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

// Helper: MCP request
async function mcpRequest(method, params) {
  const { status, data } = await request('/mcp', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
  });

  if (status !== 200) {
    throw new Error(`MCP error: ${status} ${JSON.stringify(data)}`);
  }

  return data.result;
}

describe('Members List Dedup and Presence Tests', () => {
  before(async () => {
    // Start server
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT, PUBLIC_URL: BASE_URL },
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    await waitForServer();
    console.log('Server started for members-dedup tests');
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  });

  test('Create test room', async () => {
    const { status, data } = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Dedup Test Room' })
    });

    assert.strictEqual(status, 201);
    roomToken = data.room_token;
  });

  test('Join member "Archiviste" first time', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Archiviste', role: 'agent' })
    });

    assert.strictEqual(status, 201);
    member1Token = data.member_token;
  });

  test('Join member "Archiviste" second time (should rejoin with new token)', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Archiviste', role: 'agent' })
    });

    assert.strictEqual(status, 200);
    assert.ok(data.member_token);
    assert.strictEqual(data.is_rejoin, true);
    member1Token = data.member_token;
  });

  test('Join member "TestMember"', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TestMember', role: 'agent' })
    });

    assert.strictEqual(status, 201);
  });

  test('Join member "TestMember" again (rejoin)', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TestMember', role: 'agent' })
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(data.is_rejoin, true);
  });

  test('API /members endpoint: list should be deduped with presence field', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/members`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${member1Token}`
      }
    });

    assert.strictEqual(status, 200);
    const { members } = data;

    // Should have exactly 2 members (Archiviste and TestMember, deduplicated)
    assert.strictEqual(members.length, 2, `Expected 2 members, got ${members.length}`);

    // Check that each member has the presence field
    for (const member of members) {
      assert.ok(['active', 'passive', 'stale'].includes(member.presence),
        `Invalid presence value: ${member.presence}`);
      assert.ok(member.name, 'Member should have a name');
      assert.ok(member.role, 'Member should have a role');
      assert.ok(member.last_seen, 'Member should have last_seen');
    }

    // Verify no duplicates by name
    const names = members.map(m => m.name);
    const uniqueNames = new Set(names);
    assert.strictEqual(uniqueNames.size, names.length, 'Should have no duplicate names');
  });

  test('MCP list_members tool: should also dedupe with presence field', async () => {
    // First, rejoin via MCP to get a token
    const joinResult = await mcpRequest('tools/call', {
      name: 'join_room',
      arguments: {
        room_token: roomToken,
        name: 'TestMember',
        role: 'agent'
      }
    });

    const memberToken = JSON.parse(joinResult.content[0].text).member_token;

    // Now list members via MCP
    const result = await mcpRequest('tools/call', {
      name: 'list_members',
      arguments: {
        member_token: memberToken
      }
    });

    const listResult = JSON.parse(result.content[0].text);
    const { members } = listResult;

    // Should have 2 members (deduped)
    assert.strictEqual(members.length, 2, `Expected 2 members via MCP, got ${members.length}`);

    // Check presence field in each member
    for (const member of members) {
      assert.ok(['active', 'passive', 'stale'].includes(member.presence),
        `Invalid presence value in MCP: ${member.presence}`);
    }
  });

  test('Presence calculation: recently active member should be "active"', async () => {
    // Member just joined/updated, last_seen should be very recent
    const { status, data } = await request(`/api/rooms/${roomToken}/members`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${member1Token}`
      }
    });

    assert.strictEqual(status, 200);
    const { members } = data;

    // Find Archiviste (which we just used for this request)
    const archivist = members.find(m => m.name === 'Archiviste');
    assert.ok(archivist, 'Archiviste should be in list');
    // Should be active since we just used their token
    assert.strictEqual(archivist.presence, 'active', 'Recently seen member should be "active"');
  });
});
