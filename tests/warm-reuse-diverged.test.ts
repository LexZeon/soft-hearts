// 2026-11-21 (docs/claude/2026-11-21-warm-reuse-diverged.md). Every reply of One (English) started a cold
// Claude process ("diverged-short"): the window built from her archive dropped each English reply as a "leaked draft" (the English-run rule
// of electron/brain/long-chat/history.ts), so it ended before what Claude knew. These tests run the real pieces together: her archive
// (MemoryStore), the window (longChatMessages), the session planner and a fake `claude` process (PersistentClaudeChat). The second half: out in
// full-screen Unbound her companion window is hidden, and the idle close must not take the shorter 'hidden' limit then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask, type PersistentClaudeOptions } from '../electron/brain/claude-session';
import { sessionIdleRule } from '../electron/brain/claude-session-idle';
import { longChatMessages } from '../electron/brain/long-chat/host';
import { isLeakedDraft } from '../electron/brain/long-chat/history';
import { i139ChatEdge } from '../electron/brain/i139-chat';
import { MemoryStore } from '../electron/memory/memory';
import { LONG_CHAT_KNOBS } from '../shared/behaviors/long-chat/knobs';
import { UnboundBubbleHold, type HeldBubbleEvent } from '../electron/unbound/bubble-hold';
import { chatWorld, expression, settle } from './helpers/chat-world';
import { wiringOption } from './helpers/wiring-source';

// The fake answers in English when the user's line carries "#en" (her English card), in Chinese otherwise; one delta per turn.
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
  const said = JSON.stringify(message.message.content);
  const text = said.includes("#en") ? "Hah? Turn " + turn + " and you are still here. Fine, I suppose I can keep you company a little longer."
    : "第" + turn + "轮回复。今天也辛苦了，慢慢说，我在听。";
  if (turn === 1) out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
}
`;
const persona = '你是测试角色 One，说话冷淡但关心人。';
const scope = { characterId: 'one', providerScope: 'claude:fixture' };

interface Sent { id: string; messages: ChatMessage[]; output: string; firstCharMs: number }
interface World {
  chat: PersistentClaudeChat;
  infos: ClaudeTimingInfo[];
  /** One typed turn as the host runs it: archive the user line, build the window from her archive, stream, archive her reply once. */
  send(text: string, during?: (id: string, delta: string) => void): Promise<Sent>;
}

async function withWorld(language: string | undefined, run: (world: World) => Promise<void>, extra: Partial<PersistentClaudeOptions> = {}): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-warm-reuse-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  const memory = new MemoryStore(path.join(root, 'memory'));
  await memory.load();
  const infos: ClaudeTimingInfo[] = [];
  const dispatched = new Map<string, number>(), first = new Map<string, number>();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {},
    timing: { dispatched: (id, info) => { infos.push(info); dispatched.set(id, performance.now()); }, firstDelta: id => { first.set(id, performance.now()); } }, ...extra });
  let turn = 0;
  const send = async (text: string, during?: (id: string, delta: string) => void): Promise<Sent> => {
    const id = `t${++turn}`;
    await memory.beginTurn(scope, { id, userText: text, at: Date.now(), conversationId: 'c1' });
    const messages = longChatMessages({ knobs: { ...LONG_CHAT_KNOBS, enabled: true }, archives: [memory], scope, turnId: id, ...(language ? { language } : {}),
      current: { content: text, createdAt: memory.turnStartedAt(scope, id) } });
    assert.ok(messages, 'her archive gives a window');
    let shown: string | null = null;
    const task: CompanionClaudeTask = {
      kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); },
      imageDataUrls: [], replyId: id, session: { key: 'c1', basePersona: persona, persona, messages, data: () => null, shown: () => shown },
    };
    const { output } = await chat.stream(task, new AbortController().signal, (type, delta) => {
      if (type !== 'delta') return;
      void memory.appendAssistant(scope, id, delta, Date.now()); // archived as it streams (CompanionService), never waiting for her voice
      during?.(id, delta);
    });
    await memory.finishTurn(scope, id, 'complete', Date.now());
    shown = output;
    return { id, messages, output, firstCharMs: Math.max(0, (first.get(id) ?? 0) - (dispatched.get(id) ?? 0)) };
  };
  try { await run({ chat, infos, send }); }
  finally {
    chat.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };

test('One (English): her English replies stay in the window, so every next turn reuses the warm process', async () => {
  await withWorld('en', async world => {
    const turns: Sent[] = [];
    for (let index = 0; index < 4; index++) turns.push(await world.send(`#en 第${index + 1}句`));
    assert.deepEqual(world.infos.map(info => info.reuse), ['first', 'warm', 'warm', 'warm']);
    assert.deepEqual(world.infos.map(info => info.sessionTurn), [1, 2, 3, 4]);
    // The window carries each reply exactly as Claude wrote it.
    const last = turns.at(-1)!.messages;
    for (const earlier of turns.slice(0, -1)) assert.ok(last.some(message => message.role === 'assistant' && message.content === earlier.output), earlier.output);
    console.info(`[warm-reuse] English card, first char (fake claude): turn 1 ${turns[0].firstCharMs.toFixed(0)} ms, turns 2-4 median ${median(turns.slice(1).map(turn => turn.firstCharMs)).toFixed(0)} ms`);
  });
});

