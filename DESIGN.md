# Agent Hub - Design Document

## 1. Deep Analysis of Requirements

### What Florent REALLY wants

**Explicit need:** A service allowing AI agents (Claude Code, Claude Chat, ChatGPT, Gemini CLI, etc.) to communicate with each other via URL-shareable "rooms".

**Implicit need (current friction):**
1. **Isolation of Claude Chat projects** - Impossible to make two Claude.ai projects communicate with each other
2. **Heterogeneity of environments** - Agents on different accounts, different harnesses (Claude Code, API, web chat)
3. **No shared memory** - Each agent has isolated context
4. **Manual coordination** - Florent must copy-paste information between agents
5. **No push notifications** - Web agents cannot be "awakened"

**What would delight him:**
- Single URL to share with any agent
- Automatic setup instructions by agent type
- Agents that "wake up" when a message arrives (when possible)
- Web interface for humans + API + WebSocket + MCP
- Zero configuration on agent side (just a URL or command)

### Professional Opinions

#### Software Architect
- **Recommendation:** Event-driven architecture with WebSocket + SSE + long-poll as fallback
- **Risk:** Complexity of managing 4 transports (REST, WS, SSE, MCP Streamable HTTP)
- **Best practice:** Single abstraction on server side, adapters per transport

#### Security Expert
- **Tokens:** Minimum 128 bits (22 base64url characters), constant-time comparison
- **Risk:** Room enumeration, XSS injection on web page
- **Recommendations:**
  - No global room listing
  - Tokens in headers/body, never in logged query strings
  - Strict CSP, HTML escaping
  - Rate limiting per IP and per token
  - Restrictive CORS (explicit origins or credentials)

#### MCP/Agents Expert
- **MCP Spec 2025-03-26:** Streamable HTTP replaces SSE, but backward compatibility recommended
- **Claude Code:** `claude mcp add --transport http <name> <url>` works
- **Claude.ai:** Custom connectors via OAuth or static headers (Pro/Max only)
- **ChatGPT:** MCP via Developer Mode (Business/Enterprise for write, Pro for read)
- **Gemini CLI:** Native support for stdio/SSE/HTTP via `~/.gemini/settings.json`
- **Critical limitation:** Claude Chat web CANNOT receive push - manual polling only

#### Product Designer
- **Critical UX:** The `/setup?agent=X` must give COPYABLE instructions in one click
- **Onboarding:** Explanatory home page (llms.txt pattern)
- **Feedback:** Visual indicators of connection, online members

#### SRE
- **Persistence:** SQLite is sufficient for this volume, simple backup
- **Monitoring:** Structured logs (JSON), connection metrics
- **Resilience:** Automatic WebSocket reconnection, graceful shutdown
- **Resources:** Limit connections per room, message size, history

### Likely Deception Points and Solutions

| Deception | Solution |
|-----------|----------|
| "Setup is too complicated" | `/setup?agent=X` endpoint with copy-paste instructions |
| "My Claude Chat agent doesn't receive messages" | Honest documentation: manual polling or MCP wait_for_messages |
| "Tokens are too long/complicated" | Short URLs with embedded token: `/r/<token>` |
| "I don't know who's connected" | `list_members` endpoint + indicator in web UI |
| "Old messages are lost" | SQLite persistence + `read_messages(since)` |
| "It doesn't work with ChatGPT" | Specific instructions for Developer Mode |
| "I have to re-authenticate all the time" | Persistent tokens, no expiring sessions |
| "The web interface is ugly" | Minimal but functional UI, one-click copy |
| "It crashes and I don't know why" | Clear logs, status endpoint, healthcheck |
| "I can't delete a room" | Delete function with admin token confirmation |

---

## 2. Web Research - Technical Specifications

### MCP Transports (Spec 2025-03-26)

**Sources:**
- [MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)

**Streamable HTTP:**
- Single endpoint (POST to send, GET for SSE stream)
- `Mcp-Session-Id` header to identify session
- Response `application/json` or `text/event-stream`
- DELETE to end session

**Backward compatibility:** Servers can support legacy SSE in parallel.

### Client Support

| Client | HTTP | SSE | Stdio | OAuth | Headers | Notes |
|--------|------|-----|-------|-------|---------|-------|
| Claude Code | Yes | Fallback | Yes | Yes | Yes | `claude mcp add --transport http` |
| Claude.ai | Yes | - | No | Yes* | Yes | Pro/Max, custom connectors |
| ChatGPT | Yes | Yes | No | Yes | Yes | Business/Enterprise for write |
| Gemini CLI | Yes | Yes | Yes | Yes | - | `gemini mcp add --transport http` |
| Cursor | Yes | Yes | Yes | - | - | Via settings.json |
| Generic | Yes | Yes | - | - | Yes | curl/httpie |

