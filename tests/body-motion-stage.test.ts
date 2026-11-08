import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import catalog from '../shared/motion-catalog.json';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { createVmdParser } from '../src/stage/vmd';
import { isReviewedDefaultPose } from '../src/stage/default-pose';
import { AnimationClip, Bone, BufferGeometry, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack,
  Skeleton, SkinnedMesh, Vector3 } from 'three';
import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import { canonicalVmdClipDuration } from '../shared/vmd-duration';
import { BODY_START_AGE_MS, type BodyMotionCue, type BodyMotionPlan, type BodyMotionResource } from '../shared/body-motion';
import { BodyMotionController, type BodyPlayerPort, type BodyStageGates } from '../src/stage/body-motion-controller';
import { BehaviorBodyPlayer, type BehaviorBodyPlay, type BehaviorBodyState } from '../src/stage/behavior-body';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { MmdStage } from '../src/stage/MmdStage';

const gates = (): BodyStageGates => ({ ready: true, enabled: true, visible: true, manualPose: false, manualGesture: false, manualExpression: false,
  manualHead: false, dynamicPose: false, cameraOrWindow: false, inputBlocked: false, directContact: false,
  music: false, speaking: false, waitingForReply: false, chatGesture: false });
const cue = (patch: Partial<BodyMotionCue> = {}): BodyMotionCue => ({ id: 'body-1', token: 'token-1', recipeId: 'body.confirm',
  at: 1_000, expiresAt: 12_500, durationMs: 10_000, strength: 0.2, ...patch });
const plan = (value = cue()): BodyMotionPlan => ({ mode: 'maintainer-qa', reason: 'qa-issued', cue: value });
const closed: BodyMotionPlan = { mode: 'closed', reason: 'normal-pool-closed', cue: null };
const ready: BodyMotionPlan = { mode: 'maintainer-qa', reason: 'qa-ready', cue: null };
function resource(value = cue()): BodyMotionResource {
  const recipe = BEHAVIOR_RECIPES[value.recipeId];
  return { cueId: value.id, recipeId: value.recipeId, packId: recipe.packId, motionId: recipe.motionId,
    sha256: recipe.sha256, maskId: recipe.mask, durationMs: recipe.durationMs,
    url: `mmd-asset://${'a'.repeat(32)}/${recipe.motionId}.vmd` } as BodyMotionResource;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
async function settle() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
function mockPlayer() {
  let current: BehaviorBodyPlay | null = null, elapsed = 0;
  const calls: BehaviorBodyPlay[] = [];
  const state = (): BehaviorBodyState => ({ active: !!current, id: current?.id ?? null, maskId: current?.maskId ?? null,
    reason: current ? 'playing' : 'stopped', durationMs: current?.durationMs ?? 0, elapsedMs: elapsed,
    nextTimeMs: elapsed, weight: current ? 0.2 : 0,
    trackNames: current?.clip.tracks.map(track => track.name) ?? [], blockedBaseProperties: [] });
  const port: BodyPlayerPort = {
    play(value) { current = value; elapsed = 0; calls.push(value); return true; },
    beforeUpdate(delta) { elapsed += delta * 1_000; if (current && elapsed >= current.durationMs) current = null; return state(); },
    stop() { current = null; }, dispose() { current = null; }, getState: state,
  };
  return { port, calls };
}
const rotation = (bone: string, value: number, duration = 10) => {
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), value);
  return new QuaternionKeyframeTrack(`.bones[${bone}].quaternion`, [0, duration], [...quaternion.toArray(), ...quaternion.toArray()]);
};
const source = () => new AnimationClip('fixture-candidate', 10, [rotation('首', 0.3), rotation('頭', 0.5)]);
function harness(patch: { getPlan?: (token: string) => Promise<BodyMotionPlan>;
  resolve?: (id: string, token: string) => Promise<BodyMotionResource>;
  load?: (value: BodyMotionResource, mesh: SkinnedMesh) => Promise<AnimationClip>;
  supported?: boolean; consumed?: Set<string> } = {}) {
  let now = 1_000, reads = 0, resolves = 0, loads = 0, mutations = 0;
  const player = mockPlayer();
  const controller = new BodyMotionController({} as SkinnedMesh, { player: player.port,
    targetSupported: patch.supported !== false, consumedIds: patch.consumed,
    now: () => now,
    getPlan: async token => { reads++; return patch.getPlan ? patch.getPlan(token) : closed; },
    resolve: async (id, token) => { resolves++; return patch.resolve ? patch.resolve(id, token) : resource(); },
    load: async (value, mesh) => { loads++; return patch.load ? patch.load(value, mesh) : source(); },
    mutate: <T>(callback: () => T): T => { mutations++; return callback(); },
  });
  return { controller, player, mutations: () => mutations, setNow: (value: number) => { now = value; }, counts: () => ({ reads, resolves, loads }) };
}

