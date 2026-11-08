/**
 * I-040 看一眼、听一下 (docs/claude/2026-11-07-sense-router.md). Never a real model call: fake haiku, fake frames, a fake clock.
 *
 * What it pins: the senses question rides on the reaction judge's one call (no extra call before her first character; the prompt is
 * byte-for-byte the old one when the router is off); a needed sense that is on gives one sample and haiku's facts, and her short
 * line comes only after her first reply ended and only once she is free; a newer message, a stopped reply, another conversation or
 * a "别看" drops or holds everything; a needed sense that is off gives "it is off" at most once per conversation and never turns
 * anything on; when the reaction call is not made, the router's own small call starts only after her first character; frames,
 * transcripts and facts never reach the log or the disk; the pet window reads only the sense line's exact shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReactionHost, type ReactionHostOptions, type ReactionNowSource } from '../electron/reactions/host';
import { createReactions, type ReactionMoodPort } from '../electron/reactions/wiring';
import { SenseRouterHost, type SenseRouterLogEntry, type SenseRouterPorts } from '../electron/sense-router/host';
import { coveredByFrames, createSenseRouter } from '../electron/sense-router/wiring';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import { parseReactionAnswer, reactionSystemPrompt } from '../shared/behaviors/reactions/choose';
import {
  SENSE_FIRST_LINE_HINT, SENSE_ROUTER_KNOBS, parseSenseField, parseSenseJudge, parseSenseLine, parseSenseSummary, readSenseLineMessage, senseBlock, senseLineOrigin,
  type SenseLineMessage, type SenseOn,
} from '../shared/sense-router';
import { readFeedLineMessage } from '../shared/feed-recognition';
import { FeedLinePresenter } from '../src/ui/feed-line';
import type { Dispositions } from '../shared/behaviors/reactions/dispositions';
import type { ReactionPerformer } from '../shared/behaviors/reactions/interface';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';

const SIX: Dispositions = Object.freeze({ shy: 62, clingy: 45, lively: 55, soothable: 50, volatile: 40, restrained: 48 });
const FRAME = 'data:image/jpeg;base64,RkFLRS1GUkFNRS1NQVJLRVI='; // "FAKE-FRAME-MARKER"
const FACTS = '他举着一杯奶茶，笑着，背后是书架。';
const HEARD = '主持人说今天的嘉宾是一位天文学家';

class Clock {
  now = Date.UTC(2026, 10, 7, 12, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly api = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + Math.max(0, ms), fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

const REACTION = { event: 'praise', reactions: [], delta: { O: 2 }, confidence: 0.9 };
const answerWith = (senses: unknown) => JSON.stringify({ ...REACTION, senses });

/** The whole host side: a reaction host whose one call carries the senses question, and the router with fake ports. */
function world(clock: Clock, options: { senses?: unknown; reactionsOn?: boolean; on?: Partial<SenseOn>; routerOn?: boolean } = {}) {
  const state = {
    on: { camera: true, screen: false, transcript: false, ...options.on } as SenseOn,
    identity: 'scope-1', conversation: 'conv-1', character: 'heroine', free: true, routerOn: options.routerOn ?? true,
    quiet: null as null | 'hidden',
    summary: FACTS as string | null, line: '诶，看到了，你手里那杯是什么味的？' as string | null, judge: '{"senses":["camera"]}',
  };
  const events: string[] = [];
  const captures: string[] = [];
  const asks: { prompt: string; system: string; images: readonly string[] }[] = [];
  const lines: string[] = [];
  const published: SenseLineMessage[] = [];
  const archived: SenseLineMessage[] = [];
  const logs: SenseRouterLogEntry[] = [];
  const ports: SenseRouterPorts = {
    enabled: () => state.routerOn,
    on: () => state.on, identity: () => state.identity, conversation: () => state.conversation,
    capture: async sense => { captures.push(sense); events.push(`capture:${sense}`); return FRAME; },
    heard: () => HEARD,
    ask: async (prompt, system, images) => {
      asks.push({ prompt, system, images }); events.push(images.length ? 'look' : 'ask');
      if (system.includes('感知判定员')) return state.judge;
      return state.summary ?? '看不清';
    },
    line: async prompt => { lines.push(prompt); events.push('line'); return state.line === null ? 'oops' : JSON.stringify({ text: state.line }); },
    character: () => ({ id: state.character, persona: '温和，爱看书', language: '' }), mood: () => '心情：平静',
    free: () => state.free,
    publish: message => { published.push(message); events.push('publish'); return true; },
    speechStyle: () => {},
    archive: async message => { archived.push(message); events.push('archive'); },
    log: entry => { logs.push(entry); },
    clock: () => clock.now, timers: clock.api, createId: (() => { let n = 0; return () => `t${++n}`; })(),
  };
  const router = new SenseRouterHost(ports);
  const judge = new FakeReactionJudge(options.senses === undefined ? answerWith(['camera']) : typeof options.senses === 'string' ? options.senses : answerWith(options.senses));
  const store = { enabled: options.reactionsOn ?? true, calls: 0, chats: 0,
    today: () => store.calls, noteCall: () => ++store.calls, chatsToday: () => store.chats, noteChat: () => ++store.chats };
  const now = (): ReactionNowSource => ({ characterId: state.character, dispositions: SIX, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: '温和，爱看书' });
  const performer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const reactions = new ReactionHost({ ask: judge.ask, store, now, performers: { blush: performer, shy: performer, happy: performer, action: performer },
    quiet: () => state.quiet, lift: () => {}, clock: () => clock.now, timers: clock.api, random: () => 0.5, localDate: () => 'day', warm: () => true, senses: router.port,
    knobs: { warmParallel: true } } as ReactionHostOptions);
  /** main.ts order: the reaction host takes the message, then the router (merged when that call will be made). */
  const send = (id: string, text: string, frames: { source: 'camera' | 'screen'; dataUrl: string }[] = []) => {
    reactions.userTurn(id, text);
    router.userTurn(id, text, { merged: reactions.asking(id), covered: coveredByFrames(frames) });
    return router.firstLineHint(id);
  };
  const shown = (id: string) => router.done(true, { id, shown: true });
  return { state, router, reactions, judge, events, captures, asks, lines, published, archived, logs, send, shown };
}

