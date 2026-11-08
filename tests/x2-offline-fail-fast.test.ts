import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeStreamReader, streamClaude, ClaudeFailureError } from '../electron/claude';
import { ClaudeChatProcess, ClaudeTurnError } from '../electron/claude-process';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { ChatAvailability, failureText } from '../electron/chat-availability';
import { classifyClaudeFailure } from '../shared/claude-failure';

/**
 * X2. With the network
 * off, Claude Code does not fail the turn: it retries the request with backoff
 * for minutes, printing `system/api_retry` with `error_status: null` (no HTTP
 * answer at all; the event shape was read from the local claude.exe 2.1.x),
 * and the app waited for its 120 s turn timeout, then called it "other". These
 * drive the real reader, the real persistent process and the real per-message
 * path over a fake `claude` (no network, no real CLI, no account).
 */
const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const retry = (attempt: number, status: number | null = null) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: status, error: status === null ? 'unknown' : 'overloaded' });
const network = (error: unknown) => classifyClaudeFailure(failureText(error) ?? '').kind;

test('X2 reader: the second retry without any HTTP answer ends the turn as offline', () => {
  const reader = new ClaudeStreamReader(() => {});
  assert.equal(reader.consumeEvent(init), 'ok');
  assert.equal(reader.consumeEvent(retry(1)), 'ok', 'one blip is not an outage yet');
  assert.equal(reader.consumeEvent(retry(2)), 'stop');
  assert.ok(reader.failure, 'a display message for developer mode');
  assert.equal(classifyClaudeFailure(reader.failureDetail).kind, 'network');
  assert.equal(reader.unsafe, false, 'never a safety stop');
});

test('X2 reader: retries the server answered (busy, overloaded) are never called offline', () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.consumeEvent(init);
  for (let attempt = 1; attempt <= 5; attempt++) assert.equal(reader.consumeEvent(retry(attempt, 529)), 'ok');
  assert.equal(reader.failure, '');
  assert.equal(reader.answered, true, 'the server answered');
  const quiet = new ClaudeStreamReader(() => {});
  quiet.consumeEvent(init);
  assert.equal(quiet.answered, false);
  quiet.consumeEvent({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  assert.equal(quiet.answered, true, 'any stream event is an answer');
});

/** A fake `claude -p --input-format stream-json`: "#offline" retries forever without an answer, "#silent" says nothing, "#busy" retries with 529 then answers. */
const fakeSource = String.raw`
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type !== "user") return;
  const text = message.message.content.map(block => block.text || "").join("");
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  pending++;
  if (text.includes("#offline")) {
    let attempt = 0;
    setInterval(() => out({ type: "system", subtype: "api_retry", attempt: ++attempt, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown" }), 40);
    return;
  }
  if (text.includes("#silent")) { setInterval(() => {}, 1000); return; } // waiting on a request that never answers
  if (text.includes("#busy")) {
    out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "overloaded" });
    out({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "overloaded" });
  }
  setTimeout(() => {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好呀。" } } });
    out({ type: "result", subtype: "success", is_error: false, result: "好呀。" });
    pending--; if (ended && !pending) process.exit(0);
  }, text.includes("#busy") ? 2800 : 60); // busy: answered only after the first-response window
}
// Like Claude Code: a closed stdin (the per-message path) ends the process only once its turn is done.
let pending = 0, ended = false;
process.stdin.on("end", () => { ended = true; if (!pending) process.exit(0); });
`;
async function fakeClaude(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-x2-offline-'));
  const script = path.join(directory, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return script;
}
const input = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

test('X2 persistent process: offline fails within seconds as a network outage, without degrading the session', { timeout: 15_000 }, async t => {
  const script = await fakeClaude(t);
  const chat = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [script], model: 'haiku', systemPrompt: 'x', firstResponseTimeoutMs: 5_000 });
  t.after(() => chat.close());
  const started = performance.now();
  const error = await chat.run(input('#offline 你好'), new AbortController().signal, () => {}).then(() => null, e => e);
  const elapsed = performance.now() - started;
  assert.ok(error instanceof ClaudeTurnError, String(error));
  assert.equal(error.kind, 'failed', "not 'timeout': two of those would degrade the warm session for the whole run");
  assert.equal(network(error), 'network');
  assert.ok(elapsed < 3_000, `ended after ${Math.round(elapsed)} ms, not after the 120 s turn timeout`);
});

