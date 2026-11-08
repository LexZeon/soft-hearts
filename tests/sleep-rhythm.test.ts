// I-022 她不该一直困 (shared/behaviors/sleep-rhythm/, shared/fatigue.ts, electron/fatigue-host.ts): time off screen is rest, the night's
// sleep comes easier and goes deeper, and the day is exactly as before. The day is checked step by step against a frozen copy of the
// model as it was (tests/helpers/fatigue-before-i022.ts), so any change to the day's numbers fails here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acceptWakeEvent, advanceFatigue, createFatigue, DEFAULT_FATIGUE_PARAMETERS as P, fatigueSnapshot, fatigueTerms,
  type FatigueParameters, type FatiguePhase, type FatigueState, type SleepEntryBlockers } from '../shared/fatigue';
import * as OLD from './helpers/fatigue-before-i022';
import { SLEEP_RHYTHM_KNOBS } from '../shared/behaviors/sleep-rhythm/knobs';
import { nightAt, nightWindow, prepareSleepRhythm, sleepRhythmParameters } from '../shared/behaviors/sleep-rhythm/rhythm';
import { originalFatigueParameters } from '../shared/behaviors/sleep-rhythm/fake';
import { INNER_LOOP_REST_RECENT_MAX_MS, innerLoopNightWindow, innerLoopQuiet } from '../shared/inner-loop';
import { FatigueHost, type FatigueHostClock } from '../electron/fatigue-host';
import { MoodHost } from '../electron/mood';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const neutral = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const free: SleepEntryBlockers = Object.freeze({ chat: false, tts: false, manualMotion: false });
const wrapMinute = (m: number) => ((m % 1440) + 1440) % 1440;
/** A small deterministic random source (the same trace every run). */
const random = (seed: number) => () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };

// ------------------------------------------------------------------------------------------------ traces through both models

type Wake = 'physical' | 'direct-chat' | 'explicit-wake';
interface Step { dt: number; mode: 'active' | 'offline'; blockers: SleepEntryBlockers; wake?: Wake; channels: typeof neutral }
interface Model {
  create: (clock: { monotonicMs: number; localMinute: number }, initial: { A?: number; F?: number; W?: number; phase?: FatiguePhase }, p: any) => any;
  advance: (s: any, input: any, p: any) => any;
  accept: (s: any, event: any, p: any) => any;
}
const NEW: Model = { create: createFatigue, advance: advanceFatigue, accept: acceptWakeEvent };
const FROZEN: Model = { create: OLD.createFatigue, advance: OLD.advanceFatigue, accept: OLD.acceptWakeEvent };
const START_MONO = DAY;
/** I-022 alone (I-043 off): the clock still adds its own sleepiness and A builds at the same pace at every hour. */
const I022 = Object.freeze({ ...P, wakeRateDay: 1, wakeRateNight: 1, clockSleepWeight: P.clockWeight });

/** Runs the steps from `startMinute` (her local clock) and returns the state after every step. */
function run(model: Model, p: unknown, initial: { A?: number; F?: number; W?: number; phase?: FatiguePhase }, startMinute: number, steps: readonly Step[]) {
  let elapsed = 0, s = model.create({ monotonicMs: START_MONO, localMinute: startMinute }, initial, p);
  const out: any[] = [];
  steps.forEach((step, index) => {
    elapsed += step.dt;
    s = model.advance(s, { clock: { monotonicMs: START_MONO + elapsed, localMinute: wrapMinute(startMinute + elapsed / MINUTE) }, channels: step.channels,
      baseline: neutral, blockers: step.blockers, mode: step.mode }, p);
    if (step.wake) s = model.accept(s, { id: `evt-${index}`, kind: step.wake, acceptedAtMonotonicMs: s.monotonicMs }, p);
    out.push(s);
  });
  return out;
}
const COMPARED = ['A', 'F', 'W', 'phase', 'monotonicMs', 'localPhaseMs', 'phaseAgeMs', 'candidate', 'candidateAgeMs', 'wakeHoldMs', 'sleepEntryBlocked',
  'lastWakeAt', 'dedupWatermark'] as const;
