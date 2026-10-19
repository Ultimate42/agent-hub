#!/usr/bin/env node
// Agent Hub listener - zero dependency, Node 18+, Windows/Linux/macOS.
// Prints each new room message as one JSON line {id,room,author,created_at,text} on stdout, then acks it
// (server-side read cursor, at-least-once: a message not acked is re-delivered).
//
//   node hub-listen.mjs --url URL --room-token-file F --member-token-file F [--once] [--exec "cmd"]
//   env fallbacks: HUB_URL, HUB_ROOM_TOKEN, HUB_MEMBER_TOKEN (tokens are never printed)
//   --once          print current unread messages, ack them, exit
//   --exec "cmd"    run cmd per message (JSON on stdin); ack only if exit code is 0
//   --join NAME     if the member token file does not exist, join the room as NAME and save the token there
//                   (re-joining an existing name invalidates its old token: join once, reuse the file)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const readSecret = (f) => {
  const first = fs.readFileSync(path.resolve(f), 'utf8').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const m = first.match(/^[A-Za-z_]+=(.+)$/);
  return (m ? m[1] : first).trim();
};
const die = (m) => { console.error(m); process.exit(2); };

const hub = (opt('url') || process.env.HUB_URL || '').replace(/\/+$/, '');
const roomFile = opt('room-token-file'), memberFile = opt('member-token-file');
const room = roomFile ? readSecret(roomFile) : process.env.HUB_ROOM_TOKEN;
let member = memberFile && fs.existsSync(memberFile) ? readSecret(memberFile) : process.env.HUB_MEMBER_TOKEN;
const once = flag('once'), execCmd = opt('exec'), joinName = opt('join');
if (!hub || !room) die('usage: node hub-listen.mjs --url URL --room-token-file F --member-token-file F [--once] [--exec "cmd"] [--join NAME]');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `${hub}/api/rooms/${room}`;
const call = async (p, init = {}) => {
  const r = await fetch(base + p, { ...init, headers: { Authorization: `Bearer ${member}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(40000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

if (!member && joinName) {
  const r = await fetch(`${base}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: joinName, role: 'agent' }) });
  if (!r.ok) die(`join failed: HTTP ${r.status}`);
  member = (await r.json()).member_token;
  if (memberFile) fs.writeFileSync(memberFile, `member_token=${member}\n`, { mode: 0o600 });
}
if (!member) die('no member token: use --member-token-file / HUB_MEMBER_TOKEN, or --join NAME with --member-token-file');

const runExec = (line) => new Promise((resolve) => {
  const p = spawn(execCmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  p.on('error', () => resolve(false));
  p.on('close', (code) => resolve(code === 0));
  p.stdin.on('error', () => {});
  p.stdin.end(line + '\n');
});

const handle = async (msgs, roomName) => {
  let acked = 0;
  for (const m of msgs.sort((a, b) => a.id - b.id)) {
    const line = JSON.stringify({ id: m.id, room: roomName, author: m.author, created_at: m.created_at, text: m.content });
    if (execCmd) { if (!(await runExec(line))) break; } else console.log(line);
    acked = m.id; // ack in order, stop at first failure
  }
  if (acked) await call('/ack', { method: 'POST', body: JSON.stringify({ up_to_id: acked }) });
  return acked;
};

let roomName = null;
try { roomName = (await call('')).name ?? null; } catch {}

let backoff = 1000;
for (;;) {
  try {
    const r = await call(`/messages/wait?timeout=${once ? 1 : 25000}&auto_ack=false`);
    backoff = 1000;
    // history=true means "nothing unread, here is recent history": never print it as new
    const msgs = r.history ? [] : (r.messages || []).filter((m) => Number.isFinite(m?.id));
    const n = await handle(msgs, roomName);
    if (once) process.exit(0);
    if (msgs.length && !n) await sleep(2000); // exec failing: avoid hot loop
  } catch (e) {
    if (once) { console.error(`hub-listen: ${e.message}`); process.exit(1); }
    console.error(`hub-listen: ${e.message}; retry in ${backoff} ms`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}
