import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Human titles for Codex threads, read from Codex's own state database
 * (`~/.codex/state_5.sqlite`, table `threads`): `name` is the short auto-title
 * ("Inspect repo structure"), `title`/`first_user_message` the opening prompt.
 * The rollout files the live tailer reads carry no title, only a cwd.
 *
 * The DB must be opened truly read-only: a read-write open would checkpoint
 * and delete the WAL when it is the sole connection, racing the app. Any
 * failure (no node:sqlite, missing/locked DB, schema drift) degrades to "no
 * titles" — the session list still works, just labelled by folder.
 */

export function defaultCodexStatePath() {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite');
}

/** Pick the best short label from a threads row; null if it has none. */
export function titleFromRow(row) {
  if (!row) return null;
  const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const name = clean(row.name);
  if (name) return name;
  // The opening prompt: drop attachment preambles, keep the first sentence-ish.
  let first = clean(row.first_user_message) || clean(row.title);
  first = first.replace(/^#.*?My request:\s*/i, '').replace(/^\/goal\s+/i, '');
  if (!first) return null;
  return first.length > 60 ? first.slice(0, 57).trimEnd() + '…' : first;
}

/**
 * Cached id -> title lookup. `refresh()` re-reads the DB (cheap: one indexed
 * query over the given ids) and is meant to be called every ~30 s.
 */
export class CodexTitles {
  #path;
  #open;
  #db = null;
  #titles = new Map();
  #failed = false;

  constructor({ path = defaultCodexStatePath(), open } = {}) {
    this.#path = path;
    this.#open = open ?? defaultOpen;
  }

  get(id) {
    return this.#titles.get(id) ?? null;
  }

  async refresh(ids) {
    const want = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x))];
    if (!want.length || this.#failed) return;
    try {
      this.#db ??= await this.#open(this.#path);
      if (!this.#db) {
        this.#failed = true;
        return;
      }
      const placeholders = want.map(() => '?').join(',');
      const rows = this.#db
        .prepare(`SELECT id, name, title, first_user_message FROM threads WHERE id IN (${placeholders})`)
        .all(...want);
      for (const r of rows) {
        const t = titleFromRow(r);
        if (t) this.#titles.set(r.id, t);
      }
    } catch {
      // Locked / schema changed / DB vanished: keep whatever we had, try later.
      try {
        this.#db?.close?.();
      } catch {
        /* ignore */
      }
      this.#db = null;
    }
  }

  close() {
    try {
      this.#db?.close?.();
    } catch {
      /* ignore */
    }
    this.#db = null;
  }
}

async function defaultOpen(path) {
  let mod;
  try {
    mod = await import('node:sqlite');
  } catch {
    return null; // older Node without the built-in driver
  }
  try {
    const db = new mod.DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=500');
    return db;
  } catch {
    return null;
  }
}
