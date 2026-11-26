/**
 * Unbound U1: her body in the world (docs/claude/2026-11-12-unbound-u1-part1.md, -part2.md).
 *
 * Loaded the way the companion's stage loads her (src/stage/: the same loading manager and capped textures, the same keyframe
 * interpolation and VMD parser, the same motion fitting for a model that is not the reviewed Gene, the same layered mixer and
 * the same local hair/chest physics when it is switched on).
 *
 * Part 2: she stands with weight and walks. Her place, her heading, her steps and her hips come from the gait (gait.ts, the one
 * owner of contact); her feet are put on her floor by the model's own leg IK (contact.ts, the only writer of the IK targets,
 * written last). Residuals (breath, arms down, the lean that keeps her head over her feet, the look toward where she is going,
 * arm swing) go through the dynamics layer (dynamics.ts) and ride on top of the motion; everything is restored before the
 * mixer's next update (the stage's own rule). The VMD itself is not filtered unless a style group is turned up (style-filter.ts,
 * all 0 by default: a true bypass).
 *
 * One frame, in order:
 *   physics restore → residual restore → mixer (no IK yet) → style filter (bypassed at 0) → gait and dynamics step →
 *   residuals → her place → reach guard → foot targets (last write) → IK and grants → COM measured → physics
 *
 * Units: the scene is in model units (one unit = MMD_UNIT_M meters), so the skinned mesh, its IK and its physics keep the scale
 * they were made for; the camera, her place and her gait are in meters.
 */
