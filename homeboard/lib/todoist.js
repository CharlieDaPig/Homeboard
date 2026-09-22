'use strict';
// A small Todoist REST client using only Node built-ins. No OAuth: the user pastes a personal API token.
// Endpoints and shapes follow https://developer.todoist.com/api/v1/ (checked September 2026): a unified
// v1 API at https://api.todoist.com/api/v1/, Bearer token auth, cursor pagination via ?cursor=&limit=,
// { results, next_cursor }, and GET /tasks already returning only active (uncompleted) tasks.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { SetupNeeded } = require('./errors');

const FILE = path.join(DATA_DIR, 'todoist.json');
const BASE = process.env.TODOIST_BASE || 'https://api.todoist.com/api/v1'; // overridable so tests can point at a fake server
const REJECTED = 'Todoist did not accept that token, copy it again from Todoist → Settings → Integrations → Developer';

function shorten(token) {
  return `token ending …${String(token).slice(-5)}`;
}

class Todoist {
  constructor(file = FILE) {
    this.file = file;
    this.token = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && typeof saved.token === 'string' && saved.token) this.token = saved.token;
    } catch {
      /* not set up yet */
    }
  }

  info() {
    return { set: Boolean(this.token), tokenShown: this.token ? shorten(this.token) : null };
  }

  saveToken(token) {
    const t = String(token || '').trim();
    if (!t) throw new Error('Paste your Todoist API token first.');
    if (t.length > 200 || /\s/.test(t)) throw new Error('That does not look like a Todoist API token.');
    this.token = t;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ token: t }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* not fatal */
    }
  }

  removeToken() {
    this.token = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
  }

  // One page. path: 'tasks' | 'projects'. Throws a plain-language Error on any problem.
  async apiPage(pathName, params = {}) {
    if (!this.token) throw new SetupNeeded('No Todoist token has been added yet.');
    const url = new URL(`${BASE}/${pathName}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'Todoist did not answer in time.' : `Could not reach Todoist (${err.message}).`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(REJECTED);
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      throw new Error(`Todoist is asking us to slow down${retryAfter ? ` (retry after ${retryAfter}s)` : ''}; showing the last good list.`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Todoist error (HTTP ${res.status})${body && body.error ? `: ${body.error}` : ''}`);
    }
    return res.json();
  }

  async listAll(pathName, params = {}) {
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const data = await this.apiPage(pathName, { ...params, cursor, limit: 200 });
      out.push(...(data.results || []));
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async listProjects() {
    const projects = await this.listAll('projects');
    return projects.map((p) => ({ id: p.id, name: p.name }));
  }

  // { groups } for the screen, using cfg.tasks.lists as an (optional) list of project names to show.
  async getTasks(cfg) {
    const wanted = (cfg.tasks.lists || []).map((s) => String(s).toLowerCase());
    const projects = await this.listProjects();
    const chosen = wanted.length ? projects.filter((p) => wanted.includes(p.name.toLowerCase())) : projects;

    const groups = await Promise.all(
      chosen.map(async (project) => {
        const tasks = await this.listAll('tasks', { project_id: project.id });
        const open = tasks.filter((t) => (t.content || '').trim());
        const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
        const ids = new Set(open.map((t) => t.id));
        const tops = open.filter((t) => !t.parent_id || !ids.has(t.parent_id)).sort(byOrder);
        const items = [];
        for (const t of tops) {
          items.push(t);
          items.push(...open.filter((c) => c.parent_id === t.id).sort(byOrder));
        }
        const shaped = items.map((t) => ({
          id: t.id,
          title: t.content.trim(),
          due: t.due && t.due.date ? String(t.due.date).slice(0, 10) : null,
          sub: Boolean(t.parent_id) && ids.has(t.parent_id),
        }));
        return { list: project.name, items: shaped };
      })
    );
    return { groups: groups.filter((g) => g.items.length) };
  }

  async test(cfg) {
    const projects = await this.listProjects();
    const { groups } = await this.getTasks(cfg);
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    return `Todoist: found ${count} open task${count === 1 ? '' : 's'} in ${groups.length} project${groups.length === 1 ? '' : 's'} (of ${projects.length} total)`;
  }
}

module.exports = { Todoist, REJECTED };
