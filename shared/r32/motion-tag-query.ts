import { DIMENSIONS, TAG_LAYERS, compareStable, isSha256, normalizedTag, propertyKind,
  type Dimension, type IndexedMotion, type LicenseScope, type MotionTagIndex, type TagLayer } from './motion-tag-index.js';

export interface MotionTagQuery {
  readonly useId: string; readonly licenseScope: LicenseScope;
  readonly modelSha256: string | null; readonly maskId: string | null;
  readonly referenceKey: string | null; readonly backgroundKey: string | null;
  readonly allowedProperties: readonly string[] | null; readonly layer?: TagLayer;
  readonly preferred?: readonly { readonly dimension: Dimension; readonly tag: string; readonly importance?: number }[];
  readonly dimensionWeights?: Partial<Record<Dimension, number>>;
  readonly aliases?: Partial<Record<Dimension, Readonly<Record<string, string>>>>;
}
export interface MotionTagContext {
  readonly cancelled: boolean;
  readonly activeOwners: readonly { readonly id: string; readonly properties: readonly string[] | null;
    readonly couplingClosure: readonly string[] | null }[] | null;
}
export type MotionTagSoftQuery = Pick<MotionTagQuery, 'layer' | 'preferred' | 'dimensionWeights' | 'aliases'>;
export type HardReason = 'invalid-query' | 'invalid-context' | 'cancelled' | 'source-unavailable' | 'identity-unverified'
  | 'license-unreviewed' | 'license-scope-denied' | 'use-missing' | 'use-unverified' | 'use-identity-mismatch'
  | 'model-mismatch' | 'mask-mismatch' | 'reference-mismatch' | 'background-mismatch' | 'compiled-coverage-unknown'
  | 'mask-coverage-unknown' | 'property-outside-mask' | 'property-outside-query' | 'chain-unverified' | 'closure-unknown'
  | 'cancellation-unverified' | 'owner-properties-unknown' | 'owner-closure-unknown' | 'active-property-conflict' | 'active-coupling-conflict';
