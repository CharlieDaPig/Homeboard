'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  // Everything from a calendar feed or Todoist is untrusted text, so we only ever use textContent, never innerHTML.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const parseYmd = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  let CFG;
  let calEvents = [];
  let calLoaded = false;
  let taskGroups = null;
  const loadedDay = ymd(new Date());

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || res.statusText), { forbidden: res.status === 403 });
    return body;
  }

  const is24 = () => CFG.display.timeFormat === '24h';
  const loc = () => CFG.locale || undefined;

  // ---------- Clock & date ----------
  function tick() {
    const now = new Date();
    if (ymd(now) !== loadedDay) return location.reload(); // new day: rebuild the calendar grid
    const h = now.getHours();
    $('time').textContent = is24() ? `${pad(h)}:${pad(now.getMinutes())}` : `${h % 12 || 12}:${pad(now.getMinutes())}`;
    $('secs').textContent = CFG.display.showSeconds ? pad(now.getSeconds()) : '';
    $('ampm').textContent = is24() ? '' : h < 12 ? 'AM' : 'PM';
    $('dow').textContent = now.toLocaleDateString(loc(), { weekday: 'long' }) + ',';
    $('md').textContent = now.toLocaleDateString(loc(), { month: 'long', day: 'numeric' });
  }

  // "7p", "7:30p" or "19:30"
  function fmtTime(d) {
    const h = d.getHours();
    const m = d.getMinutes();
    if (is24()) return `${pad(h)}:${pad(m)}`;
    return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h < 12 ? 'a' : 'p'}`;
  }

  // "06:52" -> "6:52 AM"
  function fmtClock(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return is24() ? `${pad(h)}:${pad(m)}` : `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // ---------- Calendar ----------
  function gridRange() {
    const today = startOfDay(new Date());
    const offset = (today.getDay() - CFG.calendar.weekStartsOn + 7) % 7;
    const start = addDays(today, -offset);
    return { today, start, end: addDays(start, CFG.calendar.weeks * 7) };
  }

  function eventDays(ev) {
    const days = [];
    if (ev.allDay) {
      for (let d = parseYmd(ev.start), end = parseYmd(ev.end); d < end; d = addDays(d, 1)) days.push(d);
    } else {
      const end = new Date(ev.end);
      let d = startOfDay(new Date(ev.start));
      do {
        days.push(d);
        d = addDays(d, 1);
      } while (d < end);
    }
    return days;
  }

  function renderCalendar() {
    const { today, start } = gridRange();
    const weeks = CFG.calendar.weeks;
    const max = CFG.calendar.maxEventsPerDay;

    const dowRow = $('dowRow');
    dowRow.replaceChildren();
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const c = el('div', ymd(d) === ymd(today) || d.getDay() === today.getDay() ? 'today' : '', d.toLocaleDateString(loc(), { weekday: 'short' }));
      dowRow.append(c);
    }

    // Bucket events by day.
    const byDay = new Map();
    for (const ev of calEvents) {
      const days = eventDays(ev);
      days.forEach((d, i) => {
        const key = ymd(d);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push({ ev, first: i === 0 });
      });
    }

    const grid = $('grid');
    grid.replaceChildren();
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(start, i);
      const key = ymd(d);
      const cell = el('div', 'day');
      if (key === ymd(today)) cell.classList.add('today');
      else if (d < today) cell.classList.add('past');

      const label = i === 0 || d.getDate() === 1 ? `${d.toLocaleDateString(loc(), { month: 'short' })} ${d.getDate()}` : String(d.getDate());
      cell.append(el('div', 'num', label));

      const items = (byDay.get(key) || []).sort((a, b) => {
        if (a.ev.allDay !== b.ev.allDay) return a.ev.allDay ? -1 : 1;
        return new Date(a.ev.start) - new Date(b.ev.start) || a.ev.title.localeCompare(b.ev.title);
      });
      for (const { ev, first } of items.slice(0, max)) {
        const chip = el('div', ev.allDay ? 'ev allday' : 'ev');
        chip.style.setProperty('--c', ev.color);
        chip.style.setProperty('--fg-c', ev.textColor);
        if (!ev.allDay && first) chip.append(el('span', 't', fmtTime(new Date(ev.start))));
        chip.append(el('span', 'n', ev.title));
        cell.append(chip);
      }
      if (items.length > max) cell.append(el('div', 'more', `+${items.length - max} more`));
      grid.append(cell);
    }
  }

  function showNotice(id, msg) {
    const n = $(id);
    n.textContent = msg || '';
    n.hidden = !msg;
  }

  // A failed refresh keeps showing the last good data, but three failures in a row put the reason on screen.
  const fails = { cal: 0, tasks: 0, wx: 0 };

  async function loadCalendar() {
    const { start, end } = gridRange();
    try {
      const q = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
      calEvents = (await getJson(`/api/calendar?${q}`)).events;
      calLoaded = true;
      fails.cal = 0;
      showNotice('calNotice', '');
      renderCalendar();
      return true;
    } catch (err) {
      console.warn('calendar:', err.message);
      if (!calLoaded || ++fails.cal >= 3) showNotice('calNotice', err.message);
      renderCalendar();
      return false;
    }
  }

  // ---------- Tasks ----------
  function dueLabel(due) {
    const today = ymd(new Date());
    const tomorrow = ymd(addDays(new Date(), 1));
    const md = parseYmd(due).toLocaleDateString(loc(), { month: 'short', day: 'numeric' });
    if (due < today) return { text: `Overdue ${md}`, overdue: true };
    if (due === today) return { text: 'Due today', overdue: false };
    if (due === tomorrow) return { text: 'Due tomorrow', overdue: false };
    return { text: `Due ${md}`, overdue: false };
  }

  function renderTasks() {
    const cols = $('taskCols');
    cols.replaceChildren();
    let budget = CFG.tasks.maxItems;
    const multi = taskGroups.length > 1;
    for (const g of taskGroups) {
      if (budget <= 0) break;
      if (multi) cols.append(el('div', 'task-group', g.list));
      for (const t of g.items) {
        if (budget-- <= 0) break;
        const row = el('div', t.sub ? 'task sub' : 'task');
        row.append(el('span', 'box'));
        const txt = el('span', 'txt');
        txt.append(document.createTextNode(t.title));
        if (t.due) {
          const d = dueLabel(t.due);
          txt.append(el('span', d.overdue ? 'due overdue' : 'due', d.text));
        }
        row.append(txt);
        cols.append(row);
      }
    }
    if (!cols.children.length) cols.append(el('div', 'empty', 'All caught up'));
  }

  async function loadTasks() {
    try {
      taskGroups = (await getJson('/api/tasks')).groups;
      fails.tasks = 0;
      showNotice('taskNotice', '');
      renderTasks();
      return true;
    } catch (err) {
      console.warn('tasks:', err.message);
      if (!taskGroups || ++fails.tasks >= 3) showNotice('taskNotice', err.message);
      return false;
    }
  }

  // ---------- Weather ----------
  function renderWeather(w) {
    const now = $('now');
    now.replaceChildren();

    const meta = el('div', 'meta');
    const wind = el('div');
    wind.append(svgIcon('wind'), el('span', '', `${w.current.wind} ${w.windUnit} ${w.current.windDir}`));
    const sun = el('div');
    sun.append(svgIcon(w.sun.type), el('span', '', fmtClock(w.sun.time)));
    meta.append(wind, sun);

    const main = el('div', 'main');
    main.append(el('div', 'temp', `${w.current.temp}°`), weatherIcon(w.current.code, w.current.isDay));
    now.append(meta, main);

    const fc = $('forecast');
    fc.replaceChildren();
    w.days.forEach((day, i) => {
      const col = el('div', 'fday');
      const name = i === 0 ? 'Today' : parseYmd(day.date).toLocaleDateString(loc(), { weekday: 'short' });
      const pop = el('div', 'pop');
      pop.append(svgIcon('drop'), el('span', '', `${day.precip ?? 0}%`));
      const hl = el('div', 'hl');
      hl.append(el('span', 'hi', String(day.high)), el('span', 'lo', String(day.low)));
      col.append(el('div', 'lbl', name), weatherIcon(day.code, true), pop, hl);
      fc.append(col);
    });
  }

  let weatherLoaded = false;
  async function loadWeather() {
    try {
      renderWeather(await getJson('/api/weather'));
      weatherLoaded = true;
      fails.wx = 0;
      showNotice('wxNotice', '');
      return true;
    } catch (err) {
      console.warn('weather:', err.message);
      if (!weatherLoaded || ++fails.wx >= 3) showNotice('wxNotice', `Weather unavailable: ${err.message}`);
      return false;
    }
  }

  // ---------- Background photos ----------
  // Images come from the backgrounds folder on the Pi (managed from the dashboard). The list is re-read
  // on every change, so adding or deleting pictures needs no restart.
  const layers = [$('bgA'), $('bgB')];
  let front = 1; // layer currently on top
  let bgImages = [];
  let bgQueue = [];
  let currentBg = null;
  let seqName = null; // last picture tried in sequential order, even if it failed to load (so one bad file cannot stall the show)
  let bgTimer = null;
  let usingGradient = false;

  async function refreshBgList() {
    try {
      bgImages = (await getJson('/api/backgrounds')).images;
    } catch {
      /* keep the old list */
    }
  }

  function showGradient() {
    if (usingGradient) return;
    usingGradient = true;
    currentBg = null;
    layers[0].style.backgroundImage = 'radial-gradient(120% 70% at 50% 100%, #24435e 0%, #101c2b 55%, #080c14 100%)';
    layers[0].classList.add('show');
    layers[1].classList.remove('show');
    front = 0;
  }

  function pickNext() {
    if (!bgImages.length) return null;
    if (CFG.display.backgroundOrder === 'sequential') {
      const last = seqName || (currentBg && currentBg.name);
      const i = last ? bgImages.findIndex((x) => x.name === last) : -1;
      const item = bgImages[(i + 1) % bgImages.length];
      seqName = item.name;
      return item;
    }
    // Shuffle without showing the same picture twice in a row, and forget pictures that were deleted.
    bgQueue = bgQueue.filter((n) => bgImages.some((x) => x.name === n));
    if (!bgQueue.length) {
      bgQueue = bgImages.map((x) => x.name).sort(() => Math.random() - 0.5);
      if (bgQueue.length > 1 && currentBg && bgQueue[0] === currentBg.name) bgQueue.push(bgQueue.shift());
    }
    const name = bgQueue.shift();
    return bgImages.find((x) => x.name === name);
  }

  function displayImage(item) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const next = layers[front ^ 1];
        next.style.backgroundImage = `url("${item.url}")`;
        next.classList.add('show');
        layers[front].classList.remove('show');
        front ^= 1;
        currentBg = item;
        seqName = item.name;
        usingGradient = false;
        heartbeat(); // let the dashboard know right away which picture is showing
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = item.url;
    });
  }

  async function advance() {
    await refreshBgList();
    if (!bgImages.length) return showGradient();
    if (bgImages.length === 1 && currentBg && currentBg.name === bgImages[0].name) return;
    for (let tries = 0; tries < Math.min(bgImages.length, 5); tries++) {
      const item = pickNext();
      if (item && (await displayImage(item))) return;
    }
  }

  function scheduleRotation() {
    clearTimeout(bgTimer);
    const ms = Math.max(10, Number(CFG.display.backgroundIntervalSeconds) || 600) * 1000;
    bgTimer = setTimeout(async () => {
      await advance();
      scheduleRotation();
    }, ms);
  }

  async function startBackground() {
    document.documentElement.style.setProperty('--dim', String(CFG.display.backgroundDim));
    await advance();
    scheduleRotation();
  }

  // Until a source has loaded once, retry every 15 s (then 30, 60 s...) so the screen fills in soon after
  // the Pi's Wi-Fi comes up at boot, instead of waiting for the next scheduled refresh.
  function loadWithRetry(loader) {
    let delay = 15000;
    const attempt = async () => {
      if (await loader()) return;
      setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 60000);
    };
    attempt();
  }

  // A small, plain warning when a source is failing. Nothing shown when all is well.
  async function loadStatus() {
    try {
      const st = await getJson('/api/status');
      const problems = [];
      if (st.calendar && st.calendar.ok === false) problems.push(st.calendar.error || 'Calendar link not working');
      if (st.tasks && st.tasks.ok === false) problems.push(st.tasks.error || 'Todoist token rejected');
      $('warn').textContent = problems.join('. ');
    } catch {
      /* ignore */
    }
  }

  // ---------- Commands from the admin dashboard, and a heartbeat back to it ----------
  const PREVIEW = new URLSearchParams(location.search).get('preview') === '1';

  function connectEvents() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events' + (PREVIEW ? '?preview=1' : ''));
    const on = (name, fn) => es.addEventListener(name, (e) => fn(e.data ? JSON.parse(e.data) : {}));
    on('hello', (h) => {
      // The server restarted or settings changed while we were disconnected: start fresh.
      if (h.epoch !== CFG.epoch || h.version !== CFG.version) location.reload();
    });
    on('reload', () => location.reload());
    on('refresh', () => {
      loadCalendar();
      loadTasks();
      loadWeather();
      loadStatus();
    });
    on('next-bg', async () => {
      await advance();
      scheduleRotation();
    });
    on('show-bg', async (d) => {
      const item = bgImages.find((x) => x.url === d.url) || { name: decodeURIComponent((d.url || '').split('/').pop().split('?')[0]), url: d.url };
      if (await displayImage(item)) scheduleRotation();
    });
    on('backgrounds', async () => {
      const before = currentBg && currentBg.name;
      await refreshBgList();
      if (!bgImages.length || !before || !bgImages.some((x) => x.name === before)) await advance();
    });
  }

  function heartbeat() {
    if (PREVIEW) return;
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bg: currentBg ? currentBg.name : null, w: window.innerWidth, h: window.innerHeight, ver: CFG.version }),
    }).catch(() => {});
  }

  // ---------- Start ----------
  async function init() {
    CFG = await getJson('/api/config');
    $('tasksTitle').textContent = CFG.tasks.title;
    $('place').textContent = CFG.mock ? 'Sample data (mock mode)' : CFG.weather.label;
    tick();
    setInterval(tick, CFG.display.showSeconds ? 1000 : 5000);
    startBackground();
    document.body.classList.toggle('low-power', Boolean(CFG.display.lowPower));
    if (PREVIEW) document.body.classList.add('preview');
    renderCalendar();
    loadWithRetry(loadCalendar);
    loadWithRetry(loadTasks);
    loadWithRetry(loadWeather);
    loadStatus();
    setInterval(loadStatus, 5 * 60 * 1000);
    setInterval(loadCalendar, CFG.refresh.calendarMinutes * 60 * 1000);
    setInterval(loadTasks, CFG.refresh.tasksMinutes * 60 * 1000);
    setInterval(loadWeather, CFG.refresh.weatherMinutes * 60 * 1000);
    connectEvents();
    heartbeat();
    setInterval(heartbeat, 30 * 1000);
  }

  init().catch((err) => {
    document.body.style.cssText = 'color:#fff;font:3.4vw/1.4 system-ui,sans-serif;padding:6vw';
    document.body.textContent = err.forbidden
      ? 'A dashboard password is set. Open /admin on this device, sign in, then come back here.'
      : `Could not reach the dashboard server: ${err.message}. Retrying...`;
    setTimeout(() => location.reload(), 10000);
  });
})();
