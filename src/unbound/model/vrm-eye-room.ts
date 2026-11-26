/**
 * I-164 (docs/claude/2026-11-20-vrm-gaps.md): how far a VRM's eye bones may turn, by the same rule as every MMD model's (eye-turn-gain.ts:
 * at the eye-head coordinator's soft limit up, the upper lid covers no more of her iris than Gene's covers of hers), read off the VRM's own
 * face natively: the lid's edge is where her own blink expression moves the lid furthest, the eyeball is what her eye bones move (else her
 * iris surface, split by side). Measured once at load, at rest, in the standard skeleton's frame (+y up, +z her front, a 0.x model
 * already turned round).
 *
 * The coordinator found on 2026-11-20 (One, a VRoid model whose iris nearly fills the socket): the VRM's own range maps let the eye bones
 * turn far enough that the iris is cut at the outer corner and shows its dark back looking down. body-transfer.ts takes the smaller of the
 * two turns: the range map's, and this share of the look.
 */
import { Matrix3, Matrix4, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { EYE_HEAD_DEFAULTS, eyeMaterialPriority, type LoadedModel } from '../../stage';
import { eyeRoomOf, eyeTurnGain, type EyeFace, type EyeRoom } from './eye-turn-gain';

const clean = (name: string) => name.replace(/\s*\(Instance\)\s*$/iu, '').trim();

/** Each eye's room on the VRM (null where it cannot be measured: no eye bone, no blink, too few eye vertices). */
export function vrmEyeRooms(model: Pick<LoadedModel, 'meshes' | 'bone' | 'expression'>, frame: Object3D): (EyeRoom | null)[] {
  const eyes = [model.bone('eyeLeft'), model.bone('eyeRight')];
  if (!eyes[0] || !eyes[1]) return [null, null];
  const blink = model.expression('blink');
  const faceMesh = blink[0]?.mesh;
  if (!faceMesh) return [null, null];
  frame.updateWorldMatrix(true, true);
  const toFrame = new Matrix4().copy(frame.matrixWorld).invert();
  // The face node's primitives (VRoid: skin, eye white, iris, lashes …), each vertex block once.
  const meshes = model.meshes.filter(mesh => mesh.parent === faceMesh.parent);
  const blocks = new Map<unknown, SkinnedMesh>();
  for (const mesh of meshes) { const position = mesh.geometry.getAttribute('position'); if (position && !blocks.has(position)) blocks.set(position, mesh); }
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], dys: number[] = [], owners: number[] = [], iris: number[] = [];
  const point = new Vector3(), delta = new Vector3(), linear = new Matrix3();
  for (const [, mesh] of blocks) {
    mesh.updateWorldMatrix(true, false); mesh.skeleton?.update();
    const toMesh = new Matrix4().multiplyMatrices(toFrame, mesh.matrixWorld);
    linear.setFromMatrix4(toMesh);
    const geometry = mesh.geometry, position = geometry.getAttribute('position'), skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
    const bones = mesh.skeleton?.bones ?? [], eyeIndex = eyes.map(eye => bones.indexOf(eye!));
    const binds = blink.filter(bind => bind.mesh.geometry.getAttribute('position') === position);
    // Which vertices the best-named iris surface holds (the eyeball when the eye bones hold none of their own).
    const irisVertices = new Set<number>();
    const ownIris = meshes.filter(m => m.geometry.getAttribute('position') === position && (Array.isArray(m.material) ? m.material : [m.material]).some(mat => eyeMaterialPriority(clean(mat.name)) === 1));
    for (const m of ownIris) { const index = m.geometry.index; if (index) for (let k = 0; k < index.count; k++) irisVertices.add(index.getX(k)); }
    for (let v = 0; v < position.count; v++) {
      mesh.getVertexPosition(v, point).applyMatrix4(toMesh);
      let owner = -1, weight = 0;
      if (skinIndex && skinWeight) for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(v, k); if (w > weight) { weight = w; owner = skinIndex.getComponent(v, k); } }
      let dy = 0;
      for (const bind of binds) {
        const target = bind.mesh.geometry.morphAttributes.position?.[bind.index];
        if (!target) continue;
        delta.set(target.getX(v), target.getY(v), target.getZ(v));
        if (!bind.mesh.geometry.morphTargetsRelative) delta.sub(new Vector3(position.getX(v), position.getY(v), position.getZ(v)));
        dy += delta.applyMatrix3(linear).y * bind.weight;
      }
      xs.push(point.x); ys.push(point.y); zs.push(point.z); dys.push(dy);
      owners.push(owner === eyeIndex[0] && owner >= 0 ? 0 : owner === eyeIndex[1] && owner >= 0 ? 1 : -1);
      iris.push(irisVertices.has(v) ? 1 : 0);
    }
  }
  const pivots = eyes.map(eye => eye!.getWorldPosition(new Vector3()).applyMatrix4(toFrame));
  // No vertices of the eye bones' own: the iris surface's vertices, each to the nearer eye.
  for (const side of [0, 1]) {
    if (owners.filter(owner => owner === side).length >= 12) continue;
    for (let i = 0; i < owners.length; i++) if (iris[i] && owners[i] < 0) {
      const near = Math.abs(xs[i] - pivots[0].x) <= Math.abs(xs[i] - pivots[1].x) ? 0 : 1;
      if (near === side) owners[i] = side;
    }
  }
  const face: EyeFace = { count: xs.length, x: i => xs[i], y: i => ys[i], z: i => zs[i], owner: Int32Array.from(owners), dy: i => dys[i] };
  return [0, 1].map(side => eyeRoomOf(face, side, pivots[side]));
}

/** The share of a look her eye bones may take on this VRM (1: room enough), at the coordinator's soft limit up. */
export function vrmEyeRoomGain(model: Pick<LoadedModel, 'meshes' | 'bone' | 'expression'>, frame: Object3D): number {
  try { return eyeTurnGain(vrmEyeRooms(model, frame), EYE_HEAD_DEFAULTS.eyeSoft.up); } catch { return 1; }
}
