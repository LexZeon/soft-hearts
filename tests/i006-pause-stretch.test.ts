/**
 * I-006 第 2 步 "你歇一下，她也伸展" (docs/claude/2026-11-06-i006-step2.md): a fourth source for her pose reactions, the user's breather
 * (shared/behaviors/user-activity "歇一下"), with no camera. Fake clock and fake idle seconds only: nothing here reads this computer.
 *  - the policy: her chance by personality, mood and sleepiness; a yawn (哈欠捂嘴) only when sleepy; a rest after each one, by time and
 *    by the interactions with her since (one function, replaceable);
 *  - a simulated working day (the real tracker, the real host): sometimes, never every breather, more when sleepy or close, less when
 *    cautious; never two within the rest;
 *  - never in a chat, a touch, music or asleep; nothing while the 「知道你是不是在忙」 switch is off; not when the user came back to her;
 *  - the stage: the same small stretch; a breather's yawn is 哈欠捂嘴 only in a whole-body framing, a stretch in a half-body one;
 *  - R29 on the real Gene frame loop at 60 and 30 fps: it enters and leaves without a jump, the display guard catches nothing.
 * I006_REPORT=1 prints the numbers of the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Vector3 } from 'three';
import {
  POSE_FOLLOW_CHANCE_MAX, POSE_REACTION_POLICY, decidePosePause, emptyPosePauseMemory, posePauseRested, readPoseReactionView,
  type PoseCharacter, type PoseCoverCue, type PoseReactionView,
} from '../shared/pose-reactions';
import { PoseReactionHost, type PoseReactionTickInput } from '../electron/pose-reactions/host';
import { HerActionHost } from '../electron/her-action-host';
import { CompanionService } from '../electron/companion';
import { createUserActivity } from '../electron/user-activity';
import { UserActivityTracker } from '../shared/behaviors/user-activity/track';
import { UNKNOWN_ACTIVITY, type UserActivityView } from '../shared/behaviors/user-activity/interface';
import { buildJournalEntry, describeJournalEntry } from '../shared/journal';
import { poseInput } from '../electron/journal/sources';
import { PoseReactionStage, POSE_REACTION_TIMELINES, framesWholeBody, type PoseReactionStageInput } from '../src/stage/pose-reaction-stage';
import { framingCamera } from '../src/stage/stage-framing';
import type { HerLifeStageGates } from '../src/stage/her-life-stage';
import type { LifeActivity } from '../src/stage/procedural-life';
import { HER_ACTION_CUE_MS, HER_ACTION_SPECS } from '../shared/her-actions';
import { between, geneStage, patContact, pointAtScalp, surprises, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000, SECOND = 1_000, HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 6, 1, 0, 0);
const report = !!process.env.I006_REPORT;
const character = (over: Partial<PoseCharacter> = {}): PoseCharacter => ({ weights: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, mood: 'calm',
  fatigue: { phase: 'awake', F: 0.3 }, motionIntervalMs: 5 * MINUTE, posture: 50, chatBoredomRelief: 20, ...over });
const CARDS: Record<string, PoseCharacter> = {
  一般: character(),
  一般犯困: character({ fatigue: { phase: 'drowsy', F: 0.8 } }),
  黏人爱玩: character({ weights: { playful: 2, close: 2, comfortable: 1, cautious: 1 } }),
  慢热: character({ weights: { playful: 1, close: 1, comfortable: 1, cautious: 2.5 } }),
};
const pause = (since: number, over: Partial<UserActivityView> = {}): UserActivityView => ({ state: 'pause', focus: 0.8, since, busyMinutes: 30, cause: 'idle', ...over });

// ---------------------------------------------------------------- the policy

test('policy: her chance follows personality, mood and sleepiness; a yawn only when sleepy; never asleep or with no body motion', () => {
  const rate = (c: PoseCharacter, n = 20_000) => {
    const random = seeded(11);
    let react = 0, yawn = 0;
    for (let i = 0; i < n; i++) {
      const out = decidePosePause(emptyPosePauseMemory(), c, 1_000_000, random, { interactions: 0, lastReactionAt: null });
      if (out.decision === 'react') { react++; if (out.kind === 'yawn') yawn++; }
    }
    return { react: react / n, yawn: react ? yawn / react : 0 };
  };
  const table = Object.fromEntries(Object.entries(CARDS).map(([name, c]) => [name, rate(c)]));
  if (report) console.log('[I-006 policy]', Object.entries(table).map(([name, r]) => `${name} ${(r.react * 100).toFixed(1)}%（哈欠占 ${(r.yawn * 100).toFixed(0)}%）`).join(' · '));
  assert.ok(table.一般.react > 0.18 && table.一般.react < 0.33, `about 1 in 4 on an average awake card: ${table.一般.react}`);
  assert.ok(table.一般犯困.react > table.一般.react + 0.08, 'sleepy: more');
  assert.ok(table.黏人爱玩.react > table.一般.react + 0.03, 'close and playful: more');
  assert.ok(table.慢热.react < table.一般.react - 0.08, 'cautious: less');
  for (const r of Object.values(table)) assert.ok(r.react <= POSE_FOLLOW_CHANCE_MAX, 'never above the fixed ceiling');
  assert.equal(table.一般.yawn, 0, 'awake: no yawn');
  assert.ok(table.一般犯困.yawn > 0.4 && table.一般犯困.yawn < 0.8, `drowsy: often a yawn ${table.一般犯困.yawn}`);
  assert.ok(rate(character({ mood: 'sad' })).react < table.一般.react, 'sad: less');
  for (const c of [character({ fatigue: { phase: 'asleep', F: 1 } }), character({ posture: 0 })]) {
    const out = decidePosePause(emptyPosePauseMemory(), c, 1_000_000, () => 0, { interactions: 0, lastReactionAt: null, force: true });
    assert.equal(out.decision, 'skip', 'asleep or still: nothing, even forced');
  }
});

test('policy: after one she rests (time, and each interaction with her since counts for a while); the gap after anything else holds', () => {
  const c = character();
  const first = decidePosePause(emptyPosePauseMemory(), c, T0, () => 0, { interactions: 0, lastReactionAt: null });
  assert.equal(first.decision, 'react');
  const rest = first.memory.restMs!;
  assert.ok(rest >= 40 * MINUTE * 0.99 && rest <= 70 * MINUTE, `default card rests 40–70 min: ${rest / MINUTE}`);
  const per = POSE_REACTION_POLICY.pauseInteractionMs(c);
  assert.equal(per, 7.5 * MINUTE);
  assert.equal(posePauseRested(first.memory, T0 + rest - 1, 0, per), false);
  assert.equal(posePauseRested(first.memory, T0 + rest, 0, per), true);
  // Four interactions with her since: 30 minutes sooner.
  assert.equal(posePauseRested(first.memory, T0 + rest - 30 * MINUTE, 4, per), true);
  assert.equal(posePauseRested(first.memory, T0 + rest - 31 * MINUTE, 4, per), false);
  assert.equal(posePauseRested(first.memory, T0 - 1, 100, per), false, 'the clock went back: not rested');
  assert.equal(decidePosePause(first.memory, c, T0 + 10 * MINUTE, () => 0, { interactions: 0, lastReactionAt: null }).decision, 'skip');
  // Something else a moment ago (a caught yawn): she lets this one go.
  const busy = decidePosePause(emptyPosePauseMemory(), c, T0, () => 0, { interactions: 0, lastReactionAt: T0 - 5 * SECOND });
  assert.deepEqual([busy.decision, busy.decision === 'skip' && busy.reason], ['skip', 'busy']);
  // A test command: chance, rest and gap are skipped.
  assert.equal(decidePosePause(first.memory, c, T0 + MINUTE, () => 0.99, { interactions: 0, lastReactionAt: T0, force: true }).decision, 'react');
  // Her delay: a second or three.
  for (let i = 0; i < 200; i++) {
    const d = POSE_REACTION_POLICY.delayMs('stretch', 'pause', c, seeded(i));
    assert.ok(d >= 600 && d <= 3_500, `delay ${d}`);
  }
});

// ---------------------------------------------------------------- the host

function rig(over: { cover?: () => PoseCoverCue | null; interactions?: (at: number) => number; random?: () => number } = {}) {
  let now = T0;
  const journal: string[] = [];
  const host = new PoseReactionHost({ changed: () => {}, presence: () => {}, clock: () => now, random: over.random ?? (() => 0), id: (() => { let n = 0; return () => `id${++n}`; })(),
    journal: (_id, event, kind) => journal.push(`${event}:${kind ?? ''}`), ...(over.interactions ? { interactionsSince: (_id: string, at: number) => over.interactions!(at) } : {}),
    ...(over.cover ? { coverYawn: over.cover } : {}) });
  const input = (over2: Partial<PoseReactionTickInput> = {}): PoseReactionTickInput => ({ now, expressions: true, canExpress: true, character: character(), ...over2 });
  const tick = (over2: Partial<PoseReactionTickInput> = {}) => { host.tick('gene', input(over2)); return host.view('gene'); };
  return { host, journal, tick, at: (t: number) => { now = t; }, now: () => now };
}

test('the host: a breather is considered once; she stretches after her delay; a pass is only a journal line', () => {
  const r = rig();
  assert.equal(r.tick({ activity: UNKNOWN_ACTIVITY }), null, 'no breather, no camera: no view');
  const view = r.tick({ activity: pause(T0) })!;
  assert.equal(view.cue?.kind, 'stretch'); assert.equal(view.cue?.source, 'pause');
  assert.ok(view.cue!.at >= T0 + 600 && view.cue!.at <= T0 + 3_500, 'her delay');
  assert.equal(view.attention, 0, 'no camera: no attention');
  const id = view.cue!.id;
  r.at(T0 + 2 * SECOND);
  assert.equal(r.tick({ activity: pause(T0) })?.cue?.id, id, 'the same breather again: nothing new');
  assert.deepEqual(r.journal, ['pause:stretch']);
  // A pass (random 0.99 > chance): one journal line, no cue.
  const p = rig({ random: () => 0.99 });
  assert.equal(p.tick({ activity: pause(T0) }), null);
  assert.deepEqual(p.journal, ['pause-pass:']);
  // A view the stage reads unchanged.
  assert.deepEqual(readPoseReactionView(JSON.parse(JSON.stringify(view))), view);
});

test('the host: not while the user is with her (typing, chat, speech, a drag), with expressions paused, asleep, or with no body motion; not when the user came back to her', () => {
  for (const [name, over] of [
    ['chat / typing (canExpress false)', { canExpress: false }],
    ['自动表现 off', { expressions: false }],
    ['asleep', { character: character({ fatigue: { phase: 'asleep', F: 1 } }) }],
    ['falling asleep', { character: character({ fatigue: { phase: 'falling-asleep', F: 1 } }) }],
    ['posture 0', { character: character({ posture: 0 }) }],
    ['came to her', { activity: pause(T0, { cause: 'came' }) }],
    ['busy', { activity: { state: 'busy', focus: 1, since: T0, busyMinutes: 30 } }],
    ['switch off (说不准)', { activity: UNKNOWN_ACTIVITY }],
    ['away', { activity: { state: 'away', focus: 0, since: T0, busyMinutes: 0 } }],
  ] as [string, Partial<PoseReactionTickInput>][]) {
    const r = rig();
    for (let t = 0; t < 5 * MINUTE; t += 10 * SECOND) { r.at(T0 + t); assert.equal(r.tick({ activity: pause(T0), ...over })?.cue ?? null, null, name); }
    assert.deepEqual(r.journal, [], name);
  }
  // A chat that ends inside the breather: she may still do it then (the breather is hers until it ends).
  const r = rig();
  r.tick({ activity: pause(T0), canExpress: false });
  r.at(T0 + 40 * SECOND);
  assert.equal(r.tick({ activity: pause(T0) })?.cue?.source, 'pause');
});

test('the host: sleepy, a breather is 哈欠捂嘴 when the her-action host gives a live cue, a stretch without one; turning the camera off keeps it', () => {
  const sleepy = character({ fatigue: { phase: 'drowsy', F: 0.9 } });
  const live: PoseCoverCue = { id: 'cover1', at: T0, expiresAt: T0 + HER_ACTION_CUE_MS };
  const r = rig({ cover: () => live });
  const view = r.tick({ activity: pause(T0), character: sleepy })!;
  assert.equal(view.cue?.kind, 'yawn'); assert.deepEqual(view.cue?.cover, live);
  assert.deepEqual(readPoseReactionView(JSON.parse(JSON.stringify(view)))?.cue?.cover, live);
  r.host.sensing(false);
  assert.equal(r.host.view('gene')?.cue?.id, view.cue?.id, 'the camera going off does not withdraw a breather');
  assert.deepEqual(r.journal, ['pause:yawn']);
  const none = rig({ cover: () => null });
  assert.equal(none.tick({ activity: pause(T0), character: sleepy })?.cue?.kind, 'stretch', 'no pet window for the hand: the stretch');
  const plain = rig();
  assert.equal(plain.tick({ activity: pause(T0), character: sleepy })?.cue?.kind, 'stretch', 'no her-action host: the stretch');
  // The view refuses a cover anywhere else, or a malformed one.
  const cue = view.cue!;
  for (const bad of [{ ...cue, kind: 'stretch' }, { ...cue, source: 'own' }, { ...cue, cover: { ...live, expiresAt: live.at + 9_000 } }, { ...cue, cover: { ...live, id: 'a b' } }, { ...cue, cover: null }])
    assert.equal(readPoseReactionView({ ...view, cue: bad }), null, JSON.stringify(bad));
});

test('the host: a test command\'s pretended breather always shows (chance, rest and gap skipped), still never in a chat', () => {
  const r = rig({ random: () => 0.99 });
  assert.equal(r.tick({ activity: pause(T0, { pretended: true }) })?.cue?.source, 'pause');
  r.at(T0 + MINUTE);
  assert.equal(r.tick({ activity: pause(T0 + MINUTE, { pretended: true }) })?.cue?.source, 'pause', 'again a minute later');
  const chat = rig();
  assert.equal(chat.tick({ activity: pause(T0, { pretended: true }), canExpress: false })?.cue ?? null, null);
});

// ---------------------------------------------------------------- a simulated working day

interface Day { pauses: number; reactions: number; yawns: number; times: number[] }
/**
 * 9 hours: blocks of 15–55 minutes at the keyboard (a key every few seconds), then 3–15 minutes away from it (no input, no lock). The real
 * tracker gives the breathers, the real host decides; one tick every 2 s. `chats`: the user talks to her once in every break.
 */
