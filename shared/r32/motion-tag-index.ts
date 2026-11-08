/** Offline candidate metadata only. This module cannot grant playback authority. */
export const DIMENSIONS = ['content', 'personality', 'mood', 'context', 'quality', 'part', 'generality'] as const;
export type Dimension = typeof DIMENSIONS[number];
export const TAG_LAYERS = ['author', 'project-curated', 'intent', 'candidate', 'observed'] as const;
export type TagLayer = typeof TAG_LAYERS[number];
export type EvidenceStage = 'source' | 'intent' | 'candidate' | 'sampled' | 'observed' | 'verified';
export type LicenseScope = 'local-preview' | 'runtime' | 'redistribution';
export interface TagAnnotation {
  readonly dimension: Dimension;
  readonly raw: string;
  readonly tag: string;
  readonly fit: number | null;
  readonly layer: TagLayer;
  readonly evidence: EvidenceStage;
  readonly refs: readonly string[];
}
export interface PropertyClaim {
  readonly path: string;
  readonly kind: 'position' | 'quaternion' | 'morph';
  readonly nonDefaultStatic: boolean;
}
/** This is trusted use-review data, not a tag-derived or file-name-derived approval. */
export interface MotionUse {
  readonly id: string;
  readonly assetKey: string | null;
  readonly outputSha256: string | null;
  readonly status: 'verified' | 'candidate' | 'unknown';
  readonly refs: readonly string[];
  readonly modelSha256: string | null;
  readonly maskId: string | null;
  readonly maskProperties: readonly string[] | null;
  /** Actual selected-use compiled tracks, including retained non-default statics. */
  readonly actualProperties: readonly PropertyClaim[] | null;
  /** Versioned reviewed reference/background identities, never plain filenames. */
  readonly referenceKey: string | null;
  readonly backgroundKey: string | null;
  readonly chainStatus: 'verified' | 'unknown';
  /** Audited model-scoped parent/IK/grant conflict-component closure; null is unknown. */
  readonly couplingClosure: readonly string[] | null;
  readonly cancellation: 'verified' | 'unknown';
}
export interface MotionRecord {
  readonly sourceId: string;
  readonly assetKey: string | null;
  readonly outputSha256: string | null;
  readonly availability: 'available' | 'source-only' | 'missing';
  readonly license: { readonly status: 'reviewed' | 'unknown'; readonly scopes: readonly LicenseScope[]; readonly ref: string | null };
  readonly tags: readonly TagAnnotation[];
  readonly uses: readonly MotionUse[];
  /** These measurements never contribute to tag-fit scoring or playback output. */
  readonly evidenceConfidence: number | null;
  readonly playbackStrength: number | null;
}
export interface IndexedMotion extends MotionRecord {
  readonly key: string;
  readonly identity: 'asset-version' | 'source-only';
}
export interface MotionTagIndex {
  readonly entries: readonly IndexedMotion[];
  readonly executionAuthority: false;
  get(key: string): IndexedMotion | undefined;
}
export const compareStable = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const normalizedTag = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-');
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value);
const nullableText = (value: unknown) => value === null || text(value);
const rating = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const hash = (value: unknown) => value === null || isSha256(value);
const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(text);
export function propertyKind(path: string): PropertyClaim['kind'] | null {
  const bone = /^\.bones\[([^\]\[\u0000-\u001f]{1,128})\]\.(position|quaternion)$/.exec(path);
  if (bone) return bone[2] as 'position' | 'quaternion';
  return /^\.morphTargetInfluences\[(0|[1-9]\d{0,6})\]$/.test(path) ? 'morph' : null;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function validateUse(use: MotionUse): void {
  assert(use && text(use.id) && nullableText(use.assetKey) && hash(use.outputSha256), 'Invalid use identity.');
  assert(['verified', 'candidate', 'unknown'].includes(use.status) && strings(use.refs), 'Invalid use evidence.');
  assert(hash(use.modelSha256) && nullableText(use.maskId) && nullableText(use.referenceKey) && nullableText(use.backgroundKey), 'Invalid use binding.');
  assert(use.maskProperties === null || strings(use.maskProperties) && new Set(use.maskProperties).size === use.maskProperties.length
    && use.maskProperties.every(value => propertyKind(value) !== null), 'Invalid reviewed mask properties.');
  assert(use.actualProperties === null || Array.isArray(use.actualProperties) && new Set(use.actualProperties.map(value => value.path)).size === use.actualProperties.length
    && use.actualProperties.every(value => value && propertyKind(value.path) !== null && propertyKind(value.path) === value.kind
      && typeof value.nonDefaultStatic === 'boolean'), 'Invalid actual property coverage.');
  assert(['verified', 'unknown'].includes(use.chainStatus) && (use.couplingClosure === null || strings(use.couplingClosure))
    && ['verified', 'unknown'].includes(use.cancellation), 'Invalid chain/cancellation evidence.');
}
function validateRecord(record: MotionRecord): void {
  assert(record && text(record.sourceId) && nullableText(record.assetKey) && hash(record.outputSha256), 'Invalid asset identity.');
  assert(['available', 'source-only', 'missing'].includes(record.availability), 'Invalid availability.');
  assert(record.license && ['reviewed', 'unknown'].includes(record.license.status) && Array.isArray(record.license.scopes)
    && record.license.scopes.every(scope => ['local-preview', 'runtime', 'redistribution'].includes(scope)) && nullableText(record.license.ref), 'Invalid license metadata.');
  assert(rating(record.evidenceConfidence) && rating(record.playbackStrength), 'Invalid independent measurements.');
  assert(Array.isArray(record.tags) && record.tags.length <= 1_024, 'Invalid annotation list.');
  for (const tag of record.tags) {
    assert(tag && DIMENSIONS.includes(tag.dimension) && TAG_LAYERS.includes(tag.layer) && text(tag.raw) && text(tag.tag)
      && !!normalizedTag(tag.tag) && rating(tag.fit) && strings(tag.refs)
      && ['source', 'intent', 'candidate', 'sampled', 'observed', 'verified'].includes(tag.evidence), 'Invalid tag annotation.');
  }
  assert(Array.isArray(record.uses) && record.uses.length <= 128 && new Set(record.uses.map(use => use.id)).size === record.uses.length, 'Duplicate/invalid uses.');
  record.uses.forEach(validateUse);
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); for (const child of Object.values(value)) deepFreeze(child, seen); Object.freeze(value);
  }
  return value;
}

/** Snapshot trusted plain data. Partial identities stay source-only, never fabricated as playable assets. */
export function buildMotionTagIndex(records: readonly MotionRecord[]): MotionTagIndex {
  assert(Array.isArray(records) && records.length <= 10_000, 'Invalid record list.');
  const lookup = new Map<string, IndexedMotion>();
  for (const input of records) {
    const record = structuredClone(input); validateRecord(record);
    const complete = record.assetKey !== null && record.outputSha256 !== null;
    const key = complete ? JSON.stringify(['asset', record.assetKey, record.outputSha256]) : JSON.stringify(['source', record.sourceId]);
    assert(!lookup.has(key), 'Duplicate content/source identity. Merge provenance explicitly instead of overwriting it.');
    const indexed = deepFreeze({ ...record, key, identity: complete ? 'asset-version' as const : 'source-only' as const });
    lookup.set(key, indexed);
  }
  return Object.freeze({ entries: Object.freeze([...lookup.values()].sort((a, b) => compareStable(a.key, b.key))),
    executionAuthority: false as const, get: (key: string) => lookup.get(key) });
}
