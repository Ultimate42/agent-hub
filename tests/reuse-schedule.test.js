import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Worker schedules of the RE-USE queue (src/services/reuse-schedule.js): pure window arithmetic on the
// wall clock of a timezone, then the file the hub reads them from. The refusal to serve a job outside
// the window is tested against a real hub in reuse-queue.test.js.

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reuse-schedule-'));
process.env.DB_PATH = path.join(TMP_DIR, 'hub.db');
process.env.HUB_REUSE_DIR = path.join(TMP_DIR, 'reuse');
const FILE = path.join(TMP_DIR, 'reuse', 'schedules.json');

let S;
before(async () => { S = await import('../src/services/reuse-schedule.js'); });
after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

// Alice's AMD desktop: weekdays 19:00 to 09:00 the next morning, and the whole weekend
// (Friday 19:00 to Monday 09:00), Paris time.
const PC_AMD = {
  timezone: 'Europe/Paris',
  days: {
    mon: ['00:00-08:00', '20:00-08:00'], tue: ['20:00-08:00'], wed: ['20:00-08:00'], thu: ['20:00-08:00'],
    fri: ['20:00-24:00'], sat: ['00:00-24:00'], sun: ['00:00-24:00']
  }
};
/** Paris wall time written with its UTC offset, so each case states the local time it is about. */
const at = (iso) => Date.parse(iso);
const open = (iso, schedule = PC_AMD) => S.inWindow(schedule, at(iso));