// ---------------------------------------------------------------- pure parts

test('the senses field: known ids once each; anything else is "nothing needed"', () => {
  assert.deepEqual(parseSenseField(['camera', 'transcript']), ['camera', 'transcript']);
  assert.deepEqual(parseSenseField([]), []);
  assert.equal(parseSenseField(['camera', 'camera']), null);
  assert.equal(parseSenseField(['microphone']), null);
  assert.equal(parseSenseField('camera'), null);
  assert.equal(parseSenseField(['camera', 'screen', 'transcript', 'camera']), null);
  assert.deepEqual(parseSenseJudge('```json\n{"senses":["screen"]}\n```'), ['screen']);
  assert.equal(parseSenseJudge('{"senses":["screen"],"why":"x"}'), null);
  assert.equal(parseSenseSummary('看不清'), null);
  assert.equal(parseSenseSummary('  “他在笑”  '), '他在笑');
  assert.equal(parseSenseLine('</thinking> {"text":"诶，看到了"}'), '诶，看到了');
  assert.equal(parseSenseLine('{"text":""}'), 'quiet');
  assert.equal(parseSenseLine('{"text":"作为AI我看不到"}'), null);
});

test('the reaction answer: senses read only when asked; a bad senses field never loses the reaction', () => {
  const asked = parseReactionAnswer(answerWith(['camera']), [], undefined, { senses: true });
  assert.deepEqual(asked?.senses, ['camera']);
  assert.equal(asked?.event, 'praise');
  const bad = parseReactionAnswer(answerWith(['nose']), [], undefined, { senses: true });
  assert.equal(bad?.event, 'praise');
  assert.equal(bad?.senses, null);
  const missing = parseReactionAnswer(JSON.stringify(REACTION), [], undefined, { senses: true });
  assert.equal(missing?.senses, null);
  // Not asked: the old strict shape, an unasked senses field is ignored, never read.
  const plain = parseReactionAnswer(JSON.stringify(REACTION), []);
  assert.equal(plain?.senses, undefined);
  assert.equal(parseReactionAnswer(answerWith(['camera']), [])?.senses, undefined);
  assert.match(reactionSystemPrompt(), /【感知】/u);
});

