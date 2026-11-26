/**
 * I-136 step 5「拉她」on a stage (the companion's MmdStage now, Unbound's figure in 5c): which part of her is under the mouse (5a), where
 * the mouse is in her world while it pulls, and the body layer (pull-layer.ts, 5b). The stage holds one of these per window and
 * forwards to it (src/stage/mmd/pull.ts); state is per mesh (a new model rebinds and clears).
 *
 * Hit test: the same capsules as Unbound's silhouette (src/foundation/body-capsules.ts), tested with a ray from the camera (the companion
 * camera may orbit), within a few pixels of her edge. The part and side come from the bone's name and its ancestors' names
 * (shared/mood/touch-part.ts), so it adapts to uploaded models; nothing about a model is stored.
 */
import { Raycaster, Vector2, Vector3, type Bone, type Camera, type SkinnedMesh } from 'three';
import { capsuleEnds, measureBodyCapsules, rayCapsuleHit, type BoneCapsule } from '../../foundation/body-capsules';
import { headTopTouch, isEyeBoneName, partOfBoneName, touchOfBoneChain, type TouchPart } from '../../../shared/mood';
import { PULL_GROUP_OF, type PullGroup } from '../../../shared/behaviors/pull/session';
import { PULL_KNOBS, type PullKnobs } from '../../../shared/behaviors/pull/knobs';
import { PullLayer, buildPullRig, type PullLayerPort, type PullLayerState, type PullStance } from './pull-layer';
import { SoftTouch } from './soft-touch';

/** A press within this many pixels of her edge still lands on her (Unbound's click uses 4 as well). */
export const PULL_MARGIN_PX = 4;

export interface StagePullHit {
  part: TouchPart;
  side: 'left' | 'right' | null;
  group: PullGroup;
  /** Skeleton index of the bone that owns that piece of her. */
  bone: number;
  /** Her height on the window now (CSS px): the session's unit for how hard. */
  heightPx: number;
  /** Where the ray entered her (world). */
  point: Vector3;
}

export interface StageView { camera: Camera; width: number; height: number }

const ray = new Raycaster(), ndc = new Vector2(), p1 = new Vector3(), p2 = new Vector3(), up = new Vector3();

export class StagePull {
  private mesh: SkinnedMesh | null = null;
  private capsules: BoneCapsule[] = [];
  private ends: Vector3[] = [];
  private layer: PullLayer | null = null;
  private plane: { point: Vector3; normal: Vector3 } | null = null;
  /** 5d: the touched soft region (the jelly's 碰了才软). */
  readonly soft = new SoftTouch();

  /** `legs: false` for Unbound (her legs are the gait's). */
  constructor(private knobs: PullKnobs = PULL_KNOBS, private readonly options: { legs?: boolean } = {}) {}

  /** The mesh this frame (a new one rebinds: capsules and rig measured once, anything held is dropped at once). */
  bind(mesh: SkinnedMesh | null): void {
    if (mesh === this.mesh) return;
    this.mesh = mesh; this.capsules = []; this.ends = []; this.plane = null; this.soft.reset();
    this.layer = null;
    if (!mesh) return;
    try { this.capsules = measureBodyCapsules(mesh); } catch { this.capsules = []; } // I-164: a VRM's from its own meshes (src/unbound/model/standard-capsules.ts)
    const rig = buildPullRig(mesh, this.options);
    this.layer = rig ? new PullLayer(rig, this.knobs) : null;
  }

  configure(knobs: PullKnobs): void { this.knobs = knobs; this.layer?.configure(knobs); }
  setStance(stance: PullStance | null): void { this.layer?.setStance(stance); }

  /** The piece of her under the window point (CSS px), or null. `herHeight`: her height in model units. */
  hit(view: StageView, x: number, y: number, herHeight: number): StagePullHit | null {
    const mesh = this.mesh;
    if (!mesh || !this.capsules.length || !(view.width > 0) || !(view.height > 0) || !Number.isFinite(x + y)) return null;
    mesh.updateMatrixWorld(true);
    capsuleEnds(mesh, this.capsules, this.ends);
    this.cast(view, x, y);
    const centre = p1.setFromMatrixPosition(mesh.matrixWorld);
    const heightPx = this.pixels(view, centre, herHeight);
    if (!(heightPx > 0)) return null;
    const found = rayCapsuleHit(ray.ray.origin, ray.ray.direction, this.capsules, this.ends, PULL_MARGIN_PX * herHeight / heightPx);
    if (!found) return null;
    const names: string[] = [], chain: Bone[] = [];
    for (let bone = mesh.skeleton.bones[found.bone] as Bone | null; bone && bone.isBone; bone = bone.parent as Bone | null) { names.push(bone.name); chain.push(bone); }
    // Hair or face on the top and sides of the head is the head (shared/mood/touch-part.ts headTopTouch); a twin-tail and a cheek stay.
    const { part, side } = headTopTouch(touchOfBoneChain(names), names, this.aboveEyes(mesh, chain.find(bone => partOfBoneName(bone.name) === 'head'), found.point));
    return { part, side, group: PULL_GROUP_OF[part], bone: found.bone, heightPx: this.pixels(view, found.point, herHeight), point: found.point.clone() };
  }

