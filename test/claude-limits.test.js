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
  pickDesktopSample,
  readDesktopPlanUsage,
  readClaudeCodeOrg,
  overlayDesktopUsage,
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

test('normalizeLimits: limits[] names the model-scoped weekly window; placeholder keys are dropped', () => {
  const raw = {
    five_hour: { utilization: 11, resets_at: '2026-09-23T12:00:00Z' },
    seven_day: { utilization: 22, resets_at: '2026-09-26T08:00:00Z' },
    seven_day_opus: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    limits: [
      { kind: 'session', percent: 11, resets_at: '2026-09-23T12:00:00Z', scope: null },
      { kind: 'weekly_all', percent: 22, resets_at: '2026-09-26T08:00:00Z', scope: null },
      { kind: 'weekly_scoped', percent: 38, resets_at: '2026-09-26T08:00:01Z', scope: { model: { id: null, display_name: 'Fable' } } },
    ],
  };
  assert.deepEqual(normalizeLimits(raw), [
    { name: 'session', usedPercent: 11, resetsAt: '2026-09-23T12:00:00Z' },
    { name: 'weekly', usedPercent: 22, resetsAt: '2026-09-26T08:00:00Z' },
    { name: 'weekly fable', usedPercent: 38, resetsAt: '2026-09-26T08:00:01Z' },
  ]);
});

