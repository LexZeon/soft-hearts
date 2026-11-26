/**
 * I-154 batch 3, row 35 睡姿、睡着的身体、梦话: her sleep in the companion window on Unbound's engine, the companion's two layers:
 *  - the sleep pose (I-024, src/stage/sleep-pose.ts SleepPose): standing or seated doze, the chin down over neck and head, a slight roll
 *    to her side, lighter breath, one wake blink. Here it becomes goals: the neck and head goals (the figure's springs carry them), her
 *    breath depth, and the wake blink as a soft closure;
 *  - the sleep body (I-078, src/stage/sleep-body.ts SleepBody): small drowsy actions, kneeling and lying down on a pillow or leaning on a
 *    desk (whichever fits the window's camera), rare small movements and a rare silent "zzz…" (梦话) while asleep, getting up again. It
 *    plans whole-body poses, so it runs as the figure's overlay: after her feet are solved and before physics (window-body.ts overlay),
 *    every bone through the figure's remember (put back before her next frame). Its own motion rules keep it smooth: one progress
 *    coordinate moved by minimum-jerk segments from the current position, speed and acceleration, and a yield weight that eases out and in.
 * The card's 睡相 (setSleepHabit) sizes her sleeping movements, as on the old stage.
 *
 * What is different, on purpose: the old stage snaps her upright when the mood scope is lost or the character changes; here she eases
 * (no phase: the pose's depth and the body's progress go back by their own springs and curves). A new model starts upright (a new owner).
 * The window engine lifts her by Unbound's floor; the sleep body plans in the model's own space, so it sees the camera lowered by the
 * same lift and its props hang in a group raised by it.
 * Her drowsy yawn and waking stretch are pose reactions (row 34): since batch 5 they go to the window's pose reactions (poseCueView,
 * window-reactions.ts), as on the old stage.
 */
