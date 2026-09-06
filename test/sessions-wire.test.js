import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, compactSession } from '../src/live.js';
import { readOmpTerminalSessions, OmpLiveState } from '../src/omp-usage.js';
import { createLiveState } from '../src/live-usage.js';
import { parseProcessTable } from '../src/claude-sessions.js';

const NOW = new Date('2026-09-06T12:00:00Z');
const claudeState = (over = {}) => ({
  summary: {}, today: 0, daily: [], perMinute: 0, perFiveMinutes: 0, ...over,
});

test('buildSnapshot: claude.sessions passes the registry list through untouched', () => {
  const sessions = [
    { id: 'a', label: 'Widget work', kind: 'bg', state: 'running', url: 'https://claude.ai/code/session_1', cwd: '/w' },
    { id: 'b', label: 'html-b8', kind: 'interactive', state: 'idle', tty: 'ttys005', app: '/Applications/Warp.app' },
  ];
  const snap = buildSnapshot({ now: NOW, claude: claudeState({ sessions }) });
  assert.deepEqual(snap.claude.sessions, sessions);
});

test('buildSnapshot: empty or absent claude.sessions is omitted', () => {
  assert.ok(!('sessions' in buildSnapshot({ now: NOW, claude: claudeState({ sessions: [] }) }).claude));
  assert.ok(!('sessions' in buildSnapshot({ now: NOW, claude: claudeState() }).claude));
});

const rawCodex = (over = {}) => ({
  id: '01a07685-0494-7421-b767-22080ea976be', source: 'vscode', cwd: '/Users/x/proj', model: 'gpt-5.6-sol',
  originator: 'Codex Desktop', turnState: 'idle', ctxUsedPercent: 31, total: { total_tokens: 1000 },
  last: { total_tokens: 100 }, tokensPerMin: 0, lastEventAgeSec: 90, ...over,
});

test('compactSession: carries originator and a title from the lookup when known', () => {
  const s = compactSession(rawCodex(), NOW, { titleOf: (id) => (id.startsWith('01a07685') ? 'Reverse engineer Grok bots' : null) });
  assert.equal(s.title, 'Reverse engineer Grok bots');
  assert.equal(s.originator, 'Codex Desktop');
  assert.equal(s.label, 'proj');
  const untitled = compactSession(rawCodex(), NOW, { titleOf: () => null });
  assert.ok(!('title' in untitled));
  const noLookup = compactSession(rawCodex(), NOW);
  assert.ok(!('title' in noLookup));
});

test('buildSnapshot: codexTitle lookup is applied to every codex session', () => {
  const snap = buildSnapshot({
    now: NOW,
    codex: { today: 1, summary: {} },
    codexSessions: [rawCodex(), rawCodex({ id: 'other' })],
    codexTitle: (id) => (id === 'other' ? 'Second' : null),
  });
  assert.equal(snap.codex.sessions[0].title, undefined);
  assert.equal(snap.codex.sessions[1].title, 'Second');
});

test('readOmpTerminalSessions: maps session file path -> tty, ignoring non-tty names', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-tty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ts = join(dir, 'agent', 'terminal-sessions');
  await mkdir(ts, { recursive: true });
  await writeFile(join(ts, 'ttys004'), '/Users/x/widget\n/Users/x/.omp/agent/sessions/-widget/2026_abc.jsonl\n');
  await writeFile(join(ts, 'ttys009'), '/Users/x/x\n/Users/x/.omp/agent/sessions/-x/2026_def.jsonl\nfresh\n');
  await writeFile(join(ts, 'README'), 'not a tty');
  const m = await readOmpTerminalSessions(dir);
  assert.equal(m.get('/Users/x/.omp/agent/sessions/-widget/2026_abc.jsonl'), 'ttys004');
  assert.equal(m.get('/Users/x/.omp/agent/sessions/-x/2026_def.jsonl'), 'ttys009');
  assert.equal(m.size, 2);
  assert.equal((await readOmpTerminalSessions('/nonexistent')).size, 0);
});

