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
  notifyWebhookFile: process.env.HUB_NOTIFY_WEBHOOK_FILE || null,

  // Web Push (app). Keys: env, else generated once into <db dir>/vapid.json (mode 600).
  vapidPublicKey: process.env.HUB_VAPID_PUBLIC_KEY || null,
  vapidPrivateKey: process.env.HUB_VAPID_PRIVATE_KEY || null,
  vapidSubject: process.env.HUB_VAPID_SUBJECT || null, // mailto: or https: URL; defaults to PUBLIC_URL
  pushPreview: process.env.HUB_PUSH_PREVIEW === '1',   // include a text excerpt in notifications
  // Extra push service origins allowed besides the browser vendors' (self-hosted services, tests)
  pushExtraOrigins: (process.env.HUB_PUSH_EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
};
