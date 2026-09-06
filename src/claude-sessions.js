import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Live Claude Code sessions, read from the registry Claude Code itself keeps
 * in `~/.claude/sessions/<pid>.json`. Each file describes one running process:
 * its session id, cwd, a human name (auto-titled from the first prompt),
 * `status` (busy while a turn runs, idle once it hands control back), `kind`
 * (`interactive` in a terminal, `bg` for a headless background job driven by
 * the daemon), and for background jobs a `bridgeSessionId` that is the
 * https://claude.ai/code/<id> web view of that session.
 *
 * The file outlives nothing: it is written on start and updated as status
 * changes, so a registry entry whose pid is gone is a stale leftover and is
 * dropped. `spare: true` entries are pre-warmed processes with no user yet.
 *
 * Alongside each session we resolve, from one `ps` pass, the pty it sits on
 * and the GUI app (`.app` bundle) that owns that process tree — enough for the
 * widget to bring the right window forward.
 */

export function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function claudeSessionsDir(claudeDir = defaultClaudeDir()) {
  return join(claudeDir, 'sessions');
}

export const CLAUDE_WEB_SESSION_BASE = 'https://claude.ai/code/';

/**
 * Parse `ps -axo pid=,ppid=,tty=,comm=` output into a pid -> { ppid, tty, comm }
 * map. `comm` on macOS is the executable path, which is what reveals the owning
 * `.app` bundle.
 */
export function parseProcessTable(text) {
  const map = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const tty = m[3] === '??' || m[3] === '?' ? null : m[3];
    map.set(Number(m[1]), { ppid: Number(m[2]), tty, comm: m[4] });
  }
  return map;
}

export function readProcessTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,tty=,comm='], { maxBuffer: 8 << 20 }, (err, out) =>
      resolve(err ? new Map() : parseProcessTable(out)),
    );
  });
}

/** `/Applications/Warp.app/Contents/MacOS/stable` -> `/Applications/Warp.app`. */
export function appBundleOf(comm) {
  const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(comm ?? '');
  return m ? m[1] : null;
}

/**
 * Walk up from `pid` to the first ancestor that lives inside a `.app` bundle
 * (the terminal or IDE hosting the session). Bounded so a cyclic/odd table
 * can't spin.
 */
export function owningApp(pid, table) {
  let cur = pid;
  for (let i = 0; i < 24; i++) {
    const p = table.get(cur);
    if (!p) return null;
    const app = appBundleOf(p.comm);
    if (app) return app;
    if (!p.ppid || p.ppid === cur || p.ppid <= 1) return null;
    cur = p.ppid;
  }
  return null;
}

const baseName = (comm) => String(comm ?? '').split('/').pop().split(' ')[0];

/**
 * The pty of the terminal a process was launched from: the first ancestor
 * (not the process itself) that has a tty. A background job's own tty is a
 * headless daemon pty; the `claude` that spawned it sits on the real one.
 */
export function spawnTTY(pid, table) {
  let cur = table.get(pid)?.ppid ?? 0;
  for (let i = 0; i < 24 && cur > 1; i++) {
    const p = table.get(cur);
    if (!p) return null;
    if (p.tty) return p.tty;
    if (!p.ppid || p.ppid === cur) return null;
    cur = p.ppid;
  }
  return null;
}

/**
 * The .app hosting the process named `comm` (e.g. "omp") on `tty`, or null.
 * Used for tools that only record which pty they run on.
 */
export function appForTTY(tty, table, comm) {
  if (!tty || !table) return null;
  for (const [pid, p] of table) {
    if (p.tty !== tty) continue;
    if (comm && baseName(p.comm) !== comm) continue;
    const app = owningApp(pid, table);
    if (app) return app;
  }
  return null;
}

/**
 * Turn one registry file's JSON into the wire form, or null if it should be
 * hidden (spare process, dead pid, malformed).
 */
