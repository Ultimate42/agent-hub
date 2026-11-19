#!/usr/bin/env node
// hub-historique: stdio MCP server that searches an agent's PRIVATE history (Claude Code JSONL transcripts).
// Zero dependency, Node >= 18. The transcripts never leave the machine: this process only reads them.
//
// Usage (in .mcp.json):  { "mcpServers": { "history": { "command": "node", "args": ["hub-historique.mjs"] } } }
// Options (argument wins over environment):
//   --dir <path>      HUB_HISTORY_DIR         folder holding the *.jsonl files
//                                             default: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, non-alphanumerics -> "-">
//   --subagents       HUB_HISTORY_SUBAGENTS=1 also read <session>/subagents/*.jsonl
//   --budget-ms <n>   HUB_HISTORY_BUDGET_MS   time budget per search (default 8000)
// Transcripts weigh tens or hundreds of MB, with single lines over 1 MB (repeated API requests): grep is too slow.
// Here: chunked reads from the END of each file (recent first, early stop), request lines skipped before decoding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL = 'historique_chercher';
const CHUNK = 256 * 1024;
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function defaultDir(cwd = process.cwd(), env = process.env) {
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// Lines of a file, forward or backward, with bounded memory: one chunk plus at most MAXLINE bytes of the current line.
// Yields { line, over }. A line longer than MAXLINE keeps only its first MAXLINE bytes (enough to recognise a request
// line) and is flagged `over`: it is never parsed.
const MAXLINE = 8 * 1024 * 1024;
async function* lines(file, reverse) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size, buf = Buffer.allocUnsafe(CHUNK);
    let carry = [], carryLen = 0, over = false, pos = reverse ? size : 0;
    // pieces are in file order; when too long, keep the earliest ones (the head of the line)
    const push = (piece, front) => {
      if (!front && carryLen >= MAXLINE) { over = true; return; }
      if (front) carry.unshift(piece); else carry.push(piece);
      carryLen += piece.length;
      if (carryLen > MAXLINE) { over = true; while (carryLen > MAXLINE && carry.length > 1) carryLen -= carry.pop().length; }
    };
    const take = () => { const line = carry.length === 1 ? carry[0] : Buffer.concat(carry); const o = over; carry = []; carryLen = 0; over = false; return { line, over: o }; };
    while (reverse ? pos > 0 : pos < size) {
      const want = Math.min(CHUNK, reverse ? pos : size - pos), start = reverse ? pos - want : pos;
      const { bytesRead: n } = await fh.read(buf, 0, want, start);
      if (n === 0) break; // file truncated while reading
      const chunk = Buffer.from(buf.subarray(0, n)); // copy: buf is reused
      if (reverse) pos = start; else pos = start + n;
      if (reverse) {
        let e = n;
        for (let i = n - 1; i >= 0; i--) if (chunk[i] === 10) { // newline: everything after it (plus carry) is a full line
          push(chunk.subarray(i + 1, e), true); e = i;
          const r = take(); if (r.line.length) yield r;
        }
        if (e > 0) push(chunk.subarray(0, e), true);
      } else {
        let s = 0;
        for (let i = 0; i < n; i++) if (chunk[i] === 10) {
          push(chunk.subarray(s, i), false); s = i + 1;
          const r = take(); if (r.line.length) yield r;
        }
        if (s < n) push(chunk.subarray(s, n), false);
      }
    }
    if (carry.length) { const r = take(); if (r.line.length) yield r; }
  } finally { await fh.close(); }
}

const isRequest = (b) => { const h = b.subarray(0, 24).toString('utf8'); return h.startsWith('{"type":"api-request') || h.startsWith('{"type": "api-request'); };

// Readable text of an entry. By default only the text of user and assistant messages: tool arguments and results (which
// may hold secrets) are included only with outils=true. Never the reasoning, never <system-reminder> blocks.
const stripReminders = (t) => String(t).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
function readable(d, outils) {
  return readableRaw(d, outils).map((r) => ({ ...r, text: stripReminders(r.text) })).filter((r) => r.text);
}
function readableRaw(d, outils) {
  const m = d?.message; if (!m || (d.type !== 'user' && d.type !== 'assistant')) return [];
  const who = d.type === 'user' ? 'user' : 'assistant';
  if (typeof m.content === 'string') return [{ role: who, text: m.content }];
  const out = [];
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'text' && b.text) out.push({ role: who, text: b.text });
    else if (!outils) continue;
    else if (b.type === 'tool_use') out.push({ role: 'tool ' + b.name, text: JSON.stringify(b.input ?? {}), useId: b.id, name: String(b.name) });
    else if (b.type === 'tool_result') {
      const t = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '');
      if (t) out.push({ role: 'result', text: t, resultOf: b.tool_use_id });
    }
  }
  return out;
}

