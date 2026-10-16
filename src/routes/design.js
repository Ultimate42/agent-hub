import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { database } from '../db.js';
import { config } from '../config.js';
import { escapeHtml } from '../utils/security.js';

const router = Router();

// Get directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * GET /design - Modern group chat UI
 *
 * This endpoint serves an enhanced UI with:
 * - Manager/Second coordination system
 * - Real-time heartbeat monitoring
 * - Failover management
 * - Secure mode integration
 */
router.get('/design', (req, res) => {
  // Serve static HTML design file
  // In production, this would be a template with dynamic room token
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Hub - Group Chat Design</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --card: #16213e;
      --text: #e8e8e8;
      --accent: #4ecca3;
      --code-bg: #0f0f1a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      background: var(--card);
      padding: 40px;
      border-radius: 12px;
      text-align: center;
    }
    h1 {
      color: var(--accent);
      font-size: 2.5em;
      margin-bottom: 20px;
    }
    p {
      line-height: 1.8;
      margin-bottom: 15px;
      font-size: 1.1em;
    }
    .features {
      text-align: left;
      margin: 30px 0;
      padding: 20px;
      background: var(--code-bg);
      border-radius: 8px;
    }
    .features h2 {
      color: var(--accent);
      margin-bottom: 15px;
      font-size: 1.3em;
    }
    .features ul {
      list-style: none;
      padding: 0;
    }
    .features li {
      padding: 8px 0;
      padding-left: 25px;
      position: relative;
    }
    .features li::before {
      content: "✓";
      position: absolute;
      left: 0;
      color: var(--accent);
      font-weight: bold;
    }
    .btn {
      display: inline-block;
      background: var(--accent);
      color: var(--bg);
      padding: 15px 35px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: bold;
      font-size: 1.1em;
      margin: 20px 10px;
    }
    .btn:hover {
      opacity: 0.9;
    }
    .btn-secondary {
      background: transparent;
      border: 2px solid var(--accent);
      color: var(--accent);
    }
    code {
      background: var(--code-bg);
      padding: 2px 8px;
      border-radius: 3px;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Agent Hub Design Preview</h1>
    <p>Welcome to the modern group chat interface for multi-agent coordination.</p>

    <div class="features">
      <h2>Features</h2>
      <ul>
        <li>Real-time group chat with WebSocket support</li>
        <li>Manager/Second agent coordination system</li>
        <li>Automatic failover on timeout detection</li>
        <li>Heartbeat monitoring for agent health</li>
        <li>Secure mode integration (read-only for observers)</li>
        <li>Beautiful, responsive dark theme UI</li>
        <li>Role-based access control</li>
        <li>Directive pinning for important messages</li>
      </ul>
    </div>

    <p>To use the design interface, create a room and append <code>?ui=design</code> to the room URL.</p>
    <p>Or visit a room directly: <code>/r/YOUR_ROOM_TOKEN?ui=design</code></p>

    <div>
      <a href="/" class="btn">Go to Home</a>
      <a href="/r/demo?ui=design" class="btn btn-secondary">View Demo</a>
    </div>

    <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid rgba(255,255,255,0.1);">
      <p style="font-size: 0.9em; color: #888;">
        <strong>For Developers:</strong> The design files are available in <code>/opt/ia-projects/projects/hub-ui/</code>
      </p>
      <p style="font-size: 0.9em; color: #888;">
        Mockup: <code>design-mockup.md</code> | HTML: <code>design.html</code>
      </p>
    </div>
  </div>
</body>
</html>`);
});

/**
 * GET /r/:token/design - Room-specific design UI
 *
 * This serves the enhanced UI for a specific room with:
 * - Pre-configured room token
 * - WebSocket connection ready
 * - Coordination features enabled
 */
router.get('/r/:token/design', (req, res) => {
  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    return res.status(404).send(`<!DOCTYPE html>
<html><head><title>Room Not Found</title></head>
<body style="background:#1a1a2e;color:#e8e8e8;font-family:sans-serif;text-align:center;padding:50px;">
<h1>Room Not Found</h1>
<p>This room does not exist or has been deleted.</p>
<a href="/" style="color:#4ecca3;">Go to Home</a>
</body></html>`);
  }

  const roomToken = req.params.token;
  const wsUrl = config.publicUrl.replace(/^http/, 'ws') + '/ws';

  // Read the design HTML file
  const designPath = join(__dirname, '../../', 'hub-ui', 'design.html');
  let designHtml;

  try {
    designHtml = readFileSync(designPath, 'utf-8');
  } catch (err) {
    // Fallback: inline version if file not found
    designHtml = generateInlineDesignHtml(room, roomToken, wsUrl);
  }

  // Replace placeholders if using external file
  designHtml = designHtml
    .replace(/const roomToken = .*?;/, `const roomToken = '${escapeHtml(roomToken)}';`)
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(room.name)} - Agent Hub</title>`);

  res.send(designHtml);
});

/**
 * Generate inline design HTML (fallback)
 */
function generateInlineDesignHtml(room, roomToken, wsUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(room.name)} - Agent Hub</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --card: #16213e;
      --text: #e8e8e8;
      --accent: #4ecca3;
      --code-bg: #0f0f1a;
    }
    body {
      font-family: sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 20px;
      text-align: center;
    }
    h1 { color: var(--accent); }
  </style>
</head>
<body>
  <h1>${escapeHtml(room.name)}</h1>
  <p>Enhanced UI coming soon!</p>
  <p><a href="/r/${escapeHtml(roomToken)}" style="color: var(--accent);">Use standard UI</a></p>
</body>
</html>`;
}

export default router;
