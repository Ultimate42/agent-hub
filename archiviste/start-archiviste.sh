#!/bin/bash
# Wrapper pour démarrer Archiviste avec flock (une seule instance)
# Usage: nohup ./start-archiviste.sh >> archiviste.log 2>&1 &

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="/tmp/archiviste.lock"
AGENT_HUB_URL="${AGENT_HUB_URL:-http://localhost:4030}"
MEMORY_API_URL="${MEMORY_API_URL:-http://localhost:4010}"
ROOM_TOKEN="${ROOM_TOKEN:-***REMOVED***}"

export AGENT_HUB_URL MEMORY_API_URL ROOM_TOKEN

# Try to acquire lock; exit immediately if another wrapper is running
exec 200>"$LOCK_FILE"
flock -n 200 || {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Another Archiviste wrapper is running. Exiting."
  exit 0
}

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Archiviste..."
  node "$SCRIPT_DIR/archiviste.js"
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Archiviste exited normally (PID lock conflict?)"
    break
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Archiviste exited with code $EXIT_CODE. Restarting in 5s..."
  sleep 5
done
