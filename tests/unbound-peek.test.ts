// Unbound U2, peek-lens (I-104; docs/claude/2026-11-12-unbound-peek.md): the director's decisions (when, how, cancel at every
// beat), the eye-on-the-axis math, the near plane and softness, the host's click-through and input cancel, and the mood write
// only when you answer. The body in the real frame loop is in unbound-peek-body.test.ts.
import test from 'node:test';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import assert from 'node:assert/strict';
import {
  NEUTRAL_MOOD, PEEK_KNOB_DEFAULTS, PEEK_TIMING, PeekHistory, PeekVariation, QUIET_CUE, VariationBag, parsePeekPlan, parsePeekReport, peekReadiness, peekWant, planPeek,
  type MoodReading, type PeekCommand, type PeekReport, type PeekSituation,
} from '../shared/unbound/director';
import { PeekDirectorHost, peekMoodFrom, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { Director } from '../src/unbound/director/director';
import { PEEK_LENS, blinkAt } from '../src/unbound/director/peek-lens';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { REST_TARGETS, blendPoseTargets, type BodySense, type PoseTargets } from '../src/unbound/motion/generator';
import { axisOffset, chooseEye, facingLens, leanEye, leanFor, lensView, onAxis, standFor, toHerFrame, type BodyFrame } from '../src/unbound/motion/lens-align';
import { NEAR_DEFAULT_M, NEAR_MIN_M, lensSoftnessPx, nearPlaneFor } from '../src/unbound/camera';
import { MOOD_MOMENTS } from '../shared/foundation/mood-moments';
import { parseUnboundControlPatch } from '../shared/unbound/scene';
import { CURIOUS, TENSE, laptopLens } from './helpers/unbound-peek';

const ready: PeekSituation = { shown: true, fullscreen: false, idleSeconds: 120, asleep: false, inCall: false, cue: { ...QUIET_CUE }, mood: CURIOUS, active: false };
const fixed = (value = 0.5) => () => value;

// ---- layer 1: when ----------------------------------------------------------------------------------------------------------------

test('readiness: only while shown, idle a while (not away), awake, not in a call, nobody talking, no full-screen, cooldown and hourly cap', () => {
  const h = new PeekHistory(), now = 10 * 3_600_000;
  assert.deepEqual(peekReadiness(ready, h, now), { ok: true });
  const why = (patch: Partial<PeekSituation>) => { const r = peekReadiness({ ...ready, ...patch }, h, now); return r.ok ? 'ok' : r.why; };
  assert.equal(why({ shown: false }), 'not-shown');
  assert.equal(why({ fullscreen: true }), 'fullscreen');
  assert.equal(why({ idleSeconds: null }), 'idle-unknown', '「知道你是不是在忙」 off: never on its own');
  assert.equal(why({ idleSeconds: PEEK_KNOB_DEFAULTS.idleSeconds - 1 }), 'not-idle');
  assert.equal(why({ idleSeconds: PEEK_KNOB_DEFAULTS.maxIdleSeconds + 1 }), 'away');
  assert.equal(why({ asleep: true }), 'asleep');
  assert.equal(why({ mood: { ...CURIOUS, A: 0.8 } }), 'sleepy', 'sleepy A high: she does not');
  assert.equal(why({ inCall: true }), 'call');
  assert.equal(why({ cue: { speaking: true, userTalking: false } }), 'speaking');
  assert.equal(why({ cue: { speaking: false, userTalking: true } }), 'user-talking');
  assert.equal(why({ active: true }), 'active');
  h.record(now - 5 * 60_000);
  assert.equal(why({}), 'cooldown');
  assert.equal(peekReadiness(ready, h, now + PEEK_KNOB_DEFAULTS.cooldownMinutes * 60_000).ok, true);
  h.record(now + 25 * 60_000);
  assert.equal(peekReadiness(ready, h, now + 50 * 60_000, { ...PEEK_KNOB_DEFAULTS, cooldownMinutes: 1 }).ok ? 'ok' : 'hour-cap', 'hour-cap', 'two in the last hour');
});

test('plan from mood: curious comes closer and stays longer; tense is shorter, hesitant, less lean; sleepy wants it less; bounded', () => {
  const curious = planPeek(CURIOUS, fixed()), tense = planPeek(TENSE, fixed()), neutral = planPeek(NEUTRAL_MOOD, fixed());
  assert.ok(curious.eyeDistanceM < neutral.eyeDistanceM && neutral.eyeDistanceM < tense.eyeDistanceM, 'more curious → closer; tense → farther');
  assert.ok(curious.holdS > tense.holdS, 'more curious → longer hold');
  // I-192: her own hold, from the least to the cap; curious stays a few seconds.
  for (const p of [curious, tense, neutral]) assert.ok(p.holdS >= ARRIVAL_KNOBS.holdMinS && p.holdS <= ARRIVAL_KNOBS.holdCapS, `bounded (${p.holdS})`);
  assert.ok(curious.holdS >= 3, `curious: a few seconds (${curious.holdS})`);
  assert.equal(curious.hesitateS, 0); assert.ok(tense.hesitateS > 0.3, 'tense → a pause part-way');
  assert.ok(tense.leanRad < curious.leanRad && tense.approachS > curious.approachS);
  assert.ok(peekWant({ ...CURIOUS, A: 0.65 }) < peekWant(CURIOUS) && peekWant(TENSE) < peekWant(NEUTRAL_MOOD));
  // Codex T-246a starting ranges.
  for (const plan of [curious, tense, neutral]) {
    assert.ok(plan.orientDelayS >= 0.12 && plan.orientDelayS <= 0.32);
    assert.ok(plan.smileDelayS >= 0.18 && plan.smileDelayS <= 0.42);
    assert.ok(plan.afterglowS >= 1.2 && plan.afterglowS <= 3.0);
    assert.ok(plan.arrivePauseS >= 0.2 && plan.arrivePauseS <= 0.5 && plan.prepareS >= 0.15 && plan.prepareS <= 0.3);
    assert.deepEqual(parsePeekPlan(JSON.parse(JSON.stringify(plan))), plan, 'a plan survives IPC');
  }
  assert.equal(parsePeekPlan({ ...curious, eyeDistanceM: 0.001 }), null);
  assert.equal(parsePeekPlan({ ...curious, action: 'hop' }), null);
});

test('variation only at segment boundaries: drawn without replacement, never the same template three times running', () => {
  let r = 0.1; const random = () => (r = (r * 7.31 + 0.13) % 1);
  const bag = new VariationBag([1, -1] as const), draws = Array.from({ length: 40 }, () => bag.draw(random));
  for (let i = 2; i < draws.length; i++) assert.ok(!(draws[i] === draws[i - 1] && draws[i] === draws[i - 2]), `no three in a row at ${i}`);
  const variation = new PeekVariation(), plans = Array.from({ length: 10 }, () => planPeek(CURIOUS, random, variation));
  assert.ok(plans.some(p => p.otherEye) && plans.some(p => !p.otherEye));
  assert.ok(plans.some(p => p.tiltRad > 0) && plans.some(p => p.tiltRad < 0));
});

// ---- layer 2 math: the eye on the axis ---------------------------------------------------------------------------------------

/** Gene's own measurements (her frame, upright; tests/helpers probe): eyes 1.43 m up, the lean pivot (上半身) at 0.94 m. */
const GENE: BodyFrame = { eyes: { left: { x: 0.02, y: 1.429, z: 0.036 }, right: { x: -0.021, y: 1.429, z: 0.036 } }, pivot: { x: 0, y: 0.936, z: 0.028 } };

test('eye alignment: standing where standFor says and leaning by leanFor puts the chosen eye on the axis at the distance', () => {
  const lens = laptopLens();
  for (const eye of ['left', 'right'] as const) for (const distance of [0.045, 0.06, 0.1]) {
    const target = onAxis(lens, distance);
    const lean = leanFor(GENE, eye, target.y, 0.3, 0.05);
    const heading = facingLens(lens);
    const stand = standFor(GENE, eye, target, lean, heading);
    // Rebuild the eye in the world from her stance and the lean (plus the rise her toes have to give).
    const e = leanEye(GENE, eye, lean), c = Math.cos(heading), s = Math.sin(heading);
    const world = { x: stand.x + e.x * c + e.z * s, y: e.y + stand.rise, z: stand.z - e.x * s + e.z * c };
    const off = axisOffset(lens, world);
    assert.ok(off.off < 1e-9 && Math.abs(off.along - distance) < 1e-9, `${eye} ${distance}`);
    assert.ok(stand.rise <= 0.05 + 1e-9, 'never asks more of her toes than they have');
    assert.ok(Math.abs(toHerFrame({ x: Math.sin(heading), y: 0, z: Math.cos(heading) }, heading).z - 1) < 1e-12);
  }
  // Leaning lowers the eye; with the lens above her eyes the lean is cut back so her toes can still reach it.
  assert.ok(leanEye(GENE, 'left', 0.3).y < GENE.eyes.left.y);
  assert.ok(leanFor(GENE, 'left', 1.46, 0.3, 0.04) < 0.3);
  assert.equal(leanFor(GENE, 'left', 1.2, 0.3, 0.04), 0.3);
  // Which eye: to the right of the lens (as you see her) her right eye is nearer; the bag can ask for the other one.
  assert.equal(chooseEye(lens, 0.3, -1), 'right'); assert.equal(chooseEye(lens, -0.3, -1), 'left'); assert.equal(chooseEye(lens, 0.3, -1, true), 'left');
});

test('the lens axis goes through the centre of the window (off-axis work area), and the camera never moves', () => {
  const lens = lensView({ x: 0, y: 1.46, z: 0.55 }, { left: -0.03, right: 0.03, top: 0.02, bottom: -0.018, near: 0.05 });
  assert.ok(lens.axis.y > 0 && Math.abs(Math.hypot(lens.axis.x, lens.axis.y, lens.axis.z) - 1) < 1e-12);
  assert.deepEqual(lens.camera, { x: 0, y: 1.46, z: 0.55 });
});

// ---- the camera ---------------------------------------------------------------------------------------------------------------

test('near plane: 5 cm while she is far, following her nearest point in, never below the floor value; softness only up close', () => {
  const cameraZ = 0.55 / 0.08;
  const far = nearPlaneFor([{ z: -8 / 0.08 }, { z: -8 / 0.08 }], [1], cameraZ);
  assert.equal(far, NEAR_DEFAULT_M);
  const close = nearPlaneFor([{ z: (0.55 - 0.06) / 0.08 }, { z: (0.55 - 0.1) / 0.08 }], [0.2], cameraZ);
  assert.ok(close < 0.06 - 0.2 * 0.08 * 1.5 && close >= NEAR_MIN_M);
  assert.equal(nearPlaneFor([{ z: cameraZ + 1 }, { z: cameraZ + 1 }], [1], cameraZ), NEAR_MIN_M);
  assert.equal(lensSoftnessPx(0.3, 0.35), 0); assert.equal(lensSoftnessPx(0.05, 0), 0); assert.equal(lensSoftnessPx(null, 1), 0);
  assert.ok(lensSoftnessPx(0.1, 0.35) > lensSoftnessPx(0.15, 0.35) && lensSoftnessPx(0.05, 0.35) === lensSoftnessPx(0.08, 0.35) && lensSoftnessPx(0.05, 0.35) <= 0.6);
});

// ---- layer 2 interface -----------------------------------------------------------------------------------------------------

test('layer 2 is one small interface: blending two generators never jumps discrete fields mid-way and keeps blinks crisp', () => {
  const a: PoseTargets = { ...REST_TARGETS, torso: { pitch: 0.2, yaw: 0, roll: 0 }, blink: 0 };
  const b: PoseTargets = { ...REST_TARGETS, torso: { pitch: 0.4, yaw: 0, roll: 0 }, blink: 1, place: { x: 1, z: 2 } };
  const mid = blendPoseTargets(a, b, 0.25);
  assert.ok(Math.abs(mid.torso.pitch - 0.25) < 1e-12);
  assert.equal(mid.place, null); assert.equal(blendPoseTargets(a, b, 0.75).place, b.place);
  assert.equal(mid.blink, 1, 'a blink is never blended down');
  assert.ok(blinkAt(0.08) === 1 && blinkAt(-0.01) === 0 && blinkAt(0.3) === 0 && blinkAt(0.03) > 0 && blinkAt(0.03) < 1);
});

// ---- layer 1 in the page: the director, cancel at every beat ------------------------------------------------------------------

/** A fake body that walks instantly-ish: enough to drive the director through its beats. */
function fakeBody(lens = laptopLens()) {
  const targets: PoseTargets[] = [];
  let root = { x: 0.25, z: -1.2, heading: 0 }, idle = true;
  const eyeAt = () => onAxis(lens, Math.max(0.05, -root.z + 0.55 - 0.1));
  const body = {
    get sense(): BodySense {
      const eye = eyeAt();
      return { root, moving: false, eyes: { left: eye, right: { ...eye, x: eye.x - 0.04 } }, head: { ...eye, y: eye.y - 0.05 }, frame: GENE, tiptoeRise: 0.05, eyeSizeM: 0.025, offsets: { lateral: 0, forward: 0, up: 0 } };
    },
    setPoseTargets(t: PoseTargets) { targets.push(t); if (t.place) root = { ...root, x: t.place.x, z: t.place.z }; idle = t.tiptoe === 0 && t.torso.pitch === 0; },
    get intentIdle() { return idle; },
  };
  return { body, targets };
}

function drive(director: Director, body: ReturnType<typeof fakeBody>['body'], seconds: number, world = { lens: laptopLens(), home: { x: 0.25, z: -1.2 } }) {
  for (let i = 0; i < seconds * 60; i++) director.frame(1 / 60, world, body);
}

test('director: beats in order, and a cancel at any beat goes on to back off and settle — never a stop in place', () => {
  const plan = planPeek(CURIOUS, fixed());
  const world = { lens: laptopLens(), home: { x: 0.25, z: -1.2 } };
  // Uncancelled: every beat, in order.
  {
    const reports: string[] = [], { body } = fakeBody();
    const director = new Director([PEEK_LENS], new ProceduralGenerator(), r => reports.push(r.phase));
    director.command({ type: 'start', id: 'p1', plan, trial: false, armAfterMs: 0 }, world);
    drive(director, body, 20);
    assert.deepEqual(reports.filter((p, i) => reports.indexOf(p) === i), ['notice', 'walk', 'lean', 'hold', 'back', 'settle', 'done']);
    assert.equal(director.active, false);
  }
  for (const beat of ['notice', 'walk', 'lean', 'hold'] as const) for (const reason of ['input', 'reply', 'fullscreen', 'timeout'] as const) {
    const reports: { phase: string; cancelled?: string | null }[] = [], { body, targets } = fakeBody();
    const director = new Director([PEEK_LENS], new ProceduralGenerator(), r => reports.push(r));
    director.command({ type: 'start', id: 'p2', plan, trial: false, armAfterMs: 0 }, world);
    let guard = 0;
    while (director.phase !== beat && guard++ < 2000) director.frame(1 / 60, world, body);
    assert.equal(director.phase, beat);
    const before = targets.length;
    director.cancel(reason); // the host's cancel, at once (2026-11-23: the page's own mouse never cancels)
    const cancelledAt = targets.length;
    assert.equal(director.phase, 'back', `${beat}/${reason}: backs off`);
    assert.equal(reports[reports.length - 1].cancelled, reason);
    drive(director, body, 20);
    assert.equal(director.active, false, `${beat}/${reason}: settles and ends`);
    const after = targets.slice(before);
    assert.ok(after.some(t => t.place && Math.hypot(t.place.x - 0.25, t.place.z + 1.2) < 1e-9), 'walks home');
    if (reason === 'input') assert.ok(targets.slice(cancelledAt, cancelledAt + 20).some(t => t.tempo === 'startle' && t.face.startle > 0), 'a little startled');
  }
});

test('director (2026-11-23): the mouse has no say at all (no pointer input); a large pull yields her (cancelled \'pull\', not walked home); a reply cue does not back her off', () => {
  const plan = planPeek(CURIOUS, fixed()), world = { lens: laptopLens(), home: { x: 0.25, z: -1.2 } };
  const { body, targets } = fakeBody();
  const reports: PeekReport[] = [];
  const director = new Director([PEEK_LENS], new ProceduralGenerator(), r => reports.push(r));
  director.command({ type: 'start', id: 't1', plan, trial: true, armAfterMs: PEEK_TIMING.trialArmMs }, world);
  assert.equal((director as unknown as { input?: unknown }).input, undefined, 'no pointer input');
  drive(director, body, 3);
  assert.notEqual(director.phase, 'back');
  const before = targets.length;
  director.yieldTo('pull');
  assert.equal(director.cancelled, 'pull');
  assert.equal(reports.at(-1)?.cancelled, 'pull', 'reported: she is told next turn');
  drive(director, body, 20);
  assert.ok(!targets.slice(before + 1).some(t => t.place && Math.hypot(t.place.x - 0.25, t.place.z + 1.2) < 1e-9), 'never walked back home: the pull owns where she stands');
  const second = new Director([PEEK_LENS], new ProceduralGenerator(), () => {});
  second.command({ type: 'start', id: 't2', plan, trial: false, armAfterMs: 0 }, world);
  drive(second, body, 1);
  second.setCue({ speaking: true, userTalking: false });
  assert.notEqual(second.phase, 'back', 'she stays: her reply does not back her off');
  assert.equal(second.cancelled, null);
});

// ---- the host: when, click-through, input, answers ----------------------------------------------------------------------------

function fakeHost(options: { idle?: number | null; mood?: MoodReading | null } = {}) {
  let now = 1_000_000, idle = options.idle ?? 120, last: number | null = null, answered = 0, timers: (() => void)[] = [];
  const sent: PeekCommand[] = [], forced: boolean[] = [];
  let shown = true, fullscreen = false;
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.5, idleSeconds: () => idle, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => options.mood === undefined ? CURIOUS : options.mood, lastInteractionAt: () => last, answered: () => { answered++; return true; },
    every: (_ms, run) => { timers.push(run); return () => { timers = timers.filter(t => t !== run); }; },
  };
  const link: PeekLink = { shown: () => shown, fullscreen: () => fullscreen, send: c => sent.push(c), changed: () => {} };
  const host = new PeekDirectorHost(ports, link);
  return {
    host, sent, forced, polls: () => timers.length,
    advance(ms: number) { now += ms; for (const t of [...timers]) t(); },
    set idle(v: number | null) { idle = v as number; }, get idle() { return idle; },
    set last(v: number | null) { last = v; }, get answered() { return answered; },
    set shown(v: boolean) { shown = v; }, set fullscreen(v: boolean) { fullscreen = v; },
    get now() { return now; },
  };
}
const starts = (sent: PeekCommand[]) => sent.filter((c): c is Extract<PeekCommand, { type: 'start' }> => c.type === 'start');

