'use strict';
// A tiny stand-in for api.todoist.com, for tests/todoist_test.js. Not a general-purpose fake: just enough
// of GET /projects and GET /tasks (cursor pagination, project_id filter, auth) to exercise lib/todoist.js.
const http = require('http');

// projects: [{id,name}]; tasksByProject: { [projectId]: [task, ...] } (task shape matches the real API).
function startFakeTodoist({ token = 'good-token', projects = [], tasksByProject = {}, pageSize = 200, mode = 'normal' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization || '';
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (mode === '429') return send(429, { error: 'rate_limited' });
    if (auth !== `Bearer ${token}`) return send(401, { error_tag: 'UNAUTHORIZED', error_code: 477 });

    const cursor = url.searchParams.get('cursor');
    const page = (all) => {
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return { results: slice, next_cursor: next };
    };

    if (url.pathname === '/api/v1/projects') return send(200, page(projects));
    if (url.pathname === '/api/v1/tasks') {
      const projectId = url.searchParams.get('project_id');
      const all = projectId ? tasksByProject[projectId] || [] : Object.values(tasksByProject).flat();
      return send(200, page(all));
    }
    send(404, { error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/api/v1`, close: () => server.close() });
    });
  });
}

module.exports = { startFakeTodoist };