test('normal closed pool and unqualified targets never resolve/load a body asset', async () => {
  for (const explicit of [closed, undefined]) {
    const h = harness(); h.controller.update(explicit, 'token-1', gates()); await settle();
    for (let index = 0; index < 20; index++) h.controller.beforeUpdate(1 / 30, 1_000 + index, gates());
    assert.deepEqual(h.counts(), { reads: explicit ? 0 : 1, resolves: 0, loads: 0 });
    assert.equal(h.player.calls.length, 0); h.controller.dispose();
  }
  const unsupported = harness({ supported: false });
  unsupported.controller.update(undefined, 'token-1', gates()); await settle();
  assert.deepEqual(unsupported.counts(), { reads: 0, resolves: 0, loads: 0 });
});

test('closed or already-cancelled presentation never rebuilds helper or physics bindings repeatedly', async () => {
  const inactive = harness(); inactive.controller.update(closed, 'token-1', gates());
  for (let index = 0; index < 30; index++) inactive.controller.cancel();
  inactive.controller.dispose(); assert.equal(inactive.mutations(), 0);
  const active = harness(); active.controller.update(plan(), 'token-1', gates()); await settle();
  assert.equal(active.mutations(), 1, 'only actual attachment needs a binding rebuild');
  active.controller.cancel(); assert.equal(active.mutations(), 2, 'active detach rebuilds exactly once');
  for (let index = 0; index < 30; index++) active.controller.cancel();
  active.controller.dispose(); assert.equal(active.mutations(), 2);
});

test('the single prepare read waits for every local readiness gate and qa-ready observation is not prepare', async () => {
  for (const key of Object.keys(gates()) as (keyof BodyStageGates)[]) {
    const h = harness({ getPlan: async () => plan() });
    const blocked = { ...gates(), [key]: ['ready', 'enabled', 'visible'].includes(key) ? false : true };
    h.controller.update(ready, 'token-1', blocked); await settle();
    assert.equal(h.counts().reads, 0, key);
    h.controller.update(ready, 'token-1', gates()); await settle();
    assert.deepEqual(h.counts(), { reads: 1, resolves: 1, loads: 1 }, key);
    h.controller.update(plan(), 'token-1', gates()); await settle();
    assert.equal(h.counts().reads, 1, key); assert.equal(h.player.calls.length, 1, key); h.controller.dispose();
  }
});

test('a repeated qa-ready observation does not invalidate the in-flight single prepare', async () => {
  const pending = deferred<BodyMotionPlan>(), h = harness({ getPlan: () => pending.promise });
  h.controller.update(ready, 'token-1', gates());
  h.controller.update(ready, 'token-1', gates());
  assert.equal(h.counts().reads, 1);
  pending.resolve(plan()); await settle();
  assert.equal(h.player.calls.length, 1); h.controller.dispose();
});

test('a later host QA-ready transition gets its one prepare after an earlier normal closed read', async () => {
  let qa = false;
  const h = harness({ getPlan: async () => qa ? plan() : closed });
  h.controller.update(undefined, 'token-1', gates()); await settle();
  assert.deepEqual(h.counts(), { reads: 1, resolves: 0, loads: 0 });
  qa = true; h.controller.update(ready, 'token-1', gates()); await settle();
  assert.deepEqual(h.counts(), { reads: 2, resolves: 1, loads: 1 });
  h.controller.update(ready, 'token-1', gates()); await settle();
  assert.equal(h.counts().reads, 2); h.controller.dispose();
});

