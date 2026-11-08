/**
 * I-037 新的反应方式 (shared/behaviors/reactions/, electron/reactions/) with a fake haiku on a fake clock. Never a real model call.
 * The character here is invented (its six 反应倾向 are made up for the test; no real character's numbers appear anywhere), and
 * so is every sentence.
 *
 * What it pins: scores are sums (no products) and the parts add up; hard gates keep a reaction out of the candidates; the stored
 * dispositions round-trip and undo; haiku is asked at most once per message, only after her first character, and a newer
 * message aborts the older call; with the switch on the 心情调整员 leaves messages alone (one haiku per message in all); haiku may
 * only pick candidates of the class it named; a failed / late / unsure haiku falls back to her warm tail's top "暖心的话"
 * reaction; the mood blends haiku 0.7 / tail 0.3; four praises in a row on the fallback path give the hand-computed blush, shy,
 * blush, nothing; a pat, a pinch and a snack react once per contact without haiku; the switch off means no call and no port;
 * adding ONE row (a fake reaction) runs end to end: haiku's prompt lists it, haiku picks it, it plays, and the journal keeps it.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReactionHost, type ReactionHostOptions, type ReactionJournalInput, type ReactionNowSource, type ReactionQuiet } from '../electron/reactions/host';
import { ReactionStore } from '../electron/reactions/store';
import { createReactions, type ReactionMoodPort } from '../electron/reactions/wiring';
import { createReactionPerformers } from '../electron/reactions/performers';
import { MoodJudgeHost } from '../electron/mood-judge/host';
import { MoodHost } from '../electron/mood';
import { FakeReactionJudge, pickFirstOf } from '../shared/behaviors/reactions/fake';
import { DISPOSITION_IDS, deriveDispositions, dispositionSummary, validateDispositions, type Dispositions } from '../shared/behaviors/reactions/dispositions';
import { REACTION_EVENTS, WORD_EVENT_IDS } from '../shared/behaviors/reactions/events';
import { REACTION_KNOBS, REACTION_TABLE, type ReactionRow } from '../shared/behaviors/reactions/knobs';
import { MoodBlend, parseReactionAnswer, reactionPrompt, reactionSystemPrompt, scoreReactions, topPick } from '../shared/behaviors/reactions/choose';
import type { ReactionBlock, ReactionPerformer, ReactionScoring } from '../shared/behaviors/reactions/interface';
import { readReactionStageCue } from '../shared/behaviors/reactions/stage';
import { playReactionCue } from '../src/stage/reaction-performers';
import { DEFAULT_MOOD_PARAMETERS, type MoodLabel, type MoodValues } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { buildJournalEntry, describeJournalEntry } from '../shared/journal';
import { ENGLISH_JOURNAL_UI_COPY as JOURNAL_EN } from '../shared/ui-copy.journal.en';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { createAppTools } from '../electron/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { capability } from '../shared/capabilities';
import { agentSetting } from '../shared/agent-channel';

const SECOND = 1_000;
/** An invented character's six (not any real character's): 害羞 70、黏人 60、活泼 40、好哄 50、情绪起伏 65、克制 55. */
const HEROINE: Dispositions = Object.freeze({ shy: 70, clingy: 60, lively: 40, soothable: 50, volatile: 65, restrained: 55 });
const HEROINE_ID = 'test-heroine';

