import express, { Router } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import {
  reuseEnabled, identifyReuseCaller, submitJob, listJobs, getJob, jobView, retryJob, cancelJob, deleteBatch,
  noteReusePoll, claimJob, claimView, canReadInput, heartbeat, failJob, completeJob,
  listWorkers, orderWorker, workerOrders, workerManifest, workerFilePath, pythonRuntime, inputPath, outputPath, inputLost
} from '../services/reuse.js';

// ---------------------------------------------------------------------------
// RE-USE cleaning queue API. 404 when disabled. Bearer token = admin (HUB_REUSE_ADMIN_TOKEN) or
// one worker machine (HUB_REUSE_WORKER_TOKENS="name:token,name:sha256:<fingerprint>,..."). See reuse-worker/README.md.
// ---------------------------------------------------------------------------
const router = Router();
const json = express.json({ limit: '64kb' });
const raw = express.raw({ type: () => true, limit: config.reuseMaxFileSize });

/** Authenticated caller with the expected role ('admin', 'worker' or 'any'), or null after answering. */
function requireCaller(req, res, role) {
  if (!reuseEnabled()) {
    res.status(404).json({ error: 'RE-USE queue is not enabled (set HUB_REUSE_ADMIN_TOKEN / HUB_REUSE_WORKER_TOKENS)' });
    return null;
  }
  const auth = req.get('Authorization');
  const caller = identifyReuseCaller(auth?.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!caller) {
    res.status(403).json({ error: 'Invalid RE-USE token' });
    return null;
  }
  if (role !== 'any' && caller.role !== role) {
    res.status(403).json({ error: `This route needs a${role === 'admin' ? 'n admin' : ' worker'} token` });
    return null;
  }
  return caller;
}

/**
 * Route guard, placed BEFORE the body parser: an unknown caller never gets a body read into memory
 * (up to 32 MB per request otherwise). The caller is left in req.reuseCaller.
 */
const guard = (role) => (req, res, next) => {
  const caller = requireCaller(req, res, role);
  if (!caller) return;
  req.reuseCaller = caller;
  next();
};

/** A query value as one string (?batch[]=a or a repeated key gives an array: refused, never bound to SQL). */
const one = (v) => (typeof v === 'string' ? v : undefined);

const answer = (res, result, status = 200) => {
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.retry !== undefined ? { retry: result.retry } : {}) });
  const { ok, ...body } = result;
  res.status(status).json({ success: true, ...body });
};

