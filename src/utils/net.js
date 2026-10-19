import net from 'net';

/**
 * True if the address is a loopback IP (v4, v6, or v4-mapped v6).
 */
export function isLoopbackIp(ip) {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/i, '');
  return v === '::1' || v.startsWith('127.');
}

/**
 * True if the request comes straight from the host itself: real socket address is loopback
 * and no proxy header is present (a request relayed by a proxy is never "from the host").
 */
export function isDirectLocalRequest(req) {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['forwarded'] !== undefined) return false;
  return isLoopbackIp(req.socket && req.socket.remoteAddress);
}

/**
 * True if the hostname targets this machine or a private/internal network.
 * Only literal IPs and well-known local names are inspected (no DNS resolution).
 */
export function isPrivateHost(hostname) {
  if (!hostname) return true;
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !net.isIP(h)) {
    return true;
  }
  h = h.replace(/^::ffff:/, '');
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return false;
}
