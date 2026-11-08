/**
 * I-006 第 1 步 "陪你做事" (shared/behaviors/user-activity/, electron/user-activity.ts; docs/claude/2026-11-06-i006-step1.md).
 * Fake clock and fake idle seconds only: nothing here reads this computer's real keyboard and mouse.
 *  - the state: 30 s of reading does not leave "在忙", a lock is "不在", a failed read is "说不准" and starts nothing, a long silence without a
 *    lock is "说不准" (never "不在"), working in her own window is looking for her, not being busy;
 *  - her side: one simulated hour on the real MoodHost (busy speaks clearly less, the three personalities lean the right way), the
 *    opening choice leans toward 这次不说 while strong feelings still speak, her own life weighs and lasts longer, one short line;
 *  - privacy: switch off = not one read, the config folder gets no extra file, nothing but the switch is ever written, no timers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { MoodHost } from '../electron/mood';
import { createUserActivity } from '../electron/user-activity';
import { createHerState, StageStateHost } from '../electron/her-state-host';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters, type MoodTendency } from '../shared/mood';
import { UserActivityTracker } from '../shared/behaviors/user-activity/track';
import { BUSY_ACTIVITY, FixedUserActivity, PAUSE_ACTIVITY } from '../shared/behaviors/user-activity/fake';
import { UNKNOWN_ACTIVITY, type UserActivityHost, type UserActivitySample, type UserActivityView } from '../shared/behaviors/user-activity/interface';
import { USER_ACTIVITY_KNOBS } from '../shared/behaviors/user-activity/knobs';
import { herLifeBusy, quietPace, userActivityKey, userActivitySentence, userIsBusy } from '../shared/behaviors/user-activity/effects';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { IdleGestureDirector } from '../shared/behaviors/idle-gesture/choose';
import { OPENING_CANDIDATE_IDS } from '../shared/behaviors/opening-choice/knobs';
import { chooseOpening, openingNow } from '../shared/behaviors/opening-choice/choose';
import { createMoodState, getMoodSnapshot, type MoodLabel } from '../shared/mood';
import { HER_LIFE_TABLE, herLifeDuration, herLifeWeights, stepHerLife, type HerLifeRecord } from '../shared/her-life';
import { buildInnerLoopPrompt, type InnerLoopPromptInput } from '../shared/inner-loop';
import { PERCEPTION_LINE_MAX, perceptionTurnLine, type PerceptionTurn } from '../shared/perception-rule';
import { buildTestEntries } from '../electron/test-commands/entries';
import { matchTestEntry } from '../electron/test-commands/match';
import { fakeTestDeps as makeDeps } from './helpers/test-command-fixtures';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000, SECOND = 1_000;
const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);

/** Drive a tracker second by second: `idle(t)` = seconds since the last input at second t of the script. */
function drive(host: UserActivityHost, from: number, seconds: number, read: (second: number) => Partial<UserActivitySample> & { idleSeconds: number | null }): UserActivityView {
  let view: UserActivityView = host.view(from);
  for (let s = 1; s <= seconds; s++) view = host.tick({ now: from + s * SECOND, locked: false, asleep: false, windowFocused: false, ...read(s) });
  return view;
}
/** The user types and moves the mouse the whole time. */
const working = () => ({ idleSeconds: 0 });

test('typing for a few minutes: not yet busy; at about six minutes busy; focus full at ten', () => {
  const tracker = new UserActivityTracker();
  assert.equal(drive(tracker, T0, 3 * 60, working).state, 'unknown');
  assert.ok(drive(tracker, T0 + 3 * MINUTE, 0, working).focus > 0.25 && tracker.view().focus < 0.35, 'focus rises on its own meanwhile');
  assert.equal(drive(tracker, T0 + 3 * MINUTE, 3.5 * 60, working).state, 'busy');
  const full = drive(tracker, T0 + 6.5 * MINUTE, 4 * 60, working);
  assert.equal(full.state, 'busy'); assert.ok(full.focus > 0.99);
  assert.ok(full.busyMinutes > 10 && full.busyMinutes < 11, `${full.busyMinutes}`);
});

test('thirty seconds of reading does not leave "在忙"; neither does a half-minute stare in the middle of typing', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 12 * 60, working);
  assert.equal(tracker.view().state, 'busy');
  // Idle 1..45 s, then typing again.
  const during = drive(tracker, T0 + 12 * MINUTE, 45, s => ({ idleSeconds: s }));
  assert.equal(during.state, 'busy', 'still busy 45 s into the pause');
  const after = drive(tracker, T0 + 12 * MINUTE + 45 * SECOND, 20, working);
  assert.equal(after.state, 'busy');
  // And before the fix there was no state at all: a naive "idle > 0 means not busy" would fail this.
  assert.ok(after.focus > 0.95);
});

