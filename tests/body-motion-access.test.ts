import assert from 'node:assert/strict';
import test from 'node:test';
import { BodyMotionAccess, type BodyMotionAccessDependencies } from '../electron/body-motion-access';
import { BodyMotionController } from '../electron/body-motion';
import type { BodyMotionCue, BodyMotionResource } from '../shared/body-motion';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(qa = true) {
  let now = 1_000, token = 'token-1', generation = 1, visible = true, verifies = 0, registrations = 0, resolves = 0;
  const model = { path: 'C:/public-gene/model.pmx', url: 'mmd-asset://model/gene.pmx' };
  const controller = new BodyMotionController(() => now, () => 'body-id-1');
  if (qa) controller.configureQa('idle.neutral');
  const gates = () => ({ enabled: true, visible, phase: 'idle', posture: 50, waitingForReply: false, gestureActive: false });
  const resource = (cue: BodyMotionCue): Omit<BodyMotionResource, 'url'> & { path: string } => ({
    cueId: cue.id, recipeId: cue.recipeId, packId: '100style-idles', motionId: 'neutral-idle',
    sha256: 'a'.repeat(64), maskId: 'candidate-pose-v1', durationMs: 10_000, path: 'C:/reviewed/neutral.vmd',
  });
  const deps: { -readonly [K in keyof BodyMotionAccessDependencies]: BodyMotionAccessDependencies[K] } = {
    authorizePet: sender => sender === 7,
    visible: () => visible,
    generation: () => generation,
    model: () => model,
    view: () => ({ token, expressions: true, body: controller.observe(token, gates()) }),
    prepare: (expected, target) => controller.prepare(expected, gates(), target),
    cue: (id, expected) => {
      if (!controller.canStartCue(id, expected)) throw new Error('no-live-cue');
      return controller.observe(token, gates()).cue!;
    },
    verifyModel: async () => { verifies++; return true; },
    resolve: async (cue, current) => { resolves++; assert.equal(current(), true); return resource(cue); },
    register: async () => { registrations++; return { url: 'mmd-asset://approved/neutral.vmd' }; },
  };
  return { deps, controller, model, resource, create: () => new BodyMotionAccess(deps),
    setNow: (value: number) => { now = value; }, setToken: (value: string) => { token = value; },
    setVisible: (value: boolean) => { visible = value; }, nextGeneration: () => { generation++; },
    counts: () => ({ verifies, registrations, resolves }) };
}

test('normal closed mode returns no candidate without hashing, resolving, registering or enabling QA', async () => {
  const f = fixture(false), access = f.create();
  assert.deepEqual(await access.getPlan(7, 'token-1'), { cue: null, mode: 'closed', reason: 'normal-pool-closed' });
  assert.deepEqual(f.counts(), { verifies: 0, registrations: 0, resolves: 0 });
  await assert.rejects(access.resolve(7, 'invented', 'token-1'), /no-live-cue/);
});

test('only the current pet and scope may prepare or resolve; requests contain no recipe input', async () => {
  const f = fixture(), access = f.create();
  for (const sender of [0, 6, 8]) await assert.rejects(access.getPlan(sender, 'token-1'), /来源/);
  await assert.rejects(access.getPlan(7, '../token'), /来源/);
  await assert.rejects(access.getPlan(7, 'old-token'), /作用域/);
  assert.equal(f.counts().verifies, 0);
  const plan = await access.getPlan(7, 'token-1'); assert.ok(plan.cue);
  await assert.rejects(access.resolve(6, plan.cue.id, 'token-1'), /来源/);
  await assert.rejects(access.resolve(7, '../asset.vmd', 'token-1'), /身份/);
});

test('concurrent ready requests converge on the same one-shot immutable host cue and clocks', async () => {
  const f = fixture(), access = f.create();
  const [left, right] = await Promise.all([access.getPlan(7, 'token-1'), access.getPlan(7, 'token-1')]);
  assert.ok(left.cue && right.cue);
  assert.equal(left.cue, right.cue);
  assert.equal(left.cue.at, 1_000);
  f.setNow(1_200);
  assert.equal((await access.getPlan(7, 'token-1')).cue, left.cue);
});