import { AnimationClip, Bone, Box3, Euler, Matrix4, Quaternion, Texture, Vector3, type Material, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { LayeredMmdAnimation, type MotionLayerClips } from '../stage/motion-layers';
import { withKeyframeInterpolation } from '../stage/keyframe-interpolation';
import { createVmdParser, type VmdDataTransform } from '../foundation/vmd';
import { createModelLoadingManager } from '../stage/model-loading';
import { relaxedArmRoll } from '../stage/procedural';
import { JellyMaterialPatch, StageJelly, StagePull, createJellyUniforms, type LocalModelPhysics, type StagePullHit, type StageView } from '../stage/model-physics';
import type { ModelPhysicsSettings } from '../../shared/stage';
import { MMD_UNIT_M, type Placement } from '../../shared/unbound/world';
import { BodyDynamics, BreathOscillator, EyeMovement, MOTION_GROUPS, RotationSpring, substeps } from './dynamics';
import { BodyRig, ContactOwner, type FootReport } from './contact';
import { Gait, type GaitBody, type GaitKnobs, type Stance } from './gait';
import { VmdStyleFilter } from './style-filter';
import { IntentLayer } from './intent-layer';
import { ArmReach } from './arm-reach';
import type { MorphSlot } from '../../shared/actions';
import type { MouthBase } from '../../shared/behaviors/part-mix/interface';
import { DEFAULT_GAIT_KNOBS } from './gait';
import { REST_TARGETS, asksForGaze, type BodySense, type PoseTargets } from './motion/generator';
import { toHerFrame, type V3 } from './motion/lens-align';
import { EyeHeadCoordinator, type EyeHeadParams, type Look } from '../stage/eye-head';
import { expMap } from './dynamics';
import { ClipSwitchBridge } from './clip-switch';
import { figureBone } from './model/figure-bones';
import { blinkMorph, eyeTurnGain, measureEyeRooms } from './model/eye-turn-gain';
import { measureFace } from './model/face-measure'; // I-192: her face for the arrival targets
import { JellyProgramWarmer } from './jelly-warm'; // step 6: the jelly's programs compiled ahead, not at the first touch
import type { FaceGeometry } from '../../shared/unbound/arrival';

/** Scene units per meter. */
export const UNITS_PER_M = 1 / MMD_UNIT_M;

export interface LoadedModel { mesh: SkinnedMesh; textures: Promise<void> }

/** The model, as the stage loads it. `textures` settles when every texture has loaded or failed. */
export function loadModel(url: string, onBytes?: (loaded: number, total?: number) => void): Promise<LoadedModel> {
  const manager = createModelLoadingManager();
  let settle!: () => void;
  const textures = new Promise<void>(resolve => { settle = resolve; });
  manager.onLoad = () => settle();
  manager.onError = () => { /* a missing texture shows as the stage shows it; the load goes on */ };
  return new Promise((resolve, reject) => new MMDLoader(manager).load(url, mesh => {
    mesh.frustumCulled = false; // skinned bounds do not follow the motion
    resolve({ mesh: mesh as SkinnedMesh, textures });
  }, onBytes ? (event: ProgressEvent) => onBytes(event.loaded, event.lengthComputable ? event.total : undefined) : undefined, reject));
}

/** One VMD as a clip for this mesh (keyframe interpolation, the authored length kept), like the stage's loadMotions. */
export function loadClip(url: string, mesh: SkinnedMesh, transform?: VmdDataTransform): Promise<AnimationClip> {
  const loader = withKeyframeInterpolation(new MMDLoader());
  let sourceDuration = 0;
  loader.parser = createVmdParser(report => { sourceDuration = report.durationFrames / 30; }, transform);
  return new Promise((resolve, reject) => loader.loadAnimation(url, mesh, value => {
    const clip = value as AnimationClip;
    clip.duration = Math.max(clip.duration, sourceDuration, 1 / 30);
    resolve(clip);
  }, undefined, reject));
}

export function disposeModel(mesh: SkinnedMesh): void {
  mesh.geometry.dispose();
  const textures = new Set<Texture>();
  for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[]) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    const uniforms = (material as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
    if (uniforms) for (const uniform of Object.values(uniforms)) if (uniform.value instanceof Texture) textures.add(uniform.value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  mesh.skeleton.dispose();
}

const findBone = figureBone; // exact names first, then the alias table (I-152 step 2)

/** Residual sizes (first picks, by eye in the preview). */
const LEAN_PER_M = 0.5;          // upper-body lean (rad) per meter of hip shift, the other way: her head stays over her feet
/** E1: her look toward where she is going, per radian still to turn, and at most (rad); the coordinator splits it (eyes, head, body). */
const LOOK_TRAVEL = 1.1, LOOK_TRAVEL_MAX = 0.75;
/** E1: the coordinator's head turn, shared between the neck and the head. */
const GAZE_NECK_SHARE = 0.35;
const ARM_SWING_RAD = 0.14;      // ≈ 8° each way at a full stride

/** What the figure measured on its last frame (meters, world), for the debug line and tests. */
/** I-154 batch 5: clips over her motion at the mixer's level (UnboundFigure.setMotionLayer). */
export interface FigureMotionLayer {
  restore(): void;
  beforeUpdate(delta: number): void;
  frame(delta: number): void;
  /** 0..1: how much of her arms it holds now. */
  readonly armsHeld: number;
}
export interface FigureReport {
  feet: FootReport[];
  com: { x: number; y: number; z: number } | null;
  comMargin: number | null;
  reachDrop: number;
  stance: string;
  steps: number;
}

/** Her model's bounds at rest (model units), as she is measured once when she is made. */
function figureBounds(mesh: SkinnedMesh): Box3 { mesh.updateMatrixWorld(true); return new Box3().setFromObject(mesh); }
/** Her height (model units) as UnboundFigure measures it; I-212: the page's first placement reads it before she is made (her-spot.ts). */
export function figureHeightUnits(mesh: SkinnedMesh): number { const bounds = figureBounds(mesh); return Math.max(1, bounds.max.y - bounds.min.y); }

export class UnboundFigure {
  /** Her height in model units (at rest) and the offset that puts her soles on the floor. */
  readonly heightUnits: number;
  readonly floorUnits: number;
  readonly head: Bone | null;
  private readonly animation: LayeredMmdAnimation;
  private readonly clipSwitch: ClipSwitchBridge;
  private readonly dynamics = new BodyDynamics();
  private readonly breath = new BreathOscillator();
  private readonly chest: Bone | null;
  private readonly center: Bone | null;
  private readonly arms: { bone: Bone; roll: number; side: 1 | -1 }[] = [];
  private readonly eyes: Bone[];
  private readonly saved = new Map<Bone, { quaternion: Quaternion; position: Vector3 }>();
  private readonly euler = new Euler();
  private readonly turn = new Quaternion();
  private readonly rig: BodyRig | null;
  private readonly contact: ContactOwner | null;
  private readonly style: VmdStyleFilter;
  private readonly lean = new RotationSpring({ ...MOTION_GROUPS.chest, eased: true });
  /** E1 (docs/claude/2026-11-14-eye-head-fix.md): every look goes through one eye-head coordinator; these move what it asks for. */
  private gaze = new EyeHeadCoordinator();
  private gazeRecenterBase = this.gaze.params.recenterShare;
  private readonly gazeHead = new RotationSpring({ ...MOTION_GROUPS.head, eased: true });
  private readonly gazeChest = new RotationSpring({ ...MOTION_GROUPS.chest, eased: true });
  private readonly eyeYaw = new EyeMovement();
  private readonly eyePitch = new EyeMovement();
  private gazeTarget: Look | null = null;
  private readonly neck: Bone | null;
  private readonly armSwing = new RotationSpring({ ...MOTION_GROUPS.arms, eased: true });
  private gait: Gait | null = null;
  private gaitBody: GaitBody | null = null;
  private readonly pending: { goal: Placement; facing: { x: number; z: number } | null; knobs: Partial<GaitKnobs>; stance: Stance };
  private readonly start: Placement;
  private breathStrength = 0.5;
  private armsOwned = false;
  private physics: LocalModelPhysics | null = null;
  /** I-147 全身果冻 layers 2 and 3 (src/stage/jelly/stage-jelly.ts, the companion's own class); null unless a lab tuning turns one on. */
  private jelly: StageJelly | null = null;
  private jellyWarm: JellyProgramWarmer | null = null;
  /** Step 5 拉她 (src/stage/pull/): the same layer as the companion's, without her legs (the gait and its IK own them). */
  private readonly pulling = new StagePull(undefined, { legs: false });
  private disposed = false;
  private framed = false;
  private lastReport: FigureReport | null = null;
  private readonly comPoint = new Vector3();
  /** U2: generated motion (layer 2's PoseTargets) through its springs (intent-layer.ts). */
  private readonly intent: IntentLayer;
  private walkOverride: number | null = null;
  private briskOverride = false;
  private facingOverride = '';
  private readonly pivot: Bone | null;
  /** Each eye as you see it (measureEyeAnchors) and how tall it is (m; null when the model does not say). Measured once per model. */
  private readonly eyeAnchors: EyeAnchor[];
  readonly eyeSizeM: number | null;
  /** I-192: her face for the arrival targets (model/face-measure.ts; null: not measurable, the director falls back to her height). */
  readonly face: FaceGeometry | null;
  /** How much of a look her eye bones take (model/eye-turn-gain.ts): 1 for Gene, less for an iris that fills its eye opening. */
  readonly eyeTurnGain: number;
  private lastSense: BodySense | null = null;
  /** I-154 batch 3: a whole-body layer after her feet and before physics (the window's sleep body); its bones are remembered, put back next frame. */
  private overlay: ((remember: (bone: Bone) => void, delta: number) => void) | null = null;
  setOverlay(layer: ((remember: (bone: Bone) => void, delta: number) => void) | null): void { this.overlay = layer; }
  /**
   * I-154 batch 5: one-shot clips over her motion at the mixer's level (the window's chat gesture, her actions, automatic body motions:
   * window-mode/window-clips.ts). It puts back its own writes before the mixer (after the residuals come off), may change the mixer's
   * bindings just before its update, writes right after it (so the residuals, her feet and IK ride on it), and says how much of her arms
   * it holds (the arms she would lower herself without a pose motion stay up under it).
   */
  private motionLayer: FigureMotionLayer | null = null;
  setMotionLayer(layer: FigureMotionLayer | null): void { this.motionLayer = layer; }
  /** Batch 5: her motion layers' bindings, for an automatic body motion in the same mixer (src/stage/behavior-body.ts). */
  behaviorBodyBindings(options: { allowBaseProjection?: boolean } = {}) { return this.animation.getBehaviorBodyBindings(options); }
  /** Showcase (docs/claude/2026-11-14-lapwing-showcase.md): her hands reaching (arm-reach.ts), and whether the walk's own look turns head and eyes (on unless a performance owns them). */
  private readonly reach: ArmReach;
  private gaitLook = true;

  constructor(readonly mesh: SkinnedMesh, placement: Placement) {
    const bounds = figureBounds(mesh);
    this.heightUnits = Math.max(1, bounds.max.y - bounds.min.y);
    this.floorUnits = -bounds.min.y;
    this.animation = new LayeredMmdAnimation(mesh);
    this.clipSwitch = new ClipSwitchBridge(mesh);
    this.head =findBone(mesh, ['頭', 'head', 'Head']);
    this.neck = findBone(mesh, ['首', 'neck', 'Neck']);
    this.chest = findBone(mesh, ['上半身2', '上半身', 'spine', 'Spine', 'Chest']);
    this.center = findBone(mesh, ['センター', '全ての親', 'center', 'Center']);
    this.eyes = [findBone(mesh, ['左目', 'LeftEye']), findBone(mesh, ['右目', 'RightEye'])].filter((bone): bone is Bone => !!bone);
    for (const [names, side] of [[['左腕', 'LeftArm', 'left_arm'], 1], [['右腕', 'RightArm', 'right_arm'], -1]] as const) {
      const bone = findBone(mesh, names), child = bone?.children.find((node): node is Bone => node instanceof Bone);
      if (bone && child) this.arms.push({ bone, roll: relaxedArmRoll(child.position.x, child.position.y), side });
    }
    // The leg IK and grants are solved here, after her feet are placed (the helper would solve them before).
    this.rig = BodyRig.find(mesh);
    const objects = this.animation.helper.objects.get(mesh) as { ikSolver?: { update(): unknown }; grantSolver?: { update(): unknown } } | undefined;
    this.animation.helper.enable('ik', false);
    this.animation.helper.enable('grant', false);
    this.solvers = { ik: objects?.ikSolver ?? null, grant: objects?.grantSolver ?? null };
    this.contact = this.rig ? new ContactOwner(this.rig, UNITS_PER_M, this.solvers.ik, this.solvers.grant) : null;
    this.style = new VmdStyleFilter(mesh);
    this.intent = new IntentLayer(mesh);
    this.reach = new ArmReach(mesh);
    this.pivot = findBone(mesh, ['上半身', 'spine', 'Spine']);
    this.eyeAnchors = measureEyeAnchors(mesh, this.eyes);
    const sizes = this.eyeAnchors.map(a => a.sizeM).filter((s): s is number => s !== null && s > 0.003 && s < 0.1);
    this.eyeSizeM = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null;
    this.face = measureFace(mesh, this.head, this.eyes, MMD_UNIT_M);
    this.eyeTurnGain = eyeTurnGain(measureEyeRooms(mesh, this.eyes, blinkMorph(mesh)), this.gaze.params.eyeSoft.up);
    // Her first appearance: at rest where she stands (no glide in from elsewhere).
    this.start = { ...placement };
    this.pending = { goal: { ...placement }, facing: null, knobs: {}, stance: 'both' };
    this.dynamics.begin('breath', 0);
    this.dynamics.begin('armsDown', 1);
    this.placeMesh(placement.xM, -placement.depthM, 0);
  }
  private readonly solvers: { ik: { update(): unknown } | null; grant: { update(): unknown } | null };

  get heightM(): number { return this.heightUnits * MMD_UNIT_M; }
  /** Where she is now, meters (world). */
  get placement(): Placement {
    const root = this.gait?.rootState;
    return root ? { xM: root.x, depthM: -root.z } : { ...this.pending.goal };
  }
  /** Facing (rad, 0 = toward the viewer's side of her world). */
  get heading(): number { return this.gait?.rootState.heading ?? 0; }
  /** Walking, turning or still settling her feet. */
  get moving(): boolean { return this.gait?.moving ?? (this.pending.goal.xM !== this.start.xM || this.pending.goal.depthM !== this.start.depthM); }
  /** Read-only, for the preview measurements: each eye bone's rotation against the head, in degrees (yaw about her up axis, pitch about her left-right axis). */
  eyeInHead(): { yaw: number; pitch: number }[] {
    const e = new Euler();
    return this.eyes.map(eye => { e.setFromQuaternion(eye.quaternion, 'YXZ'); return { yaw: e.y * 180 / Math.PI, pitch: e.x * 180 / Math.PI }; });
  }
  get walking(): boolean { return this.gait?.walking ?? false; }
  /** Feet, COM and balance of the last frame (null before the first). */
  get report(): FigureReport | null { return this.lastReport; }
  /** The contact owner's mode ('motion' lets a motion's own foot IK play as authored). */
  setContactMode(mode: 'ground' | 'motion'): void { if (this.contact) this.contact.mode = mode; }
  /** The VMD style softening per group (0 = untouched, the default). */
  get styleFilter(): VmdStyleFilter { return this.style; }

  /** The companion's motion layers (pose / gesture / expression); null clips mean breath only. */
  setClips(clips: MotionLayerClips, legacy: boolean, options: { unseen?: boolean } = {}): void {
    this.restoreResiduals();
    // `unseen`: framed but not drawn yet (the window's first motions, before she fades in; window-stage.ts): as before her first frame.
    const bridged = this.framed && options.unseen !== true;
    if (bridged) this.clipSwitch.switch(() => this.animation.setClips(clips, { legacy })); // shown: bridged, never a jump (clip-switch.ts)
    else { this.clipSwitch.restore(); this.animation.setClips(clips, { legacy }); }
    this.armsOwned = !!clips.pose || (!legacy && !!clips.gesture);
    // Before her first frame the arms simply start where the motion has them; later changes ease.
    if (!bridged) this.dynamics.begin('armsDown', this.armsOwned ? 0 : 1);
  }
  /** Targets only: where she should stand. She walks there. */
  place(placement: Placement): void {
    if (!Number.isFinite(placement.xM) || !Number.isFinite(placement.depthM)) return;
    this.pending.goal = { ...placement };
    this.gait?.setGoal(placement.xM, -placement.depthM);
  }
  /** Who she turns to when she is not walking somewhere (the viewer's eye, world meters on her floor). */
  faceToward(point: { x: number; z: number } | null): void { this.pending.facing = point ? { ...point } : null; if (!this.facingOverride) this.gait?.setFacingPoint(point); }
  setGait(knobs: Partial<GaitKnobs>): void { Object.assign(this.pending.knobs, knobs); this.gait?.setKnobs(knobs); }
  /** Both feet, or standing on one (the other lifted once her weight is over the support foot). */
  setStance(stance: Stance): void { this.pending.stance = stance; this.gait?.setStance(stance); }
  /**
   * U2, the one input from layer 2 (a generator's PoseTargets, docs/claude/2026-11-12-unbound-peek.md): goals only. Her place goes
   * to the gait (she walks), the rest to the intent layer's springs; nothing here writes a bone.
   */
  setPoseTargets(targets: PoseTargets): void {
    this.intent.set(targets);
    this.reach.set(targets.hands);
    this.gazeTarget = asksForGaze(targets) ? { yaw: targets.eyes.yaw, pitch: targets.eyes.pitch } : null;
    const share = targets.gazeRecenter; // showcase only; absent: the coordinator's own value, exactly as before
    this.gaze.params.recenterShare = share !== undefined && Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : this.gazeRecenterBase;
    if (targets.place && Number.isFinite(targets.place.x) && Number.isFinite(targets.place.z)) this.gait?.setGoal(targets.place.x, targets.place.z);
    if (targets.hop) this.gait?.hop(targets.hop); // U2 E2: a new id starts a hop when she stands still; the same id again is ignored
    const facing = targets.facing && Number.isFinite(targets.facing.x) && Number.isFinite(targets.facing.z) ? targets.facing : null;
    const facingKey = facing ? `${facing.x.toFixed(4)},${facing.z.toFixed(4)}` : '';
    if (facingKey !== this.facingOverride) { this.facingOverride = facingKey; this.gait?.setFacingPoint(facing ?? this.pending.facing); }
    const speed = targets.walkSpeedMps, brisk = targets.walkBrisk === true;
    if (speed !== this.walkOverride || brisk !== this.briskOverride) {
      this.walkOverride = speed; this.briskOverride = brisk;
      this.gait?.setKnobs({ speedMps: speed ?? this.pending.knobs.speedMps ?? DEFAULT_GAIT_KNOBS.speedMps, brisk });
    }
  }
  /** Back to no generated motion at all (the residuals ease out to nothing). */
  clearPoseTargets(): void { this.setPoseTargets({ ...REST_TARGETS }); }
  /** What her body measured on the last frame (world meters), for the director and its generator. */
  get sense(): BodySense | null { return this.lastSense; }
  /** The intent layer has her upright and on her heels again (eyes and face may still be easing). */
  get intentIdle(): boolean { return this.intent.settled; }
  /** U2 E2: how far her arms are raised (0..1), and her hips' hop lift (m), as realized now. */
  get armsRaised(): number { return this.intent.armsRaised; }
  get hopLift(): number { return this.gait?.hopLift ?? 0; }
  /** Showcase: the walk's own look off (a performance owns head and eyes), slot morphs as the page's model profile verified them, and the fingers' clearance from her face (m). */
  setGaitLook(on: boolean): void { this.gaitLook = on; }
  /** Showcase: her own eye-head balance (e.g. a three-quarter head that keeps more of a held look in the eyes). Starts the coordinator over. */
  setGazeParams(params: Partial<EyeHeadParams>): void { this.gaze = new EyeHeadCoordinator(params); this.gazeRecenterBase = this.gaze.params.recenterShare; }
  setSlotMorphs(map: Partial<Record<MorphSlot, number>> | null): void { this.intent.setSlotMorphs(map); }
  /** I-175: her mouth's eased "lip-sync owns the opening" (mouth.ts) and the base shape her face wrote last (intent-layer.ts). */
  setMouthTalk(talk: number): void { this.intent.setMouthTalk(talk); }
  get mouthBase(): MouthBase { return this.intent.mouthBase; }
  get handClearance(): number | null { return this.reach.clearance(); }
  get handsUp(): number { return this.reach.raised; }
  /** I-192 follow-up (Codex T-261): her arm reach can write her arms on this model at all (a VRM's standard body cannot today). */
  get armsCan(): boolean { return this.reach.available; }
  setBreath(strength: number): void { if (Number.isFinite(strength)) this.breathStrength = Math.min(1, Math.max(0, strength)); }
  attachPhysics(physics: LocalModelPhysics | null): void { this.physics?.dispose(); this.physics = physics; }
  get hasPhysics(): boolean { return !!this.physics; }
  /** Nothing is drawn (I-154 window mode, hidden): physics pauses, the jelly layers clear (nothing on screen to jump from); the next frame resumes. */
  hidePhysics(): void { this.physics?.setVisible(false); this.jelly?.hide(); }
  /** Step 1B: the physics budget follows the quality tier (in place; no rebuild). */
  configurePhysics(settings: ModelPhysicsSettings): void { this.physics?.configure(settings); }
  /** I-147: the model's lab tuning for the jelly layers (exactly as before while it turns none on). */
  configureJelly(settings: ModelPhysicsSettings): void {
    this.jelly = StageJelly.next(this.jelly, settings.tuning, settings.touchSoft); // step 5d: 碰了才软 as on the companion
    if (this.jelly) (this.jellyWarm ??= new JellyProgramWarmer(this.mesh, materials => new JellyMaterialPatch(createJellyUniforms()).ensure(materials))).setWanted(true);
  }

  // ---- step 5 拉她 (src/unbound/pull-input.ts drives these; the layer is src/stage/pull/) --------------------------------------
  /** The piece of her under the window point (CSS px), or null. */
  pullHit(view: StageView, x: number, y: number): StagePullHit | null { this.pulling.bind(this.mesh); return this.pulling.hit(view, x, y, this.heightUnits); }
  pullStart(hit: StagePullHit, view: StageView): boolean {
    const started = this.pulling.start(hit, view);
    if (started) this.pulling.soft.pullStart(this.jelly, hit.point, view.camera); // 5d: the touched spot gives
    return started;
  }
  pullTo(view: StageView, x: number, y: number): void { this.pulling.to(view, x, y); }
  pullEnd(): void { this.pulling.end(); this.pulling.soft.pullEnd(this.jelly); }
  setPullStance(stance: { compliance: number; pace: number } | null): void { this.pulling.setStance(stance); }
  get pullEngaged(): boolean { return this.pulling.engaged; }
  get pullState() { return this.pulling.getState(); }
  /** The pull as her body shows it, meters on her floor (x across, z toward you); zero when settled. */
  pullShownM(): { x: number; z: number } { const v = this.pulling.shownPull(new Vector3()); return { x: v.x / UNITS_PER_M, z: v.z / UNITS_PER_M }; }
  /** Where her root is now (m on her floor). */
  get rootM(): { x: number; z: number } { const r = this.gait?.rootState; return r ? { x: r.x, z: r.z } : { x: this.pending.goal.xM, z: -this.pending.goal.depthM }; }
  /** Her goal and root speed now (m, m/s on her floor; I-209 step 3: the stage keeps the goal clear of the others). */
  get goalM(): { x: number; z: number } { return this.gait?.goalPoint ?? { x: this.pending.goal.xM, z: -this.pending.goal.depthM }; }
  get velocityM(): { x: number; z: number } { return this.gait?.velocity ?? { x: 0, z: 0 }; }
  /** Step 5c: walk toward this point (m on her floor). Only the gait's goal: it alone moves her feet, at her walking speed at most. */
  followTo(point: { x: number; z: number }): void { if (Number.isFinite(point.x) && Number.isFinite(point.z)) this.gait?.setGoal(point.x, point.z); }
  private framePull(delta: number): void {
    this.mesh.updateMatrixWorld(true);
    this.pulling.apply({ remember: bone => this.remember(bone) }, delta, this.heightUnits);
    if (this.pulling.grabbed) this.pulling.soft.pullHold(this.jelly, this.pulling.shownPull(new Vector3()));
  }

  /** One frame (see the order at the top). */
  frame(delta: number, physicsDelta = delta): void {
    if (this.disposed) return;
    this.framed = true;
    this.physics?.restore();
    this.jelly?.remove(); // last frame's follow-through (it ran after the residuals, so it comes off before them)
    this.restoreResiduals();
    this.motionLayer?.restore();
    this.clipSwitch.restore();
    this.motionLayer?.beforeUpdate(delta);
    this.animation.helper.update(delta);
    this.clipSwitch.frame(delta);
    this.motionLayer?.frame(delta);
    const { count, h } = substeps(delta);
    if (this.style.active) this.style.apply(count, h, bone => this.remember(bone));
    if (!this.gait) this.beginGait();
    const gait = this.gait!;
    gait.setTiptoe(this.intent.tiptoe);
    gait.step(delta);
    this.dynamics.target('breath', this.breath.step(delta) * this.breathStrength * this.intent.breath);
    this.dynamics.target('armsDown', this.armsOwned ? 0 : 1 - (this.motionLayer?.armsHeld ?? 0));
    this.dynamics.step(delta);
    const pelvis = gait.pelvis, turnLeft = gait.turnLeft;
    this.lean.target(0, 0, pelvis.lateral * LEAN_PER_M);
    // E1: where she looks (a target from layer 2, else where she is going) → eyes, head and upper body, per sub-step.
    const travelTurn = this.gaitLook ? turnLeft : 0; // showcase: the performance gives the gaze itself
    const travel = { yaw: Math.max(-LOOK_TRAVEL_MAX, Math.min(LOOK_TRAVEL_MAX, travelTurn * LOOK_TRAVEL)), pitch: 0 };
    this.armSwing.target(gait.armSwing * ARM_SWING_RAD, 0, 0);
    for (let i = 0; i < count; i++) {
      this.stepGaze(h, travel);
      this.lean.advance(h); this.armSwing.advance(h); this.intent.advance(h); this.reach.advance(h);
    }

    // Residuals on top of the motion (restored next frame).
    const breath = this.dynamics.value('breath');
    this.rotate(this.chest, breath * 0.012, 0, 0);
    if (!this.lean.idle) this.rotateBy(this.chest, this.lean.quaternion(this.turn), false);
    this.applyGaze();
    const down = this.dynamics.value('armsDown');
    if (down > 1e-4) for (const arm of this.arms) this.rotate(arm.bone, 0, 0, arm.roll * down);
    if (!this.armSwing.idle) {
      const swing = this.armSwing.value.x;
      // Pre-multiplied (about her own left-right axis): a hanging arm swings forward for −x on her left, +x on her right.
      for (const arm of this.arms) this.rotateBy(arm.bone, this.turn.setFromAxisAngle(AXIS_X, -swing * arm.side), true);
    }
    this.intent.apply((bone, rotation) => this.rotateBy(bone, rotation, false)); // U2: generated motion, through its springs
    if (this.center) {
      this.remember(this.center);
      const k = UNITS_PER_M, extra = this.intent.pelvis;
      this.center.position.x += (pelvis.lateral + extra.lateral) * k;
      this.center.position.y += (pelvis.vertical + extra.vertical) * k + breath * this.heightUnits * 0.0015;
      this.center.position.z += (pelvis.forward + extra.forward) * k;
    }
    const root = gait.rootState;
    this.placeMesh(root.x, root.z, root.heading);
    if (this.reach.active) { this.mesh.updateMatrixWorld(true); this.reach.apply(bone => this.remember(bone)); } // showcase: hands, after the body they ride on
    if (this.pulling.engaged) this.framePull(delta); // step 5: after the body it rides on, before her feet (the lean moves her weight; the gait steps)

    // Her feet, last: the reach guard may lower her hips a little; then the only write of the foot targets, then IK.
    let reachDrop = 0;
    if (this.contact && this.gaitBody) {
      for (const bone of this.contact.bones) this.remember(bone);
      reachDrop = this.contact.guardReach(gait.footStates, this.gaitBody.ankleHeight, this.gaitBody.legLength);
      this.contact.writeAndSolve(gait.footStates, this.gaitBody.ankleHeight);
    } else {
      this.mesh.updateMatrixWorld(true);
      this.solvers.ik?.update(); this.solvers.grant?.update();
      this.mesh.updateMatrixWorld(true);
    }
    const com = this.rig?.com(this.comPoint) ?? null;
    const comM = com ? { x: com.x / UNITS_PER_M, y: com.y / UNITS_PER_M, z: com.z / UNITS_PER_M } : null;
    gait.setCom(comM ? { x: comM.x, z: comM.z } : null);
    this.lastReport = { feet: this.contact?.report() ?? [], com: comM, comMargin: gait.comMargin(), reachDrop, stance: gait.stance, steps: gait.stepCount };
    this.lastSense = this.measureSense(gait);
    if (this.overlay) { this.mesh.updateMatrixWorld(true); this.overlay(bone => this.remember(bone), delta); this.mesh.updateMatrixWorld(true); }

    if (this.jelly) { this.jelly.frame(this.mesh, delta); if (this.jelly.idle) { this.jelly.dispose(); this.jelly = null; this.jellyWarm?.setWanted(false); } } // after the final pose, before physics
    this.physics?.setVisible(true);
    this.physics?.frame(physicsDelta);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.physics?.dispose(); this.physics = null;
    this.jelly?.dispose(); this.jelly = null;
    this.jellyWarm?.dispose(); this.jellyWarm = null;
    this.clipSwitch.dispose();
    this.animation.dispose();
    this.mesh.removeFromParent();
    disposeModel(this.mesh);
  }

  /** Her gait starts from the pose the motion has on her first frame: feet where they are, facing the viewer. */
  private beginGait(): void {
    const start = this.start, facing = this.pending.facing;
    const heading = facing ? Math.atan2(facing.x - start.xM, facing.z + start.depthM) : 0;
    this.placeMesh(start.xM, -start.depthM, heading);
    let feet: [{ x: number; z: number; yaw: number }, { x: number; z: number; yaw: number }] | undefined;
    if (this.rig) {
      this.gaitBody = this.rig.gaitBody(UNITS_PER_M, this.floorUnits);
      const world = (bone: Bone) => bone.getWorldPosition(new Vector3()).divideScalar(UNITS_PER_M);
      feet = this.rig.legs.map(leg => { const p = world(leg.ik); return { x: p.x, z: p.z, yaw: heading }; }) as typeof feet;
    }
    const body: GaitBody = this.gaitBody ?? { home: [{ x: 0.07, z: 0 }, { x: -0.07, z: 0 }], ankleHeight: 0.1, legLength: 0.75, hipHeight: 0.85, foot: { heel: 0.04, toe: 0.12, halfWidth: 0.035 }, toe: { forward: 0.12, drop: 0.1 } };
    const gait = this.gait = new Gait(body, { x: start.xM, z: -start.depthM, heading }, feet);
    gait.setKnobs(this.pending.knobs);
    gait.setFacingPoint(facing);
    gait.setStance(this.pending.stance);
    gait.setGoal(this.pending.goal.xM, -this.pending.goal.depthM);
  }

  private placeMesh(x: number, z: number, heading: number): void {
    this.mesh.position.set(x * UNITS_PER_M, this.floorUnits, z * UNITS_PER_M);
    this.mesh.rotation.set(0, heading, 0);
    this.mesh.updateMatrixWorld(true);
  }
  private remember(bone: Bone): void {
    if (!this.saved.has(bone)) this.saved.set(bone, { quaternion: bone.quaternion.clone(), position: bone.position.clone() });
  }
  private rotate(bone: Bone | null, x: number, y: number, z: number): void {
    if (!bone) return;
    this.remember(bone);
    bone.quaternion.multiply(this.turn.setFromEuler(this.euler.set(x, y, z)));
  }
  /** Post-multiplied: in the bone's own frame; pre-multiplied: in its parent's frame. */
  private rotateBy(bone: Bone | null, rotation: Quaternion, pre: boolean): void {
    if (!bone) return;
    this.remember(bone);
    if (pre) bone.quaternion.premultiply(rotation); else bone.quaternion.multiply(rotation);
  }
  /** E1: one sub-step of the look: the coordinator's goals (from what the springs show now), then the springs and eye movements. */
  private stepGaze(h: number, travel: Look): void {
    const head = this.gazeHead.value, headNow = { yaw: head.y + this.gazeChest.value.y, pitch: head.x };
    const out = this.gaze.step(h, { target: this.gazeTarget, fallback: travel, headNow });
    this.gazeHead.target(out.head.pitch, out.head.yaw, 0);
    this.gazeChest.target(0, out.chestYaw, 0);
    this.eyeYaw.look(out.eyes.yaw); this.eyePitch.look(out.eyes.pitch);
    this.gazeHead.advance(h); this.gazeChest.advance(h); this.eyeYaw.advance(h); this.eyePitch.advance(h);
  }
  /** E1: the look as residuals: the upper body's share, the head turn split over neck and head, the eyes in the head. */
  private applyGaze(): void {
    if (!this.gazeChest.idle) this.rotateBy(this.chest, this.gazeChest.quaternion(this.turn), false);
    if (!this.gazeHead.idle) {
      const turn = this.gazeHead.value, part = this.gazeVector;
      if (this.neck) this.rotateBy(this.neck, expMap(part.copy(turn).multiplyScalar(GAZE_NECK_SHARE), this.turn), false);
      this.rotateBy(this.head, expMap(part.copy(turn).multiplyScalar(this.neck ? 1 - GAZE_NECK_SHARE : 1), this.turn), false);
    }
    if (this.eyeYaw.value !== 0 || this.eyePitch.value !== 0) {
      const gain = this.eyeTurnGain; // the look in degrees; the eye bones by how far this model's eyes travel for it
      const rotation = this.turn.setFromAxisAngle(AXIS_Y, this.eyeYaw.value * gain).multiply(this.eyeQuaternion.setFromAxisAngle(AXIS_X, this.eyePitch.value * gain));
      for (const eye of this.eyes) this.rotateBy(eye, rotation, false);
    }
  }
  private readonly gazeVector = new Vector3();
  private readonly eyeQuaternion = new Quaternion();
  /** E1, for tests and the developer view: whether the last look target was let go (too far round: she looks where she is going). */
  get gazeReleased(): boolean { return this.gaze.isReleased; }
  /** I-169, developer mode's gaze readout (read only): the head's turn (neck, head, upper body) and the eyes' turn as shown now, rad; yaw + = toward the screen's right, pitch + = up. */
  get gazeShown(): { head: { yaw: number; pitch: number }; eyes: { yaw: number; pitch: number } } {
    const head = this.gazeHead.value, chest = this.gazeChest.value;
    return { head: { yaw: head.y + chest.y, pitch: -head.x }, eyes: { yaw: this.eyeYaw.value, pitch: -this.eyePitch.value } };
  }

  /** Her eyes, head and lean pivot after IK (world meters), and the same in her own frame. */
  private measureSense(gait: Gait): BodySense {
    const root = gait.rootState, at = (bone: Bone | null, offset?: Vector3): V3 | null => {
      if (!bone) return null;
      // An eye: its visible centre, carried by the head (the eye bone's parent), so her own saccades do not move the point she aligns.
      const p = (offset && bone.parent ? bone.parent.localToWorld(this.senseVector.copy(bone.position).add(offset)) : bone.getWorldPosition(this.senseVector)).divideScalar(UNITS_PER_M);
      return { x: p.x, y: p.y, z: p.z };
    };
    // The eyes as you see them (each eye's visible centre on its surface, moving with the eye bone), not the bones' pivots.
    const left = at(this.eyes[0] ?? null, this.eyeAnchors[0]?.offset), right = at(this.eyes[1] ?? null, this.eyeAnchors[1]?.offset), head = at(this.head), pivot = at(this.pivot);
    const local = (p: V3) => toHerFrame({ x: p.x - root.x, y: p.y, z: p.z - root.z }, root.heading);
    const frame = left && right && pivot ? { eyes: { left: local(left), right: local(right) }, pivot: local(pivot) } : null;
    const p = this.intent.pelvis;
    return { root, moving: gait.moving, stepping: gait.stepping, eyes: { left, right }, head, frame, tiptoeRise: gait.tiptoeRise, eyeSizeM: this.eyeSizeM, face: this.face, offsets: { lateral: p.lateral, forward: p.forward, up: p.vertical + gait.tiptoeLift },
      // The margin over a two-foot support only: in a step the COM is meant to pass outside the one foot down (that is walking, not a wobble).
      hop: { phase: gait.hopPhase, id: gait.lastHopRequest, landed: gait.hopsDone }, comMargin: gait.footStates.every(f => f.phase === 'planted') ? gait.comMargin() : null };
  }
  private readonly senseVector = new Vector3();
  private restoreResiduals(): void {
    this.intent.restore();
    for (const [bone, value] of this.saved) { bone.quaternion.copy(value.quaternion); bone.position.copy(value.position); }
    this.saved.clear();
  }
}

const AXIS_X = new Vector3(1, 0, 0), AXIS_Y = new Vector3(0, 1, 0);

export interface EyeAnchor { offset: Vector3; sizeM: number | null }
/**
 * U2: the visible eye of each eye bone, at rest. MMD eye bones sit at the eyeball's pivot, a few cm behind the eye and often off
 * to one side of the iris (Gene: about 5 cm behind, 1.3 cm inward): bringing the bone to the lens would put the camera inside her
 * head and the iris off the screen (the first preview did both). The vertices the eye bone moves (its own skin weight is the
 * largest) are the eye; the front half of them is what you see. Offset (model units, from the bone, in its rest frame): their
 * centre across and up, their 85th percentile forward (the surface). Size: how tall that front is (m, 5th–95th percentile).
 * A model whose eye bones move no vertices of their own: 1 cm in front of the bone, size unknown (the near plane still guards).
 */
export function measureEyeAnchors(mesh: SkinnedMesh, eyes: readonly Bone[]): EyeAnchor[] {
  const position = mesh.geometry.getAttribute('position'), skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight');
  const fallback = (): EyeAnchor => ({ offset: new Vector3(0, 0, 0.01 / MMD_UNIT_M), sizeM: null });
  if (!position || !skinIndex || !skinWeight) return eyes.map(fallback);
  const bones = mesh.skeleton.bones, at = (values: number[], q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];
  return eyes.map(eye => {
    const index = bones.indexOf(eye);
    if (index < 0) return fallback();
    const rest = new Vector3().setFromMatrixPosition(new Matrix4().copy(mesh.skeleton.boneInverses[index]).invert());
    const points: Vector3[] = [];
    for (let i = 0; i < position.count; i++) {
      let best = -1, weight = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(i, k); if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); } }
      if (best === index) points.push(new Vector3(position.getX(i) - rest.x, position.getY(i) - rest.y, position.getZ(i) - rest.z));
    }
    if (points.length < 12) return fallback();
    const zs = points.map(p => p.z).sort((a, b) => a - b), middle = at(zs, 0.5);
    const front = points.filter(p => p.z >= middle);
    const xs = front.map(p => p.x).sort((a, b) => a - b), ys = front.map(p => p.y).sort((a, b) => a - b);
    return { offset: new Vector3(xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length, at(zs, 0.85)), sizeM: (at(ys, 0.95) - at(ys, 0.05)) * MMD_UNIT_M };
  });
}
