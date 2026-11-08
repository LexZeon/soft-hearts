import type { BufferGeometry } from 'three';

export interface BlushChannel { index: number; name: string }
type MorphGeometry = Pick<BufferGeometry, 'getAttribute' | 'morphAttributes' | 'morphTargetsRelative'>;

// Gene's four aliases have identical offsets. Select one; never sum their weights.
const aliases = [
  '赤み', '頬照り', '照れ', 'cheek_blush_geo_C',
  'blush', 'cheekBlush', 'faceBlush', '赤面', '頬赤', '紅潮', '脸红', '臉紅', '红晕', '紅暈',
];
const negative = /消|隠|非表示|無効|off|hide|hidden|remove|disable|clear|no[\s_-]*blush|隐藏|消除|关闭|關閉/i;
const normalize = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g, '');
const normalizedAliases = aliases.map(normalize);

/**
 * Conservative vertex-channel discovery, not a claim that the blush is visually verified.
 * UV/material-only placeholders have zero position deltas and are deliberately rejected.
 * Locality bounds are experimental safety limits: <=25% of vertices, a <=35% model-diagonal
 * source region, and <=5% model-diagonal displacement. They do not alter source geometry.
 */
export function selectBlushChannel(
  dictionary: Record<string, number> | null | undefined,
  geometry: MorphGeometry,
): BlushChannel | null {
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) return null;
  const base = geometry.getAttribute('position');
  const targets = geometry.morphAttributes.position;
  if (!base || base.itemSize !== 3 || !Number.isInteger(base.count) || base.count < 2 || !Array.isArray(targets)) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < base.count; vertex++) {
    const point = [base.getX(vertex), base.getY(vertex), base.getZ(vertex)];
    if (!point.every(Number.isFinite)) return null;
    for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], point[c]); max[c] = Math.max(max[c], point[c]); }
  }
  const diagonal = Math.hypot(...max.map((value, c) => value - min[c]));
  if (!Number.isFinite(diagonal) || diagonal <= 0) return null;
  const epsilon = diagonal * 1e-7;
  const maximumAffected = Math.floor(base.count * 0.25);
  if (maximumAffected === 0) return null;

  function usable(index: number, name: string): boolean {
    const target = targets[index];
    if (!target || target.itemSize !== 3 || target.count !== base.count) return false;
    if (target.name && normalize(target.name) !== normalize(name)) return false;
    let affected = 0;
    const regionMin = [Infinity, Infinity, Infinity], regionMax = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < base.count; vertex++) {
      const point = [target.getX(vertex), target.getY(vertex), target.getZ(vertex)];
      if (!point.every(Number.isFinite)) return false;
      const original = [base.getX(vertex), base.getY(vertex), base.getZ(vertex)];
      const delta = geometry.morphTargetsRelative ? point : point.map((value, c) => value - original[c]);
      const length = Math.hypot(...delta);
      if (!Number.isFinite(length) || length > diagonal * 0.05) return false;
      if (length <= epsilon) continue;
      if (++affected > maximumAffected) return false;
      for (let c = 0; c < 3; c++) { regionMin[c] = Math.min(regionMin[c], original[c]); regionMax[c] = Math.max(regionMax[c], original[c]); }
    }
    return affected > 0 && Math.hypot(...regionMax.map((value, c) => value - regionMin[c])) <= diagonal * 0.35;
  }

  const candidates = Object.entries(dictionary).filter(([name, index]) =>
    !negative.test(name.normalize('NFKC')) && normalizedAliases.includes(normalize(name))
    && Number.isInteger(index) && index >= 0 && index < targets.length);
  candidates.sort(([left], [right]) => normalizedAliases.indexOf(normalize(left)) - normalizedAliases.indexOf(normalize(right)));
  for (const [name, index] of candidates) if (usable(index, name)) return { index, name };
  return null;
}
