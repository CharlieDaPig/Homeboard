'use strict';
// Lets this Pi show up as a light in diyHue (https://diyhue.org), an open-source Philips Hue Bridge emulator.
// diyHue finds "native" lights by asking http://<address>/detect, then reads and sets them at /state.
// Here the "light" is the monitor: on wakes it, off puts it to sleep, in the same way as the daily schedule does
// (HDMI-CEC, see display.js). The Hue app can then switch the monitor through diyHue. Homeboard's own schedule keeps
// working alongside.
//
// diyHue only ever talks to port 80, so this listens on port 80 (the systemd service made by deploy/install.sh
// is allowed to do that). It is off until switched on in the dashboard.
//
// diyHue wants port 80 for itself too, so the two cannot share an address. If diyHue runs on this same Pi in Docker,
// set address to 'docker': this then listens only on Docker's own network address (docker0, usually 172.17.0.1), and
// diyHue's container is published on the Pi's network address, so each has its own port 80.
const fs = require('fs');
const childProcess = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const { ValidationError } = require('./settings');

const DEFAULTS = { enabled: false, name: 'Homeboard Monitor', address: 'all' }; // address: 'all' = every network address, 'docker' = only Docker's own network
const MODEL = 'LOM001'; // "Hue Smart plug" in diyHue's list of light types
const VERSION = 2;

function cleanAddress(a) {
  return String(a || '').replace(/^::ffff:/, '');
}

// Ignore the virtual networks that Docker and virtual machines add.
const VIRTUAL = /^(lo|docker|br-|veth|virbr|tun|tap|tailscale|zt)/;

function lanInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) if (a && (a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address, mac: a.mac });
  }
  return out.sort((a, b) => Number(/^(eth|en)/.test(b.name)) - Number(/^(eth|en)/.test(a.name)) || a.name.localeCompare(b.name)); // cable first
}

function lanAddresses() {
  return lanInterfaces().map((i) => i.address);
}

