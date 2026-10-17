import { Router } from 'express';
import { database } from '../db.js';
import { generateToken } from '../utils/tokens.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { notifyWaiters } from './api.js';
import { deduplicateAndAddPresence } from '../utils/members.js';

const router = Router();

// Supported MCP protocol versions
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const DEFAULT_PROTOCOL = '2025-03-26';

// Rate limiter for room creation via MCP (in-memory, per IP)
const mcpRoomRateLimitMap = new Map();

// Helper: Get client IP
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

// Helper: Check room creation rate limit
function checkRoomCreationLimit(ip) {
  const now = Date.now();
  const key = ip;
  let record = mcpRoomRateLimitMap.get(key);

  if (!record || now - record.resetTime > 3600000) {
    // Reset after 1 hour
    record = { count: 0, resetTime: now };
    mcpRoomRateLimitMap.set(key, record);
  }

  if (record.count >= config.maxRoomsPerHour) {
    return false; // Limit exceeded
  }

  record.count++;
  return true;
}

// MCP Tool definitions
const MCP_TOOLS = [
  {
    name: 'create_room',
    description: 'Create a new Agent Hub room for multi-agent collaboration. Returns room_token for sharing with other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Room name (e.g., "Task: summarize document")' }
      },
      required: []
    }
  },
  {
    name: 'join_room',
    description: 'Join an existing room using its token. Returns member_token for sending/receiving messages. Call this first after creating/getting a room token.',
    inputSchema: {
      type: 'object',
      properties: {
        room_token: { type: 'string', description: 'Room token (e.g., "abcdef1234567890")' },
        name: { type: 'string', description: 'Your display name (e.g., "ResearchAgent", "Claude-Code-1")' },
        role: { type: 'string', description: 'Your role: agent, human, or observer. Defaults to agent.', enum: ['agent', 'human', 'observer'] }
      },
      required: ['room_token', 'name']
    }
  },
  {
    name: 'post_message',
    description: 'Send a message to the room. Use after joining. Example: post "I found 3 relevant sources" with type "response".',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        content: { type: 'string', description: 'Message text (max 64KB)' },
        type: { type: 'string', enum: ['message', 'question', 'response', 'directive'], description: 'Message type. Defaults to "message".', default: 'message' },
        reply_to: { type: 'number', description: 'Message ID to reply to (optional)' }
      },
      required: ['member_token', 'content']
    }
  },
  {
    name: 'read_messages',
    description: 'Fetch messages from the room. Call once after joining, then use wait_for_messages in a loop.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        since: { type: 'number', description: 'Return messages after this ID (optional)' },
        limit: { type: 'number', description: 'Max messages to return. Defaults to 50, max 100.' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'wait_for_messages',
    description: 'Long-poll for new messages. Blocks up to timeout_ms and returns immediately when messages arrive. Loop this after calling read_messages. Timeout capped at 25 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        since: { type: 'number', description: 'Wait for messages after this ID' },
        timeout: { type: 'number', description: 'Max wait time in ms. Defaults to 20000, capped at 25000.' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'list_members',
    description: 'List all members currently in the room with their status.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'set_directive',
    description: 'Set a pinned directive (e.g., "Summarize in < 200 words") visible to all members.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        content: { type: 'string', description: 'Directive text' }
      },
      required: ['member_token', 'content']
    }
  },
  {
    name: 'leave_room',
    description: 'Leave the room and invalidate your member token.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' }
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
async function handleToolCall(name, args, req) {
  switch (name) {
    case 'create_room': {
      // Rate limit check
      const ip = getClientIp(req);
      if (!checkRoomCreationLimit(ip)) {
        throw new Error('Rate limit exceeded: max 10 rooms per hour');
      }

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
        throw new Error('Invalid room_token. Check the room URL or create a new room with create_room.');
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
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
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
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
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
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      database.updateMemberLastSeen(member.id);

      const since = args.since || database.getLastMessageId(member.room_id);
      // Cap timeout at 25 seconds to stay under client timeouts
      const timeout = Math.min(args.timeout || 20000, 25000);

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
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
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
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
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
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      database.deleteMember(member.id);

      return { success: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Handle a single JSON-RPC request
 */
async function handleJsonRpcRequest(req, requestBody) {
  const { id, method, params } = requestBody;

  try {
    switch (method) {
      case 'initialize': {
        // Negotiate protocol version
        const clientVersion = params?.protocolVersion;
        const negotiatedVersion = clientVersion && SUPPORTED_PROTOCOLS.includes(clientVersion)
          ? clientVersion
          : DEFAULT_PROTOCOL;

        const sessionId = req.get('Mcp-Session-Id') || generateToken(16);
        sessions.set(sessionId, { created: Date.now(), version: negotiatedVersion });

        req.mcpSessionId = sessionId;

        return jsonRpcResponse(id, {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'agent-hub',
            version: '1.0.0'
          },
          instructions: '1) call join_room with room_token + your name, keep member_token\n2) call read_messages then loop wait_for_messages (timeout<=25s)\n3) answer with post_message. If you have no room_token call create_room.'
        });
      }

      case 'ping':
        return jsonRpcResponse(id, {});

      case 'tools/list':
        return jsonRpcResponse(id, { tools: MCP_TOOLS });

      case 'tools/call': {
        const { name, arguments: args } = params || {};

        if (!name) {
          return jsonRpcError(id, -32602, 'Tool name required');
        }

        try {
          const result = await handleToolCall(name, args || {}, req);
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          });
        } catch (err) {
          logger.warn('MCP tool error', { tool: name, error: err.message });
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true
          });
        }
      }

      case 'resources/list':
        return jsonRpcResponse(id, { resources: [] });

      case 'resources/templates/list':
        return jsonRpcResponse(id, { resourceTemplates: [] });

      case 'prompts/list':
        return jsonRpcResponse(id, { prompts: [] });

      case 'logging/setLevel':
        return jsonRpcResponse(id, {});

      // Handle all notification methods (return 204 or nothing)
      default:
        if (method && method.startsWith('notifications/')) {
          return null; // Will be handled as 204
        }
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    logger.error('MCP error', { error: error.message });
    return jsonRpcError(id, -32603, 'Internal error');
  }
}

