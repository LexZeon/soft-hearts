/**
 * Model profile, adaptation layer step 1 (handbook/roadmap.md, "任意模型都好用").
 *
 * Generated once per loaded model from plain rest-pose data (vertex positions,
 * dominant skin bone, bone rest positions, vertex-morph offsets); the renderer
 * adapter in src/stage/model-profile.ts extracts that data from a Three mesh.
 * Nothing here reads files, paths or model bytes, and nothing changes the model.
 *
 * - Bones map to a standard humanoid set by NFKC-normalized aliases (MMD
 *   Japanese first, then common English/Chinese/romaji). Missing and ambiguous
 *   mappings are reported, never guessed.
 * - Proportions: height, head size (chin..crown), eye line, mouth, arm/leg
 *   lengths, shoulder width and the rest arm angle (A- vs T-pose).
 * - Semantic morph slots: a name match is only a candidate. A candidate must
 *   actually move vertices in the slot's face region (mouth vowels near the
 *   mouth, blinks at the eye line on both sides, brows above it, ...), so a
 *   decoy "あ" that moves eyebrows is rejected and the next candidate is tried.
 * - Calibration: an amplitude slot's near-max vertex displacement relative to
 *   head size is compared with the bundled Gene's, so weight 1.0 shows a similar
 *   visible amount on every model. The result is clamped to the morph's own
 *   [0, 1] at write time. Closure (eyelid) and overlay (blush) slots keep 1:
 *   "closed" is closed, and a blush overlay's offset says nothing about colour.
 */
import { acceptCollisionProxy, fitCollisionProxy, summarizeCollisionProxy, type CollisionProxy, type CollisionProxySummary } from './collision-proxy';
import {
  CORE_BONES, FINGERS, FINGER_JOINTS, FINGER_SLOTS, MORPH_ALIASES, MORPH_SLOTS, NAMED_FACE_SHAPES, NAMED_FACE_SHAPE_IDS, REFERENCE_AMPLITUDE,
  STANDARD_BONES, STANDARD_BONE_ALIASES, fingerPartOfName, fingerSlotSide, inHeads, isNamedFaceShape, normalizeProfileName, standardBoneOfName, standardParents,
  type Finger, type FingerSlot, type MorphSlot, type NamedFaceShape, type SlotPolicy, type StandardBone, type Vec3,
} from './universal-skeleton';
import { morphDictionary, resolveNamedFaceShapes } from './face-morphs';

// The standard part table, the standard pose and the ruler live in shared/universal-skeleton.ts (one place); re-exported here
// so the profile's long-standing importers keep working.
export {
  CORE_BONES, FINGERS, FINGER_JOINTS, FINGER_SLOTS, MORPH_ALIASES, MORPH_SLOTS, REFERENCE_AMPLITUDE, STANDARD_BONES, STRUCTURE_BONES,
  fingerPartOfName, fingerSlotSide, normalizeProfileName, standardBoneOfName, standardParents, structureDifferences,
} from './universal-skeleton';
export type { Finger, FingerPart, FingerSlot, MorphSlot, SlotPolicy, StandardBone, StructureDifference, Vec3 } from './universal-skeleton';

/**
 * Bump whenever aliases, region rules, calibration or the collision proxy change: cached profiles of another version are recomputed.
 * 2: adds the collision proxy (shared/collision-proxy.ts).
 * 3: adds the browUp slot (raised brows, for the E1 expression previews; docs/claude/2026-11-03-e1-r18-fixes.md).
 * 4: adds finger joints, duplicate-named standard bones and the standard skeleton's parents (T-213, docs/claude/2026-11-05-t213-adaptation-fixes.md).
 * 5: adds faceShapes, the named face shapes the face actions need (universal skeleton step 1, docs/claude/2026-11-06-skeleton-step1.md):
 *    the card reads them from here, so it says what the stage will find. Nothing else in the profile changed.
 * 6: adds the mouthPucker slot (嘟嘴, checked by where the lips move: forward and in) and moves it out of faceShapes; adds the
 *    mouthCornersDown face shape (universal skeleton step 2, docs/claude/2026-11-06-skeleton-step2.md). A cached version 5
 *    profile has neither, so the card and the stage would disagree about 撅嘴 until it is computed again.
 */
export const MODEL_PROFILE_VERSION = 6;

// ---------------------------------------------------------------- input

export interface ProfileBone {
  name: string;
  /** Parent bone index, -1 for a root. */
  parent: number;
  /** Rest position in model space (Three's MMDLoader coordinates: +y up, face toward +z, model's left at +x). */
  position: Vec3;
  ik?: boolean;
  /** Carries a dynamic rigid body (MMD physics mode 1 or 2): hair, skirt, accessories. */
  physics?: boolean;
  /** 付与 source bone and ratio (twist links, "D" deform bones). */
  grant?: { parent: number; ratio: number };
}
export interface ProfileMorphOffsets { indices: ArrayLike<number>; deltas: ArrayLike<number> }
export interface ProfileMorph {
  name: string;
  /** Sparse vertex offsets; called lazily and only for alias candidates. null when the morph moves no vertices. */
  offsets(): ProfileMorphOffsets | null;
}
export interface ModelProfileInput {
  /** Rest vertex positions, xyz per vertex. */
  positions: ArrayLike<number>;
  /** Dominant skin bone per vertex (highest weight), -1 when unknown. */
  skinBone?: ArrayLike<number>;
  /** Full skinning (Three's skinIndex/skinWeight: `width` slots per vertex; BDEF1/2/4 and SDEF as weights). Enables the collision proxy. */
  skinWeights?: { indices: ArrayLike<number>; weights: ArrayLike<number>; width: number };
  bones: readonly ProfileBone[];
  /** In morph-target index order. */
  morphs: readonly ProfileMorph[];
}

type Region = 'mouth' | 'mouth-pucker' | 'eyes' | 'eye-left' | 'eye-right' | 'brows' | 'eyes-or-brows' | 'cheeks';
const SLOT_SPECS: Readonly<Record<MorphSlot, { region: Region; policy: SlotPolicy }>> = Object.freeze({
  a: { region: 'mouth', policy: 'amplitude' }, i: { region: 'mouth', policy: 'amplitude' }, u: { region: 'mouth', policy: 'amplitude' },
  e: { region: 'mouth', policy: 'amplitude' }, o: { region: 'mouth', policy: 'amplitude' },
  blink: { region: 'eyes', policy: 'closure' }, blinkLeft: { region: 'eye-left', policy: 'closure' }, blinkRight: { region: 'eye-right', policy: 'closure' },
  smileEyes: { region: 'eyes', policy: 'closure' }, mouthSmile: { region: 'mouth', policy: 'amplitude' },
  sad: { region: 'brows', policy: 'amplitude' }, angry: { region: 'brows', policy: 'amplitude' },
  surprise: { region: 'eyes-or-brows', policy: 'amplitude' }, shy: { region: 'cheeks', policy: 'overlay' },
  jitome: { region: 'eyes', policy: 'closure' }, browUp: { region: 'brows', policy: 'amplitude' },
  // No reference amount (REFERENCE_AMPLITUDE): written as the clip says on every model (scale 1).
  mouthPucker: { region: 'mouth-pucker', policy: 'amplitude' },
});
export const slotPolicy = (slot: MorphSlot): SlotPolicy => SLOT_SPECS[slot].policy;

