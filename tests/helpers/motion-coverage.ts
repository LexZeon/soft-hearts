// I-152 step 2: the motion coverage table (docs/claude/2026-11-19-native-models-plan.md「动作覆盖表」). Every library motion on three
// test models through Unbound's engine, the way the companion window loads it: the public Gene (reviewed: its VMDs as authored), Gene
// with every standard bone renamed to English ("改了骨骼名的 PMX": not reviewed, the stage's motion conversion with its profile),
// and the synthetic VRM (the standard body: conversion onto the standard skeleton, then onto the VRM's own bones).
// Per motion and model: which tracks land (a moving track whose bone is not on the mesh would be dropped by MMDLoader's clip
// builder without a word: counted here as "silent"), what the conversion reports it cannot do (lost parts, dropped faces), and a
// short run of the real figure (bridged in from the previous motion, as on the companion): NaN anywhere, the largest per-frame turn of
// the body's bones, where her hips go.
import { Quaternion, Vector3, type AnimationClip, type Bone, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { parseVmdWith, type VmdDataTransform } from '../../src/foundation/vmd';
import { withKeyframeInterpolation } from '../../src/stage/keyframe-interpolation';
import { StageModelProfile } from '../../src/stage/model-profile';
import { StageMotionRetarget } from '../../src/actions/motion-retarget';
import { UnboundFigure } from '../../src/unbound/figure';
import { STANDARD_POSE, standardPartOfTrack, type FingerSlot, type StandardBone } from '../../shared/foundation/universal-skeleton';
import { retargetTracks, type RetargetPlan, type VmdLike } from '../../shared/actions/motion-retarget';
import { catalogMotions, motionBytes } from './bundled-motions';
import { loadPublicGeneForTargets } from '../public-gene-fixture';
import { TRACKED } from './unbound-gene';
import { syntheticStandardBody, trackedBones } from './unbound-vrm';
import type { StandardBody } from '../../src/unbound/model/standard-body';

const DEG = 180 / Math.PI;
export type CoverageModel = 'gene' | 'renamed-pmx' | 'vrm';

/** Gene's standard names → English ones the alias table knows (a model exported from another tool). */
const ENGLISH: Readonly<Partial<Record<StandardBone, string>>> = {
  root: 'Root', center: 'Center', groove: 'Groove', waist: 'Waist', lowerBody: 'Hips', upperBody: 'Spine', upperBody2: 'Chest', neck: 'Neck', head: 'Head',
  eyes: 'Eyes', ...Object.fromEntries((['Left', 'Right'] as const).flatMap(side => [['eye', 'Eye'], ['shoulder', 'Shoulder'], ['arm', 'Arm'], ['armTwist', 'ArmTwist'],
    ['elbow', 'Elbow'], ['wristTwist', 'WristTwist'], ['wrist', 'Wrist'], ['leg', 'Leg'], ['knee', 'Knee'], ['ankle', 'Ankle'], ['toe', 'Toe'], ['legIk', 'LegIK'],
    ['toeIk', 'ToeIK']].map(([slot, word]) => [`${slot}${side}`, `${side}${word}`]))),
};
const FINGER_WORD: Record<string, string> = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Little' };
/** Every standard bone and finger joint of Gene under an English name (fingertips too). */
export const RENAMED: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(STANDARD_POSE.bones.flatMap(bone => ENGLISH[bone.slot] ? [[bone.name, ENGLISH[bone.slot]!]] : [])),
  ...Object.fromEntries((STANDARD_POSE.fingers ?? []).map(finger => {
    const side = finger.name.startsWith('左') ? 'Left' : 'Right';
    const word = Object.entries({ 親指: 'thumb', 人指: 'index', 中指: 'middle', 薬指: 'ring', 小指: 'little' }).find(([jp]) => finger.name.includes(jp))![1];
    const tail = finger.slot ? /\d/.exec(finger.slot)![0] : 'Tip';
    return [finger.name, `${side}${FINGER_WORD[word]}${tail}`];
  })),
});