const pick = (s: any) => Object.fromEntries(COMPARED.map(key => [key, s[key]]));

/** A busy, varied stretch: chats, pats, a reading aloud now and then, a manual motion, mood channels drifting; steps of 5 s. */
function variedSteps(minutes: number, seed: number, options: { chatEveryMinutes?: number; quietAfterMinutes?: number; neutral?: boolean } = {}): Step[] {
  const next = random(seed), steps: Step[] = [];
  let tts = 0, manual = 0;
  for (let t = 0; t < minutes * 60; t += 5) {
    const minute = t / 60, quiet = options.quietAfterMinutes !== undefined && minute >= options.quietAfterMinutes;
    if (!quiet && next() < 0.004) tts = 4 + Math.floor(next() * 6);
    if (!quiet && next() < 0.001) manual = 2;
    const blockers = { chat: !quiet && next() < 0.01, tts: tts-- > 0, manualMotion: manual-- > 0 };
    const every = options.chatEveryMinutes, chatDue = every !== undefined && t % (every * 60) === 0 && t > 0;
    const wake: Wake | undefined = quiet ? undefined : chatDue ? 'direct-chat' : next() < 0.002 ? 'physical' : next() < 0.0005 ? 'explicit-wake' : undefined;
    const drift = options.neutral ? 0 : Math.sin(t / 3_000) * 18;
    steps.push({ dt: 5_000, mode: 'active', blockers, ...(wake ? { wake } : {}), channels: { D: 50 + drift, O: 50 - drift / 2, E: 50 + drift / 3, N: 50 - drift, C: 50 + drift / 4 } });
  }
  return steps;
}

test('I-022 left the day unchanged (I-043 off): the same inputs give the same A, F, W and phase at every step as the model before I-022', () => {
  // 07:40 → 22:20, outside the night window (about 22:26–07:34), once fresh and once very tired (she naps and wakes in the day).
  const window = nightWindow(P);
  assert.ok(window.end < 7 * 60 + 40 && window.start > 22 * 60 + 20, `night window ${window.start}–${window.end}`);
  const phases = new Set<string>();
  for (const [initial, seed] of [[{ A: 0.3, F: 0.3 }, 7], [{ A: 0.92, F: 0.8 }, 11], [{ A: 0.6, F: 0.62, phase: 'drowsy' as const }, 23]] as const) {
    const steps = variedSteps(880, seed, { chatEveryMinutes: 37 });
    const now = run(NEW, I022, initial, 7 * 60 + 40, steps), before = run(FROZEN, OLD.DEFAULT_FATIGUE_PARAMETERS, initial, 7 * 60 + 40, steps);
    for (let i = 0; i < steps.length; i++) {
      assert.deepEqual(pick(now[i]), pick(before[i]), `step ${i} (${(i * 5 / 60).toFixed(1)} min) from ${JSON.stringify(initial)}`);
      phases.add(now[i].phase);
    }
  }
  for (const phase of ['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake']) assert.ok(phases.has(phase), `the day traces reach ${phase}`);
});

test('the fake rhythm is the old model everywhere: a day, an evening, 8 hours closed and a night, step by step', () => {
  const O = originalFatigueParameters(P), steps = [
    ...variedSteps(600, 3, { chatEveryMinutes: 25 }),
    { dt: 8 * HOUR, mode: 'offline' as const, blockers: free, channels: neutral },
    ...variedSteps(720, 5, { chatEveryMinutes: 50, quietAfterMinutes: 120 }),
  ];
  const now = run(NEW, O, { A: 0.7, F: 0.66, phase: 'drowsy' }, 13 * 60, steps), before = run(FROZEN, OLD.DEFAULT_FATIGUE_PARAMETERS, { A: 0.7, F: 0.66, phase: 'drowsy' }, 13 * 60, steps);
  for (let i = 0; i < steps.length; i++) assert.deepEqual(pick(now[i]), pick(before[i]), `step ${i}`);
});

