/**
 * Hand-back with the motion's speed (docs/claude/2026-11-21-motion-handback-velocity.md; R29, "绝不瞬移"): a chat gesture or an automatic
 * body motion that gives way while it is moving fast must not stop dead. Found by full-screen Unbound batch C: the window / full-screen
 * hand-back (window-clips.ts, shared by both) started its bridge from rest, so at a moment the wrist turned 2–3° a frame the right elbow's
 * unexpected step (R29c) was 1.217° at 60 fps against 0.31–0.46° at an ordinary moment.
 *
 * Measured on the real frame loops at 60 and 30 fps, handing the chat gesture back at its fastest moment and at an ordinary one:
 *  - the window engine on the bundled public Gene (WindowMotions → WindowClips, the code the window and full-screen run);
 *  - the same engine on the synthetic VRM through the standard body;
 *  - the old stage on Gene (tests/helpers/gene-stage-harness.ts; its hand-back already passed the display guard's rates, R29f).
 * Per run: the largest unexpected step and its bone, the largest step, the overshoot (how much further from the run without the
 * gesture the arm gets than it was at the hand-over) and how long the bridge runs. HANDBACK_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import catalog from '../shared/actions/motion-catalog.json';
import type { BodyMotionPlan } from '../shared/actions';
import { WindowMotions, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import { WindowClips } from '../src/unbound/window-mode/window-clips';
import type { WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { NO_MOTION_BLOCKS } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { MAX_FAST_DRIFT_DEG } from '../src/stage/motion-transition';
import { ShownRates, rateOf } from '../src/stage/shown-rates';
import { faceView } from './helpers/window-face-fixture';
import { windowGene } from './helpers/unbound-window';
import { standClip } from './helpers/unbound-gene';
import { catalogMotionFile, TRACKED_BONES } from './helpers/frame-stats';
import { settledVmdBytes } from './helpers/settled-vmd';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { windowVrm } from './helpers/unbound-vrm';

const REPORT = process.env.HANDBACK_REPORT === '1';
const DEG = 180 / Math.PI;
const say = (line: string) => { if (REPORT) console.log(line); };

// ---- the hand-back itself, one bone (no model): what the bridge starts from ------------------------------------------------------

function oneBoneClips() {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material), bone = new Bone();
  bone.name = '右ひじ'; mesh.add(bone); mesh.bind(new Skeleton([bone]));
  const clips = new WindowClips(mesh, () => 0);
  return { mesh, bone, clips, dispose() { clips.dispose(); geometry.dispose(); material.dispose(); } };
}

/**
 * An automatic body motion turns the elbow at `speed` °/s; at `handAt` s it gives way (between frames, as the body motion's controller
 * does) to a base at rest. Returns the elbow's angle per frame (°).
 */
function handBackOneBone(fps: number, speed: number, handAt = 0.5, seconds = 1.8): number[] {
  const f = oneBoneClips(), axis = new Vector3(0, 0, 1), TRACK = '.bones[右ひじ].quaternion';
  let playing = true;
  f.clips.bodyTracks = () => playing ? [TRACK] : [];
  const angles: number[] = [];
  try {
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      if (playing && t >= handAt) f.clips.handOff([TRACK], () => { playing = false; });
      f.clips.restore();
      f.bone.quaternion.identity(); // the base under it: still
      if (playing) f.bone.quaternion.setFromAxisAngle(axis, speed / DEG * t); // the body motion's write over the base
      f.clips.frame(dt);
      angles.push(2 * Math.atan2(f.bone.quaternion.z, f.bone.quaternion.w) * DEG);
    }
  } finally { f.dispose(); }
  return angles;
}
const stepsOf = (angles: readonly number[]) => angles.slice(1).map((a, i) => a - angles[i]);
const surpriseOf = (angles: readonly number[]) => { const s = stepsOf(angles); return Math.max(0, ...s.slice(1).map((v, i) => Math.abs(v - s[i]))); };

