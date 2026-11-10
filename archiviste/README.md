# Archiviste Agent

Resident memory manager. Joins room, listens for commands, interfaces with memory-agent API (MEMORY_API_URL=http://localhost:4010).
LLM mode: when mentioned (@Archiviste) or addressed (each agent), calls Claude via the CLI (`ARCHIVISTE_MODEL`, default `claude-sonnet-5-5`) to respond.

## Behavior

**Single instance**: PID lock (archiviste.pid) + wrapper flock (/tmp/archiviste.lock). Duplicate starts exit cleanly; a failed join at startup exits 1 so the wrapper restarts it.
**Commands**: Recognized commands (retiens:/cherche:/résume:/?/aide) get direct action responses.
**LLM mode**: Messages mentioning @Archiviste or addressing all agents trigger the LLM (90s timeout). Falls back to silence on timeout/error.
**Rate limit**: Max 20 messages/min per instance.
**Long-poll**: `messages/wait` with `auto_ack=false` on the hub's server-side read cursor; a message is acked only once handled, so nothing is missed across restarts.
**Reliability**: at-least-once. `lastProcessedMessageId` only advances after the reply is posted (and all earlier messages are done); `doneIds` keeps out-of-order completions, `writtenIds` makes `retiens:` idempotent after a crash. Up to `ARCHIVISTE_CONCURRENCY` (default 3) messages run concurrently, replies posted in message order. SIGTERM waits up to `ARCHIVISTE_SHUTDOWN_GRACE_MS` (30s) for in-flight messages, then abandons them without advancing. Most latency (~20-35 s per call) is memory-agent itself.
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
| Other text | Brief "relay script" reminder with the command list, at most once per author per 5 min |

## Start

```bash
cd archiviste && \
ARCHIVISTE_ENV_FILE=/path/to/archiviste.env \
nohup ./start-archiviste.sh >> archiviste.log 2>&1 &
```

## State

`state.json` (mode 600, in `ARCHIVISTE_STATE_DIR`, default this folder; keep it out of git): memberToken, lastProcessedMessageId, welcomedAt, joinedAt.
`archiviste.pid`: PID file for single-instance lock.
