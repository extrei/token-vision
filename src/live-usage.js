#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { summarize } from './claude-usage.js';
import { AppServerClient } from './app-server-client.js';
import { TranscriptTailer, RateWindow, renderFrame, buildSnapshot, lastNDays, todayTokens } from './live.js';

/**
 * Live terminal view of token usage: Claude Code transcripts are tailed
 * incrementally every few seconds; the Codex app-server is polled for
 * account usage and rate limits on a slower interval.
 */
export function createLiveState({ claudeDir, days = 14, now = () => new Date() } = {}) {
  const tailer = new TranscriptTailer(claudeDir ? { claudeDir } : {});
  const rate = new RateWindow();
  const entries = [];
  const rated = new Set();

  return {
    async scanClaude() {
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
      };
    },
  };
}

export async function pollCodex(client, { days = 14, now = new Date() } = {}) {
  const usage = await client.readAccountUsage();
  let rateLimits;
  try {
    rateLimits = await client.request('account/rateLimits/read');
  } catch {
    rateLimits = undefined; // usage still worth showing
  }
  return {
    summary: usage.summary,
    today: todayTokens(usage.dailyUsageBuckets, now),
    daily: lastNDays(usage.dailyUsageBuckets, days, now),
    rateLimits,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      interval: { type: 'string', default: '2' },
      'codex-interval': { type: 'string', default: '30' },
      'no-codex': { type: 'boolean', default: false },
      'claude-dir': { type: 'string' },
      days: { type: 'string', default: '14' },
      once: { type: 'boolean', default: false },
      stream: { type: 'boolean', default: false },
      'codex-cmd': { type: 'string', default: 'codex' },
      'codex-args': { type: 'string', default: 'app-server' },
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
  --claude-dir <dir>    Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --days <n>            Days in the sparklines (default: 14)
  --once                Render a single frame and exit
  --stream              Emit NDJSON snapshots instead of a TUI (for widgets)
  --codex-cmd <cmd>     Codex binary (default: codex)
  --codex-args <args>   Comma-separated args (default: app-server)
  -h, --help            Show this help`);
    return;
  }

  const days = Number(values.days);
  const ansi = process.stdout.isTTY ?? false;
  const state = createLiveState({ claudeDir: values['claude-dir'], days });
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

  const refreshCodex = async () => {
    if (!client) return;
    try {
      codex = await pollCodex(client, { days });
    } catch (err) {
      codex = { error: err.message };
    }
  };

  const frame = () =>
    renderFrame({
      now: new Date(),
      claude: state.claudeFrame(),
      codex: values['no-codex'] ? undefined : codex,
      ansi,
      days,
      intervals: values.once
        ? undefined
        : { claude: values.interval, codex: values['codex-interval'] },
    });

  await state.scanClaude();
  await refreshCodex();

  if (values.once) {
    console.log(frame());
    await client?.close();
    return;
  }

  if (values.stream) {
    const emit = () =>
      console.log(
        JSON.stringify(
          buildSnapshot({
            now: new Date(),
            claude: state.claudeFrame(),
            codex: values['no-codex'] ? undefined : codex,
          }),
        ),
      );
    emit();
    const streamTimer = setInterval(async () => {
      await state.scanClaude();
      emit();
    }, Number(values.interval) * 1000);
    const streamCodexTimer = setInterval(refreshCodex, Number(values['codex-interval']) * 1000);
    const stop = async () => {
      clearInterval(streamTimer);
      clearInterval(streamCodexTimer);
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

  const shutdown = async () => {
    clearInterval(claudeTimer);
    clearInterval(codexTimer);
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
