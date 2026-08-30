import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  USAGE_URL,
  getClaudeOAuthToken,
  normalizeLimits,
  fetchClaudeLimits,
} from '../src/claude-limits.js';
import { renderFrame, buildSnapshot } from '../src/live.js';

const NOW = new Date('2026-08-30T12:00:00Z');

// ---------------------------------------------------------------- normalizeLimits

test('normalizeLimits: realistic payload → ordered, renamed, rounded windows', () => {
  const raw = {
    five_hour: { utilization: 33.4, resets_at: '2026-08-30T15:00:00Z' },
    seven_day: { utilization: 52, resets_at: '2026-09-03T00:00:00Z' },
    seven_day_opus: { utilization: 12, resets_at: null },
    some_new_window: { utilization: 5 },
    junk: 'string',
    count: 7,
    nested_no_util: { foo: 1 },
  };
  assert.deepEqual(normalizeLimits(raw), [
    { name: 'session', usedPercent: 33, resetsAt: '2026-08-30T15:00:00Z' },
    { name: 'weekly', usedPercent: 52, resetsAt: '2026-09-03T00:00:00Z' },
    { name: 'weekly opus', usedPercent: 12, resetsAt: null },
    { name: 'some new window', usedPercent: 5, resetsAt: null },
  ]);
});

test('normalizeLimits: camelCase resetsAt is used when resets_at is absent', () => {
  assert.deepEqual(normalizeLimits({ five_hour: { utilization: 10, resetsAt: '2026-08-30T17:00:00Z' } }), [
    { name: 'session', usedPercent: 10, resetsAt: '2026-08-30T17:00:00Z' },
  ]);
});

test('normalizeLimits: non-object raw → []', () => {
  assert.deepEqual(normalizeLimits(null), []);
  assert.deepEqual(normalizeLimits(undefined), []);
  assert.deepEqual(normalizeLimits('x'), []);
});

// ---------------------------------------------------------------- fetchClaudeLimits

test('fetchClaudeLimits: sends bearer + beta headers to USAGE_URL and normalizes windows', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 41.6, resets_at: '2026-08-30T15:00:00Z' } }),
    };
  };
  const result = await fetchClaudeLimits({ token: 'test-token', fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, USAGE_URL);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-token');
  assert.ok(calls[0].opts.headers['anthropic-beta']);
  assert.deepEqual(result, {
    windows: [{ name: 'session', usedPercent: 42, resetsAt: '2026-08-30T15:00:00Z' }],
  });
});

test('fetchClaudeLimits: 401 → auth expired error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(fetchClaudeLimits({ token: 't', fetchImpl }), /auth expired/);
});

test('fetchClaudeLimits: other non-ok status → HTTP status error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(fetchClaudeLimits({ token: 't', fetchImpl }), /HTTP 500/);
});

// ---------------------------------------------------------------- getClaudeOAuthToken

/** Fresh temp dir removed after the test. */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('getClaudeOAuthToken: env var wins over everything', async () => {
  const token = await getClaudeOAuthToken({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-env' },
    credentialsPath: '/nonexistent',
    keychain: false,
  });
  assert.equal(token, 'tok-env');
});

test('getClaudeOAuthToken: reads claudeAiOauth.accessToken from credentials file', async (t) => {
  const dir = await tempDir(t);
  const credentialsPath = join(dir, '.credentials.json');
  await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-file' } }));
  const token = await getClaudeOAuthToken({ env: {}, credentialsPath, keychain: false });
  assert.equal(token, 'tok-file');
});

test('getClaudeOAuthToken: reads top-level accessToken from credentials file', async (t) => {
  const dir = await tempDir(t);
  const credentialsPath = join(dir, '.credentials.json');
  await writeFile(credentialsPath, JSON.stringify({ accessToken: 'tok-flat' }));
  const token = await getClaudeOAuthToken({ env: {}, credentialsPath, keychain: false });
  assert.equal(token, 'tok-flat');
});

test('getClaudeOAuthToken: no env, no file, no keychain → throws', async () => {
  await assert.rejects(
    getClaudeOAuthToken({ env: {}, credentialsPath: '/nonexistent/creds.json', keychain: false }),
    /no Claude Code OAuth token/,
  );
});

// ---------------------------------------------------------------- renderFrame integration

const claudeState = (limits) => ({
  summary: {},
  today: 0,
  daily: [],
  perMinute: 0,
  perFiveMinutes: 0,
  ...(limits !== undefined && { limits }),
});

test('renderFrame: renders limit windows with name, percent, and reset label', () => {
  const out = renderFrame({
    now: NOW,
    ansi: false,
    claude: claudeState({
      windows: [
        { name: 'session', usedPercent: 33, resetsAt: '2026-08-30T15:00:00Z' },
        { name: 'weekly', usedPercent: 52, resetsAt: 1788654834 },
      ],
    }),
  });
  assert.ok(out.includes('session'));
  assert.ok(out.includes('33%'));
  assert.ok(out.includes('weekly'));
  assert.ok(out.includes('52%'));
  assert.ok(out.includes('resets'));
});

test('renderFrame: limits error renders a dim unavailable row', () => {
  const out = renderFrame({ now: NOW, ansi: false, claude: claudeState({ error: 'boom' }) });
  assert.ok(out.includes('unavailable: boom'));
});

test('renderFrame: no limits → no limit or unavailable lines', () => {
  const out = renderFrame({ now: NOW, ansi: false, claude: claudeState() });
  assert.ok(!out.includes('session'));
  assert.ok(!out.includes('unavailable'));
});

// ---------------------------------------------------------------- buildSnapshot integration

test('buildSnapshot: includes claude.limits when windows are non-empty', () => {
  const windows = [{ name: 'session', usedPercent: 33, resetsAt: '2026-08-30T15:00:00Z' }];
  const snapshot = buildSnapshot({ now: NOW, claude: claudeState({ windows }) });
  assert.deepEqual(snapshot.claude.limits, windows);
});

test('buildSnapshot: omits claude.limits when windows are empty or limits absent', () => {
  const empty = buildSnapshot({ now: NOW, claude: claudeState({ windows: [] }) });
  assert.ok(!('limits' in empty.claude));
  const absent = buildSnapshot({ now: NOW, claude: claudeState() });
  assert.ok(!('limits' in absent.claude));
});
