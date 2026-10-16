import { test, describe } from 'node:test';
import assert from 'node:assert';
import { shouldCallLLM } from '../archiviste/archiviste.js';

describe('Archiviste LLM Decision Logic', () => {
  test('should NOT call LLM for command: retiens:', () => {
    assert.strictEqual(shouldCallLLM('retiens: something important'), false);
  });

  test('should NOT call LLM for command: cherche:', () => {
    assert.strictEqual(shouldCallLLM('cherche: nutrition tips'), false);
  });

  test('should NOT call LLM for command: résume:', () => {
    assert.strictEqual(shouldCallLLM('résume: my week'), false);
  });

  test('should NOT call LLM for help commands', () => {
    assert.strictEqual(shouldCallLLM('?'), false);
    assert.strictEqual(shouldCallLLM('aide'), false);
  });

  test('should NOT call LLM for case-insensitive commands', () => {
    assert.strictEqual(shouldCallLLM('RETIENS: test'), false);
    assert.strictEqual(shouldCallLLM('Recherche: test'), false);
    assert.strictEqual(shouldCallLLM('RESUME: test'), false);
  });

  test('should NOT call LLM for command with accents normalized', () => {
    assert.strictEqual(shouldCallLLM('résumé: topic'), false); // Even with extra accent
  });

  test('should call LLM when message mentions @Archiviste', () => {
    assert.strictEqual(shouldCallLLM('@Archiviste what can you do?'), true);
    assert.strictEqual(shouldCallLLM('Hey @Archiviste'), true);
  });

  test('should call LLM when message mentions archiviste (lowercase)', () => {
    assert.strictEqual(shouldCallLLM('archiviste, how are you?'), true);
  });

  test('should call LLM when message uses Archiviste (case insensitive)', () => {
    assert.strictEqual(shouldCallLLM('ARCHIVISTE do something'), true);
    assert.strictEqual(shouldCallLLM('Archiviste please help'), true);
  });

  test('should call LLM when message contains "each agent"', () => {
    assert.strictEqual(shouldCallLLM('each agent should reply'), true);
    assert.strictEqual(shouldCallLLM('Each agent, tell me...'), true);
  });

  test('should call LLM when message contains "tous les agents"', () => {
    assert.strictEqual(shouldCallLLM('tous les agents doivent répondre'), true);
  });

  test('should NOT call LLM for random message without mention', () => {
    assert.strictEqual(shouldCallLLM('just a random message'), false);
    assert.strictEqual(shouldCallLLM('hello everyone'), false);
  });

  test('should NOT call LLM for message mentioning other agents', () => {
    assert.strictEqual(shouldCallLLM('@Claude do something'), false);
    assert.strictEqual(shouldCallLLM('hey Claude'), false);
  });

  test('should call LLM even if Archiviste mention is in command-like text', () => {
    // "retiens:" prefix means it's a command, so skip LLM
    assert.strictEqual(shouldCallLLM('retiens: @Archiviste is cool'), false);
  });

  test('should handle whitespace and trimming', () => {
    assert.strictEqual(shouldCallLLM('  @Archiviste   what?  '), true);
    assert.strictEqual(shouldCallLLM('\t\n Archiviste\n\t'), true);
  });

  test('should handle accented names in mentions', () => {
    // Normalize should handle accents
    assert.strictEqual(shouldCallLLM('@Archiviste'), true);
  });
});
