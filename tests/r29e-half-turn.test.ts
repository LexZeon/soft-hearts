/**
 * R29e (docs/claude/2026-11-02-R29e-half-turn.md): a blend whose two ends are
 * about a half turn (180 deg) apart must not switch to the other way round when
 * one end moves a little. The counterexample is Codex's T-002 / P-003 research:
 * MotionTransition kept a fixed start and took the shortest slerp to the live
 * target afresh every frame, so a target moving 0.2 deg across the half turn
 * flipped the display by ~179.9 deg (~13.6 deg still shown after the display
 * guard); the chat gesture layer (base -> sample at weight 0.7) flipped by ~108 deg.
 *
 * Raw = what the blend writes; shown = after the real display guard
 * (PoseContinuity with BaseSourceWatch, warm history), in the Stage's order.
 * R29_REPORT=1 prints the numbers recorded in the R29e page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip, AnimationMixer, Bone, BufferGeometry, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3,
} from 'three';
import { ChatGesturePlayer } from '../src/stage/chat-gesture';
import { captureMotionPose, handoffDurationMs, MotionTransition, switchDurationMs } from '../src/stage/motion-transition';
import { BaseSourceWatch, PoseContinuity, type WatchedMixer } from '../src/stage/pose-continuity';
import { catalogAsset, geneStage } from './helpers/gene-stage-harness';

const DEG = 180 / Math.PI;
const REPORT = !!process.env.R29_REPORT;
const ARM = '.bones[左腕].quaternion';
const Z = new Vector3(0, 0, 1);
const about = (axis: Vector3, degrees: number) => new Quaternion().setFromAxisAngle(axis.clone().normalize(), degrees / DEG);
const q = (degrees: number) => about(Z, degrees);
/** Orientation distance in degrees (q and -q are the same orientation). */
const distance = (a: Quaternion, b: Quaternion) => a.clone().normalize().angleTo(b.clone().normalize()) * DEG;
/** Component distance up to sign: for "the same value as before" checks below angleTo's float floor. */
const gap = (a: Quaternion, b: Quaternion) => Math.min(...[1, -1].map(sign =>
  Math.max(Math.abs(a.x - sign * b.x), Math.abs(a.y - sign * b.y), Math.abs(a.z - sign * b.z), Math.abs(a.w - sign * b.w))));
const f3 = (value: number) => value.toFixed(3);
const f6 = (value: number) => value.toFixed(6);

function rig() {
  const bone = new Bone(); bone.name = '左腕';
  const geometry = new BufferGeometry(), material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  mesh.add(bone); mesh.bind(new Skeleton([bone]));
  const mixer = new AnimationMixer(mesh);
  return { bone, mesh, mixer, close() { mixer.stopAllAction(); mixer.uncacheRoot(mesh); mesh.skeleton.dispose(); geometry.dispose(); material.dispose(); } };
}
/** A valid unit-quaternion track that sits at 180-e, crosses to 180+e (relative to identity) between `before` and `after`, then stays. */
function crossingClip(length: number, before: number, after: number, epsilon: number, moving = true): AnimationClip {
  const lower = q(180 - epsilon), upper = moving ? q(180 + epsilon) : lower;
  return new AnimationClip('r29e-crossing', length + 1, [new QuaternionKeyframeTrack(ARM, [0, before, after, length + 1],
    [...lower.toArray(), ...lower.toArray(), ...upper.toArray(), ...upper.toArray()])]);
}

// ------------------------------------------------------------------ 1. Codex's witness: bridge, raw and after the guard

type Kind = 'fixed400' | 'handoff' | 'switch';
const DURATION: Record<Kind, number | ((angle: number) => number)> = { fixed400: 400, handoff: handoffDurationMs, switch: switchDurationMs };
const EXPECTED_MS: Record<Kind, number> = { fixed400: 400, handoff: 800, switch: 1500 };
interface Crossing { rawStep: number; shownStep: number; targetStep: number; newJumps: number; durationMs: number }

/**
 * The Stage's order per frame (restore -> target -> guard.captureBase -> bridge -> guard.apply -> read -> guard.remove),
 * 10 ms frames up to the crossing, a zero-delta frame, then one frame across it (2e/10 s: the target moves 2e deg at 10 deg/s),
 * at the middle of the bridge. `moving: false` is the control: the same frames with the target held at 180-e.
 */
