import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, statSync, lstatSync, existsSync
} from 'fs';
import { dbInstance as db } from '../db.js';
import { config } from '../config.js';
import { compareTokens } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// RE-USE cleaning queue (speech enhancement done by remote GPU workers)
// ---------------------------------------------------------------------------
// Same contract as the transcription queue: the hub never runs the model. The manager (admin token)
// submits FLAC pieces; workers (one token per machine) pull a job, keep its lease alive with
// heartbeats while they compute, and upload the cleaned FLAC. A worker that dies simply stops
// renewing: the lease expires and another worker takes the job. Several workers = load balancing.
// The hub also distributes the worker program itself (manifest + files) and remote orders
// (pause, resume, forced update), so a machine is driven without anyone touching it.

const WORKER_NAME = /^[\w.-]{1,32}$/;
const SAFE_NAME = /^[\w.-]{1,120}$/;

export function reuseEnabled() {
  return Boolean(config.reuseAdminToken) || config.reuseWorkerTokens.length > 0;
}

/** {role:'admin'} | {role:'worker', name} | null */
export function identifyReuseCaller(token) {
  if (!token) return null;
  for (const w of config.reuseWorkerTokens) {
    if (compareTokens(token, w.token)) return { role: 'worker', name: w.name };
  }
  if (config.reuseAdminToken && compareTokens(token, config.reuseAdminToken)) return { role: 'admin' };
  return null;
}

// ---------------------------------------------------------------------------
// Schema (own tables, same SQLite file)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS reuse_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | failed | cancelled
    priority INTEGER NOT NULL DEFAULT 0,
    params TEXT NOT NULL DEFAULT '{}',
    in_sha256 TEXT NOT NULL,
    in_size INTEGER NOT NULL,
    in_rate INTEGER NOT NULL,
    in_samples INTEGER NOT NULL,
    out_sha256 TEXT,
    out_size INTEGER,
    out_rate INTEGER,
    worker TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    progress REAL,
    compute_s REAL,
    backend TEXT,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    lease_until INTEGER,
    done_at INTEGER,
    UNIQUE (batch, name)
  );
  CREATE INDEX IF NOT EXISTS idx_reuse_jobs_status ON reuse_jobs (status, priority DESC, id);
  CREATE TABLE IF NOT EXISTS reuse_workers (
    name TEXT PRIMARY KEY,
    last_poll_at INTEGER,
    info TEXT NOT NULL DEFAULT '{}',
    paused INTEGER NOT NULL DEFAULT 0,
    update_requested INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    audio_s REAL NOT NULL DEFAULT 0,
    compute_s REAL NOT NULL DEFAULT 0
  );
