import { join, basename, dirname, relative, sep } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { summarize } from './claude-usage.js';
import { TranscriptTailer, RateWindow } from './live.js';

/**
 * Claude token usage made through OMP (oh-my-pi), read from its session
 * files in `~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<session-id>.jsonl`.
 *
 * Every assistant turn is one `{"type":"message","message":{role:"assistant",
 * provider, model, usage:{input,output,cacheRead,cacheWrite,cost}}}` line;
 * user prompts and tool starts are separate lines, which is enough to tell
 * whether a session is mid-turn. Only Claude responses are counted: OMP can
 * route to many providers, and this feeds the Claude side of the widget.
 */

export function defaultOmpDir() {
  return process.env.OMP_HOME || join(homedir(), '.omp');
}

export function ompSessionsDir(ompDir = defaultOmpDir()) {
  return join(ompDir, 'agent', 'sessions');
}

export function isClaudeModel({ provider, model }) {
  return provider === 'anthropic' || /claude/i.test(model ?? '');
}

const totalTokens = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;

/** `2026-09-04T14-58-03-451Z_01a06ced-....jsonl` -> `01a06ced-...` */
export function sessionIdFromFile(file) {
  const name = basename(file).replace(/\.jsonl$/, '');
  const i = name.indexOf('_');
  return i >= 0 ? name.slice(i + 1) : name;
}

/**
 * Identity of a session file. Top-level files are user sessions named by
 * timestamp + id; subagent sessions nest as `<parent file stem>/<Name>.jsonl`
 * and get their own id from their `session` header.
 */
export function sessionMetaFromFile(file, root) {
  const rel = root ? relative(root, file) : file;
  const parts = rel.split(sep);
  const nested = parts.length > 2; // <cwd-slug>/<parent>/<Name>.jsonl
  const stem = basename(file).replace(/\.jsonl$/, '');
  return nested
    ? { id: stem, kind: 'subagent', label: stem, parent: sessionIdFromFile(dirname(file)), cwd: null }
    : { id: sessionIdFromFile(file), kind: 'user', label: null, parent: null, cwd: null };
}

/**
 * Parse one OMP session line into an event, or null when it is irrelevant.
 *   { kind: 'session', id, cwd, timestampMs }
 *   { kind: 'usage', key, date, model, provider, tokens, costUsd, stopReason, timestampMs }
 *   { kind: 'activity', timestampMs, awaiting }   user prompt / tool start (turn in flight)
 * Non-Claude assistant turns are reported as activity only, so a session that
 * mixes providers still shows as live without its tokens counting as Claude's.
 */
export function extractOmpEvent(line) {
  if (!line.includes('"type"')) return null;
  const quick =
    line.includes('"session"') || line.includes('"message"') || line.includes('tool_execution_start');
  // (toolResult lines are `"type":"message"` too.)
  if (!quick) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const timestampMs = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
  if (d.type === 'session') {
    return { kind: 'session', id: d.id ?? null, cwd: d.cwd ?? null, timestampMs };
  }
  if (!Number.isFinite(timestampMs)) return null;
  // `yield` is how an OMP subagent hands its result back: the session is done.
  if (d.type === 'custom' && d.customType === 'tool_execution_start') {
    return { kind: 'activity', timestampMs, awaiting: d.data?.toolName !== 'yield' };
  }
  if (d.type !== 'message') return null;
  const msg = d.message;
  if (msg?.role === 'user') return { kind: 'activity', timestampMs, awaiting: true };
  if (msg?.role === 'toolResult') return { kind: 'activity', timestampMs, awaiting: msg.toolName !== 'yield' };
  if (msg?.role !== 'assistant') return null;
  const stopReason = msg.stopReason ?? null;
  // A turn is still running after a tool-use stop: the next request follows
  // once the tool returns. Any other stop hands control back to the user.
  const awaiting = stopReason === 'toolUse';
  const usage = msg.usage;
  if (!usage || !isClaudeModel(msg)) return { kind: 'activity', timestampMs, awaiting };
  const tokens = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheCreation: usage.cacheWrite ?? 0,
    cacheRead: usage.cacheRead ?? 0,
  };
  if (totalTokens(tokens) === 0) return { kind: 'activity', timestampMs, awaiting };
  return {
    kind: 'usage',
    // The API response id is unique per call; resumed/forked sessions copy the
    // same lines, so it is the dedupe key. Fall back to the entry id.
    key: msg.responseId ?? d.id ?? null,
    date: new Date(timestampMs).toISOString().slice(0, 10),
    model: msg.model ?? 'unknown',
    provider: msg.provider ?? null,
    tokens,
    costUsd: usage.cost?.total ?? 0,
    stopReason,
    awaiting,
    timestampMs,
  };
}

