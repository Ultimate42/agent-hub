#!/bin/bash

BASE_URL="${1:-http://localhost:4030}"
PASSED=0
FAILED=0

echo "Running MCP Smoke Test against $BASE_URL"
echo "=========================================="

# Helper: Extract token from REST response
extract_token() {
  local response="$1"
  local field="$2"
  echo "$response" | grep -o "\"$field\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}

# Helper: Test HTTP request
test_request() {
  local name="$1"
  local method="$2"
  local url="$3"
  local data="$4"
  local expected_field="$5"

  echo -n "[$name] ... "

  if [ "$method" = "GET" ]; then
    local response=$(curl -s -X GET "$BASE_URL$url" ${data:+-H "$data"})
  else
    local response=$(curl -s -X POST "$BASE_URL$url" \
      -H "Content-Type: application/json" \
      ${data:+-d "$data"})
  fi

  if [ -z "$expected_field" ] || echo "$response" | grep -q "\"$expected_field\""; then
    echo "OK"
    PASSED=$((PASSED + 1))
    echo "$response"
    return 0
  else
    echo "FAIL"
    echo "  Response: $response"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

# Test 1: Create room
ROOM_RESPONSE=$(curl -s -X POST "$BASE_URL/api/rooms" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-test-room"}')

echo -n "[create_room] ... "
ROOM_TOKEN=$(extract_token "$ROOM_RESPONSE" "room_token")
if [ -n "$ROOM_TOKEN" ]; then
  echo "OK"
  PASSED=$((PASSED + 1))
  echo "  Room token: $ROOM_TOKEN"
else
  echo "FAIL"
  echo "  Response: $ROOM_RESPONSE"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 2: Join room (member A)
echo -n "[join_room (A)] ... "
JOIN_A=$(curl -s -X POST "$BASE_URL/api/rooms/$ROOM_TOKEN/join" \
  -H "Content-Type: application/json" \
  -d '{"name":"Agent-A","role":"agent"}')

MEMBER_A=$(extract_token "$JOIN_A" "member_token")
if [ -n "$MEMBER_A" ]; then
  echo "OK"
  PASSED=$((PASSED + 1))
  echo "  Member A token: $MEMBER_A"
else
  echo "FAIL"
  echo "  Response: $JOIN_A"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 3: Join room (member B)
echo -n "[join_room (B)] ... "
JOIN_B=$(curl -s -X POST "$BASE_URL/api/rooms/$ROOM_TOKEN/join" \
  -H "Content-Type: application/json" \
  -d '{"name":"Agent-B","role":"agent"}')

MEMBER_B=$(extract_token "$JOIN_B" "member_token")
if [ -n "$MEMBER_B" ]; then
  echo "OK"
  PASSED=$((PASSED + 1))
  echo "  Member B token: $MEMBER_B"
else
  echo "FAIL"
  echo "  Response: $JOIN_B"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 4: Post message
echo -n "[post_message] ... "
POST_MSG=$(curl -s -X POST "$BASE_URL/api/rooms/$ROOM_TOKEN/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MEMBER_A" \
  -d '{"content":"Hello from Agent A","type":"message"}')

if echo "$POST_MSG" | grep -q '"Hello from Agent A"'; then
  echo "OK"
  PASSED=$((PASSED + 1))
  MESSAGE_ID=$(echo "$POST_MSG" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
  echo "  Message ID: $MESSAGE_ID"
else
  echo "FAIL"
  echo "  Response: $POST_MSG"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 5: Read messages
echo -n "[read_messages] ... "
READ_MSG=$(curl -s -X GET "$BASE_URL/api/rooms/$ROOM_TOKEN/messages?limit=10" \
  -H "Authorization: Bearer $MEMBER_B")

if echo "$READ_MSG" | grep -q '"Hello from Agent A"'; then
  echo "OK"
  PASSED=$((PASSED + 1))
  echo "  Message received by B"
else
  echo "FAIL"
  echo "  Response: $READ_MSG"
  FAILED=$((FAILED + 1))
  exit 1
fi

# Test 6: Wait for messages (with 5s timeout)
echo -n "[wait_for_messages (5s timeout)] ... "
WAIT_START=$(date +%s%N)
WAIT_MSG=$(timeout 6 curl -s -X GET "$BASE_URL/api/rooms/$ROOM_TOKEN/messages/wait?timeout=5000" \
  -H "Authorization: Bearer $MEMBER_B")
WAIT_END=$(date +%s%N)
WAIT_DURATION=$(( (WAIT_END - WAIT_START) / 1000000 ))

if [ "$WAIT_DURATION" -ge 5000 ] && [ "$WAIT_DURATION" -le 6000 ]; then
  echo "OK (timed out after ${WAIT_DURATION}ms as expected)"
  PASSED=$((PASSED + 1))
elif echo "$WAIT_MSG" | grep -q '"messages"'; then
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
