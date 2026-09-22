'use strict';
// Tests for lib/calendars.js (the calendar-source manager) against tests/fake_calendar_server.js.
// Run with:  node tests/calendars_test.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const { startFakeCalendarServer } = require('./fake_calendar_server');
const { Calendars } = require('../homeboard/lib/calendars.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL - ${name}\n  ${err.stack || err.message}`);
  }
}

const tmpFile = () => path.join(os.tmpdir(), `homeboard-calendars-test-${Math.random().toString(36).slice(2)}.json`);
const HEAD = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n';
const TAIL = 'END:VCALENDAR\r\n';
const oneEvent = (uid, summary, start, end) => `${HEAD}BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\n${TAIL}`;

async function main() {
  const fake = await startFakeCalendarServer({
    '/home.ics': oneEvent('h1', 'Dentist', '20260315T140000Z', '20260315T150000Z'),
    '/work.ics': oneEvent('w1', 'Standup', '20260316T140000Z', '20260316T143000Z'),
    '/broken.ics': '<html>not a calendar</html>',
    '/slow-or-down': () => {
      throw new Error('should not be called directly');
    },
    '/calendar/ical/me%40example.com/private-abc123/basic.ics': (() => {
      const withDecline = `${HEAD}BEGIN:VEVENT\r\nUID:d1\r\nDTSTART:20260315T140000Z\r\nDTEND:20260315T150000Z\r\nSUMMARY:Declined party\r\nATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com\r\nEND:VEVENT\r\n${TAIL}`;
      return withDecline;
    })(),
  });

  await test('add() rejects a non-https/webcal link with a plain message', () => {
    const c = new Calendars(tmpFile());
    assert.throws(() => c.add({ name: 'X', link: 'ftp://example.com/cal.ics' }), /should start with https/);
  });

  await test('add() accepts webcal:// by treating it as https://', () => {
    const c = new Calendars(tmpFile());
    const added = c.add({ name: 'Home', link: `webcal://127.0.0.1:1/x` });
    assert.ok(c.sources[0].link.startsWith('https://'));
  });

  await test('list() never exposes the raw link, only a shortened form', () => {
    const c = new Calendars(tmpFile());
    c.add({ name: 'Home', link: `${fake.base}/home.ics` });
    const shown = c.list()[0];
    assert.ok(!shown.linkShown.includes(fake.base));
    assert.ok(shown.linkShown.includes('.ics'.slice(-5)) || /ending/.test(shown.linkShown));
    assert.strictEqual(shown.name, 'Home');
  });

  await test('new calendars get default colours from the palette, cycling as more are added', () => {
    const c = new Calendars(tmpFile());
    const a = c.add({ name: 'A', link: `${fake.base}/home.ics` });
    const b = c.add({ name: 'B', link: `${fake.base}/work.ics` });
    assert.notStrictEqual(a.color, b.color);
  });

  await test('rename() changes the name without needing the link again', () => {
    const c = new Calendars(tmpFile());
    const a = c.add({ name: 'Home', link: `${fake.base}/home.ics` });
    const r = c.rename(a.id, 'House');
    assert.strictEqual(r.name, 'House');
    assert.strictEqual(c.sources[0].link, `${fake.base}/home.ics`);
  });

  await test('remove() drops the calendar; removing an unknown id fails plainly', () => {
    const c = new Calendars(tmpFile());
    const a = c.add({ name: 'Home', link: `${fake.base}/home.ics` });
    c.remove(a.id);
    assert.strictEqual(c.sources.length, 0);
    assert.throws(() => c.remove(a.id), /No such calendar/);
  });

  await test('getCalendarEvents merges multiple calendars, tagging each event with its own colour and name', async () => {
    const c = new Calendars(tmpFile());
    c.add({ name: 'Home', link: `${fake.base}/home.ics`, color: '#111111' });
    c.add({ name: 'Work', link: `${fake.base}/work.ics`, color: '#222222' });
    const { events } = await c.getCalendarEvents('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
    assert.strictEqual(events.length, 2);
    const dentist = events.find((e) => e.title === 'Dentist');
    assert.strictEqual(dentist.calendar, 'Home');
    assert.strictEqual(dentist.color, '#111111');
  });

  await test('getCalendarEvents fails the whole request if any one calendar fails (matches the old all-or-nothing cache behaviour)', async () => {
    const c = new Calendars(tmpFile());
    c.add({ name: 'Home', link: `${fake.base}/home.ics` });
    c.add({ name: 'Broken', link: `${fake.base}/broken.ics` });
    await assert.rejects(() => c.getCalendarEvents('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'), /Calendar "Broken"/);
  });

  await test('no calendars added yet throws a SetupNeeded-flavoured error', async () => {
    const c = new Calendars(tmpFile());
    await assert.rejects(() => c.getCalendarEvents('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'), /No calendar link/);
  });

  await test('declined events are hidden using the email embedded in a Google-style secret link', async () => {
    const c = new Calendars(tmpFile());
    c.add({ name: 'Mine', link: `${fake.base}/calendar/ical/me%40example.com/private-abc123/basic.ics` });
    const { events } = await c.getCalendarEvents('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
    assert.strictEqual(events.length, 0);
  });

  await test('test() reports a plain summary with the first event', async () => {
    const soon = new Date(Date.now() + 2 * 86400000);
    const stamp = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T140000Z`;
    const feeds2 = await startFakeCalendarServer({ '/soon.ics': oneEvent('s1', 'Dentist', stamp(soon), stamp(soon)) });
    const c = new Calendars(tmpFile());
    const a = c.add({ name: 'Home', link: `${feeds2.base}/soon.ics` });
    const msg = await c.test(a.id, 5);
    assert.match(msg, /Calendar "Home": found 1 event in the next 5 weeks \(first: Dentist,/);
    await feeds2.close();
  });

  await fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main();
