/**
 * I-081 (docs/claude/2026-11-11-i081-gaze.md): with pose sensing on she picks between looking at you and at the mouse.
 * Synthetic data only: no camera, no model call, no network. I081_REPORT=1 prints the stage numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GazeAttention, NEUTRAL_GAZE_MOOD, gazeMoodFrom, type GazeAttentionEvent, type GazeAttentionInput, type GazeMood, type GazeTarget } from '../shared/behaviors/gaze-attention/choose';
import { GAZE_YAW_PER_UNIT, userAim, userGazePoint } from '../shared/behaviors/gaze-attention/geometry';
import { GAZE_JOURNAL_REASON, GAZE_JOURNAL_WHY_WORDS, parseUserGazeReading, type UserGazeReading } from '../shared/behaviors/gaze-attention/interface';
import { GAZE_ATTENTION_KNOBS, type GazeAttentionKnobs } from '../shared/behaviors/gaze-attention/knobs';
import { StageGazeAttention } from '../src/senses/gaze-attention-stage';
import { UserGazeHost, parseGazeFact } from '../electron/senses/user-gaze';
import { MoodMoments } from '../electron/mood/mood-moments';
import { MOOD_MOMENTS } from '../shared/foundation/mood-moments';
import { buildJournalEntry, describeJournalEntry, moodEventSource } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';
import { EMPTY_POSE_SIGNAL, type PoseSignal } from '../shared/senses/pose-signals';
import { parseFrameReply, WATCH_FRAME_SYSTEM_PROMPT } from '../shared/behaviors/watch-timeline/prompts';
import { WatchSession } from '../electron/senses/watch-notes/session';
import { WatchNotesStore } from '../electron/senses/watch-notes/store';
import { ScreenshotCache } from '../electron/senses/watch-notes/screenshots';
import { KeywordIndexStore } from '../electron/memory/memory-keywords/store';
import { WATCH_TIMELINE_KNOBS } from '../shared/behaviors/watch-timeline/knobs';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';

const REPORT = !!process.env.I081_REPORT;
/** A fixed pseudo-random sequence (no Math.random): the same run every time. */
function seeded(seed = 7): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const HERE = { present: true, facing: 'toward' as const, energy: 0.1 };
const input = (over: Partial<GazeAttentionInput> = {}): GazeAttentionInput => ({ dt: 1 / 60, user: HERE, mouse: true, allowed: true, mood: NEUTRAL_GAZE_MOOD, ...over });

/** Runs the chooser for `seconds` at `fps`; returns per-frame targets and weights, and the events. */
function simulate(seconds: number, over: Partial<GazeAttentionInput> = {}, seed = 7, knobs: GazeAttentionKnobs = GAZE_ATTENTION_KNOBS, fps = 60) {
  const chooser = new GazeAttention(seeded(seed), knobs);
  const frames: { target: GazeTarget | null; user: number; mouse: number; away: number; awayX: number; awayY: number }[] = [];
  const events: GazeAttentionEvent[] = [];
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const f = chooser.frame(input({ dt: 1 / fps, ...over }));
    frames.push({ ...f });
    events.push(...chooser.takeEvents());
  }
  return { frames, events, fps };
}
/** Stretches of one target: [target, seconds]. */
function stretches(frames: readonly { target: GazeTarget | null }[], fps: number): [GazeTarget | null, number][] {
  const out: [GazeTarget | null, number][] = [];
  for (const frame of frames) { const last = out.at(-1); if (last && last[0] === frame.target) last[1] += 1 / fps; else out.push([frame.target, 1 / fps]); }
  return out;
}
const share = (frames: readonly { target: GazeTarget | null }[], target: GazeTarget) => frames.filter(f => f.target === target).length / frames.length;
const mood = (over: Partial<GazeMood>): GazeMood => ({ ...NEUTRAL_GAZE_MOOD, ...over });

// ---------------------------------------------------------------- step 2: camera → where she looks

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const petAt = (x: number, y: number) => ({ x, y, width: 400, height: 560 });

test('geometry: the camera frame is not mirrored — you on the left of the picture are on the right of the screen, and she turns that way', () => {
  const pet = petAt(760, 400); // her window in the middle of the screen
  const centre = userGazePoint({ x: 0.5, y: 0.5 }, DISPLAY, pet)!;
  const leftOfPicture = userGazePoint({ x: 0.2, y: 0.5 }, DISPLAY, pet)!;
  const rightOfPicture = userGazePoint({ x: 0.8, y: 0.5 }, DISPLAY, pet)!;
  // The pointer's convention (electron/main.ts "pointer"): x > 0 = right of her window as seen on the screen.
  assert.ok(Math.abs(centre.x) < 0.01, `a user straight in front of the camera is in front of her window's middle: ${centre.x}`);
  assert.ok(leftOfPicture.x > 0.5, `left of the picture = the user's right = the screen's right: ${leftOfPicture.x}`);
  assert.ok(rightOfPicture.x < -0.5, `right of the picture = the screen's left: ${rightOfPicture.x}`);
  // From her eyes: the same sign as a mouse on that side (gazeTargets' x > 0 turns her toward the screen's right).
  assert.ok(userAim(leftOfPicture, 0, 0).x > 0 && userAim(rightOfPicture, 0, 0).x < 0);
  // The user higher in the picture is higher above the screen: she looks up more (y > 0 is up, as the pointer).
  const high = userGazePoint({ x: 0.5, y: 0.2 }, DISPLAY, pet)!, low = userGazePoint({ x: 0.5, y: 0.8 }, DISPLAY, pet)!;
  assert.ok(high.y > low.y);
});

