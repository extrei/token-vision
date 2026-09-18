import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLiveState } from '../src/live-usage.js';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'test/fixtures/claude-dir';
const NOW = () => new Date('2026-08-30T12:00:00Z');

test('createLiveState: scanClaude counts extracted entries pre-dedupe; claudeFrame aggregates', async () => {
  const state = createLiveState({ claudeDir: new URL(`../${FIXTURE}`, import.meta.url).pathname, now: NOW });

  // The fixture holds 9 countable API responses (one in a nested subagents
  // transcript) plus one cross-file duplicate transcript line (same message id
  // + request id). scanClaude() reports raw extracted entries — dedupe happens
  // later in summarize() — so it returns 10.
  assert.equal(await state.scanClaude(), 10);

  const frame = state.claudeFrame();
  assert.equal(frame.summary.lifetimeTokens, 17530); // deduped
  assert.equal(frame.summary.assistantMessages, 9);
  assert.equal(frame.today, 0); // no 2026-08-30 bucket
  // Dense last-14-days window ending at NOW (2026-08-17 … 2026-08-30).
  assert.deepEqual(frame.daily, [0, 0, 0, 1000, 100, 10, 20, 200, 0, 0, 10000, 5400, 800, 0]);
  // All fixture timestamps are far older than the rate window.
  assert.equal(frame.perMinute, 0);
  assert.equal(frame.perFiveMinutes, 0);

  // Nothing changed on disk — a second scan finds nothing new.
  assert.equal(await state.scanClaude(), 0);
});

test('CLI --once --no-codex renders the claude block and omits the CODEX section', async () => {
  const { stdout } = await execFileP(
    process.execPath,
    ['src/live-usage.js', '--once', '--no-codex', '--no-claude-limits', '--claude-dir', FIXTURE],
    { cwd: ROOT, timeout: 30_000 },
  );
  assert.ok(stdout.includes('CLAUDE CODE'));
  assert.ok(stdout.includes('17,530'));
  assert.ok(!stdout.includes('CODEX'));
  assert.ok(!stdout.includes('waiting for first poll'));
  assert.ok(!stdout.includes('ctrl-c to quit')); // --once renders no intervals line
  assert.ok(!stdout.includes('\x1b')); // piped stdout is not a TTY -> no ANSI
});

test('CLI --once with mock codex shows codex usage and no rate-limit line', async () => {
  const { stdout } = await execFileP(
    process.execPath,
    [
      'src/live-usage.js',
      '--once',
      '--no-claude-limits',
      '--claude-dir',
      FIXTURE,
      '--codex-cmd',
      process.execPath,
      '--codex-args',
      'test/fixtures/mock-app-server.js',
      '--codex-home',
      'test/fixtures/no-such-codex-home',
    ],
    { cwd: ROOT, timeout: 30_000, env: { ...process.env, MOCK_MODE: 'happy' } },
  );
  assert.ok(stdout.includes('CLAUDE CODE'));
  assert.ok(stdout.includes('17,530')); // claude lifetime
  assert.ok(stdout.includes('12,345,678')); // mock codex lifetime
  assert.ok(stdout.includes('streak 5d')); // mock currentStreakDays
  assert.ok(!stdout.includes('waiting for first poll'));
  assert.ok(!stdout.includes('unavailable'));
  // The mock rejects account/rateLimits/read with -32601; pollCodex swallows
  // it, so no limit line (no bar cells, no "window" span) is rendered.
  assert.ok(!stdout.includes('limit'));
  assert.ok(!stdout.includes('window'));
  assert.ok(!stdout.includes('░'));
});

// One API response is written as several transcript lines whose output_tokens
// grows; the live rate must end up with the response's final size, once.
const block = (uuid, output, timestamp, id = 'msg_live') => JSON.stringify({
  type: 'assistant', uuid, requestId: `req_${id}`, timestamp,
  message: { id, model: 'claude-opus-5',
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000, output_tokens: output } },
});

async function liveDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-rate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'projects', 'proj'), { recursive: true });
  return { dir, file: join(dir, 'projects', 'proj', 'session.jsonl') };
}

test('createLiveState: rate counts a response once at its final size, lines seen in one scan', async (t) => {
  const { dir, file } = await liveDir(t);
  await writeFile(file, [
    block('u1', 1, '2026-08-30T11:59:30.000Z'),
    block('u2', 1, '2026-08-30T11:59:31.000Z'),
    block('u3', 600, '2026-08-30T11:59:40.000Z'),
  ].join('\n') + '\n');
  const state = createLiveState({ claudeDir: dir, now: NOW, omp: false, claudeSessions: false });
  await state.scanClaude();
  const frame = state.claudeFrame();
  assert.equal(frame.perMinute, 10 + 1_000 + 600); // not 1011 (first line), not 3*… (every line)
  assert.equal(frame.summary.outputTokens, 600);
  assert.equal(frame.summary.assistantMessages, 1);
});

test('createLiveState: rate adds only the growth when later lines of a response arrive in a later scan', async (t) => {
  const { dir, file } = await liveDir(t);
  await writeFile(file, block('u1', 1, '2026-08-30T11:59:30.000Z') + '\n');
  const state = createLiveState({ claudeDir: dir, now: NOW, omp: false, claudeSessions: false });
  await state.scanClaude();
  assert.equal(state.claudeFrame().perMinute, 10 + 1_000 + 1);
  await appendFile(file, block('u2', 450, '2026-08-30T11:59:45.000Z') + '\n');
  await state.scanClaude();
  assert.equal(state.claudeFrame().perMinute, 10 + 1_000 + 450);
  // A copy of an earlier, smaller snapshot (forked session) changes nothing…
  await appendFile(file, block('u3', 200, '2026-08-30T11:59:50.000Z') + '\n');
  await state.scanClaude();
  assert.equal(state.claudeFrame().perMinute, 10 + 1_000 + 450);
  // …and a second response adds its own size.
  await appendFile(file, block('u4', 90, '2026-08-30T11:59:55.000Z', 'msg_two') + '\n');
  await state.scanClaude();
  assert.equal(state.claudeFrame().perMinute, (10 + 1_000 + 450) + (10 + 1_000 + 90));
  assert.equal(state.claudeFrame().summary.assistantMessages, 2);
});
