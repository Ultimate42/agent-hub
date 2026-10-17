import { Router } from 'express';
import { database } from '../db.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Helper: Extract token from Authorization header
function getToken(req) {
  const auth = req.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return req.query.token;
}

// Helper: Validate member access
function requireMember(req, res) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization required' });
    return null;
  }

  const member = database.getMemberByToken(token);
  if (!member) {
    res.status(403).json({ error: 'Invalid token' });
    return null;
  }

  database.updateMemberLastSeen(member.id);
  return member;
}

/**
 * POST /api/members/wake-target - Register or update a wake target
 * Body: {
 *   type: 'webhook' | 'file',
 *   url?: 'https://...' (for webhook),
 *   path?: '/repo/path' (for file),
 *   max_retries?: 3
 * }
 */
router.post('/members/wake-target', (req, res) => {
  try {
    const member = requireMember(req, res);
    if (!member) return;

    const { type, url, path, max_retries = 3 } = req.body || {};

    if (!type || !['webhook', 'file'].includes(type)) {
      return res.status(400).json({ error: 'type must be "webhook" or "file"' });
    }

    if (type === 'webhook') {
      if (!url) {
        return res.status(400).json({ error: 'url is required for webhook type' });
      }
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'url must be a valid URL' });
      }
      // Allow http://localhost and http://127.0.0.1 for testing, require https elsewhere
      const isLocalhost = url.includes('localhost') || url.includes('127.0.0.1');
      if (!isLocalhost && !url.startsWith('https://')) {
        return res.status(400).json({ error: 'url must use HTTPS for security (except localhost for testing)' });
      }
    }

    if (type === 'file') {
      if (!path) {
        return res.status(400).json({ error: 'path is required for file type' });
      }
      if (!path.startsWith('/')) {
        return res.status(400).json({ error: 'path must be absolute' });
      }
    }

    if (typeof max_retries !== 'number' || max_retries < 0 || max_retries > 10) {
      return res.status(400).json({ error: 'max_retries must be 0-10' });
    }

    database.setWakeTarget(member.id, type, url, path, max_retries);

    logger.info('Wake target registered', {
      memberId: member.id,
      memberName: member.name,
      targetType: type
    });

    res.json({
      success: true,
      message: `Wake target registered for ${member.name}`,
      target_type: type
    });
  } catch (error) {
    logger.error('Failed to register wake target', { error: error.message });
    res.status(500).json({ error: 'Failed to register wake target' });
  }
});

/**
 * GET /api/members/wake-target - Get current wake target
 */
router.get('/members/wake-target', (req, res) => {
  try {
    const member = requireMember(req, res);
    if (!member) return;

    const wakeTarget = database.getWakeTarget(member.id);

    if (!wakeTarget) {
      return res.json({ registered: false });
    }

    res.json({
      registered: true,
      type: wakeTarget.target_type,
      url: wakeTarget.target_type === 'webhook' ? wakeTarget.target_url : undefined,
      path: wakeTarget.target_type === 'file' ? wakeTarget.target_path : undefined,
      last_notification_at: wakeTarget.last_notification_at,
      last_error: wakeTarget.last_error,
      max_retries: wakeTarget.max_retries,
      created_at: wakeTarget.created_at
    });
  } catch (error) {
    logger.error('Failed to get wake target', { error: error.message });
    res.status(500).json({ error: 'Failed to get wake target' });
  }
});

/**
 * DELETE /api/members/wake-target - Unregister wake target
 */
router.delete('/members/wake-target', (req, res) => {
  try {
    const member = requireMember(req, res);
    if (!member) return;

    database.deleteWakeTarget(member.id);

    logger.info('Wake target unregistered', {
      memberId: member.id,
      memberName: member.name
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete wake target', { error: error.message });
    res.status(500).json({ error: 'Failed to delete wake target' });
  }
});

export default router;
