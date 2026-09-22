'use strict';
// Switches the monitor on and off from the server.
//   1. HDMI-CEC (cec-client, package cec-utils): tells the monitor itself to go to standby or wake up. This is the
//      real power switch, and the one that is used whenever the Pi has a CEC adapter.
//   2. If the monitor does not confirm that (many computer monitors ignore CEC), the picture is switched off as well,
//      which makes the monitor put itself to sleep. The server runs as a background service, so it has to find the
//      desktop session on its own. It tries, in order:
//        wlopm      (Raspberry Pi OS Bookworm and newer, labwc/Wayfire: real "display power off")
//        wlr-randr  (same desktops, if wlopm is not installed: switches the output off and on)
//        xset dpms  (older Raspberry Pi OS with the X11 desktop)
//        vcgencmd   (very old firmware)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./config');

const MEMORY_FILE = path.join(DATA_DIR, 'display.json');

function exec(cmd, args, env, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        missing: Boolean(err && err.code === 'ENOENT'),
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim().split('\n')[0],
      });
    });
  });
}

// The service does not start inside the desktop, so tell the tools where the desktop is.
function sessionEnv() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  let wayland = null;
  try {
    wayland = fs.readdirSync(runtime).filter((n) => /^wayland-\d+$/.test(n)).sort()[0] || null;
  } catch {
    /* no desktop session yet */
  }
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, DISPLAY: process.env.DISPLAY || ':0', XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority') };
  if (wayland) env.WAYLAND_DISPLAY = wayland;
  return { env, wayland };
}

// wlr-randr prints one unindented line per output followed by indented "Key: value" lines.
function parseRandr(text) {
  const outputs = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (/^\S/.test(line)) {
      cur = { name: line.split(/\s+/)[0], enabled: true, transform: null };
      outputs.push(cur);
    } else if (cur) {
      let m = /^\s*Enabled:\s*(yes|no)/i.exec(line);
      if (m) cur.enabled = m[1].toLowerCase() === 'yes';
      m = /^\s*Transform:\s*(\S+)/.exec(line);
      if (m) cur.transform = m[1];
    }
  }
  return outputs;
}

// wlopm prints one "output-name on|off" line per screen.
function parseWlopm(text) {
  const outputs = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\S+)\s+(on|off)\s*$/i.exec(line.trim());
    if (m) outputs.push({ name: m[1], on: m[2].toLowerCase() === 'on' });
  }
  return outputs;
}

// The rotation of each screen is remembered while it is switched off, so it can be put back exactly.
function readMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')).transforms || {};
  } catch {
    return {};
  }
}
function writeMemory(transforms) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ transforms }), { mode: 0o600 });
  } catch {
    /* not critical */
  }
}

async function detectPicture() {
  const { env, wayland } = sessionEnv();
  let reason = null;
  let value = null;

  if (wayland) {
    const w = await exec('wlopm', [], env, 4000);
    const l = w.ok && parseWlopm(w.out).length ? w : null;
    const r = await exec('wlr-randr', [], env, 4000);
    if (l) value = { method: 'wlopm', label: 'Wayland (wlopm)', fallback: r.ok, outputs: parseWlopm(l.out).map((o) => o.name) };
    else if (r.ok) value = { method: 'wlr-randr', label: 'Wayland (wlr-randr)', outputs: parseRandr(r.out).map((o) => o.name) };
    else if (r.missing) reason = 'No screen-control tool is installed. On the Pi run:  sudo apt install -y wlopm wlr-randr';
    else reason = `wlr-randr could not talk to the desktop (${r.err || 'unknown error'}).`;
  }
  if (!value) {
    const x = await exec('xset', ['q'], env, 4000);
    if (x.ok) value = { method: 'xset', label: 'X11 (xset)' };
    else if (x.missing && !reason) reason = 'No screen-control tool found. On the Pi run:  sudo apt install -y wlopm wlr-randr x11-xserver-utils';
  }
  if (!value) {
    const v = await exec('vcgencmd', ['display_power'], env, 4000);
    if (v.ok && /display_power=[01]/.test(v.out)) value = { method: 'vcgencmd', label: 'Raspberry Pi firmware (vcgencmd)' };
  }
  if (!value) value = { method: null, label: 'Not found', reason: reason || 'The Pi desktop is not running yet, so there is no screen to switch.' };
  return value;
}

