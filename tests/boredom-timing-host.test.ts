/**
 * #8 on the real MoodHost (electron/mood.ts) with an isolated temporary profile: 20 rounds of "you answer her, then leave her
 * alone for an hour" with the old fixed timing (FixedBoredomTiming = the card's numbers, as before) and with her own timing
 * (BoredomTimingDirector). Every look / motion / speech the one-second tick issues is recorded. Also: never more motions or
 * speech than before, the speech cooldown and hourly limit untouched, the saved and shown parameters stay the card's, the
 * "why" is developer-only and never saved, the rate is never above the card's and a 在场 relief only moves the plan later.
 * BOREDOM_TIMING_REPORT=1 prints the 20 rounds before and after.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { IdleGestureDirector } from '../shared/behaviors/idle-gesture/choose';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { BOREDOM_TIMING_KNOBS, type BoredomTimingKnobs } from '../shared/behaviors/boredom-timing/knobs';
import type { BoredomKind, BoredomTimingHost, BoredomTimingNow } from '../shared/behaviors/boredom-timing/interface';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000;
const report = !!process.env.BOREDOM_TIMING_REPORT;
const STEP = 5_000; // the host counts a gap up to 5 s as online
type Cue = { kind: BoredomKind; at: number };

async function withHost(timing: BoredomTimingHost, card: MoodParameters, run: (context: { host: MoodHost; clock: { now: number }; cues: Cue[]; directory: string }) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-boredom-timing-'));
  const clock = { now: Date.UTC(2026, 10, 4, 15, 0, 0) };
  const cues: Cue[] = [], seen = new Set<string>();
  const host = new MoodHost(directory, view => {
    const cue = view.snapshot.cue;
    if (cue && (cue.kind === 'look' || cue.kind === 'motion' || cue.kind === 'speech') && !seen.has(cue.id)) { seen.add(cue.id); cues.push({ kind: cue.kind, at: cue.at }); }
  }, () => clock.now, { boredomTiming: timing, idleGesture: new IdleGestureDirector({ random: seeded(2), clock: () => clock.now }) });
  try {
    await host.load();
    host.activate('gene', structuredClone(card));
    await run({ host, clock, cues, directory });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
let chats = 0;
/** You answer her: a few short messages a second apart (her boredom goes back to 0, a new round begins at the last one). */
function answer(host: MoodHost, clock: { now: number }): number {
  for (let i = 0; i < 6; i++) { clock.now += 1_000; host.event({ type: 'chat', id: `chat-${++chats}`, reason: '收到用户聊天' }); }
  return clock.now;
}
function leaveAlone(host: MoodHost, clock: { now: number }, minutes: number): void {
  for (let t = 0; t < minutes * MINUTE; t += STEP) { clock.now += STEP; host.tick(true); }
}
/** 20 rounds of 75 minutes each: the minutes of each round's first look, motion and speech, and how many of each. */
async function twentyRounds(timing: BoredomTimingHost, card: MoodParameters = DEFAULT_MOOD_PARAMETERS) {
  const rounds: { first: Partial<Record<BoredomKind, number>>; count: Record<BoredomKind, number> }[] = [];
  let speeches: number[] = [], whyAfter = undefined as MoodView['boredomTimingWhy'], saved = '', shown = null as MoodParameters | null;
  await withHost(timing, card, async ({ host, clock, cues, directory }) => {
    host.setDeveloperMode(true);
    for (let round = 0; round < 20; round++) {
      const start = answer(host, clock), from = cues.length;
      leaveAlone(host, clock, 75);
      const mine = cues.slice(from), first: Partial<Record<BoredomKind, number>> = {};
      const count = { look: 0, motion: 0, speech: 0 };
      for (const cue of mine) { count[cue.kind]++; first[cue.kind] ??= Math.round((cue.at - start) / MINUTE * 1000) / 1000; }
      rounds.push({ first, count });
    }
    speeches = cues.filter(cue => cue.kind === 'speech').map(cue => cue.at);
    whyAfter = host.get().boredomTimingWhy;
    shown = host.get().parameters;
    await host.flush();
    saved = await readFile(path.join(directory, 'mood-state.json'), 'utf8');
  });
  return { rounds, speeches, whyAfter, saved, shown: shown! };
}

