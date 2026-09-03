import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  USAGE_URL,
  USAGE_USER_AGENT,
  getClaudeOAuthToken,
  normalizeLimits,
  fetchClaudeLimits,
  reduceLimitsState,
  limitsCachePath,
  readCachedLimits,
  writeCachedLimits,
  isRetryableLimitsError,
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


// ---------------------------------------------------------------- User-Agent

test('fetchClaudeLimits: sends the claude-cli User-Agent the endpoint expects', async () => {
  let seen;
  const fetchImpl = async (_url, opts) => {
    seen = opts.headers['User-Agent'];
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await fetchClaudeLimits({ token: 't', fetchImpl });
  assert.equal(seen, USAGE_USER_AGENT);
  assert.match(seen, /claude-cli/);
});

// ---------------------------------------------------------------- isRetryableLimitsError

test('isRetryableLimitsError: 429 / 5xx / rate-limit are retryable; 401 and unknown are not', () => {
  assert.equal(isRetryableLimitsError(new Error('usage endpoint HTTP 429')), true);
  assert.equal(isRetryableLimitsError(new Error('usage endpoint HTTP 503')), true);
  assert.equal(isRetryableLimitsError(new Error('Rate limited. try later')), true);
  assert.equal(isRetryableLimitsError(new Error('auth expired — open claude to refresh')), false);
  assert.equal(isRetryableLimitsError(new Error('usage endpoint HTTP 400')), false);
  assert.equal(isRetryableLimitsError('HTTP 429'), true);
});

// ---------------------------------------------------------------- disk cache

test('limitsCachePath: honours XDG_CACHE_HOME', () => {
  const p = limitsCachePath();
  assert.ok(p.endsWith('/token-vision/claude-limits.json'));
});

test('writeCachedLimits / readCachedLimits: round-trips windows + fetchedAt', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'cache.json');
  const windows = [{ name: 'session', usedPercent: 33, resetsAt: '2026-08-30T15:00:00Z' }];
  await writeCachedLimits(windows, { path, fetchedAt: 1788654834000 });
  assert.deepEqual(await readCachedLimits({ path }), { windows, fetchedAt: 1788654834000 });
});

test('writeCachedLimits: does not write empty windows', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'cache.json');
  await writeCachedLimits([], { path });
  assert.equal(await readCachedLimits({ path }), null);
});

test('readCachedLimits: missing or corrupt cache → null', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await readCachedLimits({ path: join(dir, 'nope.json') }), null);
  const corrupt = join(dir, 'corrupt.json');
  await writeFile(corrupt, '{ not json');
  assert.equal(await readCachedLimits({ path: corrupt }), null);
  const noWindows = join(dir, 'nowin.json');
  await writeFile(noWindows, JSON.stringify({ fetchedAt: 1 }));
  assert.equal(await readCachedLimits({ path: noWindows }), null);
});

// ---------------------------------------------------------------- buildSnapshot staleness

test('buildSnapshot: carries limitsAsOf + limitsStale for stale (cached) windows', () => {
  const windows = [{ name: 'session', usedPercent: 33, resetsAt: null }];
  const snap = buildSnapshot({
    now: NOW,
    claude: claudeState({ windows, fetchedAt: 1788654834000, stale: true }),
  });
  assert.deepEqual(snap.claude.limits, windows);
  assert.equal(snap.claude.limitsAsOf, 1788654834000);
  assert.equal(snap.claude.limitsStale, true);
});

test('buildSnapshot: fresh windows carry limitsAsOf but no stale flag', () => {
  const windows = [{ name: 'session', usedPercent: 5, resetsAt: null }];
  const snap = buildSnapshot({ now: NOW, claude: claudeState({ windows, fetchedAt: 123456 }) });
  assert.equal(snap.claude.limitsAsOf, 123456);
  assert.ok(!('limitsStale' in snap.claude));
});

test('buildSnapshot: empty windows with an error emit limitsError, not limits', () => {
  const snap = buildSnapshot({ now: NOW, claude: claudeState({ error: 'usage endpoint HTTP 429' }) });
  assert.ok(!('limits' in snap.claude));
  assert.equal(snap.claude.limitsError, 'usage endpoint HTTP 429');
});

