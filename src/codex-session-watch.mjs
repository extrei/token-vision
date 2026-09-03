#!/usr/bin/env node
// codex-session-watch.mjs — zero-dependency (Node >= 22) monitor for *current* Codex
// session token usage. It works cross-process by tailing the rollout JSONL files that
// every Codex front-end (CLI, Codex Desktop, VS Code extension, app-server) appends to
// under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>[_<rollout-id>].jsonl.
//
// It is strictly read-only: it never talks to the app-server, never opens the SQLite
// state DBs, and never spends model quota. Usable as a CLI (`node codex-session-watch.mjs`)
// or as a module: `new SessionWatcher(opts).poll()` returns the per-session snapshots that
// `live-usage.js --stream` forwards to the menu-bar widget as `codex.sessions`.
//
// Line shapes we care about (one JSON object per line, timestamps are UTC ISO):
//   {"type":"session_meta","payload":{id,cwd,originator,cli_version,source,...}}   (line 1)
//   {"type":"turn_context","payload":{turn_id,model,effort,...}}                    (per turn)
//   {"type":"event_msg","payload":{"type":"token_count","info":{...}|null,"rate_limits":{...}|null}}
//   {"type":"event_msg","payload":{"type":"task_started"|"task_complete"|"turn_aborted",...}}
//
// Semantics learned from codex-rs (0.148–0.152) and verified against live rollouts:
//   * token_count is emitted once per model response, but only AFTER that response's tool
//     calls have resolved (so a long-running command delays it), and it is re-emitted with
//     identical totals after compaction / settings changes / rate-limit refreshes. A line
//     may carry info:null (rate-limit-only refresh). We therefore merge, never replace,
//     and derive rates from deltas of the cumulative counter, not from event counts.
//   * total_token_usage is cumulative only since the thread was last loaded into a Codex
//     process: it restarts from the response's own usage when a thread is re-triggered
//     after being idle/unloaded. The `resets` field counts those.
//   * Forked / spawned threads copy the parent's history (including its session_meta)
//     into the new file, so only the FIRST session_meta identifies a rollout.
//   * thread/revert starts a new file `..._<rollout-id>.jsonl`; old files stop growing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const RATE_WINDOW_MS = 60_000;      // tokens/min window
const HEAD_BYTES = 64 << 10;        // first line (session_meta) lives here
const TAIL_BYTES = 256 << 10;       // initial backwards read for bootstrap
const MAX_LINE = 1 << 20;           // lines longer than this can never be one we parse
const READ_BUF = Buffer.allocUnsafe(4 << 20);
const EMPTY = Buffer.alloc(0);
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
// Cheap pre-filter anchored on the type key so we do not JSON.parse every rollout line.
const LINE_HINT = /"type":\s*"(session_meta|turn_context|token_count|task_started|task_complete|turn_aborted)"/;
const META_KEEP = ['id', 'cwd', 'source', 'thread_source', 'parent_thread_id', 'forked_from_id',
  'originator', 'cli_version', 'model', 'agent_nickname', 'agent_role'];

const USAGE = `codex-session-watch — live token usage for Codex sessions (read-only rollout tailer)

usage: node codex-session-watch.mjs [options]

  --session <id-prefix>   watch only the thread whose id starts with <id-prefix> (implies --all)
  --cwd <path>            only sessions whose session_meta.cwd equals / is under <path>
  --all                   include idle sessions from the lookback window (default: active only)
  --lookback-days <n>     include rollouts started or modified in the last n days (default 3)
  --active-window <sec>   session is "active" if its rollout mtime is within n seconds (default 600)
  --interval <ms>         poll interval (default 1000, min 50)
  --rescan <sec>          re-list the session directories every n seconds (default 10)
  --once                  print a single frame (no screen control) and exit
  --stream                NDJSON: one object on start, then one per detected change
  --help                  this text

env: CODEX_HOME (default ~/.codex)

Columns: total = Codex's cumulative counter since the thread was last loaded (resets on
reload; see "resets" in --stream), last = tokens of the most recent model call, ctx% =
Codex /status formula (last.total-12k)/(window-12k), tok/min = growth of the cumulative
counter over the trailing 60 s, state = running | idle | stale (running but no writes
for longer than --active-window).`;

