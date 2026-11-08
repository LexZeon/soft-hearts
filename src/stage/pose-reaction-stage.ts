/**
 * P1 第二阶段, stage side (docs/claude/2026-11-03-pose-sensing-stage2.md): the host's MoodView.pose
 * (electron/pose-reactions/host.ts) becomes
 *  - attention: while the user is here and faces the screen, her R18 "look at you" moments come more often (procedural-life.ts's
 *    own path, through LifeActivity.lookAtUser), easing in slowly and out a little faster when the user turns away or leaves;
 *  - one reaction at a time, on its own clock from the host's start time (her delay included):
 *      glance  — the user arrived: eyes to the user, chin up a little (LifeActivity.lookUp, the "抬起头" path);
 *      yawn    — caught from the user: mouth opens on the small-"o" slot, eyes narrow, chin up, then a little down. The model's
 *                own yawn expression and a hand over the mouth are not there (no such morph or clip; no arm IK yet);
 *      stretch — caught from the user, or her own after the user sat long: the small stretch of the 2026-11-03 decision (第 6 题):
 *                chest out, shoulders up and down, head tilted, a deep breath, eyes narrowed; hands stay down;
 *      wave    — the user waved at her: the G1 raised arm (rps-performance.ts buildRpsRig, its body clearance), an open hand, three
 *                swings of the forearm about the palm's normal, outward only (never toward her head), then the arm down.
 *  I-006 第 2 步: a breather's reaction (source 'pause') is the same small stretch; a breather's yawn is 哈欠捂嘴 (her-action.ts, the
 *  host's live cue riding on this one) and only in a whole-body framing: in a half-body one the hand covers her nose and right eye
 *  (Codex's record), so there she stretches instead. Either way it starts only when her body is free.
 *
 * Motion rules (R29, how-we-work 「做事方式」 2): keyframe curves with continuous speed (monotone cubic Hermite, zero speed at both
 * ends), the arm by minimum-jerk segments from the current state; anything higher (chat, a touch, feeding, music, a picked motion,
 * a chat gesture, the game, sleep — the same owners 她自己的生活 gives way to) makes the reaction give way smoothly and end; a
 * reaction that cannot start (she is busy) is simply skipped. Body writes go through the stage's program layer (remembered and
 * restored every frame). With no view and nothing playing, `frame` returns its input unchanged and writes nothing.
 */
