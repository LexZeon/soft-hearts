// I-192 follow-up (Codex T-261, T-263; docs/claude/2026-11-22-i192-arrival-targets.md "2026-11-22 晚").
//  - T-261: on a model whose arms the engine cannot move (a VRM's standard body) nothing said the arms stayed still. The hug there is still the
//    whole hug (the face arrival: she walks over, her face comes, cheek turned); only her arms do not move, the page says so, and the host
//    records the hug with "arms still". A reply's hug goes through the host as on any model.
//  - T-263: the hold began when the lean's timer ended, wherever her face was (on every model the mouth was below the window then). Now the
//    hold starts when both eyes and her mouth are in the window and nothing of her head is nearer than the guard; a bounded wait, then she
//    holds where she is. The peek keeps one eye filling the screen (I-104, the user's); both eyes is an option (ARRIVAL_KNOBS.peekEyes).
// Real frame loop: tests/helpers/unbound-arrival.ts (the public Gene, the synthetic VRM). I192B_REPORT=1 prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL_KNOBS, alongToFit, frameWorst, headNow, inWindow, settledShift, turnHead, type FramedLens } from '../shared/unbound/arrival';
import { parsePeekReport, NEUTRAL_MOOD, type PeekCommand } from '../shared/unbound/director';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { closeMomentLine, type CloseHappened } from '../shared/unbound/close-moments';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { FRAME_PUSH_MAX_M } from '../src/unbound/motion/arrive';
import { peekBothDistance } from '../src/unbound/director/peek-lens';
import { axisOffset } from '../src/unbound/motion/lens-align';
import { REST_TARGETS, type MotionRequest } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { laptopLens } from './helpers/unbound-peek';
import { boneSurprises, inWindow as frameIn, max, pointSurprises, runArrival, type ArrivalFrame } from './helpers/unbound-arrival';

const REPORT = process.env.I192B_REPORT === '1';
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** The worst of her eyes and mouth in the window this frame (≤ 1: inside). */
const faceFrame = (f: ArrivalFrame) => Math.max(...[f.eyes.left, f.eyes.right, f.mouth].map(p => p ? Math.max(Math.abs(frameIn(f.view, p).u), Math.abs(frameIn(f.view, p).v)) : Infinity));

// ---- the pure rules ---------------------------------------------------------------------------------------------------------------------

const LENS: FramedLens = (() => {
  const w = { left: -0.31, right: 0.27, top: 0.2, bottom: -0.17 }, cx = (w.left + w.right) / 2, cy = (w.top + w.bottom) / 2, l = Math.hypot(cx, cy, 1);
  return { camera: { x: 0.1, y: 1.4, z: 0.55 }, axis: { x: cx / l, y: cy / l, z: -1 / l }, heightPerM: w.top - w.bottom, window: w };
})();

test('framing rules: where a point is in the window; how far along the axis points must go to fit (exactly, with an inset); none without a window', () => {
  const at = (x: number, y: number, d: number) => ({ x: LENS.camera.x + x * d, y: LENS.camera.y + y * d, z: LENS.camera.z - d });
  assert.deepEqual([inWindow(LENS, at(0.27, 0.2, 0.3))!.u, inWindow(LENS, at(0.27, 0.2, 0.3))!.v].map(r3), [1, 1], 'the top right corner');
  assert.deepEqual([inWindow(LENS, at(-0.31, -0.17, 0.5))!.u, inWindow(LENS, at(-0.31, -0.17, 0.5))!.v].map(r3), [-1, -1]);
  assert.equal(inWindow({ camera: LENS.camera, axis: LENS.axis }, at(0, 0, 1)), null, 'no window: not known');
  const points = [at(0.4, 0.1, 0.2), at(-0.2, -0.3, 0.2), at(0.1, 0.05, 0.25)];
  for (const inset of [0, 0.06, 0.3]) {
    const need = alongToFit(LENS, points, inset)!, moved = points.map(p => ({ x: p.x + LENS.axis.x * need, y: p.y + LENS.axis.y * need, z: p.z + LENS.axis.z * need }));
    assert.ok(need > 0, 'they must go farther');
    assert.ok(Math.abs(frameWorst(LENS, moved)! - (1 - inset)) < 1e-9, `moved by it, the worst sits exactly at the inset (${inset})`);
  }
  assert.ok(alongToFit(LENS, [at(0.01, 0.01, 0.3)], 0)! < 0, 'room to spare: negative');
  assert.equal(frameWorst(LENS, [at(0, 0, 0.2), null]), Infinity, 'an eye not known is not in frame');
});