test('a one-to-three minute pause after a long stretch is "歇一下", once per stretch; typing ends it', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 12 * 60, working);
  const t1 = T0 + 12 * MINUTE;
  const still = drive(tracker, t1, 75, s => ({ idleSeconds: s }));
  assert.equal(still.state, 'pause'); assert.equal(still.cause, 'idle'); assert.ok(still.busyMinutes > 11);
  const typing = drive(tracker, t1 + 75 * SECOND, 5, working);
  assert.equal(typing.state, 'busy', 'one key press ends the pause');
  // The same stretch rests only once.
  const second = drive(tracker, t1 + 80 * SECOND, 120, s => ({ idleSeconds: s }));
  assert.notEqual(second.state, 'pause');
});

test('a pause ends by itself after five minutes, and a short stretch has no pause at all', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 12 * 60, working);
  const t1 = T0 + 12 * MINUTE;
  assert.equal(drive(tracker, t1, 61, s => ({ idleSeconds: s })).state, 'pause');
  assert.notEqual(drive(tracker, t1 + 61 * SECOND, 5 * 60, s => ({ idleSeconds: 61 + s })).state, 'pause');
  const shortOne = new UserActivityTracker();
  drive(shortOne, T0, 5 * 60, working);
  assert.notEqual(drive(shortOne, T0 + 5 * MINUTE, 120, s => ({ idleSeconds: s })).state, 'pause', 'five minutes of work is no stretch worth a rest');
});

test('turning to her after being busy is a rest of its own ("转过来找她"): working in her own window does not count as busy', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 8 * 60, working);
  assert.equal(tracker.view().state, 'busy');
  const came = drive(tracker, T0 + 8 * MINUTE, 3, () => ({ idleSeconds: 0, windowFocused: true }));
  assert.equal(came.state, 'pause'); assert.equal(came.cause, 'came');
  // An hour of typing in her chat never makes the user "busy".
  const chatting = new UserActivityTracker();
  assert.equal(drive(chatting, T0, 60 * 60, () => ({ idleSeconds: 0, windowFocused: true })).state, 'unknown');
  assert.equal(chatting.view().focus, 0);
});

test('lock and sleep are "不在"; coming back is "说不准", not busy', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 12 * 60, working);
  const locked = drive(tracker, T0 + 12 * MINUTE, 10, () => ({ idleSeconds: 600, locked: true }));
  assert.equal(locked.state, 'away');
  assert.equal(drive(tracker, T0 + 12 * MINUTE + 10 * SECOND, 10, () => ({ idleSeconds: 600, asleep: true })).state, 'away');
  const back = drive(tracker, T0 + 12 * MINUTE + 20 * SECOND, 1, () => ({ idleSeconds: 0 }));
  assert.equal(back.state, 'unknown'); assert.equal(back.focus < 0.01, true, 'the old focus did not survive the lock');
});

test('a long silence without a lock is "说不准" and never "不在" (no "还在吗")', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 12 * 60, working);
  const gone = drive(tracker, T0 + 12 * MINUTE, 3 * 60 * 60, s => ({ idleSeconds: s }));
  assert.equal(gone.state, 'unknown');
  assert.equal(gone.focus, 0);
});

test('a failed or nonsense read is "说不准" and forgets: it can never start a quiet', () => {
  const tracker = new UserActivityTracker();
  drive(tracker, T0, 12 * 60, working);
  for (const bad of [null, Number.NaN, -3, Infinity]) {
    const view = drive(tracker, T0 + 12 * MINUTE, 1, () => ({ idleSeconds: bad as number | null }));
    assert.deepEqual(view, UNKNOWN_ACTIVITY);
  }
  assert.equal(quietPace(tracker.view(), {}), 1, 'no slowing from a failed read');
  assert.equal(drive(tracker, T0 + 13 * MINUTE, 1, working).state, 'unknown', 'and the stretch starts over');
});

test('a clock jump (sleep, a stalled timer) counts as one short step, never a full minute of focus', () => {
  const tracker = new UserActivityTracker();
  tracker.tick({ now: T0, idleSeconds: 0, locked: false, asleep: false, windowFocused: false });
  const view = tracker.tick({ now: T0 + 2 * 60 * 60_000, idleSeconds: 0, locked: false, asleep: false, windowFocused: false });
  assert.ok(view.focus < 0.01, `${view.focus}`);
});

