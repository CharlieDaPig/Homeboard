'use strict';
// Shared runtime state: recent log lines, how each data source is doing, the screen's heartbeat,
// and the open connections used to push commands to the screen.
const crypto = require('crypto');

const MAX_LOGS = 300;

const state = {
  startedAt: Date.now(),
  epoch: crypto.randomBytes(6).toString('hex'), // changes on every server start; the screen reloads when it changes
  logs: [],
  nextLogId: 1,
  sources: { calendar: {}, tasks: {}, weather: {} },
  screen: null,
  clients: new Set(),
};

function addLog(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
  state.logs.push({ id: state.nextLogId++, t: Date.now(), level, msg });
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
}

// Keep printing to the console (and so to journalctl) but also remember recent lines for the dashboard.
function captureLogs() {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      addLog(level, args);
      original(...args);
    };
  }
}

// Run a data fetch and remember when it last worked, or why it failed.
async function track(name, fn, summarize = () => ({})) {
  const t0 = Date.now();
  try {
    const value = await fn();
    state.sources[name] = { lastFetchAt: Date.now(), ok: true, ms: Date.now() - t0, error: null, ...summarize(value) };
    return value;
  } catch (err) {
    state.sources[name] = { ...state.sources[name], lastFetchAt: Date.now(), ok: false, ms: Date.now() - t0, error: err.message };
    throw err;
  }
}

function broadcast(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(payload);
    } catch {
      state.clients.delete(res);
    }
  }
}

module.exports = { state, captureLogs, track, broadcast, addLog };