`);

const q = {
  insert: db.prepare(`INSERT INTO reuse_jobs (batch, name, priority, params, in_sha256, in_size, in_rate, in_samples, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  byId: db.prepare('SELECT * FROM reuse_jobs WHERE id = ?'),
  byName: db.prepare('SELECT * FROM reuse_jobs WHERE batch = ? AND name = ?'),
  list: db.prepare('SELECT * FROM reuse_jobs WHERE (@batch IS NULL OR batch = @batch) AND (@status IS NULL OR status = @status) ORDER BY batch, name LIMIT 5000'),
  deleteBatch: db.prepare('DELETE FROM reuse_jobs WHERE batch = ?'),
  batchRows: db.prepare('SELECT id, status, lease_until FROM reuse_jobs WHERE batch = ?'), // every row: no LIMIT, unlike list
  ids: db.prepare('SELECT id, status FROM reuse_jobs'),
  lost: db.prepare(`UPDATE reuse_jobs SET status = 'failed', error = 'input audio is missing on the hub', lease_until = NULL
                    WHERE id = ? AND status IN ('pending', 'claimed')`),
  // A claimed job whose lease ran out is claimable again
  next: db.prepare(`SELECT * FROM reuse_jobs
                    WHERE status = 'pending' OR (status = 'claimed' AND lease_until < ?)
                    ORDER BY priority DESC, id LIMIT 1`),
  claim: db.prepare(`UPDATE reuse_jobs SET status = 'claimed', worker = ?, claimed_at = ?, lease_until = ?,
                     attempts = attempts + 1, progress = NULL WHERE id = ?`),
  held: db.prepare(`SELECT * FROM reuse_jobs WHERE status = 'claimed' AND worker = ? AND lease_until >= ? ORDER BY id LIMIT 1`),
  renew: db.prepare('UPDATE reuse_jobs SET lease_until = ?, progress = COALESCE(?, progress) WHERE id = ?'),
  fail: db.prepare(`UPDATE reuse_jobs SET status = ?, error = ?, lease_until = NULL WHERE id = ?`),
  done: db.prepare(`UPDATE reuse_jobs SET status = 'done', out_sha256 = ?, out_size = ?, out_rate = ?, compute_s = ?, backend = ?,
                    error = NULL, progress = 1, lease_until = NULL, done_at = ? WHERE id = ?`),
  retry: db.prepare(`UPDATE reuse_jobs SET status = 'pending', attempts = 0, error = NULL, worker = NULL, lease_until = NULL, progress = NULL
                     WHERE id = ? AND status IN ('failed', 'cancelled')`),
  cancel: db.prepare(`UPDATE reuse_jobs SET status = 'cancelled', lease_until = NULL WHERE id = ? AND status IN ('pending', 'claimed', 'failed')`),
  summary: db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(in_samples * 1.0 / in_rate), 0) AS audio_s,
                       COALESCE(SUM(compute_s), 0) AS compute_s
                       FROM reuse_jobs WHERE (@batch IS NULL OR batch = @batch) GROUP BY status`),
  worker: db.prepare('SELECT * FROM reuse_workers WHERE name = ?'),
  workers: db.prepare('SELECT * FROM reuse_workers ORDER BY name'),
  touch: db.prepare(`INSERT INTO reuse_workers (name, last_poll_at, info) VALUES (?, ?, ?)
                     ON CONFLICT(name) DO UPDATE SET last_poll_at = excluded.last_poll_at, info = excluded.info`),
  seen: db.prepare(`INSERT INTO reuse_workers (name, last_poll_at) VALUES (?, ?)
                    ON CONFLICT(name) DO UPDATE SET last_poll_at = excluded.last_poll_at`),
  ensureWorker: db.prepare('INSERT OR IGNORE INTO reuse_workers (name) VALUES (?)'),
  stored: db.prepare('SELECT COALESCE(SUM(in_size + COALESCE(out_size, 0)), 0) AS bytes FROM reuse_jobs'),
  // What the queue will need once every job is done: a cleaned file is about as big as its source
  reserved: db.prepare('SELECT COALESCE(SUM(in_size + COALESCE(out_size, in_size)), 0) AS bytes FROM reuse_jobs'),
  setPaused: db.prepare('UPDATE reuse_workers SET paused = ? WHERE name = ?'),
  setUpdate: db.prepare('UPDATE reuse_workers SET update_requested = ? WHERE name = ?'),
  count: db.prepare(`UPDATE reuse_workers SET done = done + ?, failed = failed + ?, audio_s = audio_s + ?, compute_s = compute_s + ?
                     WHERE name = ?`)
};

// ---------------------------------------------------------------------------
// FLAC header (STREAMINFO): lets the hub check rate, channels and exact length without ffmpeg
// ---------------------------------------------------------------------------
/** @returns {{rate:number, channels:number, bits:number, samples:number}|null} null when not a FLAC stream */
export function parseFlac(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  if ((buf[4] & 0x7f) !== 0) return null; // first metadata block must be STREAMINFO
  const hi = buf.readUInt32BE(18);
  const rate = hi >>> 12;
  const channels = ((hi >>> 9) & 0x7) + 1;
  const bits = ((hi >>> 4) & 0x1f) + 1;
  const samples = (hi & 0xf) * 2 ** 32 + buf.readUInt32BE(22);
  if (!rate) return null;
  return { rate, channels, bits, samples };
}

// ---------------------------------------------------------------------------
// Storage: <reuseDir>/<id>.in.flac and <id>.out.flac (names never come from the client)
// ---------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const inputPath = (id) => path.join(config.reuseDir, `${Number(id)}.in.flac`);
export const outputPath = (id) => path.join(config.reuseDir, `${Number(id)}.out.flac`);

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true }); // disk full, permissions: no half-written file left behind
    throw e;
  }
}

/** A job whose source audio is gone can never be computed: failed for good, never handed out again. */
export function inputLost(id) {
  if (q.lost.run(Number(id)).changes) logger.error('RE-USE job failed permanently: input audio is missing on the hub', { id: Number(id) });
}

/**
 * Startup sweep of the storage folder. A hub stopped in the middle of a write, or a database restored from a
 * backup, leaves audio that no row accounts for: it would fill the disk outside the storage cap, forever.
 * Only files this module names itself (<id>.in.flac, <id>.out.flac and their temporary copies) are touched.
 * Conversely a waiting job whose source is gone is failed now rather than handed to workers.
 * One hub per storage folder: a second hub with another database would see the first one's audio as orphans.
 */
export function sweepReuseStorage() {
  const rows = new Map(q.ids.all().map(r => [r.id, r.status]));
  let names = [];
  try { names = readdirSync(config.reuseDir); } catch { /* no folder yet */ }
  const removed = [];
  for (const n of names) {
    const m = /^(\d+)\.(in|out)\.flac(\.\d+\.tmp)?$/.exec(n);
    if (!m) continue;
    const status = rows.get(Number(m[1]));
    const wanted = !m[3] && (m[2] === 'in' ? status !== undefined : status === 'done');
    if (wanted) continue;
    try { rmSync(path.join(config.reuseDir, n), { force: true }); removed.push(n); } catch { /* next start */ }
  }
  if (removed.length) logger.warn('RE-USE storage: orphan files removed', { count: removed.length, files: removed.slice(0, 20) });
  for (const [id, status] of rows) {
    if ((status === 'pending' || status === 'claimed') && !existsSync(inputPath(id))) inputLost(id);
  }
  return removed.length;
}

function parseParams(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/** Public view of a job (no paths). */
export function jobView(j, now = Date.now()) {
  return {
    id: j.id,
    batch: j.batch,
    name: j.name,
    status: j.status === 'claimed' && j.lease_until < now ? 'pending' : j.status, // expired lease = back in the queue
    priority: j.priority,
    params: parseParams(j.params),
    duration_s: Math.round((j.in_samples / j.in_rate) * 1000) / 1000,
    in: { sha256: j.in_sha256, size: j.in_size, rate: j.in_rate },
    ...(j.status === 'done' ? { out: { sha256: j.out_sha256, size: j.out_size, rate: j.out_rate } } : {}),
    worker: j.worker,
    attempts: j.attempts,
    ...(j.error ? { error: j.error } : {}),
    ...(j.progress != null ? { progress: j.progress } : {}),
    ...(j.compute_s != null ? { compute_s: j.compute_s, backend: j.backend } : {}),
    created_at: new Date(j.created_at).toISOString(),
    ...(j.claimed_at ? { claimed_at: new Date(j.claimed_at).toISOString() } : {}),
    ...(j.done_at ? { done_at: new Date(j.done_at).toISOString() } : {})
  };
}

const err = (status, error) => ({ ok: false, status, error });

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------
/**
 * Queue one FLAC piece. Idempotent on (batch, name): the same bytes return the existing job,
 * different bytes are refused (409) so a re-run can never silently replace audio.
 */
export function submitJob({ batch, name, data, priority = 0, params = {} }) {
  if (!SAFE_NAME.test(batch || '') || !SAFE_NAME.test(name || '')) return err(400, 'batch and name must match [A-Za-z0-9_.-]{1,120}');
  if (!Buffer.isBuffer(data) || data.length === 0) return err(400, 'Empty body');
  const info = parseFlac(data);
  if (!info) return err(422, 'Input must be a FLAC file');
  if (info.channels !== 1) return err(422, `Input must be mono (got ${info.channels} channels)`);
  if (!info.samples) return err(422, 'FLAC header has no sample count (encode to a file, not a pipe)');
  const hash = sha256(data);
  const existing = q.byName.get(batch, name);
  if (existing) {
    if (existing.in_sha256 !== hash) return err(409, `Job ${existing.id} already holds different audio under this batch/name`);
    return { ok: true, created: false, job: jobView(existing) };
  }
  if (q.reserved.get().bytes + 2 * data.length > config.reuseMaxStorage) {
    return err(507, 'RE-USE storage is full on the hub: fetch the outputs of finished batches and delete them (DELETE /api/reuse/batches/:batch)');
  }
  const clean = {};
  for (const k of ['chunk_s', 'overlap_s']) {
    const v = Number(params[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 600) clean[k] = v;
  }
  const id = db.transaction(() => {
    const rowId = Number(q.insert.run(batch, name, Math.trunc(Number(priority)) || 0, JSON.stringify(clean),
      hash, data.length, info.rate, info.samples, Date.now()).lastInsertRowid);
    writeAtomic(inputPath(rowId), data); // inside the transaction: no row without its file
    return rowId;
  })();
  logger.info('RE-USE job queued', { id, batch, name, seconds: Math.round(info.samples / info.rate) });
  return { ok: true, created: true, job: jobView(q.byId.get(id)) };
}

export function listJobs({ batch = null, status = null } = {}) {
  const now = Date.now();
  const jobs = q.list.all({ batch: batch || null, status: status || null }).map(j => jobView(j, now));
  const summary = { total: 0, audio_s: 0 };
  let doneAudio = 0, doneCompute = 0, leftAudio = 0;
  for (const r of q.summary.all({ batch: batch || null })) {
    summary[r.status] = r.n;
    summary.total += r.n;
    summary.audio_s += r.audio_s;
    if (r.status === 'done') { doneAudio = r.audio_s; doneCompute = r.compute_s; }
    if (r.status === 'pending' || r.status === 'claimed') leftAudio += r.audio_s;
  }
  summary.audio_s = Math.round(summary.audio_s);
  summary.hub_storage = { used_bytes: q.stored.get().bytes, max_bytes: config.reuseMaxStorage }; // all batches
  // Measured speed (compute seconds per audio second) and what is left at that speed, for one worker
  if (doneAudio > 0 && doneCompute > 0) {
    summary.measured_rtf = Math.round((doneCompute / doneAudio) * 1000) / 1000;
    summary.eta_one_worker_s = Math.round(leftAudio * doneCompute / doneAudio);
  }
  return { jobs, summary };
}

export const getJob = (id) => q.byId.get(Number(id)) || null;

export function retryJob(id) {
  return q.retry.run(Number(id)).changes === 1 ? { ok: true, job: jobView(getJob(id)) } : err(409, 'Only a failed or cancelled job can be retried');
}

export function cancelJob(id) {
  return q.cancel.run(Number(id)).changes === 1 ? { ok: true, job: jobView(getJob(id)) } : err(409, 'Job is already done or cancelled');
}

/** Remove a whole batch (rows and audio) once its outputs have been fetched. Refused while a job is being computed. */
export function deleteBatch(batch, now = Date.now()) {
  const rows = q.batchRows.all(String(batch));
  if (rows.length === 0) return err(404, 'Unknown batch');
  if (rows.some(j => j.status === 'claimed' && j.lease_until >= now)) return err(409, 'A job of this batch is being computed: cancel it first');
  q.deleteBatch.run(batch);
  for (const j of rows) {
    rmSync(inputPath(j.id), { force: true });
    rmSync(outputPath(j.id), { force: true });
  }
  logger.info('RE-USE batch deleted', { batch, jobs: rows.length });
  return { ok: true, deleted: rows.length };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------
/** update: 0, or the id of a pending forced-update order (the worker echoes it back as update_ack once restarted). */
export function workerOrders(name) {
  const w = q.worker.get(name);
  return {
    paused: Boolean(w?.paused),
    update: w?.update_requested || 0,
    worker_version: workerManifest().version
  };
}

/** Record a poll (last seen + what the worker says about itself) and return its standing orders. */
export function noteReusePoll(name, info = {}) {
  const kept = {};
  for (const k of ['version', 'backend', 'device', 'os', 'state', 'job', 'rolled_back_from', 'last_error', 'host', 'update_ack']) {
    if (info && info[k] != null) kept[k] = String(info[k]).slice(0, 200);
  }
  if (info && typeof info === 'object') q.touch.run(name, Date.now(), JSON.stringify(kept));
  else q.seen.run(name, Date.now());
  // A forced update is a one-shot order: fulfilled when the worker, restarted, echoes its id (no clocks involved,
  // and a worker that had to roll back still acknowledges, so the order can never loop)
  const w = q.worker.get(name);
  if (w.update_requested && Number(kept.update_ack) === w.update_requested) q.setUpdate.run(0, name);
  return workerOrders(name);
}

/**
 * Next job for this worker, or null. A worker that still holds a live lease gets that same job back
 * (it restarted mid-job: it resumes instead of taking a second one). Jobs out of attempts are failed.
 */
export function claimJob(name, now = Date.now()) {
  return db.transaction(() => {
    if (q.worker.get(name)?.paused) return null;
    const mine = q.held.get(name, now);
    if (mine) {
      q.renew.run(now + config.reuseLeaseMs, null, mine.id);
      return q.byId.get(mine.id);
    }
    for (;;) {
      const job = q.next.get(now);
      if (!job) return null;
      if (job.attempts >= config.reuseMaxAttempts) {
        q.fail.run('failed', job.error || `${job.worker || '?'}: lease expired without result`, job.id);
        logger.error('RE-USE job failed permanently', { id: job.id, attempts: job.attempts, worker: job.worker });
        continue;
      }
      q.claim.run(name, now, now + config.reuseLeaseMs, job.id);
      return q.byId.get(job.id);
    }
  })();
}

export function claimView(j) {
  return {
    id: j.id, batch: j.batch, name: j.name, attempt: j.attempts,
    size: j.in_size, sha256: j.in_sha256, rate: j.in_rate, samples: j.in_samples,
    params: parseParams(j.params),
    lease_s: Math.round(config.reuseLeaseMs / 1000)
  };
}

/** The job, if this worker may still act on it: it is the last claimer and nobody took it over since. */
function ownedJob(id, name) {
  const j = q.byId.get(Number(id));
  if (!j) return err(404, 'Unknown job');
  if (j.status !== 'claimed' || j.worker !== name) return err(409, `Job is ${j.status}${j.worker && j.worker !== name ? ` (held by ${j.worker})` : ''}`);
  return { ok: true, job: j };
}

/** May this caller download the input? Admin always; a worker only for the job it holds. */
export function canReadInput(caller, id) {
  if (caller.role === 'admin') return getJob(id) ? { ok: true } : err(404, 'Unknown job');
  return ownedJob(id, caller.name);
}

export function heartbeat(id, name, { progress, info } = {}, now = Date.now()) {
  const owned = ownedJob(id, name);
  if (!owned.ok) return owned;
  noteReusePoll(name, info); // a worker busy for an hour is still online, and says what it is doing
  const p = Number(progress);
  q.renew.run(now + config.reuseLeaseMs, Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null, owned.job.id);
  return { ok: true, lease_s: Math.round(config.reuseLeaseMs / 1000), orders: workerOrders(name) };
}

function recordFailure(job, name, reason) {
  const retry = job.attempts < config.reuseMaxAttempts;
  q.fail.run(retry ? 'pending' : 'failed', `${name}: ${String(reason).slice(0, 300)}`, job.id);
  q.ensureWorker.run(name);
  q.count.run(0, 1, 0, 0, name);
  if (retry) logger.warn('RE-USE job failed, will retry', { id: job.id, worker: name, error: reason });
  else logger.error('RE-USE job failed permanently', { id: job.id, worker: name, attempts: job.attempts, error: reason });
  return retry;
}

export function failJob(id, name, { error } = {}) {
  const owned = ownedJob(id, name);
  if (!owned.ok) return owned;
  const retry = recordFailure(owned.job, name, error || 'no reason given');
  return { ok: true, retry };
}

/**
 * Cleaned audio for a held job. The hub refuses (422) anything that is not a faithful cleaning:
 * wrong checksum, not FLAC, not mono, rate under 24 kHz or under the input rate, length off by more than 50 ms.
 * A refused result counts as a failed attempt, so the job goes back to the queue.
 */
export function completeJob(id, name, { data, sha256: announced, computeS, backend } = {}) {
  const owned = ownedJob(id, name);
  if (!owned.ok) return owned;
  const job = owned.job;
  if (!Buffer.isBuffer(data) || data.length === 0) return err(400, 'Empty body');
  const hash = sha256(data);
  // A transfer problem is not the worker's fault: no attempt burnt, the worker simply sends again
  if (!announced || String(announced).toLowerCase() !== hash) return err(400, 'X-Sha256 does not match the body');

  const info = parseFlac(data);
  let problem = null;
  if (!info) problem = 'output is not FLAC';
  else if (info.channels !== 1) problem = `output has ${info.channels} channels`;
  else if (info.rate < config.reuseMinRate || info.rate < job.in_rate) problem = `output rate ${info.rate} Hz is below ${Math.max(config.reuseMinRate, job.in_rate)} Hz`;
  else if (Math.abs(info.samples / info.rate - job.in_samples / job.in_rate) > 0.05) {
    problem = `output lasts ${(info.samples / info.rate).toFixed(3)} s, input ${(job.in_samples / job.in_rate).toFixed(3)} s`;
  } else if (hash === job.in_sha256) problem = 'output is identical to the input';
  if (problem) {
    const retry = recordFailure(job, name, problem);
    return { ...err(422, problem), retry };
  }

  // The cap is checked at submission assuming a result about as big as its source; a much bigger one
  // (higher bit depth) must not push the disk past the cap. Not the worker's fault: no attempt burnt,
  // it keeps its work and sends again once room has been made.
  if (q.stored.get().bytes + data.length > config.reuseMaxStorage) {
    return err(507, 'RE-USE storage is full on the hub: fetch the outputs of finished batches and delete them (DELETE /api/reuse/batches/:batch)');
  }

  const seconds = Number(computeS);
  const compute = Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  db.transaction(() => {
    writeAtomic(outputPath(job.id), data);
    q.done.run(hash, data.length, info.rate, compute, backend ? String(backend).slice(0, 60) : null, Date.now(), job.id);
    q.ensureWorker.run(name);
    q.count.run(1, 0, job.in_samples / job.in_rate, compute || 0, name);
  })();
  logger.info('RE-USE job done', { id: job.id, worker: name, computeS: compute });
  return { ok: true, job: jobView(q.byId.get(job.id)) };
}

sweepReuseStorage();

// ---------------------------------------------------------------------------
// Workers: state and remote orders
// ---------------------------------------------------------------------------
export function listWorkers(now = Date.now()) {
  const known = new Map(q.workers.all().map(w => [w.name, w]));
  for (const w of config.reuseWorkerTokens) if (!known.has(w.name)) known.set(w.name, { name: w.name });
  const published = workerManifest().version;
  return {
    published_version: published,
    workers: [...known.values()].map(w => {
      const info = parseParams(w.info);
      return {
        name: w.name,
        has_token: config.reuseWorkerTokens.some(t => t.name === w.name),
        last_poll_at: w.last_poll_at ? new Date(w.last_poll_at).toISOString() : null,
        age_s: w.last_poll_at ? Math.round((now - w.last_poll_at) / 1000) : null,
        online: Boolean(w.last_poll_at) && now - w.last_poll_at < 90 * 1000,
        paused: Boolean(w.paused),
        update_requested: Boolean(w.update_requested),
        up_to_date: info.version ? info.version === published : null,
        done: w.done || 0,
        failed: w.failed || 0,
        audio_s: Math.round(w.audio_s || 0),
        compute_s: Math.round(w.compute_s || 0),
        ...(w.audio_s > 0 && w.compute_s > 0 ? { rtf: Math.round((w.compute_s / w.audio_s) * 1000) / 1000 } : {}),
        info
      };
    })
  };
}

/** Remote order for one worker: {pause: true|false} and/or {update: true}. Applied at its next poll or heartbeat. */
export function orderWorker(name, { pause, update } = {}) {
  if (!WORKER_NAME.test(name || '')) return err(400, 'Invalid worker name');
  if (!config.reuseWorkerTokens.some(w => w.name === name) && !q.worker.get(name)) return err(404, 'Unknown worker');
  if (typeof pause !== 'boolean' && update !== true) return err(400, 'Expected {pause: true|false} and/or {update: true}');
  q.ensureWorker.run(name);
  if (typeof pause === 'boolean') q.setPaused.run(pause ? 1 : 0, name);
  if (update === true) q.setUpdate.run(crypto.randomInt(1, 2 ** 31), name);
  logger.info('RE-USE worker order', { worker: name, pause, update });
  return { ok: true, orders: workerOrders(name) };
}

// ---------------------------------------------------------------------------
// Worker program distribution (self-update): every file of reuseWorkerDir, with its checksum
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workerDir = () => path.resolve(config.reuseWorkerDir || path.join(repoRoot, 'reuse-worker'));
let manifestCache = { stamp: '', manifest: { version: 'none', files: [] } };

/**
 * {version, files:[{name, sha256, size}]}. The version is derived from the file contents, so publishing
 * a new worker is just replacing files in the directory: no version number to bump, no hub restart.
 * Local config files and documentation are never distributed.
 */
export function workerManifest() {
  const dir = workerDir();
  let names = [];
  try {
    // lstat: a symbolic link is never followed (it could publish a file from outside the directory)
    names = readdirSync(dir).filter(n => SAFE_NAME.test(n) && !n.startsWith('.') && !/\.(md|bak.*|config\.json)$/i.test(n)
      && lstatSync(path.join(dir, n)).isFile()).sort();
  } catch { /* no worker directory: empty manifest */ }
  let stamp, files;
  try {
    stamp = names.map(n => { const s = statSync(path.join(dir, n)); return `${n}:${s.size}:${s.mtimeMs}`; }).join('|');
    if (stamp === manifestCache.stamp) return manifestCache.manifest;
    files = names.map(n => {
      const data = readFileSync(path.join(dir, n));
      return { name: n, sha256: sha256(data), size: data.length };
    });
  } catch {
    return manifestCache.manifest; // a file vanished while being replaced (deploy in progress): keep the last good manifest
  }
  const version = files.length ? sha256(Buffer.from(files.map(f => `${f.name}:${f.sha256}`).join('\n'))).slice(0, 12) : 'none';
  manifestCache = { stamp, manifest: { version, files } };
  return manifestCache.manifest;
}

/** Absolute path of a distributed file, or null (only names listed in the manifest are served). */
export function workerFilePath(name) {
  return workerManifest().files.some(f => f.name === name) ? path.join(workerDir(), name) : null;
}
