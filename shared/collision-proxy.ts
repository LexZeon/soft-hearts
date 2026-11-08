/**
 * Collision proxy, adaptation layer step 3 groundwork (handbook/roadmap.md,
 * 物理层「碰撞代理」): a set of capsules fitted to the model's own skinned
 * vertices at rest, one per body segment (pelvis/abdomen/chest/neck/head, upper
 * arm/forearm/hand, thigh/shin per side). Part of the model profile, cached with
 * it. The same proxy is meant for hair/skirt collision, arm de-penetration and
 * interaction regions; today the motion check (shared/motion-fit.ts) uses it.
 *
 * Fit, per segment:
 * - Bones are classified first. Standard bones drive their segment; twist/link
 *   bones follow their 付与 source or nearest standard ancestor; "D" deform
 *   bones follow the bone they copy; breast bones join the chest. Hair, skirt,
 *   cloak, sleeve and accessory chains (by name) and every bone carrying a
 *   dynamic rigid body (physics) are excluded with all their descendants, unless
 *   they lie on the path to a standard bone.
 * - A vertex belongs to a segment when at least `minWeight` of its skin weight
 *   (BDEF1/2/4, SDEF as its two weights) is on that segment's bones and at most
 *   `maxExcluded` is on excluded chains (hair roots, skirt waistbands).
 * - The axis direction comes from the joints (head: straight up; hand: along
 *   the forearm). Vertices farther than twice the upper-quartile distance from
 *   the median axis are dropped (a badge or strap skinned to the chest). The
 *   axis is then centred on the rest (mid-range of the 5th..95th percentiles
 *   across it), the length is the 2nd..98th percentile along it (inside a
 *   per-segment window around the bone, so a rigid long skirt or long hair
 *   skinned to a body bone cannot stretch it far), and the radius is the 60th
 *   percentile of the distances from the axis over the segment's middle part.
 *   Quantiles only: outliers cannot inflate it, and the result does not depend
 *   on vertex order.
 * Capsule endpoints are in model rest space (MMD bones carry no rest rotation,
 * so a posed point is bonePos + boneRot·(p − boneRest)). Pure numbers in,
 * plain JSON out, rounded so the same input always serializes the same.
 */
import type { StandardBone, Vec3 } from './model-profile';

/** Bump whenever classification, windows, quantiles or the output shape change. */
export const COLLISION_PROXY_VERSION = 1;

export const PROXY_SEGMENTS = ['pelvis', 'abdomen', 'chest', 'neck', 'head',
  'upperArmLeft', 'forearmLeft', 'handLeft', 'upperArmRight', 'forearmRight', 'handRight',
  'thighLeft', 'shinLeft', 'thighRight', 'shinRight'] as const;
export type ProxySegment = typeof PROXY_SEGMENTS[number];
export const TORSO_SEGMENTS: readonly ProxySegment[] = Object.freeze(['pelvis', 'abdomen', 'chest', 'neck']);

export interface ProxyCapsule {
  segment: ProxySegment;
  /** Standard bone whose motion carries the capsule. */
  bone: StandardBone;
  /** Axis endpoints, model rest space. a == b is a sphere. */
  a: Vec3;
  b: Vec3;
  radius: number;
  /** Vertices that defined it. */
  vertices: number;
}
export interface CollisionProxy {
  version: typeof COLLISION_PROXY_VERSION;
  capsules: ProxyCapsule[];
  /** Segments the model has no (or too few) vertices for. */
  missing: ProxySegment[];
  /** Bones and vertices left out as hair/skirt/accessory/physics. */
  excluded: { bones: number; vertices: number };
}

