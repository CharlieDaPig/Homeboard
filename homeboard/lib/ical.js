'use strict';
// A small RFC 5545 (iCalendar) reader: parses VEVENTs and expands RRULEs, but only inside a requested
// window. No third-party packages. Deliberately does not use VTIMEZONE blocks; a TZID is resolved with
// the Intl time zone database built into Node, which is what "use Intl for the zone maths" means below.

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_CANDIDATES = 50000; // safety net against a malformed rule that never advances or never ends

// ---------------------------------------------------------------- unfolding, escaping, line parsing

// A folded line is continued on the next physical line, which starts with a space or tab. CRLF is the
// standard line ending but real-world feeds sometimes use bare LF, so both are accepted.
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(s) {
  return String(s).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// "NAME;P1=V1;P2=V1,V2:VALUE" -> { name, params: { P1: ['V1'], P2: ['V1','V2'] }, value }
// A quoted param value ("...") may itself contain ':' or ';', so those must not split the line early.
function parseLine(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).toUpperCase();
  const params = {};
  while (i < n && line[i] === ';') {
    i++;
    let j = i;
    while (j < n && line[j] !== '=') j++;
    const pname = line.slice(i, j).toUpperCase();
    i = j + 1;
    const values = [];
    for (;;) {
      let val = '';
      if (line[i] === '"') {
        i++;
        const end = line.indexOf('"', i);
        val = end === -1 ? line.slice(i) : line.slice(i, end);
        i = end === -1 ? n : end + 1;
      } else {
        let k = i;
        while (k < n && line[k] !== ',' && line[k] !== ';' && line[k] !== ':') k++;
        val = line.slice(i, k);
        i = k;
      }
      values.push(val);
      if (line[i] === ',') {
        i++;
        continue;
      }
      break;
    }
    params[pname] = values;
  }
  const value = i < n && line[i] === ':' ? line.slice(i + 1) : '';
  return { name, params, value };
}

// ---------------------------------------------------------------- components

// Walks BEGIN:/END: nesting and returns a flat list of { name (e.g. VEVENT), lines: [...] } for every
// component at any depth. VTIMEZONE contents are collected too but never read; we resolve TZIDs ourselves.
function splitComponents(text) {
  const lines = unfold(text)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length);
  const stack = [{ name: 'ROOT', lines: [], children: [] }];
  for (const raw of lines) {
    if (/^BEGIN:/i.test(raw)) {
      const name = raw.slice(6).trim().toUpperCase();
      const comp = { name, lines: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (/^END:/i.test(raw)) {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].lines.push(raw);
    }
  }
  const out = [];
  (function walk(comp) {
    if (comp.name !== 'ROOT') out.push(comp);
    for (const c of comp.children) walk(c);
  })(stack[0]);
  return out;
}

// One component's property lines -> { UID: [{params,value}], SUMMARY: [...], ... } (always arrays, since
// ATTENDEE and EXDATE can repeat).
function propsOf(comp) {
  const out = {};
  for (const raw of comp.lines) {
    const p = parseLine(raw);
    (out[p.name] || (out[p.name] = [])).push(p);
  }
  return out;
}

// ---------------------------------------------------------------- date/time values

const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate(); // mo is 1-based here

// What wall-clock date/time a UTC instant shows in a given IANA zone.
function zonedParts(epochMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(epochMs))) parts[type] = value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some ICU builds print midnight as "24"
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: hour, mi: Number(parts.minute), s: Number(parts.second) };
}

// The UTC instant of a wall-clock time in a given IANA zone, correct across DST changes.
// (Two fixed-point passes are enough: the offset only ever takes one of a handful of values.)
function zonedEpoch(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const wanted = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz);
    const shownAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess += wanted - shownAsUtc;
  }
  return guess;
}

// Parses a DTSTART/DTEND/EXDATE/RDATE/RECURRENCE-ID style property into a normalised value.
// kind: 'date' (all-day) | 'instant' (has a real UTC instant, whatever the source time zone was).
function parseDateValue(prop, tzids) {
  const v = prop.value.trim();
  const isDateOnly = (prop.params.VALUE || [])[0] === 'DATE' || /^\d{8}$/.test(v);
  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { kind: 'date', y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = m;
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), s = Number(ss);
  const tzid = (prop.params.TZID || [])[0];
  if (z) return { kind: 'instant', epoch: Date.UTC(y, mo - 1, d, h, mi, s), y, mo, d, h, mi, s, tz: 'UTC' };
  if (tzid) {
    const tz = tzids && tzids.has(tzid) ? tzid : tzid; // Intl throws for a bad zone; caller catches that per-event
    return { kind: 'instant', epoch: zonedEpoch(y, mo, d, h, mi, s, tz), y, mo, d, h, mi, s, tz };
  }
  // Floating time: no particular zone, so it means whatever this machine's own zone is.
  return { kind: 'instant', epoch: new Date(y, mo - 1, d, h, mi, s).getTime(), y, mo, d, h, mi, s, tz: null };
}

