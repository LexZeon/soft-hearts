/**
 * I-027 心情调整员 (shared/behaviors/mood-judge/, electron/mood-judge/) with a fake haiku on a fake clock. Never a real model call.
 * What it pins: default off means zero calls; a batch waits knobs.gatherMs and calls are knobs.spacingMs apart; the quiet rules
 * ask nothing; the daily cap and its local-midnight reset (and the count surviving a restart); every bound; malformed,
 * unconfident, late and stale answers change nothing; a character switch or falling asleep drops a batch; after Opus's tail a
 * message batch moves each number at most ±3; the correction goes through MoodHost.lift (no new interaction, no boredom reset)
 * with the card's sensitivity applied once; the journal line holds only the closed reason; the switch is registered (I-025).
 * All text here is invented; nothing comes from a real conversation.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodJudgeHost, type MoodJudgeHostOptions, type MoodJudgeQuiet } from '../electron/mood-judge/host';
import { MoodJudgeStore } from '../electron/mood-judge/store';
import { createMoodJudge, moodJudgeFrame, type MoodJudgeMoodPort } from '../electron/mood-judge/wiring';
import { MoodHost } from '../electron/mood';
import { MoodJournal, type MoodJournalEvent } from '../electron/journal/sources';
import { settingDetail } from '../electron/agent-channel/app-tools';
import {
  MOOD_JUDGE_SYSTEM_PROMPT, boundMoodJudgement, liftDelta, mergeMoodNote, mergeNote, mergeUserText, moodJudgePrompt, moodJudgeReason, moodJudgeWhyOf,
  parseMoodJudgeAnswer, watchMoodJudge, type MoodJudgeFrame, type MoodJudgeWatchState,
} from '../shared/behaviors/mood-judge/choose';
import { judgeAnswer, neverAsked, scriptedMoodJudge } from '../shared/behaviors/mood-judge/fake';
import { MOOD_JUDGE_WHYS, moodJudgeDailyCap, type MoodJudgeAsk, type MoodJudgeItem, type MoodJudgeMoodNote, type MoodJudgeNow } from '../shared/behaviors/mood-judge/interface';
import { MOOD_JUDGE_KNOBS } from '../shared/behaviors/mood-judge/knobs';
import { DEFAULT_MOOD_PARAMETERS, type MoodValues } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { buildJournalEntry, describeJournalEntry, type JournalInput } from '../shared/journal';
import { capability } from '../shared/capabilities';
import { agentSetting } from '../shared/agent-channel';
import { formatMoodJudgeLines } from '../src/ui/MoodPanel';

const SECOND = 1_000, MINUTE = 60_000, DAY = 86_400_000;

class Clock {
  now = Date.UTC(2026, 10, 4, 6, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly timerApi = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + ms, fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
  }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/** Time passes in 1 s steps, promises settling in between (a fake haiku answers through the clock). */
async function run(clock: Clock, ms: number): Promise<void> { for (let t = 0; t < ms; t += SECOND) { clock.advance(Math.min(SECOND, ms - t)); await flush(); } }
const waiter = (clock: Clock) => (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const id = clock.timerApi.set(resolve, ms);
  signal.addEventListener('abort', () => { clock.timerApi.clear(id); reject(new Error('aborted')); }, { once: true });
});
const values = (partial: Partial<MoodValues> = {}, fill = 0): MoodValues => ({ D: fill, O: fill, E: fill, N: fill, C: fill, ...partial });
const utcDay = (ms: number) => String(Math.floor(ms / DAY));

function memoryStore(enabled = true) {
  const counts = new Map<string, number>();
  return { enabled, counts, today: (day: string) => counts.get(day) ?? 0, noteCall: (day: string) => { const n = (counts.get(day) ?? 0) + 1; counts.set(day, n); return n; } };
}
function judge(clock: Clock, ask: MoodJudgeAsk, options: Partial<MoodJudgeHostOptions> & { enabled?: boolean; sensitivity?: Partial<MoodValues> } = {}) {
  const store = memoryStore(options.enabled ?? true);
  const state = { quiet: null as MoodJudgeQuiet | null, busy: false, character: 'gene' };
  const lifts: { lift: { id: string; delta: Partial<MoodValues>; reason: string; context?: string }; characterId: string }[] = [];
  const now = (): MoodJudgeNow => ({ characterId: state.character, persona: '安静，爱看书，说话慢', personality: { playful: 1, close: 1.2, comfortable: 1, cautious: 0.9 },
    values: values({}, 55), baseline: values({}, 50), sensitivity: values(options.sensitivity ?? {}, 1), label: '平静', fatigue: '清醒', doing: '陪着你', at: clock.now });
  let lift = 0;
  const host = new MoodJudgeHost({ ask, store, now, quiet: () => state.quiet, busy: () => state.busy,
    apply: (value, characterId) => { lifts.push({ lift: value, characterId }); }, developerMode: () => true,
    clock: () => clock.now, timers: clock.timerApi, localDate: utcDay, id: () => `t${++lift}`, ...options });
  return { host, store, state, lifts };
}
const pat = (id: string, session: string, applied: Partial<MoodValues> = { O: 2, E: 0.8 }, characterId = 'gene'): MoodJudgeMoodNote =>
  ({ characterId, type: 'rua', id, session, effectiveMs: 400, applied: values(applied) });
const food = (id: string, session: string): MoodJudgeMoodNote => ({ characterId: 'gene', type: 'food', id, session, applied: values({ D: 12, E: 6 }) });

// ---------------------------------------------------------------- default off

