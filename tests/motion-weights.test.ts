import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MotionWeightStore } from '../electron/motion-weights';
import { parseWeightQuery, parseWeightTags, type MotionWeightAsset } from '../shared/motion-weights';
import { buildMotionTagIndex, type MotionRecord } from '../shared/r32/motion-tag-index';
import { rankMotionTagAnnotations, searchMotionTags } from '../shared/r32/motion-tag-query';

const a: MotionWeightAsset = { packId: 'gene', motionId: 'stand', assetKey: 'mmdagent-ex/gene@revision/stand', sha256: 'a'.repeat(64) };
const b: MotionWeightAsset = { ...a, motionId: 'happy', assetKey: 'mmdagent-ex/gene@revision/happy', sha256: 'b'.repeat(64) };
const tag = (weight: number | null, dimension = 'mood', text = 'gentle') => ({ dimension, tag: text, weight });
async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-r32-weights-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('soft-r32-weights-'));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'motion-tag-annotations.json');
  let assets = [{ ...a }, { ...b }];
  const deps = { assets: async (_pack: unknown) => structuredClone(assets) };
  return { directory, file, deps, store: new MotionWeightStore(file, deps), setAssets: (next: MotionWeightAsset[]) => { assets = next; } };
}

test('weight transport retains unknown versus zero and rejects malformed/unbounded values without getters', () => {
  assert.deepEqual(parseWeightTags([tag(null), tag(0, 'context', 'listen')]).map(t => t.weight), [null, 0]);
  for (const value of [NaN, Infinity, -0.1, 1.1, '0.5', false]) assert.throws(() => parseWeightTags([tag(value as number)]));
  assert.throws(() => parseWeightTags([tag(0.2, 'mood', 'Ｇentle'), tag(0.8)]));
  assert.throws(() => parseWeightTags(Array.from({ length: 33 }, (_, i) => tag(null, 'mood', `t${i}`))));
  assert.throws(() => parseWeightTags([{ ...tag(0.5), path: '../model' }]));
  let accessed = false;
  const hostile = { dimension: 'mood', tag: 'gentle', get weight() { accessed = true; return 1; } };
  assert.throws(() => parseWeightTags([hostile])); assert.equal(accessed, false);
  assert.throws(() => parseWeightQuery({ packId: 'gene', preferred: [] }));
  assert.throws(() => parseWeightQuery({ packId: '../private', preferred: [] }));
});

test('annotate, atomic save, new-host reload and explicit query form a usable stable-identity path', async t => {
  const f = await setup(t), initial = await f.store.read(7, 'gene', 'stand');
  assert.equal(initial.revision, 0); assert.deepEqual(await readdir(f.directory), []);
  const saved = await f.store.save(7, { token: initial.token, revision: 0, tags: [tag(null), tag(0, 'context', 'listen')] });
  assert.equal(saved.revision, 1);
  const reopened = new MotionWeightStore(f.file, f.deps), loaded = await reopened.read(8, 'gene', 'stand');
  assert.deepEqual(loaded.tags.map(t => t.weight), [null, 0]);
  const result = await reopened.search({ packId: 'gene', preferred: [{ dimension: 'context', tag: 'listen', importance: 1 }] });
  const zero = result.rows.find(row => row.asset.motionId === 'stand')!, unknown = result.rows.find(row => row.asset.motionId === 'happy')!;
  assert.equal(zero.rankingValue, 0); assert.equal(zero.knownCoverage, 1);
  assert.equal(unknown.rankingValue, 0.5); assert.equal(unknown.score, null);
  assert.equal(result.executionAuthority, false);
  const bytes = await readFile(f.file, 'utf8');
  assert.ok(bytes.includes(a.assetKey) && bytes.includes(a.sha256));
  for (const forbidden of ['token', 'path', 'model', 'playbackStrength']) assert.equal(bytes.includes(`"${forbidden}"`), false);
  assert.deepEqual(await readdir(f.directory), ['motion-tag-annotations.json']);
});

test('tokens are sender/selection scoped and queued revisions prevent lost updates', async t => {
  const f = await setup(t), first = await f.store.read(7, 'gene', 'stand');
  await assert.rejects(f.store.save(8, { token: first.token, revision: 0, tags: [tag(1)] }));
  await f.store.read(7, 'gene', 'happy');
  await assert.rejects(f.store.save(7, { token: first.token, revision: 0, tags: [tag(1)] }));
  const one = await f.store.read(7, 'gene', 'stand'), two = await f.store.read(8, 'gene', 'stand');
  const outcomes = await Promise.allSettled([
    f.store.save(7, { token: one.token, revision: 0, tags: [tag(0.2)] }),
    f.store.save(8, { token: two.token, revision: 0, tags: [tag(0.8)] }),
  ]);
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).records.length, 1);
  f.store.dropOwner(7);
  await assert.rejects(f.store.save(7, { token: one.token, revision: 1, tags: [] }));
});

