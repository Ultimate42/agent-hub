import crypto from 'crypto';
import path from 'path';
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, statSync, existsSync } from 'fs';
import { dbInstance as db, database } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { reuseEnabled, identifyReuseCaller, workerDir, heldReuseJob, listWorkers, noteReusePoll, workerOrders } from './reuse.js';

// ---------------------------------------------------------------------------
// GPU jobs: image and 3D generation on the RE-USE worker machines
// ---------------------------------------------------------------------------
// Same contract as the RE-USE queue, and the same machines: the hub never runs a model. A client (an agent with
// its member token, or the RE-USE admin) submits a request; a worker that announces the type in its polls
// ("gpu": "image,3d") gets it from POST /api/reuse/next, renews its lease while it computes, uploads the file.
// One job at a time per machine, whatever its kind; a RE-USE job being computed is never interrupted
// (reuse.js claimJob: held RE-USE job first, then a held GPU job, then the schedule, then a new GPU job, then RE-USE).
//
// What can be asked is data, not code: reuse-worker/gpu-catalog.json, published with the worker program. The hub
// validates parameters against it; the worker reads the same file to install the engines and models (pinned
// by SHA-256) and to build the command line. A new model = a catalog entry, no hub release.

const TYPE = /^[a-z0-9]{1,16}$/;
const MODEL = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PROMPT_MAX = 4000;
/** Own key of a catalog object ("constructor" or "toString" are not types or models). */
const own = (obj, key) => Boolean(obj && typeof obj === 'object' && Object.hasOwn(obj, key) && obj[key]);
const err = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Catalog (published worker directory, re-read when the file changes)
// ---------------------------------------------------------------------------
let catalogCache = { stamp: '', catalog: null };

/** Parsed gpu-catalog.json of the published worker, or null (absent or unreadable: GPU jobs disabled). */
export function gpuCatalog() {
  const file = path.join(workerDir(), 'gpu-catalog.json');
  let stamp;
  try { const s = statSync(file); stamp = `${s.size}:${s.mtimeMs}`; } catch { return null; }
  if (stamp === catalogCache.stamp) return catalogCache.catalog;
  let catalog = null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.types === 'object' && Object.keys(parsed.types).length) catalog = parsed;
    else logger.warn('GPU catalog has no types: GPU jobs disabled', { file });
  } catch (e) {
    logger.warn('GPU catalog unreadable: GPU jobs disabled', { file, error: e.message });
  }
  catalogCache = { stamp, catalog };
  return catalog;
}

export const gpuEnabled = () => reuseEnabled() && Boolean(gpuCatalog());

// ---------------------------------------------------------------------------
// Callers: RE-USE admin, RE-USE worker, or a room member listed in HUB_GPU_MEMBERS
// ---------------------------------------------------------------------------
/** {role: 'admin'|'worker'|'client', owner, label[, name]} | {role: 'refused', error} | null (unknown token). */
export function identifyGpuCaller(token) {
  if (!token || typeof token !== 'string' || token.length > 256) return null;
  const reuse = identifyReuseCaller(token);
  if (reuse?.role === 'admin') return { role: 'admin', owner: 'admin', label: 'admin' };
  if (reuse?.role === 'worker') return { role: 'worker', name: reuse.name, owner: `w:${reuse.name}`, label: reuse.name };
  const member = database.getMemberByToken(token);
  if (!member) return null;
  const roomId = Number(member.room_id);
  const allowed = config.gpuMembers.some(e => e.roomId === roomId && (e.member === null || e.member === member.name));
  if (!allowed) return { role: 'refused', error: 'This member may not use the GPU jobs (HUB_GPU_MEMBERS on the hub)' };
  return { role: 'client', owner: `m:${roomId}:${member.name}`, label: `${member.name}@${roomId}` };
}

// ---------------------------------------------------------------------------
// Schema and storage (<gpuDir>/<id>.in.<ext>, <id>.out.<ext>: names never come from the client)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS gpu_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    model TEXT NOT NULL,
    owner TEXT NOT NULL,
    owner_label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | failed | cancelled
    priority INTEGER NOT NULL DEFAULT 0,
    params TEXT NOT NULL DEFAULT '{}',
    in_sha256 TEXT, in_size INTEGER, in_ext TEXT,
    out_sha256 TEXT, out_size INTEGER, out_ext TEXT, out_meta TEXT,
    worker TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    progress REAL,
    stage TEXT,
    compute_s REAL,
    backend TEXT,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    lease_until INTEGER,
    done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_jobs_status ON gpu_jobs (status, priority DESC, id);
  CREATE INDEX IF NOT EXISTS idx_gpu_jobs_owner ON gpu_jobs (owner, id);
