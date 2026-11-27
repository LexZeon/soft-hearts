/**
 * I-154: what the window stage measures of a model the moment it is loaded, before her body ever moves (split out of window-stage.ts on
 * 2026-11-20, batch 3, behaviour unchanged): the companion's bind-pose bounds, the motion transform (a VRM's standard transform, or the
 * retarget of an MMD model that is not the reviewed Gene), the companion's model profile (her face's slots, the card's source), and the
 * painted blush, which remembers her rest pose now (window-blush.ts).
 * Batch 5 split (2026-11-20, behaviour unchanged): loading a model into her figure and window body (loadWindowModel) moved here from
 * window-stage.ts; the stage only attaches what comes back. The motion retarget is kept too: her chat gestures, actions and automatic
 * body motions ask its fit check (batch 5, window-motions.ts).
 */
import { Box3, type Bone, type Quaternion, type SkinnedMesh } from 'three';
import { loadFigureBody, dropFigureBody } from '../model/figure-body';
import { UnboundFigure, loadModel as loadFigureModel } from '../figure';
import { createBundledIdle, type BundledIdle } from '../motion/bundled-idle';
import { WindowBody } from './window-body';
import type { WindowStageHost } from './host-ports';
import { isReviewedDefaultPose, requestModelProfileCache, saveBuiltProfile, StageModelProfile, type ProfileSaveOutcome } from '../../stage';
import { motionFitStorage, StageMotionRetarget, type MotionFitView } from '../../actions';
import type { VmdDataTransform } from '../../foundation/vmd';
import { figureBone } from '../model/figure-bones';
import type { StandardBody } from '../model/standard-body';
import { WindowBlush } from './window-blush';
import { standardBlush } from '../her/vrm-blush';

// ui-zh-ok: MMD bone names inside the model file, not interface text
export const EYE_NAMES = [['左目', '左眼', 'LeftEye', 'left_eye'], ['右目', '右眼', 'RightEye', 'right_eye']] as const;
/** Her eye bones (the companion's names), left then right, the ones the model has. */
export const eyeBones = (mesh: SkinnedMesh): Bone[] =>
  EYE_NAMES.map(names => names.map(name => mesh.skeleton.bones.find(bone => bone.name === name)).find(Boolean)).filter((bone): bone is Bone => !!bone);

/** A neck bone apart from the head (the sleep pose gives the head the neck's share without one). */
// ui-zh-ok: MMD bone names inside the model file, not interface text
export const hasNeck = (mesh: SkinnedMesh, head: Bone | null): boolean => { const neck = figureBone(mesh, ['首', 'neck', 'Neck']); return !!neck && neck !== head; };

export interface WindowModelMeasure {
  bounds: { height: number; width: number; baseY: number; centerX: number };
  transform: VmdDataTransform | undefined;
  /** The retarget of an MMD model that is not the reviewed Gene (its fit check says which library motions suit it); null otherwise. */
  retarget: StageMotionRetarget | null;
  profile: StageModelProfile | null;
  painter: WindowBlush | null;
  /** Batch 7: each bone at rest (the personal pose preview builds on it, window-previews.ts), taken before her body ever moves. */
  rest: { bone: Bone; quaternion: Quaternion }[];
}

/** `standard`: a VRM's standard body (null for an MMD model). `reviewed`: the host said this is the reviewed Gene. */
/**
 * Batch 7: the fit check's stored scores and where its view goes (the control window's preview: the motion library's marks). `cached`: the host's
 * profile cache for this model (getModelProfile), `save` its saveMotionFits; absent (the companion window): the check runs without them.
 */
export interface WindowMotionFits { cached: { modelKey: string; motionFits?: unknown } | null; save(modelKey: string, record: unknown): Promise<boolean>; changed(view: MotionFitView): void }

/**
 * The host's cache read for this model (getModelProfile through requestModelProfileCache): its content key, the check-up it stored (null on
 * a model it has never seen) and the stored motion fits. 2026-11-27: read in both windows again, as the old stage did.
 */
export interface WindowProfileCache { modelKey: string; profile: unknown; motionFits?: unknown }

/**
 * `cache` (2026-11-27, docs/claude/2026-11-27-model-checkup-not-saved.md): the host's stored check-up is taken when it matches this mesh
 * (StageModelProfile accepts it, with haiku's checked matches riding along); the stored motion fits still reach only the control window's check.
 */
export function measureWindowModel(mesh: SkinnedMesh, standard: StandardBody | null, reviewed: boolean, fits: WindowMotionFits | null = null,
  cache: WindowProfileCache | null = null): WindowModelMeasure {
  mesh.updateMatrixWorld(true);
  const rest = mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone() }));
  const box = new Box3().setFromObject(mesh);
  const bounds = { height: Math.max(1, box.max.y - box.min.y), width: Math.max(1, box.max.x - box.min.x), baseY: box.min.y, centerX: (box.min.x + box.max.x) / 2 };
  let transform = standard?.transform;
  // Batch 2: one profile per MMD model (the companion's: her face's slots and calibration, the capability card's source, and the
  // motion retarget of a model that is not the reviewed Gene).
  let profile: StageModelProfile | null = null;
  if (!standard) { try { profile = new StageModelProfile(mesh, { reviewed, cached: cache?.profile }); } catch { profile = null; } }
  let retarget: StageMotionRetarget | null = null;
  if (!reviewed && !standard) {
    try { retarget = new StageMotionRetarget(mesh, profile?.profile ?? new StageModelProfile(mesh, { reviewed: false }).profile, { reviewed: false,
      // Hotfix 0.2.1: the stored scores reach the control window's fit check only, as in 0.2.0 (main also gives them to the companion).
      ...(fits ? { ...motionFitStorage(fits.cached ?? cache, { saveMotionFits: (key, record) => fits.save(key, record) }), onChange: fits.changed } : {}) });
      transform = retarget.transform; }
    catch { transform = undefined; retarget = null; /* motions as authored, as the stage does without a plan */ }
  }
  // The painted blush measures her cheeks on her rest pose: remembered now, before her body ever moves (window-blush.ts).
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const restHead = standard ? null : figureBone(mesh, ['頭', 'head', 'Head']);
  if (restHead) profile?.attachHead(restHead);
  // I-164: a VRM's blush and tears on its own face meshes (../her/vrm-blush.ts), measured now too, before her body ever moves.
  const painter = standard ? standardBlush(standard) : new WindowBlush(mesh, restHead, eyeBones(mesh), profile?.mouthLocal ?? null);
  return { bounds, transform, retarget, profile, painter, rest };
}