function workingDay(c: PoseCharacter, seed: number, chats = false): Day {
  const random = seeded(seed), host = new PoseReactionHost({ changed: () => {}, presence: () => {}, random: seeded(seed * 7 + 1), clock: () => now,
    coverYawn: () => ({ id: 'c', at: 0, expiresAt: 1 }), interactionsSince: (_id, at) => interactions.filter(t => t > at).length });
  const tracker = new UserActivityTracker(), interactions: number[] = [], day: Day = { pauses: 0, reactions: 0, yawns: 0, times: [] };
  let now = T0, lastPause: number | null = null, lastCue: string | null = null;
  const step = (idle: number) => {
    const view = tracker.tick({ now, idleSeconds: idle, locked: false, asleep: false, windowFocused: false });
    if (view.state === 'pause' && view.since !== lastPause) { lastPause = view.since; day.pauses++; }
    host.tick('gene', { now, expressions: true, canExpress: true, character: c, activity: view });
    const cue = host.view('gene')?.cue;
    if (cue && cue.id !== lastCue) { lastCue = cue.id; day.reactions++; day.times.push(now); if (cue.kind === 'yawn') day.yawns++; }
    now += 2 * SECOND;
  };
  while (now < T0 + 9 * HOUR) {
    const work = (15 + 40 * random()) * MINUTE, rest = (3 + 12 * random()) * MINUTE;
    for (const end = now + work; now < end;) step(Math.floor(random() * 6));
    if (chats) interactions.push(now + 4 * MINUTE);
    for (const start = now, end = now + rest; now < end;) step(Math.floor((now - start) / SECOND));
  }
  return day;
}

