import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractTokenCountEvent,
  isReemission,
  tokensByDate,
  CodexSessionScanner,
  localTodayTokens,
  overlayToday,
} from '../src/codex-local.js';
import { renderFrame, buildSnapshot } from '../src/live.js';

const NOW = new Date('2026-08-30T12:00:00Z');
const utc = (daysBack) => new Date(NOW.getTime() - daysBack * 86_400_000).toISOString().slice(0, 10);
const TODAY = utc(0); // 2026-08-30
const YESTERDAY = utc(1); // 2026-08-29

/** One realistic token_count rollout line (no trailing newline). */
const tokenLine = (timestamp, tokens) =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 0,
          total_tokens: 200,
        },
        last_token_usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: tokens,
        },
        model_context_window: 258_400,
      },
      rate_limits: {},
    },
  });

// ---------------------------------------------------------------- extractTokenCountEvent

test('extractTokenCountEvent: valid rollout line yields exact date and last_token_usage total', () => {
  const line =
    '{"timestamp":"2026-08-30T09:35:21.066Z","type":"event_msg","payload":{"type":"token_count",' +
    '"info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":500,' +
    '"cache_write_input_tokens":0,"output_tokens":900,"reasoning_output_tokens":300,"total_tokens":1900},' +
    '"last_token_usage":{"input_tokens":29450,"cached_input_tokens":26368,"cache_write_input_tokens":0,' +
    '"output_tokens":276,"reasoning_output_tokens":107,"total_tokens":29726},' +
    '"model_context_window":258400},"rate_limits":{"primary":{"used_percent":3}}}}';
  assert.deepEqual(extractTokenCountEvent(line), { date: '2026-08-30', tokens: 29726, total: 1900 });
});

test('extractTokenCountEvent: line without the "token_count" substring -> null', () => {
  const line = JSON.stringify({
    timestamp: '2026-08-30T09:35:21.066Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'hi' },
  });
  assert.equal(extractTokenCountEvent(line), null);
});

test('extractTokenCountEvent: invalid JSON containing the substring -> null', () => {
  assert.equal(extractTokenCountEvent('{"payload":{"type":"token_count"'), null);
  assert.equal(extractTokenCountEvent('not json at all "token_count"'), null);
});

test("extractTokenCountEvent: payload.type !== 'token_count' -> null", () => {
  // "token_count" appears as a value elsewhere, so the substring fast-path passes.
  const wrongType = JSON.stringify({
    timestamp: '2026-08-30T09:35:21.066Z',
    type: 'event_msg',
    payload: { type: 'turn_diff', label: 'token_count' },
  });
  assert.equal(extractTokenCountEvent(wrongType), null);
  // Missing payload entirely.
  const noPayload = JSON.stringify({ timestamp: '2026-08-30T09:35:21.066Z', note: 'token_count' });
  assert.equal(extractTokenCountEvent(noPayload), null);
});

test('extractTokenCountEvent: missing timestamp -> null', () => {
  const parsed = JSON.parse(tokenLine('2026-08-30T09:35:21.066Z', 123));
  delete parsed.timestamp;
  assert.equal(extractTokenCountEvent(JSON.stringify(parsed)), null);
});

test('extractTokenCountEvent: tokens <= 0 (zero, negative, missing usage) -> null', () => {
  assert.equal(extractTokenCountEvent(tokenLine('2026-08-30T09:35:21.066Z', 0)), null);
  assert.equal(extractTokenCountEvent(tokenLine('2026-08-30T09:35:21.066Z', -5)), null);
  const parsed = JSON.parse(tokenLine('2026-08-30T09:35:21.066Z', 123));
  delete parsed.payload.info.last_token_usage;
  assert.equal(extractTokenCountEvent(JSON.stringify(parsed)), null);
});

// ---------------------------------------------------------------- CodexSessionScanner

const dayDirFor = (home, date) => join(home, 'sessions', ...date.split('-'));

/**
 * Temp codexHome (removed after the test):
 *   sessions/<today>/rollout-a.jsonl      100 + 200 today (plus one non-token line)
 *   sessions/<yesterday>/rollout-b.jsonl  50 yesterday + 25 stamped TODAY (event-timestamp bucketing)
 *   sessions/<today>/notes-a.jsonl        ignored: name doesn't start with rollout-
 *   sessions/<today>/rollout-c.txt        ignored: not .jsonl
 *   sessions/<4 days back>/rollout-old.jsonl  outside lookbackDays=2 — never scanned
 */