/**
 * Incrementally tails every OMP session file; each returned event carries the
 * `sessionId` and `cwd` of the file it came from.
 */
export class OmpTailer {
  #meta = new Map(); // file -> { id, kind, label, parent, cwd }
  #tailer;
  #root;

  constructor({ ompDir } = {}) {
    this.#root = ompSessionsDir(ompDir ?? defaultOmpDir());
    this.#tailer = new TranscriptTailer({
      root: this.#root,
      extract: (line, file) => this.#extract(line, file),
    });
  }

  #extract(line, file) {
    const ev = extractOmpEvent(line);
    if (!ev) return null;
    let meta = this.#meta.get(file);
    if (!meta) {
      meta = sessionMetaFromFile(file, this.#root);
      this.#meta.set(file, meta);
    }
    if (ev.kind === 'session') {
      // Only the first header counts: a forked session copies the parent's
      // lines, header included, and the file name already names the session.
      if (meta.cwd === null && ev.cwd) meta.cwd = ev.cwd;
      return null;
    }
    const { id, kind, label, parent, cwd } = meta;
    return { ...ev, sessionId: id, sessionKind: kind, sessionLabel: label, parent, cwd, path: file };
  }

  scan() {
    return this.#tailer.scan();
  }
}

/**
 * OMP records which pty each session runs on in
 * `<ompDir>/agent/terminal-sessions/<tty>` (line 1: cwd, line 2: the session
 * file path). Returns session-file-path -> tty (e.g. "ttys004"). Files linger
 * after the session exits, so this says where a session *was*; whether an
 * `omp` process is still on that tty is for the caller to check.
 */
