import { createHash } from 'node:crypto';
import type { MotionCatalog, MotionLibraryStatus } from '../shared/motion-library';
import type { MotionRecord } from '../shared/r32/motion-tag-index.js';
import { createHostMotionTagQueryAdapter, type HostMotionTagSnapshot } from '../shared/r32/host-motion-tag-query.js';
import { parseMotionTagPreferences, type MotionTagLibraryQueryView } from '../shared/r32/motion-tag-contracts.js';

const GENE_PACK_SHA256 = 'a6f30d9d9a953d61fbac119683306acd5e3921f5e91424f914f2c04d4f454bcc';
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const USE_GAPS = Object.freeze(['exact-verified-use-missing', 'use-specific-compiled-coverage-unknown',
  'reviewed-mask-reference-background-unknown', 'audited-model-rig-coupling-closure-unknown',
  'use-cancellation-evidence-missing', 'weighted-tags-unassessed']);

/** Host data only. Existing status owns actual bundled-file checking; metadata is not use approval. */
export function importReviewedGeneCatalog(catalog: MotionCatalog, status: MotionLibraryStatus) {
  const records: MotionRecord[] = [], issues: string[] = [];
  let legacyTagsNotConverted = 0;
  try {
    const packs = structuredClone(catalog).packs.filter(pack => pack.id === 'gene');
    if (packs.length !== 1 || packs[0].motions.length !== 40
      || createHash('sha256').update(canonical(packs[0])).digest('hex') !== GENE_PACK_SHA256)
      throw new TypeError('Catalog identity differs.');
    const pack = packs[0], installed = status.packs.filter(row => row.id === 'gene');
    const witnessed = installed.length === 1 && installed[0].bundled === true && installed[0].complete === true;
    for (const motion of pack.motions) {
      legacyTagsNotConverted += motion.tags.length;
      records.push({ sourceId: `catalog:gene/${motion.id}`,
        assetKey: `${pack.source}/${pack.id}@${pack.revision}/${motion.id}`, outputSha256: motion.sha256,
        availability: witnessed && installed[0].installedMotionIds.includes(motion.id) ? 'available' : 'source-only',
        license: { status: 'reviewed', scopes: ['local-preview', 'runtime', 'redistribution'],
          ref: `reviewed-public-gene-catalog:${GENE_PACK_SHA256}:CC-BY-4.0` },
        // String tags and whole-clip playback are not weighted or exact-use witnesses.
        tags: [], uses: [], evidenceConfidence: null, playbackStrength: null });
    }
  } catch { records.length = 0; legacyTagsNotConverted = 0; issues.push('pinned-public-gene-catalog-identity-unavailable'); }
  return { records, issues, legacyTagsNotConverted,
    evidenceGaps: records.map(record => Object.freeze({ assetKey: record.assetKey!, missing: USE_GAPS })) };
}

/** Actual host consumer of the frozen index/adapter. No result grants or schedules anything. */
export function queryReviewedGeneCatalog(catalog: MotionCatalog, status: MotionLibraryStatus,
  readHostSnapshot: () => HostMotionTagSnapshot | null, preferences: unknown): MotionTagLibraryQueryView {
  const soft = parseMotionTagPreferences(preferences);
  const imported = importReviewedGeneCatalog(catalog, status);
  let observed: HostMotionTagSnapshot | null = null;
  const adapter = createHostMotionTagQueryAdapter(imported.records, () => {
    observed = structuredClone(readHostSnapshot()); return observed;
  });
  const query = adapter.query(soft), gaps: string[] = [];
  // The adapter owns invocation; this is the exact read it made, not an additional/stale read.
  const snapshot = observed as HostMotionTagSnapshot | null;
  if (!snapshot) gaps.push('host-snapshot-unavailable');
  else {
    if (!snapshot.admission?.modelSha256) gaps.push('current-model-content-unverified');
    if (!snapshot.admission?.maskId || !snapshot.admission?.allowedProperties) gaps.push('host-reviewed-use-mask-unknown');
    if (!snapshot.admission?.referenceKey || !snapshot.admission?.backgroundKey) gaps.push('host-reference-background-unknown');
    if (snapshot.context?.activeOwners === null || snapshot.context?.activeOwners === undefined) gaps.push('current-property-coupling-owners-unknown');
    if (snapshot.context?.cancelled !== false) gaps.push('host-query-cancelled-or-unknown');
  }
  return Object.freeze({ query, catalogIssues: Object.freeze(imported.issues), evidenceGaps: Object.freeze(imported.evidenceGaps),
    hostEvidenceGaps: Object.freeze(gaps), importedAssetCount: imported.records.length, verifiedUseCount: 0 as const,
    legacyTagsNotConverted: imported.legacyTagsNotConverted, executionAuthority: false as const });
}

/** Existing host lacks the reviewed rig/mask/current-owner witnesses: preserve those unknowns. */
export function unverifiedCatalogHostSnapshot(generation: number, cancelled: boolean): HostMotionTagSnapshot | null {
  if (!Number.isSafeInteger(generation) || generation < 0 || typeof cancelled !== 'boolean') return null;
  return { snapshotId: `library-generation:${generation}`, admission: { useId: 'catalog.readonly-reviewed-gesture',
    licenseScope: 'runtime', modelSha256: null, maskId: null, referenceKey: null, backgroundKey: null, allowedProperties: null },
    context: { cancelled, activeOwners: null } };
}
