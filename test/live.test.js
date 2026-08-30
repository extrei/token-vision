import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TranscriptTailer,
  RateWindow,
  sparkline,
  bar,
  compact,
  fmt,
  lastNDays,
  todayTokens,
  renderFrame,
} from '../src/live.js';

const NOW = new Date('2026-08-30T12:00:00Z');

/** One valid assistant transcript line (trailing newline included). */
function transcriptLine(uuid, timestamp, input, { newline = true } = {}) {
  const json = JSON.stringify({
    type: 'assistant',
    uuid,
    requestId: `req_${uuid}`,
    timestamp,
    message: {
      id: `msg_${uuid}`,
      model: 'claude-opus-5',
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
  return newline ? json + '\n' : json;
}

/** Fresh temp claude-dir with a projects/ subtree, removed after the test. */
async function tempClaudeDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-tailer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'projects', 'p1'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- TranscriptTailer

test('TranscriptTailer: first scan returns full history with timestampMs', async (t) => {
  const dir = await tempClaudeDir(t);
  const file = join(dir, 'projects', 'p1', 's1.jsonl');
  await writeFile(
    file,
    transcriptLine('a', '2026-08-29T10:00:00.000Z', 100) +
      '{"type":"user","uuid":"u","timestamp":"2026-08-29T10:01:00.000Z"}\n' +
      transcriptLine('b', '2026-08-29T11:00:00.000Z', 200),
  );

  const tailer = new TranscriptTailer({ claudeDir: dir });
  const entries = await tailer.scan();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.key),
    ['msg_a:req_a', 'msg_b:req_b'],
  );
  assert.equal(entries[0].timestampMs, Date.parse('2026-08-29T10:00:00.000Z'));
  assert.equal(entries[1].timestampMs, Date.parse('2026-08-29T11:00:00.000Z'));
  assert.deepEqual(entries[0].tokens, { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 });
});

test('TranscriptTailer: appended line yields exactly the new entry; no changes yields []', async (t) => {
  const dir = await tempClaudeDir(t);
  const file = join(dir, 'projects', 'p1', 's1.jsonl');
  await writeFile(file, transcriptLine('a', '2026-08-29T10:00:00.000Z', 100));

  const tailer = new TranscriptTailer({ claudeDir: dir });
  assert.equal((await tailer.scan()).length, 1);

  await appendFile(file, transcriptLine('b', '2026-08-29T11:00:00.000Z', 200));
  const fresh = await tailer.scan();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].key, 'msg_b:req_b');

  assert.deepEqual(await tailer.scan(), []);
});

test('TranscriptTailer: a new file is picked up on the next scan', async (t) => {
  const dir = await tempClaudeDir(t);
  await writeFile(
    join(dir, 'projects', 'p1', 's1.jsonl'),
    transcriptLine('a', '2026-08-29T10:00:00.000Z', 100),
  );

  const tailer = new TranscriptTailer({ claudeDir: dir });
  assert.equal((await tailer.scan()).length, 1);

  // New session in the same project + a whole new project directory.
  await writeFile(
    join(dir, 'projects', 'p1', 's2.jsonl'),
    transcriptLine('b', '2026-08-29T11:00:00.000Z', 200),
  );
  await mkdir(join(dir, 'projects', 'p2'), { recursive: true });
  await writeFile(
    join(dir, 'projects', 'p2', 's3.jsonl'),
    transcriptLine('c', '2026-08-29T12:00:00.000Z', 300),
  );

  const fresh = await tailer.scan();
  assert.deepEqual(new Set(fresh.map((e) => e.key)), new Set(['msg_b:req_b', 'msg_c:req_c']));
});

test('TranscriptTailer: partial trailing line is buffered until completed, then returned once', async (t) => {
  const dir = await tempClaudeDir(t);
  const file = join(dir, 'projects', 'p1', 's1.jsonl');
  const full = transcriptLine('a', '2026-08-29T10:00:00.000Z', 100, { newline: false });
  const cut = Math.floor(full.length / 2);

  await writeFile(file, full.slice(0, cut)); // no trailing newline
  const tailer = new TranscriptTailer({ claudeDir: dir });
  assert.deepEqual(await tailer.scan(), []);

  await appendFile(file, full.slice(cut) + '\n'); // writer finishes the line
  const fresh = await tailer.scan();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].key, 'msg_a:req_a');

  assert.deepEqual(await tailer.scan(), []); // not returned twice
});