test('X2 persistent process: no answer at all within the first-response window is offline too', { timeout: 15_000 }, async t => {
  const script = await fakeClaude(t);
  const chat = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [script], model: 'haiku', systemPrompt: 'x', firstResponseTimeoutMs: 400 });
  t.after(() => chat.close());
  const error = await chat.run(input('#silent 你好'), new AbortController().signal, () => {}).then(() => null, e => e);
  assert.ok(error instanceof ClaudeTurnError, String(error));
  assert.equal(error.kind, 'failed');
  assert.equal(network(error), 'network');
});

test('X2 persistent process: a busy server that answers is waited for, and a normal turn is untouched', { timeout: 15_000 }, async t => {
  const script = await fakeClaude(t);
  const chat = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [script], model: 'haiku', systemPrompt: 'x', firstResponseTimeoutMs: 2_500 });
  t.after(() => chat.close());
  // A normal turn first (it also warms the process, so a loaded machine's slow start never eats the window below).
  assert.equal(await chat.run(input('你好'), new AbortController().signal, () => {}), '好呀。');
  // The busy server answers retries with 529 at once but the reply only after 2.8 s, past the 2.5 s window;
  // the first turn's window also runs out meanwhile and must not touch this turn.
  const started = performance.now();
  assert.equal(await chat.run(input('#busy 你好'), new AbortController().signal, () => {}), '好呀。');
  assert.ok(performance.now() - started >= 2_500, 'it waited past the window');
  assert.equal(chat.alive, true);
});

test('X2 chat path: offline reaches the control window as a network outage she speaks about once', { timeout: 15_000 }, async t => {
  const script = await fakeClaude(t);
  const availability = new ChatAvailability({ cardKey: () => 'card', line: kind => kind === 'network' ? '好像连不上网了' : null });
  const chat = new PersistentClaudeChat({ enabled: true, availability, binary: async () => process.execPath, binaryArgs: [script], firstResponseTimeoutMs: 5_000, log: () => {} });
  t.after(() => chat.dispose());
  const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt: '#offline 你好', replyId: 'r1',
    session: { key: 'k', basePersona: 'p', persona: 'p', messages: [{ role: 'user', content: '#offline 你好' }] } };
  const error = await chat.stream(task, new AbortController().signal, () => {}).then(() => null, e => e);
  assert.ok(error);
  assert.equal(availability.view().state, 'unavailable');
  assert.equal(availability.view().kind, 'network', 'the "needs attention" panel with 重试 / 打开网络设置');
  assert.deepEqual(availability.notice(error), { kind: 'network', speak: true, line: '好像连不上网了' });
});

test('X2 per-message path: offline and silence both fail fast as network', { timeout: 20_000 }, async t => {
  const script = await fakeClaude(t);
  const task = (prompt: string) => ({ kind: 'chat' as const, model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [] });
  for (const prompt of ['#offline 你好', '#silent 你好']) {
    const started = performance.now();
    const error = await streamClaude(task(prompt), new AbortController().signal, () => {}, process.execPath, [script], { firstResponseTimeoutMs: 2_500 }).then(() => null, e => e);
    assert.ok(error instanceof ClaudeFailureError, `${prompt}: ${String(error)}`);
    assert.equal(network(error), "network", prompt);
    assert.ok(performance.now() - started < 8_000, prompt);
  }
  assert.equal((await streamClaude(task('你好'), new AbortController().signal, () => {}, process.execPath, [script], { firstResponseTimeoutMs: 2_500 })) ?? null, null);
});
