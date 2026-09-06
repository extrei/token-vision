import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractOmpEvent,
  sessionIdFromFile,
  sessionMetaFromFile,
  isClaudeModel,
  ompSessionsDir,
  OmpTailer,
  OmpLiveState,
} from '../src/omp-usage.js';
import { mergeModels, buildSnapshot, renderFrame } from '../src/live.js';
import { createLiveState } from '../src/live-usage.js';

const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/claude-dir', import.meta.url));

// Fixed clock: "today" is 2026-09-04 UTC.
const NOW = new Date('2026-09-04T15:30:00Z');
const at = (secondsBeforeNow) => new Date(NOW.getTime() - secondsBeforeNow * 1000).toISOString();

const line = (obj) => JSON.stringify(obj);

// ---------------------------------------------------------------- line builders

const header = (id, cwd, timestamp = '2026-09-04T14:58:03.451Z') =>
  line({ type: 'session', version: 3, id, timestamp, cwd });

const userLine = (id, timestamp, text = 'hi') =>
  line({ type: 'message', id, parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });

/** One assistant turn; tokens default to 100 input + 10 output. */
function assistantLine(
  id,
  timestamp,
  {
    provider = 'anthropic',
    model = 'claude-fable-5-1',
    responseId = `msg_${id}`,
    stopReason = 'stop',
    input = 100,
    output = 10,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0,
    usage = true,
  } = {},
) {
  const message = {
    role: 'assistant',
    provider,
    model,
    api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    // null omits the field (undefined would fall back to the default).
    ...(responseId !== null && { responseId }),
    ...(stopReason !== null && { stopReason }),
  };
  if (usage) {
    message.usage = {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
  }
  return line({ type: 'message', id, parentId: 'p', timestamp, message });
}

const toolStart = (id, timestamp, toolName = 'read') =>
  line({
    type: 'custom',
    customType: 'tool_execution_start',
    data: { toolCallId: `call_${id}`, toolName, startedAt: timestamp },
    id,
    parentId: 'p',
    timestamp,
  });

const toolResult = (id, timestamp, toolName = 'read') =>
  line({
    type: 'message',
    id,
    parentId: 'p',
    timestamp,
    message: { role: 'toolResult', toolCallId: `call_${id}`, toolName, content: [{ type: 'text', text: 'ok' }] },
  });

const jsonl = (...lines) => lines.join('\n') + '\n';

// ---------------------------------------------------------------- temp dir helpers

const SLUG = '-Users-osika-worktree';
const CWD = '/Users/osika/worktree';

/** Fresh temp OMP home with an agent/sessions/<slug> subtree, removed after the test. */
async function tempOmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'agent', 'sessions', SLUG), { recursive: true });
  return dir;
}

const sessionFile = (dir, stem) => join(dir, 'agent', 'sessions', SLUG, `${stem}.jsonl`);
const TS_A = '2026-09-04T14-58-03-451Z';
const UUID_A = '01a06ced-423b-72fe-8b88-d75038a626d6';
const UUID_B = '0b1c2d3e-1111-2222-3333-444455556666';

// ================================================================ extractOmpEvent

test('extractOmpEvent: session header carries id/cwd/timestampMs', () => {
  const got = extractOmpEvent(header('sess-1', CWD, '2026-09-04T14:58:03.451Z'));
  assert.deepEqual(got, {
    kind: 'session',
    id: 'sess-1',
    cwd: CWD,
    timestampMs: Date.parse('2026-09-04T14:58:03.451Z'),
  });
});

test('extractOmpEvent: session header without a timestamp is still returned (timestampMs NaN)', () => {
  const got = extractOmpEvent(line({ type: 'session', id: 'x', cwd: '/a' }));
  assert.equal(got.kind, 'session');
  assert.equal(got.id, 'x');
  assert.equal(got.cwd, '/a');
  assert.ok(Number.isNaN(got.timestampMs));
});

test('extractOmpEvent: session header with no id/cwd yields nulls', () => {
  const got = extractOmpEvent(line({ type: 'session', timestamp: '2026-09-04T14:58:03.451Z' }));
  assert.equal(got.id, null);
  assert.equal(got.cwd, null);
});

test('extractOmpEvent: Claude assistant turn maps usage, cost, key, date, model, awaiting', () => {
  const got = extractOmpEvent(
    assistantLine('62213606', '2026-09-04T15:25:44.240Z', {
      responseId: 'msg_011CeiddTpJHLGw3DFdogNJS',
      stopReason: 'toolUse',
      input: 4,
      output: 330,
      cacheRead: 0,
      cacheWrite: 36123,
      cost: 0.468,
    }),
  );
  assert.deepEqual(got, {
    kind: 'usage',
    key: 'msg_011CeiddTpJHLGw3DFdogNJS',
    date: '2026-09-04',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    tokens: { input: 4, output: 330, cacheCreation: 36123, cacheRead: 0 },
    costUsd: 0.468,
    stopReason: 'toolUse',
    awaiting: true,
    timestampMs: Date.parse('2026-09-04T15:25:44.240Z'),
  });
});

test('extractOmpEvent: assistant "stop" is a usage event that is not awaiting', () => {
  const got = extractOmpEvent(assistantLine('a', '2026-09-04T15:25:44.240Z', { stopReason: 'stop' }));
  assert.equal(got.kind, 'usage');
  assert.equal(got.awaiting, false);
  assert.equal(got.stopReason, 'stop');
});

