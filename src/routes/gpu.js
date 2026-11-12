import express, { Router } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import {
  gpuEnabled, identifyGpuCaller, submitGpuJob, listGpuJobs, ownJob, gpuJobView, cancelGpuJob, deleteGpuJob, gpuCapabilities,
  gpuInputFor, heartbeatGpu, failGpu, completeGpu, gpuOutputPath
} from '../services/gpu-jobs.js';

// ---------------------------------------------------------------------------
// GPU jobs API (image, 3D) - see reuse-worker/GPU.md. 404 while the RE-USE queue or the catalog is missing.
// Clients: a room member listed in HUB_GPU_MEMBERS (its own member token) or the RE-USE admin token.
// Workers: their RE-USE token; they get GPU jobs from POST /api/reuse/next and answer here.
// ---------------------------------------------------------------------------
const router = Router();
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', glb: 'model/gltf-binary' };
// A base64 image is a third bigger than the file, plus the prompt and parameters
const submitJson = express.json({ limit: Math.ceil(config.gpuMaxInputSize * 4 / 3) + 64 * 1024 });
const json = express.json({ limit: '64kb' });
const raw = express.raw({ type: () => true, limit: config.gpuMaxOutputSize });

/** Caller guard, BEFORE any body parser (an unknown token never gets a body read). role: 'client' (incl. admin) | 'worker'. */
const guard = (role) => (req, res, next) => {
  if (!gpuEnabled()) return res.status(404).json({ error: 'GPU jobs are not enabled on this hub' });
  const auth = req.get('Authorization');
  const caller = identifyGpuCaller(auth?.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!caller) return res.status(auth ? 403 : 401).json({ error: auth ? 'Invalid token' : 'Authorization: Bearer <member token> required' });
  if (caller.role === 'refused') return res.status(403).json({ error: caller.error });
  if (role === 'worker' && caller.role !== 'worker') return res.status(403).json({ error: 'This route needs a worker token' });
  if (role === 'client' && caller.role === 'worker') return res.status(403).json({ error: 'Workers do not submit GPU jobs' });
  req.gpuCaller = caller;
  next();
};

const one = (v) => (typeof v === 'string' ? v : undefined);
const answer = (res, result, status = 200) => {
  if (!result.ok) {
    const { ok, status: s, ...rest } = result;
    return res.status(s).json(rest);
  }
  const { ok, ...body } = result;
  res.status(status).json({ success: true, ...body });
};

