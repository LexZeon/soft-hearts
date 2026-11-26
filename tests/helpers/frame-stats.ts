/**
 * Frame-statistics helpers shared by the real-frame tests (I-176 step 3, docs/claude/2026-11-23-i176-delete.md): what is left of the old
 * stage's R29 scenario harness (tests/helpers/gene-stage-harness.ts, deleted with the old stage) once the stage itself is gone: the bone
 * sets, the catalogue motion files, the shown-frame record and its step / surprise / percentile measures. Pure; no stage.
 */
import { Quaternion, type Vector3 } from 'three';
import catalog from '../../shared/actions/motion-catalog.json';
import type { MusicEnergySample } from '../../src/stage/music-dance';
import { EMPTY_CONTACT, type MoodContact } from '../../src/mood/mood-feedback';

/** Bones whose displayed motion is the visible pose (head, neck, torso, shoulders, arms). */
export const TRACKED_BONES = ['センター', '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ'] as const;
/**
 * R29d: bones the MMD helper derives after the mixer (Gene's grant children and
 * IK links), recorded separately so the R29b/R29c measures stay as they were.
 */
export const DERIVED_BONES = ['右肩連', '左腕捩連', '右腕捩連', '左手捩連', '右手捩連', '右腕xca', '前クローク2_1xca'] as const;

/** Bundled bytes of a catalog motion (the host serves the same bytes over mmd-asset://). */
export function catalogMotionFile(packId: string, motionId: string): URL {
  const pack = catalog.packs.find(value => value.id === packId)!;
  const motion = pack.motions.find(value => value.id === motionId)!;
  return new URL(`../../assets/bundled/${pack.source}/${pack.id}/${pack.revision}/${motion.relativePath}`, import.meta.url);
}
export const catalogSha = (packId: string, motionId: string) =>
  catalog.packs.find(value => value.id === packId)!.motions.find(value => value.id === motionId)!.sha256;
/** A selected-layer AssetRef for a catalog motion, loaded by the Stage's own loadMotions from local bytes. */
export function catalogAsset(packId: string, motionId: string) {
  const url = catalogMotionFile(packId, motionId).href;
  return { path: `${motionId}.vmd`, url, name: `${motionId}.vmd` };
}

export interface ShownFrame {
  /** Seconds since the harness started. */
  t: number;
  /** World quaternion per tracked bone, as displayed (continuity offset included). */
  world: Quaternion[];
  /** Eyelid (まばたき) and smile (笑い) weights as displayed. */
  blink: number;
  smile: number;
  /** R29c: the drowsy brow (困る) and eye-shape (じと目) weights as displayed. */
  brow: number;
  jitome: number;
  /** R29d: the shown lip-sync mouth (あ) weight and the derived bones' world rotations (DERIVED_BONES order). */
  mouth: number;
  derived: Quaternion[];
  /** R29d: the display guard's jump count so far and the property it last caught (a jump = a one-frame cut it had to absorb). */
  guardJumps: number;
  guardLast: string | null;
  /** R29f: world rotations of GeneStageOptions.extraBones (empty when none). */
  extra: Quaternion[];
  /** Skeleton step 4: world positions of GeneStageOptions.extraBones, as displayed (model space is world space here). */
  extraAt: Vector3[];
  /** T-215 (GeneStageOptions.recordAll): every morph influence, then every bone's local quaternion and position, as displayed. */
  all: Float64Array | null;
}


/** A deterministic stand-in for a song: steady 120 BPM kick with a moving mid band. */
export function songSample(frame: number, rate = 30): MusicEnergySample {
  const beat = Math.round(rate / 2), kick = frame % beat === 0;
  return { time: frame / rate, rms: kick ? 0.4 : 0.14, low: kick ? 0.8 : 0.1, mid: 0.2 + Math.sin(frame / 20) * 0.1, high: 0.1 };
}

/** A pat as PetInteraction reports it (the existing class name): valid scalp hits enter rua at once with hover 1, strokes left-right. */ // no-pet-ok: existing class name
export function patContact(time: number): MoodContact {
  const x = Math.sin(time * 6) * 0.45, vx = Math.cos(time * 6) * 2.7;
  return { ...EMPTY_CONTACT, contact: true, hover: 1, x, y: -0.25, velocityX: vx, velocityY: 0, speed: Math.abs(vx) };
}


const DEG = 180 / Math.PI;
/** Per-frame displayed angular step (degrees) of each tracked bone. */
/** Which recorded rotations to measure: the tracked visible bones (default) or R29d's derived bones. */
export type BoneSet = 'world' | 'derived';
const boneCount = (set: BoneSet) => set === 'world' ? TRACKED_BONES.length : DERIVED_BONES.length;
export function steps(frames: readonly ShownFrame[], set: BoneSet = 'world'): number[][] {
  return Array.from({ length: boneCount(set) }, (_, bone) => frames.slice(1).map((frame, i) => frame[set][bone].angleTo(frames[i][set][bone]) * DEG));
}
/**
 * Unexpected motion per frame (degrees): how far this frame's world-space step
 * departs from simply repeating the previous step. Steady or smoothly changing
 * motion stays small; a teleport, a stop dead or a start at full speed is one
 * large value. (Index i belongs to frame i + 2.)
 */
export function surprises(frames: readonly ShownFrame[], set: BoneSet = 'world'): number[][] {
  const step = new Quaternion(), last = new Quaternion(), inverse = new Quaternion();
  return Array.from({ length: boneCount(set) }, (_, bone) => {
    const out: number[] = [];
    for (let i = 2; i < frames.length; i++) {
      step.copy(frames[i][set][bone]).multiply(inverse.copy(frames[i - 1][set][bone]).invert());
      last.copy(frames[i - 1][set][bone]).multiply(inverse.copy(frames[i - 2][set][bone]).invert());
      out.push(step.angleTo(last) * DEG);
    }
    return out;
  });
}
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;
}
export const between = (frames: readonly ShownFrame[], from: number, to: number) => frames.filter(frame => frame.t >= from - 1e-9 && frame.t <= to + 1e-9);
