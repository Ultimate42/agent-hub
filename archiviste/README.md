# Archiviste Agent

Resident memory manager. Joins room, listens for commands, interfaces with memory-agent API (MEMORY_API_URL=http://localhost:4010).

## Behavior

**Single instance**: PID lock (archiviste.pid) + wrapper flock (/tmp/archiviste.lock). Duplicate starts exit cleanly.
**Silent mode**: Only responds to commands. Non-command messages get no reply.
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