test('framing rules: her head points where her eyes show her head turned (any heading); the loop delivers what its limits allow', () => {
  const restEyes = { x: 0, y: 0.06, z: 0.085 }, points = [{ x: 0, y: 0.03, z: 0.12 }, { x: 0.07, y: 0.08, z: 0.02 }, { x: -0.05, y: -0.02, z: 0.09 }];
  for (const heading of [0, 0.4, -1.2]) for (const [yaw, roll] of [[0, 0], [0.35, 0], [0.2, 0.15]]) {
    const head = { x: 0.3, y: 1.45, z: -0.6 }, toWorld = (p: { x: number; y: number; z: number }) => {
      const c = Math.cos(heading), s = Math.sin(heading); return { x: head.x + p.x * c + p.z * s, y: head.y + p.y, z: head.z - p.x * s + p.z * c };
    };
    const half = 0.031, left = toWorld(turnHead({ x: restEyes.x + half, y: restEyes.y, z: restEyes.z }, yaw, roll)), right = toWorld(turnHead({ x: restEyes.x - half, y: restEyes.y, z: restEyes.z }, yaw, roll));
    const now = headNow(points, restEyes, { head, left, right, heading })!;
    points.forEach((p, i) => {
      const want = toWorld(turnHead(p, yaw, roll));
      assert.ok(Math.hypot(now[i].x - want.x, now[i].y - want.y, now[i].z - want.z) < 1e-9, `point ${i} at heading ${heading}, yaw ${yaw}, roll ${roll}`);
    });
  }
  const free = settledShift({ x: 0.01, y: 0.02, z: -0.03 }, { lateral: 0, forward: 0, up: 0 }, 0.045, 0);
  assert.deepEqual([free.x, free.y, free.z].map(r3), [0.01, 0.02, -0.03], 'inside its limits: all of it');
  const toes = settledShift({ x: 0, y: 0.05, z: 0 }, { lateral: 0, forward: 0, up: 0.04 }, 0.045, 0);
  assert.equal(r3(toes.y), 0.005, 'her toes are nearly at their top: only what is left');
});

// ---- T-261: what played is what is recorded ---------------------------------------------------------------------------------------------

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
function rig() {
  let now = 1_700_000_000_000; const timers: (() => void)[] = [];
  const sent: PeekCommand[] = [], moments: string[] = [], happened: CloseHappened[] = [];
  const closePorts: CloseMomentPorts = {
    clock: () => now, random: () => 0.4, day: () => 'today', mood: () => ({ ...WARM }), view: () => null,
    typing: () => false, playing: () => false, moment: kind => { moments.push(kind); return true; }, happened: item => happened.push(item),
  };
  const close = new CloseMomentsHost(closePorts);
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.4, idleSeconds: () => 120, asleep: () => false, inCall: () => false, userTalking: () => true,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => false,
    every: (_ms, run) => { timers.push(run); return () => {}; }, close,
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: c => sent.push(c), changed: () => {} };
  const host = new PeekDirectorHost(ports, link);
  const starts = () => sent.filter((c): c is Extract<PeekCommand, { type: 'start' }> => c.type === 'start');
  return { host, close, moments, happened, starts, later(ms: number) { now += ms; } };
}
const finish = (f: ReturnType<typeof rig>, id: string) => { for (const phase of ['back', 'settle', 'done'] as const) f.host.report({ id, phase }); };

