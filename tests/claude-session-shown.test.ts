// 2026-11-04 首字变慢 (docs/claude/2026-11-04-session-continuity-after-filter.md): the conversation-scoped Claude process kept
// what Claude wrote, the chat window keeps what the reply protocol showed (an internal plan block cut, garbled text
// repaired, a leading "<br>" run dropped). On the next message the two did not line up, the session was judged
// "diverged", closed, and the reply came from a cold or pre-warmed process. Here the turns run the way electron/main.ts
// wires them: the provider's deltas go into CompanionService.begin's turn (bubble, streamed speech, archive), the window's
// history is built with the renderer's own helpers (src/ui/reply-history.ts), and the host tells the session what the
// turn showed. The model is a fake `claude` speaking Claude Code's stream-json; every reply below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/contracts';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { PersistentClaudeChat, type CompanionSessionInput } from '../electron/claude-session';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { appendReplyHistory, outgoingChatMessages } from '../src/ui/reply-history';
import { encodeWav } from '../src/ui/MediaInput';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { speakableText } from '../shared/speakable-text';
import { voiceUtteranceMessages, type VoiceConversationEvent } from '../shared/voice-conversation';

const PERSONA = '角色名称：小桃\n你是测试角色小桃，说话温柔。';

// A plan block in front of the reply (the F4 shape, docs/claude/2026-11-04-draft-leak-plan-block.md; synthetic).
const PLAN = '笔记: 用户这轮说想把今天傍晚散步的事记下来，她大概是想被好好记住（memorial context），回应要轻一点、不能直接说"已保存"，语气别太正式（no lecturing）。';
const WALK = '嗯，傍晚的风确实很舒服，我也喜欢听你讲散步的事。\n\n下次走到桥边，也跟我说说那边的样子吧。';
const BREAK_REPLY = '晚上好呀，今天也辛苦了。';
const PLAN_WORDS = /笔记|用户|回应|语气|memorial|lecturing|已保存/u;

/** Reply bodies by a marker in the current user message; the fake appends this turn's state tail (its nonce is in the prompt). */
const REPLIES: Record<string, string> = {
  '#plan': `${PLAN}\n\n${WALK}`,
  '#br': `<br><br>\n${BREAK_REPLY}`,
};

const fakeSource = `
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
fs.appendFileSync(path.join(dir, "spawns.log"), JSON.stringify({ pid: process.pid }) + "\\n");
const replies = JSON.parse(fs.readFileSync(path.join(dir, "replies.json"), "utf8"));
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
  const prompt = message.message.content.map(block => block.text || "").join("");
  fs.appendFileSync(path.join(dir, "input.log"), JSON.stringify({ pid: process.pid, prompt }) + "\\n");
  const data = /<conversation-data>\\n([\\s\\S]*)\\n<\\/conversation-data>/.exec(prompt);
  const user = data ? JSON.parse(data[1]).currentUser : prompt;
  const marker = (prompt.match(/<sh-state-[a-f0-9]+>/) || [])[0];
  const key = Object.keys(replies).find(name => user.includes(name));
  const body = key ? replies[key] : "第" + turn + "轮，嗯，我在听。";
  const text = body + (marker ? "\\n" + marker + '{"context":"neutral","delta":{},"reason":"测试","confidence":0.9}' + marker.replace("<", "</") : "");
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  // Three characters a delta, so a plan's label and its colon arrive together (a lone first character may show; see
  // tests/reply-draft-plan-block.test.ts).
  const chars = [...text], pieces = [];
  for (let i = 0; i < chars.length; i += 3) pieces.push(chars.slice(i, i + 3).join(""));
  for (const piece of pieces) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
  out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
}
`;

interface Harness {
  root: string;
  service: CompanionService;
  chat: PersistentClaudeChat;
  /** The chat window's history, kept exactly as the renderer keeps it. */
  history: ChatMessage[];
  spawns(): Promise<number>;
  prompts(): Promise<string[]>;
  closes: string[];
}