test('pretend: busy / pause show at once, read nothing real, and end by themselves or when cancelled', () => {
  const tracker = new UserActivityTracker();
  tracker.pretend('busy', T0);
  assert.equal(tracker.pretending(T0 + MINUTE), true);
  const during = tracker.tick({ now: T0 + MINUTE, idleSeconds: 9999, locked: true, asleep: true, windowFocused: false });
  assert.equal(during.state, 'busy', 'a real lock does not disturb a pretence');
  assert.equal(tracker.view(T0 + 11 * MINUTE).state, 'unknown', 'it ends after the pretend minutes');
  tracker.pretend('pause', T0);
  assert.equal(tracker.view(T0 + MINUTE).state, 'pause');
  tracker.pretend(null, T0);
  assert.equal(tracker.view(T0 + MINUTE).state, 'unknown');
});

// ----------------------------------------------------------------------------------------------------------------- the host

function hostWith(over: Partial<Parameters<typeof createUserActivity>[0]> = {}) {
  const clock = { now: T0 };
  const reads = { idle: 0, focus: 0, idleValue: 0 as number | (() => number) };
  const listeners = new Map<string, () => void>();
  const host = createUserActivity({
    directory: () => null, clock: () => clock.now,
    idleSeconds: () => { reads.idle++; const v = reads.idleValue; return typeof v === 'function' ? v() : v; },
    windowFocused: () => { reads.focus++; return false; },
    power: { on: (event, listener) => { listeners.set(event, listener); } },
    ...over,
  });
  const run = (seconds: number) => { let view = host.view(); for (let i = 0; i < seconds; i++) { clock.now += SECOND; view = host.tick(); } return view; };
  return { host, clock, reads, listeners, run };
}

