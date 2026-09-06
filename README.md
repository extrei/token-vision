# Token Vision

Live token usage for **Claude Code**, **OMP (oh-my-pi)** and **Codex**, in the
terminal and in a macOS menu-bar widget. Zero dependencies, read-only, local only.

![preview](https://raw.githubusercontent.com/extrei/token-vision/main/docs/preview.png)

## What it shows

| | Claude Code | Codex |
|---|---|---|
| Today / lifetime tokens | from local transcripts | from `codex app-server` (plus a local same-day estimate, since the API lags) |
| Plan limits | session / weekly windows with reset times | primary / secondary rate-limit windows |
| Live rate | tokens per minute | tokens per minute per thread |
| Per model | lifetime tokens per Claude model, split Claude Code / OMP | — |
| Current sessions | every live Claude Code process (name, terminal / background, running / idle) and every active OMP session (tokens, cost, model) | every running thread, titled from Codex's own state DB: context used, tokens, model, running / idle |
| Open a session | click a row: the terminal (or Claude desktop app) the session is on screen in comes forward — for a background job that is the terminal following it (`parkedJobId`) or the one that launched it; a job with no terminal opens its claude.ai/code web view in the browser; a gone process gets `claude --resume` / `omp -r` in a new Terminal window | click a row: desktop / IDE threads activate the Codex app, CLI threads focus the terminal or `codex resume` |
| Where it's open | each row carries a chip with the hosting app's icon and name — Warp, Terminal, iTerm, the Claude desktop app, or claude.ai for a background job no terminal follows — that brings that app forward (Terminal / iTerm select the session's tab) | same: Codex app, VS Code, or the terminal |
| Finished jobs | a session going running → idle posts a macOS notification, adds to the red counter on the menu-bar icon, and is marked ✓ (red dot while unread) in the list | same |
| OMP (oh-my-pi) | Claude tokens made through OMP: today, total, cost | — |

## Quick start

Requires Node ≥ 22. The Codex side needs the `codex` CLI on `PATH` and a
ChatGPT login (`codex login`); the widget needs Xcode Command Line Tools.

```sh
npm test                                  # unit tests (mock app-server)

node src/live-usage.js                    # live terminal view, ctrl-c to quit
node src/live-usage.js --once             # single frame
node src/live-usage.js --stream           # NDJSON snapshots (what the widget consumes)

node src/codex-session-watch.mjs          # live table of current Codex threads
node src/codex-session-watch.mjs --stream # NDJSON, one object per change

node src/read-usage.js --json             # Codex account usage (account/usage/read)
node src/read-claude-usage.js --json      # Claude usage aggregated from transcripts

sh widget/build.sh && ./widget/TokenVision &   # menu-bar widget; right-click to quit
```

## How it works

- **Claude usage** is summed from `~/.claude/projects/**/*.jsonl` (subagent
  transcripts included, duplicated lines deduplicated).
- **Claude Code sessions** come from the registry Claude Code itself keeps in
  `~/.claude/sessions/<pid>.json` (name, cwd, `status` busy/idle, `kind`
  interactive/bg, and for background jobs the claude.ai/code session id);
  entries whose process is gone and pre-warmed `spare` processes are skipped.
  The pty and hosting app come from one `ps` pass. Disable with
  `--no-claude-sessions`.
- **Codex thread titles** are read from `~/.codex/state_5.sqlite` (table
  `threads`, opened read-only through `node:sqlite`) every 30 s; without them a
  thread is labelled by its folder.
- **Finished-job notifications** are computed by the widget: a session that was
  running in one snapshot and idle in the next fires `display notification`
  (via `osascript`, which works from an unbundled binary), bumps the unread
  badge, and keeps a ✓ mark until the session runs again. Opening the tray
  clears the badge; clicking a row opens that session and clears its mark.
- **OMP usage** is summed from `~/.omp/agent/sessions/**/*.jsonl`: every
  assistant turn carries `provider`, `model`, token usage and cost. Only Claude
  turns count (OMP can route to other providers); they are broken down per model
  next to the Claude Code numbers because both spend the same Claude account. A
  session is "current" while its file was written in the last 10 minutes
  (`--omp-session-window`) and "running" while a turn is in flight (last event
  is a prompt, a tool call, or a tool-use stop). Subagent sessions nest under
  their parent's folder and end with a `yield`. Disable with `--no-omp`.
- **Plan limits** come from the same OAuth usage endpoint Claude Code's
  `/usage` screen uses, with the token from the keychain or
  `~/.claude/.credentials.json`.
- **Codex account usage and rate limits** come from the `codex app-server`
  JSON-RPC API (`account/usage/read`, `account/rateLimits/read`).
- **Codex live sessions** are read by tailing the session rollouts under
  `~/.codex/sessions/`: Codex appends a `token_count` line after every model
  response with the thread's cumulative usage, the last call's size, the
  context window and the rate-limit percent. Context used follows Codex's own
  `/status` formula. The desktop app's app-server cannot be subscribed to from
  outside, so the rollouts are the live source.

## Caveats

- Everything is local to this machine; usage from other devices or cloud tasks
  is invisible until the account API catches up.
- Codex's per-thread total restarts when an idle thread is reloaded, and the
  usage line lands only after a response's tool calls finish.
- The transcript, rollout and usage-endpoint formats are internal to the two
  CLIs and may change between versions (verified against Claude Code and
  Codex 0.148–0.152, OMP 18.1).

## License

MIT
