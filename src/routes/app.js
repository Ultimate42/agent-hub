import express, { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { database } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { postMessage, ackMessages } from '../services/messages.js';
import {
  APP_COOKIE, APP_SESSION_MAX_AGE_S, createAppSession, getAppSession, deleteAppSession,
  addThread, getThreads, getThread, removeThread, readCookie, isSameOrigin
} from '../services/app-sessions.js';
import { getVapid, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe } from '../services/push.js';

// PWA "Appli" (docs/appli/PLAN.md, step 1): static client in /app, JSON API in /app/api.
// Auth = HttpOnly session cookie; the browser never sees member tokens after adding a thread.

const router = Router();
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');

// No inline script/style in the app: stricter CSP than the rest of the hub.
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self' wss: ws:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; form-action 'self'";

function isSecure(req) {
  return req.secure || config.publicUrl.startsWith('https://');
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${APP_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${APP_SESSION_MAX_AGE_S}`
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${APP_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function sessionFrom(req) {
  return getAppSession(readCookie(req.headers.cookie, APP_COOKIE));
}

function threadView(member) {
  const last = database.getMessages(member.room_id, 1)[0] || null;
  return {
    id: member.id,
    room_name: member.room_name || database.getRoomById(member.room_id)?.name || null,
    name: member.name,
    unread: database.countUnread(member.room_id, member.id),
    last_read_id: database.getReadCursor(member.id),
    last_message: last
  };
}

// --- API ---------------------------------------------------------------------

const api = Router();
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Cookie auth: reject cross-site writes; JSON-only bodies cannot be sent by a plain HTML form.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!isSameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused' });
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
});

// Add a thread (creates the session on first use). Body: { member_token }
api.post('/threads', (req, res) => {
  let sessionId = sessionFrom(req);
  let created = null;
  if (!sessionId) {
    created = createAppSession();
    sessionId = created.id;
  }
  const result = addThread(sessionId, (req.body || {}).member_token);
  if (!result.ok) {
    if (created) deleteAppSession(created.id);
    return res.status(result.status).json({ error: result.error });
  }
  if (created) setSessionCookie(req, res, created.token);
  logger.info('App thread added', { sessionId, memberId: result.member.id });
  res.status(201).json({ thread: threadView(result.member) });
});

// No session yet is not an error for the list: the app shows its onboarding
api.get('/threads', (req, res, next) => {
  if (sessionFrom(req)) return next();
  res.json({ threads: [] });
});

// Everything below needs a session
api.use((req, res, next) => {
  const sessionId = sessionFrom(req);
  if (!sessionId) return res.status(401).json({ error: 'No app session' });
  req.appSessionId = sessionId;
  next();
});

api.get('/threads', (req, res) => {
  res.json({ threads: getThreads(req.appSessionId).map(threadView) });
});

function requireThread(req, res) {
  const member = getThread(req.appSessionId, req.params.id);
  if (!member) {
    res.status(404).json({ error: 'Thread not found' });
    return null;
  }
  database.updateMemberLastSeen(member.id);
  return member;
}

api.delete('/threads/:id', (req, res) => {
  if (!removeThread(req.appSessionId, req.params.id)) return res.status(404).json({ error: 'Thread not found' });
  res.json({ removed: true });
});

// History, newest page first: ?before_id=N&limit=50. Never touches the read cursor.
api.get('/threads/:id/messages', (req, res) => {
  const member = requireThread(req, res);
  if (!member) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), config.maxMessagesPerRequest);
  const beforeId = parseInt(req.query.before_id, 10);
  const before = beforeId > 0 ? beforeId : Number.MAX_SAFE_INTEGER;
  const messages = database.getMessagesBefore(member.room_id, before, limit);
  res.json({
    messages,
    has_more: messages.length === limit && database.messageExistsBefore(member.room_id, messages[0].id),
    last_read_id: database.getReadCursor(member.id),
    me: member.name
  });
});

api.post('/threads/:id/messages', (req, res) => {
  const member = requireThread(req, res);
  if (!member) return;
  const { content, reply_to } = req.body || {};
  const result = postMessage(member, { content, type: 'message', reply_to });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // Writing in a thread means everything before was seen
  database.ackUpTo(member.id, result.message.id);
  res.status(201).json({ message: result.message });
});

api.post('/threads/:id/ack', (req, res) => {
  const member = requireThread(req, res);
  if (!member) return;
  try {
    res.json(ackMessages(member, (req.body || {}).up_to_id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Web Push (step 2) ---

api.get('/push/key', (req, res) => {
  try {
    res.json({ public_key: getVapid().publicKey });
  } catch (err) {
    logger.error('VAPID keys unavailable', { error: err.message });
    res.status(503).json({ error: 'Push is not available on this hub' });
  }
});

// Body: PushSubscription.toJSON() = { endpoint, keys: { p256dh, auth } }
api.post('/push/subscribe', (req, res) => {
  const result = pushSubscribe(req.appSessionId, req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ subscribed: true });
});

api.post('/push/unsubscribe', (req, res) => {
  res.json({ unsubscribed: pushUnsubscribe(req.appSessionId, (req.body || {}).endpoint) });
});

api.post('/logout', (req, res) => {
  deleteAppSession(req.appSessionId);
  clearSessionCookie(req, res);
  res.json({ logged_out: true });
});

api.use((req, res) => res.status(404).json({ error: 'Not found' }));

router.use('/app/api', api);

// --- Static client -------------------------------------------------------------

router.use('/app', (req, res, next) => {
  res.set('Content-Security-Policy', APP_CSP);
  // The service worker must be revalidated, otherwise app updates never reach installed clients.
  if (req.path === '/sw.js') res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/app/' });
  next();
}, express.static(appDir, { index: 'index.html', maxAge: 0 }));

export default router;