test('changed content never inherits another SHA annotation and rejects an old save', async t => {
  const f = await setup(t), view = await f.store.read(7, 'gene', 'stand');
  await f.store.save(7, { token: view.token, revision: 0, tags: [tag(0.9)] });
  const before = await readFile(f.file);
  const changed = { ...a, sha256: 'c'.repeat(64) }; f.setAssets([changed, b]);
  await assert.rejects(f.store.save(7, { token: view.token, revision: 1, tags: [tag(0.1)] }));
  assert.deepEqual(await readFile(f.file), before);
  const next = await f.store.read(7, 'gene', 'stand'); assert.equal(next.revision, 0); assert.deepEqual(next.tags, []);
  await f.store.save(7, { token: next.token, revision: 0, tags: [tag(0.1)] });
  const rows = JSON.parse(await readFile(f.file, 'utf8')).records;
  assert.equal(rows.length, 2); assert.equal(rows[0].sha256, a.sha256); assert.equal(rows[0].tags[0].weight, 0.9);
});

test('corrupt or future sidecars remain byte-for-byte intact on read/save failure', async t => {
  const f = await setup(t), view = await f.store.read(7, 'gene', 'stand');
  for (const bytes of ['{broken', '{"schemaVersion":2,"records":[]}']) {
    await writeFile(f.file, bytes);
    await assert.rejects(f.store.read(8, 'gene', 'stand'));
    await assert.rejects(f.store.save(7, { token: view.token, revision: 0, tags: [] }));
    assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
});

test('selection invalidation during the final content check preserves old data and removes only owned temporary output', async t => {
  const f = await setup(t);
  let count = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { entered = r; });
  const store = new MotionWeightStore(f.file, { assets: async () => { count++; if (count === 3) { entered(); await gate; } return [a, b]; } });
  const view = await store.read(7, 'gene', 'stand');
  const pending = store.save(7, { token: view.token, revision: 0, tags: [tag(1)] });
  const rejected = assert.rejects(pending); await reached;
  store.dropOwner(7); release(); await rejected;
  assert.deepEqual(await readdir(f.directory), []);
});

test('a hidden owner cannot revive an in-flight read after a new selection', async t => {
  const f = await setup(t); let release!: () => void, calls = 0;
  const gate = new Promise<void>(r => { release = r; });
  const store = new MotionWeightStore(f.file, { assets: async () => { if (++calls === 1) await gate; return [a, b]; } });
  const old = store.read(7, 'gene', 'stand'), rejected = assert.rejects(old);
  store.dropOwner(7); const current = await store.read(7, 'gene', 'happy'); release(); await rejected;
  assert.equal(current.asset.motionId, 'happy');
});

test('shared soft scoring normalizes dimensions/duplicates and keeps strict playback admission closed', () => {
  const record = (asset: MotionWeightAsset, fit: number, extras = 0): MotionRecord => ({ sourceId: asset.motionId,
    assetKey: asset.assetKey, outputSha256: asset.sha256, availability: 'available',
    license: { status: 'reviewed', scopes: ['local-preview'], ref: 'synthetic' }, uses: [], evidenceConfidence: null, playbackStrength: null,
    tags: [{ dimension: 'mood', raw: 'gentle', tag: 'gentle', fit, layer: 'candidate', evidence: 'candidate', refs: [] },
      ...Array.from({ length: extras }, (_, i) => ({ dimension: 'mood' as const, raw: `other${i}`, tag: `other${i}`, fit: 1,
        layer: 'candidate' as const, evidence: 'candidate' as const, refs: [] }))] });
  const index = buildMotionTagIndex([record(a, 0.2, 20), record(b, 0.8)]);
  const preferred = [{ dimension: 'mood' as const, tag: 'gentle', importance: 1 }];
  const once = rankMotionTagAnnotations(index, { layer: 'candidate', preferred });
  const duplicate = rankMotionTagAnnotations(index, { layer: 'candidate', preferred: [...preferred, ...preferred] });
  assert.deepEqual(once, duplicate); assert.equal(once[0].sourceId, 'happy'); assert.equal(once[1].rankingValue, 0.2);
  const dimensions = rankMotionTagAnnotations(index, { layer: 'candidate', preferred: [...preferred,
    { dimension: 'context', tag: 'listen', importance: 1 }] });
  assert.equal(dimensions[0].knownCoverage, 0.5); assert.equal(dimensions[0].rankingValue, 0.65);
  assert.equal(dimensions[1].rankingValue, 0.35); assert.equal(dimensions[0].dimensions.length, 2);
  const guarded = searchMotionTags(index, { layer: 'candidate', preferred, useId: 'unverified', licenseScope: 'local-preview',
    modelSha256: null, maskId: null, referenceKey: null, backgroundKey: null, allowedProperties: null }, { cancelled: false, activeOwners: [] });
  assert.equal(guarded.accepted.length, 0); assert.equal(guarded.rejected.length, 2);
});