export interface ProxyBone {
  name: string;
  parent: number;
  position: Vec3;
  /** Carries a dynamic rigid body (MMD physics mode 1 or 2). */
  physics?: boolean;
  /** 付与 source (rotation/position inherited from another bone) and its ratio. */
  grant?: { parent: number; ratio: number };
}
export interface ProxySkin {
  /** `width` bone indices per vertex. */
  indices: ArrayLike<number>;
  /** `width` weights per vertex (zero for unused slots). */
  weights: ArrayLike<number>;
  width: number;
}
export interface CollisionProxyInput {
  /** Rest vertex positions, xyz per vertex (MMDLoader model space: +y up, face toward +z, model's left at +x). */
  positions: ArrayLike<number>;
  skin: ProxySkin;
  bones: readonly ProxyBone[];
  /** Standard-bone slots (the profile's bone map). */
  slots: Partial<Record<StandardBone, number>>;
  /** Standard slot for a bone name (aliases), for "D" deform bones. */
  slotOfName?: (name: string) => StandardBone | null;
  /** Head frame from the profile, bounding the head capsule. */
  head?: { chinY: number; crownY: number; headSize: number };
}

export interface ProxyParams {
  /** Share of a vertex's weight that must be on one segment's bones. */
  minWeight: number;
  /** Largest share allowed on excluded (hair/skirt/physics) bones. */
  maxExcluded: number;
  /** Quantile of the distances from the axis used as the radius. */
  radiusQuantile: number;
  /** Axis centre: mid-range of these lower/upper quantiles across the axis. */
  centerQuantile: number;
  /** Axial extent: these lower/upper quantiles along the axis. */
  extentQuantile: number;
  /** The radius is measured on the middle of the extent, leaving this share at each end (the rounded ends). */
  coreTrim: number;
  /** Vertices farther from the median axis than this many upper-quartile distances are dropped before fitting. */
  outlierFactor: number;
  minVertices: number;
}
export const PROXY_PARAMS: Readonly<ProxyParams> = Object.freeze({
  minWeight: 0.5, maxExcluded: 0.1, radiusQuantile: 0.6, centerQuantile: 0.05, extentQuantile: 0.02, coreTrim: 0.15, outlierFactor: 2, minVertices: 16,
});

// ---------------------------------------------------------------- bone classes

/** Names that are never body volume. CJK by substring; Latin by word (camelCase and separators split). */
const EXCLUDED_CJK = /髪|髮|头发|頭髮|发尾|发梢|前发|后发|もみあげ|アホ毛|あほ毛|前毛|後毛|おさげ|三つ編|ツインテ|ポニテ|スカート|裙|すそ|裾|クローク|マント|ケープ|コート|フリル|袖|リボン|ネクタイ|マフラー|スカーフ|フード|エプロン|ドレス|ローブ|イヤリング|ピアス|ネックレス|ペンダント|帽|髪飾|飾り|アクセ|尻尾|しっぽ|翼|羽|紐|鎖|武器|剣|杖|鞄|カバン|耳|ケモミミ|獣耳|猫耳|ribbon/u;
const EXCLUDED_WORDS = new Set(['hair', 'bang', 'bangs', 'ponytail', 'twintail', 'braid', 'ahoge', 'skirt', 'hem', 'cloak', 'cape', 'mantle', 'coat', 'frill', 'sleeve',
  'ribbon', 'tie', 'necktie', 'scarf', 'hood', 'apron', 'dress', 'robe', 'earring', 'pierce', 'piercing', 'necklace', 'pendant', 'hat', 'cap', 'ornament',
  'accessory', 'acc', 'tail', 'wing', 'wings', 'ear', 'ears', 'string', 'chain', 'weapon', 'sword', 'staff', 'bag', 'cloth']);
const BREAST_CJK = /乳|胸|おっぱい/u;
const BREAST_WORDS = new Set(['breast', 'bust', 'boob', 'boobs', 'oppai']);
function words(name: string): string[] {
  return name.normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}
const excludedName = (name: string) => EXCLUDED_CJK.test(name.normalize('NFKC')) || words(name).some(word => EXCLUDED_WORDS.has(word));
const breastName = (name: string) => BREAST_CJK.test(name.normalize('NFKC')) || words(name).some(word => BREAST_WORDS.has(word));

const NONE = -1, EXCLUDED = -2;
type BoneClass = number; // segment index, NONE or EXCLUDED

