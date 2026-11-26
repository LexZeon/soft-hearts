/**
 * 小表情接管时，脸上原来的表情不"瞬间消失再瞬间回来" (docs/claude/2026-11-10-face-head-twitch.md, round 2). A face shape (face-exclusive.ts) owns its whole conflict group: every morph that moves any
 * vertex the shape moves. On a real model that group is most of the eye's mood morphs (one model: 25 for the wink, 21 for the
 * pout, all with large overlaps). A bilateral smile-eye is in the wink's group, so a one-eyed wink took the smile off BOTH eyes in
 * 0.08 s and gave it back after: the eye that never winked flicked open and shut again.
 *
 * What this keeps: the part of a base morph that lies OUTSIDE the region the shape owns, re-expressed with other morphs of the same
 * mesh that do not touch that region (the other eye's own single-side morph, or the base morph itself when only a sliver of it
 * overlaps). Morph weights are global (one number per morph, not per vertex), so a bilateral smile cannot be "half kept" on its
 * own; its outside part is matched by geometry, never by name:
 *  - the owned region m(v) ∈ [0, 1] per vertex: how much the shape's own morphs move it, relative to their largest movement
 *    (full ownership from OWNED_FULL of that on, quadratic below: a brow the wink pulls by a few percent stays the brow's);
 *  - the outside part O_i = (1 − m)·D_i of base morph i (D_i its per-vertex offsets);
 *  - up to KEEP_PARTNERS partners p (i itself among the candidates) that move the owned region by at most PARTNER_OWNED of their
 *    own energy, chosen greedily by the energy they explain, with positive scales s_p; accepted only if the leftover is at most
 *    KEEP_RESIDUAL of O_i (otherwise nothing is kept: as before).
 * The face exclusive then writes Y_i = (1 − w)·B_i as before, and adds w·s_p·B_i to each partner: at w = 0 exactly B, at w = 1 the
 * owned region shows only the shape (no double closure: partners do not move it), the rest of the face shows what it showed.
 * Linear in w and B, so value and speed stay continuous wherever the face exclusive's own w is.
 *
 * Read once per (shape, base morph) from the geometry and cached per mesh.
 */
import type { FaceMesh } from './face-exclusive';

/** A vertex is fully owned once the shape moves it by this fraction of the shape's largest movement (quadratic below). */
export const OWNED_FULL = 0.25;
/** A partner may put at most this fraction of its own energy on the owned region (it must not close the winking eye again). */
export const PARTNER_OWNED = 0.05;
/** Kept only when the partners explain all but this fraction of the outside part. */
export const KEEP_RESIDUAL = 0.3;
/** Partners per base morph (greedy). */
export const KEEP_PARTNERS = 3;
/** Below this fraction of a base morph's energy outside the owned region, nothing is worth keeping. */
const OUTSIDE_MIN = 0.05;

export interface KeepPart { index: number; scale: number }
interface Attr { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }

export class FaceKeep {
  private readonly masks = new Map<string, Float32Array>();
  private readonly parts = new Map<string, readonly KeepPart[]>();
  private readonly energy = new Map<number, { total: number; owned: Map<string, number> }>();

  constructor(private readonly mesh: FaceMesh, private readonly displaced: (index: number) => Int32Array) {}

  /** The owned region of a shape on these morphs, per vertex (cached by the sorted targets). */
  mask(targets: readonly number[]): Float32Array | null {
    const key = [...new Set(targets)].sort((a, b) => a - b).join(',');
    const cached = this.masks.get(key);
    if (cached) return cached;
    const geometry = this.mesh.geometry, base = geometry?.getAttribute('position'), morphs = geometry?.morphAttributes?.position;
    if (!base || !morphs) return null;
    const relative = geometry?.morphTargetsRelative === true, size = new Float32Array(base.count);
    let peak = 0;
    for (const index of new Set(targets)) {
      const target = morphs[index];
      if (!target) continue;
      for (const vertex of this.displaced(index)) {
        const length = Math.sqrt(offset2(target, base, relative, vertex));
        if (length > size[vertex]) size[vertex] = length;
        if (length > peak) peak = length;
      }
    }
    if (peak > 0) for (let vertex = 0; vertex < size.length; vertex++) size[vertex] = Math.min(1, (size[vertex] / (OWNED_FULL * peak)) ** 2);
    this.masks.set(key, size);
    return size;
  }

  /**
   * How to keep base morph `index` outside the owned region of a shape on `targets`: partner morphs and scales (the morph itself
   * may be one), or [] when nothing is kept. `exclude`: morphs never used as partners (the shape's own).
   */
  keep(targets: readonly number[], index: number, exclude: ReadonlySet<number>): readonly KeepPart[] {
    const key = `${[...new Set(targets)].sort((a, b) => a - b).join(',')}|${index}`;
    const cached = this.parts.get(key);
    if (cached) return cached;
    const result = this.solve(targets, index, exclude);
    this.parts.set(key, result);
    return result;
  }