// True if the desktop still has a screen switched off with wlr-randr (from an earlier off, or before a restart).
async function anyDisabled(env) {
  const r = await exec('wlr-randr', [], env);
  return r.ok && parseRandr(r.out).some((o) => !o.enabled);
}

// Picture only: on = true switches the picture back on, false switches it off. Always resolves, never throws.
async function pictureSet(on, d) {
  if (!d.method) return { ok: false, method: null, message: d.reason };
  const { env } = sessionEnv();

  if (d.method === 'wlopm' || d.method === 'wlr-randr') {
    // 1. wlopm switches the output's power without touching its layout or rotation (this is what Raspberry Pi OS itself uses).
    if (d.method === 'wlopm') {
      const r = await exec('wlopm', [on ? '--on' : '--off', '*'], env);
      const after = r.ok ? parseWlopm((await exec('wlopm', [], env)).out) : [];
      if (r.ok && after.length && after.every((o) => o.on === on) && (!on || !(await anyDisabled(env)))) return { ok: true, method: 'wlopm', message: `Screen ${on ? 'on' : 'off'} (${after.map((o) => o.name).join(', ')})` };
      if (!d.fallback) return { ok: false, method: 'wlopm', message: `wlopm did not switch the screen ${on ? 'on' : 'off'}${r.ok ? '' : `: ${r.err}`}` };
    }
    // 2. wlr-randr disables the output. Its rotation is remembered and put back when the screen wakes.
    const listed = await exec('wlr-randr', [], env);
    if (!listed.ok) return { ok: false, method: 'wlr-randr', message: `wlr-randr failed: ${listed.err}` };
    const outputs = parseRandr(listed.out);
    if (!outputs.length) return { ok: false, method: 'wlr-randr', message: 'The desktop does not list any screen right now (the monitor may be unplugged or still starting).' };
    const memory = readMemory();
    const args = [];
    if (!on) {
      for (const o of outputs) {
        if (o.enabled && o.transform) memory[o.name] = o.transform; // remember the rotation before it goes dark
        args.push('--output', o.name, '--off');
      }
      writeMemory(memory);
    } else {
      for (const o of outputs.filter((x) => !x.enabled)) {
        args.push('--output', o.name, '--on');
        const t = o.transform && o.transform !== 'normal' ? o.transform : memory[o.name]; // what the desktop still knows, else what we saved
        if (t && t !== 'normal') args.push('--transform', t);
      }
    }
    if (args.length) {
      const r = await exec('wlr-randr', args, env);
      if (!r.ok) return { ok: false, method: 'wlr-randr', message: `wlr-randr failed: ${r.err}` };
    }
    const check = await exec('wlr-randr', [], env);
    const after = check.ok ? parseRandr(check.out) : [];
    if (after.length && after.some((o) => o.enabled !== on)) return { ok: false, method: 'wlr-randr', message: `The screen did not switch ${on ? 'on' : 'off'} (the command was accepted but the state did not change).` };
    return { ok: true, method: 'wlr-randr', message: `Screen ${on ? 'on' : 'off'} (${outputs.map((o) => o.name).join(', ')})` };
  }

  if (d.method === 'xset') {
    // Blanking is normally disabled on the Pi. Turn it on just long enough to force the change, then disable it again
    // so the screen never blanks by itself in the daytime.
    const steps = on
      ? [['dpms', 'force', 'on'], ['-dpms'], ['s', 'off']]
      : [['+dpms'], ['dpms', '0', '0', '0'], ['dpms', 'force', 'off']];
    for (const s of steps) {
      const r = await exec('xset', s, env);
      if (!r.ok && s[0] !== '-dpms' && s[0] !== 's') return { ok: false, method: d.method, message: `xset failed: ${r.err}` };
    }
    return { ok: true, method: d.method, message: `Screen ${on ? 'on' : 'off'} (xset)` };
  }

  const r = await exec('vcgencmd', ['display_power', on ? '1' : '0'], env);
  if (!r.ok) return { ok: false, method: d.method, message: `vcgencmd failed: ${r.err}` };
  const back = await exec('vcgencmd', ['display_power'], env);
  if (!new RegExp(`display_power=${on ? 1 : 0}`).test(back.out)) return { ok: false, method: d.method, message: 'vcgencmd accepted the command but the screen did not change.' };
  return { ok: true, method: d.method, message: `Screen ${on ? 'on' : 'off'} (vcgencmd)` };
}

