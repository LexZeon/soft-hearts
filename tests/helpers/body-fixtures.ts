/**
 * Synthetic skinned bodies for collision-proxy tests (no private or third-party
 * data). About 20 units tall with Gene-like joints (the toy skeleton of
 * model-fixtures.ts), but with real volume: elliptical torso rings, cylindrical
 * limbs, a flat hand, a head, all skinned with BDEF1/BDEF2 blends at the joints
 * (and BDEF4 at the shoulders). Options add what real models bring: a fat belly,
 * a bust, a long skirt and long hair on their own bone chains (physics and/or
 * named), stray accessory vertices skinned straight to the chest, "D" leg
 * bones, T or A rest pose, no twist bones.
 */
import type { ModelData } from './model-fixtures';
import type { PmxLiteBone, PmxLiteRigidBody } from './pmx-lite';

export interface BodyOptions {
  pose?: 'A' | 'T';
  /** Belly forward and sideways (fat), or the slim default. */
  build?: 'slim' | 'fat';
  /** Extra forward depth of the chest at the bust line, model units. */
  bust?: number;
  /**
   * A long skirt to below the knees on its own bone chain: marked as physics and named スカート ('bones'), physics only with
   * neutral names, named only, 'unmarked' (neutral names, no physics: indistinguishable from body bones), or none.
   */
  skirt?: 'none' | 'bones' | 'physics-only' | 'named-only' | 'unmarked';
  /** Long hair down the back to the waist, the same variants. */
  hair?: 'none' | 'bones' | 'physics-only' | 'named-only' | 'unmarked';
  /** Arm twist bones (腕捩/手捩) carrying the lower half of each arm segment. Default true. */
  twist?: boolean;
  /** Deform legs: thighs and shins skinned to 足D/ひざD (付与 copies of 足/ひざ) instead of the FK bones. */
  dBones?: boolean;
  /** Accessory vertices skinned straight to 上半身2, far in front of the chest. */
  outliers?: number;
  /** Rings per unit length (mesh density). */
  density?: number;
}

type Bone = PmxLiteBone;
interface Builder { points: number[]; indices: number[]; weights: number[] }