test('default off: nothing is collected and haiku is never asked, however much happens', async () => {
  const clock = new Clock(), ask = neverAsked(), { host, lifts } = judge(clock, ask, { enabled: false });
  for (let i = 0; i < 20; i++) {
    host.noteMood(pat(`p${i}`, 's1'));
    host.userText(`r${i}`, '今天好累啊');
    host.note({ kind: 'her-line', characterId: 'gene' });
    host.note({ kind: 'song', characterId: 'gene' });
    await run(clock, 40 * SECOND);
  }
  await run(clock, 30 * MINUTE);
  assert.equal(ask.calls, 0);
  assert.equal(lifts.length, 0);
  assert.deepEqual(host.view()?.recent, [], 'nothing was even gathered');
  assert.equal(host.view()?.enabled, false);
});

test('default on in the app wiring (2026-11-07): a fresh profile reads on without writing anything; the user turning it off is saved and then nothing is asked', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i027-wiring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ask = neverAsked();
  const view = (characterId = 'gene', phase = 'awake') => ({ characterId, expressions: true, parameters: DEFAULT_MOOD_PARAMETERS,
    snapshot: { values: values({}, 50), boredom: 0, longing: 0, lastInteractionAt: null, primary: 'calm' }, fatigue: { phase } } as unknown as MoodView);
  let current = view();
  const port: MoodJudgeMoodPort = { get: () => current, isTestMoodActive: () => false, lift: () => { throw new Error('nothing applies while off'); } };
  const broadcasts: unknown[] = [];
  const app = createMoodJudge({ directory: () => directory, mood: () => port, persona: () => '安静', petVisible: () => true, available: () => true, busy: () => false,
    developerMode: () => true, broadcast: next => broadcasts.push(next), ask });
  await app.load();
  assert.equal(app.view().enabled, true, 'a fresh profile reads on');
  await assert.rejects(readFile(path.join(directory, 'mood-judge.json'), 'utf8'), 'nothing written while untouched');
  assert.deepEqual(app.setEnabled(false), { enabled: false, cap: MOOD_JUDGE_KNOBS.callsPerDay, base: MOOD_JUDGE_KNOBS.callsPerDay, perChat: MOOD_JUDGE_KNOBS.callsPerChat, max: MOOD_JUDGE_KNOBS.callsPerDayMax });
  await app.store.flush();
  assert.equal(JSON.parse(await readFile(path.join(directory, 'mood-judge.json'), 'utf8')).enabled, false, 'the user turning it off is saved');
  broadcasts.length = 0;
  app.noteMood(pat('p1', 's1')); app.watch(current); app.host.userText('r1', '在吗');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ask.calls, 0, 'off: nothing is asked');
  assert.deepEqual(app.setEnabled(true), { enabled: true, cap: MOOD_JUDGE_KNOBS.callsPerDay, base: MOOD_JUDGE_KNOBS.callsPerDay, perChat: MOOD_JUDGE_KNOBS.callsPerChat, max: MOOD_JUDGE_KNOBS.callsPerDayMax });
  assert.deepEqual(broadcasts, [{ enabled: true, cap: MOOD_JUDGE_KNOBS.callsPerDay, base: MOOD_JUDGE_KNOBS.callsPerDay, perChat: MOOD_JUDGE_KNOBS.callsPerChat, max: MOOD_JUDGE_KNOBS.callsPerDayMax }]);
  await app.store.flush();
  assert.equal(JSON.parse(await readFile(path.join(directory, 'mood-judge.json'), 'utf8')).enabled, true);
  assert.throws(() => app.setEnabled('yes' as unknown as boolean), /开关不正确/);
  await app.dispose();
});

// ---------------------------------------------------------------- batching and spacing

test('a batch waits knobs.gatherMs; pats of one contact and a snack become one call; the next call waits knobs.spacingMs', async () => {
  const clock = new Clock();
  const ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ O: 2 }), after: 3 * SECOND }), waiter(clock));
  const { host, lifts } = judge(clock, ask);
  host.noteMood(pat('p1', 's1'));
  await run(clock, 10 * SECOND);
  host.noteMood(pat('p2', 's1'));
  host.noteMood(food('f1', 's2'));
  await run(clock, 19 * SECOND);
  assert.equal(ask.calls.length, 0, 'still gathering');
  await run(clock, 2 * SECOND);
  assert.equal(ask.calls.length, 1);
  assert.match(ask.calls[0].prompt, /你摸了摸她的头（2 下，约 1 秒）/);
  assert.match(ask.calls[0].prompt, /你喂了她一份点心/);
  assert.equal(ask.calls[0].system, MOOD_JUDGE_SYSTEM_PROMPT);
  await run(clock, 5 * SECOND);
  assert.equal(lifts.length, 1);
  assert.deepEqual(lifts[0].lift.delta, { O: 2 });
  assert.equal(lifts[0].lift.reason, moodJudgeReason('too-little'));
  assert.equal(lifts[0].lift.context, 'neutral', 'a correction is no moment of its own');
  assert.ok(lifts[0].lift.id.startsWith('mood-judge-'));
  // Another moment 10 s after that call: it waits until two minutes after the call started.
  host.noteMood(pat('p3', 's3'));
  await run(clock, 100 * SECOND);
  assert.equal(ask.calls.length, 1, 'two minutes apart');
  await run(clock, 15 * SECOND);
  assert.equal(ask.calls.length, 2);
});

// ---------------------------------------------------------------- quiet rules

for (const quiet of ['asleep', 'hidden', 'unavailable', 'expressions-off', 'test-mood'] as const) {
  test(`quiet: ${quiet} asks nothing and drops the batch (never retried)`, async () => {
    const clock = new Clock(), ask = neverAsked(), { host, state, lifts } = judge(clock, ask);
    state.quiet = quiet;
    host.noteMood(pat('p1', 's1'));
    await run(clock, 31 * SECOND);
    assert.equal(ask.calls, 0);
    assert.equal(host.view()?.recent[0]?.outcome, quiet);
    state.quiet = null;
    await run(clock, 10 * MINUTE);
    assert.equal(ask.calls, 0, 'the dropped batch is not asked later');
    assert.equal(lifts.length, 0);
  });
}