test('extractOmpEvent: missing stopReason -> null, not awaiting', () => {
  const got = extractOmpEvent(assistantLine('a', '2026-09-04T15:25:44.240Z', { stopReason: null }));
  assert.equal(got.kind, 'usage');
  assert.equal(got.stopReason, null);
  assert.equal(got.awaiting, false);
});

test('extractOmpEvent: model containing "claude" counts even when the provider is not anthropic', () => {
  const got = extractOmpEvent(
    assistantLine('a', '2026-09-04T15:25:44.240Z', { provider: 'openrouter', model: 'anthropic/claude-opus-4-8' }),
  );
  assert.equal(got.kind, 'usage');
  assert.equal(got.provider, 'openrouter');
  assert.equal(got.model, 'anthropic/claude-opus-4-8');
});

test('extractOmpEvent: non-Claude assistant turn is activity only (tokens do not count)', () => {
  const got = extractOmpEvent(
    assistantLine('3f1a6352', '2026-09-04T14:58:24.938Z', {
      provider: 'cerebras',
      model: 'qwen-3.8-27b',
      responseId: 'chatcmpl-1',
      input: 21691,
      output: 161,
    }),
  );
  assert.deepEqual(got, { kind: 'activity', timestampMs: Date.parse('2026-09-04T14:58:24.938Z'), awaiting: false });
});

test('extractOmpEvent: non-Claude assistant toolUse stop is activity that is awaiting', () => {
  const got = extractOmpEvent(
    assistantLine('a', '2026-09-04T14:58:24.938Z', { provider: 'cerebras', model: 'qwen-3.8-27b', stopReason: 'toolUse' }),
  );
  assert.deepEqual(got, { kind: 'activity', timestampMs: Date.parse('2026-09-04T14:58:24.938Z'), awaiting: true });
});

test('extractOmpEvent: user prompt is activity that is awaiting', () => {
  const got = extractOmpEvent(userLine('39ca27ad', '2026-09-04T14:58:22.972Z', 'who are you'));
  assert.deepEqual(got, { kind: 'activity', timestampMs: Date.parse('2026-09-04T14:58:22.972Z'), awaiting: true });
});

test('extractOmpEvent: tool_execution_start is awaiting unless the tool is yield', () => {
  const ts = '2026-09-04T15:25:44.241Z';
  assert.deepEqual(extractOmpEvent(toolStart('8948534d', ts, 'read')), {
    kind: 'activity',
    timestampMs: Date.parse(ts),
    awaiting: true,
  });
  assert.deepEqual(extractOmpEvent(toolStart('16f5dc2a', ts, 'yield')), {
    kind: 'activity',
    timestampMs: Date.parse(ts),
    awaiting: false,
  });
});

test('extractOmpEvent: toolResult is awaiting unless the tool is yield', () => {
  const ts = '2026-09-04T15:27:36.534Z';
  assert.deepEqual(extractOmpEvent(toolResult('r1', ts, 'read')), {
    kind: 'activity',
    timestampMs: Date.parse(ts),
    awaiting: true,
  });
  assert.deepEqual(extractOmpEvent(toolResult('75a940bf', ts, 'yield')), {
    kind: 'activity',
    timestampMs: Date.parse(ts),
    awaiting: false,
  });
});