test('the pet window reads only a sense line of the exact shape; a feed reader never takes one', () => {
  const origin = senseLineOrigin('sense-a1', 5, [{ sense: 'camera', kind: 'seen', facts: FACTS }, { sense: 'transcript', kind: 'off' }]);
  assert.deepEqual(origin.sources, ['camera', 'ambient']);
  assert.deepEqual(origin.labels, ['刚看了一眼摄像头', '一起听没开']);
  const message = { id: 'sense-a1', text: '诶，看到了', origin };
  assert.deepEqual(readSenseLineMessage(message), message);
  assert.equal(readFeedLineMessage(message), null);
  assert.equal(readSenseLineMessage({ ...message, id: 'feed-a1', origin: { ...origin, id: 'feed-a1' } }), null);
  assert.equal(readSenseLineMessage({ ...message, origin: { ...origin, labels: ['随便写的'] } }), null);
  assert.equal(readSenseLineMessage({ ...message, text: '<b>x</b>' }), null);
  assert.equal(readSenseLineMessage({ ...message, extra: 1 }), null);
});

// ---------------------------------------------------------------- her first character

test('first character: no extra call, the block rides on the one reaction call, and the router off leaves that prompt byte-for-byte', async () => {
  const clock = new Clock();
  assert.equal(world(new Clock()).send('m0', '我这件衣服怎么样'), '', 'by default her first line gets no hint (the A/B: the hint slowed her first character)');
  const on = world(clock);
  (on.router as unknown as { knobs: { firstLineHint: boolean } }).knobs.firstLineHint = true;
  const hint = on.send('m1', '我这件衣服怎么样');
  assert.equal(hint, SENSE_FIRST_LINE_HINT, 'with the hint knob on and a sense on: her first line gets the one local sentence');
  assert.equal(on.asks.length + on.judge.calls + on.captures.length, 0, 'nothing is asked or captured at the moment of the message');
  await clock.advance(5_000);
  assert.equal(on.judge.calls, 1, 'one haiku call for the message, as before');
  assert.match(on.judge.prompts[0], /【感知】/u);
  assert.ok(on.judge.prompts[0].trimEnd().endsWith('只输出 JSON。'), 'the block goes before the last line');
  assert.equal(on.asks.filter(a => a.system.includes('感知判定员')).length, 0, 'no own judgment when the reaction call carried it');

  const clock2 = new Clock();
  const offWorld = world(clock2, { routerOn: false });
  assert.equal(offWorld.send('m1', '我这件衣服怎么样'), '');
  await clock2.advance(5_000);
  // The same message with the router off: the old prompt (no 【感知】, nothing else changed).
  assert.doesNotMatch(offWorld.judge.prompts[0], /【感知】/u);
  assert.equal(offWorld.judge.prompts[0], on.judge.prompts[0].replace(`\n${senseBlock(on.state.on)}`, ''));
  assert.equal(offWorld.captures.length + offWorld.asks.length, 0);
});

// ---------------------------------------------------------------- the look and the join

