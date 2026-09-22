'use strict';
// Health numbers for the dashboard: temperature, memory, disk, network address, Pi power/throttle flags.
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { ROOT } = require('./config');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim();
  } catch {
    return null;
  }
}

function cpuTempC() {
  const raw = readText('/sys/class/thermal/thermal_zone0/temp');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.round(n / 100) / 10 : null;
}

function disk() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(ROOT);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|tun|tap|tailscale|zt)/.test(name)) continue; // Docker's private networks are not where the dashboard is reached
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

// vcgencmd is only on Raspberry Pi OS. Bits are documented in the Raspberry Pi docs.
let throttleCache = { at: 0, value: null };
function throttled() {
  return new Promise((resolve) => {
    if (Date.now() - throttleCache.at < 15000) return resolve(throttleCache.value);
    execFile('vcgencmd', ['get_throttled'], { timeout: 1500 }, (err, stdout) => {
      let value = null;
      const m = !err && /0x([0-9a-f]+)/i.exec(stdout || '');
      if (m) {
        const bits = parseInt(m[1], 16);
        value = {
          raw: `0x${m[1]}`,
          underVoltageNow: Boolean(bits & 0x1),
          freqCappedNow: Boolean(bits & 0x2),
          throttledNow: Boolean(bits & 0x4),
          tempLimitNow: Boolean(bits & 0x8),
          underVoltageSinceBoot: Boolean(bits & 0x10000),
          throttledSinceBoot: Boolean(bits & 0x40000),
        };
      }
      throttleCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

async function systemInfo() {
  return {
    hostname: os.hostname(),
    model: readText('/proc/device-tree/model'),
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    uptimeSec: Math.round(os.uptime()),
    serverUptimeSec: Math.round(process.uptime()),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    mem: { total: os.totalmem(), free: os.freemem() },
    tempC: cpuTempC(),
    disk: disk(),
    addresses: addresses(),
    power: await throttled(),
  };
}

// ---------------------------------------------------------------- time zone
function currentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function listTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch {
    /* fall through */
  }
  return [currentTimezone()];
}

// Needs the sudoers rule the installer adds (NOPASSWD for exactly this command), so it can be pressed
// from the dashboard without a terminal. Restart the server after this resolves so its own clock math
// (the screen power schedule) picks up the change cleanly.
function setTimezone(tz) {
  return new Promise((resolve, reject) => {
    if (!listTimezones().includes(tz)) return reject(new Error('Not a real time zone name.'));
    execFile('sudo', ['timedatectl', 'set-timezone', tz], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr ? String(stderr).trim().split('\n')[0] : err.message));
      resolve();
    });
  });
}

module.exports = { systemInfo, currentTimezone, listTimezones, setTimezone };
