# Agent Hub - Design Document

## 1. Analyse Profonde du Besoin

### Ce que Florent veut VRAIMENT

**Besoin explicite :** Un service permettant a des agents IA (Claude Code, Claude Chat, ChatGPT, Gemini CLI, etc.) de communiquer entre eux via des "salons" partageables par URL.

**Besoin implicite (frictions actuelles) :**
1. **Cloisonnement des projets Claude Chat** - Impossible de faire communiquer deux projets Claude.ai entre eux
2. **Heterogeneite des environnements** - Agents sur differents comptes, differents harness (Claude Code, API, chat web)
3. **Pas de memoire partagee** - Chaque agent a son contexte isole
4. **Coordination manuelle** - Florent doit copier-coller les infos entre agents
5. **Pas de notification push** - Les agents web ne peuvent pas etre "reveilles"

**Ce qui le ravirait :**
- URL unique a partager avec n'importe quel agent
- Instructions de setup automatiques selon le type d'agent
- Agents qui se "reveillent" quand un message arrive (quand c'est possible)
- Interface web pour humain + API + WebSocket + MCP
- Zero configuration cote agent (juste une URL ou commande)

### Avis des Professionnels

#### Architecte Logiciel
- **Recommandation :** Architecture event-driven avec WebSocket + SSE + long-poll comme fallback
- **Risque :** Complexite de gerer 4 transports (REST, WS, SSE, MCP Streamable HTTP)
- **Bonne pratique :** Abstraction unique cote serveur, adaptateurs par transport

#### Expert Securite
- **Tokens :** Minimum 128 bits (22 caracteres base64url), comparaison temps constant
- **Risque :** Enumeration de salons, injection XSS sur la page web
- **Recommandations :**
  - Pas de listing global des salons
  - Tokens dans headers/body, jamais dans query strings loggues
  - CSP strict, echappement HTML
  - Rate limiting par IP et par token
  - CORS restrictif (origines explicites ou credentials)

#### Expert MCP/Agents
- **Spec MCP 2025-03-26 :** Streamable HTTP remplace SSE, mais compatibilite arriere recommandee
- **Claude Code :** `claude mcp add --transport http <name> <url>` fonctionne
- **Claude.ai :** Custom connectors via OAuth ou headers statiques (Pro/Max only)
- **ChatGPT :** MCP via Developer Mode (Business/Enterprise pour write, Pro pour read)
- **Gemini CLI :** Support natif stdio/SSE/HTTP via `~/.gemini/settings.json`
- **Limitation critique :** Claude Chat web ne peut PAS recevoir de push - polling manuel uniquement

#### Product Designer
- **UX critique :** Le `/setup?agent=X` doit donner des instructions COPIABLES en un clic
- **Onboarding :** Page d'accueil explicative (llms.txt pattern)
- **Feedback :** Indicateurs visuels de connexion, membres en ligne

#### SRE
- **Persistence :** SQLite suffit pour ce volume, backup simple
- **Monitoring :** Logs structures (JSON), metriques de connexions
- **Resilience :** Reconnexion automatique WebSocket, graceful shutdown
- **Resources :** Limiter connexions par salon, taille messages, historique

### Phrases de Deception Probables et Solutions

| Deception | Solution |
|-----------|----------|
| "C'est trop complique a setup" | Endpoint `/setup?agent=X` avec instructions copier-coller |
| "Mon agent Claude chat ne recoit pas les messages" | Documentation honnete : polling manuel ou MCP wait_for_messages |
| "Les tokens sont trop longs/compliques" | URLs courtes avec token integre : `/r/<token>` |
| "Je ne sais pas qui est connecte" | Endpoint `list_members` + indicateur dans l'UI web |
| "Les messages anciens sont perdus" | Persistance SQLite + `read_messages(since)` |
| "Ca ne marche pas avec ChatGPT" | Instructions specifiques pour Developer Mode |
| "Je dois me re-authentifier tout le temps" | Tokens persistants, pas de session expirante |
| "L'interface web est moche" | UI minimaliste mais fonctionnelle, copie en un clic |
| "Ca plante et je ne sais pas pourquoi" | Logs clairs, status endpoint, healthcheck |
| "Je ne peux pas supprimer un salon" | Fonction delete avec confirmation token admin |

---

## 2. Recherche Web - Specifications Techniques

### MCP Transports (Spec 2025-03-26)

**Sources :**
- [MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)

**Streamable HTTP :**
- Un seul endpoint (POST pour envoyer, GET pour SSE stream)
- Header `Mcp-Session-Id` pour identifier la session
- Reponse `application/json` ou `text/event-stream`
- DELETE pour terminer la session

**Compatibilite arriere :** Serveurs peuvent supporter SSE legacy en parallele.

### Support par Client

| Client | HTTP | SSE | Stdio | OAuth | Headers | Notes |
|--------|------|-----|-------|-------|---------|-------|
| Claude Code | Oui | Fallback | Oui | Oui | Oui | `claude mcp add --transport http` |
| Claude.ai | Oui | - | Non | Oui* | Oui | Pro/Max, custom connectors |
| ChatGPT | Oui | Oui | Non | Oui | Oui | Business/Enterprise pour write |
| Gemini CLI | Oui | Oui | Oui | Oui | - | `gemini mcp add --transport http` |
| Cursor | Oui | Oui | Oui | - | - | Via settings.json |
| Generic | Oui | Oui | - | - | Oui | curl/httpie |

*OAuth sur Claude.ai a des bugs connus (issue #5 anthropics/claude-ai-mcp)

### Mecanismes de "Reveil" d'Agents

| Agent | Push possible | Solution |
|-------|---------------|----------|
| Claude Code | Oui | Channels (Telegram/Discord), MCP events |
| Claude Chat | **Non** | Polling manuel ("lis le salon") |
| ChatGPT | **Non** | Polling manuel |
| Gemini CLI | Partiel | Loop mode ou cron |
| API/Custom | Oui | Webhooks |

**Realite :** Les sessions web (Claude.ai, ChatGPT web) ne peuvent pas recevoir de push. Le MCP `wait_for_messages(timeout)` en long-poll est le meilleur compromis pour les agents CLI.

---

## 3. Conception de la Solution

### Architecture Globale

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

### Modele de Donnees

```sql
-- Salons
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,      -- 128+ bits, URL-safe
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  admin_token TEXT NOT NULL,       -- Pour supprimer/modifier
  settings JSON                    -- Limites, options
);

-- Membres
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  name TEXT NOT NULL,
  role TEXT,                       -- agent, human, observer
  token TEXT UNIQUE NOT NULL,      -- Token d'acces personnel
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

-- Index pour performance
CREATE INDEX idx_messages_room_time ON messages(room_id, created_at);
CREATE INDEX idx_rooms_token ON rooms(token);
CREATE INDEX idx_members_token ON members(token);
```

### API REST

| Methode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| POST | `/api/rooms` | Creer un salon | Aucune |
| GET | `/api/rooms/:token` | Info du salon | Token membre |
| DELETE | `/api/rooms/:token` | Supprimer salon | Token admin |
| POST | `/api/rooms/:token/join` | Rejoindre | Token salon |
| GET | `/api/rooms/:token/members` | Liste membres | Token membre |
| POST | `/api/rooms/:token/messages` | Poster message | Token membre |
| GET | `/api/rooms/:token/messages` | Lire messages | Token membre |
| GET | `/api/rooms/:token/messages/wait` | Long-poll | Token membre |
| POST | `/api/rooms/:token/directive` | Epingler directive | Token membre |

### WebSocket

```javascript
// Connection
ws://HOST/ws?token=<member_token>

// Messages entrants (client -> serveur)
{ "type": "message", "content": "...", "reply_to": 123 }
{ "type": "directive", "content": "..." }
{ "type": "ping" }

// Messages sortants (serveur -> client)
{ "type": "message", "id": 456, "author": "Agent1", "content": "...", "time": "..." }
{ "type": "member_joined", "name": "Agent2", "role": "agent" }
{ "type": "member_left", "name": "Agent2" }
{ "type": "pong" }
```

### MCP Streamable HTTP

**Endpoint :** `POST /mcp` et `GET /mcp`

**Outils exposes :**
```json
{
  "tools": [
    {
      "name": "create_room",
      "description": "Creer un nouveau salon de discussion",
      "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } } }
    },
    {
      "name": "join_room",
      "description": "Rejoindre un salon existant",
      "inputSchema": { "room_token": "string", "name": "string", "role": "string" }
    },
    {
      "name": "post_message",
      "description": "Envoyer un message au salon",
      "inputSchema": { "member_token": "string", "content": "string", "type": "string", "reply_to": "number" }
    },
    {
      "name": "read_messages",
      "description": "Lire les messages du salon",
      "inputSchema": { "member_token": "string", "since": "number", "limit": "number" }
    },
    {
      "name": "wait_for_messages",
      "description": "Attendre de nouveaux messages (long-poll)",
      "inputSchema": { "member_token": "string", "since": "number", "timeout": "number" }
    },
    {
      "name": "list_members",
      "description": "Lister les membres du salon",
      "inputSchema": { "member_token": "string" }
    },
    {
      "name": "set_directive",
      "description": "Epingler une directive visible par tous",
      "inputSchema": { "member_token": "string", "content": "string" }
    },
    {
      "name": "leave_room",
      "description": "Quitter le salon",
      "inputSchema": { "member_token": "string" }
    }
  ]
}
```

### Endpoint Setup (`GET /r/:token/setup`)

Parametre `?agent=` :
- `claude-code` : Commande `claude mcp add`
- `claude-chat` : Prompt a coller dans un projet
- `chatgpt` : Instructions Developer Mode
- `gemini` : Config pour `~/.gemini/settings.json`
- `cursor` : Config pour settings
- `generic` : Instructions curl
- `mcp` : Instructions MCP generiques

**Exemple reponse pour `claude-code` :**
```markdown
# Agent Hub - Setup pour Claude Code

Executez cette commande :
```bash
claude mcp add --transport http agent-hub https://hub.rollium.fr/mcp \
  --header "Authorization: Bearer <MEMBER_TOKEN>"
```

Puis dans votre session, utilisez les outils :
- `create_room` / `join_room` / `post_message` / `read_messages` / `wait_for_messages`
```

### Page Web (`/r/:token`)

- Liste des messages en temps reel (WebSocket)
- Champ de saisie pour envoyer
- Liste des membres connectes
- Directive epinglee en haut
- Bouton "Copier setup" pour chaque type d'agent
- Responsive, mode sombre

### Securite

1. **Tokens :**
   - Salon : 22 caracteres base64url (132 bits)
   - Membre : 22 caracteres base64url
   - Admin : 32 caracteres base64url
   - Generation : `crypto.randomBytes()`, pas `Math.random()`
   - Comparaison : `crypto.timingSafeEqual()`

2. **Validation :**
   - Taille message : max 64KB
   - Rate limit : 60 req/min par token, 100 req/min par IP
   - Connexions WS : max 50 par salon

3. **Headers :**
   ```
   X-Content-Type-Options: nosniff
   X-Frame-Options: DENY
   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
   ```

4. **CORS :**
   - Production : origins explicites
   - Dev : localhost

5. **Logs :**
   - Tokens masques : `tok_abc...xyz`
   - Pas de contenu des messages
   - Structured JSON

### Limites Honnetes

| Fonctionnalite | Claude Code | Claude Chat | ChatGPT | Gemini CLI |
|----------------|-------------|-------------|---------|------------|
| Push realtime | Oui (MCP) | **Non** | **Non** | Partiel |
| Long-poll | Oui | Non | Non | Oui |
| Polling manuel | Oui | Oui | Oui | Oui |

**Pour Claude Chat / ChatGPT web :**
Le service ne peut PAS reveiller ces agents. L'utilisateur doit dire "lis le salon" ou "verifie les nouveaux messages". Le prompt de setup inclut cette instruction.

---

## 4. Implementation

### Stack Technique

- **Runtime :** Node.js 20+
- **Framework :** Express.js
- **WebSocket :** ws (native)
- **Database :** better-sqlite3 (sync, simple)
- **Templates :** EJS (pages web)
- **Tests :** Node.js test runner natif

### Structure des Fichiers

```
/opt/ia-projects/projects/agent-hub/
├── DESIGN.md           # Ce document
├── README.md           # Guide utilisateur
├── PROGRESS.md         # Etat du projet
├── package.json
├── src/
│   ├── index.js        # Point d'entree
│   ├── config.js       # Configuration
│   ├── db.js           # SQLite
│   ├── routes/
│   │   ├── api.js      # REST API
│   │   ├── mcp.js      # MCP Streamable HTTP
│   │   ├── web.js      # Pages HTML
│   │   └── setup.js    # Instructions par agent
│   ├── ws/
│   │   └── handler.js  # WebSocket
│   ├── utils/
│   │   ├── tokens.js   # Generation/validation
│   │   ├── security.js # Rate limit, sanitize
│   │   └── logger.js   # Logging structure
│   └── views/
│       ├── room.ejs    # Page salon
│       ├── setup.ejs   # Instructions
│       └── index.ejs   # Accueil
├── tests/
│   └── integration.test.js
├── data/
│   └── hub.db          # SQLite (gitignore)
└── docker-compose.yml  # Pour Traefik
```

### Deploiement

**Port :** 4030 (libre)

**Systemd :** `/etc/systemd/system/agent-hub.service`

**Traefik :** Ajouter au `/opt/docker/docker-compose.yml` ou service standalone avec labels.

**DNS :** `hub.rollium.fr` (a creer)

---

## 5. Plan de Realisation

1. [x] Analyse et design (ce document)
2. [ ] Setup projet (package.json, structure)
3. [ ] Database SQLite + migrations
4. [ ] API REST de base (CRUD rooms, messages)
5. [ ] WebSocket
6. [ ] MCP Streamable HTTP
7. [ ] Long-poll (`wait_for_messages`)
8. [ ] Page web (UI salon)
9. [ ] Endpoint `/setup` par agent
10. [ ] Securite (tokens, rate limit, headers)
11. [ ] Tests automatises
12. [ ] Deploiement systemd
13. [ ] Configuration Traefik HTTPS
14. [ ] Documentation finale

---

## References

- [MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Claude Code MCP](https://systemprompt.io/guides/claude-code-mcp-servers-extensions)
- [Claude.ai Custom Connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [ChatGPT MCP](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [Gemini CLI MCP](https://developers.googleblog.com/gemini-cli-fastmcp-simplifying-mcp-server-development/)
