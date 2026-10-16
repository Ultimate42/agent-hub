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

describe('Idempotent Join Tests', () => {
  before(async () => {
    // Start server
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '4030', PUBLIC_URL: BASE_URL },
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
  });

  test('Create test room', async () => {
    const { status, data } = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Idempotent Test Room' })
    });

    assert.strictEqual(status, 201);
    roomToken = data.room_token;
  });

  test('Join room first time returns 201', async () => {
    const { status, data } = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TestBot', role: 'agent' })
    });

    assert.strictEqual(status, 201, 'First join should return 201');
    assert.ok(data.member_token, 'Should return member_token');
    assert.strictEqual(data.is_rejoin, false, 'is_rejoin should be false for first join');
  });

  test('Join same name second time returns 200 with new token', async () => {
    // First join
    const join1 = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'DuplicateBot', role: 'agent' })
    });

    assert.strictEqual(join1.status, 201);
    const token1 = join1.data.member_token;

    // Second join with same name
    const join2 = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'DuplicateBot', role: 'agent' })
    });

    assert.strictEqual(join2.status, 200, 'Second join should return 200');
    assert.ok(join2.data.member_token, 'Should return new member_token');
    assert.strictEqual(join2.data.is_rejoin, true, 'is_rejoin should be true');
    assert.notStrictEqual(join2.data.member_token, token1, 'New token should differ from old token');
  });

  test('Old token becomes invalid after rejoin', async () => {
    // First join
    const join1 = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'InvalidateBot', role: 'agent' })
    });

    const oldToken = join1.data.member_token;

    // Second join with same name
    const join2 = await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'InvalidateBot', role: 'agent' })
    });

    const newToken = join2.data.member_token;

    // Try to use old token
    const oldTokenTest = await request(`/api/rooms/${roomToken}/messages`, {
      headers: { 'Authorization': `Bearer ${oldToken}` }
    });

    assert.strictEqual(oldTokenTest.status, 403, 'Old token should be invalid');
    assert.strictEqual(oldTokenTest.data.error, 'Invalid token');

    // New token should work
    const newTokenTest = await request(`/api/rooms/${roomToken}/messages`, {
      headers: { 'Authorization': `Bearer ${newToken}` }
    });

    assert.strictEqual(newTokenTest.status, 200, 'New token should be valid');
  });

  test('Member count does not increase on rejoin', async () => {
    // Get initial member count
    const setupToken = (await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Count Test Room' })
    })).data.room_token;

    const join1 = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'CountBot' })
    });

    const token1 = join1.data.member_token;

    // Get member count after first join
    const count1 = (await request(`/api/rooms/${setupToken}/members`, {
      headers: { 'Authorization': `Bearer ${token1}` }
    })).data.members.length;

    // Rejoin
    const join2 = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'CountBot' })
    });

    const token2 = join2.data.member_token;

    // Get member count after rejoin
    const count2 = (await request(`/api/rooms/${setupToken}/members`, {
      headers: { 'Authorization': `Bearer ${token2}` }
    })).data.members.length;

    assert.strictEqual(count1, count2, 'Member count should not increase on rejoin');
  });

  test('Case-insensitive name matching', async () => {
    // Create room
    const setupToken = (await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Case Test Room' })
    })).data.room_token;

    // Join with "TestBot"
    const join1 = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TestBot' })
    });

    assert.strictEqual(join1.status, 201);
    const token1 = join1.data.member_token;

    // Rejoin with "testbot" (lowercase)
    const join2 = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'testbot' })
    });

    assert.strictEqual(join2.status, 200, 'Case-insensitive match should trigger rejoin');
    assert.notStrictEqual(join2.data.member_token, token1);
  });

  test('Whitespace-trimmed name matching', async () => {
    // Create room
    const setupToken = (await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Trim Test Room' })
    })).data.room_token;

    // Join with "  TrimBot  "
    const join1 = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: '  TrimBot  ' })
    });

    assert.strictEqual(join1.status, 201);
    const token1 = join1.data.member_token;

    // Rejoin with "TrimBot" (no whitespace)
    const join2 = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TrimBot' })
    });

    assert.strictEqual(join2.status, 200, 'Trimmed name should trigger rejoin');
    assert.notStrictEqual(join2.data.member_token, token1);
  });

  test('Rate limit excludes long-poll requests', async () => {
    // Create room and join
    const setupToken = (await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Rate Limit Test' })
    })).data.room_token;

    const joinRes = await request(`/api/rooms/${setupToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'RateLimitBot' })
    });

    const token = joinRes.data.member_token;

    // Send many long-poll requests (should not be rate limited)
    const pollPromises = Array.from({ length: 70 }, (_, i) =>
      request(`/api/rooms/${setupToken}/messages/wait?timeout=100`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
    );

    const results = await Promise.all(pollPromises);

    // Check that none returned 429 (all should be 200)
    const rateLimited = results.filter(r => r.status === 429);
    assert.strictEqual(rateLimited.length, 0, `Long-poll should not be rate limited, but got ${rateLimited.length} 429 responses`);
  });
});