export interface ModelUnderTest {
  model: CoverageModel;
  mesh: SkinnedMesh;
  figure: UnboundFigure;
  transform: VmdDataTransform | undefined;
  plan: RetargetPlan | null;
  tracked: Bone[];
  /** Body segments (from joint, to joint) whose directions are compared across models: upper arms, forearms, thighs, shins, spine. */
  segments: [Bone, Bone][];
  allBones: () => Bone[];
  standard: StandardBody | null;
  /** Standard parts the model really has not (what a motion may lose there, said aloud). */
  lacks: (part: StandardBone | FingerSlot) => boolean;
  close(): void;
}

export async function modelUnderTest(model: CoverageModel): Promise<ModelUnderTest> {
  if (model === 'vrm') {
    const standard = await syntheticStandardBody('1.0');
    const figure = new UnboundFigure(standard.mesh, { xM: 0, depthM: 0 });
    return { model, mesh: standard.mesh, figure, transform: standard.transform, plan: standard.retarget.plan, tracked: trackedBones(standard), standard,
      segments: SEGMENTS.map(([a, b]) => [standard.model.bone(a)!, standard.model.bone(b)!] as [Bone, Bone]),
      allBones: () => standard.model.bones as Bone[],
      lacks: part => (part.match(/^(thumb|index|middle|ring|little)\d/) ? !standard.model.finger(part as FingerSlot) : !standard.model.bone(part as StandardBone)),
      close: () => figure.dispose() };
  }
  const fixture = await loadPublicGeneForTargets();
  const mesh = fixture.mesh;
  const tracked = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const named = (slot: StandardBone) => mesh.skeleton.bones.find(b => b.name === STANDARD_POSE.bones.find(p => p.slot === slot)!.name)!;
  const segments = SEGMENTS.map(([a, b]) => [named(a), named(b)] as [Bone, Bone]);
  let transform: VmdDataTransform | undefined, plan: RetargetPlan | null = null;
  if (model === 'renamed-pmx') {
    for (const bone of mesh.skeleton.bones) if (Object.hasOwn(RENAMED, bone.name)) bone.name = RENAMED[bone.name];
    const retarget = new StageMotionRetarget(mesh, new StageModelProfile(mesh, { reviewed: false }).profile, { reviewed: false });
    transform = retarget.transform as VmdDataTransform | undefined; plan = retarget.plan;
  }
  const figure = new UnboundFigure(mesh, { xM: 0, depthM: 0 });
  return { model, mesh, figure, transform, plan, tracked, segments, standard: null, allBones: () => mesh.skeleton.bones, lacks: () => false,
    close: () => { figure.dispose(); fixture.close(); } };
}

export interface CoverageRow {
  motion: string;
  model: CoverageModel;
  /** Moving tracks (after conversion) whose bone is not on the mesh: dropped without a word. Must be empty. */
  silent: string[];
  /** Standard parts the conversion says it cannot move here (said aloud, in the report). */
  lost: string[];
  /** Expression tracks the model has no expression for. */
  droppedFaces: string[];
  nan: boolean;
  /** Largest per-frame turn of the tracked body bones over the run (deg), and the largest "unexpected step" (R29c). */
  maxStep: number;
  maxSurprise: number;
  /** Her hips over the run, relative to her height: lowest and highest, and the farthest sideways/forward. */
  hips: { low: number; high: number; far: number };
  /** The segments' directions on the last frame (her frame: x her left, y up, z toward you). */
  directions: Vector3[];
}

const SEGMENTS: [StandardBone, StandardBone][] = [['armLeft', 'elbowLeft'], ['elbowLeft', 'wristLeft'], ['armRight', 'elbowRight'], ['elbowRight', 'wristRight'],
  ['legLeft', 'kneeLeft'], ['kneeLeft', 'ankleLeft'], ['legRight', 'kneeRight'], ['kneeRight', 'ankleRight'], ['upperBody', 'neck'], ['neck', 'head']];

