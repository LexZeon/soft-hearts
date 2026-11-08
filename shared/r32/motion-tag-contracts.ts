import { DIMENSIONS, TAG_LAYERS } from './motion-tag-index.js';
import type { HostMotionTagPreferences, HostMotionTagQueryResult } from './host-motion-tag-query.js';

export type MotionTagPreferenceRequest = HostMotionTagPreferences;
export interface MotionTagEvidenceGap { readonly assetKey: string; readonly missing: readonly string[] }
export interface MotionTagLibraryQueryView {
  readonly query: HostMotionTagQueryResult;
  readonly catalogIssues: readonly string[];
  readonly evidenceGaps: readonly MotionTagEvidenceGap[];
  readonly hostEvidenceGaps: readonly string[];
  readonly importedAssetCount: number;
  readonly verifiedUseCount: 0;
  readonly legacyTagsNotConverted: number;
  readonly executionAuthority: false;
}
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(v);
const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function data(v: unknown, allowed?: readonly string[], max = 128): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v), keys = Reflect.ownKeys(v);
  return (proto === Object.prototype || proto === null) && keys.length <= max && keys.every(key => {
    if (typeof key !== 'string' || allowed && !allowed.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(v, key);
    return !!descriptor && descriptor.enumerable && 'value' in descriptor;
  });
}
/** Exact optional transport schema. Hard admission/paths never enter this request. */
export function parseMotionTagPreferences(value: unknown): MotionTagPreferenceRequest {
  const invalid = () => { throw new TypeError('Invalid readonly motion-tag preferences.'); };
  if (!data(value, ['layer', 'preferred', 'dimensionWeights', 'aliases'], 4)) return invalid();
  if ('layer' in value && !TAG_LAYERS.includes(value.layer as never)) return invalid();
  if ('preferred' in value) {
    const list = value.preferred;
    if (!Array.isArray(list) || list.length > 256 || Reflect.ownKeys(list).length !== list.length + 1) return invalid();
    for (let i = 0; i < list.length; i++) {
      const item = Object.getOwnPropertyDescriptor(list, String(i));
      if (!item || !('value' in item) || !item.enumerable) return invalid();
      const preference = item.value;
      if (!data(preference, ['dimension', 'tag', 'importance'], 3) || !DIMENSIONS.includes(preference.dimension as never)
        || !text(preference.tag) || 'importance' in preference && !unit(preference.importance)) return invalid();
    }
  }
  if ('dimensionWeights' in value) {
    if (!data(value.dimensionWeights, DIMENSIONS, 7) || !Object.values(value.dimensionWeights).every(unit)) return invalid();
  }
  if ('aliases' in value) {
    if (!data(value.aliases, DIMENSIONS, 7)) return invalid();
    for (const map of Object.values(value.aliases)) if (!data(map) || !Object.entries(map).every(([key, target]) => text(key) && text(target))) return invalid();
  }
  if (JSON.stringify(value).length > 65536) return invalid();
  return structuredClone(value) as MotionTagPreferenceRequest;
}