function sendFile(res, file, name, ext) {
  if (!file || !existsSync(file)) return res.status(410).json({ error: 'File is no longer on the hub' });
  res.set({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.sendFile(path.resolve(file), { cacheControl: false, dotfiles: 'allow' }, (e) => { if (e && !res.headersSent) res.status(e.status || 500).end(); });
}

// ----- Clients -----------------------------------------------------------------

/** GET /api/gpu/capabilities - types, models with their parameters, workers (online, in window, busy), limits. */
router.get('/api/gpu/capabilities', guard('client'), (req, res) => {
  res.json(gpuCapabilities());
});

/**
 * POST /api/gpu/jobs {type: "image"|"3d", prompt, model?, width?, height?, size?: "1024x768", steps?, seed?, cfg_scale?,
 * negative_prompt?, image?: base64 (3D input, or image to image), priority?} -> 201 {job, adjusted?, ignored?}
 */
router.post('/api/gpu/jobs', guard('client'), submitJson, (req, res) => {
  answer(res, submitGpuJob(req.gpuCaller, req.body), 201);
});

/** GET /api/gpu/jobs[?status=][&limit=] - your jobs, newest first (admin: everyone's). */
router.get('/api/gpu/jobs', guard('client'), (req, res) => {
  res.json(listGpuJobs(req.gpuCaller, { status: one(req.query.status), limit: one(req.query.limit) }));
});

/**
 * GET /api/gpu/jobs/:id[?wait=60] - one job. With wait (seconds, at most 120), the answer comes as soon as the job is
 * finished (done, failed, cancelled), or at the end of the wait with its current state.
 */
router.get('/api/gpu/jobs/:id', guard('client'), (req, res) => {
  const first = ownJob(req.gpuCaller, req.params.id);
  if (!first.ok) return answer(res, first);
  const deadline = Date.now() + Math.min(Math.max(parseInt(one(req.query.wait), 10) || 0, 0), 120) * 1000;
  let closed = false;
  res.on('close', () => { closed = true; });
  const attempt = () => {
    if (closed) return;
    const r = ownJob(req.gpuCaller, req.params.id);
    if (!r.ok) return answer(res, r);
    const view = gpuJobView(r.job);
    if (['done', 'failed', 'cancelled'].includes(view.status) || Date.now() >= deadline) return res.json(view);
    setTimeout(attempt, 1000);
  };
  attempt();
});

/** GET /api/gpu/jobs/:id/result - the file (PNG image, GLB model). Header X-Sha256. */
router.get('/api/gpu/jobs/:id/result', guard('client'), (req, res) => {
  const r = ownJob(req.gpuCaller, req.params.id);
  if (!r.ok) return answer(res, r);
  const j = r.job;
  if (j.status !== 'done') return res.status(409).json({ error: `Job is ${j.status}`, status: j.status });
  res.set('X-Sha256', j.out_sha256);
  sendFile(res, gpuOutputPath(j), `gpu-${j.id}-${j.type}.${j.out_ext}`, j.out_ext);
});

/** POST /api/gpu/jobs/:id/cancel - stops a waiting job, or the one being computed (the worker drops it). */
router.post('/api/gpu/jobs/:id/cancel', guard('client'), (req, res) => {
  answer(res, cancelGpuJob(req.gpuCaller, req.params.id));
});

/** DELETE /api/gpu/jobs/:id - a finished job and its files (otherwise removed after the retention delay). */
router.delete('/api/gpu/jobs/:id', guard('client'), (req, res) => {
  answer(res, deleteGpuJob(req.gpuCaller, req.params.id));
});

/** GET /api/gpu/jobs/:id/input - input image: owner, admin, or the worker holding the job. */
router.get('/api/gpu/jobs/:id/input', guard('any'), (req, res) => {
  const r = gpuInputFor(req.gpuCaller, req.params.id);
  if (!r.ok) return answer(res, r);
  res.set('X-Sha256', r.job.in_sha256);
  sendFile(res, r.file, `gpu-${r.job.id}-input.${r.job.in_ext}`, r.job.in_ext);
});

// ----- Workers -----------------------------------------------------------------

/** POST /api/gpu/jobs/:id/heartbeat {progress, stage, info} - renew the lease. 409 = no longer yours (cancelled), stop. */
router.post('/api/gpu/jobs/:id/heartbeat', guard('worker'), json, (req, res) => {
  answer(res, heartbeatGpu(req.params.id, req.gpuCaller.name, req.body || {}));
});

/** POST /api/gpu/jobs/:id/fail {error} - give the job back (attempt counted). */
router.post('/api/gpu/jobs/:id/fail', guard('worker'), json, (req, res) => {
  answer(res, failGpu(req.params.id, req.gpuCaller.name, req.body || {}));
});

/** POST /api/gpu/jobs/:id/result?compute_s=&backend=&meta=<json> - raw file, header X-Sha256. 422 = not what was asked. */
router.post('/api/gpu/jobs/:id/result', guard('worker'), raw, (req, res) => {
  let meta = null;
  try { meta = req.query.meta ? JSON.parse(one(req.query.meta) || 'null') : null; } catch { meta = null; }
  answer(res, completeGpu(req.params.id, req.gpuCaller.name, {
    data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), sha256: req.get('X-Sha256'),
    computeS: one(req.query.compute_s), backend: one(req.query.backend), meta
  }));
});

export default router;