/** 嘟嘴's lip check: at least this share of the movement forward, and of the off-midline movement toward the midline. */
export const PUCKER_FORWARD = 0.25;
export const PUCKER_INWARD = 0.4;

export const MIN_SLOT_SCALE = 0.25;
export const MAX_SLOT_SCALE = 4;

// ---------------------------------------------------------------- output

export interface BoneSlotEntry { index: number; name: string }
export interface MorphRejection { index: number; name: string; reason: string }
export interface MorphSlotEntry {
  /** Morph-target index, -1 when missing. */
  index: number;
  name: string | null;
  policy: SlotPolicy;
  /** Near-max (98th percentile) vertex displacement at weight 1 / head size; 0 when missing. */
  amplitude: number;
  /** Multiplier applied before clamping to [0, 1]; 1 for closure/overlay and missing slots. */
  scale: number;
  /** Name candidates that failed validation (bounded). */
  rejected: MorphRejection[];
}
export type RestPose = 'A' | 'T' | 'arms-down' | 'unknown';
export interface ModelProfile {
  version: typeof MODEL_PROFILE_VERSION;
  counts: { vertices: number; bones: number; morphs: number };
  bones: {
    map: Partial<Record<StandardBone, BoneSlotEntry>>;
    missing: StandardBone[];
    ambiguous: { bone: StandardBone; names: string[] }[];
    features: { ik: boolean; legIk: boolean; armTwist: boolean; wristTwist: boolean; groove: boolean; eyes: 'pair' | 'both-only' | 'none' };
    /**
     * T-213: mapped standard bones whose name another bone of the model also has. A motion track names its bone, so it cannot
     * bind to either (the stage's clip players drop shared names): such a bone is there, but no action can move it.
     */
    duplicates: StandardBone[];
    /** T-213: finger joints a motion's finger tracks can land on (unique names, in joint order under that side's wrist). */
    fingers: Partial<Record<FingerSlot, BoneSlotEntry>>;
    /** T-213: fingers left out, and why (numbering: another joint convention; duplicate: a shared name or joint; chain: not a chain under the wrist). */
    fingerIssues: { finger: `${Finger}${'Left' | 'Right'}`; reason: 'numbering' | 'duplicate' | 'chain' }[];
    /** T-213: each mapped standard bone's nearest standard ancestor (null: none), the skeleton's shape as motions see it. */
    parents: Partial<Record<StandardBone, StandardBone | null>>;
  };
  proportions: {
    height: number;
    /** Chin to crown (hair included at the crown). */
    headSize: number;
    headsTall: number;
    crownY: number;
    chinY: number;
    eyeLineY: number;
    eyeLineSource: 'bones' | 'morph' | 'estimate';
    /** Measured eye centers (model's left at +x); null when only estimated. */
    eyes: { left: Vec3; right: Vec3; spacing: number; source: 'bones' | 'morph' } | null;
    mouth: { point: Vec3; source: 'morph' | 'bone' | 'estimate' };
    shoulderWidth: number | null;
    armLength: number | null;
    legLength: number | null;
    /** Upper-arm angle below horizontal at rest, degrees. */
    restArmDeg: number | null;
    restPose: RestPose;
  };
  morphs: Record<MorphSlot, MorphSlotEntry>;
  /**
   * Version 5: the named face shapes (shared/universal-skeleton.ts NAMED_FACE_SHAPES: cheekPuff, tongueOut, …) this model has,
   * found by the stage's own rule (shared/face-morphs.ts: the exact name, then the aliases) and kept only when the morph really
   * moves vertices. Absent: none.
   */
  faceShapes: Partial<Record<NamedFaceShape, { index: number; name: string }>>;
  /** Capsules fitted to the skinned body (null without full skin weights). */
  collision: CollisionProxy | null;
}

// ---------------------------------------------------------------- helpers

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
function percentile(values: number[], fraction: number): number {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const round = (value: number, digits = 4) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };

function mapBones(bones: readonly ProfileBone[], skinBone?: ArrayLike<number>): ModelProfile['bones'] {
  const normalized = bones.map(bone => normalizeProfileName(bone.name));
  const map: Partial<Record<StandardBone, BoneSlotEntry>> = {};
  const missing: StandardBone[] = [], ambiguous: { bone: StandardBone; names: string[] }[] = [];
  for (const key of STANDARD_BONES) {
    const aliases = STANDARD_BONE_ALIASES[key].map(normalizeProfileName);
    const matches: { index: number; rank: number }[] = [];
    normalized.forEach((name, index) => { const rank = aliases.indexOf(name); if (rank >= 0) matches.push({ index, rank }); });
    if (!matches.length) { missing.push(key); continue; }
    matches.sort((a, b) => a.rank - b.rank || a.index - b.index);
    map[key] = { index: matches[0].index, name: bones[matches[0].index].name };
    if (matches.length > 1) ambiguous.push({ bone: key, names: matches.slice(0, 4).map(match => bones[match.index].name) });
  }
  // A left/right pair whose "left" lies on the model's right side is flagged, not silently swapped.
  for (const key of ['eye', 'shoulder', 'arm', 'elbow', 'wrist', 'leg', 'knee', 'ankle'] as const) {
    const left = map[`${key}Left`], right = map[`${key}Right`];
    if (left && right && bones[left.index].position[0] < bones[right.index].position[0])
      ambiguous.push({ bone: `${key}Left`, names: [left.name, right.name, 'left-right-mirrored'] });
  }
  const has = (key: StandardBone) => !!map[key];
  const nameCount = new Map<string, number>();
  for (const bone of bones) nameCount.set(bone.name, (nameCount.get(bone.name) ?? 0) + 1);
  const duplicates = STANDARD_BONES.filter(key => map[key] && (nameCount.get(map[key]!.name) ?? 0) > 1);
  const slots: Partial<Record<StandardBone, number>> = {};
  for (const key of STANDARD_BONES) if (map[key]) slots[key] = map[key]!.index;
  const fingers = mapFingers(bones, slots, nameCount, skinBone);
  return {
    map, missing, ambiguous, duplicates, fingers: fingers.map, fingerIssues: fingers.issues, parents: standardParents(bones, slots),
    features: {
      ik: bones.some(bone => bone.ik === true) || has('legIkLeft') || has('legIkRight'),
      legIk: has('legIkLeft') && has('legIkRight'),
      armTwist: has('armTwistLeft') && has('armTwistRight'),
      wristTwist: has('wristTwistLeft') && has('wristTwistRight'),
      groove: has('groove'),
      eyes: has('eyeLeft') && has('eyeRight') ? 'pair' : has('eyes') ? 'both-only' : 'none',
    },
  };
}

