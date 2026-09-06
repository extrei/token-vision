import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProcessTable,
  appBundleOf,
  owningApp,
  appForTTY,
  spawnTTY,
  attachParkedTerminals,
  sessionFromRegistry,
  sortSessions,
  ClaudeSessionRegistry,
  CLAUDE_WEB_SESSION_BASE,
} from '../src/claude-sessions.js';

const PS = `
 6721     1 ??       /Applications/Warp.app/Contents/MacOS/stable
 6724  6721 ??       /Applications/Warp.app/Contents/MacOS/stable
62620  6724 ttys005  -zsh
63641 62620 ttys005  claude
41412     1 ??       /Users/osika/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
70001  6724 ttys004  -zsh
70002 70001 ttys004  /opt/homebrew/Cellar/omp/18.1.2/bin/omp
41449 41412 ttys013  /Users/osika/.local/share/claude/versions/2.1.260
27952     1 ??       claude bg-pty-host
27957 27952 ttys003  claude
64256 63641 ??       /Users/osika/.local/bin/claude
64282 64256 ??       claude bg-pty-host
64287 64282 ttys006  claude bg-spare
`;

test('parseProcessTable: pid -> {ppid, tty, comm}; "??" tty becomes null', () => {
  const t = parseProcessTable(PS);
  assert.deepEqual(t.get(63641), { ppid: 62620, tty: 'ttys005', comm: 'claude' });
  assert.deepEqual(t.get(6721), { ppid: 1, tty: null, comm: '/Applications/Warp.app/Contents/MacOS/stable' });
  assert.equal(t.get(999), undefined);
});

test('appBundleOf: extracts the .app bundle from an executable path', () => {
  assert.equal(appBundleOf('/Applications/Warp.app/Contents/MacOS/stable'), '/Applications/Warp.app');
  assert.equal(appBundleOf('/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude'),
    '/Users/x/.local/share/claude/ClaudeCode.app');
  assert.equal(appBundleOf('claude'), null);
  assert.equal(appBundleOf(null), null);
});

test('owningApp: walks the parent chain to the hosting GUI app; null when none', () => {
  const t = parseProcessTable(PS);
  assert.equal(owningApp(63641, t), '/Applications/Warp.app'); // claude -> zsh -> warp server -> Warp
  assert.equal(owningApp(41449, t), '/Users/osika/.local/share/claude/ClaudeCode.app');
  assert.equal(owningApp(27957, t), null); // bg-pty-host is not an .app
  assert.equal(owningApp(424242, t), null);
});

const entry = (over = {}) => ({
  pid: 63641,
  sessionId: 'b9b246f0-7cba-4e82-9ad3-46a38615b517',
  cwd: '/Users/osika/html',
  kind: 'interactive',
  name: 'html-b8',
  status: 'idle',
  updatedAt: 1_788_697_656_749,
  statusUpdatedAt: 1_788_697_654_240,
  startedAt: 1_788_697_654_206,
  ...over,
});

test('sessionFromRegistry: interactive terminal session -> tty + owning app, no url', () => {
  const t = parseProcessTable(PS);
  const s = sessionFromRegistry(entry(), t);
  assert.equal(s.id, 'b9b246f0-7cba-4e82-9ad3-46a38615b517');
  assert.equal(s.label, 'html-b8');
  assert.equal(s.kind, 'interactive');
  assert.equal(s.state, 'idle');
  assert.equal(s.tty, 'ttys005');
  assert.equal(s.app, '/Applications/Warp.app');
  assert.ok(!('url' in s));
});

test('sessionFromRegistry: background job -> running state + claude.ai web url', () => {
  const t = parseProcessTable(PS);
  const s = sessionFromRegistry(entry({
    pid: 41449, kind: 'bg', status: 'busy', name: 'effort-ultracode-setup',
    bridgeSessionId: 'session_01ABC',
  }), t);
  assert.equal(s.kind, 'bg');
  assert.equal(s.state, 'running');
  assert.equal(s.url, CLAUDE_WEB_SESSION_BASE + 'session_01ABC');
  assert.equal(s.bridgeSessionId, 'session_01ABC');
  assert.equal(s.tty, 'ttys013');
});

test('sessionFromRegistry: drops spares, dead pids and malformed entries', () => {
  const t = parseProcessTable(PS);
  assert.equal(sessionFromRegistry(entry({ spare: true }), t), null);
  assert.equal(sessionFromRegistry(entry({ pid: 999999 }), t), null);
  assert.equal(sessionFromRegistry(entry({ sessionId: '' }), t), null);
  assert.equal(sessionFromRegistry(null, t), null);
  assert.equal(sessionFromRegistry('nope', t), null);
});