const moves = (keys: readonly { position: ArrayLike<number>; rotation: ArrayLike<number> }[]) => keys.some(k =>
  Math.abs(k.rotation[3]) < 1 - 1e-6 || Math.hypot(k.position[0], k.position[1], k.position[2]) > 1e-4);

/** Runs one motion on the model: the clip as her pose (bridged from whatever she showed), `frames` frames at `fps`. */
export function runMotion(m: ModelUnderTest, motion: { id: string; packId: string; relativePath: string }, frames = 36, fps = 30): CoverageRow {
  const bytes = motionBytes(motion.packId, motion.relativePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const source = parseVmdWith(buffer.slice(0)) as unknown as VmdLike;
  const vmd = parseVmdWith(buffer, m.transform) as unknown as VmdLike & { motions: { boneName: string; position: number[]; rotation: number[] }[] };
  const names = new Set(m.mesh.skeleton.bones.map(b => b.name));
  const byTrack = new Map<string, typeof vmd.motions>();
  for (const key of vmd.motions) byTrack.set(key.boneName, [...byTrack.get(key.boneName) ?? [], key]);
  const silent = [...byTrack].filter(([name, keys]) => !names.has(name) && moves(keys)).map(([name]) => name);
  // What the conversion says it cannot do (the same plan as the transform; Gene plays as authored: nothing lost by design).
  const report = m.plan ? retargetTracks(source, m.plan).report : null;
  const lost = [...new Set((report?.lost ?? []).map(name => standardPartOfTrack(name) ?? name))];
  // Faces: a converted motion's report names the expression tracks it found no place for; Gene's own tracks bind by name.
  const dictionary = m.mesh.morphTargetDictionary ?? {}, shows = new Set(source.morphs.filter(f => f.weight > 1e-4).map(f => f.morphName));
  const droppedFaces = report ? [...new Set(report.droppedMorphs)].filter(name => shows.has(name))
    : [...new Set(vmd.morphs.filter(f => dictionary[f.morphName] === undefined && f.weight > 1e-4).map(f => f.morphName))];
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, m.mesh);
  clip.duration = Math.max(clip.duration, 1 / 30);
  m.figure.setClips({ pose: clip, gesture: null, expression: null }, true);
  const shown: { t: number; rotations: Quaternion[] }[] = [];
  let nan = false, low = Infinity, high = -Infinity, far = 0;
  const hips = m.tracked[0], height = m.figure.heightUnits, p = new Vector3();
  for (let i = 0; i < frames; i++) {
    m.figure.frame(1 / fps);
    m.standard?.present();
    m.mesh.updateMatrixWorld(true);
    shown.push({ t: i / fps, rotations: m.tracked.map(b => b.getWorldQuaternion(new Quaternion())) });
    for (const bone of m.allBones()) if (![bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w, bone.position.x, bone.position.y, bone.position.z].every(Number.isFinite)) nan = true;
    hips.getWorldPosition(p);
    low = Math.min(low, p.y / height); high = Math.max(high, p.y / height); far = Math.max(far, Math.hypot(p.x, p.z) / height);
  }
  const steps = shown.slice(1).map((f, i) => Math.max(...f.rotations.map((q, b) => q.angleTo(shown[i].rotations[b]) * DEG)));
  let maxSurprise = 0;
  const s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
  for (let i = 2; i < shown.length; i++) for (let b = 0; b < m.tracked.length; b++) {
    s.copy(shown[i].rotations[b]).multiply(inv.copy(shown[i - 1].rotations[b]).invert());
    l.copy(shown[i - 1].rotations[b]).multiply(inv.copy(shown[i - 2].rotations[b]).invert());
    maxSurprise = Math.max(maxSurprise, s.angleTo(l) * DEG);
  }
  const directions = m.segments.map(([a, b]) => b.getWorldPosition(new Vector3()).sub(a.getWorldPosition(new Vector3())).normalize());
  return { motion: `${motion.packId}/${motion.id}`, model: m.model, silent, lost, droppedFaces, nan, maxStep: Math.max(0, ...steps), maxSurprise, hips: { low, high, far }, directions };
}

export const libraryMotions = catalogMotions;