test('the cause: without the card language an English reply is judged a leaked draft, the window ends before it and the turn starts cold', async () => {
  const reply = { role: 'assistant' as const, content: 'Hah? Turn 1 and you are still here. Fine, I suppose I can keep you company a little longer.' };
  assert.equal(isLeakedDraft(reply), true, 'a Chinese chat keeps the English-run rule (measured on her real chat)');
  assert.equal(isLeakedDraft(reply, { language: 'en' }), false, 'an English card is not judged by it');
  assert.equal(isLeakedDraft({ role: 'assistant', content: 'Fine. <sh-state-abc>x' }, { language: 'en' }), true, 'internal tags still count for an English card');
  await withWorld(undefined, async world => {
    const turns: Sent[] = [];
    for (let index = 0; index < 3; index++) turns.push(await world.send(`#en 第${index + 1}句`));
    assert.deepEqual(world.infos.map(info => info.reuse), ['first', 'diverged-short', 'diverged-short'], 'what the dev journal showed on 11-21');
    console.info(`[warm-reuse] without the language (the 11-21 build), first char (fake claude): turn 1 ${turns[0].firstCharMs.toFixed(0)} ms, turns 2-3 median ${median(turns.slice(1).map(turn => turn.firstCharMs)).toFixed(0)} ms`);
  });
});

test('her voice still playing and her bubble still revealing do not change what the next turn is told: warm, her whole reply in it', async () => {
  // The full-screen bubble's real hold (I-165): the reply follows her voice, and no sentence was heard yet, so the bubble shows "……".
  const shownOnBubble: HeldBubbleEvent[] = [];
  const hold = new UnboundBubbleHold({ emit: event => shownOnBubble.push(event), setTimer: () => 0, clearTimer: () => {} });
  hold.connect({ follows: () => true, segmentEnd: () => null });
  await withWorld(undefined, async world => {
    const first = await world.send('你好', (id, delta) => { hold.take({ id, type: 'delta', text: delta }); });
    hold.take({ id: first.id, type: 'done', text: '' });
    assert.equal(hold.holding, first.id, 'her bubble is still waiting for her voice');
    assert.equal(shownOnBubble.filter(event => event.type === 'delta').map(event => event.text).join(''), '', 'none of the reply is on her bubble yet');
    // The user answers while she is still speaking (window or full-screen typing alike: both build the window from her archive).
    const second = await world.send('嗯，我在');
    assert.ok(second.messages.some(message => message.role === 'assistant' && message.content === first.output), 'her whole reply, as Claude wrote it');
    const third = await world.send('然后呢');
    assert.ok(third.messages.some(message => message.role === 'assistant' && message.content === second.output));
    assert.deepEqual(world.infos.map(info => info.reuse), ['first', 'warm', 'warm']);
  });
});

