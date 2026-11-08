import { Bone, Matrix4, Vector3, type SkinnedMesh } from 'three';
import type { BlushAnchors } from './procedural-blush';
import {
  acceptCachedProfile, buildModelProfile, calibratedWeight, profileBindings, summarizeModelProfile,
  type ModelProfile, type ModelProfileCacheView, type ModelProfileInput, type ModelProfileSummary, type ProfileBone, type StandardBone, type Vec3,
} from '../../shared/model-profile';
import type { HaikuMatches } from '../../shared/model-capability';
import { mergeHaikuMatches, modelCheckNames, verifyHaikuCandidates, type HaikuCandidates, type ModelCheckNames } from '../../shared/model-capability-check';

/**
 * Stage side of the model profile (shared/model-profile.ts): reads the loaded
 * mesh's rest data once, builds or accepts a cached profile, and turns it into
 * the few values the stage consumes. Imports only Three core, never the MMD
 * loader, so it runs in tests without `three/examples`.
 *
 * The host-verified bundled Gene (`reviewed`) keeps its reviewed amounts and
 * regions: every write scale is 1 and no measured fallback replaces a reviewed
 * value. Other models get calibrated morph writes, measured eye/mouth points
 * for the crown-pat and feeding regions, and cheek-pinch anchors when the blush
 * probe cannot place its own.
 */

const tuple = (value: Vector3): Vec3 => [value.x, value.y, value.z];

/** Rest data in model space. Morph offsets are read lazily, only for alias candidates. */
export function modelProfileInput(mesh: SkinnedMesh): ModelProfileInput {
  const geometry = mesh.geometry;
  const position = geometry?.getAttribute('position');
  const count = position && position.itemSize === 3 ? position.count : 0;
  const positions = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex++) {
    positions[vertex * 3] = position.getX(vertex); positions[vertex * 3 + 1] = position.getY(vertex); positions[vertex * 3 + 2] = position.getZ(vertex);
  }
  const skinIndex = geometry?.getAttribute('skinIndex'), skinWeight = geometry?.getAttribute('skinWeight');
  let skinBone: Int32Array | undefined, skinWeights: ModelProfileInput['skinWeights'];
  if (skinIndex && skinWeight && skinIndex.count === count && skinWeight.count === count) {
    skinBone = new Int32Array(count);
    const width = Math.min(4, skinIndex.itemSize, skinWeight.itemSize);
    const read = (attribute: typeof skinIndex, vertex: number, k: number) =>
      k === 0 ? attribute.getX(vertex) : k === 1 ? attribute.getY(vertex) : k === 2 ? attribute.getZ(vertex) : attribute.getW(vertex);
    // Full weights (MMDLoader: BDEF1/2/4, SDEF as its two weights) feed the collision proxy.
    const indices = new Int32Array(count * width), weights = new Float32Array(count * width);
    for (let vertex = 0; vertex < count; vertex++) {
      let best = -1, weight = 0;
      for (let k = 0; k < width; k++) {
        const w = read(skinWeight, vertex, k), bone = read(skinIndex, vertex, k);
        indices[vertex * width + k] = bone; weights[vertex * width + k] = w;
        if (w > weight) { weight = w; best = bone; }
      }
      skinBone[vertex] = best;
    }
    skinWeights = { indices, weights, width };
  }
  const bones = mesh.skeleton?.bones ?? [];
  const order = new Map<object, number>(bones.map((bone, index) => [bone, index]));
  mesh.updateMatrixWorld(true);
  const toModel = new Matrix4().copy(mesh.matrixWorld).invert();
  const mmd = (geometry?.userData as { MMD?: { iks?: { target?: number }[]; rigidBodies?: { boneIndex?: number; type?: number }[];
    grants?: { index?: number; parentIndex?: number; ratio?: number }[] } } | undefined)?.MMD;
  const ikTargets = new Set<number>((mmd?.iks ?? []).map(ik => ik?.target).filter((target): target is number => Number.isInteger(target)));
  // Collision proxy hints: bones driven by dynamic rigid bodies (hair, skirts) and 付与 links (twist links, "D" bones).
  const physics = new Set<number>((Array.isArray(mmd?.rigidBodies) ? mmd.rigidBodies : []).filter(body => body?.type === 1 || body?.type === 2)
    .map(body => body.boneIndex).filter((bone): bone is number => Number.isInteger(bone)));
  const grants = new Map<number, { parent: number; ratio: number }>();
  for (const grant of Array.isArray(mmd?.grants) ? mmd.grants : [])
    if (Number.isInteger(grant?.index) && Number.isInteger(grant?.parentIndex) && Number.isFinite(grant?.ratio)) grants.set(grant.index!, { parent: grant.parentIndex!, ratio: grant.ratio! });
  const profileBones: ProfileBone[] = bones.map((bone, index) => ({
    name: bone.name, parent: bone.parent ? order.get(bone.parent) ?? -1 : -1,
    position: tuple(bone.getWorldPosition(new Vector3()).applyMatrix4(toModel)), ik: ikTargets.has(index),
    ...(physics.has(index) ? { physics: true } : {}), ...(grants.has(index) ? { grant: grants.get(index)! } : {}),
  }));
  const dictionary = mesh.morphTargetDictionary ?? {};
  const names: string[] = [];
  for (const [name, index] of Object.entries(dictionary)) if (Number.isInteger(index) && index >= 0 && index < 65_536 && names[index] === undefined) names[index] = name;
  const targets = geometry?.morphAttributes?.position ?? [];
  const relative = geometry?.morphTargetsRelative === true;
  const morphs = Array.from({ length: Math.max(names.length, mesh.morphTargetInfluences?.length ?? 0) }, (_, index) => ({
    // MMDLoader names each target attribute; the dictionary alone loses a duplicated name's earlier index.
    name: (typeof targets[index]?.name === 'string' && targets[index].name) || (names[index] ?? ''),
    offsets: () => {
      const target = targets[index];
      if (!target || target.itemSize !== 3 || target.count !== count) return null;
      const indices: number[] = [], deltas: number[] = [];
      for (let vertex = 0; vertex < count; vertex++) {
        const dx = target.getX(vertex) - (relative ? 0 : positions[vertex * 3]);
        const dy = target.getY(vertex) - (relative ? 0 : positions[vertex * 3 + 1]);
        const dz = target.getZ(vertex) - (relative ? 0 : positions[vertex * 3 + 2]);
        if (dx * dx + dy * dy + dz * dz > 1e-14) { indices.push(vertex); deltas.push(dx, dy, dz); }
      }
      return indices.length ? { indices, deltas } : null;
    },
  }));
  return { positions, skinBone, skinWeights, bones: profileBones, morphs };
}