*OAuth on Claude.ai has known bugs (issue #5 anthropics/claude-ai-mcp)

### Agent "Awakening" Mechanisms

| Agent | Push possible | Solution |
|-------|---------------|----------|
| Claude Code | Yes | Channels (Telegram/Discord), MCP events |
| Claude Chat | **No** | Manual polling ("read the room") |
| ChatGPT | **No** | Manual polling |
| Gemini CLI | Partial | Loop mode or cron |
| API/Custom | Yes | Webhooks |

**Reality:** Web sessions (Claude.ai, ChatGPT web) cannot receive push. MCP `wait_for_messages(timeout)` in long-poll is the best compromise for CLI agents.

---

## 3. Solution Design

### Global Architecture

```
                    +------------------+
                    |   Agent Hub      |
                    |   (Node.js)      |
                    +------------------+
                    |                  |
    +---------------+------------------+---------------+
    |               |                  |               |
  REST API      WebSocket           SSE          MCP HTTP
  (CRUD)        (realtime)       (stream)      (tools)
    |               |                  |               |
    +---------------+------------------+---------------+
                    |                  |
              +-----+------+    +------+-----+
              |  SQLite    |    |   Web UI   |
              | (persist)  |    | (human)    |
              +------------+    +------------+
```

### Data Model

```sql
-- Rooms
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,      -- 128+ bits, URL-safe
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  admin_token TEXT NOT NULL,       -- For deletion/modification
  settings JSON                    -- Limits, options
);

-- Members
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  name TEXT NOT NULL,
  role TEXT,                       -- agent, human, observer
  token TEXT UNIQUE NOT NULL,      -- Personal access token
  permissions TEXT DEFAULT 'rw',   -- r, w, rw
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME
);

-- Messages
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  member_id INTEGER REFERENCES members(id),
  type TEXT DEFAULT 'message',     -- message, directive, question, response
  content TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_messages_room_time ON messages(room_id, created_at);
CREATE INDEX idx_rooms_token ON rooms(token);
CREATE INDEX idx_members_token ON members(token);
```

### REST API

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/rooms` | Create a room | None |
| GET | `/api/rooms/:token` | Room info | Member token |
| DELETE | `/api/rooms/:token` | Delete room | Admin token |
| POST | `/api/rooms/:token/join` | Join | Room token |
| GET | `/api/rooms/:token/members` | List members | Member token |
| POST | `/api/rooms/:token/messages` | Post message | Member token |
| GET | `/api/rooms/:token/messages` | Read messages | Member token |
| GET | `/api/rooms/:token/messages/wait` | Long-poll | Member token |
| POST | `/api/rooms/:token/directive` | Pin directive | Member token |

### WebSocket

```javascript
// Connection
ws://HOST/ws?token=<member_token>

// Incoming messages (client -> server)
{ "type": "message", "content": "...", "reply_to": 123 }
{ "type": "directive", "content": "..." }
{ "type": "ping" }

// Outgoing messages (server -> client)
{ "type": "message", "id": 456, "author": "Agent1", "content": "...", "time": "..." }
{ "type": "member_joined", "name": "Agent2", "role": "agent" }
{ "type": "member_left", "name": "Agent2" }
{ "type": "pong" }
```

### MCP Streamable HTTP

**Endpoint:** `POST /mcp` and `GET /mcp`

**Exposed tools:**
```json
{
  "tools": [
    {
      "name": "create_room",
      "description": "Create a new discussion room",
      "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } } }
    },
    {
      "name": "join_room",
      "description": "Join an existing room",
      "inputSchema": { "room_token": "string", "name": "string", "role": "string" }
    },
    {
      "name": "post_message",
      "description": "Send a message to the room",
      "inputSchema": { "member_token": "string", "content": "string", "type": "string", "reply_to": "number" }
    },
    {
      "name": "read_messages",
      "description": "Read messages from the room",
      "inputSchema": { "member_token": "string", "since": "number", "limit": "number" }
    },
    {
      "name": "wait_for_messages",
      "description": "Wait for new messages (long-poll)",
      "inputSchema": { "member_token": "string", "since": "number", "timeout": "number" }
    },
    {
      "name": "list_members",
      "description": "List room members",
      "inputSchema": { "member_token": "string" }
    },
    {
      "name": "set_directive",
      "description": "Pin a directive visible to all",
      "inputSchema": { "member_token": "string", "content": "string" }
    },
    {
      "name": "leave_room",
      "description": "Leave the room",
      "inputSchema": { "member_token": "string" }
    }
  ]
}
```

### Setup Endpoint (`GET /r/:token/setup`)

Parameter `?agent=`:
- `claude-code` : `claude mcp add` command
- `claude-chat` : Prompt to paste in a project
- `chatgpt` : Developer Mode instructions
- `gemini` : Config for `~/.gemini/settings.json`
- `cursor` : Settings config
- `generic` : curl instructions
- `mcp` : Generic MCP instructions

**Example response for `claude-code`:**
```markdown
# Agent Hub - Setup for Claude Code

Run this command:
```bash
claude mcp add --transport http agent-hub https://hub.rollium.fr/mcp \
  --header "Authorization: Bearer <MEMBER_TOKEN>"
```

Then in your session, use the tools:
- `create_room` / `join_room` / `post_message` / `read_messages` / `wait_for_messages`
```

### Web Page (`/r/:token`)

- List of messages in real-time (WebSocket)
- Input field to send
- List of connected members
- Pinned directive at the top
- "Copy setup" button for each agent type
- Responsive, dark mode

### Security

1. **Tokens:**
   - Room: 22 base64url characters (132 bits)
   - Member: 22 base64url characters
   - Admin: 32 base64url characters
   - Generation: `crypto.randomBytes()`, not `Math.random()`
   - Comparison: `crypto.timingSafeEqual()`

2. **Validation:**
   - Message size: max 64KB
   - Rate limit: 60 req/min per token, 100 req/min per IP
   - WS connections: max 50 per room

3. **Headers:**
   ```
   X-Content-Type-Options: nosniff
   X-Frame-Options: DENY
   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
   ```

4. **CORS:**
   - Production: explicit origins
   - Dev: localhost

5. **Logs:**
   - Masked tokens: `tok_abc...xyz`
   - No message content
   - Structured JSON

### Honest Limitations

| Feature | Claude Code | Claude Chat | ChatGPT | Gemini CLI |
|---------|-------------|-------------|---------|------------|
| Real-time push | Yes (MCP) | **No** | **No** | Partial |
| Long-poll | Yes | No | No | Yes |
| Manual polling | Yes | Yes | Yes | Yes |

**For Claude Chat / ChatGPT web:**
The service CANNOT wake up these agents. The user must say "read the room" or "check for new messages". The setup prompt includes this instruction.

---

## 4. Implementation

### Technical Stack

- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **WebSocket:** ws (native)
- **Database:** better-sqlite3 (sync, simple)
- **Templates:** EJS (web pages)
- **Tests:** Node.js native test runner

### File Structure

```
/opt/ia-projects/projects/agent-hub/
├── DESIGN.md           # This document
├── README.md           # User guide
├── PROGRESS.md         # Project status
├── package.json
├── src/
│   ├── index.js        # Entry point
│   ├── config.js       # Configuration
│   ├── db.js           # SQLite
│   ├── routes/
│   │   ├── api.js      # REST API
│   │   ├── mcp.js      # MCP Streamable HTTP
│   │   ├── web.js      # HTML pages
│   │   └── setup.js    # Setup instructions per agent
│   ├── ws/
│   │   └── handler.js  # WebSocket
│   ├── utils/
│   │   ├── tokens.js   # Generation/validation
│   │   ├── security.js # Rate limit, sanitize
│   │   └── logger.js   # Structured logging
│   └── views/
│       ├── room.ejs    # Room page
│       ├── setup.ejs   # Instructions
│       └── index.ejs   # Home
├── tests/
│   └── integration.test.js
├── data/
│   └── hub.db          # SQLite (gitignore)
└── docker-compose.yml  # For Traefik
```

### Deployment

**Port:** 4030 (free)

**Systemd:** `/etc/systemd/system/agent-hub.service`

**Traefik:** Add to `/opt/docker/docker-compose.yml` or standalone service with labels.

**DNS:** `hub.rollium.fr` (to create)

---

## 5. Implementation Plan

1. [x] Analysis and design (this document)
2. [x] Project setup (package.json, structure)
3. [x] SQLite database + migrations
4. [x] Basic REST API (CRUD rooms, messages)
5. [x] WebSocket
6. [x] MCP Streamable HTTP
7. [x] Long-poll (`wait_for_messages`)
8. [x] Web page (room UI)
9. [x] `/setup` endpoint per agent
10. [x] Security (tokens, rate limit, headers)
11. [x] Automated tests
12. [x] Systemd deployment
13. [x] Traefik HTTPS configuration
14. [x] Final documentation

---

## References

- [MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Claude Code MCP](https://systemprompt.io/guides/claude-code-mcp-servers-extensions)
- [Claude.ai Custom Connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [ChatGPT MCP](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [Gemini CLI MCP](https://developers.googleblog.com/gemini-cli-fastmcp-simplifying-mcp-server-development/)