class Clock {
  now = Date.UTC(2026, 10, 6, 12, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
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
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const values = (partial: Partial<MoodValues> = {}, fill = 50): MoodValues => ({ D: fill, O: fill, E: fill, N: fill, C: fill, ...partial });

/** Fake performers that record what played; `busyFor` makes stage ones busy for a while. */
function fakePerformers(clock: Clock) {
  const played: { id: string; level: string; at: number; event: string }[] = [];
  const state = { blushUntil: 0, busyUntil: 0, blocked: null as ReactionBlock | null };
  const make = (stage: boolean, durationMs = 0, extra?: (id: string) => ReactionBlock | null): ReactionPerformer => ({
    stage, durationMs,
    gate: () => state.blocked,
    perform: (_row, level, context) => {
      if (stage && clock.now < state.busyUntil) return { done: false, why: 'busy' };
      const blocked = extra?.(context.id) ?? null;
      if (blocked) return { done: false, why: blocked };
      played.push({ id: context.id, level, at: clock.now, event: context.event });
      return { done: true };
    },
  });
  const blush = make(false, 0, () => clock.now < state.blushUntil ? 'showing' : null);
  const performers: Record<string, ReactionPerformer> = {
    blush: { ...blush, gate: () => state.blocked ?? (clock.now < state.blushUntil ? 'showing' : null),
      perform: (row, level, context) => { const r = blush.perform(row, level, context) as { done: boolean }; if (r.done) state.blushUntil = clock.now + 3_450; return r as never; } },
    shy: make(true, 3_000), happy: make(false), action: make(true, 1_600),
  };
  return { performers, played, state };
}

function world(clock: Clock, ask: FakeReactionJudge, options: Partial<ReactionHostOptions> & { enabled?: boolean; mood?: MoodLabel } = {}) {
  const store = { enabled: options.enabled ?? true, calls: 0, chats: 0,
    today: () => store.calls, noteCall: () => ++store.calls, chatsToday: () => store.chats, noteChat: () => ++store.chats };
  const state = { quiet: null as ReactionQuiet | null, character: HEROINE_ID, mood: options.mood ?? 'calm' as MoodLabel, dispositions: HEROINE };
  const now = (): ReactionNowSource => ({ characterId: state.character, dispositions: state.dispositions, mood: state.mood, moodWords: '平静', fatigue: '', sleepy: false,
    values: values(), persona: '温和，爱看书' });
  const lifts: { id: string; delta: Partial<MoodValues> }[] = [];
  const journal: ReactionJournalInput[] = [];
  const fake = fakePerformers(clock);
  const host = new ReactionHost({ ask: ask.ask, store, now, quiet: () => state.quiet, performers: fake.performers,
    lift: lift => { lifts.push({ id: lift.id, delta: lift.delta }); }, journal: entry => { journal.push(entry); },
    clock: () => clock.now, timers: clock.api, random: () => 0.5, localDate: () => 'day', id: (() => { let n = 0; return () => `k${++n}`; })(), ...options });
  return { host, store, state, lifts, journal, performers: fake.performers, played: fake.played, perf: fake.state };
}
/** Her reply's tail for message `id` (what MoodHost tells the port after the appraisal was applied). */
const tail = (host: ReactionHost, id: string, context = 'positive', delta: Partial<MoodValues> = { O: 10 }) => {
  const share = host.port.appraisal(HEROINE_ID, id, delta, context);
  host.port.observe({ characterId: HEROINE_ID, type: 'appraisal', id: `appraisal-${id}`, session: null, pinch: false, oBefore: 0, oAfter: 0, threshold: 6, responseTo: id, context });
  return share;
};
const nowFor = (d: Dispositions, at: number, recent: { id: string; at: number }[] = [], mood: MoodLabel = 'calm') =>
  ({ characterId: HEROINE_ID, dispositions: d, mood, sleepy: false, at, recent });

// ---------------------------------------------------------------- pure parts

test('scores are sums of their parts (no products), hard gates keep a reaction out, the floor and the count hold', () => {
  const s = scoreReactions('praise', nowFor(HEROINE, 0), { random: () => 0.5 });
  for (const item of [...s.candidates, ...s.blocked]) {
    const p = item.parts;
    assert.equal(item.score, Math.round((p.base + p.lean + p.mood + p.sleepy + p.recent + p.offset + p.jitter) * 10) / 10, item.id);
  }
  // By hand: blush 58 + 0.8·20 + 0.2·15 − 0.3·5 = 75.5; shy 52 + 0.9·20 − 0.25·5 − 0.1·(−10) = 69.75; happy 45 + 0 + 6 − 1.5 − 2 = 47.5.
  assert.deepEqual(s.candidates.map(item => [item.id, item.score]), [['blush', 75.5], ['shy', 69.8], ['happy', 47.5]]);
  const gated = scoreReactions('praise', nowFor(HEROINE, 0), { random: () => 0.5, gate: id => id === 'blush' ? 'showing' : null });
  assert.deepEqual(gated.candidates.map(item => item.id), ['shy', 'happy']);
  assert.deepEqual(gated.blocked.map(item => [item.id, item.blocked]), [['blush', 'showing']]);
  // "整体更敏感" is one added number: +10 to every row.
  const offset = scoreReactions('praise', nowFor(HEROINE, 0), { random: () => 0.5, knobs: { ...REACTION_KNOBS, offset: 10 } });
  assert.equal(offset.candidates[0].score, 85.5);
  // A recent one is penalised by a half-life, not blocked.
  const recent = scoreReactions('praise', nowFor(HEROINE, 60_000, [{ id: 'blush', at: 0 }]), { random: () => 0.5 });
  assert.equal(recent.candidates.find(item => item.id === 'blush')!.score, 61.5);
  assert.equal(topPick(recent)!.id, 'shy');
  assert.deepEqual(topPick(scoreReactions('warm', nowFor(HEROINE, 0), { random: () => 0.5 })), { id: 'blush', level: 'mid' });
});

test('dispositions: a default card derives all 50; validation is strict; the store round-trips, keeps per character and undoes', async (t: TestContext) => {
  assert.deepEqual(deriveDispositions(DEFAULT_MOOD_PARAMETERS), { shy: 50, clingy: 50, lively: 50, soothable: 50, volatile: 50, restrained: 50 });
  assert.deepEqual(deriveDispositions(null), deriveDispositions(DEFAULT_MOOD_PARAMETERS));
  assert.equal(dispositionSummary(HEROINE), '害羞 70、黏人 60、活泼 40、好哄 50、情绪起伏 65、克制 55');
  assert.throws(() => validateDispositions({ ...HEROINE, brave: 50 }), /没有「brave」/);
  assert.throws(() => validateDispositions({ ...HEROINE, shy: 101 }), /0 到 100/);
  assert.throws(() => validateDispositions({ shy: 60 }), /少了/);
  assert.deepEqual(validateDispositions({ shy: 60 }, { partial: true }), { shy: 60 });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i037-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReactionStore({ directory: () => directory, defaultEnabled: true });
  await store.load();
  assert.equal(store.enabled, true, 'development default');
  assert.equal(store.dispositions(HEROINE_ID), null);
  const first = store.setDispositions(HEROINE_ID, HEROINE, deriveDispositions(null));
  assert.equal(first.before, null);
  const second = store.setDispositions(HEROINE_ID, { shy: 20 }, HEROINE);
  assert.deepEqual(second.after, { ...HEROINE, shy: 20 });
  assert.deepEqual(second.before, HEROINE);
  await store.flush();
  const again = new ReactionStore({ directory: () => directory, defaultEnabled: false });
  await again.load();
  assert.equal(again.enabled, false, 'stable default, never chosen');
  assert.deepEqual(again.dispositions(HEROINE_ID), { ...HEROINE, shy: 20 });
  again.restore(HEROINE_ID, second.before);
  assert.deepEqual(again.dispositions(HEROINE_ID), HEROINE);
  again.restore(HEROINE_ID, null);
  assert.equal(again.dispositions(HEROINE_ID), null, 'undo to "the card gives it"');
  again.setEnabled(true);
  await again.flush();
  assert.equal(JSON.parse(await readFile(path.join(directory, 'reactions.json'), 'utf8')).enabled, true);
  // A broken dispositions file is left alone and nothing is written over it.
  await writeFile(path.join(directory, 'reaction-dispositions.json'), '{broken');
  const broken = new ReactionStore({ directory: () => directory, defaultEnabled: true });
  await broken.load();
  assert.throws(() => broken.setDispositions(HEROINE_ID, { shy: 1 }, HEROINE), /读不出来/);
  assert.equal(await readFile(path.join(directory, 'reaction-dispositions.json'), 'utf8'), '{broken');
});

test('haiku may only pick candidates of the class it named; anything off the contract is the whole answer refused', () => {
  const scorings = WORD_EVENT_IDS.map(event => scoreReactions(event, nowFor(HEROINE, 0), { random: () => 0.5 }));
  const ok = (body: object) => JSON.stringify({ event: 'praise', reactions: [{ id: 'shy', level: 'mid' }], delta: { O: 3 }, confidence: 0.8, ...body });
  assert.deepEqual(parseReactionAnswer(ok({}), scorings), { event: 'praise', picks: [{ id: 'shy', level: 'mid' }], delta: { O: 3 }, confidence: 0.8 });
  assert.equal(parseReactionAnswer(ok({ reactions: [{ id: 'clap', level: 'mid' }] }), scorings), null, 'clap is no praise candidate here');
  assert.equal(parseReactionAnswer(ok({ reactions: [{ id: 'rm-rf', level: 'mid' }] }), scorings), null);
  assert.equal(parseReactionAnswer(ok({ event: 'warm' }), scorings), null, 'the fallback class is not haiku\'s');
  assert.equal(parseReactionAnswer(ok({ delta: { O: 7 } }), scorings), null, 'beyond ±maxDelta');
  assert.equal(parseReactionAnswer(ok({ extra: 1 }), scorings), null);
  assert.equal(parseReactionAnswer(ok({ reactions: [{ id: 'shy', level: 'huge' }] }), scorings), null);
  assert.equal(parseReactionAnswer(ok({ reactions: [{ id: 'shy', level: 'mid' }, { id: 'blush', level: 'mid' }, { id: 'happy', level: 'mid' }] }), scorings), null, 'at most 2');
  assert.deepEqual(parseReactionAnswer(ok({ event: 'none', reactions: [] }), scorings)?.picks, []);
  assert.equal(parseReactionAnswer('```json\n' + ok({}) + '\n```', scorings)?.picks.length, 1);
});

test('the mood blends haiku 0.7 / her tail 0.3 in either order; only one side gives: all of it; each side counts once', () => {
  const a = new MoodBlend();
  a.open('m1', true);
  assert.deepEqual(a.haiku('m1', { O: 4 }), { O: 2.8 });
  assert.deepEqual(a.opus('m1', { O: 10 }), { O: 3 });
  assert.deepEqual(a.opus('m1', { O: 10 }), {}, 'once');
  const b = new MoodBlend();
  b.open('m2', true);
  assert.deepEqual(b.opus('m2', { O: 10 }), { O: 3 });
  assert.deepEqual(b.haiku('m2', null), { O: 7 }, 'haiku gave nothing: the rest of her tail');
  const c = new MoodBlend();
  c.open('m3', false);
  assert.deepEqual(c.opus('m3', { O: 10, E: 2 }), { O: 10, E: 2 }, 'not asked: the whole tail');
  assert.deepEqual(new MoodBlend().opus('unknown', { O: 5 }), { O: 5 }, 'a message from before the switch');
});

test('the haiku prompts are generated from the tables: one more row is listed with no other change', () => {
  const table = { ...REACTION_TABLE, sparkle: { label: '闪闪眼', describe: '测试用的假反应', performer: 'action', arg: 'wink', events: { praise: 99 }, recent: { penalty: 0, halfLifeMs: 1 } } satisfies ReactionRow };
  const system = reactionSystemPrompt(table);
  assert.match(system, /sparkle（闪闪眼：测试用的假反应）/);
  for (const id of WORD_EVENT_IDS) assert.ok(system.includes(`${id}（${REACTION_EVENTS[id].label}`), id);
  assert.ok(!system.includes('warm（'), 'the fallback class is not offered to haiku');
  const scorings: ReactionScoring[] = [scoreReactions('praise', nowFor(HEROINE, 0), { table, random: () => 0.5 })];
  const prompt = reactionPrompt({ dispositions: HEROINE, persona: '温和', mood: 'calm', moodWords: '平静', fatigue: '', values: values(), scorings, text: '你今天好可爱' }, table);
  assert.match(prompt, /praise（被夸）：sparkle 闪闪眼 99、blush 脸红 76/);
  assert.match(prompt, /「你今天好可爱」/);
});

// ---------------------------------------------------------------- the host

test('one message, one haiku call at most, only after her first character (and knobs.startDelayMs); a newer message aborts the older call', async () => {
  const clock = new Clock(), ask = new FakeReactionJudge({ hang: true }), w = world(clock, ask);
  w.host.userTurn('m1', '你今天好可爱');
  await clock.advance(2 * SECOND);
  assert.equal(ask.calls, 0, 'her first character goes first');
  w.host.firstChar('other'); w.host.firstChar('m1');
  await clock.advance(1);
  assert.equal(ask.calls, 1, 'right after her first character');
  w.host.firstChar('m1');
  w.host.userTurn('m2', '真的很可爱');
  w.host.firstChar('m2');
  await clock.advance(REACTION_KNOBS.startDelayMs - 1);
  assert.equal(ask.calls, 1, 'never before knobs.startDelayMs, even with an early first character');
  await clock.advance(1);
  assert.equal(ask.calls, 2);
  // No first character at all (a spoken turn, say): knobs.firstCharWaitMs after the message.
  const clock3 = new Clock(), ask3 = new FakeReactionJudge({ hang: true }), w3 = world(clock3, ask3);
  w3.host.userTurn('v1', '你好可爱'); await clock3.advance(REACTION_KNOBS.firstCharWaitMs - 1);
  assert.equal(ask3.calls, 0); await clock3.advance(1); assert.equal(ask3.calls, 1);
  assert.equal(w.host.stats.superseded, 1);
  // The tail of m1 (superseded) brings nothing; m1 is never asked again.
  tail(w.host, 'm1');
  await clock.advance(20 * SECOND);
  assert.equal(ask.calls, 2);
  assert.equal(w.played.filter(item => item.event !== 'warm').length, 0);
  // Two messages before her first character: only the second is asked.
  const clock2 = new Clock(), ask2 = new FakeReactionJudge({ hang: true }), w2 = world(clock2, ask2);
  w2.host.userTurn('a', '一'); await clock2.advance(100); w2.host.userTurn('b', '二'); w2.host.firstChar('a'); await clock2.advance(2 * SECOND);
  assert.equal(ask2.calls, 0, 'the older message\'s first character starts nothing');
  w2.host.firstChar('b'); await clock2.advance(SECOND);
  assert.equal(ask2.calls, 1);
  assert.match(ask2.prompts[0], /「二」/);
});

test('with the switch on the 心情调整员 leaves messages alone: one haiku per message in all (and without the switch it would ask)', async () => {
  for (const skip of [true, false]) {
    const clock = new Clock(); let calls = 0;
    const judge = new MoodJudgeHost({ ask: async () => { calls++; return '{}'; }, store: { enabled: true, today: () => 0, noteCall: () => 1 },
      now: () => ({ characterId: HEROINE_ID, persona: '', personality: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, values: values(), baseline: values(), sensitivity: values({}, 1),
        label: '平静', fatigue: '清醒', doing: '', at: clock.now }), quiet: () => null, busy: () => false, apply: () => {}, developerMode: () => false,
      clock: () => clock.now, timers: clock.api, skipMessages: () => skip });
    judge.userText('m1', '你今天好可爱');
    judge.noteMood({ characterId: HEROINE_ID, type: 'chat', id: 'm1', context: 'positive', applied: values({}, 0) });
    judge.noteMood({ characterId: HEROINE_ID, type: 'appraisal', id: 'appraisal-m1', responseTo: 'm1', context: 'positive', applied: values({ O: 2 }, 0) });
    judge.noteMood({ characterId: HEROINE_ID, type: 'lift', id: 'reaction-mood-m1', reason: 'x', applied: values({ O: 2 }, 0) });
    await clock.advance(10 * 60 * SECOND);
    assert.equal(calls, skip ? 0 : 1, skip ? 'skipped while 新的反应方式 is on' : 'the control: the judge would ask');
    judge.dispose();
  }
});

test('haiku answers: its picks play (stage ones one after another), its mood share lifts once, the journal line holds ids and numbers', async () => {
  const clock = new Clock();
  const ask = new FakeReactionJudge(JSON.stringify({ event: 'praise', reactions: [{ id: 'shy', level: 'mid' }, { id: 'blush', level: 'strong' }], delta: { O: 4, D: 2 }, confidence: 0.9 }));
  const w = world(clock, ask);
  w.host.userTurn('m1', '你今天好可爱');
  await clock.advance(5 * SECOND);
  assert.deepEqual(w.played.map(item => [item.id, item.level]), [['blush', 'strong'], ['shy', 'mid']], 'blush at once, the stage one through the queue');
  assert.deepEqual(w.lifts, [{ id: 'reaction-mood-m1', delta: { O: 2.8, D: 1.4 } }]);
  assert.deepEqual(tail(w.host, 'm1', 'positive', { O: 10 }), { O: 3 }, 'her tail gives its 0.3');
  await clock.advance(SECOND);
  assert.equal(w.played.length, 2, 'her tail adds no second reaction once haiku answered');
  const entry = w.journal.at(-1)!;
  assert.equal(entry.decider, 'haiku');
  assert.deepEqual(entry.picks, [{ id: 'shy', level: 'mid', done: true }, { id: 'blush', level: 'strong', done: true }]);
  const line = buildJournalEntry(entry, clock.now);
  assert.ok(line, 'the journal accepts it');
  assert.ok(!JSON.stringify(line).includes('可爱'), 'never the user\'s words');
  assert.equal(describeJournalEntry(line!, (s, ...v) => s.replace(/\{(\d)\}/gu, (_m, i) => String(v[Number(i)]))).includes('害羞（中）'), true);
});

test('a failed, late, unsure or quota-less haiku falls back to her warm tail; a cold tail brings nothing', async () => {
  for (const [script, outcome] of [[{ fail: true }, 'error'], [{ hang: true }, 'timeout'], [JSON.stringify({ event: 'praise', reactions: [], delta: {}, confidence: 0.2 }), 'low-confidence'], ['不是 JSON', 'invalid']] as const) {
    const clock = new Clock(), ask = new FakeReactionJudge(script as never), w = world(clock, ask);
    w.host.userTurn('m1', '我考过了！');
    await clock.advance(REACTION_KNOBS.firstCharWaitMs + REACTION_KNOBS.timeoutMs + SECOND);
    assert.equal(w.played.length, 0, `${outcome}: waits for her tail`);
    assert.deepEqual(tail(w.host, 'm1', 'positive', { O: 10 }), { O: 10 }, `${outcome}: haiku gave nothing, the whole tail`);
    await clock.advance(5 * SECOND);
    assert.deepEqual(w.played.map(item => [item.id, item.event]), [['blush', 'warm']], outcome);
    assert.equal(w.journal.at(-1)!.decider, 'fallback');
    assert.equal(w.journal.at(-1)!.haiku, outcome);
  }
  // Her tail first, then haiku times out: still the fallback, once.
  const clock = new Clock(), ask = new FakeReactionJudge({ hang: true }), w = world(clock, ask);
  w.host.userTurn('m1', '你辛苦了'); await clock.advance(400);
  tail(w.host, 'm1', 'support');
  await clock.advance(REACTION_KNOBS.timeoutMs + 5 * SECOND);
  assert.deepEqual(w.played.map(item => item.id), ['blush']);
  // A cold tail: nothing.
  const clock3 = new Clock(), w3 = world(clock3, new FakeReactionJudge({ fail: true }));
  w3.host.userTurn('m1', '嗯'); await clock3.advance(2 * SECOND); tail(w3.host, 'm1', 'neutral'); await clock3.advance(5 * SECOND);
  assert.equal(w3.played.length, 0);
  // No quota: haiku never asked, the tail decides.
  const clock4 = new Clock(), ask4 = new FakeReactionJudge('{}'), w4 = world(clock4, ask4);
  w4.store.calls = 10_000;
  w4.host.userTurn('m1', '你好棒'); await clock4.advance(2 * SECOND); tail(w4.host, 'm1'); await clock4.advance(5 * SECOND);
  assert.equal(ask4.calls, 0);
  assert.deepEqual(w4.played.map(item => item.id), ['blush']);
  assert.equal(w4.journal.at(-1)!.haiku, 'quota');
});

test('scenario: an invented character praised four times, 30 s apart, haiku down: blush, shy, blush, nothing (by hand)', async () => {
  // warm, by hand (calm, jitter 0): blush 50 + 16 + 3 − 1.5 = 67.5; shy 40 + 18 − 1.25 + 1 = 57.75; happy 45 + 0 + 6 − 1.5 − 2 = 47.5.
  //  #1 t=0:   blush 67.5 (mid)                                   → blush
  //  #2 t=30:  blush 67.5 − 28·0.5^0.5 = 47.7; shy 57.75          → shy (light)
  //  #3 t=60:  blush 67.5 − 28·0.5 = 53.5; shy 57.75 − 35·0.5^0.25 = 28.3 → blush (light)
  //  #4 t=90:  blush 67.5 − 28·(0.5^1.5 + 0.5^0.5) = 37.8; shy 33.0; happy 47.5 < actAt 50 → nothing
  const clock = new Clock(), w = world(clock, new FakeReactionJudge({ fail: true }));
  const start = clock.now;
  for (let i = 1; i <= 4; i++) {
    clock.now = start + (i - 1) * 30 * SECOND;
    w.host.userTurn(`p${i}`, '你今天好可爱');
    await clock.advance(SECOND);
    tail(w.host, `p${i}`, 'positive');
    await clock.advance(5 * SECOND);
  }
  assert.deepEqual(w.played.map(item => [item.id, item.level]), [['blush', 'mid'], ['shy', 'light'], ['blush', 'light']]);
  const last = w.journal.at(-1)!;
  assert.equal(last.decider, 'none');
  assert.deepEqual(last.candidates.map(item => [item.id, item.score]), [['happy', 47.5], ['blush', 37.8], ['nod', 33.5], ['shy', 33]]);
});

test('a pat, a pinch and a snack: the top reaction at once, without haiku, once per contact', async () => {
  const clock = new Clock(), ask = new FakeReactionJudge('{}'), w = world(clock, ask);
  const note = (type: 'rua' | 'food', id: string, session: string, extra: Partial<{ pinch: boolean; oBefore: number; oAfter: number }> = {}) =>
    w.host.port.observe({ characterId: HEROINE_ID, type, id, session, pinch: false, oBefore: 0, oAfter: 0, threshold: 6, ...extra });
  note('rua', 'r1', 's1', { oAfter: 1 });
  await clock.advance(SECOND);
  assert.equal(w.played.length, 0, 'a pat counts once her closeness rose by patRise of the threshold');
  note('rua', 'r2', 's1', { oBefore: 1, oAfter: 3.2 });
  note('rua', 'r3', 's1', { oBefore: 3.2, oAfter: 5 });
  await clock.advance(SECOND);
  // pat by hand: blush 52 + 16 + 3 − 1.5 = 69.5 (shy 25 + 18 − 1.25 + 1 = 42.75).
  assert.deepEqual(w.played.map(item => [item.id, item.event]), [['blush', 'pat']]);
  note('rua', 'cheek:c1', 'c1', { pinch: true });
  note('rua', 'cheek:c1b', 'c1', { pinch: true });
  await clock.advance(5 * SECOND);
  // pinch by hand: shy 45 + 18 − 1.25 + 1 = 62.75 > blush (still red: gated) → shy.
  assert.deepEqual(w.played.slice(1).map(item => [item.id, item.event]), [['shy', 'pinch']]);
  note('food', 'f1', 'f1');
  await clock.advance(5 * SECOND);
  // feed by hand: happy 55 + 0 + 6 − 1.5 − 2 = 57.5; nod 35 − 2 + 0.5 = 33.5 → happy.
  assert.deepEqual(w.played.slice(2).map(item => [item.id, item.event]), [['happy', 'feed']]);
  assert.equal(ask.calls, 0, 'never haiku for the body');
});

test('a stage reaction waits for her to be free at most knobs.freeWaitMs, then gives up', async () => {
  const clock = new Clock(), w = world(clock, new FakeReactionJudge(JSON.stringify({ event: 'coax', reactions: [{ id: 'shy', level: 'light' }], delta: {}, confidence: 0.9 })));
  w.perf.busyUntil = clock.now + 60 * SECOND;
  w.host.userTurn('m1', '抱抱嘛');
  await clock.advance(10 * SECOND);
  assert.equal(w.played.length, 0);
  assert.deepEqual(w.journal.at(-1)!.picks, [{ id: 'shy', level: 'light', done: false, why: 'busy' }]);
  w.perf.busyUntil = clock.now + 1_000;
  w.host.userTurn('m2', '抱抱嘛');
  await clock.advance(10 * SECOND);
  assert.deepEqual(w.played.map(item => item.id), ['shy'], 'free within the wait: it plays');
});

test('switch off: no call, no reaction, MoodHost holds no port; asleep or 自动表现 off: nothing for that message', async (t: TestContext) => {
  const clock = new Clock(), ask = new FakeReactionJudge('{}'), w = world(clock, ask, { enabled: false });
  w.host.userTurn('m1', '你好棒'); await clock.advance(5 * SECOND); tail(w.host, 'm1'); await clock.advance(5 * SECOND);
  w.host.port.observe({ characterId: HEROINE_ID, type: 'food', id: 'f', session: 'f', pinch: false, oBefore: 0, oAfter: 0, threshold: 6 });
  await clock.advance(SECOND);
  assert.equal(ask.calls, 0); assert.equal(w.played.length, 0); assert.equal(w.store.chats, 0);
  assert.deepEqual(w.host.port.appraisal(HEROINE_ID, 'm1', { O: 4 }, 'positive'), { O: 4 });
  for (const quiet of ['asleep', 'off'] as const) {
    const c = new Clock(), a = new FakeReactionJudge('{}'), q = world(c, a);
    q.state.quiet = quiet;
    q.host.userTurn('m1', '你好棒'); await c.advance(2 * SECOND); tail(q.host, 'm1'); await c.advance(5 * SECOND);
    assert.equal(a.calls, 0); assert.equal(q.played.length, 0, quiet);
  }
  // The app wiring: off → MoodHost.setReactionPort(null), on → the host's port; the switch persists only once chosen.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i037-wiring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ports: unknown[] = [];
  const view = { characterId: HEROINE_ID, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'calm', values: values(), phase: 'idle', intensity: DEFAULT_MOOD_PARAMETERS.intensity, blush: null },
    fatigue: { phase: 'awake' } } as unknown as MoodView;
  const mood: ReactionMoodPort = { get: () => view, isTestMoodActive: () => false, setReactionPort: port => { ports.push(port); },
    reactionBlush: () => ({ done: true }), lift: () => {} };
  const app = createReactions({ directory: () => directory, defaultEnabled: false, mood: () => mood, persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: () => true, ask: ask.ask });
  await app.load();
  assert.deepEqual(ports, [null], 'stable default: off');
  await assert.rejects(readFile(path.join(directory, 'reactions.json'), 'utf8'));
  app.setEnabled(true);
  assert.equal(ports.at(-1), app.host.port);
  assert.equal(app.switchView().enabled, true);
  app.setEnabled(false);
  assert.equal(ports.at(-1), null);
  // The sliders: the current character only; null goes back to the card's values; `before` lets the channel undo it.
  assert.deepEqual(app.dispositionsView().values, deriveDispositions(DEFAULT_MOOD_PARAMETERS));
  const set = app.setDispositions({ shy: 80 });
  assert.equal(set.before, null); assert.equal(set.values!.shy, 80); assert.equal(set.stored, true);
  const back = app.setDispositions(null);
  assert.equal(back.stored, false); assert.deepEqual(back.before, { ...deriveDispositions(null), shy: 80 });
  await app.dispose();
});

test('MoodHost: with the port its tail gives only the blended share and the model\'s own blush gates step aside', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i037-mood-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async (port: boolean) => {
    const clock = { now: Date.UTC(2026, 10, 6, 12, 0, 0) };
    const host = new MoodHost(path.join(directory, String(port)), () => {}, () => clock.now);
    await host.load();
    host.activate(HEROINE_ID, structuredClone(DEFAULT_MOOD_PARAMETERS));
    const seen: string[] = [];
    if (port) host.setReactionPort({ ownsBlush: () => true, appraisal: () => ({}), observe: note => { seen.push(note.type); } });
    host.event({ type: 'chat', id: 'm1', reason: '收到用户聊天' });
    const before = host.get().snapshot.values.O;
    host.event({ type: 'appraisal', id: 'appraisal-m1', responseTo: 'm1', delta: { O: 8, E: 4 }, context: 'positive' });
    const after = host.get().snapshot.values.O;
    return { rise: after - before, blush: host.get().snapshot.blush, seen };
  };
  const plain = await run(false), withPort = await run(true);
  assert.ok(plain.rise > 1, `without the port her tail moves O (${plain.rise})`);
  assert.ok(Math.abs(withPort.rise) < 0.2, `with the port its share (here none) is all it gives (${withPort.rise})`);
  assert.equal(withPort.blush, null, 'the model\'s own warm-words blush is the table\'s call now');
  assert.deepEqual(withPort.seen, ['chat', 'appraisal']);
});