test('at night while you are still with her (within 30 minutes) she falls asleep as before I-022 (I-043 off), so the rest reminder is untouched', () => {
  const steps = variedSteps(8 * 60, 13, { chatEveryMinutes: 10 });
  const now = run(NEW, I022, { A: 0.55, F: 0.55, phase: 'light-drowsy' }, 22 * 60 + 30, steps);
  const before = run(FROZEN, OLD.DEFAULT_FATIGUE_PARAMETERS, { A: 0.55, F: 0.55, phase: 'light-drowsy' }, 22 * 60 + 30, steps);
  let compared = 0;
  for (let i = 0; i < steps.length; i++) {
    // Once asleep a night's sleep goes deeper (that is the change); she falls asleep at the same step, and up to then every step is the same.
    if (now[i].phase === 'asleep' || before[i].phase === 'asleep') { assert.equal(now[i].phase, before[i].phase, `asleep at the same step ${i}`); break; }
    assert.deepEqual(pick(now[i]), pick(before[i]), `step ${i}`);
    compared++;
  }
  assert.ok(compared > 1000, `compared ${compared} night steps`);
  // The rule that protects it: "you are still up" for the reminder is at most 30 minutes; the night thresholds wait at least that long.
  assert.ok(P.nightQuietMs >= INNER_LOOP_REST_RECENT_MAX_MS);
  const rules = prepareSleepRhythm(P).rules(true, P.nightQuietMs - 1);
  assert.equal(rules.sleepEnter, P.sleepEnter); assert.equal(rules.sleepExit, P.sleepExit);
});

test('a night with nobody around: she really falls asleep, sleeps through, and wakes in the morning with most of the sleep pressure gone', () => {
  // A normal day from 08:00 (rested), you chat every 20 minutes until 23:00, then leave her alone until 09:00.
  const steps = variedSteps(25 * 60, 17, { chatEveryMinutes: 20, quietAfterMinutes: 15 * 60, neutral: true });
  const now = run(NEW, P, { A: 0.1, F: 0.15 }, 8 * 60, steps), before = run(FROZEN, OLD.DEFAULT_FATIGUE_PARAMETERS, { A: 0.1, F: 0.15 }, 8 * 60, steps);
  const at = (hh: number, mm = 0) => Math.round(((hh < 8 ? hh + 24 : hh) * 60 + mm - 8 * 60) * 60 / 5) - 1;
  const asleepAt = now.findIndex((s, i) => i > at(23) && s.phase === 'asleep');
  // I-043: the day builds slowly, so she is not asleep before midnight; after midnight it builds fast and she sleeps by 03:00.
  assert.ok(asleepAt > at(0) && asleepAt < at(3), `asleep at step ${asleepAt} (00:00 is ${at(0)}, 03:00 is ${at(3)})`);
  const lastTouch = steps.slice(0, asleepAt).map(step => !!step.wake).lastIndexOf(true);
  assert.ok((asleepAt - lastTouch) * 5_000 >= P.nightQuietMs, 'only after you had left her alone for 30 minutes');
  assert.ok(now[asleepAt].F < P.sleepEnter, 'she fell asleep below the day threshold, through the night one');
  assert.equal(before[at(1)].phase === 'asleep', false, 'the old model was still up at 01:00 (the change matters)');
  for (let i = asleepAt; i <= at(7, 30); i++) assert.equal(now[i].phase, 'asleep', `she sleeps through (step ${i})`);
  const morning = now[at(7, 50)];
  assert.equal(morning.phase, 'awake', 'awake soon after the night ends');
  assert.ok(morning.A <= 0.05 && morning.F <= 0.2, `rested: A ${morning.A.toFixed(3)}, F ${morning.F.toFixed(3)}`);
  assert.ok(before[at(7, 50)].A > 4 * morning.A, // I-043: she falls asleep later, so a little more is left than with I-022 alone (it was 5×)
    `the old model was left with much more: A ${before[at(7, 50)].A.toFixed(3)}`);
  // Asleep, nobody speaks (electron/inner-loop/claim.ts reads exactly this; tests/quiet-when-asleep.test.ts covers the claim).
  assert.equal(innerLoopQuiet({ phase: now[at(2)].phase, localMinute: 120 }).asleep, true);

  // A touch at 02:00 still stirs her, chats wake her, "叫醒" wakes her: the wake rules are as they were.
  const two = now[at(2)];
  const touched = acceptWakeEvent(two, { id: 'touch', kind: 'physical', acceptedAtMonotonicMs: two.monotonicMs });
  assert.equal(touched.phase, 'micro-awake'); assert.equal(fatigueSnapshot(touched).gazeAllowed, false);
  let chatted = two;
  for (let i = 0; i < 4 && chatted.phase !== 'awake'; i++) {
    chatted = advanceFatigue(chatted, { clock: { monotonicMs: chatted.monotonicMs + 1_100, localMinute: 120 }, channels: neutral, baseline: neutral, blockers: free, mode: 'active' });
    chatted = acceptWakeEvent(chatted, { id: `chat-${i}`, kind: 'direct-chat', acceptedAtMonotonicMs: chatted.monotonicMs });
  }
  assert.equal(chatted.phase, 'awake');
  assert.equal(acceptWakeEvent(two, { id: 'wake', kind: 'explicit-wake', acceptedAtMonotonicMs: two.monotonicMs }).phase, 'awake');
});

