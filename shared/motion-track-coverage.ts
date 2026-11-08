import type { MotionPackId } from './motion-library';

export interface MotionTrackAssetId { packId: MotionPackId; motionId: string; }
export type MotionTrackKind = 'position' | 'quaternion' | 'morph';
export type MotionStructurePart = 'head' | 'neck' | 'left-arm' | 'right-arm' | 'torso' | 'legs' | 'eyes-brows' | 'mouth';
export const MOTION_STRUCTURE_PARTS: readonly MotionStructurePart[] = ['head','neck','left-arm','right-arm','torso','legs','eyes-brows','mouth'];
export interface MotionTrackProperty {
  target: string;
  kind: MotionTrackKind;
  keyframes: number;
  state: 'dynamic' | 'static-default' | 'static-nondefault';
  /** Only an independently trusted structural binding may supply this, never a name/tag guess. */
  part: MotionStructurePart | null;
  /** Index in the pinned source model structure; null when not uniquely bound. */
  modelIndex: number | null;
}
export interface MotionTrackCoverage {
  asset: MotionTrackAssetId;
  sha256: string;
  properties: MotionTrackProperty[];
  durationFrames: number;
  removedDefaultBones: number;
  removedZeroMorphs: number;
  modelMapping: 'verified-public-gene' | 'unknown';
  modelSha256: string | null;
}
export interface MotionTrackCoverageRequest { assets: MotionTrackAssetId[]; }
export interface MotionRelationBone {
  index: number; target: string; properties: Array<'position' | 'quaternion'>;
}
export interface MotionTrackRelation {
  kind: 'ancestor' | 'grant' | 'ik';
  a: MotionRelationBone; b: MotionRelationBone;
  direction: 'a-to-b' | 'b-to-a' | 'shared-chain';
  /** Ancestor, grant recipient or IK controller source index; not a live solver identity. */
  via: number; chain: number[];
}
export interface MotionRecordedRelations {
  status: 'unknown' | 'recorded-public-gene';
  reason: 'two-assets-required' | 'model-unverified' | null;
  modelSha256: string | null;
  rows: MotionTrackRelation[];
  counts: { ancestor: number; grant: number; ik: number };
  total: number; truncated: boolean;
  /** Morphs and unavailable/ambiguous source bindings remain outside these bone facts. */
  unresolvedProperties: [number, number];
}
export interface MotionTrackCoverageView {
  contextId: string;
  assets: MotionTrackCoverage[];
  /** Same VMD target identifier/property, not proof of a compiled model's binding. */
  directOverlap: Array<Pick<MotionTrackProperty, 'target' | 'kind'>>;
  modelOverlap: Array<Pick<MotionTrackProperty, 'target' | 'kind' | 'modelIndex'>>;
  recordedRelations: MotionRecordedRelations;
  hierarchy: 'unknown';
  ik: 'unknown';
  combination: 'not-validated';
}
export type MotionTrackFilter = { kind: 'all' } | { kind: 'target'; target: string; channel: 'bone' | 'morph' }
  | { kind: 'part'; part: MotionStructurePart };

export function matchesMotionTrackFilter(coverage: MotionTrackCoverage, filter: MotionTrackFilter): boolean {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'part') return coverage.properties.some(row => row.part === filter.part);
  return coverage.properties.some(row => row.target === filter.target && (filter.channel === 'morph' ? row.kind === 'morph' : row.kind !== 'morph'));
}
export type MotionTrackExclusion = { kind: 'none' }
  | Extract<MotionTrackFilter, { kind: 'target' | 'part' }>;

/** Absence in the complete retained-track facts, never absence inferred from tags or unread data. */
export function passesMotionTrackExclusion(coverage: MotionTrackCoverage | undefined, exclusion: MotionTrackExclusion): boolean {
  if (exclusion.kind === 'none') return true;
  if (!coverage) return false;
  if (exclusion.kind === 'target') return !coverage.properties.some(row => row.target === exclusion.target
    && (exclusion.channel === 'morph' ? row.kind === 'morph' : row.kind !== 'morph'));
  if (coverage.modelMapping !== 'verified-public-gene' || !coverage.modelSha256
    || !MOTION_STRUCTURE_PARTS.includes(exclusion.part)) return false;
  return coverage.properties.every(row => row.part !== null && MOTION_STRUCTURE_PARTS.includes(row.part)
    && row.modelIndex !== null && row.part !== exclusion.part);
}
export const motionTrackKey = (asset: MotionTrackAssetId) => `${asset.packId}/${asset.motionId}`;
