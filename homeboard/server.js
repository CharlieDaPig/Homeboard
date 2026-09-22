'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, ROOT, DATA_DIR } = require('./lib/config');
const { Settings } = require('./lib/settings');
const { state, captureLogs, broadcast } = require('./lib/state');

captureLogs(); // must come first so start-up messages reach the dashboard's log view

const { AdminAuth } = require('./lib/auth');
const { SetupNeeded } = require('./lib/errors');
const { Calendars } = require('./lib/calendars');
const { Todoist } = require('./lib/todoist');
const { createData } = require('./lib/data');
const { createAdmin } = require('./lib/admin');
const backgrounds = require('./lib/backgrounds');
const mock = require('./lib/mock');
const display = require('./lib/display');
const { Power } = require('./lib/power');
const { Hue } = require('./lib/hue');
const { HueLight } = require('./lib/huelight');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const base = loadConfig();
const settings = new Settings(base);
const cfg = () => settings.effective();
const calendars = new Calendars();
const todoist = new Todoist();
const auth = new AdminAuth();
const data = createData({ settings, calendars, todoist });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const ADMIN_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

// "Local" = the Pi itself, or someone tunnelled in over SSH. Other devices on the network can open the screen and the
// dashboard freely unless a dashboard password has been set (then they must sign in).
function isLocal(req) {
  const a = req.socket.remoteAddress;
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !req.headers['x-forwarded-for'];
}
// The Pi's addresses on the home network (not the private ones that Docker and virtual machines add).
function realAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|tun|tap|tailscale|zt)/.test(name)) continue;
    for (const a of list || []) if (a && (a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a);
  }
  return out;
}
// The address to type on another device, so the screen itself can tell you where to go.
function dashboardAddress() {
  const lan = realAddresses()[0];
  return `http://${lan ? lan.address : `${os.hostname()}.local`}:${base.port}/admin`;
}
const canView = (req) => isLocal(req) || Boolean(auth.sessionFrom(req));

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' };

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function page(title, message) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:20px/1.5 system-ui,sans-serif;background:#0b1018;color:#fff;max-width:36rem;margin:15vh auto;padding:0 1.5rem">
<h1 style="font-weight:400">${esc(title)}</h1><p style="color:#b8c2cf">${esc(message)}</p></body>`;
}

function readSmallJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(size <= limit ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const hue = new Hue();
const power = new Power({ display, hue, broadcast });
const hueLight = new HueLight({ power });
const admin = createAdmin({ settings, auth, calendars, todoist, data, isLocal, power, hue, hueLight });

// ---------------------------------------------------------------- screen API (/api/*)
async function handleApi(req, res, url) {
  if (!canView(req)) {
    return send(res, 403, { error: 'forbidden', message: 'A dashboard password is set. Open /admin on this device and sign in first' });
  }
  const route = url.pathname;
  const c = cfg();

  if (route === '/api/config') {
    return send(res, 200, {
      epoch: state.epoch,
      version: settings.version,
      locale: c.locale,
      display: c.display,
      refresh: c.refresh,
      calendar: c.calendar,
      tasks: { title: c.tasks.title, maxItems: c.tasks.maxItems },
      weather: { label: c.weather.label },
      mock: c.mock,
    });
  }

  if (route === '/api/status') {
    if (c.mock) return send(res, 200, { calendar: { ok: true, error: null }, tasks: { ok: true, error: null } });
    return send(res, 200, {
      calendar: { ok: state.sources.calendar.ok !== false, error: state.sources.calendar.ok === false ? state.sources.calendar.error : null },
      tasks: { ok: state.sources.tasks.ok !== false, error: state.sources.tasks.ok === false ? state.sources.tasks.error : null },
    });
  }

  if (route === '/api/backgrounds') {
    const list = backgrounds.list(backgrounds.resolveFolder(c.backgrounds.folder));
    return send(res, 200, { images: list.images.map((i) => ({ name: i.name, url: i.url })) });
  }

  if (route === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
    res.isPreview = url.searchParams.get('preview') === '1';
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ epoch: state.epoch, version: settings.version })}\n\n`);
    state.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      state.clients.delete(res);
    });
    return;
  }

  if (route === '/api/heartbeat' && req.method === 'POST') {
    const b = await readSmallJson(req);
    state.screen = {
      at: Date.now(),
      background: typeof b.bg === 'string' ? b.bg.slice(0, 120) : null,
      width: Number(b.w) || null,
      height: Number(b.h) || null,
      version: typeof b.ver === 'number' ? b.ver : null,
    };
    return send(res, 204, '');
  }

  if (route === '/api/calendar') {
    if (c.mock) return send(res, 200, mock.mockEvents());
    const start = new Date(url.searchParams.get('start') || '');
    const end = new Date(url.searchParams.get('end') || '');
    const days = (end - start) / 86400000;
    if (Number.isNaN(days) || days <= 0 || days > 120) return send(res, 400, { error: 'bad_range', message: 'start/end must be ISO dates less than 120 days apart.' });
    return send(res, 200, await data.calendar(start.toISOString(), end.toISOString()));
  }
  if (route === '/api/tasks') return send(res, 200, await data.tasks());
  if (route === '/api/weather') return send(res, 200, await data.weather());

  return send(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- files
function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request', 'text/plain');
  }
  if (rel.includes('\0')) return send(res, 400, 'Bad request', 'text/plain');
  rel = path.posix.normalize(rel.replace(/\\/g, '/')); // so "/x/../admin/..." is judged as what it really is
  if (!rel.startsWith('/')) return send(res, 403, 'Forbidden', 'text/plain');
  if (rel === '/admin') return send(res, 302, '', 'text/plain', { Location: '/admin/' });
  if (rel === '/admin/') rel = '/admin/index.html';
  if (rel === '/') rel = '/index.html';
  if (rel.startsWith('/admin') && !cfg().admin.enabled) return send(res, 404, 'Not found', 'text/plain');
  const base = path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const headers = { 'Cache-Control': 'no-cache' };
    if (rel.startsWith('/admin/') && rel.endsWith('.html')) headers['Content-Security-Policy'] = ADMIN_CSP;
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', headers);
  });
}