export interface HardRejection { readonly code: HardReason; readonly detail: string }
export interface TagFamilyExplanation {
  readonly tag: string; readonly importance: number; readonly fit: number | null; readonly refs: readonly string[];
  readonly matchedTags: readonly string[]; readonly conflict: boolean; readonly knownFits: readonly number[];
  readonly resolution: 'known' | 'unknown' | 'conservative-min';
}
export interface DimensionExplanation {
  readonly dimension: Dimension; readonly weight: number; readonly requestedImportance: number;
  readonly knownImportance: number; readonly measured: number; readonly families: readonly TagFamilyExplanation[];
}
export interface RankedMotionTagCandidate {
  readonly key: string; readonly sourceId: string; readonly useId: string; readonly layer: TagLayer;
  readonly score: number | null; readonly knownCoverage: number; readonly rankingValue: number;
  readonly dimensions: readonly DimensionExplanation[]; readonly executionAuthority: false;
}
export interface RejectedMotionTagCandidate {
  readonly key: string; readonly sourceId: string; readonly reasons: readonly HardRejection[]; readonly executionAuthority: false;
}
export interface MotionTagSearchResult {
  readonly accepted: readonly RankedMotionTagCandidate[]; readonly rejected: readonly RejectedMotionTagCandidate[];
  readonly executionAuthority: false;
}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value);
const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 4_096 && value.every(text);
const paths = (value: unknown): value is readonly string[] => strings(value) && value.every(item => propertyKind(item) !== null);
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const unique = (values: readonly string[]) => Object.freeze([...new Set(values)].sort(compareStable));
const issue = (code: HardReason, detail: string): HardRejection => Object.freeze({ code, detail });
function compile(query: MotionTagQuery) {
  if (!query || !text(query.useId) || !['local-preview', 'runtime', 'redistribution'].includes(query.licenseScope)
    || !isSha256(query.modelSha256) || !text(query.maskId) || !text(query.referenceKey) || !text(query.backgroundKey)
    || !paths(query.allowedProperties) || !TAG_LAYERS.includes(query.layer ?? 'observed')) throw new TypeError('Unknown requested use/identity/mask/coverage.');
  return compileSoft(query);
}
function compileSoft(query: MotionTagSoftQuery) {
  if (!query || !TAG_LAYERS.includes(query.layer ?? 'observed')) throw new TypeError('Unknown annotation layer.');
  const demands = new Map<Dimension, Map<string, number>>(), alias = new Map<Dimension, Map<string, string>>();
  for (const input of [query.aliases, query.dimensionWeights]) if (input !== undefined && (!input || typeof input !== 'object'
    || Array.isArray(input) || Object.keys(input).some(key => !DIMENSIONS.includes(key as Dimension)))) throw new TypeError('Unknown dimension.');
  for (const dimension of DIMENSIONS) {
    const declared = query.aliases?.[dimension], map = new Map<string, string>();
    if (declared !== undefined) {
      if (!declared || typeof declared !== 'object' || Array.isArray(declared) || Object.keys(declared).length > 128) throw new TypeError('Alias bounds.');
      for (const [from, to] of Object.entries(declared)) {
        if (!text(from) || !text(to)) throw new TypeError('Invalid alias.');
        const key = normalizedTag(from), target = normalizedTag(to);
        if (!key || !target || map.has(key) && map.get(key) !== target) throw new TypeError('Conflicting alias.');
        map.set(key, target);
      }
    }
    alias.set(dimension, map);
    const weight = query.dimensionWeights?.[dimension]; if (weight !== undefined && !unit(weight)) throw new TypeError('Invalid dimension weight.');
  }
  const family = (dimension: Dimension, raw: string): string => {
    const map = alias.get(dimension)!, seen = new Set<string>(); let key = normalizedTag(raw);
    while (map.has(key)) { if (seen.has(key)) throw new TypeError('Cyclic alias.'); seen.add(key); key = map.get(key)!; }
    return key;
  };
  for (const [dimension, map] of alias) for (const key of map.keys()) family(dimension, key);
  const preferred = query.preferred ?? [];
  if (!Array.isArray(preferred) || preferred.length > 256) throw new TypeError('Demand bounds.');
  for (const item of preferred) {
    if (!item || !DIMENSIONS.includes(item.dimension) || !text(item.tag) || !unit(item.importance ?? 1)) throw new TypeError('Invalid demand.');
    const importance = item.importance ?? 1; if (!importance) continue;
    const map = demands.get(item.dimension) ?? new Map<string, number>(), tag = family(item.dimension, item.tag);
    map.set(tag, Math.max(map.get(tag) ?? 0, importance)); demands.set(item.dimension, map);
  }
  return { demands, family, layer: query.layer ?? 'observed' };
}
function contextIssues(context: MotionTagContext): HardRejection[] {
  const issues: HardRejection[] = [];
  if (!context || context.cancelled !== false) issues.push(issue('cancelled', 'Context cancellation must be explicitly false.'));
  if (!context || !Array.isArray(context.activeOwners) || context.activeOwners.length > 128) return [...issues, issue('invalid-context', 'Active ownership is unknown.')];
  for (const owner of context.activeOwners) {
    if (!owner || !text(owner.id)) { issues.push(issue('invalid-context', 'An active owner identity is unknown.')); continue; }
    if (!paths(owner.properties)) issues.push(issue('owner-properties-unknown', `Unknown compiled properties for ${owner.id}.`));
    if (!strings(owner.couplingClosure)) issues.push(issue('owner-closure-unknown', `Unknown audited closure for ${owner.id}.`));
  }
  return issues;
}
function hard(record: IndexedMotion, query: MotionTagQuery, context: MotionTagContext): HardRejection[] {
  const issues = contextIssues(context), add = (code: HardReason, detail: string) => issues.push(issue(code, detail));
  if (record.availability !== 'available') add('source-unavailable', 'Actual output is not available.');
  if (record.identity !== 'asset-version' || !text(record.assetKey) || !isSha256(record.outputSha256)) add('identity-unverified', 'Complete asset/version identity required.');
  if (record.license.status !== 'reviewed' || !text(record.license.ref)) add('license-unreviewed', 'Reviewed license reference required.');
  if (!record.license.scopes.includes(query.licenseScope)) add('license-scope-denied', `License does not cover ${query.licenseScope}.`);
  const use = record.uses.find(value => value.id === query.useId);
  if (!use) { add('use-missing', 'Exact requested use has no record.'); return issues; }
  if (use.status !== 'verified' || !strings(use.refs) || !use.refs.length) add('use-unverified', 'Exact use needs verified references.');
  if (use.assetKey !== record.assetKey || use.outputSha256 !== record.outputSha256) add('use-identity-mismatch', 'Use belongs to another asset/version.');
  if (use.modelSha256 !== query.modelSha256) add('model-mismatch', 'Reviewed model content differs.');
  if (use.maskId !== query.maskId) add('mask-mismatch', 'Reviewed mask differs.');
  if (use.referenceKey !== query.referenceKey) add('reference-mismatch', 'Reviewed reference differs.');
  if (use.backgroundKey !== query.backgroundKey) add('background-mismatch', 'Reviewed background differs.');
  if (!paths(use.maskProperties)) add('mask-coverage-unknown', 'Reviewed mask properties are unknown.');
  if (!Array.isArray(use.actualProperties) || use.actualProperties.some(value => !value || propertyKind(value.path) !== value.kind || typeof value.nonDefaultStatic !== 'boolean'))
    add('compiled-coverage-unknown', 'Actual compiled properties are unknown.');
  else for (const claim of use.actualProperties) {
    if (paths(use.maskProperties) && !use.maskProperties.includes(claim.path)) add('property-outside-mask', claim.path);
    if (!query.allowedProperties!.includes(claim.path)) add('property-outside-query', claim.path);
  }
  if (use.chainStatus !== 'verified') add('chain-unverified', 'Actual chain structure is not reviewed.');
  if (!strings(use.couplingClosure)) add('closure-unknown', 'Audited model coupling closure is unknown.');
  if (use.cancellation !== 'verified') add('cancellation-unverified', 'Cancellation is not verified.');
  for (const owner of Array.isArray(context?.activeOwners) ? context.activeOwners : []) {
    if (!owner) continue;
    if (paths(owner.properties) && Array.isArray(use.actualProperties)) for (const claim of use.actualProperties)
      if (claim && owner.properties.includes(claim.path)) add('active-property-conflict', `${owner.id}: ${claim.path}`);
    if (strings(owner.couplingClosure) && strings(use.couplingClosure)) for (const component of use.couplingClosure)
      if (owner.couplingClosure.includes(component)) add('active-coupling-conflict', `${owner.id}: ${component}`);
  }
  return issues;
}
function rank(record: IndexedMotion, query: MotionTagSoftQuery & { useId: string }, compiled: ReturnType<typeof compile>): RankedMotionTagCandidate {
  let measuredNum = 0, covered = 0, total = 0; const dimensions: DimensionExplanation[] = [];
  for (const dimension of DIMENSIONS) {
    const requested = compiled.demands.get(dimension); if (!requested?.size) continue;
    let requestedImportance = 0, knownImportance = 0, numerator = 0;
    const families: TagFamilyExplanation[] = [];
    for (const [tag, importance] of [...requested].sort((a, b) => compareStable(a[0], b[0]))) {
      const matches = record.tags.filter(value => value.layer === compiled.layer && value.dimension === dimension && compiled.family(dimension, value.tag) === tag);
      const knownFits = [...new Set(matches.flatMap(value => value.fit === null ? [] : [value.fit]))].sort((a, b) => a - b);
      const fit = knownFits.length ? knownFits[0] : null, conflict = knownFits.length > 1;
      requestedImportance += importance;
      if (fit !== null) { knownImportance += importance; numerator += importance * fit; }
      families.push(Object.freeze({ tag, importance, fit, conflict, knownFits: Object.freeze(knownFits),
        refs: unique(matches.flatMap(value => [...value.refs])), matchedTags: unique(matches.map(value => value.tag)),
        resolution: conflict ? 'conservative-min' : fit === null ? 'unknown' : 'known' }));
    }
    const weight = query.dimensionWeights?.[dimension] ?? 1, measured = numerator / requestedImportance;
    measuredNum += weight * measured; covered += weight * knownImportance / requestedImportance; total += weight;
    dimensions.push(Object.freeze({ dimension, weight, requestedImportance, knownImportance, measured, families: Object.freeze(families) }));
  }
  return Object.freeze({ key: record.key, sourceId: record.sourceId, useId: query.useId, layer: compiled.layer,
    score: covered > 0 ? measuredNum / covered : null, knownCoverage: total > 0 ? covered / total : 0,
    // 0.5 is an explicit unknown-ranking prior, never an observed fit/confidence.
    rankingValue: total > 0 ? (measuredNum + 0.5 * (total - covered)) / total : 0.5,
    dimensions: Object.freeze(dimensions), executionAuthority: false as const });
}

