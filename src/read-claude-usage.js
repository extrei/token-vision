#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readClaudeUsage } from './claude-usage.js';

export function formatClaudeUsage(usage, { days = 21 } = {}) {
  const lines = [];
  const s = usage.summary ?? {};
  const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
  lines.push('Claude Code token usage (local transcripts)');
  lines.push(`  lifetime tokens:     ${fmt(s.lifetimeTokens)}`);
  lines.push(`  peak daily tokens:   ${fmt(s.peakDailyTokens)}`);
  lines.push(`  current streak:      ${fmt(s.currentStreakDays)} day(s)`);
  lines.push(`  longest streak:      ${fmt(s.longestStreakDays)} day(s)`);
  lines.push(`  input / output:      ${fmt(s.inputTokens)} / ${fmt(s.outputTokens)}`);
  lines.push(`  cache write / read:  ${fmt(s.cacheCreationTokens)} / ${fmt(s.cacheReadTokens)}`);
  lines.push(`  assistant messages:  ${fmt(s.assistantMessages)}`);
  lines.push(`  active:              ${s.firstActivity ?? '—'} → ${s.lastActivity ?? '—'}`);
  const buckets = usage.dailyUsageBuckets ?? [];
  if (buckets.length > 0) {
    lines.push(`Daily usage (last ${Math.min(days, buckets.length)} of ${buckets.length} active days):`);
    for (const b of buckets.slice(-days)) {
      lines.push(`  ${b.startDate}  ${fmt(b.tokens)} tokens`);
    }
  }
  const models = usage.modelBreakdown ?? [];
  if (models.length > 0) {
    lines.push('By model:');
    for (const m of models) {
      lines.push(`  ${m.model}  ${fmt(m.tokens)} tokens (${fmt(m.messages)} messages)`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      'claude-dir': { type: 'string' },
      days: { type: 'string', default: '21' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: claude-usage [options]

Aggregates Claude Code token usage from local session transcripts
(~/.claude/projects/**/*.jsonl) into a Codex-style usage report.

Options:
  --claude-dir <dir>  Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --days <n>          Daily buckets to print in text mode (default: 21)
  --json              Print the raw JSON report
  -h, --help          Show this help`);
    return;
  }
  const usage = await readClaudeUsage(
    values['claude-dir'] ? { claudeDir: values['claude-dir'] } : {},
  );
  console.log(
    values.json ? JSON.stringify(usage, null, 2) : formatClaudeUsage(usage, { days: Number(values.days) }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
