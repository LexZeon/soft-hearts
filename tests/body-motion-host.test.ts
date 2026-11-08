import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BodyMotionController, type BodyMotionHostGates } from '../electron/body-motion';
import { resolveBodyMotionResource } from '../electron/body-motion-bindings';
import { MoodHost } from '../electron/mood';
import { MotionLibrary } from '../electron/motion-library';
import { BODY_START_AGE_MS, isBodyMotionCue, type BodyMotionCue, type BodyRecipeId } from '../shared/body-motion';
import catalog from '../shared/motion-catalog.json';

const start = 1_000_000;
const gates = (): BodyMotionHostGates => ({ enabled: true, visible: true, phase: 'idle', posture: 50,
  waitingForReply: false, gestureActive: false });
function fixture() {
  let now = start, sequence = 0;
  return { controller: new BodyMotionController(() => now, () => `body-${++sequence}`),
    advance(ms: number) { now += ms; }, setNow(value: number) { now = value; }, get now() { return now; } };
}
const duration = (id: BodyRecipeId) => id === 'idle.proud' ? 161 / 30 * 1_000 : 10_000;
const cue = (recipeId: BodyRecipeId = 'body.confirm'): BodyMotionCue => ({ id: 'body-cue', token: 'scope-a', recipeId,
  at: start, expiresAt: start + duration(recipeId) + BODY_START_AGE_MS, durationMs: duration(recipeId), strength: 0.2 });
function asset(recipeId: BodyRecipeId): string {
  const packId = recipeId === 'body.confirm' ? 'gene' : '100style-idles';
  const motionId = recipeId === 'body.confirm' ? 'convinced' : recipeId === 'idle.neutral' ? 'neutral-idle' : 'proud-idle';
  const pack = catalog.packs.find(value => value.id === packId)!;
  const motion = pack.motions.find(value => value.id === motionId)!;
  return path.resolve('assets/bundled', pack.source, pack.id, pack.revision, motion.relativePath);
}
async function directory(t: TestContext): Promise<string> {
  const target = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-body-host-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(target)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('soft-hearts-body-host-'));
    await rm(target, { recursive: true, force: true });
  });
  return target;
}

test('normal body/idle pool remains closed through reads, preparation and context changes', () => {
  const f = fixture();
  for (let index = 0; index < 10; index++) {
    f.advance(100);
    assert.deepEqual(f.controller.observe(`scope-${index}`, gates()), { cue: null, mode: 'closed', reason: 'normal-pool-closed' });
    assert.equal(f.controller.prepare(`scope-${index}`, gates(), true).cue, null);
  }
});

test('only one startup QA recipe can be configured and issued, across concurrent/repeated prepare calls', async () => {
  const f = fixture();
  assert.equal(f.controller.configureQa('idle.neutral'), true);
  assert.equal(f.controller.configureQa('body.confirm'), false);
  f.controller.observe('scope-a', gates());
  const [left, right] = await Promise.all([Promise.resolve().then(() => f.controller.prepare('scope-a', gates(), true)),
    Promise.resolve().then(() => f.controller.prepare('scope-a', gates(), true))]);
  assert.ok(left.cue); assert.equal(left.cue, right.cue); assert.equal(left.cue.recipeId, 'idle.neutral');
  assert.ok(Object.isFrozen(left) && Object.isFrozen(left.cue));
  assert.equal(isBodyMotionCue(left.cue), true);
  assert.throws(() => { (left.cue as { id: string }).id = 'forged'; }, TypeError);
  f.controller.cancel();
  assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
  f.controller.observe('scope-b', gates());
  assert.equal(f.controller.prepare('scope-b', gates(), true).cue, null);
});

test('unknown or path-bearing startup recipes are sealed closed without a later retry', () => {
  for (const value of ['../private.vmd', 'file:///private.vmd', 'idle.arms-folded', '__proto__', {}, null]) {
    const f = fixture();
    assert.equal(f.controller.configureQa(value), false);
    assert.equal(f.controller.configureQa('idle.neutral'), false);
    assert.equal(f.controller.prepare('scope-a', gates(), true).mode, 'closed');
  }
});