for (const fps of [60, 30]) {
  test(`hand-back, one bone, ${fps} fps: the bridge leaves at the speed the motion had (not from rest), slows within a bounded way and lands on the base`, () => {
    const speed = 150; // °/s: a wrist turning 2.5° a frame at 60 fps
    const angles = handBackOneBone(fps, speed), steps = stepsOf(angles), at = Math.round(0.5 * fps);
    const surprise = surpriseOf(angles), before = speed / fps, shownAt = angles[at - 1];
    const peak = Math.max(...angles);
    say(`  one bone ${fps} fps: step before ${before.toFixed(3)}°, first bridged step ${steps[at - 1].toFixed(3)}°, unexpected step ${surprise.toFixed(3)}°, coasted ${(peak - shownAt).toFixed(2)}° on, end ${angles.at(-1)!.toFixed(4)}°`);
    // From rest the first bridged step was ~0 (the whole step lost in one frame): unexpected step = speed / fps.
    assert.ok(steps[at - 1] > before * 0.6, `the first bridged step keeps most of the speed (${steps[at - 1].toFixed(3)}° vs ${before.toFixed(3)}°)`);
    assert.ok(surprise < before * (fps === 60 ? 0.3 : 0.5), `no stop dead: unexpected step ${surprise.toFixed(3)}° (a stop is ${before.toFixed(3)}°)`);
    assert.ok(peak - shownAt <= MAX_FAST_DRIFT_DEG + 1e-6, `coasts a bounded way (${(peak - shownAt).toFixed(2)}°)`);
    assert.ok(Math.abs(angles.at(-1)!) < 1e-6, 'lands on the base');
  });
}

test('hand-back, one bone: a motion that was not moving still starts from rest (nothing invented); a model that came back starts with no old speed', () => {
  const still = handBackOneBone(60, 0);
  assert.ok(Math.max(...still.map(Math.abs)) < 1e-9, 'still: nothing moves');
  const f = oneBoneClips(), TRACK = '.bones[右ひじ].quaternion', axis = new Vector3(0, 0, 1);
  let playing = true;
  f.clips.bodyTracks = () => playing ? [TRACK] : [];
  try {
    for (let i = 0; i < 20; i++) { f.clips.restore(); f.bone.quaternion.setFromAxisAngle(axis, i * 0.05); f.clips.frame(1 / 60); }
    f.clips.stopAll(); // hidden: everything stops, the speed it had is forgotten
    f.clips.restore(); f.bone.quaternion.setFromAxisAngle(axis, 0.3); f.clips.frame(1 / 60); // shown again for one frame: no speed known yet
    f.clips.handOff([TRACK], () => { playing = false; });
    f.clips.restore(); f.bone.quaternion.identity(); f.clips.frame(1 / 60);
    const first = 2 * Math.atan2(f.bone.quaternion.z, f.bone.quaternion.w) * DEG;
    assert.ok(Math.abs(first - 0.3 * DEG) < 0.05, `held where it was shown, no speed from before it was hidden (${first.toFixed(3)}°)`);
  } finally { f.dispose(); }
});

test('shown rates: a bone-local angular velocity (the bridge\'s from · exp(rate · t)), per-axis position speed; a zero-delta frame keeps the speed; a new track has none', () => {
  const a = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7), local = new Vector3(1, 0, 0);
  const b = a.clone().multiply(new Quaternion().setFromAxisAngle(local, 0.02));
  const rate = rateOf('.bones[腕].quaternion', a.toArray(), b.toArray(), 0.01)!;
  assert.ok(Math.abs(rate[0] - 2) < 1e-9 && Math.abs(rate[1]) < 1e-9 && Math.abs(rate[2]) < 1e-9, `body-frame rate ${rate}`);
  const negated = rateOf('.bones[腕].quaternion', a.toArray(), b.toArray().map(v => -v), 0.01)!;
  assert.ok(Math.abs(negated[0] - 2) < 1e-9, 'the shorter way round (q and −q are one rotation)');
  assert.deepEqual(rateOf('.bones[センター].position', [0, 1, 2], [0.1, 1, 1.9], 0.1)!.map(v => +v.toFixed(9)), [1, 0, -1]);
  assert.equal(rateOf('.morphTargetInfluences[0]', [0], [1], 0.1), null, 'not a bone rotation or position');
  const rates = new ShownRates(), name = '.bones[腕].quaternion';
  rates.record(new Map([[name, a.toArray()]]), 1 / 60);
  assert.equal(rates.lookup([name])(name), null, 'first frame shown: no speed yet');
  rates.record(new Map([[name, b.toArray()]]), 0.01);
  const held = rates.lookup([name]);
  rates.record(new Map([[name, b.toArray()]]), 0);
  assert.ok(Math.abs(rates.lookup([name])(name)![0] - 2) < 1e-9, 'a zero-delta frame keeps the speed it had');
  rates.record(new Map([[name, b.toArray()]]), 0.01);
  assert.ok(Math.abs(held(name)![0] - 2) < 1e-9 && rates.lookup([name])(name)![0] === 0, 'a lookup is a copy; standing still: zero');
  rates.record(new Map(), 0.01);
  rates.record(new Map([[name, a.toArray()]]), 0.01);
  assert.equal(rates.lookup([name])(name), null, 'not shown on the frame before: no speed');
});