test('TranscriptTailer: truncated/rewritten file is re-read from byte 0', async (t) => {
  const dir = await tempClaudeDir(t);
  const file = join(dir, 'projects', 'p1', 's1.jsonl');
  await writeFile(
    file,
    transcriptLine('a', '2026-08-29T10:00:00.000Z', 100) +
      transcriptLine('b', '2026-08-29T11:00:00.000Z', 200) +
      transcriptLine('c', '2026-08-29T12:00:00.000Z', 300),
  );

  const tailer = new TranscriptTailer({ claudeDir: dir });
  assert.equal((await tailer.scan()).length, 3);

  // Replace with strictly smaller fresh content.
  const fresh = transcriptLine('z', '2026-08-30T09:00:00.000Z', 999);
  await writeFile(file, fresh);
  assert.ok(fresh.length < 3 * transcriptLine('a', '2026-08-29T10:00:00.000Z', 100).length);

  const entries = await tailer.scan();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'msg_z:req_z');

  assert.deepEqual(await tailer.scan(), []);
});

// ---------------------------------------------------------------- RateWindow

test('RateWindow: sums only samples inside the requested window', () => {
  const rw = new RateWindow({ maxAgeMs: 10_000 });
  rw.add(1_000, 10);
  rw.add(5_000, 20);
  rw.add(9_500, 30);

  assert.equal(rw.tokensSince(1_000, 10_000), 30); // only ts=9500
  assert.equal(rw.tokensSince(5_000, 10_000), 50); // ts=5000 + ts=9500
  assert.equal(rw.tokensSince(9_000, 10_000), 60); // all three (boundary inclusive)
  assert.equal(rw.tokensSince(100, 10_000), 0); // none within 100ms
});

test('RateWindow: prunes samples older than maxAgeMs permanently', () => {
  const rw = new RateWindow({ maxAgeMs: 1_000 });
  rw.add(0, 10);
  rw.add(500, 20);

  assert.equal(rw.tokensSince(1_000, 1_000), 30);
  // At now=2000 both samples exceed maxAgeMs and are dropped.
  assert.equal(rw.tokensSince(10_000, 2_000), 0);
  // Pruning is destructive: rewinding `now` does not bring them back.
  assert.equal(rw.tokensSince(10_000, 1_000), 0);
});

// ---------------------------------------------------------------- pure formatters

test('sparkline: scales to max, empty -> "", all zero -> all ▁', () => {
  assert.equal(sparkline([]), '');
  assert.equal(sparkline([0, 0, 0]), '▁▁▁');
  assert.equal(sparkline([0, 1, 2, 4, 8]), '▁▂▃▅█');
  assert.equal(sparkline([5, 5]), '██'); // every value at max
  assert.equal(sparkline([8, 0]), '█▁');
});

test('bar: fills proportionally, clamps, null -> empty bar', () => {
  assert.equal(bar(0), '░'.repeat(20));
  assert.equal(bar(100), '█'.repeat(20));
  assert.equal(bar(50), '█'.repeat(10) + '░'.repeat(10));
  assert.equal(bar(null), '░'.repeat(20));
  assert.equal(bar(undefined), '░'.repeat(20));
  assert.equal(bar(-5), '░'.repeat(20));
  assert.equal(bar(150), '█'.repeat(20));
  assert.equal(bar(2), '░'.repeat(20)); // rounds down to 0 cells
  assert.equal(bar(50, 10), '█'.repeat(5) + '░'.repeat(5));
});

test('compact: 1.2K/3.4M/1.6B, plain below 1000, null/undefined -> —', () => {
  assert.equal(compact(1234), '1.2K');
  assert.equal(compact(3_400_000), '3.4M');
  assert.equal(compact(1_600_000_000), '1.6B');
  assert.equal(compact(999), '999');
  assert.equal(compact(0), '0');
  assert.equal(compact(-1234), '-1.2K');
  assert.equal(compact(null), '—');
  assert.equal(compact(undefined), '—');
});

test('fmt: en-US thousands separators, null/undefined -> —', () => {
  assert.equal(fmt(1234567), '1,234,567');
  assert.equal(fmt(0), '0');
  assert.equal(fmt(12530), '12,530');
  assert.equal(fmt(null), '—');
  assert.equal(fmt(undefined), '—');
});

