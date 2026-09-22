'use strict';
// Settings you can change from the admin dashboard. They are saved in data/settings.json and layered
// on top of config.json, so hand-edited values are never overwritten.
const fs = require('fs');
const path = require('path');
const { merge, isObject, DATA_DIR } = require('./config');

class ValidationError extends Error {
  constructor(problems) {
    super(problems.map((p) => `${p.key}: ${p.message}`).join('; '));
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

const int = (min, max) => ({ type: 'int', min, max });
const num = (min, max) => ({ type: 'number', min, max });
const str = (max) => ({ type: 'string', max });
const list = (maxItems, maxLen) => ({ type: 'stringList', maxItems, maxLen });

// Every setting the dashboard may change, with what is allowed.
const SCHEMA = {
  locale: { type: 'string', max: 20, pattern: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, hint: 'like en-US or en-GB' },
  'display.timeFormat': { type: 'enum', values: ['12h', '24h'] },
  'display.showSeconds': { type: 'bool' },
  'display.backgroundIntervalSeconds': int(10, 86400),
  'display.backgroundOrder': { type: 'enum', values: ['shuffle', 'sequential'] },
  'display.backgroundDim': num(0, 0.9),
  'display.lowPower': { type: 'bool' },
  'refresh.calendarMinutes': int(1, 120),
  'refresh.tasksMinutes': int(1, 120),
  'refresh.weatherMinutes': int(5, 240),
  'calendar.weeks': int(1, 8),
  'calendar.weekStartsOn': { type: 'enum', values: [0, 1, 6] },
  'calendar.maxEventsPerDay': int(1, 10),
  'tasks.title': str(40),
  'tasks.lists': list(60, 200),
  'tasks.maxItems': int(1, 40),
  'weather.latitude': num(-90, 90),
  'weather.longitude': num(-180, 180),
  'weather.units': { type: 'enum', values: ['imperial', 'metric'] },
  'weather.label': str(80),
};

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

function unsetPath(target, dotted) {
  const parts = dotted.split('.');
  if (parts.some((p) => UNSAFE.has(p))) return;
  const chain = [target];
  for (const p of parts.slice(0, -1)) {
    if (!isObject(chain[chain.length - 1][p])) return;
    chain.push(chain[chain.length - 1][p]);
  }
  delete chain[chain.length - 1][parts[parts.length - 1]];
  // tidy up empty parents
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length === 0) delete chain[i - 1][parts[i - 1]];
  }
}

// Returns the cleaned value, or throws a string describing the problem.
function coerce(spec, value) {
  switch (spec.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw 'must be true or false';
      return value;
    case 'enum': {
      const match = spec.values.find((v) => v === value || String(v) === String(value));
      if (match === undefined) throw `must be one of ${spec.values.join(', ')}`;
      return match;
    }
    case 'int':
    case 'number': {
      if (typeof value === 'string' && value.trim() !== '') value = Number(value);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw 'must be a number';
      if (spec.type === 'int' && !Number.isInteger(value)) throw 'must be a whole number';
      if (value < spec.min || value > spec.max) throw `must be between ${spec.min} and ${spec.max}`;
      return value;
    }
    case 'string': {
      if (typeof value !== 'string') throw 'must be text';
      const v = value.trim();
      if (v.length > spec.max) throw `must be at most ${spec.max} characters`;
      if (spec.pattern && !spec.pattern.test(v)) throw `not valid${spec.hint ? ' (' + spec.hint + ')' : ''}`;
      return v;
    }
    case 'stringList': {
      if (!Array.isArray(value)) throw 'must be a list';
      if (value.length > spec.maxItems) throw `at most ${spec.maxItems} items`;
      return value.map((s) => {
        if (typeof s !== 'string') throw 'items must be text';
        const t = s.trim();
        if (!t || t.length > spec.maxLen) throw `items must be 1 to ${spec.maxLen} characters`;
        return t;
      });
    }
    default:
      throw 'unsupported';
  }
}

class Settings {
  constructor(base, file = path.join(DATA_DIR, 'settings.json')) {
    this.base = base;
    this.file = file;
    this.version = Date.now();
    this.overrides = {};
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Keep only keys we still know about, cleaned.
      for (const [k, v] of Object.entries(flatten(saved))) {
        if (SCHEMA[k]) {
          try {
            setPath(this.overrides, k, coerce(SCHEMA[k], v));
          } catch {
            /* ignore bad saved value */
          }
        }
      }
    } catch {
      /* no saved settings yet */
    }
    this.cached = null;
  }

  effective() {
    if (!this.cached) this.cached = merge(this.base, this.overrides);
    return this.cached;
  }

  // Only the settings the dashboard is allowed to change, in nested form.
  editable() {
    const eff = flatten(this.effective());
    const out = {};
    for (const key of Object.keys(SCHEMA)) if (key in eff) setPath(out, key, eff[key]);
    return out;
  }

  overriddenKeys() {
    return Object.keys(flatten(this.overrides));
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.overrides, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cached = null;
    this.version = Date.now();
  }

  // patch: nested object such as { display: { backgroundIntervalSeconds: 300 } }
  update(patch) {
    const flat = flatten(patch);
    const problems = [];
    const clean = {};
    for (const [key, value] of Object.entries(flat)) {
      const spec = SCHEMA[key];
      if (!spec) {
        problems.push({ key, message: 'unknown or read-only setting' });
        continue;
      }
      try {
        clean[key] = coerce(spec, value);
      } catch (message) {
        problems.push({ key, message: String(message) });
      }
    }
    // stringList values are arrays, which flatten() keeps whole (isObject is false for arrays)
    if (problems.length) throw new ValidationError(problems);
    if (!Object.keys(clean).length) return [];
    for (const [k, v] of Object.entries(clean)) setPath(this.overrides, k, v);
    this.save();
    return Object.keys(clean);
  }

  reset(keys) {
    if (!keys || !keys.length) this.overrides = {};
    else for (const k of keys) if (typeof k === 'string' && Object.hasOwn(SCHEMA, k)) unsetPath(this.overrides, k);
    this.save();
  }
}

module.exports = { Settings, ValidationError, SCHEMA, flatten };
