import { database } from './db.js';
import { logger } from './utils/logger.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import dns from 'dns/promises';
import net from 'net';
import http from 'http';
import https from 'https';
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

const defaultLookup = (h) => dns.lookup(h, { all: true });

/**
 * SSRF guard at delivery time. Registration only inspects literal addresses (no DNS); a public
 * name can still resolve to a private address (DNS rebinding, *.localtest.me, a hostile zone).
 * The name is resolved once here and the vetted address is pinned for the request itself, so the
 * address that was checked is the address that is connected to.
 * allowPrivate: the target was registered from the hub host (file-like trust), private results are
 * accepted (a LAN service behind a DNS name).
 * @returns {Promise<{error: string}|{address: string, family: number}>}
 */
export async function resolveWebhookTarget(url, { lookup = defaultLookup, allowPrivate = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'invalid URL' }; }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  const literal = net.isIP(host);
  if (literal) {
    if (!allowPrivate && isPrivateHost(host)) return { error: `${host} is a private address` };
    return { address: host, family: literal };
  }

  let addresses;
  try {
    addresses = await lookup(host);
  } catch (err) {
    return { error: `DNS lookup failed: ${err.code || err.message}` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { error: `DNS lookup failed: no address for ${host}` };
  if (!allowPrivate) {
    const bad = addresses.find(a => isPrivateHost(a.address));
    if (bad) return { error: `${host} resolves to a private address (${bad.address})` };
  }
  const pick = addresses.find(a => a.family === 4) || addresses[0];
  return { address: pick.address, family: pick.family };
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BACKOFF_MS = 30000;

/**
 * POST a JSON body to the URL, connecting to the pinned address (the hostname is still used for
 * SNI and certificate validation). Redirects are not followed. Resolves {status, statusText}.
 */
function postJson(url, body, { address, family, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = mod.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      // Pin the vetted address: net.connect calls lookup(host, {all}, cb)
      lookup: (hostname, options, cb) => (options && options.all
        ? cb(null, [{ address, family }])
        : cb(null, address, family)),
      signal: AbortSignal.timeout(timeoutMs)
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '' }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Send notification to webhook target, retrying transient failures (network, 5xx, 429)
 * up to maxRetries extra attempts with an exponential backoff (1 s, 2 s, 4 s... capped at 30 s).
 * A 4xx other than 408/425/429 is final: the receiver refused the payload.
 * Worst case with max_retries 10: 11 attempts, about 3 min of backoff plus 11 x 10 s of timeouts.
 * @param {object} [deps] { lookup, delay, post, allowPrivate } (tests inject lookup/delay/post)
 */
export async function notifyWebhook(url, payload, { maxRetries = 0, allowPrivate = false, lookup, post = postJson, delay = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const target = await resolveWebhookTarget(url, { lookup, allowPrivate });
  if (target.error) return { success: false, error: target.error, attempts: 0 };

  let lastError = 'unknown error';
  const attempts = Math.max(0, Math.min(10, Number(maxRetries) || 0)) + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await post(url, payload, target);
      if (response.status >= 200 && response.status < 300) return { success: true, attempts: attempt };
      lastError = `HTTP ${response.status}: ${response.statusText}`;
      if (!RETRYABLE_STATUS.has(response.status)) return { success: false, error: lastError, attempts: attempt };
    } catch (error) {
      lastError = error.name === 'AbortError' || error.name === 'TimeoutError' ? `timeout after ${REQUEST_TIMEOUT_MS / 1000}s` : error.message;
    }
    if (attempt < attempts) await delay(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1)));
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

/** Deliver one notification to one member's target and record the outcome. Never throws. */
async function deliver(member, wakeTarget, payload, messageId) {
  try {
    let result;
    if (wakeTarget.target_type === 'webhook') {
      result = await notifyWebhook(wakeTarget.target_url, payload, {
        maxRetries: wakeTarget.max_retries,
        allowPrivate: wakeTarget.allow_private === 1
      });
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
  } catch (err) {
    logger.error('Wake delivery crashed', { memberId: member.id, messageId, error: err.message });
  }
}

// One delivery chain per member at a time. A notification is a wake signal, not the message
// itself: while a chain (with its retries) is in flight, newer notifications for the same member
// are coalesced into a single follow-up delivery carrying the latest message, so concurrent chains
// never overwrite each other's outcome and a dead target costs one bounded chain, not one per message.
const inflight = new Map(); // memberId -> { next, promise }

function scheduleDelivery(member, wakeTarget, payload, messageId) {
  const current = inflight.get(member.id);
  if (current) {
    if (current.next) {
      logger.debug('Wake notification coalesced', { memberId: member.id, messageId, replaced: current.next.messageId });
    }
    current.next = { wakeTarget, payload, messageId };
    return current.promise;
  }
  const entry = { next: null, promise: null };
  entry.promise = (async () => {
    let job = { wakeTarget, payload, messageId };
    while (job) {
      await deliver(member, job.wakeTarget, job.payload, job.messageId);
      job = entry.next;
      entry.next = null;
    }
    inflight.delete(member.id);
  })();
  inflight.set(member.id, entry);
  return entry.promise;
}

/** Members with a delivery chain in flight (for tests / diagnostics). */
export function inflightDeliveries() {
  return inflight.size;
}

/**
 * Process a message for wake target notifications
 * Called when a message is created that mentions someone or replies to them.
 * Targets are notified concurrently: one slow or retrying webhook must not delay the others.
 */
export async function processWakeTargets(roomId, messageId, messageAuthorId, messageAuthorName, messageContent, messageReplyTo) {
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

      // Payload: enough for the receiver to know where to look. No credential travels: the member
      // already holds its tokens, and a webhook endpoint is not a place to send a join capability.
      const payload = {
        room_id: roomId,
        room_name: room?.name ?? null,
        message_id: messageId,
        author: messageAuthorName,
        reply_to: messageReplyTo ?? null,
        content_excerpt: messageContent.substring(0, 500)
      };

      deliveries.push(scheduleDelivery(member, wakeTarget, payload, messageId));
    }

    await Promise.all(deliveries);
  } catch (err) {
    logger.error('Error processing wake targets', { roomId, messageId, error: err.message });
  }
}