async function withHarness(run: (h: Harness) => Promise<void>, replies: Record<string, string> = REPLIES): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-session-shown-'));
  await writeFile(path.join(root, 'fake-claude.cjs'), fakeSource);
  await writeFile(path.join(root, 'replies.json'), JSON.stringify(replies));
  const lines = async (name: string) => {
    try { return (await readFile(path.join(root, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
  };
  const service = new CompanionService(path.join(root, 'profile'), () => {});
  const closes: string[] = [];
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [path.join(root, 'fake-claude.cjs')],
    provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => false, interruptGraceMs: 300, log: line => closes.push(line) });
  try {
    await service.load();
    await service.context('xiaotao', { kind: 'claude', baseUrl: 'https://session-shown.invalid/v1', model: 'haiku' }, PERSONA);
    await run({ root, service, chat, history: [], closes,
      spawns: async () => (await lines('spawns.log')).length,
      prompts: async () => (await lines('input.log')).map(row => row.prompt as string) });
  } finally {
    chat.dispose();
    await service.flush().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

/** The unseen history and current message of one prompt sent to Claude. */
function conversationData(prompt: string): { history: ChatMessage[]; currentUser: string } {
  return JSON.parse(prompt.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]);
}

/**
 * One ordinary chat turn as electron/main.ts runs it on the Claude path: the turn's protocol filters the provider's deltas
 * into the bubble, the streamed speech and the archive; the session is told what the turn showed; the window appends
 * what it showed (appendReplyHistory). `key`/`persona` stand for the conversation and the character.
 */
async function chatTurn(h: Harness, id: string, userText: string, options: { key?: string; persona?: string; history?: ChatMessage[] } = {}) {
  const persona = options.persona ?? PERSONA;
  const user: ChatMessage = { role: 'user', content: userText };
  const messages = outgoingChatMessages(options.history ?? h.history, user);
  const bubble: string[] = [];
  const speech = new CompletedReplySpeech();
  const fence = speech.beginCommit(1, id, 'scope');
  let spokenText = '';
  const turn: CompanionTurn = await h.service.begin(id, userText, persona, (type, text) => {
    if (type !== 'delta') return;
    speech.append(fence, text);
    spokenText += text;
    bubble.push(text);
  });
  await h.chat.stream({
    kind: 'chat', model: 'haiku', workingDirectory: h.root, writable: false, imageDataUrls: [], replyId: id,
    get prompt() { return buildCodexChatPrompt(turn.persona, messages); },
    session: { key: options.key ?? 'conversation-1', basePersona: persona, persona: turn.persona, messages, data: () => null,
      shown: () => turn.shownReply?.() ?? null },
  }, new AbortController().signal, turn.push);
  await turn.finish('complete');
  speech.record(1, id, 'scope', spokenText, { prefix: true, fence });
  const spoken: string[] = [];
  for (let segment = speech.next(1, id, 'scope'); segment; segment = speech.next(1, id, 'scope', segment.index)) spoken.push(speakableText(segment.text));
  const shown = bubble.join('');
  h.history = appendReplyHistory(messages.slice(0, -1), user, shown);
  const archived = h.service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!.messages.map(message => message.content);
  return { shown, spoken: spoken.join(''), archived };
}

test('a reply whose plan block was cut: the next messages stay on the same process, and the plan reaches no window, archive or voice', async () => {
  await withHarness(async h => {
    const planned = await chatTurn(h, 'plan-1', '今天傍晚去散步了，风好舒服 #plan');
    assert.equal(planned.shown, WALK, 'the window shows only the reply');
    assert.equal(planned.spoken, WALK.replace(/\n+/gu, ''), 'and reads only the reply');
    assert.deepEqual(planned.archived, ['今天傍晚去散步了，风好舒服 #plan', WALK], 'and archives only the reply');
    for (const text of [planned.shown, planned.spoken, planned.archived.join('\n')]) assert.doesNotMatch(text, PLAN_WORDS);
    const next = await chatTurn(h, 'plan-2', '是啊，明天还想去');
    const third = await chatTurn(h, 'plan-3', '你也一起来吧');
    assert.equal(await h.spawns(), 1, 'one process for all three messages');
    assert.ok(!h.closes.some(line => line.includes('diverged')), h.closes.join('; '));
    const prompts = await h.prompts();
    assert.equal(prompts.length, 3);
    assert.deepEqual(conversationData(prompts[1]), { history: [], currentUser: '是啊，明天还想去' }, 'Claude already holds the turn; nothing is resent');
    assert.deepEqual(conversationData(prompts[2]), { history: [], currentUser: '你也一起来吧' });
    for (const prompt of prompts.slice(1)) assert.ok(!prompt.includes('笔记: 用户'), 'the cut plan is never sent back as something she said');
    assert.ok(next.shown && third.shown);
  });
});

test('a reply that began with HTML line breaks: the next message stays on the same process', async () => {
  await withHarness(async h => {
    const first = await chatTurn(h, 'br-1', '晚上好 #br');
    assert.equal(first.shown, BREAK_REPLY);
    assert.deepEqual(first.archived, ['晚上好 #br', BREAK_REPLY]);
    await chatTurn(h, 'br-2', '嗯，今天好累');
    assert.equal(await h.spawns(), 1);
    assert.deepEqual(conversationData((await h.prompts())[1]), { history: [], currentUser: '嗯，今天好累' });
  });
});

// "UTF-8 read as GBK" garbage (shared/mojibake.ts, docs/claude/2026-11-03-mojibake-guard.md), garbled the same way as there.
const garble = (text: string): string => new TextDecoder('gbk').decode(Buffer.from(text, 'utf8'));
const SAID = '面试没过不是你的问题，是他们没眼光。今天先好好休息，我陪着你。';

test('a garbled reply that was repaired: the next message stays on the same process, and only repaired words are shown, archived and read', async () => {
  await withHarness(async h => {
    const first = await chatTurn(h, 'mojibake-1', '面试又没过 #mojibake');
    assert.ok(first.shown.length >= 20, first.shown);
    for (const char of first.shown) assert.ok(SAID.includes(char), `garbled ${JSON.stringify(char)} reached the window`);
    assert.deepEqual(first.archived, ['面试又没过 #mojibake', first.shown]);
    assert.equal(first.spoken, first.shown);
    await chatTurn(h, 'mojibake-2', '谢谢你');
    assert.equal(await h.spawns(), 1);
    const followUp = (await h.prompts())[1];
    assert.deepEqual(conversationData(followUp), { history: [], currentUser: '谢谢你' });
  }, { ...REPLIES, '#mojibake': garble(SAID) });
});

test('after a cut plan, a window that really differs still opens a fresh session with the shown history', async () => {
  const edited: ChatMessage[] = [{ role: 'user', content: '今天傍晚去散步了，风好舒服 #plan' }, { role: 'assistant', content: '（用户改过的回复）' }];
  const cases: Array<{ name: string; next: (h: Harness) => Promise<unknown> }> = [
    { name: 'an edited reply', next: h => chatTurn(h, 'x-2', '还在吗', { history: edited }) },
    { name: 'a deleted turn', next: h => chatTurn(h, 'x-2', '还在吗', { history: [] }) },
    { name: 'a cleared chat in another conversation', next: h => chatTurn(h, 'x-2', '新的开始', { key: 'conversation-2', history: [] }) },
    { name: 'another character', next: h => chatTurn(h, 'x-2', '你是谁', { persona: '角色名称：阿杏\n你是测试角色阿杏。' }) },
  ];
  for (const { name, next } of cases) {
    await withHarness(async h => {
      await chatTurn(h, 'x-1', '今天傍晚去散步了，风好舒服 #plan');
      await next(h);
      assert.equal(await h.spawns(), 2, name);
      const opening = conversationData((await h.prompts())[1]);
      for (const message of opening.history) assert.doesNotMatch(message.content, /笔记: 用户/u, `${name}: the fresh session gets the shown history`);
    });
  }
});

test('voice: legs whose plan was cut regroup to the shown utterance, and the typed message after it stays on the same process', async () => {
  await withHarness(async h => {
    const signal = new AbortController().signal;
    const shownOf = new Map<string, string>();
    // One leg of an utterance: the protocol filters it like any reply; the voice host (electron/voice-chat-host.ts) keeps the
    // leg's shown text once the leg has finished, and that is what the session is told.
    const leg = async (id: string, messages: ChatMessage[]) => {
      let text = '';
      const turn = await h.service.begin(id, messages.at(-1)!.content, PERSONA, (type, value) => { if (type === 'delta') text += value; });
      await h.chat.stream({ kind: 'chat', model: 'haiku', workingDirectory: h.root, writable: false, imageDataUrls: [], replyId: id,
        prompt: buildCodexChatPrompt(turn.persona, messages),
        session: { key: 'conversation-1', basePersona: PERSONA, persona: turn.persona, messages, shown: () => shownOf.get(id) ?? null },
      }, signal, turn.push);
      await turn.finish('complete');
      shownOf.set(id, text);
      return text;
    };
    const first = await leg('v-1', [{ role: 'user', content: '今天傍晚去散步了 #plan' }]);
    assert.equal(first, WALK);
    const second = await leg('v-2', [{ role: 'user', content: '今天傍晚去散步了 #plan' }, { role: 'assistant', content: first }, { role: 'user', content: '风好舒服' }]);
    const shown = voiceUtteranceMessages('今天傍晚去散步了 #plan\n风好舒服', [first, second]);
    assert.equal(h.chat.regroup(['v-1', 'v-2'], shown), true, 'the shown form is what the session recorded');
    h.history = shown;
    await chatTurn(h, 'typed', '你也喜欢散步吗');
    assert.equal(await h.spawns(), 1);
    assert.deepEqual(conversationData((await h.prompts()).at(-1)!), { history: [], currentUser: '你也喜欢散步吗' });
  });
});

async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 5000;
  while (!check() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'timed out waiting');
}

test('the actual voice host tells the session what each leg showed, only once the leg has finished', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-session-shown-voice-'));
  const service = new CompanionService(directory, () => {}), events: VoiceConversationEvent[] = [];
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS); settings.provider.kind = 'claude'; settings.voice.enabled = true; settings.persona = PERSONA;
  await service.context('xiaotao', settings.provider, PERSONA);
  const sessions: CompanionSessionInput[] = [], during: Array<string | null | undefined> = [];
  const regrouped: Array<{ replyIds: readonly string[]; shown: readonly ChatMessage[] }> = [];
  const pending = new Map<string, AbortController>(), finals = ['今天傍晚去散步了'];
  type Stream = PersistentClaudeChat['stream'];
  const claude = {
    // Stands in for the conversation's Claude session: Claude writes a plan block in front of the reply.
    async stream(task: Parameters<Stream>[0], _signal: Parameters<Stream>[1], emit: Parameters<Stream>[2]) {
      sessions.push(task.session!);
      during.push(task.session!.shown?.());
      const marker = task.prompt.match(/<sh-state-[a-f0-9]+>/)![0];
      const output = `${PLAN}\n\n${WALK}\n${marker}{"context":"neutral","delta":{},"reason":"测试","confidence":0.9}${marker.replace('<', '</')}`;
      for (let i = 0; i < output.length; i += 3) emit('delta', output.slice(i, i + 3));
      return { superseded: false, output };
    },
    regroup(replyIds: readonly string[], shown: readonly ChatMessage[]) { regrouped.push({ replyIds, shown }); return true; },
  };
  const voice = new VoiceChatHost({
    broadcast: event => { events.push(event); }, memoryChanged() {},
    windowVisible: sender => sender === 77, media: () => ({ voiceInput: true, voiceOwner: 'controls' }), turnOffVoiceInput() {},
    speechScope: () => 'fixture-context', settings: () => settings, companion: () => service, ambient: () => null,
    reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; },
    releaseChat: replyId => { pending.delete(replyId); }, userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude, languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => finals.shift()!, stopReading() {}, prepareSpeech() {},
  });
  try {
    const binding = voice.open(77, 'controls');
    const result = voice.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: 1, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    assert.equal(result.state, 'queued');
    await until(() => sessions.length === 1);
    assert.equal(voice.pipeline.finishSpeaking(77, binding.captureSessionId), true);
    await until(() => regrouped.length === 1);
    await voice.drain();
    assert.equal(during[0], null, 'nothing to tell while the leg is still running');
    assert.equal(sessions[0].shown?.(), WALK, 'the leg showed the reply, never the plan');
    const shownDeltas = events.flatMap(event => event.type === 'delta' ? [event.text] : []).join('');
    assert.equal(shownDeltas, WALK);
    assert.deepEqual(regrouped[0].shown, voiceUtteranceMessages('今天傍晚去散步了', [WALK]));
  } finally {
    voice.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); await voice.drain(); await service.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