test('lastNDays: dense window of n UTC days ending today, missing days 0', () => {
  const buckets = [
    { startDate: '2026-08-28', tokens: 3 },
    { startDate: '2026-08-30', tokens: 7 },
  ];
  assert.deepEqual(lastNDays(buckets, 4, NOW), [0, 3, 0, 7]);
  assert.deepEqual(lastNDays(buckets, 1, NOW), [7]);
  // Buckets outside the window are dropped.
  assert.deepEqual(lastNDays([{ startDate: '2026-08-20', tokens: 5 }], 3, NOW), [0, 0, 0]);
  assert.deepEqual(lastNDays([], 3, NOW), [0, 0, 0]);
  assert.deepEqual(lastNDays(null, 2, NOW), [0, 0]);
});

test("todayTokens: today's bucket or 0", () => {
  assert.equal(todayTokens([{ startDate: '2026-08-30', tokens: 42 }], NOW), 42);
  assert.equal(todayTokens([{ startDate: '2026-08-29', tokens: 42 }], NOW), 0);
  assert.equal(todayTokens([], NOW), 0);
  assert.equal(todayTokens(null, NOW), 0);
});

// ---------------------------------------------------------------- renderFrame (ansi:false)

const claudeState = () => ({
  summary: { lifetimeTokens: 12530, assistantMessages: 8, peakDailyTokens: 10000 },
  today: 1234,
  daily: [0, 1, 2],
  perMinute: 56,
  perFiveMinutes: 789,
});

test('renderFrame: claude block shows fmt today/rate/lifetime, no ANSI escapes', () => {
  const out = renderFrame({ now: NOW, claude: claudeState(), codex: null, ansi: false });
  assert.ok(!out.includes('\x1b'), 'ansi:false output must contain no escape codes');
  assert.ok(out.includes('CLAUDE CODE'));
  assert.ok(out.includes('1,234 tokens'));
  assert.ok(out.includes('56 tok/min'));
  assert.ok(out.includes('789 in last 5m'));
  assert.ok(out.includes('12,530'));
  assert.ok(out.includes('messages 8'));
  assert.ok(out.includes('last 14d')); // default days
  assert.ok(!out.includes('ctrl-c to quit')); // no intervals given
});

test('renderFrame: codex error branch prints unavailable: <msg>', () => {
  const out = renderFrame({ now: NOW, claude: claudeState(), codex: { error: 'boom' }, ansi: false });
  assert.ok(out.includes('unavailable: boom'));
  assert.ok(!out.includes('waiting for first poll'));
});

test('renderFrame: codex null prints the waiting branch under the CODEX header', () => {
  const out = renderFrame({ now: NOW, claude: claudeState(), codex: null, ansi: false });
  assert.ok(out.includes('CODEX'));
  assert.ok(out.includes('waiting for first poll'));
});

test('renderFrame: codex undefined (disabled) omits the section entirely', () => {
  const out = renderFrame({ now: NOW, claude: claudeState(), codex: undefined, ansi: false });
  assert.ok(!out.includes('CODEX'));
  assert.ok(!out.includes('waiting for first poll'));
});

test('renderFrame: rate limits render a pro limit line with percent, window span and reset', () => {
  const resetsAtEpoch = Date.UTC(2026, 7, 30, 18, 0, 0) / 1000; // same UTC day as NOW
  const out = renderFrame({
    now: NOW,
    claude: claudeState(),
    codex: {
      summary: { lifetimeTokens: 111, currentStreakDays: 2, peakDailyTokens: 3 },
      today: 0,
      daily: [0, 0],
      rateLimits: {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: resetsAtEpoch },
        },
      },
    },
    ansi: false,
  });
  assert.ok(out.includes('pro limit'));
  assert.ok(out.includes('  2%'));
  assert.ok(out.includes('7d window'));
  assert.ok(out.includes('resets 18:00 UTC'));
  assert.ok(out.includes(bar(2))); // 2% rounds to an empty 20-cell bar
  assert.ok(!out.includes('secondary')); // no secondary window given
  assert.ok(!out.includes('waiting for first poll'));
});

test('renderFrame: intervals line renders only when intervals are given', () => {
  const withIntervals = renderFrame({
    now: NOW,
    claude: claudeState(),
    codex: null,
    ansi: false,
    intervals: { claude: '2', codex: '30' },
  });
  assert.ok(withIntervals.includes('claude every 2s · codex every 30s · ctrl-c to quit'));

  const without = renderFrame({ now: NOW, claude: claudeState(), codex: null, ansi: false });
  assert.ok(!without.includes('ctrl-c to quit'));
});
