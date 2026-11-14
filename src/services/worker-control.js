import { dbInstance as db } from '../db.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Remote control of the RE-USE worker machines, beyond pause and update:
//  - settings: a few keys of reuse-worker.config.json the admin may override from the hub (enable_3d, gpu_max_gb,
//    gpu_keep_loaded_s, and the ComfyUI workshop: atelier_enabled, atelier_window_only, atelier_idle_free_s). Sent with every order; the worker lays them over its local config. null removes an
//    override, so the machine is back on its own file. Every change is journaled (who, when, from, to).
//  - GPU tests: the remote form of `reuse_worker.py --gpu-test`, plus the ComfyUI bench. The admin queues one test;
//    the worker runs it between two jobs, inside its schedule, reports its stage while it runs and its report at
//    the end (ok, compute_s, error, engine log excerpt). Nobody touches the PC.
// Own tables, same SQLite file; no import of reuse.js (it imports this module).
// ---------------------------------------------------------------------------

const err = (status, error) => ({ ok: false, status, error });

/** Keys the hub may set on a worker, with their bounds. The worker applies the same list (it never takes another key). */
export const WORKER_SETTINGS = {
  enable_3d: { type: 'bool' },
  gpu_max_gb: { type: 'number', min: 5, max: 200 },
  gpu_keep_loaded_s: { type: 'int', min: 0, max: 7200 },
  // ComfyUI workshop (reuse-worker/GPU.md, "Atelier ComfyUI"): Alice's own ComfyUI on the machine, on or off from here
  atelier_enabled: { type: 'bool' },
  atelier_window_only: { type: 'bool' },          // true: only inside the machine's schedule (default: always, when enabled)
  atelier_idle_free_s: { type: 'int', min: 0, max: 86400 },  // the workshop gives the card back after this long idle (600; 0 never)
  atelier_keep_days: { type: 'number', min: 0.5, max: 365 },   // its outputs and uploaded images kept this long (7)...
  atelier_files_max_gb: { type: 'number', min: 1, max: 500 }   // ...and this much at most, oldest removed first (20)
};

/** Kinds of remote test and the parameters each accepts (anything else is refused, never passed to the PC). */
export const TEST_KINDS = {
  image: { width: [256, 1536], height: [256, 1536], steps: [1, 30], seed: [0, 2147483647] },
  '3d': { res: ['512', '1024'], steps: [4, 30], seed: [0, 2147483647], texture: 'bool' },
  comfyui: { width: [256, 1536], height: [256, 1536], steps: [1, 30], seed: [0, 2147483647], runs: [1, 3] },
  comfyui_remove: {}
};

export const TEST_SILENT_MS = 15 * 60 * 1000;       // a running test the worker no longer reports on is failed
export const TEST_PENDING_MS = 24 * 60 * 60 * 1000;   // a test nobody started in a day is not run by surprise later
const RESULT_MAX = 32 * 1024;

db.exec(`
  CREATE TABLE IF NOT EXISTS reuse_worker_settings (
    worker TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (worker, key)
  );
  CREATE TABLE IF NOT EXISTS reuse_worker_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL,
    at INTEGER NOT NULL,
    what TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_reuse_worker_events ON reuse_worker_events (worker, id);
  CREATE TABLE IF NOT EXISTS reuse_worker_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL,
    kind TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | cancelled
    stage TEXT,
    progress REAL,
    ok INTEGER,
    result TEXT,
    error TEXT,
    requested_at INTEGER NOT NULL,
    started_at INTEGER,
    updated_at INTEGER,
    finished_at INTEGER,
    output TEXT                                -- {ext, size, sha256} of the file the test made (PNG, GLB), kept on the hub
  );
  CREATE INDEX IF NOT EXISTS idx_reuse_worker_tests ON reuse_worker_tests (worker, status, id);
`);