test('geometry: her window position decides the direction — a user in the middle is to her left when she sits on the right, and above her when she sits low', () => {
  const face = { x: 0.5, y: 0.5 };
  const onRight = userAim(userGazePoint(face, DISPLAY, petAt(1500, 500))!, 0, 0);
  const onLeft = userAim(userGazePoint(face, DISPLAY, petAt(20, 500))!, 0, 0);
  assert.ok(onRight.x < -0.2, `she on the right looks left: ${onRight.x}`);
  assert.ok(onLeft.x > 0.2, `she on the left looks right: ${onLeft.x}`);
  assert.ok(onRight.y > 0.2, `the camera (and you) are above her window: ${onRight.y}`);
  // Her eyes are not her window's middle: the origin is taken off (same as the mouse).
  const point = userGazePoint(face, DISPLAY, petAt(760, 400))!;
  assert.ok(userAim(point, 0.5, 0).x < userAim(point, 0, 0).x);
  // Only part of the way (aim), and never more than the true angle.
  const full = userAim(userGazePoint({ x: 0.1, y: 0.5 }, DISPLAY, petAt(760, 400))!, 0, 0, 1);
  const part = userAim(userGazePoint({ x: 0.1, y: 0.5 }, DISPLAY, petAt(760, 400))!, 0, 0, 0.5);
  assert.ok(Math.abs(part.x - full.x / 2) < 1e-9);
  assert.ok(Math.abs(full.x * GAZE_YAW_PER_UNIT) < Math.PI / 2);
  // A second display to the right: the camera is on the display she is on.
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.ok(Math.abs(userGazePoint(face, second, petAt(1920 + 760, 400))!.x) < 0.01);
  // Nothing usable: no point.
  for (const bad of [null, { x: NaN, y: 0.5 }] as const) assert.equal(userGazePoint(bad, DISPLAY, petAt(0, 0)), null);
  assert.equal(userGazePoint(face, { ...DISPLAY, width: 0 }, petAt(0, 0)), null);
  assert.equal(userGazePoint(face, DISPLAY, null), null);
});

test('the pet window reads only its own checked fields of the host reading', () => {
  const ok: UserGazeReading = { present: true, facing: 'toward', energy: 0.2, point: { x: -1.2, y: 2.4, dx: 9.6, dy: 6.86 }, screen: 'typing' };
  assert.deepEqual(parseUserGazeReading(JSON.parse(JSON.stringify(ok))), ok);
  assert.deepEqual(parseUserGazeReading({ ...ok, face: { x: 0.3, y: 0.4 }, points: [] }), ok, 'extra fields are dropped, never passed on');
  for (const bad of [{ facing: 'left' }, { energy: 2 }, { present: 'yes' }, { screen: 'exciting' }, { point: { x: NaN, y: 0, dx: 1, dy: 1 } },
    { point: { x: 0, y: 0, dx: 0, dy: 1 } }, { point: { x: 99, y: 0, dx: 1, dy: 1 } }, { point: [1, 2] }])
    assert.equal(parseUserGazeReading({ ...ok, ...bad }), null, JSON.stringify(bad));
  assert.equal(parseUserGazeReading(null), null);
});

// ---------------------------------------------------------------- step 1: the chooser

test('pose off, nobody there or not facing her: exactly the old gaze (the mouse, weight 1) every frame, no events', () => {
  for (const over of [{ user: null }, { user: { present: false, facing: 'unknown' as const, energy: 0 } }, { user: { present: true, facing: 'side' as const, energy: 0.3 } },
    { user: { present: true, facing: 'away' as const, energy: 0 } }, { allowed: false }, { mouse: false, user: null }]) {
    const run = simulate(30, over);
    assert.ok(run.frames.every(f => f.mouse === 1 && f.user === 0 && f.away === 0 && f.target === null), JSON.stringify(over));
    assert.deepEqual(run.events, []);
  }
});

