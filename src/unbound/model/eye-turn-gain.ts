/**
 * How far her eye bones turn for a look, from the model's own eyes and lids (docs/claude/2026-11-20-mumi-eye-skin.md).
 *
 * The eye-head coordinator (src/stage/eye-head.ts) speaks in degrees, and its limits were tuned on the bundled Gene: at her soft
 * limit up (9°) the upper lid covers about a fifth of her iris, and her thick lid line hides that. A model converted from VRoid has
 * an iris as tall as the eye opening, already a tenth under the upper lid at rest; the same 9° slid it a third further under, and
 * where the lid line thins toward the nose the lid's bare skin showed over the pupil.
 * Its VRM said how far its eyes may turn (lookAt range maps); the PMX it was converted to cannot carry that, and MMD models never had it.
 *
 * The rule, for every model: at the coordinator's soft limit the upper lid covers no more of her iris than Gene's covers of hers.
 * Measured once per model from its own data: the iris is what the eye bone moves (the front half of its vertices), the upper lid's
 * edge is where the model's own blink moves the lid furthest (above the iris, across its width). How much the lid covers at rest,
 * and how much one degree adds (the iris's distance from its pivot), give the turn that reaches Gene's cover; the eye bones then
 * take `that turn / the soft limit` of every look (never more than the look: Gene and any eye with as much room turn exactly as
 * before; never below `EYE_TURN_GAIN_MIN`). One share for both axes and both eyes (the smaller eye's): the upper lid is the
 * tightest room, and the eyes keep moving together. Anything the model does not measure (no blink, no vertices of the eye bone's
 * own) is left as it was.
 */
import type { Bone, SkinnedMesh } from 'three';
import { MORPH_ALIASES } from '../../../shared/foundation/universal-skeleton';

/** One eye as the rule reads it (model units, rest pose). */
export interface EyeRoom {
  /** The iris's height, the distance from its pivot to its surface, and how far its top sits under the upper lid's edge (+ = under). */
  irisHeight: number;
  lever: number;
  coverAtRest: number;
}

/** How much of her iris (its height) the upper lid may cover at the soft limit up: Gene's (0.229 and 0.222 measured) and a hair. */
export const LID_COVER_REFERENCE = 0.235;
/** The eyes never take less than this share of a look (a broken measurement must not freeze them). */
export const EYE_TURN_GAIN_MIN = 0.2;
const DEG = Math.PI / 180;

/** The model's own blink morph by the universal names (the first found, any case); -1 when it has none. */
export function blinkMorph(mesh: Pick<SkinnedMesh, 'morphTargetDictionary'>): number {
  const dictionary = mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary);
  for (const alias of MORPH_ALIASES.blink) { const key = keys.find(k => k.toLowerCase() === alias.toLowerCase()); if (key) return dictionary[key]; }
  return -1;
}

const quantile =(sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/**
 * The model's face as the rule reads it, at rest, in the model's frame (+y up, +z her front): each vertex's place, the bone that moves it
 * most (`owner`, -1: none) and how far her blink moves it down (`dy`, negative = down). An MMD mesh gives its own vertices
 * (measureEyeRooms); I-164 a VRM gives its face meshes' (vrm-eye-room.ts).
 */
export interface EyeFace {
  count: number;
  x(i: number): number; y(i: number): number; z(i: number): number;
  owner: Int32Array;
  dy(i: number): number;
}

/** Each eye's room (null for an eye it cannot measure). `blink`: the model's blink morph index (-1: none). */
export function measureEyeRooms(mesh: SkinnedMesh, eyes: readonly Bone[], blink: number): (EyeRoom | null)[] {
  const geometry = mesh.geometry, position = geometry.getAttribute('position'), skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
  const morph = blink >= 0 ? geometry.morphAttributes.position?.[blink] : undefined;
  if (!position || !skinIndex || !skinWeight || !morph) return eyes.map(() => null);
  const bones = mesh.skeleton.bones, owner = new Int32Array(position.count).fill(-1);
  for (let i = 0; i < position.count; i++) {
    let weight = 0;
    for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(i, k); if (w > weight) { weight = w; owner[i] = skinIndex.getComponent(i, k); } }
  }
  const relative = geometry.morphTargetsRelative;
  const face: EyeFace = { count: position.count, x: i => position.getX(i), y: i => position.getY(i), z: i => position.getZ(i), owner,
    dy: i => relative ? morph.getY(i) : morph.getY(i) - position.getY(i) };
  return eyes.map(eye => {
    const index = bones.indexOf(eye);
    if (index < 0) return null;
    const e = mesh.skeleton.boneInverses[index].clone().invert().elements;
    return eyeRoomOf(face, index, { x: e[12], y: e[13], z: e[14] });
  });
}

