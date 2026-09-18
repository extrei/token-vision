import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { extractUsageEntry, summarize, dedupeUsageEntries, readClaudeUsage } from '../src/claude-usage.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/claude-dir', import.meta.url));

// All streak-sensitive assertions use this fixed clock: "today" is 2026-08-30,
// "yesterday" is 2026-08-29 (the fixture's last active date).
const NOW = new Date('2026-08-30T12:00:00Z');

const line = (obj) => JSON.stringify(obj);

/** Shorthand for building summarize() input entries. */
function entry({ key = null, date, model = 'claude-opus-5', input = 0, output = 0, cacheCreation = 0, cacheRead = 0 }) {
  return { key, date, model, tokens: { input, output, cacheCreation, cacheRead } };
}

// --- extractUsageEntry -------------------------------------------------------

test('extractUsageEntry parses a valid assistant line with full key/date/model/token mapping', () => {
  const got = extractUsageEntry(line({
    type: 'assistant',
    uuid: 'u-1',
    requestId: 'req_x',
    timestamp: '2026-08-20T15:39:55.844Z',
    message: {
      id: 'msg_x',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 9213,
        cache_read_input_tokens: 17364,
        output_tokens: 437,
      },
    },
  }));
  assert.deepEqual(got, {
    key: 'msg_x:req_x',
    date: '2026-08-20',
    model: 'claude-opus-5',
    tokens: { input: 2, output: 437, cacheCreation: 9213, cacheRead: 17364 },
  });
});

test('extractUsageEntry rejects "<synthetic>" model lines', () => {
  const got = extractUsageEntry(line({
    type: 'assistant',
    uuid: 'u-syn',
    requestId: 'req_syn',
    timestamp: '2026-08-20T15:39:55.844Z',
    message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 5, output_tokens: 5 } },
  }));
  assert.equal(got, null);
});