const dateKey = (v) => (v.kind === 'date' ? `D${v.y}-${v.mo}-${v.d}` : `I${v.epoch}`);
const addDaysToDate = (v, n) => {
  const dt = new Date(Date.UTC(v.y, v.mo - 1, v.d + n));
  return { kind: 'date', y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const ymd = (v) => `${v.y}-${String(v.mo).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;

// ISO 8601 duration (PnDTnHnMnS, PnW) in milliseconds.
function parseDuration(s) {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const [, , w, d, h, mi, sec] = m;
  const ms = ((Number(w) || 0) * 7 * 86400 + (Number(d) || 0) * 86400 + (Number(h) || 0) * 3600 + (Number(mi) || 0) * 60 + (Number(sec) || 0)) * 1000;
  return sign * ms;
}

// ---------------------------------------------------------------- RRULE

function parseRRule(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    rule[k.toUpperCase()] = v;
  }
  return rule;
}

function parseByDay(spec) {
  // "MO,2TU,-1FR" -> [{ n: null, day: 1 }, { n: 2, day: 2 }, { n: -1, day: 5 }]
  return spec.split(',').map((tok) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim());
    if (!m) return null;
    return { n: m[1] ? Number(m[1]) : null, day: WEEKDAYS.indexOf(m[2]) };
  }).filter(Boolean);
}

// All calendar days in (y, mo) [1-based month] matching weekday `day` (0=SU..6=SA), 1-based date numbers,
// in ascending order. If `n` is given, only the nth (or nth-from-end, if negative) is returned.
function weekdaysInMonth(y, mo, day, n) {
  const total = daysInMonth(y, mo);
  const all = [];
  for (let d = 1; d <= total; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === day) all.push(d);
  if (!n) return all;
  const i = n > 0 ? n - 1 : all.length + n;
  return i >= 0 && i < all.length ? [all[i]] : [];
}

function resolveMonthDay(list) {
  return list.split(',').map(Number);
}

// Day-of-month candidates for one (year, month) under BYMONTHDAY / BYDAY (with or without an ordinal) /
// or, lacking either, the day-of-month DTSTART itself falls on.
function monthCandidates(y, mo, rule, dtstartDay) {
  const total = daysInMonth(y, mo);
  if (rule.BYMONTHDAY) {
    return resolveMonthDay(rule.BYMONTHDAY)
      .map((n) => (n > 0 ? n : total + n + 1))
      .filter((d) => d >= 1 && d <= total)
      .sort((a, b) => a - b);
  }
  if (rule.BYDAY) {
    const days = parseByDay(rule.BYDAY);
    const set = new Set();
    for (const { n, day } of days) for (const d of weekdaysInMonth(y, mo, day, n)) set.add(d);
    return [...set].sort((a, b) => a - b);
  }
  return dtstartDay <= total ? [dtstartDay] : [];
}

function applySetPos(list, setpos) {
  if (!setpos) return list;
  const positions = setpos.split(',').map(Number);
  const picked = positions.map((p) => (p > 0 ? list[p - 1] : list[list.length + p])).filter((x) => x !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

// Generates candidate {y,mo,d} (date-only) or {y,mo,d,h,mi,s} (timed) wall-clock tuples in order, already
// past COUNT/UNTIL and INTERVAL filtering. Stops once past `hardStop` (an epoch-ish comparable bound) or
// MAX_CANDIDATES, whichever first - the caller still applies EXDATE/RECURRENCE-ID/window logic.
function* expandRule(rule, start, hardStopKey) {
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const until = rule.UNTIL ? parseDateValue({ value: rule.UNTIL, params: rule.UNTIL.length === 8 ? { VALUE: ['DATE'] } : {} }) : null;
  const wkstDay = rule.WKST ? WEEKDAYS.indexOf(rule.WKST.toUpperCase()) : 1;
  const isDateOnly = start.kind === 'date';
  let emitted = 0;
  let iterations = 0;

  const withinBound = (cand) => {
    if (until) {
      if (isDateOnly) {
        if (cand.y > until.y || (cand.y === until.y && (cand.mo > until.mo || (cand.mo === until.mo && cand.d > until.d)))) return false;
      } else {
        const candEpoch = start.tz === 'UTC' || !start.tz ? Date.UTC(cand.y, cand.mo - 1, cand.d, cand.h, cand.mi, cand.s) : zonedEpoch(cand.y, cand.mo, cand.d, cand.h, cand.mi, cand.s, start.tz);
        if (candEpoch > (until.kind === 'date' ? Date.UTC(until.y, until.mo - 1, until.d, 23, 59, 59) : until.epoch)) return false;
      }
    }
    return true;
  };
  const pastHardStop = (cand) => {
    const key = isDateOnly ? `${cand.y}-${String(cand.mo).padStart(2, '0')}-${String(cand.d).padStart(2, '0')}` : cand.epochForCompare;
    return key > hardStopKey;
  };

  function withTime(y, mo, d) {
    return isDateOnly ? { y, mo, d } : { y, mo, d, h: start.h, mi: start.mi, s: start.s };
  }
  function tag(cand) {
    if (isDateOnly) return cand;
    cand.epochForCompare = start.tz === 'UTC' || !start.tz ? Date.UTC(cand.y, cand.mo - 1, cand.d, cand.h, cand.mi, cand.s) : zonedEpoch(cand.y, cand.mo, cand.d, cand.h, cand.mi, cand.s, start.tz);
    return cand;
  }

  if (rule.FREQ === 'DAILY') {
    let y = start.y, mo = start.mo, d = start.d;
    while (iterations++ < MAX_CANDIDATES) {
      const cand = tag(withTime(y, mo, d));
      if (!withinBound(cand)) break;
      if (pastHardStop(cand)) break;
      let ok = true;
      if (rule.BYMONTH && !rule.BYMONTH.split(',').map(Number).includes(mo)) ok = false;
      if (ok && rule.BYDAY) {
        const wanted = parseByDay(rule.BYDAY).map((b) => b.day);
        if (!wanted.includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())) ok = false;
      }
      if (ok) {
        if (count !== null && emitted >= count) break;
        emitted++;
        yield cand;
      }
      const next = new Date(Date.UTC(y, mo - 1, d + interval));
      y = next.getUTCFullYear();
      mo = next.getUTCMonth() + 1;
      d = next.getUTCDate();
    }
    return;
  }

  if (rule.FREQ === 'WEEKLY') {
    const dtstartDow = new Date(Date.UTC(start.y, start.mo - 1, start.d)).getUTCDay();
    const backToWkst = (dtstartDow - wkstDay + 7) % 7;
    let weekStart = new Date(Date.UTC(start.y, start.mo - 1, start.d - backToWkst));
    const byday = rule.BYDAY ? parseByDay(rule.BYDAY).map((b) => b.day) : [dtstartDow];
    const order = (day) => (day - wkstDay + 7) % 7;
    const sortedDays = [...new Set(byday)].sort((a, b) => order(a) - order(b));
    while (iterations++ < MAX_CANDIDATES * 7) {
      for (const day of sortedDays) {
        const off = order(day);
        const dt = new Date(weekStart.getTime() + off * 86400000);
        const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
        if (y < start.y || (y === start.y && mo < start.mo) || (y === start.y && mo === start.mo && d < start.d)) continue;
        if (rule.BYMONTH && !rule.BYMONTH.split(',').map(Number).includes(mo)) continue;
        const cand = tag(withTime(y, mo, d));
        if (!withinBound(cand)) return;
        if (pastHardStop(cand)) return;
        if (count !== null && emitted >= count) return;
        emitted++;
        yield cand;
      }
      weekStart = new Date(weekStart.getTime() + interval * 7 * 86400000);
    }
    return;
  }

  if (rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY') {
    let y = start.y, mo = start.mo;
    const stepMonths = rule.FREQ === 'MONTHLY' ? interval : interval * 12;
    while (iterations++ < MAX_CANDIDATES) {
      const months = rule.FREQ === 'YEARLY' && rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : [mo];
      let all = [];
      for (const m of months) {
        if (rule.FREQ === 'MONTHLY' && rule.BYMONTH && !rule.BYMONTH.split(',').map(Number).includes(m)) continue;
        const days = monthCandidates(y, m, rule, start.d);
        for (const d of days) all.push({ mo: m, d });
      }
      all.sort((a, b) => a.mo - b.mo || a.d - b.d);
      if (rule.BYSETPOS) all = applySetPos(all.map((x) => x.mo * 100 + x.d), rule.BYSETPOS).map((v) => ({ mo: Math.floor(v / 100), d: v % 100 }));
      for (const { mo: m, d } of all) {
        if (y === start.y && m === start.mo && d < start.d) continue;
        if (y < start.y) continue;
        const cand = tag(withTime(y, m, d));
        if (!withinBound(cand)) return;
        if (pastHardStop(cand)) return;
        if (count !== null && emitted >= count) return;
        emitted++;
        yield cand;
      }
      const next = new Date(Date.UTC(y, mo - 1 + stepMonths, 1));
      y = next.getUTCFullYear();
      mo = next.getUTCMonth() + 1;
    }
    return;
  }
}

// ---------------------------------------------------------------- putting one VEVENT's occurrences together

function firstProp(props, name) {
  return props[name] && props[name][0];
}

// selfEmail: this calendar owner's address, so a declined invite can be hidden. Returns [] on any per-event
// problem (bad date, unsupported/garbled RRULE, unresolvable time zone) rather than throwing, so one bad
// event never blanks the whole feed.
function eventOccurrences(comp, windowStart, windowEnd, selfEmail) {
  const props = propsOf(comp);
  const status = firstProp(props, 'STATUS');
  if (status && /CANCELLED/i.test(status.value)) return [];
  if (selfEmail) {
    const declined = (props.ATTENDEE || []).some((a) => {
      const addr = a.value.replace(/^mailto:/i, '').toLowerCase();
      return addr === selfEmail.toLowerCase() && (a.params.PARTSTAT || [])[0] === 'DECLINED';
    });
    if (declined) return [];
  }

  const dtstartProp = firstProp(props, 'DTSTART');
  if (!dtstartProp) return [];
  let dtstart;
  try {
    dtstart = parseDateValue(dtstartProp);
  } catch {
    return [];
  }
  if (!dtstart) return [];

  const title = firstProp(props, 'SUMMARY') ? unescapeText(firstProp(props, 'SUMMARY').value) : '(No title)';
  const uid = firstProp(props, 'UID') ? firstProp(props, 'UID').value : `${title}:${dtstartProp.value}`;

  // Duration, from DTEND, or DURATION, or the RFC 5545 default.
  let durationMs = null;
  const dtendProp = firstProp(props, 'DTEND');
  let dtend = null;
  if (dtendProp) {
    try {
      dtend = parseDateValue(dtendProp);
    } catch {
      dtend = null;
    }
  }
  if (!dtend) {
    const durProp = firstProp(props, 'DURATION');
    if (durProp) durationMs = parseDuration(durProp.value);
    else durationMs = dtstart.kind === 'date' ? 86400000 : 0;
  }

  function occurrenceEndFor(startVal) {
    if (dtend && !firstProp(props, 'RRULE')) return dtend; // only meaningful for the single base occurrence
    if (startVal.kind === 'date') {
      const days = durationMs != null ? Math.round(durationMs / 86400000) : dtend ? Math.round((Date.UTC(dtend.y, dtend.mo - 1, dtend.d) - Date.UTC(startVal.y, startVal.mo - 1, startVal.d)) / 86400000) : 1;
      return addDaysToDate(startVal, Math.max(1, days));
    }
    const ms = durationMs != null ? durationMs : dtend ? dtend.epoch - dtstart.epoch : 0;
    return { kind: 'instant', epoch: startVal.epoch + ms };
  }

  const toOutput = (startVal, endVal, useTitle) => ({
    id: `${uid}:${startVal.kind === 'date' ? ymd(startVal) : startVal.epoch}`,
    title: useTitle,
    allDay: startVal.kind === 'date',
    start: startVal.kind === 'date' ? ymd(startVal) : new Date(startVal.epoch).toISOString(),
    end: endVal.kind === 'date' ? ymd(endVal) : new Date(endVal.epoch).toISOString(),
  });

  const overlapsWindow = (startVal, endVal) => {
    const s = startVal.kind === 'date' ? Date.UTC(startVal.y, startVal.mo - 1, startVal.d) : startVal.epoch;
    const e = endVal.kind === 'date' ? Date.UTC(endVal.y, endVal.mo - 1, endVal.d) : endVal.epoch;
    return s < windowEnd.getTime() && e > windowStart.getTime();
  };

  const rruleProp = firstProp(props, 'RRULE');
  if (!rruleProp) {
    const end = dtend || occurrenceEndFor(dtstart);
    return overlapsWindow(dtstart, end) ? [toOutput(dtstart, end, title)] : [];
  }

  // Recurring event: exclusions, extra dates and single-instance overrides are resolved by the caller
  // (lib/calendars.js), which sees every VEVENT sharing this UID at once. Here we only expand the rule
  // itself and apply this event's own EXDATE/RDATE.
  let rule;
  try {
    rule = parseRRule(rruleProp.value);
  } catch {
    return [];
  }
  if (!rule.FREQ) return [];

  const exdates = new Set();
  for (const p of props.EXDATE || []) {
    for (const one of p.value.split(',')) {
      try {
        const v = parseDateValue({ value: one, params: p.params });
        if (v) exdates.add(dateKey(v));
      } catch {
        /* skip a bad EXDATE rather than fail the whole event */
      }
    }
  }

  const hardStopKey = dtstart.kind === 'date' ? ymd({ y: windowEnd.getUTCFullYear(), mo: windowEnd.getUTCMonth() + 1, d: windowEnd.getUTCDate() }) : windowEnd.getTime();
  const results = [];
  try {
    for (const cand of expandRule(rule, dtstart, hardStopKey)) {
      const startVal = dtstart.kind === 'date' ? { kind: 'date', y: cand.y, mo: cand.mo, d: cand.d } : { kind: 'instant', epoch: cand.epochForCompare };
      if (exdates.has(dateKey(startVal))) continue;
      const endVal = occurrenceEndFor(startVal);
      if (overlapsWindow(startVal, endVal)) results.push({ key: dateKey(startVal), out: toOutput(startVal, endVal, title) });
    }
  } catch {
    /* an unsupported/garbled rule: return whatever we already generated instead of nothing at all */
  }

  for (const p of props.RDATE || []) {
    for (const one of p.value.split(',')) {
      try {
        const v = parseDateValue({ value: one, params: p.params });
        if (!v || exdates.has(dateKey(v))) continue;
        const endVal = occurrenceEndFor(v);
        if (overlapsWindow(v, endVal)) results.push({ key: dateKey(v), out: toOutput(v, endVal, title) });
      } catch {
        /* skip a bad RDATE */
      }
    }
  }
  return results.map((r) => ({ ...r.out, _uid: uid, _key: r.key }));
}

// ---------------------------------------------------------------- top level

// Returns { events } for the [windowStart, windowEnd) range. Never throws for a single bad VEVENT; only
// throws if the text as a whole is not an ICS feed at all.
function parseIcs(text, { windowStart, windowEnd, selfEmail } = {}) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('That address did not return a calendar (.ics) feed. Check that it is the "Secret address in iCal format", not the calendar\'s normal page address.');
  }
  const comps = splitComponents(text).filter((c) => c.name === 'VEVENT');

  const masters = [];
  const overridesByUid = new Map(); // uid -> Map(recurrenceKey -> comp)
  for (const comp of comps) {
    const props = propsOf(comp);
    const rid = firstProp(props, 'RECURRENCE-ID');
    if (rid) {
      const uidProp = firstProp(props, 'UID');
      const uid = uidProp ? uidProp.value : null;
      if (!uid) continue;
      let v;
      try {
        v = parseDateValue(rid);
      } catch {
        continue;
      }
      if (!v) continue;
      if (!overridesByUid.has(uid)) overridesByUid.set(uid, new Map());
      overridesByUid.get(uid).set(dateKey(v), comp);
    } else {
      masters.push(comp);
    }
  }

  const events = [];
  for (const comp of masters) {
    let occ;
    try {
      occ = eventOccurrences(comp, windowStart, windowEnd, selfEmail);
    } catch {
      occ = [];
    }
    const uidProp = firstProp(propsOf(comp), 'UID');
    const uid = uidProp ? uidProp.value : null;
    const myOverrides = uid ? overridesByUid.get(uid) : null;
    for (const ev of occ) {
      if (myOverrides && myOverrides.has(ev._key)) continue; // superseded below
      const { _uid, _key, ...clean } = ev;
      events.push(clean);
    }
  }

  // Every override becomes its own occurrence at its own (possibly moved) time, cancelled ones dropped.
  for (const [, byKey] of overridesByUid) {
    for (const comp of byKey.values()) {
      let occ;
      try {
        occ = eventOccurrences(comp, windowStart, windowEnd, selfEmail);
      } catch {
        occ = [];
      }
      for (const ev of occ) {
        const { _uid, _key, ...clean } = ev;
        events.push(clean);
      }
    }
  }

  return { events };
}

module.exports = { parseIcs, zonedEpoch, zonedParts, parseDuration, parseRRule, parseByDay };
