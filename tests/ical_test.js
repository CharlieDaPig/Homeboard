'use strict';
// Unit tests for lib/ical.js (the RRULE/iCal engine). Plain node, no test framework, no network.
// Run with:  node tests/ical_test.js
const assert = require('assert');
const path = require('path');
const { parseIcs } = require(path.join(__dirname, '..', 'homeboard', 'lib', 'ical.js'));

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL - ${name}`);
    console.log(`  ${err.message}`);
  }
}

const HEAD = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//test//EN\nCALSCALE:GREGORIAN\n';
const TAIL = 'END:VCALENDAR\n';
const ics = (body) => HEAD + body + TAIL;
const win = (s, e) => ({ windowStart: new Date(s), windowEnd: new Date(e) });

function titles(res) {
  return res.events.map((e) => e.title).sort();
}
function starts(res) {
  return res.events.map((e) => e.start).sort();
}

// ---------------------------------------------------------------- basics

test('rejects a non-ICS body with a friendly message', () => {
  assert.throws(() => parseIcs('<html>not a calendar</html>', win('2026-01-01', '2026-02-01')), /did not return a calendar/);
});

test('single all-day event inside the window', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART;VALUE=DATE:20260315\nDTEND;VALUE=DATE:20260316\nSUMMARY:Trash day\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].allDay, true);
  assert.strictEqual(r.events[0].start, '2026-03-15');
  assert.strictEqual(r.events[0].end, '2026-03-16');
});

test('multi-day all-day event spans the right days', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART;VALUE=DATE:20260310\nDTEND;VALUE=DATE:20260313\nSUMMARY:Conference\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events[0].start, '2026-03-10');
  assert.strictEqual(r.events[0].end, '2026-03-13'); // exclusive: 10, 11, 12
});

test('UTC timed event', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260315T140000Z\nDTEND:20260315T150000Z\nSUMMARY:Standup\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events[0].start, '2026-03-15T14:00:00.000Z');
  assert.strictEqual(r.events[0].end, '2026-03-15T15:00:00.000Z');
});

test('floating time event uses this machine\'s own zone', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260315T090000\nDTEND:20260315T100000\nSUMMARY:Floating\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  const expect = new Date(2026, 2, 15, 9, 0, 0).toISOString();
  assert.strictEqual(r.events[0].start, expect);
});

test('DURATION used when DTEND is absent', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260315T090000Z\nDURATION:PT1H30M\nSUMMARY:Meeting\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events[0].start, '2026-03-15T09:00:00.000Z');
  assert.strictEqual(r.events[0].end, '2026-03-15T10:30:00.000Z');
});

test('no DTEND and no DURATION: all-day defaults to one day, timed defaults to zero-length', () => {
  const allDay = ics('BEGIN:VEVENT\nUID:1\nDTSTART;VALUE=DATE:20260315\nSUMMARY:X\nEND:VEVENT\n');
  const r1 = parseIcs(allDay, win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r1.events[0].end, '2026-03-16');
  const timed = ics('BEGIN:VEVENT\nUID:1\nDTSTART:20260315T090000Z\nSUMMARY:X\nEND:VEVENT\n');
  const r2 = parseIcs(timed, win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r2.events[0].start, r2.events[0].end);
});

test('line folding and text escapes are decoded', () => {
  const body = 'BEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260315T090000Z\r\nDTEND:20260315T100000Z\r\nSUMMARY:Comma\\, semi\\; and a\\nnewline plus a fol\r\n ded word\r\nEND:VEVENT\r\n';
  const r = parseIcs(HEAD.replace(/\n/g, '\r\n') + body + TAIL.replace(/\n/g, '\r\n'), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events[0].title, 'Comma, semi; and a\nnewline plus a folded word');
});

test('STATUS:CANCELLED is dropped', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260315T090000Z\nDTEND:20260315T100000Z\nSTATUS:CANCELLED\nSUMMARY:Gone\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events.length, 0);
});

test('a declined invite is hidden when the self email matches, kept otherwise', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260315T090000Z\nDTEND:20260315T100000Z\nSUMMARY:Party\nATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com\nEND:VEVENT\n';
  const hidden = parseIcs(ics(body), { ...win('2026-03-01', '2026-04-01'), selfEmail: 'me@example.com' });
  assert.strictEqual(hidden.events.length, 0);
  const shown1 = parseIcs(ics(body), { ...win('2026-03-01', '2026-04-01'), selfEmail: 'someone-else@example.com' });
  assert.strictEqual(shown1.events.length, 1);
  const shown2 = parseIcs(ics(body), win('2026-03-01', '2026-04-01')); // no selfEmail: never filter
  assert.strictEqual(shown2.events.length, 1);
});

// ---------------------------------------------------------------- time zones / DST

test('TZID event keeps 9am local across a US spring-forward change (America/Chicago)', () => {
  // Weekly Tuesday 9am starting Mar 3 2026 (before the Mar 8 2026 change) through Mar 17 (after).
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART;TZID=America/Chicago:20260303T090000\nDTEND;TZID=America/Chicago:20260303T093000\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3\nSUMMARY:Standup\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  const s = starts(r);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(s[0], '2026-03-03T15:00:00.000Z'); // CST: UTC-6
  assert.strictEqual(s[1], '2026-03-10T14:00:00.000Z'); // CDT: UTC-5 (after Mar 8 change)
  assert.strictEqual(s[2], '2026-03-17T14:00:00.000Z');
});

// ---------------------------------------------------------------- RRULE: DAILY

test('DAILY with INTERVAL and COUNT', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260301T100000Z\nDTEND:20260301T110000Z\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=5\nSUMMARY:Every other day\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-01-01', '2026-12-01'));
  assert.deepStrictEqual(starts(r), [
    '2026-03-01T10:00:00.000Z', '2026-03-03T10:00:00.000Z', '2026-03-05T10:00:00.000Z',
    '2026-03-07T10:00:00.000Z', '2026-03-09T10:00:00.000Z',
  ]);
});

// ---------------------------------------------------------------- RRULE: WEEKLY

test('WEEKLY BYDAY with two weekdays, windowed', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260303T090000Z\nDTEND:20260303T100000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH\nSUMMARY:Class\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-03-15'));
  // Mar 3 (Tu), 5 (Th), 10 (Tu), 12 (Th)
  assert.deepStrictEqual(starts(r), ['2026-03-03T09:00:00.000Z', '2026-03-05T09:00:00.000Z', '2026-03-10T09:00:00.000Z', '2026-03-12T09:00:00.000Z']);
});

test('WEEKLY INTERVAL=2 WKST=SU BYDAY=TU,TH matches the RFC 5545 worked example', () => {
  // RFC 5545 section 3.3.10: DTSTART 19970902T090000 (a Tuesday), FREQ=WEEKLY;INTERVAL=2;COUNT=8;
  // WKST=SU;BYDAY=TU,TH ==> September 2,4,16,18,30; October 2,14,16. WKST only matters here because
  // BYDAY lists more than one weekday together with INTERVAL>1 (the RFC says so explicitly).
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:19970902T090000Z\nDTEND:19970902T100000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH\nSUMMARY:X\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('1997-09-01', '1997-11-01'));
  assert.deepStrictEqual(starts(r), [
    '1997-09-02T09:00:00.000Z', '1997-09-04T09:00:00.000Z', '1997-09-16T09:00:00.000Z', '1997-09-18T09:00:00.000Z',
    '1997-09-30T09:00:00.000Z', '1997-10-02T09:00:00.000Z', '1997-10-14T09:00:00.000Z', '1997-10-16T09:00:00.000Z',
  ]);
});

// ---------------------------------------------------------------- RRULE: MONTHLY

test('MONTHLY BYDAY=2TU (second Tuesday of every month)', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260113T140000Z\nDTEND:20260113T150000Z\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=4\nSUMMARY:Board meeting\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-01-01', '2026-12-01'));
  // Second Tuesdays of Jan, Feb, Mar, Apr 2026: Jan 13, Feb 10, Mar 10, Apr 14
  assert.deepStrictEqual(starts(r), ['2026-01-13T14:00:00.000Z', '2026-02-10T14:00:00.000Z', '2026-03-10T14:00:00.000Z', '2026-04-14T14:00:00.000Z']);
});

test('MONTHLY BYDAY=-1FR (last Friday of every month)', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260130T140000Z\nDTEND:20260130T150000Z\nRRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3\nSUMMARY:Payday\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-01-01', '2026-12-01'));
  // Last Fridays: Jan 30, Feb 27, Mar 27 2026
  assert.deepStrictEqual(starts(r), ['2026-01-30T14:00:00.000Z', '2026-02-27T14:00:00.000Z', '2026-03-27T14:00:00.000Z']);
});

test('MONTHLY BYMONTHDAY with a negative (from end of month) value', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260101T120000Z\nDTEND:20260101T130000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3\nSUMMARY:Rent\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-01-01', '2026-12-01'));
  // Last calendar day of Jan, Feb (2026 not leap -> 28), Mar
  assert.deepStrictEqual(starts(r), ['2026-01-31T12:00:00.000Z', '2026-02-28T12:00:00.000Z', '2026-03-31T12:00:00.000Z']);
});

test('MONTHLY BYDAY=MO,TU,WE,TH,FR BYSETPOS=-1 (last weekday of the month)', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260130T120000Z\nDTEND:20260130T130000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3\nSUMMARY:Last weekday\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-01-01', '2026-12-01'));
  // Jan 30 2026 is a Friday (last weekday of Jan); Feb 27 is a Friday; Mar 31 is a Tuesday.
  assert.deepStrictEqual(starts(r), ['2026-01-30T12:00:00.000Z', '2026-02-27T12:00:00.000Z', '2026-03-31T12:00:00.000Z']);
});

// ---------------------------------------------------------------- RRULE: YEARLY

test('YEARLY BYMONTH/BYMONTHDAY (a birthday) across the window', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART;VALUE=DATE:20200704\nDTEND;VALUE=DATE:20200705\nRRULE:FREQ=YEARLY;BYMONTH=7;BYMONTHDAY=4\nSUMMARY:Birthday\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-01-01', '2027-01-01'));
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].start, '2026-07-04');
});

test('UNTIL stops the recurrence', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260301T100000Z\nDTEND:20260301T110000Z\nRRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20260315T235959Z\nSUMMARY:X\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  // Sundays Mar 1, 8, 15 are <= UNTIL; Mar 22, 29 are not.
  assert.deepStrictEqual(starts(r), ['2026-03-01T10:00:00.000Z', '2026-03-08T10:00:00.000Z', '2026-03-15T10:00:00.000Z']);
});

// ---------------------------------------------------------------- EXDATE / RDATE / RECURRENCE-ID

test('EXDATE removes one generated instance', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260303T090000Z\nDTEND:20260303T100000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\nEXDATE:20260310T090000Z\nSUMMARY:Standup\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.deepStrictEqual(starts(r), ['2026-03-03T09:00:00.000Z', '2026-03-17T09:00:00.000Z', '2026-03-24T09:00:00.000Z']);
});

test('RDATE adds an extra one-off occurrence', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nDTSTART:20260303T090000Z\nDTEND:20260303T100000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2\nRDATE:20260305T090000Z\nSUMMARY:Standup\nEND:VEVENT\n';
  const r = parseIcs(ics(body), win('2026-03-01', '2026-04-01'));
  assert.deepStrictEqual(starts(r), ['2026-03-03T09:00:00.000Z', '2026-03-05T09:00:00.000Z', '2026-03-10T09:00:00.000Z']);
});

test('RECURRENCE-ID overrides one instance (moved + renamed) without duplicating it', () => {
  const body =
    'BEGIN:VEVENT\r\nUID:evt1\r\nDTSTART:20260303T090000Z\r\nDTEND:20260303T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:evt1\r\nRECURRENCE-ID:20260310T090000Z\r\nDTSTART:20260310T133000Z\r\nDTEND:20260310T140000Z\r\nSUMMARY:Standup (moved)\r\nEND:VEVENT\r\n';
  const r = parseIcs(HEAD.replace(/\n/g, '\r\n') + body + TAIL.replace(/\n/g, '\r\n'), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events.length, 4); // still four Tuesdays, not five
  const moved = r.events.find((e) => e.title === 'Standup (moved)');
  assert.ok(moved, 'the moved instance should be present');
  assert.strictEqual(moved.start, '2026-03-10T13:30:00.000Z');
  assert.ok(!r.events.some((e) => e.start === '2026-03-10T09:00:00.000Z'), 'the original slot must not also appear');
});

test('RECURRENCE-ID with STATUS:CANCELLED removes that one instance only', () => {
  const body =
    'BEGIN:VEVENT\r\nUID:evt1\r\nDTSTART:20260303T090000Z\r\nDTEND:20260303T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:evt1\r\nRECURRENCE-ID:20260310T090000Z\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T100000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n';
  const r = parseIcs(HEAD.replace(/\n/g, '\r\n') + body + TAIL.replace(/\n/g, '\r\n'), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events.length, 3);
  assert.ok(!r.events.some((e) => e.start === '2026-03-10T09:00:00.000Z'));
});

test('a moved instance can arrive into the window from outside it, with no leftover at the old slot', () => {
  // Base series is entirely in February (outside the March window); one instance is moved into March.
  const body =
    'BEGIN:VEVENT\r\nUID:evt1\r\nDTSTART:20260203T090000Z\r\nDTEND:20260203T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:evt1\r\nRECURRENCE-ID:20260224T090000Z\r\nDTSTART:20260303T090000Z\r\nDTEND:20260303T100000Z\r\nSUMMARY:Standup (pushed a week)\r\nEND:VEVENT\r\n';
  const r = parseIcs(HEAD.replace(/\n/g, '\r\n') + body + TAIL.replace(/\n/g, '\r\n'), win('2026-03-01', '2026-04-01'));
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].title, 'Standup (pushed a week)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
