// Configuration for Agent Hub
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
  // Members never alerted about (comma-separated names, case-insensitive), e.g. humans
  watchdogIgnore: (process.env.HUB_WATCHDOG_IGNORE || '')
    .split(',').map(n => n.trim().toLowerCase()).filter(Boolean),
  notifyWebhookFile: process.env.HUB_NOTIFY_WEBHOOK_FILE || null
};
