import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, appendFile, chmod, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SessionWatcher,
  contextUsedPercent,
  sourceLabel,
  listRolloutFiles,
} from '../src/codex-session-watch.mjs';
import { compactSession, buildSnapshot } from '../src/live.js';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'src/codex-session-watch.mjs');

// ------------------------------------------------------------------ fixture helpers

const uuid = (n) => `0${n}a00000-0000-7000-8000-00000000000${n}`;
const iso = (ms) => new Date(ms).toISOString();

const meta = (id, extra = {}) =>
  JSON.stringify({
    timestamp: iso(Date.now() - 3600e3),
    type: 'session_meta',
    payload: { id, cwd: '/tmp/fxproj', originator: 'test', cli_version: '0.152.1', source: 'cli', ...extra },
  });
const turnContext = (model) =>
  JSON.stringify({ timestamp: iso(Date.now() - 3000e3), type: 'turn_context', payload: { turn_id: 't1', model, effort: 'high' } });
const event = (t, payload) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload });
const usage = (total) => ({
  input_tokens: total - 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 10, reasoning_output_tokens: 0, total_tokens: total,
});
const tokenCount = (t, total, last, { window = 258_400, rateLimits } = {}) =>
  event(t, {
    type: 'token_count',
    info: { total_token_usage: usage(total), last_token_usage: usage(last), model_context_window: window },
    rate_limits: rateLimits ?? {
      primary: { used_percent: 7, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      secondary: null,
      plan_type: 'pro',
    },
  });
const padLine = (n) =>
  JSON.stringify({ timestamp: iso(Date.now() - 2000e3), type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(n) } });