/**
 * Batch 5: "is this pose the reviewed bundled stand" (the companion's isReviewedDefaultPose: its bytes against the pinned hash), one check per
 * url, the last 8 kept. The reviewed stand is not "a picked pose" for her own motions.
 */
export function defaultPoseChecks(): (url: string) => Promise<boolean> {
  const checks = new Map<string, Promise<boolean>>();
  return url => {
    let check = checks.get(url);
    if (!check) { check = isReviewedDefaultPose(url).catch(() => false); checks.set(url, check); }
    if (checks.size > 8) checks.delete(checks.keys().next().value!);
    return check;
  };
}

/** A model loaded into her figure and window body, measured before it ever moved; the stage attaches it (window-stage.ts loadModel). */
export interface WindowLoadedModel extends WindowModelMeasure {
  mesh: SkinnedMesh;
  /** The textures still coming (the stage waits for them, at most 8 s, before she fades in). */
  textures: Promise<unknown>;
  standard: StandardBody | null;
  /** The host said this is the reviewed Gene (never for a VRM). */
  reviewed: boolean;
  /**
   * 2026-11-27: the check-up's save, scheduled off the load's path (src/stage/model-profile-save.ts): saved once for a model the host has no
   * check-up for, kept when it had one, logged when it fails (the next load tries again). Nobody needs to await it; tests may.
   */
  profileSaved: Promise<ProfileSaveOutcome>;
  figure: UnboundFigure;
  body: WindowBody;
}

/**
 * Loads `url` (an MMD model, or a VRM on the standard skeleton, I-152), asks the host whether it is the reviewed Gene, measures it at rest,
 * and makes her figure (at the origin: window mode never walks) and window body. `current()` false after an await: the load is dropped
 * and null comes back. Throws when the model cannot be loaded.
 */
export async function loadWindowModel(url: string, input: { host: WindowStageHost; current(): boolean; idle: Promise<BundledIdle | null>;
  /** Batch 7 (the control window's preview): the fit check's save and view (its stored scores come with the profile cache read below). */
  fits?: { save: WindowMotionFits['save']; changed: WindowMotionFits['changed'] } | null;
  /** Where a failed check-up save is written (default: the developer log, console.warn). */
  log?: (line: string) => void;
  /** When the check-up save runs (default: the next macrotask, after the load returned: never on the first frame's path). */
  defer?: (run: () => void) => void;
  random: () => number; breath: number;
  /** Tests: the MMD loader (default: the page's own, with textures). */
  loadMmd?: Parameters<typeof loadFigureBody>[1] }): Promise<WindowLoadedModel | null> {
  // I-152 step 2: a VRM, as it is, on the engine's standard skeleton (src/unbound/model/); an MMD model as before.
  const loaded = await loadFigureBody(url, input.loadMmd ?? loadFigureModel), { mesh, textures, standard } = loaded;
  if (!input.current()) { dropFigureBody(loaded); return null; }
  // The host's stored check-up for this model (both windows, as the old stage read it), in parallel with the Gene check. A VRM has none yet.
  const cache: Promise<WindowProfileCache | null> = standard ? Promise.resolve(null) : requestModelProfileCache(input.host, url);
  const reviewed = standard ? false : await input.host.isBehaviorModelSupported().then(value => value === true, () => false);
  const cached = await cache;
  if (!input.current()) { dropFigureBody(loaded); return null; }
  // Measured before her body ever moves: bounds, the motion transform, the profile, the painted blush.
  const measure = measureWindowModel(mesh, standard, reviewed, input.fits ? { cached, save: input.fits.save, changed: input.fits.changed } : null, cached);
  // 2026-11-27: the check-up the host lost with the old stage (575216516): saved once the model is measured, off the load's path.
  const profileSaved = new Promise<void>(resolve => (input.defer ?? (run => { setTimeout(run, 0); }))(resolve))
    .then(() => saveBuiltProfile({ saveModelProfile: (key, profile) => input.host.saveModelProfile?.(key, profile) ?? Promise.resolve(false) }, cached, measure.profile,
      { current: input.current, log: input.log ?? (line => console.warn(line)) }));
  const figure = new UnboundFigure(mesh, { xM: 0, depthM: 0 }); // window mode: her place is the origin, always
  figure.setBreath(input.breath);
  const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, await input.idle, 1 + Math.floor(input.random() * 1e6)), input.random, standard);
  return { ...measure, mesh, textures, standard, reviewed, figure, body, profileSaved };
}
