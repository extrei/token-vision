import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractUsageEntry, defaultClaudeDir } from './claude-usage.js';

/**
 * Incrementally tails Claude Code transcripts under `<claudeDir>/projects`.
 * The first scan() returns all historical usage entries; later scans return only
 * entries appended since, tracked via per-file byte offsets. Rewritten/truncated
 * files are re-read from the start; a trailing partial line is buffered until
 * the writer finishes it.
 */
export class TranscriptTailer {
  #offsets = new Map(); // file -> { offset, remainder }

  constructor({ claudeDir = defaultClaudeDir() } = {}) {
    this.projectsDir = join(claudeDir, 'projects');
  }

  async #files() {
    const out = [];
    let projects;
    try {
      projects = await readdir(this.projectsDir);
    } catch {
      return out;
    }
    for (const project of projects) {
      const dir = join(this.projectsDir, project);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        for (const f of await readdir(dir)) {
          if (f.endsWith('.jsonl')) out.push(join(dir, f));
        }
      } catch {
        /* raced with deletion */
      }
    }
    return out;
  }

  async scan() {
    const entries = [];
    for (const file of await this.#files()) {
      let size;
      try {
        size = (await stat(file)).size;
      } catch {
        continue;
      }
      const state = this.#offsets.get(file) ?? { offset: 0, remainder: '' };
      if (size < state.offset) {
        state.offset = 0; // truncated/rewritten — start over
        state.remainder = '';
      }
      if (size === state.offset) continue;
      let fh;
      try {
        fh = await open(file);
        const length = size - state.offset;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, state.offset);
        const text = state.remainder + buf.toString('utf8');
        const lines = text.split('\n');
        state.remainder = lines.pop() ?? '';
        state.offset = size;
        this.#offsets.set(file, state);
        for (const line of lines) {
          const entry = extractUsageEntry(line, { timestamps: true });
          if (entry) entries.push(entry);
        }
      } catch {
        /* unreadable right now — retry next scan */
      } finally {
        await fh?.close();
      }
    }
    return entries;
  }
}

/** Sliding window of (timestamp, tokens) samples for live rate readouts. */
export class RateWindow {
  #samples = [];

  constructor({ maxAgeMs = 10 * 60_000 } = {}) {
    this.maxAgeMs = maxAgeMs;
  }

  add(timestampMs, tokens) {
    this.#samples.push({ timestampMs, tokens });
  }

  /** Sum of tokens in the trailing `ms` window; also prunes expired samples. */
  tokensSince(ms, now = Date.now()) {
    this.#samples = this.#samples.filter((s) => now - s.timestampMs <= this.maxAgeMs);
    let sum = 0;
    for (const s of this.#samples) {
      if (now - s.timestampMs <= ms) sum += s.tokens;
    }
    return sum;
  }
}

const TICKS = '▁▂▃▄▅▆▇█';

export function sparkline(values) {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max <= 0) return '▁'.repeat(values.length);
  return values
    .map((v) => TICKS[Math.min(TICKS.length - 1, Math.round((v / max) * (TICKS.length - 1)))])
    .join('');
}

export function bar(percent, width = 20) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function compact(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));

const utcDate = (d) => d.toISOString().slice(0, 10);

/** Bucket list -> dense token-per-day values for the last `n` UTC days ending today. */
export function lastNDays(buckets, n, now = new Date()) {
  const byDate = new Map((buckets ?? []).map((b) => [b.startDate, b.tokens]));
  const values = [];
  for (let i = n - 1; i >= 0; i--) {
    values.push(byDate.get(utcDate(new Date(now.getTime() - i * 86_400_000))) ?? 0);
  }
  return values;
}

export function todayTokens(buckets, now = new Date()) {
  const today = utcDate(now);
  return (buckets ?? []).find((b) => b.startDate === today)?.tokens ?? 0;
}

function resetLabel(resetsAt, now) {
  if (resetsAt === null || resetsAt === undefined) return '';
  const t = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameDay = utcDate(d) === utcDate(now);
  const label = sameDay
    ? d.toISOString().slice(11, 16) + ' UTC'
    : d.toISOString().slice(5, 10).replace('-', '/');
  return `resets ${label}`;
}

function limitLine(name, window, now, { ansi }) {
  if (!window) return null;
  const pct = window.usedPercent ?? 0;
  let color = '';
  if (ansi) color = pct >= 85 ? '\x1b[31m' : pct >= 60 ? '\x1b[33m' : '\x1b[32m';
  const reset = ansi ? '\x1b[0m' : '';
  const mins = window.windowDurationMins;
  const span = !mins ? '' : mins >= 1440 ? `${Math.round(mins / 1440)}d window  ` : `${Math.round(mins / 60)}h window  `;
  return `  ${name.padEnd(12)} ${color}${bar(pct)}${reset} ${String(pct).padStart(3)}%  ${span}${resetLabel(window.resetsAt, now)}`;
}

