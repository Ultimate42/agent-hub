import path from 'node:path';

/**
 * Validate a file wake-target directory path (pure, cross-platform).
 * Absolute only, no NUL, no '..' segment (either separator). `lib` lets tests
 * inject path.win32 / path.posix.
 */
export function isValidWakeFilePath(p, lib = path) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false;
  if (!lib.isAbsolute(p)) return false;
  const hasDotDot = (s) => s.split(/[\\/]+/).includes('..');
  return !hasDotDot(p) && !hasDotDot(lib.normalize(p));
}