test('sessionFromRegistry: missing name falls back to the id prefix; unknown status is idle', () => {
  const t = parseProcessTable(PS);
  const s = sessionFromRegistry(entry({ name: undefined, status: 'weird' }), t);
  assert.equal(s.label, 'b9b246f0');
  assert.equal(s.state, 'idle');
});

test('sortSessions: running first, then most recently updated', () => {
  const out = sortSessions([
    { id: 'a', state: 'idle', updatedAt: 3 },
    { id: 'b', state: 'running', updatedAt: 1 },
    { id: 'c', state: 'idle', updatedAt: 5 },
    { id: 'd', state: 'running', updatedAt: 2 },
  ]);
  assert.deepEqual(out.map((s) => s.id), ['d', 'b', 'c', 'a']);
});

test('ClaudeSessionRegistry.scan: reads the registry dir, skips junk, uses the injected table', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'sessions'));
  await writeFile(join(dir, 'sessions', '63641.json'), JSON.stringify(entry()));
  await writeFile(join(dir, 'sessions', '41449.json'), JSON.stringify(entry({
    pid: 41449, sessionId: 'x'.repeat(8), kind: 'bg', status: 'busy', name: 'bg job', bridgeSessionId: 'session_1',
  })));
  await writeFile(join(dir, 'sessions', '999.json'), JSON.stringify(entry({ pid: 999 }))); // dead
  await writeFile(join(dir, 'sessions', '63641.abc.key'), 'secret'); // not json
  await writeFile(join(dir, 'sessions', 'broken.json'), '{ nope');
  const reg = new ClaudeSessionRegistry({ claudeDir: dir, readTable: async () => parseProcessTable(PS) });
  const list = await reg.scan();
  assert.deepEqual(list.map((s) => [s.label, s.state]), [['bg job', 'running'], ['html-b8', 'idle']]);
});

test('ClaudeSessionRegistry.scan: no registry dir -> []', async () => {
  const reg = new ClaudeSessionRegistry({ claudeDir: '/nonexistent/claude', readTable: async () => new Map() });
  assert.deepEqual(await reg.scan(), []);
});


test('appForTTY: finds the app hosting the named process on a pty; null otherwise', () => {
  const t = parseProcessTable(PS);
  assert.equal(appForTTY('ttys004', t, 'omp'), '/Applications/Warp.app');
  assert.equal(appForTTY('ttys004', t, 'claude'), null); // no claude on that pty
  assert.equal(appForTTY('ttys004', t), '/Applications/Warp.app'); // any process on the pty
  assert.equal(appForTTY('ttys099', t, 'omp'), null);
  assert.equal(appForTTY(null, t, 'omp'), null);
  assert.equal(appForTTY('ttys004', null, 'omp'), null);
});


test('spawnTTY: first ancestor with a tty; null when the chain never reaches a terminal', () => {
  const t = parseProcessTable(PS);
  assert.equal(spawnTTY(64287, t), 'ttys005'); // bg-spare -> pty-host -> daemon -> claude on ttys005
  assert.equal(spawnTTY(27957, t), null);      // pty-host under launchd, no terminal
  assert.equal(spawnTTY(63641, t), 'ttys005'); // interactive claude's own shell
  assert.equal(spawnTTY(424242, t), null);
});

test('sessionFromRegistry: a background job gets termTty from the launching terminal and its app', () => {
  const t = parseProcessTable(PS);
  const s = sessionFromRegistry(entry({ pid: 64287, kind: 'bg', status: 'busy', name: 'widget', jobId: '4a405173',
    bridgeSessionId: 'session_9' }), t);
  assert.equal(s.tty, 'ttys006');       // its own (headless) pty
  assert.equal(s.termTty, 'ttys005');   // where it is on screen
  assert.equal(s.app, '/Applications/Warp.app');
  assert.equal(s.jobId, '4a405173');
  assert.ok(!('attached' in s));
});

test('attachParkedTerminals: an interactive session parked on a job points the job at that terminal', () => {
  const sessions = [
    { id: 'i', kind: 'interactive', state: 'idle', termTty: 'ttys009', app: '/Applications/Warp.app', parkedJobId: 'job1' },
    { id: 'b', kind: 'bg', state: 'running', jobId: 'job1', termTty: 'ttys005', app: '/Applications/Warp.app' },
    { id: 'c', kind: 'bg', state: 'idle', jobId: 'job2', termTty: 'ttys003' },
  ];
  const out = attachParkedTerminals(sessions);
  const b = out.find((s) => s.id === 'b');
  assert.equal(b.attached, true);
  assert.equal(b.termTty, 'ttys009'); // the parked terminal wins over the launcher
  assert.equal(b.app, '/Applications/Warp.app');
  const c = out.find((s) => s.id === 'c');
  assert.ok(!('attached' in c));
  assert.equal(c.termTty, 'ttys003');
  assert.equal(out.find((s) => s.id === 'i').parkedJobId, 'job1');
});