function slotSegment(slot: StandardBone, slots: CollisionProxyInput['slots']): ProxySegment | null {
  const side = slot.endsWith('Left') ? 'Left' : slot.endsWith('Right') ? 'Right' : '';
  switch (slot.replace(/(Left|Right)$/, '')) {
    case 'lowerBody': case 'waist': return 'pelvis';
    case 'upperBody': return slots.upperBody2 !== undefined ? 'abdomen' : 'chest';
    case 'upperBody2': return 'chest';
    case 'neck': return 'neck';
    case 'head': case 'eyes': case 'eye': return 'head';
    case 'arm': case 'armTwist': return `upperArm${side}` as ProxySegment;
    case 'elbow': case 'wristTwist': return `forearm${side}` as ProxySegment;
    case 'wrist': return `hand${side}` as ProxySegment;
    case 'leg': return `thigh${side}` as ProxySegment;
    case 'knee': return `shin${side}` as ProxySegment;
    default: return null; // root, center, groove, shoulders, feet, IK: not fitted
  }
}

/** Per bone: segment index, NONE (not a fitted segment) or EXCLUDED. */
export function classifyProxyBones(input: Pick<CollisionProxyInput, 'bones' | 'slots' | 'slotOfName'>): BoneClass[] {
  const { bones, slots } = input, count = bones.length;
  const parentOf = (index: number) => { const parent = bones[index].parent; return Number.isInteger(parent) && parent >= 0 && parent < count && parent !== index ? parent : -1; };
  const slotOf = new Map<number, StandardBone>();
  for (const [slot, index] of Object.entries(slots) as [StandardBone, number][]) if (Number.isInteger(index) && index >= 0 && index < count && !slotOf.has(index)) slotOf.set(index, slot);
  // Bones on the path to a standard bone are never excluded (a "Hair_Root" above the head would otherwise take the head with it).
  const carriesBody = new Uint8Array(count);
  for (const index of slotOf.keys()) for (let at = index, guard = 0; at >= 0 && guard <= count; at = parentOf(at), guard++) carriesBody[at] = 1;
  const segmentIndex = (segment: ProxySegment | null) => segment === null ? NONE : PROXY_SEGMENTS.indexOf(segment);
  const torsoSlots = new Set<StandardBone>(['upperBody', 'upperBody2', 'waist', 'lowerBody']);
  const result: BoneClass[] = new Array(count);
  const state = new Uint8Array(count);
  const visit = (index: number): BoneClass => {
    if (state[index] === 2) return result[index];
    if (state[index] === 1) return NONE; // grant/parent cycle
    state[index] = 1;
    const bone = bones[index], slot = slotOf.get(index), parent = parentOf(index);
    let value: BoneClass;
    if (slot) value = segmentIndex(slotSegment(slot, slots));
    else if (!carriesBody[index] && (bone.physics === true && !breastName(bone.name) || excludedName(bone.name))) value = EXCLUDED;
    else if (parent >= 0 && !carriesBody[index] && visit(parent) === EXCLUDED) value = EXCLUDED;
    else {
      // A "D" deform bone moves exactly like the bone it is named after; a 付与 link (≥ half) like its source (a shoulder link stays a shoulder).
      const deform = /^(.*?)[dDＤ]$/u.exec(bone.name.normalize('NFKC').trim().replace(/[\s_.\-]+$/u, ''));
      const copied = deform && input.slotOfName ? input.slotOfName(deform[1]) : null;
      const grant = bone.grant && Number.isInteger(bone.grant.parent) && bone.grant.parent >= 0 && bone.grant.parent < count
        && Math.abs(bone.grant.ratio) >= 0.5 ? visit(bone.grant.parent) : EXCLUDED;
      let ancestor = parent, slotAncestor: StandardBone | undefined;
      for (let guard = 0; ancestor >= 0 && guard <= count && !(slotAncestor = slotOf.get(ancestor)); guard++) ancestor = parentOf(ancestor);
      if (copied) value = segmentIndex(slotSegment(copied, slots));
      else if (grant !== EXCLUDED) value = grant;
      else if (breastName(bone.name) && slotAncestor && torsoSlots.has(slotAncestor)) value = PROXY_SEGMENTS.indexOf('chest');
      else value = parent >= 0 ? visit(parent) : NONE;
      if (value === EXCLUDED) value = NONE;
    }
    result[index] = value; state[index] = 2;
    return value;
  };
  for (let index = 0; index < count; index++) visit(index);
  return result;
}