/** Browsing user annotations only; deliberately supplies no playback/use admission result. */
export function rankMotionTagAnnotations(index: MotionTagIndex, query: MotionTagSoftQuery): readonly RankedMotionTagCandidate[] {
  const compiled = compileSoft(query);
  const rows = index.entries.map(record => rank(record, { ...query, useId: 'catalog.annotation-search' }, compiled));
  const rounded = (value: number) => Math.round(value * 1e12) / 1e12;
  return Object.freeze(rows.sort((a, b) => rounded(b.rankingValue) - rounded(a.rankingValue)
    || b.knownCoverage - a.knownCoverage || compareStable(a.key, b.key)));
}

/** Offline trusted metadata in; candidate explanations out. No result grants execution. */
export function searchMotionTags(index: MotionTagIndex, query: MotionTagQuery, context: MotionTagContext): MotionTagSearchResult {
  const accepted: RankedMotionTagCandidate[] = [], rejected: RejectedMotionTagCandidate[] = [];
  let compiled: ReturnType<typeof compile> | null = null;
  try { compiled = compile(query); } catch { /* Invalid requests reject every candidate without soft scoring. */ }
  for (const record of index.entries) {
    const reasons = compiled ? hard(record, query, context) : [issue('invalid-query', 'Requested dimensions, aliases, identities or property coverage are invalid.')];
    if (reasons.length) rejected.push(Object.freeze({ key: record.key, sourceId: record.sourceId, reasons: Object.freeze(reasons), executionAuthority: false as const }));
    else accepted.push(rank(record, query, compiled!));
  }
  const rounded = (value: number) => Math.round(value * 1e12) / 1e12;
  accepted.sort((a, b) => rounded(b.rankingValue) - rounded(a.rankingValue) || b.knownCoverage - a.knownCoverage || compareStable(a.key, b.key));
  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected), executionAuthority: false as const });
}