// ---- the real frame loops: the chat gesture handed back at its fastest moment and at an ordinary one -------------------------------

const ARM_GENE = [...TRACKED_BONES, '左手首', '右手首'];
/** 右腕, 右ひじ, 右手首 in ARM_GENE (rightUpperArm, rightLowerArm, rightHand in the VRM's list). */
const RIGHT_ARM = [8, 10, 12];
const GESTURE_AT = 0.5;
interface Run { frames: Quaternion[][]; bridging: boolean[]; names: readonly string[]; fps: number }

const env = (view = faceView()): WindowMotionEnv => ({ shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false,
  feeding: false, hover: false, pinch: false, pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false,
  thinking: false, view, blocks: NO_MOTION_BLOCKS, showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false });
const hostWithGesture = (): WindowStageHost => ({ isBehaviorModelSupported: async () => true,
  resolveChatGesture: async cueId => {
    const entry = catalog.packs.find(p => p.id === 'genea-2022-gestures')!.motions.find(m => m.id === 'speaking-gesture-2')!;
    return { cueId, intent: 'explain', packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', sha256: entry.sha256, durationMs: entry.durationFrames / 30 * 1000,
      url: `mmd-asset://${'b'.repeat(32)}/speaking-gesture-2.vmd` };
  },
  resolveHerAction: async () => { throw Error('none'); }, reportHerAction: async () => {},
  getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }) as BodyMotionPlan,
  resolveBehaviorBody: async () => { throw Error('none'); }, resolveBehaviorMotion: async () => { throw Error('none'); },
  resolveHerLifeMotion: async () => { throw Error('none'); } });

/**
 * The window engine's frame loop on `model` ('gene' or the synthetic VRM): a chat gesture from GESTURE_AT; at frame `yieldFrame` typing
 * starts (the gesture gives way on that frame); `gesture: false` runs the same frames without it (the base the bridge goes back to).
 */
async function windowRun(model: 'gene' | 'vrm', fps: number, seconds: number, yieldFrame: number | null, gesture = true): Promise<Run> {
  const bytes = settledVmdBytes(url => /^mmd-asset:\/\/b{32}\/(.+)\.vmd$/.test(url) ? catalogMotionFile('genea-2022-gestures', /\/([^/]+)\.vmd$/.exec(url)![1]) : new URL(url), { delayMs: 2 });
  const view0 = faceView({ primary: 'calm', companion: null });
  const state = { env: env(view0), view: view0 };
  const motions = new WindowMotions(hostWithGesture(), () => state.env, () => 1_000_000 + clock);
  let clock = 0;
  const gene = model === 'gene' ? await windowGene() : null, vrm = model === 'vrm' ? await windowVrm(syntheticVrm({ face: 'full' })) : null;
  const frames: Quaternion[][] = [], bridging: boolean[] = [];
  let names: readonly string[] = [];
  try {
    let bones: Bone[], frame: (dt: number) => void;
    if (gene) {
      const mesh = gene.fixture.mesh;
      gene.figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false);
      motions.attach({ figure: gene.figure, mesh, reviewed: true, retarget: null, transform: undefined, profile: new StageModelProfile(mesh, { reviewed: true }), standard: false });
      bones = ARM_GENE.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
      names = ARM_GENE;
      frame = dt => gene.frame(dt);
    } else {
      const w = vrm!;
      motions.attach({ figure: w.figure, mesh: w.standard.mesh, reviewed: false, retarget: null, transform: w.standard.transform, profile: null, standard: true });
      const own = ['hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'];
      const slot = { hips: 'lowerBody', spine: 'upperBody', chest: 'upperBody2', neck: 'neck', head: 'head', leftShoulder: 'shoulderLeft', rightShoulder: 'shoulderRight',
        leftUpperArm: 'armLeft', rightUpperArm: 'armRight', leftLowerArm: 'elbowLeft', rightLowerArm: 'elbowRight', leftHand: 'wristLeft', rightHand: 'wristRight' } as const;
      bones = own.map(name => w.standard.model.bone(slot[name as keyof typeof slot] as never)).filter((b): b is Bone => !!b);
      names = own.slice(0, bones.length);
      frame = dt => w.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false });
    }
    motions.setMood(state.view);
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clock += dt * 1000;
      if (gesture && i === Math.round(GESTURE_AT * fps)) {
        state.view = { ...state.view, gesture: { id: `hb-${model}-${fps}`, at: 1_000_000 + clock, expiresAt: 1_000_000 + clock + 60_000, intent: 'explain', strength: 0.55, reason: 'test' } };
        state.env.view = state.view; motions.setMood(state.view);
      }
      if (i === yieldFrame) { state.env.typing = true; motions.gatesChanged(true, true); }
      motions.frame();
      frame(dt);
      motions.afterBody(dt);
      (gene?.fixture.mesh ?? vrm!.standard.mesh).updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      bridging.push(motions.clips?.bridging === true);
      void t;
      await bytes.settle();
    }
  } finally { bytes.restore(); motions.dispose(); gene?.close(); vrm?.close(); }
  return { frames, bridging, names, fps };
}

