import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { titleFromRow, CodexTitles } from '../src/codex-titles.js';

test('titleFromRow: prefers the short name, then a trimmed first prompt, else null', () => {
  assert.equal(titleFromRow({ name: 'Inspect repo structure', first_user_message: 'long…' }), 'Inspect repo structure');
  assert.equal(titleFromRow({ name: '', first_user_message: 'Check   this\nrepo' }), 'Check this repo');
  assert.equal(titleFromRow({ name: null, first_user_message: '', title: 'From title' }), 'From title');
  assert.equal(titleFromRow({ name: '', first_user_message: '' }), null);
  assert.equal(titleFromRow(null), null);
});

test('titleFromRow: strips attachment preamble and /goal, truncates long prompts', () => {
  const pre = '# Files mentioned by the user:\n\n## Notes\n\nDistinguish.\n\n## My request:\nCheck this repo';
  assert.equal(titleFromRow({ first_user_message: pre }), 'Check this repo');
  assert.equal(titleFromRow({ first_user_message: '/goal reverse engineer the bots' }), 'reverse engineer the bots');
  const long = titleFromRow({ first_user_message: 'a'.repeat(100) });
  assert.equal(long.length, 58);
  assert.ok(long.endsWith('…'));
});

async function makeDb(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT)`);
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?)');
  ins.run('t1', 'Inspect repo structure', 'x', 'y');
  ins.run('t2', null, '', 'Reverse engineer how the bots work under the hood');
  ins.run('t3', null, '', '');
  db.close();
  return path;
}

test('CodexTitles: reads names/prompts for the asked ids, caches, ignores unknown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-titles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = await makeDb(dir);
  const titles = new CodexTitles({ path });
  await titles.refresh(['t1', 't2', 't3', 'missing']);
  assert.equal(titles.get('t1'), 'Inspect repo structure');
  assert.equal(titles.get('t2'), 'Reverse engineer how the bots work under the hood');
  assert.equal(titles.get('t3'), null);
  assert.equal(titles.get('missing'), null);
  titles.close();
});

test('CodexTitles: empty id list is a no-op; opener failure degrades to no titles', async () => {
  const titles = new CodexTitles({ path: '/nonexistent/db', open: async () => null });
  await titles.refresh([]);
  await titles.refresh(['t1']);
  assert.equal(titles.get('t1'), null);
  titles.close();
});

test('CodexTitles: a throwing DB is tolerated and retried later', async () => {
  let calls = 0;
  const bad = { prepare() { calls++; throw new Error('locked'); }, close() {} };
  const titles = new CodexTitles({ path: 'x', open: async () => bad });
  await titles.refresh(['t1']);
  await titles.refresh(['t1']);
  assert.equal(calls, 2);
  assert.equal(titles.get('t1'), null);
});