const q = {
  settings: db.prepare('SELECT key, value, set_at FROM reuse_worker_settings WHERE worker = ? ORDER BY key'),
  setting: db.prepare('SELECT value FROM reuse_worker_settings WHERE worker = ? AND key = ?'),
  put: db.prepare(`INSERT INTO reuse_worker_settings (worker, key, value, set_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(worker, key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`),
  drop: db.prepare('DELETE FROM reuse_worker_settings WHERE worker = ? AND key = ?'),
  event: db.prepare('INSERT INTO reuse_worker_events (worker, at, what, detail) VALUES (?, ?, ?, ?)'),
  events: db.prepare('SELECT * FROM reuse_worker_events WHERE worker = ? ORDER BY id DESC LIMIT ?'),
  insertTest: db.prepare('INSERT INTO reuse_worker_tests (worker, kind, params, requested_at) VALUES (?, ?, ?, ?)'),
  test: db.prepare('SELECT * FROM reuse_worker_tests WHERE id = ?'),
  tests: db.prepare('SELECT * FROM reuse_worker_tests WHERE worker = ? ORDER BY id DESC LIMIT ?'),
  open: db.prepare(`SELECT * FROM reuse_worker_tests WHERE worker = ? AND status IN ('pending', 'running') ORDER BY id LIMIT 1`),
  pending: db.prepare(`SELECT * FROM reuse_worker_tests WHERE worker = ? AND status = 'pending' ORDER BY id LIMIT 1`),
  start: db.prepare(`UPDATE reuse_worker_tests SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?,
                     stage = COALESCE(?, stage), progress = COALESCE(?, progress) WHERE id = ?`),
  finish: db.prepare(`UPDATE reuse_worker_tests SET status = ?, ok = ?, result = ?, error = ?, stage = NULL, progress = ?,
                      updated_at = ?, finished_at = ? WHERE id = ?`),
  silent: db.prepare(`SELECT id, worker FROM reuse_worker_tests WHERE status = 'running' AND updated_at < ?`),
  stale: db.prepare(`SELECT id, worker FROM reuse_worker_tests WHERE status = 'pending' AND requested_at < ?`),
  keepReport: db.prepare('UPDATE reuse_worker_tests SET result = ?, stage = NULL, finished_at = COALESCE(finished_at, ?) WHERE id = ?'),
  setOutput: db.prepare('UPDATE reuse_worker_tests SET output = ? WHERE id = ?'),
  withOutput: db.prepare(`SELECT id, output FROM reuse_worker_tests WHERE worker = ? AND output IS NOT NULL ORDER BY id DESC`),
  close: db.prepare(`UPDATE reuse_worker_tests SET status = ?, error = ?, stage = NULL, finished_at = ?
                     WHERE id = ? AND status IN ('pending', 'running')`)
};

export function journal(worker, what, detail, now = Date.now()) {
  q.event.run(worker, now, what, JSON.stringify(detail));
  logger.info('RE-USE worker control', { worker, what, ...detail });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function checkSetting(key, raw) {
  const spec = WORKER_SETTINGS[key];
  if (spec.type === 'bool') {
    if (typeof raw !== 'boolean') return { error: `${key} must be true, false or null` };
    return { value: raw };
  }
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n)) || n < spec.min || n > spec.max) {
    return { error: `${key} must be a${spec.type === 'int' ? 'n integer' : ' number'} from ${spec.min} to ${spec.max}, or null` };
  }
  return { value: n };
}

/** {key: value} overrides the hub holds for this worker (sent in its orders). */
export function workerSettings(name) {
  const out = {};
  for (const row of q.settings.all(name)) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* unreadable row: ignored, never sent */ }
  }
  return out;
}

/**
 * Merge a patch of overrides: {enable_3d: true} sets, {enable_3d: null} removes (the worker's own file applies again).
 * All or nothing: one bad key refuses the whole patch. -> {ok, settings, changed: [{key, from, to}]}.
 */
export function patchWorkerSettings(name, patch, now = Date.now()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    return err(400, `Expected an object of settings: ${Object.keys(WORKER_SETTINGS).join(', ')} (null removes an override)`);
  }
  const plan = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!Object.hasOwn(WORKER_SETTINGS, key)) return err(400, `Unknown setting "${key}" (allowed: ${Object.keys(WORKER_SETTINGS).join(', ')})`);
    if (raw === null) { plan.push({ key, value: null }); continue; }
    const c = checkSetting(key, raw);
    if (c.error) return err(400, c.error);
    plan.push({ key, value: c.value });
  }
  const before = workerSettings(name);
  const changed = [];
  db.transaction(() => {
    for (const { key, value } of plan) {
      const from = Object.hasOwn(before, key) ? before[key] : null;
      if (from === value) continue;
      if (value === null) q.drop.run(name, key);
      else q.put.run(name, key, JSON.stringify(value), now);
      changed.push({ key, from, to: value });
    }
    if (changed.length) journal(name, 'settings', { changed }, now);
  })();
  return { ok: true, settings: workerSettings(name), changed };
}

/** Journal of one worker (settings changes, tests asked, started, finished, cancelled), most recent first. */
export function workerEvents(name, limit = 50) {
  return q.events.all(name, Math.min(Math.max(Number(limit) || 50, 1), 500)).map(e => {
    let detail = {};
    try { detail = JSON.parse(e.detail); } catch { /* kept empty */ }
    return { at: new Date(e.at).toISOString(), what: e.what, ...detail };
  });
}