function bridgeCrossing(kind: Kind, epsilon: number, guarded: boolean, moving = true): Crossing {
  const h = rig(), bridge = new MotionTransition(h.mesh), watch = new BaseSourceWatch();
  const seconds = EXPECTED_MS[kind] / 1000, half = epsilon / 10, pre = seconds / 2 - half, post = seconds / 2 + half;
  const from = captureMotionPose(h.mesh);
  h.mixer.clipAction(crossingClip(seconds, pre, post, epsilon, moving)).play();
  const guard = guarded ? new PoseContinuity(h.mesh, { height: 1 }) : null;
  let t = 0;
  const step = (dt: number) => {
    bridge.restore(); h.mixer.update(dt); t += dt;
    const target = h.bone.quaternion.clone();
    guard?.captureBase(watch.observe(h.mixer as unknown as WatchedMixer, dt));
    bridge.frame(dt); const raw = h.bone.quaternion.clone();
    guard?.apply(dt, dt); const shown = h.bone.quaternion.clone();
    guard?.remove();
    return { target, raw, shown };
  };
  try {
    assert.equal(bridge.start(from, [ARM], DURATION[kind]), true);
    step(0);
    while (t < pre - 1e-12) step(Math.min(0.01, pre - t));
    const before = step(0), jumps = guard?.getState().jumps ?? 0;
    const after = step(post - t);
    const row = { rawStep: distance(before.raw, after.raw), shownStep: distance(before.shown, after.shown), targetStep: distance(before.target, after.target),
      newJumps: (guard?.getState().jumps ?? 0) - jumps, durationMs: bridge.getState().durationMs };
    while (t < seconds - 1e-12) step(Math.min(0.01, seconds - t));
    const end = step(0);
    assert.ok(distance(end.raw, end.target) < 1e-5, 'the bridge still ends exactly on the target');
    return row;
  } finally { guard?.remove(); bridge.dispose(); h.close(); }
}

const EPSILONS = [0.1, 0.01, 0.001] as const;
/** Frame interval across the crossing, in ms (the target moves 2e deg at 10 deg/s). */
const intervalMs = (epsilon: number) => f3(200 * epsilon);

for (const kind of ['fixed400', 'handoff', 'switch'] as const) {
  test(`R29e witness (${kind}): a live target crossing the half turn by 0.2/0.02/0.002 deg does not flip the bridge (raw)`, () => {
    const rows = EPSILONS.map(epsilon => ({ epsilon, crossing: bridgeCrossing(kind, epsilon, false), control: bridgeCrossing(kind, epsilon, false, false) }));
    if (REPORT) for (const { epsilon, crossing, control } of rows)
      console.log(`[bridge ${kind}] ${intervalMs(epsilon)} ms: target ${f6(crossing.targetStep)} deg, raw ${f6(crossing.rawStep)} deg (bridge's own progress ${f6(control.rawStep)})`);
    for (const { epsilon, crossing, control } of rows) {
      assert.equal(crossing.durationMs, EXPECTED_MS[kind]);
      // The display may move by the bridge's own progress plus at most the target's own step.
      assert.ok(crossing.rawStep <= control.rawStep + crossing.targetStep + 1e-6,
        `${kind} ${epsilon}: raw ${f6(crossing.rawStep)} > progress ${f6(control.rawStep)} + target ${f6(crossing.targetStep)}`);
    }
  });
}

test('R29e witness (handoff, after the display guard): nothing left for the guard to catch, nothing shown beyond the progress', () => {
  const rows = EPSILONS.map(epsilon => ({ epsilon, crossing: bridgeCrossing('handoff', epsilon, true), control: bridgeCrossing('handoff', epsilon, true, false) }));
  if (REPORT) for (const { epsilon, crossing, control } of rows)
    console.log(`[bridge handoff + guard] ${intervalMs(epsilon)} ms: raw ${f6(crossing.rawStep)}, shown ${f6(crossing.shownStep)} deg (progress shown ${f6(control.shownStep)}), new guard catches ${crossing.newJumps}`);
  for (const { epsilon, crossing, control } of rows) {
    assert.equal(crossing.newJumps, 0, `${epsilon}: the guard had to catch a cut`);
    assert.ok(crossing.shownStep <= control.shownStep + crossing.targetStep + 1e-6,
      `${epsilon}: shown ${f6(crossing.shownStep)} > progress ${f6(control.shownStep)} + target ${f6(crossing.targetStep)}`);
  }
});

