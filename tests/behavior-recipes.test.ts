import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from '../shared/motion-catalog.json';
import { BEHAVIOR_SEMANTICS } from '../shared/behavior-motion';
import { BEHAVIOR_COVERAGE, BEHAVIOR_RECIPES, admitBehaviorRecipe, type RecipeGates } from '../shared/behavior-recipes';
import { BehaviorRecipeSession, type BehaviorRecipeRequest } from '../electron/behavior-recipe-session';

const gates = (): RecipeGates => ({ enabled: true, visible: true, targetVerified: true, manualPose: false,
  manualGesture: false, manualExpression: false, manualHead: false, dynamicPose: false, phase: 'idle',
  cameraOrWindow: false, inputFocused: false, preview: false, speaking: false, music: false, waitingForReply: false });
const request = (patch: Partial<BehaviorRecipeRequest> = {}): BehaviorRecipeRequest => ({
  expectedScope: 'scope-1', sourceId: 'source-1', semantic: 'mood.happy', recipeId: 'face.happy', acceptedAt: 1_000, strength: 0.34, ...patch,
});
function session() {
  let now = 1_000, id = 0;
  const value = new BehaviorRecipeSession(() => now, () => `ticket-${++id}`);
  value.setContext('scope-1', gates());
  return { value, setNow: (next: number) => { now = next; } };
}

test('coverage closes over the current semantic catalog and separately retains gaps, legacy and reserves', () => {
  assert.deepEqual(Object.keys(BEHAVIOR_COVERAGE).sort(), Object.keys(BEHAVIOR_SEMANTICS).sort());
  assert.ok(BEHAVIOR_COVERAGE['flag.crying-candidate'].gaps.some(value => value.includes('R17')));
  assert.ok(BEHAVIOR_COVERAGE['phase.food-eating'].gaps.some(value => value.includes('swallowing')));
  assert.equal(BEHAVIOR_COVERAGE['reserved.pinch.*'].disposition, 'reserved');
  assert.equal(BEHAVIOR_COVERAGE['continuous.rua-follow'].disposition, 'continuous');
  assert.equal(BEHAVIOR_COVERAGE['manual.pose'].disposition, 'protected');
  assert.equal(BEHAVIOR_COVERAGE['voice.happy'].disposition, 'external');
  for (const row of Object.values(BEHAVIOR_COVERAGE)) {
    assert.equal(row.fallback, BEHAVIOR_SEMANTICS[row.semantic].fallback);
    assert.ok(row.activeRecipes.every(id => BEHAVIOR_RECIPES[id].review === 'existing-use-verified'));
    assert.ok(row.pendingRecipes.every(id => BEHAVIOR_RECIPES[id].review === 'review-required'));
  }
});

test('independent asset pins and original source durations match the shipped catalog without granting new uses', () => {
  for (const recipe of Object.values(BEHAVIOR_RECIPES)) {
    const asset = catalog.packs.find(pack => pack.id === recipe.packId)?.motions.find(motion => motion.id === recipe.motionId);
    assert.ok(asset, recipe.id);
    assert.equal(asset.sha256, recipe.sha256, recipe.id);
    assert.ok(Math.abs(asset.durationFrames / 30 * 1_000 - recipe.durationMs) < 1e-7, recipe.id);
    assert.equal(recipe.timing, 'original-once');
    assert.ok(Object.isFrozen(recipe));
  }
  assert.equal(Object.values(BEHAVIOR_RECIPES).filter(recipe => recipe.review === 'existing-use-verified').length, 14);
  assert.notEqual(BEHAVIOR_RECIPES['body.confirm'].review, BEHAVIOR_RECIPES['face.convinced'].review);
});