test('you come and face her: after a moment she looks at you first, then picks by herself (with random dwell, never a fixed schedule)', () => {
  const chooser = new GazeAttention(seeded(3));
  for (let i = 0; i < 30; i++) chooser.frame(input({ user: null }));
  let first: GazeTarget | null = null, frames = 0;
  while (!first && frames < 120) { first = chooser.frame(input()).target; frames++; }
  assert.equal(first, 'user');
  assert.ok(frames / 60 >= GAZE_ATTENTION_KNOBS.arriveS - 1e-9, 'not at once: you have been there a moment');
  assert.deepEqual(chooser.takeEvents(), [{ kind: 'start', why: 'arrived' }]);
  const run = simulate(240);
  const parts = stretches(run.frames, run.fps).filter(([target]) => target).slice(0, -1); // the last one is cut by the end of the run
  const userDwells = parts.filter(([t]) => t === 'user').map(([, s]) => s), mouseDwells = parts.filter(([t]) => t === 'mouse').map(([, s]) => s);
  assert.ok(new Set(userDwells.map(s => s.toFixed(1))).size > 5, `user dwells vary: ${userDwells.map(s => s.toFixed(1))}`);
  assert.ok(Math.min(...userDwells) >= 1 && Math.max(...userDwells) <= 8, `looking at you is a few seconds: ${userDwells.map(s => s.toFixed(1))}`);
  const sorted = [...mouseDwells].sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median <= 2.5 && sorted[Math.floor(sorted.length * 0.9)] <= 4.5, `a glance at the mouse is a second or two (now and then a little longer): ${mouseDwells.map(s => s.toFixed(1))}`);
  assert.ok(share(run.frames, 'user') > share(run.frames, 'mouse'), 'she looks at you more than at the mouse (user: "可以看用户多一些")');
});

test('never a constant stare: after looking at you she always looks away or at the mouse before looking back', () => {
  for (const over of [{}, { mood: mood({ O: 1, M: 1 }) }, { mouse: false }, { speaking: true }, { screen: 'typing' as const }]) {
    const run = simulate(300, over, 11);
    const parts = stretches(run.frames, run.fps).filter(([target]) => target);
    for (let i = 1; i < parts.length; i++) assert.ok(!(parts[i][0] === 'user' && parts[i - 1][0] === 'user'), 'never user twice in a row');
    const longest = Math.max(...parts.filter(([t]) => t === 'user').map(([, s]) => s));
    assert.ok(longest <= 12, `${JSON.stringify(over)}: longest look at you ${longest.toFixed(1)} s`);
    if ('mouse' in over) assert.equal(run.frames.filter(f => f.target === 'mouse').length, 0, '"跟着鼠标看" off: the mouse is never a target');
  }
});

test('mood read: O and M bring her eyes to you more; D and B to the mouse; N and C check you more often but briefly; A switches less', () => {
  const runs = (over: Partial<GazeAttentionInput>) => [1, 2, 3, 4].map(seed => simulate(600, over, seed, GAZE_ATTENTION_KNOBS, 30));
  const userShare = (over: Partial<GazeAttentionInput>) => runs(over).reduce((sum, run) => sum + share(run.frames, 'user'), 0) / 4;
  const mouseShare = (over: Partial<GazeAttentionInput>) => runs(over).reduce((sum, run) => sum + share(run.frames, 'mouse'), 0) / 4;
  const userLooks = (over: Partial<GazeAttentionInput>) => {
    const all = runs(over).flatMap(run => stretches(run.frames, run.fps).filter(([t]) => t === 'user').map(([, s]) => s));
    return { count: all.length, mean: all.reduce((a, b) => a + b, 0) / all.length };
  };
  const switches = (over: Partial<GazeAttentionInput>) => runs(over).reduce((sum, run) => sum + stretches(run.frames, run.fps).length, 0);
  const neutral = userShare({}), close = userShare({ mood: mood({ O: 1, M: 0.8 }) }), distant = userShare({ mood: mood({ O: -1 }) });
  // The pick weights alone (dwell knobs off): O/M still pick you more, D/B the mouse more.
  const weightsOnly = { ...GAZE_ATTENTION_KNOBS, mood: { ...GAZE_ATTENTION_KNOBS.mood, closeDwell: 0, curiousDwell: 0 } };
  const picks = (over: Partial<GazeAttentionInput>, target: GazeTarget) => [1, 2, 3, 4].reduce((sum, seed) => sum + share(simulate(600, over, seed, weightsOnly, 30).frames, target), 0) / 4;
  assert.ok(picks({ mood: mood({ O: 1, M: 0.8 }) }, 'user') > picks({}, 'user') + 0.03, 'O/M raise the weight of picking you');
  assert.ok(picks({ mood: mood({ D: 1, B: 0.8 }) }, 'mouse') > picks({}, 'mouse') + 0.03, 'D/B raise the weight of picking the mouse');
  const curiousMouse = mouseShare({ mood: mood({ D: 1, B: 0.8 }) }), neutralMouse = mouseShare({});
  const tense = userLooks({ mood: mood({ N: 1, C: 0.6 }) }), calm = userLooks({});
  const sleepy = switches({ mood: mood({ A: 1 }) }), awake = switches({});
  if (REPORT) console.log(JSON.stringify({ neutral, close, distant, curiousMouse, neutralMouse, tense, calm, sleepy, awake }));
  assert.ok(close > neutral + 0.05 && neutral > distant + 0.03, `O/M: ${distant.toFixed(2)} < ${neutral.toFixed(2)} < ${close.toFixed(2)}`);
  assert.ok(curiousMouse > neutralMouse + 0.05, `D/B: mouse ${neutralMouse.toFixed(2)} → ${curiousMouse.toFixed(2)}`);
  assert.ok(tense.mean < calm.mean * 0.85, `N/C: shorter looks ${calm.mean.toFixed(2)} → ${tense.mean.toFixed(2)} s`);
  assert.ok(tense.count > calm.count, `N/C: more looks ${calm.count} → ${tense.count}`);
  assert.ok(sleepy < awake * 0.85, `A: fewer switches ${awake} → ${sleepy}`);
});

