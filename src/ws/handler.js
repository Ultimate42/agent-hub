import { WebSocketServer } from 'ws';
import { database } from '../db.js';
import { compareTokens, maskToken } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { postMessage, setWsBroadcaster } from '../services/messages.js';
import { checkRateLimit } from '../utils/security.js';
import { APP_COOKIE, getAppSession, getThreads, readCookie, isSameOrigin } from '../services/app-sessions.js';
import { setAppPresenceChecker } from '../services/push.js';

// Track connected clients by room
const roomClients = new Map(); // roomId -> Set<{ws, member}>
const appSockets = new Map(); // app sessionId -> Set<{visible}> (one entry per open app socket)

/**
 * Set up WebSocket server on existing HTTP server
 */
export function setupWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: config.maxMessageSize + 4096 // reject oversized frames before parsing
  });

  // Make REST / MCP / watchdog messages reach WebSocket clients too
  setWsBroadcaster((roomId, message) => broadcastToRoom(roomId, message));
  // A session with a visible app on screen sees messages live: no Web Push for it
  setAppPresenceChecker((sessionId) => [...(appSockets.get(sessionId) || [])].some(s => s.visible));

  wss.on('connection', (ws, req) => {
    // Extract token from query string
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      ws.close(4001, 'Bad request');
      return;
    }
    const token = url.searchParams.get('token');

    if (!token && url.searchParams.get('app') === '1') {
      handleAppConnection(ws, req);
      return;
    }

    if (!token) {
      ws.close(4001, 'Token required');
      return;
    }

    // Validate token
    const member = database.getMemberByToken(token);
    if (!member) {
      ws.close(4003, 'Invalid token');
      return;
    }

    // Update last seen
    database.updateMemberLastSeen(member.id);

    // Add to room clients
    if (!roomClients.has(member.room_id)) {
      roomClients.set(member.room_id, new Set());
    }
    const client = { ws, member, token, alive: true };
    ws.on('pong', () => { client.alive = true; });
    roomClients.get(member.room_id).add(client);

    logger.info('WebSocket connected', {
      roomId: member.room_id,
      memberName: member.name,
      token: maskToken(token)
    });

    // Notify others of join
    broadcastToRoom(member.room_id, {
      type: 'member_joined',
      name: member.name,
      role: member.role
    }, ws);

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(client, msg);
      } catch (err) {
        safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      const set = roomClients.get(member.room_id);
      set?.delete(client);
      if (set && set.size === 0) roomClients.delete(member.room_id);

      logger.info('WebSocket disconnected', {
        roomId: member.room_id,
        memberName: member.name
      });

      // Notify others of leave
      broadcastToRoom(member.room_id, {
        type: 'member_left',
        name: member.name
      });
    });

    // Handle errors
    ws.on('error', (err) => {
      logger.error('WebSocket error', { error: err.message });
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      room_name: database.getRoomById(member.room_id)?.name,
      your_name: member.name,
      unread_count: database.countUnread(member.room_id, member.id)
    }));
  });

  // Ping clients periodically; terminate the ones that never answered the last ping
  const pingTimer = setInterval(() => {
    for (const [roomId, clients] of roomClients.entries()) {
      for (const client of clients) {
        if (client.ws.readyState !== client.ws.OPEN || !client.alive || (client.app && !appClientValid(client))) {
          clients.delete(client);
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
      if (clients.size === 0) roomClients.delete(roomId);
    }
  }, 30000);
  pingTimer.unref();
  wss.on('close', () => clearInterval(pingTimer));

  logger.info('WebSocket server started');

  return wss;
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(client, msg) {
  const { ws } = client;

  // Re-validate on every frame: the token may have been rotated (rejoin) or the member removed
  const member = database.getMemberByToken(client.token);
  if (!member) {
    ws.close(4003, 'Invalid token');
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    safeSend(ws, { type: 'error', message: 'Invalid message' });
    return;
  }

  // Update last seen
  database.updateMemberLastSeen(member.id);

  switch (msg.type) {
    case 'message':
    case 'question':
    case 'response':
    case 'directive': {
      // Per-member flood control (same budget as REST)
      if (!checkRateLimit(`ws:${member.id}`, config.rateLimitPerMinute * 2).allowed) {
        safeSend(ws, { type: 'error', message: 'Too many messages, slow down' });
        return;
      }

      // postMessage validates, stores and broadcasts to WS + long-poll (sender included)
      const result = postMessage(member, {
        content: msg.content,
        type: msg.type,
        reply_to: msg.reply_to,
        applyDirective: true
      });
      if (!result.ok) {
        safeSend(ws, { type: 'error', message: result.error });
      }
      break;
    }

    case 'ping':
      safeSend(ws, { type: 'pong' });
      break;

    default:
      safeSend(ws, { type: 'error', message: 'Unknown message type' });
  }
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket closing */ }
  }
}