test('end to end: ONE new row (a fake reaction) is offered to haiku, picked, played through a real performer, and journaled', async () => {
  const clock = new Clock();
  const table = { ...REACTION_TABLE, sparkle: { label: '闪闪眼', describe: '测试用的假反应', performer: 'action', arg: 'wink', events: { praise: 99 }, recent: { penalty: 0, halfLifeMs: 1 } } satisfies ReactionRow };
  const ask = new FakeReactionJudge(pickFirstOf('praise', 'strong', { O: 2 }));
  const view = { characterId: HEROINE_ID, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'calm', values: values(), phase: 'idle', intensity: DEFAULT_MOOD_PARAMETERS.intensity, blush: null },
    fatigue: { phase: 'awake' } } as unknown as MoodView;
  const actions: string[] = [], lines: unknown[] = [];
  const mood: ReactionMoodPort = { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: () => {} };
  const app = createReactions({ directory: () => null, defaultEnabled: true, mood: () => mood, persona: () => '温和', petVisible: () => true, available: () => true,
    actions: () => ({ offered: () => ['wink'], perform: async word => { actions.push(word); return { played: true, status: 'played' }; } }), stage: () => true,
    journal: entry => { lines.push(buildJournalEntry(entry, clock.now)); }, ask: ask.ask,
    host: { table, clock: () => clock.now, timers: clock.api, random: () => 0.5, localDate: () => 'day' } });
  await app.load();
  app.userTurn('m1', '你今天好可爱');
  await clock.advance(5 * SECOND);
  assert.equal(ask.calls, 1);
  assert.match(ask.systems[0], /sparkle（闪闪眼/);
  assert.match(ask.prompts[0], /praise（被夸）：sparkle 闪闪眼 99/);
  assert.deepEqual(actions, ['wink'], 'played by the real "action" performer');
  const line = lines.at(-1) as { type: string; picks: unknown[] } | null;
  assert.ok(line && line.type === 'reaction');
  assert.deepEqual(line!.picks, [{ id: 'sparkle', level: 'strong', done: true }]);
  await app.dispose();
});

