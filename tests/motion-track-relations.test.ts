import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recordedMotionTrackRelations } from '../electron/motion-track-relations';
import { MotionTrackCoverageHost } from '../electron/motion-track-coverage';
import type { MotionTrackCoverage, MotionTrackProperty } from '../shared/motion-track-coverage';
import type { MotionCatalog } from '../shared/motion-library';
import { stripDefaultVmdTracks, type VmdTrackData } from '../src/stage/vmd-tracks';
import gene from '../shared/motion-track-gene-structure.json';

function coverage(indices: number[], id = 'a'): MotionTrackCoverage {
  return { asset: { packId: 'gene', motionId: id }, sha256: 'f'.repeat(64),
    durationFrames: 30, removedDefaultBones: 0, removedZeroMorphs: 0,
    modelMapping: 'verified-public-gene', modelSha256: gene.modelSha256,
    properties: indices.map(index => ({ target: gene.bones.find(b => b.index === index)!.name,
      kind: 'quaternion', keyframes: 1, state: 'static-nondefault', part: null, modelIndex: index })) };
}

test('different source targets retain recorded ancestor direction/path and nondefault static occupancy', () => {
  const head = gene.bones.find(b => b.name === '頭')!, neck = gene.bones.find(b => b.index === head.parentIndex)!;
  const a = coverage([head.index]), b = coverage([neck.index], 'b'), before = structuredClone([a, b]);
  const view = recordedMotionTrackRelations([a, b]);
  assert.equal(view.status, 'recorded-public-gene');
  const row = view.rows.find(r => r.kind === 'ancestor')!;
  assert.equal(row.direction, 'b-to-a'); assert.deepEqual(row.chain, [neck.index, head.index]);
  assert.equal(row.a.target, head.name); assert.deepEqual(row.a.properties, ['quaternion']);
  assert.deepEqual([a, b], before, 'Explanation never mutates source facts or their static state');
  assert.deepEqual(view.unresolvedProperties, [0, 0]);
});

test('explicit grant source/recipient and same recorded IK controller are separate static witnesses', () => {
  const recipient = gene.bones.find(b => b.grant)!, source = recipient.grant!.parentIndex;
  const grant = recordedMotionTrackRelations([coverage([source]), coverage([recipient.index], 'b')]);
  assert.ok(grant.rows.some(r => r.kind === 'grant' && r.direction === 'a-to-b'
    && r.via === recipient.index && r.chain.join(',') === [source, recipient.index].join(',')));
  const controller = gene.bones.find(b => b.ik)!, link = controller.ik!.links[0].index;
  const ik = recordedMotionTrackRelations([coverage([controller.index]), coverage([link], 'b')]);
  assert.ok(ik.rows.some(r => r.kind === 'ik' && r.direction === 'shared-chain' && r.via === controller.index));
  assert.equal(ik.modelSha256, gene.modelSha256);
});

test('unknown content and ambiguous or morph bindings never become recorded bone relationships', () => {
  const a = coverage([9]), b = coverage([8], 'b');
  for (const change of [{ modelSha256: '0'.repeat(64) }, { modelMapping: 'unknown' as const }]) {
    const view = recordedMotionTrackRelations([a, { ...b, ...change }]);
    assert.equal(view.status, 'unknown'); assert.equal(view.modelSha256, null); assert.deepEqual(view.rows, []);
  }
  const wrong = { ...a.properties[0], target: 'not the source bone' };
  const morph: MotionTrackProperty = { ...a.properties[0], target: gene.morphs[0].name, kind: 'morph', modelIndex: 0 };
  const unknown = recordedMotionTrackRelations([{ ...a, properties: [wrong, morph] }, b]);
  assert.deepEqual(unknown.unresolvedProperties, [2, 0]); assert.deepEqual(unknown.rows, []);
  assert.equal(recordedMotionTrackRelations([a]).reason, 'two-assets-required');
});

test('separate branches and empty facts do not gain a static relation or combination permission', () => {
  const left = gene.bones.find(b => b.name === '左腕')!, right = gene.bones.find(b => b.name === '右腕')!;
  const view = recordedMotionTrackRelations([coverage([left.index]), coverage([right.index], 'b')]);
  assert.equal(view.total, 0); assert.deepEqual(view.rows, []);
  assert.equal('combination' in view, false); assert.equal('canPlay' in view, false);
  const empty = recordedMotionTrackRelations([coverage([]), coverage([], 'b')]);
  assert.equal(empty.status, 'recorded-public-gene'); assert.equal(empty.total, 0);
});

test('large selected coverage has deterministic bounded detail without hiding total relations or duplicating property pairs', () => {
  const indices = gene.bones.map(b => b.index), a = coverage(indices), b = coverage(indices, 'b');
  a.properties.push(...a.properties.map(p => ({ ...p, kind: 'position' as const })));
  const first = recordedMotionTrackRelations([a, b]), second = recordedMotionTrackRelations([a, b]);
  assert.equal(first.rows.length, 64); assert.equal(first.truncated, true); assert.ok(first.total > 64);
  assert.equal(first.total, first.counts.ancestor + first.counts.grant + first.counts.ik);
  assert.deepEqual(first, second); assert.ok(first.rows.every(r => r.a.properties.length === 2));
  const withoutSecondProperty = recordedMotionTrackRelations([coverage(indices), b]);
  assert.equal(withoutSecondProperty.total, first.total, 'Property channels are reported on each bone, not multiplied into duplicate structural rows');
});

test('actual host A/B caller explains distinct targets, rebinds on model identity change and preserves original unknown gates', async () => {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const bytes = [new Uint8Array([1]), new Uint8Array([2])];
  const catalog: MotionCatalog = { schemaVersion: 1, packs: [{ id: 'gene', name: 'Synthetic', source: 'synthetic', sourceUrl: '',
    revision: 'f'.repeat(40), license: { id: 'synthetic', url: '', attribution: '' }, documents: [], motions: bytes.map((body, i) => ({
      id: String(i), name: String(i), category: 'gesture', tags: [], relativePath: i + '.vmd', originalPath: String(i), downloadUrl: '',
      bytes: 1, sha256: digest(body), durationFrames: 30, boneFrames: 1, morphFrames: 0 })) }] };
  let model: string | null = gene.modelSha256, reads = 0, parses = 0;
  const host = new MotionTrackCoverageHost({ catalog, context: () => 'owned-current', modelIdentity: async () => model,
    resolve: async (_pack, id) => id, read: async id => { reads++; return bytes[Number(id)]; },
    parse: body => { parses++; const data: VmdTrackData = { metadata: { motionCount: 1, morphCount: 0 },
      motions: [{ boneName: body[0] === 1 ? '頭' : '首', frameNum: 30, position: [0, .1, 0], rotation: [0, 0, 0, 1] }], morphs: [] };
      const stripped = stripDefaultVmdTracks(data); return { data: stripped.vmd, report: stripped.report }; } });
  const request = { assets: [{ packId: 'gene', motionId: '0' }, { packId: 'gene', motionId: '1' }] };
  const known = await host.read(7, request);
  assert.deepEqual(known.directOverlap, []); assert.ok(known.recordedRelations.rows.some(r => r.kind === 'ancestor'));
  assert.equal(known.hierarchy, 'unknown'); assert.equal(known.ik, 'unknown'); assert.equal(known.combination, 'not-validated');
  model = null; const unknown = await host.read(7, request);
  assert.equal(unknown.recordedRelations.status, 'unknown'); assert.deepEqual(unknown.recordedRelations.rows, []);
  assert.notEqual(known.contextId, unknown.contextId); assert.equal(reads, 4); assert.equal(parses, 2);
});
