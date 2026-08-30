#!/usr/bin/env node
/**
 * Mock of `codex app-server` for tests.
 *
 * Speaks JSON-RPC 2.0 as newline-delimited JSON over stdio (one object per
 * line, no Content-Length framing), mirroring the real server's transport.
 *
 * Handshake rules emulated:
 *   - Until the handshake completes, any request other than `initialize`
 *     is answered with the JSON-RPC error {code: -32002, message: "not initialized"}.
 *   - `initialize` is answered with an empty result object.
 *   - The `initialized` notification (no id) completes the handshake; after
 *     it, `account/usage/read` is served.
 *   - `account/usage/read` echoes params.threadId back in `threadUsage`
 *     when given one; otherwise `threadUsage` is null.
 *
 * Behavior is switched with the MOCK_MODE environment variable:
 *   - "happy"     (default) normal behavior as above
 *   - "rpc-error" account/usage/read returns error {code: 401, message: "unauthorized"}
 *   - "hang"      account/usage/read is never answered (for timeout tests)
 *   - "garbage"   one non-JSON line is emitted before each valid response
 *
 * The process exits cleanly when stdin ends.
 */
import { createInterface } from 'node:readline';

// Not a test file: bare `node --test` discovery treats every file under a
// `test/` directory as a test and would leave this script waiting forever on
// stdin. Tests that spawn the mock deliberately always set MOCK_MODE, so a
// test-runner context (NODE_TEST_CONTEXT) without MOCK_MODE means accidental
// discovery — exit cleanly instead of hanging the suite.
if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.MOCK_MODE === undefined) {
  process.exit(0);
}

const MODE = process.env.MOCK_MODE ?? 'happy';

let initialized = false;

function send(msg) {
  if (MODE === 'garbage') {
    process.stdout.write('mock-app-server: this line is not JSON and must be skipped\n');
  }
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function usageResult(params) {
  const result = {
    summary: {
      lifetimeTokens: 12345678,
      peakDailyTokens: 987654,
      currentStreakDays: 5,
      longestStreakDays: 12,
      longestRunningTurnSec: 321,
    },
    dailyUsageBuckets: [
      { startDate: '2026-08-28', tokens: 111111 },
      { startDate: '2026-08-29', tokens: 222222 },
      { startDate: '2026-08-30', tokens: 54321 },
    ],
    threadUsage: null,
  };
  if (params && typeof params.threadId === 'string') {
    result.threadUsage = {
      threadId: params.threadId,
      estimatedUsageCreditsMicros: 2500000,
      estimatedUsageUsdMicros: 1234500,
      groups: [],
    };
  }
  return result;
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed input
  }
  const { id, method, params } = msg;

  // Notifications carry no id; only `initialized` matters here.
  if (id === undefined) {
    if (method === 'initialized') initialized = true;
    return;
  }

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (!initialized) {
    send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'not initialized' } });
    return;
  }

  if (method === 'account/usage/read') {
    if (MODE === 'hang') return; // never answer
    if (MODE === 'rpc-error') {
      send({ jsonrpc: '2.0', id, error: { code: 401, message: 'unauthorized' } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: usageResult(params) });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});

rl.on('close', () => {
  process.exit(0);
});
