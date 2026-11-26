/**
 * What the stage will see in a PMX (development; read only, prints to the console, writes nothing):
 * the model profile (standard bones, face slots, rest pose), hair/chest physics support, and the arm directions after a
 * bundled motion next to Gene's (raw, as a user VMD plays, and through the stage's motion retarget).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/model-lab/pmx-check.mts <model.pmx> [--motion pose/stand] [--at 1.0]
 *
 * Builds the mesh with three's own MMDLoader (inert textures, no renderer), like tests/public-gene-fixture.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, Vector3, type AnimationClip, type Bone, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { loadPmxForTargets, loadPublicGeneForTargets } from '../../tests/public-gene-fixture.ts';
import { StageModelProfile } from '../../src/stage/model-profile.ts';
import { buildPhysicsRigPlan } from '../../src/stage/physics-rig.ts';
import { StageMotionRetarget } from '../../src/actions/motion-retarget.ts';
import { parseVmdWith } from '../../src/foundation/vmd.ts';
import { probeBlushAnchors } from '../../src/stage/procedural-blush.ts';
import { DEFAULT_BLUSH_CALIBRATION } from '../../shared/mood/blush.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--motion' && args[args.indexOf(arg) - 1] !== '--at');
if (!file) { console.error('usage: pmx-check.mts <model.pmx> [--motion pose/stand] [--at seconds]'); process.exit(2); }
const motion = args.includes('--motion') ? args[args.indexOf('--motion') + 1] : 'pose/stand';
const at = args.includes('--at') ? Number(args[args.indexOf('--at') + 1]) : 1.0;
const motionFile = path.join(REPO, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions', `${motion}.vmd`);

const model = await loadPmxForTargets(file);
const gene = await loadPublicGeneForTargets();
const mesh = model.mesh as SkinnedMesh;
const profile = new StageModelProfile(mesh, { reviewed: false });
const summary = profile.summary;
console.log('profile', JSON.stringify({ restPose: summary.restPose, restArmDeg: summary.restArmDeg, headsTall: summary.headsTall, eyes: summary.eyes, mouth: summary.mouth,
  missingBones: summary.missingBones, ambiguousBones: summary.ambiguousBones, features: summary.features, found: summary.found, missing: summary.missing, scales: summary.scales }, null, 1));
const find = (name: string) => mesh.skeleton.bones.find((b: Bone) => b.name === name);
const head = find('頭');
profile.attachHead(head);
const blush = probeBlushAnchors(mesh, head, [find('左目'), find('右目')].filter((b): b is Bone => !!b), undefined, DEFAULT_BLUSH_CALIBRATION, profile.mouthLocal);
console.log('procedural blush', blush.supported ? `supported (${blush.anchors?.eyeReference}, ${blush.anchors?.surfaceSource}, materials ${blush.anchors?.materialIndices.map(i => (Array.isArray(mesh.material) ? mesh.material[i] : mesh.material).name).join(', ')})` : `not supported: ${blush.reason}`);
const plan = buildPhysicsRigPlan(mesh);
console.log('physics', JSON.stringify(plan.support), 'hair bodies', plan.hair.rigidBodies.length, 'chest bodies', plan.chest.rigidBodies.length);

const bytes = readFileSync(motionFile);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const builder = (new MMDLoader() as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
const SEGMENTS = [['左腕', '左ひじ'], ['左ひじ', '左手首'], ['右腕', '右ひじ'], ['右ひじ', '右手首'], ['左足', '左ひざ'], ['首', '頭']] as const;
function directions(target: SkinnedMesh, vmd: unknown) {
  const mixer = new AnimationMixer(target);
  mixer.clipAction(builder.build(vmd, target)).play();
  mixer.update(at);
  target.updateMatrixWorld(true);
  const bone = (name: string) => target.skeleton.bones.find((b: Bone) => b.name === name)!;
  return SEGMENTS.map(([a, b]) => bone(b).getWorldPosition(new Vector3()).sub(bone(a).getWorldPosition(new Vector3())).normalize());
}
// The retarget reads the rest rig from the mesh: build it before anything is posed.
const retarget = new StageMotionRetarget(mesh, profile.profile, { reviewed: false });
const rest = mesh.skeleton.bones.map((bone: Bone) => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
const reset = () => mesh.skeleton.bones.forEach((bone: Bone, k: number) => { bone.position.copy(rest[k].position); bone.quaternion.copy(rest[k].quaternion); });
const reference = directions(gene.mesh as SkinnedMesh, parseVmdWith(buffer.slice(0)));
const raw = directions(mesh, parseVmdWith(buffer.slice(0)));
reset();
const retargeted = directions(mesh, parseVmdWith(buffer.slice(0), retarget.transform));
const angle = (a: Vector3, b: Vector3) => Math.round(Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * 1800 / Math.PI) / 10;
console.log(`motion ${motion} at ${at}s: angle between this model's segment and Gene's (degrees)`);
SEGMENTS.forEach(([a, b], k) => console.log(`  ${a}→${b}: raw ${angle(raw[k], reference[k])}°, retargeted ${angle(retargeted[k], reference[k])}°`));
model.close(); gene.close();