import { MathUtils, Matrix4, Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import type { CollisionProxy } from '../../shared/collision-proxy';
import type { CameraConfig } from '../../shared/contracts';
import { POSE_CUE_FRESH_MS, readPoseReactionView, type PoseCoverCue, type PoseReactionKind, type PoseReactionSource } from '../../shared/pose-reactions';
import type { HerLifeStageGates } from './her-life-stage';
import type { LifeActivity } from './procedural-life';
import { MinJerk, alignTwo, buildRpsRig, type RpsRig } from './rps-performance';

// ---------------------------------------------------------------- keyframe curves

/** [seconds, value] keys; the first and last values are rest (0) and every curve starts and ends at zero speed. */
type Keys = readonly (readonly [number, number])[];

/** Monotone cubic Hermite (Fritsch–Carlson): continuous speed, no overshoot past a key, zero slope at the ends and at extremes. */
export function sampleKeys(keys: Keys, t: number): number {
  const n = keys.length;
  if (!n) return 0;
  if (!(t > keys[0][0])) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0;
  while (i < n - 2 && t >= keys[i + 1][0]) i++;
  const [t0, v0] = keys[i], [t1, v1] = keys[i + 1], h = t1 - t0;
  const slope = (j: number): number => {
    if (j <= 0 || j >= n - 1) return 0;
    const a = (keys[j][1] - keys[j - 1][1]) / (keys[j][0] - keys[j - 1][0]), b = (keys[j + 1][1] - keys[j][1]) / (keys[j + 1][0] - keys[j][0]);
    if (a * b <= 0) return 0;
    // Weighted harmonic mean (Fritsch–Butland): stays within the monotone region.
    const h0 = keys[j][0] - keys[j - 1][0], h1 = keys[j + 1][0] - keys[j][0], w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const m0 = slope(i), m1 = slope(i + 1), s = (t - t0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * m1;
}

interface Timeline {
  /** Seconds the whole reaction lasts (all channels back at rest). */
  duration: number;
  /** Upper-body pitch (rad; negative arches the chest back), shoulder rise (rad), head pitch / roll (rad, x < 0 lifts the chin). */
  chest?: Keys; shoulders?: Keys; headX?: Keys; headZ?: Keys;
  /** Face 0..1: narrowed lids, smiling eyes, a closed smile, an open mouth (small "o"), eyes to the user. */
  lidSoft?: Keys; smileEyes?: Keys; mouthSmile?: Keys; mouthOpen?: Keys; lookUp?: Keys;
  /** Raise the arm and wave. */
  wave?: boolean;
}

/**
 * The first version's shapes (trial values). Amounts are at strength 1 (card posture 50); the face channels are scaled again by the
 * card's expression intensity inside procedural life. Mirrored head roll follows her seeded side there.
 */
export const POSE_REACTION_TIMELINES: Readonly<Record<PoseReactionKind, Timeline>> = Object.freeze({
  glance: { duration: 2.4, lookUp: [[0, 0], [0.4, 0.9], [1.5, 0.9], [2.4, 0]], smileEyes: [[0, 0], [0.5, 0.08], [1.4, 0.08], [2.4, 0]] },
  yawn: {
    duration: 4.6,
    mouthOpen: [[0, 0], [0.5, 0.1], [1.3, 0.9], [2.3, 0.95], [3.0, 0.25], [3.5, 0], [4.6, 0]],
    lidSoft: [[0, 0], [0.6, 0.15], [1.3, 0.7], [2.3, 0.7], [3.2, 0.3], [4.6, 0]],
    headX: [[0, 0], [0.7, -0.01], [1.5, -0.04], [2.3, -0.042], [3.2, 0.01], [3.9, 0.025], [4.6, 0]],
    headZ: [[0, 0], [1.5, 0.015], [3.0, 0.02], [4.6, 0]],
    shoulders: [[0, 0], [1.3, 0.05], [2.3, 0.055], [3.2, 0], [4.6, 0]],
    chest: [[0, 0], [1.3, -0.03], [2.3, -0.03], [3.2, 0.005], [4.6, 0]],
  },
  stretch: {
    duration: 5.2,
    chest: [[0, 0], [0.5, -0.02], [1.5, -0.085], [2.5, -0.09], [3.3, -0.02], [4.2, 0.008], [5.2, 0]],
    shoulders: [[0, 0], [0.4, 0.02], [1.4, 0.13], [2.4, 0.14], [3.0, 0.03], [3.5, -0.015], [4.4, 0], [5.2, 0]],
    headZ: [[0, 0], [0.8, 0.01], [1.8, 0.05], [2.8, 0.05], [4.0, 0.01], [5.2, 0]],
    headX: [[0, 0], [1.2, -0.02], [2.6, -0.025], [3.6, 0.005], [5.2, 0]],
    smileEyes: [[0, 0], [0.9, 0.1], [1.6, 0.55], [2.8, 0.55], [3.8, 0.1], [5.2, 0]],
    lidSoft: [[0, 0], [1.4, 0.25], [2.8, 0.25], [3.8, 0.05], [5.2, 0]],
  },
  wave: {
    duration: 0, // the arm decides (raise, three swings, lower)
    wave: true,
    lookUp: [[0, 0], [0.5, 0.7], [3.0, 0.7], [3.8, 0]],
    smileEyes: [[0, 0], [0.6, 0.3], [3.0, 0.3], [3.8, 0]],
    mouthSmile: [[0, 0], [0.6, 0.3], [3.0, 0.3], [3.8, 0]],
  },
});

export interface PoseReactionTiming {
  /** Attention easing (s): toward the user, and away. */
  attentionIn: number;
  attentionOut: number;
  /** Seconds a face-and-head reaction takes to give way. */
  yieldS: number;
  /** Arm: peak angular acceleration (°/s²) of raising / lowering, duration bounds (s). */
  armAccel: number; armMin: number; armMax: number;
  /** Wave: swings, frequency (Hz), amplitude (rad, outward only), the window's ramp (s). */
  swings: number; swingHz: number; swingAmp: number; swingRamp: number;
  /** Peak angular acceleration (°/s²) of the stretch giving way (chest and shoulders). */
  bodyAccel: number;
}
export const POSE_REACTION_TIMING: Readonly<PoseReactionTiming> = Object.freeze({ attentionIn: 6, attentionOut: 3, yieldS: 0.3,
  armAccel: 300, armMin: 0.5, armMax: 1.4, swings: 3, swingHz: 1.3, swingAmp: 0.36, swingRamp: 0.3, bodyAccel: 400 });

// ---------------------------------------------------------------- the layer

export interface PoseReactionStageInput {
  /** The mesh: a new owner drops what is playing. */
  owner: object | null;
  /** MoodView.pose (read again with readPoseReactionView). */
  view: unknown;
  /** Wall clock (ms): cue start times are wall times. */
  nowMs: number;
  /** The same owners 她自己的生活 gives way to (HerLifeStage.gates); null: not free. */
  gates: Readonly<HerLifeStageGates> | null;
  /** G1: the game holds her arm and face. */
  game: boolean;
  proxy?: CollisionProxy | null;
  /** I-006: the camera shows her whole body (framesWholeBody); absent or false: a breather's yawn becomes a stretch. */
  fullBody?: boolean;
  /** I-006: play 哈欠捂嘴 for this live host cue (MmdStage.playHerAction; it brings the P1 yawn face on the same clock). */
  cover?: (cue: PoseCoverCue) => void;
}

/**
 * I-006: whether this camera shows her whole body: the visible band at the model (target height ± distance × the vertical field of
 * view) reaches from near her feet (lowest 15 % of her height) to near the top of her head (top 15 %). The full preset does in every
 * window shape; the half-body one never reaches her feet (in a narrow window it shows more of her, still not the feet). No camera
 * or no model: false (the hand is not risked).
 */
export function framesWholeBody(camera: Pick<CameraConfig, 'distance' | 'fov' | 'targetY'> | null | undefined, model: { height: number; baseY?: number }): boolean {
  const height = model?.height, base = Number.isFinite(model?.baseY) ? model.baseY! : 0;
  if (!camera || !(height! > 0) || !(camera.distance > 0) || !(camera.fov > 0 && camera.fov < 180) || !Number.isFinite(camera.targetY)) return false;
  const half = camera.distance * Math.tan(MathUtils.degToRad(camera.fov / 2));
  return camera.targetY - half <= base + 0.15 * height && camera.targetY + half >= base + 0.85 * height;
}
/** The stage's program-layer writers: remember a bone (restored next frame), and an additive local rotation. */
export interface PoseReactionPort {
  remember(bone: Bone): void;
  rotate(bone: Bone, x: number, y: number, z: number): void;
}

interface Playing {
  id: string;
  kind: PoseReactionKind;
  source: PoseReactionSource;
  strength: number;
  timeline: Timeline;
  t: number;
  /** Gave way (or ended): fading out, never back. */
  leaving: boolean;
}
interface BodyRig { owner: object; chest: Bone | null; chest2: Bone | null; shoulderLeft: Bone | null; shoulderRight: Bone | null }
interface WaveRig { rig: RpsRig; sign: number }

export interface PoseReactionStageState {
  attention: number;
  multiplier: number;
  playing: { kind: PoseReactionKind; source: PoseReactionSource; t: number; weight: number; arm: number; leaving: boolean } | null;
  played: number;
  skipped: number;
  /** I-006: breather yawns handed to 哈欠捂嘴. */
  covered: number;
  wave: { arm: boolean; side: string | null; fingers: number; swings: number } | null;
}

const NEUTRAL: LifeActivity = Object.freeze({ gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0,
  sway: 1, bodyZ: 0, blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 });
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const findBone = (mesh: SkinnedMesh, names: readonly string[]): Bone | null => {
  for (const name of names) { const bone = mesh.skeleton?.bones.find(b => b.name === name); if (bone) return bone; }
  return null;
};

export class PoseReactionStage {
  private owner: object | null = null;
  private attention = 0;
  private boost = 1;
  private readonly seen = new Set<string>();
  private playing: Playing | null = null;
  /** The reaction's own weight (face, head, chest and shoulders). */
  private readonly weight = MinJerk.at(0);
  /** The raised arm (wave). */
  private readonly arm = MinJerk.at(0);
  private armDownAt = Infinity;
  private swingStart = Infinity;
  private bodyRig: BodyRig | null = null;
  private waveRig: WaveRig | null | undefined = undefined;
  private played = 0;
  private skipped = 0;
  private covered = 0;
  private swingsDone = 0;
  private readonly out: LifeActivity = { ...NEUTRAL, mouthOpen: 0 };
  private readonly base = new Map<Bone, Quaternion>();
  private readonly baseSet = new Set<Bone>();
  private readonly q1 = new Quaternion(); private readonly q2 = new Quaternion(); private readonly q3 = new Quaternion(); private readonly q4 = new Quaternion();
  private readonly v1 = new Vector3(); private readonly v2 = new Vector3(); private readonly v3 = new Vector3(); private readonly v4 = new Vector3(); private readonly v5 = new Vector3();
  private readonly v6 = new Vector3();
  private readonly m1 = new Matrix4(); private readonly m2 = new Matrix4();
  private readonly sv = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private diagnosticsAt = -Infinity;
  private diagnosticsText = 'null';

  constructor(private readonly timing: Readonly<PoseReactionTiming> = POSE_REACTION_TIMING) {}

  /** True while anything is shown (attention, a reaction, or its fading). */
  get active(): boolean { return this.attention > 1e-4 || this.playing !== null; }
  /** A reaction is playing (the motion-glitch record's activity names). */
  get reacting(): boolean { return this.playing !== null; }
  /**
   * I-006: a stretch or a wave is moving her chest, shoulders or arm (not yet giving way). Her own held pose (a hand on her chin while
   * she thinks) gives way meanwhile, so the rising shoulder never pushes that hand into her face; it comes back after, at its own pace.
   */
  get holdsBody(): boolean { const p = this.playing; return !!p && !p.leaving && (p.kind === 'stretch' || p.kind === 'wave'); }

  /**
   * One display frame, after her own life and the game face: returns the activity procedural life reads this frame. With no view
   * and nothing playing it returns `base` itself, untouched.
   */
  frame(delta: number, input: PoseReactionStageInput, base: LifeActivity | null): LifeActivity | null {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0;
    if (input.owner !== this.owner) this.reset(input.owner);
    const view = readPoseReactionView(input.view), timing = this.timing;
    // Attention: slow toward the user, a little quicker away.
    const target = view ? view.attention : 0;
    if (view) this.boost = view.boost;
    this.attention += (target - this.attention) * (1 - Math.exp(-dt / (target > this.attention ? timing.attentionIn : timing.attentionOut)));
    if (this.attention < 1e-4 && target === 0) this.attention = 0;
    // A new cue: once per id, from its start time, while fresh; skipped when she is busy then (she does not do it late).
    const cue = view?.cue;
    if (cue && !this.seen.has(cue.id) && input.nowMs >= cue.at) {
      this.seen.add(cue.id);
      if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value as string);
      const fresh = input.nowMs - cue.at <= POSE_CUE_FRESH_MS;
      if (cue.source === 'pause') this.breather(cue.kind, cue.strength, cue.id, cue.cover, fresh, input);
      else if (fresh && !this.playing && this.free(cue.kind, input)) this.start(cue.kind, cue.source, cue.strength, cue.id, input);
      else this.skipped++;
    }
    this.advance(dt, input);
    if (!this.active) return base;
    return this.compose(base);
  }

  /** Chest, shoulders and the waving arm through the stage's program layer; call after procedural life's own body writes. */
  applyPose(port: PoseReactionPort): void {
    const playing = this.playing;
    if (!playing || !this.owner) return;
    const timeline = playing.timeline, w = this.weight.x, s = playing.strength;
    if (w > 1e-5 && (timeline.chest || timeline.shoulders)) {
      const rig = this.bodyRig;
      if (rig) {
        const chest = timeline.chest ? sampleKeys(timeline.chest, playing.t) * w * s : 0;
        if (chest !== 0) {
          // Two spine bones share the bend (a curve, not a hinge); one alone takes all of it.
          if (rig.chest && rig.chest2) { port.rotate(rig.chest, chest * 0.4, 0, 0); port.rotate(rig.chest2, chest * 0.6, 0, 0); }
          else if (rig.chest ?? rig.chest2) port.rotate((rig.chest ?? rig.chest2)!, chest, 0, 0);
        }
        const shoulders = timeline.shoulders ? sampleKeys(timeline.shoulders, playing.t) * w * s : 0;
        // Both or neither (one raised shoulder would read as a shrug to one side); left +z / right −z rise, as procedural life's breath.
        if (shoulders !== 0 && rig.shoulderLeft && rig.shoulderRight) { port.rotate(rig.shoulderLeft, 0, 0, shoulders); port.rotate(rig.shoulderRight, 0, 0, -shoulders); }
      }
    }
    if (timeline.wave && this.arm.x > 1e-5) this.applyArm(port, playing);
  }

  getState(): PoseReactionStageState {
    const round = (value: number) => Math.round(value * 1e4) / 1e4, playing = this.playing, wave = this.waveRig;
    return { attention: round(this.attention), multiplier: round(1 + (this.boost - 1) * this.attention),
      playing: playing ? { kind: playing.kind, source: playing.source, t: round(playing.t), weight: round(this.weight.x), arm: round(this.arm.x), leaving: playing.leaving } : null,
      played: this.played, skipped: this.skipped, covered: this.covered,
      wave: wave ? { arm: !!wave.rig.upper, side: wave.rig.side, fingers: wave.rig.fingers, swings: this.swingsDone } : null };
  }
  /** `data-pose-reaction` text, refreshed at most every 250 ms of the caller's clock (ms). */
  diagnostics(nowMs: number): string {
    if (!(nowMs - this.diagnosticsAt < 250)) { this.diagnosticsAt = nowMs; this.diagnosticsText = JSON.stringify(this.getState()); }
    return this.diagnosticsText;
  }

  // ------------------------------------------------------------ internals

  private reset(owner: object | null): void {
    this.owner = owner; this.attention = 0; this.playing = null; this.weight.snap(0); this.arm.snap(0); this.armDownAt = this.swingStart = Infinity;
    this.bodyRig = null; this.waveRig = undefined; this.base.clear(); this.baseSet.clear();
  }

  /**
   * I-006: the user's breather. Only with her body free (a stretch or a hand both move it); a yawn is 哈欠捂嘴 in a whole-body framing,
   * else the stretch. Late, or not free: skipped, never played late.
   */
  private breather(kind: PoseReactionKind, strength: number, id: string, cover: PoseCoverCue | undefined, fresh: boolean, input: PoseReactionStageInput): void {
    if (!fresh || this.playing || !this.free('stretch', input)) { this.skipped++; return; }
    if (kind === 'yawn' && cover && input.fullBody === true && input.cover) {
      this.covered++;
      try { input.cover({ ...cover }); } catch { /* The hand is the action player's; nothing here to undo. */ }
      return;
    }
    this.start('stretch', 'pause', strength, id, input);
  }

  /** Free for this kind now: the owners her own life gives way to; the game; the body owners for the ones that move the body. */
  private free(kind: PoseReactionKind, input: PoseReactionStageInput): boolean {
    const g = input.gates;
    if (!g || !g.expressive || g.engaged || g.asleep || input.game) return false;
    return kind === 'glance' || kind === 'yawn' ? true : !g.bodyOwned;
  }

  private start(kind: PoseReactionKind, source: PoseReactionSource, strength: number, id: string, input: PoseReactionStageInput): void {
    const timeline = POSE_REACTION_TIMELINES[kind];
    const mesh = input.owner as SkinnedMesh;
    if ((timeline.chest || timeline.shoulders) && this.bodyRig?.owner !== input.owner && mesh?.skeleton)
      this.bodyRig = { owner: mesh, chest: findBone(mesh, ['上半身']), chest2: findBone(mesh, ['上半身2']), shoulderLeft: findBone(mesh, ['左肩']), shoulderRight: findBone(mesh, ['右肩']) };
    if (timeline.wave) {
      if (this.waveRig === undefined) this.waveRig = mesh?.skeleton ? this.bindWave(mesh, input.proxy) : null;
      if (!this.waveRig?.rig.upper) { this.skipped++; return; } // no arm to wave with: nothing (the face alone would look odd)
    }
    this.playing = { id, kind, source, strength: clamp(strength, 0, 1.2), timeline, t: 0, leaving: false };
    this.played++;
    this.weight.snap(1); // every curve starts at rest with zero speed
    if (timeline.wave) {
      const seconds = this.armSeconds();
      this.arm.to(1, seconds);
      this.swingStart = seconds * 0.75;
      this.armDownAt = this.swingStart + this.timing.swings / this.timing.swingHz;
      this.swingsDone = 0;
    }
  }

  private advance(dt: number, input: PoseReactionStageInput): void {
    const playing = this.playing;
    if (!playing) return;
    playing.t += dt;
    if (!playing.leaving && !this.free(playing.kind, input)) {
      // Something higher came: give way from where she is, at her speed, and do not come back.
      playing.leaving = true;
      this.weight.to(0, this.yieldSeconds(playing));
      if (playing.timeline.wave) this.arm.to(0, this.armSeconds());
    }
    if (playing.timeline.wave && !playing.leaving && playing.t >= this.armDownAt && this.arm.goal > 0) this.arm.to(0, this.armSeconds());
    this.weight.step(dt); this.arm.step(dt);
    const over = playing.timeline.wave ? playing.t >= this.armDownAt && !this.arm.moving && this.arm.x <= 1e-6
      : playing.t >= playing.timeline.duration;
    if ((playing.leaving && this.weight.x <= 1e-6 && !this.weight.moving && this.arm.x <= 1e-6 && !this.arm.moving) || over) {
      this.playing = null; this.weight.snap(0); this.arm.snap(0); this.armDownAt = this.swingStart = Infinity;
    }
  }

  /** Giving way: the face and head in yieldS; the chest and shoulders by their acceleration budget (min-jerk peak ≈ 5.77·Δ/T²). */
  private yieldSeconds(playing: Playing): number {
    let span = 0;
    for (const keys of [playing.timeline.chest, playing.timeline.shoulders]) if (keys) span = Math.max(span, Math.abs(sampleKeys(keys, playing.t)) * playing.strength);
    const body = span > 0 ? Math.sqrt(5.77 * span * 180 / Math.PI * this.weight.x / this.timing.bodyAccel) : 0;
    return clamp(Math.max(this.timing.yieldS, body), this.timing.yieldS, 1.2);
  }

  /** Raising or lowering the arm: from the whole pose difference and the acceleration budget, as G1 does (any turn-round stays in it). */
  private armSeconds(): number {
    const rig = this.waveRig?.rig;
    const span = rig ? (rig.restUpper.angleTo(rig.design.upper) + rig.design.upper.angleTo(rig.design.fore)) * 180 / Math.PI : 90;
    return clamp(Math.sqrt(5.77 * span / this.timing.armAccel), this.timing.armMin, this.timing.armMax);
  }

  private compose(base: LifeActivity | null): LifeActivity {
    const from = base ?? NEUTRAL, out = this.out;
    Object.assign(out, from);
    out.mouthOpen = from.mouthOpen ?? 0;
    // Attention rides the R18 "look at you" moments: more of them, never a fixed stare.
    out.lookAtUser = from.lookAtUser * (1 + (this.boost - 1) * this.attention);
    const playing = this.playing;
    if (playing) {
      const t = playing.timeline, w = this.weight.x, at = playing.t, head = Math.min(1, playing.strength || 0.6);
      if (t.lookUp) out.lookUp = Math.max(out.lookUp, sampleKeys(t.lookUp, at) * w);
      if (t.headX) out.headX += sampleKeys(t.headX, at) * w * head;
      if (t.headZ) out.headZ += sampleKeys(t.headZ, at) * w * head;
      if (t.lidSoft) out.lidSoft = Math.max(out.lidSoft, sampleKeys(t.lidSoft, at) * w);
      if (t.smileEyes) out.smileEyes = Math.max(out.smileEyes, sampleKeys(t.smileEyes, at) * w);
      if (t.mouthSmile) out.mouthSmile = Math.max(out.mouthSmile, sampleKeys(t.mouthSmile, at) * w);
      if (t.mouthOpen) out.mouthOpen = Math.max(out.mouthOpen ?? 0, sampleKeys(t.mouthOpen, at) * w);
    }
    return out;
  }

  // ------------------------------------------------------------ the wave (G1's raised arm, an open hand, outward swings)

  private bindWave(mesh: SkinnedMesh, proxy: CollisionProxy | null | undefined): WaveRig | null {
    let rig: RpsRig | null = null;
    try { rig = buildRpsRig(mesh, proxy); } catch { rig = null; }
    if (!rig?.upper || !rig.points) return rig ? { rig, sign: 1 } : null;
    // Outward: the side of the shoulder from the body's midline (x = 0 in an MMD model's rest space).
    const out = this.v1.set(Math.sign(rig.points.shoulder.x) || 1, 0, 0);
    const moves = this.v2.copy(rig.design.palm).cross(rig.design.fore);
    return { rig, sign: Math.sign(moves.dot(out)) || 1 };
  }

  /** Swing angle now (rad): outward only, three smooth swings inside a smooth window (zero speed where it starts and ends). */
  private swing(playing: Playing): number {
    const timing = this.timing, tau = playing.t - this.swingStart, length = timing.swings / timing.swingHz;
    if (!(tau > 0) || tau >= length) return 0;
    const ramp = timing.swingRamp, edge = Math.min(tau, length - tau);
    const window = edge >= ramp ? 1 : Math.sin(Math.PI / 2 * edge / ramp) ** 2;
    const count = Math.floor(tau * timing.swingHz);
    if (count + 1 > this.swingsDone) this.swingsDone = Math.min(timing.swings, count + 1);
    return timing.swingAmp * Math.min(1.2, Math.max(0.5, playing.strength)) * (1 - Math.cos(2 * Math.PI * timing.swingHz * tau)) / 2 * window;
  }

  /** The arm and the open hand (program layer: every bone remembered first). G1's writing (applyPose), another swing. */
  private applyArm(port: PoseReactionPort, playing: Playing): void {
    const wave = this.waveRig, w = this.arm.x;
    if (!wave) return;
    const rig = wave.rig, { upper, elbow, wrist } = rig;
    if (!upper || !elbow || !wrist || rig.owner !== this.owner) return;
    this.baseSet.clear();
    const chestQ = rig.chest.getWorldQuaternion(this.q1);
    const U = this.v1.copy(rig.design.upper).applyQuaternion(chestQ), K = this.v2.copy(rig.design.hinge).applyQuaternion(chestQ);
    const P = this.v5.copy(rig.design.palm).applyQuaternion(chestQ);
    // The forearm and hand swing about the palm's normal (the palm keeps facing the user), away from her head. The forearm turns
    // as one piece with its hinge, so the hand keeps still relative to it and the wrist twist bones do not move with the swing
    // (a smallest-swing elbow made the twist bones turn faster than the swing itself: caught at 30 fps with a late frame).
    const swing = this.q2.setFromAxisAngle(P, wave.sign * this.swing(playing));
    const F = this.v3.copy(rig.design.fore).applyQuaternion(chestQ).applyQuaternion(swing);
    const H = this.v4.copy(rig.design.hand).applyQuaternion(chestQ).applyQuaternion(swing);
    const hinge = this.v6.copy(K).applyQuaternion(swing);
    const parentQ = upper.parent ? upper.parent.getWorldQuaternion(this.q3) : this.q3.identity();
    const world = alignTwo(rig.restUpper, rig.restHinge, U, K, this.q4, this.m1, this.m2, this.sv);
    this.write(port, upper, parentQ.invert().multiply(world), w);
    const elbowParent = elbow.parent ? elbow.parent.getWorldQuaternion(this.q3) : this.q3.identity();
    const forearm = alignTwo(rig.restFore, rig.restHinge, F, hinge, this.q4, this.m1, this.m2, this.sv);
    this.write(port, elbow, elbowParent.invert().multiply(forearm), w);
    const handWorld = alignTwo(rig.restHand, rig.restPalm, H, P, this.q2, this.m1, this.m2, this.sv);
    if (rig.twist) {
      const elbowWorld = elbow.getWorldQuaternion(this.q3);
      const relative = elbowWorld.invert().multiply(handWorld);
      const axis = rig.restFore, dot = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
      const twist = this.q4.set(axis.x * dot, axis.y * dot, axis.z * dot, relative.w);
      if (twist.lengthSq() < 1e-9) twist.identity(); else twist.normalize();
      this.write(port, rig.twist, twist, w);
      this.write(port, wrist, this.q2.copy(twist).invert().multiply(relative), w);
    } else {
      const wristParent = wrist.parent ? wrist.parent.getWorldQuaternion(this.q3) : this.q3.identity();
      this.write(port, wrist, wristParent.invert().multiply(handWorld), w);
    }
    for (const joint of rig.joints) this.write(port, joint.bone, joint.targets.paper, w);
    for (const grant of rig.grants) {
      const before = this.baseSet.has(grant.parent) ? this.base.get(grant.parent) : undefined;
      if (!before) continue;
      port.remember(grant.child);
      const old = this.q2.identity().slerp(before, grant.ratio).invert(), now = this.q3.identity().slerp(grant.parent.quaternion, grant.ratio);
      grant.child.quaternion.multiply(old).multiply(now);
    }
  }

  private write(port: PoseReactionPort, bone: Bone, target: Quaternion, weight: number): void {
    port.remember(bone);
    if (!this.baseSet.has(bone)) {
      let saved = this.base.get(bone);
      if (!saved) this.base.set(bone, saved = new Quaternion());
      saved.copy(bone.quaternion); this.baseSet.add(bone);
    }
    bone.quaternion.slerp(target, Math.min(1, Math.max(0, weight)));
  }
}