export async function readOmpTerminalSessions(ompDir = defaultOmpDir()) {
  const dir = join(ompDir, 'agent', 'terminal-sessions');
  const out = new Map();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const tty of names) {
    if (!/^ttys?\d+$/.test(tty)) continue;
    try {
      const lines = (await readFile(join(dir, tty), 'utf8')).split('\n');
      const path = (lines[1] ?? '').trim();
      if (path) out.set(path, tty);
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

const folderName = (cwd) => (cwd ? cwd.split('/').filter(Boolean).pop() ?? cwd : null);

/**
 * Live state for the OMP side: lifetime + today's Claude tokens across every
 * OMP session, a per-model breakdown, and one entry per session that was
 * active within `activeWindow` seconds (the "current session" view).
 */
export class OmpLiveState {
  #tailer;
  #now;
  #entries = [];
  #sessions = new Map();
  #rate = new RateWindow();
  #rated = new Set();
  #ompDir;
  #ttyByPath = new Map();
  activeWindow;

  constructor({ ompDir, activeWindow = 600, now = () => new Date() } = {}) {
    this.#ompDir = ompDir ?? defaultOmpDir();
    this.#tailer = new OmpTailer(ompDir ? { ompDir } : {});
    this.#now = now;
    this.activeWindow = activeWindow;
  }

  async scan() {
    const fresh = await this.#tailer.scan();
    const nowMs = this.#now().getTime();
    for (const ev of fresh) this.#apply(ev, nowMs);
    // Refresh the pty map alongside; a failure here must not stop the tail.
    this.#ttyByPath = await readOmpTerminalSessions(this.#ompDir).catch(() => this.#ttyByPath);
    return fresh.length;
  }

  #session(ev) {
    let s = this.#sessions.get(ev.sessionId);
    if (!s) {
      s = {
        id: ev.sessionId,
        kind: ev.sessionKind ?? 'user',
        label: ev.sessionLabel ?? null,
        parent: ev.parent ?? null,
        cwd: ev.cwd,
        path: ev.path ?? null,
        model: null,
        lastEventMs: 0,
        awaiting: false,
        seen: new Set(),
        tokens: 0,
        messages: 0,
        costUsd: 0,
        byModel: new Map(),
        rate: new RateWindow(),
      };
      this.#sessions.set(ev.sessionId, s);
    }
    if (s.cwd === null && ev.cwd) s.cwd = ev.cwd;
    return s;
  }

  #apply(ev, nowMs) {
    const s = this.#session(ev);
    if (ev.timestampMs >= s.lastEventMs) {
      s.lastEventMs = ev.timestampMs;
      s.awaiting = ev.awaiting;
    }
    if (ev.kind !== 'usage') return;
    this.#entries.push(ev);
    s.model = ev.model;
    if (ev.key !== null) {
      if (s.seen.has(ev.key)) return;
      s.seen.add(ev.key);
    }
    const n = totalTokens(ev.tokens);
    s.tokens += n;
    s.messages++;
    s.costUsd += ev.costUsd;
    const m = s.byModel.get(ev.model) ?? { model: ev.model, tokens: 0, messages: 0 };
    m.tokens += n;
    m.messages++;
    s.byModel.set(ev.model, m);
    const recent = nowMs - ev.timestampMs <= this.#rate.maxAgeMs;
    if (recent && (ev.key === null || !this.#rated.has(ev.key))) {
      if (ev.key !== null) this.#rated.add(ev.key);
      this.#rate.add(ev.timestampMs, n);
      s.rate.add(ev.timestampMs, n);
    }
  }

  /** Sessions active within the window, most recent first, in wire form. */
  sessions(now = this.#now()) {
    const nowMs = now.getTime();
    const out = [];
    for (const s of this.#sessions.values()) {
      const ageMs = nowMs - s.lastEventMs;
      if (ageMs > this.activeWindow * 1000) continue;
      out.push({
        id: s.id,
        label: s.label ?? folderName(s.cwd) ?? s.id.slice(0, 8),
        kind: s.kind,
        ...(s.parent != null && { parent: s.parent }),
        ...(s.cwd != null && { cwd: s.cwd }),
        ...(s.path != null && { path: s.path }),
        ...(s.path != null && this.#ttyByPath.has(s.path) && { tty: this.#ttyByPath.get(s.path) }),
        ...(s.model != null && { model: s.model }),
        state: s.awaiting ? 'running' : 'idle',
        total: s.tokens,
        messages: s.messages,
        costUsd: Math.round(s.costUsd * 10_000) / 10_000,
        tokensPerMin: s.rate.tokensSince(60_000, nowMs),
        models: [...s.byModel.values()].sort((a, b) => b.tokens - a.tokens),
        lastEventAt: new Date(s.lastEventMs).toISOString(),
        ageSec: Math.max(0, Math.round(ageMs / 1000)),
      });
    }
    return out.sort((a, b) => a.ageSec - b.ageSec);
  }

  /** Wire form of the whole OMP side (what `claude.omp` carries in a snapshot). */
  frame(now = this.#now()) {
    const report = summarize(this.#entries, { now });
    const today = now.toISOString().slice(0, 10);
    let costUsd = 0;
    const seen = new Set();
    for (const e of this.#entries) {
      if (e.key !== null) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
      }
      costUsd += e.costUsd;
    }
    return {
      today: report.dailyUsageBuckets.find((b) => b.startDate === today)?.tokens ?? 0,
      lifetime: report.summary.lifetimeTokens,
      messages: report.summary.assistantMessages,
      costUsd: Math.round(costUsd * 100) / 100,
      perMinute: this.#rate.tokensSince(60_000, now.getTime()),
      models: report.modelBreakdown,
      sessions: this.sessions(now),
    };
  }
}
