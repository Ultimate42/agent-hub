import { Router } from 'express';
import { database } from '../db.js';
import { generateToken } from '../utils/tokens.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { notifyWaiters } from './api.js';
import { deduplicateAndAddPresence } from '../utils/members.js';

const router = Router();

// MCP Tool definitions
const MCP_TOOLS = [
  {
    name: 'create_room',
    description: 'Create a new Agent Hub room for multi-agent communication',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Room name' }
      }
    }
  },
  {
    name: 'join_room',
    description: 'Join an existing Agent Hub room',
    inputSchema: {
      type: 'object',
      properties: {
        room_token: { type: 'string', description: 'Room token from URL' },
        name: { type: 'string', description: 'Your display name' },
        role: { type: 'string', description: 'Your role (agent, human, observer)', default: 'agent' }
      },
      required: ['room_token', 'name']
    }
  },
  {
    name: 'post_message',
    description: 'Send a message to the room',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token' },
        content: { type: 'string', description: 'Message content' },
        type: { type: 'string', enum: ['message', 'question', 'response', 'directive'], default: 'message' },
        reply_to: { type: 'number', description: 'ID of message to reply to' }
      },
      required: ['member_token', 'content']
    }
  },
  {
    name: 'read_messages',
    description: 'Read messages from the room',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token' },
        since: { type: 'number', description: 'Get messages after this ID' },
        limit: { type: 'number', description: 'Max messages to return', default: 50 }
      },
      required: ['member_token']
    }
  },
  {
    name: 'wait_for_messages',
    description: 'Wait for new messages (long-poll). Blocks until new messages arrive or timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token' },
        since: { type: 'number', description: 'Wait for messages after this ID' },
        timeout: { type: 'number', description: 'Timeout in ms (max 30000)', default: 30000 }
      },
      required: ['member_token']
    }
  },
  {
    name: 'list_members',
    description: 'List all members in the room',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'set_directive',
    description: 'Set a pinned directive visible to all members',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token' },
        content: { type: 'string', description: 'Directive content' }
      },
      required: ['member_token', 'content']
    }
  },
  {
    name: 'leave_room',
    description: 'Leave the room',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token' }
      },
      required: ['member_token']
    }
  }
];

// Session store for MCP sessions
const sessions = new Map();