test('host: starts only after the idle wait; never forces click-through (2026-11-23: the window takes the mouse only over her, as always)', () => {
  const f = fakeHost();
  f.host.tick();
  assert.equal(starts(f.sent).length, 0, 'waits a little first (from her mood)');
  for (let i = 0; i < 60 && !starts(f.sent).length; i++) { f.advance(1000); f.host.tick(); }
  const start = starts(f.sent)[0];
  assert.ok(start, 'then starts');
  assert.equal('forcing' in f.host, false, 'no forced click-through');
  for (const phase of ['walk', 'lean', 'hold', 'back', 'settle'] as const) f.host.report({ id: start.id, phase });
  f.host.report({ id: start.id, phase: 'done' });
  assert.equal(f.host.active, false);
  // Cooldown: not again for 20 minutes, whatever the idle.
  for (let i = 0; i < 60; i++) { f.advance(10_000); f.host.tick(); }
  assert.equal(starts(f.sent).length, 1);
  assert.match(f.host.view().blocked ?? '', /冷却/);
});

test('host (2026-11-23): key or mouse input never cancels the peek, however long it goes on (nothing polls it); a stale report cannot end a newer peek', () => {
  const f = fakeHost();
  assert.equal(f.host.trial(), true);
  const id = starts(f.sent)[0].id;
  assert.equal(f.polls(), 0, 'nothing polls your input while it plays');
  for (let i = 0; i < 40; i++) { f.idle = 0.05; f.advance(200); }
  assert.equal(f.sent.filter(c => c.type === 'cancel').length, 0, 'keys and the mouse going on: she stays');
  f.host.report({ id, phase: 'hold', cancelled: 'pull' });
  assert.equal(f.host.active, true, 'the page backs her off itself; the host only hears of it');
  f.host.report({ id: 'peek-old-1', phase: 'done' });
  assert.equal(f.host.active, true, 'a report for another id changes nothing');
  assert.equal(parsePeekReport({ id, phase: 'done', extra: 1 }), null);
  assert.equal(parsePeekReport({ id: '../x', phase: 'done' }), null);
});

