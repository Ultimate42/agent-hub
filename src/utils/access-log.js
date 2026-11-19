import { config } from '../config.js';
import { logger } from './logger.js';

// Access log of the HTTP server. Most requests are routine (agents long-polling their rooms every
// few seconds): one line each drowned the system journal. What stays visible:
//  - successful requests at config.httpLogLevel (debug by default);
//  - every 5xx at error;
//  - the first 4xx of each (route, status, ip) per window at warn, its repeats counted;
//  - one 'HTTP summary' line per window at info: requests by status class, the most repeated
//    4xx (route, status, ip, count), number of 5xx. A client stuck on a refusal is thus seen once
//    as it starts, then hour after hour in the summary, instead of 700 identical lines an hour.

const MAX_KEYS = 1000; // distinct 4xx kinds tracked per window (scanners); beyond, counted as "other"

export function routeKey(method, url) {
  const path = String(url).split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:n');
  return `${method} ${path}`;
}

export function createAccessLog({ log = logger, okLevel = config.httpLogLevel, summaryMs = config.httpLogSummaryMs, now = Date.now } = {}) {
  const fresh = (t) => ({ start: t, total: 0, byClass: {}, clientErrors: new Map(), otherClientErrors: 0, serverErrors: 0 });
  let win = fresh(now());

  function flush(t = now()) {
    if (win.total) {
      const top = [...win.clientErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([kind, count]) => ({ kind, count }));
      log.info('HTTP summary', {
        since: new Date(win.start).toISOString(), requests: win.total, by_status: win.byClass,
        client_errors: top, ...(win.otherClientErrors ? { other_client_errors: win.otherClientErrors } : {}),
        server_errors: win.serverErrors,
      });
    }
    win = fresh(t);
  }

  function record({ method, url, status, duration, ip }) {
    const t = now();
    if (summaryMs > 0 && t - win.start >= summaryMs) flush(t);
    const cls = `${Math.floor(status / 100)}xx`;
    win.total++;
    win.byClass[cls] = (win.byClass[cls] || 0) + 1;
    const data = { method, url, status, duration, ip };
    if (status >= 500) { win.serverErrors++; log.error('HTTP request', data); return; }
    if (status >= 400) {
      if (!(summaryMs > 0)) { log.warn('HTTP request', data); return; } // no summary: nothing may be folded
      const kind = `${routeKey(method, url)} ${status} ${ip}`;
      const seen = win.clientErrors.get(kind);
      if (seen === undefined && win.clientErrors.size >= MAX_KEYS) { win.otherClientErrors++; log.debug('HTTP request', data); return; }
      win.clientErrors.set(kind, (seen || 0) + 1);
      if (!seen) log.warn('HTTP request', { ...data, repeats: 'counted in the next HTTP summary' });
      else log.debug('HTTP request', data);
      return;
    }
    log[okLevel]('HTTP request', data);
  }

  return { record, flush };
}