// ---------------------------------------------------------------------------
// Remote GPU tests
// ---------------------------------------------------------------------------
function checkTestParams(kind, params) {
  const allowed = TEST_KINDS[kind];
  const out = {};
  if (params == null) return { params: out };
  if (typeof params !== 'object' || Array.isArray(params)) return { error: 'params must be an object' };
  for (const [k, v] of Object.entries(params)) {
    const rule = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
    if (rule === undefined) return { error: `Unknown parameter "${k}" for a ${kind} test (allowed: ${Object.keys(allowed).join(', ') || 'none'})` };
    if (rule === 'bool') {
      if (typeof v !== 'boolean') return { error: `${k} must be true or false` };
      out[k] = v;
    } else if (typeof rule[0] === 'string') {
      if (!rule.includes(String(v))) return { error: `${k} must be one of ${rule.join(', ')}` };
      out[k] = String(v);
    } else {
      if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) return { error: `${k} must be an integer from ${rule[0]} to ${rule[1]}` };
      if ((k === 'width' || k === 'height') && v % 64) return { error: `${k} must be a multiple of 64` };
      out[k] = v;
    }
  }
  return { params: out };
}

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function testView(t) {
  if (!t) return null;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    id: t.id, worker: t.worker, kind: t.kind, params: parse(t.params) || {}, status: t.status,
    ...(t.stage ? { stage: t.stage } : {}), ...(t.progress != null ? { progress: t.progress } : {}),
    ok: t.ok == null ? null : Boolean(t.ok), error: t.error || null, result: parse(t.result),
    ...(t.output ? { output: { ...parse(t.output), url: `/api/reuse/workers/${t.worker}/tests/${t.id}/output` } } : {}),
    requested_at: iso(t.requested_at), started_at: iso(t.started_at), finished_at: iso(t.finished_at),
    ...(t.started_at ? { elapsed_s: Math.round(((t.finished_at || Date.now()) - t.started_at) / 1000) } : {})
  };
}

/** Running tests the worker stopped reporting on fail; pending ones nobody started in a day too. */
export function expireTests(now = Date.now()) {
  for (const t of q.silent.all(now - TEST_SILENT_MS)) {
    q.close.run('failed', 'the worker stopped reporting on this test for 15 min (restarted or crashed: see its worker.log)', now, t.id);
    journal(t.worker, 'test_lost', { test: t.id }, now);
  }
  for (const t of q.stale.all(now - TEST_PENDING_MS)) {
    q.close.run('failed', 'not started within 24 h (worker offline, paused or out of its schedule)', now, t.id);
    journal(t.worker, 'test_expired', { test: t.id }, now);
  }
}

/** Queue one test for a worker. One open test per worker at a time. */
export function createTest(name, { kind, params } = {}, now = Date.now()) {
  if (!Object.hasOwn(TEST_KINDS, kind || '')) return err(400, `kind must be one of ${Object.keys(TEST_KINDS).join(', ')}`);
  const c = checkTestParams(kind, params);
  if (c.error) return err(400, c.error);
  expireTests(now);
  const open = q.open.get(name);
  if (open) return err(409, `Test ${open.id} (${open.kind}) is ${open.status} on ${name}: wait for it or cancel it first`);
  const id = Number(q.insertTest.run(name, kind, JSON.stringify(c.params), now).lastInsertRowid);
  journal(name, 'test_requested', { test: id, kind, params: c.params }, now);
  return { ok: true, test: testView(q.test.get(id)) };
}

export function listTests(name, limit = 20, now = Date.now()) {
  expireTests(now);
  return q.tests.all(name, Math.min(Math.max(Number(limit) || 20, 1), 200)).map(testView);
}

export function getTest(name, id, now = Date.now()) {
  expireTests(now);
  const t = q.test.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown test');
  return { ok: true, test: testView(t) };
}

/** Cancel a pending or running test; a running one is stopped by the worker at its next report (within 30 s). */
export function cancelTest(name, id, now = Date.now()) {
  const t = q.test.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown test');
  if (!['pending', 'running'].includes(t.status)) return err(409, `Test is ${t.status}`);
  q.close.run('cancelled', 'cancelled by the admin', now, t.id);
  journal(name, 'test_cancelled', { test: t.id, was: t.status }, now);
  return { ok: true, test: testView(q.test.get(t.id)) };
}

