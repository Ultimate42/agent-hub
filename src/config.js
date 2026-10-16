// Configuration for Agent Hub

export const config = {
  port: parseInt(process.env.PORT || '4030', 10),
  host: process.env.HOST || '0.0.0.0',

  // Public URL (for setup instructions)
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:4030',

  // Database
  dbPath: process.env.DB_PATH || './data/hub.db',

  // Security
  tokenLength: 22,      // ~132 bits
  adminTokenLength: 32, // ~192 bits

  // Limits
  maxMessageSize: 64 * 1024, // 64KB
  maxMessagesPerRequest: 100,
  maxMembersPerRoom: 50,
  maxRoomsPerHour: 10,
  rateLimitPerMinute: 60,
  longPollTimeout: 30000, // 30 seconds

  // CORS
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:4030'],

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info'
};
