// I-222 (docs/claude/2026-11-26-chat-model-default.md): her chat model is Opus unless the user picks another in the app. Through a fake
// Claude Code that speaks the stream-json protocol and, when told, refuses a model exactly the way Claude Code 2.1.316 did on
// 2026-11-26 (a synthetic assistant message with "model_not_found", then an error result naming the model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { streamClaude } from '../electron/brain/claude';
import { ClaudeFailureError } from '../electron/brain/claude';
import { ClaudeTurnError } from '../electron/brain/claude-process';
import { impliedChatModelUnavailable, noteContextChatModel, noteImpliedModelRefusal, observeChatModelFallback, resetChatModelFallback, followClaudeCodeAfterRefusal } from '../electron/brain/chat-model-fallback';
import { wireChatModelFallback } from '../electron/wiring/chat-model-fallback-wiring';
import { taskArguments } from '../electron/safety/claude-tasks/process';
import { validateAgentModel } from '../electron/settings/validation';
import { CHAT_MODEL_FALLBACK_NOTICE, chatModelArgument, refusedClaudeModel } from '../shared/brain/claude-model';
import { statusNotice } from '../src/brain/chat-status-notice';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';

// What the real CLI printed for `--model claude-no-such-model-i222` (2026-11-26, Claude Code 2.1.316; only the fields read here).
const REFUSED = (model: string) => `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`;
const STDERR = (model: string) => `[claude-code:unrecognized_model] {"model":"${model}","query_source":"sdk"}`;

const fakeSource = String.raw`
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
const args = process.argv.slice(2);
const at = args.indexOf("--model"), model = at >= 0 ? args[at + 1] : "";
fs.appendFileSync(path.join(dir, "spawns.log"), JSON.stringify({ pid: process.pid, model }) + "\n");
const conf = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "refuse.json"), "utf8")); } catch { return {}; } };
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
let turn = 0, buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type !== "user") return;
  turn++;
  const prompt = message.message.content.map(block => block.text || "").join("");
  fs.appendFileSync(path.join(dir, "input.log"), JSON.stringify({ pid: process.pid, model, prompt }) + "\n");
  const c = conf();
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: model ? "claude-" + model + "-fake" : "claude-default-fake" });
  if ((c.models || []).includes(model)) {
    const text = "There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it. Run --model to pick a different model.";
    out({ type: "assistant", message: { id: "e" + turn, model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, error: "model_not_found", is_api_error_message: true, api_error_status: 404 });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 404, terminal_reason: "api_error", result: text });
    if (c.exit) { process.stderr.write("[claude-code:unrecognized_model] {\"model\":\"" + model + "\"}\n"); process.exit(1); }
    return;
  }
  if (c.overloaded) { out({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "API Error: 529 Overloaded" }); return; }
  const reply = "第" + turn + "轮回复。";
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } } });
  out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text: reply }] } });
  out({ type: "result", subtype: "success", is_error: false, result: reply });
}
process.stdin.on("end", () => { process.exitCode = 0; });
`;

