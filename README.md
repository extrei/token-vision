# Token Vision

Live token usage for **Claude Code** and **Codex**, in the terminal and in a
macOS menu-bar widget. Zero dependencies, read-only, local only.

![preview](https://raw.githubusercontent.com/extrei/token-vision/main/docs/preview.png)

## What it shows

| | Claude Code | Codex |
|---|---|---|
| Today / lifetime tokens | from local transcripts | from `codex app-server` (plus a local same-day estimate, since the API lags) |
| Plan limits | session / weekly windows with reset times | primary / secondary rate-limit windows |
| Live rate | tokens per minute | tokens per minute per thread |
| Current sessions | — | every running thread: context used, tokens, model, running / idle |

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
  transcripts included, duplicated lines deduplicated). **Plan limits** come
  from the same OAuth usage endpoint Claude Code's `/usage` screen uses, with
  the token from the keychain or `~/.claude/.credentials.json`.
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
  Codex 0.148–0.152).

## License

MIT
