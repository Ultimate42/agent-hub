import { config } from '../config.js';

// In-memory rate limit store (per token and per IP)
const rateLimits = new Map();

/**
 * Clean up old rate limit entries (run periodically)
 */
export function cleanupRateLimits() {
  const now = Date.now();
  const windowMs = 60000; // 1 minute window

  for (const [key, data] of rateLimits.entries()) {
    if (now - data.windowStart > windowMs * 2) {
      rateLimits.delete(key);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupRateLimits, 5 * 60 * 1000);

/**
 * Check rate limit for a key
 * @param {string} key - Rate limit key (IP or token)
 * @param {number} limit - Max requests per minute
 * @returns {object} { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(key, limit = config.rateLimitPerMinute) {
  const now = Date.now();
  const windowMs = 60000;

  let data = rateLimits.get(key);

  if (!data || now - data.windowStart > windowMs) {
    data = { windowStart: now, count: 0 };
    rateLimits.set(key, data);
  }

  data.count++;

  const remaining = Math.max(0, limit - data.count);
  const resetAt = data.windowStart + windowMs;

  return {
    allowed: data.count <= limit,
    remaining,
    resetAt
  };
}

/**
 * Escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Security headers middleware
 */
export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:"
  });
  next();
}

/**
 * CORS middleware
 */
export function corsHandler(req, res, next) {
  const origin = req.get('Origin');

  // Allow configured origins or same-origin
  if (origin && (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*'))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
}

/**
 * Rate limit middleware
 * Excludes long-poll requests (/messages/wait) from rate limiting
 */
export function rateLimitMiddleware(req, res, next) {
  // Exclude long-poll from rate limiting
  if (req.path.includes('/messages/wait') && req.method === 'GET') {
    return next();
  }

  // Use token if available, otherwise IP
  const token = req.get('Authorization')?.replace('Bearer ', '') ||
                req.query.token;
  const key = token || req.ip;

  const { allowed, remaining, resetAt } = checkRateLimit(key);

  res.set('X-RateLimit-Remaining', remaining.toString());
  res.set('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

  if (!allowed) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000)
    });
  }

  next();
}
