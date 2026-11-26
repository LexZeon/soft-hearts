/**
 * The head as ArmReach (arm-reach.ts) needs it, measured once per model from the vertices its head bone carries: points on the face
 * (cheeks, chin, mouth), how far the side locks of her hair reach beside the cheek, a coarse radial map and surface samples for the
 * clearance test. Split out of arm-reach.ts unchanged (I-154 batch 4, to make room for the window's arm aims).
 */
import { Matrix4, Vector3, type Bone, type SkinnedMesh } from 'three';
import { MMD_UNIT_M } from '../../shared/unbound/world';
import { inFaceRegion, type FaceRegionRef } from './face-region';

/** The head as the model has it: points on the face (head-local, model units) and a coarse radial map for the clearance test. */
export interface HeadShape {
  center: Vector3;
  cheek: { left: Vector3; right: Vector3 }; chin: Vector3; mouth: Vector3;
  /** How far out (head-local x, units, signed toward each side) anything reaches beside the cheek: the side locks of her hair. */
  hairSide: { left: number; right: number };
  /** Max radius from `center` per direction bin (24 around × 12 up/down). */
  radius: Float32Array;
  /** Surface samples (head-local, units) and their normals, for the clearance test. */
  surface: { points: Float32Array; normals: Float32Array };
}
const BINS_AROUND = 24, BINS_UP = 12;

/** A bone's rest position (model space, units) from the skeleton's inverse bind matrix. */
export function restPosition(mesh: SkinnedMesh, bone: Bone): Vector3 {
  const index = mesh.skeleton.bones.indexOf(bone);
  return new Vector3().setFromMatrixPosition(new Matrix4().copy(mesh.skeleton.boneInverses[index]).invert());
}

