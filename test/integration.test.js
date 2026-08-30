import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUsage } from '../src/read-usage.js';

const enabled = process.env.CODEX_INTEGRATION === '1';

test(
  'reads account usage from the real codex binary',
  {
    skip: enabled ? false : 'set CODEX_INTEGRATION=1 to run against the real codex binary',
    timeout: 30_000,
  },
  async () => {
    const usage = await readUsage({ timeoutMs: 30_000 });
    assert.ok(usage && typeof usage === 'object', 'expected a result object');
    assert.ok(usage.summary && typeof usage.summary === 'object', 'expected a summary object');
  },
);