test('buildSnapshot: stale windows carry the error reason (so 401 != "rate limited")', () => {
  const windows = [{ name: 'session', usedPercent: 9, resetsAt: null }];
  const snap = buildSnapshot({
    now: NOW,
    claude: claudeState({ windows, stale: true, error: 'auth expired — open claude to refresh' }),
  });
  assert.equal(snap.claude.limitsStale, true);
  assert.equal(snap.claude.limitsError, 'auth expired — open claude to refresh');
});

test('buildSnapshot: fresh (non-stale) windows never emit limitsError', () => {
  const windows = [{ name: 'session', usedPercent: 9, resetsAt: null }];
  const snap = buildSnapshot({ now: NOW, claude: claudeState({ windows, error: 'boom' }) });
  assert.ok(!('limitsError' in snap.claude));
  assert.ok(!('limitsStale' in snap.claude));
});


// ---------------------------------------------------------------- reduceLimitsState

const RS_OPTS = { now: 1000, baseMs: 150_000, maxBackoffMs: 900_000 };
const emptyState = { last: null, fails: 0, nextAt: 0 };
const goodState = {
  last: { windows: [{ name: 'session', usedPercent: 33, resetsAt: null }], fetchedAt: 500 },
  fails: 0,
  nextAt: 0,
};

test('reduceLimitsState: success stores last-good, resets fails, frees the cadence, and caches', () => {
  const windows = [{ name: 'session', usedPercent: 40, resetsAt: null }];
  const r = reduceLimitsState(emptyState, { ok: true, windows }, RS_OPTS);
  assert.deepEqual(r.state, { last: { windows, fetchedAt: 1000 }, fails: 0, nextAt: 0 });
  assert.deepEqual(r.limits, { windows, fetchedAt: 1000 });
  assert.deepEqual(r.cache, windows);
});

test('reduceLimitsState: empty 200 does NOT clobber last-good; shows it stale; no cache write', () => {
  const r = reduceLimitsState(goodState, { ok: true, windows: [] }, RS_OPTS);
  assert.deepEqual(r.state.last, goodState.last); // preserved
  assert.equal(r.state.nextAt, 0);
  assert.deepEqual(r.limits.windows, goodState.last.windows);
  assert.equal(r.limits.stale, true);
  assert.equal(r.cache, null);
});

test('reduceLimitsState: empty 200 with no prior data → error, still no clobber', () => {
  const r = reduceLimitsState(emptyState, { ok: true, windows: [] }, RS_OPTS);
  assert.equal(r.state.last, null);
  assert.equal(r.limits.error, 'no limit windows returned');
  assert.ok(!('windows' in r.limits));
});

test('reduceLimitsState: retryable failure keeps last-good stale and backs off exponentially', () => {
  const r1 = reduceLimitsState(goodState, { ok: false, error: new Error('usage endpoint HTTP 429') }, RS_OPTS);
  assert.deepEqual(r1.state.last, goodState.last);
  assert.equal(r1.state.fails, 1);
  assert.equal(r1.state.nextAt, 1000 + 150_000); // base * 2^0
  assert.equal(r1.limits.stale, true);
  assert.match(r1.limits.error, /429/);
  const r2 = reduceLimitsState(r1.state, { ok: false, error: new Error('HTTP 429') }, RS_OPTS);
  assert.equal(r2.state.fails, 2);
  assert.equal(r2.state.nextAt, 1000 + 300_000); // base * 2^1
});

test('reduceLimitsState: backoff is capped at maxBackoffMs', () => {
  const many = { last: goodState.last, fails: 20, nextAt: 0 };
  const r = reduceLimitsState(many, { ok: false, error: new Error('HTTP 503') }, RS_OPTS);
  assert.equal(r.state.nextAt, 1000 + 900_000); // capped
});

test('reduceLimitsState: non-retryable failure (401) uses base interval, not exponential', () => {
  const r = reduceLimitsState(goodState, { ok: false, error: new Error('auth expired — open claude to refresh') }, RS_OPTS);
  assert.equal(r.state.nextAt, 1000 + 150_000);
  assert.equal(r.limits.stale, true);
  assert.match(r.limits.error, /auth expired/);
});

test('reduceLimitsState: failure with no prior data → error object, no stale windows', () => {
  const r = reduceLimitsState(emptyState, { ok: false, error: new Error('HTTP 429') }, RS_OPTS);
  assert.equal(r.state.last, null);
  assert.match(r.limits.error, /429/);
  assert.ok(!('windows' in r.limits));
});
