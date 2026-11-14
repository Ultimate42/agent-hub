import { dbInstance as db } from '../db.js';
import { journal, clip } from './worker-control.js';

// ---------------------------------------------------------------------------
// Tasks for the ComfyUI workshop of a worker machine (reuse-worker/GPU.md, "Atelier ComfyUI"), asked by the admin:
//  - install_nodes {url: https://github.com/<owner>/<repo>, commit: <40 hex>, name?, pip?}: the archive of that exact
//    commit into custom_nodes/<name>, then its requirements.txt in the workshop's Python (torch kept pinned); install.py
//    is never run. pip freeze before/after kept on the PC, the difference in the result.
//  - remove_nodes {name}
//  - download_model {url: https://..., sha256, folder: loras|upscale_models|model_patches|..., name?, size?}: resumable,
//    checked against the SHA-256 before it is put in place. With member (path of one file inside a .zip at url) and
//    archive_sha256 (required then), archive_size?: the archive is downloaded and checked, only that file is extracted
//    (bounded to size, or to the worker's ZIP_MEMBER_MAX), checked against sha256 and put in place; the archive is deleted then
//    (kept after a failure for a retry, purged after 7 days).
//  - remove_model {folder, name}
//  - undo {task}: what that task put in place goes to the PC's trash, what it replaced or removed comes back.
// Nothing is ever deleted by a task: replaced or removed files go to <atelier>/trash for 30 days. Every step is
// journaled (reuse_worker_events). The worker checks the same rules again before touching its disk.
// ---------------------------------------------------------------------------

const err = (status, error) => ({ ok: false, status, error });
export const ATELIER_TASK_SILENT_MS = 30 * 60 * 1000;     // running, no report for 30 min (the worker beats every 30 s)
export const ATELIER_TASK_PENDING_MS = 7 * 24 * 3600 * 1000;
const RESULT_MAX = 16 * 1024;

db.exec(`
  CREATE TABLE IF NOT EXISTS reuse_atelier_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL,
    action TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | cancelled
    stage TEXT,
    progress REAL,
    result TEXT,
    error TEXT,
    requested_at INTEGER NOT NULL,
    started_at INTEGER,
    updated_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reuse_atelier_tasks ON reuse_atelier_tasks (worker, status, id);
`);

const q = {
  insert: db.prepare('INSERT INTO reuse_atelier_tasks (worker, action, params, requested_at) VALUES (?, ?, ?, ?)'),
  get: db.prepare('SELECT * FROM reuse_atelier_tasks WHERE id = ?'),
  list: db.prepare('SELECT * FROM reuse_atelier_tasks WHERE worker = ? ORDER BY id DESC LIMIT ?'),
  pending: db.prepare(`SELECT * FROM reuse_atelier_tasks WHERE worker = ? AND status = 'pending' ORDER BY id LIMIT 1`),
  start: db.prepare(`UPDATE reuse_atelier_tasks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?,
                     stage = COALESCE(?, stage), progress = COALESCE(?, progress) WHERE id = ?`),
  finish: db.prepare(`UPDATE reuse_atelier_tasks SET status = ?, result = ?, error = ?, stage = NULL, updated_at = ?, finished_at = ?
                      WHERE id = ?`),
  close: db.prepare(`UPDATE reuse_atelier_tasks SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?
                     AND status IN ('pending', 'running')`),
  silent: db.prepare(`SELECT id, worker FROM reuse_atelier_tasks WHERE status = 'running' AND updated_at < ?`),
  stale: db.prepare(`SELECT id, worker FROM reuse_atelier_tasks WHERE status = 'pending' AND requested_at < ?`)
};

const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const PACK = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
const FOLDER = /^[a-z][a-z0-9_]{1,40}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,59})?$/;
const FILE = /^[A-Za-z0-9_][A-Za-z0-9_.() +-]{0,119}$/;
const MODEL_EXT = /\.(safetensors|sft|gguf|pt|pth|bin|ckpt|onnx)$/i;
const SHA = /^[0-9a-f]{64}$/;
// Path of a file inside a zip: relative, '/' between parts, each part like a file name (no '..', no '\\', no 'C:')
const MEMBER_PART = /^[A-Za-z0-9_][A-Za-z0-9_.() +-]{0,119}$/;