  private solve(targets: readonly number[], index: number, exclude: ReadonlySet<number>): readonly KeepPart[] {
    const geometry = this.mesh.geometry, base = geometry?.getAttribute('position'), morphs = geometry?.morphAttributes?.position;
    const mask = this.mask(targets), own = morphs?.[index];
    if (!base || !morphs || !mask || !own || own.count !== base.count || own.itemSize !== 3) return [];
    const relative = geometry?.morphTargetsRelative === true;
    // The outside part O_i, as the starting residual (dense, only its own vertices are non-zero).
    const residual = new Float64Array(base.count * 3), support: number[] = [];
    let total = 0, outside = 0;
    for (const vertex of this.displaced(index)) {
      const keep = 1 - mask[vertex], x = dx(own, base, relative, vertex), y = dy(own, base, relative, vertex), z = dz(own, base, relative, vertex);
      const e = x * x + y * y + z * z;
      total += e;
      if (keep <= 0) continue;
      residual[vertex * 3] = keep * x; residual[vertex * 3 + 1] = keep * y; residual[vertex * 3 + 2] = keep * z;
      outside += keep * keep * e;
      support.push(vertex);
    }
    if (!(total > 0) || outside < OUTSIDE_MIN * total) return [];
    // Candidates: every morph that moves a vertex of the outside part and leaves the owned region alone.
    const candidates: { index: number; energy: number }[] = [];
    const count = Math.min(this.mesh.morphTargetInfluences?.length ?? 0, morphs.length);
    for (let p = 0; p < count; p++) {
      if (exclude.has(p)) continue;
      const target = morphs[p];
      if (!target || target.count !== base.count || target.itemSize !== 3) continue;
      if (p !== index && !support.some(vertex => offset2(target, base, relative, vertex) > 1e-14)) continue;
      const stats = this.stats(p, targets, mask);
      if (!(stats.total > 0) || stats.owned > PARTNER_OWNED * stats.total) continue;
      candidates.push({ index: p, energy: stats.total });
    }
    let left = outside;
    const parts: KeepPart[] = [];
    for (let step = 0; step < KEEP_PARTNERS && candidates.length; step++) {
      let best = -1, bestGain = 0, bestScale = 0;
      for (let c = 0; c < candidates.length; c++) {
        const { index: p, energy } = candidates[c], target = morphs[p];
        let dot = 0;
        for (const vertex of this.displaced(p)) {
          dot += dx(target, base, relative, vertex) * residual[vertex * 3] + dy(target, base, relative, vertex) * residual[vertex * 3 + 1]
            + dz(target, base, relative, vertex) * residual[vertex * 3 + 2];
        }
        if (!(dot > 0)) continue;
        const gain = dot * dot / energy, scale = dot / energy;
        // Equal shapes at another size (a duplicate morph): the one that keeps the weight nearest its own (scale nearest 1).
        const tie = best >= 0 && Math.abs(gain - bestGain) <= 1e-9 * outside;
        if (gain > bestGain + 1e-9 * outside || (tie && Math.abs(Math.log(scale)) < Math.abs(Math.log(bestScale)))) { best = c; bestGain = gain; bestScale = scale; }
      }
      if (best < 0 || bestGain < 0.02 * outside) break;
      const p = candidates[best].index, target = morphs[p];
      for (const vertex of this.displaced(p)) {
        residual[vertex * 3] -= bestScale * dx(target, base, relative, vertex);
        residual[vertex * 3 + 1] -= bestScale * dy(target, base, relative, vertex);
        residual[vertex * 3 + 2] -= bestScale * dz(target, base, relative, vertex);
      }
      left -= bestGain;
      parts.push({ index: p, scale: bestScale });
      candidates.splice(best, 1);
      if (left <= 0.01 * outside) break;
    }
    return left <= KEEP_RESIDUAL * outside ? parts : [];
  }

  /** A morph's energy, and how much of it lies on the owned region of `targets` (cached). */
  private stats(index: number, targets: readonly number[], mask: Float32Array): { total: number; owned: number } {
    const key = [...new Set(targets)].sort((a, b) => a - b).join(',');
    let entry = this.energy.get(index);
    if (!entry) {
      const geometry = this.mesh.geometry!, base = geometry.getAttribute('position')!, target = geometry.morphAttributes!.position![index];
      const relative = geometry.morphTargetsRelative === true;
      let total = 0;
      for (const vertex of this.displaced(index)) total += offset2(target, base, relative, vertex);
      entry = { total, owned: new Map() };
      this.energy.set(index, entry);
    }
    let owned = entry.owned.get(key);
    if (owned === undefined) {
      const geometry = this.mesh.geometry!, base = geometry.getAttribute('position')!, target = geometry.morphAttributes!.position![index];
      const relative = geometry.morphTargetsRelative === true;
      owned = 0;
      for (const vertex of this.displaced(index)) owned += mask[vertex] * offset2(target, base, relative, vertex);
      entry.owned.set(key, owned);
    }
    return { total: entry.total, owned };
  }
}

const dx = (t: Attr, b: Attr, relative: boolean, v: number) => t.getX(v) - (relative ? 0 : b.getX(v));
const dy = (t: Attr, b: Attr, relative: boolean, v: number) => t.getY(v) - (relative ? 0 : b.getY(v));
const dz = (t: Attr, b: Attr, relative: boolean, v: number) => t.getZ(v) - (relative ? 0 : b.getZ(v));
function offset2(t: Attr, b: Attr, relative: boolean, v: number): number {
  const x = dx(t, b, relative, v), y = dy(t, b, relative, v), z = dz(t, b, relative, v);
  return x * x + y * y + z * z;
}