test('needed and on: one sample, haiku looks at it, her line only after her first reply ended and she is free; archived once', async () => {
  const clock = new Clock();
  const w = world(clock);
  w.send('m1', '我这件衣服怎么样');
  await clock.advance(5_000);
  assert.deepEqual(w.captures, ['camera']);
  const look = w.asks.find(a => a.images.length);
  assert.ok(look, 'haiku looked');
  assert.deepEqual(look!.images, [FRAME]);
  assert.match(look!.prompt, /我这件衣服怎么样/u);
  assert.equal(w.lines.length, 0, 'never during her reply');
  assert.equal(w.published.length, 0);
  w.state.free = false;
  w.router.replyDone('m1', true, '嗯？让我看看～');
  await clock.advance(1_000);
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], /他举着一杯奶茶/u);
  assert.match(w.lines[0], /让我看看/u, 'her first reply goes into the prompt');
  assert.equal(w.published.length, 0, 'not while she is still busy (her reply being read)');
  w.state.free = true;
  await clock.advance(500);
  assert.equal(w.published.length, 1);
  const message = w.published[0];
  assert.equal(message.text, '诶，看到了，你手里那杯是什么味的？');
  assert.deepEqual(message.origin.sources, ['camera']);
  assert.equal(w.archived.length, 0, 'archived only once shown');
  assert.equal(w.shown(message.id), true);
  await clock.advance(10);
  assert.equal(w.archived.length, 1);
  assert.equal(w.shown(message.id), false, 'a second report changes nothing');
  await clock.advance(60_000);
  assert.equal(w.archived.length, 1);
  assert.deepEqual(w.events.filter(e => ['line', 'publish', 'archive'].includes(e)), ['line', 'publish', 'archive']);
  assert.ok(w.events.indexOf('capture:camera') < w.events.indexOf('line'));
  assert.equal(w.logs.at(-1)?.outcome, 'said');
});

test('a newer message before the join drops it; so does a stopped reply, another conversation or the switch going off', async () => {
  for (const spoil of ['message', 'stopped', 'conversation', 'switch', 'character'] as const) {
    const clock = new Clock();
    const w = world(clock);
    w.send('m1', '我这件衣服怎么样');
    await clock.advance(5_000);
    if (spoil === 'message') w.send('m2', '算了不说这个');
    if (spoil === 'conversation') w.state.conversation = 'conv-2';
    if (spoil === 'switch') w.state.routerOn = false;
    if (spoil === 'character') w.state.character = 'other';
    w.router.replyDone('m1', spoil !== 'stopped', '嗯？');
    await clock.advance(60_000);
    assert.equal(w.published.length, 0, `${spoil}: nothing shown`);
    assert.equal(w.archived.length, 0, `${spoil}: nothing archived`);
  }
});

test('a late line is dropped while it waits: a newer message during the chat model call, and the deadline', async () => {
  const clock = new Clock();
  const w = world(clock);
  let release!: (text: string) => void;
  let lineSignal: AbortSignal | null = null;
  (w.router as unknown as { ports: SenseRouterPorts }).ports.line = (_prompt, signal) => { lineSignal = signal; return new Promise<string>(resolve => { release = resolve; }); };
  w.send('m1', '我这件衣服怎么样');
  await clock.advance(5_000);
  w.router.replyDone('m1', true, '嗯？');
  await clock.advance(100);
  w.send('m2', '你在干嘛');
  assert.equal(lineSignal!.aborted, true, 'the newer message stops the call at once');
  release(JSON.stringify({ text: '诶，看到了' }));
  await clock.advance(60_000);
  assert.equal(w.published.length, 0);

  const clock2 = new Clock();
  const w2 = world(clock2);
  w2.state.free = false;
  w2.send('m1', '我这件衣服怎么样');
  await clock2.advance(5_000);
  w2.router.replyDone('m1', true, '嗯？');
  await clock2.advance(120_000);
  assert.equal(w2.published.length, 0, 'she never got free in time: dropped, never late');
});

