'use strict';
// Homeboard admin dashboard. Plain JavaScript, no libraries. Talks to /admin/api/*.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  // ------------------------------------------------------------------ tiny helpers
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }

  // h('div', { class: 'card', onclick: fn }, 'text', childElement)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'value') value = v; // set after children so <select> and range inputs work
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    } else if (attrs != null) kids.unshift(attrs);
    append(el, kids);
    if (value !== undefined) el.value = value;
    return el;
  }

  // replaceChildren() would print the word "null" for empty slots; skip empty slots and flatten lists instead.
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) {
    nativeReplace.call(this);
    append(this, kids);
  };

  const S = { authed: false, overview: null, tab: null, session: null };

  function toast(message, kind = '') {
    const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, message);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4500);
  }

  async function api(method, path, body, extra = {}) {
    const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'homeboard' } };
    if (extra.raw !== undefined) {
      opts.body = extra.raw;
      if (extra.type) opts.headers['Content-Type'] = extra.type;
    } else if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch('/admin/api' + path, opts);
    } catch {
      throw Object.assign(new Error('Cannot reach the Pi. Check that it is on and connected to your network.'), { offline: true });
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      if (res.status === 401 && data.error === 'login_required' && S.authed) {
        S.authed = false;
        showLogin();
      }
      throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { status: res.status, data });
    }
    return data;
  }

  // Run an action from a button: disable it while working, show errors as a toast.
  async function run(btn, fn, okMessage) {
    if (btn) btn.disabled = true;
    try {
      const result = await fn();
      if (okMessage) toast(okMessage, 'good');
      return result === undefined ? true : result;
    } catch (err) {
      toast(err.message, 'bad');
      return undefined;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // A button that needs a second click ("Sure?") before doing something destructive. No pop-up dialogs.
  function confirmButton(label, armedLabel, onConfirm, cls = 'btn small danger') {
    let timer;
    const b = h('button', { class: cls, type: 'button' }, label);
    const reset = () => {
      delete b.dataset.armed;
      b.textContent = label;
    };
    b.addEventListener('click', async () => {
      if (!b.dataset.armed) {
        b.dataset.armed = '1';
        b.textContent = armedLabel;
        timer = setTimeout(reset, 4000);
        return;
      }
      clearTimeout(timer);
      reset();
      b.disabled = true;
      try {
        await onConfirm();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  const btn = (label, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', onclick }, label);

  // ------------------------------------------------------------------ formatting
  const fmtBytes = (n) => (n == null ? '-' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400);
    const hr = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d} d ${hr} h`;
    if (hr) return `${hr} h ${m} min`;
    if (m) return `${m} min`;
    return `${sec} s`;
  }
  const ago = (ts, now = Date.now()) => (ts ? `${fmtDur((now - ts) / 1000)} ago` : 'never');
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const sentMsg = (r) => (r.screens ? 'Sent. The screen will change picture.' : 'No screen is connected right now (fine if the monitor is off).');

  const CODES = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };
  const codeLabel = (c) => CODES[c] || `Code ${c}`;

  const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, dotted, value) {
    const parts = dotted.split('.');
    let cur = obj;
    for (const p of parts.slice(0, -1)) cur = cur[p] || (cur[p] = {});
    cur[parts[parts.length - 1]] = value;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ------------------------------------------------------------------ settings forms
  // fields: [{ key, label, type: int|number|text|enum|bool|duration|range, hint, options, min, max, step }]
  function buildForm(fields, current, overridden, { saveLabel = 'Save changes', onSaved, extra } = {}) {
    const getters = new Map();
    const errors = new Map();

    const wraps = fields.map((f) => {
      if (f.heading) return h('h3', { class: 'group' }, f.heading);
      const value = getPath(current, f.key);
      let control;
      let get;
      let wrapTag = 'label';
      switch (f.type) {
        case 'bool': {
          const box = h('input', { type: 'checkbox', checked: Boolean(value) });
          control = h('span', { class: 'check' }, box, f.label);
          get = () => box.checked;
          break;
        }
        case 'enum': {
          const sel = h('select', { value: String(value) }, f.options.map(([v, l]) => h('option', { value: String(v) }, l)));
          control = sel;
          get = () => f.options.find(([v]) => String(v) === sel.value)[0];
          break;
        }
        case 'duration': {
          const unit = value % 3600 === 0 ? 3600 : value % 60 === 0 ? 60 : 1;
          const num = h('input', { type: 'number', min: 1, step: 1, value: value / unit });
          const sel = h('select', { value: String(unit), 'aria-label': 'Unit' }, [[1, 'seconds'], [60, 'minutes'], [3600, 'hours']].map(([v, l]) => h('option', { value: String(v) }, l)));
          control = h('span', { class: 'inline2' }, num, sel);
          get = () => (num.value.trim() === '' ? '' : Math.round(Number(num.value) * Number(sel.value)));
          break;
        }
        case 'range': {
          const out = h('span', { class: 'muted' });
          const r = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value });
          const show = () => (out.textContent = `${Math.round(Number(r.value) * 100)}%`);
          r.addEventListener('input', show);
          show();
          control = h('span', { class: 'rangebox' }, r, out);
          get = () => Number(r.value);
          break;
        }
        case 'int':
        case 'number': {
          const input = h('input', { type: 'number', min: f.min, max: f.max, step: f.step || (f.type === 'int' ? 1 : 'any'), value: value == null ? '' : value });
          control = input;
          get = () => (input.value.trim() === '' ? '' : Number(input.value));
          break;
        }
        default: {
          const input = h('input', { type: 'text', value: value == null ? '' : value, maxLength: f.max || 200 });
          control = input;
          get = () => input.value;
        }
      }
      getters.set(f.key, { get, spec: f });
      const err = h('span', { class: 'err', role: 'alert' });
      errors.set(f.key, err);
      const isOverridden = overridden.includes(f.key);
      const head = f.type === 'bool' ? null : h('span', null, f.label);
      const wrap = h(wrapTag, { class: 'field' }, head, control, f.hint ? h('span', { class: 'hint' }, f.hint) : null, err);
      return isOverridden
        ? h('div', { class: 'fw' }, wrap, h('span', { class: 'hint' }, 'Changed here. ', h('button', { type: 'button', class: 'linkbtn', onclick: () => resetKeys([f.key]) }, 'Undo my change')))
        : wrap;
    });

    async function resetKeys(keys) {
      const r = await run(null, () => api('POST', '/settings/reset', { keys }), 'Reset. The screen is reloading.');
      if (r && onSaved) onSaved(r);
    }

    const save = h('button', { class: 'btn primary', type: 'submit' }, saveLabel);
    const form = h('form', { class: 'form', novalidate: true }, wraps, extra, h('div', { class: 'row' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      for (const el of errors.values()) el.textContent = '';
      const patch = {};
      let count = 0;
      for (const [key, { get }] of getters) {
        const v = get();
        if (!same(v, getPath(current, key))) {
          setPath(patch, key, v);
          count++;
        }
      }
      if (!count) return toast('Nothing to change.');
      save.disabled = true;
      try {
        const r = await api('PATCH', '/settings', patch);
        toast('Saved. The screen is reloading with the new settings.', 'good');
        if (onSaved) onSaved(r);
      } catch (err) {
        for (const p of (err.data && err.data.problems) || []) {
          const el = errors.get(p.key);
          if (el) el.textContent = p.message;
        }
        const first = ((err.data && err.data.problems) || [])[0];
        const field = first && fields.find((f) => f.key === first.key);
        toast(field ? `${field.label}: ${field.rangeText || first.message}` : err.message, 'bad');
      } finally {
        save.disabled = false;
      }
    });
    return form;
  }

  const F = {
    interval: { key: 'display.backgroundIntervalSeconds', label: 'Change the picture every', type: 'duration', rangeText: 'must be between 10 seconds and 24 hours', hint: 'Anything from 10 seconds to 24 hours.' },
    order: { key: 'display.backgroundOrder', label: 'Order', type: 'enum', options: [['shuffle', 'Shuffle (random, no repeats until all are shown)'], ['sequential', 'In file-name order']] },
    dim: { key: 'display.backgroundDim', label: 'Darken the pictures', type: 'range', min: 0, max: 0.9, step: 0.05, hint: 'Makes text easier to read on bright photos.' },
    timeFormat: { key: 'display.timeFormat', label: 'Clock', type: 'enum', options: [['12h', '12-hour (3:45 PM)'], ['24h', '24-hour (15:45)']] },
    showSeconds: { key: 'display.showSeconds', label: 'Show seconds on the clock', type: 'bool' },
    lowPower: { key: 'display.lowPower', label: 'Low-power mode (turns off animations; helps older Pis)', type: 'bool' },
    locale: { key: 'locale', label: 'Language and date style', type: 'text', hint: 'For example en-US, en-GB, es-ES, de-DE.' },
    weeks: { key: 'calendar.weeks', label: 'Weeks shown on the calendar', type: 'int', min: 1, max: 8 },
    weekStart: { key: 'calendar.weekStartsOn', label: 'Week starts on', type: 'enum', options: [[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']] },
    perDay: { key: 'calendar.maxEventsPerDay', label: 'Most events shown per day', type: 'int', min: 1, max: 10 },
    tasksTitle: { key: 'tasks.title', label: 'Title above the task list', type: 'text', max: 40 },
    tasksMax: { key: 'tasks.maxItems', label: 'Most tasks shown', type: 'int', min: 1, max: 40 },
    rCal: { key: 'refresh.calendarMinutes', label: 'Check the calendar every (minutes)', type: 'int', min: 1, max: 120 },
    rTasks: { key: 'refresh.tasksMinutes', label: 'Check tasks every (minutes)', type: 'int', min: 1, max: 120 },
    rWeather: { key: 'refresh.weatherMinutes', label: 'Check the weather every (minutes)', type: 'int', min: 5, max: 240 },
    units: { key: 'weather.units', label: 'Units', type: 'enum', options: [['imperial', 'Fahrenheit, mph'], ['metric', 'Celsius, km/h']] },
    label: { key: 'weather.label', label: 'Name shown under the weather', type: 'text', max: 80, hint: 'Leave empty to show nothing.' },
    lat: { key: 'weather.latitude', label: 'Latitude', type: 'number', min: -90, max: 90 },
    lon: { key: 'weather.longitude', label: 'Longitude', type: 'number', min: -180, max: 180 },
  };

  const card = (title, subtitle, ...body) => h('section', { class: 'card' }, title ? h('div', { class: 'head' }, h('div', null, h('h2', null, title), subtitle ? h('div', { class: 'muted small-text' }, subtitle) : null)) : null, ...body);
  const pill = (text, level = '') => h('span', { class: `pill ${level}` }, text);
  const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

  // ------------------------------------------------------------------ status logic (Overview + header pill)
  function statusItems(o) {
    const items = [];
    const sc = o.screen;
    const asleep = o.power && o.power.applied === 'off';
    if (asleep) items.push({ name: 'Screen', level: '', text: 'The monitor is switched off right now.', tab: 'power' });
    else if (!sc) items.push({ name: 'Screen', level: 'warn', text: 'No screen has checked in yet. Fine if the monitor is off.' });
    else if (sc.ageSec > 90) items.push({ name: 'Screen', level: 'warn', text: `Last seen ${fmtDur(sc.ageSec)} ago. It may be off or the browser may be closed.` });
    else items.push({ name: 'Screen', level: 'good', text: `Online${sc.width ? `, ${sc.width} by ${sc.height}` : ''}${sc.background ? `, showing ${sc.background}` : ''}` });

    if (o.power) {
      const p = o.power;
      const can = Boolean(p.display.method) || (p.hue.linked && p.hue.targets.length && p.settings.hueWithScreen);
      if (p.settings.enabled && !can && p.applied === null) items.push({ name: 'Screen power', level: 'warn', text: `The schedule is on but this Pi cannot switch the screen. ${p.display.reason || ''}`, tab: 'power' });
      else if (p.failing) items.push({ name: 'Screen power', level: 'warn', text: `Could not switch the screen ${p.last ? p.last.want : ''}. ${p.last ? p.last.message : ''}`, tab: 'power' });
      else if (p.applied === 'off') items.push({ name: 'Screen power', level: 'good', text: `Off${p.manual ? ' (by hand)' : ' (schedule)'}${p.next && !p.manual ? `, turns on at ${new Date(p.next.at).toLocaleTimeString([], { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' })}` : ''}`, tab: 'power' });
      else if (p.settings.enabled && p.next && p.next.to === 'off') items.push({ name: 'Screen power', level: 'good', text: `On, turns off at ${new Date(p.next.at).toLocaleTimeString([], { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' })}`, tab: 'power' });
      else items.push({ name: 'Screen power', level: 'good', text: !p.settings.enabled ? 'On (schedule is off)' : p.manual ? 'On (by hand, until the schedule changes)' : 'On', tab: 'power' });
      // A CEC problem shows up either as "no adapter at all" (display.cec.available false) or, much more often,
      // as a per-switch warning mentioning HDMI-CEC because this particular monitor never confirms it. Both are
      // hidden together once dismissed on the Screen power tab; any other (e.g. Hue) warning is never hidden.
      const lastWarningIsCec = Boolean(p.last && p.last.ok && p.last.warning && /HDMI-CEC/i.test(p.last.warning));
      if (p.last && p.last.ok && p.last.warning && !lastWarningIsCec) items.push({ name: 'Screen power', level: 'warn', text: p.last.warning, tab: 'power' });
      else if (!p.settings.dismissCecWarning && lastWarningIsCec) items.push({ name: 'HDMI-CEC', level: 'warn', text: `${p.last.warning} Go to the Screen power tab and press "This monitor doesn't support HDMI-CEC" to clear this.`, tab: 'power' });
      else if (!p.settings.dismissCecWarning && p.settings.useCec && p.display.cec && !p.display.cec.available) items.push({ name: 'HDMI-CEC', level: 'warn', text: `Not available${can ? ', so only the picture is switched off' : ''}. ${p.display.cec.reason || ''} If your monitor doesn't support HDMI-CEC, go to the Screen power tab and press "This monitor doesn't support HDMI-CEC" to clear this.`, tab: 'power' });
    }

    const ct = o.calendarTasks;
    if (ct.mock) {
      items.push({ name: 'Calendars', level: 'good', text: 'Sample data (mock mode)', tab: 'calendartasks' });
    } else {
      if (!ct.calendars.length) items.push({ name: 'Calendars', level: 'bad', text: 'No calendar link added yet.', tab: 'calendartasks' });
      else items.push({ name: 'Calendars', level: 'good', text: `${plural(ct.calendars.length, 'calendar')} added: ${ct.calendars.map((c) => c.name).join(', ')}`, tab: 'calendartasks' });
      if (!ct.todoist.set) items.push({ name: 'Todoist', level: 'bad', text: 'No Todoist token added yet.', tab: 'calendartasks' });
      else items.push({ name: 'Todoist', level: 'good', text: `Token added (${ct.todoist.tokenShown})`, tab: 'calendartasks' });
    }

    const src = (key, name, what, tab, setupDone) => {
      const s = o.sources[key] || {};
      if (o.mock) return { name, level: 'good', text: 'Sample data', tab };
      if (s.ok) return { name, level: 'good', text: `${what(s)}. Updated ${ago(s.lastFetchAt, o.now)}`, tab };
      if (s.error) return { name, level: setupDone ? 'bad' : 'warn', text: `${s.error}${s.lastFetchAt ? ` (${ago(s.lastFetchAt, o.now)})` : ''}`, tab };
      return { name, level: '', text: 'Not fetched yet', tab };
    };
    items.push(src('calendar', 'Calendar', (s) => plural(s.count || 0, 'event'), 'calendartasks', ct.mock || ct.calendars.length > 0));
    items.push(src('tasks', 'Tasks', (s) => plural(s.count || 0, 'task'), 'calendartasks', ct.mock || ct.todoist.set));
    items.push(src('weather', 'Weather', (s) => `${s.temp}°`, 'weather', true));

    const b = o.backgrounds;
    const every = o.settings.display.backgroundIntervalSeconds;
    if (!b.readable) items.push({ name: 'Pictures', level: 'bad', text: `Cannot read the folder ${b.folder}`, tab: 'backgrounds' });
    else if (!b.count) items.push({ name: 'Pictures', level: 'warn', text: 'The folder is empty, so the screen shows a plain gradient.', tab: 'backgrounds' });
    else items.push({ name: 'Pictures', level: 'good', text: `${plural(b.count, 'picture')}, changing every ${fmtDur(every)}`, tab: 'backgrounds' });

    const sys = o.system;
    const problems = [];
    let level = 'good';
    if (sys.power && sys.power.underVoltageNow) {
      problems.push('under-voltage (weak power supply)');
      level = 'bad';
    }
    if (sys.tempC != null && sys.tempC >= 80) {
      problems.push(`very hot (${sys.tempC}°C)`);
      level = 'bad';
    } else if (sys.tempC != null && sys.tempC >= 70) {
      problems.push(`warm (${sys.tempC}°C)`);
      if (level === 'good') level = 'warn';
    }
    const memUsed = 1 - sys.mem.free / sys.mem.total;
    items.push({ name: 'Pi health', level, text: problems.length ? problems.join(', ') : `${sys.tempC != null ? `${sys.tempC}°C, ` : ''}memory ${Math.round(memUsed * 100)}% used, up ${fmtDur(sys.uptimeSec)}`, tab: 'system' });
    return items;
  }

  function paintPill(o) {
    const bad = statusItems(o).filter((i) => i.level === 'bad' || i.level === 'warn');
    const el = $('#pill');
    el.className = 'pill';
    if (!bad.length) {
      el.classList.add('good');
      el.textContent = 'All good';
    } else {
      el.classList.add(bad.some((i) => i.level === 'bad') ? 'bad' : 'warn');
      el.textContent = `${plural(bad.length, 'thing')} to check`;
    }
    el.title = bad.map((i) => `${i.name}: ${i.text}`).join('\n');
  }

  async function poll() {
    if (!S.authed || document.hidden) return;
    try {
      const o = await api('GET', '/overview');
      S.overview = o;
      paintPill(o);
      if (S.tab && S.tab.onOverview) S.tab.onOverview(o);
    } catch {
      /* the next poll will try again */
    }
  }

  // ------------------------------------------------------------------ Overview
  function tabOverview(root) {
    const wrap = h('div', { class: 'preview-wrap' });
    const frame = h('iframe', { src: '/?preview=1', title: 'Live preview of the screen', tabindex: '-1' });
    wrap.append(frame);
    const fit = () => (frame.style.transform = `scale(${wrap.clientWidth / 1080})`);
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    fit();

    const act = (label, path, msg) => btn(label, (e) => run(e.currentTarget, async () => {
      const r = await api('POST', path);
      toast(typeof msg === 'function' ? msg(r) : msg, 'good');
    }));

    const list = h('div', { class: 'list' });
    const health = h('div');
    const setup = h('div');

    // First-run checklist: shown until location, a calendar link and the Todoist token are all done.
    let setupKey = '';
    const hideKey = 'hb_setup_hidden';
    const isHidden = () => {
      try {
        return localStorage.getItem(hideKey) === '1';
      } catch {
        return false;
      }
    };
    function paintSetup(o) {
      const ct = o.calendarTasks;
      const steps = [
        { done: o.locationSet, text: 'Choose your weather location', go: 'weather', label: 'Set location' },
        { done: ct.mock || ct.calendars.length > 0, text: 'Add a calendar link', go: 'calendartasks', label: 'Add calendar' },
        { done: ct.mock || ct.todoist.set, text: 'Add your Todoist token', go: 'calendartasks', label: 'Add token' },
        { done: o.backgrounds.own, text: 'Add your own pictures (optional)', go: 'backgrounds', label: 'Add pictures', optional: true },
      ];
      const required = steps.filter((x) => !x.optional);
      const allRequired = required.every((x) => x.done);
      const show = !o.mock && !(allRequired && (steps.every((x) => x.done) || isHidden()));
      const key = JSON.stringify([show, steps.map((x) => x.done)]);
      if (key === setupKey) return; // unchanged: leave it alone so focus and clicks are not disturbed
      setupKey = key;
      if (!show) return setup.replaceChildren();
      setup.replaceChildren(card(allRequired ? 'Nearly done' : 'Finish setting up', allRequired ? 'The essentials are done. Adding your own pictures is optional.' : 'Do these once. This box disappears when you are done.',
        h('div', { class: 'list setup' }, steps.map((x) => h('div', { class: 'item' },
          pill(x.done ? 'Done' : x.optional ? 'Optional' : 'To do', x.done ? 'good' : x.optional ? '' : 'warn'),
          h('div', { class: 'grow small-text' }, x.text),
          x.done || x.locked ? null : h('a', { class: 'btn small primary', href: `#/${x.go}` }, x.label)))),
        allRequired ? h('div', { class: 'row', style: { marginTop: '12px' } }, btn('Hide this box', () => {
          try {
            localStorage.setItem(hideKey, '1');
          } catch {
            /* ignore */
          }
          setupKey = '';
          setup.replaceChildren();
        }, 'btn small ghost')) : null));
    }

    function paint(o) {
      paintSetup(o);
      list.replaceChildren(...statusItems(o).map((i) =>
        h('div', { class: 'item' },
          pill(i.name, i.level),
          h('div', { class: 'grow small-text' }, i.text),
          i.tab ? h('a', { class: 'btn small ghost', href: `#/${i.tab}` }, 'Open') : null)));
      const sys = o.system;
      const memUsed = Math.round((1 - sys.mem.free / sys.mem.total) * 100);
      const diskUsed = sys.disk ? Math.round((1 - sys.disk.free / sys.disk.total) * 100) : null;
      const bar = (pct, warnAt, badAt) => h('div', { class: `bar ${pct >= badAt ? 'bad' : pct >= warnAt ? 'warn' : ''}` }, h('i', { style: { width: `${Math.min(100, pct)}%` } }));
      health.replaceChildren(
        kv([
          ['Device', sys.model || sys.hostname],
          ['Temperature', sys.tempC != null ? `${sys.tempC}°C` : 'not available'],
          ['Memory', `${memUsed}% used`],
          ['Storage', diskUsed != null ? `${diskUsed}% used, ${fmtBytes(sys.disk.free)} free` : 'not available'],
        ]),
        h('div', { style: { marginTop: '10px', display: 'grid', gap: '6px' } }, bar(memUsed, 75, 90), diskUsed != null ? bar(diskUsed, 80, 92) : null));
    }

    root.append(h('div', { class: 'stack' }, setup, h('div', { class: 'overview' },
      h('div', { class: 'stack' },
        card('Live preview', 'The layout as it looks now. The background picture here can differ from the real screen.', wrap),
        card('Quick actions', null, h('div', { class: 'row' },
          act('Reload screen', '/actions/reload', (r) => (r.screens ? `Reloading ${plural(r.screens, 'screen')}.` : 'No screen is connected right now.')),
          act('Refresh data', '/actions/refresh-data', 'Calendar, tasks and weather will refresh now.'),
          act('Next picture', '/actions/next-background', sentMsg)))),
      h('div', { class: 'stack' }, card('Status', null, list), card('Raspberry Pi', null, health)))));

    if (S.overview) paint(S.overview);
    else poll();
    return { onOverview: paint, cleanup: () => ro.disconnect() };
  }

  // ------------------------------------------------------------------ Backgrounds
  const UPLOAD_OK = /\.(jpe?g|png|webp)$/i;
  const MAX_SIDE = 2880;

  // Shrink very large photos in the browser so the upload is quick and the Pi decodes them fast.
  async function prepare(file) {
    try {
      if (!window.createImageBitmap) return file;
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size <= 6 * 1024 * 1024) {
        bmp.close();
        return file;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
      if (!blob || (scale === 1 && blob.size >= file.size)) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch {
      return file;
    }
  }

  // Files from a drop, including folders dragged from the desktop.
  async function filesFromDrop(dt) {
    const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (!entries.length || entries.some((e) => !e)) return [...dt.files];
    const out = [];
    async function walk(entry) {
      if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  async function tabBackgrounds(root) {
    let [bg, st] = await Promise.all([api('GET', '/backgrounds'), api('GET', '/settings')]);
    const gallery = h('div');
    const uploads = h('div', { class: 'uploads' });
    const galleryTitle = h('h2');
    const gallerySub = h('div', { class: 'muted small-text' });
    let currentName = S.overview && S.overview.screen ? S.overview.screen.background : null;
    let busy = false;

    function paintGallery() {
      galleryTitle.textContent = `Pictures in the folder (${bg.images.length})`;
      gallerySub.replaceChildren('Folder on the Pi: ', h('code', null, bg.folder));
      if (!bg.readable) {
        gallery.replaceChildren(h('div', { class: 'note bad' }, 'The Pi cannot read this folder. Check the path in config.json (backgrounds.folder) and its permissions.'));
        return;
      }
      const thumbs = bg.images.map((img) =>
        h('div', { class: `thumb${img.name === currentName ? ' current' : ''}`, 'data-name': img.name },
          h('div', { class: 'img', style: { backgroundImage: `url("${img.url}")` }, role: 'img', 'aria-label': img.name }),
          h('div', { class: 'meta' }, h('b', { title: img.name }, img.name), h('span', { class: 'muted' }, fmtBytes(img.size), h('span', { class: 'now' }, img.name === currentName ? ', showing now' : ''))),
          h('div', { class: 'acts' },
            btn('Show now', (e) => run(e.currentTarget, async () => toast(sentMsg(await api('POST', '/actions/show-background', { name: img.name })), 'good')), 'btn small'),
            confirmButton('Delete', 'Sure?', async () => {
              await api('DELETE', `/backgrounds/${encodeURIComponent(img.name)}`);
              toast(`Deleted ${img.name}`, 'good');
              await refresh();
            }))));
      gallery.replaceChildren(
        bg.images.length ? h('div', { class: 'thumbs' }, thumbs) : h('div', { class: 'note' }, 'No pictures yet. Drag some in above. Until then the screen shows a plain gradient.'),
        bg.skipped.length ? h('p', { class: 'muted small-text', style: { marginTop: '12px' } }, `Ignored ${plural(bg.skipped.length, 'file')} that ${bg.skipped.length === 1 ? 'is' : 'are'} not an image: ${bg.skipped.slice(0, 5).join(', ')}${bg.skipped.length > 5 ? ', ...' : ''}`) : null);
    }

    async function refresh() {
      bg = await api('GET', '/backgrounds');
      paintGallery();
    }

    async function upload(files) {
      if (busy) return toast('Still uploading. Please wait a moment.');
      const good = files.filter((f) => UPLOAD_OK.test(f.name) && !f.name.startsWith('.'));
      const skipped = files.length - good.length;
      if (!good.length) return toast(files.length ? 'Those files are not JPG, PNG or WebP pictures.' : 'No files found.', 'bad');
      busy = true;
      uploads.replaceChildren();
      let added = 0;
      let failed = 0;
      for (const file of good) {
        const status = h('span', { class: 'muted' }, 'Preparing...');
        uploads.append(h('div', { class: 'up' }, h('span', null, file.name), status));
        try {
          const ready = await prepare(file);
          status.textContent = `Uploading ${fmtBytes(ready.size)}...`;
          await api('PUT', `/backgrounds/${encodeURIComponent(ready.name)}`, null, { raw: ready, type: ready.type || 'application/octet-stream' });
          status.textContent = 'Added';
          status.className = 'ok';
          added++;
        } catch (err) {
          status.textContent = err.message;
          status.className = 'err';
          failed++;
        }
      }
      busy = false;
      if (added) toast(`Added ${plural(added, 'picture')}.${skipped ? ` Skipped ${plural(skipped, 'other file')}.` : ''}`, 'good');
      else if (failed) toast('No pictures were added.', 'bad');
      await refresh();
    }

    const filePick = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true });
    const dirPick = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
    filePick.addEventListener('change', () => {
      upload([...filePick.files]);
      filePick.value = '';
    });
    dirPick.addEventListener('change', () => {
      upload([...dirPick.files]);
      dirPick.value = '';
    });

    const drop = h('div', { class: 'drop', tabindex: '0' },
      h('p', { style: { margin: '0 0 4px', color: 'var(--text)', fontWeight: '600' } }, 'Drop pictures or a whole folder here'),
      h('p', { class: 'small-text' }, 'From your PC\'s desktop, or anywhere. JPG, PNG or WebP. Very large photos are shrunk to a good size automatically.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        btn('Choose pictures...', () => filePick.click(), 'btn primary'),
        btn('Choose a folder...', () => dirPick.click())),
      filePick, dirPick);
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      try {
        upload(await filesFromDrop(e.dataTransfer));
      } catch {
        toast('Could not read the dropped items. Try "Choose pictures" instead.', 'bad');
      }
    });

    const rotation = buildForm([F.interval, F.order, F.dim], st.settings, st.overridden, {
      onSaved: (r) => {
        st = r;
        S.overview = null;
        render();
      },
    });
    let render = () => go('backgrounds', true);

    root.append(h('div', { class: 'grid' },
      card('Rotation', 'How the pictures change on the screen.', rotation, h('div', { class: 'row', style: { marginTop: '12px' } }, btn('Show the next picture now', (e) => run(e.currentTarget, async () => toast(sentMsg(await api('POST', '/actions/next-background')), 'good'))))),
      card('Add pictures', 'They are saved on the Pi and used right away.', drop, uploads)),
      h('section', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'head' }, h('div', null, galleryTitle, gallerySub), btn('Refresh list', (e) => run(e.currentTarget, refresh), 'btn small')),
        gallery,
        h('p', { class: 'muted small-text', style: { marginTop: '12px' } }, 'Prefer to manage files on the Pi itself? Anything you put in that folder appears here after you press Refresh list. To use a different folder, see "Background photos" in the README.')));

    paintGallery();
    return {
      onOverview: (o) => {
        const name = o.screen ? o.screen.background : null;
        if (name !== currentName) {
          currentName = name;
          // Only move the "showing now" marker, so a half-clicked Delete is not reset.
          for (const t of gallery.querySelectorAll('.thumb')) {
            const on = t.dataset.name === name;
            t.classList.toggle('current', on);
            const tag = t.querySelector('.now');
            if (tag) tag.textContent = on ? ', showing now' : '';
          }
        }
      },
    };
  }

  // ------------------------------------------------------------------ Calendar & Tasks
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  // Mirrors the default colours lib/calendars.js hands out, only so the "Add a calendar" form can preview
  // the colour a new calendar will get before it is saved.
  const DEFAULT_COLORS = ['#4285f4', '#33b679', '#d50000', '#f6bf26', '#8e24aa', '#039be5', '#e67c73', '#616161'];

  function renderTestResults(box, results) {
    box.replaceChildren(...results.map((x) =>
      h('div', { class: 'item' }, pill(x.name, x.ok ? 'good' : 'bad'), h('div', { class: 'grow small-text' }, x.ok ? x.detail : x.error), h('span', { class: 'muted small-text' }, `${x.ms} ms`))));
  }

  function calendarGuide() {
    return h('div', { class: 'steps' },
      h('p', { class: 'muted small-text' }, 'Google Calendar can hand out a private link that shows your events without signing in, and it never expires. Do this once per calendar you want on the screen.'),
      h('ol', null,
        h('li', null, 'On a computer, open ', ext('https://calendar.google.com', 'Google Calendar'), ', click the gear icon, then Settings.'),
        h('li', null, 'Under "Settings for my calendars" (left side), click the calendar you want.'),
        h('li', null, 'Click "Integrate calendar", then copy "Secret address in iCal format".'),
        h('li', null, 'Paste it below.')),
      h('p', { class: 'muted small-text' }, 'A school or work account may hide this option. If your secret link ever leaks, come back here and press "Reset" next to it in Google Calendar, then paste the new link below.'));
  }

  function todoistGuide() {
    return h('div', { class: 'steps' },
      h('ol', null,
        h('li', null, 'Open ', ext('https://todoist.com', 'Todoist'), ' in a browser, click your picture (top right), then Settings.'),
        h('li', null, 'Click Integrations, then Developer.'),
        h('li', null, 'Copy the API token and paste it below.')));
  }

  function calendarRow(c, onChanged) {
    const editing = h('div');
    const view = h('div', { class: 'item' },
      h('span', { class: 'swatch', style: { background: c.color } }),
      h('div', { class: 'grow' }, h('b', null, c.name), h('div', { class: 'muted small-text' }, c.linkShown)),
      btn('Rename', () => {
        const name = h('input', { type: 'text', value: c.name });
        const color = h('input', { type: 'color', value: c.color });
        editing.replaceChildren(h('form', { class: 'inline', onsubmit: (e) => run(null, async () => {
          e.preventDefault();
          await api('PATCH', `/calendars/${c.id}`, { name: name.value, color: color.value });
          onChanged();
        }, 'Saved.') },
          h('label', { class: 'field' }, h('span', null, 'Name'), name), color,
          h('button', { class: 'btn primary small', type: 'submit' }, 'Save'), btn('Cancel', () => editing.replaceChildren(), 'btn small ghost')));
      }, 'btn small'),
      btn('Test', (e) => run(e.currentTarget, async () => {
        const r = await api('POST', `/calendars/${c.id}/test`);
        renderTestResults(view.testBox || (view.testBox = h('div')), r.results);
        if (!view.testBox.parentNode) view.after(view.testBox);
      })),
      confirmButton('Remove', 'Sure?', async () => {
        await api('DELETE', `/calendars/${c.id}`);
        onChanged();
      }));
    return h('div', null, view, editing);
  }

  async function tabCalendarTasks(root) {
    const calList = h('div', { class: 'list' });
    const calResults = h('div', { class: 'list', style: { marginTop: '10px' } });
    const todoistBox = h('div');
    const todoistResults = h('div', { class: 'list', style: { marginTop: '10px' } });
    const projectPicker = h('div');

    const reload = () => {
      S.overview = null;
      go('calendartasks', true);
    };

    async function paintCalendars() {
      const { calendars } = await api('GET', '/calendars');
      calList.replaceChildren(calendars.length ? calendars.map((c) => calendarRow(c, reload)) : h('div', { class: 'note' }, 'No calendars added yet.'));
    }

    const nextColor = (count) => DEFAULT_COLORS[count % DEFAULT_COLORS.length];
    async function buildAddForm() {
      const { calendars } = await api('GET', '/calendars');
      const name = h('input', { type: 'text', placeholder: 'Home', maxLength: 60 });
      const link = h('input', { type: 'text', placeholder: 'https://calendar.google.com/calendar/ical/.../private-.../basic.ics', autocomplete: 'off', spellcheck: 'false' });
      const color = h('input', { type: 'color', value: nextColor(calendars.length) });
      const err = h('span', { class: 'err', role: 'alert' });
      const form = h('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          await api('POST', '/calendars', { name: name.value, link: link.value, color: color.value });
          toast('Calendar added.', 'good');
          name.value = '';
          link.value = '';
          await paintCalendars();
          const rebuilt = await buildAddForm();
          addFormHolder.replaceChildren(rebuilt);
        } catch (ex) {
          err.textContent = ex.message;
        }
      } },
      h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('label', { class: 'field' }, h('span', null, 'Secret calendar link'), link),
      h('label', { class: 'field' }, h('span', null, 'Colour'), color),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add calendar')));
      return form;
    }
    const addFormHolder = h('div');

    async function paintTodoist() {
      const info = await api('GET', '/todoist');
      const tokenInput = h('input', { type: 'text', placeholder: 'Paste your Todoist API token', autocomplete: 'off', spellcheck: 'false' });
      const err = h('span', { class: 'err', role: 'alert' });
      const saveForm = h('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          await api('POST', '/todoist/token', { token: tokenInput.value });
          toast('Todoist token saved.', 'good');
          tokenInput.value = '';
          await paintTodoist();
          await paintProjects();
        } catch (ex) {
          err.textContent = ex.message;
        }
      } },
      h('label', { class: 'field' }, h('span', null, info.set ? 'Replace the token' : 'Todoist API token'), tokenInput),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, info.set ? 'Replace token' : 'Save token')));
      todoistBox.replaceChildren(
        h('div', { class: 'row spread' },
          pill(info.set ? `Token saved (${info.tokenShown})` : 'No token yet', info.set ? 'good' : 'bad'),
          info.set ? h('div', { class: 'row' },
            btn('Test', (e) => run(e.currentTarget, async () => renderTestResults(todoistResults, (await api('POST', '/todoist/test')).results))),
            confirmButton('Remove token', 'Sure?', async () => {
              await api('POST', '/todoist/token/remove');
              toast('Todoist token removed.', 'good');
              await paintTodoist();
              await paintProjects();
            })) : null),
        h('div', { style: { marginTop: '10px' } }, saveForm));
    }

    async function paintProjects() {
      const info = await api('GET', '/todoist');
      if (!info.set) {
        projectPicker.replaceChildren(h('div', { class: 'note' }, 'Add your Todoist token to choose which projects appear.'));
        return;
      }
      projectPicker.replaceChildren(h('div', { class: 'muted' }, 'Loading...'));
      try {
        const { projects } = await api('GET', '/todoist/projects');
        const boxes = projects.map((p) => ({ p, box: h('input', { type: 'checkbox', checked: p.shown }) }));
        const save = btn('Save projects', (ev) => run(ev.currentTarget, async () => {
          const picked = boxes.filter((x) => x.box.checked);
          if (!picked.length) throw new Error('Pick at least one project.');
          await api('PATCH', '/settings', { tasks: { lists: picked.length === boxes.length ? [] : picked.map((x) => x.p.name) } });
        }, 'Saved. The screen is reloading.'), 'btn primary');
        projectPicker.replaceChildren(
          h('div', { class: 'list' }, boxes.map(({ p, box }) => h('label', { class: 'item' }, box, h('span', { class: 'grow' }, p.name)))),
          h('div', { class: 'row', style: { marginTop: '12px' } }, save));
      } catch (err) {
        projectPicker.replaceChildren(h('div', { class: 'note bad' }, `Could not load your projects: ${err.message}`));
      }
    }

    const overview0 = S.overview || (await api('GET', '/overview'));
    const isMock = overview0.mock;

    root.append(h('div', { class: 'stack' },
      isMock ? h('div', { class: 'note' }, 'Sample data (mock mode). Calendars and Todoist are not used.') : null,
      h('div', { class: 'grid' },
        card('Calendars', 'Read-only, from a secret link. No sign-in, no expiry.', calList, calResults,
          h('h3', { style: { margin: '16px 0 8px' } }, 'Add a calendar'), addFormHolder, calendarGuide()),
        card('Tasks (Todoist)', 'Move your tasks from Google Tasks to Todoist yourself, then connect it here.', todoistBox, todoistResults,
          h('h3', { style: { margin: '16px 0 8px' } }, 'Which projects to show'), projectPicker,
          h('h3', { style: { margin: '16px 0 8px' } }, 'Get your token'), todoistGuide()))));

    addFormHolder.replaceChildren(await buildAddForm());
    if (!isMock) {
      await Promise.all([paintCalendars(), paintTodoist(), paintProjects()]);
    } else {
      calList.replaceChildren(h('div', { class: 'note' }, 'Sample data.'));
      todoistBox.replaceChildren(h('div', { class: 'note' }, 'Sample data.'));
    }
  }

  // ------------------------------------------------------------------ Weather
  async function tabWeather(root) {
    let [w, st] = await Promise.all([api('GET', '/weather'), api('GET', '/settings')]);
    const now = h('div');
    const results = h('div', { class: 'list', style: { marginTop: '10px' } });

    function paintNow() {
      const x = w.weather;
      const s = w.source || {};
      const unit = st.settings.weather.units === 'metric' ? '°C' : '°F';
      if (!x) {
        now.replaceChildren(h('div', { class: 'note' }, s.error ? `The last weather check failed: ${s.error}` : 'No weather has been fetched yet. Press Refresh now.'));
        return;
      }
      now.replaceChildren(
        h('div', { class: 'row spread' },
          h('div', null, h('div', { class: 'big' }, `${x.current.temp}${unit}`), h('div', null, codeLabel(x.current.code))),
          h('div', { class: 'small-text muted', style: { textAlign: 'right' } },
            h('div', null, `Wind ${x.current.wind} ${x.windUnit} ${x.current.windDir}`),
            h('div', null, `Next ${x.sun.type}: ${x.sun.time}`),
            h('div', null, s.ok ? `Updated ${ago(s.lastFetchAt)}` : s.error ? h('span', { class: 'err' }, s.error) : ''))),
        h('div', { class: 'forecast' }, x.days.map((d, i) =>
          h('div', { class: 'fc' },
            h('b', null, i === 0 ? 'Today' : new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'short' })),
            h('div', null, codeLabel(d.code)),
            h('div', null, `${d.high}° / ${d.low}°`),
            h('div', { class: 'muted' }, `${d.precip == null ? '-' : d.precip}% rain`)))));
    }

    const reload = () => {
      S.overview = null;
      go('weather', true);
    };

    const place = h('input', { type: 'text', placeholder: 'City name, for example Dallas', 'aria-label': 'Search for a place' });
    async function search(e) {
      e.preventDefault();
      const r = await run(e.submitter || null, () => api('GET', `/geocode?q=${encodeURIComponent(place.value)}`));
      if (!r) return;
      if (!r.results.length) return results.replaceChildren(h('div', { class: 'note' }, 'No matching places. Try just the city name.'));
      results.replaceChildren(...r.results.map((p) =>
        h('div', { class: 'item' },
          h('div', { class: 'grow' }, h('b', null, p.name), h('div', { class: 'muted small-text' }, [p.admin1, p.country].filter(Boolean).join(', '), ` (${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)})`)),
          btn('Use this', (ev) => run(ev.currentTarget, async () => {
            await api('PATCH', '/settings', { weather: { latitude: Number(p.latitude.toFixed(4)), longitude: Number(p.longitude.toFixed(4)), label: [p.name, p.admin1].filter(Boolean).join(', ') } });
            reload();
          }, 'Location saved.'), 'btn small primary'))));
    }

    const locForm = buildForm([F.label, F.lat, F.lon, F.units, F.rWeather], st.settings, st.overridden, { onSaved: reload });

    root.append(h('div', { class: 'stack' },
      card('Current weather', `${st.settings.weather.label || 'Your location'}. Data from Open-Meteo.`, now,
        h('div', { class: 'row', style: { marginTop: '14px' } }, btn('Refresh now', (e) => run(e.currentTarget, async () => {
          const r = await api('POST', '/weather/refresh');
          w = { ...w, weather: r.weather, source: r.source };
          paintNow();
        }, 'Weather refreshed.'), 'btn primary'))),
      h('div', { class: 'grid' },
        card('Find your city', 'Search, then pick the right one.',
          h('form', { class: 'inline', onsubmit: search }, h('label', { class: 'field' }, h('span', null, 'Place'), place), h('button', { class: 'btn', type: 'submit' }, 'Search')), results),
        card('Location and units', 'Or type the numbers yourself.', locForm))));
    paintNow();
  }

  // ------------------------------------------------------------------ Settings
  async function tabSettings(root) {
    const st = await api('GET', '/settings');
    const power0 = await api('GET', '/power');
    const reload = () => {
      S.overview = null;
      go('settings', true);
    };
    const all = buildForm([
      { heading: 'Clock and look' }, F.timeFormat, F.showSeconds, F.locale, F.lowPower,
      { heading: 'Calendar (which calendars appear is set on the Calendar & Tasks tab)' }, F.weeks, F.weekStart, F.perDay,
      { heading: 'Tasks (which Todoist projects appear is set on the Calendar & Tasks tab)' }, F.tasksTitle, F.tasksMax,
      { heading: 'How often to check (lower numbers show changes sooner but check the calendar link and Todoist more often)' }, F.rCal, F.rTasks, F.rWeather,
    ], st.settings, st.overridden, { onSaved: reload });

    // Time zone: not one of the settings above (it's the Pi's own system clock, not a Homeboard setting
    // in data/settings.json), so it is its own small form that calls a dedicated endpoint.
    let zones;
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
    if (!zones.includes(power0.timezone)) zones = [power0.timezone, ...zones];
    const tzSelect = h('select', { value: power0.timezone }, zones.map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
    const tzErr = h('span', { class: 'err', role: 'alert' });
    const tzForm = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      tzErr.textContent = '';
      const save = e.submitter;
      if (save) save.disabled = true;
      try {
        await api('POST', '/timezone', { timezone: tzSelect.value });
        toast('Time zone saved. The server is restarting to apply it (a few seconds)...', 'good');
      } catch (ex) {
        tzErr.textContent = ex.message;
      } finally {
        if (save) save.disabled = false;
      }
    } },
    h('label', { class: 'field' }, h('span', null, 'Time zone'), tzSelect),
    tzErr,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save time zone')));

    root.append(h('div', { class: 'stack' },
      card('Settings', null, all),
      card('Time zone', `The Pi's clock currently says ${new Date().toLocaleString([], { timeZone: power0.timezone })}. A wrong time zone shows the wrong time and the wrong "today" on the calendar.`, tzForm),
      card('Start over', 'Resetting undoes every change made from this dashboard, including your city and the calendars and task lists you picked, and goes back to the original settings.',
        h('div', { class: 'row' }, confirmButton('Reset all dashboard settings', 'Really reset everything?', async () => {
          await api('POST', '/settings/reset', {});
          toast('Reset. The screen is reloading.', 'good');
          reload();
        }, 'btn danger'), h('span', { class: 'muted small-text' }, st.overridden.length ? `${plural(st.overridden.length, 'setting')} changed from the dashboard.` : 'Nothing has been changed from the dashboard.')))));
  }

  // ------------------------------------------------------------------ System
  async function tabSystem(root) {
    const o = await api('GET', '/overview');
    S.overview = o;
    const sys = o.system;
    const memUsed = Math.round((1 - sys.mem.free / sys.mem.total) * 100);
    const diskUsed = sys.disk ? Math.round((1 - sys.disk.free / sys.disk.total) * 100) : null;
    const bar = (pct, warnAt, badAt) => h('div', { class: `bar ${pct >= badAt ? 'bad' : pct >= warnAt ? 'warn' : ''}`, style: { margin: '4px 0 10px' } }, h('i', { style: { width: `${Math.min(100, pct)}%` } }));
    const port = location.port ? `:${location.port}` : '';

    const powerRow = (label, bad, badText) => h('div', { class: 'item' }, pill(bad ? 'Yes' : 'No', bad ? 'bad' : 'good'), h('div', { class: 'grow small-text' }, label, bad ? h('span', { class: 'muted' }, ` (${badText})`) : null));
    const p = sys.power;

    // optional password: none by default, can be set, changed or removed here
    const minPw = (S.session && S.session.minPassword) || 4;
    const pwBox = h('div');
    const paintPassword = () => {
      const isSet = Boolean(S.session && S.session.passwordSet);
      const cur = h('input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input', { type: 'password', autocomplete: 'new-password' });
      const err = h('span', { class: 'err', role: 'alert' });
      const finish = (r, message) => {
        S.session = { ...S.session, passwordSet: r.passwordSet };
        toast(message, 'good');
        paintPassword();
      };
      const form = h('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!next.value || next.value.length < minPw) return (err.textContent = `Type a password of at least ${minPw} characters.`);
        const btnEl = e.submitter;
        if (btnEl) btnEl.disabled = true;
        try {
          finish(await api('POST', '/password', { current: cur.value, next: next.value }), isSet ? 'Password changed.' : 'Password set. This browser stays signed in.');
        } catch (ex) {
          err.textContent = ex.message;
          if (btnEl) btnEl.disabled = false;
        }
      } },
      isSet ? h('label', { class: 'field' }, h('span', null, 'Current password'), cur) : null,
      h('label', { class: 'field' }, h('span', null, isSet ? 'New password' : 'Password'), next, h('span', { class: 'hint' }, `At least ${minPw} characters.`)),
      err,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, isSet ? 'Change password' : 'Set password'),
        isSet ? confirmButton('Remove password', 'Really remove?', async () => {
          err.textContent = '';
          if (!cur.value) return (err.textContent = 'Type the current password above first.');
          try {
            finish(await api('POST', '/password', { current: cur.value, next: '' }), 'Password removed. Anyone on your network can open the dashboard.');
          } catch (ex) {
            err.textContent = ex.message;
          }
        }, 'btn danger') : null));
      pwBox.replaceChildren(
        h('p', { class: 'muted small-text' }, isSet
          ? 'Other devices on your network have to enter it once. Each browser then stays signed in.'
          : 'No password is set, so anyone on your home network can open this page. That is fine for most homes. You can add one whenever you like.'),
        form);
      $('#logout').hidden = !isSet;
    };
    paintPassword();

    // logs
    const logBox = h('div', { class: 'logs', tabindex: '0', role: 'log', 'aria-label': 'Recent server messages' });
    let last = 0;
    let stopped = false;
    let timer;
    async function pollLogs() {
      if (stopped) return;
      try {
        if (!document.hidden) {
          const r = await api('GET', `/logs?since=${last}`);
          if (r.logs.length) {
            const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
            for (const l of r.logs) logBox.append(h('div', { class: l.level === 'error' ? 'l-error' : l.level === 'warn' ? 'l-warn' : '' }, h('span', { class: 't' }, `${clock(l.t)}  `), l.msg));
            while (logBox.childNodes.length > 400) logBox.firstChild.remove();
            if (atBottom) logBox.scrollTop = logBox.scrollHeight;
          }
          last = r.last;
        }
      } catch {
        /* keep trying */
      }
      timer = setTimeout(pollLogs, 3000);
    }

    async function restart(e) {
      const ok = await run(e.currentTarget, () => api('POST', '/actions/restart'));
      if (!ok) return;
      toast('Restarting the server. This takes a few seconds.');
      const t0 = Date.now();
      const wait = async () => {
        try {
          await api('GET', '/session');
          toast('The server is back.', 'good');
          go('system', true);
        } catch {
          if (Date.now() - t0 > 60000) toast('The server has not come back after a minute. Check the Pi.', 'bad');
          else setTimeout(wait, 1500);
        }
      };
      setTimeout(wait, 2000);
    }

    async function rebootPi(e) {
      const ok = await run(e.currentTarget, () => api('POST', '/actions/reboot-pi'));
      if (!ok) return;
      toast('Rebooting the Pi. The screen will go dark for a minute or two, then Homeboard opens again on its own.');
    }

    root.append(h('div', { class: 'stack' },
      h('div', { class: 'grid' },
        card('Device', null, kv([
          ['Model', sys.model || sys.platform],
          ['Name', sys.hostname],
          ['Dashboard address', sys.addresses.length ? sys.addresses.map((a) => h('div', null, h('code', null, `${a.address}${port}/admin`))) : 'not on a network'],
          ['Also try', h('code', null, `${sys.hostname}.local${port}/admin`)],
          ['Pi uptime', fmtDur(sys.uptimeSec)],
          ['Server uptime', fmtDur(sys.serverUptimeSec)],
          ['Software', `Homeboard ${o.version}, Node ${sys.node}`],
        ])),
        card('Health', null,
          h('div', null, h('div', { class: 'row spread small-text' }, h('span', null, 'Temperature'), h('b', null, sys.tempC != null ? `${sys.tempC}°C` : 'not available')), sys.tempC != null ? bar(sys.tempC, 70, 80) : null),
          h('div', null, h('div', { class: 'row spread small-text' }, h('span', null, 'Memory'), h('b', null, `${memUsed}% of ${fmtBytes(sys.mem.total)}`)), bar(memUsed, 75, 90)),
          diskUsed != null ? h('div', null, h('div', { class: 'row spread small-text' }, h('span', null, 'Storage'), h('b', null, `${diskUsed}% used, ${fmtBytes(sys.disk.free)} free`)), bar(diskUsed, 80, 92)) : null,
          h('div', { class: 'row spread small-text' }, h('span', null, 'Load'), h('b', { title: '1, 5 and 15 minute averages' }, `${sys.load.join(', ')} (${plural(sys.cpus, 'core')})`))),
        card('Power', p ? 'From the Pi itself. Under-voltage means the power supply is too weak.' : 'Only a Raspberry Pi reports this.',
          p ? h('div', { class: 'list' },
            powerRow('Under-voltage right now', p.underVoltageNow, 'use the official power supply'),
            powerRow('Under-voltage since start', p.underVoltageSinceBoot, 'the supply dipped at some point'),
            powerRow('Slowed down by heat right now', p.throttledNow || p.tempLimitNow, 'improve cooling'),
            powerRow('Slowed down since start', p.throttledSinceBoot, 'it got too hot or too little power')) : h('div', { class: 'note' }, 'No power information here.'))),
      h('div', { class: 'grid' },
        card('Actions', null, h('div', { class: 'row' },
          btn('Reload screen', (e) => run(e.currentTarget, async () => toast((await api('POST', '/actions/reload')).screens ? 'Reloading the screen.' : 'No screen is connected right now (fine if the monitor is off).', 'good'))),
          o.canRestart ? confirmButton('Restart server', 'Really restart?', () => restart({ currentTarget: null }), 'btn danger') : h('span', { class: 'muted small-text' }, 'Restart is available when Homeboard runs as a background service (the normal Pi install).'),
          confirmButton('Reboot Pi', 'Really reboot?', () => rebootPi({ currentTarget: null }), 'btn danger'))),
        card('Password (optional)', null, pwBox)),
      card('Recent server messages', 'Updates every few seconds.', logBox)));

    await pollLogs();
    logBox.scrollTop = logBox.scrollHeight;
    return { cleanup: () => { stopped = true; clearTimeout(timer); } };
  }

  // ------------------------------------------------------------------ Screen power
  async function tabPower(root) {
    let st = await api('GET', '/power');
    const statusBox = h('div');
    const formBox = h('div');
    const hueBox = h('div');
    const lightBox = h('div');

    // Times are the Pi's clock, which may differ from the device you are browsing on.
    const clockText = (hhmm) => new Date(2000, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3))).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const whenText = (ts, p) => {
      const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: p.timezone });
      const d = day(ts);
      const time = new Date(ts).toLocaleTimeString([], { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' });
      if (d === day(p.now)) return `today at ${time}`;
      if (d === day(p.now + 86400000)) return `tomorrow at ${time}`;
      return `${new Date(ts).toLocaleDateString([], { timeZone: p.timezone, weekday: 'long' })} at ${time}`;
    };

    const refresh = async () => {
      st = await api('GET', '/power');
      S.overview = null;
      paintStatus(st, true);
      paintForm(st);
      paintHue(st);
      paintLight();
    };

    // ---- status and the On / Off now buttons ----
    let statusKey = '';
    function paintStatus(p, force = false) {
      const key = JSON.stringify([p.applied, p.manual, p.manualUntil, p.next, p.display, p.last && p.last.at, p.failing, p.settings, p.hue.linked]);
      if (!force && key === statusKey) return;
      statusKey = key;
      const s = p.settings;
      const state = p.applied === 'on' ? ['Screen is ON', 'good'] : p.applied === 'off' ? ['Screen is OFF', 'warn'] : ['Waiting to switch', ''];
      let line;
      if (p.manual) line = s.enabled && p.manualUntil ? `You switched it ${p.manual} by hand. It stays ${p.manual} until ${whenText(p.manualUntil, p)}, then follows the schedule.` : `You switched it ${p.manual} by hand. It stays that way until you switch it back.`;
      else if (!s.enabled) line = 'The daily schedule is off, so the screen stays on.';
      else if (p.next) line = `Turns ${p.next.to} ${whenText(p.next.at, p)}.`;
      else line = 'The screen stays on (the on and off times are the same).';
      const canControl = Boolean(p.display.method) || (p.hue.linked && p.hue.targets.length && s.hueWithScreen);
      // A CEC problem shows up in one of two ways: the Pi has no CEC adapter at all (rare - p.display.cec.available
      // is false), or the adapter is fine but this particular monitor never confirms the command (the common case -
      // shows up per-switch as p.last.warning, which mentions "HDMI-CEC"). Either way, the same dismiss button
      // applies; only one is shown at a time, and a non-CEC warning (e.g. from the Hue plug) is never hidden by it.
      const lastWarningIsCec = Boolean(p.last && p.last.ok && p.last.warning && /HDMI-CEC/i.test(p.last.warning));
      const cecUnavailable = s.useCec && p.display.cec && !p.display.cec.available;
      const cecText = lastWarningIsCec ? p.last.warning : cecUnavailable ? `Not available${p.display.method ? ', so only the picture is switched off' : ''}. ${p.display.cec.reason || ''}` : null;
      const dismissCec = (e) => run(e.currentTarget, async () => {
        st = await api('PATCH', '/power', { dismissCecWarning: true });
        S.overview = null;
        paintStatus(st, true);
      }, 'Got it - this warning is now cleared.');
      statusBox.replaceChildren(card('Screen power', `The Pi's clock says ${new Date(p.now).toLocaleTimeString([], { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' })} (${p.timezone.replace(/_/g, ' ')})`,
        h('div', { class: 'row', style: { marginBottom: '10px' } }, pill(state[0], state[1]), h('span', { class: 'small-text muted' }, line)),
        h('div', { class: 'row' },
          btn('Turn on now', (e) => setScreen(e, 'on'), p.applied === 'off' ? 'btn primary' : 'btn'),
          btn('Turn off now', (e) => setScreen(e, 'off')),
          p.manual ? btn('Go back to the schedule', (e) => run(e.currentTarget, async () => {
            const r = await api('POST', '/power/resume');
            st = r.status;
            paintStatus(st, true);
          }, 'Back on the schedule.'), 'btn ghost') : null),
        h('div', { style: { marginTop: '14px' } }, kv([
          ['Switched with', p.display.method ? p.display.label : h('span', { class: 'err' }, 'Not available')],
          p.hue.linked ? ['Hue plug', p.hue.targets.length ? p.hue.targets.map((t) => t.name || t.id).join(', ') + (s.hueWithScreen ? '' : ' (not used)') : 'linked, no device chosen yet'] : null,
        ])),
        h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Check HDMI-CEC', (e) => checkCec(e), 'btn small')),
        cecText && !s.dismissCecWarning
          ? h('div', { class: 'note warn', style: { marginTop: '12px' } },
              h('div', null, cecText),
              h('div', { class: 'row', style: { marginTop: '8px' } }, btn('This monitor doesn\'t support HDMI-CEC', dismissCec, 'btn small'))) : null,
        s.dismissCecWarning ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'muted small-text' }, 'HDMI-CEC warning cleared. '), btn('Show it again', (e) => run(e.currentTarget, async () => {
          st = await api('PATCH', '/power', { dismissCecWarning: false });
          S.overview = null;
          paintStatus(st, true);
        }), 'btn small ghost')) : null,
        !canControl ? h('div', { class: 'note bad', style: { marginTop: '12px' } }, `This Pi cannot switch the screen yet. ${p.display.reason || ''}`) : null,
        p.last && p.last.ok && p.last.warning && !lastWarningIsCec ? h('div', { class: 'note warn', style: { marginTop: '12px' } }, p.last.warning) : null,
        p.last && !p.last.ok ? h('div', { class: 'note warn', style: { marginTop: '12px' } }, `The last attempt to switch the screen ${p.last.want} did not work: ${p.last.message}`) : null));
    }
    async function checkCec(e) {
      const b = e.currentTarget;
      b.disabled = true;
      const label = b.textContent;
      b.textContent = 'Asking the monitor...';
      try {
        const r = await api('POST', '/power/cec-check');
        toast(r.message, r.ok ? 'good' : 'bad');
      } catch (ex) {
        toast(ex.message, 'bad');
      } finally {
        b.disabled = false;
        b.textContent = label;
      }
    }
    async function setScreen(e, state) {
      await run(e.currentTarget, async () => {
        const r = await api('POST', '/power/screen', { state });
        st = r.status;
        S.overview = null;
        paintStatus(st, true);
        if (!r.ok) throw new Error(r.message || 'The screen did not switch.');
        toast(state === 'on' ? 'Screen switched on.' : 'Screen switched off.', 'good');
      });
    }

    // ---- the daily schedule ----
    function paintForm(p) {
      const s = p.settings;
      const enabled = h('input', { type: 'checkbox', checked: s.enabled });
      const on = h('input', { type: 'time', value: s.onTime, required: true, 'aria-label': 'Turn on at' });
      const off = h('input', { type: 'time', value: s.offTime, required: true, 'aria-label': 'Turn off at' });
      const cec = h('input', { type: 'checkbox', checked: s.useCec });
      const wk = h('input', { type: 'checkbox', checked: s.weekendDifferent });
      const wkOn = h('input', { type: 'time', value: s.weekendOnTime, required: true, 'aria-label': 'Weekend turn on at' });
      const wkOff = h('input', { type: 'time', value: s.weekendOffTime, required: true, 'aria-label': 'Weekend turn off at' });
      const wkBox = h('div', { class: 'form cols' },
        h('label', { class: 'field' }, h('span', null, 'Saturday and Sunday: turn on at'), wkOn),
        h('label', { class: 'field' }, h('span', null, 'Saturday and Sunday: turn off at'), wkOff));
      const dayLabel = h('span', null);
      const timesBox = h('div', { class: 'stack' },
        h('div', { class: 'form cols' },
          h('label', { class: 'field' }, dayLabel, on),
          h('label', { class: 'field' }, h('span', null, 'Turn off at'), off)),
        h('label', { class: 'check' }, wk, 'Use different times on Saturday and Sunday'),
        wkBox);
      const sync = () => {
        dayLabel.textContent = wk.checked ? 'Monday to Friday: turn on at' : 'Turn on at';
        wkBox.hidden = !wk.checked;
        timesBox.style.opacity = enabled.checked ? '' : '0.5';
      };
      enabled.addEventListener('change', sync);
      wk.addEventListener('change', sync);
      sync();
      const err = h('div', { class: 'err', role: 'alert' });
      const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save schedule');
      const form = h('form', { class: 'form', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        save.disabled = true;
        try {
          const r = await api('PATCH', '/power', {
            enabled: enabled.checked, onTime: on.value, offTime: off.value, weekendDifferent: wk.checked, weekendOnTime: wkOn.value, weekendOffTime: wkOff.value, useCec: cec.checked,
          });
          st = r;
          S.overview = null;
          toast('Schedule saved.', 'good');
          paintStatus(st, true);
          paintForm(st);
        } catch (ex) {
          err.textContent = ex.message;
          toast(ex.message, 'bad');
        } finally {
          save.disabled = false;
        }
      } },
      h('label', { class: 'check' }, enabled, 'Switch the monitor on and off automatically'),
      timesBox,
      h('label', { class: 'check' }, cec, 'Switch the monitor with HDMI-CEC (recommended). This is what really switches its power. Without it, only the picture is turned off.'),
      err,
      h('div', { class: 'row' }, save),
      h('div', { class: 'hint' }, `A time like 22:00 means 10:00 PM. If the on time is later than the off time (for example on at 6:00 PM, off at 2:00 AM), the screen runs through midnight. The current schedule: on at ${clockText(s.onTime)}, off at ${clockText(s.offTime)}${s.weekendDifferent ? `, weekends ${clockText(s.weekendOnTime)} to ${clockText(s.weekendOffTime)}` : ''}.`));
      formBox.replaceChildren(card('Daily schedule', 'At the off time the Pi tells the monitor to switch itself off, and at the on time to switch on, every day (over the HDMI cable, using HDMI-CEC). The Pi keeps running, so the calendar is up to date the moment the monitor wakes.', form));
    }

    // ---- Philips Hue ----
    async function paintHue(p) {
      const hs = p.hue;
      if (!hs.linked) {
        const ip = h('input', { type: 'text', placeholder: '192.168.1.20', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Hue Bridge address' });
        const found = h('div', { class: 'list' });
        const find = btn('Find my Hue Bridge', (e) => run(e.currentTarget, async () => {
          const r = await api('POST', '/power/hue/discover');
          if (!r.bridges.length) {
            found.replaceChildren(h('div', { class: 'note warn' }, 'Nothing was found automatically. Type the bridge\'s address below. You can see it in your router\'s list of devices, or in the Hue app under Settings, My Hue system, by tapping the bridge.'));
            return;
          }
          found.replaceChildren(...r.bridges.map((b) => h('div', { class: 'item' }, pill(b.name, 'good'), h('div', { class: 'grow small-text' }, b.ip), btn('Use this', () => {
            ip.value = b.ip;
            toast('Now click Link Hue, then press the round button on the bridge.');
          }, 'btn small'))));
          if (r.bridges.length === 1) ip.value = r.bridges[0].ip;
        }));
        const link = h('button', { class: 'btn primary', type: 'button' }, 'Link Hue');
        link.addEventListener('click', async () => {
          if (!ip.value.trim()) return toast('Click Find my Hue Bridge first, or type the bridge\'s address.', 'bad');
          link.disabled = true;
          link.textContent = 'Press the round button on the bridge now...';
          try {
            await api('POST', '/power/hue/link', { ip: ip.value });
            toast('Hue is linked. Now choose the plug.', 'good');
            await refresh();
          } catch (ex) {
            toast(ex.message, 'bad');
            link.disabled = false;
            link.textContent = 'Link Hue';
          }
        });
        hueBox.replaceChildren(card('Philips Hue (optional)', 'If the monitor is plugged into a Hue smart plug, Homeboard can also cut its power at night (in addition to HDMI-CEC).',
          h('div', { class: 'stack' },
            h('p', { class: 'small-text muted', style: { margin: 0 } }, 'You need a Hue Bridge on your network. At night Homeboard tells the monitor to switch itself off (HDMI-CEC) and cuts the plug a few seconds later. In the morning the plug comes on first, then the monitor is woken.'),
            h('div', { class: 'row' }, find),
            found,
            h('label', { class: 'field' }, h('span', null, 'Bridge address'), ip),
            h('div', { class: 'hint' }, 'Click Link Hue, then press the round button on top of the bridge within 30 seconds.'),
            h('div', { class: 'row' }, link))));
        return;
      }

      const lightsBox = h('div', { class: 'list' }, h('div', { class: 'muted small-text' }, 'Loading devices from the bridge...'));
      const useHue = h('input', { type: 'checkbox', checked: st.settings.hueWithScreen });
      useHue.addEventListener('change', async () => {
        try {
          st = await api('PATCH', '/power', { hueWithScreen: useHue.checked });
          S.overview = null;
          paintStatus(st, true);
          toast(useHue.checked ? 'Hue will switch with the screen.' : 'Hue will be left alone.', 'good');
        } catch (ex) {
          useHue.checked = !useHue.checked;
          toast(ex.message, 'bad');
        }
      });
      let boxes = [];
      const saveDevices = btn('Save chosen devices', (e) => run(e.currentTarget, async () => {
        const ids = boxes.filter((b) => b.input.checked).map((b) => b.id);
        await api('PUT', '/power/hue/targets', { ids });
        await refresh();
      }, 'Saved.'));
      const testRow = h('div', { class: 'row' },
        btn('Test the plug (off for 5 seconds)', async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          b.textContent = 'Plug is off... wait 5 seconds';
          try {
            const r = await api('POST', '/power/hue/test');
            toast(r.message, 'good');
          } catch (ex) {
            toast(ex.message, 'bad');
          } finally {
            b.disabled = false;
            b.textContent = 'Test the plug (off for 5 seconds)';
          }
        }));
      hueBox.replaceChildren(card('Philips Hue', `Linked to the bridge at ${hs.bridge}.`,
        h('div', { class: 'stack' },
          h('p', { class: 'small-text muted', style: { margin: 0 } }, 'Tick the smart plug your monitor is plugged into (never the Pi). Ticking a light works too, but then the light goes off and on with the screen.'),
          lightsBox,
          h('div', { class: 'row' }, saveDevices),
          h('label', { class: 'check' }, useHue, 'Switch these together with the screen (on and off, on the schedule and with the buttons above)'),
          testRow,
          h('div', { class: 'row' }, confirmButton('Unlink Hue', 'Sure? Click again', async () => {
            await api('POST', '/power/hue/unlink');
            toast('Hue unlinked.', 'good');
            await refresh();
          })))));
      try {
        const r = await api('GET', '/power/hue/lights');
        const chosen = new Set(r.targets.map((t) => t.id));
        boxes = r.lights.map((l) => ({ id: l.id, input: h('input', { type: 'checkbox', checked: chosen.has(l.id) }) }));
        lightsBox.replaceChildren(...(r.lights.length ? r.lights.map((l, i) => h('label', { class: 'item' }, boxes[i].input, h('div', { class: 'grow' }, l.name), l.plug ? pill('Smart plug', 'good') : pill('Light', 'plain'))) : [h('div', { class: 'muted small-text' }, 'The bridge has no lights or plugs.')]));
      } catch (ex) {
        lightsBox.replaceChildren(h('div', { class: 'note bad' }, ex.message), btn('Try again', () => paintHue(st), 'btn small'));
      }
    }


    // ---- appearing as a light in diyHue (the Hue app without a plug) ----
    async function paintLight() {
      let ls;
      try {
        ls = await api('GET', '/power/huelight');
      } catch (ex) {
        lightBox.replaceChildren(card('Hue app control (diyHue, optional)', '', h('div', { class: 'note bad' }, ex.message)));
        return;
      }
      const ago = (t) => {
        const s = Math.max(0, Math.round((ls.now - t) / 1000));
        return s < 60 ? 'a moment ago' : s < 3600 ? `${Math.round(s / 60)} minutes ago` : s < 86400 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`;
      };
      const on = h('input', { type: 'checkbox', checked: ls.enabled });
      const name = h('input', { type: 'text', value: ls.name, maxlength: '32', autocomplete: 'off', 'aria-label': 'Name shown in the Hue app' });
      const where = h('select', { 'aria-label': 'Where diyHue runs' },
        h('option', { value: 'all' }, 'On another computer (or anywhere else)'),
        h('option', { value: 'docker' }, 'On this same Pi, in Docker'));
      where.value = ls.address;
      const err = h('div', { class: 'err', role: 'alert' });
      const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
      const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        save.disabled = true;
        try {
          const r = await api('PATCH', '/power/huelight', { enabled: on.checked, name: name.value, address: where.value });
          if (r.enabled && !r.listening) toast('Saved, but the Pi could not open the port. The card below says why.', 'bad');
          else toast(r.enabled ? 'Saved. This Pi now answers diyHue.' : 'Saved. This Pi no longer answers diyHue.', 'good');
          await paintLight();
        } catch (ex) {
          err.textContent = ex.message;
          toast(ex.message, 'bad');
          save.disabled = false;
        }
      } },
      h('p', { class: 'small-text muted', style: { margin: 0 } }, 'diyHue is a free program that pretends to be a Hue Bridge. It can list this monitor as a Hue smart plug, and then the Hue app can switch the screen on and off (the same way the schedule does, over HDMI-CEC). It is a second bridge next to your real one. It can run on another computer, or on this same Pi. Setup steps are in START-HERE.md, Part 6.'),
      h('label', { class: 'check' }, on, 'Let diyHue see this Pi as a Hue smart plug'),
      h('label', { class: 'field' }, h('span', null, 'Where does diyHue run?'), where),
      h('label', { class: 'field' }, h('span', null, 'Name shown in the Hue app'), name),
      err,
      h('div', { class: 'row' }, save, btn('Refresh', () => paintLight(), 'btn ghost')));
      const items = [];
      if (ls.enabled) {
        items.push(ls.listening ? h('div', { class: 'row' }, pill(`Listening on port ${ls.port}`, 'good')) : h('div', { class: 'note bad' }, ls.error || 'Not listening yet. Wait a few seconds and press Refresh.'));
        items.push(kv([
          [ls.address === 'docker' ? 'Address to give diyHue (Docker)' : 'Address to give diyHue', ls.addresses.length ? ls.addresses.join('  or  ') : h('span', { class: 'err' }, ls.address === 'docker' ? 'Docker is not installed yet (see START-HERE.md, Part 6)' : 'no network address found')],
          ['diyHue last asked', ls.seen ? `${ls.seen.ip}, ${ago(ls.seen.at)}` : 'not yet'],
          ['Last switch from diyHue', ls.switched ? `${ls.switched.state}, ${ago(ls.switched.at)} (${ls.switched.ip})` : 'none yet'],
        ]));
      }
      lightBox.replaceChildren(card('Hue app control (diyHue, optional)', 'The monitor shows up as a Hue smart plug in diyHue.', form, ...items.map((i) => h('div', { style: { marginTop: '12px' } }, i))));
    }

    root.append(h('div', { class: 'stack' }, statusBox, formBox, hueBox, lightBox));
    paintHue(st);
    paintLight();
    paintStatus(st, true);
    paintForm(st);
    return { onOverview: (o) => o.power && paintStatus(o.power) };
  }

  // ------------------------------------------------------------------ router
  const TABS = [
    ['overview', 'Overview', tabOverview],
    ['backgrounds', 'Pictures', tabBackgrounds],
    ['calendartasks', 'Calendar & Tasks', tabCalendarTasks],
    ['weather', 'Weather', tabWeather],
    ['power', 'Screen power', tabPower],
    ['settings', 'Settings', tabSettings],
    ['system', 'System', tabSystem],
  ];
  let renderToken = 0;

  function currentName() {
    const n = location.hash.replace(/^#\/?/, '');
    return TABS.some(([k]) => k === n) ? n : 'overview';
  }

  async function go(name, force = false) {
    if (!force && name === currentName() && S.tab && S.tab.name === name) return;
    if (location.hash !== `#/${name}`) {
      history.replaceState(null, '', `#/${name}`);
    }
    await render();
  }

  async function render() {
    const token = ++renderToken;
    const name = currentName();
    if (S.tab && S.tab.cleanup) S.tab.cleanup();
    S.tab = null;
    for (const t of $('#tabs').children) {
      if (t.dataset.tab === name) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    }
    const main = $('#main');
    main.replaceChildren(h('div', { class: 'muted' }, 'Loading...'));
    const holder = h('div');
    try {
      const impl = TABS.find(([k]) => k === name)[2];
      const result = (await impl(holder)) || {};
      if (token !== renderToken) {
        if (result.cleanup) result.cleanup();
        return;
      }
      S.tab = { name, ...result };
      main.replaceChildren(holder);
    } catch (err) {
      if (token !== renderToken) return;
      if (!S.authed) return;
      main.replaceChildren(card('Something went wrong', null, h('p', { class: 'err' }, err.message), btn('Try again', () => render())));
    }
  }

  // ------------------------------------------------------------------ sign in / start up
  function showLogin() {
    if (S.tab && S.tab.cleanup) S.tab.cleanup();
    S.tab = null;
    $('#app').hidden = true;
    const box = $('#login');
    box.hidden = false;
    const msg = h('div', { class: 'err', role: 'alert' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', autofocus: true, required: true, 'aria-label': 'Password' });
    const go1 = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      go1.disabled = true;
      try {
        await api('POST', '/login', { password: pw.value });
        await boot();
      } catch (err) {
        msg.textContent = err.message;
        pw.select();
      } finally {
        go1.disabled = false;
      }
    } },
    h('label', { class: 'field' }, h('span', null, 'Password'), pw),
    msg, go1);
    box.replaceChildren(h('div', { class: 'card' }, h('h1', null, 'Homeboard'), h('p', { class: 'muted' }, 'Enter the dashboard password. This browser will remember it.'), form));
    pw.focus();
  }

  async function boot() {
    let info;
    try {
      info = await api('GET', '/session');
    } catch (err) {
      $('#login').hidden = false;
      $('#app').hidden = true;
      $('#login').replaceChildren(h('div', { class: 'card' }, h('h1', null, 'Homeboard'), h('p', { class: 'err' }, err.message), btn('Try again', () => boot(), 'btn primary')));
      return;
    }
    S.session = info;
    if (!info.authed) {
      S.authed = false;
      return showLogin();
    }
    S.authed = true;
    $('#logout').hidden = !info.passwordSet;
    $('#login').hidden = true;
    $('#app').hidden = false;
    S.overview = null;
    await render();
    poll();
  }

  function init() {
    $('#tabs').replaceChildren(...TABS.map(([key, label]) => h('button', { class: 'tab', type: 'button', 'data-tab': key, onclick: () => go(key) }, label)));
    $('#logout').addEventListener('click', async () => {
      try {
        await api('POST', '/logout');
      } catch {
        /* already signed out */
      }
      S.authed = false;
      S.session = { ...(S.session || {}), authed: false, passwordSet: true };
      showLogin();
    });
    window.addEventListener('hashchange', () => {
      if (S.authed) render();
    });
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll();
    });
    boot();
  }

  init();
})();
