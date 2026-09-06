#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { summarize } from './claude-usage.js';
import { AppServerClient } from './app-server-client.js';
import { TranscriptTailer, RateWindow, renderFrame, buildSnapshot, lastNDays, todayTokens } from './live.js';
import { CodexSessionScanner, localTodayTokens, overlayToday } from './codex-local.js';
import { SessionWatcher } from './codex-session-watch.mjs';
import { OmpLiveState } from './omp-usage.js';
import { ClaudeSessionRegistry, readProcessTable, appForTTY } from './claude-sessions.js';
import { CodexTitles } from './codex-titles.js';
import {
  readClaudeLimits,
  readCachedLimits,
  writeCachedLimits,
  reduceLimitsState,
} from './claude-limits.js';

/**
 * Live terminal view of token usage: Claude Code transcripts are tailed
 * incrementally every few seconds; the Codex app-server is polled for
 * account usage and rate limits on a slower interval.
 */
export function createLiveState({
  claudeDir,
  days = 14,
  now = () => new Date(),
  omp = true,
  ompDir,
  ompSessionWindow = 600,
  claudeSessions = true,
  readTable = readProcessTable,
} = {}) {
  const tailer = new TranscriptTailer(claudeDir ? { claudeDir } : {});
  const rate = new RateWindow();
  const entries = [];
  const rated = new Set();
  const ompState = omp
    ? new OmpLiveState({ ...(ompDir && { ompDir }), activeWindow: ompSessionWindow, now })
    : null;
  // Live Claude Code processes (name, busy/idle, terminal vs background job).
  const registry = claudeSessions ? new ClaudeSessionRegistry(claudeDir ? { claudeDir } : {}) : null;
  let sessions = [];
  // One `ps` pass per tick, shared by the registry (tty + hosting app per
  // Claude Code process) and the OMP side (hosting app of the `omp` on a pty).
  let table = null;

  // OMP only records the pty a session runs on; resolve the terminal app that
  // owns the `omp` process there (nothing if the session has exited).
  const withOmpApps = (frame) => ({
    ...frame,
    sessions: (frame.sessions ?? []).map((s) => {
      if (s.app || !s.tty) return s;
      const app = appForTTY(s.tty, table, 'omp');
      return app ? { ...s, app } : s;
    }),
  });

  return {
    async scanClaude() {
      // OMP sessions are tailed on the same tick; a read problem there must
      // not take the Claude Code side down.
      if (ompState) await ompState.scan().catch(() => {});
      if (registry || ompState) table = await readTable().catch(() => table);
      if (registry) sessions = await registry.scan(table ?? undefined).catch(() => sessions);
      const fresh = await tailer.scan();
      const nowMs = now().getTime();
      for (const e of fresh) {
        entries.push(e);
        const total = e.tokens.input + e.tokens.output + e.tokens.cacheCreation + e.tokens.cacheRead;
        // Recent entries feed the live rate window, each API response once.
        if (e.timestampMs && nowMs - e.timestampMs <= rate.maxAgeMs && !rated.has(e.key)) {
          if (e.key !== null) rated.add(e.key);
          rate.add(e.timestampMs, total);
        }
      }
      return fresh.length;
    },
    claudeFrame() {
      const t = now();
      const report = summarize(entries, { now: t });
      return {
        summary: report.summary,
        today: todayTokens(report.dailyUsageBuckets, t),
        daily: lastNDays(report.dailyUsageBuckets, days, t),
        perMinute: rate.tokensSince(60_000, t.getTime()),
        perFiveMinutes: rate.tokensSince(300_000, t.getTime()),
        models: report.modelBreakdown,
        ...(ompState && { omp: withOmpApps(ompState.frame(t)) }),
        ...(registry && { sessions }),
      };
    },
  };
}