test('off screen is rest: closed 10 minutes, 2 hours, 8 hours and 3 days (A 0.75, F 0.69, as on 11-04 at 10:30)', () => {
  const closed = (hours: number, fromMinute: number, p: FatigueParameters = P) => {
    const ms = hours * HOUR, counted = Math.min(ms, p.maxOfflineMs);
    let s = createFatigue({ monotonicMs: 3 * DAY - counted, localMinute: wrapMinute(fromMinute + (ms - counted) / MINUTE) }, { A: 0.75, F: 0.69 }, p);
    s = advanceFatigue(s, { clock: { monotonicMs: 3 * DAY, localMinute: wrapMinute(fromMinute + ms / MINUTE) }, channels: neutral, baseline: neutral, blockers: free, mode: 'offline' }, p);
    return s;
  };
  const tenDay = closed(1 / 6, 14 * 60), tenNight = closed(1 / 6, 0), twoDay = closed(2, 14 * 60), twoNight = closed(2, 23 * 60);
  const night = closed(8, 23 * 60), work = closed(8, 9 * 60), days = closed(72, 23 * 60), oneDay = closed(24, 23 * 60);
  assert.ok(tenDay.A > 0.72 && tenDay.A < 0.75, `10 minutes in the day: only a little (${tenDay.A})`);
  assert.ok(tenNight.A > 0.68 && tenNight.A < tenDay.A, `10 minutes at night: a little more (${tenNight.A})`);
  assert.ok(twoDay.A > 0.5 && twoDay.A < 0.6, `2 hours in the day: about half a nap (${twoDay.A})`);
  assert.ok(twoNight.A < 0.3, `2 hours at night: a real sleep (${twoNight.A})`);
  assert.ok(night.A < 0.03 && night.F < 0.15, `8 hours overnight: awake and clear (${night.A}, ${night.F})`);
  assert.ok(work.A < 0.22, `8 hours closed in the day (at work): rested (${work.A})`);
  assert.equal(days.A, oneDay.A, '3 days count as the longest rest, 24 hours');
  assert.ok(days.A < 0.01);
  // Before I-022 nothing of this was rest: the same closings leave A and F exactly as they were.
  for (const hours of [1 / 6, 2, 8, 72]) { const old = closed(hours, 23 * 60, originalFatigueParameters(P)); assert.equal(old.A, 0.75); assert.equal(old.F, 0.69); }
});