test('her reply still coming: the batch waits; past knobs.staleMs it is dropped instead', async () => {
  const clock = new Clock(), ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ O: 1 }) }));
  const { host, state } = judge(clock, ask);
  state.busy = true;
  host.noteMood(pat('p1', 's1'));
  await run(clock, 90 * SECOND);
  assert.equal(ask.calls.length, 0);
  state.busy = false;
  await run(clock, 6 * SECOND);
  assert.equal(ask.calls.length, 1, 'asked once her reply was done');
  await run(clock, 3 * MINUTE);
  state.busy = true;
  host.noteMood(pat('p2', 's2'));
  await run(clock, 30 * SECOND + MOOD_JUDGE_KNOBS.staleMs + 10 * SECOND);
  state.busy = false;
  await run(clock, 5 * MINUTE);
  assert.equal(ask.calls.length, 1);
  assert.equal(host.view()?.recent[0]?.outcome, 'stale');
});

// ---------------------------------------------------------------- the daily cap

test('the daily cap: past it a batch is dropped (cap reached on the panel); local midnight starts again', async () => {
  const clock = new Clock();
  clock.now = Date.UTC(2026, 10, 4, 23, 40, 0);
  const ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ C: -1 }, { why: 'calmer' }) }));
  const { host, store } = judge(clock, ask, { knobs: { callsPerDay: 2 } });
  for (let i = 0; i < 3; i++) { host.noteMood(pat(`p${i}`, `s${i}`)); await run(clock, 3 * MINUTE); }
  assert.equal(ask.calls.length, 2);
  assert.equal(host.view()?.recent[0]?.outcome, 'quota');
  assert.equal(host.view()?.capReached, true);
  assert.equal(store.today(utcDay(clock.now)), 2);
  await run(clock, 15 * MINUTE); // past midnight (UTC days in this test)
  host.noteMood(pat('p9', 's9'));
  await run(clock, 3 * MINUTE);
  assert.equal(ask.calls.length, 3, 'a new day');
  assert.equal(host.view()?.today, 1);
  assert.equal(host.view()?.capReached, false);
});

test('the day\'s count survives a restart, resets on another local date, and an unreadable file is left alone (off)', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i027-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mood-judge.json');
  const first = new MoodJudgeStore({ file: () => file });
  await first.load();
  assert.equal(first.enabled, true, 'default on (2026-11-07)');
  first.setEnabled(true);
  assert.equal(first.noteCall('2026-11-04'), 1);
  assert.equal(first.noteCall('2026-11-04'), 2);
  await first.flush();
  const second = new MoodJudgeStore({ file: () => file });
  await second.load();
  assert.equal(second.enabled, true);
  assert.equal(second.today('2026-11-04'), 2, 'survives the restart');
  assert.equal(second.today('2026-11-05'), 0);
  assert.equal(second.noteCall('2026-11-05'), 1, 'a new local date starts again');
  await second.flush();
  await writeFile(file, '{ broken');
  const third = new MoodJudgeStore({ file: () => file });
  await third.load();
  assert.equal(third.enabled, false);
  third.setEnabled(true); third.noteCall('2026-11-05');
  await third.flush();
  assert.equal(await readFile(file, 'utf8'), '{ broken', 'an unreadable file is never overwritten');
});

// ---------------------------------------------------------------- bounds and "合理"

test('bounds: D/N ±3 and O/E/C ±6, all five within 12 together, the hour\'s net within ±15, a quick reversal halved', () => {
  const at = Date.UTC(2026, 10, 4, 6, 0, 0);
  const answer = (delta: Record<string, number>, confidence = 0.9) => parseMoodJudgeAnswer(judgeAnswer(delta, { confidence }));
  assert.deepEqual(boundMoodJudgement(answer({ D: 5, N: -6, O: 4 }), { afterOpus: false, history: [], at }), { D: 3, O: 4, N: -3 });
  // 3 + 6 + 6 + 6 = 21 > 12: scaled down together, never rounded up.
  assert.deepEqual(boundMoodJudgement(answer({ D: 6, O: 6, E: 6, C: -6 }), { afterOpus: false, history: [], at }), { D: 1.7, O: 3.4, E: 3.4, C: -3.4 });
  assert.deepEqual(boundMoodJudgement(answer({ O: 6, E: -5 }), { afterOpus: true, history: [], at }), { O: 3, E: -3 }, 'after Opus: ±3');
  const hour = [{ at: at - 50 * MINUTE, delta: { O: 6 } }, { at: at - 30 * MINUTE, delta: { O: 6 } }];
  assert.deepEqual(boundMoodJudgement(answer({ O: 6 }), { afterOpus: false, history: hour, at }), { O: 3 }, 'net +15 within the hour');
  assert.deepEqual(boundMoodJudgement(answer({ O: 6 }), { afterOpus: false, history: [{ at: at - 61 * MINUTE, delta: { O: 12 } }], at }), { O: 6 }, 'older than an hour no longer counts');
  assert.deepEqual(boundMoodJudgement(answer({ O: -4 }), { afterOpus: false, history: [{ at: at - 5 * MINUTE, delta: { O: 4 } }], at }), { O: -2 }, 'reversal within 10 minutes halved');
  assert.deepEqual(boundMoodJudgement(answer({ O: -4 }), { afterOpus: false, history: [{ at: at - 11 * MINUTE, delta: { O: 4 } }], at }), { O: -4 });
  assert.equal(boundMoodJudgement(answer({ O: 4 }, 0.69), { afterOpus: false, history: [], at }), null, 'confidence below 0.7: unused');
  assert.equal(boundMoodJudgement(null, { afterOpus: false, history: [], at }), null);
  assert.deepEqual(boundMoodJudgement(answer({}), { afterOpus: false, history: [], at }), {}, 'the app got it right: nothing to add');
});