test('the wiring hands the card language to the typed turn\'s window, and every window reader gets it', async () => {
  const w = chatWorld({ longChat: true });
  (w.env.i139Chat as { cardLanguage: () => string }).cardLanguage = () => 'en';
  w.send('r1', 'hi');
  await settle(() => w.settled('r1'), 'settles');
  assert.equal((w.longChatInputs[0] as { language?: string }).language, 'en');
  // The voice utterance's window (senses-voice-input-wiring) reads it too.
  const asked: unknown[] = [];
  const voiceWindow = expression<(groupId: string) => unknown>(wiringOption('voiceHost', 'longChatHistory'), {
    companion: { memory: {}, currentScope: () => scope }, textInvitationMemory: null, LONG_CHAT: { enabled: true }, // the wiring's needs.* read these names
    i139Chat: { labels: () => null, cardLanguage: () => 'en' }, longChatHistory: (input: unknown) => { asked.push(input); return []; } });
  voiceWindow('g1');
  assert.equal((asked[0] as { language?: string }).language, 'en');
  // The edge reads the active card whatever the I-139 switch says.
  assert.equal(i139ChatEdge({ on: () => false, card: () => ({ language: 'en' }) }).cardLanguage(), 'en');
  assert.equal(i139ChatEdge({ on: () => false, card: () => { throw new Error('no card'); } }).cardLanguage(), 'zh-CN');
});

// ---------------------------------------------------------------- out in full-screen Unbound: no 'hidden' close

test('idle rule: a hidden companion window while she is seen elsewhere keeps the ordinary limit', () => {
  const limits = { idleMs: 600_000, hiddenIdleMs: 180_000 };
  assert.deepEqual(sessionIdleRule({ visible: true, ...limits }), { ms: 600_000, reason: 'idle' });
  assert.deepEqual(sessionIdleRule({ visible: false, ...limits }), { ms: 180_000, reason: 'hidden' });
  assert.deepEqual(sessionIdleRule({ visible: false, seenElsewhere: () => true, ...limits }), { ms: 600_000, reason: 'idle' });
  assert.deepEqual(sessionIdleRule({ visible: false, seenElsewhere: () => { throw new Error('x'); }, ...limits }), { ms: 180_000, reason: 'hidden' });
});

test('out in full-screen Unbound (companion window hidden, she is on screen) the process is not closed as hidden; at home hidden it still is', async () => {
  // 'before': she is out when the window hides; 'after': the window hides first and she is out by the time the short timer fires; 'home': hidden at home.
  for (const when of ['before', 'after', 'home'] as const) {
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let next = 0, seen = false;
    const closes: string[] = [];
    const idle = () => [...timers.entries()].filter(([, timer]) => timer.ms > 60_000).map(([handle, timer]) => ({ ms: timer.ms, fire: () => { timers.delete(handle); timer.callback(); } }));
    await withWorld(undefined, async world => {
      await world.send('你好');
      seen = when === 'before';
      world.chat.noteVisible(false);
      const first = idle();
      assert.equal(first.length, 1, when);
      if (when === 'before') assert.ok(first[0].ms > 180_000 && first[0].ms <= 600_000, 'the ordinary limit, not the hidden one');
      else {
        assert.ok(first[0].ms <= 180_000, 'hidden: the shorter limit is set');
        seen = when === 'after';
        first[0].fire();
        if (when === 'home') { assert.deepEqual(closes, ['hidden']); return; }
        assert.deepEqual(closes, [], 'not closed as hidden: she is on screen by now');
        const longer = idle();
        assert.equal(longer.length, 1, 'the ordinary limit runs instead');
        assert.ok(longer[0].ms > 180_000 && longer[0].ms <= 600_000);
      }
      const reply = await world.send('还在吗');
      assert.equal(world.infos.at(-1)?.reuse, 'warm', `${when}: the next reply is warm (${reply.firstCharMs.toFixed(0)} ms)`);
      assert.deepEqual(closes, []);
    }, { timers: { set: (callback, ms) => { timers.set(++next, { callback, ms }); return next; }, clear: handle => { timers.delete(handle as number); } },
      idleMs: 600_000, hiddenIdleMs: 180_000, seenElsewhere: () => seen, log: line => { const match = /closed \((\w+)\)/.exec(line); if (match) closes.push(match[1]); } });
  }
});

test('the wiring: the chat process asks herOnScreen whether she is seen while her companion window is hidden', () => {
  const seenElsewhere = expression<() => boolean>(wiringOption('claudeChat', 'seenElsewhere'), { herHereNow: () => true });
  assert.equal(seenElsewhere(), true);
  assert.equal(expression<() => boolean>(wiringOption('claudeChat', 'seenElsewhere'), { herHereNow: () => false })(), false);
});