test('the knobs are the only source of the rhythm, and changing one knob changes one parameter', () => {
  const fields = sleepRhythmParameters();
  for (const [key, value] of Object.entries(fields)) assert.equal(P[key as keyof FatigueParameters], value, key);
  assert.equal(P.maxOfflineMs, SLEEP_RHYTHM_KNOBS.offline.longestRestHours * HOUR);
  assert.equal(P.offlineVirtualRest, true);
  const changed = sleepRhythmParameters({ ...SLEEP_RHYTHM_KNOBS, night: { ...SLEEP_RHYTHM_KNOBS.night, restSpeed: 2 } });
  const differing = Object.keys(fields).filter(key => (changed as any)[key] !== (fields as any)[key]);
  assert.deepEqual(differing, ['nightRestScale']);
  // A changed knob takes effect: a deeper night's sleep leaves less pressure after the same 2 hours closed at night.
  const twoHours = (p: FatigueParameters) => advanceFatigue(createFatigue({ monotonicMs: DAY - 2 * HOUR, localMinute: 0 }, { A: 0.7 }, p),
    { clock: { monotonicMs: DAY, localMinute: 120 }, channels: neutral, baseline: neutral, blockers: free, mode: 'offline' }, p).A;
  assert.ok(twoHours({ ...P, ...changed }) < twoHours(P));
  // Unsafe values are refused instead of quietly used.
  for (const patch of [{ nightSleepEnter: 0.5 }, { nightSleepEnter: 0.8 }, { nightSleepExit: 0.7 }, { nightRestScale: 9 }, { offlineNightRestQuality: 2 },
    { nightRecoveredA: 0.5 }, { maxOfflineMs: 3 * DAY }]) assert.throws(() => createFatigue({ monotonicMs: 0, localMinute: 0 }, {}, { ...P, ...patch }), JSON.stringify(patch));
});

test('her night is the inner loop\'s night: one window', () => {
  assert.deepEqual(innerLoopNightWindow(P), nightWindow(P));
  for (let minute = 0; minute < 1440; minute += 7) assert.equal(innerLoopQuiet({ localMinute: minute }).night, nightAt(minute, P), String(minute));
  assert.equal(nightAt(NaN, P), false);
});

// ------------------------------------------------------------------------------------------------ the host

/** A host clock with its own "local midnight", so the tests do not depend on the machine's time zone. */
function hostClock(startWall: number, midnight: number) {
  let mono = 5_000, wall = startWall;
  const clock: FatigueHostClock = { monotonicMs: () => mono, wallMs: () => wall, localMinute: w => wrapMinute((w - midnight) / MINUTE) };
  return { clock, step: (ms: number) => { mono += ms; wall += ms; }, jumpWall: (ms: number) => { wall += ms; }, jumpMono: (ms: number) => { mono += ms; }, wall: () => wall };
}
async function profileDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'soft-hearts-sleep-rhythm-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(tmpdir())); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
const MIDNIGHT = Date.UTC(2026, 10, 4, 0, 0, 0);
async function seed(dir: string, wallMs: number, profile: { A: number; F: number; W?: number; phase?: FatiguePhase } = { A: 0.75, F: 0.69 }, id = 'mira') {
  await writeFile(path.join(dir, 'fatigue-state.json'), JSON.stringify({ version: 1, profiles: [{ characterId: id, A: profile.A, F: profile.F, W: profile.W ?? 0, phase: profile.phase ?? 'drowsy', wallMs }] }));
}

test('host: the closed time from the previous run is the rest she gets, the same number, once, with a note for the developer panel', async t => {
  const dir = await profileDir(t), stopAt = MIDNIGHT - HOUR, c = hostClock(stopAt + 8 * HOUR, MIDNIGHT); // 23:00 → 07:00
  await seed(dir, stopAt);
  const host = new FatigueHost(dir, c.clock); await host.load();
  host.setLastStop({ characterId: 'mira', closedMs: 8 * HOUR, exact: true });
  const view = host.activate('mira', neutral, neutral);
  assert.ok(view.A < 0.03, `8 hours closed overnight: A ${view.A}`);
  assert.equal(view.phase, 'drowsy', 'closed never changes what she shows');
  const note = host.restNote('mira')!;
  assert.equal(note.kind, 'closed'); assert.equal(note.awayMs, 8 * HOUR); assert.equal(note.countedMs, 8 * HOUR); assert.equal(note.exact, true);
  assert.equal(note.before.A, 0.75); assert.equal(note.after.A, view.A);
  // Back on screen she wakes up within a couple of minutes (drowsy → light → awake), rested.
  host.setBlockers(free);
  for (let i = 0; i < 180; i++) { c.step(1_000); host.update('mira', neutral, neutral); }
  assert.equal(host.view('mira')!.phase, 'awake');
});