  /** How far above her eye line the hit is, in eye spacings, measured in the head's own frame (so a turned or tilted head reads the same); null without a head or two eyes. */
  private aboveEyes(mesh: SkinnedMesh, head: Bone | undefined, point: Vector3): number | null {
    if (!head) return null;
    const eyes = mesh.skeleton.bones.filter(bone => isEyeBoneName(bone.name));
    if (eyes.length < 2) return null;
    head.updateWorldMatrix(true, false);
    const [a, b] = eyes.slice(0, 2).map(eye => head.worldToLocal(eye.getWorldPosition(new Vector3())));
    const spacing = a.distanceTo(b);
    return spacing > 1e-6 ? (head.worldToLocal(point.clone()).y - (a.y + b.y) / 2) / spacing : null;
  }

  /** The pull begins at the hit (the layer goes on from what it shows). */
  start(hit: StagePullHit, view: StageView): boolean {
    const mesh = this.mesh, layer = this.layer;
    if (!mesh || !layer) return false;
    const bone = mesh.skeleton.bones[hit.bone];
    if (!bone) return false;
    bone.updateWorldMatrix(true, false);
    const local = bone.worldToLocal(hit.point.clone());
    layer.grab({ group: hit.group, side: hit.side, bone, local });
    view.camera.updateWorldMatrix(true, false);
    this.plane = { point: hit.point.clone(), normal: view.camera.getWorldDirection(new Vector3()) };
    return true;
  }

  /** The mouse moved while pulling: the point on the plane through the grabbed point, facing the camera. */
  to(view: StageView, x: number, y: number): void {
    const layer = this.layer, plane = this.plane;
    if (!layer?.grabbed || !plane || !Number.isFinite(x + y)) return;
    layer.point(plane.point);
    this.cast(view, x, y);
    const denominator = ray.ray.direction.dot(plane.normal);
    if (Math.abs(denominator) < 1e-6) return;
    const t = p2.copy(plane.point).sub(ray.ray.origin).dot(plane.normal) / denominator;
    if (!(t > 0)) return;
    layer.aim(p2.copy(ray.ray.direction).multiplyScalar(t).add(ray.ray.origin));
  }

  /** Released, cancelled or slipped free: she eases back. */
  end(): void { this.layer?.release(); this.plane = null; }
  /** Hidden or a hard cut: nothing left to show. */
  reset(): void { this.layer?.reset(); this.plane = null; this.soft.reset(); }

  get grabbed(): boolean { return this.layer?.grabbed === true; }
  get engaged(): boolean { return this.layer?.engaged === true; }
  /** The grabbed point now (world), or null. */
  point(out: Vector3): Vector3 | null { return this.layer?.point(out) ?? null; }
  getState(): PullLayerState | null { return this.layer?.getState() ?? null; }
  /** The pull as the body shows it (world), zero when settled. */
  shownPull(out: Vector3): Vector3 { return this.layer ? this.layer.shownPull(out) : out.set(0, 0, 0); }

  apply(port: PullLayerPort, dt: number, herHeight: number): void { this.layer?.apply(port, dt, herHeight); }

  private cast(view: StageView, x: number, y: number): void {
    ndc.set(x / view.width * 2 - 1, -(y / view.height * 2 - 1));
    view.camera.updateWorldMatrix(true, false);
    ray.setFromCamera(ndc, view.camera);
  }

  /** How many window pixels `length` (model units) spans upright at `at`. */
  private pixels(view: StageView, at: Vector3, length: number): number {
    up.setFromMatrixColumn(view.camera.matrixWorld, 1).normalize();
    const a = p2.copy(at).project(view.camera), ay = a.y, ax = a.x;
    const b = up.multiplyScalar(length).add(at).project(view.camera);
    return Math.hypot((b.x - ax) * view.width / 2, (b.y - ay) * view.height / 2);
  }
}