/** The old name-only lookup, kept as the fallback when a profile cannot be built at all. */
export function legacyMorphIndices(dictionary: Record<string, number> | undefined): { blink: number; mouth: number; smile: number; sad: number } {
  const find = (aliases: string[]) => { for (const name of aliases) if (dictionary?.[name] !== undefined) return dictionary[name]; return -1; };
  return { blink: find(['まばたき', '瞬き', 'blink', 'Blink']), mouth: find(['あ', 'a', 'A', 'mouthOpen', 'MouthOpen']),
    smile: find(['笑い', 'にこり', '口角上げ', 'smile', 'Smile']), sad: find(['困る', '悲しい', 'sad', 'Sad']) };
}

/** Pinch-only cheek anchors from measured eyes and mouth (same head-local frame as probeBlushAnchors). */
function cheekAnchorsFrom(eyes: readonly Vector3[], mouth: Vector3 | null): BlushAnchors | null {
  if (eyes.length !== 2 || !mouth) return null;
  const [leftEye, rightEye] = [...eyes].sort((a, b) => a.x - b.x).map(point => point.clone());
  const spacing = leftEye.distanceTo(rightEye);
  if (!(spacing > 1e-5)) return null;
  const right = rightEye.clone().sub(leftEye).normalize(), midpoint = leftEye.clone().add(rightEye).multiplyScalar(0.5);
  const up = midpoint.clone().sub(mouth); up.addScaledVector(right, -up.dot(right));
  const drop = up.length();
  if (drop < spacing * 0.3 || drop > spacing * 3) return null;
  up.normalize();
  const forward = right.clone().cross(up).normalize();
  if (forward.dot(midpoint) < 0) forward.negate();
  const center = midpoint.clone().lerp(mouth, 0.56);
  const left = center.clone().addScaledVector(right, -spacing * 0.54), rightCheek = center.clone().addScaledVector(right, spacing * 0.54);
  return { leftEye: tuple(leftEye), rightEye: tuple(rightEye), mouth: tuple(mouth), leftCheek: tuple(left), rightCheek: tuple(rightCheek),
    leftNormal: tuple(forward), rightNormal: tuple(forward), forward: tuple(forward), up: tuple(up), right: tuple(right),
    eyeDistance: spacing, boneEyeDistance: spacing, eyeReference: 'model-profile', mouthEstimated: false, surfaceSource: 'local-face', materialIndices: [] };
}