// Generate JSON-RPC response
function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Handle tool calls
async function handleToolCall(name, args) {
  switch (name) {
    case 'create_room': {
      const roomToken = generateToken(config.tokenLength);
      const adminToken = generateToken(config.adminTokenLength);
      const roomId = database.createRoom(roomToken, adminToken, args.name || 'Untitled Room');

      logger.info('MCP: Room created', { roomId });

      return {
        room_token: roomToken,
        admin_token: adminToken,
        url: `${config.publicUrl}/r/${roomToken}`,
        setup_url: `${config.publicUrl}/r/${roomToken}/setup`
      };
    }

    case 'join_room': {
      const room = database.getRoomByToken(args.room_token);
      if (!room) {
        throw new Error('Room not found');
      }

      // Check if member with same name already exists (idempotent)
      const existingMember = database.getMemberByNameAndRoom(room.id, args.name);

      if (existingMember) {
        // Member exists: update token and role, invalidate old token
        const newToken = generateToken(config.tokenLength);
        database.updateMemberToken(existingMember.id, newToken);

        if (args.role && args.role !== 'agent') {
          database.updateMemberRole(existingMember.id, args.role);
        }

        logger.info('MCP: Member rejoined (token refreshed)', { roomId: room.id, memberId: existingMember.id, name: args.name });

        return {
          member_token: newToken,
          room_name: room.name,
          directive: room.directive,
          is_rejoin: true
        };
      }

      const memberCount = database.countMembersByRoom(room.id);
      if (memberCount >= config.maxMembersPerRoom) {
        throw new Error('Room is full');
      }

      const memberToken = generateToken(config.tokenLength);
      database.createMember(room.id, memberToken, args.name, args.role || 'agent');

      logger.info('MCP: Member joined', { roomId: room.id, name: args.name });

      return {
        member_token: memberToken,
        room_name: room.name,
        directive: room.directive,
        is_rejoin: false
      };
    }

    case 'post_message': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member token');
      }

      if (!member.permissions.includes('w')) {
        throw new Error('Write permission required');
      }

      if (args.content.length > config.maxMessageSize) {
        throw new Error('Message too large');
      }

      const messageId = database.createMessage(
        member.room_id,
        member.id,
        args.type || 'message',
        args.content,
        args.reply_to
      );

      const newMessage = {
        id: messageId,
        type: args.type || 'message',
        content: args.content,
        author: member.name,
        created_at: new Date().toISOString()
      };

      notifyWaiters(member.room_id, [newMessage]);

      return { message_id: messageId, success: true };
    }

    case 'read_messages': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member token');
      }

      database.updateMemberLastSeen(member.id);

      const limit = Math.min(args.limit || 50, config.maxMessagesPerRequest);
      let messages;

      if (args.since) {
        messages = database.getMessagesSince(member.room_id, args.since, limit);
      } else {
        messages = database.getMessages(member.room_id, limit);
      }

      const room = database.getRoomById(member.room_id);

      return {
        directive: room?.directive,
        messages,
        last_id: messages.length > 0 ? messages[messages.length - 1].id : (args.since || 0)
      };
    }

    case 'wait_for_messages': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member token');
      }

      database.updateMemberLastSeen(member.id);

      const since = args.since || database.getLastMessageId(member.room_id);
      const timeout = Math.min(args.timeout || config.longPollTimeout, config.longPollTimeout);

      // Check for existing messages first
      const existing = database.getMessagesSince(member.room_id, since, config.maxMessagesPerRequest);
      if (existing.length > 0) {
        return { messages: existing };
      }

      // Wait for new messages
      return new Promise((resolve) => {
        const roomWaiters = new Map();
        const waiter = {
          resolve: (msgs) => resolve({ messages: msgs }),
          timeout: setTimeout(() => {
            resolve({ messages: [] });
          }, timeout)
        };

        // Store in a simple structure for MCP long-poll
        // Note: In production, this should be integrated with the API waiters
        const existingCheck = setInterval(() => {
          const newMsgs = database.getMessagesSince(member.room_id, since, config.maxMessagesPerRequest);
          if (newMsgs.length > 0) {
            clearInterval(existingCheck);
            clearTimeout(waiter.timeout);
            resolve({ messages: newMsgs });
          }
        }, 500);

        waiter.interval = existingCheck;

        setTimeout(() => {
          clearInterval(existingCheck);
        }, timeout);
      });
    }

    case 'list_members': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member token');
      }

      const allMembers = database.getMembersByRoom(member.room_id);
      const dedupedMembers = deduplicateAndAddPresence(allMembers);

      return {
        members: dedupedMembers.map(m => ({
          name: m.name,
          role: m.role,
          last_seen: m.last_seen,
          presence: m.presence
        }))
      };
    }

    case 'set_directive': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member token');
      }

      if (!member.permissions.includes('w')) {
        throw new Error('Write permission required');
      }

      database.updateRoomDirective(member.room_id, args.content);

      return { success: true, directive: args.content };
    }

    case 'leave_room': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member token');
      }

      database.deleteMember(member.id);

      return { success: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * POST /mcp - MCP Streamable HTTP endpoint
 */
router.post('/', async (req, res) => {
  const body = req.body;

  if (!body || !body.jsonrpc) {
    return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request'));
  }

  const { id, method, params } = body;

  try {
    switch (method) {
      case 'initialize':
        // Get or create session
        const sessionId = req.get('Mcp-Session-Id') || generateToken(16);
        sessions.set(sessionId, { created: Date.now() });

        res.set('Mcp-Session-Id', sessionId);
        return res.json(jsonRpcResponse(id, {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'agent-hub',
            version: '1.0.0'
          }
        }));

      case 'tools/list':
        return res.json(jsonRpcResponse(id, { tools: MCP_TOOLS }));

      case 'tools/call':
        const { name, arguments: args } = params || {};

        if (!name) {
          return res.json(jsonRpcError(id, -32602, 'Tool name required'));
        }

        try {
          const result = await handleToolCall(name, args || {});
          return res.json(jsonRpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }));
        } catch (err) {
          logger.warn('MCP tool error', { tool: name, error: err.message });
          return res.json(jsonRpcResponse(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true
          }));
        }

      case 'notifications/initialized':
        // Client is ready, acknowledge
        return res.status(204).end();

      default:
        return res.json(jsonRpcError(id, -32601, `Method not found: ${method}`));
    }
  } catch (error) {
    logger.error('MCP error', { error: error.message });
    return res.json(jsonRpcError(id, -32603, 'Internal error'));
  }
});

/**
 * GET /mcp - SSE stream for server notifications
 */
router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial ping
  res.write('event: ping\ndata: {}\n\n');

  // Keep alive
  const keepAlive = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/**
 * DELETE /mcp - End session
 */
router.delete('/', (req, res) => {
  const sessionId = req.get('Mcp-Session-Id');
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.status(204).end();
});

export default router;