/** Codex's chat-gesture witness: a valid synthetic 左腕 track crossing the half turn at 1 s, strength 0.7, no fades, identity base. */
function gestureCrossing(epsilon: number, guarded: boolean) {
  const h = rig(), player = new ChatGesturePlayer(h.mesh), watch = new BaseSourceWatch();
  const half = epsilon / 10, pre = 1 - half, post = 1 + half;
  const clip = crossingClip(2, pre, post, epsilon), sampler = clip.tracks[0].createInterpolant();
  const guard = guarded ? new PoseContinuity(h.mesh, { height: 1 }) : null;
  let t = 0;
  const step = (dt: number) => {
    player.restore(); h.bone.quaternion.identity(); h.mixer.update(dt); t += dt;
    guard?.captureBase(watch.observe(h.mixer as unknown as WatchedMixer, dt));
    player.frame(dt, { blocked: false }); const raw = h.bone.quaternion.clone();
    guard?.apply(dt, dt); const shown = h.bone.quaternion.clone();
    guard?.remove();
    return { raw, shown, target: new Quaternion().fromArray(sampler.evaluate(t) as unknown as number[]) };
  };
  try {
    assert.equal(player.play({ id: `r29e-${epsilon}-${guarded}`, clip, strength: 0.7, fadeInMs: 0, fadeOutMs: 0 }), true);
    step(0); while (t < pre - 1e-12) step(Math.min(0.01, pre - t));
    const before = step(0), jumps = guard?.getState().jumps ?? 0, after = step(post - t);
    assert.equal(player.getState().weight, 0.7);
    return { rawStep: distance(before.raw, after.raw), shownStep: distance(before.shown, after.shown), targetStep: distance(before.target, after.target),
      newJumps: (guard?.getState().jumps ?? 0) - jumps };
  } finally { guard?.remove(); player.dispose(); h.close(); }
}

test('R29e witness (chat gesture, weight 0.7): a sample crossing the half turn moves the overlay by 0.7x its own step, raw and shown', () => {
  const rows = EPSILONS.map(epsilon => ({ epsilon, raw: gestureCrossing(epsilon, false), guarded: gestureCrossing(epsilon, true) }));
  if (REPORT) for (const { epsilon, raw, guarded } of rows)
    console.log(`[chat gesture 0.7] ${intervalMs(epsilon)} ms: target ${f6(raw.targetStep)}, raw ${f6(raw.rawStep)}, shown ${f6(guarded.shownStep)} deg, new guard catches ${guarded.newJumps}`);
  for (const { epsilon, raw, guarded } of rows) {
    assert.ok(raw.rawStep <= 0.7 * raw.targetStep + 1e-6, `${epsilon}: raw ${f6(raw.rawStep)} > 0.7 x target ${f6(raw.targetStep)}`);
    assert.ok(guarded.shownStep <= 0.7 * guarded.targetStep + 1e-6, `${epsilon}: shown ${f6(guarded.shownStep)}`);
    assert.equal(guarded.newJumps, 0);
  }
});

// ------------------------------------------------------------------ 2. live targets, the contract beyond the witness

/**
 * One bridged bone whose live target is from * about(axis(t), angle(t)), turning steadily. With the way round
 * kept, the display is exactly from * about(axis(t), w * angle(t)): the "follow the live target" curve of the
 * original bridge with the relative angle unwrapped (it reaches the target at w = 1 and never flips).
 */
function liveBridge(options: { fps: number; from: Quaternion; axis: (t: number) => Vector3; angle: (t: number) => number; flipSign?: boolean;
  duration?: number | ((angle: number) => number) }) {
  const h = rig(), bridge = new MotionTransition(h.mesh);
  const rows: { t: number; w: number; raw: Quaternion; expected: Quaternion; target: Quaternion }[] = [];
  try {
    h.bone.quaternion.copy(options.from);
    const pose = captureMotionPose(h.mesh);
    const target = (t: number) => options.from.clone().multiply(about(options.axis(t), options.angle(t)));
    let t = 0, frame = 0;
    const evaluate = (dt: number) => {
      bridge.restore();
      const value = target(t);
      // Mixers and normalizers may hand out either sign of the same rotation.
      if (options.flipSign && frame % 2) value.set(-value.x, -value.y, -value.z, -value.w);
      h.bone.quaternion.copy(value); bridge.frame(dt); frame++;
      const w = bridge.getState().active ? bridge.getState().weight : 1;
      rows.push({ t, w, raw: h.bone.quaternion.clone(), target: value.clone(),
        expected: options.from.clone().multiply(about(options.axis(t), w * options.angle(t))) });
    };
    assert.equal(bridge.start(pose, [ARM], options.duration ?? handoffDurationMs), true);
    evaluate(0);
    while (bridge.getState().active) { t += 1 / options.fps; evaluate(1 / options.fps); }
    return rows;
  } finally { bridge.dispose(); h.close(); }
}
const largestStep = (rows: readonly { raw: Quaternion }[]) => Math.max(...rows.slice(1).map((row, i) => distance(row.raw, rows[i].raw)));