function sendFlac(res, file, name) {
  if (!existsSync(file)) return res.status(404).json({ error: 'Audio file is missing on the hub' });
  res.set({ 'Content-Type': 'audio/flac', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.sendFile(path.resolve(file), { cacheControl: false, dotfiles: 'allow' }, (e) => { if (e && !res.headersSent) res.status(e.status || 500).end(); });
}

// ----- Admin -----------------------------------------------------------------

/**
 * POST /api/reuse/jobs?batch=extrait01&name=extrait01_000.flac[&priority=0][&chunk_s=5][&overlap_s=2.5]
 * Raw mono FLAC body. 201 {job} (200 when the same audio was already queued under that name, 409 if it differs).
 */
router.post('/api/reuse/jobs', guard('admin'), raw, (req, res) => {
  const result = submitJob({
    batch: one(req.query.batch), name: one(req.query.name), priority: one(req.query.priority),
    params: { chunk_s: one(req.query.chunk_s), overlap_s: one(req.query.overlap_s) },
    data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  });
  answer(res, result, result.created ? 201 : 200);
});

/** GET /api/reuse/jobs[?batch=][&status=] - Jobs and a summary (counts, audio seconds, measured speed, time left). */
router.get('/api/reuse/jobs', guard('admin'), (req, res) => {
  res.json(listJobs({ batch: one(req.query.batch), status: one(req.query.status) }));
});

/** GET /api/reuse/jobs/:id - One job (admin). */
router.get('/api/reuse/jobs/:id', guard('admin'), (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(jobView(job));
});

/** GET /api/reuse/jobs/:id/output - Cleaned FLAC of a done job, named <stem>_clean.flac (admin). */
router.get('/api/reuse/jobs/:id/output', guard('admin'), (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  if (job.status !== 'done') return res.status(409).json({ error: `Job is ${job.status}` });
  res.set('X-Sha256', job.out_sha256);
  sendFlac(res, outputPath(job.id), `${job.name.replace(/\.flac$/i, '')}_clean.flac`);
});

/** POST /api/reuse/jobs/:id/retry | /cancel (admin) */
router.post('/api/reuse/jobs/:id/retry', guard('admin'), (req, res) => {
  answer(res, retryJob(req.params.id));
});
router.post('/api/reuse/jobs/:id/cancel', guard('admin'), (req, res) => {
  answer(res, cancelJob(req.params.id));
});

/** DELETE /api/reuse/batches/:batch - Remove a batch and its audio from the hub once the outputs are fetched (admin). */
router.delete('/api/reuse/batches/:batch', guard('admin'), (req, res) => {
  answer(res, deleteBatch(req.params.batch));
});

/** GET /api/reuse/workers - Every worker: last poll, version, GPU, state, pause, speed (admin). */
router.get('/api/reuse/workers', guard('admin'), (req, res) => {
  res.json(listWorkers());
});

/** POST /api/reuse/workers/:name/order {pause: true|false} and/or {update: true} (admin). */
router.post('/api/reuse/workers/:name/order', guard('admin'), json, (req, res) => {
  answer(res, orderWorker(req.params.name, req.body || {}));
});

// ----- Worker ----------------------------------------------------------------

/**
 * POST /api/reuse/next {wait: 25, info: {version, backend, device, os, state}} - Long-poll for a job.
 * Always 200 {job: {...}|null, orders: {paused, update, worker_version}}. Returns early when an order changes.
 */
router.post('/api/reuse/next', guard('worker'), json, (req, res) => {
  const caller = req.reuseCaller;
  const body = req.body || {};
  const deadline = Date.now() + Math.min(Math.max(parseInt(body.wait, 10) || 0, 0), 25) * 1000;
  let closed = false;
  res.on('close', () => { closed = true; });
  const first = noteReusePoll(caller.name, body.info); // one write per poll; the loop below only reads

  const attempt = () => {
    if (closed) return;
    const orders = workerOrders(caller.name);
    const job = claimJob(caller.name);
    if (job) return res.json({ job: claimView(job), orders });
    const changed = orders.paused !== first.paused || orders.update !== first.update || orders.worker_version !== first.worker_version;
    // An order the worker must act on (update) is delivered at once; otherwise wait for a job
    if (changed || orders.update || Date.now() >= deadline) return res.json({ job: null, orders });
    setTimeout(attempt, 1000);
  };
  attempt();
});

/** POST /api/reuse/worker/status {info} - Report state without claiming anything (startup, install failure). {orders} */
router.post('/api/reuse/worker/status', guard('worker'), json, (req, res) => {
  const caller = req.reuseCaller;
  res.json({ orders: noteReusePoll(caller.name, (req.body || {}).info) });
});

/** GET /api/reuse/jobs/:id/input - Source FLAC (the worker holding the job, or admin). */
router.get('/api/reuse/jobs/:id/input', guard('any'), (req, res) => {
  const caller = req.reuseCaller;
  const allowed = canReadInput(caller, req.params.id);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  const job = getJob(req.params.id);
  if (!existsSync(inputPath(job.id))) {
    // Nothing to compute from: fail the job for good instead of handing it to workers again and again
    inputLost(job.id);
    return res.status(404).json({ error: 'Audio file is missing on the hub' });
  }
  res.set('X-Sha256', job.in_sha256);
  sendFlac(res, inputPath(job.id), job.name);
});

/** POST /api/reuse/jobs/:id/heartbeat {progress: 0..1, info} - Renew the lease. 409 = the job is no longer yours, stop. */
router.post('/api/reuse/jobs/:id/heartbeat', guard('worker'), json, (req, res) => {
  const caller = req.reuseCaller;
  answer(res, heartbeat(req.params.id, caller.name, req.body || {}));
});

/**
 * POST /api/reuse/jobs/:id/result?compute_s=12.3&backend=vulkan - Raw cleaned FLAC, header X-Sha256.
 * 422 when the audio is not a faithful cleaning (length, rate, channels): the attempt is counted and the job re-queued.
 */
router.post('/api/reuse/jobs/:id/result', guard('worker'), raw, (req, res) => {
  const caller = req.reuseCaller;
  answer(res, completeJob(req.params.id, caller.name, {
    data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    sha256: req.get('X-Sha256'), computeS: one(req.query.compute_s), backend: one(req.query.backend)
  }));
});

/** POST /api/reuse/jobs/:id/fail {error} - Give the job back (counted as an attempt). */
router.post('/api/reuse/jobs/:id/fail', guard('worker'), json, (req, res) => {
  const caller = req.reuseCaller;
  answer(res, failJob(req.params.id, caller.name, req.body || {}));
});

// ----- Worker program (self-update) --------------------------------------------

/** GET /api/reuse/worker/manifest - {version, files: [{name, sha256, size}]} of the published worker (any token). */
router.get('/api/reuse/worker/manifest', guard('any'), (req, res) => {
  res.json(workerManifest());
});

/** GET /api/reuse/worker/files/:name - One file of the manifest (any token). */
router.get('/api/reuse/worker/files/:name', guard('any'), (req, res) => {
  const file = workerFilePath(req.params.name);
  if (!file) return res.status(404).json({ error: 'Not a published worker file' });
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.sendFile(file, { cacheControl: false, dotfiles: 'allow' }, (e) => { if (e && !res.headersSent) res.status(e.status || 500).end(); });
});

/**
 * GET /api/reuse/worker/python - Official python.org embed zip the published Windows launcher expects
 * (same version, same sha256), for a PC that cannot reach python.org. Any RE-USE token, like the other
 * worker files: the archive is public, but the route makes the hub download and send 12 MB.
 */
router.get('/api/reuse/worker/python', guard('any'), async (req, res) => {
  let runtime;
  try { runtime = await pythonRuntime(); } catch (e) { runtime = { ok: false, status: 500, error: `Python archive unavailable: ${e.message}` }; }
  if (!runtime.ok) return res.status(runtime.status).json({ error: runtime.error });
  res.set({
    'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${runtime.spec.name}"`,
    'X-Sha256': runtime.spec.sha256, 'Cache-Control': 'no-store'
  });
  res.sendFile(runtime.file, { cacheControl: false, dotfiles: 'allow' }, (e) => { if (e && !res.headersSent) res.status(e.status || 500).end(); });
});

export default router;