test('qa-ready supersedes a still-pending old closed read without that old result clearing the new cue', async () => {
  const initial = deferred<BodyMotionPlan>(); let reads = 0;
  const h = harness({ getPlan: () => ++reads === 1 ? initial.promise : Promise.resolve(plan()) });
  h.controller.update(undefined, 'token-1', gates());
  h.controller.update(ready, 'token-1', gates()); await settle();
  assert.equal(h.player.calls.length, 1);
  initial.resolve(closed); await settle();
  assert.equal(h.player.calls.length, 1); assert.equal(h.controller.getState().active, true);
  assert.equal(reads, 2); h.controller.dispose();
});

test('attempted cue is consumed before load and cannot replay after direct input/hide/resume', async () => {
  for (const key of ['directContact', 'visible', 'inputBlocked', 'cameraOrWindow', 'waitingForReply', 'music'] as const) {
    const pending = deferred<BodyMotionResource>(), h = harness({ resolve: () => pending.promise });
    h.controller.update(plan(), 'token-1', gates());
    const blocked = { ...gates(), [key]: key === 'visible' ? false : true };
    h.controller.update(plan(), 'token-1', blocked);
    h.controller.update(plan(), 'token-1', gates());
    pending.resolve(resource()); await settle();
    assert.equal(h.player.calls.length, 0, key); assert.equal(h.counts().resolves, 1, key);
    h.controller.update(plan(), 'token-1', gates()); await settle();
    assert.equal(h.counts().resolves, 1, key); h.controller.dispose();
  }
});

test('old initial plan and old resolved/loaded resources cannot cross a token generation', async () => {
  for (const phase of ['plan', 'resolve', 'load'] as const) {
    const read = deferred<BodyMotionPlan>(), resolved = deferred<BodyMotionResource>(), loaded = deferred<AnimationClip>();
    const h = harness({ getPlan: () => read.promise, resolve: () => resolved.promise, load: () => loaded.promise });
    h.controller.update(phase === 'plan' ? undefined : plan(), 'token-1', gates());
    if (phase === 'load') { resolved.resolve(resource()); await settle(); }
    h.controller.update(closed, 'token-2', gates());
    read.resolve(plan()); resolved.resolve(resource()); loaded.resolve(source()); await settle();
    assert.equal(h.player.calls.length, 0, phase); h.controller.dispose();
  }
});

test('fixed metadata, mask and registered local URL are checked before touching a loader', async () => {
  const invalid: Partial<BodyMotionResource>[] = [{ cueId: 'other' }, { recipeId: 'idle.neutral' }, { packId: '100style-idles' },
    { motionId: 'proud-idle' }, { sha256: 'b'.repeat(64) }, { maskId: 'candidate-pose-v1' }, { durationMs: 9_999 },
    { url: 'file:///convinced.vmd' }, { url: 'https://example.org/convinced.vmd' },
    { url: `mmd-asset://${'a'.repeat(32)}/convinced.vmd?other=1` },
    { url: `mmd-asset://${'a'.repeat(32)}/stand.vmd` }];
  for (const patch of invalid) {
    const h = harness({ resolve: async () => ({ ...resource(), ...patch }) });
    h.controller.update(plan(), 'token-1', gates()); await settle();
    assert.equal(h.counts().loads, 0, JSON.stringify(patch)); assert.equal(h.player.calls.length, 0);
    h.controller.dispose();
  }
});

test('future, late, wrong-token and invalid-duration cues never play', async () => {
  for (const value of [cue({ at: 1_001, expiresAt: 12_501 }), cue({ token: 'old-token' }), cue({ durationMs: 9_999 })]) {
    const h = harness(); h.controller.update(plan(value), 'token-1', gates()); await settle();
    assert.equal(h.player.calls.length, 0); h.controller.dispose();
  }
  const h = harness(); h.setNow(1_000 + BODY_START_AGE_MS + 1);
  h.controller.update(plan(), 'token-1', gates()); await settle(); assert.equal(h.counts().resolves, 0);
  h.controller.dispose();
});

