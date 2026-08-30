# codex-usage

Node.js clients that read account token usage for both CLI agents:

- **Codex** — live from the `codex app-server` JSON-RPC method `account/usage/read`
- **Claude Code** — aggregated offline from the local session transcripts in
  `~/.claude/projects/**/*.jsonl` (there is no per-user usage API for Pro/Max
  accounts: the `/usage` screen is interactive-only and the Admin/Analytics
  usage APIs require an organization admin key)

## Usage

```sh
node src/read-usage.js            # human-readable summary
node src/read-usage.js --json     # raw JSON response
node src/read-usage.js --thread-id <id>   # estimated usage for one thread
node src/read-usage.js --codex /path/to/codex --timeout 10000
```

Requires the `codex` CLI on `PATH` (tested with codex-cli 0.148.0) and an
authenticated Codex account (`codex login`).

### Claude Code

```sh
node src/read-claude-usage.js           # human-readable summary
node src/read-claude-usage.js --json    # raw JSON report
node src/read-claude-usage.js --claude-dir /path/to/.claude --days 30
```

Reads `<claude-dir>/projects/**/*.jsonl` (default `$CLAUDE_CONFIG_DIR` or
`~/.claude`) and produces the same shape as the Codex response: `summary`
(lifetime/peak tokens, streaks, plus input/output/cache splits), UTC-bucketed
`dailyUsageBuckets`, and a per-model breakdown. Duplicated transcript lines
(resumed/forked sessions) are deduplicated by message id + request id;
synthetic error placeholders are skipped. Caveats: local machine only, and the
transcript format is internal to Claude Code and may change between versions.

## Protocol

`codex app-server` speaks JSON-RPC 2.0 as newline-delimited JSON over stdio
(no Content-Length framing). The flow this client performs:

1. `initialize` request with `{ clientInfo: { name, version }, capabilities: { experimentalApi: true } }`
   (`account/usage/read` is stable API, so the `experimentalApi` capability is optional)
2. `initialized` notification
3. `account/usage/read` request — params `{}` or `{ threadId: "..." }`

Requires ChatGPT-backed auth: without it the server answers with JSON-RPC error
`-32600` ("codex account authentication required..." / "chatgpt authentication
required to read token usage"). `-32001` means the server is overloaded (retry).

The response shape (from `codex app-server generate-json-schema`):

```jsonc
{
  "summary": {
    "lifetimeTokens": 123,          // int64 | null
    "peakDailyTokens": 123,         // int64 | null
    "currentStreakDays": 1,         // int64 | null
    "longestStreakDays": 1,         // int64 | null
    "longestRunningTurnSec": 1      // int64 | null
  },
  "dailyUsageBuckets": [            // array | null
    { "startDate": "2026-08-29", "tokens": 123 }
  ],
  "threadUsage": {                  // only when threadId was requested; else null
    "threadId": "...",
    "estimatedUsageCreditsMicros": 123,
    "estimatedUsageUsdMicros": 123, // int64 | null
    "groups": [ /* per-model token breakdown */ ]
  }
}
```

### Live terminal view

```sh
npm run live                       # repaints in place; ctrl-c to quit
node src/live-usage.js --interval 2 --codex-interval 30 --days 14
node src/live-usage.js --once      # single frame, no screen control
node src/live-usage.js --no-codex  # Claude transcripts only
```

Tails the Claude transcripts incrementally (per-file byte offsets, partial-line
buffering) for a live tokens-per-minute rate, and polls the Codex app-server for
account usage plus `account/rateLimits/read` utilization (colored bar, reset
time). Sparklines show the last N days per agent. Codex being unavailable or
unauthenticated degrades to a note; the Claude side keeps running.

## Tests

```sh
npm test                     # unit tests against a mock app-server on stdio
CODEX_INTEGRATION=1 npm test # also hits the real codex app-server
```