describe('RE-USE schedule: window arithmetic', () => {
  test('weekday evening to next morning: the range passes midnight', () => {
    // Wednesday 11 November 2026 (winter time, +01:00)
    assert.strictEqual(open('2026-11-11T15:32:00+01:00'), false, 'afternoon');
    assert.strictEqual(open('2026-11-11T18:59:59+01:00'), false, 'one second before');
    assert.strictEqual(open('2026-11-11T19:00:00+01:00'), true, 'opens at 19:00 sharp');
    assert.strictEqual(open('2026-11-11T23:59:59+01:00'), true);
    assert.strictEqual(open('2026-11-12T00:00:00+01:00'), true, 'midnight: still the range started on Wednesday');
    assert.strictEqual(open('2026-11-12T08:59:59+01:00'), true);
    assert.strictEqual(open('2026-11-12T09:00:00+01:00'), false, 'closes at 09:00 sharp');
    assert.strictEqual(open('2026-11-12T12:00:00+01:00'), false);
  });

  test('weekend: open from Friday 19:00 to Monday 09:00 without a gap', () => {
    assert.strictEqual(open('2026-11-13T18:59:00+01:00'), false, 'Friday before 19:00');
    assert.strictEqual(open('2026-11-13T19:00:00+01:00'), true);
    for (const t of ['2026-11-14T00:00:00+01:00', '2026-11-14T09:00:00+01:00', '2026-11-14T14:00:00+01:00', '2026-11-14T23:59:59+01:00',
      '2026-11-15T00:00:00+01:00', '2026-11-15T09:30:00+01:00', '2026-11-15T23:59:59+01:00', '2026-11-16T00:00:00+01:00', '2026-11-16T08:59:59+01:00']) {
      assert.strictEqual(open(t), true, t);
    }
    assert.strictEqual(open('2026-11-16T09:00:00+01:00'), false, 'Monday 09:00');
    assert.strictEqual(open('2026-11-16T19:00:00+01:00'), true, 'Monday evening');
    // Every minute from Friday 19:00 to Monday 09:00 (62 hours)
    for (let t = at('2026-11-13T19:00:00+01:00'); t < at('2026-11-16T09:00:00+01:00'); t += 60 * 1000) {
      if (!S.inWindow(PC_AMD, t)) assert.fail(`closed at ${new Date(t).toISOString()}`);
    }
  });

  test('next window: start and end, outside and inside a window', () => {
    const outside = S.windowState(PC_AMD, at('2026-11-11T15:32:00+01:00'));
    assert.deepStrictEqual(outside, {
      in_window: false, next_window_start: '2026-11-11T18:00:00.000Z', next_window_end: '2026-11-12T08:00:00.000Z'
    });
    // Inside: the end is the end of the current window, the start is the opening of the following one
    const inside = S.windowState(PC_AMD, at('2026-11-11T22:00:00+01:00'));
    assert.deepStrictEqual(inside, {
      in_window: true, next_window_start: '2026-11-12T18:00:00.000Z', next_window_end: '2026-11-12T08:00:00.000Z'
    });
    const friday = S.windowState(PC_AMD, at('2026-11-13T12:00:00+01:00'));
    assert.strictEqual(friday.next_window_start, '2026-11-13T18:00:00.000Z');
    assert.strictEqual(friday.next_window_end, '2026-11-16T08:00:00.000Z', 'the weekend is one window');
    const sunday = S.windowState(PC_AMD, at('2026-11-15T12:00:00+01:00'));
    assert.strictEqual(sunday.next_window_end, '2026-11-16T08:00:00.000Z');
    assert.strictEqual(sunday.next_window_start, '2026-11-16T18:00:00.000Z');
    // Asked again one minute later (the answer is kept until the next change): same boundaries
    assert.deepStrictEqual(S.windowState(PC_AMD, at('2026-11-15T12:01:00+01:00')), sunday);
    // ... and the state flips at the boundary even though an answer was kept
    assert.strictEqual(S.windowState(PC_AMD, at('2026-11-16T09:00:00+01:00')).in_window, false);
  });

  test('the announced boundaries are exactly where the queue changes its mind', () => {
    for (const now of ['2026-11-09T03:00:00+01:00', '2026-11-11T15:32:00+01:00', '2026-11-14T10:00:00+01:00', '2027-03-26T12:00:00+01:00', '2026-10-23T12:00:00+02:00']) {
      const state = S.windowState(PC_AMD, at(now));
      for (const [key, opens] of [['next_window_start', true], ['next_window_end', false]]) {
        const t = Date.parse(state[key]);
        assert.strictEqual(S.inWindow(PC_AMD, t), opens, `${now} ${key}`);
        assert.strictEqual(S.inWindow(PC_AMD, t - 1), !opens, `${now} ${key} - 1 ms`);
      }
    }
  });

  test('summer time (clocks forward, Sunday 28 March 2027): hours stay local', () => {
    // Friday 26 March is still winter time (+01:00): 19:00 local = 18:00 UTC
    assert.strictEqual(open('2027-03-26T18:59:00+01:00'), false);
    assert.strictEqual(open('2027-03-26T19:00:00+01:00'), true);
    // The night of the change is inside the weekend window, before and after the jump (02:00 -> 03:00)
    assert.strictEqual(open('2027-03-28T01:59:00+01:00'), true);
    assert.strictEqual(open('2027-03-28T03:00:00+02:00'), true);
    // Monday 29 March is summer time (+02:00): closes at 09:00 local = 07:00 UTC, not 08:00 UTC
    assert.strictEqual(open('2027-03-29T08:59:00+02:00'), true);
    assert.strictEqual(open('2027-03-29T09:00:00+02:00'), false);
    assert.strictEqual(S.inWindow(PC_AMD, Date.parse('2027-03-29T07:30:00Z')), false, '09:30 local: closed');
    assert.strictEqual(open('2027-03-29T19:00:00+02:00'), true, 'opens at 19:00 local = 17:00 UTC');
    assert.strictEqual(S.inWindow(PC_AMD, Date.parse('2027-03-29T16:59:00Z')), false);
    const state = S.windowState(PC_AMD, at('2027-03-27T12:00:00+01:00'));
    assert.strictEqual(state.next_window_end, '2027-03-29T07:00:00.000Z');
    assert.strictEqual(state.next_window_start, '2027-03-29T17:00:00.000Z');
  });

  test('winter time (clocks back, Sunday 25 October 2026): hours stay local', () => {
    // Friday 23 October is summer time (+02:00): 19:00 local = 17:00 UTC
    assert.strictEqual(open('2026-10-23T18:59:00+02:00'), false);
    assert.strictEqual(open('2026-10-23T19:00:00+02:00'), true);
    // 02:30 happens twice that night: open both times
    assert.strictEqual(open('2026-10-25T02:30:00+02:00'), true);
    assert.strictEqual(open('2026-10-25T02:30:00+01:00'), true);
    // Monday 26 October is winter time (+01:00): closes at 09:00 local = 08:00 UTC, not 07:00 UTC
    assert.strictEqual(S.inWindow(PC_AMD, Date.parse('2026-10-26T07:30:00Z')), true, '08:30 local: still open');
    assert.strictEqual(open('2026-10-26T09:00:00+01:00'), false);
    const state = S.windowState(PC_AMD, at('2026-10-24T12:00:00+02:00'));
    assert.strictEqual(state.next_window_end, '2026-10-26T08:00:00.000Z');
    assert.strictEqual(state.next_window_start, '2026-10-26T18:00:00.000Z');
    // A weekday night across the change of offset is 14 hours long on the wall clock, 15 hours of real time on that Sunday only
    const weekday = S.windowState(PC_AMD, at('2026-10-27T12:00:00+01:00'));
    assert.strictEqual(Date.parse(weekday.next_window_end) - Date.parse(weekday.next_window_start), 14 * 3600 * 1000);
  });

  test('a boundary that falls in the skipped or the repeated hour is still announced where the state changes', () => {
    const night = { timezone: 'Europe/Paris', days: { sun: ['02:30-05:00'] } };
    // 28 March 2027: 02:30 does not exist; the window opens when the clock jumps to 03:00 (01:00 UTC)
    const gap = S.windowState(night, at('2027-03-27T12:00:00+01:00'));
    assert.strictEqual(gap.next_window_start, '2027-03-28T01:00:00.000Z');
    assert.strictEqual(gap.next_window_end, '2027-03-28T03:00:00.000Z');
    // 25 October 2026: 02:30 happens twice; the window opens at the first one (00:30 UTC)
    const fold = S.windowState(night, at('2026-10-24T12:00:00+02:00'));
    assert.strictEqual(fold.next_window_start, '2026-10-25T00:30:00.000Z');
    assert.strictEqual(fold.next_window_end, '2026-10-25T04:00:00.000Z');
  });

  test('no schedule = always open; schedules that never change state announce no boundary', () => {
    assert.deepStrictEqual(S.windowState(null, at('2026-11-11T15:32:00+01:00')), { in_window: true, next_window_start: null, next_window_end: null });
    const always = { timezone: 'Europe/Paris', days: Object.fromEntries(S.DAYS.map(d => [d, ['00:00-24:00']])) };
    assert.deepStrictEqual(S.windowState(always, at('2026-11-11T15:32:00+01:00')), { in_window: true, next_window_start: null, next_window_end: null });
    const never = { timezone: 'Europe/Paris', days: {} };
    assert.deepStrictEqual(S.windowState(never, at('2026-11-11T15:32:00+01:00')), { in_window: false, next_window_start: null, next_window_end: null });
  });

  test('another timezone: the same instant is judged on that wall clock', () => {
    const tokyo = { timezone: 'Asia/Tokyo', days: { thu: ['00:00-01:00'] } };
    assert.strictEqual(S.inWindow(tokyo, at('2026-11-11T16:30:00+01:00')), true, 'Thursday 00:30 in Tokyo');
    assert.strictEqual(S.inWindow({ ...tokyo, timezone: 'Europe/Paris' }, at('2026-11-11T16:30:00+01:00')), false);
  });

  test('validation: canonical form, and a clear refusal for anything else', () => {
    const ok = S.normalizeSchedule({ timezone: 'Europe/Paris', days: { sun: [' 00:00-24:00 '], mon: ['20:00-08:00'], tue: [] } });
    assert.deepStrictEqual(ok, { ok: true, schedule: { timezone: 'Europe/Paris', days: { mon: ['20:00-08:00'], sun: ['00:00-24:00'] } } });
    const refused = [
      null, [], 'night', {}, { timezone: 'Europe/Paris' }, { timezone: 'Mars/Olympus', days: {} }, { timezone: 'Europe/Paris', days: [] },
      { timezone: 'Europe/Paris', days: { monday: ['20:00-08:00'] } }, { timezone: 'Europe/Paris', days: { mon: '20:00-08:00' } },
      { timezone: 'Europe/Paris', days: { mon: ['19h-9h'] } }, { timezone: 'Europe/Paris', days: { mon: ['25:00-09:00'] } },
      { timezone: 'Europe/Paris', days: { mon: ['19:00-24:30'] } }, { timezone: 'Europe/Paris', days: { mon: ['24:00-09:00'] } },
      { timezone: 'Europe/Paris', days: { mon: ['09:00-09:00'] } }, { timezone: 'Europe/Paris', days: { mon: [900] } },
      { timezone: 'Europe/Paris', days: {}, pause: true }
    ];
    for (const input of refused) {
      const r = S.normalizeSchedule(input);
      assert.strictEqual(r.ok, false, JSON.stringify(input));
      assert.ok(r.error.length > 10);
    }
  });
});

