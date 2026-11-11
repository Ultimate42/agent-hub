import path from 'path';
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, statSync, rmSync } from 'fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// RE-USE worker schedules: when a machine may be given jobs
// ---------------------------------------------------------------------------
// A machine that is someone's desktop only works at agreed hours. The schedule is data, not code:
// <reuseDir>/schedules.json, written by PUT /api/reuse/workers/:name/schedule or edited by hand (re-read
// when the file changes, no restart). A worker without an entry is always available.
//
//   { "gpu-box": { "timezone": "Europe/Paris",
//                 "days": { "mon": ["00:00-08:00", "20:00-08:00"], "tue": ["20:00-08:00"], ...,
//                           "fri": ["20:00-24:00"], "sat": ["00:00-24:00"], "sun": ["00:00-24:00"] } } }
//
// A range is "HH:MM-HH:MM" in the wall clock of the timezone, listed under the day it STARTS. When the end
// is not after the start, the range runs past midnight and ends the next day ("20:00-08:00" under "mon" =
// Monday 19:00 to Tuesday 09:00). "24:00" is the end of the day. A day without ranges is closed.
// Everything is computed on the wall clock, so summer/winter time needs no care: 19:00 is 19:00 local.

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RANGE = /^([01]\d|2[0-4]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;
const DAY_MIN = 24 * 60;

const formatters = new Map();
const computed = new WeakMap(); // schedule object -> {from, until, state}: see windowState
function formatter(timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
    }));
  }
  return formatters.get(timezone);
}

/** Wall clock of an instant in a timezone: {year, month, day, dow (0 = Sunday), minutes (since midnight), second}. */
export function wallClock(timezone, at) {
  const p = {};
  for (const part of formatter(timezone).formatToParts(new Date(at))) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    dow: DAYS.indexOf(p.weekday.toLowerCase()),
    minutes: Number(p.hour) * 60 + Number(p.minute), second: Number(p.second)
  };
}

/** [{start, end}] in minutes for one "HH:MM-HH:MM" (end <= start: runs into the next day), or null. */
function parseRange(text) {
  const m = RANGE.exec(String(text).trim());
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start >= DAY_MIN || end > DAY_MIN || start === end) return null; // "24:00-..." and empty ranges mean nothing
  return { start, end };
}

/**
 * Check a schedule and return it in its canonical form: {ok, schedule: {timezone, days: {mon: [...], ...}}}
 * or {ok: false, error}. Unknown keys are refused rather than ignored: a typo ("monday") must not
 * silently close or open a day.
 */
export function normalizeSchedule(input) {
  const bad = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Expected {timezone, days: {mon: ["20:00-08:00"], ...}}');
  for (const k of Object.keys(input)) if (k !== 'timezone' && k !== 'days') return bad(`Unknown key "${k}" (expected timezone, days)`);
  const timezone = input.timezone;
  if (typeof timezone !== 'string' || !timezone) return bad('timezone is required (for example "Europe/Paris")');
  try { formatter(timezone); } catch { return bad(`Unknown timezone "${timezone.slice(0, 60)}"`); }
  if (!input.days || typeof input.days !== 'object' || Array.isArray(input.days)) return bad('days must be an object keyed by sun, mon, tue, wed, thu, fri, sat');
  const days = {};
  for (const [day, ranges] of Object.entries(input.days)) {
    if (!DAYS.includes(day)) return bad(`Unknown day "${day.slice(0, 20)}" (expected sun, mon, tue, wed, thu, fri, sat)`);
    if (!Array.isArray(ranges) || ranges.length > 12) return bad(`days.${day} must be a list of at most 12 ranges`);
    for (const r of ranges) {
      if (typeof r !== 'string' || !parseRange(r)) return bad(`days.${day}: "${String(r).slice(0, 20)}" is not a range like "20:00-08:00" (24:00 = end of day)`);
    }
    if (ranges.length) days[day] = ranges.map(r => r.trim());
  }
  const ordered = {};
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) if (days[d]) ordered[d] = days[d];
  return { ok: true, schedule: { timezone, days: ordered } };
}

const rangesOf = (schedule, dow) => (schedule.days[DAYS[dow]] || []).map(parseRange);