/** The vertices the head bone carries most, in its rest frame: face points and the radial map. */
export function measureHead(mesh: SkinnedMesh, head: Bone): HeadShape | null {
  const position = mesh.geometry.getAttribute('position'), skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight');
  const normal = mesh.geometry.getAttribute('normal');
  if (!position || !skinIndex || !skinWeight) return null;
  const index = mesh.skeleton.bones.indexOf(head);
  const normalOf: Vector3[] = [];
  const rest = restPosition(mesh, head);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const eyes = ['左目', '右目'].map(n => mesh.skeleton.bones.find(b => b.name === n)).filter((b): b is Bone => !!b).map(b => restPosition(mesh, b).sub(rest));
  const points: Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    let best = -1, weight = 0;
    for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(i, k); if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); } }
    if (best === index && weight > 0.5) { points.push(new Vector3(position.getX(i) - rest.x, position.getY(i) - rest.y, position.getZ(i) - rest.z)); normalOf.push(normal ? new Vector3(normal.getX(i), normal.getY(i), normal.getZ(i)).normalize() : new Vector3()); }
  }
  if (points.length < 50) return null;
  const xs = points.map(p => p.x).sort((a, b) => a - b), ys = points.map(p => p.y).sort((a, b) => a - b), zs = points.map(p => p.z).sort((a, b) => a - b);
  const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.max(0, Math.floor(f * (v.length - 1))))];
  const center = new Vector3((q(xs, 0.02) + q(xs, 0.98)) / 2, (q(ys, 0.02) + q(ys, 0.98)) / 2, (q(zs, 0.02) + q(zs, 0.98)) / 2);
  const eyeY = eyes.length ? eyes.reduce((s, e) => s + e.y, 0) / eyes.length : center.y;
  const front = points.filter(p => p.z > center.z);
  // Chin: the lowest front point near the middle. Mouth: a third of the way from the chin to the eyes, the frontmost there.
  const middle = front.filter(p => Math.abs(p.x - center.x) < 0.015 / MMD_UNIT_M);
  const chin = (middle.length ? middle : front).reduce((a, b) => (b.y < a.y ? b : a));
  const mouthY = chin.y + (eyeY - chin.y) * 0.33;
  const band = (y: number, half: number) => front.filter(p => Math.abs(p.y - y) < half);
  const mouthBand = band(mouthY, 0.006 / MMD_UNIT_M).filter(p => Math.abs(p.x - center.x) < 0.012 / MMD_UNIT_M);
  const mouth = mouthBand.length ? mouthBand.reduce((a, b) => (b.z > a.z ? b : a)) : new Vector3(center.x, mouthY, chin.z);
  const cheekY = mouthY + (eyeY - mouthY) * 0.25;
  // Cheek: the widest point at that height among points not behind the eyes (the side of the face, not the hair behind it).
  const eyeZ = eyes.length ? eyes.reduce((s, e) => s + e.z, 0) / eyes.length : center.z;
  // In front of the eyes' pivots: the cheek you would touch, not the side of the head by the ear.
  const cheekBand = band(cheekY, 0.008 / MMD_UNIT_M).filter(p => p.z > eyeZ + 0.004 / MMD_UNIT_M);
  const cheekOf = (s: 1 | -1) => cheekBand.length ? cheekBand.reduce((a, b) => (s * b.x > s * a.x ? b : a)).clone() : new Vector3(center.x + s * 0.05 / MMD_UNIT_M, cheekY, center.z);
  const radius = new Float32Array(BINS_AROUND * BINS_UP);
  for (const p of points) {
    const d = p.clone().sub(center), r = d.length(), bin = binOf(d);
    if (r > radius[bin]) radius[bin] = r;
  }
  // Empty bins borrow the smallest filled neighbour (conservative: a hand there reads as outside only when it really is).
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < radius.length; i++) if (radius[i] === 0) {
    const a = i % BINS_AROUND, u = Math.floor(i / BINS_AROUND), around = [radius[u * BINS_AROUND + (a + 1) % BINS_AROUND], radius[u * BINS_AROUND + (a + BINS_AROUND - 1) % BINS_AROUND]].filter(v => v > 0);
    if (around.length) radius[i] = Math.min(...around);
  }
  const stride = Math.max(1, Math.floor(points.length / 6000));
  const sp: number[] = [], sn: number[] = [];
  // Round 16: locks weighted to the head bone that hang below the chin line are not her surface for the clearance (face-region.ts).
  const region: FaceRegionRef = { chinY: chin.y, unitM: MMD_UNIT_M };
  for (let i = 0; i < points.length; i += stride) {
    if (!inFaceRegion(points[i], region)) continue;
    const n = normalOf[i].lengthSq() > 0.5 ? normalOf[i] : points[i].clone().sub(center).normalize();
    sp.push(points[i].x, points[i].y, points[i].z); sn.push(n.x, n.y, n.z);
  }
  // Anything at all beside the cheek (any bone: the side locks hang there), in the head's rest frame.
  const hairSide = { left: cheekOf(1).x, right: -cheekOf(-1).x };
  const cheekLeft = cheekOf(1), cheekRight = cheekOf(-1);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) - rest.x, y = position.getY(i) - rest.y, z = position.getZ(i) - rest.z;
    if (Math.abs(y - (cheekY - 0.045 / MMD_UNIT_M)) > 0.025 / MMD_UNIT_M || z < eyeZ - 0.03 / MMD_UNIT_M || z > eyeZ + 0.05 / MMD_UNIT_M || Math.abs(x) > 0.14 / MMD_UNIT_M) continue;
    if (x > 0) hairSide.left = Math.max(hairSide.left, x); else hairSide.right = Math.max(hairSide.right, -x);
  }
  return { center, cheek: { left: cheekLeft, right: cheekRight }, hairSide, chin: chin.clone(), mouth: mouth.clone(), radius, surface: { points: new Float32Array(sp), normals: new Float32Array(sn) } };
}

function binOf(d: Vector3): number {
  const around = Math.floor(((Math.atan2(d.x, d.z) + Math.PI) / (2 * Math.PI)) * BINS_AROUND) % BINS_AROUND;
  const up = Math.min(BINS_UP - 1, Math.max(0, Math.floor(((Math.atan2(d.y, Math.hypot(d.x, d.z)) + Math.PI / 2) / Math.PI) * BINS_UP)));
  return up * BINS_AROUND + around;
}
function radiusAt(shape: HeadShape, d: Vector3): number { return shape.radius[binOf(d)] || 0; }