/**
 * Flatten the live state into one compact JSON-ready snapshot — the wire
 * format of `live-usage.js --stream`, consumed by the menu-bar widget.
 * Pure given its inputs.
 */
export function buildSnapshot({ now = new Date(), claude, codex }) {
  const snapshot = { ts: now.toISOString() };
  if (claude) {
    snapshot.claude = {
      perMinute: claude.perMinute,
      perFiveMinutes: claude.perFiveMinutes,
      today: claude.today,
      lifetime: claude.summary?.lifetimeTokens ?? 0,
      messages: claude.summary?.assistantMessages ?? 0,
    };
  }
  if (codex !== undefined) {
    if (codex === null) {
      snapshot.codex = { pending: true };
    } else if (codex.error) {
      snapshot.codex = { error: codex.error };
    } else {
      const primary = codex.rateLimits?.rateLimits?.primary;
      snapshot.codex = {
        today: codex.today,
        ...(codex.todayEstimated && { todayEstimated: true }),
        lifetime: codex.summary?.lifetimeTokens ?? 0,
        ...(primary && {
          usedPercent: primary.usedPercent ?? 0,
          windowMins: primary.windowDurationMins ?? null,
          resetsAt: primary.resetsAt ?? null,
        }),
        ...(codex.rateLimits?.rateLimits?.planType && {
          planType: codex.rateLimits.rateLimits.planType,
        }),
      };
    }
  }
  return snapshot;
}

/**
 * Render one frame of the live view as a plain string (no cursor control —
 * the caller owns screen management). Pure given `state`.
 */
export function renderFrame(state) {
  const { now = new Date(), claude, codex, ansi = true, days = 14, intervals } = state;
  const B = ansi ? '\x1b[1m' : '';
  const D = ansi ? '\x1b[2m' : '';
  const R = ansi ? '\x1b[0m' : '';
  const lines = [];

  lines.push(`${B}LIVE TOKEN VISION${R}  ${D}${now.toISOString().replace('T', ' ').slice(0, 19)} UTC${R}`);
  lines.push('');

  const row = (label, rest) => `  ${label.padEnd(12)} ${rest}`;

  if (claude) {
    const s = claude.summary ?? {};
    lines.push(`${B}CLAUDE CODE${R} ${D}(local transcripts)${R}`);
    lines.push(row('today', `${fmt(claude.today)} tokens`));
    lines.push(row('rate', `${fmt(claude.perMinute)} tok/min ${D}(last 60s)${R}   ${fmt(claude.perFiveMinutes)} ${D}in last 5m${R}`));
    lines.push(row('lifetime', `${fmt(s.lifetimeTokens)}   ${D}messages${R} ${fmt(s.assistantMessages)}`));
    lines.push(row(`last ${days}d`, `${sparkline(claude.daily)}  ${D}peak ${compact(s.peakDailyTokens)}/day${R}`));
    lines.push('');
  }

  // codex === undefined means the codex side is disabled entirely;
  // null means enabled but not yet polled.
  if (codex !== undefined) lines.push(`${B}CODEX${R} ${D}(app-server)${R}`);
  if (codex === undefined) {
    /* section hidden */
  } else if (codex?.error) {
    lines.push(`  ${D}unavailable: ${codex.error}${R}`);
  } else if (codex) {
    const s = codex.summary ?? {};
    lines.push(
      row(
        'today',
        codex.todayEstimated
          ? `~${fmt(codex.today)} tokens ${D}(local estimate — API lags)${R}`
          : `${fmt(codex.today)} tokens`,
      ),
    );
    lines.push(row('lifetime', `${fmt(s.lifetimeTokens)}   ${D}streak${R} ${fmt(s.currentStreakDays)}d`));
    lines.push(row(`last ${days}d`, `${sparkline(codex.daily)}  ${D}peak ${compact(s.peakDailyTokens)}/day${R}`));
    const rl = codex.rateLimits?.rateLimits;
    if (rl) {
      const primary = limitLine(`${rl.planType ?? 'plan'} limit`, rl.primary, now, { ansi });
      const secondary = limitLine('secondary', rl.secondary, now, { ansi });
      if (primary) lines.push(primary);
      if (secondary) lines.push(secondary);
    }
  } else {
    lines.push(`  ${D}waiting for first poll…${R}`);
  }
  lines.push('');
  if (intervals) {
    lines.push(`${D}claude every ${intervals.claude}s · codex every ${intervals.codex}s · ctrl-c to quit${R}`);
  }
  return lines.join('\n');
}