describe('RE-USE schedule: the file the hub reads', () => {
  const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

  test('no file: every worker is always available', () => {
    assert.strictEqual(S.workerInWindow('gpu-box'), true);
    assert.deepStrictEqual(S.workerWindow('gpu-box'), { schedule: null, in_window: true, next_window_start: null, next_window_end: null });
  });

  test('set, read back, clear; each change is journaled with the previous value', () => {
    const closed = at('2026-11-11T15:32:00+01:00');
    const set = S.setWorkerSchedule('gpu-box', PC_AMD);
    assert.strictEqual(set.ok, true);
    assert.deepStrictEqual(read(), { 'gpu-box': PC_AMD });
    assert.strictEqual(S.workerInWindow('gpu-box', closed), false);
    assert.strictEqual(S.workerInWindow('gpu-box', at('2026-11-11T19:00:00+01:00')), true);
    assert.strictEqual(S.workerInWindow('dev-box', closed), true, 'a worker without an entry is not concerned');
    const view = S.workerWindow('gpu-box', closed);
    assert.deepStrictEqual(view.schedule, PC_AMD);
    assert.strictEqual(view.in_window, false);
    assert.strictEqual(view.next_window_start, '2026-11-11T18:00:00.000Z');

    assert.strictEqual(S.setWorkerSchedule('gpu-box', { timezone: 'Europe/Paris', days: { mon: ['nope'] } }).status, 400);
    assert.deepStrictEqual(read(), { 'gpu-box': PC_AMD }, 'a refused schedule changes nothing');

    assert.strictEqual(S.clearWorkerSchedule('gpu-box').ok, true);
    assert.deepStrictEqual(read(), {});
    assert.strictEqual(S.workerInWindow('gpu-box', closed), true);
    const journal = fs.readFileSync(path.join(TMP_DIR, 'reuse', 'schedules.log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(journal.map(l => [l.worker, l.action]), [['gpu-box', 'set'], ['gpu-box', 'clear']]);
    assert.strictEqual(journal[0].previous, null);
    assert.deepStrictEqual(journal[1].previous, PC_AMD, 'enough to put it back');
  });

  test('a file edited by hand is taken at once; an entry with a typo closes that worker only, and says why', () => {
    fs.writeFileSync(FILE, JSON.stringify({ 'gpu-box': { timezone: 'Europe/Paris', days: { monday: ['20:00-08:00'] } }, 'dev-box': { timezone: 'Europe/Paris', days: { wed: ['00:00-24:00'] } } }));
    const wednesday = at('2026-11-11T15:32:00+01:00');
    assert.strictEqual(S.workerInWindow('gpu-box', wednesday), false);
    const view = S.workerWindow('gpu-box', wednesday);
    assert.strictEqual(view.in_window, false);
    assert.match(view.schedule_error, /Unknown day "monday"/);
    assert.strictEqual(S.workerInWindow('dev-box', wednesday), true);
    assert.strictEqual(S.workerInWindow('other', wednesday), true);
  });

  test('an unreadable file closes every worker until it is repaired, and is never overwritten', () => {
    fs.writeFileSync(FILE, '{ "gpu-box": ');
    assert.strictEqual(S.workerInWindow('gpu-box'), false);
    assert.strictEqual(S.workerInWindow('dev-box'), false);
    assert.match(S.workerWindow('dev-box').schedule_error, /not valid/);
    assert.strictEqual(S.setWorkerSchedule('gpu-box', PC_AMD).status, 409);
    assert.strictEqual(fs.readFileSync(FILE, 'utf8'), '{ "gpu-box": ', 'left as it was for a human to repair');
    fs.writeFileSync(FILE, '{}\n');
    assert.strictEqual(S.workerInWindow('dev-box'), true, 'repaired: open again without a restart');
  });
});
