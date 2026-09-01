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
`dailyUsageBuckets`, and a per-model breakdown. The scan is recursive: besides the session
transcripts one level down, subagent transcripts nest deeper
(`<project>/<session-id>/subagents/agent-*.jsonl`) and carry their own API
usage — on an agent-heavy setup they hold roughly as many tokens as the main
sessions, so skipping them undercounts lifetime by about half. Duplicated
transcript lines (resumed/forked sessions rewrite the same API response up to
a dozen times with byte-identical usage) are deduplicated by message id +
request id; synthetic error placeholders are skipped. Caveats: local machine only, and the
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

**Claude plan limits**: the live views also show the `/usage`-style plan
windows (session / weekly / weekly opus utilization with reset times), fetched
the way Claude Code itself does — the OAuth usage endpoint
(`api.anthropic.com/api/oauth/usage`) with the token from
`$CLAUDE_CODE_OAUTH_TOKEN`, `~/.claude/.credentials.json`, or the macOS
Keychain. This endpoint is not officially documented, so it degrades to a
dim "limits unavailable" note on any failure; `--no-claude-limits` disables
the fetch entirely and `--claude-limits-interval` tunes the poll (default 60s).

**Codex "today" estimate**: the backend's `dailyUsageBuckets` lag behind and
usually stop at yesterday, so live views fill today's bucket from the local
session rollouts (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, summing
`token_count` events' `last_token_usage.total_tokens` by event timestamp, with
a 7-day directory lookback for long-running sessions). The shown value is
`max(api, local)` and marked `~ (local estimate)` when the local floor wins —
local rollouts can't see usage from other devices or cloud tasks (validated at
95–97% of the API's figure for same-machine days). `--codex-home` overrides
the rollout location.

### Notch widget (macOS)

```sh
sh widget/build.sh        # compiles widget/TokenVision (needs Xcode CLT)
./widget/TokenVision &    # black pill under the notch; right-click it to quit
```

A small native SwiftUI app that runs `node src/live-usage.js --stream` (NDJSON
snapshots) and mirrors it live. A black pill hangs from the right edge of the
notch (top-right corner on notch-less displays, always on the menu-bar
screen) with one ring gauge per agent — Claude and Codex — showing the most-used
plan-limit window, colored by severity (green < 40%, yellow < 70%, red).
Hovering a ring opens a callout listing every window (`Current session`,
`All models` / `Weekly`, …) with a bar, percent used, and the reset time
(`Resets in 51 min`, `Resets Thu 12:00 AM`). Right-click the pill to quit.
The streamer is relaunched automatically if it dies; pass a custom script
path as the first argument if you move things around.

## Tests

```sh
npm test                     # unit tests against a mock app-server on stdio
CODEX_INTEGRATION=1 npm test # also hits the real codex app-server
```
