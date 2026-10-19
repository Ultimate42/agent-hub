import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isValidWakeFilePath } from '../src/utils/paths.js';
import { parseDbTime } from '../src/utils/time.js';
import { calculatePresence } from '../src/utils/members.js';

const sqlNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

test('wake path validator: win32 absolute paths', () => {
  const w = path.win32;
  assert.ok(isValidWakeFilePath('C:\\Users\\me\\wake', w));
  assert.ok(isValidWakeFilePath('C:/Users/me/wake', w));
  assert.ok(isValidWakeFilePath('\\\\server\\share\\wake', w));
  assert.ok(!isValidWakeFilePath('relative\\dir', w));
  assert.ok(!isValidWakeFilePath('C:\\Users\\..\\Windows', w));
  assert.ok(!isValidWakeFilePath('C:\\Users/../Windows', w));
  assert.ok(!isValidWakeFilePath('C:\\a\0b', w));
});

test('wake path validator: posix and native', () => {
  const p = path.posix;
  assert.ok(isValidWakeFilePath('/tmp/wake', p));
  assert.ok(!isValidWakeFilePath('/tmp/../etc', p));
  assert.ok(!isValidWakeFilePath('/tmp\\..\\etc', p));
  assert.ok(!isValidWakeFilePath('tmp/wake', p));
  assert.ok(!isValidWakeFilePath('', p));
  assert.ok(isValidWakeFilePath(path.join(os.tmpdir(), 'wake')));
});

test('presence from SQLite UTC timestamps', () => {
  assert.equal(calculatePresence(sqlNow(-60_000)), 'active');
  assert.equal(calculatePresence(sqlNow(-3600_000)), 'passive');
  assert.equal(calculatePresence(sqlNow(-2 * 86400_000)), 'stale');
  assert.equal(calculatePresence(null), 'stale');
  assert.equal(parseDbTime('2026-01-01 00:00:00'), Date.UTC(2026, 0, 1));
});

for (const tz of ['Europe/Paris', 'America/New_York', 'Asia/Tokyo']) {
  test(`presence correct with process TZ=${tz}`, () => {
    const code = `
      import('./src/utils/members.js').then(({ calculatePresence }) => {
        const f = (o) => new Date(Date.now() + o).toISOString().slice(0, 19).replace('T', ' ');
        const r = [calculatePresence(f(-60000)), calculatePresence(f(-3600000)), calculatePresence(f(-172800000))];
        console.log(JSON.stringify(r));
      });`;
    const out = spawnSync(process.execPath, ['-e', code], {
      cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, TZ: tz }, encoding: 'utf8'
    });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), ['active', 'passive', 'stale']);
  });
}
