import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retention-'));
const DAY = 24 * 3600 * 1000;
let database, retention;

// Room with one message `ageDays` old (DB timestamps are UTC "YYYY-MM-DD HH:MM:SS")
function roomWithActivity(name, ageDays, settings = {}) {
  const id = Number(database.createRoom(`tok-${name}`, `adm-${name}`, name, settings));
  const memberId = Number(database.createMember(id, `mem-${name}`, 'Alice'));
  const msgId = Number(database.createMessage(id, memberId, 'message', 'hello'));
  const ts = new Date(Date.now() - ageDays * DAY).toISOString().slice(0, 19).replace('T', ' ');
  database.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, msgId);
  database.db.prepare('UPDATE rooms SET created_at = ? WHERE id = ?').run(ts, id);
  return id;
}

describe('Room retention', () => {
  before(async () => {
    process.env.DB_PATH = path.join(DIR, 'hub.db');
    // Pre-existing production rooms 38-40 must be set to "never" by the one-time migration
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(process.env.DB_PATH);
    raw.exec(`CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, admin_token TEXT NOT NULL,
      name TEXT, directive TEXT, settings TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    for (const id of [37, 38, 39, 40]) raw.prepare('INSERT INTO rooms (id, token, admin_token, name, settings) VALUES (?, ?, ?, ?, ?)').run(id, `t${id}`, `a${id}`, `R${id}`, '{"secure_mode":false}');
    raw.close();
    ({ database } = await import('../src/db.js'));
    retention = await import('../src/services/retention.js');
  });

  after(() => {
    database.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  test('migration: rooms 38, 39, 40 never expire, others keep the default', () => {
    for (const id of [38, 39, 40]) {
      const s = database.getRoomById(id).settings;
      assert.strictEqual(s.retention_days, 0);
      assert.strictEqual(s.secure_mode, false, 'other settings kept');
    }
    assert.strictEqual(database.getRoomById(37).settings.retention_days, undefined);
    assert.strictEqual(retention.roomRetentionDays({}), 7);
  });

  test('warns one day before, deletes only after the warning, a message resets it', () => {
    const fresh = roomWithActivity('fresh', 1);
    const soon = roomWithActivity('soon', 6.5);
    const keep = roomWithActivity('keep', 30, { retention_days: 0 });

    let r = retention.runRetention();
    assert.deepStrictEqual(r.warned, [soon]);
    assert.deepStrictEqual(r.deleted, []);
    const warning = database.getMessages(soon, 10).at(-1);
    assert.strictEqual(warning.author, 'HubWatchdog');
    assert.match(warning.content, /deleted on .* after 7 days without messages/);

    // Same pass again: no second warning
    assert.deepStrictEqual(retention.runRetention().warned, []);

    // 1 day later: deleted (the warning itself does not count as activity)
    r = retention.runRetention(Date.now() + DAY);
    assert.deepStrictEqual(r.deleted, [soon]);
    assert.strictEqual(database.getRoomById(soon), undefined);
    assert.ok(database.getRoomById(fresh));
    assert.ok(database.getRoomById(keep));
  });

  test('an expired room is never deleted without a prior warning', () => {
    const old = roomWithActivity('old', 20);
    let r = retention.runRetention();
    assert.deepStrictEqual(r.deleted, []);
    assert.deepStrictEqual(r.warned, [old]);
    r = retention.runRetention(Date.now() + DAY);
    assert.deepStrictEqual(r.deleted, [old]);
  });

  test('set_retention validates and clears a pending warning', () => {
    const id = roomWithActivity('cfg', 6.5);
    retention.runRetention();
    assert.ok(database.getRoomById(id).settings.retention_warned_at);
    const member = database.getMemberByToken('mem-cfg');
    assert.deepStrictEqual(retention.setRoomRetention(member, 'never'), { ok: true, retention_days: 0 });
    assert.strictEqual(database.getRoomById(id).settings.retention_warned_at, undefined);
    assert.deepStrictEqual(retention.runRetention(Date.now() + 10 * DAY).deleted.includes(id), false);
    assert.strictEqual(retention.setRoomRetention(member, 30).retention_days, 30);
    assert.strictEqual(retention.setRoomRetention(member, -1).ok, false);
    assert.strictEqual(retention.setRoomRetention(member, 'soon').ok, false);
  });
});