/**
 * I-024: told about every profile a stage in this window builds (one stage per window), so the model check
 * (src/ui/model-capability-sync.ts) can read this mesh's own names and check haiku's candidates on it.
 */
const builtListeners = new Set<(profile: StageModelProfile) => void>();
/** I-024: haiku's checked matches the host sent along with a cached profile (requestModelProfileCache), keyed by that object. */
const hostHaiku = new WeakMap<object, HaikuMatches>();
export function onStageModelProfile(listener: (profile: StageModelProfile) => void): () => void {
  builtListeners.add(listener);
  return () => { builtListeners.delete(listener); };
}

/**
 * Built once on model load while the skeleton is still at rest. Never throws:
 * any failure falls back to the old name lookup with no calibration.
 */
export class StageModelProfile {
  readonly profile: ModelProfile | null = null;
  readonly source: ModelProfileSummary['source'] = 'unavailable';
  readonly reviewed: boolean;
  /** Fresh computation that the host may cache. */
  readonly fresh: boolean;
  readonly indices: { readonly blink: number; readonly mouth: number; readonly smile: number; readonly sad: number };
  /** morph index -> calibrated scale (empty for the reviewed Gene). */
  readonly scales: ReadonlyMap<number, number>;
  /** morph index -> every morph written with it (a per-eye blink pair). */
  readonly links: ReadonlyMap<number, readonly number[]>;
  /** Extra morphs owned by a dedicated compositor (excluded from the continuity guard). */
  readonly linkedMorphs: readonly number[];
  readonly summary: ModelProfileSummary;
  /** Head-local measured eye centers for the crown-pat probe when the model has no eye bone pair (see attachHead). */
  contactEyes: readonly Vector3[] = [];
  /** Head-local measured mouth for feeding and blush placement (null for the reviewed Gene or when only estimated). */
  mouthLocal: Vector3 | null = null;
  /** Head-local cheek anchors for the pinch region when the blush probe fails (null for the reviewed Gene). */
  cheekAnchors: BlushAnchors | null = null;
  /** I-024: this mesh's counts and part names (to match a host record to it), and its rest data until the model check is done. */
  private readonly checkIdentity: { vertices: number; bones: readonly string[]; morphs: readonly string[] } | null = null;
  private checkInput: ModelProfileInput | null = null;
  /** I-024: the profile as the names found it (the card's "名字认出" and the check read this); `profile` adds haiku's matches. */
  readonly namedProfile: ModelProfile | null = null;
  /** I-024: haiku's checked matches the host sent with the cached profile, filled into `profile` (never for the reviewed Gene). */
  readonly fromHaiku: HaikuMatches = {};

  constructor(private readonly mesh: SkinnedMesh, options: { reviewed: boolean; cached?: unknown }) {
    this.reviewed = options.reviewed === true;
    try {
      const input = modelProfileInput(mesh);
      const identity = { vertices: input.positions.length / 3, bones: input.bones.map(bone => bone.name), morphs: input.morphs.map(morph => morph.name) };
      const cached = options.cached === undefined || options.cached === null ? null : acceptCachedProfile(options.cached, identity);
      this.source = cached ? 'cache' : 'computed';
      this.namedProfile = cached ?? buildModelProfile(input);
      const haiku = cached && !this.reviewed && typeof options.cached === 'object' ? hostHaiku.get(options.cached as object) : undefined;
      const merged = haiku ? mergeHaikuMatches(this.namedProfile, haiku, identity) : null;
      this.profile = merged?.profile ?? this.namedProfile;
      this.fromHaiku = merged?.merged ?? {};
      this.checkIdentity = identity;
      // Rest data for the I-024 check; it needs no full skin weights.
      this.checkInput = { positions: input.positions, skinBone: input.skinBone, bones: input.bones, morphs: input.morphs };
    } catch { this.profile = this.namedProfile = null; this.fromHaiku = {}; this.source = 'unavailable'; this.checkIdentity = null; this.checkInput = null; }
    this.fresh = this.source === 'computed';
    const bindings = this.profile ? profileBindings(this.profile, this.reviewed) : null;
    this.indices = bindings ? { blink: bindings.blink, mouth: bindings.mouth, smile: bindings.smile, sad: bindings.sad } : legacyMorphIndices(mesh.morphTargetDictionary);
    this.scales = new Map(bindings?.scales ?? []);
    this.links = bindings && bindings.blinkPartner >= 0 ? new Map([[bindings.blink, [bindings.blink, bindings.blinkPartner]]]) : new Map();
    this.linkedMorphs = bindings && bindings.blinkPartner >= 0 ? [bindings.blinkPartner] : [];
    this.summary = summarizeModelProfile(this.profile, this.source, this.reviewed);
    for (const listener of builtListeners) try { listener(this); } catch { /* The check never changes how a model loads. */ }
  }