test('host: I-192: a reply starting mid-peek does not back her off; nor a full-screen program (I-199); a trial ignores idle, cooldown and full screen but not being shown', () => {
  const f = fakeHost({ idle: 0 });
  assert.equal(f.host.trial(), true, 'idle 0 and no cooldown check');
  f.host.chat('delta');
  assert.equal(f.sent[f.sent.length - 1].type, 'start', 'she stays while she speaks');
  const g = fakeHost();
  g.host.trial(); g.fullscreen = true; g.host.tick(); g.advance(200);
  assert.equal(g.sent.filter(c => c.type === 'cancel').length, 0, 'a full-screen program in front never ends a peek');
  assert.equal(g.host.active, true);
  const fs = fakeHost(); fs.fullscreen = true;
  assert.equal(fs.host.trial(), true, 'asked for: a full-screen program does not hold a trial back');
  const auto = fakeHost(); auto.fullscreen = true; auto.host.tick();
  assert.match(auto.host.view().blocked ?? '', /全屏/, 'her own peek waits (information, autonomous only)');
  const h = fakeHost(); h.shown = false;
  assert.equal(h.host.trial(), false);
  const k = fakeHost(); k.host.chat('delta'); k.host.tick();
  assert.match(k.host.view().blocked ?? '', /说话/, 'never starts while she speaks');
});

