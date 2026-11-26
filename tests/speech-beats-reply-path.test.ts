// 边说边演第 2 步：回复链路（docs/claude/2026-11-20-speech-beats-2-4.md）。聊天一轮是接线里真的那段代码（tests/helpers/chat-world.ts
// 从 electron/wiring/brain-chat-wiring.ts 的文字取出来跑），她的 Claude 流是假的，标记故意拆在几段里。
// 守的事：协议、气泡、朗读、存档、记忆只见干净的字；只演不说的那条不出字、不朗读、灰色小字、只存一次；开关关着提示词一字不变；
// 停掉的回复不再发拍子。
// Reads as text (test-affected selects this test when they change): 'electron/wiring/brain-wiring.ts', 'electron/wiring/brain-chat-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatWorld, settle } from './helpers/chat-world';
import { speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_WORDS } from '../shared/behaviors/speech-beats/interface';
import { SpeechBeatArchive } from '../electron/brain/speech-beats/archive';
import { SpeechBeatsHost } from '../electron/brain/speech-beats/host';
import { MemoryStore } from '../electron/memory/memory';
import { longChatMessages } from '../electron/brain/long-chat/host';
import { LONG_CHAT_KNOBS } from '../shared/behaviors/long-chat/knobs';
import { sessionText } from '../electron/brain/claude-session-prompt';

const SPLIT = ['⟦smi', 'le-warm⟧今天', '起得好早。⟦ti', 'lt⟧昨晚睡得好吗？⟦lea', 'n-in⟧'];
const leaks = (text: string) => /[⟦⟧]/u.test(text) || SPEECH_BEAT_WORDS.some(word => text.includes(word));
type BeatsEvent = { id: string; type: string; speechBeats?: { beats?: { word: string; at: number }[]; final?: { performanceOnly: boolean; line: string; history: string | null } } };
const beatEvents = (events: readonly unknown[]) => (events as BeatsEvent[]).filter(event => event.type === 'beats');
const sessionShown = (task: Record<string, unknown>) => (task.session as { shown: () => string | null }).shown();

/** Today's per-turn prompt of the fake world (before 边说边演): the switch off must give exactly this. */
const TODAY_PROMPT = 'PROMPT:PERSONA\n\nIC\n\nSIGHT';

test('switch on: markers split across chunks never reach the protocol, the bubble, the reading or the archive; beats go out in order', async () => {
  const w = chatWorld({ stream: SPLIT, beats: true, passThrough: true });
  w.send('r1');
  await settle(() => w.settled('r1'), 'the reply settles');
  const pushed = w.log.filter(line => line.startsWith('push delta ')).map(line => line.slice('push delta '.length));
  assert.equal(pushed.join(''), '今天起得好早。昨晚睡得好吗？', 'what her reply protocol is given');
  for (const text of [...pushed, ...w.shown, ...w.spoken]) assert.ok(!leaks(text), `leaked: ${text}`);
  assert.ok(w.spoken.some(line => line === '[record] 今天起得好早。昨晚睡得好吗？'), 'the reading gets the clean reply');
  const beats = beatEvents(w.events);
  assert.deepEqual(beats.flatMap(event => event.speechBeats?.beats ?? []), [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 7 }, { word: 'lean-in', at: 14 }]);
  assert.deepEqual(beats.at(-1)?.speechBeats?.final, { performanceOnly: false, line: '', history: '⟦smile-warm⟧今天起得好早。⟦tilt⟧昨晚睡得好吗？⟦lean-in⟧' });
  const order = (w.events as BeatsEvent[]).filter(event => event.id === 'r1' && event.type !== 'status').map(event => event.type);
  assert.equal(order.at(-1), 'done', 'the final beats come before done');
  assert.ok(String(w.tasks[0].prompt).includes(speechBeatSentence()), 'the prompt sentence is in her turn while the switch is on');
  assert.equal(sessionShown(w.tasks[0]), '⟦smile-warm⟧今天起得好早。⟦tilt⟧昨晚睡得好吗？⟦lean-in⟧', 'her process remembers her words as written');
  const voice = (w.voiceHost.history as { messages: { role: string; content: string }[] }).messages.at(-1);
  assert.equal(voice?.content, '⟦smile-warm⟧今天起得好早。⟦tilt⟧昨晚睡得好吗？⟦lean-in⟧');
  await settle(() => w.archived.length === 1, 'kept once beside her archive');
  const kept = JSON.parse(w.archived[0]) as { entries: { beats: unknown[]; performanceOnly: boolean; line: string }[] };
  assert.equal(kept.entries.length, 1);
  assert.equal(kept.entries[0].beats.length, 3);
  assert.ok(!JSON.stringify(kept).includes('今天'), 'her words are not kept there');
});