test('a sampled idle or head use never inherits an existing face approval or filename meaning', () => {
  for (const recipe of Object.values(BEHAVIOR_RECIPES).filter(recipe => recipe.review === 'review-required'))
    assert.deepEqual(admitBehaviorRecipe(recipe.id, gates()), { allowed: false, reason: 'unreviewed-use' });
  assert.deepEqual(BEHAVIOR_COVERAGE['phase.idle'].pendingRecipes, ['idle.neutral', 'idle.proud']);
  assert.ok(!BEHAVIOR_COVERAGE['mood.calm'].pendingRecipes.includes('idle.depressed'));
  for (const id of ['__proto__', '../convinced', 'Happy', null, {}, 'gene/convinced'])
    assert.deepEqual(admitBehaviorRecipe(id, gates()), { allowed: false, reason: 'unknown' });
});

test('missing or malformed gate values fail closed instead of coercing truthy consent', () => {
  for (const key of Object.keys(gates()).filter(key => key !== 'phase')) {
    for (const value of [undefined, 'false', 1, null])
      assert.deepEqual(admitBehaviorRecipe('face.happy', { ...gates(), [key]: value } as RecipeGates), { allowed: false, reason: 'gate' });
  }
  assert.deepEqual(admitBehaviorRecipe('face.happy', undefined as never), { allowed: false, reason: 'gate' });
});

test('all direct phases, waiting and window/input gates suppress optional recipes', () => {
  for (const phase of ['rua', 'food-wait', 'food-ready', 'food-eating', 'cheek', 'unknown'])
    assert.deepEqual(admitBehaviorRecipe('face.happy', { ...gates(), phase }), { allowed: false, reason: 'gate' });
  for (const patch of [{ enabled: false }, { visible: false }, { waitingForReply: true }, { cameraOrWindow: true },
    { inputFocused: true }, { preview: true }])
    assert.deepEqual(admitBehaviorRecipe('chat.explain', { ...gates(), ...patch }), { allowed: false, reason: 'gate' });
});

test('property-specific manual priority preserves face/body separation and speech mouth ownership', () => {
  assert.equal(admitBehaviorRecipe('face.happy', { ...gates(), manualPose: true, manualGesture: true }).allowed, true);
  assert.equal(admitBehaviorRecipe('chat.explain', { ...gates(), manualExpression: true, speaking: true }).allowed, true);
  assert.equal(admitBehaviorRecipe('face.happy', { ...gates(), speaking: true, music: true }).allowed, true);
  for (const patch of [{ manualPose: true }, { dynamicPose: true }, { manualGesture: true }])
    assert.deepEqual(admitBehaviorRecipe('chat.explain', { ...gates(), ...patch }), { allowed: false, reason: 'manual' });
  assert.deepEqual(admitBehaviorRecipe('face.happy', { ...gates(), manualExpression: true }), { allowed: false, reason: 'manual' });
  assert.deepEqual(admitBehaviorRecipe('chat.explain', { ...gates(), music: true }), { allowed: false, reason: 'continuous-owner' });
  assert.deepEqual(admitBehaviorRecipe('face.happy', { ...gates(), targetVerified: false }), { allowed: false, reason: 'unsupported-target' });
});

test('host tickets consume accepted identities once and independently lease expression and gesture', () => {
  const { value } = session(), face = value.issue(request());
  assert.ok(face && Object.isFrozen(face));
  assert.equal(value.issue(request()), null);
  const gesture = value.issue(request({ semantic: 'chat.explain', recipeId: 'chat.explain' }));
  assert.ok(gesture);
  assert.equal(value.canStart(face), true);
  assert.equal(value.canStart(gesture), true);
  assert.equal(value.canStart({ ...face }), false, 'a renderer-shaped clone is not the host lease');
  assert.equal(value.issue(request({ sourceId: 'wrong', recipeId: 'face.disgust' })), null, 'semantic binding set is enforced');
});

test('a valid reaction suppressed by input is consumed and does not play when input ends', () => {
  const { value } = session();
  value.setContext('scope-1', { ...gates(), phase: 'cheek' });
  assert.equal(value.issue(request()), null);
  value.setContext('scope-1', gates());
  assert.equal(value.issue(request()), null);
  assert.ok(value.issue(request({ sourceId: 'fresh-source' })));
});

