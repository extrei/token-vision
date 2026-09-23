import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Claude plan limits (what the interactive `/usage` screen shows): fetched
 * from the OAuth usage endpoint Claude Code itself uses. There is no official
 * public API for per-user limits, so treat this as best-effort — the response
 * shape is normalized defensively and any failure degrades to "unavailable".
 *
 * The OAuth access token comes from, in order: $CLAUDE_CODE_OAUTH_TOKEN,
 * ~/.claude/.credentials.json, or the macOS Keychain item Claude Code writes
 * ("Claude Code-credentials").
 */

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export async function getClaudeOAuthToken({
  env = process.env,
  credentialsPath = join(homedir(), '.claude', '.credentials.json'),
  keychain = true,
} = {}) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const creds = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const token = creds.claudeAiOauth?.accessToken ?? creds.accessToken;
    if (token) return token;
  } catch {
    /* no credentials file — try the keychain */
  }
  if (keychain && process.platform === 'darwin') {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 8000 },
        (err, out) => (err ? reject(new Error('keychain read failed')) : resolve(out)),
      );
    });
    const token = JSON.parse(stdout.trim()).claudeAiOauth?.accessToken;
    if (token) return token;
  }
  throw new Error('no Claude Code OAuth token found');
}

const WINDOW_NAMES = new Map([
  ['five_hour', 'session'],
  ['seven_day', 'weekly'],
  ['seven_day_opus', 'weekly opus'],
  ['seven_day_sonnet', 'weekly sonnet'],
  ['seven_day_oauth_apps', 'weekly apps'],
]);
const WINDOW_ORDER = [...WINDOW_NAMES.keys()];

const LIMIT_KINDS = new Map([
  ['session', 'session'],
  ['weekly_all', 'weekly'],
]);

// `severity` is the provider's own judgement with a loosely documented
// vocabulary, so anything not plainly fine reads as spent — except `warning`,
// which Claude raises while a limit still has room (seen at 76% used).
const FINE_SEVERITIES = new Set(['normal', 'ok', 'none', 'healthy', 'warning', 'warn']);

function isSpent(node) {
  if (node.locked_reason != null) return true;
  const severity = typeof node.severity === 'string' ? node.severity.toLowerCase() : null;
  return severity !== null && !FINE_SEVERITIES.has(severity);
}

function window(name, percent, resetsAt, spent) {
  return { name, usedPercent: Math.round(percent), resetsAt: resetsAt ?? null, ...(spent && { spent: true }) };
}

/**
 * Normalize the endpoint's response into ordered windows:
 * [{ name, usedPercent, resetsAt, spent? }].
 *
 * `limits[]` is the fuller answer: only it carries the per-model
 * `weekly_scoped` windows, and the unknown top-level siblings of a reply that
 * has it are placeholders (e.g. `nimbus_quill` at 0% with no reset). The
 * top-level `five_hour` / `seven_day` objects are the fallback for a reply
 * without the array; there anything object-shaped with a numeric
 * `utilization` counts as a window.
 */
export function normalizeLimits(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Array.isArray(raw.limits) && raw.limits.length ? windowsFromLimits(raw.limits) : windowsFromKeys(raw);
}

function windowsFromLimits(limits) {
  const windows = [];
  for (const limit of limits) {
    if (!limit || typeof limit !== 'object' || typeof limit.percent !== 'number') continue;
    let name = LIMIT_KINDS.get(limit.kind);
    if (limit.kind === 'weekly_scoped') {
      const model = limit.scope?.model?.display_name;
      if (typeof model !== 'string') continue;
      name = `weekly ${model.toLowerCase()}`;
    }
    if (!name) continue;
    windows.push(window(name, limit.percent, limit.resets_at, isSpent(limit)));
  }
  const rank = (w) => (w.name === 'session' ? 0 : w.name === 'weekly' ? 1 : 2);
  return windows.sort((a, b) => rank(a) - rank(b));
}