test('extractUsageEntry rejects all-zero usage lines', () => {
  const got = extractUsageEntry(line({
    type: 'assistant',
    uuid: 'u-zero',
    requestId: 'req_zero',
    timestamp: '2026-08-20T15:39:55.844Z',
    message: {
      id: 'msg_zero',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  }));
  assert.equal(got, null);
});

test('extractUsageEntry rejects malformed JSON', () => {
  // Contains both "assistant" and "usage" so it survives the cheap substring
  // pre-filter and actually exercises the JSON.parse failure path.
  const got = extractUsageEntry('{"type":"assistant","message":{"usage":{"input_tokens":');
  assert.equal(got, null);
});

test('extractUsageEntry rejects non-assistant lines', () => {
  // The quoted "assistant"/"usage" substrings in the payload get the line past
  // the pre-filter, proving the d.type check itself does the rejecting.
  const got = extractUsageEntry(line({
    type: 'user',
    uuid: 'u-user',
    timestamp: '2026-08-20T15:39:55.844Z',
    note: 'assistant',
    message: { role: 'user', usage: { input_tokens: 5, output_tokens: 5 } },
  }));
  assert.equal(got, null);
});

test('extractUsageEntry falls back to uuid for the key when requestId is missing', () => {
  const got = extractUsageEntry(line({
    type: 'assistant',
    uuid: 'u-fallback',
    timestamp: '2026-08-21T00:00:00.000Z',
    message: { id: 'msg_d', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  assert.equal(got.key, 'u-fallback');
});

test('extractUsageEntry key is null when requestId and uuid are both missing', () => {
  const got = extractUsageEntry(line({
    type: 'assistant',
    timestamp: '2026-08-21T00:00:00.000Z',
    message: { id: 'msg_no_ids', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  assert.equal(got.key, null);
});

// --- summarize ---------------------------------------------------------------

test('summarize dedupes entries with the same key', () => {
  const dup = { key: 'msg_a:req_a', date: '2026-08-29', input: 10, output: 20 };
  const { summary } = summarize([entry(dup), entry(dup)], { now: NOW });
  assert.equal(summary.assistantMessages, 1);
  assert.equal(summary.lifetimeTokens, 30);
});

test('summarize counts every null-key entry, even identical ones', () => {
  const dup = { key: null, date: '2026-08-29', input: 10, output: 20 };
  const { summary } = summarize([entry(dup), entry(dup)], { now: NOW });
  assert.equal(summary.assistantMessages, 2);
  assert.equal(summary.lifetimeTokens, 60);
});

test('summarize sums daily buckets and sorts them ascending by date', () => {
  const report = summarize([
    entry({ key: 'k1', date: '2026-08-29', input: 100 }),
    entry({ key: 'k2', date: '2026-08-27', output: 7 }),
    entry({ key: 'k3', date: '2026-08-29', cacheRead: 50 }),
    entry({ key: 'k4', date: '2026-08-28', cacheCreation: 3 }),
  ], { now: NOW });
  assert.deepEqual(report.dailyUsageBuckets, [
    { startDate: '2026-08-27', tokens: 7 },
    { startDate: '2026-08-28', tokens: 3 },
    { startDate: '2026-08-29', tokens: 150 },
  ]);
  assert.equal(report.summary.peakDailyTokens, 150);
  assert.equal(report.summary.firstActivity, '2026-08-27');
  assert.equal(report.summary.lastActivity, '2026-08-29');
});

test('summarize computes current and longest streaks against a fixed now', () => {
  // Older 5-day run 08-20..08-24, gap, trailing 3-day run 08-27..08-29
  // (ends "yesterday" relative to NOW, so it counts as current).
  const dates = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24',
    '2026-08-27', '2026-08-28', '2026-08-29'];
  const { summary } = summarize(dates.map((date, i) => entry({ key: `k${i}`, date, input: 1 })), { now: NOW });
  assert.equal(summary.currentStreakDays, 3);
  assert.equal(summary.longestStreakDays, 5);
});

test('summarize trailing run ending today counts as current', () => {
  const { summary } = summarize([
    entry({ key: 'k1', date: '2026-08-29', input: 1 }),
    entry({ key: 'k2', date: '2026-08-30', input: 1 }),
  ], { now: NOW });
  assert.equal(summary.currentStreakDays, 2);
  assert.equal(summary.longestStreakDays, 2);
});

test('summarize currentStreakDays is null when last activity is older than yesterday', () => {
  const { summary } = summarize([
    entry({ key: 'k1', date: '2026-08-26', input: 1 }),
    entry({ key: 'k2', date: '2026-08-27', input: 1 }),
    entry({ key: 'k3', date: '2026-08-28', input: 1 }), // two days before NOW
  ], { now: NOW });
  assert.equal(summary.currentStreakDays, null);
  assert.equal(summary.longestStreakDays, 3);
});

test('summarize orders modelBreakdown by tokens descending', () => {
  const report = summarize([
    entry({ key: 'k1', date: '2026-08-29', model: 'claude-sonnet-5', input: 10 }),
    entry({ key: 'k2', date: '2026-08-29', model: 'claude-opus-5', input: 500 }),
    entry({ key: 'k3', date: '2026-08-29', model: 'claude-sonnet-5', output: 30 }),
    entry({ key: 'k4', date: '2026-08-29', model: 'claude-haiku-4', output: 100 }),
  ], { now: NOW });
  assert.deepEqual(report.modelBreakdown, [
    { model: 'claude-opus-5', tokens: 500, messages: 1 },
    { model: 'claude-haiku-4', tokens: 100, messages: 1 },
    { model: 'claude-sonnet-5', tokens: 40, messages: 2 },
  ]);
});

test('summarize of no entries reports zero lifetime tokens and null peak/streaks', () => {
  const report = summarize([], { now: NOW });
  assert.deepEqual(report, {
    summary: {
      lifetimeTokens: 0,
      peakDailyTokens: null,
      currentStreakDays: null,
      longestStreakDays: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      assistantMessages: 0,
      firstActivity: null,
      lastActivity: null,
    },
    dailyUsageBuckets: [],
    modelBreakdown: [],
  });
});

// --- readClaudeUsage (end-to-end against test/fixtures/claude-dir) -----------
//
// Hand-computed expectations. Counted entries (dup counted once):
//   msg_a1  08-20 opus    100+400+200+300     = 1,000
//   msg_dup 08-21 opus    10+40+20+30         =   100   (in session1 AND session2)
//   msg_c   08-22 sonnet  1+4+2+3             =    10
//   msg_d   08-23 sonnet  5+5+5+5             =    20   (no requestId → uuid key)
//   msg_e   08-24 opus    50+50+50+50         =   200
//   msg_f   08-27 opus    1000+4000+2000+3000 = 10,000
//   msg_g   08-28 sonnet  100+100+100+100     =   400
//   msg_h   08-29 sonnet  200+200+200+200     =   800
//   msg_agent_x 08-28 sonnet 1000+1000+1000+2000 = 5,000
//     (nested subagent transcript at proj-a/some-session-id/subagents/agent-x.jsonl)
// Rejected: synthetic, all-zero, malformed JSON, user line, notes.txt,
// and projects/orphan.jsonl (plain file, not inside a project dir).

test('readClaudeUsage aggregates the fixture dir exactly', async () => {
  const report = await readClaudeUsage({ claudeDir: FIXTURE_DIR, now: NOW });
  assert.deepEqual(report, {
    summary: {
      lifetimeTokens: 17530,
      peakDailyTokens: 10000,
      currentStreakDays: 3,
      longestStreakDays: 5,
      inputTokens: 2466,
      outputTokens: 5799,
      cacheCreationTokens: 3577,
      cacheReadTokens: 5688,
      assistantMessages: 9,
      firstActivity: '2026-08-20',
      lastActivity: '2026-08-29',
    },
    dailyUsageBuckets: [
      { startDate: '2026-08-20', tokens: 1000 },
      { startDate: '2026-08-21', tokens: 100 },
      { startDate: '2026-08-22', tokens: 10 },
      { startDate: '2026-08-23', tokens: 20 },
      { startDate: '2026-08-24', tokens: 200 },
      { startDate: '2026-08-27', tokens: 10000 },
      { startDate: '2026-08-28', tokens: 5400 },
      { startDate: '2026-08-29', tokens: 800 },
    ],
    modelBreakdown: [
      { model: 'claude-opus-5', tokens: 11300, messages: 4 },
      { model: 'claude-sonnet-5', tokens: 6230, messages: 5 },
    ],
  });
});

test('readClaudeUsage picks up nested subagent transcripts (proj-a/some-session-id/subagents/agent-x.jsonl)', async () => {
  // Regression guard: transcript scanning was once one-level-deep and silently
  // missed projects/<project>/<session>/subagents/agent-*.jsonl files. The
  // nested fixture holds a single 5,000-token 08-28 message; the flat fixture
  // files contribute 400 to that day, so 5,400 proves the nested file counted.
  const report = await readClaudeUsage({ claudeDir: FIXTURE_DIR, now: NOW });
  const bucket = report.dailyUsageBuckets.find((b) => b.startDate === '2026-08-28');
  assert.deepEqual(bucket, { startDate: '2026-08-28', tokens: 5400 });
});

test('readClaudeUsage on a nonexistent claudeDir yields a zero-usage report without throwing', async () => {
  const report = await readClaudeUsage({
    claudeDir: `${FIXTURE_DIR}-does-not-exist`,
    now: NOW,
  });
  assert.equal(report.summary.lifetimeTokens, 0);
  assert.equal(report.summary.assistantMessages, 0);
  assert.equal(report.summary.peakDailyTokens, null);
  assert.equal(report.summary.currentStreakDays, null);
  assert.equal(report.summary.longestStreakDays, null);
  assert.deepEqual(report.dailyUsageBuckets, []);
  assert.deepEqual(report.modelBreakdown, []);
});

// --- one response, several transcript lines -----------------------------------

test('summarize keeps the largest snapshot of a response, not the first (message_start placeholder)', () => {
  // One API response written as three lines (one per content block): input and
  // cache numbers are final from the start, output_tokens only on the last.
  const snap = (output) => entry({ key: 'msg_1:req_1', date: '2026-08-29', input: 3, cacheRead: 20_000, output });
  const report = summarize([snap(1), snap(500), snap(12_345)], { now: NOW });
  assert.equal(report.summary.assistantMessages, 1);
  assert.equal(report.summary.outputTokens, 12_345);
  assert.equal(report.summary.inputTokens, 3);
  assert.equal(report.summary.cacheReadTokens, 20_000);
  assert.equal(report.summary.lifetimeTokens, 3 + 20_000 + 12_345);
  assert.deepEqual(report.modelBreakdown, [{ model: 'claude-opus-5', tokens: 32_348, messages: 1 }]);
});

test('summarize: the largest snapshot wins whatever order the lines are scanned in', () => {
  // Resumed / forked sessions copy a response's lines into other files, so the
  // final snapshot can be seen before an earlier one.
  const snap = (output) => entry({ key: 'msg_1:req_1', date: '2026-08-29', input: 3, output });
  for (const order of [[1, 500, 900], [900, 1, 500], [500, 900, 1], [900, 900, 900]]) {
    assert.equal(summarize(order.map(snap), { now: NOW }).summary.outputTokens, 900, `order ${order}`);
  }
});

test('summarize: day and model come from the snapshot that is kept', () => {
  const report = summarize([
    entry({ key: 'k', date: '2026-08-28', model: 'claude-opus-5', output: 1 }),
    entry({ key: 'k', date: '2026-08-29', model: 'claude-opus-5', output: 700 }),
    entry({ key: 'other', date: '2026-08-28', model: 'claude-haiku-4-5', output: 40 }),
  ], { now: NOW });
  assert.deepEqual(report.dailyUsageBuckets, [
    { startDate: '2026-08-28', tokens: 40 },
    { startDate: '2026-08-29', tokens: 700 },
  ]);
  assert.equal(report.summary.assistantMessages, 2);
});

test('dedupeUsageEntries: one entry per key (first-seen order), every unkeyed entry kept', () => {
  const a1 = entry({ key: 'a', date: '2026-08-29', output: 1 });
  const a2 = entry({ key: 'a', date: '2026-08-29', output: 50 });
  const b = entry({ key: 'b', date: '2026-08-29', output: 7 });
  const n1 = entry({ date: '2026-08-29', output: 2 });
  const n2 = entry({ date: '2026-08-29', output: 2 });
  assert.deepEqual(dedupeUsageEntries([a1, n1, b, a2, n2]), [n1, n2, a2, b]);
  assert.deepEqual(dedupeUsageEntries([]), []);
});

test('end to end: transcript lines of one response collapse to its final usage', () => {
  const block = (uuid, output) => line({
    type: 'assistant', uuid, requestId: 'req_9', timestamp: '2026-08-29T10:00:00.000Z',
    message: { id: 'msg_9', model: 'claude-opus-5',
      usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 9_000, output_tokens: output } },
  });
  const entries = [block('u1', 1), block('u2', 1), block('u3', 2_048)].map((l) => extractUsageEntry(l));
  const report = summarize(entries, { now: NOW });
  assert.equal(report.summary.assistantMessages, 1);
  assert.equal(report.summary.outputTokens, 2_048);
  assert.equal(report.summary.lifetimeTokens, 4 + 100 + 9_000 + 2_048);
});
