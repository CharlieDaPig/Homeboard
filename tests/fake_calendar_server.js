'use strict';
// A tiny HTTP server that hands back canned .ics text, for tests/calendars_test.js.
const http = require('http');

// feeds: { [urlPath]: icsText | () => icsText }
function startFakeCalendarServer(feeds) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const feed = feeds[url.pathname];
    if (feed === undefined) {
      res.writeHead(404);
      return res.end('not found');
    }
    const text = typeof feed === 'function' ? feed() : feed;
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
    res.end(text);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

module.exports = { startFakeCalendarServer };