export function bodyModel(options: BodyOptions = {}): ModelData & { skinIndices: Int32Array; skinWeights: Float32Array; rigidBodies: PmxLiteRigidBody[] } {
  const t = options.pose === 'T', fat = options.build === 'fat', twist = options.twist !== false, density = options.density ?? 6;
  const bones: Bone[] = [], rigidBodies: PmxLiteRigidBody[] = [];
  const bone = (name: string, parent: number, x: number, y: number, z = 0, extra: Partial<Bone> = {}) => { bones.push({ name, parent, position: [x, y, z], ik: false, ...extra }); return bones.length - 1; };
  const root = bone('全ての親', -1, 0, 0), center = bone('センター', root, 0, 9.2);
  const upper = bone('上半身', center, 0, 11.8), upper2 = bone('上半身2', upper, 0, 13.8), neck = bone('首', upper2, 0, 15.8), head = bone('頭', neck, 0, 17.3);
  bone('左目', head, 0.45, 17.95, 0.8); bone('右目', head, -0.45, 17.95, 0.8);
  const lower = bone('下半身', center, 0, 11.5);
  const arm: Record<'L' | 'R', { shoulder: number; arm: number; armTwist: number; elbow: number; wristTwist: number; wrist: number; finger: number; joints: number[][] }> = {} as never;
  for (const [side, sign, name] of [['L', 1, '左'], ['R', -1, '右']] as const) {
    const shoulder = bone(`${name}肩`, upper2, 0.27 * sign, 15.77);
    const a = [1.33 * sign, 15.36], e = [(t ? 4.18 : 3.69) * sign, t ? 15.36 : 13.77], w = [(t ? 7.26 : 6.25) * sign, t ? 15.36 : 12.05];
    const armBone = bone(`${name}腕`, shoulder, a[0], a[1]);
    const armTwist = twist ? bone(`${name}腕捩`, armBone, (a[0] + e[0]) / 2, (a[1] + e[1]) / 2) : armBone;
    const elbow = bone(`${name}ひじ`, armTwist, e[0], e[1]);
    const wristTwist = twist ? bone(`${name}手捩`, elbow, (e[0] + w[0]) / 2, (e[1] + w[1]) / 2) : elbow;
    const wrist = bone(`${name}手首`, wristTwist, w[0], w[1]);
    const dir = [(w[0] - e[0]) / Math.hypot(w[0] - e[0], w[1] - e[1]), (w[1] - e[1]) / Math.hypot(w[0] - e[0], w[1] - e[1])];
    const finger = bone(`${name}中指１`, wrist, w[0] + dir[0] * 0.85, w[1] + dir[1] * 0.85);
    bone(`${name}中指先`, finger, w[0] + dir[0] * 1.9, w[1] + dir[1] * 1.9);
    arm[side] = { shoulder, arm: armBone, armTwist, elbow, wristTwist, wrist, finger, joints: [a, e, w] };
  }
  const leg: Record<'L' | 'R', { leg: number; knee: number; ankle: number; skinLeg: number; skinKnee: number }> = {} as never;
  for (const [side, sign, name] of [['L', 1, '左'], ['R', -1, '右']] as const) {
    const legBone = bone(`${name}足`, lower, 0.88 * sign, 10.48), knee = bone(`${name}ひざ`, legBone, 0.88 * sign, 5.77), ankle = bone(`${name}足首`, knee, 0.88 * sign, 1.33);
    let skinLeg = legBone, skinKnee = knee;
    if (options.dBones) {
      skinLeg = bone(`${name}足D`, lower, 0.88 * sign, 10.48, 0, { grant: { parent: legBone, ratio: 1 } });
      skinKnee = bone(`${name}ひざD`, skinLeg, 0.88 * sign, 5.77, 0, { grant: { parent: knee, ratio: 1 } });
    }
    leg[side] = { leg: legBone, knee, ankle, skinLeg, skinKnee };
  }

  const b: Builder = { points: [], indices: [], weights: [] };
  const add = (x: number, y: number, z: number, skin: [number, number][]) => {
    b.points.push(x, y, z);
    const slots = skin.slice(0, 4);
    for (let k = 0; k < 4; k++) { b.indices.push(slots[k]?.[0] ?? 0); b.weights.push(slots[k]?.[1] ?? 0); }
  };
  /** BDEF1 away from the joint height, a BDEF2 blend within ±width of it. */
  const blend = (at: number, joint: number, from: number, to: number, width = 0.25): [number, number][] => {
    const s = Math.min(1, Math.max(0, (at - (joint - width)) / (2 * width)));
    return s <= 0 ? [[from, 1]] : s >= 1 ? [[to, 1]] : [[from, 1 - s], [to, s]];
  };
  const ring = 28;
  // Torso: elliptical rings, crotch to neck base. Front depth, back depth and half width per height.
  const bumps = (y: number, centre: number, width: number) => Math.max(0, 1 - ((y - centre) / width) ** 2);
  for (let y = 9.8; y <= 15.9 + 1e-9; y += 1 / density) {
    const hips = bumps(y, 10.6, 1.4), waist = bumps(y, 12.3, 1.2), chest = bumps(y, 14.0, 1.3);
    let side = 0.95 + 0.3 * hips + 0.15 * chest, front = 0.62 + 0.15 * hips + 0.1 * chest, back = 0.62 + 0.2 * hips + 0.05 * chest;
    if (fat) { side += 0.4 * waist + 0.25 * hips; front += 0.95 * waist + 0.3 * hips; back += 0.15 * waist; }
    front += (options.bust ?? 0) * bumps(y, 14.1, 0.75);
    if (y > 15.2) side *= 1 - 0.35 * (y - 15.2) / 0.7; // towards the neck
    // Hips on 下半身 below the waist, belly on 上半身, chest on 上半身2.
    const skin: [number, number][] = y < 12.6 ? blend(y, 11.6, lower, upper, 0.3) : blend(y, 13.6, upper, upper2, 0.3);
    for (let k = 0; k < ring; k++) {
      const angle = (k / ring) * 2 * Math.PI, s = Math.sin(angle);
      add(side * Math.cos(angle), y, s * (s > 0 ? front : back), skin);
    }
  }
  // Neck and head.
  for (let y = 15.9; y <= 17.0 + 1e-9; y += 1 / density) for (let k = 0; k < 16; k++) {
    const angle = (k / 16) * 2 * Math.PI; add(0.4 * Math.cos(angle), y, 0.4 * Math.sin(angle), y < 16.0 ? blend(y, 15.95, upper2, neck, 0.1) : blend(y, 16.9, neck, head, 0.15));
  }
  for (let row = 0; row <= 14; row++) {
    const phi = Math.PI * row / 14, y = 18.15 - 1.3 * Math.cos(phi), r = 1.0 * Math.sin(phi) + 0.05;
    for (let k = 0; k < 24; k++) { const angle = (k / 24) * 2 * Math.PI; add(r * Math.cos(angle), y, 0.1 + r * 1.05 * Math.sin(angle), [[head, 1]]); }
  }
  // Limbs: cylinders around a bone line (start, end, radius at each end), skinned by a weight function of the position along it.
  const cylinder = (from: number[], to: number[], r0: number, r1: number, skin: (s: number) => [number, number][], rings = ring) => {
    const d = [to[0] - from[0], to[1] - from[1], (to[2] ?? 0) - (from[2] ?? 0)], len = Math.hypot(d[0], d[1], d[2]);
    const u = d.map(value => value / len), hint = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const dotHint = hint[0] * u[0] + hint[1] * u[1] + hint[2] * u[2];
    const e1 = [hint[0] - dotHint * u[0], hint[1] - dotHint * u[1], hint[2] - dotHint * u[2]], l1 = Math.hypot(e1[0], e1[1], e1[2]);
    const n1 = e1.map(value => value / l1), n2 = [u[1] * n1[2] - u[2] * n1[1], u[2] * n1[0] - u[0] * n1[2], u[0] * n1[1] - u[1] * n1[0]];
    const steps = Math.max(2, Math.round(len * density));
    for (let i = 0; i <= steps; i++) {
      const s = i / steps, r = r0 + (r1 - r0) * s, c = [from[0] + d[0] * s, from[1] + d[1] * s, (from[2] ?? 0) + d[2] * s];
      for (let k = 0; k < rings; k++) {
        const angle = (k / rings) * 2 * Math.PI, cos = Math.cos(angle) * r, sin = Math.sin(angle) * r;
        add(c[0] + n1[0] * cos + n2[0] * sin, c[1] + n1[1] * cos + n2[1] * sin, c[2] + n1[2] * cos + n2[2] * sin, skin(s));
      }
    }
  };
  const along = (s: number, joint: number, from: number, to: number, width = 0.08): [number, number][] =>
    s < joint - width ? [[from, 1]] : s > joint + width ? [[to, 1]] : [[from, (joint + width - s) / (2 * width)], [to, (s - joint + width) / (2 * width)]];
  for (const side of ['L', 'R'] as const) {
    const { joints: [a, e, w], shoulder, arm: armBone, armTwist, elbow, wristTwist, wrist, finger } = arm[side];
    // Upper arm (a 4-weight blend with the shoulder and chest near the top), forearm, then a flat hand.
    cylinder(a, e, 0.38, 0.32, s => s < 0.1 ? [[armBone, 0.55], [shoulder, 0.25], [upper2, 0.1], [armTwist, 0.1]] : s > 0.92 ? along(s, 0.96, armTwist, elbow, 0.04) : along(s, 0.5, armBone, armTwist));
    cylinder(e, w, 0.31, 0.25, s => s > 0.94 ? along(s, 0.97, wristTwist, wrist, 0.03) : along(s, 0.5, elbow, wristTwist));
    const dir = [(w[0] - e[0]) / Math.hypot(w[0] - e[0], w[1] - e[1]), (w[1] - e[1]) / Math.hypot(w[0] - e[0], w[1] - e[1])];
    for (let i = 0; i <= 12; i++) for (let j = -4; j <= 4; j++) for (const z of [-0.12, 0.12]) {
      const s = i / 12 * 1.9, across = j * 0.1;
      add(w[0] + dir[0] * s - dir[1] * across * 0.2, w[1] + dir[1] * s + dir[0] * across * 0.2, z + across, s > 0.85 ? [[finger, 1]] : [[wrist, 1]]);
    }
  }
  for (const side of ['L', 'R'] as const) {
    const { skinLeg, skinKnee, ankle } = leg[side], x = side === 'L' ? 0.88 : -0.88;
    cylinder([x, 10.3, 0], [x, 5.77, 0], 0.68, 0.45, s => s < 0.06 ? [[lower, 0.4], [skinLeg, 0.6]] : along(s, 1, skinLeg, skinKnee));
    cylinder([x, 5.77, 0], [x, 1.33, 0], 0.44, 0.3, s => along(s, 0.02, skinLeg, skinKnee, 0.02));
    cylinder([x, 1.0, -0.2], [x, 0.2, 1.2], 0.25, 0.2, () => [[ankle, 1]], 12);
  }
  // Long skirt: a flared cone from the hips to below the knees, on 8 two-bone chains.
  if (options.skirt && options.skirt !== 'none') {
    const physics = options.skirt === 'bones' || options.skirt === 'physics-only', named = options.skirt === 'bones' || options.skirt === 'named-only';
    const chains: number[][] = [];
    for (let c = 0; c < 8; c++) {
      const angle = (c / 8) * 2 * Math.PI, rTop = 1.4, rMid = 2.0;
      const top = bone(named ? `スカート${c}_1` : `B_${c}_1`, lower, rTop * Math.cos(angle), 11.0, rTop * Math.sin(angle));
      const mid = bone(named ? `スカート${c}_2` : `B_${c}_2`, top, rMid * Math.cos(angle), 8.5, rMid * Math.sin(angle));
      if (physics) rigidBodies.push({ boneIndex: top, type: 1 }, { boneIndex: mid, type: 1 });
      chains.push([top, mid]);
    }
    for (let y = 11.2; y >= 5.5; y -= 1 / density) {
      const r = 1.42 + (11.2 - y) * 0.2;
      for (let k = 0; k < 32; k++) {
        const angle = (k / 32) * 2 * Math.PI, chain = chains[Math.round(k / 4) % 8];
        // The waistband is half on the hips; the rest rides the chain.
        const skin: [number, number][] = y > 10.8 ? [[lower, 0.5], [chain[0], 0.5]] : y > 8.5 ? [[chain[0], 1]] : [[chain[1], 1]];
        add(r * Math.cos(angle), y, r * Math.sin(angle), skin);
      }
    }
  }
  // Long hair: a curved sheet from the crown down the back to the waist, on 3 chains.
  if (options.hair && options.hair !== 'none') {
    const physics = options.hair === 'bones' || options.hair === 'physics-only', named = options.hair === 'bones' || options.hair === 'named-only';
    const chains: number[][] = [];
    for (let c = 0; c < 3; c++) {
      const x = (c - 1) * 0.6;
      const h1 = bone(named ? `後髪${c}_1` : `J_${c}_1`, head, x, 17.8, -1.05), h2 = bone(named ? `後髪${c}_2` : `J_${c}_2`, h1, x, 15.0, -1.15), h3 = bone(named ? `後髪${c}_3` : `J_${c}_3`, h2, x, 12.5, -1.2);
      if (physics) rigidBodies.push({ boneIndex: h1, type: 2 }, { boneIndex: h2, type: 2 }, { boneIndex: h3, type: 2 });
      chains.push([h1, h2, h3]);
    }
    for (let y = 19.0; y >= 11.0; y -= 1 / density) for (let k = -6; k <= 6; k++) {
      const x = k * 0.15, chain = chains[Math.min(2, Math.max(0, Math.round(k / 4) + 1))];
      const skin: [number, number][] = y > 17.6 ? [[head, 0.7], [chain[0], 0.3]] : y > 15.0 ? [[chain[0], 1]] : y > 12.5 ? [[chain[1], 1]] : [[chain[2], 1]];
      add(x, y, -1.1 - 0.05 * Math.abs(k) / 6, skin);
    }
  }
  // Stray accessory vertices skinned straight to the chest bone, far in front.
  for (let k = 0; k < (options.outliers ?? 0); k++) add(0.3 * Math.sin(k), 14 + 0.2 * Math.cos(k * 1.7), 3 + 0.3 * Math.sin(k * 0.7), [[upper2, 1]]);

  const count = b.points.length / 3, skinBone = new Int32Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    let best = 0; for (let k = 1; k < 4; k++) if (b.weights[vertex * 4 + k] > b.weights[vertex * 4 + best]) best = k;
    skinBone[vertex] = b.indices[vertex * 4 + best];
  }
  return { positions: Float32Array.from(b.points), skinBone, skinIndices: Int32Array.from(b.indices), skinWeights: Float32Array.from(b.weights), bones, morphs: [], rigidBodies };
}

/** The same body with its vertices in another order (fit results must not depend on it). */
export function shuffledVertices<T extends ReturnType<typeof bodyModel>>(data: T, seed = 11): T {
  const count = data.positions.length / 3, order = Array.from({ length: count }, (_, k) => k);
  let state = seed;
  for (let k = count - 1; k > 0; k--) { state = (state * 16807) % 2147483647; const j = state % (k + 1); [order[k], order[j]] = [order[j], order[k]]; }
  const pick = <A extends Float32Array | Int32Array>(source: A, width: number, make: (n: number) => A) => {
    const out = make(count * width); order.forEach((from, to) => { for (let c = 0; c < width; c++) out[to * width + c] = source[from * width + c]; }); return out;
  };
  return { ...data, positions: pick(data.positions, 3, n => new Float32Array(n)), skinBone: pick(data.skinBone, 1, n => new Int32Array(n)),
    skinIndices: pick(data.skinIndices, 4, n => new Int32Array(n)), skinWeights: pick(data.skinWeights, 4, n => new Float32Array(n)) };
}
