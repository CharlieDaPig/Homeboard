'use strict';
// Switches the monitor on and off on a daily schedule (and on demand), optionally together with a Hue smart plug.
// The schedule lives in data/power.json and is separate from the other dashboard settings, so changing it never
// reloads the screen.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { ValidationError } = require('./settings');

const DEFAULTS = {
  enabled: true,
  onTime: '07:00',
  offTime: '22:00',
  weekendDifferent: false,
  weekendOnTime: '08:00',
  weekendOffTime: '23:00',
  useCec: true,
  hueWithScreen: true,
  dismissCecWarning: false, // set once the user has confirmed their monitor just doesn't support HDMI-CEC
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SPEC = {
  enabled: 'bool',
  onTime: 'time',
  offTime: 'time',
  weekendDifferent: 'bool',
  weekendOnTime: 'time',
  weekendOffTime: 'time',
  useCec: 'bool',
  hueWithScreen: 'bool',
  dismissCecWarning: 'bool',
};
const LABELS = { enabled: 'Schedule', onTime: 'Turn on at', offTime: 'Turn off at', weekendDifferent: 'Weekend times', weekendOnTime: 'Weekend turn on at', weekendOffTime: 'Weekend turn off at', useCec: 'HDMI-CEC', hueWithScreen: 'Hue', dismissCecWarning: 'HDMI-CEC warning' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// on/off are minutes since midnight. A window that runs past midnight (on 18:00, off 02:00) is fine.
function inWindow(minute, on, off) {
  if (on === off) return true; // same time means "never turns off"
  return on < off ? minute >= on && minute < off : minute >= on || minute < off;
}

class Power {
  constructor({ display, hue, broadcast, file = path.join(DATA_DIR, 'power.json'), now = () => new Date(), waits = {} }) {
    this.display = display;
    this.hue = hue || { hasTargets: () => false, status: () => ({ linked: false, bridge: null, targets: [] }), setOn: async () => ({ ok: true }) }; // no Hue: nothing to do
    this.waits = { afterScreenOff: 3000, afterHueOn: 7000, retryWake: 4000, ...waits };
    this.broadcast = broadcast || (() => {});
    this.file = file;
    this.now = now;
    this.settings = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(saved)) {
        if (SPEC[k]) {
          try {
            this.settings[k] = this.coerce(k, v);
          } catch {
            /* ignore a bad saved value */
          }
        }
      }
    } catch {
      /* no saved schedule yet: defaults */
    }
    this.applied = null; // what we last managed to do: 'on' | 'off'
    this.appliedAt = 0;
    this.override = null; // { state, base } while someone has pressed On/Off by hand
    this.last = null; // { at, ok, message } of the latest attempt
    this.failures = 0;
    this.nextTryAt = 0;
    this.busy = false;
    this.holdUntil = 0; // after the plug's power is restored, wait for the monitor to start before working out its state
    this.timer = null;
  }

  coerce(key, value) {
    if (SPEC[key] === 'bool') {
      if (typeof value !== 'boolean') throw 'must be on or off';
      return value;
    }
    if (typeof value !== 'string' || !TIME_RE.test(value.trim())) throw 'must be a time like 07:00';
    return value.trim();
  }

  update(patch) {
    const problems = [];
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (!SPEC[key]) {
        problems.push({ key, message: 'unknown setting' });
        continue;
      }
      try {
        clean[key] = this.coerce(key, value);
      } catch (message) {
        problems.push({ key, message: `${LABELS[key]}: ${message}` });
      }
    }
    if (problems.length) throw new ValidationError(problems);
    const hueTurnedOn = clean.hueWithScreen === true && !this.settings.hueWithScreen;
    Object.assign(this.settings, clean);
    if (hueTurnedOn && this.applied === 'off') this.appliedAt = 0; // cut the plug's power at the next tick
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.failures = 0;
    this.nextTryAt = 0;
    return Object.keys(clean);
  }

  // The times that apply on a given day.
  timesFor(date) {
    const s = this.settings;
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    return weekend && s.weekendDifferent ? { on: s.weekendOnTime, off: s.weekendOffTime } : { on: s.onTime, off: s.offTime };
  }

  // What the schedule alone says right now. A window that runs past midnight belongs to the day it started on,
  // so Friday 6 PM to 2 AM is still on at Saturday 1 AM even if Saturday has its own times.
  scheduledState(date = this.now()) {
    if (!this.settings.enabled) return 'on';
    const minute = date.getHours() * 60 + date.getMinutes();
    const today = this.timesFor(date);
    const on = toMinutes(today.on);
    const off = toMinutes(today.off);
    if (on === off) return 'on'; // same time means it never turns off
    if (on < off ? minute >= on && minute < off : minute >= on) return 'on';
    const yesterday = this.timesFor(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12));
    const yOn = toMinutes(yesterday.on);
    const yOff = toMinutes(yesterday.off);
    return yOn > yOff && minute < yOff ? 'on' : 'off';
  }

  // When the schedule next changes, looking up to eight days ahead.
  nextChange(date = this.now()) {
    if (!this.settings.enabled) return null;
    const current = this.scheduledState(date);
    const t = new Date(date);
    t.setSeconds(0, 0);
    for (let i = 1; i <= 8 * 24 * 60; i++) {
      const at = new Date(t.getTime() + i * 60000);
      const s = this.scheduledState(at);
      if (s !== current) return { at: at.getTime(), to: s };
    }
    return null;
  }

  // The next time the schedule switches to `target` ('on' or 'off'), looking up to eight days ahead.
  nextTo(target, date = this.now()) {
    if (!this.settings.enabled) return null;
    const t = new Date(date);
    t.setSeconds(0, 0);
    let prev = this.scheduledState(t);
    for (let i = 1; i <= 8 * 24 * 60; i++) {
      const at = new Date(t.getTime() + i * 60000);
      const cur = this.scheduledState(at);
      if (cur === target && prev !== target) return at.getTime();
      prev = cur;
    }
    return null;
  }

  wanted(date = this.now()) {
    const scheduled = this.scheduledState(date);
    if (this.override && this.override.base !== scheduled) this.override = null; // the next scheduled change ends a manual choice
    return this.override ? this.override.state : scheduled;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 20000);
    setTimeout(() => this.tick().catch(() => {}), 4000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(force = false) {
    if (this.busy) return;
    if (Date.now() < this.holdUntil) return; // a follow-up tick is already scheduled for when the monitor has started
    if (!force && Date.now() < this.nextTryAt) return;
    const want = this.wanted();
    if (!this.settings.enabled && !this.override) {
      if (this.applied === 'on') return; // nothing to do
      // Schedule off and the screen is asleep (or we do not know yet, after a restart): make sure it is awake.
      if (this.applied === null && !(await this.canSwitch())) return;
    }
    const stale = want === 'off' && this.applied === 'off' && Date.now() - this.appliedAt > 10 * 60 * 1000; // an X11 wake-up by keypress gets put back to sleep
    if (want === this.applied && !stale) return;
    await this.apply(want, { check: stale || (this.applied === null && this.failures === 0) });
  }

  // Run the switch again soon, even though the state has not changed (used after the Hue devices change).
  reassert() {
    if (this.applied === 'off') this.appliedAt = 0;
    this.tick(true).catch(() => {});
  }

  // Someone is about to stop or change the Hue devices while the screen is asleep: give the monitor its power back first,
  // otherwise the plug would stay off forever.
  async releaseHue() {
    if (this.applied === 'off' && this.hue.hasTargets()) {
      const r = await this.hue.setOn(true);
      if (r.ok) {
        // The monitor is powered again, so nothing is known about its state any more. Once it has started, the next tick
        // puts it to sleep again (or leaves it on) according to what is set up by then.
        this.applied = null;
        this.appliedAt = 0;
        this.holdUntil = Date.now() + this.waits.afterHueOn + 1000;
        const later = setTimeout(() => this.tick(true).catch(() => {}), this.waits.afterHueOn + 1500);
        if (later.unref) later.unref();
      }
      return r;
    }
    return { ok: true };
  }

  // What can switch the screen right now, given whether HDMI-CEC is switched on in the settings.
  effective(d) {
    return this.settings.useCec && d.cec && d.cec.available ? d : { ...d, method: d.picture ? d.picture.method : d.method, label: d.picture ? d.picture.label : d.label, reason: d.picture ? d.picture.reason : d.reason };
  }

  async canSwitch() {
    return Boolean(this.effective(await this.display.detect()).method) || this.hue.hasTargets();
  }

  // With a Hue smart plug the order matters. Off: the monitor is put to standby first, then the plug cuts its power a
  // few seconds later. On: the plug comes on first, the monitor gets a few seconds to start, then it is woken.
  async apply(want, opts = {}) {
    this.busy = true;
    const previous = this.applied;
    const wasOff = previous === 'off';
    const parts = [];
    let ok = true;
    let warning = null;
    const useHue = this.settings.hueWithScreen && this.hue.hasTargets();
    const displayOpts = { cec: this.settings.useCec, check: Boolean(opts.check) };
    try {
      if (want === 'off') {
        // The ten-minute re-check with a plug: the monitor has no power, so only the plug needs repeating.
        const skipDisplay = useHue && previous === 'off';
        const d = skipDisplay ? { ok: true, message: '' } : await this.display.set(false, displayOpts);
        parts.push(d.message);
        if (!useHue) warning = d.warning || null;
        if (!d.ok && !useHue) ok = false;
        if (useHue) {
          if (!skipDisplay) await sleep(this.waits.afterScreenOff); // let the monitor settle before its power goes
          const h = await this.hue.setOn(false);
          parts.push(h.message);
          if (!h.ok) ok = false;
          if (!d.ok && h.ok) ok = true; // the plug alone is enough
        }
      } else {
        let plugFailed = false;
        if (useHue) {
          const h = await this.hue.setOn(true);
          parts.push(h.message);
          if (!h.ok) {
            ok = false;
            plugFailed = true;
          } else if (wasOff || previous === null) await sleep(this.waits.afterHueOn); // a monitor takes a few seconds to start
        }
        let d = await this.display.set(true, displayOpts);
        // Just after the plug came on, the monitor may still be starting and ignore the first wake-up: try again a few times.
        for (let i = 0; useHue && !plugFailed && (wasOff || previous === null) && (!d.ok || d.warning) && i < 3; i++) {
          await sleep(this.waits.retryWake);
          d = await this.display.set(true, displayOpts);
        }
        parts.push(d.message);
        warning = d.warning || null;
        if (!d.ok && !(d.method === null && useHue && ok)) ok = false;
      }
    } catch (err) {
      ok = false;
      parts.push(err.message);
    } finally {
      this.busy = false;
    }
    const message = parts.filter(Boolean).join('. ');
    this.last = { at: Date.now(), ok, message, want, warning: ok ? warning : null };
    if (ok) {
      this.applied = want;
      this.appliedAt = Date.now();
      this.failures = 0;
      this.nextTryAt = 0;
      if (want !== previous) console.log(`Screen power: ${want}. ${message}`); // not for the quiet 10-minute re-check
      if (warning && want !== previous) console.warn(`Screen power: ${warning}`);
      if (want === 'on' && (wasOff || (previous === null && useHue))) setTimeout(() => this.broadcast('reload'), 2500); // redraw after the monitor is back
    } else {
      this.applied = null; // we no longer know what state the screen is in, so the next tick works it out again
      this.failures++;
      this.nextTryAt = Date.now() + Math.min(300000, 20000 * 2 ** Math.min(this.failures - 1, 4));
      if (this.failures === 1 || this.failures % 10 === 0) console.warn(`Screen power: could not switch ${want}: ${message}`);
    }
    return this.last;
  }

  async manual(state, source = 'the dashboard') {
    if (state !== 'on' && state !== 'off') throw Object.assign(new Error('State must be on or off.'), { status: 400 });
    if (this.busy) throw Object.assign(new Error('Still busy switching. Try again in a few seconds.'), { status: 409 });
    const scheduled = this.scheduledState();
    this.override = state === scheduled ? null : { state, base: scheduled }; // pressing the same thing the schedule wants is not an override
    const r = await this.apply(state);
    if (r.ok) console.log(`Screen switched ${state} from ${source}.`);
    else this.override = null; // do not keep retrying something that cannot work
    return r;
  }

  async resume() {
    this.override = null;
    if (this.busy) return this.last;
    const want = this.wanted();
    if (want !== this.applied) return this.apply(want);
    return this.last;
  }

  async status() {
    const d = this.effective(await this.display.detect());
    const date = this.now();
    const scheduled = this.scheduledState(date);
    const wanted = this.wanted(date);
    return {
      settings: { ...this.settings },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      scheduled,
      wanted,
      applied: this.applied,
      manual: this.override ? this.override.state : null,
      manualUntil: this.override ? this.nextTo(this.override.state === 'off' ? 'on' : 'off', date) : null,
      next: this.nextChange(date),
      display: { method: d.method, label: d.label, reason: d.reason || null, cec: d.cec ? { available: d.cec.available, reason: d.cec.reason || null } : null },
      hue: { ...this.hue.status(), use: this.settings.hueWithScreen },
      last: this.last,
      failing: this.failures > 0,
      now: date.getTime(),
    };
  }
}

module.exports = { Power, inWindow, DEFAULTS };