/** Day directory for `daysAgo` under a fake CODEX_HOME. */
function dayDir(home, daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return join(home, 'sessions', String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
}

async function rollout(dir, id, lines) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-02T10-00-00-${id}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'codex-watch-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const byId = (snaps) => Object.fromEntries(snaps.map((s) => [s.id, s]));

// ------------------------------------------------------------------ pure helpers

test('contextUsedPercent mirrors the Codex /status formula (12k baseline, integer)', () => {
  // (70000 - 12000) / (258400 - 12000) = 23.5% used -> remaining rounds to 76 -> 24 used
  assert.equal(contextUsedPercent({ total_tokens: 70_000 }, 258_400), 24);
  assert.equal(contextUsedPercent({ total_tokens: 5_000 }, 258_400), 0); // below baseline
  assert.equal(contextUsedPercent({ total_tokens: 999_999 }, 258_400), 100); // clamped
  assert.equal(contextUsedPercent({ total_tokens: 70_000 }, 12_000), null); // window <= baseline
  assert.equal(contextUsedPercent(null, 258_400), null);
  assert.equal(contextUsedPercent({}, 258_400), null);
});

test('sourceLabel handles every SessionSource serde shape', () => {
  assert.equal(sourceLabel('vscode'), 'vscode');
  assert.equal(sourceLabel({ subagent: 'review' }), 'subagent:review');
  assert.equal(sourceLabel({ subagent: { other: 'guardian' } }), 'subagent:guardian');
  assert.equal(sourceLabel({ subagent: { thread_spawn: { agent_nickname: 'Bohr' } } }), 'subagent:spawn/Bohr');
  assert.equal(sourceLabel({ subagent: { thread_spawn: {} } }, { agent_nickname: 'Meta' }), 'subagent:spawn/Meta');
  assert.equal(sourceLabel({ custom: 'x' }), 'custom:x');
  assert.equal(sourceLabel(null), '?');
});

// ------------------------------------------------------------------ SessionWatcher

test('SessionWatcher: head+tail bootstrap of a large rollout recovers usage, model, turn state and resets', () =>
  withHome(async (home) => {
    const now = Date.now();
    const id = uuid(1);
    await rollout(dayDir(home, 0), id, [
      meta(id),
      turnContext('gpt-fx'),
      ...Array.from({ length: 12 }, () => padLine(40_000)), // pushes turn_context past the 256 KB tail
      event(now - 50e3, { type: 'task_started', turn_id: 't1' }),
      tokenCount(now - 40e3, 100_000, 100_000),
      tokenCount(now - 30e3, 150_000, 50_000),
      tokenCount(now - 30e3 + 1, 150_000, 50_000), // exact re-emit: must not count
      tokenCount(now - 20e3, 70_000, 70_000), // counter restarted (thread reloaded)
      event(now - 10e3, { type: 'task_complete' }),
    ]);
    const w = new SessionWatcher({ codexHome: home, all: true });
    const s = byId(w.poll())[id];
    assert.ok(s, 'session discovered');
    assert.equal(s.total.total_tokens, 70_000);
    assert.equal(s.last.total_tokens, 70_000);
    assert.equal(s.model, 'gpt-fx');
    assert.equal(s.turnState, 'idle');
    assert.equal(s.resets, 1);
    assert.equal(s.ctxUsedPercent, 24);
    // deltas: 50000 (100k->150k) + 70000 (reset) inside the 60 s window; the duplicate adds 0
    assert.equal(s.tokensPerMin, 120_000);
    assert.equal(s.shortId, `${id.slice(0, 13)}…${id.slice(-4)}`);
  }));

test('SessionWatcher: usage-less token_count (info:null) keeps totals and refreshes rate limits', () =>
  withHome(async (home) => {
    const now = Date.now();
    const id = uuid(2);
    await rollout(dayDir(home, 0), id, [
      meta(id, { source: { subagent: 'review' } }),
      tokenCount(now - 5e3, 90_000, 90_000),
      event(now - 1e3, {
        type: 'token_count',
        info: null,
        rate_limits: { primary: { used_percent: 99, window_minutes: 300, resets_at: Math.floor(now / 1000) - 120 }, secondary: null, plan_type: 'pro' },
      }),
    ]);
    const s = byId(new SessionWatcher({ codexHome: home, all: true }).poll())[id];
    assert.equal(s.total.total_tokens, 90_000);
    assert.equal(s.last.total_tokens, 90_000);
    assert.equal(s.rateLimits.primary.usedPercent, 99);
    assert.equal(s.source, 'subagent:review');
    assert.equal(s.tokenCountEvents, 2);
  }));

test('SessionWatcher: a forked rollout keeps its own (first) session_meta, not the copied parent one', () =>
  withHome(async (home) => {
    const now = Date.now();
    const id = uuid(3);
    await rollout(dayDir(home, 0), id, [
      meta(id, { source: { subagent: { thread_spawn: { parent_thread_id: uuid(1), agent_nickname: 'Bohr' } } } }),
      meta(uuid(1), { agent_nickname: 'Parent' }),
      tokenCount(now - 2e3, 5_000, 5_000),
    ]);
    const s = byId(new SessionWatcher({ codexHome: home, all: true }).poll())[id];
    assert.equal(s.id, id);
    assert.equal(s.source, 'subagent:spawn/Bohr');
  }));

test('SessionWatcher: a truncated trailing line is ignored until the writer completes it', () =>
  withHome(async (home) => {
    const now = Date.now();
    const id = uuid(4);
    const file = await rollout(dayDir(home, 0), id, [meta(id), tokenCount(now - 9e3, 8_000, 8_000)]);
    const partial = tokenCount(now - 1e3, 9_000, 1_000);
    await appendFile(file, partial.slice(0, 40));
    const w = new SessionWatcher({ codexHome: home, all: true });
    assert.equal(byId(w.poll())[id].total.total_tokens, 8_000);
    await appendFile(file, partial.slice(40) + '\n');
    assert.equal(byId(w.poll())[id].total.total_tokens, 9_000);
  }));

test('SessionWatcher: lines over 1 MB are skipped without losing the lines after them', () =>
  withHome(async (home) => {
    const now = Date.now();
    const id = uuid(5);
    await rollout(dayDir(home, 0), id, [meta(id), padLine(1_500_000), tokenCount(now - 2e3, 4_242, 4_242)]);
    const s = byId(new SessionWatcher({ codexHome: home, all: true }).poll())[id];
    assert.equal(s.total.total_tokens, 4_242);
    assert.equal(s.parseErrors, 0);
  }));

test('listRolloutFiles: an old day directory is still scanned when a file in it was written recently', () =>
  withHome(async (home) => {
    const now = Date.now();
    const fresh = await rollout(dayDir(home, 6), uuid(7), [meta(uuid(7)), tokenCount(now - 2e3, 777, 777)]);
    const stale = await rollout(dayDir(home, 6), uuid(8), [meta(uuid(8)), tokenCount(now - 8 * 86_400e3, 1, 1)]);
    await utimes(stale, new Date(now - 8 * 86_400e3), new Date(now - 8 * 86_400e3));
    const files = listRolloutFiles(join(home, 'sessions'), 3, null);
    assert.ok(files.includes(fresh));
    assert.ok(!files.includes(stale));
    // --session filters on the file name, so non-matching rollouts are never opened
    assert.deepEqual(listRolloutFiles(join(home, 'sessions'), 3, uuid(7).slice(0, 13)), [fresh]);
  }));

test('SessionWatcher: unreadable and vanished rollouts do not throw', { skip: process.getuid?.() === 0 && 'root can read anything' }, () =>
  withHome(async (home) => {
    const now = Date.now();
    const bad = await rollout(dayDir(home, 0), uuid(8), [meta(uuid(8)), tokenCount(now - 2e3, 888, 888)]);
    const gone = await rollout(dayDir(home, 0), uuid(9), [meta(uuid(9)), tokenCount(now - 2e3, 999, 999)]);
    await chmod(bad, 0);
    const w = new SessionWatcher({ codexHome: home, all: true, rescanSec: 3600 });
    const first = byId(w.poll());
    assert.equal(first[uuid(8)].readError, 'EACCES');
    assert.equal(first[uuid(9)].total.total_tokens, 999);
    await rm(gone);
    const second = byId(w.poll());
    assert.ok(!(uuid(9) in second), 'deleted rollout dropped before the next rescan');
    await chmod(bad, 0o644);
  }));

test('SessionWatcher: a turn still "running" with no writes for longer than the active window reads as stale', () =>
  withHome(async (home) => {
    const now = Date.now();
    const id = uuid(6);
    const file = await rollout(dayDir(home, 0), id, [
      meta(id),
      event(now - 3600e3, { type: 'task_started', turn_id: 't9' }),
      tokenCount(now - 3600e3, 6_000, 6_000),
    ]);
    await utimes(file, new Date(now - 3600e3), new Date(now - 3600e3));
    const w = new SessionWatcher({ codexHome: home, activeWindow: 600 });
    assert.equal(w.poll().length, 0, 'inactive sessions hidden by default');
    const s = byId(new SessionWatcher({ codexHome: home, all: true }).poll())[id];
    assert.equal(s.turnState, 'stale');
    assert.equal(s.active, false);
  }));

test('SessionWatcher: --cwd style filter matches through macOS /tmp -> /private/tmp symlinks', () =>
  withHome(async (home) => {
    const now = Date.now();
    await rollout(dayDir(home, 0), uuid(1), [meta(uuid(1)), tokenCount(now - 2e3, 1, 1)]);
    await rollout(dayDir(home, 0), uuid(2), [meta(uuid(2), { cwd: '/elsewhere' }), tokenCount(now - 2e3, 1, 1)]);
    const w = new SessionWatcher({ codexHome: home, all: true, cwd: '/private/tmp/fxproj' });
    const ids = w.poll().map((s) => s.id);
    // /tmp/fxproj need not exist: the longest existing ancestor is resolved
    assert.deepEqual(ids, process.platform === 'darwin' ? [uuid(1)] : ids);
    assert.ok(!ids.includes(uuid(2)));
  }));

// ------------------------------------------------------------------ CLI

test('CLI --once --stream --session prints one start object with the selected session', () =>
  withHome(async (home) => {
    const now = Date.now();
    await rollout(dayDir(home, 0), uuid(1), [meta(uuid(1)), tokenCount(now - 2e3, 1_234, 1_234)]);
    await rollout(dayDir(home, 0), uuid(2), [meta(uuid(2)), tokenCount(now - 2e3, 2, 2)]);
    const { stdout } = await execFileP(process.execPath, [SCRIPT, '--once', '--stream', '--session', uuid(1).slice(0, 13)], {
      env: { ...process.env, CODEX_HOME: home }, timeout: 20_000,
    });
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.type, 'start');
    assert.equal(obj.sessions.length, 1);
    assert.equal(obj.sessions[0].total.total_tokens, 1_234);
  }));

