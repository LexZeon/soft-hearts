/**
 * Round 16: the showcase fits any MMD model by what it measures, not by a hand-tuned table per model.
 *  - Distance: the head's size (all vertices above the chin line, hair included) against the bundled Gene's decides how far she
 *    stands from the lens, so the head takes the same share of the frame whatever the model (a larger head would fill the frame
 *    and cut the waving hand off). Gene measures 1.0, so Gene's framing is exactly what it was.
 *  - Expression strength: how far each expression slot's vertices move (against the head's size), against Gene's, raises the
 *    slot's weight on a model whose shapes are subtle (capped; a stronger model is left alone). Gene's own factor is 1.0.
 * The measuring is pure (arrays in, numbers out); `fitModel` reads a loaded mesh.
 */
import { Matrix4, Vector3, type SkinnedMesh } from 'three';
import { MMD_UNIT_M } from '../../../shared/unbound/world';
import { MORPH_ALIASES, MORPH_SLOTS, type MorphSlot } from '../../../shared/foundation/universal-skeleton'; // direct, not via the actions page: the Unbound window does not take that page (docs/claude/2026-11-16-overhaul-parts-4.md)

/** The bundled Gene's measured head extent (m), see scripts/unbound/showcase-fit-check.ts. */
export const GENE_HEAD_EXTENT_M = 0.2349;
/** The bundled Gene's slot reach: the 90th-percentile vertex move of each slot the showcase drives, as a share of the head extent. */
export const GENE_SLOT_REACH: Readonly<Partial<Record<MorphSlot, number>>> = Object.freeze({
  a: 0.0979, i: 0.0199, u: 0.0821, e: 0.0346, o: 0.0925, blink: 0.092, smileEyes: 0.0685, mouthSmile: 0.013, surprise: 0.0151,
  shy: 0.0306, jitome: 0.0333, browUp: 0.0315, mouthPucker: 0.0147,
});
/** The distance scale stays inside this range, and ratios within DEAD_ZONE of 1 are taken as 1 (measuring noise). */
export const DISTANCE_SCALE_RANGE = Object.freeze({ min: 0.85, max: 1.6, deadZone: 0.04 });
/** No slot is strengthened past this. */
export const SLOT_GAIN_CAP = 1.5;
/** A ratio under this above 1 is measuring noise, not a weaker model. */
const GAIN_DEAD_ZONE = 0.05;

const quantile = (sorted: readonly number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : 0;

/** Head extent (m) from the head-frame coordinates (model units) of every vertex above the chin line: sqrt(width x height). */
export function headExtentM(xs: readonly number[], ys: readonly number[], chinY: number): number {
  const x = [...xs].sort((a, b) => a - b), y = [...ys].sort((a, b) => a - b);
  if (x.length < 50) return 0;
  return Math.sqrt((quantile(x, 0.99) - quantile(x, 0.01)) * (quantile(y, 0.995) - chinY)) * MMD_UNIT_M;
}

/** How far a model stands from the lens, as a multiple of Gene's distance: the head's size against Gene's. */
export function distanceScaleFor(extentM: number, reference = GENE_HEAD_EXTENT_M): number {
  if (!(extentM > 0) || !(reference > 0)) return 1;
  const ratio = extentM / reference, { min, max, deadZone } = DISTANCE_SCALE_RANGE;
  if (Math.abs(ratio - 1) < deadZone) return 1;
  return Math.min(max, Math.max(min, ratio));
}

/** The 90th-percentile move (model units) of the vertices a morph moves at all; 0 when it moves none (a group or material morph). */
export function morphMove(deltas: ArrayLike<number>): number {
  const moved: number[] = [];
  for (let i = 0; i + 2 < deltas.length; i += 3) { const d = Math.hypot(deltas[i], deltas[i + 1], deltas[i + 2]); if (d > 1e-4) moved.push(d); }
  moved.sort((a, b) => a - b);
  return quantile(moved, 0.9);
}

/**
 * Strength factors per slot: Gene's reach over this model's (both as a share of the head extent), 1 where this model reaches as
 * far or farther, where either is unknown, and never more than the cap.
 */
export function slotGains(own: Readonly<Partial<Record<MorphSlot, number>>>, reference: Readonly<Partial<Record<MorphSlot, number>>> = GENE_SLOT_REACH): Partial<Record<MorphSlot, number>> {
  const out: Partial<Record<MorphSlot, number>> = {};
  for (const [slot, ref] of Object.entries(reference) as [MorphSlot, number][]) {
    const mine = own[slot];
    if (!(mine && mine > 0) || !(ref > 0)) continue;
    const ratio = ref / mine;
    if (ratio > 1 + GAIN_DEAD_ZONE) out[slot] = Math.min(SLOT_GAIN_CAP, ratio);
  }
  return out;
}

/** Slot to morph index as the intent layer finds it: the profile's verified entry first, else the universal aliases by name. */
export function resolveSlotMorphs(mesh: SkinnedMesh, verified: Readonly<Partial<Record<MorphSlot, number>>>): Partial<Record<MorphSlot, number>> {
  const dictionary = mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary), out: Partial<Record<MorphSlot, number>> = {};
  for (const slot of MORPH_SLOTS) {
    const known = verified[slot];
    if (known !== undefined) { if (known >= 0) out[slot] = known; continue; }
    for (const alias of MORPH_ALIASES[slot]) { const key = keys.find(k => k.toLowerCase() === alias.toLowerCase()); if (key) { out[slot] = dictionary[key]; break; } }
  }
  return out;
}