`);
// What the engine said during the current attempt (device, memory plan, timings, useful lines), sent with heartbeats
if (!db.prepare('PRAGMA table_info(gpu_jobs)').all().some(c => c.name === 'engine')) db.exec('ALTER TABLE gpu_jobs ADD COLUMN engine TEXT');
// Reference images of a job (FLUX 3 Klein): [{sha256, size, ext}], files <id>.ref<n>.<ext>; refs_size counts in the storage cap
if (!db.prepare('PRAGMA table_info(gpu_jobs)').all().some(c => c.name === 'refs')) {
  db.exec('ALTER TABLE gpu_jobs ADD COLUMN refs TEXT');
  db.exec('ALTER TABLE gpu_jobs ADD COLUMN refs_size INTEGER');
}

const q = {
  insert: db.prepare(`INSERT INTO gpu_jobs (type, model, owner, owner_label, priority, params, in_sha256, in_size, in_ext, refs, refs_size, created_at)
                      VALUES (@type, @model, @owner, @label, @priority, @params, @in_sha256, @in_size, @in_ext, @refs, @refs_size, @now)`),
  byId: db.prepare('SELECT * FROM gpu_jobs WHERE id = ?'),
  list: db.prepare(`SELECT * FROM gpu_jobs WHERE (@owner IS NULL OR owner = @owner) AND (@status IS NULL OR status = @status)
                    ORDER BY id DESC LIMIT @limit`),
  waitingOf: db.prepare(`SELECT COUNT(*) AS n FROM gpu_jobs WHERE owner = ? AND (status = 'pending' OR status = 'claimed')`),
  ahead: db.prepare(`SELECT COUNT(*) AS n FROM gpu_jobs WHERE (status = 'pending' OR (status = 'claimed' AND lease_until < @now))
                     AND type = @type AND (priority > @priority OR (priority = @priority AND id < @id))`),
  candidates: db.prepare(`SELECT * FROM gpu_jobs WHERE status = 'pending' OR (status = 'claimed' AND lease_until < ?)
                          ORDER BY priority DESC, id LIMIT 200`),
  held: db.prepare(`SELECT * FROM gpu_jobs WHERE status = 'claimed' AND worker = ? AND lease_until >= ? ORDER BY id LIMIT 1`),
  heldAll: db.prepare(`SELECT worker, type FROM gpu_jobs WHERE status = 'claimed' AND lease_until >= ?`),
  claim: db.prepare(`UPDATE gpu_jobs SET status = 'claimed', worker = ?, claimed_at = ?, lease_until = ?, attempts = attempts + 1,
                     progress = NULL, stage = NULL, engine = NULL WHERE id = ?`),
  renew: db.prepare('UPDATE gpu_jobs SET lease_until = ?, progress = COALESCE(?, progress), stage = COALESCE(?, stage) WHERE id = ?'),
  engine: db.prepare('UPDATE gpu_jobs SET engine = ? WHERE id = ?'),
  fail: db.prepare('UPDATE gpu_jobs SET status = ?, error = ?, lease_until = NULL, done_at = ? WHERE id = ?'),
  done: db.prepare(`UPDATE gpu_jobs SET status = 'done', out_sha256 = ?, out_size = ?, out_ext = ?, out_meta = ?, compute_s = ?, backend = ?,
                    error = NULL, progress = 1, stage = NULL, lease_until = NULL, done_at = ? WHERE id = ?`),
  cancel: db.prepare(`UPDATE gpu_jobs SET status = 'cancelled', lease_until = NULL, done_at = ? WHERE id = ? AND status IN ('pending', 'claimed')`),
  remove: db.prepare('DELETE FROM gpu_jobs WHERE id = ?'),
  stale: db.prepare(`SELECT id FROM gpu_jobs WHERE status = 'pending' AND created_at < ?`),
  expired: db.prepare(`SELECT id FROM gpu_jobs WHERE status IN ('done', 'failed', 'cancelled') AND COALESCE(done_at, created_at) < ?`),
  ids: db.prepare('SELECT id, status FROM gpu_jobs'),
  stored: db.prepare('SELECT COALESCE(SUM(COALESCE(in_size, 0) + COALESCE(refs_size, 0) + COALESCE(out_size, 0)), 0) AS bytes FROM gpu_jobs'),
  counts: db.prepare(`SELECT type, status, COUNT(*) AS n FROM gpu_jobs WHERE status IN ('pending', 'claimed') GROUP BY type, status`)
};

const EXT = /^(png|jpg|webp|glb)$/;
const inPath = (id, ext) => path.join(config.gpuDir, `${Number(id)}.in.${EXT.test(ext) ? ext : 'bin'}`);
const outPath = (id, ext) => path.join(config.gpuDir, `${Number(id)}.out.${EXT.test(ext) ? ext : 'bin'}`);
export const gpuInputPath = (j) => (j.in_ext ? inPath(j.id, j.in_ext) : null);
export const gpuOutputPath = (j) => (j.out_ext ? outPath(j.id, j.out_ext) : null);
const refPath = (id, n, ext) => path.join(config.gpuDir, `${Number(id)}.ref${Number(n)}.${EXT.test(ext) ? ext : 'bin'}`);
const refsOf = (j) => { try { return JSON.parse(j.refs || '[]') || []; } catch { return []; } };
export const gpuRefPaths = (j) => refsOf(j).map((r, n) => refPath(j.id, n, r.ext));

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function removeFiles(j) {
  for (const f of [gpuInputPath(j), gpuOutputPath(j), ...gpuRefPaths(j)]) if (f) rmSync(f, { force: true });
}

/** Image formats accepted as input, by magic number (never by the name or the Content-Type). */
export function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** {width, height} of a PNG (IHDR), or null. */
export function pngSize(buf) {
  if (imageKind(buf) !== 'png' || buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A binary glTF 2.0 file whose header announces exactly its own length. */
export function isGlb(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 20 && buf.toString('latin1', 0, 4) === 'glTF'
    && buf.readUInt32LE(4) === 2 && buf.readUInt32LE(8) === buf.length;
}

// ---------------------------------------------------------------------------
// Request validation (catalog driven, forgiving where the intent is clear)
// ---------------------------------------------------------------------------
const ALIASES = { w: 'width', h: 'height', n_steps: 'steps', num_steps: 'steps', cfg: 'cfg_scale', guidance: 'cfg_scale',
  negative: 'negative_prompt', neg_prompt: 'negative_prompt', input_image: 'image', image_base64: 'image', init_image: 'image' };
const TOP = new Set(['type', 'model', 'prompt', 'image', 'references', 'priority', 'size', 'params']);

/** Decode an image given as base64 or a data: URL. -> {buf, ext} | {error} */
function decodeImage(value) {
  if (typeof value !== 'string' || !value) return { error: 'image must be a base64 string (or a data: URL)' };
  const b64 = value.replace(/^data:[\w/+.-]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return { error: 'image is not valid base64' };
  if (b64.length * 3 / 4 > config.gpuMaxInputSize + 4) return { error: `image larger than ${Math.round(config.gpuMaxInputSize / 1048576)} MB`, status: 413 };
  const buf = Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64');
  const ext = imageKind(buf);
  if (!ext) return { error: 'image must be PNG, JPEG or WebP' };
  return { buf, ext };
}

/** One parameter value against its catalog spec -> {value[, note]} | {error}. Out-of-range numbers are clamped (said in note). */
function checkParam(name, spec, raw) {
  const t = spec.type;
  if (t === 'string') {
    if (typeof raw !== 'string') return { error: `${name} must be a string` };
    // eslint-disable-next-line no-control-regex
    const v = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    const max = spec.max || 2000;
    return v.length > max ? { error: `${name} is longer than ${max} characters` } : { value: v };
  }
  if (t === 'bool') {
    if (typeof raw === 'boolean') return { value: raw };
    if (raw === 'true' || raw === 1 || raw === '1') return { value: true };
    if (raw === 'false' || raw === 0 || raw === '0') return { value: false };
    return { error: `${name} must be true or false` };
  }
  if (t === 'enum') {
    const v = String(raw).toLowerCase();
    return spec.values.includes(v) ? { value: v } : { error: `${name} must be one of: ${spec.values.join(', ')}` };
  }
  if (t === 'int' || t === 'number') {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) return { error: `${name} must be a number` };
    let v = t === 'int' ? Math.round(n) : n;
    if (spec.multiple) v = Math.round(v / spec.multiple) * spec.multiple;
    if (spec.min !== undefined && v < spec.min) v = spec.min;
    if (spec.max !== undefined && v > spec.max) v = spec.max;
    return v !== n ? { value: v, note: `${name} ${n} -> ${v}` } : { value: v };
  }
  return { error: `${name}: unknown parameter type in the catalog` };
}

/**
 * Body of POST /api/gpu/jobs -> {ok, type, model, prompt, params, input, adjusted, ignored} | {ok:false, status, error}.
 * Parameters may sit at the top level or under "params"; common aliases (w, h, cfg, negative...) and "size": "1024x768"
 * are understood. Unknown keys are ignored and listed in the answer, so a caller learns without failing.
 */
// sd-server reads generation settings hidden in the prompt (<sd_cpp_extra_args>{json}</...>), some of them local file
// paths: never let a caller's text reach the engine as instructions
const ENGINE_DIRECTIVE = /sd_cpp_extra_args/i;

export function normalizeRequest(body, catalog = gpuCatalog(), { admin = false } = {}) {
  if (!catalog) return err(404, 'GPU jobs are not enabled on this hub (no gpu-catalog.json published)');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'Expected a JSON object');
  const flat = { ...(body.params && typeof body.params === 'object' ? body.params : {}) };
  for (const [k, v] of Object.entries(body)) if (k !== 'params') flat[k] = v;
  const given = {};
  for (const [k, v] of Object.entries(flat)) given[ALIASES[k] || k] = v;

  let type = given.type !== undefined ? String(given.type).toLowerCase() : null;
  const model = given.model !== undefined ? String(given.model).toLowerCase() : null;
  if (!type && model) type = Object.keys(catalog.types).find(t => own(catalog.types[t].models, model)) || null;
  if (!type) type = given.image !== undefined && given.prompt === undefined && own(catalog.types, '3d') ? '3d' : 'image';
  if (!TYPE.test(type) || !own(catalog.types, type)) return err(400, `Unknown type "${type}". Available: ${Object.keys(catalog.types).join(', ')}`);
  const spec = catalog.types[type];
  const modelId = model || spec.default_model;
  if (!MODEL.test(modelId || '') || !own(spec.models, modelId)) {
    return err(400, `Unknown model "${modelId}" for ${type}. Available: ${Object.keys(spec.models || {}).join(', ')}`);
  }
  const m = spec.models[modelId];

  const adjusted = [];
  let prompt = '';
  if (spec.prompt !== 'none') {
    const p = given.prompt === undefined ? '' : checkParam('prompt', { type: 'string', max: PROMPT_MAX }, given.prompt);
    if (p.error) return err(400, p.error);
    prompt = p.value || '';
    if (!prompt && spec.prompt === 'required') return err(400, `prompt is required for ${type}`);
    if (ENGINE_DIRECTIVE.test(prompt)) return err(400, 'prompt must not contain engine directives (sd_cpp_extra_args)');
  }

  let input = null;
  if (given.image !== undefined && given.image !== null && given.image !== '') {
    if (!spec.input || spec.input === 'none') return err(400, `${type} (${modelId}) takes no input image`);
    const img = decodeImage(given.image);
    if (img.error) return err(img.status || 400, img.error);
    if (Array.isArray(spec.input_formats) && !spec.input_formats.includes(img.ext)) {
      return err(400, `${type} takes ${spec.input_formats.map(f => f.toUpperCase()).join(' or ')} input images, not ${img.ext.toUpperCase()}`);
    }
    input = img;
  } else if (spec.input === 'required') return err(400, `image (base64 PNG, JPEG or WebP) is required for ${type}`);

  // Reference images (FLUX 3 Klein): the model's native multi-reference input, not image to image
  const refSpec = m.references;
  const references = [];
  if (refSpec && input) return err(400, `${modelId} takes "references" (a list of images), not "image"`);
  if (given.references !== undefined && given.references !== null) {
    if (!refSpec) return err(400, `${type} (${modelId}) takes no references`);
    if (!Array.isArray(given.references)) return err(400, 'references must be a list of base64 images (PNG or JPEG)');
    if (given.references.length > refSpec.max) return err(400, `at most ${refSpec.max} references for ${modelId}`);
    for (const [i, raw] of given.references.entries()) {
      const img = decodeImage(raw);
      if (img.error) return err(img.status || 400, `references[${i}]: ${img.error}`);
      if (!refSpec.formats.includes(img.ext)) return err(400, `references[${i}]: ${refSpec.formats.map(f => f.toUpperCase()).join(' or ')} only, not ${img.ext.toUpperCase()}`);
      if (img.buf.length > refSpec.max_bytes) return err(413, `references[${i}]: larger than ${Math.round(refSpec.max_bytes / 1048576)} MB`);
      references.push(img);
    }
  }

  if (typeof given.size === 'string') {
    const s = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(given.size);
    if (!s) return err(400, 'size must look like "1024x768"');
    if (given.width === undefined) given.width = Number(s[1]);
    if (given.height === undefined) given.height = Number(s[2]);
  }

  const specs = m.params || {};
  const params = {};
  const adminOnly = [];
  for (const [name, ps] of Object.entries(specs)) {
    if (ps.needs_input && !input) continue;
    let raw = given[name];
    // Engine tuning (attention, VAE tiling, threads) restarts the resident engine: the RE-USE admin only
    if (ps.admin && !admin) {
      if (raw !== undefined) adminOnly.push(name);
      raw = undefined;
    }
    if (raw === undefined || raw === null || raw === '') {
      if (name === 'seed' && (ps.default === undefined || ps.default === 'random')) {
        params.seed = crypto.randomInt(0, 2 ** 31 - 1); // chosen here, so every result can be made again
        continue;
      }
      if (ps.default === undefined) continue;
      raw = ps.default;
    }
    if (name === 'seed' && Number(raw) < 0) { params.seed = crypto.randomInt(0, 2 ** 31 - 1); continue; }
    const c = checkParam(name, ps, raw);
    if (c.error) return err(400, c.error);
    if (typeof c.value === 'string' && ENGINE_DIRECTIVE.test(c.value)) return err(400, `${name} must not contain engine directives (sd_cpp_extra_args)`);
    params[name] = c.value;
    if (c.note) adjusted.push(c.note);
  }
  const ignored = Object.keys(given).filter(k => !TOP.has(k) && !(k in specs) && k !== 'width' && k !== 'height');
  for (const k of ['width', 'height']) if (given[k] !== undefined && !(k in specs)) ignored.push(k);
  for (const k of adminOnly) ignored.push(`${k} (admin only)`);

  let priority = 0;
  if (given.priority !== undefined) {
    const p = checkParam('priority', { type: 'int', min: -10, max: 10 }, given.priority);
    if (p.error) return err(400, p.error);
    priority = p.value;
  }
  return { ok: true, type, model: modelId, prompt, params, input, references, priority, adjusted, ignored };
}

// ---------------------------------------------------------------------------
// Which workers offer what (they say it in every poll: info.gpu = "image,3d")
// ---------------------------------------------------------------------------
const typesOf = (info) => String(info?.gpu || '').split(',').map(s => s.trim()).filter(t => TYPE.test(t));
// Models that need more than the type's engine (FLUX 3 Klein: ComfyUI installed on the machine), announced one by one
const modelsOf = (info) => String(info?.gpu_models || '').split(',').map(s => s.trim()).filter(t => MODEL.test(t));
const needsAnnounce = (type, model) => Boolean(gpuCatalog()?.types?.[type]?.models?.[model]?.engine);
const canRun = (types, models, type, model) => types.has(type) && (!needsAnnounce(type, model) || models.has(model));

/** Workers (with a token) that announced this type (and this model when it needs it) at least once, online or not. */
function offeredBy(type, workers, model = null) {
  return workers.filter(w => w.has_token && typesOf(w.info).includes(type)
    && (!model || !needsAnnounce(type, model) || modelsOf(w.info).includes(model))).map(w => w.name);
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------
function parse(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/** Public view of a job; result_url once done. */
export function gpuJobView(j, now = Date.now()) {
  const expired = j.status === 'claimed' && j.lease_until < now;
  const status = expired ? 'pending' : j.status;
  const params = parse(j.params);
  const view = {
    id: j.id, type: j.type, model: j.model, status, priority: j.priority,
    prompt: params.prompt, params: params.values || {},
    ...(j.in_sha256 ? { input: { sha256: j.in_sha256, size: j.in_size, format: j.in_ext } } : {}),
    ...(j.refs ? { references: refsOf(j).map(r => ({ sha256: r.sha256, size: r.size, format: r.ext })) } : {}),
    owner: j.owner_label, worker: j.worker, attempts: j.attempts,
    ...(j.error ? { error: j.error } : {}),
    ...(status === 'claimed' ? { progress: j.progress ?? 0, ...(j.stage ? { stage: j.stage } : {}) } : {}),
    ...(status === 'pending' ? { queue_position: q.ahead.get({ now, type: j.type, priority: j.priority, id: j.id }).n + 1 } : {}),
    ...(j.compute_s != null ? { compute_s: j.compute_s, backend: j.backend } : {}),
    ...(j.engine ? { engine: parse(j.engine) } : {}),
    created_at: new Date(j.created_at).toISOString(),
    ...(j.claimed_at ? { claimed_at: new Date(j.claimed_at).toISOString() } : {}),
    ...(j.done_at ? { finished_at: new Date(j.done_at).toISOString() } : {})
  };
  if (j.status === 'done') {
    view.result = { url: `/api/gpu/jobs/${j.id}/result`, format: j.out_ext, size: j.out_size, sha256: j.out_sha256, ...parse(j.out_meta) };
    view.expires_at = new Date(j.done_at + config.gpuRetentionMs).toISOString();
  }
  return view;
}

const mayRead = (caller, j) => caller.role === 'admin' || j.owner === caller.owner;

/** The job if this caller may see it (admin: all; others: their own), else a 404 that says nothing about others. */
export function ownJob(caller, id) {
  const j = q.byId.get(Number(id));
  return j && mayRead(caller, j) ? { ok: true, job: j } : err(404, 'Unknown job');
}

export function submitGpuJob(caller, body, now = Date.now()) {
  purgeGpu(now);
  const r = normalizeRequest(body, gpuCatalog(), { admin: caller.role === 'admin' });
  if (!r.ok) return r;
  const { workers } = listWorkers(now);
  if (!offeredBy(r.type, workers).length) {
    return err(409, `No worker offers "${r.type}" yet${gpuCatalog().types[r.type].experimental ? ' (experimental type, enabled machine by machine)' : ''}: see GET /api/gpu/capabilities`);
  }
  if (!offeredBy(r.type, workers, r.model).length) {
    return err(409, `No worker offers the model "${r.model}" yet (it needs ComfyUI on the machine): see GET /api/gpu/capabilities`);
  }
  if (caller.role !== 'admin' && q.waitingOf.get(caller.owner).n >= config.gpuMaxWaitingPerOwner) {
    return err(429, `Already ${config.gpuMaxWaitingPerOwner} jobs waiting for you: wait for them or cancel some`);
  }
  const refsSize = r.references.reduce((n, x) => n + x.buf.length, 0);
  if ((r.input || refsSize) && q.stored.get().bytes + (r.input?.buf.length || 0) + refsSize > config.gpuMaxStorage) {
    return err(507, 'GPU storage is full on the hub: delete finished jobs (DELETE /api/gpu/jobs/:id)');
  }
  const row = {
    type: r.type, model: r.model, owner: caller.owner, label: caller.label, priority: r.priority,
    params: JSON.stringify({ prompt: r.prompt, values: r.params }),
    in_sha256: r.input ? sha256(r.input.buf) : null, in_size: r.input ? r.input.buf.length : null, in_ext: r.input?.ext || null,
    refs: r.references.length ? JSON.stringify(r.references.map(x => ({ sha256: sha256(x.buf), size: x.buf.length, ext: x.ext }))) : null,
    refs_size: refsSize || null, now
  };
  const id = db.transaction(() => {
    const rowId = Number(q.insert.run(row).lastInsertRowid);
    if (r.input) writeAtomic(inPath(rowId, r.input.ext), r.input.buf);
    r.references.forEach((x, n) => writeAtomic(refPath(rowId, n, x.ext), x.buf));
    return rowId;
  })();
  logger.info('GPU job queued', { id, type: r.type, model: r.model, owner: caller.label });
  return {
    ok: true, job: gpuJobView(q.byId.get(id), now),
    ...(r.adjusted.length ? { adjusted: r.adjusted } : {}), ...(r.ignored.length ? { ignored: r.ignored } : {})
  };
}

export function listGpuJobs(caller, { status = null, limit = 50 } = {}, now = Date.now()) {
  purgeGpu(now);
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const rows = q.list.all({ owner: caller.role === 'admin' ? null : caller.owner, status: status || null, limit: n });
  return { jobs: rows.map(j => gpuJobView(j, now)) };
}

export function cancelGpuJob(caller, id, now = Date.now()) {
  const own = ownJob(caller, id);
  if (!own.ok) return own;
  if (!q.cancel.run(now, own.job.id).changes) return err(409, `Job is already ${own.job.status}`);
  logger.info('GPU job cancelled', { id: own.job.id, by: caller.label });
  return { ok: true, job: gpuJobView(q.byId.get(own.job.id), now) };
}

/** Remove a finished job and its files (a job being computed must be cancelled first). */
export function deleteGpuJob(caller, id, now = Date.now()) {
  const own = ownJob(caller, id);
  if (!own.ok) return own;
  const j = own.job;
  if (j.status === 'pending' || (j.status === 'claimed' && j.lease_until >= now)) return err(409, 'Job is not finished: cancel it first');
  q.remove.run(j.id);
  removeFiles(j);
  return { ok: true, deleted: j.id };
}

/**
 * What can be asked now: types and models (with their parameters), which workers offer them, whether one can
 * start right now (online, in its time window, not paused, not busy) or when the next window opens.
 */
export function gpuCapabilities(now = Date.now()) {
  purgeGpu(now);
  const catalog = gpuCatalog();
  const { workers } = listWorkers(now);
  const busy = new Map(q.heldAll.all(now).map(r => [r.worker, r.type]));
  const machines = workers.filter(w => w.has_token).map(w => {
    const doing = heldReuseJob(w.name, now) ? 'reuse' : (busy.get(w.name) || null);
    return {
      name: w.name, online: w.online, in_window: w.in_window, paused: w.paused, busy: doing,
      types: typesOf(w.info), ...(w.info.gpu_state ? { gpu_state: w.info.gpu_state } : {}),
      ...(w.info.device ? { device: w.info.device } : {}),
      next_window_start: w.next_window_start, next_window_end: w.next_window_end,
      ready_now: w.online && w.in_window && !w.paused && !doing
    };
  });
  const waiting = {};
  for (const r of q.counts.all()) waiting[r.type] = (waiting[r.type] || 0) + r.n;
  const types = {};
  for (const [type, spec] of Object.entries(catalog.types)) {
    const offer = machines.filter(m => m.types.includes(type));
    const starts = offer.filter(m => m.online && !m.paused).map(m => (m.in_window ? now : Date.parse(m.next_window_start || '') || null)).filter(Boolean);
    types[type] = {
      label: spec.label, experimental: Boolean(spec.experimental), prompt: spec.prompt || 'required', input_image: spec.input || 'none',
      output: spec.output, default_model: spec.default_model,
      models: Object.entries(spec.models || {}).map(([id, m]) => ({
        id, label: m.label, license: m.license, source: m.source, ...(m.notes ? { notes: m.notes } : {}), params: m.params || {},
        ...(m.references ? { references: { max: m.references.max, max_bytes: m.references.max_bytes, formats: m.references.formats } } : {}),
        ...(m.engine ? { offered_by: offeredBy(type, workers, id) } : {})
      })),
      offered_by: offer.map(m => m.name), ready_now: offer.some(m => m.ready_now), waiting_jobs: waiting[type] || 0,
      next_start_at: starts.length ? new Date(Math.max(now, Math.min(...starts))).toISOString() : null
    };
  }
  return {
    types, workers: machines,
    limits: {
      max_input_bytes: config.gpuMaxInputSize, max_waiting_per_caller: config.gpuMaxWaitingPerOwner,
      results_kept_hours: Math.round(config.gpuRetentionMs / 3600000), pending_expires_hours: Math.round(config.gpuPendingMs / 3600000)
    }
  };
}

// ---------------------------------------------------------------------------
// Worker side (claimed through POST /api/reuse/next: see reuse.js claimJob)
// ---------------------------------------------------------------------------
/** Hooks for claimJob: the GPU job this worker holds, then a new one of a type it announced (caps). */
export function gpuClaimHooks(name, caps, modelCaps = '') {
  const types = new Set((Array.isArray(caps) ? caps : typesOf({ gpu: caps })));
  const models = new Set(Array.isArray(modelCaps) ? modelCaps : modelsOf({ gpu_models: modelCaps }));
  return {
    held(now) {
      const mine = q.held.get(name, now);
      if (!mine) return null;
      // A machine that no longer announces this type (worker rolled back to a version without GPU jobs, "gpu":
      // false, 3D switched off) would take the job for a RE-USE one: it is given back to the queue instead.
      if (!canRun(types, models, mine.type, mine.model)) {
        recordFailure(mine, name, `no longer offers "${mine.type}" (${mine.model})`, now);
        return null;
      }
      q.renew.run(now + config.gpuLeaseMs, null, null, mine.id);
      return { gpu: q.byId.get(mine.id) };
    },
    next(now) {
      if (!types.size || !gpuCatalog()) return null;
      for (const j of q.candidates.all(now)) {
        if (!canRun(types, models, j.type, j.model)) continue;
        if (j.attempts >= config.gpuMaxAttempts) {
          q.fail.run('failed', j.error || `${j.worker || '?'}: lease expired without result`, now, j.id);
          logger.error('GPU job failed permanently', { id: j.id, attempts: j.attempts, worker: j.worker });
          continue;
        }
        q.claim.run(name, now, now + config.gpuLeaseMs, j.id);
        return { gpu: q.byId.get(j.id) };
      }
      return null;
    }
  };
}

export function gpuClaimView(j) {
  const p = parse(j.params);
  return {
    kind: j.type, id: j.id, model: j.model, attempt: j.attempts, prompt: p.prompt || '', params: p.values || {},
    ...(j.in_sha256 ? { input: { sha256: j.in_sha256, size: j.in_size, format: j.in_ext } } : {}),
    ...(j.refs ? { references: refsOf(j).map((r, n) => ({ n, sha256: r.sha256, size: r.size, format: r.ext })) } : {}),
    lease_s: Math.round(config.gpuLeaseMs / 1000)
  };
}

function heldBy(id, name) {
  const j = q.byId.get(Number(id));
  if (!j) return err(404, 'Unknown job');
  if (j.status !== 'claimed' || j.worker !== name) return err(409, `Job is ${j.status}${j.worker && j.worker !== name ? ` (held by ${j.worker})` : ''}`);
  return { ok: true, job: j };
}

/** Input image: the worker holding the job, its owner, or admin. */
export function gpuInputFor(caller, id) {
  const r = caller.role === 'worker' ? heldBy(id, caller.name) : ownJob(caller, id);
  if (!r.ok) return r;
  const file = gpuInputPath(r.job);
  if (!file) return err(404, 'This job has no input image');
  return { ok: true, job: r.job, file };
}

/** Reference image n of a job: the worker holding it, its owner, or admin. */
export function gpuRefFor(caller, id, n) {
  const r = caller.role === 'worker' ? heldBy(id, caller.name) : ownJob(caller, id);
  if (!r.ok) return r;
  const refs = refsOf(r.job);
  const i = Number(n);
  if (!Number.isInteger(i) || i < 0 || i >= refs.length) return err(404, 'No such reference image');
  return { ok: true, job: r.job, file: refPath(r.job.id, i, refs[i].ext), ref: refs[i] };
}

/** Small flat object from a worker: lower-case keys, strings, numbers, booleans only. */
function cleanMeta(meta, max = 24) {
  const kept = {};
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [k, v] of Object.entries(meta).slice(0, max)) {
      if (/^[a-z_]{1,32}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) kept[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
  }
  return kept;
}

export function heartbeatGpu(id, name, { progress, stage, info, log, meta } = {}, now = Date.now()) {
  const r = heldBy(id, name);
  if (!r.ok) return r;
  noteReusePoll(name, info);
  if (Array.isArray(log) || (meta && typeof meta === 'object')) {
    const lines = (Array.isArray(log) ? log : []).filter(l => typeof l === 'string').slice(-100).map(l => l.slice(0, 300));
    q.engine.run(JSON.stringify({ ...cleanMeta(meta), log: lines }), r.job.id);
  }
  const p = Number(progress);
  q.renew.run(now + config.gpuLeaseMs, progress !== undefined && Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null,
    typeof stage === 'string' ? stage.slice(0, 80) : null, r.job.id);
  return { ok: true, lease_s: Math.round(config.gpuLeaseMs / 1000), orders: workerOrders(name) };
}

function recordFailure(j, name, reason, now) {
  const retry = j.attempts < config.gpuMaxAttempts;
  q.fail.run(retry ? 'pending' : 'failed', `${name}: ${String(reason).slice(0, 300)}`, retry ? null : now, j.id);
  if (retry) logger.warn('GPU job failed, will retry', { id: j.id, worker: name, error: reason });
  else logger.error('GPU job failed permanently', { id: j.id, worker: name, attempts: j.attempts, error: reason });
  return retry;
}

export function failGpu(id, name, { error } = {}, now = Date.now()) {
  const r = heldBy(id, name);
  if (!r.ok) return r;
  return { ok: true, retry: recordFailure(r.job, name, error || 'no reason given', now) };
}

/**
 * Result file of a held job. Refused (422, attempt counted) when it is not what was asked: an image must be a PNG
 * of the requested size, a 3D model a binary glTF 2.0 whose header matches its length.
 */
export function completeGpu(id, name, { data, sha256: announced, computeS, backend, meta } = {}, now = Date.now()) {
  const r = heldBy(id, name);
  if (!r.ok) return r;
  const j = r.job;
  if (!Buffer.isBuffer(data) || data.length === 0) return err(400, 'Empty body');
  const hash = sha256(data);
  if (!announced || String(announced).toLowerCase() !== hash) return err(400, 'X-Sha256 does not match the body');
  const want = gpuCatalog()?.types[j.type]?.output || (j.type === '3d' ? 'glb' : 'png');
  const values = parse(j.params).values || {};
  let problem = null, ext = want;
  if (want === 'png') {
    const size = pngSize(data);
    if (!size) problem = 'output is not a PNG image';
    else if (values.width && values.height && (size.width !== values.width || size.height !== values.height)) {
      problem = `output is ${size.width}x${size.height}, ${values.width}x${values.height} was asked`;
    }
  } else if (want === 'glb') {
    if (!isGlb(data)) problem = 'output is not a binary glTF 2.0 (GLB) file';
  } else problem = `catalog output "${want}" is not supported by the hub`;
  if (problem) return { ...err(422, problem), retry: recordFailure(j, name, problem, now) };
  if (q.stored.get().bytes + data.length > config.gpuMaxStorage) {
    return err(507, 'GPU storage is full on the hub: delete finished jobs (DELETE /api/gpu/jobs/:id)');
  }
  const kept = cleanMeta(meta);
  const seconds = Number(computeS);
  db.transaction(() => {
    writeAtomic(outPath(j.id, ext), data);
    q.done.run(hash, data.length, ext, JSON.stringify(kept), Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
      backend ? String(backend).slice(0, 60) : null, now, j.id);
  })();
  logger.info('GPU job done', { id: j.id, type: j.type, worker: name, computeS: seconds });
  return { ok: true, job: gpuJobView(q.byId.get(j.id), now) };
}

// ---------------------------------------------------------------------------
// Housekeeping: waiting too long = failed; finished jobs and their files removed after the retention delay;
// at startup, files no row accounts for are removed (same rule as the RE-USE folder).
// ---------------------------------------------------------------------------
let lastPurge = 0;
export function purgeGpu(now = Date.now(), force = false) {
  if (!force && now - lastPurge < 60 * 1000) return;
  lastPurge = now;
  for (const { id } of q.stale.all(now - config.gpuPendingMs)) {
    q.fail.run('failed', `no worker took the job within ${Math.round(config.gpuPendingMs / 3600000)} h`, now, id);
  }
  for (const { id } of q.expired.all(now - config.gpuRetentionMs)) {
    const j = q.byId.get(id);
    q.remove.run(id);
    if (j) removeFiles(j);
  }
}

export function sweepGpuStorage() {
  const rows = new Map(q.ids.all().map(r => [r.id, r.status]));
  let names = [];
  try { names = readdirSync(config.gpuDir); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const m = /^(\d+)\.(in|out|ref\d)\.[a-z]{2,4}(\.\d+\.tmp)?$/.exec(n);
    if (!m) continue;
    const status = rows.get(Number(m[1]));
    if (!m[3] && (m[2] !== 'out' ? status !== undefined : status === 'done')) continue;
    try { rmSync(path.join(config.gpuDir, n), { force: true }); removed++; } catch { /* next start */ }
  }
  if (removed) logger.warn('GPU storage: orphan files removed', { count: removed });
  for (const [id, status] of rows) {
    const j = q.byId.get(id);
    if ((status === 'pending' || status === 'claimed') && ((j.in_ext && !existsSync(gpuInputPath(j))) || gpuRefPaths(j).some(f => !existsSync(f)))) {
      q.fail.run('failed', 'input image is missing on the hub', Date.now(), id);
    }
  }
  return removed;
}

sweepGpuStorage();