export async function pollCodex(client, { days = 14, now = new Date(), codexHome, scanner } = {}) {
  const usage = await client.readAccountUsage();
  let rateLimits;
  try {
    rateLimits = await client.request('account/rateLimits/read');
  } catch {
    rateLimits = undefined; // usage still worth showing
  }
  // The backend's daily buckets lag behind (usually stopping at yesterday);
  // fill today's bucket from the local session rollouts as a floor.
  let local = 0;
  try {
    local = scanner ? await scanner.todayTokens(now) : await localTodayTokens({ codexHome, now });
  } catch {
    /* no local sessions — keep the API value */
  }
  const { buckets, today, todayEstimated } = overlayToday(usage.dailyUsageBuckets, local, now);
  return {
    summary: usage.summary,
    today,
    todayEstimated,
    daily: lastNDays(buckets, days, now),
    rateLimits,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      interval: { type: 'string', default: '2' },
      'codex-interval': { type: 'string', default: '30' },
      'no-codex': { type: 'boolean', default: false },
      'no-claude-limits': { type: 'boolean', default: false },
      'claude-limits-interval': { type: 'string', default: '150' },
      'claude-dir': { type: 'string' },
      days: { type: 'string', default: '14' },
      once: { type: 'boolean', default: false },
      stream: { type: 'boolean', default: false },
      'codex-cmd': { type: 'string', default: 'codex' },
      'codex-args': { type: 'string', default: 'app-server' },
      'codex-home': { type: 'string' },
      'no-codex-sessions': { type: 'boolean', default: false },
      'codex-session-window': { type: 'string', default: '600' },
      'no-omp': { type: 'boolean', default: false },
      'no-claude-sessions': { type: 'boolean', default: false },
      'omp-dir': { type: 'string' },
      'omp-session-window': { type: 'string', default: '600' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: live-usage [options]

Live terminal view of Claude Code + Codex token usage.

Options:
  --interval <s>        Claude transcript scan interval (default: 2)
  --codex-interval <s>  Codex app-server poll interval (default: 30)
  --no-codex            Claude transcripts only
  --no-claude-limits    Skip the Claude plan-limit fetch (OAuth usage endpoint)
  --claude-limits-interval <s>  Claude limit poll interval (default: 150)
  --claude-dir <dir>    Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --days <n>            Days in the sparklines (default: 14)
  --once                Render a single frame and exit
  --stream              Emit NDJSON snapshots instead of a TUI (for widgets)
  --codex-cmd <cmd>     Codex binary (default: codex)
  --codex-args <args>   Comma-separated args (default: app-server)
  --codex-home <dir>    Codex home for the local same-day estimate and the
                        per-session tailer (default: $CODEX_HOME or ~/.codex)
  --no-codex-sessions   Skip the live per-session view (rollout tailing)
  --codex-session-window <s>  A session counts as live while its rollout was
                        written within this many seconds (default: 600)
  --no-omp              Skip Claude usage made through OMP (oh-my-pi)
  --no-claude-sessions  Skip the live Claude Code process list (~/.claude/sessions)
  --omp-dir <dir>       OMP home (default: $OMP_HOME or ~/.omp)
  --omp-session-window <s>  An OMP session counts as current while its file
                        was written within this many seconds (default: 600)
  -h, --help            Show this help`);
    return;
  }

  const days = Number(values.days);
  const ansi = process.stdout.isTTY ?? false;
  const state = createLiveState({
    claudeDir: values['claude-dir'],
    days,
    omp: !values['no-omp'],
    ompDir: values['omp-dir'],
    ompSessionWindow: Number(values['omp-session-window']),
    claudeSessions: !values['no-claude-sessions'],
  });
  let codex = null;
  let client = null;

  if (!values['no-codex']) {
    client = new AppServerClient({
      command: values['codex-cmd'],
      args: values['codex-args'].split(',').filter(Boolean),
      timeoutMs: 20_000,
    });
    try {
      client.start();
      await client.initialize();
    } catch (err) {
      codex = { error: err.message };
      client = null;
    }
  }

  const scanner = client
    ? new CodexSessionScanner(values['codex-home'] ? { codexHome: values['codex-home'] } : {})
    : null;
  // Live per-session usage is read straight from the rollout files, so it works
  // even when the app-server is unavailable (but not when Codex is disabled).
  const watcher = !values['no-codex'] && !values['no-codex-sessions']
    ? new SessionWatcher({
        ...(values['codex-home'] && { codexHome: values['codex-home'] }),
        activeWindow: Number(values['codex-session-window']),
      })
    : null;
  // Human titles for Codex threads come from Codex's state DB (read-only);
  // refreshed on a slow cadence for whichever threads the tailer currently sees.
  const titles = watcher ? new CodexTitles() : null;
  let lastCodexIds = [];
  const codexSessions = () => {
    if (!watcher) return undefined;
    try {
      const list = watcher.poll();
      lastCodexIds = list.map((s) => s.id);
      return list;
    } catch {
      return []; // a transient read problem must not take the stream down
    }
  };
  const codexTitle = titles ? (id) => titles.get(id) : undefined;
  const refreshCodexTitles = async () => {
    if (!titles) return;
    await titles.refresh(lastCodexIds).catch(() => {});
  };
  const refreshCodex = async () => {
    if (!client) return;
    try {
      codex = await pollCodex(client, { days, scanner });
    } catch (err) {
      codex = { error: err.message };
    }
  };

  // Resilient limits: the shared OAuth usage endpoint rate-limits hard (Claude
  // Code, this widget and other tools all poll it), so a failed fetch must not
  // blank the display. Keep the last-good windows (seeded from an on-disk cache
  // at startup), surface them as `stale`, and back off exponentially on 429/5xx
  // so we stop hammering a limit we've already hit.
  const baseLimitsMs = Number(values['claude-limits-interval']) * 1000;
  const maxBackoffMs = 15 * 60_000;
  const limitsState = { last: null, fails: 0, nextAt: 0 };
  let claudeLimits = null;

  const seedClaudeLimits = async () => {
    if (values['no-claude-limits']) return;
    const cached = await readCachedLimits();
    if (cached) {
      limitsState.last = cached;
      claudeLimits = { ...cached, stale: true };
    }
  };

  const refreshClaudeLimits = async () => {
    if (values['no-claude-limits']) return;
    if (Date.now() < limitsState.nextAt) return; // still backing off
    let outcome;
    try {
      outcome = { ok: true, windows: (await readClaudeLimits()).windows };
    } catch (err) {
      outcome = { ok: false, error: err };
    }
    const now = Date.now();
    const { state, limits, cache } = reduceLimitsState(limitsState, outcome, {
      now,
      baseMs: baseLimitsMs,
      maxBackoffMs,
    });
    Object.assign(limitsState, state);
    claudeLimits = limits;
    if (cache) await writeCachedLimits(cache, { fetchedAt: now });
  };

  const claudeState = () => ({
    ...state.claudeFrame(),
    ...(claudeLimits && { limits: claudeLimits }),
  });
  const frame = () =>
    renderFrame({
      now: new Date(),
      claude: claudeState(),
      codex: values['no-codex'] ? undefined : codex,
      codexSessions: codexSessions(),
      ansi,
      days,
      intervals: values.once
        ? undefined
        : { claude: values.interval, codex: values['codex-interval'] },
    });

  await seedClaudeLimits();
  await state.scanClaude();
  codexSessions(); // prime the id list so the first title refresh has targets
  await Promise.all([refreshCodex(), refreshClaudeLimits(), refreshCodexTitles()]);

  if (values.once) {
    console.log(frame());
    titles?.close();
    await client?.close();
    return;
  }

  if (values.stream) {
    const emit = () =>
      console.log(
        JSON.stringify(
          buildSnapshot({
            now: new Date(),
            claude: claudeState(),
            codex: values['no-codex'] ? undefined : codex,
            codexSessions: codexSessions(),
            codexTitle,
          }),
        ),
      );
    emit();
    const streamTimer = setInterval(async () => {
      await state.scanClaude();
      emit();
    }, Number(values.interval) * 1000);
    const streamCodexTimer = setInterval(refreshCodex, Number(values['codex-interval']) * 1000);
    const streamLimitsTimer = setInterval(
      refreshClaudeLimits,
      Number(values['claude-limits-interval']) * 1000,
    );
    const streamTitlesTimer = setInterval(refreshCodexTitles, 30_000);
    const stop = async () => {
      clearInterval(streamTimer);
      clearInterval(streamCodexTimer);
      clearInterval(streamLimitsTimer);
      clearInterval(streamTitlesTimer);
      titles?.close();
      await client?.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  const paint = () => process.stdout.write('\x1b[H' + frame() + '\x1b[0J\n');
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  paint();

  const claudeTimer = setInterval(async () => {
    await state.scanClaude();
    paint();
  }, Number(values.interval) * 1000);
  const codexTimer = setInterval(refreshCodex, Number(values['codex-interval']) * 1000);
  const limitsTimer = setInterval(
    refreshClaudeLimits,
    Number(values['claude-limits-interval']) * 1000,
  );

  const shutdown = async () => {
    clearInterval(claudeTimer);
    clearInterval(codexTimer);
    clearInterval(limitsTimer);
    process.stdout.write('\x1b[?25h\n');
    await client?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