test('a "别看" in the message: no frame, and no "it is off" either; turned off meanwhile: no frame', async () => {
  const clock = new Clock();
  const w = world(clock, { senses: ['camera', 'screen'] });
  w.state.on = { camera: true, screen: true, transcript: false };
  assert.equal(w.send('m1', '别看我，我今天好丑'), '', 'nothing on that she may use: no hint');
  await clock.advance(5_000);
  w.router.replyDone('m1', true, '才不丑');
  await clock.advance(60_000);
  assert.deepEqual(w.captures, []);
  assert.equal(w.lines.length, 0);

  const clock2 = new Clock();
  const w2 = world(clock2);
  w2.send('m1', '我这件衣服怎么样');
  w2.state.on = { camera: false, screen: false, transcript: false }; // the user turned 「发图片」 off before haiku answered
  await clock2.advance(5_000);
  w2.router.replyDone('m1', true, '嗯？');
  await clock2.advance(60_000);
  assert.deepEqual(w2.captures, []);
  assert.equal(w2.asks.filter(a => a.images.length).length, 0);
});

test('a clear frame she was asked to take covers the camera: no second look', async () => {
  const clock = new Clock();
  const w = world(clock);
  assert.equal(w.send('m1', '你看看我', [{ source: 'camera', dataUrl: FRAME }]), '');
  await clock.advance(5_000);
  w.router.replyDone('m1', true, '看到啦');
  await clock.advance(60_000);
  assert.deepEqual(w.captures, []);
  assert.equal(w.lines.length, 0);
});

test('needed but off: "it is off" once per conversation, nothing captured, nothing turned on', async () => {
  const clock = new Clock();
  const w = world(clock, { on: { camera: false } });
  const before = JSON.stringify(w.state.on);
  w.send('m1', '你看我今天气色怎么样');
  await clock.advance(5_000);
  w.router.replyDone('m1', true, '嗯……');
  await clock.advance(1_000);
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], /摄像头没开/u);
  assert.equal(w.published[0]?.origin.labels[0], '摄像头没开');
  w.shown(w.published[0].id);
  await clock.advance(1_000);
  w.send('m2', '那你现在看看我嘛');
  await clock.advance(5_000);
  w.router.replyDone('m2', true, '嗯……');
  await clock.advance(60_000);
  assert.equal(w.lines.length, 1, 'not again in the same conversation');
  w.state.conversation = 'conv-2';
  w.send('m3', '你看我今天气色怎么样');
  await clock.advance(5_000);
  w.router.replyDone('m3', true, '嗯……');
  await clock.advance(1_000);
  assert.equal(w.lines.length, 2, 'a new conversation may say it once again');
  assert.deepEqual(w.captures, []);
  assert.equal(JSON.stringify(w.state.on), before);
});

test('the reaction call is not made (switch off): the own judgment starts only after her first character, only while a sense is on', async () => {
  const clock = new Clock();
  const w = world(clock, { reactionsOn: false, on: { camera: false, transcript: true } });
  w.state.judge = '{"senses":["transcript"]}';
  w.send('m1', '刚才那个嘉宾是谁');
  await clock.advance(10_000);
  assert.equal(w.asks.length, 0, 'nothing before her first character');
  w.router.firstChar('m1');
  await clock.advance(100);
  assert.equal(w.asks.filter(a => a.system.includes('感知判定员')).length, 1);
  const read = w.asks.find(a => a.prompt.includes('<heard>'));
  assert.ok(read, 'haiku read the heard words');
  assert.match(read!.prompt, /天文学家/u);
  assert.equal(read!.images.length, 0);
  w.router.replyDone('m1', true, '好像是个科学家？');
  await clock.advance(1_000);
  assert.equal(w.published[0]?.origin.sources[0], 'ambient');

  const clock2 = new Clock();
  const none = world(clock2, { reactionsOn: false, on: { camera: false } });
  none.send('m1', '你看我今天气色怎么样');
  none.router.firstChar('m1');
  await clock2.advance(30_000);
  assert.equal(none.asks.length, 0, 'nothing on and no free ride: no call at all');
});

