'use strict';
// Tests for lib/todoist.js against tests/fake_todoist_server.js (no real Todoist account involved).
// Run with:  node tests/todoist_test.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startFakeTodoist } = require('./fake_todoist_server');

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL - ${name}\n  ${err.stack || err.message}`);
  }
}

const tmpFile = () => path.join(os.tmpdir(), `homeboard-todoist-test-${Math.random().toString(36).slice(2)}.json`);

async function main() {
  const fake = await startFakeTodoist({
    token: 'good-token',
    projects: [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }, { id: 'p3', name: 'Empty Project' }],
    tasksByProject: {
      p1: [
        { id: 't1', content: 'Buy milk', parent_id: null, order: 2, due: { date: '2026-03-15' } },
        { id: 't2', content: 'Call plumber', parent_id: null, order: 1, due: null },
        { id: 't3', content: 'Pick a faucet', parent_id: 't2', order: 1, due: { date: '2026-03-10T10:00:00' } },
        { id: 't4', content: '   ', parent_id: null, order: 3, due: null }, // blank title: must be skipped
      ],
      p2: [{ id: 't5', content: 'Ship the report', parent_id: null, order: 1, due: { date: '2026-03-20' } }],
      p3: [],
    },
    pageSize: 2, // force pagination to actually exercise the cursor
  });
  process.env.TODOIST_BASE = fake.url;
  delete require.cache[require.resolve('../homeboard/lib/todoist.js')];
  const { Todoist } = require('../homeboard/lib/todoist.js');

  await test('no token: throws SetupNeeded-flavoured error', async () => {
    const t = new Todoist(tmpFile());
    await assert.rejects(() => t.listProjects(), /No Todoist token/);
  });

  await test('saveToken persists and info() never returns the full token', async () => {
    const file = tmpFile();
    const t = new Todoist(file);
    t.saveToken('  abc123def456  ');
    assert.strictEqual(t.token, 'abc123def456');
    const info = t.info();
    assert.strictEqual(info.set, true);
    assert.ok(!info.tokenShown.includes('abc123def456'));
    assert.ok(info.tokenShown.endsWith('f456'));
    const reloaded = new Todoist(file);
    assert.strictEqual(reloaded.token, 'abc123def456');
  });

  await test('wrong token is rejected with a plain-language message', async () => {
    const t = new Todoist(tmpFile());
    t.token = 'wrong-token';
    await assert.rejects(() => t.listProjects(), /did not accept that token/);
  });

  await test('listProjects pages through the cursor and returns every project', async () => {
    const t = new Todoist(tmpFile());
    t.token = 'good-token';
    const projects = await t.listProjects();
    assert.deepStrictEqual(projects.map((p) => p.name).sort(), ['Empty Project', 'Home', 'Work']);
  });

  await test('getTasks: subtasks nest under their parent, blank titles skipped, empty projects dropped, due is date-only', async () => {
    const t = new Todoist(tmpFile());
    t.token = 'good-token';
    const { groups } = await t.getTasks({ tasks: { lists: [] } });
    assert.strictEqual(groups.length, 2); // Empty Project has no open tasks left, so it is left out
    const home = groups.find((g) => g.list === 'Home');
    assert.deepStrictEqual(home.items.map((i) => i.title), ['Call plumber', 'Pick a faucet', 'Buy milk']);
    assert.strictEqual(home.items[0].sub, false);
    assert.strictEqual(home.items[1].sub, true); // directly under its parent
    assert.strictEqual(home.items[2].due, '2026-03-15');
    assert.strictEqual(home.items[1].due, '2026-03-10'); // time part dropped
  });

  await test('getTasks: an empty tasks.lists filter means every project; a named filter narrows it', async () => {
    const t = new Todoist(tmpFile());
    t.token = 'good-token';
    const filtered = await t.getTasks({ tasks: { lists: ['work'] } }); // case-insensitive
    assert.strictEqual(filtered.groups.length, 1);
    assert.strictEqual(filtered.groups[0].list, 'Work');
  });

  await test('a 429 is reported plainly (the cache layer is what keeps old data, not this class)', async () => {
    const busy = await startFakeTodoist({ mode: '429' });
    process.env.TODOIST_BASE = busy.url;
    delete require.cache[require.resolve('../homeboard/lib/todoist.js')];
    const { Todoist: T2 } = require('../homeboard/lib/todoist.js');
    const t = new T2(tmpFile());
    t.token = 'anything';
    await assert.rejects(() => t.listProjects(), /slow down|rate/i);
    await busy.close();
  });

  await fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main();
