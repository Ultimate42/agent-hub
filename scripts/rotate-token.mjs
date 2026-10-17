#!/usr/bin/env node
// Rotate a room token (or admin token) or a member token directly in the SQLite DB.
// Usage:
//   node scripts/rotate-token.mjs --room <id> [--admin] --out <file>
//   node scripts/rotate-token.mjs --member <id> --out <file>
// DB: HUB_DB_PATH, or HUB_DATA_DIR/hub.db. The new token is written to --out
// (mode 600) and never printed. Stop the hub (or accept a brief race) before running.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { generateToken } from '../src/utils/tokens.js';

export function rotateToken(db, { room, member, admin = false, length = 22 }) {
  const token = generateToken(length);
  let info;
  if (room != null) {
    const col = admin ? 'admin_token' : 'token';
    info = db.prepare(`UPDATE rooms SET ${col} = ? WHERE id = ?`).run(token, room);
  } else if (member != null) {
    info = db.prepare('UPDATE members SET token = ? WHERE id = ?').run(token, member);
  } else {
    throw new Error('Specify room or member');
  }
  if (info.changes !== 1) throw new Error('No matching row');
  return token;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const out = get('--out');
  if (!out || (!get('--room') && !get('--member'))) {
    console.error('Usage: rotate-token.mjs (--room <id> [--admin] | --member <id>) --out <file>');
    process.exit(2);
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dbPath = process.env.HUB_DB_PATH || path.join(process.env.HUB_DATA_DIR || path.join(root, 'data'), 'hub.db');
  const db = new Database(dbPath);
  const token = rotateToken(db, {
    room: get('--room') ? Number(get('--room')) : undefined,
    member: get('--member') ? Number(get('--member')) : undefined,
    admin: a.includes('--admin')
  });
  db.close();
  fs.writeFileSync(out, token, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log(`Token rotated; new value written to ${out}`);
}