test('I-175 "how long": suffixes split across chunks (and an unknown one) never reach the protocol, the bubble, the reading or the archive text', async () => {
  const w = chatWorld({ stream: ['⟦pou', 't on', 'ce⟧哼。【smile-warm li', 'ne】好吧。⟦tilt fore', 'ver⟧'], beats: true, passThrough: true });
  w.send('r1');
  await settle(() => w.settled('r1'), 'the reply settles');
  const pushed = w.log.filter(line => line.startsWith('push delta ')).map(line => line.slice('push delta '.length));
  assert.equal(pushed.join(''), '哼。好吧。');
  for (const text of [...pushed, ...w.shown, ...w.spoken]) assert.ok(!leaks(text) && !/once|line|forever/u.test(text), `leaked: ${text}`);
  const beats = beatEvents(w.events);
  assert.deepEqual(beats.flatMap(event => event.speechBeats?.beats ?? []), [{ word: 'pout', at: 0, how: 'once' }, { word: 'smile-warm', at: 2, how: 'line' }, { word: 'tilt', at: 5 }]);
  assert.equal(beats.at(-1)?.speechBeats?.final?.history, '⟦pout once⟧哼。⟦smile-warm line⟧好吧。⟦tilt⟧', 'her history: her own words with her known suffixes');
  await settle(() => w.archived.length === 1, 'kept once beside her archive');
  const kept = JSON.parse(w.archived[0]) as { entries: { beats: { word: string; at: number; how?: string }[] }[] };
  assert.deepEqual(kept.entries[0].beats, [{ word: 'pout', at: 0, how: 'once' }, { word: 'smile-warm', at: 2, how: 'line' }, { word: 'tilt', at: 5 }], 'the closed suffix is kept with the beat');
});

test('switch off: the prompt is byte-for-byte today’s, nothing is performed, and her markers still never show', async () => {
  const plain = chatWorld({ beats: false });
  plain.send('r1');
  await settle(() => plain.settled('r1'), 'settles');
  assert.equal(plain.tasks[0].prompt, TODAY_PROMPT, 'golden: the prompt with the switch off');
  assert.deepEqual(beatEvents(plain.events), [], 'no markers, nothing to say');
  const w = chatWorld({ stream: SPLIT, beats: false, passThrough: true });
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.equal(w.tasks[0].prompt, TODAY_PROMPT);
  for (const text of [...w.log, ...w.shown, ...w.spoken]) assert.ok(!leaks(text), `leaked: ${text}`);
  const beats = beatEvents(w.events);
  assert.ok(beats.every(event => !event.speechBeats?.beats), 'no beats for the stage while off');
  assert.deepEqual(beats.at(-1)?.speechBeats?.final, { performanceOnly: false, line: '', history: '今天起得好早。昨晚睡得好吗？' });
  assert.equal(sessionShown(w.tasks[0]), '今天起得好早。昨晚睡得好吗？');
});

test('performance-only (on): no bubble text, no reading, the grey line, kept once with her markers as her history', async () => {
  const w = chatWorld({ stream: ['⟦sh', 'y⟧⟦hand-', 'cheek⟧'], beats: true, passThrough: true });
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.equal(w.shown.join(''), '', 'nothing for the bubble or the archive text');
  assert.ok(!w.log.includes('speech recorded'), 'nothing is read aloud');
  const final = beatEvents(w.events).at(-1)?.speechBeats?.final;
  assert.deepEqual(final, { performanceOnly: true, line: '（害羞地笑了，手放到脸边）', history: '⟦shy⟧⟦hand-cheek⟧' });
  assert.deepEqual(beatEvents(w.events).flatMap(event => event.speechBeats?.beats ?? []), [{ word: 'shy', at: 0 }, { word: 'hand-cheek', at: 0 }]);
  assert.ok(!/（/u.test(sessionShown(w.tasks[0]) ?? ''), 'never a bracket action as her words');
  await settle(() => w.archived.length === 1, 'kept once');
  assert.equal(JSON.parse(w.archived[0]).entries[0].performanceOnly, true);
  assert.deepEqual(w.finishes, ['complete'], 'one archive of the reply');
});