/** Per frame, the largest world step of `bones` (indices into the run's names) from the frame before (°). */
const stepAt = (run: Run, i: number, bones: readonly number[]) => Math.max(...bones.map(b => run.frames[i][b].angleTo(run.frames[i - 1][b]) * DEG));

/** The fastest frame of the right arm while the gesture is fully in (from GESTURE_AT + 1 s to `until`), and an ordinary one (the median speed). */
function moments(run: Run, until: number): { fast: number; ordinary: number; fastStep: number; ordinaryStep: number } {
  const right = RIGHT_ARM; // the right upper arm, elbow and wrist: the same places in Gene's and the VRM's lists
  const from = Math.round((GESTURE_AT + 1) * run.fps), to = Math.round(until * run.fps);
  const speeds: { i: number; v: number }[] = [];
  for (let i = from; i <= to; i++) speeds.push({ i, v: stepAt(run, i, right) });
  const fast = speeds.reduce((a, b) => b.v > a.v ? b : a);
  const sorted = [...speeds].sort((a, b) => a.v - b.v), median = sorted[Math.floor(sorted.length / 2)];
  // Hand back on the frame after the shown speed (the bridge starts from the pose of the frame before).
  return { fast: fast.i + 1, ordinary: median.i + 1, fastStep: fast.v, ordinaryStep: median.v };
}

/** Around a hand-back on `at`: the largest unexpected step (R29c) and its bone, the largest step, the overshoot against `base`, the bridge's time. */
function measure(run: Run, at: number, base: Run, seconds = 1.2) {
  const end = Math.min(run.frames.length - 1, at + Math.round(seconds * run.fps));
  let worst = { angle: 0, bone: '', frame: 0 }, peak = 0;
  const a = new Quaternion(), b = new Quaternion(), inv = new Quaternion();
  for (let i = Math.max(2, at); i <= end; i++) { // from the first bridged frame (its step against the last shown one)
    peak = Math.max(peak, stepAt(run, i, run.names.map((_, k) => k)));
    for (let k = 0; k < run.names.length; k++) {
      a.copy(run.frames[i][k]).multiply(inv.copy(run.frames[i - 1][k]).invert());
      b.copy(run.frames[i - 1][k]).multiply(inv.copy(run.frames[i - 2][k]).invert());
      const angle = a.angleTo(b) * DEG;
      if (angle > worst.angle) worst = { angle, bone: run.names[k], frame: i };
    }
  }
  let overshoot = 0;
  for (let k = 0; k < run.names.length; k++) {
    const start = run.frames[at - 1][k].angleTo(base.frames[at - 1][k]) * DEG;
    for (let i = at; i <= end; i++) overshoot = Math.max(overshoot, run.frames[i][k].angleTo(base.frames[i][k]) * DEG - start);
  }
  let bridgeEnd = at;
  while (bridgeEnd < run.bridging.length && run.bridging[bridgeEnd]) bridgeEnd++;
  const wrist = [];
  for (let i = Math.max(1, at - 3); i <= Math.min(end, at + 8); i++) wrist.push(stepAt(run, i, [worst.bone ? run.names.indexOf(worst.bone) : 12]).toFixed(2));
  return { surprise: worst.angle, bone: worst.bone, after: worst.frame - at, peak, overshoot, bridgeMs: (bridgeEnd - at) / run.fps * 1000, wrist };
}
const fmt = (m: ReturnType<typeof measure>) => `unexpected ${m.surprise.toFixed(3)}° (${m.bone}, frame ${m.after >= 0 ? '+' : ''}${m.after}) · step ${m.peak.toFixed(3)}° · overshoot ${m.overshoot.toFixed(2)}° · bridge ${m.bridgeMs.toFixed(0)} ms`
  + (REPORT ? ` · its steps from 3 frames before: ${m.wrist.join(' ')}` : '');

