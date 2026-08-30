import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * Normalize the endpoint's response into ordered windows:
 * [{ name, usedPercent, resetsAt }]. Tolerates unknown keys — anything
 * object-shaped with a numeric `utilization` counts as a window.
 */
export function normalizeLimits(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const windows = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || typeof value.utilization !== 'number') continue;
    windows.push({
      name: WINDOW_NAMES.get(key) ?? key.replaceAll('_', ' '),
      usedPercent: Math.round(value.utilization),
      resetsAt: value.resets_at ?? value.resetsAt ?? null,
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

export async function fetchClaudeLimits({ token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'codex-usage-live/1.0',
    },
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'auth expired — open claude to refresh' : `usage endpoint HTTP ${res.status}`);
  }
  return { windows: normalizeLimits(await res.json()) };
}

/** Token lookup + fetch in one step. */
export async function readClaudeLimits(opts = {}) {
  const token = await getClaudeOAuthToken(opts);
  return fetchClaudeLimits({ token, fetchImpl: opts.fetchImpl });
}
