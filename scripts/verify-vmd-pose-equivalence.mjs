/** CPU-only, read-only source equivalence: node --import tsx scripts/verify-vmd-pose-equivalence.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, Bone, BufferGeometry, LoopOnce, MeshBasicMaterial, Skeleton, SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { readableVmdHeader } from '../src/stage/vmd.ts';
import { stripDefaultVmdTracks } from '../src/stage/vmd-tracks.ts';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(workspace, 'shared/motion-catalog.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(workspace, 'shared/bundled-assets.json'), 'utf8'));
const parser = new MMDParser.Parser();
const modelBytes = await readFile(path.join(workspace, 'assets/bundled', manifest.root, manifest.model.relativePath));
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const model = parser.parsePmx(arrayBuffer(modelBytes), true);
const builder = new MMDLoader().animationBuilder;
const tolerance = 1e-6;
const records = [];
const failures = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function rig() {
  // This is the same PMX rest-transform construction used by MMDLoader's MeshBuilder.
  // Geometry/texture data is unnecessary for AnimationMixer's bone and morph bindings.
  const bones = model.bones.map(entry => {
    const bone = new Bone();
    bone.name = entry.name;
    bone.position.fromArray(entry.position);
    if (entry.parentIndex >= 0) bone.position.sub({ x: model.bones[entry.parentIndex].position[0], y: model.bones[entry.parentIndex].position[1], z: model.bones[entry.parentIndex].position[2] });
    return bone;
  });
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  model.bones.forEach((entry, index) => {
    if (entry.parentIndex >= 0) bones[entry.parentIndex].add(bones[index]); else mesh.add(bones[index]);
  });
  mesh.bind(new Skeleton(bones));
  mesh.morphTargetDictionary = Object.fromEntries(model.morphs.map((entry, index) => [entry.name, index]));
  mesh.morphTargetInfluences = model.morphs.map(() => 0);
  return mesh;
}

function sampled(vmd, time, sourceDuration) {
  const mesh = rig();
  const clip = builder.build(vmd, mesh);
  const builderDuration = clip.duration;
  clip.duration = Math.max(sourceDuration, clip.duration, 1 / 30);
  const mixer = new AnimationMixer(mesh);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(time);
  mesh.updateMatrixWorld(true);
  const result = {
    builderDuration, duration: clip.duration, clipTracks: clip.tracks.length,
    bones: mesh.skeleton.bones.map(bone => ({ name: bone.name, position: bone.position.toArray(), quaternion: bone.quaternion.toArray() })),
    restPositions: model.bones.map(entry => entry.position.map((value, index) => value - (entry.parentIndex >= 0 ? model.bones[entry.parentIndex].position[index] : 0))),
    morphs: [...mesh.morphTargetInfluences],
  };
  mixer.stopAllAction();
  mixer.uncacheRoot(mesh);
  mesh.skeleton.dispose();
  mesh.geometry.dispose();
  mesh.material.dispose();
  return result;
}

for (const pack of catalog.packs) for (const entry of pack.motions) {
  const relative = `${pack.source}/${pack.id}/${pack.revision}/${entry.relativePath}`;
  const file = path.join(workspace, 'assets/bundled', ...relative.split('/'));
  const bytes = await readFile(file);
  assert.equal(hash(bytes), entry.sha256);
  const raw = parser.parseVmd(readableVmdHeader(arrayBuffer(bytes)), true);
  const { vmd, report } = stripDefaultVmdTracks(raw);
  const rawBoneNames = new Set(raw.motions.map(frame => frame.boneName));
  const filteredBoneNames = new Set(vmd.motions.map(frame => frame.boneName));
  const removedBoneNames = new Set(report.removedBoneNames);
  const duration = Math.max(report.durationFrames / 30, 1 / 30);
  const times = [...new Set([0, Math.min(0.5, duration), duration / 2, Math.max(0, duration - 1 / 300), duration])].sort((a, b) => a - b);
  const samples = [];
  for (const time of times) {
    const original = sampled(raw, time, duration);
    const filtered = sampled(vmd, time, duration);
    let positionError = 0, quaternionError = 0, morphError = 0, motionDeltaError = 0, unexplainedPositionError = 0;
    let worstBone = null, worstMorph = null;
    for (let index = 0; index < original.bones.length; index++) {
      const a = original.bones[index], b = filtered.bones[index];
      const p = Math.max(...a.position.map((value, component) => Math.abs(value - b.position[component])));
      const rest = original.restPositions[index];
      const originalBase = rest.map(value => rawBoneNames.has(a.name) ? Math.fround(value) : value);
      const filteredBase = rest.map(value => filteredBoneNames.has(a.name) ? Math.fround(value) : value);
      const delta = Math.max(...a.position.map((value, component) => Math.abs(
        (value - originalBase[component]) - (b.position[component] - filteredBase[component]),
      )));
      const unexplained = Math.max(...a.position.map((value, component) => Math.abs(
        value - (b.position[component] + (removedBoneNames.has(a.name) ? Math.fround(rest[component]) - rest[component] : 0)),
      )));
      motionDeltaError = Math.max(motionDeltaError, delta);
      unexplainedPositionError = Math.max(unexplainedPositionError, unexplained);
      // q and -q encode the same orientation.
      const q = Math.min(
        Math.max(...a.quaternion.map((value, component) => Math.abs(value - b.quaternion[component]))),
        Math.max(...a.quaternion.map((value, component) => Math.abs(value + b.quaternion[component]))),
      );
      if (p > positionError || q > quaternionError) worstBone = a.name;
      positionError = Math.max(positionError, p);
      quaternionError = Math.max(quaternionError, q);
    }
    original.morphs.forEach((value, index) => {
      const error = Math.abs(value - filtered.morphs[index]);
      if (error > morphError) worstMorph = model.morphs[index].name;
      morphError = Math.max(morphError, error);
    });
    const durationError = Math.abs(original.duration - filtered.duration);
    const passed = [positionError, quaternionError, morphError, durationError].every(value => Number.isFinite(value) && value <= tolerance);
    const sample = { time, positionError, quaternionError, morphError, durationError, passed, worstBone, worstMorph,
      motionDeltaError, unexplainedPositionError,
      motionDeltaPass: [motionDeltaError, quaternionError, morphError, durationError].every(value => Number.isFinite(value) && value <= tolerance),
      originalBuilderDuration: original.builderDuration, filteredBuilderDuration: filtered.builderDuration,
      originalPlaybackDuration: original.duration, filteredPlaybackDuration: filtered.duration,
      originalClipTracks: original.clipTracks, filteredClipTracks: filtered.clipTracks };
    samples.push(sample);
    if (!passed) failures.push({ packId: pack.id, motionId: entry.id, ...sample });
  }
  assert.equal(hash(await readFile(file)), entry.sha256, 'source file remains untouched');
  records.push({ packId: pack.id, motionId: entry.id, sha256: entry.sha256, durationFrames: report.durationFrames,
    keptStaticPoseNames: report.keptStaticPoseNames, keptStaticMorphNames: report.keptStaticMorphNames,
    passed: samples.every(sample => sample.passed), samples });
}

const samples = records.flatMap(record => record.samples);
const report = {
  status: failures.length ? 'FAIL' : 'PASS', motions: records.length, sampleCount: samples.length,
  modelRevision: manifest.root, boneCount: model.bones.length, morphCount: model.morphs.length,
  tolerance, maximumPositionError: Math.max(...samples.map(sample => sample.positionError)),
  maximumQuaternionError: Math.max(...samples.map(sample => sample.quaternionError)),
  maximumMorphError: Math.max(...samples.map(sample => sample.morphError)),
  maximumDurationError: Math.max(...samples.map(sample => sample.durationError)),
  maximumMotionDeltaError: Math.max(...samples.map(sample => sample.motionDeltaError)),
  maximumUnexplainedPositionError: Math.max(...samples.map(sample => sample.unexplainedPositionError)),
  motionDeltaPass: samples.every(sample => sample.motionDeltaPass),
  strictAbsolutePosePass: failures.length === 0,
  method: 'Actual Three r170 MMDLoader.animationBuilder and AnimationMixer, independent fresh Gene Bone/Skeleton/SkinnedMesh per sample. Both original and filtered clips retain original source duration. Samples include start, 0.5s (clamped), midpoint, near endpoint and exact endpoint. All local bone positions, quaternion orientations and Gene morph weights compared.',
  limits: ['No textures, DOM, GPU rendering, IK/grant solving, physics or vertex deformation are exercised.', 'The audit uses the bundled Gene skeleton; other models need their own playback review.', 'An original default position track quantizes the local PMX rest position into Float32 keyframe values. Removing it keeps the unquantized rest value; this can exceed absolute 1e-6 by one Float32 unit. Raw absolute errors remain reported and determine strict status. Motion-delta and unexplained errors separately establish whether this is only rest-position quantization.'],
  sourceFilesUnchanged: true, failures, records,
};
const output = path.join(workspace, '.local/static-track-audit');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'pose-equivalence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, motions: report.motions, samples: report.sampleCount,
  maximumPositionError: report.maximumPositionError, maximumQuaternionError: report.maximumQuaternionError,
  maximumMorphError: report.maximumMorphError, maximumDurationError: report.maximumDurationError, failures: failures.length }, null, 2));
assert.equal(failures.length, 0, 'Filtered tracks must preserve sampled Gene poses and source duration');