test('the host records what played: on a model whose arms cannot move the hug (her face came) is a hug, with "arms still" — never that they moved', () => {
  assert.deepEqual(parsePeekReport({ id: 'p-1', phase: 'hold', arms: false }), { id: 'p-1', phase: 'hold', arms: false });
  assert.equal(parsePeekReport({ id: 'p-1', phase: 'hold', arms: 'no' }), null, 'only booleans');
  assert.equal(parsePeekReport({ id: 'p-1', phase: 'hold', light: true }), null, 'no other keys');
  const f = rig();
  assert.equal(f.host.chatBeat('hug'), 'play', 'a reply\'s hug walks up as on any model');
  const id = f.starts()[0].id;
  f.host.report({ id, phase: 'lean', arms: false });
  assert.deepEqual(f.moments, [], 'not before the hold');
  f.host.report({ id, phase: 'hold', arms: false }); f.host.report({ id, phase: 'hold', arms: false });
  assert.deepEqual(f.moments, ['hug'], 'the hug is recorded once, at the hold');
  assert.equal(f.happened.length, 1);
  assert.equal(f.happened[0].arms, 'still', 'what played: her arms stayed still');
  assert.ok(!closeMomentLine(f.happened).includes('手'), 'her next line never says her arms moved');
  finish(f, id);
  assert.notEqual(f.close.history.lastAt(), null, 'the hug cooldown as for any hug');
  f.later(10 * 60_000);
  assert.equal(f.host.chatBeat('hug'), 'play', 'arms that cannot move are not a gate: the next hug walks up too');
  const kiss = rig();
  assert.equal(kiss.host.chatBeat('kiss'), 'play');
  kiss.host.report({ id: kiss.starts()[0].id, phase: 'hold', arms: false });
  assert.equal(kiss.happened[0].arms, undefined, 'a kiss needs no arms: nothing about them');
});

test('a hug that played with her arms is recorded as before (once, at the hold, nothing about still arms)', () => {
  const f = rig();
  assert.equal(f.host.chatBeat('hug'), 'play');
  const id = f.starts()[0].id;
  f.host.report({ id, phase: 'hold', arms: true }); f.host.report({ id, phase: 'hold', arms: true });
  assert.deepEqual(f.moments, ['hug']);
  assert.equal(f.happened.length, 1);
  assert.equal(f.happened[0].arms, undefined);
});

test('the page: on a model whose arms cannot move the hug is the whole hug — she walks over, her face arrives in the window, cheek turned; only her arms stay still, and the report says so', async () => {
  for (const fps of [60, 30]) {
    const reports: unknown[] = [], r = await runArrival('VRM', fps, 'hug', { reports, measureNear: fps === 60 });
    const phases = [...new Set(r.frames.map(f => f.phase).filter(Boolean))], parsed = reports.map(x => parsePeekReport(x)!);
    const hold = r.frames.filter(f => f.phase === 'hold');
    if (REPORT) console.log(`[I-192b VRM hug ${fps}]`, JSON.stringify({ phases, target: r.target, first: hold.length ? faceFrame(hold[0]) : null, arms: [...new Set(parsed.map(p => p.arms))] }));
    assert.deepEqual(phases, ['notice', 'walk', 'lean', 'hold', 'back', 'settle'], 'she walks over and back as on any model');
    assert.equal(r.target?.arrived, true, 'her face arrived');
    assert.ok(faceFrame(hold[0]) <= 1 && max(hold.map(faceFrame)) <= 1.02, 'both eyes and her mouth in the window');
    assert.ok(parsed.length > 0 && parsed.every(p => p.arms === false), 'every report: her arms cannot move here');
    if (fps === 60) {
      const near = r.frames.filter(f => f.nearest);
      assert.ok(Math.min(...near.map(f => f.nearest!.view - f.nearM)) > 0.005 && Math.min(...near.map(f => f.nearest!.all)) > 0, 'nothing of her in the camera');
    }
  }
  const geneReports: unknown[] = [];
  await runArrival('Gene', 60, 'hug', { reports: geneReports, measureNear: false, seconds: 14 });
  assert.ok(geneReports.map(x => parsePeekReport(x)!).every(p => p.arms === true), 'Gene: her arms can move');
});

const fakeGenerator = (requests: MotionRequest[]) => ({ generate: (request: MotionRequest) => { requests.push(request); return { ...REST_TARGETS }; }, reset() {} }) as never;
test('the page: a reply\'s hug on a model whose arms cannot move asks the host like on any model; its lighter one (when the host says so) opens no arms', () => {
  const lens = laptopLens(), HOME = { x: 0, z: -0.85 }, body = { sense: {} as never, setPoseTargets() {} };
  const gates = { shown: true, asleep: false, armsHeld: false, armsCan: false }, say = (player: UnboundSpeechBeats) => {
    player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word: 'hug', at: 0 }] } } as unknown as UnboundBubble);
    player.receive({ id: 'r1', type: 'delta', text: '抱一下。', rev: 1 } as UnboundBubble);
  };
  const asked: string[] = [];
  const play = new UnboundSpeechBeats(fakeGenerator([]), () => {}, word => { asked.push(word); return 'play'; });
  say(play);
  for (let k = 0; k < 10; k++) play.frame(1 / 60, lens, HOME, body, true, gates);
  assert.deepEqual(asked, ['hug'], 'asked');
  assert.deepEqual(play.played, ['hug', 'hug:play']);
  const requests: MotionRequest[] = [];
  const lighter = new UnboundSpeechBeats(fakeGenerator(requests), () => {}, () => 'lighter');
  say(lighter);
  for (let k = 0; k < 60; k++) lighter.frame(1 / 60, lens, HOME, body, true, gates);
  const showcase = requests.map(r => r.intent).filter(i => i.kind === 'showcase') as Extract<MotionRequest['intent'], { kind: 'showcase' }>[];
  assert.ok(showcase.length > 0 && showcase.every(i => !i.hands.left && !i.hands.right), 'the lighter one: no arms she cannot move');
});