test('strict answers: anything but exactly the four fields, the five numbers within ±6 and a listed reason is no answer', () => {
  const ok = { delta: { O: 2, C: -1 }, fits: false, why: 'too-little', confidence: 0.8 };
  assert.deepEqual(parseMoodJudgeAnswer(JSON.stringify(ok)), ok);
  assert.deepEqual(parseMoodJudgeAnswer('```json\n' + JSON.stringify(ok) + '\n```'), ok);
  for (const bad of [
    'O +2', '', JSON.stringify({ ...ok, note: '用户说他很累' }), JSON.stringify({ delta: ok.delta, fits: false, why: 'too-little' }),
    JSON.stringify({ ...ok, delta: { O: 7 } }), JSON.stringify({ ...ok, delta: { boredom: -5 } }), JSON.stringify({ ...ok, delta: { O: '2' } }),
    JSON.stringify({ ...ok, why: '本机给少了' }), JSON.stringify({ ...ok, why: '他刚才说的话让她难过' }), JSON.stringify({ ...ok, confidence: 1.2 }),
    JSON.stringify({ ...ok, fits: 'yes' }), JSON.stringify([ok]), 'x'.repeat(2_000),
  ]) assert.equal(parseMoodJudgeAnswer(bad), null, bad.slice(0, 60));
});

test('the card\'s sensitivity counts once: what haiku asks is what she gets (a sensitivity-0 number never moves)', () => {
  assert.deepEqual(liftDelta({ O: 3, C: -2, D: 1 }, values({ O: 2, C: 0.5, D: 0 }, 1)), { O: 1.5, C: -4 });
});

// ---------------------------------------------------------------- answers that change nothing

test('malformed, unconfident, timed-out and late answers change nothing (and none is retried)', async () => {
  const clock = new Clock();
  const answers: (string | 'hang' | 'late')[] = ['不是 JSON', JSON.stringify({ delta: { O: 2 }, fits: true, why: 'fits', confidence: 0.9, extra: 1 }),
    judgeAnswer({ O: 4 }, { confidence: 0.5 }), 'hang', 'late'];
  const late: { resolve?: (text: string) => void } = {};
  const calls: string[] = [];
  const ask: MoodJudgeAsk = async (prompt, _system, signal) => {
    calls.push(prompt);
    const next = answers[calls.length - 1];
    if (next === 'hang') return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    if (next === 'late') return new Promise<string>(resolve => { late.resolve = resolve; }); // ignores the abort, answers after the timeout
    return next;
  };
  const { host, lifts } = judge(clock, ask);
  for (let i = 0; i < 5; i++) { host.noteMood(pat(`p${i}`, `s${i}`)); await run(clock, 3 * MINUTE); }
  assert.equal(calls.length, 5);
  late.resolve!(judgeAnswer({ O: 3 }));
  await run(clock, 5 * SECOND);
  assert.equal(lifts.length, 0);
  assert.deepEqual(host.view()?.recent.map(why => why.outcome).reverse(), ['invalid', 'invalid', 'low-confidence', 'timeout', 'timeout'].slice(0, 5));
  await run(clock, 20 * MINUTE);
  assert.equal(calls.length, 5, 'nothing retried');
});

test('a character switch drops the open batch and an answer still on its way; falling asleep drops one too', async () => {
  const clock = new Clock();
  const ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ O: 2 }), after: 10 * SECOND }), waiter(clock));
  const { host, state, lifts } = judge(clock, ask);
  const frame = (characterId: string, extra: Partial<MoodJudgeFrame> = {}): MoodJudgeFrame => ({ characterId, at: clock.now, sleeping: false, bored: null, longing: null,
    lastInteractionAt: null, need: null, pose: null, screen: null, songs: null, ...extra });
  host.watch(frame('gene'));
  host.noteMood(pat('p1', 's1'));
  host.watch(frame('momo'));
  await run(clock, MINUTE);
  assert.equal(ask.calls.length, 0);
  assert.equal(host.view()?.recent[0]?.outcome, 'character');
  // In flight: the answer comes for gene, but momo is on screen now.
  host.watch(frame('gene'));
  host.noteMood(pat('p2', 's2'));
  await run(clock, 31 * SECOND);
  assert.equal(ask.calls.length, 1);
  state.character = 'momo';
  await run(clock, 15 * SECOND);
  assert.equal(lifts.length, 0);
  assert.equal(host.view()?.recent[0]?.outcome, 'character');
  // A note for another character closes the open one too.
  state.character = 'gene';
  await run(clock, 3 * MINUTE);
  host.noteMood(pat('p3', 's3'));
  host.noteMood(pat('p4', 's4', {}, 'momo'));
  assert.equal(host.view()?.recent[0]?.outcome, 'character');
  await run(clock, 3 * MINUTE);
  // Falling asleep while the call runs.
  host.watch(frame('gene'));
  host.noteMood(pat('p5', 's5'));
  await run(clock, 3 * MINUTE);
  const before = ask.calls.length;
  host.noteMood(pat('p6', 's6'));
  await run(clock, 31 * SECOND);
  assert.equal(ask.calls.length, before + 1);
  state.quiet = 'asleep';
  await run(clock, 15 * SECOND);
  assert.equal(host.view()?.recent[0]?.outcome, 'asleep');
  assert.equal(lifts.filter(item => item.characterId === 'gene').length, 1, 'only the one batch momo did not interrupt');
});

