import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

/**
 * Aggregates Claude Code token usage from the local session transcripts in
 * `~/.claude/projects/<project>/<session>.jsonl`. Every assistant message in
 * a transcript carries `message.usage` (input/output/cache token counts),
 * `message.model` and a `timestamp`, which is enough to reconstruct the same
 * shape the Codex app-server returns from `account/usage/read`.
 *
 * Days are bucketed by UTC date. "Tokens" = input + output + cache creation
 * + cache read, matching how Codex counts lifetime/daily tokens.
 */

export function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

const totalTokens = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;

/**
 * Parse one transcript JSONL line into a usage entry, or null if the line is
 * not an assistant message with real token usage.
 * Entry: { key, date, model, tokens: {input, output, cacheCreation, cacheRead} }
 */
export function extractUsageEntry(line) {
  // Cheap pre-filter before JSON.parse — transcripts are large.
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d.type !== 'assistant') return null;
  const msg = d.message;
  const usage = msg?.usage;
  if (!usage || typeof d.timestamp !== 'string') return null;
  if (msg.model === '<synthetic>') return null; // error placeholders, no real API call
  const tokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
  if (totalTokens(tokens) === 0) return null;
  return {
    // The same API response can be rewritten into several transcript lines
    // (resumed/forked sessions), so dedupe on message id + request id.
    key: msg.id && d.requestId ? `${msg.id}:${d.requestId}` : (d.uuid ?? null),
    date: d.timestamp.slice(0, 10),
    model: msg.model ?? 'unknown',
    tokens,
  };
}

function streaks(dates, now) {
  const sorted = [...dates].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const date of sorted) {
    const t = Date.parse(date);
    run = prev !== null && t - prev === 86_400_000 ? run + 1 : 1;
    prev = t;
    if (run > longest) longest = run;
  }
  // The trailing run counts as "current" if it reaches today or yesterday.
  const last = sorted.at(-1);
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const current = last === today || last === yesterday ? run : 0;
  return { current, longest };
}

/** Aggregate deduplicated usage entries into a Codex-style usage response. */
export function summarize(entries, { now = new Date() } = {}) {
  const seen = new Set();
  const byDay = new Map();
  const byModel = new Map();
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let messages = 0;

  for (const e of entries) {
    if (e.key !== null) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
    }
    messages++;
    for (const k of Object.keys(totals)) totals[k] += e.tokens[k];
    const n = totalTokens(e.tokens);
    byDay.set(e.date, (byDay.get(e.date) ?? 0) + n);
    const m = byModel.get(e.model) ?? { model: e.model, tokens: 0, messages: 0 };
    m.tokens += n;
    m.messages++;
    byModel.set(e.model, m);
  }

  const dailyUsageBuckets = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([startDate, tokens]) => ({ startDate, tokens }));
  const { current, longest } = streaks(byDay.keys(), now);

  return {
    summary: {
      lifetimeTokens: totals.input + totals.output + totals.cacheCreation + totals.cacheRead,
      peakDailyTokens: dailyUsageBuckets.reduce((max, b) => Math.max(max, b.tokens), 0) || null,
      currentStreakDays: current || null,
      longestStreakDays: longest || null,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheCreationTokens: totals.cacheCreation,
      cacheReadTokens: totals.cacheRead,
      assistantMessages: messages,
      firstActivity: dailyUsageBuckets[0]?.startDate ?? null,
      lastActivity: dailyUsageBuckets.at(-1)?.startDate ?? null,
    },
    dailyUsageBuckets,
    modelBreakdown: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

async function* transcriptFiles(projectsDir) {
  let projects;
  try {
    projects = await readdir(projectsDir);
  } catch {
    return; // no projects dir — treated as zero usage
  }
  for (const project of projects) {
    const dir = join(projectsDir, project);
    let files;
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) yield join(dir, f);
    }
  }
}

/** Scan all transcripts under `<claudeDir>/projects` and aggregate usage. */
export async function readClaudeUsage({ claudeDir = defaultClaudeDir(), now } = {}) {
  const entries = [];
  for await (const file of transcriptFiles(join(claudeDir, 'projects'))) {
    const lines = createInterface({ input: createReadStream(file) });
    for await (const line of lines) {
      const entry = extractUsageEntry(line);
      if (entry) entries.push(entry);
    }
  }
  return summarize(entries, now ? { now } : {});
}