// ---------------------------------------------------------------- fit

const add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Readonly<Vec3>) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Readonly<Vec3>): Vec3 => { const l = length(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
}
const round6 = (value: number) => Math.round(value * 1e6) / 1e6 || 0;

interface Axis { bone: StandardBone; origin: Vec3; direction: Vec3; length: number; window: [number, number] }
/**
 * Which axis ends (start, end) are free. A free end is pulled in by the full
 * radius so the rounded cap ends where the vertices end; an end joined to the
 * next segment is pulled in by half a radius, a compromise: 0 lets a thick
 * segment's full radius reach past its own vertices (on Gene the belly capsule
 * then flags the reviewed "frustrated"), 1 pinches the body at every joint.
 */
const JOINED_SHRINK = 0.5;
const FREE_ENDS: Readonly<Record<ProxySegment, readonly [boolean, boolean]>> = Object.freeze({
  pelvis: [false, true], abdomen: [false, false], chest: [false, false], neck: [false, false], head: [false, true],
  upperArmLeft: [true, false], forearmLeft: [false, false], handLeft: [false, true], upperArmRight: [true, false], forearmRight: [false, false], handRight: [false, true],
  thighLeft: [false, false], shinLeft: [false, true], thighRight: [false, false], shinRight: [false, true],
});
/** Rest axis of each segment from the joints; window is the allowed extent along it, in axis lengths. */
function axisOf(segment: ProxySegment, input: CollisionProxyInput): Axis | null {
  const { slots, bones } = input;
  const at = (slot: StandardBone) => { const index = slots[slot]; return index === undefined || !bones[index] ? null : bones[index].position; };
  const make = (bone: StandardBone, from: Vec3 | null, to: Vec3 | null, window: [number, number]): Axis | null => {
    if (!from || !to || slots[bone] === undefined) return null;
    const delta = sub(to, from), size = length(delta);
    return size > 1e-6 && [...from, ...to].every(finite) ? { bone, origin: [...from], direction: unit(delta), length: size, window } : null;
  };
  const side = segment.endsWith('Left') ? 'Left' : 'Right';
  switch (segment) {
    case 'pelvis': {
      const left = at('legLeft'), right = at('legRight');
      return make('lowerBody', at('lowerBody'), left && right ? scale(add(left, right), 0.5) : null, [-0.6, 2.6]);
    }
    case 'abdomen': return slots.upperBody2 !== undefined ? make('upperBody', at('upperBody'), at('upperBody2'), [-0.5, 1.5]) : null;
    case 'chest': {
      const bone: StandardBone = slots.upperBody2 !== undefined ? 'upperBody2' : 'upperBody';
      return make(bone, at(bone), at('neck') ?? at('head'), [-0.5, 1.5]);
    }
    case 'neck': return make('neck', at('neck'), at('head'), [-0.3, 1.3]);
    case 'head': {
      const head = at('head'), neck = at('neck');
      if (!head) return null;
      const frame = input.head;
      const size = frame && frame.headSize > 0 ? frame.headSize : neck ? 1.5 * length(sub(head, neck)) : 0;
      if (!(size > 0)) return null;
      const window: [number, number] = frame && [frame.chinY, frame.crownY].every(finite) && frame.crownY > frame.chinY
        ? [(frame.chinY - 0.1 * size - head[1]) / size, (frame.crownY - head[1]) / size] : [-0.4, 1.2];
      return make('head', head, add(head, [0, size, 0]), window);
    }
    case 'upperArmLeft': case 'upperArmRight': return make(`arm${side}`, at(`arm${side}`), at(`elbow${side}`), [-0.3, 1.3]);
    case 'forearmLeft': case 'forearmRight': return make(`elbow${side}`, at(`elbow${side}`), at(`wrist${side}`), [-0.3, 1.3]);
    case 'handLeft': case 'handRight': {
      const elbow = at(`elbow${side}`), wrist = at(`wrist${side}`);
      if (!elbow || !wrist) return null;
      // Nominal hand length 0.7 forearm; vertices decide the real one, within a forearm's length past the wrist.
      const forearm = sub(wrist, elbow);
      return make(`wrist${side}`, wrist, add(wrist, scale(forearm, 0.7)), [-0.2, 1.45]);
    }
    case 'thighLeft': case 'thighRight': return make(`leg${side}`, at(`leg${side}`), at(`knee${side}`), [-0.3, 1.3]);
    case 'shinLeft': case 'shinRight': return make(`knee${side}`, at(`knee${side}`), at(`ankle${side}`), [-0.3, 1.3]);
  }
}

/** Two unit vectors across the axis: "forward" (+z projected) first, so offsets mean the same on every segment. */
function across(direction: Vec3): [Vec3, Vec3] {
  const hint: Vec3 = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const e1 = unit(sub(hint, scale(direction, dot(hint, direction))));
  return [e1, cross(direction, e1)];
}

function fitCapsule(segment: ProxySegment, axis: Axis, points: number[], positions: ArrayLike<number>, params: ProxyParams): ProxyCapsule | null {
  const [e1, e2] = across(axis.direction);
  const sorted = (values: number[]) => Float64Array.from(values).sort();
  let t: number[] = [], x: number[] = [], y: number[] = [];
  const low = axis.window[0] * axis.length, high = axis.window[1] * axis.length;
  for (const vertex of points) {
    const offset = sub([positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]], axis.origin);
    const along = dot(offset, axis.direction);
    if (!(along >= low && along <= high)) continue;
    t.push(along); x.push(dot(offset, e1)); y.push(dot(offset, e2));
  }
  if (t.length < params.minVertices) return null;
  {
    // Outliers first: anything farther from the median axis than outlierFactor × the upper-quartile distance (a badge, a stray strap) is not body.
    // The upper quartile, not the median: a head's eyes, mouth and teeth sit near the axis and would make the median small.
    const mx = quantile(sorted(x), 0.5), my = quantile(sorted(y), 0.5);
    const distances = x.map((_, k) => Math.hypot(x[k] - mx, y[k] - my)), limit = quantile(sorted(distances), 0.75) * params.outlierFactor;
    const keep = distances.map(value => value <= limit);
    if (keep.filter(Boolean).length >= params.minVertices) { t = t.filter((_, k) => keep[k]); x = x.filter((_, k) => keep[k]); y = y.filter((_, k) => keep[k]); }
  }
  const sx = sorted(x), sy = sorted(y), st = sorted(t);
  const cx = (quantile(sx, params.centerQuantile) + quantile(sx, 1 - params.centerQuantile)) / 2;
  const cy = (quantile(sy, params.centerQuantile) + quantile(sy, 1 - params.centerQuantile)) / 2;
  const tLow = quantile(st, params.extentQuantile), tHigh = quantile(st, 1 - params.extentQuantile);
  const trim = (tHigh - tLow) * params.coreTrim;
  let radii: number[] = [];
  for (let k = 0; k < t.length; k++) if (t[k] >= tLow + trim && t[k] <= tHigh - trim) radii.push(Math.hypot(x[k] - cx, y[k] - cy));
  if (radii.length < params.minVertices) radii = t.map((_, k) => Math.hypot(x[k] - cx, y[k] - cy));
  const radius = quantile(sorted(radii), params.radiusQuantile);
  if (!(radius > 0) || !finite(radius)) return null;
  const [startFree, endFree] = FREE_ENDS[segment];
  let ta = tLow + radius * (startFree ? 1 : JOINED_SHRINK), tb = tHigh - radius * (endFree ? 1 : JOINED_SHRINK);
  if (ta > tb) ta = tb = (tLow + tHigh) / 2;
  const centre = add(axis.origin, add(scale(e1, cx), scale(e2, cy)));
  const point = (along: number) => add(centre, scale(axis.direction, along)).map(round6) as Vec3;
  return { segment, bone: axis.bone, a: point(ta), b: point(tb), radius: round6(radius), vertices: t.length };
}

