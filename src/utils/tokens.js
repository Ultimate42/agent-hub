import crypto from 'crypto';

/**
 * Generate a cryptographically secure URL-safe token
 * @param {number} length - Number of characters (each char = ~6 bits)
 * @returns {string} URL-safe base64 token
 */
export function generateToken(length = 22) {
  // Each base64 char encodes 6 bits, so we need (length * 6 / 8) bytes
  const bytes = Math.ceil((length * 6) / 8);
  return crypto.randomBytes(bytes)
    .toString('base64url')
    .slice(0, length);
}

/**
 * Constant-time comparison of two tokens
 * @param {string} a - First token
 * @param {string} b - Second token
 * @returns {boolean} Whether tokens match
 */
export function compareTokens(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(a, 'utf8'),
      Buffer.from(b, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Mask a token for logging (show first 3 and last 3 chars)
 * @param {string} token - Token to mask
 * @returns {string} Masked token like "abc...xyz"
 */
export function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return `${token.slice(0, 3)}...${token.slice(-3)}`;
}
