'use strict';
// Optional dashboard password. With no password set, everyone on the home network can open the dashboard.
// With one set, browsers sign in once and stay signed in (a long-lived cookie derived from the password, so it
// survives restarts). Deliberately simple: no lockouts, no session table.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const COOKIE = 'hb_session';
const MAX_AGE = 365 * 24 * 3600; // seconds
const MIN_LENGTH = 4;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const scrypt = (password, salt, params) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });

class AdminAuth {
  constructor(file = path.join(DATA_DIR, 'admin.json')) {
    this.file = file;
    this.record = null;
    this.loadedMtime = -1;
    this.refresh();
  }

  // The password can also be set or removed from the command line (deploy/set-password.js) while the server runs,
  // so notice when the file changes.
  refresh() {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      /* no file: no password */
    }
    if (mtime === this.loadedMtime) return;
    this.loadedMtime = mtime;
    try {
      this.record = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.record = null;
    }
  }

  isSet() {
    this.refresh();
    return Boolean(this.record && this.record.hash && this.record.salt);
  }

  async setPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_LENGTH) throw new Error(`Password must be at least ${MIN_LENGTH} characters.`);
    if (password.length > 200) throw new Error('Password is too long.');
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT);
    this.record = { salt: salt.toString('hex'), hash: key.toString('hex'), params: SCRYPT };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.record), { mode: 0o600 });
    this.syncMtime();
  }

  clearPassword() {
    fs.rmSync(this.file, { force: true });
    this.record = null;
    this.syncMtime();
  }

  syncMtime() {
    try {
      this.loadedMtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.loadedMtime = 0;
    }
  }

  async verify(password) {
    if (!this.isSet() || typeof password !== 'string' || password.length > 200) return false;
    const key = await scrypt(password, Buffer.from(this.record.salt, 'hex'), this.record.params || SCRYPT);
    const expected = Buffer.from(this.record.hash, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  }

  // The cookie value proves the browser signed in with the current password; changing the password invalidates it.
  token() {
    return crypto.createHmac('sha256', this.record.hash).update('homeboard-session').digest('hex');
  }

  tokenFrom(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return null;
  }

  // Signed in? Always yes when no password is set.
  sessionFrom(req) {
    if (!this.isSet()) return { open: true };
    const got = this.tokenFrom(req);
    if (!got) return null;
    const want = this.token();
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? { open: false } : null;
  }

  cookie() {
    return `${COOKIE}=${this.token()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}`;
  }
  clearCookie() {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

module.exports = { AdminAuth, MIN_LENGTH };