/** Fits the proxy. Deterministic: quantiles only, so the same mesh gives the same numbers whatever the vertex order. */
export function fitCollisionProxy(input: CollisionProxyInput, overrides: Partial<ProxyParams> = {}): CollisionProxy {
  const params = { ...PROXY_PARAMS, ...overrides };
  const classes = classifyProxyBones(input);
  const { positions, skin } = input;
  const vertexCount = Math.floor(positions.length / 3), width = Math.max(1, Math.floor(skin.width));
  const members: number[][] = PROXY_SEGMENTS.map(() => []);
  const share = new Float64Array(PROXY_SEGMENTS.length);
  let excludedVertices = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    share.fill(0);
    let total = 0, excluded = 0;
    for (let k = 0; k < width; k++) {
      const weight = skin.weights[vertex * width + k], bone = skin.indices[vertex * width + k];
      if (!(weight > 0) || !Number.isInteger(bone) || bone < 0 || bone >= classes.length) continue;
      total += weight;
      const value = classes[bone];
      if (value === EXCLUDED) excluded += weight; else if (value >= 0) share[value] += weight;
    }
    if (!(total > 0)) continue;
    if (excluded / total > params.maxExcluded) { excludedVertices++; continue; }
    let best = -1;
    for (let s = 0; s < share.length; s++) if (share[s] > (best < 0 ? 0 : share[best])) best = s;
    if (best >= 0 && share[best] / total >= params.minWeight
      && [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]].every(finite)) members[best].push(vertex);
  }
  const capsules: ProxyCapsule[] = [], missing: ProxySegment[] = [];
  PROXY_SEGMENTS.forEach((segment, index) => {
    const axis = axisOf(segment, input);
    const capsule = axis ? fitCapsule(segment, axis, members[index], positions, params) : null;
    if (capsule) capsules.push(capsule); else missing.push(segment);
  });
  return { version: COLLISION_PROXY_VERSION, capsules, missing, excluded: { bones: classes.filter(value => value === EXCLUDED).length, vertices: excludedVertices } };
}