async function fixtureCodexHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-local-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const todayDir = dayDirFor(home, TODAY);
  const yesterdayDir = dayDirFor(home, YESTERDAY);
  const oldDir = dayDirFor(home, utc(4));
  await mkdir(todayDir, { recursive: true });
  await mkdir(yesterdayDir, { recursive: true });
  await mkdir(oldDir, { recursive: true });

  await writeFile(
    join(todayDir, 'rollout-a.jsonl'),
    tokenLine(`${TODAY}T08:00:00.000Z`, 100) +
      '\n' +
      JSON.stringify({ timestamp: `${TODAY}T08:30:00.000Z`, type: 'event_msg', payload: { type: 'agent_message' } }) +
      '\n' +
      tokenLine(`${TODAY}T09:00:00.000Z`, 200) +
      '\n',
  );
  await writeFile(
    join(yesterdayDir, 'rollout-b.jsonl'),
    tokenLine(`${YESTERDAY}T23:00:00.000Z`, 50) + '\n' + tokenLine(`${TODAY}T00:30:00.000Z`, 25) + '\n',
  );
  await writeFile(join(todayDir, 'notes-a.jsonl'), tokenLine(`${TODAY}T10:00:00.000Z`, 1_000_000) + '\n');
  await writeFile(join(todayDir, 'rollout-c.txt'), tokenLine(`${TODAY}T10:00:00.000Z`, 500_000) + '\n');
  await writeFile(
    join(oldDir, 'rollout-old.jsonl'),
    tokenLine(`${utc(4)}T10:00:00.000Z`, 9999) + '\n' + tokenLine(`${TODAY}T01:00:00.000Z`, 7777) + '\n',
  );
  return home;
}

test('CodexSessionScanner: buckets by event timestamp, matches only rollout-*.jsonl, honors lookback', async (t) => {
  const home = await fixtureCodexHome(t);
  const scanner = new CodexSessionScanner({ codexHome: home, lookbackDays: 2 });

  const daily = await scanner.dailyTokens(NOW);
  // Today = 100 + 200 (rollout-a) + 25 (today-stamped event living in yesterday's dir).
  // Yesterday = 50. The 4-days-back dir (9999 + a today-stamped 7777) is outside the
  // lookback window; the non-rollout files (1,000,000 / 500,000) are never read.
  assert.deepEqual(
    daily,
    new Map([
      [TODAY, 325],
      [YESTERDAY, 50],
    ]),
  );
  assert.equal(await scanner.todayTokens(NOW), 325);
});

test('localTodayTokens: one-shot wrapper returns the same today total', async (t) => {
  const home = await fixtureCodexHome(t);
  assert.equal(await localTodayTokens({ codexHome: home, lookbackDays: 2, now: NOW }), 325);
});

test('CodexSessionScanner: grown file is re-read; unchanged files served from cache', async (t) => {
  const home = await fixtureCodexHome(t);
  const scanner = new CodexSessionScanner({ codexHome: home, lookbackDays: 2 });

  const first = await scanner.dailyTokens(NOW);
  assert.equal(first.get(TODAY), 325);

  // Append -> size changes -> file re-read, new event counted.
  await appendFile(join(dayDirFor(home, TODAY), 'rollout-a.jsonl'), tokenLine(`${TODAY}T11:00:00.000Z`, 40) + '\n');
  const second = await scanner.dailyTokens(NOW);
  assert.deepEqual(
    second,
    new Map([
      [TODAY, 365],
      [YESTERDAY, 50],
    ]),
  );

  // No writes -> sizes unchanged -> cached per-file results, identical totals.
  const third = await scanner.dailyTokens(NOW);
  assert.deepEqual(third, second);
  assert.equal(await scanner.todayTokens(NOW), 365);
});

test('CodexSessionScanner: missing codexHome -> empty Map / 0, no throw', async () => {
  const home = join(tmpdir(), `codex-local-does-not-exist-${process.pid}-${Date.now()}`);
  const scanner = new CodexSessionScanner({ codexHome: home, lookbackDays: 2 });
  assert.deepEqual(await scanner.dailyTokens(NOW), new Map());
  assert.equal(await scanner.todayTokens(NOW), 0);
});

// ---------------------------------------------------------------- overlayToday

test('overlayToday: api bucket >= local -> api wins, not estimated', () => {
  const buckets = [
    { startDate: YESTERDAY, tokens: 10 },
    { startDate: TODAY, tokens: 500 },
  ];
  const res = overlayToday(buckets, 300, NOW);
  assert.equal(res.today, 500);
  assert.equal(res.todayEstimated, false);
  assert.deepEqual(res.buckets, buckets);
});