test('real performers: their gates (自动表现 off, asleep, card blush off, a pat on, a model without the action) and the stage cue', async () => {
  const view = { characterId: HEROINE_ID, expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot: { primary: 'calm', values: values(), phase: 'idle',
    intensity: DEFAULT_MOOD_PARAMETERS.intensity, blush: null }, fatigue: { phase: 'awake' } } as unknown as MoodView & { snapshot: { phase: string } };
  const cues: unknown[] = [], lifts: unknown[] = [];
  const performers = createReactionPerformers({ mood: () => ({ get: () => view, reactionBlush: () => ({ done: true }), lift: lift => { lifts.push(lift); } }),
    actions: () => ({ offered: () => ['nod'], perform: async () => ({ played: true, status: 'played' }) }), stage: cue => { cues.push(cue); return true; } });
  const ctx = { characterId: HEROINE_ID, event: 'praise' as const };
  assert.equal(performers.shy.gate(REACTION_TABLE.shy, ctx), null);
  assert.deepEqual(await performers.shy.perform(REACTION_TABLE.shy, 'mid', { ...ctx, id: 'shy', key: 'k1' }), { done: true });
  assert.deepEqual(readReactionStageCue(cues[0]), { id: 'reaction-shy-k1', kind: 'shy', level: 'mid' });
  assert.equal(performers.action.gate(REACTION_TABLE.clap, ctx), 'model', 'this model cannot clap');
  assert.equal(performers.action.gate(REACTION_TABLE.nod, ctx), null);
  await performers.happy.perform(REACTION_TABLE.happy, 'strong', { ...ctx, id: 'happy', key: 'k2' });
  assert.deepEqual((lifts[0] as { delta: unknown }).delta, REACTION_KNOBS.happyLift.strong);
  (view.snapshot as { phase: string }).phase = 'rua';
  assert.equal(performers.shy.gate(REACTION_TABLE.shy, ctx), 'busy', 'a pat on: the show would fade at once');
  (view.snapshot as { phase: string }).phase = 'idle';
  view.parameters.blush.enabled = false;
  assert.equal(performers.blush.gate(REACTION_TABLE.blush, ctx), 'card-off');
  (view as { fatigue: { phase: string } }).fatigue.phase = 'asleep';
  assert.equal(performers.happy.gate(REACTION_TABLE.happy, ctx), 'asleep');
  (view as { expressions: boolean }).expressions = false;
  assert.equal(performers.blush.gate(REACTION_TABLE.blush, ctx), 'off');
  assert.equal(performers.shy.gate(REACTION_TABLE.shy, { ...ctx, characterId: 'another' }), 'stale');
});

