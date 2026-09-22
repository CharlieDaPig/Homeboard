'use strict';
// Asks for your city, looks up its coordinates (Open-Meteo geocoding) and saves them to config.json.
// Usage: node deploy/set-location.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');

function readConfig() {
  const file = fs.existsSync(CONFIG) ? CONFIG : EXAMPLE;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function search(name) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name, count: '8', language: 'en', format: 'json' });
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  return (await res.json()).results || [];
}

const describe = (r) => [r.name, r.admin1, r.country].filter(Boolean).join(', ');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Read answers one line at a time (also works when the answers are piped in).
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const { value, done } = await lines.next();
    if (done) process.stdout.write('\n');
    return done ? '' : String(value).trim();
  };
  try {
    let results = [];
    while (!results.length) {
      const typed = await ask('Your city (for the weather), e.g. Dallas (blank to skip): ');
      if (!typed) return console.log('Skipped. You can set your city later on the Weather tab of the dashboard.');
      // The service matches on the place name only, so drop anything after a comma ("Dallas, TX" -> "Dallas").
      try {
        results = await search(typed.split(',')[0].trim());
      } catch (err) {
        console.log(`Could not look that up (${err.message}). Check the internet connection and try again.`);
        continue;
      }
      if (!results.length) console.log('No match. Try just the city name.');
    }
    results.forEach((r, i) => console.log(`  ${i + 1}) ${describe(r)}`));
    const pick = Number(await ask(`Which one? [1-${results.length}, default 1]: `) || 1);
    const chosen = results[pick - 1] || results[0];

    const units = (await ask('Units: 1) Fahrenheit and mph  2) Celsius and km/h [default 1]: ')) === '2' ? 'metric' : 'imperial';

    const cfg = readConfig();
    cfg.weather = { ...cfg.weather, latitude: chosen.latitude, longitude: chosen.longitude, units, label: describe(chosen), confirmed: true };
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`Saved: ${describe(chosen)} (${chosen.latitude}, ${chosen.longitude}), ${units}.`);
    // A location saved earlier from the dashboard would override config.json, so drop it: this choice should win.
    const overrides = path.join(ROOT, 'data', 'settings.json');
    try {
      const saved = JSON.parse(fs.readFileSync(overrides, 'utf8'));
      if (saved.weather) {
        for (const k of ['latitude', 'longitude', 'units', 'label']) delete saved.weather[k];
        if (!Object.keys(saved.weather).length) delete saved.weather;
        fs.writeFileSync(overrides, JSON.stringify(saved, null, 2), { mode: 0o600 });
      }
    } catch {
      /* no dashboard settings yet */
    }
    if (!process.env.HOMEBOARD_INSTALLER) console.log('If the server is running, restart it to apply this:  sudo systemctl restart homeboard');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