test('overlayToday: local > api -> local wins, estimated', () => {
  const buckets = [
    { startDate: YESTERDAY, tokens: 10 },
    { startDate: TODAY, tokens: 500 },
  ];
  const res = overlayToday(buckets, 800, NOW);
  assert.equal(res.today, 800);
  assert.equal(res.todayEstimated, true);
  assert.deepEqual(res.buckets, [
    { startDate: YESTERDAY, tokens: 10 },
    { startDate: TODAY, tokens: 800 },
  ]);
});

test("overlayToday: missing today bucket is appended in sorted position, estimated when local > 0", () => {
  const buckets = [
    { startDate: utc(2), tokens: 5 },
    { startDate: YESTERDAY, tokens: 10 },
  ];
  const res = overlayToday(buckets, 42, NOW);
  assert.equal(res.today, 42);
  assert.equal(res.todayEstimated, true);
  assert.deepEqual(res.buckets, [
    { startDate: utc(2), tokens: 5 },
    { startDate: YESTERDAY, tokens: 10 },
    { startDate: TODAY, tokens: 42 },
  ]);

  // Sorted insertion, not blind append: a later-dated bucket stays last.
  const withLater = overlayToday([{ startDate: '2026-08-31', tokens: 1 }], 7, NOW);
  assert.deepEqual(
    withLater.buckets.map((b) => b.startDate),
    [TODAY, '2026-08-31'],
  );
});

test('overlayToday: local 0 with no today bucket -> appended 0 bucket, NOT estimated', () => {
  const res = overlayToday([{ startDate: YESTERDAY, tokens: 10 }], 0, NOW);
  assert.equal(res.today, 0);
  assert.equal(res.todayEstimated, false);
  assert.deepEqual(res.buckets, [
    { startDate: YESTERDAY, tokens: 10 },
    { startDate: TODAY, tokens: 0 },
  ]);
});

test('overlayToday: input array and its bucket objects are not mutated', () => {
  const buckets = [
    { startDate: YESTERDAY, tokens: 10 },
    { startDate: TODAY, tokens: 20 },
  ];
  const snapshot = structuredClone(buckets);

  // Overwrite path (local wins) must not touch the input objects.
  const res = overlayToday(buckets, 999, NOW);
  assert.deepEqual(buckets, snapshot);
  assert.notEqual(res.buckets, buckets);
  assert.notEqual(res.buckets[1], buckets[1]);

  // Append path must not push into the input array.
  const noToday = [{ startDate: YESTERDAY, tokens: 10 }];
  const noTodaySnapshot = structuredClone(noToday);
  overlayToday(noToday, 5, NOW);
  assert.deepEqual(noToday, noTodaySnapshot);
});

// ---------------------------------------------------------------- renderFrame / buildSnapshot markers

test("renderFrame: todayEstimated shows ~ and '(local estimate' marker", () => {
  const out = renderFrame({
    now: NOW,
    codex: { today: 12345, todayEstimated: true, daily: [], summary: {} },
    ansi: false,
  });
  assert.ok(out.includes('~12,345 tokens'));
  assert.ok(out.includes('(local estimate'));
});

test('renderFrame: no estimate marker when todayEstimated is false or absent', () => {
  for (const codex of [
    { today: 12345, todayEstimated: false, daily: [], summary: {} },
    { today: 12345, daily: [], summary: {} },
  ]) {
    const out = renderFrame({ now: NOW, codex, ansi: false });
    assert.ok(out.includes('12,345 tokens'));
    assert.ok(!out.includes('~'));
    assert.ok(!out.includes('(local estimate'));
  }
});

test('buildSnapshot: todayEstimated key present only when true', () => {
  const estimated = buildSnapshot({
    now: NOW,
    codex: { today: 5, todayEstimated: true, summary: {} },
  });
  assert.equal(estimated.codex.todayEstimated, true);

  const plain = buildSnapshot({ now: NOW, codex: { today: 5, todayEstimated: false, summary: {} } });
  assert.ok(!('todayEstimated' in plain.codex));

  const absent = buildSnapshot({ now: NOW, codex: { today: 5, summary: {} } });
  assert.ok(!('todayEstimated' in absent.codex));
});

// ---------------------------------------------------------------- re-emitted token_count events

/** token_count line with its own size (`last`) and the thread's cumulative counter (`total`). */
const usageLine = (timestamp, last, total) =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        ...(total !== undefined && { total_token_usage: { total_tokens: total } }),
        last_token_usage: { total_tokens: last },
        model_context_window: 258_400,
      },
      rate_limits: {},
    },
  });
