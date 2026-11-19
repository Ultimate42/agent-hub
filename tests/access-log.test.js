import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';

process.env.DB_PATH = path.join(os.tmpdir(), `hub-test-access-log-${process.pid}.db`);
const { createAccessLog, routeKey } = await import('../src/utils/access-log.js');

function fakeLog() {
  const lines = [];
  const mk = (level) => (msg, data) => lines.push({ level, msg, ...data });
  return { lines, log: { error: mk('error'), warn: mk('warn'), info: mk('info'), debug: mk('debug') } };
}

describe('access log', () => {
  test('success lines go to the configured level, 5xx always at error', () => {
    const { lines, log } = fakeLog();
    const a = createAccessLog({ log, okLevel: 'debug', summaryMs: 3600000, now: () => 0 });
    a.record({ method: 'GET', url: '/api/rooms/***/messages/wait', status: 200, duration: 3, ip: '127.0.0.1' });
    a.record({ method: 'POST', url: '/mcp', status: 502, duration: 3, ip: '127.0.0.1' });
    assert.deepStrictEqual(lines.map((l) => l.level), ['debug', 'error']);
  });

  test('a repeated 4xx is warned once, then counted in the summary', () => {
    const { lines, log } = fakeLog();
    let t = 0;
    const a = createAccessLog({ log, okLevel: 'debug', summaryMs: 3600000, now: () => t });
    for (let i = 0; i < 700; i++) a.record({ method: 'GET', url: '/api/rooms/***/messages/wait?auto_ack=false', status: 403, duration: 1, ip: '127.0.0.1' });
    a.record({ method: 'GET', url: '/api/rooms/***/messages', status: 200, duration: 1, ip: '127.0.0.1' });
    assert.strictEqual(lines.filter((l) => l.level === 'warn').length, 1);
    t = 3600000;
    a.record({ method: 'GET', url: '/health', status: 200, duration: 1, ip: '127.0.0.1' });
    const sum = lines.find((l) => l.msg === 'HTTP summary');
    assert.ok(sum && sum.level === 'info');
    assert.strictEqual(sum.requests, 701);
    assert.deepStrictEqual(sum.by_status, { '4xx': 700, '2xx': 1 });
    assert.deepStrictEqual(sum.client_errors, [{ kind: 'GET /api/rooms/***/messages/wait 403 127.0.0.1', count: 700 }]);
    // new window: the same refusal is warned again (visible once per window, never silenced)
    a.record({ method: 'GET', url: '/api/rooms/***/messages/wait', status: 403, duration: 1, ip: '127.0.0.1' });
    assert.strictEqual(lines.filter((l) => l.level === 'warn').length, 2);
  });

  test('without summary every 4xx stays at warn', () => {
    const { lines, log } = fakeLog();
    const a = createAccessLog({ log, okLevel: 'info', summaryMs: 0, now: () => 0 });
    for (let i = 0; i < 3; i++) a.record({ method: 'GET', url: '/x', status: 401, duration: 1, ip: '1.2.3.4' });
    a.record({ method: 'GET', url: '/x', status: 200, duration: 1, ip: '1.2.3.4' });
    assert.deepStrictEqual(lines.map((l) => l.level), ['warn', 'warn', 'warn', 'info']);
  });

  test('routeKey folds numeric ids', () => {
    assert.strictEqual(routeKey('GET', '/api/rooms/***/messages/123?x=1'), 'GET /api/rooms/***/messages/:n');
  });

  test('empty window logs no summary', () => {
    const { lines, log } = fakeLog();
    const a = createAccessLog({ log, summaryMs: 1000, now: () => 0 });
    a.flush(5000);
    assert.strictEqual(lines.length, 0);
  });
});

describe('config', () => {
  test('HTTP_LOG_LEVEL and HTTP_LOG_SUMMARY_MINUTES are validated', async () => {
    process.env.HTTP_LOG_LEVEL = 'loud'; process.env.HTTP_LOG_SUMMARY_MINUTES = 'abc';
    let { config } = await import('../src/config.js?al=1');
    assert.strictEqual(config.httpLogLevel, 'debug');
    assert.strictEqual(config.httpLogSummaryMs, 3600000);
    process.env.HTTP_LOG_SUMMARY_MINUTES = '0';
    ({ config } = await import('../src/config.js?al=0'));
    assert.strictEqual(config.httpLogSummaryMs, 0);
    process.env.HTTP_LOG_LEVEL = 'info'; process.env.HTTP_LOG_SUMMARY_MINUTES = '15';
    ({ config } = await import('../src/config.js?al=2'));
    assert.strictEqual(config.httpLogLevel, 'info');
    assert.strictEqual(config.httpLogSummaryMs, 900000);
    delete process.env.HTTP_LOG_LEVEL; delete process.env.HTTP_LOG_SUMMARY_MINUTES;
  });
});
