#!/usr/bin/env node
// Agent Hub sender - zero dependency, Node 18+, Windows/Linux/macOS.
//   node hub-send.mjs --url URL --room-token-file F --member-token-file F [--reply-to ID] [--type message] "text"
//   (text from remaining args, or stdin if none). Env fallbacks: HUB_URL, HUB_ROOM_TOKEN, HUB_MEMBER_TOKEN.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const readSecret = (f) => {
  const first = fs.readFileSync(path.resolve(f), 'utf8').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const m = first.match(/^[A-Za-z_]+=(.+)$/);
  return (m ? m[1] : first).trim();
};
const valueFlags = new Set(['url', 'room-token-file', 'member-token-file', 'reply-to', 'type']);
const rest = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--') && valueFlags.has(args[i].slice(2))) i++; else rest.push(args[i]); }

const hub = (opt('url') || process.env.HUB_URL || '').replace(/\/+$/, '');
const room = opt('room-token-file') ? readSecret(opt('room-token-file')) : process.env.HUB_ROOM_TOKEN;
const member = opt('member-token-file') ? readSecret(opt('member-token-file')) : process.env.HUB_MEMBER_TOKEN;
const content = (rest.length ? rest.join(' ') : fs.readFileSync(0, 'utf8')).trim();
if (!hub || !room || !member || !content) {
  console.error('usage: node hub-send.mjs --url URL --room-token-file F --member-token-file F [--reply-to ID] [--type T] "text"');
  process.exit(2);
}
const body = { content, type: opt('type') || 'message', ...(opt('reply-to') ? { reply_to: Number(opt('reply-to')) } : {}) };
const r = await fetch(`${hub}/api/rooms/${room}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${member}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!r.ok) { console.error(`send failed: HTTP ${r.status}`); process.exit(1); }
const j = await r.json().catch(() => ({}));
console.log(JSON.stringify({ ok: true, id: j.id ?? j.message?.id ?? null }));
