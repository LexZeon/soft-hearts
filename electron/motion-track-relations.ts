import gene from '../shared/motion-track-gene-structure.json';
import type {
  MotionTrackCoverage, MotionRecordedRelations, MotionRelationBone, MotionTrackRelation,
} from '../shared/motion-track-coverage';

const LIMIT = 64;
const bones = new Map(gene.bones.map(bone => [bone.index, bone]));
const names = new Map<string, number>();
for (const bone of gene.bones) names.set(bone.name, (names.get(bone.name) ?? 0) + 1);
const ikRecords = gene.bones.filter(bone => bone.ik).map(bone => ({
  controller: bone.index,
  members: new Set([bone.index, bone.ik!.effector, ...bone.ik!.links.map(link => link.index)]),
}));

function occupied(fact: MotionTrackCoverage): { rows: MotionRelationBone[]; unresolved: number } {
  const rows = new Map<number, MotionRelationBone>();
  let unresolved = 0;
  for (const property of fact.properties) {
    const bone = property.modelIndex === null ? undefined : bones.get(property.modelIndex);
    if (property.kind === 'morph' || !bone || bone.name !== property.target || names.get(bone.name) !== 1) {
      unresolved++;
      continue;
    }
    const row = rows.get(bone.index) ?? { index: bone.index, target: bone.name, properties: [] };
    if (!row.properties.includes(property.kind)) row.properties.push(property.kind);
    rows.set(bone.index, row);
  }
  return { rows: [...rows.values()].sort((a, b) => a.index - b.index), unresolved };
}

/** A source-index path only. Solver state, transforms and compositing closure are not inferred. */
function ancestry(ancestor: number, descendant: number): number[] | null {
  const path = [descendant];
  const seen = new Set(path);
  let parent = bones.get(descendant)?.parentIndex ?? -1;
  while (parent >= 0 && path.length <= bones.size) {
    if (seen.has(parent) || !bones.has(parent)) return null;
    path.push(parent);
    if (parent === ancestor) return path.reverse();
    seen.add(parent);
    parent = bones.get(parent)!.parentIndex;
  }
  return null;
}

/** Uses the already frozen public structural table, never a model file or a name/tag heuristic. */
export function recordedMotionTrackRelations(assets: readonly MotionTrackCoverage[]): MotionRecordedRelations {
  const result: MotionRecordedRelations = {
    status: 'unknown', reason: assets.length === 2 ? 'model-unverified' : 'two-assets-required',
    modelSha256: null, rows: [], counts: { ancestor: 0, grant: 0, ik: 0 }, total: 0,
    truncated: false, unresolvedProperties: [assets[0]?.properties.length ?? 0, assets[1]?.properties.length ?? 0],
  };
  if (assets.length !== 2 || !assets.every(asset => asset.modelMapping === 'verified-public-gene'
    && asset.modelSha256 === gene.modelSha256)) return result;
  result.status = 'recorded-public-gene'; result.reason = null; result.modelSha256 = gene.modelSha256;
  const [left, right] = assets.map(occupied);
  result.unresolvedProperties = [left.unresolved, right.unresolved];
  const add = (row: MotionTrackRelation) => {
    result.counts[row.kind]++; result.total++;
    if (result.rows.length < LIMIT) result.rows.push(row);
    else result.truncated = true;
  };
  // At most224 unique source indices per side; emitted detail is capped independently of counting.
  for (const a of left.rows) for (const b of right.rows) {
    if (a.index === b.index) continue; // Same-property/source-index overlap has its existing separate report.
    const forward = ancestry(a.index, b.index), backward = forward ? null : ancestry(b.index, a.index);
    if (forward || backward) add({ kind: 'ancestor', a, b, direction: forward ? 'a-to-b' : 'b-to-a',
      via: forward ? a.index : b.index, chain: forward ?? backward! });
    const aGrant = bones.get(a.index)!.grant, bGrant = bones.get(b.index)!.grant;
    if (bGrant?.parentIndex === a.index) add({ kind: 'grant', a, b, direction: 'a-to-b', via: b.index, chain: [a.index, b.index] });
    if (aGrant?.parentIndex === b.index) add({ kind: 'grant', a, b, direction: 'b-to-a', via: a.index, chain: [b.index, a.index] });
    for (const record of ikRecords) if (record.members.has(a.index) && record.members.has(b.index)) {
      add({ kind: 'ik', a, b, direction: 'shared-chain', via: record.controller, chain: [] });
    }
  }
  return result;
}
