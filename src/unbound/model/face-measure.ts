/**
 * I-192 (docs/claude/2026-11-22-i192-arrival-targets.md): her face as the arrival targets read it (shared/unbound/arrival/face.ts), measured
 * once per model from its own skinned vertices as she stands when she arrives: an MMD mesh's own geometry, a VRM's own meshes through its
 * standard body (the standard skeleton's mesh has no vertices).
 *
 *  - her head: the vertices whose strongest bone is the head bone or one of its children (eyes, hair, accessories): the clip guard's points
 *  - her eyes: each eye bone's own vertices, the front half: the centre across and up, the 85th percentile forward (as measureEyeAnchors)
 *  - her mouth: the vertices her "あ" (open mouth) shape moves most; a model without one: two fifths of the way down to her chin
 * Everything relative to the figure's head bone, in her frame (she faces +z at rest), in metres. A model with no eye vertices: null (the caller
 * falls back to fallbackFace from her height). Three.js math only, no DOM.
 */
import { Vector3, type Bone, type SkinnedMesh } from 'three';
import type { FaceGeometry, V3 } from '../../../shared/unbound/arrival';
import { StandardBody } from './standard-body';
import { MORPH_ALIASES } from '../../../shared/foundation/universal-skeleton';

/** At most this many head points are kept for the clip guard (an even sample of all of them). */
export const FACE_POINTS = 1500;

function descendants(root: Bone): Set<Bone> {
  const out = new Set<Bone>();
  root.traverse(node => { if ((node as Bone).isBone) out.add(node as Bone); });
  return out;
}

/** How far each vertex moves in the mesh's "あ" (open mouth) shape, by the universal aliases; null when the mesh has none. */
function openMouthMoves(mesh: SkinnedMesh): Float32Array | null {
  const dictionary = mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary);
  const key = MORPH_ALIASES.a.map(alias => keys.find(k => k.toLowerCase() === alias.toLowerCase())).find((k): k is string => !!k);
  const target = key === undefined ? undefined : mesh.geometry?.morphAttributes.position?.[dictionary[key]], position = mesh.geometry?.getAttribute('position');
  if (!target || !position || target.count !== position.count) return null;
  const relative = mesh.geometry.morphTargetsRelative === true, out = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const dx = target.getX(i) - (relative ? 0 : position.getX(i)), dy = target.getY(i) - (relative ? 0 : position.getY(i)), dz = target.getZ(i) - (relative ? 0 : position.getZ(i));
    out[i] = Math.hypot(dx, dy, dz);
  }
  return out;
}

/** Every vertex of `mesh` (world, model units) whose strongest bone is in `bones`, with that bone and how far its "あ" moves it. */
function ownVertices(mesh: SkinnedMesh, bones: Set<Bone>, visit: (p: Vector3, bone: Bone, mouth: number) => void): void {
  const position = mesh.geometry?.getAttribute('position'), skinIndex = mesh.geometry?.getAttribute('skinIndex'), skinWeight = mesh.geometry?.getAttribute('skinWeight');
  if (!position || !skinIndex || !skinWeight || !mesh.skeleton) return;
  const list = mesh.skeleton.bones, p = new Vector3(), moves = openMouthMoves(mesh);
  for (let i = 0; i < position.count; i++) {
    let best = -1, weight = 0;
    for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(i, k); if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); } }
    const bone = list[best];
    if (!bone || !bones.has(bone)) continue;
    mesh.getVertexPosition(i, p);
    visit(mesh.localToWorld(p), bone, moves?.[i] ?? 0);
  }
}

const at = (values: number[], q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];

