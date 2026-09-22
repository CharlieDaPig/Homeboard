'use strict';
// Weather from Open-Meteo (free, no API key). https://open-meteo.com

function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

async function getWeather(cfg) {
  const w = cfg.weather;
  const imperial = w.units !== 'metric';
  const params = new URLSearchParams({
    latitude: w.latitude,
    longitude: w.longitude,
    current: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imperial ? 'mph' : 'kmh',
    timezone: 'auto',
    forecast_days: 5,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return shape(await res.json(), imperial);
}

// Turn the raw Open-Meteo payload into what the screen needs.
function shape(data, imperial) {
  const c = data.current;
  const d = data.daily;
  const days = d.time.map((date, i) => ({
    date, // local calendar date at the forecast location
    code: d.weather_code[i],
    high: Math.round(d.temperature_2m_max[i]),
    low: Math.round(d.temperature_2m_min[i]),
    precip: d.precipitation_probability_max[i],
  }));

  // Next sun event: sunrise if it hasn't happened yet, sunset if still day, otherwise tomorrow's sunrise.
  const today = d.time.indexOf(c.time.slice(0, 10));
  const i = today >= 0 ? today : 0;
  let sun;
  if (c.time < d.sunrise[i]) sun = { type: 'sunrise', time: d.sunrise[i].slice(11, 16) };
  else if (c.time < d.sunset[i]) sun = { type: 'sunset', time: d.sunset[i].slice(11, 16) };
  else if (d.sunrise[i + 1]) sun = { type: 'sunrise', time: d.sunrise[i + 1].slice(11, 16) };
  else sun = { type: 'sunset', time: d.sunset[i].slice(11, 16) };

  return {
    current: {
      temp: Math.round(c.temperature_2m),
      code: c.weather_code,
      isDay: Boolean(c.is_day),
      wind: Math.round(c.wind_speed_10m),
      windDir: compass(c.wind_direction_10m),
    },
    windUnit: imperial ? 'mph' : 'km/h',
    sun,
    days,
  };
}

module.exports = { getWeather, shape };
