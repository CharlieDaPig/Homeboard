'use strict';
// Outline weather icons (24x24 grid, drawn with strokes so they inherit text colour).
// Shapes follow the open Feather icon style. All markup here is static, never user data.
(function () {
  const CLOUD = 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z';
  const CLOUD_HIGH = 'M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25';
  const SUN =
    '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';

  const ICONS = {
    sun: SUN,
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    'partly-day':
      '<circle cx="8" cy="8" r="3.2"/><path d="M8 1.6v1.4M2.4 8H1M3.9 3.9l1 1M12.1 3.9l-1 1M14 8h1.4"/>' +
      '<path d="M20 20h-9.5a4.4 4.4 0 0 1-.6-8.75A6 6 0 0 1 21.4 13.6 3.2 3.2 0 0 1 20 20z"/>',
    'partly-night':
      '<path d="M10.5 3.2A5.2 5.2 0 0 0 4 9.6a5.2 5.2 0 0 0 4.4 4.9"/><path d="M6.2 3.4a5.2 5.2 0 0 0 .2 4.7"/>' +
      '<path d="M20 20h-9.5a4.4 4.4 0 0 1-.6-8.75A6 6 0 0 1 21.4 13.6 3.2 3.2 0 0 1 20 20z"/>',
    cloud: `<path d="${CLOUD}"/>`,
    fog: '<path d="M18 9h-1.26A8 8 0 1 0 6 14.5"/><path d="M3 17h18M6 21h12"/>',
    drizzle: `<path d="M8 19v2M8 13v2M16 19v2M16 13v2M12 21v2M12 15v2"/><path d="${CLOUD_HIGH}"/>`,
    rain: `<path d="M16 13v8M8 13v8M12 15v8"/><path d="${CLOUD_HIGH}"/>`,
    snow: '<path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/><path d="M8 16h.01M8 20h.01M12 18h.01M12 22h.01M16 16h.01M16 20h.01"/>',
    thunder: '<path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"/><path d="M13 11l-4 6h6l-4 6"/>',
    wind: '<path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/>',
    sunrise: '<path d="M17 18a5 5 0 0 0-10 0M12 2v7M4.22 10.22l1.42 1.42M1 18h2M21 18h2M18.36 11.64l1.42-1.42M23 22H1M8 6l4-4 4 4"/>',
    sunset: '<path d="M17 18a5 5 0 0 0-10 0M12 9v-7M4.22 10.22l1.42 1.42M1 18h2M21 18h2M18.36 11.64l1.42-1.42M23 22H1M16 5l-4 4-4-4"/>',
    drop: '<path d="M12 2.7l5.7 5.7a8 8 0 1 1-11.4 0z"/>',
  };

  // WMO weather codes as used by Open-Meteo.
  function nameForCode(code, isDay = true) {
    if (code === 0 || code === 1) return isDay ? 'sun' : 'moon';
    if (code === 2) return isDay ? 'partly-day' : 'partly-night';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloud';
  }

  window.svgIcon = function (name, className) {
    const span = document.createElement('span');
    span.className = 'icon ' + (className || '');
    span.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || ICONS.cloud) +
      '</svg>';
    return span;
  };
  window.weatherIcon = (code, isDay, className) => window.svgIcon(nameForCode(code, isDay), className);
})();
