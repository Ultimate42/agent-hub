import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { database } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { compareTokens } from '../utils/tokens.js';
import { generateVapidKeys, checkVapidKeys, sendPush } from './web-push.js';

// Web Push for the app (docs/appli/PLAN.md, step 2).
// A device subscribes inside an app session; when a message lands in one of the session's threads
// (written by someone else) and the session has no live app socket, every device of the session
// gets a minimal notification ("<room>: new message from <author>"). The text is read in the app.

// Browser vendors' push services. Anything else is refused (the hub POSTs to these URLs: no SSRF).
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const MAX_SUBSCRIPTIONS_PER_SESSION = 10;
const MAX_FAILURES = 5;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const db = database.db;
const stmts = {
  upsert: db.prepare(`INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET session_id = excluded.session_id, p256dh = excluded.p256dh,
      auth = excluded.auth, failures = 0, last_error = NULL`),
  countForSession: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE session_id = ? AND endpoint != ?'),
  deleteForSession: db.prepare('DELETE FROM push_subscriptions WHERE session_id = ? AND endpoint = ?'),
  deleteById: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
  fail: db.prepare('UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?'),
  ok: db.prepare('UPDATE push_subscriptions SET failures = 0, last_error = NULL WHERE id = ?'),
  dropFailing: db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?'),
  // Devices of the sessions that follow this room, with the member each session uses there
  recipients: db.prepare(`
    SELECT ps.id, ps.session_id, ps.endpoint, ps.p256dh, ps.auth,
           t.member_id, t.member_token_hash, m.token AS member_token, r.name AS room_name
    FROM push_subscriptions ps
    JOIN app_session_threads t ON t.session_id = ps.session_id
    JOIN members m ON m.id = t.member_id
    JOIN rooms r ON r.id = m.room_id
    WHERE m.room_id = ? AND m.id != ? AND m.role = 'human'`)
};

// --- VAPID keys ----------------------------------------------------------------

let vapid = null;

/** VAPID keys: env, else <db dir>/vapid.json, else generated and saved there (mode 600). */
export function getVapid() {
  if (vapid) return vapid;
  const subject = config.vapidSubject || (/^https:/.test(config.publicUrl) ? config.publicUrl : 'mailto:admin@localhost');
  let keys;
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    keys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  } else {
    const file = path.join(path.dirname(config.dbPath), 'vapid.json');
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      keys = generateVapidKeys();
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
      logger.info('Generated VAPID keys', { file });
    }
  }
  checkVapidKeys(keys);
  vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
  return vapid;
}

// --- Subscriptions ---------------------------------------------------------------

export function isAllowedEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (config.pushExtraOrigins.includes(url.origin)) return true;
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
}

/**
 * Save a PushSubscription.toJSON() for a session.
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function subscribe(sessionId, sub) {
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isAllowedEndpoint(endpoint)) {
    return { ok: false, status: 400, error: 'Unsupported push endpoint' };
  }
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
    return { ok: false, status: 400, error: 'Invalid subscription keys' };
  }
  if (stmts.countForSession.get(sessionId, endpoint).n >= MAX_SUBSCRIPTIONS_PER_SESSION) {
    return { ok: false, status: 429, error: `Too many devices (max ${MAX_SUBSCRIPTIONS_PER_SESSION})` };
  }
  stmts.upsert.run(sessionId, endpoint, p256dh, auth);
  return { ok: true };
}

export function unsubscribe(sessionId, endpoint) {
  return stmts.deleteForSession.run(sessionId, String(endpoint || '')).changes > 0;
}

// --- Dispatch ----------------------------------------------------------------------

// Registered by ws/handler.js: true while an app socket of the session is open (avoids a circular import)
let sessionIsLive = () => false;
export function setAppPresenceChecker(fn) {
  sessionIsLive = fn;
}

/**
 * Notify the app devices following a room about a new message. Never throws.
 * @param {number} roomId
 * @param {{id, content, author}} message
 * @param {number} authorMemberId
 */
export async function notifyPush(roomId, message, authorMemberId) {
  let rows;
  try {
    rows = stmts.recipients.all(roomId, authorMemberId);
  } catch (err) {
    logger.error('Push: recipients query failed', { error: err.message });
    return;
  }
  // Rotated member token = revoked thread; a session with an open app socket is notified in-app
  rows = rows.filter(r => compareTokens(r.member_token_hash, sha256(r.member_token)) && !sessionIsLive(r.session_id));
  if (rows.length === 0) return;

  let keys;
  try {
    keys = getVapid();
  } catch (err) {
    logger.error('Push: VAPID keys unavailable', { error: err.message });
    return;
  }

  await Promise.all(rows.map(async (r) => {
    const payload = JSON.stringify({
      title: r.room_name || 'Agent Hub',
      body: config.pushPreview
        ? `${message.author} : ${message.content}`.slice(0, 180)
        : `Nouveau message de ${message.author}`,
      thread: r.member_id,
      message_id: message.id
    });
    try {
      const status = await sendPush(r, payload, keys, { topic: `thread-${r.member_id}` });
      if (status === 404 || status === 410) {
        stmts.deleteById.run(r.id); // unsubscribed or expired on the device
      } else if (status >= 200 && status < 300) {
        stmts.ok.run(r.id);
      } else {
        throw new Error(`push service answered ${status}`);
      }
    } catch (err) {
      stmts.fail.run(String(err.message).slice(0, 200), r.id);
      stmts.dropFailing.run(r.id, MAX_FAILURES);
      logger.warn('Push delivery failed', { subscription: r.id, error: err.message });
    }
  }));
}