test('her view says she fell asleep (or another character came) while haiku thinks: the call is stopped at once and its answer never lands', async () => {
  const clock = new Clock();
  const signals: AbortSignal[] = [];
  const ask: MoodJudgeAsk = (_prompt, _system, signal) => { signals.push(signal); return new Promise<string>(resolve => { clock.timerApi.set(() => resolve(judgeAnswer({ O: 3 })), 20 * SECOND); }); };
  const { host, lifts } = judge(clock, ask);
  const frame = (extra: Partial<MoodJudgeFrame> = {}): MoodJudgeFrame => ({ characterId: 'gene', at: clock.now, sleeping: false, bored: null, longing: null,
    lastInteractionAt: null, need: null, pose: null, screen: null, songs: null, ...extra });
  host.watch(frame());
  host.noteMood(pat('p1', 's1'));
  await run(clock, 31 * SECOND);
  assert.equal(signals.length, 1);
  host.watch(frame({ sleeping: true }));
  assert.equal(signals[0].aborted, true, 'stopped at once');
  assert.equal(host.view()?.recent[0]?.outcome, 'asleep');
  await run(clock, 30 * SECOND);
  assert.equal(lifts.length, 0, 'the answer that still came is ignored');
  host.watch(frame({ sleeping: false }));
  await run(clock, 3 * MINUTE);
  assert.equal(signals.length, 2, 'waking up is an event of its own, asked about');
  assert.match(host.view()?.recent[0]?.outcome ?? '', /applied|nothing/);
  host.noteMood(pat('p2', 's2'));
  await run(clock, 31 * SECOND);
  assert.equal(signals.length, 3);
  host.watch(frame({ characterId: 'momo' }));
  assert.equal(signals[2].aborted, true);
  assert.equal(host.view()?.recent[0]?.outcome, 'character');
});

// ---------------------------------------------------------------- the chat path

test('a message: the user\'s words (cut to 200, the same text Opus got) and Opus\'s tail; haiku then moves each number at most ±3', async () => {
  const clock = new Clock();
  const ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ O: 6, E: 5, D: -2 }, { why: 'subdued' }) }));
  const { host, lifts } = judge(clock, ask);
  const long = '今天下班路上看到一只小猫，' + '它一直跟着我走'.repeat(40);
  host.userText('r1', long);
  host.noteMood({ characterId: 'gene', type: 'chat', id: 'r1', reason: '收到用户聊天', applied: values() });
  host.noteMood({ characterId: 'gene', type: 'appraisal', id: 'appraisal-r1', responseTo: 'r1', reason: 'Opus 自己写的理由：用户今天被老板骂了', context: 'concern', applied: values({ O: 3, C: 2 }) });
  await run(clock, 31 * SECOND);
  const prompt = ask.calls[0].prompt;
  assert.ok(prompt.includes(`「${long.slice(0, 200)}」`), 'the words, cut to 200');
  assert.ok(!prompt.includes(long.slice(0, 201)));
  assert.ok(!prompt.includes('老板'), 'Opus\'s free-text reason never reaches haiku');
  assert.match(prompt, /她自己（Opus 尾注，担心用户）的判断已生效：亲近 \+3\.0、压力 \+2\.0/);
  assert.match(prompt, /每个数最多再修 ±3/);
  assert.deepEqual(lifts[0].lift.delta, { D: -2, O: 3, E: 3 });
  assert.equal(host.view()?.recent[0]?.afterOpus, true);
  // Without an accepted tail the usual caps hold.
  await run(clock, 3 * MINUTE);
  host.noteMood({ characterId: 'gene', type: 'chat', id: 'r2', reason: '收到用户语音', applied: values() });
  await run(clock, 31 * SECOND);
  assert.match(ask.calls[1].prompt, /你用语音说了一句。.*没有给出心情判断/);
  assert.deepEqual(lifts[1].lift.delta, { D: -1.8, O: 5.5, E: 4.6 }, 'D 2 + O 6 + E 5 = 13 > 12: scaled together (toward zero); D −2 after −2 is no reversal');
});

test('her own line: answered by the user\'s next message, or "没人回" once knobs.herLineAnswerMs passed', async () => {
  const clock = new Clock(), ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({}) }));
  const { host } = judge(clock, ask);
  host.note({ kind: 'her-line', characterId: 'gene' });
  await run(clock, 10 * SECOND);
  host.noteMood({ characterId: 'gene', type: 'chat', id: 'r1', reason: '收到用户聊天', applied: values() });
  await run(clock, 25 * SECOND);
  assert.match(ask.calls[0].prompt, /她主动对你说了一句，你回了/);
  await run(clock, 3 * MINUTE);
  host.note({ kind: 'her-line', characterId: 'gene' });
  await run(clock, MOOD_JUDGE_KNOBS.herLineAnswerMs + MINUTE);
  assert.match(ask.calls.at(-1)!.prompt, /她主动对你说了一句，没人回/);
});

// ---------------------------------------------------------------- merging, watching

test('merging: a pinch, the recognized taste joining its snack, a game, her needs; the judge\'s own lift is never an event', () => {
  let items: MoodJudgeItem[] = [];
  const at = 0;
  items = mergeMoodNote(items, { characterId: 'gene', type: 'rua', id: 'cheek:c1', session: 'c1', effectiveMs: 300, applied: values({ O: 1 }) }, at);
  items = mergeMoodNote(items, food('f1', 'snack-1'), at);
  items = mergeMoodNote(items, { characterId: 'gene', type: 'lift', id: 'feed-taste-snack-1', reason: '喂的是她爱吃的', applied: values({ D: 6 }) }, at);
  items = mergeMoodNote(items, { characterId: 'gene', type: 'chat', id: 'rps-m1', reason: '和用户玩了猜拳', applied: values({ D: 6, O: 3 }) }, at);
  items = mergeNote(items, { kind: 'game', characterId: 'gene', result: 'her', rounds: 3 }, at);
  items = mergeMoodNote(items, { characterId: 'gene', type: 'lift', id: 'need-soothed:lonely:123', reason: '被用户哄好了', applied: values({ E: 4 }) }, at);
  items = mergeMoodNote(items, { characterId: 'gene', type: 'lift', id: 'mood-judge-abc', reason: moodJudgeReason('fits'), applied: values({ O: 1 }) }, at);
  items = mergeUserText(items, 'r1', '  第一行\n第二行  ', false, at);
  assert.deepEqual(items.map(item => item.kind), ['touch', 'feed', 'game', 'need', 'message']);
  const lines = items.map(item => moodJudgePromptLine(item));
  assert.match(lines[0], /你捏了捏她的脸/);
  assert.match(lines[1], /认出来是她爱吃的）。本机：期待 \+18\.0、舒适 \+6\.0/);
  assert.match(lines[2], /一场猜拳，她赢了。本机：期待 \+6\.0、亲近 \+3\.0/);
  assert.match(lines[3], /被你哄好了/);
  assert.match(lines[4], /「第一行 第二行」/);
});
const moodJudgePromptLine = (item: MoodJudgeItem) => moodJudgePrompt({ characterId: 'gene', persona: '', personality: { playful: 1, close: 1, comfortable: 1, cautious: 1 },
  values: values({}, 50), baseline: values({}, 50), sensitivity: values({}, 1), label: '', fatigue: '', doing: '', at: 0 }, [item]).split('\n').find(line => line.startsWith('1. '))!;