const SECONDS = 5;
/** The gesture is fully in from GESTURE_AT + 1 s; the hand-back happens before 3.6 s so its bridge is inside the run. */
const UNTIL = 3.6;

/** The largest unexpected step of the gesture itself in the second before frame `at` (what the hand-back is compared with). */
function ownSurprise(run: Run, at: number): number {
  let out = 0; const a = new Quaternion(), b = new Quaternion(), inv = new Quaternion();
  for (let i = Math.max(2, at - run.fps); i < at; i++) for (let k = 0; k < run.names.length; k++) {
    a.copy(run.frames[i][k]).multiply(inv.copy(run.frames[i - 1][k]).invert());
    b.copy(run.frames[i - 1][k]).multiply(inv.copy(run.frames[i - 2][k]).invert());
    out = Math.max(out, a.angleTo(b) * DEG);
  }
  return out;
}

const ENGINES = {
  'window engine, Gene': (fps: number, yieldFrame: number | null, gesture?: boolean) => windowRun('gene', fps, SECONDS, yieldFrame, gesture),
  'window engine, synthetic VRM (standard body)': (fps: number, yieldFrame: number | null, gesture?: boolean) => windowRun('vrm', fps, SECONDS, yieldFrame, gesture),
} as const;

for (const [engine, runOf] of Object.entries(ENGINES)) for (const fps of [60, 30]) {
  test(`${engine}, ${fps} fps: a chat gesture handed back at its fastest moment leaves at its speed (no stop dead), slows within a bounded way; an ordinary moment as smooth`, async () => {
    const free = await runOf(fps, null), base = await runOf(fps, null, false);
    const m = moments(free, UNTIL);
    assert.ok(m.fastStep > 0.5, `the gesture plays (right arm ${m.fastStep.toFixed(3)}°/frame at its fastest)`);
    const fast = await runOf(fps, m.fast), ordinary = await runOf(fps, m.ordinary);
    // Up to the hand-back the runs show the same frames (the measure compares like with like).
    let gap = 0; for (let i = 0; i < m.fast; i++) for (let k = 0; k < free.names.length; k++) gap = Math.max(gap, fast.frames[i][k].angleTo(free.frames[i][k]) * DEG);
    assert.ok(gap < 0.01, `the same frames before the hand-back (${gap.toFixed(4)}°: float noise)`);
    const f = measure(fast, m.fast, base), o = measure(ordinary, m.ordinary, base);
    const ownFast = ownSurprise(free, m.fast), ownOrdinary = ownSurprise(free, m.ordinary);
    say(`  ${engine} ${fps} fps · fastest (right arm ${m.fastStep.toFixed(2)}°/frame at ${(m.fast / fps).toFixed(2)} s; the gesture's own unexpected step ${ownFast.toFixed(3)}°): ${fmt(f)}`
      + ` · ordinary (${m.ordinaryStep.toFixed(2)}°/frame at ${(m.ordinary / fps).toFixed(2)} s; own ${ownOrdinary.toFixed(3)}°): ${fmt(o)}`);
    // The window batch 5 bound for her clips, or the gesture's own unexpected step in the second before (its own turns), whichever is larger.
    const limit = fps === 60 ? 0.6 : 1.4;
    // From rest the first bridged step lost the whole step at once (unexpected step = the step): it must stay well under that.
    assert.ok(f.surprise < 0.35 * m.fastStep, `fastest moment: unexpected step ${f.surprise.toFixed(3)}° (${f.bone}) vs a stop dead ${m.fastStep.toFixed(3)}°`);
    assert.ok(f.surprise < Math.max(limit, ownFast), `fastest moment: unexpected step ${f.surprise.toFixed(3)}° (${f.bone}), bound ${Math.max(limit, ownFast).toFixed(3)}°`);
    assert.ok(o.surprise < Math.max(limit, ownOrdinary), `ordinary moment: unexpected step ${o.surprise.toFixed(3)}° (${o.bone}), bound ${Math.max(limit, ownOrdinary).toFixed(3)}°`);
    assert.ok(f.overshoot < MAX_FAST_DRIFT_DEG && o.overshoot < MAX_FAST_DRIFT_DEG, `bounded overshoot (${f.overshoot.toFixed(2)}°, ${o.overshoot.toFixed(2)}°)`);
    assert.ok(f.bridgeMs > 0 && f.bridgeMs <= 1000 && o.bridgeMs > 0 && o.bridgeMs <= 1000, `it lands (${f.bridgeMs.toFixed(0)} / ${o.bridgeMs.toFixed(0)} ms)`);
  });
}
