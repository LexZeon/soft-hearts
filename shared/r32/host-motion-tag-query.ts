import { buildMotionTagIndex, type MotionRecord } from './motion-tag-index.js';
import { searchMotionTags, type MotionTagContext, type MotionTagQuery,
  type MotionTagSearchResult } from './motion-tag-query.js';

export type HostMotionTagPreferences = Pick<MotionTagQuery,
  'layer' | 'preferred' | 'dimensionWeights' | 'aliases'>;
export type HostMotionTagAdmission = Pick<MotionTagQuery,
  'useId' | 'licenseScope' | 'modelSha256' | 'maskId' | 'referenceKey' | 'backgroundKey' | 'allowedProperties'>;
/** Host-owned review/pose/owner generation, freshly read for every synchronous query. */
export interface HostMotionTagSnapshot {
  readonly snapshotId: string;
  readonly admission: HostMotionTagAdmission;
  readonly context: MotionTagContext;
}
export interface HostMotionTagQueryResult extends MotionTagSearchResult {
  /** Diagnostic identity only. It is neither an admission token nor a playback lease. */
  readonly snapshotId: string | null;
  readonly snapshotRead: 'ok' | 'unavailable';
}
export interface HostMotionTagQueryAdapter {
  query(preferences?: HostMotionTagPreferences): HostMotionTagQueryResult;
}
const preferenceKeys = new Set(['layer', 'preferred', 'dimensionWeights', 'aliases']);
const snapshotIdentity = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * Importable host-only seam, not connected to the app. Caller owns trusted reviews and live context.
 * Tags cannot supply hard admission fields. All output is an explanation, never execution authority.
 * The dependency remains the frozen 9a7edb15 pure index/query packet; no asset IO or playback occurs.
 */
export function createHostMotionTagQueryAdapter(
  records: readonly MotionRecord[],
  readHostSnapshot: () => HostMotionTagSnapshot | null,
): HostMotionTagQueryAdapter {
  // The original index validates, clones and freezes metadata; no later caller mutation is retained.
  const index = buildMotionTagIndex(records);
  if (typeof readHostSnapshot !== 'function') throw new TypeError('Host snapshot reader required.');
  return Object.freeze({ query(preferences: HostMotionTagPreferences = {}): HostMotionTagQueryResult {
    let snapshot: HostMotionTagSnapshot | null = null;
    let query = {} as MotionTagQuery;
    try {
      const current = structuredClone(readHostSnapshot());
      if (current && snapshotIdentity(current.snapshotId)) snapshot = current;
      if (snapshot && preferences && typeof preferences === 'object' && !Array.isArray(preferences)
        && Reflect.ownKeys(preferences).every(key => typeof key === 'string' && preferenceKeys.has(key))) {
        const soft = structuredClone(preferences);
        const hard = snapshot.admission;
        // Explicit picks: even a runtime cast cannot replace identity, masks, use or ownership.
        query = { layer: soft.layer, preferred: soft.preferred, dimensionWeights: soft.dimensionWeights,
          aliases: soft.aliases, useId: hard.useId, licenseScope: hard.licenseScope,
          modelSha256: hard.modelSha256, maskId: hard.maskId, referenceKey: hard.referenceKey,
          backgroundKey: hard.backgroundKey, allowedProperties: hard.allowedProperties };
      }
    } catch {
      // A missing, throwing or uncloneable host read refuses every record. No cached result fallback.
      snapshot = null;
    }
    const result = searchMotionTags(index, query, snapshot?.context ?? { cancelled: true, activeOwners: null });
    return Object.freeze({ ...result, snapshotId: snapshot?.snapshotId ?? null,
      snapshotRead: snapshot ? 'ok' as const : 'unavailable' as const });
  } });
}