test('normal URL output excludes the host path and rechecks Gene before and after grant', async () => {
  const f = fixture(), access = f.create(), plan = await access.getPlan(7, 'token-1'); assert.ok(plan.cue);
  const output = await access.resolve(7, plan.cue.id, 'token-1');
  assert.equal(output.url, 'mmd-asset://approved/neutral.vmd');
  assert.equal(Object.hasOwn(output, 'path'), false);
  assert.deepEqual(f.counts(), { verifies: 4, registrations: 1, resolves: 1 });
});

test('a model generation or in-place identity change during verification cannot prepare a cue', async () => {
  for (const change of ['generation', 'identity'] as const) {
    const f = fixture(), checking = deferred<boolean>();
    f.deps.verifyModel = () => checking.promise;
    const pending = f.create().getPlan(7, 'token-1');
    if (change === 'generation') f.nextGeneration(); else f.model.url = 'mmd-asset://other/model.pmx';
    checking.resolve(true);
    await assert.rejects(pending, /模型代次/);
    assert.equal(f.controller.ownsCue('body-id-1', 'token-1'), false);
  }
});

test('hidden or replaced scope during resource loading cannot receive an asset grant', async () => {
  for (const change of ['hide', 'scope', 'generation'] as const) {
    const f = fixture(), access = f.create(), plan = await access.getPlan(7, 'token-1'); assert.ok(plan.cue);
    const entered = deferred<void>(), loaded = deferred<ReturnType<typeof f.resource>>();
    f.deps.resolve = async () => { entered.resolve(); return loaded.promise; };
    const pending = access.resolve(7, plan.cue.id, 'token-1');
    await entered.promise;
    if (change === 'hide') f.setVisible(false);
    else if (change === 'scope') f.setToken('token-2');
    else f.nextGeneration();
    loaded.resolve(f.resource(plan.cue));
    await assert.rejects(pending);
    assert.equal(f.counts().registrations, 0);
  }
});

test('cancellation or target-byte denial after URL registration still rejects output', async () => {
  const f = fixture(), access = f.create(), plan = await access.getPlan(7, 'token-1'); assert.ok(plan.cue);
  const entered = deferred<void>(), granted = deferred<{ url: string }>();
  f.deps.register = async () => { entered.resolve(); return granted.promise; };
  const pending = access.resolve(7, plan.cue.id, 'token-1');
  await entered.promise;
  f.controller.cancel();
  granted.resolve({ url: 'mmd-asset://late/resource.vmd' });
  await assert.rejects(pending);
  const other = fixture(), otherAccess = other.create(), otherPlan = await otherAccess.getPlan(7, 'token-1'); assert.ok(otherPlan.cue);
  let checks = 0;
  other.deps.verifyModel = async () => ++checks < 3;
  await assert.rejects(otherAccess.resolve(7, otherPlan.cue.id, 'token-1'), /目标已改变/);
});

test('a denied target never resolves files and an expired startup lease cannot be refreshed by reads', async () => {
  const f = fixture(); f.deps.verifyModel = async () => false;
  const denied = await f.create().getPlan(7, 'token-1');
  assert.equal(denied.cue, null); assert.equal(denied.reason, 'unsupported-target');
  assert.equal(f.counts().resolves, 0);
  const other = fixture(), access = other.create(), plan = await access.getPlan(7, 'token-1'); assert.ok(plan.cue);
  other.setNow(2_501);
  await assert.rejects(access.resolve(7, plan.cue.id, 'token-1'), /no-live-cue/);
  assert.equal((await access.getPlan(7, 'token-1')).cue?.at, 1_000);
});

test('pet navigation ownership revokes an in-flight call even when webContents ID is reused', async () => {
  const f = fixture(), access = f.create(), plan = await access.getPlan(7, 'token-1'); assert.ok(plan.cue);
  const entered = deferred<void>(), loaded = deferred<ReturnType<typeof f.resource>>();
  f.deps.resolve = async () => { entered.resolve(); return loaded.promise; };
  const pending = access.resolve(7, plan.cue.id, 'token-1'); await entered.promise;
  // Main's navigation/render-process-gone callbacks do both synchronously.
  f.nextGeneration(); f.controller.cancel();
  loaded.resolve(f.resource(plan.cue)); await assert.rejects(pending);
  assert.equal(f.counts().registrations, 0);
  assert.equal((await access.getPlan(7, 'token-1')).cue, null);
});