test('unattempted initial QA stays ready after a temporary host block, while a consumed attempt never rearms', () => {
  const f = fixture(); f.controller.configureQa('idle.neutral');
  assert.equal(f.controller.observe('scope-a', { ...gates(), visible: false }).reason, 'blocked');
  const ready = f.controller.observe('scope-a', gates());
  assert.deepEqual(ready, { cue: null, mode: 'maintainer-qa', reason: 'qa-ready' });
  const first = f.controller.prepare('scope-a', gates(), true).cue;
  assert.ok(first); f.controller.observe('scope-a', { ...gates(), waitingForReply: true });
  const consumed = f.controller.observe('scope-a', gates());
  assert.deepEqual(consumed, { cue: null, mode: 'maintainer-qa', reason: 'qa-consumed' });
  assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
});

test('all three QA recipes preserve exact original duration and bounded host posture strength', () => {
  for (const recipeId of ['idle.neutral', 'idle.proud', 'body.confirm'] as const) {
    for (const posture of [25, 50, 100]) {
      const f = fixture(); f.controller.configureQa(recipeId);
      const issued = f.controller.prepare('scope-a', { ...gates(), posture }, true).cue;
      assert.ok(issued); assert.equal(issued.durationMs, duration(recipeId));
      assert.equal(issued.expiresAt, issued.at + issued.durationMs + BODY_START_AGE_MS);
      assert.equal(issued.strength, Math.min(0.3, 0.2 * posture / 50));
    }
  }
});

test('blocked, waiting, hidden, unsupported or zero-posture prepare attempts never become a late cue', () => {
  const blocked: Partial<BodyMotionHostGates>[] = [{ enabled: false }, { visible: false }, { phase: 'rua' },
    { phase: 'food-wait' }, { phase: 'cheek' }, { posture: 0 }, { posture: NaN }, { posture: 101 },
    { waitingForReply: true }, { gestureActive: true }, { enabled: 'true' as unknown as boolean }];
  for (const patch of blocked) {
    const f = fixture(); f.controller.configureQa('idle.neutral');
    assert.equal(f.controller.prepare('scope-a', { ...gates(), ...patch }, true).cue, null);
    assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
  }
  const f = fixture(); f.controller.configureQa('idle.neutral');
  assert.equal(f.controller.prepare('scope-a', gates(), false).reason, 'unsupported-target');
  assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
});

test('live host gate/context cancellation revokes ownership and never rearms the single startup attempt', () => {
  for (const patch of [{ visible: false }, { enabled: false }, { phase: 'rua' }, { waitingForReply: true }, { posture: 0 }]) {
    const f = fixture(); f.controller.configureQa('body.confirm');
    const first = f.controller.prepare('scope-a', gates(), true).cue!;
    assert.equal(f.controller.observe('scope-a', { ...gates(), ...patch }).cue, null);
    assert.equal(f.controller.ownsCue(first.id, first.token), false);
    assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
  }
  const f = fixture(); f.controller.configureQa('body.confirm');
  const first = f.controller.prepare('scope-a', gates(), true).cue!;
  assert.equal(f.controller.prepare('stale-other-scope', gates(), true).cue, null);
  assert.equal(f.controller.ownsCue(first.id, first.token), true, 'stale prepare cannot cancel a current host scope');
  f.controller.observe('scope-b', gates());
  assert.equal(f.controller.ownsCue(first.id, first.token), false);
  assert.equal(f.controller.prepare('scope-b', gates(), true).cue, null);
});

test('a new target denial revokes an already issued QA lease and later verification never rearms it', () => {
  const f = fixture(); f.controller.configureQa('body.confirm');
  const first = f.controller.prepare('scope-a', gates(), true).cue!;
  assert.equal(f.controller.prepare('stale-scope', gates(), false).cue, null);
  assert.equal(f.controller.ownsCue(first.id, first.token), true, 'a stale denial cannot affect the current scope');
  const denied = f.controller.prepare('scope-a', gates(), false);
  assert.deepEqual(denied, { cue: null, mode: 'maintainer-qa', reason: 'unsupported-target' });
  assert.equal(f.controller.ownsCue(first.id, first.token), false);
  assert.equal(f.controller.canStartCue(first.id, first.token), false);
  assert.equal(f.controller.observe('scope-a', gates()).cue, null);
  assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
});