test('startup age is separate from full-pass ownership, and expiration cancels immediately', async () => {
  const h = harness(); h.controller.update(plan(), 'token-1', gates()); await settle();
  assert.equal(h.player.calls.length, 1);
  h.setNow(3_000); h.controller.beforeUpdate(0.1, 3_000, gates());
  assert.equal(h.controller.getState().active, true, 'A running ten-second source does not expire at startup1.5s.');
  assert.equal(h.controller.ownsProperty('.bones[頭].quaternion'), true);
  assert.equal(h.controller.ownsProperty('.morphTargetInfluences[0]'), false);
  h.controller.beforeUpdate(0.1, 12_500, gates()); assert.equal(h.controller.getState().active, false);
  h.setNow(13_000); h.controller.update(plan(), 'token-1', gates()); await settle();
  assert.equal(h.player.calls.length, 1); h.controller.dispose();
});

test('a load that finishes after startup age is discarded even while its full lease still exists', async () => {
  const pending = deferred<AnimationClip>(), h = harness({ load: () => pending.promise });
  h.controller.update(plan(), 'token-1', gates()); await settle();
  h.setNow(2_501); pending.resolve(source()); await settle();
  assert.equal(h.player.calls.length, 0); assert.equal(h.controller.getState().pending, false); h.controller.dispose();
});

test('proud keeps one canonical 161/30 duration from the parser to the player, not MMDLoader Float32 time', async () => {
  const durationMs = BEHAVIOR_RECIPES['idle.proud'].durationMs;
  const accepted = cue({ recipeId: 'idle.proud', durationMs, expiresAt: 1_000 + durationMs + BODY_START_AGE_MS });
  const seconds = durationMs / 1_000;
  assert.ok(Math.abs(Math.fround(seconds) * 1_000 - durationMs) > 1e-4, 'Exercise the actual proud rounding boundary.');
  // The Stage loader gives the clip the parser's frames/30 (the same function the recipe uses).
  const loaded = () => { const clip = new AnimationClip('public-proud', Math.fround(seconds), [rotation('頭', 0.1, Math.fround(seconds))]);
    assert.equal(canonicalVmdClipDuration(clip, 161), durationMs); return clip; };
  const h = harness({ resolve: async () => resource(accepted), load: async () => loaded() });
  h.controller.update(plan(accepted), 'token-1', gates()); await settle();
  assert.equal(h.player.calls.length, 1); assert.equal(h.player.calls[0].durationMs, durationMs); h.controller.dispose();
  const raw = harness({ resolve: async () => resource(accepted), load: async () => new AnimationClip('uncanonical', Math.fround(seconds),
    [rotation('頭', 0.1, Math.fround(seconds))]) });
  raw.controller.update(plan(accepted), 'token-1', gates()); await settle();
  assert.equal(raw.player.calls.length, 0, 'no tolerance: a clip that skipped the canonical duration is not admitted');
  assert.equal(raw.controller.getState().reason, 'invalid-duration'); raw.controller.dispose();
  const changed = harness({ resolve: async () => resource(accepted), load: async () => new AnimationClip('retimed',
    Math.fround(seconds) + 0.001, [rotation('頭', 0.1, Math.fround(seconds) + 0.001)]) });
  changed.controller.update(plan(accepted), 'token-1', gates()); await settle();
  assert.equal(changed.player.calls.length, 0); assert.equal(changed.controller.getState().reason, 'invalid-duration');
  changed.controller.dispose();
});

test('backward clocks and disposal cancel pending work and cannot resurrect a consumed identity', async () => {
  const pending = deferred<AnimationClip>(), h = harness({ load: () => pending.promise });
  h.controller.update(plan(), 'token-1', gates()); await settle();
  h.controller.beforeUpdate(0.1, 999, gates()); pending.resolve(source()); await settle();
  h.controller.update(plan(), 'token-1', gates()); await settle(); assert.equal(h.player.calls.length, 0);
  h.controller.dispose(); h.controller.update(plan(cue({ id: 'new' })), 'token-1', gates());
  assert.equal(h.counts().resolves, 1);
});