test('hide then restore while resolving cannot resurrect a revoked old ticket', async () => {
  const { value } = session(), ticket = value.issue(request()); assert.ok(ticket);
  let release!: (value: string) => void;
  const pending = value.resolve(ticket, () => new Promise<string>(resolve => { release = resolve; }));
  value.setContext('scope-1', { ...gates(), visible: false });
  value.setContext('scope-1', gates());
  release('old-resource');
  assert.equal(await pending, null);
  assert.equal(value.issue(request()), null);
});

test('scope replacement and slot replacement invalidate asynchronous resources without stopping other slots', async () => {
  const { value } = session(), old = value.issue(request()); assert.ok(old);
  let release!: (value: number) => void;
  const pending = value.resolve(old, () => new Promise<number>(resolve => { release = resolve; }));
  const next = value.issue(request({ sourceId: 'next' })); assert.ok(next);
  value.cancel(old.id);
  assert.equal(value.canStart(next), true);
  release(42); assert.equal(await pending, null);
  value.setContext('scope-2', gates());
  assert.equal(value.canStart(next), false);
  value.setContext('scope-1', gates());
  assert.equal(value.issue(request({ sourceId: 'next' })), null);
});

test('expired, future, invalid and delayed loads cannot issue or start a replay', async () => {
  const { value, setNow } = session();
  for (const patch of [{ acceptedAt: -1 }, { acceptedAt: 1_001 }, { strength: NaN }, { strength: 0 }, { strength: 0.71 }])
    assert.equal(value.issue(request(patch)), null);
  const ticket = value.issue(request()); assert.ok(ticket);
  setNow(2_501);
  let called = false;
  assert.equal(await value.resolve(ticket, async () => { called = true; return 1; }), null);
  assert.equal(called, false);
  assert.equal(value.issue(request()), null);
});

test('bounded consumed storage cannot replay evicted identities inside the allowed loading window', () => {
  const { value, setNow } = session();
  for (let index = 0; index < 300; index++) {
    setNow(1_000 + index);
    assert.ok(value.issue(request({ sourceId: `source-${index}`, acceptedAt: 1_000 + index })));
  }
  assert.equal(value.issue(request({ sourceId: 'source-0' })), null);
});

test('a late source rejected before a clock rollback never becomes fresh on a repeated sample', () => {
  const { value, setNow } = session();
  setNow(3_000); assert.equal(value.issue(request()), null);
  setNow(2_000); assert.equal(value.issue(request()), null);
  assert.equal(value.issue(request()), null);
  setNow(3_000); assert.equal(value.issue(request()), null);
  assert.ok(value.issue(request({ sourceId: 'genuinely-new', acceptedAt: 3_000 })));
});

test('a result accepted in an old scope cannot be first issued under the next scope', () => {
  const { value } = session(), captured = request();
  value.setContext('scope-2', gates());
  assert.equal(value.issue(captured), null);
  assert.ok(value.issue(request({ expectedScope: 'scope-2', sourceId: 'new-scope-source' })));
  assert.equal(value.issue({ ...request(), expectedScope: undefined } as never), null);
});

test('load failures, backwards clocks and disposal revoke leases and never retry the same accepted source', async () => {
  const { value, setNow } = session(), ticket = value.issue(request()); assert.ok(ticket);
  await assert.rejects(value.resolve(ticket, async () => { throw new Error('fixture-load'); }), /fixture-load/);
  assert.equal(value.canStart(ticket), false);
  assert.equal(value.issue(request()), null);
  const next = value.issue(request({ sourceId: 'next' })); assert.ok(next);
  setNow(999); assert.equal(value.canStart(next), false);
  setNow(1_000); assert.equal(value.canStart(next), false);
  value.dispose();
  assert.equal(value.issue(request({ sourceId: 'after-dispose' })), null);
});