test('the stage side: shy goes to the universal show with its strength; another kind of performance is never cut; an unknown cue does nothing', () => {
  let other = false;
  const asked: { recipe: unknown; strength: number | undefined }[] = [];
  const port = { showingOther: () => other, playExpression: (recipe: unknown, strength?: number) => { asked.push({ recipe, strength }); return { recipe: 'shy' as const, usable: true, parts: [], missing: [], reason: '' }; } };
  assert.equal(playReactionCue({ id: 'r1', kind: 'shy', level: 'mid' }, port), 'played');
  // Asked again while showing: the universal show keeps going at the higher strength (show-blend.ts), so it is played, not refused.
  assert.equal(playReactionCue({ id: 'r2', kind: 'shy', level: 'strong' }, port), 'played');
  assert.deepEqual(asked, [{ recipe: 'shy', strength: 0.8 }, { recipe: 'shy', strength: 1 }]);
  other = true;
  assert.equal(playReactionCue({ id: 'r3', kind: 'shy', level: 'light' }, port), 'busy', 'a preview or personal pose is not cut');
  assert.equal(asked.length, 2);
  assert.equal(playReactionCue({ id: 'r4', kind: 'surprise', level: 'mid' }, port), 'invalid');
  assert.equal(playReactionCue({ id: 'r5', kind: 'shy', level: 'mid', extra: 1 }, port), 'invalid');
});

