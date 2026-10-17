import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { rotateToken } from '../scripts/rotate-token.mjs';

test('rotateToken changes room and member tokens', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE rooms (id INTEGER PRIMARY KEY, token TEXT UNIQUE, admin_token TEXT);
           CREATE TABLE members (id INTEGER PRIMARY KEY, token TEXT UNIQUE);
           INSERT INTO rooms VALUES (1,'old-room','old-admin'); INSERT INTO members VALUES (1,'old-member');`);
  const r = rotateToken(db, { room: 1 });
  assert.notStrictEqual(r, 'old-room');
  assert.strictEqual(db.prepare('SELECT token FROM rooms').get().token, r);
  assert.strictEqual(db.prepare('SELECT admin_token FROM rooms').get().admin_token, 'old-admin');
  const m = rotateToken(db, { member: 1 });
  assert.strictEqual(db.prepare('SELECT token FROM members').get().token, m);
  assert.throws(() => rotateToken(db, { room: 99 }));
});