test('the reaction call was meant to carry it but was not made (she was hidden meanwhile): the own judgment still waits for her first character', async () => {
  const clock = new Clock();
  const w = world(clock);
  w.send('m1', '我这件衣服怎么样');
  w.state.quiet = 'hidden';
  await clock.advance(10_000);
  assert.equal(w.judge.calls, 0, 'the reaction call was not made');
  assert.equal(w.asks.length, 0, 'and nothing else before her first character');
  w.router.firstChar('m1');
  await clock.advance(100);
  assert.equal(w.asks.filter(a => a.system.includes('感知判定员')).length, 1);
  assert.deepEqual(w.captures, ['camera']);
});

test('defaults: on without the first-line hint (the no-hint A/B was under the line); off, the app wiring asks nothing and the reaction prompt stays the old one', async () => {
  assert.equal(SENSE_ROUTER_KNOBS.enabled, true);
  assert.equal(SENSE_ROUTER_KNOBS.firstLineHint, false);
  const clock = new Clock();
  const asked: string[] = [];
  const router = createSenseRouter({ enabled: () => false, on: () => ({ camera: true, screen: true, transcript: true }), identity: () => 's', conversation: () => 'c',
    capture: async () => FRAME, heard: () => HEARD, character: () => ({ id: 'heroine', persona: 'p', language: '' }), mood: () => '', chatModel: () => '',
    free: () => true, petSender: () => 7, send: () => true, speechStyle: () => {}, archive: async () => {}, log: () => {},
    ports: { clock: () => clock.now, timers: clock.api, ask: async prompt => { asked.push(prompt); return '{"senses":["camera"]}'; } } });
  router.userTurn('m1', '我这件衣服怎么样', false, []);
  assert.equal(router.hint('m1', false), '');
  router.firstChar('m1');
  assert.equal(router.host.port.block('m1'), null);
  await clock.advance(30_000);
  assert.deepEqual(asked, []);
});

test('the hint has its own knob: off, no sentence in her first line, the look and her second line still come', async () => {
  const clock = new Clock();
  const w = world(clock);
  (w.router as unknown as { knobs: { firstLineHint: boolean } }).knobs.firstLineHint = false;
  assert.equal(w.send('m1', '我这件衣服怎么样'), '');
  await clock.advance(5_000);
  w.router.replyDone('m1', true, '嗯？');
  await clock.advance(1_000);
  assert.equal(w.published.length, 1);
});

test('the 一起听 block already in her first reply covers the transcript', async () => {
  const clock = new Clock();
  const w = world(clock, { senses: ['transcript'], on: { camera: false, transcript: true } });
  w.reactions.userTurn('m1', '刚才那首歌叫什么');
  w.router.userTurn('m1', '刚才那首歌叫什么', { merged: w.reactions.asking('m1') });
  assert.equal(w.router.firstLineHint('m1', ['transcript']), '');
  await clock.advance(5_000);
  w.router.replyDone('m1', true, '是《晴天》呀');
  await clock.advance(60_000);
  assert.equal(w.asks.length, 0);
  assert.equal(w.lines.length, 0);
});

// ---------------------------------------------------------------- privacy