for (const fps of [60, 30]) {
  test(`R29e live target (${fps} fps): a target turning slowly or fast through the half turn is followed the way it went`, () => {
    const tilted = (t: number) => new Vector3(Math.sin(t * 0.7), 0.4, Math.cos(t * 0.7));
    const cases = [
      { label: '10 deg/s through 180, z', from: q(0), axis: () => Z, angle: (t: number) => 175 + 10 * t },
      { label: '90 deg/s through 180, z', from: q(0), axis: () => Z, angle: (t: number) => 150 + 90 * t },
      { label: '40 deg/s through 180, wandering 3D axis, tilted start', from: about(new Vector3(1, 2, 0.5), 35), axis: tilted, angle: (t: number) => 168 + 40 * t },
    ];
    const results = cases.map(c => {
      const rows = liveBridge({ fps, ...c });
      return { label: c.label, rows, worst: Math.max(...rows.map(row => distance(row.raw, row.expected))) };
    });
    if (REPORT) for (const { label, rows, worst } of results)
      console.log(`[live ${fps} fps] ${label}: largest step ${f3(largestStep(rows))} deg, off the unwrapped curve by ${f6(worst)} deg`);
    for (const { label, rows, worst } of results) {
      assert.ok(worst < 1e-4, `${label}: the display leaves the target's way round by ${f6(worst)} deg`);
      assert.ok(distance(rows.at(-1)!.raw, rows.at(-1)!.target) < 1e-5, 'ends on the target');
    }
  });
}

test('R29e live target: either sign of the same target rotation gives the same display (hemisphere flips are not crossings)', () => {
  const base = { fps: 60, from: q(10), axis: () => new Vector3(0.2, 0.3, 1), angle: (t: number) => 172 + 25 * t };
  const plain = liveBridge(base), flipped = liveBridge({ ...base, flipSign: true });
  const worst = Math.max(...plain.map((row, i) => gap(row.raw, flipped[i].raw)));
  assert.ok(worst < 1e-12, `sign flips change the display by ${worst}`);
  assert.ok(Math.max(...plain.map(row => distance(row.raw, row.expected))) < 1e-4);
});

test('R29e live target: a target that spins more than a full turn during the bridge stays continuous and lands on it', () => {
  // 400 deg/s for the whole (correction-sized) bridge: about 1.5 turns relative to the start.
  const rows = liveBridge({ fps: 60, from: q(0), axis: () => new Vector3(0.1, 1, 0.05), angle: t => 100 + 400 * t, duration: switchDurationMs });
  const worst = Math.max(...rows.map(row => distance(row.raw, row.expected)));
  if (REPORT) console.log(`[live full turn] relative ${f3(100 + 400 * rows.at(-1)!.t)} deg at the end, largest step ${f3(largestStep(rows))} deg, off the unwrapped curve by ${f6(worst)}`);
  assert.ok(worst < 1e-4, `off the unwrapped curve by ${f6(worst)} deg`);
  assert.ok(100 + 400 * rows.at(-1)!.t > 540, 'the target did turn past a full turn');
});

