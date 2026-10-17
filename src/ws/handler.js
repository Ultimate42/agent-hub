import { WebSocketServer } from 'ws';
import { database } from '../db.js';
import { compareTokens, maskToken } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { notifyWaiters } from '../routes/api.js';

// Track connected clients by room
const roomClients = new Map(); // roomId -> Set<{ws, member}>

/**
 * Set up WebSocket server on existing HTTP server
 */
export function setupWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws'
  });

  wss.on('connection', (ws, req) => {
    // Extract token from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

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
    const client = { ws, member };
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
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      roomClients.get(member.room_id)?.delete(client);

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
      your_name: member.name
    }));
  });

  // Ping clients periodically to keep connections alive
  setInterval(() => {
    for (const [roomId, clients] of roomClients.entries()) {
      for (const client of clients) {
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.ping();
        } else {
          clients.delete(client);
        }
      }
    }
  }, 30000);

  logger.info('WebSocket server started');

  return wss;
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(client, msg) {
  const { ws, member } = client;

  // Update last seen
  database.updateMemberLastSeen(member.id);

  switch (msg.type) {
    case 'message':
    case 'question':
    case 'response':
    case 'directive':
      if (!member.permissions.includes('w')) {
        ws.send(JSON.stringify({ type: 'error', message: 'Write permission required' }));
        return;
      }

      // Secure mode check
      const room = database.getRoomById(member.room_id);
      if (room?.settings?.secure_mode) {
        const allowedRoles = ['manager', 'second', 'agent'];
        const coordinationRole = member.coordination_role;

        if (!allowedRoles.includes(member.role) && !coordinationRole) {
          ws.send(JSON.stringify({ type: 'error', message: 'Secure mode: Only coordinators and agents can post messages' }));
          return;
        }
      }

      if (!msg.content) {
        ws.send(JSON.stringify({ type: 'error', message: 'Content required' }));
        return;
      }

      if (msg.content.length > config.maxMessageSize) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
        return;
      }

      // Validate reply_to if provided
      if (msg.reply_to && !database.messageExistsInRoom(msg.reply_to, member.room_id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'reply_to not found' }));
        return;
      }

      // Special handling for directive
      if (msg.type === 'directive') {
        database.updateRoomDirective(member.room_id, msg.content);
      }

      // Save message
      const messageId = database.createMessage(
        member.room_id,
        member.id,
        msg.type,
        msg.content,
        msg.reply_to
      );

      const newMessage = {
        id: messageId,
        type: msg.type,
        content: msg.content,
        author: member.name,
        author_role: member.role,
        reply_to: msg.reply_to,
        created_at: new Date().toISOString()
      };

      // Broadcast to room (including sender for confirmation)
      broadcastToRoom(member.room_id, newMessage);

      // Notify long-poll waiters
      notifyWaiters(member.room_id, [newMessage]);

      logger.debug('Message sent via WebSocket', {
        roomId: member.room_id,
        messageId,
        author: member.name
      });
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
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
      client.ws.send(data);
    }
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