// ----------------------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { session: null, cwd: null, all: false, lookbackDays: 3, activeWindow: 600,
    interval: 1000, rescan: 10, once: false, stream: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    const num = (min) => {
      const raw = next(), v = Number(raw);
      if (raw === undefined || raw === '' || !Number.isFinite(v) || v < min) {
        console.error(`${a} needs a number >= ${min}`); process.exit(2);
      }
      return v;
    };
    if (a === '--session') { o.session = next(); o.all = true; }
    else if (a === '--cwd') o.cwd = realpath(next() ?? '.');
    else if (a === '--all') o.all = true;
    else if (a === '--lookback-days') o.lookbackDays = num(0);
    else if (a === '--active-window') o.activeWindow = num(1);
    else if (a === '--interval') o.interval = num(50);
    else if (a === '--rescan') o.rescan = num(1);
    else if (a === '--once') o.once = true;
    else if (a === '--stream' || a === '--json-lines') o.stream = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error(`unknown option: ${a}\n\n${USAGE}`); process.exit(2); }
  }
  if (!o.session) o.session = null; else if (!/^[0-9a-f-]+$/i.test(o.session)) {
    console.error('--session expects a thread id prefix (hex/dashes)'); process.exit(2);
  }
  return o;
}

// ------------------------------------------------------------------------ discovery
// Day directories are named by the session's START date (writer-local), while a thread can
// keep growing for days, so we take every file in a recent day dir plus any older file whose
// mtime is inside the lookback window. `sessionFilter` (thread id prefix) is matched on the
// file name so non-matching rollouts are never opened.
export function listRolloutFiles(sessionsRoot, lookbackDays, sessionFilter) {
  const now = Date.now();
  const dayCutoff = now - (lookbackDays + 1) * 86_400_000;
  const mtimeCutoff = now - Math.max(lookbackDays, 1) * 86_400_000;
  const out = [];
  const safeList = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const y of safeList(sessionsRoot)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of safeList(path.join(sessionsRoot, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of safeList(path.join(sessionsRoot, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        const recentDay = Date.UTC(+y, +m - 1, +d) >= dayCutoff;
        const dir = path.join(sessionsRoot, y, m, d);
        for (const f of safeList(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          if (sessionFilter && !f.includes(sessionFilter)) continue;
          const full = path.join(dir, f);
          if (recentDay) { out.push(full); continue; }
          let st; try { st = fs.statSync(full); } catch { continue; }
          if (st.mtimeMs >= mtimeCutoff) out.push(full);
        }
      }
    }
  }
  return out.sort();
}

// --------------------------------------------------------------------------- session
// Mirrors Codex's own /status math (codex-rs/protocol/src/protocol.rs,
// TokenUsage::percent_of_context_window_remaining): both the window and the last
// response's total_tokens are offset by a 12k baseline that covers the system prompt,
// tool definitions and room to run /compact. The result is an integer percent.
export const BASELINE_TOKENS = 12000;
export function contextUsedPercent(last, window) {
  const tot = last?.total_tokens;
  if (typeof tot !== 'number' || typeof window !== 'number' || window <= BASELINE_TOKENS) return null;
  const eff = window - BASELINE_TOKENS, used = Math.max(tot - BASELINE_TOKENS, 0);
  const remaining = Math.round((Math.max(eff - used, 0) / eff) * 100);
  return 100 - Math.min(100, Math.max(0, remaining));
}

// SessionSource serde shapes: "cli" | "vscode" | "exec" | {"subagent": "review"|"compact"|...}
// | {"subagent": {"thread_spawn": {...}} | {"other": "guardian"}} | {"custom": "..."} | {"internal": ...}
export function sourceLabel(src, meta) {
  if (typeof src === 'string') return src;
  if (!src || typeof src !== 'object') return src == null ? '?' : JSON.stringify(src);
  if ('custom' in src) return `custom:${src.custom}`;
  if ('internal' in src) {
    const v = src.internal;
    return `internal:${typeof v === 'string' ? v : Object.keys(v ?? {})[0] ?? '?'}`;
  }
  const sa = src.subagent;
  if (typeof sa === 'string') return `subagent:${sa}`;
  if (sa && typeof sa === 'object') {
    const kind = Object.keys(sa)[0] ?? 'unknown', val = sa[kind];
    if (kind === 'other') return `subagent:${typeof val === 'string' ? val : 'other'}`;
    const nick = val?.agent_nickname ?? meta?.agent_nickname;
    return `subagent:${kind === 'thread_spawn' ? 'spawn' : kind}${nick ? '/' + nick : ''}`;
  }
  return JSON.stringify(src);
}

// realpath that tolerates paths which no longer exist (a session's cwd may be gone):
// resolve the longest existing ancestor and re-append the rest, so /tmp/x and
// /private/tmp/x compare equal on macOS either way.
function realpath(p) {
  p = path.resolve(p);
  let rest = '';
  for (let cur = p; ; ) {
    try { return path.join(fs.realpathSync.native(cur), rest); } catch { /* keep climbing */ }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest = path.join(path.basename(cur), rest); cur = parent;
  }
}
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/i;

export class Session {
  constructor(file) {
    this.path = file;
    this.fileId = (file.match(UUID_RE) ?? [])[1] ?? path.basename(file);
    this.gone = false; this.readError = null; this.ino = null;
    this.reset();
  }
  reset() {
    this.offset = 0; this.pending = EMPTY; this.skipping = false;
    this.meta = null; this.metaTried = false; this.cwdReal = null; this.id = this.fileId;
    this.mtimeMs = 0; this.size = 0;
    this.resetParsed();
  }
  resetParsed() {
    this.parseErrors = 0; this.model = null; this.effort = null;
    this.lastTok = null; this.tokEvents = 0; this.prevTotal = null; this.resets = 0;
    this.recent = []; // {t, tokens} deltas inside the rate window
    this.turnState = 'idle'; this.turnId = null; this.turnKnown = false;
  }
  noteError(e) {
    if (e?.code === 'ENOENT') { this.gone = true; return; }
    if (this.readError !== e?.code) {
      this.readError = e?.code ?? String(e);
      console.error(`codex-session-watch: ${this.path}: ${e?.message ?? e}`);
    }
  }
  // Reads only the first line (session_meta) so filters can be applied before the
  // (possibly large) rest of the file is touched.
  ensureMeta() {
    if (this.meta || this.metaTried) return;
    this.metaTried = true;
    try {
      const fd = fs.openSync(this.path, 'r');
      try {
        const n = fs.readSync(fd, READ_BUF, 0, HEAD_BYTES, 0);
        const nl = READ_BUF.subarray(0, n).indexOf(0x0a);
        if (nl >= 0) this.handleLine(READ_BUF.subarray(0, nl).toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch (e) { this.noteError(e); }
  }
  // Incremental tail: read bytes [offset, size), keep an unterminated trailing fragment in
  // `pending` (bytes, so multi-byte UTF-8 split across reads is safe). A shrink or an inode
  // change means truncation/rotation → start over. The first read of a large file uses a
  // head+tail bootstrap instead of scanning every byte.
  tail() {
    let st;
    try { st = fs.statSync(this.path); } catch (e) { this.noteError(e); return false; }
    if ((this.ino != null && st.ino !== this.ino) || st.size < this.offset) this.reset();
    this.ino = st.ino; this.mtimeMs = st.mtimeMs; this.size = st.size;
    if (st.size === this.offset) return false;
    try {
      const fd = fs.openSync(this.path, 'r');
      try {
        if (this.offset === 0 && st.size > HEAD_BYTES + TAIL_BYTES) this.bootstrap(fd, st.size);
        this.readRange(fd, st.size);
      } finally { fs.closeSync(fd); }
    } catch (e) { this.noteError(e); return false; }
    this.readError = null;
    return true;
  }
  bootstrap(fd, size) {
    const hn = fs.readSync(fd, READ_BUF, 0, HEAD_BYTES, 0);
    const hnl = READ_BUF.subarray(0, hn).indexOf(0x0a);
    if (hnl < 0) return; // absurdly long first line: fall back to a full incremental read
    if (!this.meta) this.handleLine(READ_BUF.subarray(0, hnl).toString('utf8'));
    const bodyStart = hnl + 1;
    // Grow the tail window backwards until it holds a usage line and a turn marker.
    for (let span = TAIL_BYTES; ; span *= 4) {
      const start = Math.max(bodyStart, size - span);
      const buf = Buffer.allocUnsafe(size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.subarray(0, n);
      let from = 0;
      if (start > bodyStart) {
        const nl = text.indexOf(0x0a);
        if (nl < 0) continue; // window sits inside one giant line; widen
        from = nl + 1;
      }
      this.resetParsed();
      const lastNl = text.lastIndexOf(0x0a);
      if (lastNl >= from) {
        for (const line of text.subarray(from, lastNl).toString('utf8').split('\n')) this.handleLine(line);
        this.pending = Buffer.from(text.subarray(lastNl + 1));
      } else {
        this.pending = Buffer.from(text.subarray(from));
      }
      this.offset = size;
      // Stop once usage + turn state are known (and the model, unless that needs > 4 MB).
      if ((this.lastTok && this.turnKnown && (this.model || span >= (4 << 20))) || start <= bodyStart) return;
    }
  }
  readRange(fd, size) {
    while (this.offset < size) {
      const n = fs.readSync(fd, READ_BUF, 0, Math.min(READ_BUF.length, size - this.offset), this.offset);
      if (n <= 0) break;
      this.offset += n;
      let data = READ_BUF.subarray(0, n);
      if (this.skipping) { // inside a line too long to matter: drop up to its newline
        const nl = data.indexOf(0x0a);
        if (nl < 0) continue;
        data = data.subarray(nl + 1); this.skipping = false;
      }
      this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : Buffer.from(data);
      const nl = this.pending.lastIndexOf(0x0a);
      if (nl < 0) {
        if (this.pending.length > MAX_LINE) { this.pending = EMPTY; this.skipping = true; }
        continue; // no complete line yet; wait for more bytes
      }
      const complete = this.pending.subarray(0, nl).toString('utf8');
      this.pending = Buffer.from(this.pending.subarray(nl + 1));
      for (const line of complete.split('\n')) this.handleLine(line);
    }
  }
  handleLine(line) {
    if (!line || line.length > MAX_LINE || !LINE_HINT.test(line)) return;
    let obj; try { obj = JSON.parse(line); } catch { this.parseErrors++; return; }
    const p = obj.payload ?? {};
    if (obj.type === 'session_meta') {
      // Forked threads (thread/fork, spawned subagents) copy the parent's history into
      // the new rollout, including the parent's session_meta; only the first one is ours.
      if (this.meta) return;
      this.meta = Object.fromEntries(META_KEEP.filter((k) => k in p).map((k) => [k, p[k]]));
      if (p.id) this.id = p.id;
      if (p.model) this.model = p.model; // usually absent; turn_context is authoritative
      this.cwdReal = typeof p.cwd === 'string' ? realpath(p.cwd) : null;
    } else if (obj.type === 'turn_context') {
      if (p.model) this.model = p.model; // latest turn wins (model can change mid-thread)
      if (p.effort) this.effort = p.effort;
    } else if (obj.type === 'event_msg') {
      const t = Date.parse(obj.timestamp) || Date.now();
      if (p.type === 'token_count') this.onTokenCount(obj.timestamp, t, p.info, p.rate_limits);
      else if (p.type === 'task_started') {
        this.turnState = 'running'; this.turnId = p.turn_id ?? null; this.turnKnown = true;
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        this.turnState = 'idle'; this.turnId = null; this.turnKnown = true;
      }
    }
  }
  onTokenCount(ts, t, info, rl) {
    this.tokEvents++;
    const prev = this.lastTok ?? {};
    this.lastTok = { ts, t,
      total: info?.total_token_usage ?? prev.total ?? null,
      last: info?.last_token_usage ?? prev.last ?? null,
      window: info?.model_context_window ?? prev.window ?? null,
      rateLimits: rl ?? prev.rateLimits ?? null };
    const tot = info?.total_token_usage?.total_tokens;
    if (typeof tot !== 'number') return;
    let delta = 0;
    if (this.prevTotal == null) delta = 0;               // first sample: no baseline yet
    else if (tot >= this.prevTotal) delta = tot - this.prevTotal; // 0 for re-emits
    else { delta = tot; this.resets++; }                  // counter restarted on reload
    this.prevTotal = tot;
    if (delta > 0) this.recent.push({ t, tokens: delta });
    const floor = t - RATE_WINDOW_MS;
    while (this.recent.length && this.recent[0].t < floor) this.recent.shift();
  }
  // Plain-data view used by both the table and --stream.
  snapshot(now, activeWindowSec) {
    const m = this.meta ?? {}, lt = this.lastTok;
    const floor = now - RATE_WINDOW_MS;
    const tokPerMin = this.recent.reduce((s, e) => (e.t >= floor ? s + e.tokens : s), 0);
    const pick = (u) => u ? Object.fromEntries(TOKEN_FIELDS.map((k) => [k, u[k] ?? 0])) : null;
    const rl = lt?.rateLimits ?? null;
    const lim = (x) => x ? { usedPercent: x.used_percent ?? null, windowMinutes: x.window_minutes ?? null,
      resetsAt: x.resets_at ?? null } : null;
    const active = now - this.mtimeMs <= activeWindowSec * 1000;
    const turnState = this.turnState === 'running' && !active ? 'stale' : this.turnState;
    return {
      // UUIDv7 ids share their leading hex when threads start close together (parent +
      // spawned subagents), so the short id keeps the first two groups plus the last four.
      id: this.id, shortId: `${this.id.slice(0, 13)}…${this.id.slice(-4)}`, path: this.path,
      source: sourceLabel(m.source, m), threadSource: m.thread_source ?? null,
      parentThreadId: m.parent_thread_id ?? null, forkedFromId: m.forked_from_id ?? null,
      cwd: m.cwd ?? null, originator: m.originator ?? null, cliVersion: m.cli_version ?? null,
      model: this.model, effort: this.effort,
      active, mtimeMs: this.mtimeMs, bytes: this.size,
      lastEventTs: lt?.ts ?? null, lastEventAgeSec: lt ? (now - lt.t) / 1000 : null,
      turnState, turnId: this.turnId,
      total: pick(lt?.total), last: pick(lt?.last), modelContextWindow: lt?.window ?? null,
      ctxUsedPercent: contextUsedPercent(lt?.last, lt?.window), tokensPerMin: tokPerMin,
      resets: this.resets,
      rateLimits: rl ? { primary: lim(rl.primary), secondary: lim(rl.secondary),
        planType: rl.plan_type ?? null } : null,
      tokenCountEvents: this.tokEvents, parseErrors: this.parseErrors, readError: this.readError,
    };
  }
}

// ------------------------------------------------------------------------ formatting
const fmtTok = (n) => n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
function fmtDur(sec) { // 28s, 5m12s, 2h05m, 4d15h
  if (sec == null || !isFinite(sec)) return '-';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
    m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (d) return `${d}d${String(h).padStart(2, '0')}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
const fmtIn = (unixSec, now) => {
  if (!unixSec) return '';
  const d = unixSec - now / 1000;
  return d <= 0 ? `reset ${fmtDur(-d)} ago` : 'in ' + fmtDur(d);
};
const tailStr = (s, n) => s == null ? '-' : s.length > n ? '…' + s.slice(-(n - 1)) : s;
const cell = (s, w, right) => { s = String(s ?? '-'); if (s.length > w) s = s.slice(0, w - 1) + '…';
  return right ? s.padStart(w) : s.padEnd(w); };

const COLS = [ // [header, width, right-align, getter]
  ['id', 18, false, (s) => s.shortId],
  ['source', 22, false, (s) => s.source],
  ['cwd', 30, false, (s) => tailStr(s.cwd, 30)],
  ['model', 17, false, (s) => s.model],
  ['total', 8, true, (s) => fmtTok(s.total?.total_tokens)],
  ['last', 7, true, (s) => fmtTok(s.last?.total_tokens)],
  ['ctx%', 4, true, (s) => s.ctxUsedPercent == null ? '-' : `${s.ctxUsedPercent}%`],
  ['tok/min', 7, true, (s) => fmtTok(s.tokensPerMin)],
  ['rate-limit', 20, false, (s, now) => s.rateLimits?.primary
    ? `${s.rateLimits.primary.usedPercent}% ${fmtIn(s.rateLimits.primary.resetsAt, now)}` : '-'],
  ['age', 6, true, (s) => fmtDur(s.lastEventAgeSec)],
  ['state', 7, false, (s) => s.turnState],
];

function renderTable(snaps, opts, now, known, nextPollMs) {
  const lines = [];
  lines.push(`codex-session-watch  root=${opts.sessionsRoot}  lookback=${opts.lookbackDays}d  ` +
    `active<=${opts.activeWindow}s  showing ${snaps.length}/${known} sessions` +
    (opts.session ? `  session=${opts.session}` : '') + (opts.cwd ? `  cwd=${opts.cwd}` : ''));
  lines.push(COLS.map(([h, w, r]) => cell(h, w, r)).join('  '));
  lines.push(COLS.map(([, w]) => '-'.repeat(w)).join('  '));
  if (!snaps.length) lines.push('(no matching sessions — try --all or a larger --active-window)');
  for (const s of snaps) lines.push(COLS.map(([, w, r, get]) => cell(get(s, now), w, r)).join('  '));
  const d = new Date(now);
  lines.push('');
  lines.push(`${d.toLocaleTimeString()} local (${d.toISOString().slice(11, 19)}Z)` +
    (nextPollMs == null ? '' : `  next poll in ${(nextPollMs / 1000).toFixed(1)}s  Ctrl-C to quit`) +
    `  ctx% = Codex /status formula: (last.total-12k)/(window-12k)`);
  return lines.join('\n');
}

// --------------------------------------------------------------------------- watcher
/**
 * Discovers rollout files and tails them; `poll()` returns one plain-data snapshot per
 * selected session (newest first). Options mirror the CLI flags.
 */
export class SessionWatcher {
  constructor({ codexHome, sessionsRoot, lookbackDays = 3, activeWindow = 600, rescanSec = 10,
    session = null, cwd = null, all = false } = {}) {
    this.sessionsRoot = sessionsRoot ??
      path.join(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    this.lookbackDays = lookbackDays; this.activeWindow = activeWindow; this.rescanSec = rescanSec;
    this.session = session; this.cwd = cwd == null ? null : realpath(cwd); this.all = all || !!session;
    this.sessions = new Map(); // rollout path -> Session
    this.lastRescan = -Infinity;
  }
  get known() { return this.sessions.size; }
  rescan(now = Date.now()) {
    const files = new Set(listRolloutFiles(this.sessionsRoot, this.lookbackDays, this.session));
    for (const f of files) if (!this.sessions.has(f)) this.sessions.set(f, new Session(f));
    for (const [f, s] of this.sessions) if (!files.has(f) || s.gone) this.sessions.delete(f);
    this.lastRescan = now;
  }
  /** Tail every known rollout and return the snapshots that pass the filters. */
  poll(now = Date.now()) {
    if (now - this.lastRescan >= this.rescanSec * 1000) this.rescan(now);
    const snaps = [];
    for (const [f, s] of this.sessions) {
      if (this.cwd || this.session) {
        s.ensureMeta();
        if (s.gone) { this.sessions.delete(f); continue; }
        if (this.session && !s.id.startsWith(this.session)) continue;
        if (this.cwd && s.cwdReal !== null &&
          !(s.cwdReal === this.cwd || s.cwdReal.startsWith(this.cwd + path.sep))) continue;
        if (this.cwd && s.cwdReal === null && s.meta) continue;
      }
      s.tail();
      if (s.gone) { this.sessions.delete(f); continue; }
      const snap = s.snapshot(now, this.activeWindow);
      if (this.cwd && snap.cwd === null) continue;
      if (!this.all && !snap.active) continue;
      snaps.push(snap);
    }
    return snaps.sort((a, b) => (b.mtimeMs - a.mtimeMs));
  }
}

// ------------------------------------------------------------------------------ main
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const watcher = new SessionWatcher({ lookbackDays: opts.lookbackDays, activeWindow: opts.activeWindow,
    rescanSec: opts.rescan, session: opts.session, cwd: opts.cwd, all: opts.all });
  opts.sessionsRoot = watcher.sessionsRoot;

  // A closed pipe (`| head`) must end the watcher quietly, not with a stack trace.
  let stdoutBlocked = false;
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  process.stdout.on('drain', () => { stdoutBlocked = false; });
  const write = (s, droppable) => {
    if (droppable && stdoutBlocked) return;
    if (!process.stdout.write(s)) stdoutBlocked = true;
  };

  // --once: a single frame with no screen control.
  if (opts.once) {
    const now = Date.now();
    const snaps = watcher.poll(now);
    if (opts.stream) write(JSON.stringify({ type: 'start', ts: new Date(now).toISOString(), sessions: snaps }) + '\n');
    else write(renderTable(snaps, opts, now, watcher.known, null) + '\n');
    return;
  }

  // Long-running: poll every --interval, rescan dirs every --rescan seconds.
  const tui = !opts.stream && process.stdout.isTTY;
  const prevSig = new Map(); // rollout path -> change signature
  const sig = (s) => JSON.stringify([s.lastEventTs, s.turnState, s.total?.total_tokens,
    s.rateLimits?.primary?.usedPercent, s.model, s.active]);
  const cleanup = () => { if (tui) process.stdout.write('\x1b[?25h\n'); process.exit(0); };
  process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
  if (tui) process.stdout.write('\x1b[?25l');

  let first = true, lastFrameSig = null;
  const tick = () => {
    const now = Date.now();
    const snaps = watcher.poll(now);
    const ts = new Date(now).toISOString();
    if (opts.stream) {
      if (first) write(JSON.stringify({ type: 'start', ts, sessions: snaps }) + '\n');
      const seen = new Set();
      for (const s of snaps) {
        seen.add(s.path);
        const cur = sig(s), prev = prevSig.get(s.path);
        if (!first && cur !== prev) {
          write(JSON.stringify({ type: prev == null ? 'appeared' : 'update', ts, session: s }) + '\n');
        }
        prevSig.set(s.path, cur);
      }
      for (const p of [...prevSig.keys()]) if (!seen.has(p)) {
        prevSig.delete(p); write(JSON.stringify({ type: 'gone', ts, path: p }) + '\n');
      }
    } else if (tui) {
      write('\x1b[H\x1b[2J' + renderTable(snaps, opts, now, watcher.known, opts.interval) + '\n', true);
    } else {
      // Not a terminal: print a frame only when something changed, so logs stay small.
      const frameSig = snaps.map(sig).join('|');
      if (frameSig !== lastFrameSig) {
        lastFrameSig = frameSig;
        write(renderTable(snaps, opts, now, watcher.known, null) + '\n\n', true);
      }
    }
    first = false;
    setTimeout(tick, opts.interval);
  };
  tick();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