test('R29e unchanged: static targets and live targets that never reach the half turn give exactly the old shortest slerp', () => {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const randomRotation = () => about(new Vector3(random() - 0.5, random() - 0.5, random() - 0.5), random() * 360 - 180);
  let worst = 0, frames = 0;
  for (let run = 0; run < 40; run++) {
    const from = randomRotation(), target = randomRotation(), axis = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5);
    const still = from.angleTo(target) * DEG;
    // A live target that keeps turning but stays short of the half turn relative to the start (at most 170 deg).
    const rate = Math.max(0, Math.min(20, 170 - still));
    const moving = (t: number) => target.clone().multiply(about(axis, rate * t));
    for (const live of [false, true]) {
      const h = rig(), bridge = new MotionTransition(h.mesh);
      try {
        h.bone.quaternion.copy(from); const pose = captureMotionPose(h.mesh);
        bridge.start(pose, [ARM], 800);
        for (let frame = 0, t = 0; frame <= 50 && (frame === 0 || bridge.getState().active); frame++, t += 1 / 60) {
          bridge.restore();
          const value = live ? moving(t) : target.clone();
          h.bone.quaternion.copy(value); bridge.frame(frame ? 1 / 60 : 0);
          if (!bridge.getState().active) break;
          const old = from.clone().normalize().slerp(value.clone().normalize(), bridge.getState().weight);
          worst = Math.max(worst, gap(h.bone.quaternion, old)); frames++;
        }
      } finally { bridge.dispose(); h.close(); }
    }
  }
  assert.ok(frames > 3000, `${frames} frames compared`);
  assert.ok(worst < 1e-9, `differs from the old slerp by ${worst}`);
});

// ------------------------------------------------------------------ 3. reselect, zero progress, cancel

test('R29e reselect across the half turn: the new bridge starts from what is shown and keeps continuous', () => {
  const h = rig(), bridge = new MotionTransition(h.mesh);
  try {
    const angle = (t: number) => 177 + 10 * t, target = (t: number) => q(angle(t));
    const pose = captureMotionPose(h.mesh);
    bridge.start(pose, [ARM], handoffDurationMs);
    const shown: { raw: Quaternion; target: Quaternion; progress: number }[] = [];
    let t = 0, previousWeight = 0;
    const frame = (dt: number) => {
      bridge.restore(); h.bone.quaternion.copy(target(t)); bridge.frame(dt);
      const w = bridge.getState().active ? bridge.getState().weight : 1;
      shown.push({ raw: h.bone.quaternion.clone(), target: target(t), progress: Math.max(0, w - previousWeight) }); previousWeight = w;
    };
    frame(0);
    while (angle(t) < 181) { t += 1 / 60; frame(1 / 60); } // past the half turn, partway through the bridge
    assert.ok(bridge.getState().active && bridge.getState().weight > 0.1 && bridge.getState().weight < 0.9);
    // Rapid reselect: capture what is shown, restore, start again over the same property toward the same live target.
    const visible = captureMotionPose(h.mesh), before = h.bone.quaternion.clone();
    bridge.restore(); h.bone.quaternion.copy(target(t));
    bridge.start(visible, [ARM], handoffDurationMs); bridge.frame(0);
    assert.ok(distance(h.bone.quaternion, before) < 1e-9, 'the reselect frame shows the same pose');
    previousWeight = 0; shown.push({ raw: h.bone.quaternion.clone(), target: target(t), progress: 0 });
    while (bridge.getState().active) { t += 1 / 60; frame(1 / 60); }
    // Each frame moves by at most the bridge's own progress over the way left to go (a half turn plus how far the
    // target has moved since that bridge started) plus the target's own step.
    let travel = 0;
    for (let i = 1; i < shown.length; i++) {
      if (shown[i].progress === 0 && i > 1 && shown[i].raw.equals(shown[i - 1].raw)) travel = 0; // the reselect frame
      const targetStep = distance(shown[i].target, shown[i - 1].target);
      const step = distance(shown[i].raw, shown[i - 1].raw), allowed = shown[i].progress * (180 + travel) + targetStep + 1e-6;
      travel += targetStep;
      assert.ok(step <= allowed, `frame ${i}: ${f3(step)} > ${f3(allowed)} deg`);
    }
    assert.ok(distance(shown.at(-1)!.raw, shown.at(-1)!.target) < 1e-5, 'ends on the target');
  } finally { bridge.dispose(); h.close(); }
});