test('her mood view becomes the numbers the chooser reads (relative to the card baseline; B and M from the snapshot; A from fatigue)', () => {
  const view = { parameters: { baseline: { D: 50, O: 40, E: 50, N: 50, C: 50 }, evidence: { level: 1 }, weights: { cautious: 1.5 } },
    snapshot: { values: { D: 75, O: 70, E: 50, N: 50, C: 25 }, boredom: 40, longing: 20, blush: { amount: 0.5 } }, fatigue: { A: 0.6 } };
  const read = gazeMoodFrom(view);
  assert.equal(read.D, 0.5); assert.equal(read.O, 0.5); assert.equal(read.N, 0); assert.equal(read.C, -0.5);
  assert.equal(read.B, 0.4); assert.equal(read.M, 0.2); assert.equal(read.A, 0.6);
  assert.ok(read.shy > 0.6, `a blush and a cautious card make her shy: ${read.shy}`);
  assert.deepEqual(gazeMoodFrom(null), NEUTRAL_GAZE_MOOD);
  assert.deepEqual(gazeMoodFrom({ snapshot: { values: { O: NaN } } }), NEUTRAL_GAZE_MOOD);
});

test('shy: on eye contact she looks away briefly and comes back to you; not shy: she holds it and it counts as eye contact', () => {
  const shy = simulate(120, { mood: mood({ shy: 1 }) }, 5);
  const shyEvents = shy.events.filter(e => e.kind === 'shy').length;
  assert.ok(shyEvents >= 1, 'a shy look-away happened');
  const parts = stretches(shy.frames, shy.fps).filter(([t]) => t);
  // A shy look-away is short and followed by a look back at you.
  let back = 0;
  for (let i = 1; i + 1 < parts.length; i++) if (parts[i - 1][0] === 'user' && parts[i][0] === 'away' && parts[i][1] <= 1.6 && parts[i + 1][0] === 'user') back++;
  assert.ok(back >= 1, 'she looked back after looking away');
  const rarely = { ...GAZE_ATTENTION_KNOBS, weights: { ...GAZE_ATTENTION_KNOBS.weights, user: 0.0001 } };
  const forced = stretches(simulate(30, { mood: mood({ shy: 1 }) }, 5, rarely).frames, 60).filter(([t]) => t).map(([t]) => t);
  assert.deepEqual(forced.slice(0, 3), ['user', 'away', 'user'], 'first look, the shy look-away, and back to you (not a free pick)');
  const bold = simulate(120, { mood: mood({ shy: 0 }) }, 5);
  assert.equal(bold.events.filter(e => e.kind === 'shy').length, 0);
  assert.ok(bold.events.some(e => e.kind === 'eye-contact'), 'eye contact counted');
  // Eye contact needs you to face her: present but turned away for good → no eye contact, and she stops looking your way.
  const chooser = new GazeAttention(seeded(9));
  for (let i = 0; i < 60; i++) chooser.frame(input());
  for (let i = 0; i < 300; i++) chooser.frame(input({ user: { present: true, facing: 'side', energy: 0 } }));
  const events = chooser.takeEvents();
  assert.ok(!events.some(e => e.kind === 'eye-contact'));
  assert.deepEqual(events.at(-1), { kind: 'stop', why: 'turned' });
});

