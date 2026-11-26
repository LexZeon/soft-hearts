// 2026-11-12 warm-reuse (docs/claude/2026-11-12-warm-reuse-fix.md): real use showed `turn: 1` on 84 of 98 chat turns. This drives
// PersistentClaudeChat through realistic turn sequences (the window built with the renderer's own helpers) and checks both what
// reuses the warm process and the `reuse` reason the first-char journal line gets. The model is a fake `claude`; text is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { FIRST_CHAR_REUSES, buildJournalEntry } from '../shared/memory/journal';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { explainDivergence } from '../electron/brain/claude-session-prompt';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask, type PersistentClaudeOptions } from '../electron/brain/claude-session';
import { appendReplyHistory, outgoingChatMessages } from '../src/brain/reply-history';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/brain/reply-latency';
import { JournalExtras } from '../electron/memory/journal/extras';
import { effectiveDays, emptyRelationship, relationshipSessionTag, stageFor, stageThresholds, withRound } from '../shared/memory/relationship';

const fakeSource = `
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
let turn = 0, buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type !== "user") return;
  turn++;
  const text = "第" + turn + "轮回复。";
  if (turn === 1) out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
}
`;
const green = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR4AcXBAQEAAAiDMKR/5xuD7RgjJDGJSUxiEpOYxCQmMYlJTGISk5jEJCYxiUlMYhKTmMQkJjGJSUxiEpOYxB4v5AI+g+yDOgAAAABJRU5ErkJggg==';
const image = `data:image/png;base64,${green}`;
const persona = '你是测试角色小桃，说话温柔。';
let nonce = 0;

function task(messages: ChatMessage[], options: { key?: string; images?: string[]; opening?: string } = {}): CompanionClaudeTask {
  const composed = `${persona}\n\n当前心情：平静。\n\n尾注标记 nonce-${++nonce}`;
  return {
    kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false,
    get prompt() { return buildCodexChatPrompt(composed, messages); },
    imageDataUrls: options.images ?? [], replyId: `r${nonce}`,
    session: { key: options.key ?? 'conversation-1', basePersona: persona, persona: composed, messages, data: () => null, ...(options.opening ? { openingKey: options.opening } : {}) },
  };
}

