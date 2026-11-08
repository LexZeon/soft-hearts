import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { ClaudeFailureError } from '../electron/claude';
import { ClaudeTurnError, type ClaudeChatProcess } from '../electron/claude-process';
import { ChatAvailability } from '../electron/chat-availability';

const LIMIT = "You've hit your session limit · resets 1:20pm (America/Los_Angeles)";
const task = (): CompanionClaudeTask => ({
  kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: '你好', replyId: 'r1',
  session: { key: 'k', basePersona: 'p', persona: 'p', messages: [{ role: 'user', content: '你好' }] },
});
const none = () => {};

test('per-message path: a failed turn is reported with its raw detail, a finished one clears it', async () => {
  const availability = new ChatAvailability({ cardKey: () => 'card', line: () => '额度的话' });
  let fail = true;
  const chat = new PersistentClaudeChat({ enabled: false, availability,
    perMessage: async (_task, _signal, emit) => {
      if (fail) throw new ClaudeFailureError('Claude 暂时不可用', LIMIT);
      emit('delta', '好的');
    } });
  const error = await chat.stream(task(), new AbortController().signal, none).then(() => null, e => e);
  assert.ok(error instanceof ClaudeFailureError);
  assert.equal(availability.view().kind, 'quota');
  assert.deepEqual(availability.notice(error), { kind: 'quota', speak: true, line: '额度的话' });
  fail = false;
  const outcome = await chat.stream(task(), new AbortController().signal, none);
  assert.equal(outcome.output, '好的');
  assert.equal(availability.view().state, 'ok');
});

test('a turn the user stopped is not a failure', async () => {
  const availability = new ChatAvailability();
  const controller = new AbortController();
  const chat = new PersistentClaudeChat({ enabled: false, availability,
    perMessage: async () => { controller.abort(); throw new ClaudeFailureError('已停止。', LIMIT); } });
  await assert.rejects(chat.stream(task(), controller.signal, none));
  assert.equal(availability.view().state, 'ok');
});

test('persistent path: the turn error carries its detail into the state', async () => {
  const availability = new ChatAvailability();
  const process = {
    model: 'haiku', turnsStarted: 0, alive: true, busy: false,
    settled: async () => {}, close: () => { process.alive = false; }, supersede: () => false,
    runTurn: async () => { throw new ClaudeTurnError('Claude 暂时不可用', 'failed', LIMIT); },
  };
  const chat = new PersistentClaudeChat({ availability, binary: async () => 'claude', startProcess: async () => process as unknown as ClaudeChatProcess });
  const error = await chat.stream(task(), new AbortController().signal, none).then(() => null, e => e);
  assert.ok(error instanceof ClaudeTurnError);
  assert.equal(availability.view().kind, 'quota');
  assert.equal(availability.notice(error)?.speak, true);
  chat.dispose();
});

test('a safety stop through the chat path stays a safety stop, not an outage', async () => {
  const availability = new ChatAvailability();
  const chat = new PersistentClaudeChat({ enabled: false, availability,
    perMessage: async () => { throw new ClaudeFailureError('Claude 聊天通道意外请求了工具，已停止。', '', true); } });
  const error = await chat.stream(task(), new AbortController().signal, none).then(() => null, e => e);
  assert.equal(availability.view().state, 'ok');
  assert.equal(availability.notice(error), undefined);
});

test('a broken reporter never changes what the chat turn does', async () => {
  const chat = new PersistentClaudeChat({ enabled: false,
    availability: { success: () => { throw new Error('x'); }, failure: () => { throw new Error('x'); } },
    perMessage: async (_t, _s, emit) => { emit('delta', '嗯'); } });
  assert.equal((await chat.stream(task(), new AbortController().signal, none)).output, '嗯');
  const failing = new PersistentClaudeChat({ enabled: false,
    availability: { success: () => {}, failure: () => { throw new Error('x'); } },
    perMessage: async () => { throw new Error('原错误'); } });
  await assert.rejects(failing.stream(task(), new AbortController().signal, none), /原错误/);
});

test('the raw failure text is carried on the error the chat path throws', async () => {
  const { ClaudeStreamReader, streamClaude } = await import('../electron/claude');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'), path = await import('node:path');
  const reader = new ClaudeStreamReader(() => {});
  reader.consume(JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }));
  assert.equal(reader.consume(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: LIMIT })), 'stop');
  assert.equal(reader.failureDetail, LIMIT);

  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-claude-detail-'));
  try {
    const result = path.join(root, 'result.cjs'), crash = path.join(root, 'crash.cjs');
    await writeFile(result, `process.stdin.resume(); process.stdin.on("end", () => {
      console.log(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }));
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: ${JSON.stringify(LIMIT)} })); });`);
    await writeFile(crash, `process.stdin.resume(); process.stdin.on("end", () => { console.error("getaddrinfo ENOTFOUND api.anthropic.com"); process.exit(1); });`);
    const run = (script: string) => streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: root, writable: false, prompt: '你好' },
      new AbortController().signal, none, process.execPath, [script]).then(() => null, e => e);
    const limited = await run(result);
    assert.ok(limited instanceof ClaudeFailureError);
    assert.equal(limited.detail, LIMIT);
    assert.equal(limited.unsafe, false);
    const offline = await run(crash);
    assert.ok(offline instanceof ClaudeFailureError);
    assert.match(offline.detail, /ENOTFOUND/);
    const availability = new ChatAvailability();
    availability.failure(offline);
    assert.equal(availability.view().kind, 'network');
  } finally { await rm(root, { recursive: true, force: true }); }
});
