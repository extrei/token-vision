import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { formatClaudeUsage } from '../src/read-claude-usage.js';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const usageFixture = () => ({
  summary: {
    lifetimeTokens: 12345678,
    peakDailyTokens: 987654,
    currentStreakDays: 3,
    longestStreakDays: 12,
    inputTokens: 1466,
    outputTokens: 4799,
    cacheCreationTokens: 2577,
    cacheReadTokens: 3688,
    assistantMessages: 42,
    firstActivity: '2026-08-20',
    lastActivity: '2026-08-29',
  },
  dailyUsageBuckets: [
    { startDate: '2026-08-25', tokens: 1000 },
    { startDate: '2026-08-26', tokens: 2000 },
    { startDate: '2026-08-27', tokens: 3000 },
    { startDate: '2026-08-28', tokens: 4000 },
    { startDate: '2026-08-29', tokens: 5000 },
  ],
  modelBreakdown: [
    { model: 'claude-opus-5', tokens: 11300, messages: 4 },
    { model: 'claude-sonnet-5', tokens: 1230, messages: 2 },
  ],
});

test('formatClaudeUsage renders numbers with thousands separators', () => {
  const out = formatClaudeUsage(usageFixture());
  assert.match(out, /lifetime tokens:\s+12,345,678/);
  assert.match(out, /peak daily tokens:\s+987,654/);
  assert.match(out, /input \/ output:\s+1,466 \/ 4,799/);
  assert.match(out, /cache write \/ read:\s+2,577 \/ 3,688/);
  assert.match(out, /2026-08-29\s+5,000 tokens/);
});

test('formatClaudeUsage shows an em dash for null values', () => {
  const out = formatClaudeUsage({
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
  assert.match(out, /peak daily tokens:\s+—/);
  assert.match(out, /current streak:\s+— day\(s\)/);
  assert.match(out, /longest streak:\s+— day\(s\)/);
  assert.match(out, /active:\s+— → —/);
  // No buckets / models → those sections are omitted entirely.
  assert.doesNotMatch(out, /Daily usage/);
  assert.doesNotMatch(out, /By model/);
});

test('formatClaudeUsage {days} keeps only the LAST n daily buckets', () => {
  const out = formatClaudeUsage(usageFixture(), { days: 2 });
  assert.match(out, /Daily usage \(last 2 of 5 active days\):/);
  assert.match(out, /2026-08-28\s+4,000 tokens/);
  assert.match(out, /2026-08-29\s+5,000 tokens/);
  assert.doesNotMatch(out, /2026-08-25/);
  assert.doesNotMatch(out, /2026-08-26/);
  assert.doesNotMatch(out, /2026-08-27/);
});

test('formatClaudeUsage lists every model with tokens and message counts', () => {
  const out = formatClaudeUsage(usageFixture());
  assert.match(out, /By model:/);
  assert.match(out, /claude-opus-5\s+11,300 tokens \(4 messages\)/);
  assert.match(out, /claude-sonnet-5\s+1,230 tokens \(2 messages\)/);
});

test('CLI --json --claude-dir prints the fixture report as JSON', async () => {
  const { stdout } = await execFileP(
    process.execPath,
    ['src/read-claude-usage.js', '--json', '--claude-dir', 'test/fixtures/claude-dir'],
    { cwd: ROOT },
  );
  const report = JSON.parse(stdout);
  // The CLI runs with the real clock, so only assert now-independent fields
  // (streaks depend on today's date).
  assert.equal(report.summary.lifetimeTokens, 17530);
  assert.equal(report.summary.peakDailyTokens, 10000);
  assert.equal(report.summary.inputTokens, 2466);
  assert.equal(report.summary.outputTokens, 5799);
  assert.equal(report.summary.cacheCreationTokens, 3577);
  assert.equal(report.summary.cacheReadTokens, 5688);
  assert.equal(report.summary.assistantMessages, 9);
  assert.equal(report.summary.firstActivity, '2026-08-20');
  assert.equal(report.summary.lastActivity, '2026-08-29');
  assert.deepEqual(report.dailyUsageBuckets, [
    { startDate: '2026-08-20', tokens: 1000 },
    { startDate: '2026-08-21', tokens: 100 },
    { startDate: '2026-08-22', tokens: 10 },
    { startDate: '2026-08-23', tokens: 20 },
    { startDate: '2026-08-24', tokens: 200 },
    { startDate: '2026-08-27', tokens: 10000 },
    { startDate: '2026-08-28', tokens: 5400 },
    { startDate: '2026-08-29', tokens: 800 },
  ]);
  assert.deepEqual(report.modelBreakdown, [
    { model: 'claude-opus-5', tokens: 11300, messages: 4 },
    { model: 'claude-sonnet-5', tokens: 6230, messages: 5 },
  ]);
});