test('normalizeLimits: locked_reason or an unrecognised severity marks a window spent; warning does not', () => {
  const raw = {
    limits: [
      { kind: 'session', percent: 100, resets_at: null, severity: 'exceeded', locked_reason: null },
      { kind: 'weekly_all', percent: 76, resets_at: null, severity: 'warning', locked_reason: null },
      { kind: 'weekly_scoped', percent: 40, resets_at: null, severity: 'normal', locked_reason: 'org_cap',
        scope: { model: { display_name: 'Fable' } } },
    ],
  };
  assert.deepEqual(normalizeLimits(raw), [
    { name: 'session', usedPercent: 100, resetsAt: null, spent: true },
    { name: 'weekly', usedPercent: 76, resetsAt: null },
    { name: 'weekly fable', usedPercent: 40, resetsAt: null, spent: true },
  ]);
  assert.deepEqual(normalizeLimits({ five_hour: { utilization: 100, resets_at: null, locked_reason: 'x' } }), [
    { name: 'session', usedPercent: 100, resetsAt: null, spent: true },
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

// ---------------------------------------------------------------- desktop app fallback

const ORG = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HISTORY = {
  version: 2,
  samples: [
    { t: 1000, org: ORG, u: { fh: 5, sd: 3 } },
    { t: 3000, org: OTHER, u: { fh: 100, sd: 24, xu: 72.08 } },
    { t: 2000, org: ORG, u: { fh: 15.6, sd: 7.2 } },
    { t: 4000, org: ORG, u: {} }, // no usable numbers
    { t: 'bad', org: ORG, u: { fh: 1, sd: 1 } },
    null,
  ],
};

test('pickDesktopSample: newest sample of the matching org, rounded; other orgs ignored', () => {
  assert.deepEqual(pickDesktopSample(HISTORY, { org: ORG }), { t: 2000, session: 16, weekly: 7 });
  assert.deepEqual(pickDesktopSample(HISTORY, { org: OTHER }), { t: 3000, session: 100, weekly: 24 });
});

test('pickDesktopSample: unknown org -> newest overall; no match / junk -> null', () => {
  assert.deepEqual(pickDesktopSample(HISTORY), { t: 3000, session: 100, weekly: 24 });
  assert.equal(pickDesktopSample(HISTORY, { org: 'nobody' }), null);
  assert.equal(pickDesktopSample({}), null);
  assert.equal(pickDesktopSample(null), null);
  assert.equal(pickDesktopSample({ samples: 'x' }), null);
});

test('pickDesktopSample: a sample with only one of the two windows is still usable', () => {
  assert.deepEqual(pickDesktopSample({ samples: [{ t: 9, org: ORG, u: { sd: 4 } }] }, { org: ORG }),
    { t: 9, session: null, weekly: 4 });
});

test('readDesktopPlanUsage / readClaudeCodeOrg: read from disk; missing or corrupt -> null', async (t) => {
  const dir = await tempDir(t);
  const hist = join(dir, 'plan-usage-history.json');
  await writeFile(hist, JSON.stringify(HISTORY));
  assert.deepEqual(await readDesktopPlanUsage({ path: hist, org: ORG }), { t: 2000, session: 16, weekly: 7 });
  assert.equal(await readDesktopPlanUsage({ path: join(dir, 'nope.json') }), null);
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{ nope');
  assert.equal(await readDesktopPlanUsage({ path: bad }), null);

  const cfg = join(dir, '.claude.json');
  await writeFile(cfg, JSON.stringify({ oauthAccount: { organizationUuid: ORG } }));
  assert.equal(await readClaudeCodeOrg({ path: cfg }), ORG);
  await writeFile(cfg, JSON.stringify({ oauthAccount: {} }));
  assert.equal(await readClaudeCodeOrg({ path: cfg }), null);
  assert.equal(await readClaudeCodeOrg({ path: join(dir, 'missing.json') }), null);
});

const OV_NOW = 10_000_000;
const sample = (over = {}) => ({ t: OV_NOW - 60_000, session: 16, weekly: 7, ...over });
const FUTURE = new Date(OV_NOW + 3_600_000).toISOString();
const PAST = new Date(OV_NOW - 3_600_000).toISOString();

test('overlayDesktopUsage: a healthy endpoint always wins; no sample is a no-op', () => {
  const healthy = { windows: [{ name: 'session', usedPercent: 1, resetsAt: null }], fetchedAt: 1 };
  assert.equal(overlayDesktopUsage(healthy, sample(), { now: OV_NOW }), healthy);
  const stale = { ...healthy, stale: true, error: 'auth expired' };
  assert.equal(overlayDesktopUsage(stale, null, { now: OV_NOW }), stale);
  assert.equal(overlayDesktopUsage(null, null, { now: OV_NOW }), null);
});

test('overlayDesktopUsage: stale endpoint + newer sample -> desktop numbers, fresh, reason kept', () => {
  const stale = {
    windows: [
      { name: 'session', usedPercent: 0, resetsAt: PAST },
      { name: 'weekly', usedPercent: 2, resetsAt: FUTURE },
      { name: 'weekly opus', usedPercent: 1, resetsAt: FUTURE },
    ],
    fetchedAt: OV_NOW - 48 * 3_600_000,
    stale: true,
    error: 'auth expired — open claude to refresh',
  };
  const out = overlayDesktopUsage(stale, sample(), { now: OV_NOW });
  assert.deepEqual(out, {
    windows: [
      { name: 'session', usedPercent: 16, resetsAt: null }, // its old reset already passed
      { name: 'weekly', usedPercent: 7, resetsAt: FUTURE }, // still-valid reset carried over
    ],
    fetchedAt: OV_NOW - 60_000,
    source: 'desktop',
    error: 'auth expired — open claude to refresh',
  });
  assert.ok(!('stale' in out));
});

test('overlayDesktopUsage: works with no endpoint data at all (never fetched)', () => {
  const out = overlayDesktopUsage({ error: 'auth expired' }, sample(), { now: OV_NOW });
  assert.deepEqual(out.windows.map((w) => [w.name, w.usedPercent]), [['session', 16], ['weekly', 7]]);
  assert.equal(out.source, 'desktop');
  const fromNull = overlayDesktopUsage(null, sample(), { now: OV_NOW });
  assert.equal(fromNull.source, 'desktop');
  assert.ok(!('error' in fromNull));
});

test('overlayDesktopUsage: a sample older than the last good fetch is ignored; an old sample is stale', () => {
  const stale = { windows: [{ name: 'session', usedPercent: 9, resetsAt: null }], fetchedAt: OV_NOW - 30_000, stale: true };
  assert.equal(overlayDesktopUsage(stale, sample({ t: OV_NOW - 60_000 }), { now: OV_NOW }), stale);
  const old = overlayDesktopUsage({ error: 'x' }, sample({ t: OV_NOW - 2 * 3_600_000 }), { now: OV_NOW });
  assert.equal(old.stale, true);
  assert.equal(old.source, 'desktop');
});

test('overlayDesktopUsage: epoch-second reset times are honoured; a sample with no numbers is a no-op', () => {
  const stale = { windows: [{ name: 'weekly', usedPercent: 2, resetsAt: (OV_NOW + 5_000_000) / 1000 }], fetchedAt: 1, stale: true };
  const out = overlayDesktopUsage(stale, sample({ session: null }), { now: OV_NOW });
  assert.deepEqual(out.windows, [{ name: 'weekly', usedPercent: 7, resetsAt: (OV_NOW + 5_000_000) / 1000 }]);
  assert.equal(overlayDesktopUsage(stale, sample({ session: null, weekly: null }), { now: OV_NOW }), stale);
});

test('buildSnapshot: limitsSource is carried when the numbers come from the desktop app', () => {
  const windows = [{ name: 'session', usedPercent: 16, resetsAt: null }];
  const snap = buildSnapshot({ now: NOW, claude: claudeState({ windows, fetchedAt: 5, source: 'desktop' }) });
  assert.equal(snap.claude.limitsSource, 'desktop');
  assert.ok(!('limitsStale' in snap.claude));
  const plain = buildSnapshot({ now: NOW, claude: claudeState({ windows, fetchedAt: 5 }) });
  assert.ok(!('limitsSource' in plain.claude));
});

