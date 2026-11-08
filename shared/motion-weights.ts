import { DIMENSIONS, normalizedTag, type Dimension } from './r32/motion-tag-index';
import type { DimensionExplanation } from './r32/motion-tag-query';
import type { MotionPackId } from './motion-library';

export { DIMENSIONS };
export type { Dimension };
export const MOTION_WEIGHT_LIMIT = 32;
export const motionDimensionLabels: Record<Dimension, string> = {
  content: '动作内容', personality: '性格', mood: '心情', context: '情境',
  quality: '质感与时间', part: '部位', generality: '通用度',
};
export interface MotionWeightTag { dimension: Dimension; tag: string; weight: number | null }
export interface MotionWeightAsset { packId: MotionPackId; motionId: string; assetKey: string; sha256: string }
export interface MotionWeightView {
  asset: MotionWeightAsset; token: string; revision: number; tags: MotionWeightTag[];
}
export interface MotionWeightSave { token: string; revision: number; tags: MotionWeightTag[] }
export interface MotionWeightQuery {
  packId: MotionPackId;
  preferred: { dimension: Dimension; tag: string; importance: number }[];
}
export interface MotionWeightRank {
  asset: MotionWeightAsset; rankingValue: number; score: number | null; knownCoverage: number;
  dimensions: readonly DimensionExplanation[];
}
export interface MotionWeightResults { rows: MotionWeightRank[]; executionAuthority: false }

const packs = ['gene', '100style-idles', 'mpi-embm-gestures', 'genea-2022-gestures', 'fnoji-dances', 'soft-hearts-actions'];
export const motionWeightPackId = (value: unknown): value is MotionPackId => typeof value === 'string' && packs.includes(value);
const fail = (): never => { throw Error('动作标签格式不正确，请使用有效标签和 0～1 权重。'); };
export function weightData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value), own = Reflect.ownKeys(value);
  return (proto === Object.prototype || proto === null) && own.length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return !!d && d.enumerable && 'value' in d;
  }) && own.every(key => typeof key === 'string' && keys.includes(key));
}
export function weightText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
export const weightUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function weightArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length > MOTION_WEIGHT_LIMIT || Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
    .every(d => !!d && d.enumerable && 'value' in d);
}
export function parseWeightTags(value: unknown): MotionWeightTag[] {
  if (!weightArray(value)) return fail();
  const seen = new Set<string>();
  return value.map(row => {
    if (!weightData(row, ['dimension', 'tag', 'weight']) || !DIMENSIONS.includes(row.dimension as Dimension)
      || !weightText(row.tag) || row.weight !== null && !weightUnit(row.weight)) return fail();
    const tag = normalizedTag(row.tag), key = `${row.dimension}:${tag}`;
    if (!tag || tag.length > 64 || seen.has(key)) return fail();
    seen.add(key);
    return { dimension: row.dimension as Dimension, tag, weight: row.weight as number | null };
  });
}
export function parseWeightSave(value: unknown): MotionWeightSave {
  if (!weightData(value, ['token', 'revision', 'tags']) || typeof value.token !== 'string'
    || !/^[a-f0-9]{48}$/.test(value.token) || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0) return fail();
  return { token: value.token, revision: value.revision as number, tags: parseWeightTags(value.tags) };
}
export function parseWeightQuery(value: unknown): MotionWeightQuery {
  if (!weightData(value, ['packId', 'preferred']) || !packs.includes(value.packId as string)
    || !weightArray(value.preferred) || !value.preferred.length) return fail();
  return { packId: value.packId as MotionPackId, preferred: value.preferred.map(row => {
    if (!weightData(row, ['dimension', 'tag', 'importance']) || !DIMENSIONS.includes(row.dimension as Dimension)
      || !weightText(row.tag) || !weightUnit(row.importance)) return fail();
    return { dimension: row.dimension as Dimension, tag: normalizedTag(row.tag), importance: row.importance };
  }) };
}