test('stop: you leave, sensing goes off, or she falls asleep — each says why, and she eases back to exactly the old gaze', () => {
  for (const [over, why] of [[{ user: { present: false, facing: 'unknown' as const, energy: 0 } }, 'left'], [{ user: null }, 'off'], [{ allowed: false }, 'asleep']] as const) {
    const chooser = new GazeAttention(seeded(2));
    for (let i = 0; i < 120; i++) chooser.frame(input());
    chooser.takeEvents();
    let last = chooser.frame(input(over));
    for (let i = 0; i < 200; i++) last = chooser.frame(input(over));
    assert.deepEqual(chooser.takeEvents(), [{ kind: 'stop', why }]);
    assert.deepEqual([last.engaged, last.user, last.mouse, last.away, last.target], [false, 0, 1, 0, null]);
  }
  // Turning back to her after a turn away: 'facing', not 'arrived'.
  const chooser = new GazeAttention(seeded(2));
  for (let i = 0; i < 120; i++) chooser.frame(input());
  for (let i = 0; i < 120; i++) chooser.frame(input({ user: { present: true, facing: 'away', energy: 0 } }));
  for (let i = 0; i < 120; i++) chooser.frame(input());
  assert.deepEqual(chooser.takeEvents().filter(e => e.kind === 'start' || e.kind === 'stop'),
    [{ kind: 'start', why: 'arrived' }, { kind: 'stop', why: 'turned' }, { kind: 'start', why: 'facing' }]);
});

test('screen interest (haiku, same call): a lively screen draws her to the screen side; you typing draws her to you', () => {
  const avg = (over: Partial<GazeAttentionInput>, target: GazeTarget) => [1, 2, 3].reduce((sum, seed) => sum + share(simulate(400, over, seed, GAZE_ATTENTION_KNOBS, 30).frames, target), 0) / 3;
  const unknown = { mouse: avg({}, 'mouse'), user: avg({}, 'user') };
  const lively = avg({ screen: 'lively' }, 'mouse'), typing = avg({ screen: 'typing' }, 'user');
  if (REPORT) console.log(JSON.stringify({ unknown, lively, typing }));
  assert.ok(lively > unknown.mouse + 0.08, `lively: mouse ${unknown.mouse.toFixed(2)} → ${lively.toFixed(2)}`);
  assert.ok(typing > unknown.user + 0.04, `typing: you ${unknown.user.toFixed(2)} → ${typing.toFixed(2)}`);
  assert.ok(avg({ screen: 'typing' }, 'mouse') > 0.03, 'typing: an occasional glance at the screen');
});

test('praise: a fresh warm moment turns her eyes to you once', () => {
  const chooser = new GazeAttention(seeded(4));
  let f = chooser.frame(input());
  for (let i = 0; i < 2000 && f.target !== 'mouse'; i++) f = chooser.frame(input());
  assert.equal(f.target, 'mouse');
  f = chooser.frame(input({ praised: true }));
  assert.equal(f.target, 'user');
});

// ---------------------------------------------------------------- step 3: smooth blending (no jump per frame)

test('switching targets blends smoothly: no frame jumps, the speed changes gently — smoother than today\'s mouse jump of the same size', () => {
  const MOUSE = { x: 0.8, y: 0.1 }, USER = { x: -0.5, y: 0.4 };
  for (const fps of [60, 30]) {
    const run = simulate(120, {}, 6, GAZE_ATTENTION_KNOBS, fps);
    const aim = run.frames.map(f => ({ x: f.mouse * MOUSE.x + f.user * USER.x + f.away * (USER.x + f.awayX), y: f.mouse * MOUSE.y + f.user * USER.y + f.away * (USER.y + f.awayY) }));
    let step = 0, surprise = 0;
    for (let i = 2; i < aim.length; i++) {
      const v1 = { x: aim[i].x - aim[i - 1].x, y: aim[i].y - aim[i - 1].y }, v0 = { x: aim[i - 1].x - aim[i - 2].x, y: aim[i - 1].y - aim[i - 2].y };
      step = Math.max(step, Math.hypot(v1.x, v1.y)); surprise = Math.max(surprise, Math.hypot(v1.x - v0.x, v1.y - v0.y));
    }
    // Today's mouse jump of the whole distance (pointer-keys: a straight line over at least 0.05 s, from rest).
    const distance = Math.hypot(MOUSE.x - USER.x, MOUSE.y - USER.y) + 0.3, keyFrames = Math.max(1, Math.round(0.1 * fps));
    const pointerJump = distance / keyFrames;
    if (REPORT) console.log(JSON.stringify({ fps, step, surprise, pointerJumpStep: pointerJump, pointerJumpSurprise: pointerJump }));
    assert.ok(step < pointerJump, `${fps} fps: the largest per-frame step ${step.toFixed(3)} < a mouse jump's ${pointerJump.toFixed(3)}`);
    assert.ok(surprise < pointerJump * 0.75, `${fps} fps: the speed never changes at once (${surprise.toFixed(3)})`);
    assert.ok(surprise < step * 0.5, `${fps} fps: speed builds up and eases off (eased, not linear): ${surprise.toFixed(3)} vs ${step.toFixed(3)}`);
    // The weights always add up to one and stay in range.
    for (const f of run.frames) { assert.ok(Math.abs(f.user + f.mouse + f.away - 1) < 1e-9); assert.ok(f.user >= 0 && f.mouse >= 0 && f.away >= 0); }
  }
});

