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

  -- Files shared in a room (bytes on disk under config.uploadsDir/<room_id>/<token>).
  -- message_id is NULL until the uploader attaches the file to a message.
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    token TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_room ON attachments(room_id);
  CREATE INDEX IF NOT EXISTS idx_wake_notifications_member_msg ON wake_notifications(member_id, message_id);
`);

// Migration (idempotent, no data loss): server-side read cursor per member (a member belongs to one room).
// Existing members start at the current last message id of their room: clients that kept their own
// since_id keep working, and nothing already delivered is replayed as "unread".
const memberCols = db.prepare('PRAGMA table_info(members)').all().map(c => c.name);
if (!memberCols.includes('last_read_id')) {
  db.transaction(() => {
    db.exec('ALTER TABLE members ADD COLUMN last_read_id INTEGER');
    db.exec(`UPDATE members SET last_read_id =
      COALESCE((SELECT MAX(id) FROM messages WHERE messages.room_id = members.room_id), 0)`);
  })();
}

// Migration: message edit / soft delete, and emoji reactions
const messageCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!messageCols.includes('edited_at')) {
  db.exec(`
    ALTER TABLE messages ADD COLUMN edited_at DATETIME;
    ALTER TABLE messages ADD COLUMN deleted_at DATETIME;
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, member_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
`);

// Migration: transcription state of audio attachments (filled by an external worker)
const attachmentCols = db.prepare('PRAGMA table_info(attachments)').all().map(c => c.name);
if (!attachmentCols.includes('transcript_status')) {
  db.exec(`
    ALTER TABLE attachments ADD COLUMN transcript TEXT;
    ALTER TABLE attachments ADD COLUMN transcript_status TEXT;
    ALTER TABLE attachments ADD COLUMN transcript_claimed_at INTEGER;
    ALTER TABLE attachments ADD COLUMN transcript_attempts INTEGER DEFAULT 0;
  `);
}

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
    INSERT INTO members (room_id, token, name, role, permissions, last_read_id)
    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(id) FROM messages WHERE room_id = ?), 0))
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
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ?
    ORDER BY m.id DESC
    LIMIT ?
  `),
  getMessagesSince: db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ? AND m.id > ?
    ORDER BY m.id ASC
    LIMIT ?
  `),
  getUnread: db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ? AND m.id > ? AND m.member_id IS NOT ?
    ORDER BY m.id ASC
    LIMIT ?
  `),
  countUnread: db.prepare(`
    SELECT COUNT(*) as n FROM messages WHERE room_id = ? AND id > ? AND member_id IS NOT ?
  `),
  getMessagesBefore: db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ? AND m.id < ?
    ORDER BY m.id DESC
    LIMIT ?
  `),
  getReadCursor: db.prepare(`SELECT COALESCE(last_read_id, 0) as c FROM members WHERE id = ?`),
  // Monotonic: the cursor never moves backwards, never beyond the room's last message.
  ackCursor: db.prepare(`
    UPDATE members SET last_read_id = MAX(COALESCE(last_read_id, 0),
      MIN(?, COALESCE((SELECT MAX(id) FROM messages WHERE room_id = members.room_id), 0)))
    WHERE id = ?
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

  // Attachments
  createAttachment: db.prepare(`
    INSERT INTO attachments (room_id, member_id, token, filename, mime_type, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getAttachmentByToken: db.prepare(`
    SELECT * FROM attachments WHERE token = ?
  `),
  getMessageFull: db.prepare(`
    SELECT m.id, m.room_id, m.member_id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.id = ?
  `),
  editMessage: db.prepare(`
    UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL
  `),
  softDeleteMessage: db.prepare(`
    UPDATE messages SET content = '', deleted_at = CURRENT_TIMESTAMP WHERE id = ?
  `),
  getAttachmentsByMessage: db.prepare(`
    SELECT * FROM attachments WHERE message_id = ?
  `),
  addReaction: db.prepare(`
    INSERT OR IGNORE INTO reactions (message_id, member_id, emoji) VALUES (?, ?, ?)
  `),
  removeReaction: db.prepare(`
    DELETE FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?
  `),
  getReactions: db.prepare(`
    SELECT r.emoji, mem.name FROM reactions r LEFT JOIN members mem ON mem.id = r.member_id
    WHERE r.message_id = ? ORDER BY r.id
  `),
  searchMessages: db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
           mem.name as author, mem.role as author_role
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ? AND m.deleted_at IS NULL
      AND (m.content LIKE ? ESCAPE '\\' OR mem.name LIKE ? ESCAPE '\\'
           OR m.id IN (SELECT message_id FROM attachments WHERE room_id = ? AND message_id IS NOT NULL
                       AND (filename LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\')))
    ORDER BY m.id DESC
    LIMIT ?
  `),
  getAttachmentById: db.prepare(`
    SELECT * FROM attachments WHERE id = ?
  `),
  linkAttachment: db.prepare(`
    UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL
  `),
  getMessageAttachments: db.prepare(`
    SELECT * FROM attachments WHERE message_id = ? ORDER BY id
  `),
  queueTranscription: db.prepare(`
    UPDATE attachments SET transcript_status = 'pending'
    WHERE id = ? AND mime_type LIKE 'audio/%' AND transcript_status IS NULL
  `),
  nextTranscription: db.prepare(`
    SELECT * FROM attachments
    WHERE transcript_status = 'pending' OR (transcript_status = 'claimed' AND transcript_claimed_at < ?)
    ORDER BY id LIMIT 1
  `),
  claimTranscription: db.prepare(`
    UPDATE attachments SET transcript_status = 'claimed', transcript_claimed_at = ?,
      transcript_attempts = COALESCE(transcript_attempts, 0) + 1
    WHERE id = ?
  `),
  setTranscriptionStatus: db.prepare(`
    UPDATE attachments SET transcript_status = ?, transcript = ? WHERE id = ?
  `),
  getStalePendingAttachments: db.prepare(`
    SELECT * FROM attachments WHERE message_id IS NULL AND created_at < datetime('now', ?)
  `),
  deleteAttachment: db.prepare(`
    DELETE FROM attachments WHERE id = ?
  `),
  roomStorageUsed: db.prepare(`
    SELECT COALESCE(SUM(size), 0) as n FROM attachments WHERE room_id = ?
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

/** Public shape of an attachment (the token-based URL is the download capability). */
export function attachmentInfo(a) {
  return {
    id: a.id,
    filename: a.filename,
    mime_type: a.mime_type,
    size: a.size,
    url: `${config.publicUrl}/files/${a.token}/${encodeURIComponent(a.filename)}`,
    ...(a.transcript_status ? { transcript_status: a.transcript_status } : {}),
    ...(a.transcript ? { transcript: a.transcript } : {})
  };
}

/** Group reaction rows ({emoji, name}) into [{emoji, count, members}] in first-use order. */
function groupReactions(rows) {
  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, { emoji: r.emoji, count: 0, members: [] });
    const g = byEmoji.get(r.emoji);
    g.count++;
    if (r.name) g.members.push(r.name);
  }
  return [...byEmoji.values()];
}

/**
 * Decorate a page of messages (one query per kind): `attachments`, `reactions`,
 * `edited_at` / `deleted: true` only when set (a deleted message has empty content).
 */
function withAttachments(messages) {
  for (const m of messages) {
    if (m.deleted_at) { m.deleted = true; m.content = ''; }
    if (!m.edited_at) delete m.edited_at;
    delete m.deleted_at;
  }
  const ids = messages.map(m => m.id).filter(Boolean);
  if (ids.length === 0) return messages;
  const placeholders = ids.map(() => '?').join(',');

  const rows = db.prepare(
    `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY id`
  ).all(...ids);
  const byMsg = new Map();
  for (const r of rows) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, []);
    byMsg.get(r.message_id).push(attachmentInfo(r));
  }

  const reactionRows = db.prepare(`
    SELECT r.message_id, r.emoji, mem.name FROM reactions r
    LEFT JOIN members mem ON mem.id = r.member_id
    WHERE r.message_id IN (${placeholders}) ORDER BY r.id
  `).all(...ids);
  const reactionsByMsg = new Map();
  for (const r of reactionRows) {
    if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
    reactionsByMsg.get(r.message_id).push(r);
  }

  for (const m of messages) {
    if (byMsg.has(m.id)) m.attachments = byMsg.get(m.id);
    if (reactionsByMsg.has(m.id)) m.reactions = groupReactions(reactionsByMsg.get(m.id));
  }
  return messages;
}

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
    const result = stmts.createMember.run(roomId, token, name, role, permissions, roomId);
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
    return withAttachments(stmts.getMessages.all(roomId, limit).reverse());
  },

  getMessagesSince(roomId, sinceId, limit = 100) {
    return withAttachments(stmts.getMessagesSince.all(roomId, sinceId, limit));
  },

  // --- Server-side read cursor (per member; a member belongs to a single room) ---
  getReadCursor(memberId) {
    return stmts.getReadCursor.get(memberId)?.c || 0;
  },

  getUnread(roomId, memberId, cursor, limit = 100) {
    return withAttachments(stmts.getUnread.all(roomId, cursor, memberId, limit));
  },

  countUnread(roomId, memberId, cursor = this.getReadCursor(memberId)) {
    return stmts.countUnread.get(roomId, cursor, memberId).n;
  },

  /** Advance the cursor to upToId (clamped to the room's last id). Never goes backwards. Returns new cursor. */
  ackUpTo(memberId, upToId) {
    stmts.ackCursor.run(upToId, memberId);
    return this.getReadCursor(memberId);
  },

  /** Older history (id < beforeId, newest first reversed to ascending). Does not touch any cursor. */
  getMessagesBefore(roomId, beforeId, limit = 50) {
    return withAttachments(stmts.getMessagesBefore.all(roomId, beforeId, limit).reverse());
  },

  messageExistsBefore(roomId, id) {
    return stmts.getMessagesBefore.all(roomId, id, 1).length > 0;
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
      SELECT m.id, m.type, m.content, m.reply_to, m.created_at, m.edited_at, m.deleted_at, mem.name as author, mem.id as member_id
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

  // Attachment operations
  createAttachment(roomId, memberId, token, filename, mimeType, size) {
    return Number(stmts.createAttachment.run(roomId, memberId, token, filename, mimeType, size).lastInsertRowid);
  },

  getAttachmentByToken(token) {
    return stmts.getAttachmentByToken.get(token);
  },

  getAttachmentById(id) {
    return stmts.getAttachmentById.get(id);
  },

  /** Link pending attachments to a message. Returns false if one was already linked. */
  linkAttachments(messageId, attachmentIds) {
    return db.transaction(() => {
      for (const id of attachmentIds) {
        if (stmts.linkAttachment.run(messageId, id).changes !== 1) throw new Error('attachment already used');
      }
      return true;
    })();
  },

  /** One message, decorated like lists (attachments, reactions, edited/deleted), with room_id/member_id. */
  getMessage(messageId) {
    const m = stmts.getMessageFull.get(messageId);
    return m ? withAttachments([m])[0] : undefined;
  },

  editMessage(messageId, content) {
    return stmts.editMessage.run(content, messageId).changes === 1;
  },

  /** Soft delete: the row stays (replies keep their parent), content and attachments go. Returns removed attachments. */
  deleteMessage(messageId) {
    return db.transaction(() => {
      const atts = stmts.getAttachmentsByMessage.all(messageId);
      for (const a of atts) stmts.deleteAttachment.run(a.id);
      stmts.softDeleteMessage.run(messageId);
      db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
      return atts;
    })();
  },

  /** Toggle a reaction; returns the message's grouped reactions. */
  toggleReaction(messageId, memberId, emoji) {
    if (stmts.addReaction.run(messageId, memberId, emoji).changes === 0) {
      stmts.removeReaction.run(messageId, memberId, emoji);
    }
    return groupReactions(stmts.getReactions.all(messageId));
  },

  /** Case-insensitive substring search (content, author, file names, transcripts), newest first. */
  searchMessages(roomId, query, limit = 50) {
    const like = '%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%';
    return withAttachments(stmts.searchMessages.all(roomId, like, like, roomId, like, like, limit));
  },

  getMessageAttachments(messageId) {
    return stmts.getMessageAttachments.all(messageId).map(attachmentInfo);
  },

  // Transcription queue (audio attachments, processed by an external worker)
  queueTranscription(attachmentId) {
    return stmts.queueTranscription.run(attachmentId).changes === 1;
  },

  /** Claim the next pending (or lease-expired) job. Jobs over maxAttempts are marked failed. */
  claimNextTranscription(leaseMs, maxAttempts) {
    return db.transaction(() => {
      const now = Date.now();
      for (;;) {
        const job = stmts.nextTranscription.get(now - leaseMs);
        if (!job) return null;
        if ((job.transcript_attempts || 0) >= maxAttempts) {
          stmts.setTranscriptionStatus.run('failed', null, job.id);
          continue;
        }
        stmts.claimTranscription.run(now, job.id);
        return stmts.getAttachmentById.get(job.id);
      }
    })();
  },

  setTranscriptionStatus(attachmentId, status, transcript = null) {
    stmts.setTranscriptionStatus.run(status, transcript, attachmentId);
  },

  /** Uploads never attached to a message, older than maxAgeMs. */
  getStalePendingAttachments(maxAgeMs) {
    return stmts.getStalePendingAttachments.all(`-${Math.floor(maxAgeMs / 1000)} seconds`);
  },

  deleteAttachment(id) {
    stmts.deleteAttachment.run(id);
  },

  getRoomStorageUsed(roomId) {
    return stmts.roomStorageUsed.get(roomId).n;
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