test('host: an estimate (上次没正常退出) is marked, a clock that went back is no rest, another character counts from its own save', async t => {
  const dir = await profileDir(t), stopAt = MIDNIGHT + 14 * HOUR, c = hostClock(stopAt + 2 * HOUR, MIDNIGHT);
  await writeFile(path.join(dir, 'fatigue-state.json'), JSON.stringify({ version: 1, profiles: [
    { characterId: 'mira', A: 0.75, F: 0.69, W: 0, phase: 'awake', wallMs: stopAt },
    { characterId: 'gene', A: 0.75, F: 0.69, W: 0, phase: 'awake', wallMs: stopAt - 6 * HOUR }] }));
  const estimated = new FatigueHost(dir, c.clock); await estimated.load();
  estimated.setLastStop({ characterId: 'mira', closedMs: 2 * HOUR, exact: false });
  estimated.activate('mira', neutral, neutral);
  assert.equal(estimated.restNote('mira')!.exact, false);
  // gene was not the one on screen: her own last save (8 hours ago) counts, not the app's 2 hours.
  const gene = estimated.activate('gene', neutral, neutral);
  assert.equal(estimated.restNote('gene')!.kind, 'away'); assert.equal(estimated.restNote('gene')!.awayMs, 8 * HOUR);
  assert.ok(gene.A < estimated.view('mira')!.A);

  const back = new FatigueHost(dir, c.clock); await back.load();
  back.setLastStop({ characterId: 'mira', closedMs: 0, exact: true }); // the clock is earlier than the stop: closedSpan gives 0
  assert.equal(back.activate('mira', neutral, neutral).A, 0.75);
});

test('host: the computer asleep with the app open counts as rest; a changed system clock does not', async t => {
  const dir = await profileDir(t), c = hostClock(MIDNIGHT - 30 * MINUTE, MIDNIGHT); // 23:30
  await seed(dir, c.wall(), { A: 0.7, F: 0.66, phase: 'awake' });
  const host = new FatigueHost(dir, c.clock); await host.load(); host.setBlockers(free);
  host.activate('mira', neutral, neutral);
  assert.equal(host.restNote('mira'), undefined, 'no time off screen yet');
  // The computer sleeps 7 hours (23:30 → 06:30): both clocks jump. That counts as rest, a night's.
  c.step(7 * HOUR); host.update('mira', neutral, neutral);
  const note = host.restNote('mira')!;
  assert.equal(note.kind, 'paused'); assert.equal(note.awayMs, 7 * HOUR); assert.equal(note.before.A, 0.7);
  assert.ok(host.view('mira')!.A < 0.05, `rested after the night asleep: ${host.view('mira')!.A}`);
  // Someone sets the system clock 7 hours ahead: only the wall clock moves. No rest; a second of being awake.
  const before = host.view('mira')!.A;
  c.jumpWall(7 * HOUR); c.step(1_000); host.update('mira', neutral, neutral);
  assert.ok(host.view('mira')!.A >= before, 'no rest from a changed clock'); assert.equal(host.restNote('mira'), note);
  // The shorter of the two clocks counts: a wall clock that moved less than the monotonic one limits it.
  c.jumpMono(2 * HOUR); c.jumpWall(30 * MINUTE); host.update('mira', neutral, neutral);
  assert.equal(host.restNote('mira')!.awayMs, 30 * MINUTE);
  // A clock that went back is no pause at all.
  const last = host.restNote('mira');
  c.jumpWall(-3 * HOUR); c.jumpMono(5 * MINUTE); host.update('mira', neutral, neutral);
  assert.equal(host.restNote('mira'), last, 'the note is still the last real pause');
});

test('MoodHost: the developer panel sees the rest only in developer mode', async t => {
  const dir = await profileDir(t), stopAt = MIDNIGHT + 9 * HOUR, c = hostClock(stopAt + 3 * HOUR, MIDNIGHT);
  await seed(dir, stopAt, { A: 0.75, F: 0.69 }, 'gene');
  const mood = new MoodHost(dir, () => {}, c.wall, { fatigueClock: c.clock });
  try {
    await mood.load();
    mood.noteLastStop({ at: stopAt, closedMs: 3 * HOUR, exact: true, cause: 'tray', characterId: 'gene', clockBack: false });
    mood.activate('gene');
    assert.equal(mood.get().fatigue?.rest, undefined, 'not in developer mode');
    mood.setDeveloperMode(true);
    const rest = mood.get().fatigue?.rest;
    assert.equal(rest?.kind, 'closed'); assert.equal(rest?.awayMs, 3 * HOUR); assert.ok(rest!.after.A < rest!.before.A);
  } finally { await mood.flush().catch(() => {}); }
});