// ---------------------------------------------------------------- HDMI-CEC
// cec-client can only be run once at a time (it takes over the adapter), so every call waits for the one before.
let cecQueue = Promise.resolve();
function cecRun(args, input, timeout) {
  const job = cecQueue.then(
    () =>
      new Promise((resolve) => {
        let done = false;
        const finish = (r) => {
          if (done) return;
          done = true;
          clearTimeout(hard);
          resolve(r);
        };
        const child = execFile('cec-client', args, { timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
          finish({ ok: !err, missing: Boolean(err && err.code === 'ENOENT'), out: String(stdout || ''), err: String(stderr || (err && err.message) || '').trim().split('\n')[0] });
        });
        // A program that hangs must never block the next one, so give up after the timeout whatever happens.
        const hard = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          finish({ ok: false, missing: false, out: '', err: 'cec-client did not finish in time' });
        }, timeout + 2000);
        if (input && child.stdin) {
          child.stdin.on('error', () => {});
          child.stdin.end(input);
        }
      })
  );
  cecQueue = job.catch(() => {});
  return job;
}
const cecWait = () => new Promise((r) => setTimeout(r, Number(process.env.HOMEBOARD_CEC_WAIT_MS) || 2500));

// cec-client prints "power status: on", "power status: standby", "power status: in transition from standby to on" ...
function parsePower(text) {
  const m = /power status:\s*(.+)/i.exec(String(text));
  if (!m) return { state: 'unknown' };
  const t = m[1].trim().toLowerCase();
  if (t === 'on') return { state: 'on' };
  if (t === 'standby') return { state: 'standby' };
  const tr = /transition from \w+ to (\w+)/.exec(t);
  if (tr) return { state: 'transition', to: tr[1] === 'on' ? 'on' : 'standby' };
  return { state: 'unknown' };
}

const CEC_HELP = 'Use the HDMI port next to the Pi\'s power port (HDMI 0), and switch on HDMI-CEC in the monitor\'s own menu (it may be called HDMI Control, Anynet+, Simplink, EasyLink or Bravia Sync).';

async function detectCec() {
  const r = await cecRun(['-l'], '', 8000);
  if (r.missing) return { available: false, missing: true, reason: 'HDMI-CEC is not installed. On the Pi run:  sudo apt install -y cec-utils' };
  const m = /Found devices:\s*(\d+)/i.exec(r.out);
  if (!m) return { available: false, reason: `cec-client did not run properly (${r.err || 'no answer'}).` };
  if (Number(m[1]) === 0) return { available: false, reason: `The Pi shows no HDMI-CEC adapter. ${CEC_HELP} Also check that the Pi's config.txt does not switch CEC off (a line such as hdmi_ignore_cec=1, or nocec on the dtoverlay=vc4-kms-v3d line) and that the user running Homeboard is in the video group.` };
  return { available: true };
}

// Asks the monitor whether it is on. Used by the "Check HDMI-CEC" button and to confirm every switch.
async function cecStatus() {
  const r = await cecRun(['-s', '-d', '1'], 'pow 0\n', 12000);
  if (r.missing) return { ok: false, state: 'unknown', message: 'cec-client is not installed. Run:  sudo apt install -y cec-utils' };
  const p = parsePower(r.out);
  if (!r.ok && p.state === 'unknown') return { ok: false, state: 'unknown', adapter: false, message: `cec-client could not talk to the HDMI-CEC adapter (${r.err || 'unknown error'}).` };
  if (p.state === 'unknown') return { ok: false, state: 'unknown', message: `The monitor did not answer over HDMI-CEC. ${CEC_HELP}` };
  const text = p.state === 'transition' ? `switching ${p.to === 'on' ? 'on' : 'to standby'}` : p.state === 'standby' ? 'in standby' : 'on';
  return { ok: true, state: p.state, to: p.to, message: `The monitor answered over HDMI-CEC: it is ${text}.` };
}

// Sends the switch command, then asks the monitor whether it did it.
// Result: { sent, confirmed, message }.
async function cecSet(on) {
  const steps = on ? ['on 0', 'as'] : ['standby 0']; // "as" makes the Pi the active input, so the monitor shows it
  for (const step of steps) {
    const r = await cecRun(['-s', '-d', '1'], `${step}\n`, 20000);
    if (!r.ok) return { sent: false, confirmed: false, message: r.missing ? 'cec-client is not installed.' : `cec-client failed: ${r.err || 'unknown error'}` };
    if (step !== steps[steps.length - 1]) await cecWait();
  }
  const goal = on ? 'on' : 'standby';
  let silent = 0;
  for (let i = 0; i < 4; i++) {
    await cecWait();
    const st = await cecStatus();
    if (st.ok && (st.state === goal || (st.state === 'transition' && st.to === goal))) return { sent: true, confirmed: true, message: `Monitor ${on ? 'woken' : 'put in standby'} over HDMI-CEC` };
    if (!st.ok && ++silent >= 2) break; // it does not answer at all
    if (st.ok && st.state !== 'transition' && i >= (on ? 2 : 1)) break; // it answers but is not doing it (a monitor can be slow to wake)
  }
  return { sent: true, confirmed: false, message: 'The monitor did not confirm the HDMI-CEC command.' };
}

