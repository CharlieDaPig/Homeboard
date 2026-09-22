'use strict';
// Philips Hue support: switch a smart plug (or any Hue light) on and off together with the screen.
// Uses the Hue Bridge's local API over your home network. The link is made once by pressing the round
// button on the bridge; the key it hands back is kept in data/hue.json (readable only by this user).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'hue.json');
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

class HueError extends Error {}

function cleanHost(input) {
  const host = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host || !HOST_RE.test(host)) throw new HueError('That does not look like an address. Type something like 192.168.1.20');
  return host;
}

// The bridge uses a certificate signed by Philips Hue itself, which no computer knows about, so it cannot be
// checked the normal way. That is fine on a home network.
function request(host, method, pathname, { body, key, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (key) headers['hue-application-key'] = key;
    const req = https.request({ host: hostname, port: port ? Number(port) : 443, method, path: pathname, headers, rejectUnauthorized: false, timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size < 2 * 1024 * 1024) chunks.push(c);
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(new HueError(`Could not reach the Hue bridge at ${host} (${err.code || err.message}). Check the address, and that the Pi and the bridge are on the same network.`)));
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Hue {
  constructor(file = FILE) {
    this.file = file;
    this.data = this.read();
  }

  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { bridge: String(d.bridge || ''), key: String(d.key || ''), targets: Array.isArray(d.targets) ? d.targets.filter((t) => t && typeof t.id === 'string').map((t) => ({ id: t.id, name: String(t.name || '') })) : [] };
    } catch {
      return { bridge: '', key: '', targets: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isLinked() {
    return Boolean(this.data.bridge && this.data.key);
  }

  hasTargets() {
    return this.isLinked() && this.data.targets.length > 0;
  }

  status() {
    return { linked: this.isLinked(), bridge: this.data.bridge || null, targets: this.data.targets };
  }

  // Ask an address whether it is a Hue bridge. Returns its name, or null.
  async probe(host) {
    try {
      const r = await request(host, 'GET', '/api/config', { timeout: 4000 });
      if (r.status === 200 && r.json && (r.json.bridgeid || r.json.modelid)) return { ip: host, name: r.json.name || 'Hue Bridge', id: r.json.bridgeid || null };
    } catch {
      /* not a bridge */
    }
    return null;
  }

  // Philips keeps a list of bridges by home network. Also try the name bridges answer to on the local network.
  async discover() {
    const candidates = new Set(['philips-hue.local']);
    try {
      const res = await fetch('https://discovery.meethue.com', { signal: AbortSignal.timeout(6000) });
      if (res.ok) for (const b of await res.json()) if (b && typeof b.internalipaddress === 'string' && HOST_RE.test(b.internalipaddress)) candidates.add(b.internalipaddress);
    } catch {
      /* offline or rate limited: the local name may still work */
    }
    const found = (await Promise.all([...candidates].map((c) => this.probe(c)))).filter(Boolean);
    found.sort((a, b) => Number(/^\d+\.\d+\.\d+\.\d+/.test(b.ip)) - Number(/^\d+\.\d+\.\d+\.\d+/.test(a.ip))); // a numeric address is safer to store than a .local name
    const seen = new Set();
    return found.filter((b) => (b.id && seen.has(b.id) ? false : (b.id && seen.add(b.id), true)));
  }

  // Waits up to 30 seconds for the round button on the bridge to be pressed.
  async link(hostInput, { waitMs = 30000, stepMs = 2000 } = {}) {
    const host = cleanHost(hostInput);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await request(host, 'POST', '/api', { body: { devicetype: 'homeboard#pi', generateclientkey: true } });
      const first = Array.isArray(r.json) ? r.json[0] : null;
      if (first && first.success && first.success.username) {
        this.data = { bridge: host, key: first.success.username, targets: this.data.bridge === host ? this.data.targets : [] };
        this.save();
        return this.status();
      }
      const type = first && first.error && first.error.type;
      if (type !== 101) throw new HueError(`The bridge refused the link${first && first.error ? `: ${first.error.description}` : ''}. Is ${host} really your Hue bridge?`);
      if (Date.now() + stepMs > deadline) throw new HueError('The round button on the bridge was not pressed in time. Click Link again, then press the button within 30 seconds.');
      await sleep(stepMs);
    }
  }

  unlink() {
    this.data = { bridge: '', key: '', targets: [] };
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }

  async call(method, pathname, body) {
    if (!this.isLinked()) throw new HueError('Hue is not linked yet.');
    const r = await request(this.data.bridge, method, pathname, { body, key: this.data.key });
    if (r.status === 401 || r.status === 403) throw new HueError('The bridge no longer accepts this link. Unlink Hue and link it again.');
    if (r.json && Array.isArray(r.json.errors) && r.json.errors.length) throw new HueError(r.json.errors.map((e) => e.description).join('; '));
    if (r.status >= 400 || !r.json) throw new HueError(`The bridge answered with an error (${r.status}).`);
    return r.json;
  }

  // Everything on the bridge that can be switched: smart plugs first, then lights.
  async lights() {
    const j = await this.call('GET', '/clip/v2/resource/light');
    const rank = (l) => (l.plug ? 0 : 1);
    return (j.data || [])
      .map((l) => ({ id: l.id, name: (l.metadata && l.metadata.name) || 'Unnamed', plug: Boolean(l.metadata && l.metadata.archetype === 'plug'), on: Boolean(l.on && l.on.on) }))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  setTargets(list) {
    if (!this.isLinked()) throw new HueError('Hue is not linked yet.');
    this.data.targets = list.slice(0, 20).map((t) => ({ id: String(t.id), name: String(t.name || '').slice(0, 80) }));
    this.save();
    return this.status();
  }

  // Switch every chosen device. Never throws; says which ones failed.
  async setOn(on) {
    if (!this.hasTargets()) return { ok: true, skipped: true, message: 'No Hue device chosen' };
    const failed = [];
    for (const t of this.data.targets) {
      try {
        await this.call('PUT', `/clip/v2/resource/light/${encodeURIComponent(t.id)}`, { on: { on } });
      } catch (err) {
        failed.push(`${t.name || t.id}: ${err.message}`);
      }
    }
    return failed.length
      ? { ok: false, message: `Hue: ${failed.join(' | ')}` }
      : { ok: true, message: `Hue ${on ? 'on' : 'off'}: ${this.data.targets.map((t) => t.name || t.id).join(', ')}` };
  }
}

module.exports = { Hue, HueError };