/** Is this instant inside the schedule? No schedule = always. */
export function inWindow(schedule, at = Date.now()) {
  if (!schedule) return true;
  const { dow, minutes } = wallClock(schedule.timezone, at);
  for (const r of rangesOf(schedule, dow)) {
    if (r.end > r.start ? (minutes >= r.start && minutes < r.end) : minutes >= r.start) return true;
  }
  // Tail of a range started yesterday and running past midnight
  for (const r of rangesOf(schedule, (dow + 6) % 7)) {
    if (r.end <= r.start && minutes < r.end) return true;
  }
  return false;
}

/**
 * Instants at which a wall-clock time happens in a timezone. One in general; two when clocks go back (the
 * hour is lived twice); when clocks go forward the skipped time maps to the instant the clock jumps.
 */
function wallToInstants(timezone, year, month, day, minutes) {
  const asUtc = Date.UTC(year, month - 1, day, 0, minutes); // day and minutes may overflow: Date.UTC carries
  const offsetAt = (t) => {
    const w = wallClock(timezone, t);
    return Date.UTC(w.year, w.month - 1, w.day, 0, w.minutes, w.second) - Math.floor(t / 1000) * 1000;
  };
  const found = new Set();
  for (const probe of [asUtc - 24 * 3600 * 1000, asUtc + 24 * 3600 * 1000]) found.add(asUtc - offsetAt(probe));
  return [...found];
}

/**
 * {in_window, next_window_start, next_window_end} (ISO strings or null).
 * Inside a window: next_window_end is when it closes, next_window_start when the following one opens.
 * Outside: next_window_start is when the next one opens, next_window_end when that one closes.
 * No schedule, or a schedule that never changes state (always open, never open): both null.
 */
export function windowState(schedule, at = Date.now()) {
  const now = Number(at);
  if (!schedule) return { in_window: true, next_window_start: null, next_window_end: null };
  // The answer holds until the next change: computed once per change, not once per request
  const known = computed.get(schedule);
  if (known && now >= known.from && now < known.until) return { ...known.state };
  const open = inWindow(schedule, now);
  const state = { in_window: open, next_window_start: null, next_window_end: null };
  // Every boundary of the schedule over the coming two weeks, as instants. They are only probes: the real
  // changes are read off inWindow itself (bisection between two probes that disagree), so the announced
  // times can never disagree with what the queue does, clock changes included.
  const probes = new Set();
  for (let offset = -1; offset <= 15; offset++) {
    const day = wallClock(schedule.timezone, now + offset * 24 * 3600 * 1000);
    for (const r of rangesOf(schedule, day.dow)) {
      for (const minutes of [r.start, r.end > r.start ? r.end : r.end + DAY_MIN]) {
        for (const t of wallToInstants(schedule.timezone, day.year, day.month, day.day, minutes)) probes.add(t);
      }
    }
  }
  const opens = [];
  const closes = [];
  let before = now;
  let was = open;
  for (const probe of [...probes].filter(t => t > now).sort((a, b) => a - b)) {
    const is = inWindow(schedule, probe);
    if (is !== was) {
      let lo = before; // state "was"
      let hi = probe;  // state "is"
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (inWindow(schedule, mid) === is) hi = mid; else lo = mid;
      }
      (is ? opens : closes).push(hi);
      was = is;
    }
    before = probe;
  }
  const iso = (t) => (t === undefined ? null : new Date(t).toISOString());
  if (open) {
    state.next_window_end = iso(closes[0]);
    state.next_window_start = iso(opens.find(t => t > (closes[0] ?? Infinity)));
  } else {
    state.next_window_start = iso(opens[0]);
    state.next_window_end = iso(closes.find(t => t > (opens[0] ?? Infinity)));
  }
  computed.set(schedule, { from: now, until: Math.min(opens[0] ?? Infinity, closes[0] ?? Infinity, now + 3600 * 1000), state });
  return { ...state };
}

// ---------------------------------------------------------------------------
// Storage: <reuseDir>/schedules.json (+ schedules.log.jsonl, one line per change, so a change can be undone)
// ---------------------------------------------------------------------------
const schedulesFile = () => path.join(config.reuseDir, 'schedules.json');
const journalFile = () => path.join(config.reuseDir, 'schedules.log.jsonl');
let cache = { stamp: null, entries: new Map(), fileError: null };

