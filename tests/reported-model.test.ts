// 2026-11-23 (docs/claude/2026-11-23-opening-marker-plan.md, first step): the model id Claude Code's system/init event reports is kept on the
// chat process and reaches the journal's first-char line as `model`. Diagnostic only: nothing decides anything by it. A fake `claude` emits the init.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeStreamReader } from '../electron/brain/claude';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/brain/reply-latency';
import { JournalExtras } from '../electron/memory/journal/extras';
import { buildJournalEntry } from '../shared/memory/journal';
import { reportedModelId } from '../shared/brain/claude-model';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';

const init = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], ...extra });

test('the reader keeps a clean model id from the init event; odd or missing ones leave null', () => {
  const read = (extra: Record<string, unknown>) => { const reader = new ClaudeStreamReader(() => {}); reader.consume(init(extra)); return reader; };
  assert.equal(read({ model: 'claude-sonnet-4-5-20250929' }).model, 'claude-sonnet-4-5-20250929');
  assert.equal(read({ model: 'claude-opus-4-1[1m]' }).model, 'claude-opus-4-1[1m]');
  assert.equal(read({}).model, null);
  for (const odd of ['has space', 'new\nline', 'x'.repeat(81), '中文模型', '', 7, null, { a: 1 }, 'a/b']) assert.equal(read({ model: odd }).model, null, JSON.stringify(odd));
  assert.equal(reportedModelId('x'.repeat(80)), 'x'.repeat(80));
});

test('the init safety check is untouched: tools or MCP servers still stop the turn, and no model is kept then', () => {
  for (const extra of [{ tools: ['Bash'] }, { mcp_servers: [{ name: 'x' }] }]) {
    const reader = new ClaudeStreamReader(() => {});
    assert.equal(reader.consume(init({ ...extra, model: 'claude-x' })), 'stop');
    assert.equal(reader.unsafe, true); assert.equal(reader.model, null);
  }
});

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
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [], ...(model === "none" ? {} : { model }) });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } } });
  out({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "你好" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "你好" });
}
`;

/** One real chat turn through PersistentClaudeChat (fake claude) with the real latency probe; returns the journal's first-char entry. */
async function firstCharEntry(model: string): Promise<Record<string, unknown>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-reported-model-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  const lines: string[] = [];
  const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => null, now: () => 0, wallNow: () => 1_800_000_000_000, log: line => lines.push(line), timers: { set: callback => { callback(); return 0; }, clear: () => {} } });
  const persona = '你是测试角色小桃。';
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script, model], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, timing: probe.claudeTiming() });
  try {
    probe.begin('r1', 'claude');
    const messages = [{ role: 'user' as const, content: '你好' }];
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); },
      imageDataUrls: [], replyId: 'r1', session: { key: 'c1', basePersona: persona, persona, messages, data: () => null } };
    const { output } = await chat.stream(task, new AbortController().signal, () => {});
    probe.delta('r1', output); probe.complete('r1'); probe.end('r1', false);
    const record = JSON.parse(lines[0]) as ReplyLatencyRecord;
    const extras = new JournalExtras({ sink: { record: () => true } as never, characterId: () => 'c', engine: () => 'local', uptimeMs: () => 1000, blushStage: () => {} });
    const entry = buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 900, pauseTalk: false, carried: false, ...extras.firstChar(record) } as never, 1) as Record<string, unknown> | null;
    assert.ok(entry, 'the first-char line is built');
    return entry;
  } finally {
    chat.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

test('init with a model: the first-char journal row carries it', async () => {
  const entry = await firstCharEntry('claude-sonnet-4-5-20250929');
  assert.equal(entry.model, 'claude-sonnet-4-5-20250929');
});

test('init without a model, or with odd characters: no model field', async () => {
  assert.equal('model' in await firstCharEntry('none'), false);
  assert.equal('model' in await firstCharEntry('bad model!'), false);
});

test('the journal row builder itself drops an odd model, so a stray value never reaches the file', () => {
  const base = { type: 'first-char', characterId: 'c', ms: 900, pauseTalk: false, carried: false };
  assert.equal((buildJournalEntry({ ...base, model: 'claude-x' } as never, 1) as Record<string, unknown>).model, 'claude-x');
  for (const odd of ['a b', 'x'.repeat(81), 5, '好']) assert.equal('model' in (buildJournalEntry({ ...base, model: odd } as never, 1) as Record<string, unknown>), false);
});