  /** This mesh's counts and names, in the shape acceptCachedProfile compares (null without a profile). */
  identity(): { vertices: number; bones: readonly string[]; morphs: readonly string[] } | null { return this.checkIdentity; }
  /** I-024: the names haiku may read (this model's own morph and bone names, nothing else); null once released. */
  checkNames(): ModelCheckNames | null { return this.checkInput ? modelCheckNames(this.checkInput) : null; }
  /** haiku's names checked on this mesh's rest data with the profile's own vertex rules; only what passed. */
  verifyHaikuCandidates(candidates: HaikuCandidates): HaikuMatches {
    return this.checkInput && this.namedProfile ? verifyHaikuCandidates(this.checkInput, this.namedProfile, candidates) : {};
  }
  /** Drops the rest-data copy once this model's check is done (or not needed). */
  releaseCheckInput(): void { this.checkInput = null; }

  /** The profile's mapping of a standard bone (aliases beyond the stage's exact names). */
  bone(slot: StandardBone): Bone | undefined {
    const entry = this.profile?.bones.map[slot];
    const bone = entry ? this.mesh.skeleton?.bones[entry.index] : undefined;
    return bone && bone.name === entry?.name ? bone : undefined;
  }

  /** Converts measured face points into the stage's head bone space (rest pose); skipped for the reviewed Gene. */
  attachHead(head: Bone | undefined): void {
    this.contactEyes = []; this.mouthLocal = null; this.cheekAnchors = null;
    const proportions = this.profile?.proportions;
    if (!head || this.reviewed || !proportions) return;
    try {
      this.mesh.updateMatrixWorld(true); head.updateWorldMatrix(true, false);
      const local = (point: Vec3) => head.worldToLocal(this.mesh.localToWorld(new Vector3(...point)));
      const eyes = proportions.eyes ? [local(proportions.eyes.left), local(proportions.eyes.right)] : [];
      const mouth = proportions.mouth.source !== 'estimate' ? local(proportions.mouth.point) : null;
      if (![...eyes, ...(mouth ? [mouth] : [])].every(point => [point.x, point.y, point.z].every(Number.isFinite))) return;
      this.contactEyes = eyes; this.mouthLocal = mouth; this.cheekAnchors = cheekAnchorsFrom(eyes, mouth);
    } catch { this.contactEyes = []; this.mouthLocal = null; this.cheekAnchors = null; }
  }
}

/**
 * The stage's one procedural morph write: calibrated by the profile, clamped to
 * [0, 1], max-combined with what the mixer already wrote, and remembered once
 * per frame so restoreLayers() can undo it. Linked morphs (a per-eye blink pair)
 * receive the same value.
 */
export function writeProfiledMorph(
  influences: number[] | undefined, layers: { index: number; value: number }[],
  profile: Pick<StageModelProfile, 'scales' | 'links'> | null | undefined, index: number, weight: number,
): void {
  if (index < 0 || !influences) return;
  const value = calibratedWeight(profile?.scales, index, weight);
  for (const target of profile?.links.get(index) ?? [index]) {
    if (!layers.some(layer => layer.index === target)) layers.push({ index: target, value: influences[target] ?? 0 });
    influences[target] = Math.max(influences[target] ?? 0, value);
  }
}

/**
 * Starts the host cache read in parallel with model admission; resolves null on any mismatch or error. I-024: haiku's checked
 * matches that come with the cached profile ride along with that same object into StageModelProfile, which fills them into the
 * slots the names left empty (they were checked on this exact model content when they were stored).
 */
export function requestModelProfileCache(desktop: { getModelProfile?: () => Promise<ModelProfileCacheView> } | undefined,
  url: string): Promise<{ modelKey: string; profile: unknown; motionFits?: unknown } | null> {
  try {
    const pending = desktop?.getModelProfile?.();
    if (!pending || typeof pending.then !== 'function') return Promise.resolve(null);
    return pending.then(view => {
      if (!view || typeof view.modelKey !== 'string' || view.modelUrl !== url) return null;
      if (view.profile && typeof view.profile === 'object' && view.haiku && typeof view.haiku === 'object') hostHaiku.set(view.profile, view.haiku);
      return { modelKey: view.modelKey, profile: view.profile, motionFits: view.motionFits ?? null };
    }, () => null);
  } catch { return Promise.resolve(null); }
}