const pick = (out: { active: boolean; x: number; y: number; userX: number; userY: number }) => ({ active: out.active, x: out.x, y: out.y, userX: out.userX, userY: out.userY });

test('stage side: pose off gives exactly the old aim; pose on blends toward where you are; you leaving fades back without a jump', () => {
  const stage = new StageGazeAttention(seeded(8));
  const mouse = { mouseX: 0.6, mouseY: -0.2 };
  const base = { delta: 1 / 60, follow: true, allowed: true, ...mouse, originX: 0.1, originY: 0.3, mood: null };
  for (let i = 0; i < 120; i++) {
    const out = stage.frame({ ...base, reading: null });
    assert.deepEqual(pick(out), { active: false, x: 0.6, y: -0.2, userX: 0, userY: 0 });
  }
  const reading: UserGazeReading = { present: true, facing: 'toward', energy: 0.1, point: { x: -2, y: 1.5, dx: 9.6, dy: 6.9 }, screen: null };
  const aims: { x: number; y: number; userX: number }[] = [];
  for (let i = 0; i < 600; i++) { const out = stage.frame({ ...base, reading }); aims.push({ x: out.x, y: out.y, userX: out.userX }); }
  const goal = userAim(reading.point!, 0.1, 0.3);
  assert.ok(Math.abs(aims.at(-1)!.userX - goal.x) < 1e-3, 'the "look at you" direction settles on where you are');
  assert.ok(aims.some(a => Math.abs(a.x - goal.x) < 0.02), 'she looks at you at times');
  assert.ok(aims.some(a => Math.abs(a.x - 0.6) < 0.02), 'and at the mouse at times');
  const moved = { ...reading, point: { ...reading.point!, x: 1.5 } };
  const first = stage.frame({ ...base, reading: moved }), before = first.userX; aims.push({ x: first.x, y: first.y, userX: first.userX });
  const second = stage.frame({ ...base, reading: moved }), after = second.userX; aims.push({ x: second.x, y: second.y, userX: second.userX });
  assert.ok(Math.abs(after - before) < 0.05, `you moved: she follows smoothly (${(after - before).toFixed(3)} in one frame)`);
  for (let i = 0; i < 120; i++) { const out = stage.frame({ ...base, reading: moved }); aims.push({ x: out.x, y: out.y, userX: out.userX }); }
  assert.ok(Math.abs(stage.frame({ ...base, reading: moved }).userX - userAim(moved.point, 0.1, 0.3).x) < 0.01, 'and arrives');
  for (let i = 0; i < 300; i++) { const out = stage.frame({ ...base, reading: { ...reading, present: false, point: null } }); aims.push({ x: out.x, y: out.y, userX: out.userX }); }
  let largest = 0;
  for (let i = 1; i < aims.length; i++) largest = Math.max(largest, Math.abs(aims[i].x - aims[i - 1].x), Math.abs(aims[i].userX - aims[i - 1].userX));
  assert.ok(largest < 0.12, `no jump while blending or fading: ${largest.toFixed(3)}`);
  const settled = stage.frame({ ...base, reading: null });
  assert.deepEqual(pick(settled), { active: false, x: 0.6, y: -0.2, userX: 0, userY: 0 }, 'back to exactly the old aim');
  assert.ok(!/[xy]"?\s*:\s*-?\d/u.test(stage.diagnostics(1e9).replace(/"(known|user|mouse|away)":/gu, '')), 'diagnostics carry no coordinates');
});

// ---------------------------------------------------------------- steps 4, 5: host, eye contact back to mood, journal

const at = (now: number) => () => now;
const signal = (over: Partial<PoseSignal> = {}): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, confidence: 0.9, facing: 'toward', posture: 'sitting', energy: 0.2, face: { x: 0.5, y: 0.4 }, ...over });

test('host: the reading is memory only, fresh a few seconds, in her window\'s units; sensing off forgets you at once', () => {
  let now = 1_000;
  const host = new UserGazeHost(() => now);
  assert.equal(host.read(petAt(760, 400), DISPLAY), null, 'nothing before a signal');
  host.note(signal());
  const reading = host.read(petAt(760, 400), DISPLAY)!;
  assert.deepEqual(Object.keys(reading).sort(), ['energy', 'facing', 'point', 'present', 'screen']);
  assert.deepEqual(reading.point, userGazePoint({ x: 0.5, y: 0.4 }, DISPLAY, petAt(760, 400)));
  host.screenInterest('lively');
  assert.equal(host.read(petAt(760, 400), DISPLAY)!.screen, 'lively');
  host.screenInterest('dramatic');
  assert.equal(host.read(petAt(760, 400), DISPLAY)!.screen, null, 'an unknown word is not known');
  now += GAZE_ATTENTION_KNOBS.camera.freshMs + 1;
  assert.equal(host.read(petAt(760, 400), DISPLAY), null, 'stale');
  host.note(signal()); host.sensing(false);
  assert.equal(host.read(petAt(760, 400), DISPLAY), null, 'sensing off: forgotten');
  host.note(signal({ present: false, facing: 'unknown', face: null }));
  assert.equal(host.read(petAt(760, 400), DISPLAY)!.point, null);
});

