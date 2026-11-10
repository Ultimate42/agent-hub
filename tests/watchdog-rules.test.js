import { test, describe } from 'node:test';
import assert from 'node:assert';
import { expectsReply, inAlertWindow } from '../src/wake-policy.js';

const members = [
  { id: 1, name: 'Alice', role: 'human' },
  { id: 2, name: 'Agent2', role: 'agent' },
  { id: 3, name: 'Claude', role: 'agent' },
  { id: 4, name: 'HubWatchdog', role: 'observer' },
  { id: 5, name: 'Transcription', role: 'agent' }
];
const human = (content, extra = {}) => ({ author_id: 1, author: 'Alice', author_role: 'human', content, ...extra });
const by = (n) => members.find(m => m.name === n);

describe('watchdog rules', () => {
  test('old message: outside the alert window', () => {
    assert.strictEqual(inAlertWindow(1303014, 120, 86400), false);
    assert.strictEqual(inAlertWindow(3600, 120, 86400), true);
    assert.strictEqual(inAlertWindow(60, 120, 86400), false);
    assert.strictEqual(inAlertWindow(1303014, 120, 0), true); // 0 = no limit
  });
  test('passive member: a plain human message in a multi-agent room does not require a reply', () => {
    assert.strictEqual(expectsReply({ message: human('bonjour'), member: by('Claude'), members }), false);
    assert.strictEqual(expectsReply({ message: human('bonjour'), member: by('Agent2'), members }), false);
  });
  test('watchdog and system members never owe a reply', () => {
    assert.strictEqual(expectsReply({ message: human('@HubWatchdog hi'), member: by('HubWatchdog'), members }), false);
    assert.strictEqual(expectsReply({ message: human('@Transcription hi'), member: by('Transcription'), members }), false);
  });
  test('real mention or direct reply: reply expected', () => {
    assert.strictEqual(expectsReply({ message: human('@Claude tu peux ?'), member: by('Claude'), members }), true);
    assert.strictEqual(expectsReply({ message: human('ok', { reply_to_member_id: 3 }), member: by('Claude'), members }), true);
    const agent = { author_id: 2, author: 'Agent2', author_role: 'agent', content: '@Claude ping' };
    assert.strictEqual(expectsReply({ message: agent, member: by('Claude'), members }), true);
  });
  test('human message with a single non-human recipient: reply expected', () => {
    const duo = [members[0], members[2], members[3]];
    assert.strictEqual(expectsReply({ message: human('salut'), member: duo[1], members: duo }), true);
  });
  test('agent message without mention does not require a reply', () => {
    const agent = { author_id: 2, author: 'Agent2', author_role: 'agent', content: 'fyi' };
    assert.strictEqual(expectsReply({ message: agent, member: by('Claude'), members }), false);
  });
});
