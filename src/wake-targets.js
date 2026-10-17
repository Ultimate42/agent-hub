import { database } from './db.js';
import { logger } from './utils/logger.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { isMentioned } from './utils/mentions.js';

/**
 * Check if a message is addressed to a member
 * (a) content contains "@MemberName" (case-insensitive)
 * (b) reply_to points to member's message
 */
export function isMessageAddressedToMember(message, memberId, memberName) {
  // Case (b): reply_to points to this member's message
  if (message.reply_to) {
    // Need to fetch the replied-to message
    const replyToMsg = database.db.prepare(
      'SELECT member_id FROM messages WHERE id = ?'
    ).get(message.reply_to);
    if (replyToMsg?.member_id === memberId) {
      return true;
    }
  }

  // Case (a): content contains "@MemberName" (case-insensitive)
  if (isMentioned(message.content, memberName)) {
    return true;
  }

  return false;
}

/**
 * Send notification to webhook target
 */
async function notifyWebhook(url, payload) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual', // never follow redirects to internal addresses
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Write notification to file target
 */
function notifyFile(filePath, payload) {
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    const content = `# Wake Notification\n\n**Room**: ${payload.room_id}\n**Message ID**: ${payload.message_id}\n**From**: ${payload.author}\n**Time**: ${new Date().toISOString()}\n\n${payload.content_excerpt}\n`;
    writeFileSync(filePath, content, 'utf8');

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Process a message for wake target notifications
 * Called when a message is created that mentions someone or replies to them
 */
export async function processWakeTargets(roomId, messageId, messageAuthorId, messageAuthorName, messageContent, messageReplyTo) {
  try {
    // Get all members in the room
    const members = database.getMembersByRoom(roomId);

    // For each member, check:
    // 1. Do they have a wake target configured?
    // 2. Is the message addressed to them?
    // 3. Is the message NOT from them?
    // 4. Has this notification already been sent for this message/member pair?

    for (const member of members) {
      // Don't notify the author of the message
      if (member.id === messageAuthorId) {
        continue;
      }

      // Check if member has a wake target
      const wakeTarget = database.getWakeTarget(member.id);
      if (!wakeTarget) {
        continue;
      }

      // Check if notification already sent (idempotent)
      if (database.wakeNotificationExists(member.id, messageId)) {
        continue;
      }

      // Check if message is addressed to this member
      const isAddressed = isMessageAddressedToMember(
        { reply_to: messageReplyTo, content: messageContent },
        member.id,
        member.name
      );

      if (!isAddressed) {
        continue;
      }

      // Record notification (before sending to ensure idempotency)
      database.createWakeNotification(member.id, messageId);

      // Prepare payload
      const payload = {
        room_id: roomId,
        message_id: messageId,
        author: messageAuthorName,
        content_excerpt: messageContent.substring(0, 500)
      };

      // Send notification
      let result;
      if (wakeTarget.target_type === 'webhook') {
        result = await notifyWebhook(wakeTarget.target_url, payload);
      } else if (wakeTarget.target_type === 'file') {
        const timestamp = Date.now();
        const filePath = `${wakeTarget.target_path}/wake-${timestamp}-msg${messageId}.md`;
        result = notifyFile(filePath, payload);
      } else {
        continue;
      }

      if (result.success) {
        database.updateWakeTargetSuccess(member.id);
        logger.info('Wake notification sent', {
          memberId: member.id,
          memberName: member.name,
          messageId,
          targetType: wakeTarget.target_type
        });
      } else {
        database.updateWakeTargetError(member.id, result.error);
        logger.warn('Wake notification failed', {
          memberId: member.id,
          memberName: member.name,
          messageId,
          error: result.error
        });
      }
    }
  } catch (err) {
    logger.error('Error processing wake targets', { roomId, messageId, error: err.message });
  }
}