function windowsFromKeys(raw) {
  const windows = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || typeof value.utilization !== 'number') continue;
    windows.push({
      ...window(WINDOW_NAMES.get(key) ?? key.replaceAll('_', ' '), value.utilization, value.resets_at ?? value.resetsAt, isSpent(value)),
      key,
    });
  }
  windows.sort((a, b) => {
    const ai = WINDOW_ORDER.indexOf(a.key);
    const bi = WINDOW_ORDER.indexOf(b.key);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.key.localeCompare(b.key);
  });
  return windows.map(({ key, ...w }) => w);
}

// The usage endpoint rate-limits by User-Agent: a generic UA is throttled to
// 429 immediately, while the string Claude Code itself sends is served. Mirror
// it (overridable via CLAUDE_USAGE_USER_AGENT) so this reader isn't singled out.
export const USAGE_USER_AGENT =
  process.env.CLAUDE_USAGE_USER_AGENT || 'claude-cli/2.1.246 (external, cli)';

export async function fetchClaudeLimits({ token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': USAGE_USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'auth expired — open claude to refresh' : `usage endpoint HTTP ${res.status}`);
  }
  return { windows: normalizeLimits(await res.json()) };
}


/**
 * Last-good limits are cached on disk so a fresh streamer (or one riding out a
 * 429 storm) can still show the most recent real numbers instead of a dash.
 */
export function limitsCachePath() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'token-vision', 'claude-limits.json');
}

export async function readCachedLimits({ path = limitsCachePath() } = {}) {
  try {
    const c = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(c.windows) && c.windows.length) {
      return { windows: c.windows, fetchedAt: typeof c.fetchedAt === 'number' ? c.fetchedAt : null };
    }
  } catch {
    /* no cache yet */
  }
  return null;
}

export async function writeCachedLimits(windows, { path = limitsCachePath(), fetchedAt } = {}) {
  if (!Array.isArray(windows) || !windows.length) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ windows, fetchedAt: fetchedAt ?? null }));
  } catch {
    /* cache is best-effort */
  }
}

/** True for transient failures worth backing off and retrying (rate limits, 5xx). */
export function isRetryableLimitsError(err) {
  const m = String(err?.message ?? err);
  return /HTTP (429|5\d\d)/.test(m) || /rate.?limit/i.test(m);
}

/**
 * Pure state machine for the resilient limits poller. Given the previous state
 * `{ last, fails, nextAt }` and a fetch outcome, returns the next state, the
 * `limits` object to publish (fresh, or last-good marked `stale`), and the
 * windows to persist to the disk cache (or null). Keeping this pure makes the
 * "don't blank / don't clobber / back off" behaviour unit-testable.
 *
 * outcome: { ok: true, windows } on a 200, or { ok: false, error } on failure.
 */
export function reduceLimitsState(prev, outcome, { now, baseMs, maxBackoffMs = 15 * 60_000 }) {
  if (outcome.ok && outcome.windows?.length) {
    const last = { windows: outcome.windows, fetchedAt: now };
    // Healthy: reset backoff and let the poll timer own the cadence (nextAt 0).
    return { state: { last, fails: 0, nextAt: 0 }, limits: { ...last }, cache: outcome.windows };
  }
  if (outcome.ok) {
    // 200 with no usable windows: keep last-good (do NOT clobber), retry next tick.
    return {
      state: { last: prev.last, fails: prev.fails, nextAt: 0 },
      limits: prev.last
        ? { ...prev.last, stale: true, error: 'no limit windows returned' }
        : { error: 'no limit windows returned' },
      cache: null,
    };
  }
  const fails = prev.fails + 1;
  const message = String(outcome.error?.message ?? outcome.error);
  const backoff = isRetryableLimitsError(outcome.error)
    ? Math.min(baseMs * 2 ** (fails - 1), maxBackoffMs)
    : baseMs;
  return {
    state: { last: prev.last, fails, nextAt: now + backoff },
    limits: prev.last ? { ...prev.last, stale: true, error: message } : { error: message },
    cache: null,
  };
}