// The address Docker gives the Pi on its own private network (where a diyHue container can reach the Pi). Node does not
// list a network that has no cable (an idle docker0 with no containers yet), so if it is missing there, ask `ip`, and
// as a last resort use Docker's usual address as long as the network exists.
function dockerAddress() {
  const list = os.networkInterfaces().docker0 || [];
  const a = list.find((x) => x && (x.family === 'IPv4' || x.family === 4));
  if (a) return a.address;
  if (!fs.existsSync('/sys/class/net/docker0')) return null;
  try {
    const out = childProcess.execFileSync('ip', ['-4', '-o', 'addr', 'show', 'dev', 'docker0'], { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /inet (\d+\.\d+\.\d+\.\d+)/.exec(out);
    if (m) return m[1];
  } catch {
    /* no ip tool */
  }
  return '172.17.0.1';
}

// An identifier for diyHue: the address of the Pi's network card, or one made up from its name.
function deviceMac() {
  const found = lanInterfaces().find((i) => i.mac && i.mac !== '00:00:00:00:00:00');
  if (found) return found.mac.toUpperCase();
  const h = crypto.createHash('sha1').update(os.hostname()).digest();
  return [0x02, h[0], h[1], h[2], h[3], h[4]].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

function toBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

// diyHue sends {"1":{"on":false}}. Older tools send {"on":false} or {"lights":{"1":{...}}}. All of them are fine.
function pickOn(body) {
  if (!body || typeof body !== 'object') return undefined;
  if ('on' in body) return toBool(body.on);
  if (body.lights && typeof body.lights === 'object') return pickOn(body.lights['1'] || Object.values(body.lights)[0]);
  if (body['1'] && typeof body['1'] === 'object') return pickOn(body['1']);
  return undefined;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit || !chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

class HueLight {
  constructor({ power, file = path.join(DATA_DIR, 'huelight.json'), port = Number(process.env.HOMEBOARD_HUELIGHT_PORT) || 80, host = null }) {
    this.power = power;
    this.file = file;
    this.port = port;
    this.host = host; // only for tests: overrides the address setting
    this.openedHost = null;
    this.settings = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof saved.enabled === 'boolean') this.settings.enabled = saved.enabled;
      if (typeof saved.name === 'string' && saved.name.trim()) this.settings.name = saved.name.trim().slice(0, 32);
      if (saved.address === 'all' || saved.address === 'docker') this.settings.address = saved.address;
      if (typeof saved.mac === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(saved.mac)) this.mac = saved.mac;
    } catch {
      /* not set up yet */
    }
    this.mac = this.mac || null; // kept once chosen, so that diyHue does not see a new light when the network changes
    this.server = null;
    this.listening = false;
    this.error = null;
    this.retry = null;
    this.desired = null; // 'on' | 'off' while a request from diyHue is still being carried out
    this.working = false;
    this.seen = null; // { ip, at, path } of the latest request
    this.switched = null; // { ip, at, state } of the latest on/off request
  }

  update(patch) {
    const problems = [];
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === 'enabled') {
        if (typeof value === 'boolean') clean.enabled = value;
        else problems.push({ key, message: 'Must be on or off.' });
      } else if (key === 'name') {
        const name = typeof value === 'string' ? value.trim() : '';
        if (!name || name.length > 32 || /[\u0000-\u001f]/.test(name)) problems.push({ key, message: 'The name must be 1 to 32 characters.' });
        else clean.name = name;
      } else if (key === 'address') {
        if (value === 'all' || value === 'docker') clean.address = value;
        else problems.push({ key, message: 'Choose another computer or this Pi (Docker).' });
      } else problems.push({ key, message: 'unknown setting' });
    }
    if (problems.length) throw new ValidationError(problems);
    Object.assign(this.settings, clean);
    this.save();
    return Object.keys(clean);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...this.settings, mac: this.mac || undefined }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  getMac() {
    if (!this.mac) {
      this.mac = deviceMac();
      try {
        this.save();
      } catch {
        /* not critical: it is worked out again next time */
      }
    }
    return this.mac;
  }

  // Opens or closes the listener so that it matches the setting. Never throws: a problem is shown in the dashboard.
  async apply() {
    if (!this.settings.enabled) return this.close();
    if (this.server) {
      const host = this.listenHost();
      // The setting changed, or Docker's address did. (If Docker's address merely cannot be read right now, leave a working listener alone.)
      if (this.openedMode !== this.settings.address || (host && this.openedHost !== host)) await this.close();
    }
    return this.open();
  }

  // The address to listen on, or null if it does not exist (yet).
  listenHost() {
    if (this.host) return this.host;
    return this.settings.address === 'docker' ? dockerAddress() : '0.0.0.0';
  }

  open() {
    if (this.listening || this.server) return Promise.resolve();
    clearTimeout(this.retry);
    const host = this.listenHost();
    if (!host) {
      this.error = 'Docker is not running on this Pi yet (its network, docker0, is missing). Install and start Docker, or choose "another computer".';
      this.retry = setTimeout(() => this.apply().catch(() => {}), 30000); // Docker may still be starting at boot
      this.retry.unref();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch(() => {
        try {
          res.writeHead(500).end();
        } catch {
          /* gone */
        }
      }));
      server.once('close', () => resolve()); // closed again before it finished opening
      server.on('error', (err) => {
        if (this.server === server) {
          this.listening = false;
          this.server = null;
        }
        if (err.code === 'EACCES') this.error = `This user is not allowed to use port ${this.port}. Run  bash homeboard/deploy/install.sh  again (it allows that), then restart with  sudo systemctl restart homeboard.`;
        else if (err.code === 'EADDRINUSE') this.error = this.settings.address === 'docker'
          ? `Port ${this.port} is already used by another program on Docker's network address. Is that a diyHue container? Publish it on the Pi's network address only (see START-HERE.md, Part 6).`
          : `Port ${this.port} is already used by another program on this Pi. If that is diyHue running on this same Pi, choose "On this same Pi, in Docker" above (see START-HERE.md, Part 6). Otherwise diyHue has to run on a different computer.`;
        else this.error = `Could not open port ${this.port}: ${err.message}`;
        if (this.lastWarned !== this.error) console.warn(`Hue light: ${this.error}`); // once, not every 30 seconds
        this.lastWarned = this.error;
        if (this.settings.enabled) {
          this.retry = setTimeout(() => this.apply().catch(() => {}), 30000); // try again, in case the port frees up
          this.retry.unref();
        }
        resolve();
      });
      this.server = server; // so that a second open() does not start another listener
      server.listen(this.port, host, () => {
        if (this.server !== server) return resolve(); // switched off while opening
        this.openedHost = host;
        this.openedMode = this.settings.address;
        this.lastWarned = null;
        this.listening = true;
        this.error = null;
        console.log(`Hue light: answering diyHue on ${host}:${this.port} as "${this.settings.name}".`);
        resolve();
      });
    });
  }

  close() {
    clearTimeout(this.retry);
    const server = this.server;
    this.server = null;
    this.listening = false;
    this.openedHost = null;
    this.openedMode = null;
    this.error = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.once('close', () => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  start() {
    return this.apply();
  }

  // What diyHue is told: the state the screen is really in, or the one it is meant to be in.
  isOn() {
    return (this.desired || this.power.applied || this.power.wanted()) === 'on';
  }

  // diyHue only waits three seconds for an answer, and switching can take longer (waiting for the monitor to confirm HDMI-CEC can take ten seconds or more). So the
  // answer goes out at once and the switch is carried out here. The latest request wins, and a request that arrives
  // while the screen is busy switching waits for it instead of being lost.
  request(state, ip) {
    this.desired = state;
    this.source = `diyHue (${ip})`;
    if (!this.working) this.work().catch(() => {});
  }

  async work() {
    this.working = true;
    const deadline = Date.now() + 120000;
    try {
      while (this.desired && Date.now() < deadline) {
        if (this.power.busy) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const state = this.desired;
        if (this.power.applied === state && this.power.wanted() === state) {
          if (this.desired === state) this.desired = null; // already so; diyHue often repeats itself
          continue;
        }
        try {
          const r = await this.power.manual(state, this.source);
          if (!r.ok) console.warn(`Hue light: diyHue asked for the screen ${state}, but it did not switch: ${r.message}`);
        } catch (err) {
          if (err.status === 409) continue; // became busy in the meantime: wait and try again
          console.warn(`Hue light: could not switch the screen ${state}: ${err.message}`);
        }
        if (this.desired === state) this.desired = null;
      }
    } finally {
      this.desired = null;
      this.working = false;
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const ip = cleanAddress(req.socket.remoteAddress);
    const reply = (status, body) => {
      const isJson = typeof body === 'object';
      res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store' });
      res.end(isJson ? JSON.stringify(body) : body);
    };
    const light = url.searchParams.get('light');
    if (light && light !== '1') return reply(404, 'There is only light 1.');

    if (req.method === 'GET' && p === '/detect') {
      this.seen = { ip, at: Date.now(), path: p };
      return reply(200, { name: this.settings.name, protocol: 'native_multi', modelid: MODEL, type: 'plug', mac: this.getMac(), version: VERSION, lights: 1 });
    }
    if (req.method === 'GET' && (p === '/state' || p === '/get')) {
      this.seen = { ip, at: Date.now(), path: p };
      return reply(200, { on: this.isOn() });
    }
    const isPut = (req.method === 'PUT' || req.method === 'POST') && p === '/state';
    const isSet = req.method === 'GET' && p === '/set';
    if (isPut || isSet) {
      this.seen = { ip, at: Date.now(), path: p };
      const want = isSet ? toBool(url.searchParams.get('on')) : pickOn(await readBody(req));
      if (want === undefined) return reply(200, 'OK'); // brightness or colour only: nothing to do for a monitor
      const state = want ? 'on' : 'off';
      this.switched = { ip, at: Date.now(), state };
      this.request(state, ip);
      return reply(200, 'OK');
    }
    return reply(404, 'Not found');
  }

  status() {
    return {
      enabled: this.settings.enabled,
      name: this.settings.name,
      port: this.port,
      listening: this.listening,
      error: this.error,
      address: this.settings.address,
      dockerAddress: dockerAddress(),
      addresses: this.settings.address === 'docker' ? [dockerAddress()].filter(Boolean) : lanAddresses(),
      lanAddresses: lanAddresses(),
      seen: this.seen,
      switched: this.switched,
      now: Date.now(),
    };
  }
}

module.exports = { HueLight, pickOn, lanInterfaces, dockerAddress };