test('extractOmpEvent: Claude turn with zero usage is activity, missing usage is activity', () => {
  const ts = '2026-09-04T15:25:44.240Z';
  assert.deepEqual(
    extractOmpEvent(assistantLine('z', ts, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
    { kind: 'activity', timestampMs: Date.parse(ts), awaiting: false },
  );
  assert.deepEqual(extractOmpEvent(assistantLine('n', ts, { usage: false, stopReason: 'toolUse' })), {
    kind: 'activity',
    timestampMs: Date.parse(ts),
    awaiting: true,
  });
});

test('extractOmpEvent: usage fields missing from the usage object default to 0 and cost to 0', () => {
  const got = extractOmpEvent(
    line({
      type: 'message',
      id: 'a',
      timestamp: '2026-09-04T15:25:44.240Z',
      message: { role: 'assistant', provider: 'anthropic', model: 'claude-fable-5-1', usage: { output: 7 } },
    }),
  );
  assert.deepEqual(got.tokens, { input: 0, output: 7, cacheCreation: 0, cacheRead: 0 });
  assert.equal(got.costUsd, 0);
});

test('extractOmpEvent: key falls back to the line id, then null', () => {
  const ts = '2026-09-04T15:25:44.240Z';
  assert.equal(extractOmpEvent(assistantLine('lineid', ts, { responseId: null })).key, 'lineid');
  const noIds = line({
    type: 'message',
    timestamp: ts,
    message: { role: 'assistant', provider: 'anthropic', model: 'claude-fable-5-1', stopReason: 'stop', usage: { input: 1 } },
  });
  assert.equal(extractOmpEvent(noIds).key, null);
});

test('extractOmpEvent: model/provider missing -> "unknown" model only when it is still Claude', () => {
  const got = extractOmpEvent(
    line({
      type: 'message',
      id: 'a',
      timestamp: '2026-09-04T15:25:44.240Z',
      message: { role: 'assistant', provider: 'anthropic', stopReason: 'stop', usage: { input: 1 } },
    }),
  );
  assert.equal(got.kind, 'usage');
  assert.equal(got.model, 'unknown');
  // No provider and no model: not Claude -> activity.
  const anon = extractOmpEvent(
    line({
      type: 'message',
      id: 'a',
      timestamp: '2026-09-04T15:25:44.240Z',
      message: { role: 'assistant', stopReason: 'stop', usage: { input: 1 } },
    }),
  );
  assert.equal(anon.kind, 'activity');
});

test('extractOmpEvent: non-session lines without a parseable timestamp are dropped', () => {
  assert.equal(extractOmpEvent(userLine('u', undefined)), null);
  assert.equal(extractOmpEvent(userLine('u', 'not a date')), null);
  assert.equal(extractOmpEvent(assistantLine('a', undefined)), null);
  assert.equal(extractOmpEvent(toolStart('t', undefined)), null);
});

test('extractOmpEvent: garbage, empty, non-JSON and irrelevant lines -> null', () => {
  assert.equal(extractOmpEvent(''), null);
  assert.equal(extractOmpEvent('not json at all'), null);
  // Survives the substring pre-filter, then fails JSON.parse.
  assert.equal(extractOmpEvent('{"type":"message","message":{"role":"assistant","usage":'), null);
  // Valid JSON but no "type" key at all.
  assert.equal(extractOmpEvent(line({ message: { role: 'user' }, timestamp: '2026-09-04T15:25:44.240Z' })), null);
  // model_change lines are not events.
  assert.equal(
    extractOmpEvent(line({ type: 'model_change', id: '5dfc6a00', timestamp: '2026-09-04T14:58:03.477Z', model: 'anthropic/claude-opus-4-8' })),
    null,
  );
  // Other custom events (even ones mentioning "message" so they pass the pre-filter).
  assert.equal(
    extractOmpEvent(
      line({ type: 'custom', customType: 'tool_execution_end', data: { message: 'done' }, id: 'x', timestamp: '2026-09-04T14:58:03.477Z' }),
    ),
    null,
  );
  // A message with an unknown role.
  assert.equal(
    extractOmpEvent(line({ type: 'message', id: 'x', timestamp: '2026-09-04T14:58:03.477Z', message: { role: 'system' } })),
    null,
  );
  // A message with no message body.
  assert.equal(extractOmpEvent(line({ type: 'message', id: 'x', timestamp: '2026-09-04T14:58:03.477Z' })), null);
});

test('isClaudeModel: anthropic provider or a claude model name', () => {
  assert.equal(isClaudeModel({ provider: 'anthropic', model: 'claude-fable-5-1' }), true);
  assert.equal(isClaudeModel({ provider: 'anthropic', model: undefined }), true);
  assert.equal(isClaudeModel({ provider: 'bedrock', model: 'us.anthropic.Claude-Opus' }), true);
  assert.equal(isClaudeModel({ provider: 'cerebras', model: 'qwen-3.8-27b' }), false);
  assert.equal(isClaudeModel({}), false);
});

// ================================================================ sessionMetaFromFile

test('sessionIdFromFile: strips the timestamp prefix and .jsonl', () => {
  assert.equal(sessionIdFromFile(`/x/${SLUG}/${TS_A}_${UUID_A}.jsonl`), UUID_A);
  assert.equal(sessionIdFromFile(`/x/${SLUG}/${TS_A}_${UUID_A}`), UUID_A);
  assert.equal(sessionIdFromFile('/x/plain.jsonl'), 'plain'); // no underscore
});

test('sessionMetaFromFile: top-level file -> user session named by its uuid', () => {
  const root = join('/omp', 'agent', 'sessions');
  const meta = sessionMetaFromFile(join(root, SLUG, `${TS_A}_${UUID_A}.jsonl`), root);
  assert.deepEqual(meta, { id: UUID_A, kind: 'user', label: null, parent: null, cwd: null });
});

test('sessionMetaFromFile: nested file -> subagent named by its stem with the parent uuid', () => {
  const root = join('/omp', 'agent', 'sessions');
  const meta = sessionMetaFromFile(join(root, SLUG, `${TS_A}_${UUID_A}`, 'Explorer.jsonl'), root);
  assert.deepEqual(meta, { id: 'Explorer', kind: 'subagent', label: 'Explorer', parent: UUID_A, cwd: null });
});

test('ompSessionsDir: <ompDir>/agent/sessions', () => {
  assert.equal(ompSessionsDir('/home/x/.omp'), join('/home/x/.omp', 'agent', 'sessions'));
});

// ================================================================ OmpTailer

test('OmpTailer: header cwd is captured and every event carries session identity', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(
      header(UUID_A, CWD),
      line({ type: 'model_change', id: 'mc', timestamp: '2026-09-04T14:58:03.477Z', model: 'anthropic/claude-opus-4-8' }),
      userLine('u1', '2026-09-04T14:58:22.972Z'),
      assistantLine('a1', '2026-09-04T14:58:24.938Z', { stopReason: 'toolUse' }),
      toolStart('t1', '2026-09-04T14:58:25.000Z'),
    ),
  );

  const tailer = new OmpTailer({ ompDir: dir });
  const events = await tailer.scan();
  // The header itself is consumed (not returned); model_change is ignored.
  assert.deepEqual(events.map((e) => e.kind), ['activity', 'usage', 'activity']);
  for (const e of events) {
    assert.equal(e.sessionId, UUID_A);
    assert.equal(e.sessionKind, 'user');
    assert.equal(e.sessionLabel, null);
    assert.equal(e.parent, null);
    assert.equal(e.cwd, CWD);
  }
  assert.equal(events[1].key, 'msg_a1');
});