test('a simulated working day: sometimes, never every breather; more when sleepy or close, less when cautious; never two within her rest', () => {
  const rows: string[] = [];
  const summary: Record<string, { per: number; share: number; gap: number; yawns: number; lively: number }> = {};
  for (const [name, c] of Object.entries(CARDS)) {
    let pauses = 0, reactions = 0, yawns = 0, gap = Infinity, lively = 0;
    const days = 30;
    for (let seed = 1; seed <= days; seed++) {
      const day = workingDay(c, seed);
      pauses += day.pauses; reactions += day.reactions; yawns += day.yawns;
      for (let i = 1; i < day.times.length; i++) gap = Math.min(gap, day.times[i] - day.times[i - 1]);
      lively += workingDay(c, seed, true).reactions;
    }
    summary[name] = { per: reactions / days, share: reactions / pauses, gap: gap / MINUTE, yawns: yawns / days, lively: lively / days };
    rows.push(`${name}: 每天歇 ${(pauses / days).toFixed(1)} 次，她动 ${(reactions / days).toFixed(2)} 次（${(100 * reactions / pauses).toFixed(0)}%，哈欠 ${(yawns / days).toFixed(2)}），`
      + `最短间隔 ${(gap / MINUTE).toFixed(0)} 分钟；每次歇都找她说一句的日子 ${(lively / days).toFixed(2)} 次`);
  }
  if (report) console.log('[I-006 day]\n' + rows.join('\n'));
  const s = summary;
  assert.ok(s.一般.per >= 1 && s.一般.per <= 4, `an average awake card: a few a day (${s.一般.per})`);
  for (const [name, row] of Object.entries(s)) {
    assert.ok(row.share < 0.6, `${name}: never every breather (${row.share})`);
    assert.ok(row.gap >= 30, `${name}: never two within the rest (${row.gap} min)`);
  }
  assert.ok(s.一般犯困.per > s.一般.per, 'sleepy: more'); assert.ok(s.一般犯困.yawns > 0.3, 'sleepy: yawns'); assert.equal(s.一般.yawns, 0, 'awake: no yawn');
  assert.ok(s.黏人爱玩.per > s.一般.per, 'close: more'); assert.ok(s.慢热.per < s.一般.per, 'cautious: less');
  assert.ok(s.一般.lively > s.一般.per, 'a lively day (she is talked to): a little more');
});