test('host: answered → one small O lift; ignored → nothing; a trial never writes; after the window nothing', () => {
  const f = fakeHost();
  for (let i = 0; i < 60 && !starts(f.sent).length; i++) { f.advance(1000); f.host.tick(); }
  const id = starts(f.sent)[0].id;
  f.host.report({ id, phase: 'done' });
  f.advance(5_000); f.host.tick();
  assert.equal(f.answered, 0, 'nothing yet');
  f.last = f.now; f.host.tick(); f.host.tick();
  assert.equal(f.answered, 1, 'you talked to her: once');
  f.host.report({ id, phase: 'done', clicked: true });
  assert.equal(f.answered, 1, 'never twice for one peek');
  // Ignored.
  const g = fakeHost();
  for (let i = 0; i < 60 && !starts(g.sent).length; i++) { g.advance(1000); g.host.tick(); }
  g.host.report({ id: starts(g.sent)[0].id, phase: 'done' });
  for (let i = 0; i < 40; i++) { g.advance(1000); g.host.tick(); }
  g.last = g.now; g.host.tick();
  assert.equal(g.answered, 0, 'after the answer window: nothing');
  // A click on her right after a trial: nothing (the button is not a bid of hers).
  const h = fakeHost();
  h.host.trial();
  const tid = starts(h.sent)[0].id;
  h.host.report({ id: tid, phase: 'done' });
  h.host.report({ id: tid, phase: 'done', clicked: true });
  h.last = h.now + 1; h.host.tick();
  assert.equal(h.answered, 0);
  // A click on her after a real peek counts.
  const k = fakeHost();
  for (let i = 0; i < 60 && !starts(k.sent).length; i++) { k.advance(1000); k.host.tick(); }
  const kid = starts(k.sent)[0].id;
  k.host.report({ id: kid, phase: 'settle' });
  k.host.report({ id: kid, phase: 'settle', clicked: true });
  assert.equal(k.answered, 1);
});

