export interface VmdBoneFrame {
  boneName: string;
  frameNum: number;
  position: readonly number[];
  rotation: readonly number[];
}

export interface VmdMorphFrame {
  morphName: string;
  frameNum: number;
  weight: number;
}

export interface VmdTrackData {
  metadata: { motionCount: number; morphCount: number };
  motions: readonly VmdBoneFrame[];
  morphs: readonly VmdMorphFrame[];
}

export interface VmdTrackCounts {
  boneTracks: number;
  boneKeyframes: number;
  morphTracks: number;
  morphKeyframes: number;
}

export interface VmdTrackReport {
  before: VmdTrackCounts;
  after: VmdTrackCounts;
  removedBoneNames: string[];
  removedMorphNames: string[];
  keptStaticPoseNames: string[];
  keptStaticMorphNames: string[];
  /** Original bone/morph endpoint, even when the last remaining default track is removed. */
  durationFrames: number;
}

const ROTATION_EPSILON = 1e-8;
const validTime = (value: number) => Number.isInteger(value) && value >= 0;
const vector = (values: readonly number[], length: number) => values.length === length && values.every(Number.isFinite);
function validRotation(rotation: readonly number[]): boolean {
  return vector(rotation, 4) && Math.abs(rotation.reduce((sum, value) => sum + value * value, 0) - 1) <= 1e-7;
}
function sameRotation(first: readonly number[], next: readonly number[]): boolean {
  if (!validRotation(first) || !validRotation(next)) return false;
  const sign = first.reduce((sum, value, index) => sum + value * next[index], 0) < 0 ? -1 : 1;
  return first.every((value, index) => Math.abs(value - next[index] * sign) <= ROTATION_EPSILON);
}
const validBone = (frame: VmdBoneFrame) => validTime(frame.frameNum) && vector(frame.position, 3) && validRotation(frame.rotation);
const defaultBone = (frame: VmdBoneFrame) => validBone(frame) && frame.position.every(value => value === 0) &&
  frame.rotation.slice(0, 3).every(value => Math.abs(value) <= ROTATION_EPSILON) && Math.abs(Math.abs(frame.rotation[3]) - 1) <= ROTATION_EPSILON;
const defaultMorph = (frame: VmdMorphFrame) => validTime(frame.frameNum) && Number.isFinite(frame.weight) && frame.weight === 0;

function grouped<T>(frames: readonly T[], name: (frame: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const frame of frames) {
    const key = name(frame);
    const track = result.get(key);
    if (track) track.push(frame); else result.set(key, [frame]);
  }
  return result;
}

/**
 * Drop only whole tracks that always equal the model's default transform/zero morph.
 * A non-default static pose is meaningful initialization, so it stays intact. This
 * does not trim time, change interpolation, strip unknown bones, or rewrite files.
 * The caller must keep report.durationFrames / 30 as a lower bound on clip duration.
 */
export function stripDefaultVmdTracks<T extends VmdTrackData>(source: T): { vmd: T; report: VmdTrackReport } {
  const bones = grouped(source.motions, frame => frame.boneName);
  const morphs = grouped(source.morphs, frame => frame.morphName);
  const removedBones = new Set<string>();
  const removedMorphs = new Set<string>();
  const keptStaticPoseNames: string[] = [];
  const keptStaticMorphNames: string[] = [];
  for (const [name, frames] of bones) {
    if (frames.every(defaultBone)) removedBones.add(name);
    else {
      const first = frames[0];
      if (validBone(first) && frames.every(frame => validBone(frame) &&
        frame.position.every((value, index) => value === first.position[index]) && sameRotation(first.rotation, frame.rotation)))
        keptStaticPoseNames.push(name);
    }
  }
  for (const [name, frames] of morphs) {
    if (frames.every(defaultMorph)) removedMorphs.add(name);
    else if (Number.isFinite(frames[0].weight) && frames.every(frame => validTime(frame.frameNum) && frame.weight === frames[0].weight))
      keptStaticMorphNames.push(name);
  }
  const motions = source.motions.filter(frame => !removedBones.has(frame.boneName));
  const morphFrames = source.morphs.filter(frame => !removedMorphs.has(frame.morphName));
  let durationFrames = 0;
  for (const frames of [source.motions, source.morphs])
    for (const frame of frames) if (validTime(frame.frameNum)) durationFrames = Math.max(durationFrames, frame.frameNum);
  return {
    vmd: {
      ...source,
      metadata: { ...source.metadata, motionCount: motions.length, morphCount: morphFrames.length },
      motions,
      morphs: morphFrames,
    },
    report: {
      before: { boneTracks: bones.size, boneKeyframes: source.motions.length, morphTracks: morphs.size, morphKeyframes: source.morphs.length },
      after: { boneTracks: bones.size - removedBones.size, boneKeyframes: motions.length, morphTracks: morphs.size - removedMorphs.size, morphKeyframes: morphFrames.length },
      removedBoneNames: [...removedBones], removedMorphNames: [...removedMorphs], keptStaticPoseNames, keptStaticMorphNames, durationFrames,
    },
  };
}