export function sessionFromRegistry(entry, table, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.spare === true) return null;
  const pid = Number(entry.pid);
  const id = entry.sessionId;
  if (!Number.isFinite(pid) || typeof id !== 'string' || !id) return null;
  const proc = table.get(pid);
  if (!proc) return null; // process gone — stale registry file
  const status = entry.status === 'busy' ? 'busy' : 'idle';
  const kind = entry.kind === 'interactive' ? 'interactive' : 'bg';
  const bridge = typeof entry.bridgeSessionId === 'string' && entry.bridgeSessionId ? entry.bridgeSessionId : null;
  const name = typeof entry.name === 'string' && entry.name ? entry.name : id.slice(0, 8);
  return {
    id,
    pid,
    label: name,
    kind,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
    status,
    state: status === 'busy' ? 'running' : 'idle',
    statusUpdatedAt: numOrNull(entry.statusUpdatedAt),
    updatedAt: numOrNull(entry.updatedAt),
    startedAt: numOrNull(entry.startedAt),
    // Seconds since the status last changed (same field the other tailers emit).
    ageSec: Math.max(0, Math.round((now - (numOrNull(entry.statusUpdatedAt) ?? numOrNull(entry.updatedAt) ?? now)) / 1000)),
    ...(bridge && { bridgeSessionId: bridge, url: CLAUDE_WEB_SESSION_BASE + bridge }),
    ...(proc.tty && { tty: proc.tty }),
    // The terminal the session is visible in. Interactive: its own pty.
    // Background job: the terminal that launched it (an attached interactive
    // session overrides this later, see `attachParkedTerminals`).
    ...(kind === 'interactive'
      ? proc.tty && { termTty: proc.tty }
      : spawnTTY(pid, table) && { termTty: spawnTTY(pid, table) }),
    ...(owningApp(pid, table) && { app: owningApp(pid, table) }),
    ...(typeof entry.agent === 'string' && { agent: entry.agent }),
    ...(typeof entry.jobId === 'string' && { jobId: entry.jobId }),
    ...(typeof entry.parkedJobId === 'string' && entry.parkedJobId && { parkedJobId: entry.parkedJobId }),
  };
}

/**
 * An interactive session "parks" on a background job to follow it
 * (`parkedJobId`); that terminal is then where the job is on screen. Point
 * the job at that terminal's pty and app, and flag it `attached`.
 */
export function attachParkedTerminals(sessions) {
  const byJob = new Map();
  for (const s of sessions) {
    if (s.kind === 'interactive' && s.parkedJobId) byJob.set(s.parkedJobId, s);
  }
  return sessions.map((s) => {
    if (s.kind !== 'bg' || !s.jobId) return s;
    const host = byJob.get(s.jobId);
    if (!host) return s;
    return {
      ...s,
      attached: true,
      ...(host.termTty && { termTty: host.termTty }),
      ...(host.app && { app: host.app }),
    };
  });
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Scanner: reads every registry file, drops stale/spare ones, resolves tty +
 * owning app from a fresh process table, and returns the live sessions
 * running-first then most recently updated.
 */
export class ClaudeSessionRegistry {
  #dir;
  #readTable;

  constructor({ claudeDir, readTable = readProcessTable } = {}) {
    this.#dir = claudeSessionsDir(claudeDir ?? defaultClaudeDir());
    this.#readTable = readTable;
  }

  /** `table` lets a caller share one process-table read across scanners. */
  async scan(table) {
    let names;
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const files = names.filter((n) => n.endsWith('.json'));
    if (!files.length) return [];
    table ??= await this.#readTable();
    const out = [];
    for (const f of files) {
      let entry;
      try {
        entry = JSON.parse(await readFile(join(this.#dir, f), 'utf8'));
      } catch {
        continue; // half-written or foreign file
      }
      const s = sessionFromRegistry(entry, table);
      if (s) out.push(s);
    }
    return sortSessions(attachParkedTerminals(out));
  }
}

export function sortSessions(list) {
  return [...list].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}