// ---------------------------------------------------------------- through the real services and the switch

test('through CompanionService: the user-activity source gives the breather; the switch off gives nothing at all', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i006-step2-'));
  try {
    const service = new CompanionService(directory, () => {}, { pose: { random: () => 0 } });
    service.mood.activate('gene');
    const activity = createUserActivity({ directory: () => null, idleSeconds: () => 0, windowFocused: () => false });
    service.setUserActivitySource(() => activity.view());
    service.herLifeTick(true);
    assert.equal(service.pose.view('gene'), null, 'nothing pretended, nothing read: no breather');
    assert.equal(activity.pretend('pause'), true);
    service.herLifeTick(true);
    assert.equal(service.pose.view('gene')?.cue?.source, 'pause');
    // Off: the source does not exist (always 说不准), and a test command cannot pretend.
    const off = new CompanionService(directory, () => {}, { pose: { random: () => 0 } });
    off.mood.activate('gene');
    const offActivity = createUserActivity({ directory: () => null, idleSeconds: () => { throw new Error('read while off'); }, windowFocused: () => false });
    offActivity.setEnabled(false);
    off.setUserActivitySource(() => offActivity.view());
    assert.equal(offActivity.pretend('pause'), false);
    for (let i = 0; i < 30; i++) { offActivity.tick(); off.herLifeTick(true); }
    assert.equal(off.pose.view('gene'), null);
    await service.flush().catch(() => {}); await off.flush().catch(() => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the her-action host issues a live 哈欠捂嘴 cue without sending it; a window resolves it as any other; no pet window: none', async () => {
  const sent: unknown[] = [];
  let visible = true;
  const host = new HerActionHost({ send: cue => sent.push(cue), petVisible: () => visible, library: { resolvePreview: async () => 'x' },
    register: async () => ({ url: 'mmd-asset://x/y.vmd' }) as never, now: () => T0, createId: () => 'cueA',
    timers: { set: () => 0, clear: () => {} } });
  const cue = host.issue('cover-yawn')!;
  assert.deepEqual(cue, { id: 'cueA', action: 'cover-yawn', at: T0, expiresAt: T0 + HER_ACTION_CUE_MS });
  assert.deepEqual(sent, [], 'not sent: it rides on the pose cue');
  assert.deepEqual(host.live, ['cueA']);
  assert.equal(host.report({ cueId: 'cueA', status: 'played', missing: [], detail: '' }), true, 'the pet answers it like any cue');
  visible = false;
  assert.equal(host.issue('cover-yawn'), null);
});

test('journal: a breather writes only the category (stretch / yawn / let go), in plain words', () => {
  const lines = [poseInput('gene', 'pause', 'stretch'), poseInput('gene', 'pause', 'yawn'), poseInput('gene', 'pause-pass', null)]
    .map(input => buildJournalEntry(input as never, T0)).map(entry => { assert.ok(entry, 'accepted'); return describeJournalEntry(entry!, (s: string) => s).replace(/^\d\d:\d\d /u, ''); });
  assert.deepEqual(lines, ['你停下来歇口气，她也伸了一下', '你停下来歇口气，她困困地打了个哈欠', '你停下来歇口气，她这次没动']);
  assert.equal(buildJournalEntry(poseInput('gene', 'pause', 'wave') as never, T0), null, 'a breather is never a wave');
  assert.equal(buildJournalEntry({ type: 'pose', characterId: 'gene', event: 'pause-pass', kind: 'stretch' }, T0), null, 'a pass names nothing');
});

// ---------------------------------------------------------------- the stage layer

const FREE: HerLifeStageGates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
const NEUTRAL: LifeActivity = { gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0, sway: 1, bodyZ: 0,
  blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 };

test('framing: the full preset shows her whole body, the half-body one does not; no camera is not whole', () => {
  const model = { height: 20, width: 8, baseY: 0, centerX: 0 };
  for (const aspect of [400 / 560, 300 / 700, 1.2]) for (const topBand of [0, 0.22, 0.35]) {
    assert.equal(framesWholeBody(framingCamera('full', model, { aspect, fov: 32, topBand }), model), true, `full ${aspect} ${topBand}`);
    assert.equal(framesWholeBody(framingCamera('portrait', model, { aspect, fov: 32, topBand }), model), false, `portrait ${aspect} ${topBand}`);
  }
  assert.equal(framesWholeBody(null, model), false);
  assert.equal(framesWholeBody({ distance: 30, fov: 32, targetY: 10 }, { height: 0 }), false);
});

test('stage layer: a breather stretch plays; a breather yawn is the hand in a whole-body framing and the stretch in a half-body one; busy: skipped', () => {
  const run = (kind: 'stretch' | 'yawn', input: Partial<PoseReactionStageInput>) => {
    const stage = new PoseReactionStage(), owner = {}, covers: PoseCoverCue[] = [];
    const cover: PoseCoverCue = { id: 'cv', at: 10_000, expiresAt: 18_000 };
    const view: PoseReactionView = { attention: 0, boost: 2.2, cue: { id: 'p1', kind, source: 'pause', at: 10_000, strength: 1, ...(kind === 'yawn' ? { cover } : {}) } };
    let now = 10_000;
    for (let i = 0; i < 60; i++) { now += 1000 / 60; stage.frame(1 / 60, { owner, view, nowMs: now, gates: FREE, game: false, cover: c => covers.push(c), ...input }, NEUTRAL); }
    return { state: stage.getState(), covers };
  };
  const stretch = run('stretch', {});
  assert.equal(stretch.state.playing?.kind, 'stretch'); assert.equal(stretch.state.playing?.source, 'pause');
  const whole = run('yawn', { fullBody: true });
  assert.equal(whole.state.playing, null, 'the hand is the action player\'s, not this layer\'s');
  assert.deepEqual(whole.covers, [{ id: 'cv', at: 10_000, expiresAt: 18_000 }]); assert.equal(whole.state.covered, 1);
  for (const half of [{ fullBody: false }, {}]) {
    const r = run('yawn', half);
    assert.equal(r.state.playing?.kind, 'stretch', 'half body: the stretch, never the hand over her face');
    assert.deepEqual(r.covers, []);
  }
  for (const [name, gates, game] of [
    ['a touch / feeding / chat / music (engaged)', { ...FREE, engaged: true }, false],
    ['a picked pose / gesture / music body (body owned)', { ...FREE, bodyOwned: true }, false],
    ['asleep', { ...FREE, asleep: true }, false],
    ['自动表现 off', { ...FREE, expressive: false }, false],
    ['the game', FREE, true],
  ] as const) for (const kind of ['stretch', 'yawn'] as const) {
    const r = run(kind, { gates, game, fullBody: true });
    assert.equal(r.state.playing, null, `${name} ${kind}`); assert.deepEqual(r.covers, [], `${name} ${kind}`); assert.equal(r.state.skipped, 1);
  }
});

// ---------------------------------------------------------------- R29 on the real Gene frame loop

const START = 2;
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;
const ALL = TRACKED_BONES.map((_, i) => i);
const worst = (series: number[][], idx: readonly number[]) => Math.max(0, ...idx.map(i => Math.max(0, ...series[i])));
const guardAll = (frames: GeneStage['shown']) => frames.slice(1).filter((frame, i) => frame.guardJumps > frames[i].guardJumps).map(frame => `${frame.guardLast}@${frame.t.toFixed(2)}`);
const fullCamera = (h: GeneStage, preset: 'full' | 'portrait') => framingCamera(preset, { height: h.stage.height, width: h.stage.height * 0.4, baseY: 0, centerX: 0 }, { aspect: 400 / 560, fov: 32 });
function breather(h: GeneStage, kind: 'stretch' | 'yawn', cover?: PoseCoverCue) {
  const v = h.stage.moodView;
  h.stage.setMood({ ...v, revision: v.revision + 1, pose: { attention: 0, boost: 2.2, cue: { id: `pause-${kind}-${h.fps}`, kind, source: 'pause', at: Date.now() - 1, strength: 1, ...(cover ? { cover } : {}) } } });
}
const waitFor = async (check: () => boolean, ms = 3_000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5)); };

