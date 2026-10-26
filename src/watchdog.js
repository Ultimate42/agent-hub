import { database } from './db.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { appendFileSync } from 'fs';
import { generateToken } from './utils/tokens.js';
import { publishMessage } from './services/messages.js';
import { isMentioned } from './utils/mentions.js';
import { parseDbTime } from './utils/time.js';

const LEGACY_WATCHDOG_TOKEN = 'system-watchdog-token';
export { parseDbTime };

let watchdogInterval = null;
let db = null;

// Prepare statements once on init
let stmt_getRooms = null;
let stmt_getMessagesByRoom = null;
let stmt_getReplyToAuthor = null;

/**
 * Initialize watchdog database access (call after database.js initializes)
 */
export function initWatchdogDb(dbInstance) {
  db = dbInstance;
  stmt_getRooms = db.prepare('SELECT id FROM rooms');
  stmt_getMessagesByRoom = db.prepare(`
    SELECT m.id, m.type, m.content, m.reply_to, m.created_at, mem.name as author, mem.id as member_id
    FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.room_id = ?
    ORDER BY m.created_at ASC
  `);
  stmt_getReplyToAuthor = db.prepare(`
    SELECT mem.id FROM messages m
    LEFT JOIN members mem ON m.member_id = mem.id
    WHERE m.id = ?
  `);
}

/**
 * Check if a message is addressed to a member
 * (a) type='question' and reply_to points to member's message
 * (b) content contains "@MemberName" (case-insensitive)
 * (c) reply_to points to member's message
 */
function isMessageAddressedToMember(message, memberId, memberName) {
  // Case (c): reply_to points to this member's message
  if (message.reply_to) {
    const replyToMsg = stmt_getReplyToAuthor.get(message.reply_to);
    if (replyToMsg?.id === memberId) {
      return true;
    }
  }

  // Case (a): type='question' and reply_to points to member's message
  if (message.type === 'question' && message.reply_to) {
    const replyToMsg = stmt_getReplyToAuthor.get(message.reply_to);
    if (replyToMsg?.id === memberId) {
      return true;
    }
  }

  // Case (b): content contains "@MemberName" (case-insensitive)
  if (isMentioned(message.content, memberName)) {
    return true;
  }

  return false;
}

/**
 * Get a member by name and room
 */
function getMemberInRoom(roomId, memberName) {
  return database.getMemberByNameAndRoom(roomId, memberName);
}

/**
 * Get or create HubWatchdog member in a room
 */
export function getOrCreateWatchdogMember(roomId) {
  const existing = database.getMemberByNameAndRoom(roomId, 'HubWatchdog');
  if (existing) {
    // Legacy rows used a constant, publicly guessable token (and a UNIQUE clash for
    // every room after the first): replace it with a random, never-disclosed one.
    if (existing.token === LEGACY_WATCHDOG_TOKEN) {
      database.updateMemberToken(existing.id, generateToken(32));
    }
    return existing.id;
  }

  // The watchdog never authenticates: give it a random token nobody receives
  const memberId = database.createMember(roomId, generateToken(32), 'HubWatchdog', 'observer', 'r');
  return memberId;
}

/**
 * Main watchdog check: look for unreplied addressed messages
 */