test('Stage-owned consumption survives replacing a player or Layered instance', async () => {
  const consumed = new Set<string>(), first = harness({ consumed });
  first.controller.update(plan(), 'token-1', gates()); await settle(); assert.equal(first.player.calls.length, 1);
  first.controller.dispose(); const next = harness({ consumed });
  next.controller.update(plan(), 'token-1', gates()); await settle();
  assert.equal(next.counts().resolves, 0); next.controller.dispose();
});

test('controls Stage never creates the pet-only controller and new input gate leaves old routes alone', () => {
  const stage = Object.create(MmdStage.prototype) as any;
  stage.options = { transparent: false }; stage.bodyReady = true; stage.mesh = {}; stage.animation = {}; stage.bodyMotion = null;
  stage.updateBodyMotion(); assert.equal(stage.bodyMotion, null, 'No window/desktop IPC exists in this CPU fixture.');
  const events: string[] = [];
  stage.cancelBodyMotion = () => events.push('cancel-body'); stage.updateBodyMotion = () => events.push('update-body');
  stage.updateBehaviorMotion = () => { throw new Error('Old face route must not be called.'); };
  stage.cancelChatGesture = () => { throw new Error('Old M004 route must not be called.'); };
  stage.setBodyInputBlocked(true);
  assert.equal(stage.bodyInputBlocked, true); assert.deepEqual(events, ['cancel-body', 'update-body']);
});

test('the actual hash-reviewed Stand head track is a compatible background, while other manual head sources block', async () => {
  const pack = catalog.packs.find(value => value.id === 'gene')!;
  const stand = pack.motions.find(value => value.id === 'stand')!;
  const bytes = await readFile(path.join('assets/bundled', pack.source, pack.id, pack.revision, stand.relativePath));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const parser = createVmdParser() as { parseVmd(data: ArrayBuffer, convert: boolean): { motions: { boneName: string; rotation: number[] }[] } };
  const head = parser.parseVmd(buffer, true).motions.filter(frame => frame.boneName === '頭');
  assert.ok(head.length > 1 && head.some(frame => frame.rotation.some((value, index) => Math.abs(value - head[0].rotation[index]) > 0.0001)),
    'This regression must use the actual dynamic head track that sets legacy moodHeadBlocked.');
  const qualified = await isReviewedDefaultPose('mmd-asset://public/stand.vmd', async () => new Response(buffer));
  assert.equal(qualified, true);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
  try {
    const stage = Object.create(MmdStage.prototype) as any;
    Object.assign(stage, { bodyReady: true, mesh: {}, animation: {}, disposed: false, hostVisible: true,
      container: { clientWidth: 400, clientHeight: 560 }, controls: { interacting: false },
      bodyManualPose: !qualified, bodyManualGesture: false, bodyDynamicPose: false, moodHeadBlocked: true,
      moodView: { expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS),
        snapshot: { phase: 'idle', intensity: { ...DEFAULT_MOOD_PARAMETERS.intensity } }, gesture: null },
      moodContact: { contact: false, feeding: false, hover: 0 }, behaviorBlocked: false, bodyCameraEditing: false,
      bodyInputBlocked: false, musicEnabled: false, speaking: false, bodyWaitingForReply: false });
    assert.equal(stage.bodyGates().manualHead, false);
    stage.bodyManualPose = true; assert.equal(stage.bodyGates().manualHead, true);
    stage.bodyManualPose = false; stage.bodyManualGesture = true; assert.equal(stage.bodyGates().manualHead, true);
    stage.moodView.snapshot.intensity.posture = 0; assert.equal(stage.bodyGates().enabled, false);
    stage.moodView.snapshot.intensity.posture = 50; stage.moodView.parameters.intensity.posture = 0;
    assert.equal(stage.bodyGates().enabled, true, 'Host effective snapshot intensity remains authoritative over the template.');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as any).document;
  }
});

