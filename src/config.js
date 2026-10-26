// Configuration for Agent Hub
import path from 'path';

// Data directory: HUB_DATA_DIR (default ./data). DB_PATH, if set, overrides the db file only.
export const dataDir = process.env.HUB_DATA_DIR || './data';

export const config = {
  port: parseInt(process.env.PORT || '4030', 10),
  host: process.env.HOST || '0.0.0.0',

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
  transcribeLeaseMs: 5 * 60 * 1000,
  transcribeMaxAttempts: 3,
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

  // Watchdog
  unreplySeconds: parseInt(process.env.HUB_UNREPLY_SECONDS || '120', 10),
  watchdogIntervalMs: parseInt(process.env.HUB_WATCHDOG_INTERVAL_MS || '15000', 10),
  notifyWebhookFile: process.env.HUB_NOTIFY_WEBHOOK_FILE || null
};