test('20 rounds on the real host: before, every round at the same minutes; now spread out, never twice in a row at the same moment, never more motion or speech', async () => {
  const before = await twentyRounds(new FixedBoredomTiming());
  const after = await twentyRounds(new BoredomTimingDirector({ random: seeded(20) }));
  const minutes = (run: typeof before, kind: BoredomKind) => run.rounds.map(round => round.first[kind]!);
  if (report) for (const [name, run] of [['before', before], ['after', after]] as const)
    for (const kind of ['look', 'motion', 'speech'] as const) console.log(`${name} ${kind}: ${minutes(run, kind).map(m => m?.toFixed(1) ?? '—').join(' ')}`);
  for (const kind of ['look', 'motion', 'speech'] as const) {
    const old = minutes(before, kind), now = minutes(after, kind);
    assert.equal(new Set(old).size, 1, `before: one moment for ${kind} (${old[0]})`);
    assert.ok(now.every(Number.isFinite), `${kind} happened every round`);
    assert.ok(new Set(now.map(m => m.toFixed(1))).size >= 15, `${kind}: ${now.join(' ')}`);
    for (let i = 1; i < now.length; i++)
      // Both moments land on the next 5 s tick (rounded to 0.001 min here), so the gap may look up to one tick shorter.
      assert.ok(Math.abs(now[i] - now[i - 1]) >= BOREDOM_TIMING_KNOBS.apartMinutes - STEP / MINUTE - 2e-3, `${kind} twice in a row: ${now[i - 1]} → ${now[i]}`);
  }
  assert.ok(minutes(before, 'look')[0] >= 20 && minutes(before, 'look')[0] < 20.1);
  assert.ok(minutes(after, 'motion').every(m => m >= 32.5) && minutes(after, 'speech').every(m => m >= 42.5), 'motion and speech never before the card');
  assert.ok(Math.min(...minutes(after, 'look')) < 20, 'a look can come earlier (no words, no model call)');
  // Never more motions or speech in any round (each is a chance for the inner loop to ask the model); looks may be more.
  after.rounds.forEach((round, i) => {
    assert.ok(round.count.motion <= before.rounds[i].count.motion, `round ${i}: ${round.count.motion} motions > ${before.rounds[i].count.motion}`);
    assert.ok(round.count.speech <= before.rounds[i].count.speech, `round ${i}: speech`);
  });
  // The speech cooldown and hourly limit (frequency) are the card's, untouched.
  for (const run of [before, after]) {
    for (let i = 1; i < run.speeches.length; i++) assert.ok(run.speeches[i] - run.speeches[i - 1] >= DEFAULT_MOOD_PARAMETERS.frequency.speechIntervalMs);
    for (const at of run.speeches) assert.ok(run.speeches.filter(other => other > at - 60 * MINUTE && other <= at).length <= DEFAULT_MOOD_PARAMETERS.frequency.speechPerHour);
  }
  // The why panel: this round first, then the last rounds; what happened agrees with the plan.
  const why = after.whyAfter!;
  if (report) for (const entry of why) console.log(`why: ${JSON.stringify(entry.plan)} ${JSON.stringify(entry.happened)} ${entry.why.join('；')}｜${entry.rules}（分量：${entry.weights}）`);
  assert.ok(why.length >= 2 && why[0].current && !why[1].current);
  for (const entry of why.slice(1)) for (const kind of ['look', 'motion', 'speech'] as const) {
    const plan = entry.plan[kind], happened = entry.happened[kind];
    if (plan !== null && happened !== undefined) assert.ok(happened >= plan - 0.05 && happened <= plan + STEP / MINUTE + 0.06, `${kind}: plan ${plan}, happened ${happened}`);
  }
  // What is saved and shown is the card, never this round's numbers; nothing of the why is saved.
  assert.deepEqual(after.shown, DEFAULT_MOOD_PARAMETERS);
  const file = JSON.parse(after.saved) as { profiles: { parameters: MoodParameters }[] };
  assert.deepEqual(file.profiles[0].parameters.boredom, DEFAULT_MOOD_PARAMETERS.boredom);
  for (const word of ['早一点', '照常', '慢一点', '避开', 'boredomTiming', '宽限']) assert.ok(!after.saved.includes(word), `saved file has no "${word}"`);
});

test('the why is developer-only; "此刻" is her mood, card personality and fatigue, read once per round', async () => {
  const seen: BoredomTimingNow[] = [];
  const director = new BoredomTimingDirector({ random: seeded(3) });
  const spy: BoredomTimingHost = {
    rules: (id, card, idle, now) => director.rules(id, card, idle, () => { const value = now(); if (value) seen.push(value); return value; }),
    happened: (...args) => director.happened(...args), relieved: id => director.relieved(id), recent: id => director.recent(id),
  };
  const card = structuredClone(DEFAULT_MOOD_PARAMETERS);
  card.weights.close = 2;
  await withHost(spy, card, ({ host, clock }) => {
    assert.equal(host.get().boredomTimingWhy, undefined, 'not in a normal view');
    host.setDeveloperMode(true);
    assert.ok(host.get().boredomTimingWhy!.length >= 1);
    host.setDeveloperMode(false);
    answer(host, clock);
    const rounds = seen.length;
    leaveAlone(host, clock, 2);
    assert.equal(seen.length, rounds, 'not read again within the round');
    const last = seen.at(-1)!;
    assert.equal(last.personality.close, 2);
    assert.equal(typeof last.mood, 'string');
    assert.deepEqual(last.moments, [], 'awake');
    assert.equal(host.get().boredomTimingWhy, undefined);
  });
});

test('a pace knob above 1 never makes her boredom rise faster than the card\'s; a 在场 relief mid-round changes no number, moves the plan later and says so', async () => {
  const eager: BoredomTimingKnobs = structuredClone(BOREDOM_TIMING_KNOBS) as BoredomTimingKnobs;
  (eager.tempos.usual as { base: number }).base = 0; (eager.tempos.unhurried as { base: number }).base = 0;
  (eager.tempos.eager as { pace: readonly number[] }).pace = [1.25, 1.25];
  await withHost(new BoredomTimingDirector({ random: seeded(6), knobs: eager }), DEFAULT_MOOD_PARAMETERS, ({ host, clock }) => {
    host.setDeveloperMode(true);
    answer(host, clock);
    leaveAlone(host, clock, 25);
    const before = host.get().boredomTimingWhy![0];
    assert.match(before.rules, /每分钟 \+2 /, `the card's rate (T-207 3B/3D): ${before.rules}`);
    assert.ok(before.plan.look! < 20, `the look comes earlier instead: ${before.plan.look}`);
    assert.ok(host.presence({ id: 'presence-1', relief: 15 }));
    const after = host.get().boredomTimingWhy![0];
    assert.equal(after.rules, before.rules, 'no number changes (T-207 3C: the gap between motion and speech stays)');
    assert.ok(after.why.some(line => line.includes('你回到电脑前')));
    assert.ok(after.plan.speech! > before.plan.speech!, `${before.plan.speech} → ${after.plan.speech}`);
    assert.ok(Math.abs((after.plan.speech! - after.plan.motion!) - (before.plan.speech! - before.plan.motion!)) <= 0.11, 'same gap');
  });
});