test('R29e zero progress: before any progress the start is shown whatever the target does; a zero-delta rebuild mid-bridge does not flip', () => {
  const h = rig(), bridge = new MotionTransition(h.mesh);
  try {
    h.bone.quaternion.copy(q(5)); const pose = captureMotionPose(h.mesh);
    bridge.start(pose, [ARM], 800);
    // No progress yet: the target hops across the half turn and back (and its sign flips); the start stays shown.
    const negated = (value: Quaternion) => value.clone().set(-value.x, -value.y, -value.z, -value.w);
    for (const value of [q(184.9), q(185.1), negated(q(184.9)), negated(q(185.1)), q(185)]) {
      bridge.restore(); h.bone.quaternion.copy(value); bridge.frame(0);
      assert.ok(distance(h.bone.quaternion, q(5)) < 1e-9, 'zero progress shows the start');
    }
    // Progress to the middle with the target just short of the half turn (relative to the start).
    let t = 0;
    while (t < 0.4 - 1e-9) { bridge.restore(); h.bone.quaternion.copy(q(184.9)); bridge.frame(1 / 60); t += 1 / 60; }
    const w = bridge.getState().weight, elapsed = bridge.getState().elapsedMs, before = h.bone.quaternion.clone();
    // An event between ticks rebuilds the target at the same progress (restore -> new target -> frame(0)): it crossed by 0.2 deg.
    bridge.restore(); h.bone.quaternion.copy(q(185.1)); bridge.frame(0);
    const step = distance(before, h.bone.quaternion);
    if (REPORT) console.log(`[zero-delta rebuild] w ${f3(w)}: target crossed by 0.2 deg, display moved ${f6(step)} deg`);
    assert.equal(bridge.getState().elapsedMs, elapsed, 'no progress');
    assert.ok(step <= w * 0.2 + 1e-6, `the rebuild moved the display by ${f6(step)} deg`);
  } finally { bridge.dispose(); h.close(); }
});

/** A gesture with a fixed sample over a live base that turns steadily; the overlay is base * (base^-1 sample)^weight. */
function gestureOverMovingBase(cancelAt: number | null) {
  const h = rig(), player = new ChatGesturePlayer(h.mesh);
  const sample = q(0);
  const clip = new AnimationClip('r29e-still', 3, [new QuaternionKeyframeTrack(ARM, [0, 3], [...sample.toArray(), ...sample.toArray()])]);
  const base = (t: number) => 170 + 20 * t; // the base turns away from the sample and passes a half turn from it at 0.5 s
  const rows: { t: number; raw: Quaternion; expected: Quaternion; weight: number }[] = [];
  try {
    assert.equal(player.play({ id: `r29e-base-${cancelAt}`, clip, strength: 0.7, fadeInMs: 0, fadeOutMs: 0 }), true);
    for (let t = 0, frame = 0; t <= 1.2 + 1e-9; frame++, t = frame / 60) {
      if (cancelAt !== null && Math.abs(t - cancelAt) < 1e-9) player.cancel({ immediate: false });
      player.restore(); h.bone.quaternion.copy(q(base(t)));
      const state = player.frame(frame ? 1 / 60 : 0, { blocked: false });
      // Unwrapped: the overlay turns back from the base by weight x the base's angle from the sample.
      rows.push({ t, raw: h.bone.quaternion.clone(), weight: state.weight, expected: q(base(t) - state.weight * base(t)) });
      if (!state.active) break;
    }
    return rows;
  } finally { player.dispose(); h.close(); }
}

test('R29e chat gesture: a live base that drifts a half turn away from the sample, then a smooth cancel there, stays continuous', () => {
  const results = [null, 0.75].map(cancelAt => {
    const rows = gestureOverMovingBase(cancelAt);
    return { cancelAt, rows, worst: Math.max(...rows.map(row => distance(row.raw, row.expected))) };
  });
  if (REPORT) for (const { cancelAt, rows, worst } of results)
    console.log(`[chat gesture over a moving base${cancelAt === null ? '' : ', smooth cancel at 0.75 s'}] largest step ${f3(largestStep(rows))} deg, off the unwrapped curve by ${f6(worst)}`);
  for (const { cancelAt, rows, worst } of results) {
    assert.ok(worst < 1e-4, `off the unwrapped curve by ${f6(worst)} deg`);
    // Without a cancel the overlay only follows the base (0.3 x 20 deg/s); the cancel's own 0.15 s fade is a fast but continuous curve.
    if (cancelAt === null) assert.ok(largestStep(rows) < 0.2, `largest step ${f3(largestStep(rows))} deg`);
    else assert.equal(rows.at(-1)!.weight, 0, 'the cancel fades out');
  }
});

// ------------------------------------------------------------------ 4. the real Stage loop (bundled Gene, bundled motions)