for (const fps of [60, 30]) {
  test(`${fps} fps on Gene: a breather's stretch enters and leaves without a jump; the guard catches nothing`, async () => {
    const idle = await geneStage({ fps });
    let undisturbed: number;
    try { idle.run(START + 7.5); undisturbed = worst(surprises(between(idle.shown, START - 0.2, START + 7.5)), ALL); } finally { idle.close(); }
    const h = await geneStage({ fps });
    try {
      h.run(START);
      breather(h, 'stretch');
      const duration = POSE_REACTION_TIMELINES.stretch.duration;
      h.run(duration + 2);
      const during = between(h.shown, START - 0.2, START + duration + 1.5);
      assert.deepEqual(guardAll(during), [], 'nothing for the guard');
      const whole = worst(surprises(between(h.shown, START - 2 / fps, START + duration + 1.5)), ALL);
      if (report) console.log(`[I-006 ${fps}fps] breather stretch: largest unexpected step ${whole.toFixed(3)}° (same seconds without it ${undisturbed.toFixed(3)}°)`);
      assert.ok(whole <= Math.max(floor(fps), 1.25 * undisturbed), `largest unexpected step ${whole} (undisturbed ${undisturbed})`);
      const state = h.stage.poseReaction.getState();
      assert.equal(state.played, 1); assert.equal(state.playing, null, 'ended');
    } finally { h.close(); }
  });

  test(`${fps} fps on Gene: a breather's yawn in a whole-body framing is 哈欠捂嘴 (hand and the usual yawn face); in a half-body one the stretch; the guard catches nothing`, async () => {
    for (const preset of ['full', 'portrait'] as const) {
      const h = await geneStage({ fps, herActions: true });
      try {
        h.stage.framingCamera = fullCamera(h, preset);
        h.run(START);
        const at = Date.now(), cover = { id: `cover${fps}${preset}`, at, expiresAt: at + HER_ACTION_CUE_MS };
        h.grantAction({ ...cover, action: 'cover-yawn' });
        breather(h, 'yawn', cover);
        h.tick();
        await waitFor(() => h.actionReports.some(r => r.cueId === cover.id));
        const jumps = h.shown.at(-1)!.guardJumps;
        h.run(0.5);
        if (preset === 'full') {
          assert.equal(h.actionReports.find(r => r.cueId === cover.id)?.status, 'played');
          assert.equal(h.stage.herAction.active, true, 'the hand');
          assert.equal(h.stage.poseReaction.getState().playing?.kind, 'yawn', 'the usual yawn face on the same clock');
          h.run(HER_ACTION_SPECS['cover-yawn'].durationFrames / 30 + 0.3);
          assert.equal(h.stage.herAction.active, false);
        } else {
          assert.deepEqual(h.actionReports.filter(r => r.cueId === cover.id), [], 'no hand in a half-body framing');
          assert.equal(h.stage.poseReaction.getState().playing?.kind, 'stretch');
          h.run(POSE_REACTION_TIMELINES.stretch.duration + 0.5);
        }
        assert.equal(h.stage.poseReaction.getState().playing, null, 'ended');
        assert.equal(h.shown.at(-1)!.guardJumps, jumps, `${preset}: nothing for the guard (${h.shown.at(-1)!.guardLast})`);
        if (report) console.log(`[I-006 ${fps}fps] breather yawn, ${preset}: ${preset === 'full' ? '哈欠捂嘴' : 'stretch'}, guard ${h.shown.at(-1)!.guardJumps - jumps}`);
      } finally { h.close(); }
    }
  });
}

