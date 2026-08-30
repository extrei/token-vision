# codex-usage

Node.js client for the Codex CLI app-server that reads account token usage via the
`account/usage/read` JSON-RPC method.

## Usage

```sh
node src/read-usage.js            # human-readable summary
node src/read-usage.js --json     # raw JSON response
node src/read-usage.js --thread-id <id>   # estimated usage for one thread
node src/read-usage.js --codex /path/to/codex --timeout 10000
```

Requires the `codex` CLI on `PATH` (tested with codex-cli 0.148.0) and an
authenticated Codex account (`codex login`).

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

## Tests

```sh
npm test                     # unit tests against a mock app-server on stdio
CODEX_INTEGRATION=1 npm test # also hits the real codex app-server
```