test('eye contact comes back to her mood as a small O lift with a cooldown, and only while pose says you face her', () => {
  const lifts: { id: string; delta: Record<string, number> }[] = [];
  let clock = Date.UTC(2026, 10, 11, 12);
  const moments = new MoodMoments({ clock: () => clock, current: () => 'gene',
    state: () => ({ values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, evidence: 1, primary: 'calm' }),
    lift: lift => { lifts.push(lift as never); return true; } });
  const lines: unknown[] = [];
  const host = new UserGazeHost(() => clock);
  const ports = { moment: () => moments.eyeContact(), record: (line: unknown) => lines.push(line) };
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), false, 'no pose signal: not counted');
  host.note(signal({ facing: 'side' }));
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), false, 'not facing her: not counted');
  host.note(signal());
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), true);
  assert.deepEqual(lifts.map(l => l.delta), [{ O: 1 }]);
  assert.match(lifts[0].id, /^moment-eye-contact-/u);
  clock += 60_000; host.note(signal());
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), false, 'inside the cooldown');
  clock += MOOD_MOMENTS['eye-contact'].cooldownMs; host.note(signal());
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), true, 'after the cooldown');
  assert.deepEqual(lines, [{ type: 'gaze', event: 'eye-contact' }, { type: 'gaze', event: 'eye-contact' }], 'one journal line per counted moment');
  assert.equal(moodEventSource('lift', '和你对视了一会儿'), 'moment-eye-contact');
  // The other facts are closed words only.
  assert.equal(host.fact({ kind: 'start', why: 'arrived' }, ports), true);
  assert.deepEqual(lines.at(-1), { type: 'gaze', event: 'start', why: 'arrived' });
  for (const bad of [{ kind: 'start' }, { kind: 'start', why: 'left' }, { kind: 'stop', why: 'arrived' }, { kind: 'shy', why: 'left' }, { kind: 'eye-contact', x: 0.3 },
    { kind: 'wink' }, null, 'shy', { kind: 'stop', why: 'off', face: { x: 0.5, y: 0.5 } }])
    assert.equal(parseGazeFact(bad), null, JSON.stringify(bad));
});

test('journal line: closed words in Chinese with an English copy, never a position', () => {
  const ok = (value: object) => buildJournalEntry({ type: 'gaze', characterId: 'gene', ...value }, Date.UTC(2026, 10, 11, 12));
  const start = ok({ event: 'start', why: 'arrived' })!;
  assert.deepEqual(Object.keys(start).sort(), ['at', 'characterId', 'event', 'reason', 'time', 'type', 'v', 'why']);
  assert.equal(start.reason, '她开始时不时看你');
  const tr = (text: string, ...args: unknown[]) => text.replace(/\{(\d)\}/gu,(_, i: string) => String(args[Number(i)]));
  assert.match(describeJournalEntry(start, tr), /她开始时不时看你（你来到电脑前）$/u);
  assert.deepEqual(Object.keys(ok({ event: 'eye-contact' })!).sort(), ['at', 'characterId', 'event', 'reason', 'time', 'type', 'v']);
  const smuggled = ok({ event: 'shy', x: 0.4, face: { x: 0.3, y: 0.2 }, points: [] })!;
  assert.deepEqual(Object.keys(smuggled).sort(), ['at', 'characterId', 'event', 'reason', 'time', 'type', 'v'], 'a position never reaches a line');
  for (const bad of [{ event: 'start' }, { event: 'start', why: 'left' }, { event: 'stop', why: 'facing' }, { event: 'eye-contact', why: 'arrived' }, { event: 'stare' }])
    assert.equal(ok(bad), null, JSON.stringify(bad));
  for (const words of [...Object.values(GAZE_JOURNAL_REASON), ...Object.values(GAZE_JOURNAL_WHY_WORDS), '和你对视了一会儿，觉得亲近了些'])
    assert.ok(ENGLISH_JOURNAL_UI_COPY[words], `English copy: ${words}`);
});

// ---------------------------------------------------------------- step 6: screen interest rides on the existing frame call

