'use strict';
// The /admin/api/* routes behind the monitoring dashboard.
const fs = require('fs');
const { state, broadcast } = require('./state');
const screenCount = () => [...state.clients].filter((r) => !r.isPreview).length;
const { getWeather } = require('./weather');
const { systemInfo, setTimezone } = require('./system');
const { ValidationError } = require('./settings');
const { HueError } = require('./hue');
const backgrounds = require('./backgrounds');
const { MIN_LENGTH } = require('./auth');
const pkg = require('../package.json');


function createAdmin({ settings, auth, calendars, todoist, data, isLocal, power, hue, hueLight }) {
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const releaseFailed = (r) => `The plug could not be switched back on first (${r.message || 'no answer from the bridge'}), so nothing was changed. If the Hue bridge is gone for good, press "Turn on now" on the Screen power tab, then try again.`;
  const fail = (res, status, message, extra = {}) => json(res, status, { error: extra.error || 'error', message, ...extra });

  function readJson(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject({ status: 413, message: 'Request too large.' });
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch {
          reject({ status: 400, message: 'Request was not valid JSON.' });
        }
      });
      req.on('error', () => reject({ status: 400, message: 'Request failed.' }));
    });
  }

  const cfg = () => settings.effective();
  const folder = () => backgrounds.resolveFolder(cfg().backgrounds.folder);

  function calendarTasksInfo() {
    if (cfg().mock) return { calendars: [{ id: 'a', name: 'Personal', color: '#4285f4', textColor: '#ffffff', linkShown: 'sample' }], todoist: { set: true, tokenShown: 'sample' }, mock: true };
    return { calendars: calendars.list(), todoist: todoist.info() };
  }

  function screenInfo() {
    if (!state.screen) return null;
    return { ...state.screen, ageSec: Math.round((Date.now() - state.screen.at) / 1000) };
  }

  async function geocode(q) {
    if (cfg().mock) return [{ name: 'Dallas', admin1: 'Texas', country: 'United States', latitude: 32.78306, longitude: -96.80667 }];
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name: q, count: '8', language: 'en', format: 'json' });
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Place lookup failed (${res.status})`);
    const body = await res.json();
    return (body.results || []).map((r) => ({ name: r.name, admin1: r.admin1 || '', country: r.country || '', latitude: r.latitude, longitude: r.longitude }));
  }

  // ---------------------------------------------------------------------------------------------
  return async function handle(req, res, url) {
    const path = url.pathname.replace(/^\/admin\/api/, '') || '/';
    const method = req.method;
    const ip = req.socket.remoteAddress;

    // Browsers cannot add a custom header to a cross-site request without our permission,
    // so requiring one (plus a matching Origin) blocks cross-site form posts.
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      let sameOrigin = true;
      if (origin) {
        try {
          sameOrigin = new URL(origin).host === req.headers.host;
        } catch {
          sameOrigin = false;
        }
      }
      if (!sameOrigin || req.headers['x-requested-with'] !== 'homeboard') return fail(res, 403, 'Blocked: request did not come from the dashboard.', { error: 'csrf' });
    }

    try {
      // ---- who am I / sign in (a password is optional: with none set, everyone is signed in) ----
      if (method === 'GET' && path === '/session') {
        return json(res, 200, { authed: Boolean(auth.sessionFrom(req)), passwordSet: auth.isSet(), mock: cfg().mock, minPassword: MIN_LENGTH });
      }

      if (method === 'POST' && path === '/login') {
        if (!auth.isSet()) return json(res, 200, { ok: true });
        const body = await readJson(req);
        if (!(await auth.verify(body.password))) return fail(res, 401, 'Wrong password.', { error: 'bad_password' });
        console.log(`Dashboard sign-in from ${ip}`);
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie() });
      }

      // ---- everything below needs a signed-in session ----
      if (!auth.sessionFrom(req)) return fail(res, 401, 'Please sign in.', { error: 'login_required' });

      if (method === 'POST' && path === '/logout') {
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
      }

      // Set, change or remove the password. body: { current, next } ; next empty = remove it.
      if (method === 'POST' && path === '/password') {
        const body = await readJson(req);
        if (auth.isSet() && !(await auth.verify(body.current))) return fail(res, 401, 'Current password is wrong.', { error: 'bad_password' });
        if (!body.next) {
          auth.clearPassword();
          console.log('Dashboard password removed.');
          return json(res, 200, { ok: true, passwordSet: false }, { 'Set-Cookie': auth.clearCookie() });
        }
        try {
          await auth.setPassword(body.next);
        } catch (err) {
          return fail(res, 400, err.message);
        }
        console.log('Dashboard password set.');
        return json(res, 200, { ok: true, passwordSet: true }, { 'Set-Cookie': auth.cookie() }); // keeps this browser signed in
      }

      // ---- overview ----
      if (method === 'GET' && path === '/overview') {
        const c = cfg();
        const f = folder();
        const bg = backgrounds.list(f);
        return json(res, 200, {
          version: pkg.version,
          mock: c.mock,
          epoch: state.epoch,
          now: Date.now(),
          screen: screenInfo(),
          screensConnected: screenCount(),
          calendarTasks: calendarTasksInfo(),
          sources: state.sources,
          weather: data.lastWeather(),
          weatherLocation: c.weather,
          locationSet: Boolean(c.weather.confirmed) || settings.overriddenKeys().includes('weather.latitude') || Math.abs(c.weather.latitude - 32.7555) > 0.01 || Math.abs(c.weather.longitude + 97.3308) > 0.01,
          backgrounds: { count: bg.images.length, own: bg.images.some((i) => !/^(dusk-ocean|teal-night|violet-haze)\.svg$/.test(i.name)), folder: f, readable: bg.readable },
          settings: settings.editable(),
          power: await power.status(),
          system: await systemInfo(),
          canRestart: Boolean(process.env.INVOCATION_ID),
        });
      }

      // ---- settings ----
      if (method === 'GET' && path === '/settings') {
        return json(res, 200, { settings: settings.editable(), overridden: settings.overriddenKeys() });
      }
      if (method === 'PATCH' && path === '/settings') {
        const body = await readJson(req);
        try {
          const changed = settings.update(body);
          if (changed.length) {
            data.clear();
            console.log(`Settings changed: ${changed.join(', ')}`);
            broadcast('reload');
          }
          return json(res, 200, { ok: true, changed, settings: settings.editable(), overridden: settings.overriddenKeys() });
        } catch (err) {
          if (err instanceof ValidationError) return fail(res, 422, err.message, { error: 'invalid', problems: err.problems });
          throw err;
        }
      }
      if (method === 'POST' && path === '/settings/reset') {
        const body = await readJson(req);
        settings.reset(Array.isArray(body.keys) ? body.keys : null);
        data.clear();
        console.log('Settings reset to config.json values.');
        broadcast('reload');
        return json(res, 200, { ok: true, settings: settings.editable(), overridden: settings.overriddenKeys() });
      }

      // ---- Calendar & Tasks ----
      const testStep = async (name, fn) => {
        const t0 = Date.now();
        try {
          const detail = await fn();
          return { name, ok: true, ms: Date.now() - t0, detail };
        } catch (err) {
          return { name, ok: false, ms: Date.now() - t0, error: err.message };
        }
      };

      if (method === 'GET' && path === '/calendars') {
        if (cfg().mock) return json(res, 200, { calendars: [{ id: 'a', name: 'Personal', color: '#4285f4', textColor: '#ffffff', linkShown: 'sample' }] });
        return json(res, 200, { calendars: calendars.list() });
      }
      if (method === 'POST' && path === '/calendars') {
        if (cfg().mock) return fail(res, 400, 'Not available in mock mode.');
        const body = await readJson(req);
        try {
          const added = calendars.add(body);
          data.clear();
          broadcast('refresh');
          console.log(`Calendar added: ${added.name}`);
          return json(res, 200, { ok: true, calendar: added });
        } catch (err) {
          return fail(res, 400, err.message);
        }
      }
      const calMatch = /^\/calendars\/([^/]+)$/.exec(path);
      if (calMatch && method === 'PATCH') {
        const body = await readJson(req);
        try {
          const updated = calendars.rename(calMatch[1], body.name, body.color);
          data.clear();
          broadcast('refresh');
          return json(res, 200, { ok: true, calendar: updated });
        } catch (err) {
          return fail(res, err.status || 400, err.message);
        }
      }
      if (calMatch && method === 'DELETE') {
        try {
          calendars.remove(calMatch[1]);
          data.clear();
          broadcast('refresh');
          console.log('Calendar removed.');
          return json(res, 200, { ok: true });
        } catch (err) {
          return fail(res, err.status || 400, err.message);
        }
      }
      const calTestMatch = /^\/calendars\/([^/]+)\/test$/.exec(path);
      if (calTestMatch && method === 'POST') {
        if (cfg().mock) return json(res, 200, { results: [{ name: 'Calendar', ok: true, ms: 1, detail: 'Calendar "Personal": found 4 events in the next 5 weeks (sample)' }] });
        const found = calendars.list().find((c) => c.id === calTestMatch[1]);
        const step = await testStep(found ? found.name : 'Calendar', () => calendars.test(calTestMatch[1], cfg().calendar.weeks));
        return json(res, 200, { results: [step] });
      }

      if (method === 'GET' && path === '/todoist') {
        if (cfg().mock) return json(res, 200, { set: true, tokenShown: 'sample', mock: true });
        return json(res, 200, todoist.info());
      }
      if (method === 'POST' && path === '/todoist/token') {
        if (cfg().mock) return fail(res, 400, 'Not available in mock mode.');
        const body = await readJson(req);
        try {
          todoist.saveToken(body.token);
        } catch (err) {
          return fail(res, 400, err.message);
        }
        data.clear();
        broadcast('refresh');
        console.log('Todoist token saved.');
        return json(res, 200, { ok: true, ...todoist.info() });
      }
      if (method === 'POST' && path === '/todoist/token/remove') {
        todoist.removeToken();
        data.clear();
        broadcast('refresh');
        console.log('Todoist token removed.');
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/todoist/projects') {
        const c = cfg();
        if (c.mock) return json(res, 200, { projects: [{ id: 'p1', name: 'My Tasks', shown: true }] });
        const wanted = c.tasks.lists;
        const projects = await todoist.listProjects();
        return json(res, 200, { projects: projects.map((p) => ({ ...p, shown: !wanted.length || wanted.some((w) => w.toLowerCase() === p.name.toLowerCase()) })) });
      }
      if (method === 'POST' && path === '/todoist/test') {
        if (cfg().mock) return json(res, 200, { results: [{ name: 'Todoist', ok: true, ms: 1, detail: 'Todoist: found 7 open tasks in 1 project (sample)' }] });
        const step = await testStep('Todoist', () => todoist.test(cfg()));
        return json(res, 200, { results: [step] });
      }

      // ---- weather ----
      if (method === 'GET' && path === '/weather') {
        return json(res, 200, { weather: data.lastWeather(), source: state.sources.weather, location: cfg().weather });
      }
      if (method === 'POST' && path === '/weather/refresh') {
        data.clear();
        try {
          const weather = await data.weather();
          broadcast('refresh');
          return json(res, 200, { weather, source: state.sources.weather });
        } catch (err) {
          return fail(res, 502, `Weather refresh failed: ${err.message}`);
        }
      }
      if (method === 'GET' && path === '/geocode') {
        const q = (url.searchParams.get('q') || '').trim().split(',')[0].trim();
        if (q.length < 2) return fail(res, 400, 'Type at least two letters of a place name.');
        try {
          return json(res, 200, { results: await geocode(q) });
        } catch (err) {
          return fail(res, 502, err.message);
        }
      }

      // ---- backgrounds ----
      if (method === 'GET' && path === '/backgrounds') {
        const f = folder();
        backgrounds.ensureFolder(f);
        const bg = backgrounds.list(f);
        return json(res, 200, { folder: f, ...bg, maxUploadMB: backgrounds.MAX_UPLOAD / 1024 / 1024 });
      }
      const bgMatch = /^\/backgrounds\/([^/]+)$/.exec(path);
      if (bgMatch && method === 'PUT') {
        let name;
        try {
          name = decodeURIComponent(bgMatch[1]);
        } catch {
          return fail(res, 400, 'Bad file name.');
        }
        try {
          const saved = await backgrounds.saveUpload(folder(), name, req);
          console.log(`Background added: ${saved}`);
          broadcast('backgrounds');
          return json(res, 200, { ok: true, name: saved });
        } catch (err) {
          if (err && err.status) return fail(res, err.status, err.message);
          throw err;
        }
      }
      if (bgMatch && method === 'DELETE') {
        let name;
        try {
          name = decodeURIComponent(bgMatch[1]);
        } catch {
          return fail(res, 400, 'Bad file name.');
        }
        const file = backgrounds.pathFor(folder(), name);
        // Only pictures shown in the list can be deleted, never other files that happen to be in the folder.
        if (!file || !backgrounds.list(folder()).images.some((i) => i.name === name)) return fail(res, 404, 'No such image.');
        try {
          fs.unlinkSync(file);
        } catch (err) {
          return fail(res, 500, `Could not delete: ${err.code || err.message}`);
        }
        console.log(`Background removed: ${name}`);
        broadcast('backgrounds');
        return json(res, 200, { ok: true });
      }

      // ---- screen power: schedule and on/off now ----
      if (method === 'GET' && path === '/power') return json(res, 200, await power.status());
      if (method === 'PATCH' && path === '/power') {
        const body = await readJson(req);
        if (body.hueWithScreen === false) {
          const rel = await power.releaseHue(); // do not leave the monitor's plug switched off
          if (!rel.ok) return fail(res, 502, releaseFailed(rel));
        }
        try {
          const changed = power.update(body);
          if (changed.length) console.log(`Screen schedule changed: ${changed.join(', ')}`);
        } catch (err) {
          if (err instanceof ValidationError) return fail(res, 422, err.message, { error: 'invalid', problems: err.problems });
          throw err;
        }
        power.tick(true).catch(() => {});
        return json(res, 200, await power.status());
      }
      if (method === 'POST' && path === '/power/screen') {
        const body = await readJson(req);
        const result = await power.manual(body.state);
        return json(res, 200, { ok: result.ok, message: result.message, status: await power.status() });
      }
      if (path === '/power/huelight') {
        if (method === 'GET') return json(res, 200, hueLight.status());
        if (method === 'PATCH') {
          const body = await readJson(req);
          try {
            const changed = hueLight.update(body);
            if (changed.length) console.log(`Hue light (diyHue) changed: ${changed.join(', ')}`);
          } catch (err) {
            if (err instanceof ValidationError) return fail(res, 422, err.message, { error: 'invalid', problems: err.problems });
            throw err;
          }
          await hueLight.apply();
          return json(res, 200, hueLight.status());
        }
      }
      if (method === 'POST' && path === '/power/cec-check') {
        const st = await power.display.cecStatus();
        return json(res, 200, st);
      }
      if (method === 'POST' && path === '/power/resume') {
        await power.resume();
        return json(res, 200, { ok: true, status: await power.status() });
      }

      if (path.startsWith('/power/hue')) {
        try {
          if (method === 'POST' && path === '/power/hue/discover') return json(res, 200, { bridges: await hue.discover() });
          if (method === 'POST' && path === '/power/hue/link') {
            const body = await readJson(req);
            console.log(`Linking to the Hue bridge at ${body.ip}...`);
            const st = await hue.link(body.ip);
            console.log('Hue bridge linked.');
            return json(res, 200, { ok: true, hue: st });
          }
          if (method === 'POST' && path === '/power/hue/unlink') {
            const rel = await power.releaseHue(); // do not leave the monitor's plug switched off
            if (!rel.ok) return fail(res, 502, releaseFailed(rel));
            hue.unlink();
            console.log('Hue unlinked.');
            return json(res, 200, { ok: true });
          }
          if (method === 'GET' && path === '/power/hue/lights') return json(res, 200, { lights: await hue.lights(), targets: hue.status().targets });
          if (method === 'PUT' && path === '/power/hue/targets') {
            const body = await readJson(req);
            const known = await hue.lights();
            const chosen = (Array.isArray(body.ids) ? body.ids : []).map((id) => known.find((l) => l.id === id)).filter(Boolean);
            const rel = await power.releaseHue(); // the old devices get their power back before they are replaced
            if (!rel.ok) return fail(res, 502, releaseFailed(rel));
            const st = hue.setTargets(chosen);
            power.reassert();
            console.log(`Hue devices chosen: ${chosen.map((l) => l.name).join(', ') || 'none'}`);
            return json(res, 200, { ok: true, hue: st });
          }
          if (method === 'POST' && path === '/power/hue/test') {
            if (!hue.hasTargets()) return fail(res, 400, 'Choose a device above and press "Save chosen devices" first.');
            if (power.busy) return fail(res, 409, 'Still busy switching the screen. Try again in a few seconds.');
            const asleep = power.applied === 'off' && power.settings.hueWithScreen; // if the plug is meant to be off, it ends up off again
            const off = await hue.setOn(false);
            if (!off.ok) return fail(res, 502, off.message);
            await new Promise((r) => setTimeout(r, 5000));
            const back = await hue.setOn(!asleep);
            if (!back.ok) return fail(res, 502, back.message);
            return json(res, 200, { ok: true, message: asleep ? 'The plug was switched off and on again (it is off now because the screen is asleep).' : 'The plug was off for 5 seconds and is on again.' });
          }
        } catch (err) {
          if (err instanceof HueError) return fail(res, 502, err.message);
          throw err;
        }
      }

      // ---- actions ----
      if (method === 'POST' && path === '/actions/reload') {
        broadcast('reload');
        return json(res, 200, { ok: true, screens: screenCount() });
      }
      if (method === 'POST' && path === '/actions/refresh-data') {
        data.clear();
        broadcast('refresh');
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/actions/next-background') {
        broadcast('next-bg');
        return json(res, 200, { ok: true, screens: screenCount() });
      }
      if (method === 'POST' && path === '/actions/show-background') {
        const body = await readJson(req);
        const file = backgrounds.pathFor(folder(), body.name);
        if (!file || !fs.existsSync(file)) return fail(res, 404, 'No such image.');
        const item = backgrounds.list(folder()).images.find((i) => i.name === body.name);
        if (!item) return fail(res, 404, 'That file is not a displayable image.');
        broadcast('show-bg', { url: item.url });
        return json(res, 200, { ok: true, screens: screenCount() });
      }
      if (method === 'POST' && path === '/actions/restart') {
        if (!process.env.INVOCATION_ID) return fail(res, 400, 'The server is not running as a background service, so it cannot restart itself. Restart it from the Pi.');
        console.warn('Restart requested from the dashboard.');
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 500); // systemd starts it again (Restart=always)
        return;
      }

      // ---- time zone ----
      if (method === 'POST' && path === '/timezone') {
        if (cfg().mock) return fail(res, 400, 'Not available in mock mode.');
        const body = await readJson(req);
        const tz = String(body.timezone || '').trim();
        try {
          await setTimezone(tz);
        } catch (err) {
          return fail(res, 400, err.message);
        }
        console.log(`Time zone changed to ${tz}.`);
        json(res, 200, { ok: true, timezone: tz });
        if (process.env.INVOCATION_ID) setTimeout(() => process.exit(0), 500); // restart so the schedule's clock math uses the new zone cleanly
        return;
      }

      // ---- logs ----
      if (method === 'GET' && path === '/logs') {
        const since = Number(url.searchParams.get('since')) || 0;
        const logs = state.logs.filter((l) => l.id > since).slice(-200);
        return json(res, 200, { logs, last: state.nextLogId - 1 });
      }

      return fail(res, 404, 'Unknown dashboard route.', { error: 'not_found' });
    } catch (err) {
      if (err && err.status && err.message) return fail(res, err.status, err.message);
      console.error(`admin ${method} ${path}: ${err && err.message}`);
      return fail(res, 500, err && err.message ? err.message : 'Something went wrong.');
    }
  };
}

module.exports = { createAdmin };
