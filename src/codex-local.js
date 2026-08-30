import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Local fallback for the Codex backend's daily-usage lag: the
 * `account/usage/read` buckets typically stop at yesterday, but every local
 * session rollout under `<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * logs `token_count` events whose `last_token_usage.total_tokens` is the
 * per-turn delta. Summing those by event timestamp reconstructs a same-day
 * total. It is a floor, not the truth — usage from other devices or cloud
 * tasks is invisible locally — so callers overlay it with `max()`.
 *
 * Rollout files live in the day directory of the session's START, while a
 * long-lived session keeps appending events for days — hence the lookback
 * over previous day directories, bucketing every event by its own timestamp.
 */

export function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Parse one rollout line into {date, tokens} or null. */
export function extractTokenCountEvent(line) {
  if (!line.includes('"token_count"')) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const p = d.payload;
  if (!p || p.type !== 'token_count' || typeof d.timestamp !== 'string') return null;
  const tokens = p.info?.last_token_usage?.total_tokens ?? 0;
  if (tokens <= 0) return null;
  return { date: d.timestamp.slice(0, 10), tokens };
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayDir = (codexHome, date) => join(codexHome, 'sessions', ...date.split('-'));

function tokensByDate(text) {
  const byDate = new Map();
  for (const line of text.split('\n')) {
    const event = extractTokenCountEvent(line);
    if (event) byDate.set(event.date, (byDate.get(event.date) ?? 0) + event.tokens);
  }
  return byDate;
}

/**
 * Scans rollout files for token totals per UTC date, caching per-file results
 * keyed on file size so a live poll only re-reads files that grew.
 */
export class CodexSessionScanner {
  #cache = new Map(); // path -> { size, byDate }

  constructor({ codexHome = defaultCodexHome(), lookbackDays = 7 } = {}) {
    this.codexHome = codexHome;
    this.lookbackDays = lookbackDays;
  }

  async #rolloutFiles(now) {
    const files = [];
    for (let i = 0; i <= this.lookbackDays; i++) {
      const dir = dayDir(this.codexHome, utcDate(now.getTime() - i * 86_400_000));
      try {
        for (const f of await readdir(dir)) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) files.push(join(dir, f));
        }
      } catch {
        /* day directory doesn't exist */
      }
    }
    return files;
  }

  /** Tokens per UTC date across the lookback window ending at `now`. */
  async dailyTokens(now = new Date()) {
    const totals = new Map();
    for (const file of await this.#rolloutFiles(now)) {
      let size;
      try {
        size = (await stat(file)).size;
      } catch {
        continue;
      }
      let cached = this.#cache.get(file);
      if (!cached || cached.size !== size) {
        try {
          cached = { size, byDate: tokensByDate(await readFile(file, 'utf8')) };
          this.#cache.set(file, cached);
        } catch {
          continue;
        }
      }
      for (const [date, tokens] of cached.byDate) {
        totals.set(date, (totals.get(date) ?? 0) + tokens);
      }
    }
    return totals;
  }

  /** Local token total for the current UTC day. */
  async todayTokens(now = new Date()) {
    return (await this.dailyTokens(now)).get(now.toISOString().slice(0, 10)) ?? 0;
  }
}

/** One-shot convenience wrapper around CodexSessionScanner. */
export async function localTodayTokens({ codexHome, lookbackDays, now = new Date() } = {}) {
  const scanner = new CodexSessionScanner({
    ...(codexHome && { codexHome }),
    ...(lookbackDays !== undefined && { lookbackDays }),
  });
  return scanner.todayTokens(now);
}

/**
 * Overlay the local same-day estimate onto API daily buckets: today's bucket
 * becomes max(api, local). Returns { buckets, today, todayEstimated } without
 * mutating the input; todayEstimated is true when the local floor won.
 */
export function overlayToday(buckets, localToday, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const out = (buckets ?? []).map((b) => ({ ...b }));
  let entry = out.find((b) => b.startDate === today);
  if (!entry) {
    entry = { startDate: today, tokens: 0 };
    out.push(entry);
    out.sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  }
  const todayEstimated = localToday > entry.tokens;
  if (todayEstimated) entry.tokens = localToday;
  return { buckets: out, today: entry.tokens, todayEstimated };
}
