/**
 * Development: where the stage puts the procedural blush on a PMX, next to where the face really is (read only, prints only).
 * Everything in head-local units divided by the eye-bone distance E, x right, y up, z forward, origin at the midpoint of the eye bones.
 *   node node_modules/tsx/dist/cli.mjs scripts/model-lab/blush-probe.mts <model.pmx>
 */
import { Matrix4, Vector3, type Bone, type SkinnedMesh } from 'three';
import { loadPmxForTargets } from '../../tests/public-gene-fixture.ts';
import { StageModelProfile } from '../../src/stage/model-profile.ts';
import { probeBlushAnchors } from '../../src/stage/procedural-blush.ts';
import { DEFAULT_BLUSH_CALIBRATION } from '../../shared/mood/blush.ts';

const file = process.argv[2];
if (!file) { console.error('usage: blush-probe.mts <model.pmx>'); process.exit(2); }
const model = await loadPmxForTargets(file);
const mesh = model.mesh as SkinnedMesh;
const profile = new StageModelProfile(mesh, { reviewed: false });
const find = (name: string) => mesh.skeleton.bones.find((b: Bone) => b.name === name);
const head = find('頭')!;
profile.attachHead(head);
mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
const eyes = [find('左目'), find('右目')].filter((b): b is Bone => !!b);
const probe = probeBlushAnchors(mesh, head, eyes, undefined, DEFAULT_BLUSH_CALIBRATION, profile.mouthLocal);
if (!probe.supported || !probe.anchors) { console.log('not supported:', probe.reason); process.exit(0); }
const a = probe.anchors;
const toHead = head.matrixWorld.clone().invert();
const E = a.boneEyeDistance;
const eyeL = eyes.map(b => b.getWorldPosition(new Vector3()).applyMatrix4(toHead)).sort((p, q) => p.x - q.x);
const mid = eyeL[0].clone().add(eyeL[1]).multiplyScalar(0.5);
const right = new Vector3(...a.right), up = new Vector3(...a.up), fwd = new Vector3(...a.forward);
const rel = (p: number[] | Vector3) => { const d = new Vector3(...(Array.isArray(p) ? p : p.toArray())).sub(mid); return [d.dot(right) / E, d.dot(up) / E, d.dot(fwd) / E].map(v => +v.toFixed(2)); };
console.log('E (units)', +E.toFixed(3), 'eyeReference', a.eyeReference, 'surface', a.surfaceSource, 'mouthEstimated', a.mouthEstimated);
console.log('eye bones', JSON.stringify(eyeL.map(rel)));
console.log('anchor eyes', JSON.stringify(rel(a.leftEye)), JSON.stringify(rel(a.rightEye)), 'mouth', JSON.stringify(rel(a.mouth)));
console.log('cheeks', JSON.stringify(rel(a.leftCheek)), JSON.stringify(rel(a.rightCheek)));
// real face geometry: per material, head-local bounding box (rest pose), only vertices near the face
const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const transform = new Matrix4().multiplyMatrices(toHead, mesh.matrixWorld);
const index = mesh.geometry.index!;
for (const [mi, m] of mats.entries()) {
  const groups = mesh.geometry.groups.filter(g => g.materialIndex === mi);
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const seen = new Set<number>();
  for (const g of groups) for (let i = g.start; i < g.start + g.count; i++) {
    const v = index.getX(i); if (seen.has(v)) continue; seen.add(v);
    const p = mesh.getVertexPosition(v, new Vector3()).applyMatrix4(transform);
    const r = rel(p); if (r[1] > -4 && r[1] < 3 && Math.abs(r[0]) < 4 && r[2] > -1) { xs.push(r[0]); ys.push(r[1]); zs.push(r[2]); }
  }
  if (xs.length < 4) continue;
  const mean = (v: number[]) => +(v.reduce((s, t) => s + t, 0) / v.length).toFixed(2);
  console.log(String(mi).padStart(2), m.name.padEnd(44), 'near-face verts', xs.length, 'x', Math.min(...xs).toFixed(2), Math.max(...xs).toFixed(2), 'y', Math.min(...ys).toFixed(2), Math.max(...ys).toFixed(2), 'z mean', mean(zs));
}
console.log('blush materials', JSON.stringify(a.materialIndices.map(i => mats[i].name)));