test('start freshness is separate from a full ongoing lease through the final original source frame', () => {
  const f = fixture(); f.controller.configureQa('body.confirm');
  const first = f.controller.prepare('scope-a', gates(), true).cue!;
  f.advance(BODY_START_AGE_MS); assert.equal(f.controller.canStartCue(first.id, first.token), true);
  f.advance(1); assert.equal(f.controller.canStartCue(first.id, first.token), false);
  assert.equal(f.controller.ownsCue(first.id, first.token), true);
  f.advance(4_000); assert.equal(f.controller.ownsCue(first.id, first.token), true);
  f.advance(4_000); assert.equal(f.controller.ownsCue(first.id, first.token), true);
  f.setNow(first.expiresAt - 1); assert.equal(f.controller.ownsCue(first.id, first.token), true);
  f.advance(1); assert.equal(f.controller.ownsCue(first.id, first.token), false);
  assert.equal(f.controller.observe('scope-a', gates()).cue, null);
  assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null);
});

test('clock rollback, nonfinite time and suspension gaps revoke leases without rejuvenating a source', () => {
  for (const change of ['rollback', 'invalid', 'suspend'] as const) {
    const f = fixture(); f.controller.configureQa('idle.neutral');
    const first = f.controller.prepare('scope-a', gates(), true).cue!;
    f.advance(500); assert.equal(f.controller.ownsCue(first.id, first.token), true);
    f.setNow(change === 'rollback' ? start + 100 : change === 'invalid' ? NaN : start + 6_000);
    assert.equal(f.controller.ownsCue(first.id, first.token), false, change);
    f.setNow(start + 6_500);
    assert.equal(f.controller.prepare('scope-a', gates(), true).cue, null, change);
  }
});

test('fixed QA resource pins resolve only reviewed local previews offline and never create a cache', async t => {
  const target = await directory(t); let fetches = 0;
  const library = new MotionLibrary(path.join(target, 'cache'), { bundledDirectory: path.resolve('assets/bundled'),
    fetch: (async () => { fetches++; throw new Error('offline only'); }) as typeof fetch });
  for (const recipeId of ['idle.neutral', 'idle.proud', 'body.confirm'] as const) {
    const resource = await resolveBodyMotionResource(library, cue(recipeId), { now: start, stillCurrent: () => true });
    assert.equal(resource.recipeId, recipeId); assert.equal(resource.durationMs, duration(recipeId));
    assert.equal(resource.maskId, recipeId === 'body.confirm' ? 'candidate-head-v1' : 'candidate-pose-v1');
    assert.ok(Object.isFrozen(resource)); assert.equal(Object.hasOwn(resource, 'url'), false);
    assert.equal(createHash('sha256').update(await readFile(resource.path)).digest('hex'), resource.sha256);
  }
  assert.equal(fetches, 0); assert.deepEqual(await readdir(target), []);
});

test('forged cues, proxy/accessor identities and excess capabilities fail before any resource resolution', async () => {
  let calls = 0, getterReads = 0;
  const library = { resolvePreview: async () => { calls++; return asset('body.confirm'); } };
  const accessor = Object.defineProperty({ ...cue() }, 'recipeId', { enumerable: true, get() { getterReads++; return 'body.confirm'; } });
  const values: unknown[] = [null, {}, [], { ...cue(), recipeId: 'idle.arms-folded' }, { ...cue(), path: 'private.vmd' },
    { ...cue(), url: 'file:///private.vmd' }, { ...cue(), id: '../invalid' }, { ...cue(), token: '' },
    { ...cue(), durationMs: 100 }, { ...cue(), expiresAt: start + 100 }, { ...cue(), strength: 0.31 },
    { ...cue(), strength: NaN }, accessor, new Proxy(cue(), {}), { ...cue(), [Symbol('extra')]: true }];
  for (const value of values)
    await assert.rejects(resolveBodyMotionResource(library, value as BodyMotionCue, { now: start, stillCurrent: () => true }));
  assert.equal(calls, 0); assert.equal(getterReads, 0);
  await assert.rejects(resolveBodyMotionResource(library, cue(), { now: start, stillCurrent: () => false }));
  await assert.rejects(resolveBodyMotionResource(library, cue(), { now: start, stillCurrent: () => 1 as unknown as boolean }));
  assert.equal(calls, 0);
});

test('deferred resolution freezes the admitted cue instead of following caller mutations', async () => {
  let release!: (value: string) => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const library = { resolvePreview: async (pack: unknown, motion: unknown) => {
    assert.equal(pack, 'gene'); assert.equal(motion, 'convinced'); enter();
    return new Promise<string>(resolve => { release = resolve; });
  } };
  const mutable = { ...cue() }, pending = resolveBodyMotionResource(library, mutable, { now: start, stillCurrent: () => true });
  await entered; mutable.recipeId = 'idle.neutral'; mutable.id = 'mutated-id';
  release(asset('body.confirm'));
  const resource = await pending;
  assert.equal(resource.recipeId, 'body.confirm'); assert.equal(resource.cueId, 'body-cue');
});

