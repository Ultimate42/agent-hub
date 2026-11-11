// Configuration for Agent Hub
import crypto from 'crypto';
import path from 'path';

// Data directory: HUB_DATA_DIR (default ./data). DB_PATH, if set, overrides the db file only.
export const dataDir = process.env.HUB_DATA_DIR || './data';

/** "name:token,name2:token2" -> [{name, token}] (invalid entries ignored). */
export function parseWorkerTokens(raw) {
  return String(raw || '').split(',').map(e => e.trim()).filter(Boolean).map(e => {
    const i = e.indexOf(':');
    return { name: e.slice(0, i), token: e.slice(i + 1) };
  }).filter(w => /^[\w.-]{1,32}$/.test(w.name) && w.token.length >= 16);
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

/**
 * One RE-USE token as written in the environment -> {digest: Buffer(32)} or {problem: 'reason'}.
 * Either the token itself (16 characters or more) or its fingerprint "sha256:<64 hex>", so that a machine
 * can create its token locally and hand over the fingerprint only. Both end up as a digest: the hub
 * compares sha256(presented token) to it and never keeps a clear token. A reason never quotes the value.
 */
export function parseTokenSpec(value) {
  const v = String(value || '');
  if (/^sha256:/i.test(v)) {
    const hex = v.slice(7);
    if (!/^[0-9a-f]{64}$/i.test(hex)) return { problem: '"sha256:" must be followed by 64 hexadecimal characters' };
    return { digest: Buffer.from(hex, 'hex') };
  }
  if (v.length < 16) return { problem: 'token shorter than 16 characters' };
  // A bare fingerprint would make the fingerprint itself (which is public) the token
  if (/^[0-9a-f]{64}$/i.test(v)) return { digest: sha256(v), note: 'looks like a fingerprint without its "sha256:" prefix: it is used as a clear token' };
  return { digest: sha256(v) };
}

/**
 * HUB_REUSE_WORKER_TOKENS "name:token,name2:sha256:<64 hex>" -> {workers: [{name, digest}], problems: [text]}.
 * A refused entry is reported by its position, never by its content (a misplaced token must not reach a log).
 */
export function parseReuseWorkerTokens(raw) {
  const workers = [], problems = [];
  String(raw || '').split(',').map(e => e.trim()).forEach((e, n) => {
    if (!e) return;
    const where = `HUB_REUSE_WORKER_TOKENS entry ${n + 1}`;
    const i = e.indexOf(':');
    if (i < 0) return problems.push(`${where} ignored: expected name:token or name:sha256:<64 hex>`);
    const name = e.slice(0, i);
    if (!/^[\w.-]{1,32}$/.test(name)) return problems.push(`${where} ignored: the worker name must be 1 to 32 letters, digits, ".", "_" or "-"`);
    const spec = parseTokenSpec(e.slice(i + 1));
    if (spec.problem) return problems.push(`${where} ignored: ${spec.problem}`);
    if (spec.note) problems.push(`${where} ${spec.note}`);
    workers.push({ name, digest: spec.digest });
  });
  return { workers, problems };
}

/** HUB_REUSE_ADMIN_TOKEN (clear, or "sha256:<64 hex>") -> {digest: Buffer|null, problems: [text]}. */
export function parseReuseAdminToken(raw) {
  if (!raw) return { digest: null, problems: [] };
  const spec = parseTokenSpec(String(raw).trim());
  if (spec.problem) return { digest: null, problems: [`HUB_REUSE_ADMIN_TOKEN ignored: ${spec.problem}`] };
  return { digest: spec.digest, problems: spec.note ? [`HUB_REUSE_ADMIN_TOKEN ${spec.note}`] : [] };
}

/** "Member Name@roomId:worker,Other@12:worker2" -> [{member, roomId, name}] (worker name is after the last colon; invalid entries ignored). */
export function parseWorkerMembers(raw) {
  return String(raw || '').split(',').map(e => e.trim()).filter(e => e.includes(':')).map(e => {
    const i = e.lastIndexOf(':');
    // "Member@roomId:worker" : the member must belong to that room (a name alone can be taken in any room)
    const m = e.slice(0, i).trim().match(/^(.+)@(\d+)$/);
    return { member: m ? m[1].trim() : '', roomId: m ? Number(m[2]) : null, name: e.slice(i + 1).trim() };
  }).filter(w => w.member && w.roomId && /^[\w.-]{1,32}$/.test(w.name));
}

/** Positive integer from an env value, or the default (an unparseable value must not disable a cap). */
function positiveInt(value, dflt) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const reuseWorkers = parseReuseWorkerTokens(process.env.HUB_REUSE_WORKER_TOKENS);
const reuseAdmin = parseReuseAdminToken(process.env.HUB_REUSE_ADMIN_TOKEN);

export const config = {
  port: parseInt(process.env.PORT || '4030', 10),
  host: process.env.HOST || '0.0.0.0',
  // Proxies allowed to set X-Forwarded-For (Express "trust proxy" entries: 'loopback', CIDR, IP).
  // Anything else reaching the port directly must not be able to spoof the client IP.
  trustedProxies: (process.env.HUB_TRUSTED_PROXIES || 'loopback,172.18.0.0/16')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Concurrent GET /mcp SSE streams kept open (each holds a socket and a keep-alive timer)
  maxSseStreams: positiveInt(process.env.HUB_MAX_SSE_STREAMS, 500),

  // Public URL (for setup instructions)
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:4030',

  // Database
  dbPath: process.env.DB_PATH || path.join(dataDir, 'hub.db'),

  // Shared files (images, audio, documents): stored on disk next to the db unless HUB_UPLOADS_DIR is set
  uploadsDir: process.env.HUB_UPLOADS_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(dataDir, 'hub.db')), 'uploads'),
  maxFileSize: parseInt(process.env.HUB_MAX_FILE_SIZE || String(10 * 1024 * 1024), 10), // 10MB
  maxRoomStorage: parseInt(process.env.HUB_MAX_ROOM_STORAGE || String(200 * 1024 * 1024), 10), // 200MB
  maxAttachmentsPerMessage: 10,
  // Uploaded files never attached to a message are deleted after this delay
  // Voice transcription by an external worker (scripts/transcribe-worker.mjs); disabled when unset
  transcribeToken: process.env.HUB_TRANSCRIBE_TOKEN || null,
  // One token per worker machine ("dev-box:token,vps:token"), revocable one by one; the legacy token above stays valid
  transcribeWorkerTokens: parseWorkerTokens(process.env.HUB_TRANSCRIBE_WORKER_TOKENS),
  // Room members allowed to act as a worker with their own member token: "Member:worker,..."
  transcribeWorkerMembers: parseWorkerMembers(process.env.HUB_TRANSCRIBE_WORKER_MEMBERS),
  transcribeLeaseMs: 5 * 60 * 1000,
  transcribeMaxAttempts: 3,
  // RE-USE cleaning queue (src/services/reuse.js, worker program in reuse-worker/); disabled when both are unset.
  // Admin = whoever submits audio and reads results (the manager); one token per worker machine, revocable one by one.
  // Tokens are kept as SHA-256 digests only: clear "name:token" or fingerprint "name:sha256:<64 hex>" (see parseTokenSpec)
  reuseAdminDigest: reuseAdmin.digest,
  reuseWorkerTokens: reuseWorkers.workers, // [{name, digest}]
  reuseTokenProblems: [...reuseAdmin.problems, ...reuseWorkers.problems], // logged at startup, values never quoted
  reuseDir: process.env.HUB_REUSE_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(dataDir, 'hub.db')), 'reuse'),
  reuseWorkerDir: process.env.HUB_REUSE_WORKER_DIR || null, // default: <repo>/reuse-worker
  reusePythonBaseUrl: process.env.HUB_REUSE_PYTHON_BASE_URL || 'https://www.python.org/ftp/python', // origin of the portable Python zip (tests)
  reuseMaxFileSize: positiveInt(process.env.HUB_REUSE_MAX_FILE_SIZE, 32 * 1024 * 1024), // held in memory: 5 min of FLAC is under 10 MB
  reuseMaxStorage: positiveInt(process.env.HUB_REUSE_MAX_STORAGE, 6 * 1024 * 1024 * 1024), // sources + results kept on disk
  // A worker renews its lease with a heartbeat every minute while it computes; silent for this long = job handed to another
  reuseLeaseMs: positiveInt(process.env.HUB_REUSE_LEASE_SECONDS, 600) * 1000,
  reuseMaxAttempts: 3,
  reuseMinRate: 24000, // cleaned audio is never accepted under 24 kHz
  // Rooms are deleted after this many days without messages (0 = never); agents can change it
  // per room (set_retention). A warning is posted retentionWarnMs before deletion.
  retentionDefaultDays: parseFloat(process.env.HUB_RETENTION_DEFAULT_DAYS ?? '7'),
  retentionWarnMs: 24 * 3600 * 1000,
  pendingFileTtlMs: parseFloat(process.env.HUB_PENDING_FILE_TTL_HOURS || '24') * 3600 * 1000,

  // Security
  tokenLength: 22,      // ~132 bits
  adminTokenLength: 32, // ~192 bits

  // Limits
  maxMessageSize: 64 * 1024, // 64KB
  maxMessagesPerRequest: 100,
  maxMembersPerRoom: 50,
  maxRoomsPerHour: 10,
  rateLimitPerMinute: parseInt(process.env.HUB_RATE_LIMIT_PER_MINUTE || '60', 10),
  longPollTimeout: 30000, // 30 seconds

  // CORS
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:4030'],

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Wake policy: after this many consecutive agent messages in a room with no human message (and no
  // mention of the member), 'all' wake-ups caused by agent messages are suspended
  wakeLoopLimit: Math.max(1, parseInt(process.env.HUB_WAKE_LOOP_LIMIT || '6', 10) || 6),

  // Watchdog
  unreplySeconds: parseInt(process.env.HUB_UNREPLY_SECONDS || '120', 10),
  watchdogIntervalMs: parseInt(process.env.HUB_WATCHDOG_INTERVAL_MS || '15000', 10),
  // Never alert about a message older than this (seconds, default 24 h; 0 = no limit): no flood of
  // alerts about history after a restart
  watchdogMaxAgeSeconds: Math.max(0, parseInt(process.env.HUB_WATCHDOG_MAX_AGE || '86400', 10) || 0),
  // Members never alerted about (comma-separated names, case-insensitive), e.g. humans
  watchdogIgnore: (process.env.HUB_WATCHDOG_IGNORE || '')
    .split(',').map(n => n.trim().toLowerCase()).filter(Boolean),
  notifyWebhookFile: process.env.HUB_NOTIFY_WEBHOOK_FILE || null
};
