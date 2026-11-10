import { database } from './db.js';
import { logger } from './utils/logger.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import dns from 'dns/promises';
import { isMentioned } from './utils/mentions.js';
import { isPrivateHost } from './utils/net.js';

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
 * SSRF guard at delivery time. Registration only inspects literal addresses (no DNS); a public
 * name can still resolve to a private address (DNS rebinding, *.localtest.me, a hostile zone).
 * A public hostname that resolves to a private / loopback / link-local address is refused.
 * Literal private hosts were accepted at registration only for requests from the hub host itself.
 * @returns {Promise<string|null>} error message, or null when the target is acceptable
 */
export async function checkWebhookAddress(url, lookup = (h) => dns.lookup(h, { all: true })) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'invalid URL'; }
  if (isPrivateHost(parsed.hostname)) return null; // literal private target, allowed at registration
  let addresses;
  try {
    addresses = await lookup(parsed.hostname);
  } catch (err) {
    return `DNS lookup failed: ${err.code || err.message}`;
  }
  const bad = addresses.find(a => isPrivateHost(a.address));
  if (bad) return `${parsed.hostname} resolves to a private address (${bad.address})`;
  return null;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Send notification to webhook target, retrying transient failures (network, 5xx, 429)
 * up to maxRetries extra attempts with a short exponential backoff (1 s, 2 s, 4 s...).
 * A 4xx other than 408/425/429 is final: the receiver refused the payload.
 */
async function notifyWebhook(url, payload, { maxRetries = 0, lookup, delay = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const addressError = await checkWebhookAddress(url, lookup);
  if (addressError) return { success: false, error: addressError, attempts: 0 };

  let lastError = 'unknown error';
  const attempts = Math.max(0, Math.min(10, Number(maxRetries) || 0)) + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'manual', // never follow redirects to internal addresses
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) return { success: true, attempts: attempt };
      lastError = `HTTP ${response.status}: ${response.statusText}`;
      if (!RETRYABLE_STATUS.has(response.status)) return { success: false, error: lastError, attempts: attempt };
    } catch (error) {
      lastError = error.name === 'TimeoutError' ? 'timeout after 10s' : error.message;
    }
    if (attempt < attempts) await delay(1000 * 2 ** (attempt - 1));
  }
  return { success: false, error: `${lastError} (after ${attempts} attempt${attempts > 1 ? 's' : ''})`, attempts };
}

/**
 * Write notification to file target
 */
function notifyFile(filePath, payload) {
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    const content = `# Wake Notification\n\n**Room**: ${payload.room_name} (${payload.room_id})\n**Message ID**: ${payload.message_id}\n**From**: ${payload.author}\n**Time**: ${new Date().toISOString()}\n\n${payload.content_excerpt}\n`;
    writeFileSync(filePath, content, 'utf8');

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** Deliver one notification to one member's target and record the outcome. */
async function deliver(member, wakeTarget, payload, messageId, deps) {
  let result;
  if (wakeTarget.target_type === 'webhook') {
    result = await notifyWebhook(wakeTarget.target_url, payload, { maxRetries: wakeTarget.max_retries, ...deps });
  } else if (wakeTarget.target_type === 'file') {
    const filePath = join(wakeTarget.target_path, `wake-${Date.now()}-msg${messageId}.md`);
    result = notifyFile(filePath, payload);
  } else {
    return;
  }

  if (result.success) {
    database.updateWakeTargetSuccess(member.id);
    logger.info('Wake notification sent', {
      memberId: member.id,
      memberName: member.name,
      messageId,
      targetType: wakeTarget.target_type,
      attempts: result.attempts
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

/**
 * Process a message for wake target notifications
 * Called when a message is created that mentions someone or replies to them.
 * Targets are notified concurrently: one slow or retrying webhook must not delay the others.
 * @param {object} [deps] test hooks: { lookup, delay }
 */
export async function processWakeTargets(roomId, messageId, messageAuthorId, messageAuthorName, messageContent, messageReplyTo, deps = {}) {
  try {
    const room = database.getRoomById(roomId);
    const members = database.getMembersByRoom(roomId);
    const deliveries = [];

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

      // Payload: enough for the receiver to know where to look, and to answer (the member already
      // holds the room token; the message excerpt is what the watchdog would quote)
      const payload = {
        room_id: roomId,
        room_name: room?.name ?? null,
        room_token: room?.token ?? null,
        message_id: messageId,
        author: messageAuthorName,
        reply_to: messageReplyTo ?? null,
        content_excerpt: messageContent.substring(0, 500)
      };

      deliveries.push(deliver(member, wakeTarget, payload, messageId, deps));
    }

    await Promise.all(deliveries);
  } catch (err) {
    logger.error('Error processing wake targets', { roomId, messageId, error: err.message });
  }
}