test('watching the mood view: sleep and waking (how long), crossings upward, the user back after half an hour, her need, the camera, the screen, a song', () => {
  const base: MoodJudgeFrame = { characterId: 'gene', at: 0, sleeping: false, bored: null, longing: null, lastInteractionAt: 1_000, need: null, pose: null, screen: null, songs: 0 };
  let state: MoodJudgeWatchState | null = null;
  const step = (frame: Partial<MoodJudgeFrame>) => { const out = watchMoodJudge(state, { ...base, ...frame }); state = out.state; return out; };
  assert.deepEqual(step({ bored: 'motion', longing: 'longing' }).notes, [], 'the first frame only learns');
  assert.deepEqual(step({ at: MINUTE, bored: 'speech', longing: 'longing' }).notes, [{ kind: 'bored', characterId: 'gene', level: 'speech' }]);
  const asleep = step({ at: 2 * MINUTE, sleeping: true, bored: 'speech', longing: 'sad' });
  assert.equal(asleep.fellAsleep, true);
  assert.deepEqual(asleep.notes, [], 'nothing while she sleeps');
  assert.deepEqual(step({ at: 2 * MINUTE + 95 * MINUTE, sleeping: false, bored: null, longing: null }).notes, [{ kind: 'wake', characterId: 'gene', sleptMinutes: 95 }]);
  assert.deepEqual(step({ at: 100 * MINUTE, lastInteractionAt: 1_000 + 40 * MINUTE }).notes, [{ kind: 'return', characterId: 'gene', via: 'interaction', awayMinutes: 40 }]);
  assert.deepEqual(step({ at: 101 * MINUTE, lastInteractionAt: 1_000 + 45 * MINUTE }).notes, [], 'five minutes later is no return');
  assert.deepEqual(step({ at: 102 * MINUTE, need: { id: 'lonely', since: 5 } }).notes, [{ kind: 'need-start', characterId: 'gene', need: 'lonely' }]);
  assert.deepEqual(step({ at: 103 * MINUTE, need: { id: 'lonely', since: 5 } }).notes, []);
  assert.deepEqual(step({ at: 104 * MINUTE, pose: { id: 'c1', kind: 'yawn', source: 'follow' } }).notes, [{ kind: 'camera', characterId: 'gene', gesture: 'yawn' }]);
  assert.deepEqual(step({ at: 105 * MINUTE, pose: { id: 'c2', kind: 'glance', source: 'arrive' } }).notes, [{ kind: 'return', characterId: 'gene', via: 'camera', awayMinutes: null }]);
  assert.deepEqual(step({ at: 106 * MINUTE, screen: 'code' }).notes, []);
  assert.deepEqual(step({ at: 109 * MINUTE, screen: 'code' }).notes, [], 'the first activity after sharing starts is no change');
  assert.deepEqual(step({ at: 110 * MINUTE, screen: 'video' }).notes, []);
  assert.deepEqual(step({ at: 111 * MINUTE, screen: 'video' }).notes, [], 'not two minutes yet');
  assert.deepEqual(step({ at: 112 * MINUTE + SECOND, screen: 'video' }).notes, [{ kind: 'screen', characterId: 'gene', activity: 'video' }]);
  assert.deepEqual(step({ at: 113 * MINUTE, screen: 'video', songs: 2 }).notes, [{ kind: 'song', characterId: 'gene' }]);
  const other = step({ characterId: 'momo', at: 114 * MINUTE });
  assert.equal(other.switched, true);
  assert.deepEqual(other.notes, []);
});

// ---------------------------------------------------------------- MoodHost, journal, registry

