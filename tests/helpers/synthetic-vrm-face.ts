/**
 * I-164 (docs/claude/2026-11-20-vrm-gaps.md): a VRoid-like FULL face for the synthetic VRM (synthetic-vrm.ts `face: 'full'`), nothing from a
 * real model. A curved face skin (57 × 57 grid, her front +Z) on the head bone, two iris domes on the eye bones (VRoid keeps the eye bones at
 * about a third of the real eye spacing: here ±12 mm, the irises at ±32 mm), and the part shapes a VRoid face has (Fcl_*), plus a raw
 * "tongueOut" target and a "Fcl_MTH_Puff" a custom cheekPuff expression binds. Positions in VRM 1.0 metres.
 *
 * `irisFill`: the upper lid's edge sits just under the iris's top (One: the iris nearly fills the socket), else well above it.
 * `lips` (2026-11-22, docs/claude/2026-11-22-mouth-shut-while-talking.md): VRoid-like lips that meet at the mouth line: Fcl_MTH_A pulls the lower
 * lip down (and the upper a little up), Fcl_MTH_I barely parts them (VRoid's い parts One's lips by nothing), Fcl_MTH_Fun lifts the corners
 * with the lips closed. Appended after the other targets (LIPS_MORPHS), so every other index stays.
 */
export type V3 = [number, number, number];
export interface FaceVertex { at: V3; joints: [string, number][] }

export const FULL_FACE_MORPHS = ['Fcl_EYE_Close', 'Fcl_MTH_A', 'Fcl_EYE_Joy', 'Fcl_EYE_Close_L', 'Fcl_EYE_Close_R', 'Fcl_MTH_U', 'Fcl_MTH_Small', 'Fcl_MTH_Down',
  'Fcl_MTH_Puff', 'tongueOut'] as const;
/** The eye bones' x (her left +), the irises' centres, their radius. */
export const LIPS_MORPHS = ['Fcl_MTH_I', 'Fcl_MTH_Fun'] as const;
export const FULL_FACE = { eyeBoneX: 0.012, irisX: 0.032, irisY: 1.51, irisR: 0.008, mouthY: 1.47 } as const;

type FaceMorph = typeof FULL_FACE_MORPHS[number] | typeof LIPS_MORPHS[number];
export function fullFace(irisFill: boolean, lips = false): { vertices: FaceVertex[]; skin: number[]; iris: number[]; names: FaceMorph[]; targets: Record<FaceMorph, V3[]> } {
  const vertices: FaceVertex[] = [], skin: number[] = [], iris: number[] = [];
  const N = 57, x0 = -0.07, y0 = 1.42, step = 0.14 / (N - 1);
  const surface = (x: number) => 0.09 - 3 * x * x;
  const lipRow = Math.round((FULL_FACE.mouthY - y0) / step); // the lower lip's top row; with lips, the row above it closes onto it
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const x = x0 + c * step, closes = lips && r === lipRow + 1 && Math.abs(x) <= 0.012;
    vertices.push({ at: [x, closes ? y0 + lipRow * step : y0 + r * step, surface(x)], joints: [['J_Bip_C_Head', 1]] });
  }
  for (let r = 0; r + 1 < N; r++) for (let c = 0; c + 1 < N; c++) {
    const a = r * N + c, b = a + 1, d = a + N, e = d + 1;
    skin.push(a, b, e, a, e, d); // counter-clockwise seen from +Z
  }
  for (const side of [1, -1] as const) {
    const bone = side === 1 ? 'J_Adj_L_FaceEye' : 'J_Adj_R_FaceEye', cx = side * FULL_FACE.irisX, z = surface(cx) + 0.003, center = vertices.length;
    vertices.push({ at: [cx, FULL_FACE.irisY, z + 0.002], joints: [[bone, 1]] });
    for (let k = 0; k < 16; k++) { const t = (k / 16) * Math.PI * 2; vertices.push({ at: [cx + FULL_FACE.irisR * Math.cos(t), FULL_FACE.irisY + FULL_FACE.irisR * Math.sin(t), z], joints: [[bone, 1]] }); }
    for (let k = 0; k < 16; k++) iris.push(center, center + 1 + k, center + 1 + ((k + 1) % 16));
  }
  const zero = (): V3[] => vertices.map(() => [0, 0, 0]);
  const names: FaceMorph[] = [...FULL_FACE_MORPHS, ...(lips ? LIPS_MORPHS : [])];
  const targets = Object.fromEntries(names.map(name => [name, zero()])) as Record<FaceMorph, V3[]>;
  const top = FULL_FACE.irisY + FULL_FACE.irisR, edge = irisFill ? top - 0.006 : top + 0.008, band = irisFill ? 0.006 : 0.012;
  vertices.forEach((v, i) => {
    if (i >= N * N) return; // the irises move with the eye bones only
    const [x, y] = v.at;
    for (const side of [1, -1] as const) {
      if (Math.abs(x - side * FULL_FACE.irisX) > 0.011 || y < edge || y > edge + band) continue;
      targets.Fcl_EYE_Close[i] = [0, -0.012, 0];
      targets.Fcl_EYE_Joy[i] = [0, -0.005, 0];
      targets[side === 1 ? 'Fcl_EYE_Close_L' : 'Fcl_EYE_Close_R'][i] = [0, -0.012, 0];
    }
    const mouth = Math.abs(x) <= 0.012 && Math.abs(y - FULL_FACE.mouthY) <= 0.006;
    if (mouth && lips) {
      const lower = Math.floor(i / N) <= lipRow;
      targets.Fcl_MTH_A[i] = lower ? [0, -0.006, 0] : [0, 0.001, 0];
      targets.Fcl_MTH_I[i] = [x * 0.15, 0, 0];
      if (Math.abs(x) > 0.006) targets.Fcl_MTH_Fun[i] = [0, 0.0015, 0];
    }
    if (mouth) {
      if (!lips) targets.Fcl_MTH_A[i] = [0, -0.006, 0];
      targets.Fcl_MTH_U[i] = [-x * 0.4, 0, 0.002];
      targets.Fcl_MTH_Small[i] = [-x * 0.2, 0, 0];
      if (Math.abs(x) > 0.006) targets.Fcl_MTH_Down[i] = [0, -0.003, 0];
      if (Math.abs(x) <= 0.006) targets.tongueOut[i] = [0, 0, 0.006];
    }
    if (Math.abs(x) >= 0.025 && Math.abs(x) <= 0.05 && y >= 1.465 && y <= 1.495) targets.Fcl_MTH_Puff[i] = [Math.sign(x) * 0.002, 0, 0.004];
  });
  return { vertices, skin, iris, names, targets };
}