async function fake(refuse: { models?: string[]; exit?: boolean; overloaded?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-i222-claude-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  await writeFile(path.join(root, 'refuse.json'), JSON.stringify(refuse));
  const lines = async (name: string) => { try { return (await readFile(path.join(root, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return {
    root, script,
    spawns: () => lines('spawns.log') as Promise<{ pid: number; model: string }[]>,
    inputs: () => lines('input.log') as Promise<{ pid: number; model: string; prompt: string }[]>,
    refuse: (value: typeof refuse) => writeFile(path.join(root, 'refuse.json'), JSON.stringify(value)),
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  };
}
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('timed out waiting'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
let nonce = 0;
function turn(messages: ChatMessage[], model: string): CompanionClaudeTask {
  const composed = `测试角色。\n\n尾注标记 nonce-${++nonce}`;
  return { kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(composed, messages); }, imageDataUrls: [],
    replyId: `r${nonce}`, session: { key: 'conversation-1', basePersona: '测试角色。', persona: composed, messages, data: () => null } };
}
function chat(script: string, model: () => string) {
  const timing: [string, ClaudeTimingInfo][] = [];
  const instance = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: model() }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, timing: { dispatched: (id, info) => timing.push([id, info]), firstDelta: () => {} } });
  return { instance, timing };
}
function collect() {
  const deltas: string[] = [], statuses: string[] = [];
  return { deltas, statuses, emit: (type: string, text: string) => { if (type === 'delta') deltas.push(text); if (type === 'status') statuses.push(text); } };
}

test('what an empty chat model means: Opus; the follow choice: no --model; the task model keeps its own meaning of empty', () => {
  assert.equal(chatModelArgument(''), 'opus');
  assert.equal(chatModelArgument('   '), 'opus');
  assert.equal(chatModelArgument('gpt-5-codex'), 'opus', 'a Codex-era name was never chosen in this app');
  assert.equal(chatModelArgument('follow-default'), '');
  assert.equal(chatModelArgument('sonnet'), 'sonnet');
  assert.equal(chatModelArgument('opus'), 'opus');
  assert.equal(chatModelArgument('', true), '', 'after a refused Opus, until the follow choice is saved');
  assert.equal(chatModelArgument('sonnet', true), 'sonnet', 'an explicit choice never changes');
  // R20 tasks: unchanged.
  assert.equal(validateAgentModel(''), '');
  assert.ok(!taskArguments({ mcpConfigFile: 'cfg.json', model: '' }).includes('--model'));
  assert.ok(!taskArguments({ mcpConfigFile: 'cfg.json', model: validateAgentModel('follow-default') }).includes('--model'));
});

test('the refusal recogniser reads only a real refusal of the model (row 16): not a network error, an overload, a usage limit, a login or a content refusal', () => {
  assert.equal(refusedClaudeModel(REFUSED('opus')), 'opus');
  assert.equal(refusedClaudeModel(STDERR('opus')), 'opus');
  assert.equal(refusedClaudeModel('{"error":"model_not_found"} model_not_found'), '');
  // (1) the model is not available to this account or the organisation turned it off: the only case that switches the saved choice.
  for (const off of ['API Error: 403 {"type":"error","error":{"type":"permission_error","message":"This model is not available to your organization."}}',
    'Claude Opus has been disabled by your organization administrator.', 'The model claude-opus-5-5 is not enabled for this workspace.'])
    assert.equal(refusedClaudeModel(off), '', off);
  // (2) not logged in, (3) usage used up, (4) rate limit or overload, (5) network, (6) content refused: never a refused model.
  const never: Record<string, string[]> = {
    login: ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'OAuth token has expired. Please run /login', 'API Error: 401 authentication_error'],
    quota: ["You've hit your session limit · resets 5pm", "You've hit your Opus limit · resets 3am", 'Credit balance is too low', 'Claude usage limit reached. Your limit will reset at 9pm.'],
    overload: ['API Error: 529 Overloaded', 'API Error: 429 rate_limit_error: Number of requests has exceeded your rate limit', 'Request rejected (429) · Opus is temporarily overloaded'],
    network: ['Connection error. fetch failed', 'getaddrinfo ENOTFOUND api.anthropic.com', 'Request timed out', 'socket hang up'],
    content: ['Claude Code is unable to respond to this request, which appears to violate our usage policy', 'API Error: Claude Code is unable to respond to this request'],
  };
  for (const [kind, texts] of Object.entries(never)) for (const text of texts) assert.equal(refusedClaudeModel(text), null, `${kind}: ${text}`);
  resetChatModelFallback();
  for (const texts of Object.values(never)) for (const text of texts)
    assert.equal(noteImpliedModelRefusal('', new ClaudeTurnError(text, 'failed', text), new AbortController().signal), false, text);
  assert.equal(impliedChatModelUnavailable(), false, 'none of cases 2-6 touched anything');
  for (const other of ['API Error: 529 Overloaded', 'Connection error. fetch failed', "You've hit your session limit · resets 5pm", 'Not logged in · Please run /login',
    'Claude Code is unable to respond to this request, which appears to violate our usage policy', 'API Error: 500 Internal server error', '', undefined])
    assert.equal(refusedClaudeModel(other), null, String(other));
  resetChatModelFallback();
  const signal = new AbortController().signal;
  assert.equal(noteImpliedModelRefusal('', new ClaudeTurnError('x', 'failed', '', 'refusal'), signal), false, 'a content refusal is not "cannot use Opus"');
  assert.equal(noteImpliedModelRefusal('', new ClaudeTurnError('busy', 'failed', 'API Error: 529 Overloaded'), signal), false);
  assert.equal(noteImpliedModelRefusal('opus', new ClaudeTurnError(REFUSED('opus'), 'failed', REFUSED('opus')), signal), false, 'an explicit opus is the user\'s choice');
  assert.equal(noteImpliedModelRefusal('', new ClaudeTurnError('x', 'failed', REFUSED('claude-fable-5-2')), signal), false, 'Claude Code\'s own default refused: no loop');
  assert.equal(impliedChatModelUnavailable(), false, 'none of these changed anything');
  const aborted = new AbortController(); aborted.abort();
  assert.equal(noteImpliedModelRefusal('', new ClaudeFailureError(REFUSED('opus'), REFUSED('opus')), aborted.signal), false);
  assert.equal(noteImpliedModelRefusal('', new ClaudeFailureError(REFUSED('opus'), REFUSED('opus')), signal), true);
  assert.equal(impliedChatModelUnavailable(), true);
  // The user picks Opus（默认） again later in this run: it is tried again; another choice leaves the flag alone.
  assert.equal(noteContextChatModel('follow-default'), false, 'the first note only remembers');
  assert.equal(noteContextChatModel('sonnet'), true);
  assert.equal(impliedChatModelUnavailable(), true);
  assert.equal(noteContextChatModel(''), true);
  assert.equal(impliedChatModelUnavailable(), false);
  resetChatModelFallback();
});

test('her chat process: an empty model starts with --model opus, the follow choice without, and the warm spare is reused with an empty model (row 5)', async () => {
  resetChatModelFallback();
  const f = await fake();
  let model = '';
  const { instance, timing } = chat(f.script, () => model);
  try {
    instance.prewarm('start');
    await until(async () => (await f.spawns()).length === 1);
    const first = collect();
    await instance.stream(turn([u('你好')], ''), new AbortController().signal, first.emit);
    assert.deepEqual(first.deltas, ['第1轮回复。']);
    assert.deepEqual((await f.spawns()).map(row => row.model), ['opus'], 'one process, started with --model opus');
    assert.equal(timing[0][1].process, 'prewarmed', 'the spare started for an empty model served the turn');
    instance.close('quit');
    model = 'follow-default';
    await instance.stream(turn([u('你好')], 'follow-default'), new AbortController().signal, collect().emit);
    assert.deepEqual((await f.spawns()).map(row => row.model).slice(-1), [''], 'the follow choice: Claude Code\'s own default');
  } finally { instance.dispose(); await f.cleanup(); }
});

test('a chat model change mid-conversation: the next turn runs on a new process with the new model and the earlier lines', async () => {
  resetChatModelFallback();
  const f = await fake();
  let model = '';
  const { instance } = chat(f.script, () => model);
  try {
    await instance.stream(turn([u('第一句：合成的蓝色')], ''), new AbortController().signal, collect().emit);
    model = 'sonnet';
    const second = collect();
    await instance.stream(turn([u('第一句：合成的蓝色'), a('第1轮回复。'), u('第二句')], 'sonnet'), new AbortController().signal, second.emit);
    assert.equal(second.deltas.join(''), '第1轮回复。', 'a new process answered');
    const spawns = await f.spawns();
    assert.deepEqual(spawns.map(row => row.model), ['opus', 'sonnet']);
    const opening = (await f.inputs()).filter(row => row.pid === spawns[1].pid)[0].prompt;
    assert.match(opening, /合成的蓝色/, 'her history reached the new process (the same way as after a restart)');
    assert.match(opening, /第1轮回复/);
    assert.match(opening, /第二句/);
  } finally { instance.dispose(); await f.cleanup(); }
});

for (const exit of [false, true]) {
  test(`the implied Opus refused (${exit ? 'the process exits' : 'the process stays'}): she still answers on Claude Code's default, the follow choice is saved, the page is told once`, async () => {
    resetChatModelFallback();
    const f = await fake({ models: ['opus'], exit });
    let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), provider: { ...DEFAULT_SETTINGS.provider, model: '' } };
    const published: string[] = [];
    let queue = Promise.resolve() as Promise<unknown>;
    wireChatModelFallback({ store: () => ({ get current() { return settings; }, persist: async next => { settings = next; } }),
      mutate: operation => { const run = queue.then(operation); queue = run.catch(() => {}); return run; },
      published: next => published.push(next.provider.model), log: () => {} });
    const { instance } = chat(f.script, () => settings.provider.model);
    try {
      const first = collect();
      await instance.stream(turn([u('你好')], ''), new AbortController().signal, first.emit);
      assert.deepEqual(first.deltas, ['第1轮回复。'], 'never mute');
      assert.deepEqual(first.statuses.filter(text => text === CHAT_MODEL_FALLBACK_NOTICE).length, 1, 'said once, in this turn');
      assert.equal(statusNotice(first.statuses.at(-1)!), CHAT_MODEL_FALLBACK_NOTICE, 'the windows show exactly this line');
      await queue;
      assert.equal(settings.provider.model, 'follow-default', 'the saved choice switched by itself');
      assert.equal(settings.provider.memoryModel, '', 'her memory pin is untouched');
      assert.deepEqual(published, ['follow-default'], 'the settings page learns it');
      assert.deepEqual((await f.spawns()).map(row => row.model), ['opus', ''], 'Opus tried once, then the default');
      const second = collect();
      await instance.stream(turn([u('你好'), a('第1轮回复。'), u('再来')], settings.provider.model), new AbortController().signal, second.emit);
      assert.equal(second.statuses.includes(CHAT_MODEL_FALLBACK_NOTICE), false, 'not said again');
      assert.equal((await f.spawns()).filter(row => row.model === 'opus').length, 1, 'Opus is not tried again');
    } finally { instance.dispose(); observeChatModelFallback(null); await f.cleanup(); }
  });
}

