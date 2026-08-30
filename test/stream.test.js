import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/live.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'test/fixtures/claude-dir';
const NOW = new Date('2026-08-30T12:00:00Z');

// ---------------------------------------------------------------------------
// buildSnapshot unit tests
// ---------------------------------------------------------------------------

test('buildSnapshot: ts is the provided now.toISOString(); no inputs -> ts only', () => {
  const snap = buildSnapshot({ now: NOW });
  assert.equal(snap.ts, '2026-08-30T12:00:00.000Z');
  assert.ok(!('claude' in snap));
  assert.ok(!('codex' in snap));
});

test('buildSnapshot: claude summary flattened, rates and today passed through', () => {
  const snap = buildSnapshot({
    now: NOW,
    claude: {
      perMinute: 42,
      perFiveMinutes: 210,
      today: 999,
      summary: { lifetimeTokens: 12530, assistantMessages: 8, peakDailyTokens: 10000 },
    },
  });
  assert.deepEqual(snap.claude, {
    perMinute: 42,
    perFiveMinutes: 210,
    today: 999,
    lifetime: 12530,
    messages: 8,
  });
});

test('buildSnapshot: codex undefined -> no codex key at all', () => {
  const snap = buildSnapshot({ now: NOW, codex: undefined });
  assert.ok(!('codex' in snap));
});

test('buildSnapshot: codex null -> pending marker', () => {
  const snap = buildSnapshot({ now: NOW, codex: null });
  assert.deepEqual(snap.codex, { pending: true });
});

test('buildSnapshot: codex error -> error passed through', () => {
  const snap = buildSnapshot({ now: NOW, codex: { error: 'spawn codex ENOENT' } });
  assert.deepEqual(snap.codex, { error: 'spawn codex ENOENT' });
});

test('buildSnapshot: full codex with rate limits maps primary window and planType', () => {
  const snap = buildSnapshot({
    now: NOW,
    codex: {
      today: 54321,
      summary: { lifetimeTokens: 12345678, currentStreakDays: 5 },
      rateLimits: {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1767225600 },
        },
      },
    },
  });
  assert.deepEqual(snap.codex, {
    today: 54321,
    lifetime: 12345678,
    usedPercent: 37,
    windowMins: 300,
    resetsAt: 1767225600,
    planType: 'pro',
  });
});

test('buildSnapshot: full codex without rate limits omits the optional keys entirely', () => {
  const snap = buildSnapshot({
    now: NOW,
    codex: { today: 54321, summary: { lifetimeTokens: 12345678 } },
  });
  assert.deepEqual(snap.codex, { today: 54321, lifetime: 12345678 });
  assert.ok(!('usedPercent' in snap.codex));
  assert.ok(!('windowMins' in snap.codex));
  assert.ok(!('resetsAt' in snap.codex));
  assert.ok(!('planType' in snap.codex));
});

// ---------------------------------------------------------------------------
// CLI --stream tests
// ---------------------------------------------------------------------------

/**
 * Spawn live-usage.js --stream, collect stdout for `collectMs`, SIGTERM it,
 * and wait for the process to close (SIGKILL backstop so tests never hang).
 * Returns the parsed NDJSON lines plus captured stderr for diagnostics.
 */
async function collectStream(args, { env = {}, collectMs = 1200 } = {}) {
  const child = spawn(process.execPath, ['src/live-usage.js', '--stream', '--no-claude-limits', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  const closed = once(child, 'close');
  await delay(collectMs);
  child.kill('SIGTERM');
  const backstop = setTimeout(() => child.kill('SIGKILL'), 3000);
  backstop.unref();
  await closed; // must not hang; exit code is irrelevant (SIGTERM kill is fine)
  clearTimeout(backstop);

  const rawLines = stdout.split('\n').filter((l) => l.trim() !== '');
  const lines = rawLines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      assert.fail(`stdout line ${i + 1} is not valid JSON: ${l}\nstderr: ${stderr}`);
    }
  });
  return { lines, stderr };
}

test('CLI --stream --no-codex emits parseable snapshots with claude data and no codex key', async () => {
  const { lines, stderr } = await collectStream(
    ['--interval', '0.3', '--no-codex', '--claude-dir', FIXTURE],
  );
  assert.ok(lines.length >= 2, `expected >=2 snapshot lines, got ${lines.length}\nstderr: ${stderr}`);
  for (const snap of lines) {
    assert.equal(typeof snap.ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(snap.ts)));
  }
  const first = lines[0];
  assert.equal(first.claude.lifetime, 12530);
  assert.ok(!('codex' in first));
});

test('CLI --stream with mock codex includes codex usage but no usedPercent', async () => {
  const { lines, stderr } = await collectStream(
    [
      '--interval', '0.3',
      '--claude-dir', FIXTURE,
      '--codex-cmd', process.execPath,
      '--codex-args', 'test/fixtures/mock-app-server.js',
      '--codex-home', 'test/fixtures/no-such-codex-home',
    ],
    { env: { MOCK_MODE: 'happy' }, collectMs: 1400 },
  );
  assert.ok(lines.length >= 2, `expected >=2 snapshot lines, got ${lines.length}\nstderr: ${stderr}`);
  const withCodex = lines.find((l) => typeof l.codex?.lifetime === 'number');
  assert.ok(withCodex, `no snapshot carried codex.lifetime\nstderr: ${stderr}\nlines: ${JSON.stringify(lines)}`);
  assert.equal(withCodex.codex.lifetime, 12345678); // mock fixture lifetimeTokens
  // The mock rejects account/rateLimits/read (-32601); pollCodex swallows it,
  // so the snapshot must carry no rate-limit fields.
  assert.ok(!('usedPercent' in withCodex.codex));
});
