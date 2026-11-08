import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersonalizeBodyAuthoring } from '../electron/personalize-body-authoring';
import { PersonalizeBodyStore } from '../electron/personalize-body-store';
import { BODY_VISUAL_PURPOSE, type BodyPoseBinding } from '../shared/personalize-body';
import type { SelectedVisualImage } from '../electron/selected-visual-image';

const target = 'a'.repeat(64), source = 'b'.repeat(64);
const binding: BodyPoseBinding = { id: 'body.synthetic', label: '合成姿态', targetModelSha: target, sourceSha: source,
  mask: 'synthetic-rotation', qualifiedStrength: .3, properties: [{ boneIndex: 1, boneName: 'synthetic-arm', quaternion: [0, 0, 0, 1] }] };
const selection = { bindingId: binding.id, semantic: 'mood.content', label: '合成姿态', strength: .3 } as const;

async function fixture(run: (f: Awaited<ReturnType<typeof make>>) => Promise<void>) {
  const f = await make(); try { await run(f); } finally { await f.close(); }
}
async function make() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-body-session-')), card = randomUUID();
  let context = 'initial', supported = true, model: string | null = target, released = 0, calls = 0;
  const cancelled: string[] = [], changed: string[] = [];
  const store = new PersonalizeBodyStore(directory, () => [card]); await store.load();
  const service = new PersonalizeBodyAuthoring(store, {
    context: () => ({ characterId: card, identity: context, codex: true, imageSupported: supported,
      connectionLabel: 'synthetic', modelUrl: 'mmd-asset://synthetic' }),
    verifyTarget: async () => model, choices: sha => sha === target ? [binding] : [],
    binding: (id, sha) => id === binding.id && sha === target ? binding : null,
    chooseImage: async () => ({ dataUrl: 'data:image/jpeg;base64,AA==', previewDataUrl: 'data:image/jpeg;base64,AA==',
      sha256: 'c'.repeat(64), width: 1, height: 1, release: () => { released++; } } as SelectedVisualImage),
    reserve: () => () => {},
    stream: async (_prompt, _image, _signal, append) => { calls++; append(JSON.stringify({ observations: [
      { region: 'left-arm', visibility: 'occluded', description: '遮挡' }], inferences: [], questions: ['手臂在哪里？'], insufficient: '深度未知' })); },
    previewCancelled: (_owner, id) => cancelled.push(id), changed: id => changed.push(id),
  });
  const open = () => service.get(7, card);
  const choose = async () => { const state = await open(); return service.choose(7, state.id, state.revision); };
  const study = async () => { const s = await choose(); return service.research(7, { sessionId: s.id, revision: s.revision,
    materialId: s.material!.id, submitNonce: s.submitNonce!, purpose: BODY_VISUAL_PURPOSE, refinement: '' }); };
  return { directory, card, store, service, open, choose, study, cancelled, changed,
    context: (value: string) => { context = value; }, support: (value: boolean) => { supported = value; },
    model: (value: string | null) => { model = value; }, get calls() { return calls; }, get released() { return released; },
    close: async () => { service.invalidate(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('soft-body-session-')); await rm(directory, { recursive: true, force: true }); } };
}

test('only explicit current selected image submits, and each receipt is single-use', async () => fixture(async f => {
  let s = await f.choose(); assert.equal(f.calls, 0);
  const request = { sessionId: s.id, revision: s.revision, materialId: s.material!.id, submitNonce: s.submitNonce!,
    purpose: BODY_VISUAL_PURPOSE, refinement: '' };
  f.support(false); await assert.rejects(f.service.research(7, request)); assert.equal(f.calls, 0); f.support(true);
  s = await f.service.research(7, request); assert.equal(f.calls, 1); assert.equal(s.study?.observations[0].visibility, 'occluded');
  await assert.rejects(f.service.research(7, request)); assert.notEqual(s.submitNonce, request.submitNonce);
  f.service.close(7, s.id); assert.equal(f.released, 1); assert.equal(f.store.get(f.card).profile, null);
}));