test('CLI --once renders a table and rejects bad numeric options', () =>
  withHome(async (home) => {
    const now = Date.now();
    await rollout(dayDir(home, 0), uuid(1), [meta(uuid(1)), turnContext('gpt-fx'), tokenCount(now - 2e3, 70_000, 70_000)]);
    const { stdout } = await execFileP(process.execPath, [SCRIPT, '--once', '--all'], {
      env: { ...process.env, CODEX_HOME: home }, timeout: 20_000,
    });
    assert.match(stdout, /showing 1\/1 sessions/);
    assert.match(stdout, /gpt-fx/);
    assert.match(stdout, /70\.0k/);
    assert.match(stdout, / 24% /);
    await assert.rejects(
      execFileP(process.execPath, [SCRIPT, '--once', '--interval', 'abc'], { env: { ...process.env, CODEX_HOME: home } }),
      (err) => err.code === 2 && /--interval needs a number/.test(err.stderr),
    );
  }));

// ------------------------------------------------------------------ wire format

test('compactSession: labels subagents by nickname, guardian reviews by role, user threads by folder', () => {
  const base = {
    id: 'abc', cwd: '/Users/me/proj', model: 'gpt-x', turnState: 'running', ctxUsedPercent: 42,
    total: { total_tokens: 1_000 }, last: { total_tokens: 100 }, tokensPerMin: 50,
    lastEventTs: '2026-09-02T10:00:00.000Z', lastEventAgeSec: 3.4, resets: 0,
  };
  assert.deepEqual(compactSession({ ...base, source: 'vscode' }), {
    id: 'abc', label: 'proj', kind: 'user', cwd: '/Users/me/proj', model: 'gpt-x', state: 'running',
    ctxPercent: 42, total: 1_000, last: 100, tokensPerMin: 50, lastEventAt: '2026-09-02T10:00:00.000Z', ageSec: 3,
  });
  assert.equal(compactSession({ ...base, source: 'subagent:spawn/Archimedes' }).label, 'Archimedes');
  assert.equal(compactSession({ ...base, source: 'subagent:spawn/Archimedes' }).kind, 'subagent');
  assert.equal(compactSession({ ...base, source: 'subagent:guardian' }).label, 'Guardian review');
  assert.equal(compactSession({ ...base, source: 'subagent:guardian' }).kind, 'guardian');
  const bare = compactSession({ id: 'zz', source: 'cli', turnState: 'idle', tokensPerMin: 0, resets: 2 });
  assert.equal(bare.label, 'cli');
  assert.equal(bare.total, null);
  assert.equal(bare.resets, 2);
  assert.ok(!('ctxPercent' in bare));
  assert.ok(!('model' in bare));
});

test('buildSnapshot: codex.sessions rides along in every codex state and is absent when codex is disabled', () => {
  const sessions = [{ id: 'a', source: 'vscode', cwd: '/p', turnState: 'idle', tokensPerMin: 0, total: { total_tokens: 5 } }];
  assert.equal(buildSnapshot({ codex: null, codexSessions: sessions }).codex.sessions[0].label, 'p');
  assert.equal(buildSnapshot({ codex: { error: 'x' }, codexSessions: sessions }).codex.sessions.length, 1);
  assert.equal(buildSnapshot({ codex: { today: 1, summary: {} }, codexSessions: sessions }).codex.sessions[0].total, 5);
  assert.ok(!('sessions' in buildSnapshot({ codex: { today: 1, summary: {} } }).codex));
  assert.ok(!('codex' in buildSnapshot({ codex: undefined, codexSessions: sessions })));
});