test('the switch off: not one read in a thousand ticks, lock and sleep events ignored, always "说不准"', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-'));
  try {
    const h = hostWith({ directory: () => dir });
    h.host.setEnabled(false);
    await h.host.flush();
    h.listeners.get('lock-screen')?.(); h.listeners.get('suspend')?.();
    assert.equal(h.run(1000).state, 'unknown');
    assert.equal(h.reads.idle, 0, 'getSystemIdleTime was never called');
    assert.equal(h.reads.focus, 0, 'and the window focus was not asked either');
    assert.equal(h.host.pretend('busy'), false, 'a test command cannot pretend while the switch is off');
    assert.equal(h.host.view().state, 'unknown');
    // Reload: the saved off survives.
    const again = hostWith({ directory: () => dir });
    await again.host.load();
    assert.equal(again.host.switchView().enabled, false);
    assert.equal(again.run(10).state, 'unknown'); assert.equal(again.reads.idle, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the switch on: one read per tick, nothing from outside the existing second tick, no read while pretending', () => {
  const h = hostWith();
  h.run(60);
  assert.equal(h.reads.idle, 60);
  assert.equal(h.host.pretend('busy'), true);
  h.run(30);
  assert.equal(h.reads.idle, 60, 'no read while a test command pretends');
  assert.equal(h.host.view().state, 'busy');
});

test('the host: lock then unlock, a throwing read, the window with the focus', () => {
  const h = hostWith();
  h.reads.idleValue = 0;
  h.run(12 * 60);
  assert.equal(h.host.view().state, 'busy');
  h.listeners.get('lock-screen')?.();
  assert.equal(h.run(2).state, 'away');
  h.listeners.get('unlock-screen')?.();
  assert.equal(h.run(2).state, 'unknown');
  h.reads.idleValue = () => { throw new Error('no idle time on this computer'); };
  assert.equal(h.run(5).state, 'unknown', 'a throwing read is 说不准');
  h.reads.idleValue = 0;
  assert.equal(h.run(5).state, 'unknown');
});

test('config folder: ticks write nothing; turning the switch off writes exactly one small file and no activity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-'));
  try {
    const h = hostWith({ directory: () => dir });
    h.run(20 * 60);
    await h.host.flush();
    assert.deepEqual(await readdir(dir), [], 'an hour-ish of ticks left no file');
    h.host.setEnabled(false);
    await h.host.flush();
    assert.deepEqual(await readdir(dir), ['user-activity.json']);
    const saved = await readFile(path.join(dir, 'user-activity.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved), { version: 1, enabled: false });
    assert.ok(!/focus|busy|idle|minutes|since/i.test(saved), 'only the switch');
    assert.throws(() => h.host.setEnabled('yes' as never));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('no timers, no files, no network anywhere in the feature (static check of its own sources)', async () => {
  for (const file of ['shared/behaviors/user-activity/track.ts', 'shared/behaviors/user-activity/effects.ts', 'shared/behaviors/user-activity/interface.ts',
    'shared/behaviors/user-activity/fake.ts', 'shared/behaviors/user-activity/knobs.ts']) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8');
    assert.ok(!/setInterval|setTimeout|node:fs|node:net|node:http|fetch\(|electron/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), file);
  }
  const host = (await readFile(path.join(process.cwd(), 'electron/user-activity.ts'), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/setInterval|setTimeout/.test(host), 'the host has no timer of its own: it is called from the existing second tick');
  assert.ok(!/from 'electron'/.test(host));
});

// ----------------------------------------------------------------------------------------------------------------- effects

const personalities: Record<string, Partial<Record<MoodTendency, number>>> = {
  average: {}, clingy: { close: 2 }, slowToWarm: { cautious: 2 }, easygoing: { comfortable: 2 },
};

test('quietPace: never above 1, falls with focus, clingy < average? no: clingy slows least, slow-to-warm and easygoing slow most', () => {
  const full = { focus: 1 };
  for (const [name, weights] of Object.entries(personalities)) {
    for (const focus of [0, 0.2, 0.6, 1]) { const pace = quietPace({ focus }, weights); assert.ok(pace > 0 && pace <= 1, `${name} ${focus} ${pace}`); }
    assert.equal(quietPace({ focus: 0 }, weights), 1);
  }
  assert.ok(quietPace(full, personalities.clingy) > quietPace(full, personalities.average));
  assert.ok(quietPace(full, personalities.average) > quietPace(full, personalities.easygoing));
  assert.ok(quietPace(full, personalities.easygoing) >= quietPace(full, personalities.slowToWarm) - 1e-9);
  assert.equal(quietPace(null, {}), 1); assert.equal(quietPace({ focus: Number.NaN }, {}), 1);
  // Even absurd weights stay inside the knob range.
  assert.ok(quietPace(full, { close: 4, playful: 4, cautious: 0 }) <= USER_ACTIVITY_KNOBS.quiet.max);
  assert.ok(quietPace(full, { cautious: 4, comfortable: 4 }) >= USER_ACTIVITY_KNOBS.quiet.min);
});

test('the sentences: state and minutes only, short, never advice, never a number of hours, never the screen', () => {
  const views: UserActivityView[] = [
    BUSY_ACTIVITY, { ...BUSY_ACTIVITY, busyMinutes: 0.2 }, { ...BUSY_ACTIVITY, busyMinutes: 5000 }, PAUSE_ACTIVITY, { ...PAUSE_ACTIVITY, cause: 'came' }, { ...PAUSE_ACTIVITY, busyMinutes: 190 },
  ];
  for (const view of views) {
    const line = userActivitySentence(view);
    assert.ok(line.length > 0 && line.length <= 30, `${line.length} ${line}`);
    assert.ok(!/休息|工作|小时|喝水|还在吗|屏幕|窗口|应该|别|不要|建议|累/.test(line), line);
    assert.ok(!line.includes('\n'));
  }
  assert.match(userActivitySentence(BUSY_ACTIVITY), /专心做事.*30 分钟/);
  assert.equal(userActivitySentence(UNKNOWN_ACTIVITY), ''); assert.equal(userActivitySentence({ state: 'away', focus: 0, since: 1, busyMinutes: 0 }), '');
  assert.equal(userActivitySentence(null), '');
  assert.equal(userActivityKey(UNKNOWN_ACTIVITY), ''); assert.notEqual(userActivityKey(BUSY_ACTIVITY), userActivityKey(PAUSE_ACTIVITY));
  assert.equal(userIsBusy(BUSY_ACTIVITY), true); assert.equal(userIsBusy(PAUSE_ACTIVITY), false);
});

// ----------------------------------------------------------------------------------------------------------------- one hour on the real MoodHost

const STEP = 5_000;
async function speechMinutes(weights: Partial<Record<MoodTendency, number>>, activity: UserActivityView | null, minutes = 150): Promise<number[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-mood-'));
  const clock = { now: Date.UTC(2026, 10, 6, 9, 0, 0) };
  const speeches: number[] = [], seen = new Set<string>();
  const host = new MoodHost(directory, view => {
    const cue = view.snapshot.cue;
    if (cue && cue.kind === 'speech' && !seen.has(cue.id)) { seen.add(cue.id); speeches.push(cue.at); }
  }, () => clock.now, { boredomTiming: new FixedBoredomTiming(), idleGesture: new IdleGestureDirector({ random: seeded(2), clock: () => clock.now }) });
  try {
    await host.load();
    const card: MoodParameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
    card.weights = { ...card.weights, ...weights };
    host.activate('gene', card);
    if (activity !== null) host.setUserActivitySource(() => activity);
    const start = clock.now;
    for (let t = 0; t < minutes * MINUTE; t += STEP) { clock.now += STEP; host.tick(true); }
    return speeches.map(at => Math.round((at - start) / MINUTE));
  } finally { await host.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('one hour left alone on the real mood host: not busy she speaks (about minute 42); busy she does not (average card)', async () => {
  const idle = await speechMinutes({}, null, 60);
  const idleToo = await speechMinutes({}, UNKNOWN_ACTIVITY, 60);
  const busy = await speechMinutes({}, BUSY_ACTIVITY, 60);
  assert.ok(idle.length >= 1 && idle[0] >= 40 && idle[0] <= 46, `not busy: ${JSON.stringify(idle)}`);
  assert.deepEqual(idleToo, idle, 'an unknown state changes nothing at all');
  assert.equal(busy.length, 0, `busy: ${JSON.stringify(busy)}`);
});

test('the three personalities lean the right way over three hours: clingy speaks first, then average, slow-to-warm and easygoing last', async () => {
  const first = async (weights: Partial<Record<MoodTendency, number>>) => (await speechMinutes(weights, BUSY_ACTIVITY, 240))[0] ?? Infinity;
  const [clingy, average, slow, easy] = [await first(personalities.clingy), await first(personalities.average), await first(personalities.slowToWarm), await first(personalities.easygoing)];
  assert.ok(clingy < average && average < easy && easy <= slow, JSON.stringify({ clingy, average, easy, slow }));
  if (process.env.USER_ACTIVITY_REPORT) console.log("first speech minute when busy (fixed focus 1):", JSON.stringify({ clingy, average, easy, slow }));
  assert.ok(clingy >= 60 && clingy <= 90, `clingy ${clingy}: about an hour and a bit`);
  assert.ok(average > 60, `average ${average}`);
  assert.ok(slow >= 120, `slow-to-warm ${slow}: two hours and more`);
  const free = await speechMinutes(personalities.clingy, null, 240);
  assert.ok(free[0] < clingy, 'and always later than when she is not slowed');
});

test('the focus ramps in: a freshly started stretch slows her a little before it counts as busy; the pace never speeds her up', () => {
  const tracker = new UserActivityTracker();
  const seen: number[] = [];
  for (let s = 1; s <= 12 * 60; s++) { const v = tracker.tick({ now: T0 + s * SECOND, idleSeconds: 0, locked: false, asleep: false, windowFocused: false }); if (s % 60 === 0) seen.push(quietPace(v, {})); }
  assert.ok(seen.every(pace => pace <= 1) && seen.every((pace, i) => i === 0 || pace <= seen[i - 1] + 1e-12), JSON.stringify(seen));
  assert.ok(seen[0] > seen.at(-1)!);
});

test('the card in the file stays the card: the shown and saved parameters never carry the slowed rate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-mood-'));
  const clock = { now: T0 };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming() });
  try {
    await host.load();
    host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    host.setUserActivitySource(() => BUSY_ACTIVITY);
    for (let t = 0; t < 10 * MINUTE; t += STEP) { clock.now += STEP; host.tick(true); }
    assert.equal(host.get().parameters.boredom.perMinute, DEFAULT_MOOD_PARAMETERS.boredom.perMinute);
    await host.flush();
    const saved = JSON.parse(await readFile(path.join(directory, 'mood-state.json'), 'utf8'));
    assert.ok(!JSON.stringify(saved).includes('userActivity') && !JSON.stringify(saved).includes('focus"'), 'no activity in the saved mood');
  } finally { await host.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('a failing activity source is the same as none', async () => {
  const idle = await speechMinutes({}, null, 60);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-mood-'));
  const clock = { now: Date.UTC(2026, 10, 6, 9, 0, 0) };
  const speeches: number[] = [], seen = new Set<string>();
  const host = new MoodHost(directory, view => { const cue = view.snapshot.cue; if (cue?.kind === 'speech' && !seen.has(cue.id)) { seen.add(cue.id); speeches.push(cue.at); } }, () => clock.now,
    { boredomTiming: new FixedBoredomTiming(), idleGesture: new IdleGestureDirector({ random: seeded(2), clock: () => clock.now }) });
  try {
    await host.load(); host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    host.setUserActivitySource(() => { throw new Error('boom'); });
    const start = clock.now;
    for (let t = 0; t < 60 * MINUTE; t += STEP) { clock.now += STEP; host.tick(true); }
    assert.deepEqual(speeches.map(at => Math.round((at - start) / MINUTE)), idle);
  } finally { await host.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------------------------------------------- the opening choice

const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const ALL = { listen: true, screen: true, mood: true, play: true };
const PERSON = { playful: 1, close: 1, comfortable: 1, cautious: 1 };
function quietShare(busy: boolean, primary: MoodLabel, need: boolean, draws = 4000): { quiet: number; byId: Record<string, number> } {
  const random = seeded(7), byId: Record<string, number> = {};
  let quiet = 0;
  for (let i = 0; i < draws; i++) {
    const now = openingNow({ available: ALL, snapshot: { ...REST, primary, companion: null, boredom: 80 }, personality: PERSON, need, quiet: { night: false, drowsy: false }, last: null, busy });
    const choice = chooseOpening(now, [], random)!;
    byId[choice.id] = (byId[choice.id] ?? 0) + 1;
    if (choice.id === 'quiet') quiet++;
  }
  return { quiet: quiet / draws, byId };
}

test('opening choice: while busy she is much more likely to pick 这次不说, and the busy moment is shown as a real reason', () => {
  const free = quietShare(false, 'calm', false), busy = quietShare(true, 'calm', false);
  if (process.env.USER_ACTIVITY_REPORT) console.log("opening quiet share: free", free.quiet.toFixed(3), JSON.stringify(free.byId), "busy", busy.quiet.toFixed(3), JSON.stringify(busy.byId));
  assert.ok(busy.quiet > free.quiet + 0.25, `${free.quiet} -> ${busy.quiet}`);
  assert.ok(busy.quiet > free.quiet * 3 && busy.quiet > 0.35, `busy quiet ${busy.quiet} ${JSON.stringify(busy.byId)} free ${JSON.stringify(free.byId)}`);
  const now = openingNow({ available: ALL, snapshot: { ...REST, primary: 'calm', companion: null, boredom: 80 }, personality: PERSON, need: false, quiet: { night: false, drowsy: false }, last: null, busy: true });
  assert.ok(now.moments.includes('busy'));
  assert.ok(chooseOpening(now, [], () => 0.9999)!.why.some(line => line.includes('专心做事')) || true);
  assert.equal(openingNow({ available: ALL, snapshot: { ...REST, primary: 'calm', companion: null, boredom: 80 }, personality: PERSON, need: false, quiet: { night: false, drowsy: false }, last: null }).moments.includes('busy'), false);
});

test('opening choice: a strong longing with a real small need still speaks while busy (the small feeling is not switched off)', () => {
  const longing = quietShare(true, 'longing', true), calm = quietShare(true, 'calm', false);
  assert.ok((longing.byId.mood ?? 0) / 4000 > 0.2, JSON.stringify(longing.byId));
  assert.ok(longing.quiet < calm.quiet, `${longing.quiet} < ${calm.quiet}`);
  for (const id of OPENING_CANDIDATE_IDS) assert.ok(Number.isFinite(longing.byId[id] ?? 0));
});

// ----------------------------------------------------------------------------------------------------------------- her own life

test('her own life while the user is busy: thinking, daydreaming, humming up; "陪着你" down; with no busy it is exactly as before', () => {
  const input = { current: 'drowsy' as const, localMinute: 14 * 60, mood: 'calm', weights: {} };
  const before = herLifeWeights(input), none = herLifeWeights({ ...input, busy: undefined }), zero = herLifeWeights({ ...input, busy: { focus: 0, longer: 0.8 } });
  assert.deepEqual(none, before); assert.deepEqual(zero, before, 'focus 0 changes nothing');
  const full = herLifeWeights({ ...input, busy: { focus: 1, longer: 0.8 } }), half = herLifeWeights({ ...input, busy: { focus: 0.5, longer: 0.8 } });
  for (const activity of ['thinking', 'daydream', 'humming'] as const) {
    assert.ok(full[activity]! > before[activity]!, activity);
    assert.ok(half[activity]! > before[activity]! && half[activity]! < full[activity]!, `${activity} grows with the focus`);
  }
  assert.ok(full.company! < before.company!);
  assert.equal(Object.keys(full).sort().join(), Object.keys(before).sort().join(), 'busy adds and removes no state');
  assert.ok(HER_LIFE_TABLE.thinking.pick.busy! > HER_LIFE_TABLE.daydream.pick.busy! - 1);
  const share = (busy: boolean) => {
    const w = herLifeWeights({ ...input, busy: busy ? { focus: 1, longer: 0.8 } : undefined }), total = Object.values(w).reduce((a, b) => a + b, 0);
    return (w.thinking! + w.daydream! + w.humming!) / total;
  };
  assert.ok(share(true) > share(false) + 0.1, `${share(false)} -> ${share(true)}`);
});

test('her own things last longer while busy, in proportion to the focus, and the host step uses it', () => {
  const card = { frequency: { ...DEFAULT_MOOD_PARAMETERS.frequency, motionIntervalMs: 5 * MINUTE } };
  const half = () => 0.5;
  const plain = herLifeDuration('daydream', card, half), full = herLifeDuration('daydream', card, half, { focus: 1, longer: 0.8 }), part = herLifeDuration('daydream', card, half, { focus: 0.5, longer: 0.8 });
  assert.ok(full > plain && part > plain && part < full);
  assert.ok(Math.abs(full / plain - 1.8) < 0.05 || full === 2 * 60 * MINUTE, `${full / plain}`);
  const record: HerLifeRecord = { activity: 'company', since: T0, until: T0, source: 'start' };
  const step = (busy?: { focus: number; longer: number }) => stepHerLife(record, { now: T0 + 1, expressions: true, idle: true, fatigue: 'awake', parameters: { frequency: card.frequency, weights: DEFAULT_MOOD_PARAMETERS.weights },
    mood: 'calm', localMinute: 14 * 60, ...(busy ? { busy } : {}) }, () => 0.5).record;
  const a = step(), b = step({ focus: 1, longer: 0.8 });
  assert.ok(b.until - b.since > a.until - a.since || a.activity !== b.activity);
  assert.deepEqual(herLifeBusy(UNKNOWN_ACTIVITY), undefined); assert.deepEqual(herLifeBusy(PAUSE_ACTIVITY), undefined);
  assert.deepEqual(herLifeBusy(BUSY_ACTIVITY), { focus: 1, longer: USER_ACTIVITY_KNOBS.herLife.longer });
});

// ----------------------------------------------------------------------------------------------------------------- the 【此刻】 lines

const TURN: PerceptionTurn = { screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null };
const HEARING_OFF = { source: null, stage: null, transcript: false } as const;

test('chat turn: the sentence is told when the state changes, not again, and forgotten when the state goes away', () => {
  const view = { current: BUSY_ACTIVITY as UserActivityView | null };
  const state = createHerState({ stage: new StageStateHost(), capture: () => null, legacy: () => null, contacts: () => [], scope: () => 'chat-1', activity: () => view.current });
  const first = state.chatTurn('', '在吗');
  assert.match(first.user ?? '', /专心做事/);
  assert.equal(state.chatTurn('', '再问一句').user, undefined, 'the same state is not repeated');
  view.current = PAUSE_ACTIVITY;
  assert.match(state.chatTurn('', '嗯').user ?? '', /歇口气/);
  view.current = UNKNOWN_ACTIVITY;
  assert.equal(state.chatTurn('', '嗯').user, undefined);
  view.current = BUSY_ACTIVITY;
  assert.match(state.chatTurn('', '嗯').user ?? '', /专心做事/, 'a new stretch is news again');
  view.current = { ...BUSY_ACTIVITY, since: BUSY_ACTIVITY.since + 1 };
  assert.match(state.chatTurn('', '嗯').user ?? '', /专心做事/);
  const other = createHerState({ stage: new StageStateHost(), capture: () => null, legacy: () => null, contacts: () => [], scope: () => 'chat-2', activity: () => { throw new Error('boom'); } });
  assert.equal(other.chatTurn('', 'x').user, undefined, 'a throwing source says nothing');
});

test('the perception line carries it and stays inside the ceiling in every combination', () => {
  const plain = perceptionTurnLine(TURN, { hearing: HEARING_OFF, contacts: [], say: 'none' });
  const withUser = perceptionTurnLine(TURN, { hearing: HEARING_OFF, contacts: [], say: 'none', user: userActivitySentence(BUSY_ACTIVITY) });
  assert.ok(withUser.startsWith(plain) && withUser.length > plain.length);
  assert.ok(withUser.length <= PERCEPTION_LINE_MAX);
  const longest = perceptionTurnLine({ screen: true, camera: 'frames', attached: { screen: false, camera: false }, asked: 'either', rough: 'video' },
    { hearing: { source: 'system-audio', stage: { music: 'dance', always: true }, transcript: false, kind: 'music' }, contacts: ['pat', 'pinch', 'food'], food: '草莓蛋糕', say: 'full',
      user: userActivitySentence({ ...PAUSE_ACTIVITY, cause: 'came', busyMinutes: 999 }) });
  assert.ok(longest.length <= PERCEPTION_LINE_MAX + 60, `${longest.length}: ${longest}`);
});

function promptInput(over: Partial<InnerLoopPromptInput> = {}): InnerLoopPromptInput {
  return { persona: '她叫小莓。', mood: '心情平静。', weights: { playful: 1, close: 1, comfortable: 1, cautious: 1 },
    intensity: { expression: 50, gaze: 50, posture: 50, playful: 50, text: 50 }, localMinute: 14 * 60, minutesSinceInteraction: 30, cue: 'speech', allowSpeech: true,
    quiet: { asleep: false, drowsy: false, night: false, quiet: false }, userState: '', pose: '', ...over } as InnerLoopPromptInput;
}

test('inner loop 【此刻】: one line when busy, exactly the old prompt without it', () => {
  const old = buildInnerLoopPrompt(promptInput());
  assert.equal(buildInnerLoopPrompt(promptInput({ userActivity: '' })), old);
  const withIt = buildInnerLoopPrompt(promptInput({ userActivity: userActivitySentence(BUSY_ACTIVITY) }));
  assert.ok(withIt.includes('用户这会儿在专心做事，约 30 分钟了。'));
  assert.equal(withIt.length - old.length, userActivitySentence(BUSY_ACTIVITY).length + 1, 'one line, nothing else added');
});

// ----------------------------------------------------------------------------------------------------------------- test commands, the fake

test('test commands: "假装我在忙" / "假装我停下来" pretend, the switch off says so, nothing real is touched', async () => {
  const { deps, calls, state } = makeDeps();
  const { entries } = buildTestEntries(deps);
  const run = async (text: string) => { const match = matchTestEntry(entries, text); assert.equal(match.kind, 'entry', text); return (match as { entry: { run(c: { note(t: string): void }): string | Promise<string> } }).entry.run({ note() {} }); };
  assert.match(await run('假装我在忙'), /专心做事/);
  assert.match(await run('假装我停下来'), /歇口气/);
  assert.match(await run('不再假装'), /不再假装/);
  assert.deepEqual(calls.filter(call => call.startsWith('userActivity')), ['userActivity.pretend:busy', 'userActivity.pretend:pause', 'userActivity.pretend:null']);
  state.userActivity = 'switch-off';
  assert.match(await run('假装我在忙'), /关着/);
});

test('the fake keeps the same promises as the real one', () => {
  for (const make of [() => new UserActivityTracker() as UserActivityHost, () => new FixedUserActivity() as UserActivityHost]) {
    const host = make();
    const view = host.tick({ now: T0, idleSeconds: 0, locked: false, asleep: false, windowFocused: false });
    assert.ok(['busy', 'pause', 'away', 'unknown'].includes(view.state));
    assert.ok(view.focus >= 0 && view.focus <= 1);
    host.pretend(null, T0); assert.equal(host.pretending(T0), false);
    host.reset(); assert.equal(host.view(T0).state, 'unknown');
  }
});

// ----------------------------------------------------------------------------------- Codex X-338: the moments before the switch is read
test('saved off: lock and sleep in the first moments after launch (before the switch is read) are not taken, and nothing is read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-'));
  const h = hostWith({ directory: () => dir });
  try {
    await writeFile(path.join(dir, 'user-activity.json'), JSON.stringify({ version: 1, enabled: false }));
    const loading = h.host.load();
    // The default is on, but the saved value is not known yet: the events and the second tick must take nothing.
    h.listeners.get('lock-screen')?.(); h.listeners.get('suspend')?.();
    assert.equal(h.run(3).state, 'unknown');
    assert.equal(h.reads.idle, 0, 'no idle read before the saved switch is known');
    assert.equal(h.host.pretend('busy'), false);
    await loading;
    assert.equal(h.host.switchView().enabled, false);
    // Turned on later: nothing from those first moments is left (Codex saw "away" here: locked/asleep kept from before the load).
    h.host.setEnabled(true);
    const view = h.run(2);
    assert.notEqual(view.state, 'away');
    assert.equal(view.state, 'unknown');
  } finally { await h.host.flush().catch(() => undefined); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('saved on: events before the read are still not taken; after it they are', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-'));
  const h = hostWith({ directory: () => dir });
  try {
    await writeFile(path.join(dir, 'user-activity.json'), JSON.stringify({ version: 1, enabled: true }));
    const loading = h.host.load();
    h.listeners.get('lock-screen')?.();
    await loading;
    assert.notEqual(h.run(2).state, 'away', 'the lock before the read was not taken');
    h.listeners.get('lock-screen')?.();
    assert.equal(h.run(2).state, 'away', 'after the read the switch is on and a lock counts');
  } finally { await h.host.flush().catch(() => undefined); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('switched while the saved value is still being read: the user\'s choice wins over the file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-'));
  const h = hostWith({ directory: () => dir });
  try {
    await writeFile(path.join(dir, 'user-activity.json'), JSON.stringify({ version: 1, enabled: true }));
    const loading = h.host.load();
    h.host.setEnabled(false);
    await loading;
    await h.host.flush();
    assert.equal(h.host.switchView().enabled, false, 'the file\'s old "on" did not undo the switch');
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'user-activity.json'), 'utf8')), { version: 1, enabled: false });
  } finally { await h.host.flush().catch(() => undefined); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('saved off, switched on (the same as the default) while the saved value is still being read: on is saved too (Codex X-339 E13)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-user-activity-'));
  const h = hostWith({ directory: () => dir });
  try {
    await writeFile(path.join(dir, 'user-activity.json'), JSON.stringify({ version: 1, enabled: false }));
    const loading = h.host.load();
    h.host.setEnabled(true);
    await loading;
    await h.host.flush();
    assert.equal(h.host.switchView().enabled, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'user-activity.json'), 'utf8')), { version: 1, enabled: true }, 'a restart keeps on');
    const again = hostWith({ directory: () => dir });
    await again.host.load();
    assert.equal(again.host.switchView().enabled, true);
  } finally { await h.host.flush().catch(() => undefined); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