/**
 * A reachable case with bundled assets only, through the motion library's own channels: Stand as the pose and
 * speaking-gesture-2 as the gesture, then split-dance selected as the pose (gesture cleared) at 5.1 s. The bridged
 * 左手首 starts ~175 deg from the dance's wrist and the dance's own 25.6 deg one-frame step carries it across the half
 * turn at w ~0.93. Every bridged bone may move by at most its target's own step plus the bridge's progress over the
 * way left to go (a half turn plus how far its target has moved since the switch).
 */
test('R29e real loop: switching into split-dance where a bridged wrist crosses the half turn does not add a flip', async () => {
  const fps = 60, h = await geneStage({ fps, layers: { pose: catalogAsset('gene', 'stand'), gesture: catalogAsset('genea-2022-gestures', 'speaking-gesture-2'), expression: null } });
  try {
    h.run(5.1);
    // R29f: the bridge would also coast on the wrist's own speed at the switch (motion-transition.ts DRIFT); this bound is
    // about the way round from a fixed start, so the start is held still here (the coast is measured in r29f-smoothness).
    h.stage.poseRates = () => () => null;
    await h.stage.loadMotions({ pose: catalogAsset('fnoji-dances', 'split-dance'), gesture: null, expression: null }, false);
    const bridge = h.stage.motionTransition as MotionTransition, bones = h.mesh.skeleton.bones as Bone[], wrist = bones.findIndex(bone => bone.name === '左手首');
    const real = bridge.frame.bind(bridge);
    let last: { raw: Quaternion[]; target: Quaternion[]; weight: number } | null = null;
    const over: string[] = [], travel = bones.map(() => 0);
    // The wrist per rendered frame of the bridge: raw / target steps, and the shown (after the guard) step.
    const wristFrames: { rawStep: number; targetStep: number; weight: number; shown: Quaternion | null }[] = [];
    bridge.frame = (delta: number) => {
      const target = bones.map(bone => bone.quaternion.clone());
      real(delta);
      if (!(delta > 0)) return;
      const raw = bones.map(bone => bone.quaternion.clone()), weight = bridge.getState().active ? bridge.getState().weight : 1;
      if (last) for (let i = 0; i < bones.length; i++) {
        const rawStep = distance(raw[i], last.raw[i]), targetStep = distance(target[i], last.target[i]);
        // The way round left to go is at most a half turn plus how far the target has moved since the switch.
        const allowed = targetStep + (weight - last.weight) * (180 + travel[i]) + 0.01;
        travel[i] += targetStep;
        if (rawStep > allowed) over.push(`${bones[i].name} w ${f3(weight)}: raw ${f3(rawStep)} > target ${f3(targetStep)} + progress = ${f3(allowed)}`);
        if (i === wrist) wristFrames.push({ rawStep, targetStep, weight, shown: null });
      }
      last = { raw, target, weight };
    };
    const render = h.stage.renderer.render.bind(h.stage.renderer);
    const shownWrist: Quaternion[] = [];
    h.stage.renderer.render = () => {
      const shown = bones[wrist].quaternion.clone(), frame = wristFrames.at(-1);
      if (frame && !frame.shown) frame.shown = shown;
      shownWrist.push(shown); render();
    };
    const caught = h.stage.continuity.getState().jumps as number;
    h.run(1.6);
    // The dance's own one-frame wrist steps (~25.6 deg) while the bridge runs; the first carries the bridged target across the half turn.
    const big = wristFrames.map((frame, i) => ({ ...frame, shownStep: frame.shown && wristFrames[i - 1]?.shown ? distance(frame.shown, wristFrames[i - 1].shown!) : NaN }))
      // R29f: keyframe interpolation spreads the dance's 25.6° key-to-key step over the 60 fps frames in between (~11–14° each).
      .filter(frame => frame.weight < 1 && frame.targetStep > 10);
    if (REPORT) console.log(`[real loop stand + speaking-gesture-2 -> split-dance @5.1 s, ${fps} fps] 左手首 on the dance's own big steps: ${big.map(frame =>
      `w ${f3(frame.weight)} target ${f3(frame.targetStep)} raw ${f3(frame.rawStep)} shown ${f3(frame.shownStep)}`).join(' | ')} | frames over the bound: ${over.length} | guard catches ${h.stage.continuity.getState().jumps - caught}`);
    assert.ok(last, 'the bridge ran');
    assert.ok(big.length && big[0].weight > 0.9, 'the case still reaches the crossing');
    assert.deepEqual(over, [], 'a bridged bone moved more than its target plus the progress');
  } finally { h.close(); }
});