// ---------------------------------------------------------------- what is available, and switching
let detected = { at: 0, value: null };

async function detect(force = false) {
  if (!force && detected.value && Date.now() - detected.at < (detected.value.method ? 60000 : 15000)) return detected.value;
  const [picture, cec] = await Promise.all([detectPicture(), detectCec()]);
  const method = cec.available ? 'cec' : picture.method;
  const value = {
    method,
    label: cec.available ? `HDMI-CEC${picture.method ? `, with ${picture.label} as backup` : ''}` : picture.label,
    reason: method ? null : cec.missing && /No screen-control tool/.test(picture.reason || '') ? 'Nothing is installed yet that can switch the monitor. On the Pi run:  sudo apt install -y cec-utils wlopm wlr-randr' : `${cec.reason} ${picture.reason || ''}`.trim(),
    picture,
    cec,
  };
  detected = { at: Date.now(), value };
  return value;
}

// on = true wakes the monitor, false puts it to sleep. Always resolves, never throws.
// opts.cec = false skips HDMI-CEC and only switches the picture.
// Result: { ok, method, message, warning? }. A warning means it worked, but something needs a look.
async function set(on, opts = {}) {
  const d = await detect(true);
  const pic = d.picture;
  const useCec = opts.cec !== false && d.cec.available;
  if (!useCec) {
    if (!pic.method) return { ok: false, method: null, message: opts.cec === false ? pic.reason : d.reason };
    return pictureSet(on, pic);
  }
  if (opts.check) {
    // A re-check (the ten-minute repeat, or the first switch after the server starts): ask before sending anything.
    const goal = on ? 'on' : 'standby';
    const st = await cecStatus();
    if (st.ok && (st.state === goal || (st.state === 'transition' && st.to === goal))) {
      if (on && pic.method) await pictureSet(true, pic); // the picture may still be off from an earlier backup switch-off
      return { ok: true, method: 'cec', message: `Monitor already ${on ? 'on' : 'in standby'} (HDMI-CEC)` };
    }
    if (!st.ok && !on && pic.method) {
      // The monitor does not answer HDMI-CEC, so do not keep sending it commands all night: the picture is enough.
      const q = await pictureSet(false, pic);
      if (q.ok) return { ...q, warning: `The monitor does not answer over HDMI-CEC, so only the picture is switched off. ${CEC_HELP}` };
    }
  }
  let p = { ok: false };
  if (on) {
    if (pic.method) p = await pictureSet(true, pic); // if the picture was switched off before, bring it back first
    const c = await cecSet(true);
    if (c.confirmed) return { ok: true, method: 'cec', message: c.message };
    if (c.sent || p.ok) return { ok: true, method: 'cec', message: `Wake-up sent over HDMI-CEC${p.ok ? ` and the picture switched on (${pic.label})` : ''}`, warning: `${c.message} If the monitor stays dark, check its HDMI-CEC setting. ${CEC_HELP}` };
    return { ok: false, method: 'cec', message: c.message };
  }
  const c = await cecSet(false);
  if (c.confirmed) return { ok: true, method: 'cec', message: c.message };
  // The monitor ignored CEC (or did not answer). Switching the picture off makes it sleep anyway.
  if (pic.method) p = await pictureSet(false, pic);
  if (p.ok) return { ok: true, method: pic.method, message: `${p.message} (HDMI-CEC was not confirmed)`, warning: `The monitor did not react to HDMI-CEC, so only the picture was switched off. ${CEC_HELP}` };
  if (c.sent) return { ok: true, method: 'cec', message: 'Standby sent over HDMI-CEC', warning: `${c.message} ${CEC_HELP}` };
  return { ok: false, method: 'cec', message: c.message };
}

module.exports = { detect, set, cecStatus, parseRandr, parseWlopm, parsePower };