test('OmpTailer: nested subagent file events carry kind/label/parent and the subagent header cwd', async (t) => {
  const dir = await tempOmpDir(t);
  const parentDir = join(dir, 'agent', 'sessions', SLUG, `${TS_A}_${UUID_A}`);
  await mkdir(parentDir, { recursive: true });
  await writeFile(
    join(parentDir, 'Explorer.jsonl'),
    jsonl(header('sub-own-id', '/Users/osika/other'), userLine('u1', '2026-09-04T15:00:00.000Z')),
  );

  const events = await new OmpTailer({ ompDir: dir }).scan();
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 'Explorer');
  assert.equal(events[0].sessionKind, 'subagent');
  assert.equal(events[0].sessionLabel, 'Explorer');
  assert.equal(events[0].parent, UUID_A);
  assert.equal(events[0].cwd, '/Users/osika/other');
});

test('OmpTailer: only the first header sets cwd; events before the header have cwd null', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(
      userLine('u0', '2026-09-04T14:58:00.000Z'),
      header(UUID_A, '/first'),
      header(UUID_A, '/second'), // a fork copies the parent's header too
      userLine('u1', '2026-09-04T14:58:22.972Z'),
    ),
  );
  const events = await new OmpTailer({ ompDir: dir }).scan();
  assert.deepEqual(events.map((e) => e.cwd), [null, '/first']);
});

test('OmpTailer: incremental scan returns only appended lines; no change -> []', async (t) => {
  const dir = await tempOmpDir(t);
  const file = sessionFile(dir, `${TS_A}_${UUID_A}`);
  await writeFile(file, jsonl(header(UUID_A, CWD), userLine('u1', '2026-09-04T14:58:22.972Z')));

  const tailer = new OmpTailer({ ompDir: dir });
  assert.equal((await tailer.scan()).length, 1);
  assert.deepEqual(await tailer.scan(), []);

  await appendFile(file, jsonl(assistantLine('a1', '2026-09-04T14:58:24.938Z')));
  const fresh = await tailer.scan();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].kind, 'usage');
  assert.equal(fresh[0].key, 'msg_a1');
  assert.equal(fresh[0].cwd, CWD); // cwd from the header seen on the first scan

  assert.deepEqual(await tailer.scan(), []);
});

test('OmpTailer: missing sessions dir scans to []', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-usage-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await new OmpTailer({ ompDir: dir }).scan(), []);
});

// ================================================================ OmpLiveState

/** Live state on a temp dir with a settable clock. */
function liveState(dir, opts = {}) {
  const clock = { now: NOW };
  const state = new OmpLiveState({ ompDir: dir, now: () => clock.now, ...opts });
  return { state, clock };
}

test('OmpLiveState: today vs lifetime split across dates, messages, cost rounding', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(
      header(UUID_A, CWD),
      assistantLine('y1', '2026-09-03T23:59:59.000Z', { input: 1000, output: 0, cost: 0.123456 }),
      assistantLine('t1', '2026-09-04T00:00:01.000Z', { input: 200, output: 30, cacheRead: 70, cacheWrite: 0, cost: 0.2 }),
      assistantLine('t2', at(3600), { input: 5, output: 5, cost: 0.001 }),
    ),
  );
  const { state } = liveState(dir);
  assert.equal(await state.scan(), 3);
  const f = state.frame();
  assert.equal(f.today, 310);
  assert.equal(f.lifetime, 1310);
  assert.equal(f.messages, 3);
  assert.equal(f.costUsd, 0.32); // 0.324456 -> 2 decimals
  assert.equal(f.perMinute, 0); // nothing within the last minute
  assert.equal(await state.scan(), 0);
});

test('OmpLiveState: per-model breakdown ordered by tokens descending; non-Claude turns excluded', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(
      header(UUID_A, CWD),
      assistantLine('a', at(300), { model: 'claude-sonnet-4-5', input: 10, output: 0 }),
      assistantLine('b', at(290), { model: 'claude-opus-4-8', input: 500, output: 0 }),
      assistantLine('c', at(280), { model: 'claude-sonnet-4-5', input: 0, output: 30 }),
      assistantLine('d', at(270), { model: 'claude-fable-5-1', input: 100, output: 0 }),
      assistantLine('e', at(260), { provider: 'cerebras', model: 'qwen-3.8-27b', input: 9999, output: 0 }),
    ),
  );
  const { state } = liveState(dir);
  await state.scan();
  const f = state.frame();
  assert.deepEqual(f.models, [
    { model: 'claude-opus-4-8', tokens: 500, messages: 1 },
    { model: 'claude-fable-5-1', tokens: 100, messages: 1 },
    { model: 'claude-sonnet-4-5', tokens: 40, messages: 2 },
  ]);
  assert.equal(f.lifetime, 640);
  // The session's own breakdown follows the same ordering and its model is the last Claude one seen.
  assert.deepEqual(f.sessions[0].models, f.models);
  assert.equal(f.sessions[0].model, 'claude-fable-5-1');
});

test('OmpLiveState: session wire form for a user session (label from the cwd folder)', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(
      header(UUID_A, CWD),
      userLine('u1', at(100)),
      assistantLine('a1', at(90), { input: 100, output: 10, cost: 0.12345678, stopReason: 'stop' }),
    ),
  );
  const { state } = liveState(dir);
  await state.scan();
  const [s] = state.frame().sessions;
  assert.deepEqual(s, {
    id: UUID_A,
    label: 'worktree',
    kind: 'user',
    cwd: CWD,
    path: sessionFile(dir, `${TS_A}_${UUID_A}`),
    model: 'claude-fable-5-1',
    state: 'idle',
    total: 110,
    messages: 1,
    costUsd: 0.1235, // 4 decimals
    tokensPerMin: 0,
    models: [{ model: 'claude-fable-5-1', tokens: 110, messages: 1 }],
    lastEventAt: at(90),
    ageSec: 90,
  });
  assert.ok(!('parent' in s));
});