function serveBackground(req, res, url) {
  if (!canView(req)) return send(res, 403, 'Forbidden', 'text/plain');
  let name;
  try {
    name = decodeURIComponent(url.pathname.slice('/backgrounds/'.length));
  } catch {
    return send(res, 400, 'Bad request', 'text/plain');
  }
  const file = backgrounds.pathFor(backgrounds.resolveFolder(cfg().backgrounds.folder), name);
  const type = file && backgrounds.MIME[path.extname(file).toLowerCase()];
  if (!file || !type) return send(res, 404, 'Not found', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'private, max-age=86400',
      // Uploaded pictures must never be able to run anything, even if opened directly.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...SECURITY_HEADERS,
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request', 'text/plain');
  }
  try {
    if (url.pathname.startsWith('/admin/api/')) {
      if (!cfg().admin.enabled) return send(res, 404, { error: 'disabled' });
      return await admin(req, res, url);
    }

    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/backgrounds/')) return serveBackground(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof SetupNeeded) return send(res, 401, { error: 'setup_needed', message: `${err.message} On your phone or computer, open ${dashboardAddress()} and choose the Calendar & Tasks tab.` });
    console.error(`${url.pathname}: ${err.message}`);
    // Only signed-in users (or the Pi itself) get the detail; it can contain file paths.
    return send(res, 502, { error: 'upstream', message: canView(req) ? err.message : 'Something went wrong.' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${base.port} is already in use. Is Homeboard already running? (sudo systemctl status homeboard)`);
  else console.error(`Server error: ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => console.error(`Unhandled error: ${err && err.message ? err.message : err}`));
process.on('uncaughtException', (err) => {
  console.error(`Fatal error: ${err && err.stack ? err.stack : err}`);
  process.exit(1); // the background service restarts us
});

server.listen(base.port, base.host, () => {
  const local = `http://localhost:${base.port}`;
  console.log(`Homeboard running at ${local}${base.mock ? '  (MOCK DATA)' : ''}`);
  backgrounds.ensureFolder(backgrounds.resolveFolder(cfg().backgrounds.folder));
  if (base.admin.enabled) {
    const lan = realAddresses().map((a) => `http://${a.address}:${base.port}/admin`);
    console.log(`Dashboard: ${local}/admin${base.host === '127.0.0.1' ? ' (this computer only)' : lan.length ? `  or  ${lan.join('  ')}` : ''}`);
  }
  power.start();
  hueLight.start();
  if (!base.mock && !calendars.sources.length) console.log(`No calendar link has been added yet. Add one from the dashboard: ${local}/admin`);
  if (!base.mock && !todoist.token) console.log(`No Todoist token has been added yet. Add one from the dashboard: ${local}/admin`);
});