// ---- T-263: the hold starts when her face is there --------------------------------------------------------------------------------------

test('Gene kiss 60 fps: the hold never begins before the lean is through, and begins only with both eyes and her mouth in the window', async () => {
  const r = await runArrival('Gene', 60, 'kiss', { measureNear: false, seconds: 20 });
  const lean = r.frames.find(f => f.phase === 'lean')!, hold = r.frames.find(f => f.phase === 'hold')!;
  const timerEnd = r.frames.find(f => f.t >= lean.t + (r.plan as { approachS: number }).approachS)!;
  if (REPORT) console.log('[I-192b Gene kiss gate]', JSON.stringify({ atTimer: faceFrame(timerEnd), atHold: faceFrame(hold), waitS: hold.t - timerEnd.t, target: r.target }));
  // I-203: the lean has its own clock now (it waits, eased, while her feet still step) and the kiss's eye dip brings her face up, so her face is
  // often in the window already when the lean is through; the rule is unchanged: never before the lean, only with her face there.
  assert.ok(hold.t >= timerEnd.t - 1e-9, `the hold never before the lean is through (${hold.t} vs ${timerEnd.t})`);
  assert.ok(faceFrame(hold) <= 1, `the hold begins with both eyes and her mouth in the window (${faceFrame(hold)})`);
  assert.equal(r.target?.arrived, true);
});

test('a window she cannot reach (I-203: shifted up by its own height, so the axis rises out of her reach): the wait is bounded — after it she backs off smoothly (T-264: it did not happen, no hold) and goes home', async () => {
  const shrink = (lens: FramedLens): FramedLens => {
    // I-203: a smaller window no longer works for this (the kiss now stands as far as fits the window); one whose middle is far above her does.
    const w = lens.window!, up = w.top - w.bottom, cx = (w.left + w.right) / 2, cy = (w.top + w.bottom) / 2 + up, z = -1, l = Math.hypot(cx, cy, z);
    return { ...lens, axis: { x: cx / l, y: cy / l, z: z / l }, window: { ...w, top: w.top + up, bottom: w.bottom + up } };
  };
  for (const fps of [60, 30]) {
    const r = await runArrival('Gene', fps, 'kiss', { measureNear: false, lensPatch: shrink as never, seconds: 30 }), k = 60 / fps;
    const phases = [...new Set(r.frames.map(f => f.phase).filter(Boolean))];
    const root = max(pointSurprises(r.frames.map(f => f.root))), head = max(pointSurprises(r.frames.map(f => f.head))), torso = max(boneSurprises(r.frames, r.boneNames.flatMap((n, i) => /^(センター|上半身2?|首|頭)$/.test(n) ? [i] : [])));
    if (REPORT) console.log(`[I-192b bounded ${fps}]`, JSON.stringify({ phases, target: r.target, holdS: r.holdS, root, head, torso }));
    assert.deepEqual(phases, ['notice', 'walk', 'lean', 'back', 'settle'], 'she never freezes, and never holds a kiss that did not arrive (T-264)');
    assert.equal(r.target?.arrived, false, 'not there');
    assert.ok(r.target!.framedM! <= r.target!.distanceM + FRAME_PUSH_MAX_M + 1e-9, `never pushed past her hips' reach (${r.target!.framedM} m)`);
    assert.ok(Math.abs(r.target!.waitS! - ARRIVAL_KNOBS.arriveWaitS) <= 1.5 / fps, `backed off after the bounded wait (${r.target!.waitS} s)`);
    assert.equal(r.holdS, 0, 'no hold');
    assert.ok(root < 0.1 * k * k && head < 0.35 * k * k && torso < 0.3 * k * k, `no jolt (root ${root}, head ${head} cm, torso ${torso}°)`);
    const end = r.frames.at(-1)!.root;
    assert.ok(Math.hypot(end.x - 0.25, end.z + 2) < 0.06, 'back home');
  }
});