test('the frame description call also says how worth watching the screen is; parsed strictly, absent or odd = not known, the description is kept', async () => {
  assert.match(WATCH_FRAME_SYSTEM_PROMPT, /watch/u);
  assert.match(WATCH_FRAME_SYSTEM_PROMPT, /lively[\s\S]*calm[\s\S]*typing[\s\S]*idle/u);
  assert.equal(parseFrameReply(JSON.stringify({ description: '一个视频正在放', keywords: [], watch: 'lively' }))!.interest, 'lively');
  assert.equal(parseFrameReply(JSON.stringify({ description: '一个文档', keywords: [] }))!.interest, null);
  for (const odd of ['LIVELY', 'very lively', 3, ['lively'], { level: 'lively' }, null]) {
    const reply = parseFrameReply(JSON.stringify({ description: '一个文档', keywords: [], watch: odd }))!;
    assert.equal(reply.text, '一个文档', 'the description survives'); assert.equal(reply.interest, null, JSON.stringify(odd));
  }
  // The session hands it on from the same call: one describe, one interest.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i081-watch-'));
  try {
    let clock = 2_000_000_000_000, describes = 0;
    const told: unknown[] = [];
    const keywordStore = new KeywordIndexStore(directory), screenshots = new ScreenshotCache(directory, () => clock, WATCH_TIMELINE_KNOBS.notes);
    const notes = new WatchNotesStore(directory, { keywords: keywordStore, screenshots }, WATCH_TIMELINE_KNOBS.notes);
    const session = new WatchSession({ now: () => clock, characterId: () => 'gene', conditions: () => ({ watch: true, screen: true }),
      capture: async () => 'data:image/jpeg;base64,FRAME1', prepare: url => ({ thumb: new Uint8Array(576).fill(60), picture: url }),
      describe: async () => { describes++; return JSON.stringify({ description: '视频里两个人在跑', keywords: [], watch: 'lively' }); },
      summarize: async () => '{}', notes, screenshots, interest: kind => told.push(kind), createId: () => 'f1' });
    clock += 10_000; await session.tick(); await session.settled();
    assert.equal(describes, 1);
    assert.deepEqual(told, ['lively']);
    session.dispose();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('one knob: the user weight alone changes how much she looks at you, nothing else is touched', () => {
  const more = { ...GAZE_ATTENTION_KNOBS, weights: { ...GAZE_ATTENTION_KNOBS.weights, user: 4 } };
  const base = simulate(400, {}, 3, GAZE_ATTENTION_KNOBS, 30), boosted = simulate(400, {}, 3, more, 30);
  assert.ok(share(boosted.frames, 'user') > share(base.frames, 'user') + 0.05);
  assert.deepEqual(DEFAULT_MOOD_PARAMETERS.baseline, { D: 50, O: 50, E: 50, N: 50, C: 50 }, 'the mood model is not touched');
});

test('stage side: a switch moves the eyes and head straight from one target\'s split to the other\'s (blended after the split, never through straight ahead)', async () => {
  const { gazeTargets } = await import('../src/stage/procedural');
  const stage = new StageGazeAttention(seeded(8));
  // The mouse below her eyes, you up and to the left: the line between the two aims passes near straight ahead.
  const base = { delta: 1 / 60, follow: true, allowed: true, mouseX: 0.1, mouseY: -0.8, originX: 0, originY: 0, mood: null };
  const reading: UserGazeReading = { present: true, facing: 'toward', energy: 0, point: { x: -2.6, y: 3.2, dx: 9.6, dy: 6.9 }, screen: null };
  const mouse = gazeTargets(0.1, -0.8, true);
  // You are known first (facing aside), so where you are has settled before she turns to you.
  for (let i = 0; i < 240; i++) stage.frame({ ...base, reading: { ...reading, facing: 'side' } });
  let previous: GazeTarget | null = null, eyes: number[] = [], switched = false;
  for (let i = 0; i < 600 && !switched; i++) {
    const out = stage.frame({ ...base, reading });
    const split = out.targets(1, 0, 0, 0, true);
    const target = (stage as unknown as { last: { target: GazeTarget | null } }).last.target;
    if (target === 'user' && previous === null) eyes = [];
    if (target === 'user') eyes.push(split.eyeY);
    if (target === 'user' && eyes.length > 30) switched = true;
    previous = target;
  }
  assert.ok(switched, 'she turned to you');
  const user = gazeTargets(stage.frame({ ...base, reading }).userX, stage.frame({ ...base, reading }).userY, true);
  const low = Math.min(mouse.eyeY, user.eyeY) - 1e-9, high = Math.max(mouse.eyeY, user.eyeY) + 1e-9;
  assert.ok(eyes.every(value => value >= low && value <= high), `the eyes stay between the two targets' shares: ${eyes.map(v => v.toFixed(3)).join(' ')}`);
  for (let i = 1; i < eyes.length; i++) assert.ok(eyes[i] >= eyes[i - 1] - 1e-9, 'and move one way only');
  // Only the mouse (pose off): exactly the split the stage always made.
  const off = new StageGazeAttention(seeded(1)).frame({ ...base, reading: null });
  assert.deepEqual(off.targets(0.7, 0.01, -0.02, 0, true), { ...gazeTargets(0.1 * 0.7 + 0.01, -0.8 * 0.7 - 0.02, true) });
});