test('OmpLiveState: session without a header or usage falls back to the id prefix and omits cwd/model', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(sessionFile(dir, `${TS_A}_${UUID_A}`), jsonl(userLine('u1', at(10))));
  const { state } = liveState(dir);
  await state.scan();
  const [s] = state.frame().sessions;
  assert.equal(s.label, UUID_A.slice(0, 8));
  assert.equal(s.state, 'running');
  assert.ok(!('cwd' in s));
  assert.ok(!('model' in s));
  assert.equal(s.total, 0);
});

test('OmpLiveState: sessions older than activeWindow are not listed but still count toward totals', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(header(UUID_A, '/p/recent'), assistantLine('a', at(300), { input: 100, output: 0 })),
  );
  await writeFile(
    sessionFile(dir, `2026-09-04T13-00-00-000Z_${UUID_B}`),
    jsonl(header(UUID_B, '/p/stale'), assistantLine('b', at(1200), { input: 1000, output: 0 })),
  );
  const { state } = liveState(dir, { activeWindow: 600 });
  await state.scan();
  const f = state.frame();
  assert.equal(f.lifetime, 1100);
  assert.deepEqual(f.sessions.map((s) => s.id), [UUID_A]);

  // Exactly at the window edge still counts; one second past it does not.
  assert.equal(state.sessions(new Date(NOW.getTime() - 600_000)).length, 2);
  const wide = liveState(dir, { activeWindow: 1199 });
  await wide.state.scan();
  assert.deepEqual(wide.state.sessions().map((s) => s.id), [UUID_A]);
  const wider = liveState(dir, { activeWindow: 1200 });
  await wider.state.scan();
  assert.deepEqual(wider.state.sessions().map((s) => s.id), [UUID_A, UUID_B]);
});

test('OmpLiveState: running/idle transitions as lines are appended and rescanned', async (t) => {
  const dir = await tempOmpDir(t);
  const file = sessionFile(dir, `${TS_A}_${UUID_A}`);
  const { state, clock } = liveState(dir);
  const current = () => state.frame().sessions[0].state;
  let step = 0;
  const tick = () => {
    step++;
    clock.now = new Date(NOW.getTime() + step * 1000);
    return clock.now.toISOString();
  };

  await writeFile(file, jsonl(header(UUID_A, CWD), userLine('u1', tick())));
  await state.scan();
  assert.equal(current(), 'running'); // prompt sent, awaiting the model

  await appendFile(file, jsonl(assistantLine('a1', tick(), { stopReason: 'stop' })));
  await state.scan();
  assert.equal(current(), 'idle'); // model answered, control back to the user

  await appendFile(file, jsonl(userLine('u2', tick())));
  await state.scan();
  assert.equal(current(), 'running');

  await appendFile(file, jsonl(assistantLine('a2', tick(), { stopReason: 'toolUse' })));
  await state.scan();
  assert.equal(current(), 'running'); // tool call pending

  await appendFile(file, jsonl(toolStart('t1', tick(), 'read')));
  await state.scan();
  assert.equal(current(), 'running');

  await appendFile(file, jsonl(toolResult('r1', tick(), 'read')));
  await state.scan();
  assert.equal(current(), 'running'); // result goes back to the model

  // A non-Claude turn that ends the turn also idles the session.
  await appendFile(file, jsonl(assistantLine('a3', tick(), { provider: 'cerebras', model: 'qwen-3.8-27b', stopReason: 'stop' })));
  await state.scan();
  assert.equal(current(), 'idle');
  assert.equal(state.frame().sessions[0].messages, 2); // only the two Claude turns

  // An older event arriving after a newer one does not roll the state back.
  await appendFile(file, jsonl(userLine('late', at(3600))));
  await state.scan();
  assert.equal(current(), 'idle');
});

test('OmpLiveState: subagent goes idle on yield (tool start or tool result)', async (t) => {
  const dir = await tempOmpDir(t);
  const parentDir = join(dir, 'agent', 'sessions', SLUG, `${TS_A}_${UUID_A}`);
  await mkdir(parentDir, { recursive: true });
  const sub = join(parentDir, 'Explorer.jsonl');
  await writeFile(
    sub,
    jsonl(
      header('sub-id', CWD),
      userLine('u1', at(50)),
      assistantLine('a1', at(40), { stopReason: 'toolUse', input: 10, output: 1 }),
    ),
  );
  const { state } = liveState(dir);
  await state.scan();
  let [s] = state.frame().sessions;
  assert.equal(s.id, 'Explorer');
  assert.equal(s.kind, 'subagent');
  assert.equal(s.label, 'Explorer');
  assert.equal(s.parent, UUID_A);
  assert.equal(s.cwd, CWD);
  assert.equal(s.state, 'running');

  await appendFile(sub, jsonl(toolStart('t1', at(30), 'yield')));
  await state.scan();
  [s] = state.frame().sessions;
  assert.equal(s.state, 'idle');

  // A toolResult for yield keeps it idle (the "Result submitted." line).
  await appendFile(sub, jsonl(toolResult('r1', at(20), 'yield')));
  await state.scan();
  [s] = state.frame().sessions;
  assert.equal(s.state, 'idle');
  assert.equal(s.ageSec, 20);
});