/**
 * Map name -> {schedule} | {error}. Re-read when the file changes. An entry that cannot be understood keeps
 * its worker CLOSED (and says why in GET /api/reuse/workers): a typo made by hand must not make a desktop
 * PC compute in the middle of the day. Same when the whole file is unreadable: every worker is closed
 * until it is repaired, which is visible at once, rather than every worker open.
 */
function load() {
  let stamp;
  try {
    const s = statSync(schedulesFile());
    stamp = `${s.size}:${s.mtimeMs}:${s.ino}`;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      stamp = `unreadable:${e.code}`;
      if (cache.stamp !== stamp) {
        logger.error('RE-USE schedules: file cannot be read, every worker is closed until it is repaired', { error: e.code });
        cache = { stamp, entries: new Map(), fileError: `schedules.json cannot be read (${e.code})` };
      }
      return cache;
    }
    stamp = 'none';
  }
  if (stamp === cache.stamp) return cache;
  const entries = new Map();
  let fileError = null;
  if (stamp !== 'none') {
    try {
      const parsed = JSON.parse(readFileSync(schedulesFile(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object keyed by worker name');
      for (const [name, value] of Object.entries(parsed)) {
        const checked = normalizeSchedule(value);
        if (checked.ok) entries.set(name, { schedule: checked.schedule });
        else {
          entries.set(name, { error: checked.error });
          logger.error('RE-USE schedules: invalid entry, this worker is closed until it is repaired', { worker: name, error: checked.error });
        }
      }
    } catch (e) {
      fileError = `schedules.json is not valid (${e.message.slice(0, 120)})`;
      logger.error('RE-USE schedules: file is not valid, every worker is closed until it is repaired', { error: e.message });
    }
  }
  cache = { stamp, entries, fileError };
  return cache;
}

/**
 * What the queue and the admin view need for one worker:
 * {schedule: {...}|null, in_window, next_window_start, next_window_end[, schedule_error]}.
 */
export function workerWindow(name, at = Date.now()) {
  const { entries, fileError } = load();
  const entry = entries.get(name);
  const error = fileError || entry?.error;
  if (error) return { schedule: null, in_window: false, next_window_start: null, next_window_end: null, schedule_error: error };
  const schedule = entry?.schedule || null;
  return { schedule, ...windowState(schedule, at) };
}

/** Cheap form for the claim path (no next-window computation). */
export function workerInWindow(name, at = Date.now()) {
  const { entries, fileError } = load();
  const entry = entries.get(name);
  if (fileError || entry?.error) return false;
  return inWindow(entry?.schedule || null, at);
}

function save(mutate, journal) {
  const file = schedulesFile();
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // Never rewrite a file we could not understand: the entries of the other workers would be lost
    if (e.code !== 'ENOENT') return { ok: false, status: 409, error: 'schedules.json on the hub is not valid JSON: repair it by hand first' };
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return { ok: false, status: 409, error: 'schedules.json on the hub is not an object keyed by worker name: repair it by hand first' };
  }
  const previous = current[journal.worker] ?? null;
  mutate(current);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    appendFileSync(journalFile(), `${JSON.stringify({ at: new Date().toISOString(), ...journal, previous })}\n`);
  } catch (e) {
    logger.warn('RE-USE schedules: change applied but not journaled', { error: e.message });
  }
  logger.info('RE-USE worker schedule changed', { worker: journal.worker, action: journal.action });
  return { ok: true };
}

/** Set the schedule of one worker (validated first). */
export function setWorkerSchedule(name, input) {
  const checked = normalizeSchedule(input);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const saved = save((all) => { all[name] = checked.schedule; }, { worker: name, action: 'set', schedule: checked.schedule });
  return saved.ok ? { ok: true, worker: name, ...workerWindow(name) } : saved;
}

/** Remove the schedule of one worker: it becomes always available again. */
export function clearWorkerSchedule(name) {
  const saved = save((all) => { delete all[name]; }, { worker: name, action: 'clear', schedule: null });
  return saved.ok ? { ok: true, worker: name, ...workerWindow(name) } : saved;
}
