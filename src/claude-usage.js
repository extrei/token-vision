import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
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

/** "Tokens" for one API response: input + output + cache creation + cache read. */
export const totalTokens = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;

/**
 * Parse one transcript JSONL line into a usage entry, or null if the line is
 * not an assistant message with real token usage.
 * Entry: { key, date, model, tokens: {input, output, cacheCreation, cacheRead} }
 */
export function extractUsageEntry(line, { timestamps = false } = {}) {
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
    // One API response spans several transcript lines (one per content block,
    // plus copies in resumed/forked sessions): message id + request id is what
    // ties them together — see dedupeUsageEntries.
    key: msg.id && d.requestId ? `${msg.id}:${d.requestId}` : (d.uuid ?? null),
    date: d.timestamp.slice(0, 10),
    model: msg.model ?? 'unknown',
    tokens,
    ...(timestamps && { timestampMs: Date.parse(d.timestamp) }),
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

/**
 * One entry per API response. Claude Code writes a transcript line per content
 * block, all under the same message id + request id, and the usage on those
 * lines is a running snapshot: input and cache counts are already final on the
 * first, but `output_tokens` only reaches the billed figure on the last (the
 * first is often the `message_start` placeholder, 1-2 tokens). Resumed and
 * forked sessions copy those lines into other files too, so "last seen" depends
 * on scan order. Keeping the largest snapshot is order-independent and is the
 * final one. Entries without a key can't be matched up, so each one counts.
 */
export function dedupeUsageEntries(entries) {
  const best = new Map(); // key -> largest snapshot, in first-seen order
  const unkeyed = [];
  for (const e of entries) {
    if (e.key === null) {
      unkeyed.push(e);
      continue;
    }
    const prev = best.get(e.key);
    if (!prev || totalTokens(e.tokens) > totalTokens(prev.tokens)) best.set(e.key, e);
  }
  return [...unkeyed, ...best.values()];
}

/** Aggregate deduplicated usage entries into a Codex-style usage response. */
export function summarize(entries, { now = new Date() } = {}) {
  const byDay = new Map();
  const byModel = new Map();
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let messages = 0;

  for (const e of dedupeUsageEntries(entries)) {
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
  // Recursive: session transcripts sit at projects/<project>/<session>.jsonl,
  // but subagent transcripts nest deeper (<project>/<session>/subagents/*.jsonl)
  // and carry their own API usage — skipping them undercounts by ~half.
  let names;
  try {
    names = await readdir(projectsDir, { recursive: true });
  } catch {
    return; // no projects dir — treated as zero usage
  }
  for (const name of names) {
    // Depth >= 1 only: real transcripts always live inside a project dir;
    // a stray .jsonl directly under projects/ is foreign.
    if (name.endsWith('.jsonl') && name.includes(sep)) yield join(projectsDir, name);
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