/**
 * T-213: the finger joints, one group per hand and finger. A group is used only when it is clearly the MMD numbering: every
 * numbered joint inside the range (thumb 0–2, others 1–3) at most once, anything numbered past it only a bare tip (a leaf
 * with no skinned vertices), the joints a chain in number order, and the first under that side's wrist when the wrist is
 * known. Otherwise the whole finger is left out (never shifted or guessed) and the reason is kept.
 */
function mapFingers(bones: readonly ProfileBone[], slots: Partial<Record<StandardBone, number>>, nameCount: ReadonlyMap<string, number>,
  skinBone?: ArrayLike<number>): { map: ModelProfile['bones']['fingers']; issues: ModelProfile['bones']['fingerIssues'] } {
  const groups = new Map<`${Finger}${'Left' | 'Right'}`, { joint: number | null; index: number }[]>();
  bones.forEach((bone, index) => {
    const part = fingerPartOfName(bone.name);
    if (!part || part.tip) return;
    const key = `${part.finger}${part.side === 'left' ? 'Left' : 'Right'}` as const;
    groups.set(key, [...groups.get(key) ?? [], { joint: part.joint, index }]);
  });
  const children = new Set(bones.map(bone => bone.parent));
  const skinned = new Set<number>();
  if (skinBone) for (let vertex = 0; vertex < skinBone.length; vertex++) skinned.add(skinBone[vertex]);
  const tipOnly = (index: number) => !!skinBone && !children.has(index) && !skinned.has(index);
  const descends = (index: number, ancestor: number) => {
    for (let at = bones[index]?.parent ?? -1, steps = 0; at >= 0 && steps <= bones.length; at = bones[at]?.parent ?? -1, steps++) if (at === ancestor) return true;
    return false;
  };
  const map: ModelProfile['bones']['fingers'] = {}, issues: ModelProfile['bones']['fingerIssues'] = [];
  for (const side of ['Left', 'Right'] as const) for (const finger of FINGERS) {
    const key = `${finger}${side}` as const, entries = groups.get(key);
    if (!entries) continue;
    const range = FINGER_JOINTS[finger];
    const joints = entries.filter(entry => entry.joint !== null && range.includes(entry.joint));
    const extra = entries.filter(entry => !joints.includes(entry));
    joints.sort((a, b) => a.joint! - b.joint!);
    // Past the top only a bare tip may be numbered (Mixamo's Index4); a real joint there means the numbers are shifted (a thumb
    // 1–3 whose 1 is the metacarpal), so nothing is guessed. Below the range (人指０) a metacarpal above the chain is fine.
    const fits = (entry: { joint: number | null; index: number }) => entry.joint !== null && (entry.joint > range[range.length - 1]
      ? tipOnly(entry.index) : !!joints.length && descends(joints[0].index, entry.index));
    if (!joints.length || !extra.every(fits)) { issues.push({ finger: key, reason: 'numbering' }); continue; }
    if (joints.some((entry, k) => k > 0 && entry.joint === joints[k - 1].joint) || joints.some(entry => (nameCount.get(bones[entry.index].name) ?? 0) > 1)) {
      issues.push({ finger: key, reason: 'duplicate' }); continue;
    }
    const wrist = slots[`wrist${side}`];
    if ((wrist !== undefined && !descends(joints[0].index, wrist)) || joints.some((entry, k) => k > 0 && !descends(entry.index, joints[k - 1].index))) {
      issues.push({ finger: key, reason: 'chain' }); continue;
    }
    for (const entry of joints) map[`${finger}${entry.joint}${side}` as FingerSlot] = { index: entry.index, name: bones[entry.index].name };
  }
  return { map, issues };
}


/**
 * T-213, one rule for "can a motion track move this standard bone" (the capability card, the action checks, the stage):
 * true when the profile maps it and no other bone shares its name; 'duplicate' when it is there under a shared name.
 */
export function profileBoneState(profile: Pick<ModelProfile, 'bones'> | null | undefined, slot: StandardBone): boolean | 'duplicate' {
  if (!profile?.bones.map[slot]) return false;
  return (profile.bones.duplicates ?? []).includes(slot) ? 'duplicate' : true;
}
/** Finger joints a motion's finger tracks can reach, per hand. */
export function profileFingerCount(profile: Pick<ModelProfile, 'bones'> | null | undefined): { left: number; right: number } {
  const out = { left: 0, right: 0 };
  for (const slot of Object.keys(profile?.bones.fingers ?? {}) as FingerSlot[]) if (FINGER_SLOTS.includes(slot)) out[fingerSlotSide(slot)]++;
  return out;
}
/** The profile's finger joints by bone name, with their hand (to count which finger tracks really bound). */
export function profileFingerNames(profile: Pick<ModelProfile, 'bones'> | null | undefined): Map<string, 'left' | 'right'> {
  const out = new Map<string, 'left' | 'right'>();
  for (const [slot, entry] of Object.entries(profile?.bones.fingers ?? {}) as [FingerSlot, BoneSlotEntry][])
    if (FINGER_SLOTS.includes(slot) && entry) out.set(entry.name, fingerSlotSide(slot));
  return out;
}