/** The face of the figure's mesh (`unitM`: metres per model unit; `head`, `eyes`: the figure's own bones). Null when it cannot be measured. */
export function measureFace(mesh: SkinnedMesh, head: Bone | null, eyes: readonly Bone[], unitM: number): FaceGeometry | null {
  if (!head) return null;
  mesh.updateMatrixWorld(true);
  const body = StandardBody.ofMesh(mesh);
  // The model's own head and eyes: an MMD mesh's are the figure's; a VRM's are the model's bones the standard skeleton drives.
  const sources: { mesh: SkinnedMesh; head: Bone; eyes: Bone[] }[] = body
    ? body.model.meshes.map(m => ({ mesh: m, head: body.model.bone('head')!, eyes: [body.model.bone('eyeLeft'), body.model.bone('eyeRight')].filter((b): b is Bone => !!b) })).filter(s => !!s.head)
    : [{ mesh, head, eyes: [...eyes] }];
  if (!sources.length) return null;
  const origin = head.getWorldPosition(new Vector3());
  const rel = (p: Vector3): V3 => ({ x: (p.x - origin.x) * unitM, y: (p.y - origin.y) * unitM, z: (p.z - origin.z) * unitM });
  const headPoints: V3[] = [], ownHead: V3[] = [], eyePoints = new Map<Bone, V3[]>(), mouth: { v: V3; move: number }[] = [];
  for (const source of sources) {
    const all = descendants(source.head), eyeSet = new Set(source.eyes);
    ownVertices(source.mesh, all, (p, bone, move) => {
      const v = rel(p);
      headPoints.push(v);
      if (bone === source.head) ownHead.push(v);
      if (move > 0) mouth.push({ v, move });
      if (eyeSet.has(bone)) { const list = eyePoints.get(bone) ?? []; list.push(v); eyePoints.set(bone, list); }
    });
  }
  const eyeCentres: { c: V3; size: number }[] = [];
  for (const points of eyePoints.values()) {
    if (points.length < 12) continue;
    const zs = points.map(p => p.z).sort((a, b) => a - b), front = points.filter(p => p.z >= at(zs, 0.5));
    const ys = front.map(p => p.y).sort((a, b) => a - b);
    eyeCentres.push({ c: { x: front.reduce((s, p) => s + p.x, 0) / front.length, y: front.reduce((s, p) => s + p.y, 0) / front.length, z: at(zs, 0.85) }, size: at(ys, 0.95) - at(ys, 0.05) });
  }
  if (eyeCentres.length < 2 || headPoints.length < 50) return null;
  const eyesMid = { x: (eyeCentres[0].c.x + eyeCentres[1].c.x) / 2, y: (eyeCentres[0].c.y + eyeCentres[1].c.y) / 2, z: (eyeCentres[0].c.z + eyeCentres[1].c.z) / 2 };
  const span = Math.abs(eyeCentres[0].c.x - eyeCentres[1].c.x), eyeSizeM = (eyeCentres[0].size + eyeCentres[1].size) / 2;
  // Her mouth: the vertices her "あ" moves most (over a third of the most), below her eyes, between them: their middle height. A model
  // without an "あ" on its head: two fifths of the way from her eyes to her chin (the head bone's own lowest vertex in front, between the eyes).
  const most = mouth.reduce((m, p) => Math.max(m, p.move), 0);
  const lips = mouth.filter(p => p.move > most / 3 && p.v.y < eyesMid.y && Math.abs(p.v.x - eyesMid.x) < span);
  let mouthDropM = lips.length >= 4 ? eyesMid.y - lips.reduce((s, p) => s + p.v.y, 0) / lips.length : NaN;
  if (!(mouthDropM > 0.01)) {
    const band = ownHead.filter(p => Math.abs(p.x - eyesMid.x) < 0.45 * span && p.z > eyesMid.z - 0.03 && p.y < eyesMid.y).map(p => p.y).sort((a, b) => a - b);
    mouthDropM = band.length >= 8 ? 0.4 * (eyesMid.y - at(band, 0.02)) : NaN;
  }
  const stride = Math.max(1, Math.ceil(headPoints.length / FACE_POINTS));
  const points = headPoints.filter((_, i) => i % stride === 0);
  // The farthest-forward points always stay in the sample (the nose tip, the bangs' front): the clip guard must not miss them.
  const forward = [...headPoints].sort((a, b) => b.z - a.z).slice(0, 24);
  return { eyes: eyesMid, eyeSizeM, mouthDropM, points: [...points, ...forward] };
}