export function startWatchdog() {
  if (watchdogInterval) {
    logger.warn('Watchdog already running');
    return;
  }

  watchdogInterval = setInterval(async () => {
    try {
      if (!stmt_getRooms) return; // Not initialized yet

      // Get all rooms
      const rooms = stmt_getRooms.all();

      for (const room of rooms) {
        const roomId = room.id;

        // Ensure watchdog member exists
        const watchdogMemberId = getOrCreateWatchdogMember(roomId);

        // Get all members
        const members = database.getMembersByRoom(roomId);
        if (members.length === 0) continue;

        // Get all messages in room
        const messages = database.getAllMessages(roomId);
        if (messages.length === 0) continue;

        // For each message, check if it's addressed to someone and unresponded
        for (const msg of messages) {
          // Skip system and watchdog messages
          if (msg.author === 'HubWatchdog' || msg.author === 'system' || msg.author === 'Transcription') continue;
          if (!msg.member_id || msg.deleted_at) continue;

          // Check time elapsed
          const msgTime = parseDbTime(msg.created_at);
          if (Number.isNaN(msgTime)) continue; // never alert on an unparseable timestamp
          const nowTime = Date.now();
          const elapsedSeconds = (nowTime - msgTime) / 1000;

          if (elapsedSeconds < config.unreplySeconds) {
            continue; // Not old enough yet
          }

          // Check each member to see if this message is addressed to them
          for (const member of members) {
            if (member.id === msg.member_id) continue; // Don't check author
            if (config.watchdogIgnore.includes(member.name.trim().toLowerCase())) continue; // HUB_WATCHDOG_IGNORE

            if (!isMessageAddressedToMember(msg, member.id, member.name)) {
              continue; // Not addressed to this member
            }

            // Check if member has replied yet
            const hasReply = messages.some(m =>
              m.author === member.name &&
              m.id > msg.id
            );

            if (hasReply || database.hasReacted(msg.id, member.id)) {
              continue; // Already replied, or acknowledged with a reaction
            }

            // "May be asleep" only if the message never reached them: no alert when their read
            // cursor passed it or they polled the hub after it was posted (they are awake and got it)
            if ((member.last_read_id || 0) >= msg.id || parseDbTime(member.last_seen) > msgTime) {
              continue;
            }

            // Check if alert already exists
            // One alert per absence: if they were already reported and have not been seen since,
            // another alert says nothing new (it fired once per pending message before)
            const lastAlert = database.lastWatchdogAlertFor(member.id);
            if (lastAlert && !(parseDbTime(member.last_seen) > parseDbTime(lastAlert))) {
              continue;
            }

            if (database.watchdogAlertExists(msg.id, member.id)) {
              continue; // Alert already posted
            }

            // Post alert message
            const lastSeen = member.last_seen ? ` (last seen ${member.last_seen})` : '';
            const alertContent = `No reply from ${member.name} to message #${msg.id} after ${Math.floor(elapsedSeconds)}s${lastSeen}. ${msg.author}: ${member.name} may be asleep; the user has been alerted if the hub is configured with a notifier.`;

            // Create alert as HubWatchdog
            const alertMsgId = database.createMessage(
              roomId,
              watchdogMemberId,
              'message',
              alertContent,
              null
            );

            // Record the alert
            database.createWatchdogAlert(roomId, msg.id, member.id);

            // Push to WebSocket + long-poll clients as well
            publishMessage(roomId, {
              id: Number(alertMsgId),
              type: 'message',
              content: alertContent,
              author: 'HubWatchdog',
              author_role: 'observer',
              created_at: new Date().toISOString()
            });

            logger.info('Watchdog alert posted', {
              roomId,
              messageId: msg.id,
              toMember: member.name,
              alertMsgId
            });

            // Write to webhook file if configured
            if (config.notifyWebhookFile) {
              try {
                const line = JSON.stringify({
                  ts: new Date().toISOString(),
                  room: roomId,
                  to: member.name,
                  from: msg.author,
                  message_id: msg.id
                });
                appendFileSync(config.notifyWebhookFile, line + '\n');
              } catch (err) {
                logger.warn('Failed to write webhook file', { error: err.message });
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error('Watchdog error', { error: err.message, stack: err.stack });
    }
  }, config.watchdogIntervalMs);

  logger.info('Watchdog started', {
    interval: config.watchdogIntervalMs,
    unreplySeconds: config.unreplySeconds
  });
}

/**
 * Stop watchdog cleanly
 */
export function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    logger.info('Watchdog stopped');
  }
}