function fileName(url, name, member) {
  if (name != null) return String(name);
  if (member != null) return String(member).split('/').pop();
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; }
}

const isMember = (m) => typeof m === 'string' && m.length <= 500 && !m.includes('..')
  && m.split('/').length <= 20 && m.split('/').every(part => MEMBER_PART.test(part));
const isSize = (n) => Number.isInteger(n) && n > 0;

/** -> {action, params} cleaned, or {error}. Same rules as check_atelier_task in reuse_worker.py. */
export function checkAtelierTask(body) {
  const { action } = body || {};
  const p = body?.params && typeof body.params === 'object' ? { ...body, ...body.params } : { ...(body || {}) };
  switch (action) {
    case 'install_nodes': {
      const m = GITHUB.exec(String(p.url || ''));
      if (!m || !/^[0-9a-f]{40}$/.test(String(p.commit || ''))) {
        return { error: 'install_nodes: url https://github.com/<owner>/<repo> and commit (the full 40-character hash) expected' };
      }
      const name = String(p.name ?? m[2]);
      if (!PACK.test(name)) return { error: `invalid pack name "${name}"` };
      if (p.pip != null && typeof p.pip !== 'boolean') return { error: 'pip must be true or false' };
      return { action, params: { url: `https://github.com/${m[1]}/${m[2]}`, commit: p.commit, name, pip: p.pip !== false } };
    }
    case 'remove_nodes':
      return PACK.test(String(p.name || '')) ? { action, params: { name: p.name } } : { error: 'remove_nodes: name of the pack expected' };
    case 'download_model':
    case 'remove_model': {
      const folder = String(p.folder || '');
      if (!FOLDER.test(folder)) return { error: 'folder expected, e.g. loras, upscale_models, model_patches (lowercase, one optional subfolder)' };
      const member = action === 'download_model' ? p.member : null;
      if (member != null && !isMember(member)) {
        return { error: 'member: relative path of a file inside the zip expected, e.g. Pack-1.0/Models/x.safetensors (no "..", no "\\", no leading "/")' };
      }
      const name = fileName(p.url, p.name, member);
      if (!FILE.test(name) || !MODEL_EXT.test(name) || name.includes('..')) {
        return { error: `invalid file name "${name}" (.safetensors, .gguf, .pt, .pth, .bin, .ckpt, .onnx)` };
      }
      if (action === 'remove_model') return { action, params: { folder, name } };
      if (!/^https:\/\/\S{1,2000}$/.test(String(p.url || '')) || !SHA.test(String(p.sha256 || ''))) {
        return { error: 'download_model: https url and sha256 (64 lowercase hex characters) expected' };
      }
      if (p.size != null && !isSize(p.size)) return { error: 'size must be a number of bytes' };
      const params = { url: p.url, sha256: p.sha256, folder, name, ...(p.size != null ? { size: p.size } : {}) };
      if (member == null) {
        if (p.archive_sha256 != null || p.archive_size != null) return { error: 'archive_sha256 and archive_size go with member' };
        return { action, params };
      }
      if (!SHA.test(String(p.archive_sha256 || ''))) return { error: 'member needs archive_sha256 (64 lowercase hex characters) of the zip' };
      if (p.archive_size != null && !isSize(p.archive_size)) return { error: 'archive_size must be a number of bytes' };
      return { action, params: { ...params, member, archive_sha256: p.archive_sha256,
                                 ...(p.archive_size != null ? { archive_size: p.archive_size } : {}) } };
    }
    case 'undo':
      return Number.isInteger(p.task) && p.task > 0 ? { action, params: { task: p.task } } : { error: 'undo: task (id of the task to undo) expected' };
    default:
      return { error: 'action must be one of install_nodes, remove_nodes, download_model, remove_model, undo' };
  }
}

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
export function atelierTaskView(t) {
  if (!t) return null;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    id: t.id, worker: t.worker, action: t.action, params: parse(t.params) || {}, status: t.status,
    ...(t.stage ? { stage: t.stage } : {}), ...(t.progress != null ? { progress: t.progress } : {}),
    error: t.error || null, result: parse(t.result),
    requested_at: iso(t.requested_at), started_at: iso(t.started_at), finished_at: iso(t.finished_at)
  };
}