/** One eye's room from the face: the eye is the vertices `owner` names, turning about `pivot`. */
export function eyeRoomOf(face: EyeFace, index: number, pivot: { x: number; y: number; z: number }): EyeRoom | null {
  const owner = face.owner, position = { getX: face.x, getY: face.y, getZ: face.z, count: face.count };
  const points: number[] = [];
  for (let i = 0; i < position.count; i++) if (owner[i] === index) points.push(i);
  if (points.length < 12) return null;
  const zs = points.map(i => position.getZ(i)).sort((a, b) => a - b), middle = quantile(zs, 0.5);
  const front = points.filter(i => position.getZ(i) >= middle);
  const ys = front.map(i => position.getY(i)).sort((a, b) => a - b), xs = front.map(i => position.getX(i)).sort((a, b) => a - b);
  const top = quantile(ys, 0.95), bottom = quantile(ys, 0.05), left = quantile(xs, 0.05), right = quantile(xs, 0.95);
  const center = { x: (left + right) / 2, y: (top + bottom) / 2, z: quantile(zs, 0.85) };
  const irisHeight = top - bottom;
  // The upper lid: what the blink moves down, above the iris's middle and across its width, not the eye's own vertices.
  const lid: { y: number; dy: number }[] = [];
  for (let i = 0; i < position.count; i++) {
    if (owner[i] === index) continue;
    const x = position.getX(i), y = position.getY(i);
    if (x < left || x > right || y < center.y) continue;
    const dy = face.dy(i);
    if (dy < 0) lid.push({ y, dy });
  }
  if (lid.length < 5 || !(irisHeight > 1e-6)) return null;
  const most = lid.reduce((m, l) => Math.min(m, l.dy), 0);
  const edge = lid.filter(l => l.dy <= 0.85 * most).map(l => l.y).sort((a, b) => a - b);
  const lever = Math.hypot(center.x - pivot.x, center.y - pivot.y, center.z - pivot.z);
  if (!edge.length || !(lever > 1e-6)) return null;
  return { irisHeight, lever, coverAtRest: (top - quantile(edge, 0.5)) / irisHeight };
}

/** The turn (degrees) that brings this eye's lid cover to the reference. */
export function eyeTurnToReference(room: EyeRoom): number {
  return (LID_COVER_REFERENCE - room.coverAtRest) / (room.lever * DEG / room.irisHeight);
}

/**
 * How much of a look her eye bones take (0..1]: 1 for Gene and any eye with as much room, less for an iris that fills its opening.
 * `softUpDeg`: the eye-head coordinator's soft limit up (its EYE_HEAD_DEFAULTS, 9°; the figure passes its own).
 */
export function eyeTurnGain(rooms: readonly (EyeRoom | null)[], softUpDeg: number): number {
  const measured = rooms.filter((room): room is EyeRoom => room !== null);
  if (measured.length !== rooms.length || !measured.length) return 1;
  const turn = Math.min(...measured.map(eyeTurnToReference));
  if (!Number.isFinite(turn) || turn >= softUpDeg) return 1;
  return Math.max(EYE_TURN_GAIN_MIN, turn / softUpDeg);
}
