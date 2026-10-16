/**
 * Security check for new members in secure mode
 *
 * This is a simple heuristic-based check that looks for suspicious patterns
 * in member names and initial context. In a real-world scenario, this could
 * be enhanced with ML-based detection, reputation systems, etc.
 */

const SUSPICIOUS_PATTERNS = [
  /script/i,
  /hack/i,
  /exploit/i,
  /inject/i,
  /admin/i,
  /root/i,
  /system/i,
  /<[^>]*>/,  // HTML tags
  /javascript:/i,
  /eval\(/i,
  /exec\(/i
];

/**
 * Check if a member name or context seems suspicious
 * @param {string} name - Member name
 * @param {string} context - Optional context string
 * @returns {'normal'|'suspect'|'quarantine'}
 */
export function checkMemberContext(name, context = '') {
  const combined = `${name} ${context}`.toLowerCase();

  let suspicionScore = 0;

  // Check for suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(combined)) {
      suspicionScore += 2;
    }
  }

  // Check for unusual length (very short or very long names)
  if (name.length < 2 || name.length > 100) {
    suspicionScore += 1;
  }

  // Check for excessive special characters
  const specialChars = (name.match(/[^a-zA-Z0-9\s-_]/g) || []).length;
  if (specialChars > 3) {
    suspicionScore += 1;
  }

  // Determine status based on score
  if (suspicionScore >= 3) {
    return 'quarantine';
  } else if (suspicionScore >= 1) {
    return 'suspect';
  }

  return 'normal';
}