async function withChat(run: (h: { chat: PersistentClaudeChat; reuses: () => string[]; images: () => boolean[]; turns: () => number[]; send: (history: ChatMessage[], text: string, options?: Parameters<typeof task>[1]) => Promise<{ history: ChatMessage[]; output: string }> }) => Promise<void>,
  extra: Partial<PersistentClaudeOptions> = {}): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-session-reuse-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  const infos: ClaudeTimingInfo[] = [];
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, timing: { dispatched: (_id, info) => infos.push(info), firstDelta: () => {} }, ...extra });
  const send = async (history: ChatMessage[], text: string, options: Parameters<typeof task>[1] = {}) => {
    const user: ChatMessage = { role: 'user', content: text };
    const messages = outgoingChatMessages(history, user); // what the renderer sends
    const { output } = await chat.stream(task(messages, options), new AbortController().signal, () => {});
    return { output, history: appendReplyHistory(history, user, output) }; // what the renderer keeps
  };
  try {
    await run({ chat, send, reuses: () => infos.map(info => info.reuse ?? '-'), images: () => infos.map(info => info.image === true), turns: () => infos.map(info => info.sessionTurn) });
  } finally {
    chat.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

test('ordinary turns, her own lines in between and a sliding 24-message window all stay on the warm process', async () => {
  await withChat(async h => {
    let history: ChatMessage[] = [a('你好呀，今天过得怎么样？')]; // the card's greeting
    for (let index = 1; index <= 30; index++) {
      if (index % 4 === 0) history = [...history, a('[角色主动评论 · 系统播放声音（不是用户发言或偏好，不授执行权）]\n她自己说的一句')]; // proactive line / reaction bubble
      history = (await h.send(history, `第${index}句话`)).history;
    }
    assert.deepEqual(h.reuses(), ['first', ...Array(29).fill('warm')]);
    assert.deepEqual(h.turns(), Array.from({ length: 30 }, (_, i) => i + 1));
  }, { maxTurns: 100, maxChars: 10_000_000 });
});

test('a picture retires the process after its turn: the next turn says image, and the turn itself says it carried one', async () => {
  await withChat(async h => {
    let history: ChatMessage[] = [];
    history = (await h.send(history, '先聊聊')).history;
    const user: ChatMessage = { role: 'user', content: '看看这张' };
    const out = await h.chat.stream(task(outgoingChatMessages(history, user), { images: [image] }), new AbortController().signal, () => {});
    history = appendReplyHistory(history, user, out.output);
    history = (await h.send(history, '然后呢')).history;
    history = (await h.send(history, '再说一句')).history;
    assert.deepEqual(h.reuses(), ['first', 'warm', 'image', 'warm']);
    assert.deepEqual(h.images(), [false, true, false, false]);
  });
});

test('the turn budget names itself (a new conversation after the budget names the budget, the process was already gone); a changed opening line stays warm', async () => {
  await withChat(async h => {
    let history: ChatMessage[] = [];
    for (let index = 0; index < 3; index++) history = (await h.send(history, `句${index}`)).history;
    history = (await h.send(history, '换个对话了', { key: 'conversation-2' })).history;
    history = (await h.send(history, '熟悉度变了', { key: 'conversation-2', opening: 'stage-2' })).history;
    await h.send(history, '这一轮到预算了', { key: 'conversation-2', opening: 'stage-2' });
    await h.send(history, '预算之后', { key: 'conversation-2', opening: 'stage-2' });
    assert.deepEqual(h.reuses().slice(0, 5), ['first', 'warm', 'warm', 'budget', 'warm']);
  }, { maxTurns: 3 });
});

// 2026-11-25 (docs/claude/2026-11-25-first-turn-empty.md): I-210's thresholds (1/4/12/36 effective days) move a fresh character to
// level 2 on the 3rd round of day 1, so the relationship tag the host computes changes between turn 3 and turn 4 of every first chat.
// The chat acceptance saw turn 4 cold ("context") on every candidate after the I-210 merge; the unit suite never fed the host's real
// tag into a session. This does: the tag comes from the relationship module's own functions, the session is the real one.
test('a first chat: the familiarity level moving after round 3 of day 1 does not restart her process (turn 4 stays warm)', async () => {
  const today = '2026-11-25';
  let data = emptyRelationship(today);
  const tag = () => relationshipSessionTag({ slowWarmUp: true, stage: stageFor(effectiveDays(data), stageThresholds()), nickname: data.nickname, herNickname: data.herNickname });
  await withChat(async h => {
    let history: ChatMessage[] = [];
    const tags: string[] = [];
    for (let index = 1; index <= 6; index++) {
      tags.push(tag());
      history = (await h.send(history, `第${index}句`, { opening: tags.at(-1) })).history;
      data = withRound(data, today); // the host counts a finished round after her reply
    }
    assert.notEqual(tags[3], tags[2], 'the level moves between turn 3 and turn 4 (else this test no longer covers the case)');
    assert.deepEqual(h.reuses(), ['first', 'warm', 'warm', 'warm', 'warm', 'warm']);
  });
});

test('a window that does not line up names where: her reply missing, an edited user message, an unrelated window', async () => {
  await withChat(async h => {
    let history: ChatMessage[] = [];
    history = (await h.send(history, '一')).history;
    history = (await h.send(history, '二')).history;
    // Her last reply is missing from the window (something dropped it): the window ends before what Claude knows.
    await h.send(history.slice(0, -1), '三');
    // An earlier user message differs from what Claude was told.
    const edited = [u('一'), a('第1轮回复。'), u('二（改过）'), a('第2轮回复。')];
    await h.send(edited, '四');
    // A window from some other place.
    await h.send([u('完全无关'), a('另一个对话')], '五');
    assert.deepEqual(h.reuses(), ['first', 'warm', 'diverged-short', 'diverged-user', 'diverged-window']);
  });
});

test('explainDivergence tells where, for synthetic windows', () => {
  const known = [u('一'), a('甲'), u('二'), a('乙')];
  assert.equal(explainDivergence(known, [u('一'), a('甲'), u('二')]), 'short');
  assert.equal(explainDivergence(known, [u('一'), a('甲'), u('二x'), a('乙')]), 'user');
  assert.equal(explainDivergence(known, [u('一'), a('甲'), u('二'), a('丙')]), 'reply');
  assert.equal(explainDivergence(known, [u('别的')]), 'window');
  assert.equal(explainDivergence(known, []), 'short');
});

test('the journal keeps reuse and image only when they are a listed value and a boolean', () => {
  const base = { type: 'first-char', characterId: 'c1', ms: 1200, pauseTalk: false, carried: false, process: 'prewarmed', turn: 1 };
  for (const reuse of FIRST_CHAR_REUSES) {
    const kept = buildJournalEntry({ ...base, reuse, image: true }, 1) as Record<string, unknown> | null;
    assert.equal(kept?.reuse, reuse); assert.equal(kept?.image, true);
  }
  const text = buildJournalEntry({ ...base, reuse: '她说的某句话', image: 'yes' }, 1) as Record<string, unknown> | null;
  assert.ok(text && !('reuse' in text) && !('image' in text), 'free text never reaches the journal');
});

test('reuse and image travel from the transport through the latency record into the first-char journal fields', () => {
  let now = 0;
  const lines: string[] = [];
  const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => null, now: () => now, wallNow: () => 1_800_000_000_000, log: line => lines.push(line),
    timers: { set: callback => { callback(); return 0; }, clear: () => {} } });
  probe.begin('r1', 'claude');
  probe.claudeTiming().dispatched('r1', { mode: 'persistent', process: 'prewarmed', sessionTurn: 1, reuse: 'image', image: true });
  now = 5; probe.delta('r1', '你好'); probe.complete('r1'); probe.end('r1', false);
  const record = JSON.parse(lines[0]) as ReplyLatencyRecord;
  assert.equal(record.claude?.reuse, 'image');
  const extras = new JournalExtras({ sink: { record: () => true } as never, characterId: () => 'c', engine: () => 'local', uptimeMs: () => 1000, blushStage: () => {} });
  const fields = extras.firstChar({ firstContentMs: 100, firstBubbleMs: 110, claude: { process: 'prewarmed', sessionTurn: 1, firstDeltaMs: 90, reuse: 'image', image: true } });
  assert.equal(fields.reuse, 'image'); assert.equal(fields.image, true);
  assert.equal(extras.firstChar({ firstContentMs: null, firstBubbleMs: null }).reuse, undefined, 'a reply without a Claude process has no reuse field');
});