/**
 * Unbound U1 part 2: balance geometry (docs/claude/2026-11-12-unbound-u1-part2.md). Pure math, meters on her floor (x across,
 * z toward the viewer; y is never needed here).
 *
 * - Her centre of mass is an *animation proxy* (Codex c228 §2): segment weights are a textbook-style split of a body (head,
 *   trunk, arms, legs), each segment's mass at the middle of its bones; never one weight per bone (hair and skirt helper bones
 *   are not body mass) and never claimed as her real weight distribution.
 * - The support region is the convex hull of the patches of the feet that are actually in contact (a lifted foot leaves it).
 * - The margin is the signed distance from the COM's floor point to that region's edge (+ inside).
 */
export interface Point2 { x: number; z: number }

/**
 * Segments of the COM proxy: bone names (MMD first, then common English) for the two ends, and the share of the body.
 * Shares follow the usual anthropometric split (head-neck 8.1, trunk 49.7, upper arm 2.8, forearm 1.6, hand 0.6, thigh 10,
 * shank 4.65, foot 1.45 per cent) — a proxy for how she moves, not a measurement of the model.
 */
export const COM_SEGMENTS: readonly { name: string; from: readonly string[]; to: readonly string[]; share: number }[] = Object.freeze([
  { name: 'head', from: ['首', 'neck', 'Neck'], to: ['頭先', '頭', 'head', 'Head'], share: 0.081 },
  { name: 'trunk', from: ['下半身', 'センター', 'hips', 'Hips'], to: ['首', 'neck', 'Neck'], share: 0.497 },
  ...(['左', '右'] as const).flatMap(side => {
    const en = side === '左' ? 'Left' : 'Right';
    return [
      { name: `${side}upperArm`, from: [`${side}腕`, `${en}Arm`], to: [`${side}ひじ`, `${en}ForeArm`], share: 0.028 },
      { name: `${side}forearm`, from: [`${side}ひじ`, `${en}ForeArm`], to: [`${side}手首`, `${en}Hand`], share: 0.016 },
      { name: `${side}hand`, from: [`${side}手首`, `${en}Hand`], to: [`${side}中指１`, `${side}手先`, `${en}HandMiddle1`], share: 0.006 },
      { name: `${side}thigh`, from: [`${side}足`, `${en}UpLeg`], to: [`${side}ひざ`, `${en}Leg`], share: 0.1 },
      { name: `${side}shank`, from: [`${side}ひざ`, `${en}Leg`], to: [`${side}足首`, `${en}Foot`], share: 0.0465 },
      { name: `${side}foot`, from: [`${side}足首`, `${en}Foot`], to: [`${side}足先`, `${side}つま先`, `${en}ToeBase`], share: 0.0145 },
    ];
  }),
]);

/** Weighted mean of segment middles (segments whose bones are missing drop out; the rest are renormalized). */
export function centerOfMass(segments: readonly { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number }; share: number }[]): { x: number; y: number; z: number } | null {
  let total = 0, x = 0, y = 0, z = 0;
  for (const s of segments) {
    if (!(s.share > 0)) continue;
    total += s.share;
    x += s.share * (s.a.x + s.b.x) / 2; y += s.share * (s.a.y + s.b.y) / 2; z += s.share * (s.a.z + s.b.z) / 2;
  }
  return total > 0 ? { x: x / total, y: y / total, z: z / total } : null;
}

/** A foot's contact patch on the floor: heel and toe along its yaw, a little wide. Corners in order. */
export interface FootSize { heel: number; toe: number; halfWidth: number }
export function footPatch(ankle: Point2, yaw: number, size: FootSize): Point2[] {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), sx = Math.cos(yaw), sz = -Math.sin(yaw);
  const at = (forward: number, side: number) => ({ x: ankle.x + fx * forward + sx * side, z: ankle.z + fz * forward + sz * side });
  return [at(-size.heel, -size.halfWidth), at(size.toe, -size.halfWidth), at(size.toe, size.halfWidth), at(-size.heel, size.halfWidth)];
}

/** Convex hull, counter-clockwise in (x, z) (monotone chain). */
export function convexHull(points: readonly Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point2, a: Point2, b: Point2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Point2[] = [], upper: Point2[] = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = sorted.length - 1; i >= 0; i--) { const p = sorted[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Signed distance from `p` to the edge of a convex polygon (counter-clockwise): + inside, − outside. -Infinity for no support. */
export function supportMargin(p: Point2, hull: readonly Point2[]): number {
  if (hull.length < 3) return -Infinity;
  let inside = true, nearest = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x, ez = b.z - a.z, length = Math.hypot(ex, ez) || 1e-12;
    // Counter-clockwise: the inside is to the left of each edge.
    const side = (ex * (p.z - a.z) - ez * (p.x - a.x)) / length;
    if (side < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / (length * length)));
    nearest = Math.min(nearest, Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t)));
  }
  return inside ? nearest : -nearest;
}

/** The middle of a polygon (vertex mean; enough for a hull of one or two foot patches). */
export function polygonCenter(points: readonly Point2[]): Point2 {
  let x = 0, z = 0;
  for (const p of points) { x += p.x; z += p.z; }
  return points.length ? { x: x / points.length, z: z / points.length } : { x: 0, z: 0 };
}
