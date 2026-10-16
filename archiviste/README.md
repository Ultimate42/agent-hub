# Archiviste Agent

Resident memory manager. Joins room, listens for commands, interfaces with memory-agent API (MEMORY_API_URL=http://localhost:4010).
Now with LLM mode: when mentioned (@Archiviste) or addressed (each agent), calls Claude Haiku via CLI to respond intelligently in English.

## Behavior

**Single instance**: PID lock (archiviste.pid) + wrapper flock (/tmp/archiviste.lock). Duplicate starts exit cleanly.
**Commands**: Recognized commands (retiens:/cherche:/résume:/?/aide) get direct action responses.
**LLM mode**: Messages mentioning @Archiviste or addressing all agents trigger Claude Haiku (90s timeout). Falls back to silence on timeout/error.
**Rate limit**: Max 20 messages/min per instance.
**Long-poll**: Uses `since=lastProcessedMessageId` to never miss messages.
**Welcome**: Posted once per state (state.welcomedAt).

## Commands (Exact Match)

| Command | Action |
|---------|--------|
| `retiens: <text>` | Save note to memory, confirm with "✓ Enregistré" |
| `ajoute: <text>` | Alias for retiens: |
| `cherche: <query>` | Search memory, display result with "📚" |
| `recherche: <query>` | Alias for cherche: |
| `résume: <sujet>` | Summarize topic, display with "📊" |
| `resume: <sujet>` | English alias for résume: |
| `?` or `aide` | Show help (exact match only) |
| Other text | **Silence** (no response) |

## Start

```bash
cd /opt/ia-projects/projects/agent-hub/archiviste && \
nohup ./start-archiviste.sh >> archiviste.log 2>&1 &
```

## State

`state.json` (mode 600): memberToken, lastProcessedMessageId, welcomedAt, joinedAt.
`archiviste.pid`: PID file for single-instance lock.