/**
 * Where the blush comes from: the model's own blush shape when it has one, else the companion's painted cheek blush (procedural-blush.ts).
 * `force` (development, `?blush=procedural`) paints it even where the model has a shape, to look at the painted one on Gene.
 */
export function blushPath(resolved: Readonly<Partial<Record<MorphSlot, number>>>, force = false): 'morph' | 'procedural' {
  return force || resolved.shy === undefined ? 'procedural' : 'morph';
}

export interface ModelFit { headExtentM: number; distanceScale: number; slotReach: Partial<Record<MorphSlot, number>>; slotGain: Partial<Record<MorphSlot, number>> }

/** Reads a loaded mesh (bind pose): its head extent, each mapped slot's reach, and the factors that follow. */
export function fitModel(mesh: SkinnedMesh, slotMorphs: Readonly<Partial<Record<MorphSlot, number>>>): ModelFit {
  const head = mesh.skeleton.bones.find(b => b.name === '頭');
  const position = mesh.geometry.getAttribute('position');
  let extent = 0;
  if (head && position) {
    const rest = new Vector3().setFromMatrixPosition(new Matrix4().copy(mesh.skeleton.boneInverses[mesh.skeleton.bones.indexOf(head)]).invert());
    // The chin line: the lowest point of the head-weighted vertices at the front (the same as arm-reach.ts's chin, in the rest frame).
    const index = mesh.skeleton.bones.indexOf(head), skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight');
    let chinY = Infinity;
    if (skinIndex && skinWeight) for (let i = 0; i < position.count; i++) {
      let best = -1, weight = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(i, k); if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); } }
      const z = position.getZ(i) - rest.z, x = position.getX(i) - rest.x;
      if (best === index && weight > 0.5 && z > 0 && Math.abs(x) < 0.015 / MMD_UNIT_M) chinY = Math.min(chinY, position.getY(i) - rest.y);
    }
    if (Number.isFinite(chinY)) {
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < position.count; i++) { const y = position.getY(i) - rest.y; if (y > chinY) { xs.push(position.getX(i) - rest.x); ys.push(y); } }
      extent = headExtentM(xs, ys, chinY);
    }
  }
  const slotReach: Partial<Record<MorphSlot, number>> = {};
  const targets = mesh.geometry.morphAttributes.position;
  if (extent > 0 && position && targets) for (const [slot, index] of Object.entries(resolveSlotMorphs(mesh, slotMorphs)) as [MorphSlot, number][]) {
    const attribute = targets[index];
    if (!attribute) continue;
    const deltas: number[] = [];
    for (let i = 0; i < position.count; i++) deltas.push(attribute.getX(i) - position.getX(i), attribute.getY(i) - position.getY(i), attribute.getZ(i) - position.getZ(i));
    const move = morphMove(deltas) * MMD_UNIT_M;
    if (move > 0) slotReach[slot] = move / extent;
  }
  return { headExtentM: extent, distanceScale: distanceScaleFor(extent), slotReach, slotGain: slotGains(slotReach) };
}
