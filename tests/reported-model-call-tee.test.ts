// 2026-11-26 (docs/claude/2026-11-26-reported-model.md): the model Claude Code reports reached the journal in tests/reported-model.test.ts
// (which hands the latency probe straight to the chat) but never on the real machine, because the app's timing observer goes through the
// call-timing tee (electron/voice/voice-call/timing.ts), and that dropped the second argument of firstDelta. Here the chain is the app's:
// fake claude -> PersistentClaudeChat -> teeCallTiming(ReplyLatencyProbe.claudeTiming()) -> record -> journal first-char row.
// Event order of the real CLI (2.1.316, observed 2026-11-26): the init event comes AFTER each user message is written, once per turn
// (system/init, system/status, then stream_event ...), so the reader of the written turn always sees it; the fake emits the same order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { ClaudeSessionPool } from '../electron/brain/session-pool';
import { ClaudeChatProcess } from '../electron/brain/claude-process';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/brain/reply-latency';
import { JournalExtras } from '../electron/memory/journal/extras';
import { teeCallTiming } from '../electron/voice/voice-call/timing';
import { buildJournalEntry } from '../shared/memory/journal';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';

const fakeSource = `
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
const model = process.argv[2];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type !== "user") return;
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [], model });
  out({ type: "system", subtype: "status", status: "requesting" });
  out({ type: "stream_event", event: { type: "message_start", message: { id: "m", role: "assistant", content: [] } } });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } } });
  out({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "你好" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "你好" });
}
`;
const MODEL = 'claude-fable-5-2';

async function withFake<T>(run: (script: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-reported-tee-'));
  try { const script = path.join(root, 'fake-claude.cjs'); await writeFile(script, fakeSource); return await run(script); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

/** The app's observer chain: the latency probe behind the call-timing tee (a call on, as in a voice call, and off). */
function chain(callOn: boolean) {
  const lines: string[] = [];
  const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => null, now: () => 0, wallNow: () => 1_800_000_000_000, log: line => lines.push(line), timers: { set: callback => { callback(); return 0; }, clear: () => {} } });
  const timing = teeCallTiming(probe.claudeTiming(), { on: () => callOn, record: () => {} });
  return { lines, probe, timing };
}

function task(id: string, text: string, persona: string): CompanionClaudeTask {
  const messages = [{ role: 'user' as const, content: text }];
  return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); },
    imageDataUrls: [], replyId: id, session: { key: 'c1', basePersona: persona, persona, messages, data: () => null } };
}

function firstCharRow(line: string): Record<string, unknown> {
  const record = JSON.parse(line) as ReplyLatencyRecord;
  const extras = new JournalExtras({ sink: { record: () => true } as never, characterId: () => 'c', engine: () => 'local', uptimeMs: () => 1000, blushStage: () => {} });
  const entry = buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 900, pauseTalk: false, carried: false, ...extras.firstChar(record) } as never, 1) as Record<string, unknown> | null;
  assert.ok(entry, 'the first-char line is built');
  return entry;
}

async function turn(chat: PersistentClaudeChat, c: ReturnType<typeof chain>, id: string, text: string): Promise<void> {
  c.probe.begin(id, 'claude');
  const { output } = await chat.stream(task(id, text, '你是测试角色小桃。'), new AbortController().signal, () => {});
  c.probe.delta(id, output); c.probe.complete(id); c.probe.end(id, false);
}

const newChat = (script: string, c: ReturnType<typeof chain>) => new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script, MODEL],
  provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, timing: c.timing });

for (const callOn of [false, true]) {
  test(`two turns (call ${callOn ? 'on' : 'off'}): both first-char rows carry the model through the app's observer chain`, () => withFake(async script => {
    const c = chain(callOn);
    const chat = newChat(script, c);
    try {
      await turn(chat, c, 'r1', '你好');
      await turn(chat, c, 'r2', '再来');
      const [one, two] = c.lines.map(firstCharRow);
      assert.equal(one.process, 'cold'); assert.equal(one.model, MODEL);
      assert.equal(two.model, MODEL); // whichever process kind the second turn used (the test's history does not extend, so it starts fresh)
    } finally { chat.dispose(); }
  }));
}

test('a prewarmed spare: its first turn carries the model', () => withFake(async script => {
  const c = chain(false);
  const chat = newChat(script, c);
  try {
    chat.noteVisible(true); chat.prewarm();
    await new Promise(resolve => setTimeout(resolve, 300));
    await turn(chat, c, 'r1', '你好');
    const row = firstCharRow(c.lines[0]);
    assert.equal(row.process, 'prewarmed'); assert.equal(row.model, MODEL);
  } finally { chat.dispose(); }
}));

test('a process whose first turn was a hidden warm request: the model is known before and after her first real turn', () => withFake(async script => {
  const proc = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [script, MODEL], model: 'haiku', systemPrompt: '你是测试角色小桃。' });
  const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  try {
    assert.equal(proc.reportedModel, null, 'nothing reported before any turn is written');
    await proc.runTurn(user('warm'), new AbortController().signal, () => {});
    assert.equal(proc.reportedModel, MODEL);
    await proc.runTurn(user('你好'), new AbortController().signal, () => {});
    assert.equal(proc.reportedModel, MODEL);
  } finally { proc.close('closed'); }
}));

test('the call-timing tee passes the model to the observer it wraps (a unit check of the lost argument)', () => {
  const seen: Array<string | undefined> = [];
  const tee = teeCallTiming({ dispatched: () => {}, firstDelta: (_id, model) => { seen.push(model); } }, { on: () => true, record: () => {} });
  tee.dispatched('x', { mode: 'persistent', process: 'cold', sessionTurn: 1 });
  tee.firstDelta('x', 'claude-fable-5-2');
  assert.deepEqual(seen, ['claude-fable-5-2']);
});

test('the pool tells the model of her current chat process for get_diagnostics: null before a turn, the id after', () => withFake(async script => {
  const c = chain(false);
  const pool = new ClaudeSessionPool({ enabled: true, binary: async () => process.execPath, binaryArgs: [script, MODEL], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, timing: c.timing });
  try {
    assert.equal(pool.reportedModel(), null);
    c.probe.begin('r1', 'claude');
    await pool.stream(task('r1', '你好', '你是测试角色小桃。'), new AbortController().signal, () => {});
    assert.equal(pool.reportedModel(), MODEL);
  } finally { pool.dispose(); }
}));