for (const model of ['Gene', 'VRM'] as const) for (const fps of [60, 30]) {
  test(`${model} ${fps} fps: the peek keeps one eye filling the screen (I-104, the user's) — that eye on the axis and inside the window, nothing of her in the camera`, async () => {
    assert.equal(ARRIVAL_KNOBS.peekEyes, 1, 'one eye (the user decided it in I-104)');
    const r = await runArrival(model, fps, 'look');
    const hold = r.frames.filter(f => f.phase === 'hold'), settled = hold.slice(Math.round(0.6 * fps));
    // Her chosen eye: the one nearer the lens axis (metres off it), and where it is in the window.
    const eye = (f: ArrivalFrame) => [f.eyes.left, f.eyes.right].filter((e): e is NonNullable<typeof e> => !!e).map(e => ({ off: axisOffset(f.lens, e).off, at: frameIn(f.view, e) })).sort((a, b) => a.off - b.off)[0];
    const centre = max(settled.map(f => eye(f).off)), inside = max(settled.map(f => Math.max(Math.abs(eye(f).at.u), Math.abs(eye(f).at.v))));
    const near = r.frames.filter(f => f.nearest);
    const view = Math.min(...near.map(f => f.nearest!.view - f.nearM)), all = Math.min(...near.map(f => f.nearest!.all));
    if (REPORT) console.log(`[I-192b ${model} look ${fps}]`, JSON.stringify({ centre, along: settled.map(f => f.eyeAlong).filter((v): v is number => v !== null).map(r3).slice(0, 1), view, all, holdS: r.holdS }));
    assert.ok(centre < 0.012 && inside <= 1, `her chosen eye on the lens axis (${centre} m off) and in the window (${inside})`);
    assert.ok(view > 0.005 && all > 0, `beyond the near plane (+${view} m), never past the eye plane (${all} m)`);
    assert.ok(r.holdS >= (r.plan as { holdS: number }).holdS - 0.05, 'her own hold');
  });
}

test('the both-eyes option (peekEyes 2, off): far enough that both eyes and an eye\'s width fit across the window; nothing without a window', () => {
  const frame = { eyes: { left: { x: 0.033, y: 1.5, z: 0.08 }, right: { x: -0.033, y: 1.5, z: 0.08 } }, pivot: { x: 0, y: 1, z: 0 } };
  const w = { left: -0.37, right: 0.37, top: 0.22, bottom: -0.22 }, d = peekBothDistance(frame, 0.026, { window: w });
  const half = (0.033 + 0.6 * 0.026) / (d * (w.right - w.left) / 2);
  assert.ok(Math.abs(half - (1 - ARRIVAL_KNOBS.frameInset)) < 1e-9, `the outer edge sits at the inset (${half})`);
  assert.equal(peekBothDistance(frame, 0.026, {}), 0);
});


test('Gene 60 fps: with nothing else keeping her back (no window known, the plan asking for the 3.5 cm floor) the peek\'s own clip guard still stops her nose and bangs out of the camera', async () => {
  // The guard alone holds her back here (with both eyes framed, peekEyes 2, the window's width would): I192-peek-never-through-lens.
  const r = await runArrival('Gene', 60, 'look', { peekPatch: { eyeFill: 2 }, lensPatch: lens => ({ ...lens, window: undefined }) });
  const near = r.frames.filter(f => f.nearest), view = Math.min(...near.map(f => f.nearest!.view)), all = Math.min(...near.map(f => f.nearest!.all));
  const margin = Math.min(...near.map(f => f.nearest!.view - f.nearM));
  if (REPORT) console.log('[I-192b Gene look guard]', JSON.stringify({ view, all, margin }));
  assert.ok(r.frames.some(f => f.phase === 'hold'), 'she held the stare');
  assert.ok(view > ARRIVAL_KNOBS.minClearM - 0.01 && all > 0 && margin > 0.005, `nothing of her in the camera (${view} m in view, ${all} m nearest, +${margin} m)`);
});