test('OmpLiveState: duplicate responseId across two files counts once in lifetime/cost/messages, once per session', async (t) => {
  const dir = await tempOmpDir(t);
  const shared = assistantLine('a1', at(120), { responseId: 'msg_shared', input: 100, output: 0, cost: 0.5 });
  // A forked session copies the parent's lines, header included.
  await writeFile(sessionFile(dir, `${TS_A}_${UUID_A}`), jsonl(header(UUID_A, CWD), shared, shared));
  await writeFile(
    sessionFile(dir, `2026-09-04T15-10-00-000Z_${UUID_B}`),
    jsonl(header(UUID_A, CWD), shared, assistantLine('b1', at(30), { responseId: 'msg_own', input: 1, output: 0, cost: 0.25 })),
  );
  const { state } = liveState(dir);
  assert.equal(await state.scan(), 4); // raw events, pre-dedupe
  const f = state.frame();
  assert.equal(f.lifetime, 101);
  assert.equal(f.messages, 2);
  assert.equal(f.costUsd, 0.75);
  assert.equal(f.perMinute, 1); // msg_shared is older than a minute; msg_own is 30s old
  const byId = Object.fromEntries(f.sessions.map((s) => [s.id, s]));
  assert.equal(byId[UUID_A].total, 100); // the in-file duplicate counted once
  assert.equal(byId[UUID_A].messages, 1);
  assert.equal(byId[UUID_B].total, 101);
  assert.equal(byId[UUID_B].messages, 2);
  assert.equal(byId[UUID_B].costUsd, 0.75);
});

test('OmpLiveState: null-key usage entries are never deduped', async (t) => {
  const dir = await tempOmpDir(t);
  const anon = line({
    type: 'message',
    timestamp: at(10),
    message: { role: 'assistant', provider: 'anthropic', model: 'claude-fable-5-1', stopReason: 'stop', usage: { input: 5 } },
  });
  await writeFile(sessionFile(dir, `${TS_A}_${UUID_A}`), jsonl(header(UUID_A, CWD), anon, anon));
  const { state } = liveState(dir);
  await state.scan();
  const f = state.frame();
  assert.equal(f.lifetime, 10);
  assert.equal(f.messages, 2);
  assert.equal(f.perMinute, 10);
  assert.equal(f.sessions[0].total, 10);
});

test('OmpLiveState: sessions are sorted most-recent-first', async (t) => {
  const dir = await tempOmpDir(t);
  const UUID_C = '0c000000-0000-0000-0000-000000000000';
  await writeFile(sessionFile(dir, `2026-09-04T15-00-00-000Z_${UUID_A}`), jsonl(header(UUID_A, '/a'), userLine('u', at(200))));
  await writeFile(sessionFile(dir, `2026-09-04T15-01-00-000Z_${UUID_B}`), jsonl(header(UUID_B, '/b'), userLine('u', at(20))));
  await writeFile(sessionFile(dir, `2026-09-04T15-02-00-000Z_${UUID_C}`), jsonl(header(UUID_C, '/c'), userLine('u', at(90))));
  const { state } = liveState(dir);
  await state.scan();
  const sessions = state.frame().sessions;
  assert.deepEqual(sessions.map((s) => s.id), [UUID_B, UUID_C, UUID_A]);
  assert.deepEqual(sessions.map((s) => s.ageSec), [20, 90, 200]);
  assert.deepEqual(sessions.map((s) => s.label), ['b', 'c', 'a']);
});

test('OmpLiveState: perMinute and tokensPerMin count only entries within the last minute', async (t) => {
  const dir = await tempOmpDir(t);
  await writeFile(
    sessionFile(dir, `${TS_A}_${UUID_A}`),
    jsonl(
      header(UUID_A, '/a'),
      assistantLine('old', at(3600), { input: 100000, output: 0 }), // outside the rate window entirely
      assistantLine('mid', at(120), { input: 1000, output: 0 }), // in the 10m window, not the last minute
      assistantLine('new', at(30), { input: 100, output: 20 }),
    ),
  );
  await writeFile(
    sessionFile(dir, `2026-09-04T15-10-00-000Z_${UUID_B}`),
    jsonl(header(UUID_B, '/b'), assistantLine('b', at(59), { input: 7, output: 0 })),
  );
  const { state, clock } = liveState(dir);
  await state.scan();
  let f = state.frame();
  assert.equal(f.perMinute, 127);
  const byId = Object.fromEntries(f.sessions.map((s) => [s.id, s]));
  assert.equal(byId[UUID_A].tokensPerMin, 120);
  assert.equal(byId[UUID_B].tokensPerMin, 7);

  // Ninety seconds later the minute has rolled past both recent entries.
  clock.now = new Date(NOW.getTime() + 90_000);
  f = state.frame();
  assert.equal(f.perMinute, 0);
  assert.equal(f.sessions.find((s) => s.id === UUID_A).tokensPerMin, 0);
});

test('OmpLiveState: frame() shape on an empty dir', async (t) => {
  const dir = await tempOmpDir(t);
  const { state } = liveState(dir);
  assert.equal(await state.scan(), 0);
  assert.deepEqual(state.frame(), {
    today: 0,
    lifetime: 0,
    messages: 0,
    costUsd: 0,
    perMinute: 0,
    models: [],
    sessions: [],
  });
});

// ================================================================ mergeModels

