import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { formatUsage, readUsage } from '../src/read-usage.js';

const MOCK = fileURLToPath(new URL('./fixtures/mock-app-server.js', import.meta.url));

// readUsage() has no env option, so the mock inherits this process's env.
// Setting MOCK_MODE marks the spawn as deliberate for the mock's discovery
// guard (see mock-app-server.js) and pins the default happy-path behavior.
process.env.MOCK_MODE = 'happy';

test('formatUsage formats lifetime tokens with thousands separators', () => {
  const out = formatUsage({
    summary: {
      lifetimeTokens: 12345678,
      peakDailyTokens: 987654,
      currentStreakDays: 5,
      longestStreakDays: 12,
      longestRunningTurnSec: 321,
    },
  });
  assert.match(out, /lifetime tokens:\s+12,345,678/);
  assert.match(out, /peak daily tokens:\s+987,654/);
});

test('formatUsage shows an em dash for null values', () => {
  const out = formatUsage({
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null,
      longestStreakDays: null,
      longestRunningTurnSec: null,
    },
  });
  assert.match(out, /lifetime tokens:\s+—/);
  assert.match(out, /peak daily tokens:\s+—/);
  assert.match(out, /current streak:\s+— day\(s\)/);
  assert.match(out, /longest turn:\s+— s/);
});

test('formatUsage renders daily usage buckets', () => {
  const out = formatUsage({
    summary: {},
    dailyUsageBuckets: [
      { startDate: '2026-08-28', tokens: 111111 },
      { startDate: '2026-08-29', tokens: 222222 },
    ],
  });
  assert.match(out, /Daily usage:/);
  assert.match(out, /2026-08-28\s+111,111 tokens/);
  assert.match(out, /2026-08-29\s+222,222 tokens/);
});

test('formatUsage omits the daily section when buckets are null or empty', () => {
  assert.doesNotMatch(formatUsage({ summary: {}, dailyUsageBuckets: null }), /Daily usage:/);
  assert.doesNotMatch(formatUsage({ summary: {}, dailyUsageBuckets: [] }), /Daily usage:/);
});

test('formatUsage converts threadUsage USD micros to dollars', () => {
  const out = formatUsage({
    summary: {},
    threadUsage: {
      threadId: 'thread-abc-123',
      estimatedUsageCreditsMicros: 2500000,
      estimatedUsageUsdMicros: 1234500,
      groups: [],
    },
  });
  assert.match(out, /Thread thread-abc-123:/);
  assert.match(out, /estimated credits \(micro\):\s+2,500,000/);
  assert.match(out, /estimated USD:\s+\$1\.2345/);
});

test('formatUsage skips the USD line when estimatedUsageUsdMicros is null', () => {
  const out = formatUsage({
    summary: {},
    threadUsage: {
      threadId: 't-1',
      estimatedUsageCreditsMicros: 42,
      estimatedUsageUsdMicros: null,
      groups: [],
    },
  });
  assert.match(out, /Thread t-1:/);
  assert.doesNotMatch(out, /estimated USD/);
});

test('readUsage returns the fixture end-to-end against the mock server', async () => {
  const usage = await readUsage({ command: process.execPath, args: [MOCK] });
  assert.deepEqual(usage.summary, {
    lifetimeTokens: 12345678,
    peakDailyTokens: 987654,
    currentStreakDays: 5,
    longestStreakDays: 12,
    longestRunningTurnSec: 321,
  });
  assert.equal(usage.dailyUsageBuckets.length, 3);
  assert.equal(usage.threadUsage, null);
});