test('on Gene: music, a pat and sleep keep a breather out (skipped, never played late)', async () => {
  for (const what of ['music', 'pat', 'asleep'] as const) {
    const h = await geneStage({ fps: 60, ...(what === 'music' ? { music: true } : {}) });
    try {
      h.run(START);
      if (what === 'pat') { pointAtScalp(h); h.run(0.5, time => { h.stage.setMoodContact(patContact(time)); }); }
      if (what === 'asleep') { const v = h.stage.moodView; h.stage.setMood({ ...v, revision: v.revision + 1, fatigue: { ...(v.fatigue ?? {}), sleeping: true } }); h.run(0.2); }
      breather(h, 'stretch');
      if (what === 'pat') h.run(1, time => { h.stage.setMoodContact(patContact(time)); }); else h.run(1);
      const state = h.stage.poseReaction?.getState();
      assert.equal(state?.played ?? 0, 0, what); assert.equal(state?.skipped, 1, what);
      // Free again later: the old cue is not replayed.
      if (what === 'pat') h.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0 });
      h.run(3);
      assert.equal(h.stage.poseReaction.getState().played, 0, `${what}: not played late`);
    } finally { h.close(); }
  }
});

/**
 * Real window 2026-11-06 (240005b): while the user was "busy" she was thinking, a hand on her chin (her own life), and the breather's
 * stretch played on top of it: shoulders up and chest out with the hand still at her chin, the fingers moving over her face (0.51 in
 * her head's frame, against 0.40 for thinking alone; never closer to the head). A stretch takes her body, so her held pose now gives
 * way meanwhile (smoothly, at its own pace) and comes back after, as it does for every other body owner.
 */
