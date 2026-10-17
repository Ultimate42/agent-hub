import express from 'express';
import { createServer } from 'http';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { securityHeaders, corsHandler, rateLimitMiddleware } from './utils/security.js';
import { setupWebSocket } from './ws/handler.js';
import apiRoutes from './routes/api.js';
import mcpRoutes from './routes/mcp.js';
import webRoutes from './routes/web.js';
import setupRoutes from './routes/setup.js';
import designRoutes from './routes/design.js';
import coordinationRoutes from './routes/coordination.js';

// Initialize Express
const app = express();

// Trust proxy (for correct IP behind reverse proxy)
app.set('trust proxy', 1);

// Middleware
app.use(securityHeaders);
app.use(corsHandler);
app.use(rateLimitMiddleware);

// Parse JSON with size limit
app.use(express.json({ limit: '64kb' }));

// Request logging (mask tokens in URLs)
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    // Mask any token-like strings in URL
    const safeUrl = req.originalUrl.replace(/([?&]token=)[^&]+/g, '$1***').replace(/(\/(?:rooms|r)\/)[A-Za-z0-9_-]{8,}/g, '$1***');

    logger.info('HTTP request', {
      method: req.method,
      url: safeUrl,
      status: res.statusCode,
      duration: Date.now() - start,
      ip: req.ip
    });
  });

  next();
});

// Routes
app.use('/api', apiRoutes);
app.use('/api', coordinationRoutes); // /api/rooms/:token/coordination/*
app.use('/mcp', mcpRoutes);
app.use(setupRoutes);  // /r/:token/setup
app.use(designRoutes); // /design, /r/:token/design
app.use(webRoutes);    // /, /r/:token, /health, /llms.txt

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Setup WebSocket
const wss = setupWebSocket(server);

// Start server
server.listen(config.port, config.host, () => {
  logger.info('Agent Hub started', {
    port: config.port,
    host: config.host,
    publicUrl: config.publicUrl
  });

  console.log(`
========================================
  Agent Hub is running!

  Local:  http://localhost:${config.port}
  Public: ${config.publicUrl}

  MCP:    ${config.publicUrl}/mcp
  API:    ${config.publicUrl}/api
========================================
`);
});

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');

  // Close WebSocket clients
  if (wss?.clients) {
    wss.clients.forEach(ws => ws.terminate());
  }

  server.close(() => process.exit(0));

  // Force close idle/all connections after 2s
  setTimeout(() => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }, 2000);

  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
