import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const dbPathWith = (env) => execFileSync('node', ['-e', "import('./src/config.js').then(m=>console.log(m.config.dbPath))"],
  { cwd: root, env: { PATH: process.env.PATH, ...env } }).toString().trim();

test('default data dir is ./data', () => {
  assert.equal(dbPathWith({}), path.join('data', 'hub.db'));
});
test('HUB_DATA_DIR relocates the database', () => {
  const d = path.join(os.tmpdir(), 'hub-data-dir-test');
  assert.equal(dbPathWith({ HUB_DATA_DIR: d }), path.join(d, 'hub.db'));
});
test('DB_PATH overrides HUB_DATA_DIR', () => {
  assert.equal(dbPathWith({ HUB_DATA_DIR: '/x', DB_PATH: '/y/z.db' }), '/y/z.db');
});