test('mergeModels: sums per model, keeps the per-source split, sorts largest first', () => {
  const merged = mergeModels(
    [
      { model: 'claude-opus-4-8', tokens: 500, messages: 2 },
      { model: 'claude-sonnet-4-5', tokens: 40, messages: 1 },
    ],
    [
      { model: 'claude-sonnet-4-5', tokens: 600, messages: 3 },
      { model: 'claude-fable-5-1', tokens: 100, messages: 1 },
    ],
  );
  assert.deepEqual(merged, [
    { model: 'claude-sonnet-4-5', tokens: 640, messages: 4, claudeCode: 40, omp: 600 },
    { model: 'claude-opus-4-8', tokens: 500, messages: 2, claudeCode: 500, omp: 0 },
    { model: 'claude-fable-5-1', tokens: 100, messages: 1, claudeCode: 0, omp: 100 },
  ]);
});

test('mergeModels: tolerates missing lists and missing counts', () => {
  assert.deepEqual(mergeModels(), []);
  assert.deepEqual(mergeModels(undefined, null), []);
  assert.deepEqual(mergeModels([{ model: 'm' }], undefined), [
    { model: 'm', tokens: 0, messages: 0, claudeCode: 0, omp: 0 },
  ]);
});

// ================================================================ buildSnapshot

const ompFrame = () => ({
  today: 310,
  lifetime: 1310,
  messages: 3,
  costUsd: 0.32,
  perMinute: 12,
  models: [{ model: 'claude-fable-5-1', tokens: 1310, messages: 3 }],
  sessions: [
    {
      id: UUID_A,
      label: 'worktree',
      kind: 'user',
      cwd: CWD,
      model: 'claude-fable-5-1',
      state: 'running',
      total: 1310,
      messages: 3,
      costUsd: 0.32,
      tokensPerMin: 12,
      models: [{ model: 'claude-fable-5-1', tokens: 1310, messages: 3 }],
      lastEventAt: at(5),
      ageSec: 5,
    },
  ],
});

const claudeFrame = (extra = {}) => ({
  summary: { lifetimeTokens: 12530, assistantMessages: 8, peakDailyTokens: 10000 },
  today: 1234,
  daily: [0, 1, 2],
  perMinute: 56,
  perFiveMinutes: 789,
  ...extra,
});

test('buildSnapshot: claude.models merges both sources with the split; claude.omp passes through untouched', () => {
  const omp = ompFrame();
  const snap = buildSnapshot({
    now: NOW,
    claude: claudeFrame({
      models: [
        { model: 'claude-fable-5-1', tokens: 30, messages: 1 },
        { model: 'claude-opus-4-8', tokens: 12500, messages: 7 },
      ],
      omp,
    }),
  });
  assert.deepEqual(snap.claude.models, [
    { model: 'claude-opus-4-8', tokens: 12500, messages: 7, claudeCode: 12500, omp: 0 },
    { model: 'claude-fable-5-1', tokens: 1340, messages: 4, claudeCode: 30, omp: 1310 },
  ]);
  assert.equal(snap.claude.omp, omp);
  assert.deepEqual(snap.claude.omp, ompFrame());
  assert.equal(snap.claude.today, 1234);
  assert.equal(snap.claude.lifetime, 12530);
  assert.equal(snap.ts, NOW.toISOString());
});

test('buildSnapshot: models come from omp alone when Claude Code has none', () => {
  const snap = buildSnapshot({ now: NOW, claude: claudeFrame({ models: [], omp: ompFrame() }) });
  assert.deepEqual(snap.claude.models, [
    { model: 'claude-fable-5-1', tokens: 1310, messages: 3, claudeCode: 0, omp: 1310 },
  ]);
});

test('buildSnapshot: models and omp are omitted when absent or empty', () => {
  const absent = buildSnapshot({ now: NOW, claude: claudeFrame() });
  assert.ok(!('models' in absent.claude));
  assert.ok(!('omp' in absent.claude));

  const empty = buildSnapshot({ now: NOW, claude: claudeFrame({ models: [] }) });
  assert.ok(!('models' in empty.claude));
  assert.ok(!('omp' in empty.claude));

  const ompNoModels = buildSnapshot({ now: NOW, claude: claudeFrame({ models: [], omp: { ...ompFrame(), models: [] } }) });
  assert.ok(!('models' in ompNoModels.claude));
  assert.ok('omp' in ompNoModels.claude);
});

// ================================================================ renderFrame

test('renderFrame: "by model" row from Claude Code models only, no omp rows', () => {
  const out = renderFrame({
    now: NOW,
    claude: claudeFrame({
      models: [
        { model: 'claude-opus-4-8', tokens: 12500, messages: 7 },
        { model: 'claude-fable-5-1', tokens: 30, messages: 1 },
      ],
    }),
    codex: undefined,
    ansi: false,
  });
  assert.ok(!out.includes('\x1b'));
  const byModel = out.split('\n').find((l) => l.includes('by model'));
  assert.ok(byModel, 'by model row present');
  assert.ok(byModel.includes('opus-4-8 12.5K')); // claude- prefix stripped
  assert.ok(byModel.includes('fable-5-1 30'));
  assert.ok(!byModel.includes('(cc')); // single source -> no split
  assert.ok(!out.includes('  omp '));
  assert.ok(!out.includes('omp sessions'));
});

