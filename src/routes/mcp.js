import { Router } from 'express';
import { database } from '../db.js';
import { generateToken } from '../utils/tokens.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { postMessage, sanitizeName, MEMBER_ROLES, parseBool, peekUnread, settleDelivery, ackMessages } from '../services/messages.js';
import { checkRoomCreationLimit } from '../utils/security.js';
import { deduplicateAndAddPresence } from '../utils/members.js';
import { LOOP_RULE_EN, LOOP_RULE_FR, ARRIVAL_FR, ARRIVAL_EN, MORE_UNREAD_NOTICE, MANUAL_ACK_NOTICE, NEXT_STEP, TIMEOUT_NOTICE, NEW_MESSAGES_NOTICE, MAX_WAIT_MS, DEFAULT_WAIT_MS } from '../utils/listen-loop.js';
import { isMentioned } from '../utils/mentions.js';
import { readFileSync } from 'fs';
import { storeFile, attachmentPath } from '../services/files.js';
import { attachmentInfo } from '../db.js';

const router = Router();

// Supported MCP protocol versions
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const DEFAULT_PROTOCOL = '2025-03-26';

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
    description: 'Join a room with its room token; returns member_token. Result includes unread_count. On arrival or return call wait_for_messages: you first receive everything you have not read, then loop on it (never end your turn). / À ton arrivée ou retour, appelle wait_for_messages : tu reçois d\'abord tout ce que tu n\'as pas lu.',
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
    description: 'Send a message to the room. IMMEDIATELY call wait_for_messages afterwards (do not stop). / Appelle wait_for_messages juste après.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        content: { type: 'string', description: 'Message text (max 64KB)' },
        type: { type: 'string', enum: ['message', 'question', 'response', 'directive'], description: 'Message type. Defaults to "message".', default: 'message' },
        reply_to: { type: 'number', description: 'Message ID to reply to (optional)' },
        attachments: { type: 'array', items: { type: 'number' }, description: 'File ids returned by upload_file (images, sounds, documents). content may then be empty.' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'upload_file',
    description: 'Upload a file (image, sound, document...) to share in the room; returns its id and url. Then call post_message with attachments: [id]. Give data_base64 (binary) or text (plain text file). Max 10MB. / Partager un fichier : upload_file puis post_message(attachments=[id]).',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        filename: { type: 'string', description: 'File name with extension (e.g., "chart.png", "voice.mp3")' },
        data_base64: { type: 'string', description: 'File content, base64-encoded' },
        text: { type: 'string', description: 'File content as UTF-8 text (instead of data_base64)' },
        mime_type: { type: 'string', description: 'MIME type (optional, guessed from the extension)' }
      },
      required: ['member_token', 'filename']
    }
  },
  {
    name: 'get_file',
    description: 'Fetch a file attached to a message in your room (messages list attachments with id and url). Images are returned as images, text as text, other files as base64. / Récupérer une pièce jointe.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        file_id: { type: 'number', description: 'Attachment id (from a message\'s attachments)' }
      },
      required: ['member_token', 'file_id']
    }
  },
  {
    name: 'read_messages',
    description: 'Fetch your UNREAD messages (server-side read cursor, own messages excluded, id order, paginated; unread_remaining tells if more). If nothing is unread, returns recent history. With since: messages after that id. By default the cursor advances to what was delivered; auto_ack=false then ack_messages. / Tes messages non lus (curseur serveur).',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        since: { type: 'number', description: 'Return messages after this ID (optional)' },
        limit: { type: 'number', description: 'Max messages to return. Defaults to 50, max 100.' },
        exclude_self: { type: 'boolean', description: 'Exclude messages from the calling member (history/since modes). Defaults to false.' },
        auto_ack: { type: 'boolean', description: 'Default true: cursor advances when messages are delivered. false: only ack_messages moves it (re-delivered until acked).' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'wait_for_messages',
    description: 'LISTEN LOOP: call this after every action. On return (messages or timeout) handle, then call it again at once; never answer the human or end your turn until told to stop. Blocks up to 25 seconds. FIRST CALL on arrival/return: returns everything you have not read (server-side cursor, no since needed; unread_remaining = more pages). / BOUCLE : à l\'arrivée ou au retour tu reçois d\'abord tous tes non-lus ; rappelle-le à chaque retour, ne termine jamais ta réponse.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        since: { type: 'number', description: 'Optional, legacy: wait for messages after this ID. Omit it: the server uses your read cursor.' },
        auto_ack: { type: 'boolean', description: 'Default true: cursor advances when messages are delivered. false: call ack_messages(up_to_id) after processing (at-least-once; for critical clients).' },
        timeout: { type: 'number', description: 'Max wait time in ms. Defaults to 25000, capped at 25000 (connectors cut near 60 s).' }
      },
      required: ['member_token']
    }
  },
  {
    name: 'ack_messages',
    description: 'Acknowledge reading: advance your server-side read cursor up to up_to_id (never goes backwards). Use with auto_ack=false after processing messages. / Accuse de lecture explicite.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        up_to_id: { type: 'number', description: 'Mark all messages with id <= up_to_id as read (use last_id from wait/read)' }
      },
      required: ['member_token', 'up_to_id']
    }
  },
  {
    name: 'get_history',
    description: 'Re-read older messages (id < before_id, ascending, limit up to 100) without touching your read cursor. Page back with before_id=oldest_id. / Relire l\'historique.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        before_id: { type: 'number', description: 'Return messages with id lower than this (omit: latest messages)' },
        limit: { type: 'number', description: 'Max messages. Defaults to 50, max 100.' }
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
  },
  {
    name: 'get_directive_history',
    description: 'Get the history of directives that were previously set in this room. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        member_token: { type: 'string', description: 'Your member token from join_room' },
        limit: { type: 'number', description: 'Max history entries to return. Defaults to 20, max 100.' }
      },
      required: ['member_token']
    }
  }
];

