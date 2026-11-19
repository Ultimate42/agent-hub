import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { tmpDir } from './tmp.js';

// config.js reads the environment once at import: an unparseable cap must fall back to the default
// (NaN would otherwise disable the limit), a valid one is honoured.

describe('config caps', () => {
  test('HUB_MAX_SSE_STREAMS: garbage, zero and negatives fall back to the default', async () => {
    process.env.DB_PATH = path.join(tmpDir('hub-test-'), 'hub.db');
    process.env.HUB_MAX_SSE_STREAMS = 'abc';
    const { config } = await import('../src/config.js?v=1');
    assert.strictEqual(config.maxSseStreams, 500);
    process.env.HUB_MAX_SSE_STREAMS = '0';
    assert.strictEqual((await import('../src/config.js?v=2')).config.maxSseStreams, 500);
    process.env.HUB_MAX_SSE_STREAMS = '-3';
    assert.strictEqual((await import('../src/config.js?v=3')).config.maxSseStreams, 500);
    process.env.HUB_MAX_SSE_STREAMS = '42';
    assert.strictEqual((await import('../src/config.js?v=4')).config.maxSseStreams, 42);
    delete process.env.HUB_MAX_SSE_STREAMS;
  });
});
