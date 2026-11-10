#!/usr/bin/env node
// Agent Hub watcher ("guetteur") - zero dependency, Node 18+, Windows/Linux/macOS.
// Listens to one or more rooms (long-poll + server read cursor) and WAKES an agent for each batch of messages.
//
//   node hub-watch.mjs run     --url URL --room-token-file F --member-token-file F --name NAME --mode MODE [opts]
//   node hub-watch.mjs status  [--state-dir D]            exit 0 = healthy, 1 = stale/dead
//   node hub-watch.mjs install [--os linux|windows|macos] [--out DIR] -- <same args as run>
//
// Modes (--mode):
//   claude-code  start a Claude Code turn: `claude -p --resume <id>` (--session-id ID) or `claude -p --continue` (in --cwd)
//   exec         run --exec "cmd" per batch (JSON on stdin, text in $HUB_WATCH_TEXT): notification, webhook, any hook
//   file         write <inbox>/<room>-<firstId>-<lastId>.json (for agents that read a file)
//   sdk          not handled here: see runner/hub-session-runner.mjs
// A batch is acked (POST /ack) ONLY after the wake succeeded (exit 0 / file written): otherwise it is re-delivered.
// Messages that arrive during a turn stay unread on the server and come as ONE grouped batch afterwards.
//
// Options (also usable as keys of --config file.json, flags win):
//   --url, --room-token-file, --member-token-file (repeat room/member pairs via config "rooms":[{label,roomTokenFile,memberTokenFile}])
//   --name NAME            my member name (own messages are ignored). Which messages wake me is the hub rule (my wake policy, see AGENT-SETUP.md); --only-mentions can only tighten it: @NAME or reply to me
//   --session-id ID, --cwd DIR, --claude-bin PATH, --claude-args "..." (e.g. "--permission-mode acceptEdits")
//   --turn-timeout SEC (default 900)   --exec CMD   --inbox DIR   --max-wakes-per-min N (default 6, 0 = unlimited)
//   --state-dir DIR (default ~/.agent-hub-watch/<name>)   --log-file F   --reply-hint "text" (extra line in the prompt)
// Tokens are read from files / env (HUB_ROOM_TOKEN, HUB_MEMBER_TOKEN) and are never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const CHAT_TYPES = new Set(['message', 'question', 'response', 'directive']);
const VALUE_FLAGS = new Set(['url', 'room-token-file', 'member-token-file', 'name', 'mode', 'session-id', 'cwd', 'claude-bin', 'claude-args',
  'turn-timeout', 'exec', 'inbox', 'max-wakes-per-min', 'state-dir', 'log-file', 'reply-hint', 'config', 'os', 'out', 'heartbeat-max-age']);

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1).map((x) => ({ raw: x }))); o.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (VALUE_FLAGS.has(k)) o[k] = argv[++i]; else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
const readSecret = (f) => {
  const first = fs.readFileSync(path.resolve(f), 'utf8').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const m = first.match(/^[A-Za-z_]+=(.+)$/);
  return (m ? m[1] : first).trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const isMentioned = (content, name) => !!name && new RegExp(`@${esc(name)}(?![\\w-])`, 'i').test(content || '');
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** Build the effective config from flags + optional JSON file. */
export function buildConfig(opts, env = process.env) {
  let file = {};
  if (opts.config) file = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  const pick = (k, camel) => opts[k] ?? file[camel] ?? file[k];
  const url = String(pick('url', 'url') || env.HUB_URL || '').replace(/\/+$/, '');
  const rooms = [];
  for (const r of file.rooms || []) rooms.push({ label: r.label, roomTokenFile: r.roomTokenFile, memberTokenFile: r.memberTokenFile, roomToken: r.roomToken, memberToken: r.memberToken });
  const rf = pick('room-token-file', 'roomTokenFile'), mf = pick('member-token-file', 'memberTokenFile');
  if (rf || env.HUB_ROOM_TOKEN) rooms.push({ roomTokenFile: rf, memberTokenFile: mf });
  const name = pick('name', 'name') || '';
  const cfg = {
    url, name, rooms,
    mode: pick('mode', 'mode') || 'claude-code',
    onlyMentions: !!(opts['only-mentions'] ?? file.onlyMentions),
    sessionId: pick('session-id', 'sessionId'),
    cwd: pick('cwd', 'cwd') || process.cwd(),
    claudeBin: pick('claude-bin', 'claudeBin') || 'claude',
    claudeArgs: pick('claude-args', 'claudeArgs') || '',
    turnTimeoutMs: Number(pick('turn-timeout', 'turnTimeout') || 900) * 1000,
    exec: pick('exec', 'exec'),
    inbox: pick('inbox', 'inbox'),
    maxWakesPerMin: Number(pick('max-wakes-per-min', 'maxWakesPerMin') ?? 6),
    replyHint: pick('reply-hint', 'replyHint') || '',
    logFile: pick('log-file', 'logFile'),
    pollTimeoutMs: Number(file.pollTimeoutMs || env.HUB_WATCH_POLL_MS || 25000),
    backoffMaxMs: Number(file.backoffMaxMs || 30000),
    backoffMinMs: Number(file.backoffMinMs || 1000),
  };
  cfg.stateDir = path.resolve(pick('state-dir', 'stateDir') || path.join(os.homedir(), '.agent-hub-watch', (name || 'default').replace(/[^\w.-]/g, '_')));
  return cfg;
}
export function validateConfig(cfg, env = process.env) {
  const errs = [];
  if (!cfg.url) errs.push('--url (or HUB_URL) is required');
  if (!cfg.rooms.length) errs.push('at least one room is required (--room-token-file / HUB_ROOM_TOKEN / config rooms[])');
  if (!['claude-code', 'exec', 'file', 'sdk'].includes(cfg.mode)) errs.push(`unknown mode "${cfg.mode}" (claude-code|exec|file|sdk)`);
  if (cfg.mode === 'exec' && !cfg.exec) errs.push('mode exec needs --exec "cmd"');
  if (cfg.mode === 'file' && !cfg.inbox) errs.push('mode file needs --inbox DIR');
  if (cfg.onlyMentions && !cfg.name) errs.push('--only-mentions needs --name');
  return errs;
}

/** Pure filter: should this message wake me? `isReplyToMe(id)` is async. */
export async function shouldWake(msg, cfg, isReplyToMe) {
  if (!msg || !Number.isFinite(msg.id)) return false;
  if (msg.type && !CHAT_TYPES.has(msg.type)) return false;
  if (!msg.content) return false;
  const a = msg.author || '';
  if (cfg.name && same(a, cfg.name)) return false;
  if (/^auto-/i.test(a) || same(a, 'system') || same(a, 'HubWatchdog')) return false;
  if (cfg.onlyMentions) return isMentioned(msg.content, cfg.name) || (msg.reply_to ? await isReplyToMe(msg.reply_to) : false);
  return true;
}

export function buildPrompt(roomLabel, msgs, cfg) {
  const lines = msgs.map((m) => `[Hub ${roomLabel} #${m.id} de ${m.author}${m.reply_to ? ` (réponse à #${m.reply_to})` : ''}] ${m.content}`);
  const hint = cfg.replyHint || 'Réponds dans le salon (par ex. avec client/hub-send.mjs) si une réponse est attendue.';
  return `Nouveau(x) message(s) dans le salon "${roomLabel}" (${msgs.length}) :\n${lines.join('\n')}\n\n${hint}\nTraite-les, puis termine ton tour.`;
}

/** Split a command-line string into args (quotes supported). */
export function splitArgs(s) {
  const out = []; let cur = '', q = null, has = false;
  for (const ch of s || '') {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const isWin = process.platform === 'win32';
const killTree = (child) => {
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref(); }
  } catch {}
};
/** Run a child with stdin text; resolves {ok, code, timedOut}. Never rejects. */
function runChild(cmd, args, { input, cwd, env, timeoutMs, shell, log }) {
  return new Promise((resolve) => {
    let done = false, timedOut = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ ...r, timedOut }); } };
    let p;
    try { p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return resolve({ ok: false, code: -1, timedOut: false, error: e.message }); }
    const tail = (d) => { const t = String(d).trim(); if (t) log(`  | ${t.slice(0, 300)}`); };
    p.stdout.on('data', tail); p.stderr.on('data', tail);
    p.on('error', (e) => fin({ ok: false, code: -1, error: e.message }));
    p.on('close', (code) => fin({ ok: code === 0, code }));
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
    const timer = setTimeout(() => { timedOut = true; log(`turn timeout after ${Math.round(timeoutMs / 1000)}s, killing child`); killTree(p); }, timeoutMs);
  });
}