test('the journal copy has English for every reaction word it can write', () => {
  const tr = (s: string) => { if (!(s in JOURNAL_EN) && /[一-鿿]/u.test(s)) throw new Error(`no English for ${s}`); return s; };
  const t = (s: string, ...v: readonly unknown[]) => tr(s).replace(/\{(\d)\}/gu, (_m, i) => String(v[Number(i)]));
  for (const decider of ['top', 'haiku', 'fallback', 'none'] as const)
    for (const haiku of ['answered', 'none', 'invalid', 'low-confidence', 'timeout', 'error', 'quota', 'quiet', 'superseded', null] as const)
      for (const event of ['none', ...Object.keys(REACTION_EVENTS)] as const) {
        const ids = Object.keys(REACTION_TABLE).slice(0, 2);
        const entry = buildJournalEntry({ type: 'reaction', characterId: HEROINE_ID, event, decider, haiku, candidates: [{ id: ids[0], score: 50 }],
          picks: [{ id: ids[0], level: 'mid', done: true }, { id: ids[1], level: 'light', done: false, why: 'busy' }] }, 1);
        assert.ok(entry);
        describeJournalEntry(entry!, t);
      }
  for (const id of Object.keys(REACTION_TABLE)) tr(REACTION_TABLE[id].label);
  for (const id of DISPOSITION_IDS) assert.ok(id);
});