test('fixed preset needs no image but keeps preview identity, current target, save and undo gates', async () => fixture(async f => {
  let s = await f.open(); assert.equal(s.material, null); assert.equal(s.study, null);
  await assert.rejects(f.service.preview(7, s.id, s.revision, selection));
  await assert.rejects(f.service.previewFixed(7, s.id, s.revision, { ...selection, strength: .4 }));
  const p = await f.service.previewFixed(7, s.id, s.revision, selection);
  assert.equal(p.sourceKind, 'fixed-preset'); assert.equal(p.materialId, null); assert.equal(f.calls, 0);
  const save = { sessionId: s.id, revision: p.revision, savedRevision: s.savedRevision, previewId: p.id, previewToken: p.token };
  await assert.rejects(f.service.save(7, save)); await assert.rejects(f.service.resolve(8, p.id, p.token, 3));
  f.service.receipt(7, { phase: 'bind', id: p.id, token: p.token, stageGeneration: 3 });
  await assert.rejects(f.service.resolve(7, p.id, p.token, 4));
  await f.service.resolve(7, p.id, p.token, 3);
  f.service.receipt(7, { phase: 'ready', id: p.id, token: p.token, stageGeneration: 3 });
  f.model(null); await assert.rejects(f.service.save(7, save)); f.model(target);
  s = await f.service.save(7, save); assert.equal(s.saved.profile?.enabled, true);
  assert.equal(s.material, null); assert.equal(s.study, null); assert.equal(f.calls, 0);
  s = await f.service.change(7, { sessionId: s.id, revision: s.revision, kind: 'disable' });
  assert.equal(s.saved.profile?.enabled, false);
  s = await f.service.change(7, { sessionId: s.id, revision: s.revision, kind: 'undo' });
  assert.equal(s.saved.profile?.enabled, true); assert.deepEqual(f.changed, [f.card, f.card, f.card]);
  const file = await readFile(path.join(f.directory, 'personalize-body.json'), 'utf8');
  assert.ok(!file.includes('base64')); assert.ok(!file.includes('materialId')); assert.ok(!file.includes('study'));
}));

test('a cancelled fixed preset cannot resolve or affect a newer preview', async () => fixture(async f => {
  const s = await f.open(), first = await f.service.previewFixed(7, s.id, s.revision, selection);
  f.service.receipt(7, { phase: 'stop', id: first.id, token: first.token, stageGeneration: 0 });
  await assert.rejects(f.service.resolve(7, first.id, first.token, 3));
  const current = await f.open(), next = await f.service.previewFixed(7, current.id, current.revision, selection);
  f.service.receipt(7, { phase: 'stop', id: first.id, token: first.token, stageGeneration: 0 });
  assert.ok(!f.cancelled.includes(next.id)); f.context('different-model');
  await assert.rejects(f.service.resolve(7, next.id, next.token, 3)); assert.equal(f.store.get(f.card).revision, 0);
}));

test('same owner, target, binding and stage generation gate preview, save, disable and undo', async () => fixture(async f => {
  let s = await f.study();
  await assert.rejects(f.service.preview(7, s.id, s.revision, { ...selection, bindingId: 'body.unknown' }));
  await assert.rejects(f.service.preview(7, s.id, s.revision, { ...selection, strength: .4 }));
  const p = await f.service.preview(7, s.id, s.revision, selection);
  const save = { sessionId: s.id, revision: p.revision, savedRevision: s.savedRevision, previewId: p.id, previewToken: p.token };
  await assert.rejects(f.service.save(7, save)); await assert.rejects(f.service.resolve(8, p.id, p.token, 3));
  assert.throws(() => f.service.receipt(7, { phase: 'ready', id: p.id, token: p.token, stageGeneration: 3 }));
  f.service.receipt(7, { phase: 'bind', id: p.id, token: p.token, stageGeneration: 3 });
  await assert.rejects(f.service.resolve(7, p.id, p.token, 4));
  assert.deepEqual(await f.service.resolve(7, p.id, p.token, 3), binding);
  f.service.receipt(7, { phase: 'ready', id: p.id, token: p.token, stageGeneration: 3 });
  f.model(null); await assert.rejects(f.service.save(7, save)); assert.equal(f.store.get(f.card).revision, 0); f.model(target);
  s = await f.service.save(7, save); assert.equal(s.saved.profile?.enabled, true);
  const file = await readFile(path.join(f.directory, 'personalize-body.json'), 'utf8');
  assert.ok(!file.includes('base64')); assert.ok(!file.includes('遮挡')); assert.ok(!file.includes('c'.repeat(64)));
  s = await f.service.change(7, { sessionId: s.id, revision: s.revision, kind: 'disable' });
  assert.equal(s.saved.profile?.enabled, false);
  f.model(null); await assert.rejects(f.service.change(7, { sessionId: s.id, revision: s.revision, kind: 'undo' })); f.model(target);
  s = await f.service.change(7, { sessionId: s.id, revision: s.revision, kind: 'undo' });
  assert.equal(s.saved.profile?.enabled, true); assert.deepEqual(f.changed, [f.card, f.card, f.card]);
}));

test('a stopped or context-replaced preview cannot confirm or cancel a newer selection', async () => fixture(async f => {
  const s = await f.study(), first = await f.service.preview(7, s.id, s.revision, selection);
  f.service.receipt(7, { phase: 'stop', id: first.id, token: first.token, stageGeneration: 0 });
  await assert.rejects(f.service.save(7, { sessionId: s.id, revision: first.revision, savedRevision: 0,
    previewId: first.id, previewToken: first.token }));
  const current = await f.open(), next = await f.service.preview(7, current.id, current.revision, selection);
  f.service.receipt(7, { phase: 'stop', id: first.id, token: first.token, stageGeneration: 0 });
  assert.ok(!f.cancelled.includes(next.id)); f.context('different-model');
  await assert.rejects(f.service.resolve(7, next.id, next.token, 1)); assert.equal(f.store.get(f.card).revision, 0);
}));