test('mood: peek-answered is O only, up only, and shares the answered-bid family (never a second O for the same answer)', () => {
  const spec = MOOD_MOMENTS['peek-answered'];
  assert.deepEqual(Object.keys(spec.delta), ['O']);
  assert.ok((spec.delta.O ?? 0) > 0 && (spec.delta.O ?? 0) <= 1.5);
  assert.equal(spec.group, MOOD_MOMENTS['spoke-answered'].group);
  assert.equal(spec.keepReason, true);
  assert.equal(spec.longingEase, undefined, 'never writes M');
  // Her mood read relative to the card's baseline; A, B, M as they are.
  const reading = peekMoodFrom({ snapshot: { values: { D: 70, O: 50, E: 50, N: 50, C: 50 }, boredom: 30, longing: 5 }, parameters: { baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, evidence: { level: 1 } }, fatigue: { A: 0.4, sleeping: false } });
  assert.ok(reading && reading.D > 50 && reading.O === 50 && reading.A === 0.4 && reading.B === 30 && reading.M === 5);
});

test('control patch: the trial button and the knobs are strict', () => {
  assert.deepEqual(parseUnboundControlPatch({ peekNow: true }), { peekNow: true });
  assert.throws(() => parseUnboundControlPatch({ peekNow: false }));
  assert.deepEqual(parseUnboundControlPatch({ peekIdleSeconds: 45, peekCooldownMinutes: 20, peekPerHour: 2, peekSoftness: 0.35 }), { peekIdleSeconds: 45, peekCooldownMinutes: 20, peekPerHour: 2, peekSoftness: 0.35 });
  assert.throws(() => parseUnboundControlPatch({ peekIdleSeconds: 5 }));
  assert.throws(() => parseUnboundControlPatch({ peekPerHour: 99 }));
  assert.throws(() => parseUnboundControlPatch({ peekSoftness: 2 }));
});
