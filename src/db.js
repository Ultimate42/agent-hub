import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Ensure data directory exists
const dbDir = dirname(config.dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

// Initialize database
export const dbInstance = new Database(config.dbPath);
const db = dbInstance;
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Rooms table
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    admin_token TEXT NOT NULL,
    name TEXT,
    directive TEXT,
    settings TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Members table
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'agent',
    permissions TEXT DEFAULT 'rw',
    status TEXT DEFAULT 'normal',
    coordination_role TEXT,
    last_heartbeat INTEGER,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Messages table
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    type TEXT DEFAULT 'message',
    content TEXT NOT NULL,
    reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Coordination events table
  CREATE TABLE IF NOT EXISTS coordination_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    from_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    to_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Directive history table
  CREATE TABLE IF NOT EXISTS directive_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    author TEXT,
    replaced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Watchdog alerts table (tracks which message addressed-to which member has already been alerted)
  CREATE TABLE IF NOT EXISTS watchdog_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    to_member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    alert_posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, to_member_id)
  );

  -- Wake targets table: stores webhook or file targets for members
  CREATE TABLE IF NOT EXISTS wake_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('webhook', 'file')),
    target_url TEXT,
    target_path TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_error TEXT,
    last_notification_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id)
  );

  -- Wake notifications table: idempotent tracking of notifications sent
  CREATE TABLE IF NOT EXISTS wake_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    notification_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id, message_id)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_rooms_token ON rooms(token);
  CREATE INDEX IF NOT EXISTS idx_members_token ON members(token);
  CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_id);
  CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_coordination_events_room ON coordination_events(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_directive_history_room ON directive_history(room_id, replaced_at);
  CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_room ON watchdog_alerts(room_id);
  CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_msg_member ON watchdog_alerts(message_id, to_member_id);
  CREATE INDEX IF NOT EXISTS idx_wake_targets_member ON wake_targets(member_id);
  CREATE INDEX IF NOT EXISTS idx_wake_notifications_member_msg ON wake_notifications(member_id, message_id);
`);

logger.info('Database initialized', { path: config.dbPath });

// Prepared statements
const stmts = {
  // Rooms
  createRoom: db.prepare(`
    INSERT INTO rooms (token, admin_token, name, settings)
    VALUES (?, ?, ?, ?)
  `),
  getRoomByToken: db.prepare(`
    SELECT * FROM rooms WHERE token = ?
  `),
  getRoomById: db.prepare(`
    SELECT * FROM rooms WHERE id = ?
  `),
  updateRoomDirective: db.prepare(`
    UPDATE rooms SET directive = ? WHERE id = ?
  `),
  deleteRoom: db.prepare(`
    DELETE FROM rooms WHERE id = ?
  `),

  // Members
  createMember: db.prepare(`
    INSERT INTO members (room_id, token, name, role, permissions)
    VALUES (?, ?, ?, ?, ?)
  `),
  getMemberByToken: db.prepare(`
    SELECT m.*, r.token as room_token, r.id as room_id
    FROM members m
    JOIN rooms r ON m.room_id = r.id
    WHERE m.token = ?
  `),
  getMemberByNameAndRoom: db.prepare(`
    SELECT id, name, role, token, status, last_seen, created_at
    FROM members
    WHERE room_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))
    ORDER BY id DESC
    LIMIT 1
  `),
  getMembersByRoom: db.prepare(`
    SELECT id, name, role, permissions, status, coordination_role, last_heartbeat, last_seen, created_at
    FROM members WHERE room_id = ?
  `),
  updateMemberToken: db.prepare(`
    UPDATE members SET token = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?
  `),
  updateMemberRole: db.prepare(`
    UPDATE members SET role = ? WHERE id = ?
  `),
  updateMemberLastSeen: db.prepare(`
    UPDATE members SET last_seen = CURRENT_TIMESTAMP WHERE id = ?
  `),
  deleteMember: db.prepare(`
    DELETE FROM members WHERE id = ?
  `),
  countMembersByRoom: db.prepare(`
    SELECT COUNT(*) as count FROM members WHERE room_id = ?
  `),
  updateMemberStatus: db.prepare(`
    UPDATE members SET status = ? WHERE id = ?
  `),
  updateRoomSettings: db.prepare(`
    UPDATE rooms SET settings = ? WHERE id = ?
  `),

  // Messages
  createMessage: db.prepare(`
    INSERT INTO messages (room_id, member_id, type, content, reply_to)
    VALUES (?, ?, ?, ?, ?)
  `),
  getMessages: db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ?
    ORDER BY m.id DESC
    LIMIT ?
  `),
  getMessagesSince: db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ? AND m.id > ?
    ORDER BY m.id ASC
    LIMIT ?
  `),
  getLastMessageId: db.prepare(`
    SELECT MAX(id) as last_id FROM messages WHERE room_id = ?
  `),
  getMessageById: db.prepare(`
    SELECT id FROM messages WHERE id = ? AND room_id = ?
  `),

  // Coordination
  updateMemberHeartbeat: db.prepare(`
    UPDATE members SET last_heartbeat = ? WHERE id = ?
  `),
  updateMemberCoordinationRole: db.prepare(`
    UPDATE members SET coordination_role = ? WHERE id = ?
  `),
  getCoordinationMembers: db.prepare(`
    SELECT id, name, role, coordination_role, last_heartbeat, last_seen
    FROM members
    WHERE room_id = ? AND coordination_role IS NOT NULL
  `),
  createCoordinationEvent: db.prepare(`
    INSERT INTO coordination_events (room_id, event_type, from_member_id, to_member_id, reason)
    VALUES (?, ?, ?, ?, ?)
  `),
  getCoordinationEvents: db.prepare(`
    SELECT * FROM coordination_events
    WHERE room_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),

  // Directive history
  createDirectiveHistory: db.prepare(`
    INSERT INTO directive_history (room_id, content, author)
    VALUES (?, ?, ?)
  `),
  getDirectiveHistory: db.prepare(`
    SELECT id, room_id, content, author, replaced_at
    FROM directive_history
    WHERE room_id = ?
    ORDER BY id DESC
    LIMIT ?
  `),

  // Watchdog
  createWatchdogAlert: db.prepare(`
    INSERT INTO watchdog_alerts (room_id, message_id, to_member_id)
    VALUES (?, ?, ?)
  `),
  watchdogAlertExists: db.prepare(`
    SELECT 1 FROM watchdog_alerts WHERE message_id = ? AND to_member_id = ? LIMIT 1
  `),

  // Wake targets
  setWakeTarget: db.prepare(`
    INSERT OR REPLACE INTO wake_targets (member_id, target_type, target_url, target_path, max_retries)
    VALUES (?, ?, ?, ?, ?)
  `),
  getWakeTarget: db.prepare(`
    SELECT * FROM wake_targets WHERE member_id = ?
  `),
  deleteWakeTarget: db.prepare(`
    DELETE FROM wake_targets WHERE member_id = ?
  `),
  updateWakeTargetError: db.prepare(`
    UPDATE wake_targets SET last_error = ?, retry_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE member_id = ?
  `),
  updateWakeTargetSuccess: db.prepare(`
    UPDATE wake_targets SET last_error = NULL, retry_count = 0, last_notification_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE member_id = ?
  `),

  // Wake notifications
  createWakeNotification: db.prepare(`
    INSERT INTO wake_notifications (member_id, message_id)
    VALUES (?, ?)
  `),
  wakeNotificationExists: db.prepare(`
    SELECT 1 FROM wake_notifications WHERE member_id = ? AND message_id = ? LIMIT 1
  `)
};

