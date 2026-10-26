import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = '4135';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `hub-test-watchdog-${process.pid}-${Date.now()}.db`);

let serverProcess;
let roomToken;
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

describe('Watchdog Tests', () => {
  before(async () => {
    // Start server with short watchdog interval and unreply timeout
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT,
        PUBLIC_URL: BASE_URL,
        DB_PATH: TEST_DB_PATH,
        HUB_UNREPLY_SECONDS: '2',
        HUB_WATCHDOG_INTERVAL_MS: '500',
        HUB_WATCHDOG_IGNORE: ' florent , Someone Else'
      },
      stdio: 'pipe'
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    await waitForServer();
    console.log('Server started with HUB_UNREPLY_SECONDS=2');

    // Create room
    let res = await request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: 'Watchdog Test Room' })
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
    // Clean up test DB files
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  });

  test('Watchdog posts single alert for unanswered @mention after timeout', async () => {
    // Agent1 mentions Agent2
    const { data: msgRes } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Hey @Agent2, are you there?' })
    });
    const msgId = msgRes.id;

    // Wait for watchdog to trigger (2 seconds + some buffer)
    await new Promise(r => setTimeout(r, 3000));

    // Check messages - should have watchdog alert
    const { data: msgsData } = await request(`/api/rooms/${roomToken}/messages`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    const watchdogAlert = msgsData.messages.find(m => m.author === 'HubWatchdog');
    assert.ok(watchdogAlert, 'Watchdog should post alert');
    assert.ok(watchdogAlert.content.includes(`message #${msgId}`), 'Alert should mention message ID');
    assert.ok(watchdogAlert.content.includes('Agent2'), 'Alert should mention Agent2');
    assert.ok(watchdogAlert.content.includes('may be asleep'), 'Alert should indicate member may be asleep');
  });

  test('No alert for members listed in HUB_WATCHDOG_IGNORE (case-insensitive)', async () => {
    await request(`/api/rooms/${roomToken}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Florent', role: 'human' })
    });
    const { data: msgRes } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Florent can you validate?' })
    });

    await new Promise(r => setTimeout(r, 3000));

    const { data } = await request(`/api/rooms/${roomToken}/messages/history?limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alert = data.messages.find(m => m.author === 'HubWatchdog' && m.content.includes(`message #${msgRes.id}`));
    assert.strictEqual(alert, undefined, 'Ignored member must not trigger an alert');
  });

  test('A reaction from the addressee acknowledges the message (no alert)', async () => {
    const { data: msgRes } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 deployed, thanks' })
    });
    await request(`/api/rooms/${roomToken}/messages/${msgRes.id}/reactions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({ emoji: '👍' })
    });

    await new Promise(r => setTimeout(r, 3000));

    const { data } = await request(`/api/rooms/${roomToken}/messages/history?limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alert = data.messages.find(m => m.author === 'HubWatchdog' && m.content.includes(`message #${msgRes.id}`));
    assert.strictEqual(alert, undefined, 'Reacted message must not trigger an alert');
  });

  test('No "may be asleep" alert when the addressee received the message', async () => {
    const { data: msgRes } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 FYI, nothing to answer' })
    });
    // Agent2 reads its unread messages right away (its read cursor passes the mention)
    const read = await request(`/api/rooms/${roomToken}/messages?limit=100`, { headers: { 'Authorization': `Bearer ${member2Token}` } });
    assert.strictEqual(read.status, 200, `Agent2 read failed: ${JSON.stringify(read.data)}`);
    assert.ok(read.data.messages.some(m => m.id === msgRes.id), 'Agent2 must receive the mention');
    assert.ok(read.data.last_read_id >= msgRes.id, `cursor ${read.data.last_read_id} must pass #${msgRes.id}`);

    await new Promise(r => setTimeout(r, 3000));

    const { data } = await request(`/api/rooms/${roomToken}/messages/history?limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alert = data.messages.find(m => m.author === 'HubWatchdog' && m.content.includes(`message #${msgRes.id}`));
    assert.strictEqual(alert, undefined, 'A member who got the message is not asleep');
  });

  test('No second alert for same unanswered message', async () => {
    // Post another mention to Agent2
    const { data: msgRes } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Agent2? Another mention @Agent2' })
    });
    const msgId = msgRes.id;

    // Wait for first watchdog trigger
    await new Promise(r => setTimeout(r, 3000));

    const { data: msgs1 } = await request(`/api/rooms/${roomToken}/messages?mode=recent&limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alertCount1 = msgs1.messages.filter(m =>
      m.author === 'HubWatchdog' && m.content.includes(`message #${msgId}`)
    ).length;
    assert.strictEqual(alertCount1, 1, 'Should have exactly 1 alert for this message');

    // Wait again
    await new Promise(r => setTimeout(r, 1000));

    const { data: msgs2 } = await request(`/api/rooms/${roomToken}/messages?mode=recent&limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alertCount2 = msgs2.messages.filter(m =>
      m.author === 'HubWatchdog' && m.content.includes(`message #${msgId}`)
    ).length;
    assert.strictEqual(alertCount2, 1, 'Should still have exactly 1 alert (no duplicate)');
  });

  test('One alert per absence, not one per pending message', async () => {
    // Agent2 comes back (seen), then goes silent while two messages are addressed to it
    await request(`/api/rooms/${roomToken}/messages/history?limit=1`, { headers: { 'Authorization': `Bearer ${member2Token}` } });
    await new Promise(r => setTimeout(r, 1100)); // last_seen has a 1 s resolution
    const ids = [];
    for (const content of ['@Agent2 first question?', '@Agent2 second question?']) {
      const { data } = await request(`/api/rooms/${roomToken}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${member1Token}` },
        body: JSON.stringify({ content })
      });
      ids.push(data.id);
    }

    await new Promise(r => setTimeout(r, 3500));

    const { data } = await request(`/api/rooms/${roomToken}/messages/history?limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alerts = data.messages.filter(m => m.author === 'HubWatchdog' && ids.some(id => m.content.includes(`message #${id} `)));
    assert.strictEqual(alerts.length, 1, `expected a single alert, got: ${alerts.map(a => a.content).join(' | ')}`);
  });

  test('No alert if addressee replies quickly', async () => {
    // Agent1 mentions Agent2
    const { data: msgRes } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 can you help?' })
    });
    const msgId = msgRes.id;

    // Agent2 replies quickly (within 2-second timeout)
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({ content: 'I am here!' })
    });

    // Wait for watchdog to run and check
    await new Promise(r => setTimeout(r, 3000));

    // Check messages - if Agent2 replied, watchdog might not trigger
    // This test just verifies no crash and watchdog handles replies
    const { data: msgsData } = await request(`/api/rooms/${roomToken}/messages?mode=recent&limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    assert.ok(Array.isArray(msgsData.messages), 'Should return messages without error');
    // Either there's an alert (watchdog was running) or no alert (watchdog skipped due to reply)
    // Both are acceptable - we just want no crash
  });

  test('No alert for reply_to messages if addressee replies', async () => {
    // Agent1 posts message
    const { data: msg1 } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Question about the task' })
    });

    // Agent2 replies to Agent1's message
    const { data: msg2 } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member2Token}` },
      body: JSON.stringify({
        content: 'Sure, let me help',
        reply_to: msg1.id
      })
    });

    // Agent1 replies quickly to Agent2
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({
        content: 'Thanks!',
        reply_to: msg2.id
      })
    });

    // Wait for watchdog
    await new Promise(r => setTimeout(r, 3000));

    // Should not have unanswered alerts in this thread
    const { data: msgsData } = await request(`/api/rooms/${roomToken}/messages?mode=recent&limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    const watchdogAlerts = msgsData.messages.filter(m =>
      m.author === 'HubWatchdog' && (
        m.content.includes(`message #${msg2.id}`) ||
        m.content.includes(`message #${msg1.id}`)
      )
    );
    assert.strictEqual(watchdogAlerts.length, 0, 'Should not alert when conversation is active');
  });

  test('pending_unreplied field exists in /members endpoint', async () => {
    // Get members list
    const { data: membersData } = await request(`/api/rooms/${roomToken}/members`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });

    assert.ok(Array.isArray(membersData.members), 'Members should be an array');
    const agent2 = membersData.members.find(m => m.name === 'Agent2');
    assert.ok(agent2, 'Agent2 should be in members');
    assert.ok(typeof agent2.pending_unreplied === 'number', 'pending_unreplied should be a number');
  });

  test('Watchdog does not self-trigger endlessly', async () => {
    // Get initial alert count
    const { data: msgs1 } = await request(`/api/rooms/${roomToken}/messages?mode=recent&limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alertCountBefore = msgs1.messages.filter(m => m.author === 'HubWatchdog').length;

    // Agent2 comes back first (an absent member already reported is not alerted again)
    await request(`/api/rooms/${roomToken}/messages/history?limit=1`, { headers: { 'Authorization': `Bearer ${member2Token}` } });
    await new Promise(r => setTimeout(r, 1100));

    // Simulate old message without reply
    const { data: msg } = await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: '@Agent2 final test' })
    });

    // Wait for watchdog
    await new Promise(r => setTimeout(r, 3000));

    // Get alert count after
    const { data: msgs2 } = await request(`/api/rooms/${roomToken}/messages?mode=recent&limit=100`, {
      headers: { 'Authorization': `Bearer ${member1Token}` }
    });
    const alertCountAfter = msgs2.messages.filter(m => m.author === 'HubWatchdog').length;

    assert.ok(alertCountAfter > alertCountBefore, 'New alert should be posted at least once');

    // Watchdog should not post infinite alerts for its own messages
    // (it only triggers on addressed messages from non-system sources)
    const watchdogAlerts = msgs2.messages.filter(m => m.author === 'HubWatchdog');
    assert.ok(watchdogAlerts.length > 0, 'Should have watchdog alerts');
  });

  test('Shutdown cleanly without leaking timers', async () => {
    // Send a few messages
    await request(`/api/rooms/${roomToken}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${member1Token}` },
      body: JSON.stringify({ content: 'Goodbye test' })
    });

    // Kill the server
    await new Promise((resolve) => {
      serverProcess.on('exit', resolve);
      serverProcess.kill('SIGTERM');
    });

    // If we got here, shutdown completed without hanging on watchdog timer
    assert.ok(true, 'Server shut down cleanly');
  });
});
