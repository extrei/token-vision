import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLiveState } from '../src/live-usage.js';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'test/fixtures/claude-dir';
const NOW = () => new Date('2026-08-30T12:00:00Z');

test('createLiveState: scanClaude counts extracted entries pre-dedupe; claudeFrame aggregates', async () => {
  const state = createLiveState({ claudeDir: new URL(`../${FIXTURE}`, import.meta.url).pathname, now: NOW });

  // The fixture holds 8 countable API responses plus one cross-file duplicate
  // transcript line (same message id + request id). scanClaude() reports raw
  // extracted entries — dedupe happens later in summarize() — so it returns 9.
  assert.equal(await state.scanClaude(), 9);

  const frame = state.claudeFrame();
  assert.equal(frame.summary.lifetimeTokens, 12530); // deduped
  assert.equal(frame.summary.assistantMessages, 8);
  assert.equal(frame.today, 0); // no 2026-08-30 bucket
  // Dense last-14-days window ending at NOW (2026-08-17 … 2026-08-30).
  assert.deepEqual(frame.daily, [0, 0, 0, 1000, 100, 10, 20, 200, 0, 0, 10000, 400, 800, 0]);
  // All fixture timestamps are far older than the rate window.
  assert.equal(frame.perMinute, 0);
  assert.equal(frame.perFiveMinutes, 0);

  // Nothing changed on disk — a second scan finds nothing new.
  assert.equal(await state.scanClaude(), 0);
});

test('CLI --once --no-codex renders the claude block and omits the CODEX section', async () => {
  const { stdout } = await execFileP(
    process.execPath,
    ['src/live-usage.js', '--once', '--no-codex', '--claude-dir', FIXTURE],
    { cwd: ROOT, timeout: 30_000 },
  );
  assert.ok(stdout.includes('CLAUDE CODE'));
  assert.ok(stdout.includes('12,530'));
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
  assert.ok(stdout.includes('12,530')); // claude lifetime
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
