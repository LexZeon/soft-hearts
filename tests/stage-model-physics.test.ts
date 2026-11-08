import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { AnimationClip, Euler, PerspectiveCamera, Quaternion, QuaternionKeyframeTrack, Scene, Vector3 } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { normalizeModelPhysicsSettings, type ModelPhysicsState } from '../shared/model-physics';
import { MmdStage } from '../src/stage/MmdStage';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { captureMotionPose, MotionTransition } from '../src/stage/motion-transition';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { MusicDance } from '../src/stage/music-dance';
import { clamp } from '../src/stage/procedural';
import { LocalModelPhysics, probeModelPhysicsSupport } from '../src/stage/model-physics';
import type { AmmoModule } from '../src/stage/ammo-runtime';
import { physicsMesh } from './physics-fixture';

const ON = normalizeModelPhysicsSettings({ hair: { enabled: true } });
const OFF = normalizeModelPhysicsSettings(undefined);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// tick is a class-field arrow, not a prototype method. Execute its actual source
// initializer with the fixture as lexical this; copying its composition order
// into a test loop would fail to verify production ordering and cancellation.
const stageSource = ts.createSourceFile('MmdStage.ts', readFileSync(new URL('../src/stage/MmdStage.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const stageClass = stageSource.statements.find((statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === 'MmdStage');
const tickProperty = stageClass?.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member) && member.name.getText(stageSource) === 'tick');
const tickInitializer = tickProperty?.initializer;
assert.ok(tickInitializer, 'the production tick initializer must exist');
const tickJavaScript = ts.transpileModule(`const callback = ${tickInitializer.getText(stageSource)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const makeTick = new Function('clamp', `${tickJavaScript}\nreturn callback;`) as (this: object, limiter: typeof clamp) => (time: number) => void;

function browserGlobals() {
  const names = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const raf: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1, desktop: { isBehaviorModelSupported: async () => false } }, document,
    requestAnimationFrame: (callback: FrameRequestCallback) => { raf.push(callback); return raf.length; },
    cancelAnimationFrame() {},
  });
  return { document, raf, restore() {
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    });
  } };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(transparent = true) {
  const mesh = physicsMesh();
  mesh.geometry.userData.MMD.iks = [];
  mesh.geometry.userData.MMD.grants = [];
  const scene = new Scene(); scene.add(mesh);
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000);
  camera.position.set(0, 10, 30); camera.lookAt(0, 4, 0); camera.updateMatrixWorld(true);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.pet.breath = 0; settings.pet.followMouse = false; settings.pet.fps = 30;
  const events: string[] = [], states: ModelPhysicsState[] = [];
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  const container = { clientWidth: 400, clientHeight: 560 };
  const animation = new LayeredMmdAnimation(mesh);
  animation.setClips({ pose: new AnimationClip('original-body', 8, [new QuaternionKeyframeTrack('.bones[頭].quaternion', [0, 8], [0, 0, 0, 1, 0, Math.sin(0.2), 0, Math.cos(0.2)])]), gesture: null, expression: null });
  const mixer = animation.helper.objects.get(mesh)!.mixer! as any;
  const originalAction = mixer._actions[0];
  const originalUpdate = animation.helper.update.bind(animation.helper);
  animation.helper.update = ((delta: number) => { events.push('animation.update'); return originalUpdate(delta); }) as typeof animation.helper.update;
  Object.assign(stage, {
    scene, mesh, camera, settings, options: { transparent, onPhysicsState: (state: ModelPhysicsState) => states.push(state) }, container,
    controls: { interacting: false, setEnabled() {}, update() { events.push('controls.update'); }, dispose() {} },
    renderer: { render() { events.push('render'); }, setSize() {}, domElement: { dataset: {}, removeEventListener() {}, remove() {} },
      renderLists: { dispose() {} }, clear() {}, dispose() {}, forceContextLoss() {} },
    resizeObserver: { disconnect() {} }, grid: null, animation, motionTransition: null,
    head: mesh.skeleton.bones[3], chest: mesh.skeleton.bones[1], center: mesh.skeleton.bones[0], eyes: [], arms: [], height: 20, width: 12, centerX: 0, baseY: 0,
    elapsed: 0, previousFrame: 0, hasRenderedModel: false, frameId: 0, disposed: false, hostVisible: true, previewSuspended: false,
    gazeOrigin: new Vector3(), eyePoint: new Vector3(), facePoint: new Vector3(), pointer: { x: 0, y: 0 }, gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 },
    nextBlink: Infinity, blinkStart: -10, naturalBlink: 0, speaking: false, mouth: 0,
    blinkIndex: -1, mouthIndex: -1, smileIndex: -1, sadIndex: -1, blushChannel: null,
    boneLayers: [], morphLayers: [], rotation: new Euler(), offset: new Quaternion(),
    restPose: mesh.skeleton.bones.map(bone => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone() })),
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodView: null, moodFaceBlocked: false, moodHeadBlocked: false, moodMouthBlocked: false,
    musicDance: new MusicDance(), musicEnabled: false, proceduralBlush: null, blushPreviewUntil: 0, blushPreviewing: false,
    behaviorMotion: null, behaviorBlocked: false, chatGesturePlayer: null, chatGestureGeneration: 0, chatGestureBlocked: false,
    chatGestureResource: null, chatGestureError: '', chatGestureIds: new Set(), chatGestureClips: new Map(), defaultPoseChecks: new Map(),
    motionClips: new Map(), modelGeneration: 0, motionGeneration: 0, settingsGeneration: 0, modelUrl: '', motionUrl: '', lastFaceAnchor: -Infinity,
    physicsSettings: normalizeModelPhysicsSettings(undefined), physicsSupport: probeModelPhysicsSupport(mesh), localPhysics: null,
    physicsGeneration: 0, physicsPending: null, physicsError: '', physicsSignature: '', lastPhysicsRelease: null,
  });
  stage.tick = makeTick.call(stage, clamp);
  let loads = 0, destroyed = 0;
  const ammo: AmmoModule = { destroy() { destroyed++; } };
  stage.loadPhysicsRuntime = () => { loads++; return Promise.resolve(ammo); };
  return { stage, mesh, events, states, container, mixer, originalAction, animation, ammo,
    get loads() { return loads; }, get destroyed() { return destroyed; },
    dispose() { stage.clearModel(); },
  };
}

function attachPhysicsSpy(h: ReturnType<typeof fixture>) {
  const frames: number[] = [];
  let elapsed = 0, calls = 0, disposed = false, visible = true;
  const state: ModelPhysicsState = { support: probeModelPhysicsSupport(h.mesh), enabled: { hair: true, chest: false },
    running: true, quality: 'standard', status: 'running', bodyCount: 0, constraintCount: 0, steps: 0, liveObjects: 0, avgStepMs: 0 };
  h.stage.localPhysics = {
    restore() { h.events.push('physics.restore'); },
    frame(delta: number) { h.events.push(delta === 0 ? 'physics.frame0' : 'physics.frame'); frames.push(delta); if (delta > 0) { elapsed += delta; calls++; } },
    setVisible(next: boolean) { visible = next; h.events.push(`physics.visible:${next}`); },
    configure() { h.events.push('physics.configure'); },
    dispose() { h.events.push('physics.dispose'); disposed = true; },
    getState() { return { ...state, status: disposed ? 'disposed' : visible ? 'running' : 'hidden', running: !disposed && visible }; },
    getDiagnostics() { return null; },
  };
  return { frames, get elapsed() { return elapsed; }, get calls() { return calls; }, get disposed() { return disposed; } };
}

function attachTransition(h: ReturnType<typeof fixture>) {
  const transition = new MotionTransition(h.mesh);
  transition.start(captureMotionPose(h.mesh), ['.bones[頭].quaternion']);
  const restore = transition.restore.bind(transition), frame = transition.frame.bind(transition);
  transition.restore = () => { h.events.push('transition.restore'); restore(); };
  transition.frame = delta => { h.events.push(delta === 0 ? 'transition.frame0' : 'transition.frame'); frame(delta); };
  h.stage.motionTransition = transition;
  return transition;
}

test('default off, control preview, zero strength and unavailable parts never request Ammo', async () => {
  const globals = browserGlobals();
  const h = fixture(), preview = fixture(false);
  try {
    await h.stage.ensureLocalPhysics();
    assert.equal(h.loads, 0);
    h.stage.setPhysicsSettings(normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 0 } }));
    preview.stage.setPhysicsSettings(ON);
    await flush();
    assert.equal(h.loads, 0);
    assert.equal(preview.loads, 0);
    h.stage.physicsSupport = { ...h.stage.physicsSupport, chest: { supported: false, bones: 0, bodies: 0, reason: 'fixture has no secondary chest rig' } };
    h.stage.setPhysicsSettings(normalizeModelPhysicsSettings({ chest: { enabled: true } }));
    assert.equal(h.loads, 0);
    assert.equal(h.stage.getPhysicsState().enabled.chest, true);
    assert.equal(h.stage.getPhysicsState().status, 'unsupported');
    const snapshot = h.stage.getPhysicsState(); snapshot.support.hair.supported = false;
    assert.equal(h.stage.getPhysicsState().support.hair.supported, true, 'readback cannot mutate the host support probe');
  } finally { h.dispose(); preview.dispose(); globals.restore(); }
});

test('actual model load probes support independently of persisted switches and attaches lazily without a world', async () => {
  const globals = browserGlobals(), h = fixture();
  const originalLoad = MMDLoader.prototype.load;
  const incoming = physicsMesh();
  incoming.skeleton.bones[6].name = 'upperChest';
  const url = 'app-asset://physics-test/model.pmx';
  MMDLoader.prototype.load = ((_url: string, done: (mesh: typeof incoming) => void) => { queueMicrotask(() => done(incoming)); }) as typeof originalLoad;
  h.stage.rebuildBlush = () => undefined;
  try {
    const legacySettings = JSON.stringify(h.stage.settings);
    h.stage.modelUrl = url;
    await h.stage.loadModel(url);
    assert.equal(h.stage.mesh, incoming);
    assert.equal(h.stage.getPhysicsState().support.hair.supported, true);
    assert.equal(h.stage.getPhysicsState().support.chest.supported, false);
    assert.deepEqual(h.stage.getPhysicsState().enabled, { hair: false, chest: false });
    assert.equal(h.loads, 0);
    h.stage.setPhysicsSettings(normalizeModelPhysicsSettings({ chest: { enabled: true } }));
    assert.equal(h.loads, 0);
    h.stage.setPhysicsSettings(normalizeModelPhysicsSettings({ hair: { enabled: true }, chest: { enabled: true } }));
    await h.stage.physicsPending;
    assert.equal(h.loads, 1);
    assert.ok(h.stage.localPhysics instanceof LocalModelPhysics);
    assert.equal(h.stage.localPhysics.getState().liveObjects, 0, 'attachment is not a native world allocation');
    assert.equal(h.destroyed, 0);
    assert.equal(JSON.stringify(h.stage.settings), legacySettings);
    assert.ok(h.states.some(state => state.support.hair.supported && !state.support.chest.supported));
  } finally { MMDLoader.prototype.load = originalLoad; h.dispose(); globals.restore(); }
});

for (const cancellation of ['disable', 'hide', 'replace-model', 'dispose'] as const) {
  test(`delayed runtime completion cannot attach after ${cancellation}`, async () => {
    const globals = browserGlobals(), h = fixture(), pending = deferred<AmmoModule>();
    h.stage.loadPhysicsRuntime = () => pending.promise;
    try {
      h.stage.setPhysicsSettings(ON);
      const attempt = h.stage.physicsPending;
      assert.ok(attempt);
      if (cancellation === 'disable') h.stage.setPhysicsSettings(OFF);
      if (cancellation === 'hide') h.stage.setVisible(false);
      if (cancellation === 'replace-model') h.stage.clearModel();
      if (cancellation === 'dispose') h.stage.dispose();
      pending.resolve(h.ammo);
      await attempt;
      assert.equal(h.stage.localPhysics, null);
      assert.equal(h.stage.physicsError, '');
      assert.equal(h.destroyed, 0);
    } finally { h.dispose(); globals.restore(); }
  });
}

test('stale completion does not clear or replace a newer pending runtime attempt', async () => {
  const globals = browserGlobals(), h = fixture(), first = deferred<AmmoModule>(), second = deferred<AmmoModule>();
  const attempts = [first, second];
  h.stage.loadPhysicsRuntime = () => attempts.shift()!.promise;
  try {
    h.stage.setPhysicsSettings(ON); const oldPending = h.stage.physicsPending;
    h.stage.setPhysicsSettings(OFF);
    h.stage.setPhysicsSettings(ON); const currentPending = h.stage.physicsPending;
    first.resolve(h.ammo); await oldPending;
    assert.equal(h.stage.localPhysics, null);
    assert.equal(h.stage.physicsPending, currentPending);
    second.resolve(h.ammo); await currentPending;
    assert.ok(h.stage.localPhysics instanceof LocalModelPhysics);
    assert.equal(h.stage.localPhysics.getState().liveObjects, 0);
  } finally { h.dispose(); globals.restore(); }
});

test('a cancelled loader rejection cannot poison a later visible generation', async () => {
  const globals = browserGlobals(), h = fixture(), pending = deferred<AmmoModule>();
  h.stage.loadPhysicsRuntime = () => pending.promise;
  try {
    h.stage.setPhysicsSettings(ON); const attempt = h.stage.physicsPending;
    h.stage.setVisible(false);
    pending.reject(new Error('late runtime failure')); await attempt;
    assert.equal(h.stage.physicsError, '');
    assert.equal(h.stage.getPhysicsState().status, 'hidden');
    h.stage.loadPhysicsRuntime = () => Promise.resolve(h.ammo);
    h.stage.setVisible(true); await h.stage.physicsPending;
    assert.ok(h.stage.localPhysics instanceof LocalModelPhysics);
  } finally { h.dispose(); globals.restore(); }
});

test('the actual tick restores physics before the bridge and solves after the final bridge without replacing the Action', () => {
  const globals = browserGlobals(), h = fixture(), physics = attachPhysicsSpy(h), transition = attachTransition(h);
  try {
    for (let i = 0; i < 5; i++) {
      h.events.length = 0;
      h.stage.tick(1000 + i * 1000 / 30);
      const index = (name: string) => { const value = h.events.indexOf(name); assert.ok(value >= 0, name); return value; };
      assert.ok(index('physics.restore') < index('transition.restore'));
      assert.ok(index('transition.restore') < index('animation.update'));
      assert.ok(index('transition.frame') < index('physics.frame'));
      assert.ok(index('physics.frame') < index('render'));
    }
    assert.equal(physics.calls, 5);
    assert.ok(Math.abs(physics.elapsed - 5 / 30) < 1e-8);
    assert.equal(h.mixer._actions[0], h.originalAction);
    assert.ok(Math.abs(h.originalAction.time - 5 / 30) < 1e-8);
    assert.ok(transition.getState().elapsedMs > 0);
    assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.modelPhysics).previewOnly, false);
  } finally { h.dispose(); globals.restore(); }
});

test('between-tick chat cancellation reattaches physics while music-off preserves the display without advancing clocks', () => {
  const globals = browserGlobals(), h = fixture(), physics = attachPhysicsSpy(h), transition = attachTransition(h);
  try {
    h.stage.tick(1000); h.stage.tick(1000 + 1000 / 30);
    const elapsed = physics.elapsed, calls = physics.calls, actionTime = h.originalAction.time, bridgeTime = transition.getState().elapsedMs;
    for (const [name, cancel] of [
      ['chat cancellation', () => h.stage.cancelChatGesture(true)],
      ['music-off', () => { h.stage.setMusicEnabled(true); h.stage.setMusicEnabled(false); }],
    ] as const) {
      h.events.length = 0;
      const frames = physics.frames.length;
      cancel();
      if (name === 'music-off') {
        assert.equal(h.events.length, 0, 'music-off retains the current display until the normal next tick fades its offset');
        assert.equal(physics.frames.length, frames);
      } else {
        assert.ok(h.events.indexOf('physics.restore') >= 0);
        assert.ok(h.events.indexOf('physics.restore') < h.events.indexOf('physics.frame0'));
        assert.ok(physics.frames.length > frames && physics.frames.slice(frames).every(delta => delta === 0));
      }
      assert.equal(physics.elapsed, elapsed);
      assert.equal(physics.calls, calls);
      assert.equal(h.originalAction.time, actionTime);
      assert.equal(transition.getState().elapsedMs, bridgeTime);
      assert.equal(h.mixer._actions[0], h.originalAction);
    }
  } finally { h.dispose(); globals.restore(); }
});

test('a visible frame stall reaches physics without advancing the original animation by the full gap', () => {
  const globals = browserGlobals(), h = fixture(), physics = attachPhysicsSpy(h);
  try {
    h.stage.tick(1000);
    const actionBefore = h.originalAction.time;
    h.stage.tick(1600);
    assert.ok(Math.abs(physics.frames.at(-1)! - 0.6) < 1e-8, 'physics observes the actual gap for discontinuity recovery');
    assert.ok(Math.abs(h.originalAction.time - actionBefore - 0.1) < 1e-8, 'authored animation retains its existing frame cap');
    h.stage.tick(1600 + 1000 / 30);
    assert.ok(Math.abs(physics.frames.at(-1)! - 1 / 30) < 1e-8, 'the following tick has no catch-up backlog');
    assert.equal(h.mixer._actions[0], h.originalAction);
  } finally { h.dispose(); globals.restore(); }
});

test('model teardown disposes the outer physics owner before inner presentation, animation and mesh resources', () => {
  const globals = browserGlobals(), h = fixture(), physics = attachPhysicsSpy(h);
  try {
    h.stage.behaviorMotion = { dispose() { h.events.push('behavior.dispose'); }, restore() {}, stop() {} };
    h.stage.chatGesturePlayer = { getState: () => ({ active: false }), cancel() { h.events.push('chat.cancel'); }, dispose() { h.events.push('chat.dispose'); } };
    const disposeAnimation = h.animation.dispose.bind(h.animation);
    h.animation.dispose = () => { h.events.push('animation.dispose'); disposeAnimation(); };
    h.mesh.geometry.addEventListener('dispose', () => h.events.push('geometry.dispose'));
    h.events.length = 0;
    h.stage.clearModel();
    assert.equal(physics.disposed, true);
    for (const event of ['behavior.dispose', 'chat.cancel', 'chat.dispose', 'animation.dispose', 'geometry.dispose']) {
      assert.ok(h.events.indexOf('physics.dispose') < h.events.indexOf(event), event);
    }
    assert.equal(h.stage.localPhysics, null);
    assert.equal(h.stage.physicsSupport, null);
    assert.equal(h.stage.mesh, null);
    const diagnostics = JSON.parse(h.stage.renderer.domElement.dataset.modelPhysics);
    assert.equal(diagnostics.lastPhysicsRelease.status, 'disposed');
    assert.equal(diagnostics.lastPhysicsRelease.running, false);
    assert.equal(diagnostics.lastPhysicsRelease.liveObjects, 0);
    assert.equal(diagnostics.parts, null);
    const released = structuredClone(diagnostics.lastPhysicsRelease);
    h.stage.clearModel();
    assert.deepEqual(JSON.parse(h.stage.renderer.domElement.dataset.modelPhysics).lastPhysicsRelease, released,
      'clearing an already-empty model retains only the previous bounded release snapshot');
  } finally { h.dispose(); globals.restore(); }
});

test('hide publishes post-release diagnostics immediately while animation frames are stopped', () => {
  const globals = browserGlobals(), h = fixture();
  attachPhysicsSpy(h);
  try {
    h.stage.tick(1000);
    assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.modelPhysics).status, 'running');
    h.stage.setVisible(false);
    assert.equal(h.stage.frameId, 0);
    const hidden = JSON.parse(h.stage.renderer.domElement.dataset.modelPhysics);
    assert.equal(hidden.status, 'hidden');
    assert.equal(hidden.running, false);
    assert.equal(hidden.liveObjects, 0);
    assert.equal(hidden.lastPhysicsRelease, null);
    assert.equal(h.stage.previousFrame, 0);
  } finally { h.dispose(); globals.restore(); }
});

test('zero-size frames suspend physics and resume with the normal frame delta instead of hidden elapsed time', () => {
  const globals = browserGlobals(), h = fixture(), physics = attachPhysicsSpy(h);
  try {
    h.stage.tick(1000);
    const calls = physics.calls, actionTime = h.originalAction.time;
    h.container.clientWidth = 0;
    h.stage.tick(60_000);
    assert.equal(physics.calls, calls);
    assert.equal(h.originalAction.time, actionTime);
    assert.equal(h.stage.previousFrame, 0);
    assert.ok(h.events.includes('physics.visible:false'));
    assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.modelPhysics).status, 'hidden');
    h.container.clientWidth = 400;
    h.stage.tick(120_000);
    assert.equal(physics.calls, calls + 1);
    assert.ok(Math.abs(physics.frames.at(-1)! - 1 / 30) < 1e-8);
    assert.ok(Math.abs(h.originalAction.time - actionTime - 1 / 30) < 1e-8);
    assert.equal(h.mixer._actions[0], h.originalAction);
  } finally { h.dispose(); globals.restore(); }
});