async function thinkingStretch(fps: number, stretch: boolean) {
  const h = await geneStage({ fps, herLife: true });
  const stage = h.stage, view = stage.moodView;
  stage.setMood({ ...view, revision: view.revision + 1, herLife: { activity: 'thinking', since: Date.now(), until: Date.now() + 600_000, source: 'rule', lookUp: null } });
  h.tick();
  stage.herLife.request('thinking');
  for (let i = 0; i < 400 && stage.herLife.getState().clips.thinking !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 2));
  h.run(6);
  const held = stage.herLife.getState().pose?.weight ?? 0;
  const bones = ['左人指３', '右人指３', '頭'].map(name => h.mesh.skeleton.bones.find((b: { name: string }) => b.name === name)!);
  const gap = () => { const head = bones[2].getWorldPosition(new Vector3()); return Math.min(...bones.slice(0, 2).map(b => b.getWorldPosition(new Vector3()).distanceTo(head))); };
  // Where the nearer fingertip sits in her head's own frame (how it moves over her face, whatever her body does).
  const near = bones[0].getWorldPosition(new Vector3()).distanceTo(bones[2].getWorldPosition(new Vector3()))
    <= bones[1].getWorldPosition(new Vector3()).distanceTo(bones[2].getWorldPosition(new Vector3())) ? bones[0] : bones[1];
  const onFace = () => bones[2].worldToLocal(near.getWorldPosition(new Vector3()));
  const start = h.time(), before = gap(), origin = onFace();
  if (stretch) breather(h, 'stretch');
  let closest = Infinity, lowest = Infinity, slide = 0;
  h.run(POSE_REACTION_TIMELINES.stretch.duration, () => {
    closest = Math.min(closest, gap()); lowest = Math.min(lowest, stage.herLife.getState().pose?.weight ?? 0);
    if ((stage.herLife.getState().pose?.weight ?? 0) > 0.5) slide = Math.max(slide, onFace().distanceTo(origin));
  });
  h.run(6);
  return { h, held, before, closest, lowest, slide, after: stage.herLife.getState().pose?.weight ?? 0, start };
}