const at = (hms) => `${TODAY}T${hms}.000Z`;

test('extractTokenCountEvent: total is the cumulative counter, null when the line has none', () => {
  assert.deepEqual(extractTokenCountEvent(usageLine(at('09:00:00'), 500, 1500)), { date: TODAY, tokens: 500, total: 1500 });
  assert.deepEqual(extractTokenCountEvent(usageLine(at('09:00:00'), 500)), { date: TODAY, tokens: 500, total: null });
});

test('isReemission: same (last, total) as the previous event; never without a total or a previous event', () => {
  const ev = (tokens, total) => ({ date: TODAY, tokens, total });
  assert.equal(isReemission(ev(500, 1500), ev(500, 1500)), true);
  assert.equal(isReemission(ev(500, 2000), ev(500, 1500)), false); // same size, counter moved: a real response
  assert.equal(isReemission(ev(400, 1500), ev(500, 1500)), false);
  assert.equal(isReemission(ev(500, null), ev(500, null)), false); // can't be told apart: count it
  assert.equal(isReemission(ev(500, 1500), null), false);
});

test('tokensByDate: a verbatim re-emission is summed once (compaction / settings / rate-limit refresh)', () => {
  // Shape from a real rollout: runs like [40625, 40625, 40625] with an unchanged cumulative total.
  const text = [
    usageLine(at('09:00:00'), 40_000, 40_000),
    usageLine(at('09:01:00'), 40_625, 80_625),
    usageLine(at('09:01:30'), 40_625, 80_625), // re-emitted
    usageLine(at('09:02:10'), 40_625, 80_625), // re-emitted again
    '{"timestamp":"' + at('09:02:20') + '","type":"event_msg","payload":{"type":"thread_settings_applied"}}',
    usageLine(at('09:03:00'), 47_716, 128_341),
    usageLine(at('09:03:05'), 47_716, 128_341), // re-emitted
  ].join('\n');
  assert.equal(tokensByDate(text).get(TODAY), 40_000 + 40_625 + 47_716);
});

test('tokensByDate: equal-sized consecutive responses, counter resets and total-less lines all count', () => {
  const text = [
    usageLine(at('10:00:00'), 5_000, 5_000),
    usageLine(at('10:01:00'), 5_000, 10_000), // same size, counter moved
    usageLine(at('10:02:00'), 3_000, 3_000),  // thread reloaded: counter restarted
    usageLine(at('10:03:00'), 700),           // no cumulative total on the line
    usageLine(at('10:04:00'), 700),           // …so an identical one still counts
  ].join('\n');
  assert.equal(tokensByDate(text).get(TODAY), 5_000 + 5_000 + 3_000 + 700 + 700);
});

test('tokensByDate: a re-emission across midnight is dropped, not moved to the next day', () => {
  const text = [
    usageLine(`${YESTERDAY}T23:59:50.000Z`, 900, 900),
    usageLine(`${TODAY}T00:00:05.000Z`, 900, 900), // re-emitted after midnight
    usageLine(`${TODAY}T00:01:00.000Z`, 100, 1_000),
  ].join('\n');
  const byDate = tokensByDate(text);
  assert.equal(byDate.get(YESTERDAY), 900);
  assert.equal(byDate.get(TODAY), 100);
});

test('CodexSessionScanner: re-emissions in a rollout file do not inflate today (and the floor stays a floor)', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codex-reemit-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, 'sessions', ...TODAY.split('-'));
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-08-30T09-00-00-aaaa.jsonl');
  await writeFile(file, [
    usageLine(at('09:00:00'), 1_000, 1_000),
    usageLine(at('09:00:10'), 1_000, 1_000), // re-emitted
    usageLine(at('09:05:00'), 2_000, 3_000),
  ].join('\n') + '\n');
  const scanner = new CodexSessionScanner({ codexHome: home });
  assert.equal(await scanner.todayTokens(NOW), 3_000);
  // The file grows by one more re-emission and one real response: still each once.
  await appendFile(file, [usageLine(at('09:05:20'), 2_000, 3_000), usageLine(at('09:06:00'), 500, 3_500)].join('\n') + '\n');
  assert.equal(await scanner.todayTokens(NOW), 3_500);
  // An API bucket that already holds the truth is not overridden by the local figure.
  const { today, todayEstimated } = overlayToday([{ startDate: TODAY, tokens: 3_600 }], 3_500, NOW);
  assert.equal(today, 3_600);
  assert.equal(todayEstimated, false);
});