import { Group, Matrix4, PerspectiveCamera, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { hashSeed, SleepPose, type LivelinessLib, type SleepBody, type SleepMurmur, type StageModelProfile } from '../../stage';
import type { MoodView } from '../../../shared/mood';
import type { Rot } from '../motion/generator';

export interface WindowSleepModel {
  mesh: SkinnedMesh;
  /**
   * The companion's model profile (its standard bones and collision capsules); I-164 (docs/claude/2026-11-20-vrm-gaps.md): a VRM gives its
   * standard skeleton's bones (src/unbound/model/standard-face.ts standardSleepBones, capsules estimated from the joints); null: the head-only doze.
   */
  profile: Pick<StageModelProfile, 'bone'> & { profile?: { collision?: unknown } | null } | null;
  /** The rest bounds' bottom (model units), the floor the sleep body plans on. */
  baseY: number;
  /** The model has a neck bone apart from the head (without one, the head takes the neck's share). */
  hasNeck: boolean;
}

export interface WindowSleepInput {
  view: MoodView | null;
  /** The card's 能做睡姿 (the same switch for the doze and the body). */
  capable: boolean;
  /** A picked head motion or a pull holds her head: the doze yields (by its own weight). */
  headOwned: boolean;
  /** A higher owner holds her body (a pull, a held hand): the sleep body yields. */
  yielding: boolean;
  /** Someone is busy with her (a touch, speech, a reply, a camera adjust): no drowsy action starts. */
  busy: boolean;
  /** A hand on her head or cheek now (a pat or a pinch). */
  touched: boolean;
  /** The window's camera (lifted by `lift`), the window's size, the scene. */
  camera: PerspectiveCamera; lift: number; width: number; height: number; scene: Object3D;
  /** Batch 7: 试一下 能做睡姿 holds the doze's phase at asleep now (window-capability.ts); absent: no. */
  preview?: boolean;
  /**
   * Full-screen batch G (docs/claude/2026-11-21-unbound-full-BG.md): her model's place in the world (the figure's mesh: where she stands,
   * which way she faces). The sleep body plans in the model's own space: the camera is seen from there and the props hang in it, so her
   * desk or pillow stands at world scale where she is and the pose choice is made from the world camera. Absent: the window's lift only.
   */
  space?: Object3D;
}

export interface WindowSleepFrame {
  /** Added to her neck and head goals (rad). */
  neck: Rot; head: Rot;
  /** The wake blink (a soft closure, 0..1). */
  softLids: number;
  /** Her breath depth factor (1 = as usual). */
  breath: number;
  /** The sleep body is (partly) shown: her learned idle steps aside. */
  performing: boolean;
  /** Something of her sleep is easing now (the pace draws at full rate). */
  moving: boolean;
  /** The figure's overlay for this frame (the sleep body), or null. */
  overlay: ((remember: (bone: Bone) => void, delta: number) => void) | null;
}

const ZERO: Rot = Object.freeze({ pitch: 0, yaw: 0, roll: 0 }) as Rot;

export class WindowSleep {
  private lib: Pick<LivelinessLib, 'SleepBody' | 'sleepBodyInput'> | null = null;
  private readonly pose = new SleepPose();
  private body: SleepBody | null = null;
  private model: WindowSleepModel | null = null;
  private rigCache: { mesh: SkinnedMesh; rig: unknown } | undefined;
  private habit: number | undefined;
  private readonly local = new PerspectiveCamera();
  private readonly props = new Group();
  private murmurs: SleepMurmur[] = [];
  private readonly inverse = new Matrix4();

  /** The sleep body's code (src/stage/sleep-body.ts), loaded on demand; until then the doze only. */
  constructor(lib: Pick<LivelinessLib, 'SleepBody' | 'sleepBodyInput'> | null = null, private readonly random: () => number = Math.random) { if (lib) this.load(lib); }
  load(lib: Pick<LivelinessLib, 'SleepBody' | 'sleepBodyInput'>): void { if (!this.lib) { this.lib = lib; this.body = new lib.SleepBody(this.random); } }

  /** I-078 第 3 步: the active card's 睡相 (0 calm … 100 restless; anything else = the middle). */
  setHabit(value: unknown): void { this.habit = typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
  get sleepHabit(): number | undefined { return this.habit; }

  /** A model was loaded (or none): the layers start upright for it; the old model's props go. */
  attach(model: WindowSleepModel | null): void {
    this.model = model; this.rigCache = undefined;
    this.pose.reset(); this.body?.reset(); this.murmurs = [];
    this.props.removeFromParent();
  }
  /** The sleep body's state (the developer view, tests). */
  getState() { return this.body?.getState() ?? null; }
  /** 梦话: the silent "zzz…" bubbles since the last call (the wiring shows them, bubble only). */
  takeMurmurs(): SleepMurmur[] { const out = this.murmurs; this.murmurs = []; return out; }
  /**
   * Batch 5 (row 34): her drowsy yawn or waking stretch, offered to the pose reactions as one cue over the host's view (held a second so
   * the reaction takes it on its first free frame, once per id; window-reactions.ts); null when she has none.
   */
  poseCueView(base: unknown, nowMs: number): unknown | null { return this.body?.poseCueView(base, nowMs) ?? null; }
  /** Batch 7 (row 45 色块哨兵): the world corners of the props shown now (a pillow is not a stray block). */
  propCorners(): readonly { x: number; y: number; z: number }[] { return this.body?.propCorners() ?? []; }

  frame(dt: number, input: WindowSleepInput): WindowSleepFrame {
    const model = this.model, view = input.view;
    if (!model) return { neck: ZERO, head: ZERO, softLids: 0, breath: 1, performing: false, moving: false, overlay: null };
    // The doze (I-024): the companion's owner gates; its depth and weight are critically damped.
    const posture = view?.expressions === true && (view.snapshot?.intensity?.posture ?? 0) > 0;
    // Batch 7 (row 42 试一下 能做睡姿): the preview holds the phase at asleep (rate 2), then the real phase takes over (the old stage's frameSleepPose).
    const preview = input.preview === true;
    const pose = this.pose.frame(dt, { owner: model.mesh, phase: preview ? 'asleep' : view?.fatigue?.phase ?? null, allowed: input.capable && !input.headOwned && (preview || posture),
      rate: preview ? 2 : 1, side: hashSeed(view?.characterId ?? '') & 1 ? -1 : 1 });
    const neck = model.hasNeck ? pose.neckX : 0, neckZ = model.hasNeck ? pose.neckZ : 0;
    const out: WindowSleepFrame = {
      // The companion's local Euler (x lowers the chin, z rolls to her side) → the figure's goals (roll's sign as window-face.ts maps it).
      neck: pose.active ? { pitch: neck, yaw: 0, roll: -neckZ } : ZERO,
      head: pose.active ? { pitch: pose.headX + (model.hasNeck ? 0 : pose.neckX), yaw: 0, roll: -(pose.headZ + (model.hasNeck ? 0 : pose.neckZ)) } : ZERO,
      softLids: pose.blink, breath: pose.breathScale, performing: false, moving: pose.active && pose.amount > 0 && pose.amount < 1, overlay: null,
    };
    // The sleep body (I-078), as the figure's overlay. It runs every frame once there is fatigue (or while it still shows), so it eases back.
    const body = this.body, lib = this.lib;
    if (!body || !lib || (!view?.fatigue && !body.engaged && !body.moving)) return out;
    this.syncSpace(input);
    const args = lib.sleepBodyInput({ mesh: model.mesh, rigCache: this.rigCache as never, profile: model.profile as never, baseY: model.baseY, view,
      sleepPose: input.capable, camera: this.local, width: input.width, height: input.height, scene: this.props,
      yielding: input.yielding, busy: input.busy, touched: input.touched, sleepHabit: this.habit });
    this.rigCache = args.rigCache;
    out.performing = body.engaged; out.moving = out.moving || body.moving;
    out.overlay = (remember, delta) => {
      body.frame(delta, args, { remember });
      for (let murmur = body.takeMurmur(); murmur; murmur = body.takeMurmur()) this.murmurs.push(murmur);
    };
    return out;
  }

  /** The sleep body plans in the model's own space: the camera lowered by Unbound's lift, the props raised by it. */
  private syncSpace(input: WindowSleepInput): void {
    if (input.space) { this.syncWorld(input, input.space); return; }
    this.local.copy(input.camera);
    this.local.position.y -= input.lift;
    this.local.updateMatrixWorld(true);
    if (this.props.parent !== input.scene) input.scene.add(this.props);
    if (this.props.position.y !== input.lift) { this.props.position.y = input.lift; this.props.updateMatrixWorld(true); }
  }

  /** Out in the world: the camera as seen from her model's own space, the props carried by her model's place (position and facing). */
  private syncWorld(input: WindowSleepInput, space: Object3D): void {
    space.updateMatrixWorld();
    this.local.copy(input.camera);
    this.inverse.copy(space.matrixWorld).invert().multiply(input.camera.matrixWorld).decompose(this.local.position, this.local.quaternion, this.local.scale);
    this.local.updateMatrixWorld(true);
    if (this.props.parent !== input.scene) input.scene.add(this.props);
    space.matrixWorld.decompose(this.props.position, this.props.quaternion, this.props.scale);
    this.props.updateMatrixWorld(true);
  }

  dispose(): void { this.body?.reset(); this.props.removeFromParent(); this.model = null; }
}