test('late cancellation, clock rollback or start-age expiry during deferred resolution cannot grant a resource', async () => {
  for (const mode of ['cancel', 'rollback', 'late'] as const) {
    let now = start, current = true, release!: (value: string) => void;
    const library = { resolvePreview: async () => new Promise<string>(resolve => { release = resolve; }) };
    const pending = resolveBodyMotionResource(library, cue(), { now: () => now, stillCurrent: () => current });
    if (mode === 'cancel') current = false;
    if (mode === 'rollback') now = start - 1;
    if (mode === 'late') now = start + BODY_START_AGE_MS + 1;
    release(asset('body.confirm')); await assert.rejects(pending, /失效或不受支持/);
  }
});

test('a forged path containing wrong-size or wrong-hash VMD bytes fails the independent source pins', async t => {
  const target = await directory(t), forged = path.join(target, 'forged.vmd');
  const source = await readFile(asset('body.confirm'));
  await writeFile(forged, source.subarray(0, source.length - 1));
  await assert.rejects(resolveBodyMotionResource({ resolvePreview: async () => forged }, cue(), { now: start, stillCurrent: () => true }), /资源校验失败/);
  const changed = Buffer.from(source); changed[changed.length - 1] ^= 1; await writeFile(forged, changed);
  await assert.rejects(resolveBodyMotionResource({ resolvePreview: async () => forged }, cue(), { now: start, stillCurrent: () => true }), /资源校验失败/);
});

test('MoodHost shares the transient QA cue, preserves mood/profile bytes and never saves automatic choices', async t => {
  const target = await directory(t); let now = start;
  const host = new MoodHost(target, () => {}, () => now);
  try {
    await host.load(); host.activate('gene'); host.setBodyVisible(true); await host.flush();
    const before = await readFile(path.join(target, 'mood-state.json'), 'utf8'), original = host.get();
    assert.equal(original.body?.mode, 'closed'); assert.equal(host.configureBodyQa('idle.neutral'), true);
    const first = host.prepareBodyPresentation(original.token, true).cue;
    assert.ok(first); assert.deepEqual(host.get().body, host.get().body);
    assert.equal(host.getBodyCue(first.id, original.token)?.id, first.id);
    assert.deepEqual(host.get().snapshot.values, original.snapshot.values);
    await host.flush(); assert.equal(await readFile(path.join(target, 'mood-state.json'), 'utf8'), before);
    now += BODY_START_AGE_MS + 1;
    assert.equal(host.getBodyCue(first.id, original.token), null);
    assert.equal(host.getBodyCue(first.id, original.token, false)?.id, first.id);
    host.cancelBodyPresentation('old-token', first.id);
    assert.equal(host.getBodyCue(first.id, original.token, false)?.id, first.id);
    host.cancelBodyPresentation(original.token, first.id);
    assert.equal(host.get().body?.cue, null);
    assert.equal(host.prepareBodyPresentation(original.token, true).cue, null);
  } finally { await host.flush(); }
});

test('MoodHost hides, new user acceptance and context invalidation cancel body presentation immediately', async t => {
  for (const boundary of ['hide', 'user', 'context', 'interaction-cancel', 'expressions'] as const) {
    const target = await directory(t), host = new MoodHost(target, () => {}, () => start);
    try {
      await host.load(); host.activate('gene'); host.setBodyVisible(true); host.configureBodyQa('body.confirm');
      const token = host.get().token, first = host.prepareBodyPresentation(token, true).cue!;
      if (boundary === 'hide') host.setBodyVisible(false);
      if (boundary === 'user') host.beginChatGesture('new-user', token);
      if (boundary === 'context') host.invalidate();
      if (boundary === 'interaction-cancel') host.cancelInteraction();
      if (boundary === 'expressions') host.setExpressions(false);
      assert.equal(host.getBodyCue(first.id, token, false), null, boundary);
      assert.equal(host.get().body?.cue, null, boundary);
      host.setBodyVisible(true);
      assert.equal(host.prepareBodyPresentation(host.get().token, true).cue, null, boundary);
    } finally { await host.flush(); }
  }
});
