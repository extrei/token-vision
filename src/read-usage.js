#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AppServerClient } from './app-server-client.js';

export function formatUsage(usage) {
  const lines = [];
  const s = usage.summary ?? {};
  const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
  lines.push('Account token usage');
  lines.push(`  lifetime tokens:     ${fmt(s.lifetimeTokens)}`);
  lines.push(`  peak daily tokens:   ${fmt(s.peakDailyTokens)}`);
  lines.push(`  current streak:      ${fmt(s.currentStreakDays)} day(s)`);
  lines.push(`  longest streak:      ${fmt(s.longestStreakDays)} day(s)`);
  lines.push(`  longest turn:        ${fmt(s.longestRunningTurnSec)} s`);
  const buckets = usage.dailyUsageBuckets ?? [];
  if (buckets.length > 0) {
    lines.push('Daily usage:');
    for (const b of buckets) {
      lines.push(`  ${b.startDate}  ${fmt(b.tokens)} tokens`);
    }
  }
  if (usage.threadUsage) {
    const t = usage.threadUsage;
    lines.push(`Thread ${t.threadId}:`);
    lines.push(`  estimated credits (micro): ${fmt(t.estimatedUsageCreditsMicros)}`);
    if (t.estimatedUsageUsdMicros != null) {
      lines.push(`  estimated USD:             $${(t.estimatedUsageUsdMicros / 1e6).toFixed(4)}`);
    }
  }
  return lines.join('\n');
}

export async function readUsage({ threadId, command, args, timeoutMs } = {}) {
  const client = new AppServerClient({
    ...(command && { command }),
    ...(args && { args }),
    ...(timeoutMs && { timeoutMs }),
  }).start();
  try {
    await client.initialize();
    return await client.readAccountUsage({ threadId });
  } finally {
    await client.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'thread-id': { type: 'string' },
      json: { type: 'boolean', default: false },
      codex: { type: 'string', default: 'codex' },
      timeout: { type: 'string', default: '30000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: codex-usage [options]

Reads account usage via \`codex app-server\` (JSON-RPC method account/usage/read).

Options:
  --thread-id <id>  Read estimated usage for one thread instead of account-wide
  --json            Print the raw JSON response
  --codex <path>    Path to the codex binary (default: codex)
  --timeout <ms>    Request timeout in milliseconds (default: 30000)
  -h, --help        Show this help`);
    return;
  }
  const usage = await readUsage({
    threadId: values['thread-id'],
    command: values.codex,
    timeoutMs: Number(values.timeout),
  });
  console.log(values.json ? JSON.stringify(usage, null, 2) : formatUsage(usage));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