test('renderFrame: omp rows show totals, cost, sessions, and the per-source split on shared models', () => {
  const out = renderFrame({
    now: NOW,
    claude: claudeFrame({
      models: [{ model: 'claude-fable-5-1', tokens: 30, messages: 1 }],
      omp: ompFrame(),
    }),
    codex: undefined,
    ansi: false,
  });
  assert.ok(!out.includes('\x1b'));
  const lines = out.split('\n');
  const byModel = lines.find((l) => l.includes('by model'));
  assert.ok(byModel.includes('fable-5-1 1.3K (cc 30 · omp 1.3K)'));
  const omp = lines.find((l) => l.trimStart().startsWith('omp '));
  assert.ok(omp, 'omp row present');
  assert.ok(omp.includes('310 today'));
  assert.ok(omp.includes('total 1,310'));
  assert.ok(omp.includes('rate 12 tok/min'));
  assert.ok(omp.includes('cost $0.32'));
  const sessions = lines.find((l) => l.includes('omp sessions'));
  assert.ok(sessions.includes('1 active (local sessions)'));
  const sessionLine = lines[lines.indexOf(sessions) + 1];
  assert.ok(sessionLine.includes('worktree'));
  assert.ok(sessionLine.includes('● running'));
  assert.ok(sessionLine.includes('1.3K'));
  assert.ok(sessionLine.includes('12/min'));
  assert.ok(sessionLine.includes('claude-fable-5-1'));
  assert.ok(sessionLine.includes('—')); // OMP sessions carry no ctx percent
});

test('renderFrame: omp with no active sessions and zero cost', () => {
  const out = renderFrame({
    now: NOW,
    claude: claudeFrame({ omp: { ...ompFrame(), costUsd: 0, sessions: [] } }),
    codex: undefined,
    ansi: false,
  });
  assert.ok(out.includes('omp sessions none active'));
  assert.ok(!out.includes('cost $'));
  assert.ok(out.includes('by model')); // omp models alone produce the row
});

test('renderFrame: no models and no omp -> neither row', () => {
  const out = renderFrame({ now: NOW, claude: claudeFrame({ models: [] }), codex: undefined, ansi: false });
  assert.ok(!out.includes('by model'));
  assert.ok(!out.includes('  omp '));
  assert.ok(!out.includes('omp sessions'));
});

// ================================================================ createLiveState

test('createLiveState: omp:false -> claudeFrame has no omp key but still has models', async () => {
  const state = createLiveState({ claudeDir: CLAUDE_FIXTURE, omp: false, now: () => NOW });
  await state.scanClaude();
  const frame = state.claudeFrame();
  assert.ok(!('omp' in frame));
  assert.ok(Array.isArray(frame.models));
  assert.deepEqual(frame.models, [
    { model: 'claude-opus-5', tokens: 11300, messages: 4 },
    { model: 'claude-sonnet-5', tokens: 6230, messages: 5 },
  ]);
});

test('createLiveState: omp:true with a temp ompDir -> omp frame present and tailed on the same tick', async (t) => {
  const dir = await tempOmpDir(t);
  const file = sessionFile(dir, `${TS_A}_${UUID_A}`);
  await writeFile(
    file,
    jsonl(header(UUID_A, CWD), userLine('u1', at(40)), assistantLine('a1', at(30), { input: 100, output: 10, cost: 0.01 })),
  );
  const state = createLiveState({ claudeDir: CLAUDE_FIXTURE, omp: true, ompDir: dir, now: () => NOW, ompSessionWindow: 600 });
  await state.scanClaude();
  const frame = state.claudeFrame();
  assert.equal(frame.summary.lifetimeTokens, 17530); // Claude Code side unaffected
  assert.equal(frame.models.length, 2);
  assert.deepEqual(frame.omp, {
    today: 110,
    lifetime: 110,
    messages: 1,
    costUsd: 0.01,
    perMinute: 110,
    models: [{ model: 'claude-fable-5-1', tokens: 110, messages: 1 }],
    sessions: [
      {
        id: UUID_A,
        label: 'worktree',
        kind: 'user',
        cwd: CWD,
        path: file,
        model: 'claude-fable-5-1',
        state: 'idle',
        total: 110,
        messages: 1,
        costUsd: 0.01,
        tokensPerMin: 110,
        models: [{ model: 'claude-fable-5-1', tokens: 110, messages: 1 }],
        lastEventAt: at(30),
        ageSec: 30,
      },
    ],
  });

  // Appended OMP lines are picked up by the next scanClaude() tick.
  await appendFile(file, jsonl(userLine('u2', at(5))));
  await state.scanClaude();
  assert.equal(state.claudeFrame().omp.sessions[0].state, 'running');

  // The merged snapshot carries both sides.
  const snap = buildSnapshot({ now: NOW, claude: state.claudeFrame() });
  assert.equal(snap.claude.omp.lifetime, 110);
  assert.deepEqual(snap.claude.models.map((m) => m.model), ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1']);
  assert.deepEqual(snap.claude.models[2], { model: 'claude-fable-5-1', tokens: 110, messages: 1, claudeCode: 0, omp: 110 });
});

test('createLiveState: omp:true with a missing ompDir still yields an empty omp frame', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-usage-none-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = createLiveState({ claudeDir: CLAUDE_FIXTURE, omp: true, ompDir: join(dir, 'nope'), now: () => NOW });
  await state.scanClaude();
  const frame = state.claudeFrame();
  assert.deepEqual(frame.omp, { today: 0, lifetime: 0, messages: 0, costUsd: 0, perMinute: 0, models: [], sessions: [] });
});