class Mutex {
  constructor() { this.q = Promise.resolve(); }
  run(fn) { const r = this.q.then(fn, fn); this.q = r.catch(() => {}); return r; }
}

export class Watcher {
  constructor(cfg, { log } = {}) {
    this.cfg = cfg;
    this.secrets = [];
    this.logFn = log;
    this.stopping = false;
    this.mutex = new Mutex();
    this.wakes = [];
    this.state = { pid: process.pid, started: Date.now(), lastPollOk: 0, lastWake: 0, lastWakeOk: 0, wakeCount: 0, failures: 0, rooms: {} };
    this.abort = new AbortController();
    this.rooms = cfg.rooms.map((r, i) => {
      const roomToken = r.roomToken || (r.roomTokenFile ? readSecret(r.roomTokenFile) : process.env.HUB_ROOM_TOKEN);
      const memberToken = r.memberToken || (r.memberTokenFile && fs.existsSync(r.memberTokenFile) ? readSecret(r.memberTokenFile) : process.env.HUB_MEMBER_TOKEN);
      if (!roomToken || !memberToken) throw new Error(`room #${i + 1}: missing room or member token`);
      this.secrets.push(roomToken, memberToken);
      return { label: r.label || `room${i + 1}`, roomToken, memberToken, authors: new Map(), name: null };
    });
  }
  log(msg) {
    let s = `${new Date().toISOString()} ${msg}`;
    for (const t of this.secrets) if (t && t.length >= 6) s = s.split(t).join('***');
    (this.logFn || ((x) => console.log(x)))(s);
  }
  heartbeat() {
    try {
      fs.mkdirSync(this.cfg.stateDir, { recursive: true });
      const f = path.join(this.cfg.stateDir, 'heartbeat.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify({ ...this.state, now: Date.now(), mode: this.cfg.mode, rooms: this.state.rooms }));
      fs.renameSync(f + '.tmp', f);
    } catch {}
  }
  lock() {
    fs.mkdirSync(this.cfg.stateDir, { recursive: true });
    const f = path.join(this.cfg.stateDir, 'watcher.lock');
    if (fs.existsSync(f)) {
      const pid = Number(fs.readFileSync(f, 'utf8').trim());
      let alive = false;
      if (pid && pid !== process.pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      if (alive) throw new Error(`another watcher is already running (pid ${pid}, lock ${f})`);
    }
    fs.writeFileSync(f, String(process.pid));
    this.lockFile = f;
  }
  unlock() { try { if (this.lockFile && Number(fs.readFileSync(this.lockFile, 'utf8')) === process.pid) fs.unlinkSync(this.lockFile); } catch {} }

  async api(room, p, init = {}) {
    const r = await fetch(`${this.cfg.url}/api/rooms/${room.roomToken}${p}`, {
      ...init, headers: { Authorization: `Bearer ${room.memberToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(this.cfg.pollTimeoutMs + 15000), this.abort.signal]),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${p.split('?')[0] || '/'}`);
    return r.json();
  }
  /** Ask the hub which of these messages wake me under MY wake policy (hub rule, not a local one).
   *  Returns Map(id -> decision), or null when the hub is too old to know (legacy local filter then). */
  async hubDecisions(room, msgs) {
    if (this.noWakeCheck) return null;
    try {
      const r = await this.api(room, '/wake-check', { method: 'POST', body: JSON.stringify({ message_ids: msgs.map((m) => m.id) }) });
      if (r.policy !== room.policy) { room.policy = r.policy; this.log(`${room.label}: wake policy from hub = ${r.policy} (anti-loop limit ${r.loop_limit})`); }
      return new Map((r.decisions || []).map((d) => [d.id, d]));
    } catch (e) {
      if (/HTTP 404/.test(e.message)) { this.noWakeCheck = true; this.log('hub has no /wake-check: falling back to the local filter (update the hub)'); return null; }
      throw e;
    }
  }
  async isReplyToMe(room, id) {
    if (!room.authors.has(id)) {
      try {
        const h = await this.api(room, `/messages/history?before_id=${id + 1}&limit=100`);
        for (const m of h.messages || []) room.authors.set(m.id, m.author);
      } catch {}
    }
    return same(room.authors.get(id), this.cfg.name);
  }
  /** Wake-rate limiter: returns ms to wait before the next wake is allowed. */
  rateDelay() {
    const lim = this.cfg.maxWakesPerMin;
    if (!(lim > 0)) return 0;
    const now = Date.now();
    this.wakes = this.wakes.filter((t) => now - t < 60000);
    return this.wakes.length < lim ? 0 : 60000 - (now - this.wakes[0]) + 50;
  }

  /** Execute one wake for a batch. Returns true on success. */
  async wake(room, msgs) {
    const cfg = this.cfg;
    const text = buildPrompt(room.label, msgs, cfg);
    const log = (m) => this.log(m);
    if (cfg.mode === 'file') {
      fs.mkdirSync(cfg.inbox, { recursive: true });
      const base = `${room.label.replace(/[^\w.-]/g, '_')}-${msgs[0].id}-${msgs.at(-1).id}`;
      const f = path.join(cfg.inbox, base + '.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify({ room: room.label, messages: msgs.map(slim), text }, null, 2));
      fs.renameSync(f + '.tmp', f);
      return true;
    }
    if (cfg.mode === 'exec') {
      const payload = JSON.stringify({ room: room.label, messages: msgs.map(slim), text });
      const r = await runChild(cfg.exec, [], { input: payload + '\n', cwd: cfg.cwd, shell: true, timeoutMs: cfg.turnTimeoutMs, log,
        env: { HUB_WATCH_ROOM: room.label, HUB_WATCH_COUNT: String(msgs.length), HUB_WATCH_TEXT: text, HUB_WATCH_LAST_ID: String(msgs.at(-1).id) } });
      if (!r.ok) log(`exec failed (code ${r.code}${r.error ? ', ' + r.error : ''})`);
      return r.ok;
    }
    if (cfg.mode === 'claude-code') {
      const args = ['-p'];
      if (cfg.sessionId) args.push('--resume', cfg.sessionId); else args.push('--continue');
      args.push(...splitArgs(cfg.claudeArgs));
      // prompt on stdin: no command-line quoting problem, works on Windows (claude.cmd needs a shell)
      const r = await runChild(cfg.claudeBin, args, { input: text, cwd: cfg.cwd, shell: isWin, timeoutMs: cfg.turnTimeoutMs, log, env: {} });
      if (!r.ok) log(`claude turn failed (code ${r.code}${r.timedOut ? ', timeout' : ''}${r.error ? ', ' + r.error : ''})`);
      return r.ok;
    }
    return false;
  }

  async roomLoop(room) {
    const cfg = this.cfg;
    const rs = this.state.rooms[room.label] = { lastPollOk: 0, lastAcked: 0, errors: 0 };
    let backoff = cfg.backoffMinMs;
    try { room.name = (await this.api(room, '')).name || null; if (room.name) room.label = room.label.startsWith('room') ? room.name : room.label; } catch {}
    while (!this.stopping) {
      try {
        const r = await this.api(room, `/messages/wait?timeout=${cfg.pollTimeoutMs}&auto_ack=false`);
        backoff = cfg.backoffMinMs; rs.errors = 0;
        rs.lastPollOk = this.state.lastPollOk = Date.now(); this.heartbeat();
        const all = r.history ? [] : (r.messages || []).filter((m) => Number.isFinite(m?.id)).sort((a, b) => a.id - b.id);
        if (!all.length) continue;
        for (const m of all) room.authors.set(m.id, m.author);
        const maxId = all.at(-1).id;
        const todo = [];
        const decisions = await this.hubDecisions(room, all);
        for (const m of all) {
          const d = decisions?.get(m.id);
          if (d && !d.wake) { if (d.reason === 'loop-suspended') this.log(`${room.label} #${m.id}: wake suspended by the hub anti-loop guard`); continue; }
          // local checks stay as a safety net (own/system messages) and --only-mentions can only tighten the hub policy
          if (await shouldWake(m, cfg, (id) => this.isReplyToMe(room, id))) todo.push(m);
        }
        if (todo.length) {
          const wait = this.rateDelay();
          if (wait > 0) { this.log(`rate limit reached (${cfg.maxWakesPerMin}/min): waiting ${Math.ceil(wait / 1000)}s, messages stay unread`); await sleep(wait); }
          if (this.stopping) break;
          const ok = await this.mutex.run(async () => {
            this.wakes.push(Date.now()); this.state.lastWake = Date.now(); this.state.wakeCount++;
            this.log(`wake [${cfg.mode}] ${room.label}: ${todo.length} message(s) #${todo[0].id}..#${todo.at(-1).id}`);
            return this.wake(room, todo);
          });
          if (!ok) {
            this.state.failures++; this.heartbeat();
            this.log(`wake failed: not acked, retry in ${Math.round(backoff / 1000)}s`);
            await sleep(backoff); backoff = Math.min(backoff * 2, cfg.backoffMaxMs);
            continue;
          }
          this.state.lastWakeOk = Date.now();
        }
        await this.api(room, '/ack', { method: 'POST', body: JSON.stringify({ up_to_id: maxId }) });
        rs.lastAcked = maxId; this.heartbeat();
      } catch (e) {
        if (this.stopping) break;
        rs.errors++; this.state.failures++;
        this.log(`${room.label}: ${e.message}; retry in ${Math.round(backoff / 1000)}s`);
        this.heartbeat();
        await sleep(backoff);
        backoff = Math.min(backoff * 2, cfg.backoffMaxMs);
      }
    }
  }
  async start() {
    this.lock();
    this.log(`watcher started: mode=${this.cfg.mode} rooms=${this.rooms.length} name=${this.cfg.name || '(none)'} onlyMentions=${this.cfg.onlyMentions} state=${this.cfg.stateDir}`);
    if (!this.cfg.name) this.log('warning: no --name, own messages are only excluded by the server cursor');
    this.heartbeat();
    this.hb = setInterval(() => this.heartbeat(), 10000); this.hb.unref();
    this.loops = Promise.all(this.rooms.map((r) => this.roomLoop(r)));
  }
  async stop() {
    this.stopping = true; clearInterval(this.hb);
    this.abort.abort();
    await Promise.race([this.loops, sleep(3000)]);
    this.state.stopped = Date.now(); this.heartbeat();
    this.unlock();
    this.log('watcher stopped');
  }
}
const slim = (m) => ({ id: m.id, author: m.author, created_at: m.created_at, reply_to: m.reply_to ?? null, text: m.content });

export function statusOf(stateDir, maxAgeSec = 90) {
  const f = path.join(path.resolve(stateDir), 'heartbeat.json');
  if (!fs.existsSync(f)) return { ok: false, text: `no heartbeat at ${f}: watcher never started` };
  const hb = JSON.parse(fs.readFileSync(f, 'utf8'));
  let alive = false;
  try { process.kill(hb.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  const age = hb.lastPollOk ? Math.round((Date.now() - hb.lastPollOk) / 1000) : null;
  const ok = alive && !hb.stopped && age !== null && age <= maxAgeSec;
  const fmt = (t) => (t ? new Date(t).toISOString() : 'never');
  return { ok, text: `${ok ? 'OK' : 'KO'} pid=${hb.pid} alive=${alive} mode=${hb.mode} lastPollOk=${fmt(hb.lastPollOk)} (${age ?? '-'}s ago, max ${maxAgeSec}s) lastWake=${fmt(hb.lastWake)} lastWakeOk=${fmt(hb.lastWakeOk)} wakes=${hb.wakeCount} failures=${hb.failures}` };
}

// ---------- install: generate service files, print exact commands, execute nothing ----------
export function generateService(osName, runArgs, { node = process.execPath, script = SELF, name = 'agent-hub-watch', home = os.homedir() } = {}) {
  const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  if (osName === 'linux') {
    const exec = [node, script, 'run', ...runArgs].map(q).join(' ');
    return { file: `${name}.service`, install: `mkdir -p ~/.config/systemd/user && cp ${name}.service ~/.config/systemd/user/\nsystemctl --user daemon-reload\nsystemctl --user enable --now ${name}.service\nloginctl enable-linger "$USER"   # optional: keep running after logout\n# check: systemctl --user status ${name}.service ; journalctl --user -u ${name} -f`,
      content: `[Unit]\nDescription=Agent Hub watcher\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=always\nRestartSec=5\nKillSignal=SIGTERM\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n` };
  }
  if (osName === 'macos') {
    const label = `com.agenthub.${name}`;
    const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const items = [node, script, 'run', ...runArgs].map((a) => `    <string>${x(a)}</string>`).join('\n');
    return { file: `${label}.plist`, install: `mkdir -p ~/Library/LaunchAgents && cp ${label}.plist ~/Library/LaunchAgents/\nlaunchctl load ~/Library/LaunchAgents/${label}.plist\n# check: launchctl list | grep ${name} ; logs: ${home}/.agent-hub-watch/launchd.log`,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${items}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${x(home)}/.agent-hub-watch/launchd.log</string>\n  <key>StandardErrorPath</key><string>${x(home)}/.agent-hub-watch/launchd.log</string>\n</dict></plist>\n` };
  }
  if (osName === 'windows') {
    const ps = (s) => `'${s.replace(/'/g, "''")}'`;
    const argList = ['"' + script + '"', 'run', ...runArgs.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))].join(' ');
    return { file: `${name}-install.ps1`, install: `powershell -NoProfile -ExecutionPolicy Bypass -File .\\${name}-install.ps1\n# check: Get-ScheduledTask -TaskName ${name} ; node "${script}" status ; remove: Unregister-ScheduledTask -TaskName ${name} -Confirm:$false`,
      content: `# Registers a per-user scheduled task (no admin needed): starts at logon, restarts on failure, no time limit.\n$ErrorActionPreference = 'Stop'\n$action   = New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(argList)}\n$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME\n$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew\nRegister-ScheduledTask -TaskName ${ps(name)} -Action $action -Trigger $trigger -Settings $settings -Description 'Agent Hub watcher' -Force | Out-Null\nStart-ScheduledTask -TaskName ${ps(name)}\nWrite-Host 'Task ${name} registered and started.'\n` };
  }
  throw new Error(`unknown --os "${osName}" (linux|windows|macos)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = ['run', 'status', 'install'].includes(argv[0]) ? argv.shift() : 'run';
  const opts = parseArgs(argv);
  if (cmd === 'status') {
    const cfgDir = opts['state-dir'] || (opts.config || opts.name ? buildConfig(opts).stateDir : path.join(os.homedir(), '.agent-hub-watch', 'default'));
    const s = statusOf(cfgDir, Number(opts['heartbeat-max-age'] || 90));
    console.log(s.text); process.exit(s.ok ? 0 : 1);
  }
  if (cmd === 'install') {
    const osName = opts.os || ({ win32: 'windows', darwin: 'macos' }[process.platform] || 'linux');
    const runArgs = opts.rest || [];
    if (!runArgs.length) { console.error('usage: node hub-watch.mjs install [--os linux|windows|macos] [--out DIR] -- <args of run, with absolute paths>'); process.exit(2); }
    const svc = generateService(osName, runArgs);
    const out = path.resolve(opts.out || path.join(os.homedir(), '.agent-hub-watch', 'service'));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, svc.file), svc.content);
    console.log(`Generated: ${path.join(out, svc.file)}\nNothing was executed. Run these commands yourself (no root needed), from ${out}:\n\n${svc.install}`);
    return;
  }
  const cfg = buildConfig(opts);
  if (cfg.mode === 'sdk') { console.error('mode sdk is not run by the watcher: use runner/hub-session-runner.mjs (see runner/README.md).'); process.exit(2); }
  const errs = validateConfig(cfg);
  if (errs.length) { console.error('hub-watch: ' + errs.join('\nhub-watch: ')); process.exit(2); }
  let logStream = null;
  if (cfg.logFile) { fs.mkdirSync(path.dirname(path.resolve(cfg.logFile)), { recursive: true }); logStream = fs.createWriteStream(cfg.logFile, { flags: 'a' }); }
  const w = new Watcher(cfg, { log: (l) => { console.log(l); logStream?.write(l + '\n'); } });
  try { await w.start(); } catch (e) { console.error(`hub-watch: ${e.message}`); process.exit(3); }
  let closing = false;
  const bye = async () => { if (closing) return; closing = true; await w.stop(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  await w.loops;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(`hub-watch: ${e.message}`); process.exit(1); });
