'use strict';
// One place that fetches calendar, tasks and weather, with caching, so the screen and the dashboard share results.
const { Cache } = require('./cache');
const { track } = require('./state');
const { getWeather } = require('./weather');
const mock = require('./mock');

const MIN = 60 * 1000;

function createData({ settings, calendars, todoist }) {
  const cache = new Cache();
  const cfg = () => settings.effective();
  const isMock = () => cfg().mock;

  return {
    cache,

    calendar(startIso, endIso) {
      if (isMock()) return Promise.resolve(mock.mockEvents());
      const c = cfg();
      const key = `cal:${startIso}:${endIso}:${calendars.sources.map((s) => s.id).join(',')}`;
      return cache.get(key, c.refresh.calendarMinutes * MIN, () =>
        track('calendar', () => calendars.getCalendarEvents(startIso, endIso), (v) => ({ count: v.events.length }))
      );
    },

    tasks() {
      if (isMock()) return Promise.resolve(mock.mockTasks());
      const c = cfg();
      const key = `tasks:${JSON.stringify(c.tasks.lists)}`;
      return cache.get(key, c.refresh.tasksMinutes * MIN, () =>
        track('tasks', () => todoist.getTasks(c), (v) => ({ count: v.groups.reduce((n, g) => n + g.items.length, 0) }))
      );
    },

    weather() {
      if (isMock()) return Promise.resolve(mock.mockWeather());
      const c = cfg();
      const key = `weather:${c.weather.latitude}:${c.weather.longitude}:${c.weather.units}`;
      return cache.get(key, c.refresh.weatherMinutes * MIN, () =>
        track('weather', () => getWeather(c), (v) => ({ temp: v.current.temp, units: c.weather.units }))
      );
    },

    // Forget everything so the next request fetches fresh data.
    clear() {
      cache.map.clear();
    },

    // The last weather reading we have, without fetching.
    lastWeather() {
      if (isMock()) return mock.mockWeather();
      const c = cfg();
      const hit = cache.map.get(`weather:${c.weather.latitude}:${c.weather.longitude}:${c.weather.units}`);
      return hit ? hit.value : null;
    },
  };
}

module.exports = { createData };