interface HeadFrame { minY: number; maxY: number; height: number; chinY: number; crownY: number; headSize: number; midX: number; vertices: number }
function headFrame(input: ModelProfileInput, bones: ModelProfile['bones']): HeadFrame {
  const positions = input.positions, count = Math.floor(positions.length / 3);
  let minY = Infinity, maxY = -Infinity;
  for (let vertex = 0; vertex < count; vertex++) {
    const y = positions[vertex * 3 + 1];
    if (finite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  if (!(maxY > minY)) { minY = 0; maxY = 1; }
  const height = maxY - minY;
  const head = bones.map.head?.index ?? -1;
  const headPosition = head >= 0 ? input.bones[head].position : null;
  // Head family: vertices skinned (mostly) to the head bone or any descendant (hair, eyes, accessories).
  const family = new Set<number>();
  if (head >= 0) {
    family.add(head);
    for (let changed = true; changed;) {
      changed = false;
      input.bones.forEach((bone, index) => { if (!family.has(index) && family.has(bone.parent)) { family.add(index); changed = true; } });
    }
  }
  const familyY: number[] = [], ownY: number[] = [], ownX: number[] = [];
  const skin = input.skinBone;
  if (skin && head >= 0) for (let vertex = 0; vertex < count; vertex++) {
    const bone = skin[vertex], y = positions[vertex * 3 + 1];
    if (!finite(y) || !family.has(bone)) continue;
    familyY.push(y);
    if (bone === head) { ownY.push(y); ownX.push(positions[vertex * 3]); }
  }
  if (familyY.length < 12 || ownY.length < 12) {
    // No usable skin data: the top of the model around the head bone (or the top center) stands in.
    familyY.length = ownY.length = ownX.length = 0;
    const baseY = headPosition ? headPosition[1] - height * 0.035 : maxY - height * 0.16;
    const centerX = headPosition?.[0] ?? 0;
    for (let vertex = 0; vertex < count; vertex++) {
      const x = positions[vertex * 3], y = positions[vertex * 3 + 1];
      if (finite(x) && finite(y) && y >= baseY && Math.abs(x - centerX) <= height * 0.15) { familyY.push(y); ownY.push(y); ownX.push(x); }
    }
  }
  let crownY = percentile(familyY, 0.98), chinY = percentile(ownY, 0.02);
  let headSize = crownY - chinY;
  if (!finite(headSize) || headSize < height * 0.04 || headSize > height * 0.6) {
    crownY = maxY; headSize = height * 0.15; chinY = crownY - headSize;
  }
  const midX = headPosition?.[0] ?? (ownX.length ? ownX.reduce((sum, x) => sum + x, 0) / ownX.length : 0);
  return { minY, maxY, height, chinY, crownY, headSize, midX, vertices: count };
}

interface MorphStats {
  moved: number;
  nearMax: number;
  centroid: Vec3;
  /** Share of displacement weight on the model's left (+x of the head midline). */
  leftShare: number;
  /** Weighted mean |x - midline| in head sizes. */
  lateral: number;
  /** Share of displacement weight inside the head's vertical span. */
  inHead: number;
  left: Vec3 | null;
  right: Vec3 | null;
  /** Share of the displacement toward the face's front (+z): sum of dz / sum of lengths, -1..1. */
  forward: number;
  /** Off the midline (beyond 2% of a head): sum of the x movement toward the midline / sum of lengths, -1..1; 0 with no such vertex. */
  inward: number;
}
function morphStats(input: ModelProfileInput, index: number, frame: HeadFrame): MorphStats | null {
  let offsets: ProfileMorphOffsets | null = null;
  try { offsets = input.morphs[index]?.offsets() ?? null; } catch { return null; }
  if (!offsets) return null;
  const positions = input.positions, count = frame.vertices, minimum = frame.headSize * 1e-4;
  const lengths: number[] = [];
  let weight = 0, cx = 0, cy = 0, cz = 0, leftWeight = 0, lateral = 0, inHead = 0, forward = 0, inward = 0, aside = 0;
  const side = [[0, 0, 0, 0], [0, 0, 0, 0]];
  const n = Math.min(offsets.indices.length, Math.floor(offsets.deltas.length / 3));
  for (let k = 0; k < n; k++) {
    const vertex = offsets.indices[k];
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= count) continue;
    const length = Math.hypot(offsets.deltas[k * 3], offsets.deltas[k * 3 + 1], offsets.deltas[k * 3 + 2]);
    if (!finite(length) || length <= minimum) continue;
    const x = positions[vertex * 3], y = positions[vertex * 3 + 1], z = positions[vertex * 3 + 2];
    if (!finite(x) || !finite(y) || !finite(z)) continue;
    lengths.push(length); weight += length; cx += x * length; cy += y * length; cz += z * length;
    const s = x > frame.midX ? 0 : 1;
    if (s === 0) leftWeight += length;
    side[s][0] += x * length; side[s][1] += y * length; side[s][2] += z * length; side[s][3] += length;
    lateral += Math.abs(x - frame.midX) * length;
    forward += offsets.deltas[k * 3 + 2];
    if (Math.abs(x - frame.midX) > frame.headSize * 0.02) { inward -= Math.sign(x - frame.midX) * offsets.deltas[k * 3]; aside += length; }
    if (y >= frame.chinY - frame.headSize * 0.15 && y <= frame.crownY + frame.headSize * 0.05) inHead += length;
  }
  if (lengths.length < 3 || weight <= 0) return null;
  const centroidOf = (values: number[]): Vec3 | null => values[3] > 0 ? [values[0] / values[3], values[1] / values[3], values[2] / values[3]] : null;
  return { moved: lengths.length, nearMax: percentile(lengths, 0.98), centroid: [cx / weight, cy / weight, cz / weight],
    leftShare: leftWeight / weight, lateral: lateral / weight / frame.headSize, inHead: inHead / weight,
    left: centroidOf(side[0]), right: centroidOf(side[1]), forward: forward / weight, inward: aside > 0 ? inward / aside : 0 };
}

/** Why a candidate does not show the slot's meaning; '' when it does. */
function regionMismatch(region: Region, stats: MorphStats, frame: HeadFrame, eyeLineY: number): string {
  if (stats.inHead < 0.8) return 'moves vertices outside the head';
  const dy = (stats.centroid[1] - eyeLineY) / frame.headSize;
  const balance = Math.min(stats.leftShare, 1 - stats.leftShare);
  const within = (low: number, high: number, what: string) => dy >= low && dy <= high ? '' : `${what} (${round(dy, 2)} head from the eye line)`;
  switch (region) {
    case 'mouth': return within(-0.65, -0.12, 'not at the mouth') || (stats.lateral > 0.22 ? 'too far from the face midline' : balance < 0.3 ? 'one-sided' : '');
    // 嘟嘴: a mouth shape whose lips push forward and draw in toward the midline (Gene's mouthPucker: forward 0.50, in 0.85;
    // its う 0.05 / 0.31, cheekPuff 0.65 / -0.58, the frowns 0 / 0). A name alone is never enough.
    case 'mouth-pucker': return regionMismatch('mouth', stats, frame, eyeLineY)
      || (stats.forward < PUCKER_FORWARD ? 'the lips do not move forward' : stats.inward < PUCKER_INWARD ? 'the lips do not draw in' : '');
    case 'eyes': return within(-0.15, 0.14, 'not at the eyes') || (balance < 0.3 ? 'one eye only' : '');
    case 'eye-left': return within(-0.15, 0.14, 'not at the eyes') || (stats.leftShare < 0.8 ? 'not the left eye' : '');
    case 'eye-right': return within(-0.15, 0.14, 'not at the eyes') || (stats.leftShare > 0.2 ? 'not the right eye' : '');
    case 'brows': return within(0.04, 0.45, 'not at the brows') || (balance < 0.3 ? 'one-sided' : '');
    case 'eyes-or-brows': return within(-0.15, 0.45, 'not at the eyes or brows') || (balance < 0.3 ? 'one-sided' : '');
    case 'cheeks': return within(-0.4, 0.02, 'not at the cheeks') || (balance < 0.3 ? 'one-sided' : stats.lateral < 0.06 ? 'not on the cheeks' : '');
  }
}

function candidates(morphs: readonly string[], aliases: readonly string[]): number[] {
  const wanted = aliases.map(normalizeProfileName), ranked: { index: number; rank: number }[] = [];
  morphs.forEach((name, index) => { const rank = wanted.indexOf(name); if (rank >= 0) ranked.push({ index, rank }); });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(value => value.index);
}

function armAngle(bones: readonly ProfileBone[], arm?: BoneSlotEntry, elbow?: BoneSlotEntry): number | null {
  if (!arm || !elbow) return null;
  const a = bones[arm.index].position, b = bones[elbow.index].position;
  const horizontal = Math.hypot(b[0] - a[0], b[2] - a[2]);
  if (horizontal + Math.abs(b[1] - a[1]) <= 1e-9) return null;
  return Math.atan2(a[1] - b[1], horizontal) * 180 / Math.PI;
}
function chainLength(bones: readonly ProfileBone[], chain: (BoneSlotEntry | undefined)[]): number | null {
  if (chain.some(entry => !entry)) return null;
  let total = 0;
  for (let k = 1; k < chain.length; k++) total += distance(bones[chain[k - 1]!.index].position, bones[chain[k]!.index].position);
  return total;
}
const mean = (values: (number | null)[]) => { const valid = values.filter(finite); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; };

// ---------------------------------------------------------------- build

export function buildModelProfile(input: ModelProfileInput): ModelProfile {
  const bones = mapBones(input.bones, input.skinBone);
  const frame = headFrame(input, bones);
  const morphNames = input.morphs.map(morph => normalizeProfileName(morph.name));
  const statsCache = new Map<number, MorphStats | null>();
  const stats = (index: number) => {
    if (!statsCache.has(index)) statsCache.set(index, morphStats(input, index, frame));
    return statsCache.get(index)!;
  };

  // Eye line: real eye bone pair inside the head, else an eye-closing morph's two clusters, else a ratio estimate.
  let eyes: ModelProfile['proportions']['eyes'] = null;
  const eyeLeft = bones.map.eyeLeft, eyeRight = bones.map.eyeRight;
  if (eyeLeft && eyeRight) {
    const left = input.bones[eyeLeft.index].position, right = input.bones[eyeRight.index].position;
    const spacing = distance(left, right);
    if ([...left, ...right].every(finite) && spacing > frame.headSize * 0.05 && spacing < frame.headSize
      && [left[1], right[1]].every(y => y > frame.chinY && y < frame.crownY))
      eyes = { left: [...left], right: [...right], spacing, source: 'bones' };
  }
  if (!eyes) {
    for (const index of candidates(morphNames, [...MORPH_ALIASES.blink, ...MORPH_ALIASES.smileEyes, ...MORPH_ALIASES.jitome])) {
      const value = stats(index);
      if (!value?.left || !value.right || value.inHead < 0.8) continue;
      const relative = (value.centroid[1] - frame.chinY) / frame.headSize, balance = Math.min(value.leftShare, 1 - value.leftShare);
      const spacing = distance(value.left, value.right);
      if (relative < 0.2 || relative > 0.8 || balance < 0.3 || spacing < frame.headSize * 0.05) continue;
      eyes = { left: value.left, right: value.right, spacing, source: 'morph' };
      break;
    }
  }
  const eyeLineY = eyes ? (eyes.left[1] + eyes.right[1]) / 2 : frame.chinY + frame.headSize * 0.42;

  const morphs = {} as Record<MorphSlot, MorphSlotEntry>;
  for (const slot of MORPH_SLOTS) {
    const { region, policy } = SLOT_SPECS[slot];
    const list = slot === 'blinkLeft' ? [...MORPH_ALIASES.blinkLeft, ...MORPH_ALIASES.blinkRight]
      : slot === 'blinkRight' ? [...MORPH_ALIASES.blinkRight, ...MORPH_ALIASES.blinkLeft] : MORPH_ALIASES[slot];
    const rejected: MorphRejection[] = [];
    let chosen: { index: number; value: MorphStats } | null = null;
    for (const index of candidates(morphNames, list)) {
      const value = stats(index);
      const reason = value ? regionMismatch(region, value, frame, eyeLineY) : 'moves no vertices';
      if (!reason) { chosen = { index, value: value! }; break; }
      if (rejected.length < 6) rejected.push({ index, name: input.morphs[index].name, reason });
    }
    const amplitude = chosen ? chosen.value.nearMax / frame.headSize : 0;
    const reference = REFERENCE_AMPLITUDE[slot];
    const scale = chosen && policy === 'amplitude' && reference && amplitude > 0 ? clamp(reference / amplitude, MIN_SLOT_SCALE, MAX_SLOT_SCALE) : 1;
    morphs[slot] = { index: chosen?.index ?? -1, name: chosen ? input.morphs[chosen.index].name : null, policy, amplitude, scale, rejected };
  }

  // Mouth: where the open-mouth morph actually moves, else a mouth bone, else below the eye line.
  const mouthMorph = morphs.a.index >= 0 ? morphs.a.index : morphs.o.index;
  const mouthBone = input.bones.findIndex(bone => ['口', 'mouth'].includes(normalizeProfileName(bone.name)));
  const mouth: ModelProfile['proportions']['mouth'] = mouthMorph >= 0 ? { point: [...stats(mouthMorph)!.centroid], source: 'morph' }
    : mouthBone >= 0 ? { point: [...input.bones[mouthBone].position], source: 'bone' }
      : { point: [frame.midX, eyeLineY - frame.headSize * 0.28, eyes ? (eyes.left[2] + eyes.right[2]) / 2 : 0], source: 'estimate' };

  const map = bones.map, b = input.bones;
  const restArmDeg = mean([armAngle(b, map.armLeft, map.elbowLeft), armAngle(b, map.armRight, map.elbowRight)]);
  let collision: CollisionProxy | null = null;
  if (input.skinWeights) {
    try {
      const slots: Partial<Record<StandardBone, number>> = {};
      for (const [slot, entry] of Object.entries(map) as [StandardBone, BoneSlotEntry][]) slots[slot] = entry.index;
      collision = fitCollisionProxy({ positions: input.positions, skin: input.skinWeights, bones: b, slots, slotOfName: standardBoneOfName,
        head: { chinY: frame.chinY, crownY: frame.crownY, headSize: frame.headSize } });
    } catch { collision = null; }
  }
  return {
    version: MODEL_PROFILE_VERSION,
    counts: { vertices: frame.vertices, bones: input.bones.length, morphs: input.morphs.length },
    bones,
    proportions: {
      height: frame.height, headSize: frame.headSize, headsTall: inHeads(frame.height, frame.headSize),
      crownY: frame.crownY, chinY: frame.chinY, eyeLineY, eyeLineSource: eyes?.source ?? 'estimate', eyes, mouth,
      shoulderWidth: map.armLeft && map.armRight ? Math.abs(b[map.armLeft.index].position[0] - b[map.armRight.index].position[0]) : null,
      armLength: mean([chainLength(b, [map.armLeft, map.elbowLeft, map.wristLeft]), chainLength(b, [map.armRight, map.elbowRight, map.wristRight])]),
      legLength: mean([chainLength(b, [map.legLeft, map.kneeLeft, map.ankleLeft]), chainLength(b, [map.legRight, map.kneeRight, map.ankleRight])]),
      restArmDeg,
      restPose: restArmDeg === null ? 'unknown' : restArmDeg < 15 ? 'T' : restArmDeg <= 65 ? 'A' : 'arms-down',
    },
    morphs,
    faceShapes: namedFaceShapes(input),
    collision,
  };
}

/** The named face shapes this model has, by the stage's rule (shared/face-morphs.ts) on its own morph names and real vertex movement. */
function namedFaceShapes(input: ModelProfileInput): ModelProfile['faceShapes'] {
  const names = input.morphs.map(morph => morph.name);
  const found = resolveNamedFaceShapes(NAMED_FACE_SHAPES, { names: morphDictionary(names), count: names.length, slot: () => null,
    displaces: index => { try { return offsetsMove(input.morphs[index]?.offsets()); } catch { return false; } } });
  const out: ModelProfile['faceShapes'] = {};
  for (const shape of NAMED_FACE_SHAPE_IDS) { const index = found[shape]; if (index !== undefined) out[shape] = { index, name: names[index] }; }
  return out;
}
/** Some vertex moves (the stage's own threshold: squared offset above 1e-14). */
function offsetsMove(offsets: ProfileMorphOffsets | null | undefined): boolean {
  if (!offsets) return false;
  const deltas = offsets.deltas, count = Math.min(offsets.indices.length, Math.floor(deltas.length / 3));
  for (let k = 0; k < count; k++) if (deltas[k * 3] ** 2 + deltas[k * 3 + 1] ** 2 + deltas[k * 3 + 2] ** 2 > 1e-14) return true;
  return false;
}

// ---------------------------------------------------------------- candidate check (I-024)

export interface ProfileCandidateChecker {
  /** '' when this morph moves vertices in the slot's face region (the exact check a name candidate passes above); otherwise why not. */
  morph(slot: MorphSlot, index: number): string;
  /**
   * '' when this bone can be the standard bone: a real deforming bone (not IK, not physics) that moves skinned vertices, at the
   * part's place in the rest pose, on the model's own side, and inside the chain of the parts already known (`known`: standard
   * bone -> bone index, from the profile or accepted earlier). Otherwise why not.
   */
  bone(bone: StandardBone, index: number, known: Partial<Record<StandardBone, number>>): string;
}

/**
 * I-024 模型体检 (shared/model-capability-check.ts): checks a candidate that something other than the alias lists suggested
 * (haiku reading the model's own part names) with the same head frame, eye line and region rules buildModelProfile used.
 * `profile` must be this input's profile. Nothing is trusted by name alone; nothing changes the model.
 */
export function profileCandidateChecker(input: ModelProfileInput, profile: ModelProfile): ProfileCandidateChecker {
  const frame = headFrame(input, profile.bones);
  const eyeLineY = profile.proportions.eyeLineY;
  const children = new Map<number, number[]>();
  input.bones.forEach((bone, index) => { if (bone.parent >= 0) children.set(bone.parent, [...children.get(bone.parent) ?? [], index]); });
  const descendsFrom = (index: number, ancestor: number) => {
    for (let at = input.bones[index]?.parent ?? -1, steps = 0; at >= 0 && steps <= input.bones.length; at = input.bones[at]?.parent ?? -1, steps++)
      if (at === ancestor) return true;
    return false;
  };
  const skinned = new Map<number, number>();
  const skin = input.skinBone;
  if (skin) for (let vertex = 0; vertex < frame.vertices; vertex++) { const bone = skin[vertex]; if (Number.isInteger(bone) && bone >= 0) skinned.set(bone, (skinned.get(bone) ?? 0) + 1); }
  const movesVertices = (index: number) => {
    let count = 0;
    for (const stack = [index], seen = new Set<number>(); stack.length;) {
      const at = stack.pop()!;
      if (seen.has(at)) continue;
      seen.add(at); count += skinned.get(at) ?? 0;
      if (count >= 3) return true;
      stack.push(...children.get(at) ?? []);
    }
    return false;
  };
  const mapped = new Map<number, StandardBone>();
  for (const [slot, entry] of Object.entries(profile.bones.map) as [StandardBone, BoneSlotEntry][]) mapped.set(entry.index, slot);
  const chain: Partial<Record<StandardBone, StandardBone>> = { head: 'neck', eyeLeft: 'head', eyeRight: 'head',
    elbowLeft: 'armLeft', elbowRight: 'armRight', wristLeft: 'elbowLeft', wristRight: 'elbowRight' };
  return {
    morph(slot, index) {
      if (!Number.isInteger(index) || index < 0 || index >= input.morphs.length) return 'no such morph';
      const stats = morphStats(input, index, frame);
      return stats ? regionMismatch(SLOT_SPECS[slot].region, stats, frame, eyeLineY) : 'moves no vertices';
    },
    bone(bone, index, known) {
      const source = Number.isInteger(index) ? input.bones[index] : undefined;
      if (!source) return 'no such bone';
      if (source.ik) return 'an IK bone';
      if (source.physics) return 'driven by physics';
      const other = mapped.get(index);
      if (other && other !== bone) return `already the ${other}`;
      if (!skin) return 'no skin data to check';
      if (!movesVertices(index)) return 'moves no vertices';
      const [x, y] = source.position, size = frame.headSize, offset = x - frame.midX;
      if (![x, y].every(finite)) return 'no rest position';
      if (bone === 'head' && (y < frame.chinY - size * 0.6 || y > frame.crownY || Math.abs(offset) > size * 0.5)) return 'not at the head';
      if (bone === 'neck' && (y < frame.chinY - size * 1.2 || y > frame.chinY + size * 0.5 || Math.abs(offset) > size * 0.5)) return 'not at the neck';
      if (bone === 'eyeLeft' || bone === 'eyeRight') {
        if (y < frame.chinY || y > frame.crownY || Math.abs(offset) > size * 0.5) return 'not at the eyes';
        if (bone === 'eyeLeft' ? offset < size * 0.02 : offset > -size * 0.02) return `not the model's ${bone === 'eyeLeft' ? 'left' : 'right'} eye`;
      }
      const arm = /^(arm|elbow|wrist)(Left|Right)$/u.exec(bone);
      if (arm) {
        if (y > frame.chinY + size * 0.2) return 'above the chin';
        if (arm[2] === 'Left' ? offset < size * 0.05 : offset > -size * 0.05) return `not on the model's ${arm[2].toLowerCase()}`;
      }
      const parent = chain[bone], parentIndex = parent ? known[parent] : undefined;
      if (parent && parentIndex !== undefined && !descendsFrom(index, parentIndex)) return `not under the ${parent}`;
      for (const [child, above] of Object.entries(chain) as [StandardBone, StandardBone][]) {
        const childIndex = above === bone ? known[child] : undefined;
        if (childIndex !== undefined && !descendsFrom(childIndex, index)) return `the ${child} is not under it`;
      }
      return '';
    },
  };
}

// ---------------------------------------------------------------- stage bindings

export interface ProfileBindings {
  /** Morph index for the eyelid compositor; -1 when the model has no usable blink. */
  blink: number;
  /** Second morph written with the blink when the model only has per-eye blinks. */
  blinkPartner: number;
  /** Morph index for lip-sync and feeding (あ, else お). */
  mouth: number;
  /** Eye smile (笑い), else mouth smile. */
  smile: number;
  /** Troubled brows. */
  sad: number;
  /** morph index -> calibrated scale; empty for the reviewed Gene, whose values stay as reviewed. */
  scales: [number, number][];
}

/** What the stage writes. `reviewed` (the host-verified bundled Gene) keeps every amount exactly as before. */
export function profileBindings(profile: ModelProfile, reviewed: boolean): ProfileBindings {
  const slot = (name: MorphSlot) => profile.morphs[name]?.index ?? -1;
  const pairOnly = slot('blink') < 0 && slot('blinkLeft') >= 0 && slot('blinkRight') >= 0 && slot('blinkLeft') !== slot('blinkRight');
  const scales = new Map<number, number>();
  if (!reviewed) for (const name of MORPH_SLOTS) {
    const entry = profile.morphs[name];
    if (entry && entry.index >= 0 && entry.policy === 'amplitude' && entry.scale !== 1 && !scales.has(entry.index)) scales.set(entry.index, entry.scale);
  }
  return {
    blink: pairOnly ? slot('blinkLeft') : slot('blink'),
    blinkPartner: pairOnly ? slot('blinkRight') : -1,
    mouth: slot('a') >= 0 ? slot('a') : slot('o'),
    smile: slot('smileEyes') >= 0 ? slot('smileEyes') : slot('mouthSmile'),
    sad: slot('sad'),
    scales: [...scales],
  };
}

/** Calibrated semantic amount for one morph write, clamped to the morph's own [0, 1]. */
export function calibratedWeight(scales: ReadonlyMap<number, number> | null | undefined, index: number, weight: number): number {
  const value = weight * (scales?.get(index) ?? 1);
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------- summary (read-only, plain data)

export interface ModelProfileSummary {
  version: number;
  source: 'computed' | 'cache' | 'unavailable';
  reviewed: boolean;
  restPose: RestPose;
  restArmDeg: number | null;
  headsTall: number | null;
  eyes: 'bones' | 'morph' | 'estimate';
  mouth: 'morph' | 'bone' | 'estimate';
  found: Partial<Record<MorphSlot, string>>;
  missing: MorphSlot[];
  /** Effective scales written by the stage (1 omitted). */
  scales: Partial<Record<MorphSlot, number>>;
  missingBones: StandardBone[];
  ambiguousBones: StandardBone[];
  features: ModelProfile['bones']['features'] | null;
  /** Collision proxy numbers (null: none fitted, the motion check uses its rough body approximation). */
  collision: CollisionProxySummary | null;
}
export function summarizeModelProfile(profile: ModelProfile | null, source: ModelProfileSummary['source'], reviewed: boolean): ModelProfileSummary {
  if (!profile) return { version: MODEL_PROFILE_VERSION, source: 'unavailable', reviewed, restPose: 'unknown', restArmDeg: null, headsTall: null,
    eyes: 'estimate', mouth: 'estimate', found: {}, missing: [...MORPH_SLOTS], scales: {}, missingBones: [...STANDARD_BONES], ambiguousBones: [], features: null, collision: null };
  const found: Partial<Record<MorphSlot, string>> = {}, scales: Partial<Record<MorphSlot, number>> = {}, missing: MorphSlot[] = [];
  for (const slot of MORPH_SLOTS) {
    const entry = profile.morphs[slot];
    if (entry.index < 0 || entry.name === null) { missing.push(slot); continue; }
    found[slot] = entry.name;
    if (!reviewed && entry.policy === 'amplitude' && entry.scale !== 1) scales[slot] = round(entry.scale, 2);
  }
  return {
    version: profile.version, source, reviewed,
    restPose: profile.proportions.restPose,
    restArmDeg: profile.proportions.restArmDeg === null ? null : round(profile.proportions.restArmDeg, 1),
    headsTall: round(profile.proportions.headsTall, 2),
    eyes: profile.proportions.eyeLineSource, mouth: profile.proportions.mouth.source,
    found, missing, scales,
    missingBones: [...CORE_BONES.filter(bone => profile.bones.missing.includes(bone)), ...profile.bones.missing.filter(bone => !CORE_BONES.includes(bone))],
    ambiguousBones: [...new Set(profile.bones.ambiguous.map(entry => entry.bone))],
    features: { ...profile.bones.features },
    collision: summarizeCollisionProxy(profile.collision),
  };
}

// ---------------------------------------------------------------- cache validation

/** Host reply for the current model: its content hash, its asset URL (to match the stage) and a cached profile if any. */
export interface ModelProfileCacheView {
  modelKey: string | null; modelUrl: string; profile: ModelProfile | null;
  /**
   * I-024: slots haiku matched for this model and the vertex check passed (shared/model-capability-check.ts), only once its
   * check finished. The stage fills them into a cached profile's missing slots (src/stage/model-profile.ts).
   */
  haiku?: import('./model-capability').HaikuMatches | null;
  /** Universal skeleton step 1: this model's stored library motion scores (shared/motion-fit-record.ts), checked again by the stage. */
  motionFits?: unknown;
}

const MAX_NAME = 256;
const vec = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite);
const name = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_NAME;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nullableNumber = (value: unknown) => value === null || finite(value);

/**
 * Accepts a cached profile only when it was computed by this version for this
 * exact model content: counts and every referenced bone/morph name must match
 * the loaded mesh. Anything else is recomputed (never trusted, never thrown).
 */
export function acceptCachedProfile(value: unknown, model: { vertices: number; bones: readonly string[]; morphs: readonly string[] }): ModelProfile | null {
  try {
    if (!isObject(value) || value.version !== MODEL_PROFILE_VERSION || !isObject(value.counts) || !isObject(value.bones)
      || !isObject(value.proportions) || !isObject(value.morphs)) return null;
    const counts = value.counts, bones = value.bones, proportions = value.proportions, morphs = value.morphs;
    if (counts.vertices !== model.vertices || counts.bones !== model.bones.length || counts.morphs !== model.morphs.length) return null;
    if (!isObject(bones.map) || !Array.isArray(bones.missing) || !Array.isArray(bones.ambiguous) || !isObject(bones.features)) return null;
    for (const [key, entry] of Object.entries(bones.map)) {
      if (!STANDARD_BONES.includes(key as StandardBone) || !isObject(entry) || !Number.isInteger(entry.index)
        || model.bones[entry.index as number] !== entry.name) return null;
    }
    if (!bones.missing.every(key => STANDARD_BONES.includes(key)) || bones.ambiguous.length > STANDARD_BONES.length * 2
      || !bones.ambiguous.every(entry => isObject(entry) && STANDARD_BONES.includes(entry.bone as StandardBone)
        && Array.isArray(entry.names) && entry.names.length <= 4 && entry.names.every(name))) return null;
    // T-213 (version 4): duplicate-named standard bones, finger joints (each this model's own bone), parents among the mapped bones.
    if (!Array.isArray(bones.duplicates) || !bones.duplicates.every(key => STANDARD_BONES.includes(key) && isObject((bones.map as Record<string, unknown>)[key]))
      || !isObject(bones.fingers) || !Array.isArray(bones.fingerIssues) || bones.fingerIssues.length > 10 || !isObject(bones.parents)) return null;
    for (const [key, entry] of Object.entries(bones.fingers)) {
      if (!FINGER_SLOTS.includes(key as FingerSlot) || !isObject(entry) || !Number.isInteger(entry.index) || model.bones[entry.index as number] !== entry.name) return null;
    }
    if (!bones.fingerIssues.every(row => isObject(row) && typeof row.finger === 'string' && /^(thumb|index|middle|ring|little)(Left|Right)$/.test(row.finger)
      && ['numbering', 'duplicate', 'chain'].includes(row.reason as string))) return null;
    for (const [key, parent] of Object.entries(bones.parents)) {
      if (!isObject((bones.map as Record<string, unknown>)[key]) || (parent !== null && !isObject((bones.map as Record<string, unknown>)[parent as string]))) return null;
    }
    const features = bones.features;
    if (!['ik', 'legIk', 'armTwist', 'wristTwist', 'groove'].every(key => typeof features[key] === 'boolean')
      || !['pair', 'both-only', 'none'].includes(features.eyes as string)) return null;
    const numbers = ['height', 'headSize', 'headsTall', 'crownY', 'chinY', 'eyeLineY'];
    if (!numbers.every(key => finite(proportions[key])) || (proportions.headSize as number) <= 0
      || !['bones', 'morph', 'estimate'].includes(proportions.eyeLineSource as string)
      || !['shoulderWidth', 'armLength', 'legLength', 'restArmDeg'].every(key => nullableNumber(proportions[key]))
      || !['A', 'T', 'arms-down', 'unknown'].includes(proportions.restPose as string)) return null;
    const eyes = proportions.eyes, mouth = proportions.mouth;
    if (eyes !== null && !(isObject(eyes) && vec(eyes.left) && vec(eyes.right) && finite(eyes.spacing) && ['bones', 'morph'].includes(eyes.source as string))) return null;
    if (!isObject(mouth) || !vec(mouth.point) || !['morph', 'bone', 'estimate'].includes(mouth.source as string)) return null;
    for (const slot of MORPH_SLOTS) {
      const entry = morphs[slot];
      if (!isObject(entry) || !Number.isInteger(entry.index) || entry.policy !== SLOT_SPECS[slot].policy || !finite(entry.amplitude)
        || !finite(entry.scale) || (entry.scale as number) < MIN_SLOT_SCALE || (entry.scale as number) > MAX_SLOT_SCALE
        || !Array.isArray(entry.rejected) || entry.rejected.length > 6) return null;
      if (entry.index === -1 ? entry.name !== null : model.morphs[entry.index as number] !== entry.name) return null;
      if (!entry.rejected.every(row => isObject(row) && Number.isInteger(row.index) && name(row.name) && name(row.reason))) return null;
    }
    // Version 5: each named face shape is this model's own morph at that index.
    const shapes = value.faceShapes;
    if (!isObject(shapes) || !Object.entries(shapes).every(([shape, entry]) => isNamedFaceShape(shape) && isObject(entry) && Number.isInteger(entry.index)
      && (entry.index as number) >= 0 && model.morphs[entry.index as number] === entry.name)) return null;
    const map = bones.map;
    if (value.collision !== null && acceptCollisionProxy(value.collision, slot => isObject(map[slot])) === null) return null;
    return JSON.parse(JSON.stringify(value)) as ModelProfile;
  } catch { return null; }
}

/** Host-side shape check before persisting renderer data: bounded plain JSON of this version, no paths are expected or needed. */
export function validateStoredModelProfile(value: unknown): ModelProfile {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || text.length > 64_000) throw new Error('Invalid model profile');
  const plain = (node: unknown, depth: number): boolean => {
    if (depth > 6) return false;
    if (node === null || typeof node === 'boolean' || finite(node)) return true;
    if (typeof node === 'string') return node.length <= MAX_NAME && !node.includes('\0');
    if (Array.isArray(node)) return node.length <= 512 && node.every(item => plain(item, depth + 1));
    return isObject(node) && Object.keys(node).length <= 96 && Object.entries(node).every(([key, item]) => key.length <= 64 && plain(item, depth + 1));
  };
  if (!isObject(value) || value.version !== MODEL_PROFILE_VERSION || !plain(value, 0) || !isObject(value.morphs) || !isObject(value.counts))
    throw new Error('Invalid model profile');
  return JSON.parse(text) as ModelProfile;
}
