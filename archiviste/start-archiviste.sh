#!/bin/bash
# Wrapper pour démarrer Archiviste avec redémarrage automatique en cas d'erreur
# Usage: ./start-archiviste.sh &
# ou: nohup ./start-archiviste.sh > archiviste.log 2>&1 &

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HUB_URL="${AGENT_HUB_URL:-http://localhost:4030}"
MEMORY_API_URL="${MEMORY_API_URL:-http://localhost:4010}"
ROOM_TOKEN="${ROOM_TOKEN:-***REMOVED***}"

export AGENT_HUB_URL MEMORY_API_URL ROOM_TOKEN

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Archiviste (HUB=$AGENT_HUB_URL, MEM=$MEMORY_API_URL)..."
  node "$SCRIPT_DIR/archiviste.js"
  EXIT_CODE=$?

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Archiviste exited with code $EXIT_CODE. Restarting in 5s..."
  sleep 5
done