test('MoodHost: pats come with their contact, a message and its tail with the request id; a correction is a lift (no interaction, no boredom reset)', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i027-mood-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: Date.UTC(2026, 10, 4, 6, 0, 0) };
  const host = new MoodHost(directory, () => {}, () => clock.now);
  await host.load();
  host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
  const notes: MoodJudgeMoodNote[] = [];
  host.setJudgeObserver(note => notes.push(note));
  const token = host.get().token;
  host.interaction({ token, sessionId: 'touch-1', type: 'phase', phase: 'rua' });
  for (let i = 0; i < 3; i++) { clock.now += 400; host.interaction({ token, sessionId: 'touch-1', type: 'rua', id: `stroke-${i}`, activeMs: 300 }); }
  host.interaction({ token, sessionId: 'touch-1', type: 'phase', phase: 'idle' });
  clock.now += 1_000;
  host.event({ type: 'chat', id: 'r1', reason: '收到用户聊天' });
  host.event({ type: 'appraisal', id: 'appraisal-r1', responseTo: 'r1', delta: { O: 3 }, context: 'positive', reason: '模型的理由' });
  assert.deepEqual(notes.map(note => [note.type, note.id, note.session ?? null]),
    [['rua', 'stroke-0', 'touch-1'], ['rua', 'stroke-1', 'touch-1'], ['rua', 'stroke-2', 'touch-1'], ['chat', 'r1', null], ['appraisal', 'appraisal-r1', null]]);
  assert.ok(notes[0].applied.O > 0);
  assert.equal(notes[4].responseTo, 'r1');
  // The correction: values move by what was asked (saturation aside); the interaction clock and boredom stay.
  clock.now += 60_000;
  const before = host.get().snapshot;
  host.lift({ id: 'mood-judge-x1', delta: { C: -3 }, reason: moodJudgeReason('calmer') });
  const after = host.get().snapshot;
  assert.ok(after.values.C < before.values.C - 1);
  assert.equal(after.lastInteractionAt, before.lastInteractionAt, 'not an interaction');
  assert.equal(after.boredom, before.boredom, 'boredom not reset');
  assert.equal(notes.at(-1)?.id, 'mood-judge-x1', 'the observer sees it; the judge ignores its own (mergeMoodNote)');
  host.lift({ id: 'mood-judge-x1', delta: { C: -3 }, reason: moodJudgeReason('calmer') });
  assert.equal(host.get().snapshot.values.C, after.values.C, 'the same correction applies once');
  // A gain through the judge stays "neutral" (no supportive afterglow, no face, her chat's 话题情境 untouched); a her-needs lift is positive.
  host.lift({ id: 'mood-judge-x2', delta: { O: 3 }, reason: moodJudgeReason('warmer'), context: 'neutral' });
  assert.equal(host.get().snapshot.context, 'neutral');
  host.lift({ id: 'need-soothed:lonely:1', delta: { O: 3 }, reason: '被用户哄好了' });
  assert.equal(host.get().snapshot.context, 'positive');
  // The test mood keeps the judge quiet.
  assert.equal(host.isTestMoodActive(), false);
  host.setDeveloperMode(true);
  host.setTestMood('happy');
  assert.equal(host.isTestMoodActive(), true);
  // Developer panel line.
  host.setMoodJudgeSource(() => ({ enabled: true, today: 3, cap: 200, capReached: false, recent: [] }));
  assert.deepEqual(host.get().moodJudge, { enabled: true, today: 3, cap: 200, capReached: false, recent: [] });
  host.setDeveloperMode(false);
  assert.equal('moodJudge' in host.get(), false, 'developer mode only');
  await host.flush();
});

test('sensitivity is applied once: on a card twice as sensitive she moves as much as on a plain card', async (t: TestContext) => {
  const moved: number[] = [];
  for (const sensitivity of [1, 2]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'i027-sens-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const clock = { now: Date.UTC(2026, 10, 4, 6, 0, 0) };
    const host = new MoodHost(directory, () => {}, () => clock.now);
    await host.load();
    const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
    parameters.sensitivity.O = sensitivity;
    host.activate('gene', parameters);
    const before = host.get().snapshot.values.O;
    host.lift({ id: 'mood-judge-s', delta: liftDelta({ O: 4 }, parameters.sensitivity), reason: moodJudgeReason('warmer') });
    moved.push(host.get().snapshot.values.O - before);
    await host.flush();
  }
  assert.ok(Math.abs(moved[0] - moved[1]) < 1e-9, `${moved}`);
  assert.ok(moved[0] > 3 && moved[0] <= 4);
});

test('journal: a correction is one "她又想了想" line with a closed reason, only while the switch is on; nothing else gets in', () => {
  const inputs: JournalInput[] = [];
  let on = true;
  const journal = new MoodJournal({ record: input => { inputs.push(input); }, accepting: () => on }, () => 0);
  const lift = (reason: string): MoodJournalEvent => ({ characterId: 'gene', type: 'lift', reason, before: values({}, 50), after: values({ O: 52.4, C: 49 }, 50),
    labelBefore: 'calm', labelAfter: 'content' });
  journal.event(lift(moodJudgeReason('too-little')));
  assert.deepEqual(inputs, [{ type: 'mood-judge', characterId: 'gene', why: 'too-little', before: values({}, 50), after: values({ O: 52.4, C: 49 }, 50), labelBefore: 'calm', labelAfter: 'content' }]);
  journal.event(lift('她又想了想（用户刚才说想辞职）'));
  assert.equal(inputs.at(-1)?.type, 'mood-event', 'any other text is not a judge line (and its words never get through)');
  assert.ok(!JSON.stringify(inputs).includes('辞职'));
  on = false;
  journal.event(lift(moodJudgeReason('calmer')));
  assert.equal(inputs.length, 2, 'off: nothing');
  const entry = buildJournalEntry(inputs[0], Date.UTC(2026, 10, 4, 3, 5));
  assert.ok(entry);
  const line = describeJournalEntry(entry!, (source, ...vals) => vals.reduce<string>((text, value, i) => text.replace(`{${i}}`, String(value)), source));
  assert.match(line, /她又想了想（刚才反应不够，补一点）→ 亲近 \+2、压力 -1，现在：满足$/);
  assert.equal(buildJournalEntry({ ...inputs[0], why: '用户说想辞职' }, 0), null, 'only a listed reason');
  assert.equal(buildJournalEntry({ ...inputs[0], note: 'x' }, 0)?.type, 'mood-judge');
  assert.equal(JSON.stringify(buildJournalEntry({ ...inputs[0], note: '用户说想辞职' }, 0)).includes('辞职'), false, 'extra fields are dropped');
  for (const why of Object.keys(MOOD_JUDGE_WHYS)) {
    assert.ok(MOOD_JUDGE_WHYS[why as keyof typeof MOOD_JUDGE_WHYS].length <= 20, why);
    assert.equal(moodJudgeWhyOf(moodJudgeReason(why as keyof typeof MOOD_JUDGE_WHYS)), why);
  }
});

test('three-way (I-025): the switch is registered; turning it on needs the user\'s words, turning it off does not', () => {
  const entry = capability('mood_judge');
  assert.ok(entry);
  assert.equal(entry!.level, 'user-words');
  assert.deepEqual(entry!.controls, ['#mood-judge-enabled']);
  assert.equal(entry!.category, 'privacy');
  const spec = agentSetting('mood_judge');
  assert.equal(spec?.kind, 'boolean');
  assert.deepEqual(spec?.confirmWhen, [true]);
  assert.match(settingDetail('mood_judge', true) ?? '', /用量.*200/);
  assert.equal(settingDetail('mood_judge', false), undefined);
});