test('frames, heard words and facts never reach the log, the journal or the profile folder', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sense-router-'));
  try {
    const clock = new Clock();
    const view = { characterId: 'heroine', snapshot: { primary: 'calm', values: { D: 50, O: 50, E: 50, N: 50, C: 50 } }, fatigue: { phase: 'awake' },
      expressions: true, parameters: DEFAULT_MOOD_PARAMETERS } as unknown as MoodView;
    const mood: ReactionMoodPort = { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: () => {} };
    const logs: unknown[] = [];
    const journal: unknown[] = [];
    const lines: string[] = [];
    let senseHost!: SenseRouterHost;
    const router = createSenseRouter({ enabled: () => true,
      on: () => ({ camera: true, screen: true, transcript: true }), identity: () => 's', conversation: () => 'c',
      capture: async () => FRAME, heard: () => HEARD, character: () => ({ id: 'heroine', persona: 'p', language: '' }), mood: () => '',
      chatModel: () => '', free: () => true, petSender: () => 7, send: () => true, speechStyle: () => {}, archive: async () => {},
      log: entry => { logs.push(entry); },
      ports: { clock: () => clock.now, timers: clock.api, createId: () => 'x1',
        ask: async (_p, system) => system.includes('感知判定员') ? '{"senses":["camera","screen","transcript"]}' : FACTS,
        line: async prompt => { lines.push(prompt); return JSON.stringify({ text: '诶，看到了' }); } },
    });
    senseHost = router.host;
    const reactions = createReactions({ directory: () => directory, defaultEnabled: true, mood: () => mood, persona: () => 'p', petVisible: () => true,
      available: () => true, actions: () => null, stage: () => true, journal: entry => { journal.push(entry); }, senses: senseHost.port,
      ask: async () => answerWith(['camera', 'screen', 'transcript']), warm: null, performers: {},
      host: { clock: () => clock.now, timers: clock.api, localDate: () => 'day', random: () => 0.5 } });
    await reactions.load();
    reactions.userTurn('m1', '你看我屏幕上这个，还有刚才说的');
    router.userTurn('m1', '你看我屏幕上这个，还有刚才说的', reactions.host.asking('m1'), []);
    reactions.firstChar('m1'); router.firstChar('m1');
    await clock.advance(10_000);
    router.replyDone('m1', true, '我看看');
    await clock.advance(5_000);
    senseHost.done(true, { id: 'sense-x1', shown: true });
    await clock.advance(1_000);
    await reactions.dispose();
    assert.equal(lines.length, 1, 'the flow ran to her line');
    const secrets = ['RkFLRS1GUkFNRS1NQVJLRVI', FACTS, HEARD, '天文学家', '奶茶'];
    const written: string[] = [];
    const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else written.push(await readFile(full, 'utf8'));
    } };
    await walk(directory);
    for (const secret of secrets) {
      assert.ok(!written.some(text => text.includes(secret)), `not on disk: ${secret}`);
      assert.ok(!JSON.stringify(logs).includes(secret), `not in the log: ${secret}`);
      assert.ok(!JSON.stringify(journal).includes(secret), `not in the journal: ${secret}`);
    }
    assert.ok(logs.length >= 1);
    assert.deepEqual(Object.keys(logs.at(-1) as object).sort(), ['factsMs', 'judge', 'judgedMs', 'needed', 'off', 'outcome', 'seen', 'shownMs']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the pet window

test('the pet window shows the sense line through the ordinary presenter and reports it', async () => {
  const reports: { id: string; shown: boolean }[] = [];
  const shownTexts: string[] = [];
  const remembered: string[] = [];
  let listener: ((message: SenseLineMessage) => void) | null = null;
  const presenter = new FeedLinePresenter({ onFeedLine: callback => { listener = callback; return () => {}; }, feedLineDone: async input => { reports.push(input); return true; } },
    { read: readSenseLineMessage, remember: message => { remembered.push(message.id); },
      say: { free: () => true, voiceOn: () => false, show: (_id: string, text: string) => { shownTexts.push(text); }, speak: async () => {}, ended: () => {} } as never });
  const origin = senseLineOrigin('sense-p1', 1, [{ sense: 'screen', kind: 'seen', facts: 'x' }]);
  assert.ok(listener);
  assert.equal(await presenter.present({ id: 'sense-p1', text: '你在写代码呀', origin }), true);
  assert.equal(await presenter.present({ id: 'feed-p2', text: '好吃', origin: { kind: 'proactive', id: 'feed-p2', at: 1, sources: ['feed'], labels: ['喂食：糖'] } }), false);
  assert.deepEqual(shownTexts, ['你在写代码呀']);
  assert.deepEqual(remembered, ['sense-p1']);
  assert.deepEqual(reports, [{ id: 'sense-p1', shown: true }]);
});