test('performance-only (off): the grey line, no reading, and it stays out of her history', async () => {
  const w = chatWorld({ stream: ['⟦shy⟧'], beats: false, passThrough: true });
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.ok(!w.log.includes('speech recorded'));
  assert.deepEqual(beatEvents(w.events).at(-1)?.speechBeats?.final, { performanceOnly: true, line: '（害羞地笑了）', history: null });
  assert.equal(sessionShown(w.tasks[0]), '');
});

test('a stop while it streams or while it is archived: no more beats, no grey line, nothing kept', async () => {
  const held = chatWorld({ stream: SPLIT, beats: true, passThrough: true, hold: true });
  held.send('r1');
  await settle(() => held.tasks.length === 1, 'streaming');
  held.cancel(1, 'r1');
  held.release();
  await settle(() => held.settled('r1'), 'settles');
  assert.deepEqual(beatEvents(held.events), []);
  const late = chatWorld({ stream: SPLIT, beats: true, passThrough: true });
  late.env.onFinish = async (status: string) => { if (status === 'complete') late.cancel(1, 'r1'); };
  late.send('r1');
  await settle(() => late.settled('r1'), 'settles');
  assert.ok(beatEvents(late.events).every(event => !event.speechBeats?.final), 'no final for a stopped reply');
  assert.deepEqual(late.archived, []);
});

test('her process compares her words without markers, so a window without them still lines up with what she wrote', () => {
  assert.equal(sessionText('⟦smile-warm⟧今天好。⟦tilt⟧'), '今天好。');
  assert.equal(sessionText('⟦shy⟧⟦hand-cheek⟧'), '');
  assert.equal(sessionText('【重要】带伞'), '【重要】带伞');
});

test('her long window: with the switch on her archived replies come back as she wrote them, a performance-only one included; off, as archived', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-speech-beats-'));
  const memory = new MemoryStore(directory);
  await memory.load();
  const scope = { characterId: 'gene', providerScope: 'claude:fixture' };
  const turn = async (id: string, text: string, reply: string, when: number) => {
    await memory.beginTurn(scope, { id, userText: text, at: when, conversationId: 'c1' });
    if (reply) await memory.appendAssistant(scope, id, reply, when + 1);
    await memory.finishTurn(scope, id, 'complete', when + 2);
  };
  const writes: string[] = [];
  const host = new SpeechBeatsHost(directory, new SpeechBeatArchive(directory, async (_file, data) => { writes.push(data); }, () => { throw new Error('none'); }));
  const now = Date.UTC(2026, 10, 20, 12);
  await turn('t1', '早', '早。吃了吗？', now - 60_000);
  await host.archive.record(scope, 't1', { beats: [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 2 }], line: '', performanceOnly: false });
  await turn('t2', '你真好看', '', now - 50_000);
  await host.archive.record(scope, 't2', { beats: [{ word: 'shy', at: 0 }], line: '（害羞地笑了）', performanceOnly: true });
  const knobs = { ...LONG_CHAT_KNOBS, enabled: true };
  const on = longChatMessages({ knobs, archives: [host.longChatArchive(memory, true)], scope, current: { content: '嗯' }, now })!;
  const off = longChatMessages({ knobs, archives: [host.longChatArchive(memory, false)], scope, current: { content: '嗯' }, now })!;
  const replies = (messages: { role: string; content: string }[]) => messages.filter(message => message.role === 'assistant').map(message => message.content);
  assert.ok(replies(on).some(content => content.endsWith('⟦smile-warm⟧早。⟦tilt⟧吃了吗？')), JSON.stringify(on));
  assert.ok(replies(on).some(content => content.endsWith('⟦shy⟧')), 'the performance-only turn is in her history as her markers');
  assert.ok(replies(off).some(content => content.endsWith('早。吃了吗？') && !content.includes('⟦')));
  assert.ok(!replies(off).some(content => content.includes('⟦')), 'off: as archived');
  assert.equal(replies(off).length, 1, 'off: the performance-only turn stays out');
  for (const content of [...replies(on), ...replies(off)]) assert.ok(!/（害羞/u.test(content), 'never the grey line as her words');
  // The archive reads back what it wrote; a damaged file is empty, never a failure.
  const again = new SpeechBeatArchive(directory, async () => {}, () => writes.at(-1)!);
  assert.deepEqual(again.get(scope, 't2'), { beats: [{ word: 'shy', at: 0 }], line: '（害羞地笑了）', performanceOnly: true });
  assert.equal(new SpeechBeatArchive(directory, async () => {}, () => '{bad').get(scope, 't2'), null);
});
