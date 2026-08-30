import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/app-server-client.js';

const MOCK = fileURLToPath(new URL('./fixtures/mock-app-server.js', import.meta.url));

function startClient({ mode, timeoutMs = 5000 } = {}) {
  return new AppServerClient({
    command: process.execPath,
    args: [MOCK],
    env: { ...process.env, MOCK_MODE: mode ?? 'happy' },
    timeoutMs,
  }).start();
}

test('happy path: initialize then readAccountUsage returns the fixture', async () => {
  const client = startClient();
  try {
    const init = await client.initialize();
    assert.deepEqual(init, {});
    const usage = await client.readAccountUsage();
    assert.deepEqual(usage.summary, {
      lifetimeTokens: 12345678,
      peakDailyTokens: 987654,
      currentStreakDays: 5,
      longestStreakDays: 12,
      longestRunningTurnSec: 321,
    });
    assert.equal(usage.dailyUsageBuckets.length, 3);
    assert.deepEqual(usage.dailyUsageBuckets[0], { startDate: '2026-08-28', tokens: 111111 });
    assert.equal(usage.threadUsage, null);
  } finally {
    await client.close();
  }
});

test('threadId is passed through and threadUsage comes back', async () => {
  const client = startClient();
  try {
    await client.initialize();
    const usage = await client.readAccountUsage({ threadId: 'thread-abc-123' });
    assert.ok(usage.threadUsage, 'expected threadUsage to be present');
    assert.equal(usage.threadUsage.threadId, 'thread-abc-123');
    assert.equal(usage.threadUsage.estimatedUsageCreditsMicros, 2500000);
    assert.equal(usage.threadUsage.estimatedUsageUsdMicros, 1234500);
    assert.deepEqual(usage.threadUsage.groups, []);
  } finally {
    await client.close();
  }
});

test('JSON-RPC error response rejects with .code === 401', async () => {
  const client = startClient({ mode: 'rpc-error' });
  try {
    await client.initialize();
    await assert.rejects(client.readAccountUsage(), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 401);
      assert.match(err.message, /unauthorized/);
      return true;
    });
  } finally {
    await client.close();
  }
});

test('request before initialize rejects with .code === -32002', async () => {
  const client = startClient();
  try {
    await assert.rejects(client.request('account/usage/read', {}), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, -32002);
      assert.match(err.message, /not initialized/);
      return true;
    });
  } finally {
    await client.close();
  }
});

test('timeout: hung account/usage/read rejects with a "timed out" message', async () => {
  const client = startClient({ mode: 'hang', timeoutMs: 200 });
  try {
    await client.initialize();
    await assert.rejects(client.readAccountUsage(), /timed out/);
  } finally {
    await client.close();
  }
});

test('garbage lines on stdout are skipped and the call still succeeds', async () => {
  const client = startClient({ mode: 'garbage' });
  try {
    await client.initialize();
    const usage = await client.readAccountUsage({ threadId: 't-garbage' });
    assert.equal(usage.summary.lifetimeTokens, 12345678);
    assert.equal(usage.threadUsage.threadId, 't-garbage');
  } finally {
    await client.close();
  }
});

test('child exit while a request is pending rejects the pending promise', async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: ['-e', ''], // exits immediately without answering anything
    timeoutMs: 5000,
  }).start();
  try {
    await assert.rejects(
      client.request('account/usage/read', {}),
      /exited|not running/,
    );
  } finally {
    await client.close();
  }
});