/**
 * Broadcast a message to all clients in a room
 */
function broadcastToRoom(roomId, message, excludeWs = null) {
  const clients = roomClients.get(roomId);
  if (!clients) return;

  const data = JSON.stringify(message);

  for (const client of clients) {
    if (client.ws !== excludeWs && client.ws.readyState === client.ws.OPEN) {
      // App clients get every room on one socket: tag each event with its thread (member id)
      const payload = client.app ? JSON.stringify({ ...message, thread: client.member.id }) : data;
      try { client.ws.send(payload); } catch { /* socket closing */ }
    }
  }
}

/**
 * App (PWA) connection: authenticated by the HttpOnly session cookie, subscribed to every thread
 * of the session. The app posts over REST: this socket only takes ping and visibility frames
 * (visibility decides between live delivery and Web Push). Presence is not announced to the room.
 */
function handleAppConnection(ws, req) {
  if (!isSameOrigin(req)) {
    ws.close(4003, 'Cross-origin refused');
    return;
  }
  const sessionId = getAppSession(readCookie(req.headers.cookie, APP_COOKIE));
  if (!sessionId) {
    ws.close(4001, 'No app session');
    return;
  }

  const clients = [];
  for (const member of getThreads(sessionId)) {
    database.updateMemberLastSeen(member.id);
    if (!roomClients.has(member.room_id)) roomClients.set(member.room_id, new Set());
    const client = { ws, member, token: member.token, alive: true, app: true, sessionId };
    roomClients.get(member.room_id).add(client);
    clients.push(client);
  }
  ws.on('pong', () => { for (const c of clients) c.alive = true; });

  // Visible until the app says otherwise (it reports document.visibilityState changes)
  const presence = { visible: true };
  if (!appSockets.has(sessionId)) appSockets.set(sessionId, new Set());
  appSockets.get(sessionId).add(presence);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { msg = null; }
    if (msg?.type === 'ping') safeSend(ws, { type: 'pong' });
    else if (msg?.type === 'visibility') presence.visible = msg.visible === true;
    else safeSend(ws, { type: 'error', message: 'App socket is receive-only; post over /app/api' });
  });

  ws.on('close', () => {
    const sockets = appSockets.get(sessionId);
    sockets?.delete(presence);
    if (sockets && sockets.size === 0) appSockets.delete(sessionId);
    for (const c of clients) {
      const set = roomClients.get(c.member.room_id);
      set?.delete(c);
      if (set && set.size === 0) roomClients.delete(c.member.room_id);
    }
  });
  ws.on('error', (err) => logger.error('WebSocket error', { error: err.message }));

  logger.info('App WebSocket connected', { sessionId, threads: clients.length });
  safeSend(ws, { type: 'connected', threads: clients.map(c => c.member.id) });
}

/** An app client stays subscribed only while its session exists and its member token was not rotated. */
function appClientValid(client) {
  try {
    return getThreads(client.sessionId).some(m => m.id === client.member.id && m.token === client.token);
  } catch {
    return false;
  }
}

/**
 * Get connected clients count for a room
 */
export function getConnectedCount(roomId) {
  return roomClients.get(roomId)?.size || 0;
}

/**
 * Broadcast a message to all clients in a room (public export)
 */
export function broadcast(roomId, message) {
  broadcastToRoom(roomId, message);
}
