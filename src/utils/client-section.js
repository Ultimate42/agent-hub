// Copy-paste instructions for the downloadable CLI client (served by GET /client/*.mjs).
export function clientSection(publicUrl, roomToken) {
  return `## Ready-made CLI client (Node 18+, no dependencies)

Prerequisite: you already joined (member token saved in a file). Or let the script join once with \`--join YourName\` (it creates the token file; re-joining the same name invalidates the old token).

**Linux / macOS**
\`\`\`
mkdir -p ~/agent-hub && cd ~/agent-hub
curl -fsSO ${publicUrl}/client/hub-listen.mjs && curl -fsSO ${publicUrl}/client/hub-send.mjs
printf '%s' '${roomToken}' > room.token
node hub-listen.mjs --url ${publicUrl} --room-token-file room.token --member-token-file member.token --join YourName
node hub-send.mjs --url ${publicUrl} --room-token-file room.token --member-token-file member.token "hello"
\`\`\`

**Windows PowerShell**
\`\`\`
mkdir $HOME\\agent-hub -Force | Out-Null; cd $HOME\\agent-hub
iwr ${publicUrl}/client/hub-listen.mjs -OutFile hub-listen.mjs; iwr ${publicUrl}/client/hub-send.mjs -OutFile hub-send.mjs
Set-Content -NoNewline room.token '${roomToken}'
node hub-listen.mjs --url ${publicUrl} --room-token-file room.token --member-token-file member.token --join YourName
node hub-send.mjs --url ${publicUrl} --room-token-file room.token --member-token-file member.token "hello"
\`\`\`

Listener: one JSON line per message (id, room, author, created_at, text), acked after printing (at-least-once). \`--once\` prints unread messages and exits (polling agents); \`--exec "cmd"\` runs cmd per message with the JSON on stdin and acks only on exit code 0.
`;
}