// ---------------------------------------------------------------- validation and summary

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const vec = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite);

/** A cached proxy is used only when it has this version, a known shape, and every capsule's bone is one the model maps. */
export function acceptCollisionProxy(value: unknown, mapped: (bone: StandardBone) => boolean): CollisionProxy | null {
  if (!isObject(value) || value.version !== COLLISION_PROXY_VERSION || !Array.isArray(value.capsules) || !Array.isArray(value.missing)
    || !isObject(value.excluded) || !finite(value.excluded.bones) || !finite(value.excluded.vertices)) return null;
  if (value.capsules.length + value.missing.length !== PROXY_SEGMENTS.length) return null;
  const seen = new Set<string>();
  for (const capsule of value.capsules) {
    if (!isObject(capsule) || !PROXY_SEGMENTS.includes(capsule.segment as ProxySegment) || seen.has(capsule.segment as string)
      || typeof capsule.bone !== 'string' || !mapped(capsule.bone as StandardBone) || !vec(capsule.a) || !vec(capsule.b)
      || !finite(capsule.radius) || (capsule.radius as number) <= 0 || !Number.isInteger(capsule.vertices)) return null;
    seen.add(capsule.segment as string);
  }
  if (!value.missing.every(segment => PROXY_SEGMENTS.includes(segment) && !seen.has(segment))) return null;
  return JSON.parse(JSON.stringify(value)) as CollisionProxy;
}

export interface CollisionProxySummary {
  version: number;
  capsules: number;
  missing: ProxySegment[];
  /** Radius per segment in model units, 3 decimals. */
  radius: Partial<Record<ProxySegment, number>>;
  excludedBones: number;
  excludedVertices: number;
}
export function summarizeCollisionProxy(proxy: CollisionProxy | null | undefined): CollisionProxySummary | null {
  if (!proxy) return null;
  const radius: CollisionProxySummary['radius'] = {};
  for (const capsule of proxy.capsules) radius[capsule.segment] = Math.round(capsule.radius * 1000) / 1000;
  return { version: proxy.version, capsules: proxy.capsules.length, missing: [...proxy.missing], radius,
    excludedBones: proxy.excluded.bones, excludedVertices: proxy.excluded.vertices };
}
