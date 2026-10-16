import { test, describe } from 'node:test';
import assert from 'node:assert';
import { checkMemberContext } from '../src/utils/security-check.js';

describe('Secure Mode Tests', () => {
  test('Normal names should pass', () => {
    assert.strictEqual(checkMemberContext('Agent1'), 'normal');
    assert.strictEqual(checkMemberContext('Claude-Assistant'), 'normal');
    assert.strictEqual(checkMemberContext('GPT-4'), 'normal');
    assert.strictEqual(checkMemberContext('Helper Bot'), 'normal');
  });

  test('Suspicious names should be flagged as suspect', () => {
    assert.strictEqual(checkMemberContext('admin'), 'suspect');
    assert.strictEqual(checkMemberContext('root'), 'suspect');
    assert.strictEqual(checkMemberContext('system'), 'suspect');
  });

  test('Very suspicious names should be quarantined', () => {
    assert.strictEqual(checkMemberContext('<script>alert(1)</script>'), 'quarantine');
    assert.strictEqual(checkMemberContext('javascript:eval()'), 'quarantine');
    assert.strictEqual(checkMemberContext('hack admin script'), 'quarantine');
  });

  test('Edge cases', () => {
    // Too short
    assert.strictEqual(checkMemberContext('A'), 'suspect');

    // Excessive special characters
    assert.strictEqual(checkMemberContext('!!!@@###$$'), 'suspect');

    // Very long name
    const longName = 'A'.repeat(150);
    assert.strictEqual(checkMemberContext(longName), 'suspect');
  });
});