/**
 * POST /mcp - MCP Streamable HTTP endpoint
 */
router.post('/', async (req, res) => {
  const body = req.body;

  if (!body) {
    return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request'));
  }

  // Handle batch requests (array of requests)
  if (Array.isArray(body)) {
    const responses = [];

    for (const item of body) {
      if (!item || !item.jsonrpc) {
        responses.push(jsonRpcError(null, -32600, 'Invalid Request'));
        continue;
      }

      const response = await handleJsonRpcRequest(req, item);
      // Only include responses with an id (skip notifications)
      if (response !== null && item.id !== undefined) {
        // Set session header on first response
        if (req.mcpSessionId && !res.headersSent) {
          res.set('Mcp-Session-Id', req.mcpSessionId);
        }
        responses.push(response);
      }
    }

    // Return batch response
    if (responses.length === 0) {
      return res.status(204).end();
    }
    return res.json(responses);
  }

  // Single request
  if (!body.jsonrpc) {
    return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request'));
  }

  const response = await handleJsonRpcRequest(req, body);

  // Handle notification (no id): return 204
  if (body.id === undefined) {
    return res.status(204).end();
  }

  // Handle initialize or other responses that set session header
  if (req.mcpSessionId) {
    res.set('Mcp-Session-Id', req.mcpSessionId);
  }

  return res.json(response);
});

/**
 * GET /mcp - SSE stream for server notifications
 */
router.get('/', (req, res) => {
  // Check if client accepts text/event-stream
  const accept = req.get('Accept') || '';
  if (!accept.includes('text/event-stream')) {
    return res.status(405).json({
      error: 'Must accept text/event-stream',
      acceptableMediaTypes: ['text/event-stream']
    });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial ping
  res.write('event: ping\ndata: {}\n\n');

  // Keep-alive every 15 seconds
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

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
