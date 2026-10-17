#!/bin/bash

BASE_URL="${1:-http://localhost:4030}"
MCP_ONLY_READONLY="${MCP_ONLY_READONLY:-0}"
PASSED=0
FAILED=0

echo "Running MCP Smoke Test against $BASE_URL"
[ "$MCP_ONLY_READONLY" = "1" ] && echo "(Readonly mode: initialize/notifications/ping/tools only)"
echo "=========================================="

# Helper: Generate request ID
gen_request_id() {
  echo "req-$(date +%s%N | cut -b1-13)"
}

# Helper: Make MCP JSON-RPC call
mcp_call() {
  local method="$1"
  local params="$2"
  local request_id=$(gen_request_id)

  local payload="{\"jsonrpc\":\"2.0\",\"id\":\"$request_id\",\"method\":\"$method\""
  if [ -n "$params" ]; then
    payload="$payload,\"params\":$params"
  fi
  payload="$payload}"

  curl -s -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

# Test 1: Initialize
echo -n "[initialize] ... "
INIT_RESP=$(mcp_call "initialize" '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}')

if echo "$INIT_RESP" | grep -q '"protocolVersion":"2025-06-18"' && echo "$INIT_RESP" | grep -q '"instructions"'; then
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  echo "  Response: $INIT_RESP"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 2: Notifications/initialized (no id = notification, returns 204)
echo -n "[notifications/initialized] ... "
NOTIF_RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')

HTTP_CODE=$(echo "$NOTIF_RESP" | tail -n1)
if [ "$HTTP_CODE" = "204" ]; then
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL (HTTP $HTTP_CODE)"
  FAILED=$((FAILED + 1))
fi

# Test 3: Ping
echo -n "[ping] ... "
PING_RESP=$(mcp_call "ping" '{}')

if echo "$PING_RESP" | grep -q '"result"' || echo "$PING_RESP" | grep -q '{}'; then
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  echo "  Response: $PING_RESP"
  FAILED=$((FAILED + 1))
fi

# Test 4: Tools/list
echo -n "[tools/list] ... "
TOOLS_RESP=$(mcp_call "tools/list" '{}')

if echo "$TOOLS_RESP" | grep -q '"tools"'; then
  TOOL_COUNT=$(echo "$TOOLS_RESP" | grep -o '"name":' | wc -l)
  if [ "$TOOL_COUNT" -ge 8 ]; then
    echo "OK ($TOOL_COUNT tools)"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (only $TOOL_COUNT tools, expected 8+)"
    FAILED=$((FAILED + 1))
  fi
else
  echo "FAIL"
  echo "  Response: $TOOLS_RESP"
  FAILED=$((FAILED + 1))
fi

# Exit early if readonly mode
if [ "$MCP_ONLY_READONLY" = "1" ]; then
  echo ""
  echo "=========================================="
  echo "Results: $PASSED passed, $FAILED failed"
  echo "=========================================="
  [ $FAILED -eq 0 ] && exit 0 || exit 1
fi

# Helper: Extract tool result JSON from MCP response
extract_tool_result() {
  echo "$1" | jq -r '.result.content[0].text | fromjson' 2>/dev/null
}

# Test 5: Create room
echo -n "[tools/call: create_room] ... "
CREATE_ROOM_PARAMS='{"name":"create_room","arguments":{"name":"smoke-test-'"$(date +%s)"'"}}'
CREATE_ROOM_RESP=$(mcp_call "tools/call" "$CREATE_ROOM_PARAMS")

CREATE_ROOM_JSON=$(extract_tool_result "$CREATE_ROOM_RESP")
if echo "$CREATE_ROOM_JSON" | jq -e '.room_token' > /dev/null 2>&1; then
  ROOM_TOKEN=$(echo "$CREATE_ROOM_JSON" | jq -r '.room_token')
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 6: Join room (Member A)
echo -n "[tools/call: join_room (A)] ... "
JOIN_A_PARAMS='{"name":"join_room","arguments":{"room_token":"'"$ROOM_TOKEN"'","name":"Agent-A","role":"agent"}}'
JOIN_A_RESP=$(mcp_call "tools/call" "$JOIN_A_PARAMS")

JOIN_A_JSON=$(extract_tool_result "$JOIN_A_RESP")
if echo "$JOIN_A_JSON" | jq -e '.member_token' > /dev/null 2>&1; then
  MEMBER_A=$(echo "$JOIN_A_JSON" | jq -r '.member_token')
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 7: Join room (Member B)
echo -n "[tools/call: join_room (B)] ... "
JOIN_B_PARAMS='{"name":"join_room","arguments":{"room_token":"'"$ROOM_TOKEN"'","name":"Agent-B","role":"agent"}}'
JOIN_B_RESP=$(mcp_call "tools/call" "$JOIN_B_PARAMS")

JOIN_B_JSON=$(extract_tool_result "$JOIN_B_RESP")
if echo "$JOIN_B_JSON" | jq -e '.member_token' > /dev/null 2>&1; then
  MEMBER_B=$(echo "$JOIN_B_JSON" | jq -r '.member_token')
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 8: Post message from A
echo -n "[tools/call: post_message] ... "
POST_MSG_PARAMS='{"name":"post_message","arguments":{"member_token":"'"$MEMBER_A"'","content":"Hello from Agent A","type":"message"}}'
POST_MSG_RESP=$(mcp_call "tools/call" "$POST_MSG_PARAMS")

POST_MSG_JSON=$(extract_tool_result "$POST_MSG_RESP")
if echo "$POST_MSG_JSON" | jq -e '.message_id' > /dev/null 2>&1; then
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 9: Read messages by B
echo -n "[tools/call: read_messages] ... "
READ_MSG_PARAMS='{"name":"read_messages","arguments":{"room_token":"'"$ROOM_TOKEN"'","member_token":"'"$MEMBER_B"'","limit":10}}'
READ_MSG_RESP=$(mcp_call "tools/call" "$READ_MSG_PARAMS")

if echo "$READ_MSG_RESP" | grep -q 'Hello from Agent A'; then
  echo "OK"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  echo "  Response: $READ_MSG_RESP"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 10: Wait for messages (5s timeout)
echo -n "[tools/call: wait_for_messages (5s timeout)] ... "
WAIT_START=$(date +%s%N)
WAIT_MSG_PARAMS='{"name":"wait_for_messages","arguments":{"room_token":"'"$ROOM_TOKEN"'","member_token":"'"$MEMBER_B"'","timeout":5000}}'
WAIT_MSG_RESP=$(timeout 6 mcp_call "tools/call" "$WAIT_MSG_PARAMS")
WAIT_END=$(date +%s%N)
WAIT_DURATION=$(( (WAIT_END - WAIT_START) / 1000000 ))

if [ "$WAIT_DURATION" -ge 5000 ] && [ "$WAIT_DURATION" -le 6500 ]; then
  echo "OK (timed out after ${WAIT_DURATION}ms as expected)"
  PASSED=$((PASSED + 1))
elif echo "$WAIT_MSG_RESP" | grep -q '"messages"'; then
  echo "OK (received response in ${WAIT_DURATION}ms)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL (unexpected behavior: ${WAIT_DURATION}ms)"
  FAILED=$((FAILED + 1))
fi

# Summary
echo ""
echo "=========================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "=========================================="

if [ $FAILED -eq 0 ]; then
  exit 0
else
  exit 1
fi