test('the day state still advances in the same 1-second steps (no coarser offline shortcut changed it)', () => {
  // Fine and coarse partitions of an awake stretch agree, as before.
  const s: FatigueState = createFatigue({ monotonicMs: 0, localMinute: 600 }, { A: 0.4, F: 0.4 });
  let fine = s; for (let i = 0; i < 60; i++) fine = advanceFatigue(fine, { clock: { monotonicMs: (i + 1) * 1_000, localMinute: 600 + (i + 1) / 60 }, channels: neutral, baseline: neutral, blockers: free, mode: 'active' });
  const coarse = advanceFatigue(s, { clock: { monotonicMs: 60_000, localMinute: 601 }, channels: neutral, baseline: neutral, blockers: free, mode: 'active' });
  assert.ok(Math.abs(fine.A - coarse.A) < 1e-12); assert.ok(Math.abs(fine.F - coarse.F) < 1e-5);
});

test('I-043: the clock adds no sleepiness of its own; it sets how fast it builds (day slow, after midnight fast)', () => {
  assert.equal(P.clockSleepWeight, 0);
  const state = createFatigue({ monotonicMs: START_MONO, localMinute: 180 }, { A: 0.4, F: 0.35 });
  assert.equal(fatigueTerms(state, { clock: { monotonicMs: START_MONO, localMinute: 180 }, channels: neutral, baseline: neutral, blockers: free, mode: 'active' }).clock, 0, '03:00 adds nothing by itself');
  const rate = (hh: number, mm = 0) => prepareSleepRhythm(P).wakeRate((hh * 60 + mm) * MINUTE);
  assert.equal(rate(12), SLEEP_RHYTHM_KNOBS.wake.dayRate); assert.equal(rate(20, 59), SLEEP_RHYTHM_KNOBS.wake.dayRate);
  assert.ok(rate(22, 30) > rate(21, 30) && rate(22, 30) < SLEEP_RHYTHM_KNOBS.wake.nightRate, 'speeding up from 21:00');
  assert.equal(rate(0), SLEEP_RHYTHM_KNOBS.wake.nightRate); assert.equal(rate(4, 59), SLEEP_RHYTHM_KNOBS.wake.nightRate);
  assert.ok(rate(6, 30) < SLEEP_RHYTHM_KNOBS.wake.nightRate && rate(6, 30) > SLEEP_RHYTHM_KNOBS.wake.dayRate, 'slowing down from 05:00');
  assert.equal(rate(8), SLEEP_RHYTHM_KNOBS.wake.dayRate);
  // The same awake state an hour later: at noon it builds at the day pace, after midnight at the night pace.
  const hour = (minute: number) => run(NEW, P, { A: 0.4, F: 0.35 }, minute, variedSteps(60, 5, { neutral: true })).at(-1)!;
  assert.ok(hour(0).A - 0.4 > 4 * (hour(12 * 60).A - 0.4), 'after midnight it builds several times faster than at noon');
});

test('I-043: a rested day from 08:00 with you chatting every 20 minutes: not even a little sleepy before 21:00, sleepy only after midnight', () => {
  const steps = variedSteps(18 * 60, 29, { chatEveryMinutes: 20, neutral: true });
  const day = run(NEW, P, { A: 0.1, F: 0.15 }, 8 * 60, steps);
  const at = (hh: number, mm = 0) => Math.round((hh * 60 + mm - 8 * 60) * 60 / 5) - 1;
  for (let i = 0; i <= at(21); i++) assert.equal(day[i].phase, 'awake', `awake all day (step ${i})`);
  assert.ok(day[at(23, 59)].F < P.drowsyEnter, `not yet 困 at 23:59: F ${day[at(23, 59)].F.toFixed(2)}`);
});