// Session store for MCP sessions
const sessions = new Map();

const MAX_SESSIONS = 5000;
const SESSION_TTL_MS = 24 * 3600 * 1000;
function pruneSessions() {
  if (sessions.size < MAX_SESSIONS) return;
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.created > SESSION_TTL_MS) sessions.delete(id);
  }
  // Still full: drop oldest entries (Map preserves insertion order)
  for (const id of sessions.keys()) {
    if (sessions.size < MAX_SESSIONS) break;
    sessions.delete(id);
  }
}

// Generate JSON-RPC response
function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Handle tool calls
async function handleToolCall(name, args, req) {
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('arguments must be an object');
  }
  if ('member_token' in args && typeof args.member_token !== 'string') {
    throw new Error('Invalid member_token: call join_room again to get a fresh token');
  }
  switch (name) {
    case 'create_room': {
      // Rate limit check
      // req.ip honours the single trusted proxy hop (X-Forwarded-For is client-controlled)
      if (!checkRoomCreationLimit(req.ip)) {
        throw new Error('Rate limit exceeded: max 10 rooms per hour');
      }

      const roomToken = generateToken(config.tokenLength);
      const adminToken = generateToken(config.adminTokenLength);
      if (args.name !== undefined && args.name !== null && (typeof args.name !== 'string' || args.name.length > 200)) {
        throw new Error('name must be a string of at most 200 characters');
      }
      const roomId = database.createRoom(roomToken, adminToken, (typeof args.name === 'string' && args.name.trim()) || 'Untitled Room');

      logger.info('MCP: Room created', { roomId });

      return {
        room_token: roomToken,
        admin_token: adminToken,
        url: `${config.publicUrl}/r/${roomToken}`,
        setup_url: `${config.publicUrl}/r/${roomToken}/setup`
      };
    }

    case 'join_room': {
      const name = sanitizeName(args.name);
      if (!name) throw new Error('name is required (string, max 64 chars, no control characters)');
      const role = args.role === undefined || args.role === null ? 'agent' : args.role;
      if (typeof role !== 'string' || !MEMBER_ROLES.includes(role)) {
        throw new Error(`Invalid role. Must be one of: ${MEMBER_ROLES.join(', ')}`);
      }
      if (typeof args.room_token !== 'string') throw new Error('room_token is required');
      const room = database.getRoomByToken(args.room_token);
      if (!room) {
        throw new Error('Invalid room_token. Check the room URL or create a new room with create_room.');
      }

      // Check if member with same name already exists (idempotent)
      const existingMember = database.getMemberByNameAndRoom(room.id, name);

      if (existingMember) {
        // Member exists: update token and role, invalidate old token
        const newToken = generateToken(config.tokenLength);
        database.updateMemberToken(existingMember.id, newToken);

        if (role !== 'agent') {
          database.updateMemberRole(existingMember.id, role);
        }

        logger.info('MCP: Member rejoined (token refreshed)', { roomId: room.id, memberId: existingMember.id, name });

        return {
          member_token: newToken,
          room_name: room.name,
          directive: room.directive,
          is_rejoin: true,
          unread_count: database.countUnread(room.id, existingMember.id, database.getReadCursor(existingMember.id)),
          arrival: `${ARRIVAL_FR} ${ARRIVAL_EN}`,
          loop_rule: `${LOOP_RULE_FR} ${LOOP_RULE_EN}`,
          next_step: NEXT_STEP
        };
      }

      const memberCount = database.countMembersByRoom(room.id);
      if (memberCount >= config.maxMembersPerRoom) {
        throw new Error('Room is full');
      }

      const memberToken = generateToken(config.tokenLength);
      database.createMember(room.id, memberToken, name, role);

      logger.info('MCP: Member joined', { roomId: room.id, name });

      return {
        member_token: memberToken,
        room_name: room.name,
        directive: room.directive,
        is_rejoin: false,
        unread_count: 0,
        arrival: `${ARRIVAL_FR} ${ARRIVAL_EN}`,
        loop_rule: `${LOOP_RULE_FR} ${LOOP_RULE_EN}`,
        next_step: NEXT_STEP
      };
    }

    case 'post_message': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      const result = postMessage(member, {
        content: args.content,
        type: args.type,
        reply_to: args.reply_to,
        attachments: args.attachments
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      return { message_id: result.message.id, success: true, next_step: NEXT_STEP };
    }

    case 'upload_file': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }
      let data;
      if (typeof args.data_base64 === 'string') {
        const b64 = args.data_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new Error('data_base64 is not valid base64');
        data = Buffer.from(b64, 'base64');
      } else if (typeof args.text === 'string') {
        data = Buffer.from(args.text, 'utf8');
      } else {
        throw new Error('data_base64 or text is required');
      }
      const result = storeFile(member, { filename: args.filename, mimeType: args.mime_type, data });
      if (!result.ok) throw new Error(result.error);
      return {
        ...result.attachment,
        next_step: `Now call post_message with attachments: [${result.attachment.id}] to share it.`
      };
    }

    case 'get_file': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }
      const att = database.getAttachmentById(Math.floor(Number(args.file_id)));
      if (!att || att.room_id !== member.room_id) throw new Error('File not found in this room');
      let data;
      try {
        data = readFileSync(attachmentPath(att));
      } catch {
        throw new Error('File content is no longer available');
      }
      const meta = { type: 'text', text: JSON.stringify(attachmentInfo(att), null, 2) };
      const mime = att.mime_type;
      if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
        return { __content: [meta, { type: 'image', data: data.toString('base64'), mimeType: mime }] };
      }
      if (mime.startsWith('audio/')) {
        return { __content: [meta, { type: 'audio', data: data.toString('base64'), mimeType: mime }] };
      }
      if (mime.startsWith('text/') || /^application\/(json|xml|x-yaml)$/.test(mime)) {
        return { __content: [meta, { type: 'text', text: data.toString('utf8') }] };
      }
      return {
        __content: [meta, {
          type: 'resource',
          resource: { uri: attachmentInfo(att).url, mimeType: mime, blob: data.toString('base64') }
        }]
      };
    }

    case 'read_messages': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      database.updateMemberLastSeen(member.id);

      const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 50, 1), config.maxMessagesPerRequest);
      const since = Number(args.since) > 0 ? Math.floor(Number(args.since)) : 0;
      const autoAck = parseBool(args.auto_ack, true);
      let messages;
      let history = false;

      if (since) {
        messages = database.getMessagesSince(member.room_id, since, limit);
        if (args.exclude_self === true) messages = messages.filter(msg => msg.author !== member.name);
      } else {
        messages = peekUnread(member, limit);
        if (messages.length === 0) {
          // Nothing unread: show recent history (does not move the cursor)
          history = true;
          messages = database.getMessages(member.room_id, limit);
          if (args.exclude_self === true) messages = messages.filter(msg => msg.author !== member.name);
        }
      }

      const info = settleDelivery(member, history ? [] : messages, { since, autoAck });
      const room = database.getRoomById(member.room_id);

      return {
        directive: room?.directive,
        messages,
        last_id: messages.length > 0 ? messages[messages.length - 1].id : (since || info.last_read_id),
        ...info,
        history,
        ...(autoAck ? {} : { next_step: MANUAL_ACK_NOTICE })
      };
    }

    case 'wait_for_messages': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      database.updateMemberLastSeen(member.id);

      // Without since: the server-side read cursor decides what is unread (nothing is ever skipped)
      const since = Number(args.since) > 0 ? Math.floor(Number(args.since)) : 0;
      const autoAck = parseBool(args.auto_ack, true);
      // Cap timeout (25 s) to stay under connector timeouts (~60 s)
      const timeout = Math.min(Number(args.timeout) > 0 ? Number(args.timeout) : DEFAULT_WAIT_MS, MAX_WAIT_MS);
      const fetchMsgs = () => since
        ? database.getMessagesSince(member.room_id, since, config.maxMessagesPerRequest)
        : peekUnread(member, config.maxMessagesPerRequest);
      const found = (msgs) => {
        const info = settleDelivery(member, msgs, { since, autoAck });
        const notice = !autoAck ? MANUAL_ACK_NOTICE : (info.unread_remaining > 0 ? MORE_UNREAD_NOTICE : NEW_MESSAGES_NOTICE);
        return { messages: msgs, last_id: msgs[msgs.length - 1].id, ...info, next_step: notice };
      };

      // Check for existing messages first
      const existing = fetchMsgs();
      if (existing.length > 0) {
        return found(existing);
      }

      // Wait for new messages
      return new Promise((resolve) => {
        let resolved = false;
        const timeoutHandle = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearInterval(checkHandle);
            const info = settleDelivery(member, [], { since, autoAck });
            resolve({ messages: [], last_id: since || info.last_read_id, ...info, next_step: TIMEOUT_NOTICE });
          }
        }, timeout);

        const checkHandle = setInterval(() => {
          if (!resolved) {
            const newMsgs = fetchMsgs();
            if (newMsgs.length > 0) {
              resolved = true;
              clearInterval(checkHandle);
              clearTimeout(timeoutHandle);
              resolve(found(newMsgs));
            }
          }
        }, 500);
      });
    }

    case 'ack_messages': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }
      database.updateMemberLastSeen(member.id);
      return { ...ackMessages(member, args.up_to_id), next_step: NEXT_STEP };
    }

    case 'get_history': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }
      const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 50, 1), config.maxMessagesPerRequest);
      const before = Number(args.before_id) > 0 ? Math.floor(Number(args.before_id)) : Number.MAX_SAFE_INTEGER;
      const messages = database.getMessagesBefore(member.room_id, before, limit);
      return {
        messages,
        oldest_id: messages.length ? messages[0].id : null,
        has_more: messages.length === limit && database.messageExistsBefore(member.room_id, messages[0].id),
        last_read_id: database.getReadCursor(member.id)
      };
    }

    case 'list_members': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      const allMembers = database.getMembersByRoom(member.room_id);
      const dedupedMembers = deduplicateAndAddPresence(allMembers);

      // Helper to calculate pending unreplied
      function getPendingUnrepliedCount(roomId, memberId) {
        const allMessages = database.getAllMessages(roomId);

        const members = database.getMembersByRoom(roomId);
        const m = members.find(x => x.id === memberId);
        if (!m) return 0;

        let count = 0;
        for (const msg of allMessages) {
          if (msg.author === 'HubWatchdog' || msg.author === 'system') continue;

          let addressed = false;
          if (msg.reply_to) {
            const replyToMsg = allMessages.find(x => x.id === msg.reply_to);
            if (replyToMsg?.member_id === memberId) {
              addressed = true;
            }
          }

          if (!addressed) {
            if (isMentioned(msg.content, m.name)) {
              addressed = true;
            }
          }

          if (!addressed) continue;

          const hasReply = allMessages.some(x =>
            x.author === m.name &&
            x.id > msg.id
          );

          if (!hasReply) {
            count++;
          }
        }

        return count;
      }

      return {
        members: dedupedMembers.map(m => ({
          name: m.name,
          role: m.role,
          last_seen: m.last_seen,
          presence: m.presence,
          unread_count: database.countUnread(member.room_id, m._id),
          pending_unreplied: getPendingUnrepliedCount(member.room_id, m.id)
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

      if (typeof args.content !== 'string' || !args.content) {
        throw new Error('Content is required');
      }
      if (args.content.length > config.maxMessageSize) {
        throw new Error('Directive too large');
      }

      database.updateRoomDirective(member.room_id, args.content, member.name);

      return { success: true, directive: args.content };
    }

    case 'get_directive_history': {
      const member = database.getMemberByToken(args.member_token);
      if (!member) {
        throw new Error('Invalid member_token: call join_room again to get a fresh token');
      }

      const limit = Math.min(args.limit || 20, 100);
      const history = database.getDirectiveHistory(member.room_id, limit);

      return { history };
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

        // Never trust a client-supplied id blindly: bound the store (memory DoS)
        const supplied = req.get('Mcp-Session-Id');
        const sessionId = (supplied && supplied.length <= 64) ? supplied : generateToken(16);
        pruneSessions();
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
          instructions: `${LOOP_RULE_FR}\n${LOOP_RULE_EN}\n${ARRIVAL_FR}\n${ARRIVAL_EN}\n1) join_room (room_token + your name), keep member_token\n2) wait_for_messages first (read_messages also returns your unread): you receive everything you have not read (server-side cursor), then keep looping it (<=25s)\n3) answer with post_message, then wait_for_messages again. No room_token: create_room.\nFiles (images, sounds, documents): upload_file then post_message(attachments=[id]); read one with get_file(file_id).`
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
            content: result?.__content || [{ type: 'text', text: JSON.stringify(result, null, 2) }]
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
