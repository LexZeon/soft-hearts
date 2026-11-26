/**
 * I-164 interaction: a body with volume for the synthetic VRM (synthetic-vrm.ts `body: 'full'`), so her capsules can be measured: each body
 * part is a tube of vertex rings along its bone (VRM 1.0 world positions, metres, T pose), skinned wholly to that bone. Nothing here comes
 * from a real model.
 */
import type { V3 } from './synthetic-vrm-face';

export interface BodyVertex { at: V3; joints: [string, number][] }

/** One tube: from `a` to `b`, `radius`, skinned to `joint`; five rings of six (30 vertices, ten triangles' worth). */
function tube(joint: string, a: V3, b: V3, radius: number): BodyVertex[] {
  const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], length = Math.hypot(axis[0], axis[1], axis[2]);
  const d = axis.map(v => v / length);
  // Two directions across the axis.
  const helper = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [d[1] * helper[2] - d[2] * helper[1], d[2] * helper[0] - d[0] * helper[2], d[0] * helper[1] - d[1] * helper[0]];
  const ul = Math.hypot(u[0], u[1], u[2]); for (let k = 0; k < 3; k++) u[k] /= ul;
  const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const out: BodyVertex[] = [];
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (let k = 0; k < 6; k++) {
      const angle = k / 6 * Math.PI * 2, c = Math.cos(angle) * radius, s = Math.sin(angle) * radius;
      out.push({ at: [0, 1, 2].map(i => a[i] + axis[i] * t + u[i] * c + w[i] * s) as V3, joints: [[joint, 1]] });
    }
  }
  return out;
}

/** The tubes (the bones' places match synthetic-vrm.ts's skeleton). */
export function fullBody(): BodyVertex[] {
  const out: BodyVertex[] = [
    ...tube('J_Bip_C_Hips', [0, 0.95, 0], [0, 0.8, 0], 0.13),
    ...tube('J_Bip_C_Spine', [0, 1.0, 0], [0, 1.15, 0], 0.11),
    ...tube('J_Bip_C_Chest', [0, 1.15, 0], [0, 1.33, 0], 0.12),
    ...tube('J_Bip_C_Neck', [0, 1.35, 0], [0, 1.45, 0], 0.035),
    ...tube('J_Bip_C_Head', [0, 1.45, 0], [0, 1.65, 0], 0.09),
  ];
  for (const side of [1, -1] as const) {
    const s = side === 1 ? 'L' : 'R';
    out.push(
      ...tube(`J_Bip_${s}_UpperArm`, [0.1 * side, 1.3, 0], [0.32 * side, 1.3, 0], 0.035),
      ...tube(`J_Bip_${s}_LowerArm`, [0.32 * side, 1.3, 0], [0.52 * side, 1.3, 0], 0.03),
      ...tube(`J_Bip_${s}_Hand`, [0.52 * side, 1.3, 0], [0.6 * side, 1.3, 0], 0.025),
      ...tube(`J_Bip_${s}_UpperLeg`, [0.08 * side, 0.85, 0], [0.08 * side, 0.45, 0], 0.065),
      ...tube(`J_Bip_${s}_LowerLeg`, [0.08 * side, 0.45, 0], [0.08 * side, 0.08, 0], 0.045),
      ...tube(`J_Bip_${s}_Foot`, [0.08 * side, 0.08, 0], [0.08 * side, 0.02, 0.1], 0.03),
    );
  }
  return out;
}