function listFiles(dir, subagents) {
  const out = [];
  const add = (f) => { try { const st = fs.statSync(f); let start = 0; // unknown start: never excluded by a period, never used to stop early
    try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(16384); const n = fs.readSync(fd, b, 0, 16384, 0); fs.closeSync(fd);
      const m = /"timestamp":"([^"]+)"/.exec(b.subarray(0, n).toString('utf8')); if (m && !isNaN(Date.parse(m[1]))) start = Date.parse(m[1]); } catch {}
    out.push({ f, end: st.mtimeMs, start }); } catch {} };
  let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of names) {
    if (e.isFile() && e.name.endsWith('.jsonl')) add(path.join(dir, e.name));
    else if (subagents && e.isDirectory()) { const sub = path.join(dir, e.name, 'subagents'); try { for (const s of fs.readdirSync(sub)) if (s.endsWith('.jsonl')) add(path.join(sub, s)); } catch {} }
  }
  return out;
}

// All words must be in the same message (accents and case ignored).
// order 'recent' (default): newest first, stops as soon as `max` results are found (exact).
// order 'oldest': oldest first, to find where a fact first appeared when recent echoes drown it.
export async function search({ q, depuis, jusqua, max, ordre = 'recent', outils = false } = {}, { dir, subagents = false, budgetMs = 8000 } = {}) {
  const terms = fold(q || '').split(/\s+/).filter((w) => w.length > 1);
  if (!terms.length) throw new Error('q: at least one word of 2 letters');
  if (!['recent', 'oldest'].includes(ordre)) throw new Error('ordre: "recent" or "oldest"');
  for (const [k, v] of [['depuis', depuis], ['jusqua', jusqua]]) if (v && !/^\d{4}-\d{2}-\d{2}/.test(v)) throw new Error(`${k}: YYYY-MM-DD`);
  const limit = Math.min(Math.max(Number(max) || 8, 1), 20), t0 = Date.now(), rev = ordre === 'recent';
  const found = [], seen = new Set();
  const files = listFiles(dir, subagents).sort((a, b) => rev ? b.end - a.end : a.start - b.start);
  let truncated = false, scanned = 0, reached = null;
  const cmp = (a, b) => rev ? b.when.localeCompare(a.when) : a.when.localeCompare(b.when);
  const dayMs = 864e5, fromMs = depuis ? Date.parse(depuis.slice(0, 10)) : -Infinity, toMs = jusqua ? Date.parse(jusqua.slice(0, 10)) + dayMs : Infinity;

  for (const { f, end, start } of files) {
    if (end < fromMs || start >= toMs) continue; // file entirely outside the period
    if (found.length >= limit) { // the next files cannot beat the current limit-th result
      const edge = [...found].sort(cmp)[limit - 1].when;
      if (rev ? new Date(end).toISOString() < edge : new Date(start).toISOString() > edge) break;
    }
    const own = new Set(), held = new Map(); let n = 0;
    const keep = (r, ts) => {
      const text = fold(r.text); if (!terms.every((w) => text.includes(w))) return false;
      const i = Math.max(0, text.indexOf(terms[0])); // fold keeps the length for most text; otherwise the excerpt shifts slightly
      const ex = r.text.slice(Math.max(0, i - 160), i + 240).replace(/\s+/g, ' ').trim();
      const key = r.role + ex; if (seen.has(key)) return true; seen.add(key);
      found.push({ when: ts, from: r.role, excerpt: ex }); return true;
    };
    try {
      for await (const { line, over } of lines(f, rev)) {
        if (Date.now() - t0 > budgetMs) { truncated = true; break; }
        if (isRequest(line) || over) continue; // oversized lines are API requests in practice: never parsed
        let d; try { d = JSON.parse(line.toString('utf8')); } catch { continue; }
        scanned++; n++;
        const ts = d.timestamp || '', ms = Date.parse(ts);
        if (!isNaN(ms)) {
          reached = ts;
          if (rev ? ms < fromMs : ms >= toMs) break; // chronological file: nothing further in this direction is in the period
          if (rev ? ms >= toMs : ms < fromMs) continue;
        }
        for (const r of readable(d, outils)) {
          if (r.name?.endsWith(TOOL)) { own.add(r.useId); held.delete(r.useId); continue; } // the search never finds itself
          if (r.resultOf) {
            if (own.has(r.resultOf)) continue;
            if (rev) { // reading backward: the call comes after its result, so hold the hit until the call is seen
              const t = fold(r.text); if (terms.every((w) => t.includes(w))) held.set(r.resultOf, { r, ts, n }); continue;
            }
          }
          keep(r, ts);
        }
        for (const [id, h] of held) if (n - h.n > 50) { held.delete(id); keep(h.r, h.ts); } // the call is always close to its result
        if (found.length >= limit && !held.size && !isNaN(ms)) { // past the limit-th best result in this direction: nothing here can beat it
          const edge = [...found].sort(cmp)[limit - 1].when; if (rev ? ts < edge : ts > edge) break;
        }
      }
    } finally { for (const h of held.values()) keep(h.r, h.ts); }
    if (truncated) break;
  }
  found.sort(cmp);
  const res = found.slice(0, limit);
  return { query: q, order: ordre, found: res.length, results: res,
    ...(truncated ? { truncated: `stopped after ${Math.round(budgetMs / 1000)} s (reached ${reached || 'start'}): add a word, or narrow with depuis/jusqua (YYYY-MM-DD)` } : {}),
    ...(!res.length ? { note: `nothing in the ${scanned} entries read: try other words (all words must be in the same message)` } : {}) };
}