/** The test to hand to this worker now, as an order {id, kind, params}, or null. The caller checks pause and schedule. */
export function pendingTest(name, now = Date.now()) {
  const t = q.pending.get(name);
  if (!t) return null;
  if (t.requested_at < now - TEST_PENDING_MS) { expireTests(now); return null; }
  return { id: t.id, kind: t.kind, params: parse(t.params) || {} };
}

/** JSON of a report, at most max characters, always valid: the scalar fields and the end of the log (why it failed) first. */
export function clip(value, max) {
  const s = JSON.stringify(value ?? null);
  if (s.length <= max) return s;
  const small = { truncated: true };
  for (const [k, v] of Object.entries(value || {})) if (v === null || typeof v !== 'object') small[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  const log = Array.isArray(value?.log) ? value.log.slice(-40).map(l => String(l).slice(0, 300)) : [];
  for (let n = log.length; n >= 0; n = n > 4 ? Math.floor(n / 2) : n - 1) {
    const out = JSON.stringify(n ? { ...small, log: log.slice(-n) } : small);
    if (out.length <= max) return out;
  }
  return JSON.stringify({ truncated: true, ok: value?.ok ?? null, error: String(value?.error ?? '').slice(0, Math.max(0, max - 100)) });
}

/**
 * Worker report on a test it was given: {status: 'running', stage, progress} while it runs, then
 * {status: 'done'|'failed', report: {ok, compute_s, error, log, ...}}. -> {ok, cancel} (cancel: stop now).
 */
export function reportTest(name, id, { status, stage, progress, report } = {}, now = Date.now(), stopReason = null) {
  const t = q.test.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown test');
  if (t.status === 'cancelled') {
    // Stopped (admin, pause, end of the schedule): the worker still sends what it got, kept with the test
    if ((status === 'done' || status === 'failed') && report && typeof report === 'object') q.keepReport.run(clip(report, RESULT_MAX), now, t.id);
    return { ok: true, cancel: true, reason: t.error };
  }
  if (!['pending', 'running'].includes(t.status)) return err(409, `Test is ${t.status}`);
  const p = Number(progress);
  const prog = Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null;
  if (status === 'running' && stopReason) {
    // The machine is no longer free (window closed, paused): stop now; what is installed or downloaded stays for the next test
    q.close.run('cancelled', `stopped: ${stopReason}`, now, t.id);
    journal(name, 'test_stopped', { test: t.id, kind: t.kind, reason: stopReason }, now);
    return { ok: true, cancel: true, reason: `stopped: ${stopReason}` };
  }
  if (status === 'running') {
    if (t.status === 'pending') journal(name, 'test_started', { test: t.id, kind: t.kind }, now);
    q.start.run(now, now, stage ? String(stage).slice(0, 200) : null, prog, t.id);
    return { ok: true, cancel: false };
  }
  if (status !== 'done' && status !== 'failed') return err(400, 'status must be running, done or failed');
  const ok = status === 'done' && report?.ok !== false;
  const error = ok ? null : String(report?.error || 'no reason given').slice(0, 1000);
  q.finish.run(ok ? 'done' : 'failed', ok ? 1 : 0, clip(report || {}, RESULT_MAX), error, ok ? 1 : prog, now, now, t.id);
  journal(name, 'test_finished', { test: t.id, kind: t.kind, ok, compute_s: report?.compute_s ?? null, ...(error ? { error: error.slice(0, 200) } : {}) }, now);
  return { ok: true, cancel: false };
}

// ---------------------------------------------------------------------------
// File made by a test (image, GLB): what shows the result is right, beyond the figures
// ---------------------------------------------------------------------------
export const TEST_OUTPUT_EXT = /^(png|glb)$/;
export const TEST_OUTPUTS_KEPT = 10;   // per worker; older files are removed, their reports stay

/** Record the file of a test the worker is running or has just finished. -> {ok, drop: [ids whose file to delete]}. */
export function noteTestOutput(name, id, { ext, size, sha256 }) {
  const t = q.test.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown test');
  if (t.finished_at && Date.now() - t.finished_at > 10 * 60 * 1000) return err(409, 'Test finished more than 10 min ago');
  q.setOutput.run(JSON.stringify({ ext, size, sha256 }), t.id);
  const drop = q.withOutput.all(name).slice(TEST_OUTPUTS_KEPT).map(r => ({ id: r.id, ext: parse(r.output)?.ext }));
  for (const d of drop) q.setOutput.run(null, d.id);
  return { ok: true, drop };
}

/** {ext, size, sha256} of a test's file, or null. */
export function testOutput(name, id) {
  const t = q.test.get(Number(id));
  if (!t || t.worker !== name || !t.output) return null;
  return parse(t.output);
}
