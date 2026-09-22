'use strict';
// Fake data so you can preview the layout without a calendar link, Todoist token or internet:  npm run mock
const { shape } = require('./weather');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const at = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).toISOString();

function mockEvents() {
  const t = new Date();
  const sunday = addDays(t, -t.getDay());
  const blue = { color: '#4285f4', textColor: '#ffffff', calendar: 'Personal' };
  const green = { color: '#33b679', textColor: '#000000', calendar: 'Work' };
  const red = { color: '#d50000', textColor: '#ffffff', calendar: 'Family' };
  const gold = { color: '#f6bf26', textColor: '#000000', calendar: 'Birthdays' };
  let n = 0;
  const ev = (o, base) => ({ id: `mock${n++}`, ...base, ...o });
  return {
    events: [
      ev({ title: 'Team standup', allDay: false, start: at(t, 9, 30), end: at(t, 10) }, blue),
      ev({ title: 'Dentist', allDay: false, start: at(t, 15), end: at(t, 16) }, red),
      ev({ title: 'Dinner with Sam', allDay: false, start: at(t, 18, 30), end: at(t, 20) }, blue),
      ev({ title: 'Design review', allDay: false, start: at(addDays(t, 1), 11), end: at(addDays(t, 1), 12) }, green),
      ev({ title: 'Trash day', allDay: true, start: ymd(addDays(t, 2)), end: ymd(addDays(t, 3)) }, gold),
      ev({ title: 'Conference', allDay: true, start: ymd(addDays(sunday, 8)), end: ymd(addDays(sunday, 11)) }, green),
      ev({ title: 'Load-in', allDay: false, start: at(addDays(sunday, 9), 8), end: at(addDays(sunday, 9), 12) }, blue),
      ev({ title: 'Rehearsal', allDay: false, start: at(addDays(sunday, 9), 19), end: at(addDays(sunday, 9), 22) }, blue),
      ev({ title: 'Call with landlord', allDay: false, start: at(addDays(sunday, 9), 13, 15), end: at(addDays(sunday, 9), 13, 45) }, red),
      ev({ title: 'Gym', allDay: false, start: at(addDays(sunday, 9), 6), end: at(addDays(sunday, 9), 7) }, red),
      ev({ title: 'Opening night', allDay: false, start: at(addDays(sunday, 12), 19, 30), end: at(addDays(sunday, 12), 22) }, blue),
      ev({ title: "Mom's birthday", allDay: true, start: ymd(addDays(sunday, 16)), end: ymd(addDays(sunday, 17)) }, gold),
      ev({ title: 'Pay rent', allDay: true, start: ymd(addDays(sunday, 19)), end: ymd(addDays(sunday, 20)) }, red),
      ev({ title: 'Flight to Denver', allDay: false, start: at(addDays(sunday, 23), 7, 5), end: at(addDays(sunday, 23), 10) }, blue),
      ev({ title: 'Book club', allDay: false, start: at(addDays(sunday, 25), 19), end: at(addDays(sunday, 25), 21) }, green),
      ev({ title: 'Oil change', allDay: false, start: at(addDays(sunday, 29), 10), end: at(addDays(sunday, 29), 11) }, red),
    ],
  };
}

function mockTasks() {
  const t = new Date();
  return {
    groups: [
      {
        list: 'My Tasks',
        items: [
          { id: '1', title: 'Order replacement bulbs', due: ymd(addDays(t, -1)), sub: false },
          { id: '2', title: 'Renew car registration', due: ymd(addDays(t, 3)), sub: false },
          { id: '3', title: 'Email the venue about power access', due: null, sub: false },
          { id: '4', title: 'Print the show schedule', due: null, sub: true },
          { id: '5', title: 'Call the plumber', due: ymd(addDays(t, 6)), sub: false },
          { id: '6', title: 'Buy groceries', due: null, sub: false },
          { id: '7', title: 'Back up the photo library', due: null, sub: false },
        ],
      },
    ],
  };
}

function mockWeather() {
  const t = new Date();
  const days = [];
  const codes = [1, 2, 3, 61, 95];
  for (let i = 0; i < 5; i++) {
    days.push({ date: ymd(addDays(t, i)), code: codes[i], high: 96 - i * 3, low: 75 - i, precip: [0, 0, 14, 60, 35][i] });
  }
  const iso = (d, h, m) => `${ymd(d)}T${pad(h)}:${pad(m)}`;
  return shape(
    {
      current: { time: iso(t, 13, 0), temperature_2m: 81.4, weather_code: 2, wind_speed_10m: 10.2, wind_direction_10m: 180, is_day: 1 },
      daily: {
        time: days.map((d) => d.date),
        weather_code: days.map((d) => d.code),
        temperature_2m_max: days.map((d) => d.high),
        temperature_2m_min: days.map((d) => d.low),
        precipitation_probability_max: days.map((d) => d.precip),
        sunrise: days.map((d) => `${d.date}T06:52`),
        sunset: days.map((d) => `${d.date}T19:15`),
      },
    },
    true
  );
}

module.exports = { mockEvents, mockTasks, mockWeather };