const DESCRIPTION = "Search your own past conversations (messages you received and your replies; with outils=true also tool arguments and results): dated excerpts, newest first by default. All words of q must be in the same message (accents and case ignored). Use it for a fact learned in an old conversation or before a context compaction that is neither in the files nor in memory. Raw .jsonl transcripts are too big for grep: use this tool. ordre=\"oldest\" returns the oldest matches first (where a fact first appeared); depuis/jusqua (YYYY-MM-DD, inclusive) restrict the period.";
const SCHEMA = { type: 'object', properties: {
  q: { type: 'string', description: 'words to find together in one message' },
  depuis: { type: 'string', description: 'YYYY-MM-DD: ignore anything older' },
  jusqua: { type: 'string', description: 'YYYY-MM-DD: ignore anything newer (inclusive)' },
  ordre: { type: 'string', enum: ['recent', 'oldest'], description: 'recent (default) or oldest first' },
  outils: { type: 'boolean', description: 'also search tool arguments and results (default false: messages only, tool output may contain secrets)' },
  max: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['q'] };

export function createServer(opts) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
    const { id, method, params } = msg;
    if (typeof method !== 'string') return null; // a response from the client (id + result/error, no method): nothing to answer
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notification
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hub-historique', version: '1.0.0' } });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [{ name: TOOL, description: DESCRIPTION, inputSchema: SCHEMA }] });
    if (method === 'tools/call') {
      if (params?.name !== TOOL) return fail(-32602, 'unknown tool');
      try { return reply({ content: [{ type: 'text', text: JSON.stringify(await search(params.arguments || {}, opts)) }] }); }
      catch (e) { return reply({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }); }
    }
    return fail(-32601, 'method not found');
  };
}

export function optionsFromArgs(argv = process.argv.slice(2), env = process.env) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  return { dir: arg('--dir') || env.HUB_HISTORY_DIR || defaultDir(), subagents: argv.includes('--subagents') || env.HUB_HISTORY_SUBAGENTS === '1',
    budgetMs: Number(arg('--budget-ms') || env.HUB_HISTORY_BUDGET_MS) || 8000 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const handle = createServer(optionsFromArgs());
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
      let m; try { m = JSON.parse(l); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      const id = m && typeof m === 'object' ? m.id ?? null : null;
      handle(m).then((r) => r && out(r), () => out({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } })); } });
  // No process.exit on end of input: the process ends by itself once the requests in flight are answered and flushed.
}
