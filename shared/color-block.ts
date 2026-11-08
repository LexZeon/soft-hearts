/**
 * I-031 色块诊断日志: what the pet window sends the host when the
 * 色块哨兵 (src/stage/stray-pixels.ts) finds a block or nearly does. Temporary and local only: the host
 * (electron/color-block-log.ts) checks every field again and writes outside every profile. Numbers, closed names, bone and
 * morph names, the GPU's name, and two small pictures of her 3D canvas only; never chat, never paths.
 */
import type { MotionActivity } from './journal';

/** The frames kept before a block, oldest first; atMs is relative to the detection (≤ 0). */
export const COLOR_BLOCK_FRAME_COLUMNS = Object.freeze(['atMs', 'dtMs', 'headYaw', 'headPitch', 'eyeX', 'eyeY', 'pointerX', 'pointerY',
  'pointerOver', 'physics', 'contextLost'] as const);
export type ColorBlockFrameColumn = (typeof COLOR_BLOCK_FRAME_COLUMNS)[number];
export type ColorBlockFrames = Record<ColorBlockFrameColumn, number[]>;

export const COLOR_BLOCK_WINDOW_MS = 5_000;
export const COLOR_BLOCK_MAX_FRAMES = 1_200;
export const COLOR_BLOCK_MAX_RUNS = 200;
export const COLOR_BLOCK_MAX_STRIPS = 8;
/** Each picture: a PNG data URL of at most this many bytes once decoded. */
export const COLOR_BLOCK_IMAGE_BYTES = 200 * 1024;
export const COLOR_BLOCK_IMAGE_PREFIX = 'data:image/png;base64,';
/** Pictures are at most this wide (device pixels of the small copy). */
export const COLOR_BLOCK_IMAGE_WIDTH = 240;
/** At most one block event, and one near miss, per this long (the pet and the host both keep to it). */
export const COLOR_BLOCK_GAP_MS = 10_000;
export const COLOR_BLOCK_NEAR_GAP_MS = 5_000;

export interface ColorBlockStrip { x: number; y: number; w: number; h: number; drawn: number }
/** One sample of the sentinel: drawn pixels (share and count) of the strips it read, where her reach was, which strips hit. */
export interface ColorBlockSample {
  drawn: number; pixels: number; total: number; width: number; height: number; widen: number;
  reach: { minX: number; maxX: number; minY: number; maxY: number } | null;
  strips: ColorBlockStrip[];
}
export interface ColorBlockWatchStats { samples: number; hits: number; blocks: number; cleared: number; stayed: number; widen: number; stopped: boolean }
/** The stage's own numbers at the block, before the re-send: what lies farthest from normal. */
export interface ColorBlockInspect {
  bones: number; morphs: number; modelHeight: number;
  /** The bone farthest from her root, in model heights (null: not finite). */
  farthestBone: { name: string; heights: number | null } | null;
  /** The bone whose scale is farthest from 1 (null: not finite). */
  worstScale: { name: string; scale: number | null } | null;
  /** The morph weight farthest outside 0..1, else the largest (null: not finite). */
  worstMorph: { name: string; weight: number | null } | null;
  /** A rest position or morph offset in memory is not finite or far outside her (stray-pixels.ts brokenGeometry). */
  geometryBroken: boolean;
}
export interface ColorBlockEnv {
  renderer: string; vendor: string;
  bufferWidth: number; bufferHeight: number; canvasWidth: number; canvasHeight: number; dpr: number;
  fov: number | null; zoom: number | null; aspect: number | null;
  /** Camera to her root, in model heights. */
  distance: number | null;
  fps: number | null;
  contextLost: number; contextRestored: number;
}
export interface ColorBlockEvent {
  kind: 'block';
  cause: { part: 'bone' | 'morph' | 'geometry' | 'gpu'; name: string };
  /** The sample after the re-send was clean; null when no such sample came (the model changed). */
  cleared: boolean | null;
  found: ColorBlockSample;
  after: ColorBlockSample | null;
  watch: ColorBlockWatchStats;
  inspect: ColorBlockInspect | null;
  frames: ColorBlockFrames;
  /** What she was doing, as runs (a new run when it changed). */
  activities: { atMs: number; names: MotionActivity[] }[];
  env: ColorBlockEnv;
  images: { found: string | null; after: string | null };
}
/** One hit that did not repeat: numbers only. */
export interface ColorBlockNearMiss {
  kind: 'near';
  found: ColorBlockSample;
  watch: ColorBlockWatchStats;
  dt: { frames: number; meanMs: number; maxMs: number; slowFrames: number };
  activities: MotionActivity[];
}
export type ColorBlockReport = ColorBlockEvent | ColorBlockNearMiss;