test('an explicitly chosen model that is refused shows the error and changes nothing; an overload with an empty model changes nothing', async () => {
  resetChatModelFallback();
  const f = await fake({ models: ['opus'] });
  let changed = 0;
  observeChatModelFallback(() => { changed++; });
  const { instance } = chat(f.script, () => 'opus');
  try {
    const shown = collect();
    await assert.rejects(instance.stream(turn([u('你好')], 'opus'), new AbortController().signal, shown.emit), /selected model \(opus\)/);
    assert.equal(changed, 0); assert.equal(impliedChatModelUnavailable(), false);
    assert.deepEqual(shown.statuses, []);
    await f.refuse({ overloaded: true });
    await assert.rejects(instance.stream(turn([u('你好')], ''), new AbortController().signal, collect().emit));
    assert.equal(changed, 0, 'an overload is not a refused model');
    assert.equal(followClaudeCodeAfterRefusal({ ...structuredClone(DEFAULT_SETTINGS), provider: { ...DEFAULT_SETTINGS.provider, model: 'sonnet' } }), null, 'never replaces a choice');
  } finally { instance.dispose(); observeChatModelFallback(null); await f.cleanup(); }
});

test('a one-off call (streamClaude, the side requests) with an empty model: refused Opus, then once more without --model', async () => {
  resetChatModelFallback();
  const f = await fake({ models: ['opus'], exit: true });
  try {
    const shown = collect();
    await streamClaude({ kind: 'chat', model: '', workingDirectory: os.tmpdir(), writable: false, prompt: '你好', imageDataUrls: [] }, new AbortController().signal, shown.emit, process.execPath, [f.script]);
    assert.deepEqual(shown.deltas, ['第1轮回复。']);
    assert.deepEqual((await f.spawns()).map(row => row.model), ['opus', '']);
    await f.refuse({ models: ['haiku'] });
    await assert.rejects(streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt: '你好', imageDataUrls: [] },
      new AbortController().signal, collect().emit, process.execPath, [f.script]), /selected model \(haiku\)/, 'an explicit haiku is never replaced');
  } finally { resetChatModelFallback(); await f.cleanup(); }
});