test('OmpLiveState.sessions: carries the session file path and its tty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sdir = join(dir, 'agent', 'sessions', '-proj');
  await mkdir(sdir, { recursive: true });
  const file = join(sdir, '2026-09-06T11-00-00-000Z_0123abcd-1111-2222-3333-444444444444.jsonl');
  const lines = [
    { type: 'session', version: 3, id: '0123abcd-1111-2222-3333-444444444444', timestamp: '2026-09-06T11:00:00.000Z', cwd: '/Users/x/proj' },
    { type: 'message', id: 'u1', timestamp: '2026-09-06T11:59:00.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'message', id: 'a1', timestamp: '2026-09-06T11:59:30.000Z', message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-fable-5', stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, responseId: 'r1' } },
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ts = join(dir, 'agent', 'terminal-sessions');
  await mkdir(ts, { recursive: true });
  await writeFile(join(ts, 'ttys007'), `/Users/x/proj\n${file}\n`);
  const st = new OmpLiveState({ ompDir: dir, now: () => NOW });
  await st.scan();
  const [s] = st.sessions(NOW);
  assert.equal(s.id, '0123abcd-1111-2222-3333-444444444444');
  assert.equal(s.path, file);
  assert.equal(s.tty, 'ttys007');
  assert.equal(s.state, 'idle');
});


test('createLiveState: OMP sessions get the hosting app of the omp process on their pty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sdir = join(dir, 'agent', 'sessions', '-proj');
  await mkdir(sdir, { recursive: true });
  const file = join(sdir, '2026-09-06T11-00-00-000Z_0123abcd-1111-2222-3333-444444444444.jsonl');
  await writeFile(file, [
    { type: 'session', version: 3, id: '0123abcd-1111-2222-3333-444444444444', timestamp: '2026-09-06T11:00:00.000Z', cwd: '/Users/x/proj' },
    { type: 'message', id: 'u1', timestamp: '2026-09-06T11:59:00.000Z', message: { role: 'user', content: 'hi' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ts = join(dir, 'agent', 'terminal-sessions');
  await mkdir(ts, { recursive: true });
  await writeFile(join(ts, 'ttys007'), `/Users/x/proj\n${file}\n`);
  const table = parseProcessTable(`
 6721     1 ??       /Applications/Warp.app/Contents/MacOS/stable
 6724  6721 ??       /Applications/Warp.app/Contents/MacOS/stable
 8001  6724 ttys007  -zsh
 8002  8001 ttys007  /opt/homebrew/bin/omp
`);
  const state = createLiveState({
    claudeDir: '/nonexistent', omp: true, ompDir: dir, claudeSessions: false,
    now: () => NOW, readTable: async () => table,
  });
  await state.scanClaude();
  const [s] = state.claudeFrame().omp.sessions;
  assert.equal(s.tty, 'ttys007');
  assert.equal(s.app, '/Applications/Warp.app');
  assert.equal(s.state, 'running');
});

test('createLiveState: an OMP session whose omp process exited keeps its tty but gets no app', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-noapp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sdir = join(dir, 'agent', 'sessions', '-proj');
  await mkdir(sdir, { recursive: true });
  const file = join(sdir, '2026-09-06T11-00-00-000Z_0123abcd-1111-2222-3333-444444444444.jsonl');
  await writeFile(file, JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-09-06T11:59:00.000Z', message: { role: 'user', content: 'hi' } }) + '\n');
  const ts = join(dir, 'agent', 'terminal-sessions');
  await mkdir(ts, { recursive: true });
  await writeFile(join(ts, 'ttys007'), `/Users/x/proj\n${file}\n`);
  const state = createLiveState({
    claudeDir: '/nonexistent', omp: true, ompDir: dir, claudeSessions: false,
    now: () => NOW, readTable: async () => new Map(),
  });
  await state.scanClaude();
  const [s] = state.claudeFrame().omp.sessions;
  assert.equal(s.tty, 'ttys007');
  assert.ok(!('app' in s));
});