test('agent channel: set_reaction_dispositions changes the current character\'s six through the 角色页 operation, and undo puts them back', async () => {
  const view = { characterId: HEROINE_ID, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'calm', values: values(), phase: 'idle', intensity: DEFAULT_MOOD_PARAMETERS.intensity, blush: null },
    fatigue: { phase: 'awake' } } as unknown as MoodView;
  const mood: ReactionMoodPort = { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: () => {} };
  const app = createReactions({ directory: () => null, defaultEnabled: true, mood: () => mood, persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: () => true, ask: new FakeReactionJudge('{}').ask });
  await app.load();
  const operations = new Map<string, IpcHandler>();
  app.register((method, operation) => { operations.set(method, (event, ...args) => operation(event.sender.id, ...args)); });
  assert.ok(['getReactions', 'setReactions', 'getReactionDispositions', 'setReactionDispositions'].every(op => AGENT_HOST_OPERATIONS.includes(op) && operations.has(op)));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations, admit: (guard: () => void, run: () => unknown) => { guard(); return run(); },
    importCharacterCard: async () => { throw new Error('x'); }, loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
    commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); }, replyLatency: () => [], broadcast: () => {}, interconnected: () => true } as never);
  let undo: { run(guard: () => void): Promise<void> } | undefined;
  const notices: string[] = [];
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true, confirm: async () => { throw new Error('no dialog expected'); },
    notice: (_tool: string, title: string, detail?: string) => notices.push(`${title}：${detail ?? ''}`), called: (_summary: unknown, offer?: never) => { undo = offer; } } as never);
  for (const bad of [{}, { shy: 101 }, { shy: 1.5 }, { brave: 3 }, { shy: 10, reset: true }, { reset: false }])
    assert.equal(((await registry.call('set_reaction_dispositions', bad)) as { error: { code: string } }).error.code, 'invalid_input', JSON.stringify(bad));
  const result = await registry.call('set_reaction_dispositions', { shy: 80, restrained: 30 }) as { ok: boolean; result: { values: Dispositions; fromCard: boolean } };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.values, { ...deriveDispositions(null), shy: 80, restrained: 30 });
  assert.equal(result.result.fromCard, false);
  assert.deepEqual(notices, ['调她的反应倾向：调了她的反应倾向：害羞 80、克制 30']);
  assert.deepEqual(app.dispositionsView().values, { ...deriveDispositions(null), shy: 80, restrained: 30 });
  await undo!.run(() => {});
  assert.equal(app.dispositionsView().stored, false, 'undo: back to the card\'s values');
  assert.deepEqual(capability('reaction_dispositions')?.channel, { tool: 'set_reaction_dispositions', read: 'set_reaction_dispositions 的返回值' });
  assert.equal(capability('new_reactions')?.level, 'user-words', 'turning it on spends quota: the user\'s own words');
  assert.equal(agentSetting('new_reactions')?.kind, 'boolean');
  await app.dispose();
});
