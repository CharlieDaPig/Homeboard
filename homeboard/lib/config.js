'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const DEFAULTS = {
  host: '0.0.0.0', // reachable from other devices on your home network (needed for the dashboard)
  port: 3000,
  locale: 'en-US',
  mock: false,
  admin: { enabled: true },
  backgrounds: { folder: 'backgrounds' }, // relative to this project, or absolute, or starting with ~
  display: {
    timeFormat: '12h',
    showSeconds: true,
    backgroundIntervalSeconds: 600,
    backgroundOrder: 'shuffle',
    backgroundDim: 0.1,
    lowPower: false,
    startupDelaySeconds: 60, // how long kiosk.sh waits after login before opening the screen; see deploy/kiosk.sh
  },
  refresh: { calendarMinutes: 5, tasksMinutes: 2, weatherMinutes: 15 },
  calendar: { weeks: 5, weekStartsOn: 0, maxEventsPerDay: 4 },
  tasks: { title: 'Tasks', lists: [], maxItems: 14 }, // lists = Todoist project names to show; empty means all
  weather: { latitude: 32.7555, longitude: -97.3308, units: 'imperial', label: 'Fort Worth, TX' },
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (isObject(v) && isObject(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`${path.basename(file)} is not valid JSON (${err.message}); ignoring it.`);
    return {};
  }
}

// config.json (hand-edited, needs a restart) merged over the defaults.
function loadConfig() {
  const user = readJson(path.join(ROOT, 'config.json'));
  // Older versions stored the rotation time in minutes.
  if (isObject(user.display) && user.display.backgroundIntervalMinutes && !user.display.backgroundIntervalSeconds) {
    user.display.backgroundIntervalSeconds = Math.round(user.display.backgroundIntervalMinutes * 60);
  }
  const cfg = merge(DEFAULTS, user);
  delete cfg.display.backgroundIntervalMinutes;
  if (process.env.MOCK === '1') cfg.mock = true;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  return cfg;
}

module.exports = { loadConfig, merge, isObject, readJson, ROOT, DATA_DIR, DEFAULTS };