test('controller uses the real Layered helper bridge, keeps base phase and releases at the next phase on revoke', async () => {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const bones = ['首', '頭', '左人指１'].map(name => { const bone = new Bone(); bone.name = name; mesh.add(bone); return bone; });
  mesh.bind(new Skeleton(bones)); mesh.morphTargetDictionary = {}; mesh.morphTargetInfluences = [];
  const animation = new LayeredMmdAnimation(mesh);
  animation.setClips({ pose: new AnimationClip('base', 10, [rotation('頭', 0), rotation('左人指１', 0.2)]), gesture: null, expression: null });
  animation.helper.update(0.4);
  const player = new BehaviorBodyPlayer(animation.getBehaviorBodyBindings({ allowBaseProjection: true }));
  const controller = new BodyMotionController(mesh, { player, targetSupported: true, now: () => 1_000,
    getPlan: async () => closed, resolve: async () => resource(), load: async () => source(),
    mutate: <T>(change: () => T): T => { try { return change(); } finally { animation.helper.update(0); } },
  });
  try {
    controller.update(plan(), 'token-1', gates()); await settle(); assert.equal(controller.getState().active, true);
    const phase = animation.getLayerTimes().pose!;
    controller.beforeUpdate(0.1, 1_100, gates()); animation.helper.update(0.1);
    assert.ok(Math.abs(animation.getLayerTimes().pose! - phase - 0.1) < 1e-10);
    assert.ok(bones[1].quaternion.clone().normalize().angleTo(new Quaternion()) > 0.005);
    controller.update(plan(), 'token-1', { ...gates(), directContact: true });
    assert.equal(controller.getState().active, false);
    animation.helper.update(0.1);
    assert.ok(Math.abs(animation.getLayerTimes().pose! - phase - 0.2) < 1e-10);
    assert.ok(bones[1].quaternion.clone().normalize().angleTo(new Quaternion()) < 1e-6);
  } finally { controller.dispose(); animation.dispose(); mesh.skeleton.dispose(); geometry.dispose(); material.dispose(); }
});

// R29c: a revoked playing motion hands the display back through `release` (motion-transition.ts handOffToBase).
test('R29c controller: revoking a playing motion goes through release (stop once, inside it); immediate cancels and dispose never do', async () => {
  const log: string[] = [];
  let playing: BehaviorBodyPlay | null = null;
  const state = (): BehaviorBodyState => ({ active: !!playing, id: playing?.id ?? null, maskId: playing?.maskId ?? null, reason: playing ? 'playing' : 'stopped',
    durationMs: playing?.durationMs ?? 0, elapsedMs: 0, nextTimeMs: 0, weight: playing ? 0.2 : 0,
    trackNames: playing ? ['.bones[首].quaternion', '.bones[頭].quaternion'] : [], blockedBaseProperties: [] });
  const player: BodyPlayerPort = { play(value) { playing = value; return true; }, beforeUpdate: () => state(),
    stop() { if (playing) log.push('player.stop'); playing = null; }, dispose() { playing = null; }, getState: state };
  let current = cue({ id: 'r29c-1' });
  const controller = new BodyMotionController({} as SkinnedMesh, { player, targetSupported: true, now: () => 1_000,
    getPlan: async () => plan(current), resolve: async () => resource(current),
    load: async () => source(),
    mutate: <T>(change: () => T): T => { log.push('mutate'); return change(); },
    release: (tracks, stop) => { log.push(`release:${tracks.join(',')}`); stop(); log.push('released'); },
  });
  try {
    controller.update(plan(current), 'token-1', gates()); await settle();
    assert.equal(controller.getState().active, true);
    log.length = 0;
    controller.update(plan(current), 'token-1', { ...gates(), directContact: true });
    assert.equal(controller.getState().active, false, 'ownership ends at once');
    assert.deepEqual(log, ['release:.bones[首].quaternion,.bones[頭].quaternion', 'mutate', 'player.stop', 'released']);
    for (const ending of ['immediate', 'dispose'] as const) {
      current = cue({ id: `r29c-${ending}` });
      controller.update(plan(current), 'token-1', gates()); await settle();
      assert.equal(controller.getState().active, true, `${ending}: playing again`);
      log.length = 0;
      if (ending === 'immediate') controller.cancel(true); else controller.dispose();
      assert.deepEqual(log, ['mutate', 'player.stop'], `${ending}: a plain stop, no hand-off`);
    }
  } finally { controller.dispose(); }
});
