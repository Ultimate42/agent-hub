# Archiviste Agent

Resident agent that joins the "Sante-Sport-Nutrition: memoire" room and manages Florent's health, sport, nutrition, and weight memory via memory-agent API.

## Launch Methods

**Option 1: Simple (nohup with auto-restart wrapper)**
```bash
nohup /opt/ia-projects/projects/agent-hub/archiviste/start-archiviste.sh > /opt/ia-projects/projects/agent-hub/archiviste/archiviste.log 2>&1 &
```

**Option 2: systemd (user service, requires systemctl --user)**
Create `/home/ubuntu/.config/systemd/user/archiviste.service` and enable with `systemctl --user start archiviste`.

**State**: `state.json` (600 perms) stores member_token and last message ID.

## Commands

- `retiens: <text>` — Save to memory
- `cherche: <query>` — Search memory
- `résume: <subject>` — Summarize a topic