/**
 * Second source: the Claude desktop app. While it is open it samples the same
 * plan limits about every 15 minutes and appends them to
 * `~/Library/Application Support/Claude/plan-usage-history.json` as
 * `{ t, org, u: { fh, sd } }` — five-hour and seven-day utilization, percent.
 *
 * It matters because the endpoint above is read with Claude Code's OAuth token,
 * which lives 8 hours and is only renewed when Claude Code itself runs. Work
 * only in the desktop app for a day and every fetch fails with "auth expired":
 * the ring freezes on old numbers while desktop usage keeps climbing. The
 * desktop file is fresh exactly then, needs no credentials, and is read-only.
 * (The token is deliberately not refreshed here: refresh tokens rotate, and
 * spending Claude Code's from another process would log it out.)
 */
export function desktopUsageHistoryPath() {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');
}

/** Organization of the Claude Code login, to pick the matching desktop samples. */
export async function readClaudeCodeOrg({
  path = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json'),
} = {}) {
  try {
    const org = JSON.parse(await readFile(path, 'utf8')).oauthAccount?.organizationUuid;
    return typeof org === 'string' && org ? org : null;
  } catch {
    return null;
  }
}

/**
 * Newest usable sample as `{ t, session, weekly }`, or null. With a known
 * `org`, only that organization's samples count (another org's numbers would
 * be a different plan); with none, the newest sample wins.
 */
export function pickDesktopSample(history, { org } = {}) {
  const samples = Array.isArray(history?.samples) ? history.samples : [];
  let best = null;
  for (const s of samples) {
    if (!s || typeof s.t !== 'number' || !s.u || typeof s.u !== 'object') continue;
    if (org && s.org !== org) continue;
    const { fh, sd } = s.u;
    if (typeof fh !== 'number' && typeof sd !== 'number') continue;
    if (!best || s.t > best.t) {
      best = {
        t: s.t,
        session: typeof fh === 'number' ? Math.round(fh) : null,
        weekly: typeof sd === 'number' ? Math.round(sd) : null,
      };
    }
  }
  return best;
}

export async function readDesktopPlanUsage({ path = desktopUsageHistoryPath(), org } = {}) {
  try {
    return pickDesktopSample(JSON.parse(await readFile(path, 'utf8')), { org });
  } catch {
    return null; // desktop app not installed / file mid-write
  }
}

/**
 * Overlay a desktop sample on the endpoint's result. A healthy endpoint always
 * wins (it polls more often and carries reset times and every window). When it
 * is stale or has nothing, a desktop sample newer than the last good fetch
 * takes over the session/weekly windows; reset times are carried from the
 * last-good windows while they are still in the future. The result is marked
 * `source: 'desktop'`, and `stale` only once the sample itself is old.
 */
export function overlayDesktopUsage(limits, sample, { now = Date.now(), freshMs = 30 * 60_000 } = {}) {
  if (!sample) return limits;
  const healthy = limits?.windows?.length && !limits.stale;
  if (healthy) return limits;
  if (sample.t <= (limits?.fetchedAt ?? 0)) return limits;
  const carriedReset = (name) => {
    const prev = limits?.windows?.find((w) => w.name === name)?.resetsAt ?? null;
    if (prev == null) return null;
    const ms = typeof prev === 'number' ? prev * 1000 : Date.parse(prev);
    return Number.isFinite(ms) && ms > now ? prev : null;
  };
  const windows = [];
  if (sample.session != null) {
    windows.push({ name: 'session', usedPercent: sample.session, resetsAt: carriedReset('session') });
  }
  if (sample.weekly != null) {
    windows.push({ name: 'weekly', usedPercent: sample.weekly, resetsAt: carriedReset('weekly') });
  }
  if (!windows.length) return limits;
  return {
    windows,
    fetchedAt: sample.t,
    source: 'desktop',
    ...(now - sample.t > freshMs && { stale: true }),
    ...(limits?.error && { error: limits.error }),
  };
}

/** Token lookup + fetch in one step. */
export async function readClaudeLimits(opts = {}) {
  const token = await getClaudeOAuthToken(opts);
  return fetchClaudeLimits({ token, fetchImpl: opts.fetchImpl });
}