export function expireAtelierTasks(now = Date.now()) {
  for (const t of q.silent.all(now - ATELIER_TASK_SILENT_MS)) {
    q.close.run('failed', 'the worker stopped reporting on this task for 30 min (restarted: see its worker.log)', now, now, t.id);
    journal(t.worker, 'atelier_task_lost', { task: t.id }, now);
  }
  for (const t of q.stale.all(now - ATELIER_TASK_PENDING_MS)) {
    q.close.run('failed', 'not started within 7 days (worker offline or without the workshop)', now, now, t.id);
    journal(t.worker, 'atelier_task_expired', { task: t.id }, now);
  }
}

export function createAtelierTask(name, body, now = Date.now()) {
  const c = checkAtelierTask(body);
  if (c.error) return err(400, c.error);
  expireAtelierTasks(now);
  const id = Number(q.insert.run(name, c.action, JSON.stringify(c.params), now).lastInsertRowid);
  journal(name, 'atelier_task_requested', { task: id, action: c.action, params: c.params }, now);
  return { ok: true, task: atelierTaskView(q.get.get(id)) };
}

export function listAtelierTasks(name, limit = 20, now = Date.now()) {
  expireAtelierTasks(now);
  return q.list.all(name, Math.min(Math.max(Number(limit) || 20, 1), 200)).map(atelierTaskView);
}

export function getAtelierTask(name, id, now = Date.now()) {
  expireAtelierTasks(now);
  const t = q.get.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown task');
  return { ok: true, task: atelierTaskView(t) };
}

/** Cancel a pending task, or stop a running one (download or pip stopped at the worker's next report, within 30 s). */
export function cancelAtelierTask(name, id, now = Date.now()) {
  const t = q.get.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown task');
  if (!['pending', 'running'].includes(t.status)) return err(409, `Task is ${t.status}`);
  q.close.run('cancelled', 'cancelled by the admin', now, now, t.id);
  journal(name, 'atelier_task_cancelled', { task: t.id, was: t.status }, now);
  return { ok: true, task: atelierTaskView(q.get.get(t.id)) };
}

/** Oldest pending task for this worker as an order {id, action, params}, or null. */
export function pendingAtelierTask(name, now = Date.now()) {
  const t = q.pending.get(name);
  if (!t) return null;
  if (t.requested_at < now - ATELIER_TASK_PENDING_MS) { expireAtelierTasks(now); return null; }
  return { id: t.id, action: t.action, params: parse(t.params) || {} };
}

/** Worker report: {status: 'running', stage, progress} every 30 s, then {status: 'done'|'failed', result}. -> {ok, cancel}. */
export function reportAtelierTask(name, id, { status, stage, progress, result } = {}, now = Date.now()) {
  const t = q.get.get(Number(id));
  if (!t || t.worker !== name) return err(404, 'Unknown task');
  if (t.status === 'cancelled') return { ok: true, cancel: true };
  if (!['pending', 'running'].includes(t.status)) return err(409, `Task is ${t.status}`);
  if (status === 'running') {
    if (t.status === 'pending') journal(name, 'atelier_task_started', { task: t.id, action: t.action }, now);
    const p = Number(progress);
    q.start.run(now, now, stage ? String(stage).slice(0, 200) : null, Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null, t.id);
    return { ok: true, cancel: false };
  }
  if (status !== 'done' && status !== 'failed') return err(400, 'status must be running, done or failed');
  const ok = status === 'done' && result?.ok !== false;
  const error = ok ? null : String(result?.error || 'no reason given').slice(0, 1000);
  q.finish.run(ok ? 'done' : 'failed', clip(result || {}, RESULT_MAX), error, now, now, t.id);
  journal(name, 'atelier_task_finished', { task: t.id, action: t.action, ok, ...(error ? { error: error.slice(0, 200) } : {}) }, now);
  return { ok: true, cancel: false };
}