test('the developer panel line: off, today against the cap, used up, and the last batches (numbers and the closed reason only)', () => {
  assert.match(formatMoodJudgeLines({ enabled: false, today: 0, cap: 200, capReached: false, recent: [] }), /关着/);
  assert.match(formatMoodJudgeLines({ enabled: true, today: 200, cap: 200, capReached: true, recent: [] }), /200 \/ 200 次，今天的次数用完了/);
  const text = formatMoodJudgeLines({ enabled: true, today: 12, cap: 200, capReached: false, recent: [
    { at: Date.UTC(2026, 10, 4, 6), events: 3, outcome: 'applied', delta: { O: 2, C: -1 }, why: 'too-little', fits: false, confidence: 0.8, ms: 3_100 },
    { at: Date.UTC(2026, 10, 4, 5), events: 1, outcome: 'asleep' }] });
  assert.match(text, /今天 12 \/ 200 次/);
  assert.match(text, /看了 3 件事 → 动了 O 亲近 \+2\.0、C 压力 -1\.0（刚才反应不够，补一点） · 3\.1 秒/);
  assert.match(text, /她睡着了，没问/);
});

test('the frame the app builds from a mood view: thresholds from the card, sleep, her need and the camera cue', () => {
  const view = { characterId: 'gene', parameters: DEFAULT_MOOD_PARAMETERS,
    snapshot: { boredom: DEFAULT_MOOD_PARAMETERS.boredom.motionAt + 1, longing: DEFAULT_MOOD_PARAMETERS.longing.sadAt + 1, lastInteractionAt: 5 },
    fatigue: { phase: 'micro-awake' }, herNeed: { id: 'dream', mode: 'need', since: 9, strength: 0.5, usedToday: 1 },
    pose: { attention: 0.5, boost: 1.2, cue: { id: 'q1', kind: 'wave', source: 'follow', at: 1, strength: 1 } } } as unknown as MoodView;
  assert.deepEqual(moodJudgeFrame(view, { at: 7, screen: 'code', songs: 3 }), { characterId: 'gene', at: 7, sleeping: true, bored: 'motion', longing: 'sad',
    lastInteractionAt: 5, need: { id: 'dream', since: 9 }, pose: { id: 'q1', kind: 'wave', source: 'follow' }, screen: 'code', songs: 3 });
});

// ---------------------------------------------------------------- the daily limit grows with the day's messages
test('today\'s limit: 120 to start, 2 more for each message today, never above 800 (light, normal and busy days)', () => {
  const cap = (chats: number) => moodJudgeDailyCap(MOOD_JUDGE_KNOBS, chats);
  assert.deepEqual([0, 15, 50, 120, 340, 400, 10_000].map(cap), [120, 150, 220, 360, 800, 800, 800]);
  assert.equal(cap(-3), 120); assert.equal(cap(Number.NaN), 120);
  // Always above the simulated use (docs/claude/2026-11-04-i027-usage-estimate.md: light 22, normal 78, busy 180, at most 202).
  assert.ok(cap(15) > 22 && cap(50) > 90 && cap(120) > 202);
});

test('each message she gets raises today\'s limit; a batch past the old fixed limit is still asked; the panel shows the limit now', async () => {
  const clock = new Clock();
  const ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ C: -1 }, { why: 'calmer' }) }));
  const chats = new Map<string, number>();
  const store = { ...memoryStore(), chatsToday: (day: string) => chats.get(day) ?? 0,
    noteChat: (day: string) => { const n = (chats.get(day) ?? 0) + 1; chats.set(day, n); return n; } };
  const { host } = judge(clock, ask, { store, knobs: { ...MOOD_JUDGE_KNOBS, callsPerDay: 1, callsPerChat: 1, callsPerDayMax: 3 } });
  assert.equal(host.view()?.cap, 1);
  host.noteMood(pat('p0', 's0')); await run(clock, 3 * MINUTE);
  host.noteMood(pat('p1', 's1')); await run(clock, 3 * MINUTE);
  assert.equal(ask.calls.length, 1, 'the base alone allows one');
  host.userText('m1', '在吗'); await run(clock, 3 * MINUTE);
  assert.equal(host.view()?.cap, 2, 'one message: one more');
  assert.equal(ask.calls.length, 2, 'the next batch (with the message) is asked now');
  for (const id of ['m2', 'm3', 'm4']) host.userText(id, '嗯');
  assert.equal(host.view()?.cap, 3, 'never above the maximum');
  assert.equal(host.capToday(), 3);
});

test('the day\'s message count survives a restart, starts again on another date, and an older file without it reads as 0', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i027-chats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mood-judge.json');
  await writeFile(file, JSON.stringify({ version: 1, enabled: true, day: '2026-11-06', count: 4 }));
  const old = new MoodJudgeStore({ file: () => file });
  await old.load();
  assert.equal(old.chatsToday('2026-11-06'), 0); assert.equal(old.today('2026-11-06'), 4);
  old.noteChat('2026-11-06'); old.noteChat('2026-11-06');
  await old.flush();
  const again = new MoodJudgeStore({ file: () => file });
  await again.load();
  assert.equal(again.chatsToday('2026-11-06'), 2); assert.equal(again.today('2026-11-06'), 4);
  again.noteChat('2026-11-07');
  assert.equal(again.chatsToday('2026-11-07'), 1); assert.equal(again.today('2026-11-07'), 0, 'a new date starts both counts again');
  assert.equal(again.chatsToday('2026-11-06'), 0);
  await again.flush();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['chats', 'count', 'day', 'enabled', 'version'], 'only numbers, never a message');
});