for (const fps of [60, 30]) {
  test(`${fps} fps on Gene: thinking with a hand on her chin, a breather's stretch puts the hand down first (her stretch outranks her thinking), then it comes back`, async () => {
    const still = await thinkingStretch(fps, false);
    still.h.close();
    const run = await thinkingStretch(fps, true);
    try {
      const frames = between(run.h.shown, run.start - 0.2, Infinity);
      assert.deepEqual(guardAll(frames), [], 'nothing for the guard');
      const step = worst(surprises(frames), ALL), base = worst(surprises(between(still.h.shown, still.start - 0.2, Infinity)), ALL);
      if (report) console.log(`[I-006 ${fps}fps] thinking + stretch: held ${run.held.toFixed(2)}, lowest ${run.lowest.toFixed(2)}, after ${run.after.toFixed(2)}; `
        + `fingertip-head ${run.before.toFixed(3)} → closest ${run.closest.toFixed(3)} (no stretch ${still.closest.toFixed(3)}); `
        + `fingertip slides over her face (while the hand is held) ${run.slide.toFixed(3)} (no stretch ${still.slide.toFixed(3)}); largest unexpected step ${step.toFixed(3)}° (no stretch ${base.toFixed(3)}°)`);
      assert.ok(run.held > 0.5, `the hand was on her chin (${run.held})`);
      assert.ok(run.lowest < 0.1, `it gave way during the stretch (${run.lowest})`);
      assert.ok(run.closest >= still.closest - 1e-3, `never closer to her face than while just thinking (${run.closest} vs ${still.closest})`);
      assert.ok(run.after > 0.5, `it came back after (${run.after})`);
      assert.ok(step <= Math.max(floor(fps) * 2, 0.3), `largest unexpected step ${step} (thinking alone ${base})`);
    } finally { run.h.close(); }
  });
}
