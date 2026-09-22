'use strict';
// The list of calendar sources (each a secret iCal link) shown on the screen, and fetching/parsing them.
// No npm dependencies: lib/ical.js does the actual reading.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const { parseIcs } = require('./ical');
const { SetupNeeded } = require('./errors');

const FILE = path.join(DATA_DIR, 'calendars.json');
const MAX_BYTES = 20 * 1024 * 1024; // a feed holds a calendar's whole history; this is a generous ceiling

// Cycled through for new calendars so they are distinguishable without the user having to pick a colour.
// Pairs are chosen to be readable both as a solid chip and as light text on top.
const PALETTE = [
  { color: '#4285f4', textColor: '#ffffff' }, // blue
  { color: '#33b679', textColor: '#000000' }, // green
  { color: '#d50000', textColor: '#ffffff' }, // red
  { color: '#f6bf26', textColor: '#000000' }, // gold
  { color: '#8e24aa', textColor: '#ffffff' }, // purple
  { color: '#039be5', textColor: '#ffffff' }, // teal blue
  { color: '#e67c73', textColor: '#000000' }, // salmon
  { color: '#616161', textColor: '#ffffff' }, // grey
];

function textColorFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // Perceived brightness (ITU-R BT.601); a light background reads better with dark text.
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  return luma > 150 ? '#000000' : '#ffffff';
}

// Never show the secret in full anywhere it could end up in a log or a lower-trust API response.
function shorten(link) {
  const tail = String(link).replace(/[?#].*$/, '').slice(-5);
  return `link ending …${tail}`;
}

// Google's secret address looks like .../calendar/ical/<url-encoded-email>/private-<token>/basic.ics
function guessSelfEmail(link) {
  const m = /\/ical\/([^/]+)\/private-/i.exec(link);
  if (!m) return null;
  let email;
  try {
    email = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeLink(raw) {
  const trimmed = String(raw || '').trim();
  const httpsIfy = trimmed.replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(httpsIfy)) throw new Error('The link should start with https:// (or webcal://). Paste the "Secret address in iCal format" from Google Calendar.');
  return httpsIfy;
}

class Calendars {
  constructor(file = FILE) {
    this.file = file;
    this.sources = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.sources)) this.sources = saved.sources.filter((s) => s && s.id && s.link);
    } catch {
      /* none saved yet */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sources: this.sources }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* not fatal */
    }
  }

  // What the dashboard is allowed to see: never the raw link.
  list() {
    return this.sources.map((s) => ({ id: s.id, name: s.name, color: s.color, textColor: s.textColor, linkShown: shorten(s.link) }));
  }

  add({ name, link, color }) {
    const cleanLink = normalizeLink(link);
    const cleanName = String(name || '').trim().slice(0, 60) || `Calendar ${this.sources.length + 1}`;
    const palette = PALETTE[this.sources.length % PALETTE.length];
    const cleanColor = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : palette.color;
    const source = { id: crypto.randomBytes(8).toString('hex'), name: cleanName, link: cleanLink, color: cleanColor, textColor: color ? textColorFor(cleanColor) : palette.textColor };
    this.sources.push(source);
    this.save();
    return this.list().find((s) => s.id === source.id);
  }

  rename(id, name, color) {
    const s = this.sources.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('No such calendar.'), { status: 404 });
    if (name != null) s.name = String(name).trim().slice(0, 60) || s.name;
    if (color != null && /^#[0-9a-f]{6}$/i.test(color)) {
      s.color = color;
      s.textColor = textColorFor(color);
    }
    this.save();
    return this.list().find((x) => x.id === id);
  }

  remove(id) {
    const before = this.sources.length;
    this.sources = this.sources.filter((x) => x.id !== id);
    if (this.sources.length === before) throw Object.assign(new Error('No such calendar.'), { status: 404 });
    this.save();
  }

  async fetchOne(link) {
    let res;
    try {
      res = await fetch(link, { signal: AbortSignal.timeout(20000), headers: { Accept: 'text/calendar, text/plain, */*' } });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'The calendar did not answer in time.' : `Could not reach the calendar link (${err.message}).`);
    }
    if (!res.ok) throw new Error(`The calendar link returned an error (HTTP ${res.status}). If you reset the secret link, paste the new one in.`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('That calendar feed is unexpectedly large.');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('That calendar feed is unexpectedly large.');
    return text;
  }

  // { events } merged across every configured calendar, for the [startIso, endIso) window.
  async getCalendarEvents(startIso, endIso) {
    if (!this.sources.length) throw new SetupNeeded('No calendar link has been added yet.');
    const windowStart = new Date(startIso);
    const windowEnd = new Date(endIso);
    const perCalendar = await Promise.all(
      this.sources.map(async (s) => {
        let text;
        try {
          text = await this.fetchOne(s.link);
        } catch (err) {
          throw new Error(`Calendar "${s.name}": ${err.message}`);
        }
        let parsed;
        try {
          parsed = parseIcs(text, { windowStart, windowEnd, selfEmail: guessSelfEmail(s.link) });
        } catch (err) {
          throw new Error(`Calendar "${s.name}": ${err.message}`);
        }
        return parsed.events.map((e) => ({ ...e, id: `${s.id}:${e.id}`, color: s.color, textColor: s.textColor, calendar: s.name }));
      })
    );
    return { events: perCalendar.flat() };
  }

  // For the dashboard's per-calendar Test button.
  async test(id, weeks) {
    const s = this.sources.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('No such calendar.'), { status: 404 });
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + weeks * 7 * 86400000);
    const text = await this.fetchOne(s.link);
    const parsed = parseIcs(text, { windowStart, windowEnd, selfEmail: guessSelfEmail(s.link) });
    const events = parsed.events.sort((a, b) => a.start.localeCompare(b.start));
    if (!events.length) return `Calendar "${s.name}": found 0 events in the next ${weeks} weeks.`;
    const first = events[0];
    const when = first.allDay ? new Date(`${first.start}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : new Date(first.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `Calendar "${s.name}": found ${events.length} event${events.length === 1 ? '' : 's'} in the next ${weeks} weeks (first: ${first.title}, ${when})`;
  }
}

module.exports = { Calendars, textColorFor, normalizeLink };