// Database API
export const database = {
  // Expose db instance for raw queries (watchdog, etc)
  db: dbInstance,


  // Room operations
  createRoom(token, adminToken, name, settings = {}) {
    const result = stmts.createRoom.run(token, adminToken, name, JSON.stringify(settings));
    return result.lastInsertRowid;
  },

  getRoomByToken(token) {
    const room = stmts.getRoomByToken.get(token);
    if (room) {
      room.settings = JSON.parse(room.settings || '{}');
    }
    return room;
  },

  getRoomById(id) {
    const room = stmts.getRoomById.get(id);
    if (room) {
      room.settings = JSON.parse(room.settings || '{}');
    }
    return room;
  },

  updateRoomDirective(roomId, directive, author = null) {
    // Archive old directive before updating
    const room = stmts.getRoomById.get(roomId);
    if (room && room.directive) {
      stmts.createDirectiveHistory.run(roomId, room.directive, author);
    }
    stmts.updateRoomDirective.run(directive, roomId);
  },

  deleteRoom(roomId) {
    stmts.deleteRoom.run(roomId);
  },

  // Member operations
  createMember(roomId, token, name, role = 'agent', permissions = 'rw') {
    const result = stmts.createMember.run(roomId, token, name, role, permissions);
    return result.lastInsertRowid;
  },

  getMemberByToken(token) {
    return stmts.getMemberByToken.get(token);
  },

  getMemberByNameAndRoom(roomId, name) {
    return stmts.getMemberByNameAndRoom.get(roomId, name);
  },

  getMembersByRoom(roomId) {
    return stmts.getMembersByRoom.all(roomId);
  },

  updateMemberToken(memberId, token) {
    stmts.updateMemberToken.run(token, memberId);
  },

  updateMemberRole(memberId, role) {
    stmts.updateMemberRole.run(role, memberId);
  },

  updateMemberLastSeen(memberId) {
    stmts.updateMemberLastSeen.run(memberId);
  },

  deleteMember(memberId) {
    stmts.deleteMember.run(memberId);
  },

  countMembersByRoom(roomId) {
    return stmts.countMembersByRoom.get(roomId).count;
  },

  // Message operations
  createMessage(roomId, memberId, type, content, replyTo = null) {
    const result = stmts.createMessage.run(roomId, memberId, type, content, replyTo);
    return result.lastInsertRowid;
  },

  getMessages(roomId, limit = 50) {
    return stmts.getMessages.all(roomId, limit).reverse();
  },

  getMessagesSince(roomId, sinceId, limit = 100) {
    return stmts.getMessagesSince.all(roomId, sinceId, limit);
  },

  getLastMessageId(roomId) {
    const result = stmts.getLastMessageId.get(roomId);
    return result?.last_id || 0;
  },

  messageExistsInRoom(messageId, roomId) {
    return stmts.getMessageById.get(messageId, roomId) !== undefined;
  },

  // Secure mode operations
  updateMemberStatus(memberId, status) {
    stmts.updateMemberStatus.run(status, memberId);
  },

  updateRoomSettings(roomId, settings) {
    stmts.updateRoomSettings.run(JSON.stringify(settings), roomId);
  },

  // Coordination operations
  updateMemberHeartbeat(memberId, timestamp) {
    stmts.updateMemberHeartbeat.run(timestamp, memberId);
  },

  updateMemberCoordinationRole(memberId, role) {
    stmts.updateMemberCoordinationRole.run(role, memberId);
  },

  getCoordinationMembers(roomId) {
    return stmts.getCoordinationMembers.all(roomId);
  },

  createCoordinationEvent(roomId, eventType, fromMemberId, toMemberId, reason) {
    const result = stmts.createCoordinationEvent.run(roomId, eventType, fromMemberId, toMemberId, reason);
    return result.lastInsertRowid;
  },

  getCoordinationEvents(roomId, limit = 50) {
    return stmts.getCoordinationEvents.all(roomId, limit);
  },

  // Directive history operations
  createDirectiveHistory(roomId, content, author) {
    const result = stmts.createDirectiveHistory.run(roomId, content, author);
    return result.lastInsertRowid;
  },

  getDirectiveHistory(roomId, limit = 50) {
    return stmts.getDirectiveHistory.all(roomId, limit);
  },

  // Get all messages in a room (no limit)
  getAllMessages(roomId) {
    return db.prepare(`
      SELECT m.id, m.type, m.content, m.reply_to, m.created_at, mem.name as author, mem.id as member_id
      FROM messages m
      LEFT JOIN members mem ON m.member_id = mem.id
      WHERE m.room_id = ?
      ORDER BY m.id ASC
    `).all(roomId);
  },

  // Watchdog operations
  createWatchdogAlert(roomId, messageId, toMemberId) {
    try {
      const result = stmts.createWatchdogAlert.run(roomId, messageId, toMemberId);
      return result.lastInsertRowid;
    } catch (err) {
      // UNIQUE constraint violation means alert already exists, which is fine
      if (err.message?.includes('UNIQUE')) {
        return null;
      }
      throw err;
    }
  },

  watchdogAlertExists(messageId, toMemberId) {
    return stmts.watchdogAlertExists.get(messageId, toMemberId) !== undefined;
  },

  // Wake targets operations
  setWakeTarget(memberId, targetType, targetUrl = null, targetPath = null, maxRetries = 3) {
    try {
      const result = stmts.setWakeTarget.run(memberId, targetType, targetUrl, targetPath, maxRetries);
      return result.lastInsertRowid;
    } catch (err) {
      logger.error('Failed to set wake target', { memberId, targetType, error: err.message });
      throw err;
    }
  },

  getWakeTarget(memberId) {
    return stmts.getWakeTarget.get(memberId);
  },

  deleteWakeTarget(memberId) {
    stmts.deleteWakeTarget.run(memberId);
  },

  updateWakeTargetError(memberId, errorMessage) {
    stmts.updateWakeTargetError.run(errorMessage, memberId);
  },

  updateWakeTargetSuccess(memberId) {
    stmts.updateWakeTargetSuccess.run(memberId);
  },

  wakeNotificationExists(memberId, messageId) {
    return stmts.wakeNotificationExists.get(memberId, messageId) !== undefined;
  },

  createWakeNotification(memberId, messageId) {
    try {
      const result = stmts.createWakeNotification.run(memberId, messageId);
      return result.lastInsertRowid;
    } catch (err) {
      // UNIQUE constraint violation means notification already exists, which is fine
      if (err.message?.includes('UNIQUE')) {
        return null;
      }
      throw err;
    }
  },

  // Utility
  close() {
    db.close();
  }
};

export default database;
