import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bone, Euler, PerspectiveCamera, Quaternion, Scene, ShaderMaterial, Skeleton, SkinnedMesh, Texture, UniformsUtils } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import { MmdStage } from '../src/stage/MmdStage';
import { CryingTimeline } from '../src/stage/crying-timeline';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { type BlushAnchors } from '../src/stage/procedural-blush';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/blush';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';

const START = 7 * 24 * 60 * 60 * 1_000;

function installGlobal(t: TestContext, key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

function clock(t: TestContext) {
  let now = START;
  t.mock.method(Date, 'now', () => now);
  return { at(elapsedMs: number) { now = START + elapsedMs; return now; } };
}

function candidate() {
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  const initial = createMoodState(START, parameters);
  initial.lastInteractionAt = START - parameters.longing.graceMs - 86 / parameters.longing.perHour * 3_600_000;
  const state = applyMoodEvent(initial, { type: 'chat', id: 'accepted-reunion', context: 'neutral' }, START, parameters);
  assert.equal(getMoodSnapshot(state, START, parameters).cryingCandidate, true);
  return { state, parameters };
}

const anchors: BlushAnchors = {
  leftEye: [-0.5, 1, 1], rightEye: [0.5, 1, 1], mouth: [0, 0.1, 1],
  leftCheek: [-0.5, 0.5, 1], rightCheek: [0.5, 0.5, 1],
  leftNormal: [0, 0, 1], rightNormal: [0, 0, 1], forward: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0],
  eyeDistance: 1, boneEyeDistance: 1, eyeReference: 'main-eye-geometry', mouthEstimated: true,
  surfaceSource: 'named-face', materialIndices: [0],
};

class SurfaceSpy {
  amount = 0;
  elapsedMs = 0;
  disposed = 0;
  supported = true;
  updates: [number, number][] = [];
  update(amount: number, elapsedMs: number) { this.amount = amount; this.elapsedMs = elapsedMs; this.updates.push([amount, elapsedMs]); }
  dispose() { this.disposed++; this.supported = false; this.amount = 0; }
  getState() { return { supported: this.supported, reason: 'fixture surface', amount: this.amount, elapsedMs: this.elapsedMs }; }
}

function harness() {
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  const head = new Bone(); head.name = '頭';
  const material = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) });
  material.name = '顔';
  const mesh = new SkinnedMesh(undefined, material);
  mesh.add(head); mesh.bind(new Skeleton([head])); mesh.morphTargetInfluences = [0.2, 0.1, 0.05];
  const surface = new SurfaceSpy();
  Object.assign(stage, {
    mesh, head, eyes: [], camera: new PerspectiveCamera(), scene: new Scene(),
    controls: { interacting: false, enabled: false, setEnabled(value: boolean) { this.enabled = value; } },
    options: { transparent: true }, hostVisible: true, disposed: false,
    renderer: { domElement: { dataset: {} } }, container: { clientWidth: 400, clientHeight: 560 },
    moodView: null, moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT },
    moodFaceBlocked: false, moodHeadBlocked: false, moodMouthBlocked: false, behaviorBlocked: false,
    cryingTimeline: new CryingTimeline(), cryingFrame: null, proceduralTears: surface,
    tearsVerifiedGene: true, tearsAnchorsProbed: true, tearsAnchors: structuredClone(anchors), tearsReason: 'fixture surface',
    proceduralBlush: null, blushSupport: 'fixture blush', blushCalibration: { ...DEFAULT_BLUSH_CALIBRATION }, blushCalibrationModelUrl: '',
    boneLayers: [], morphLayers: [], restPose: [], rotation: new Euler(), offset: new Quaternion(),
    chatGestureGeneration: 0, chatGestureClips: new Map(), defaultPoseChecks: new Map(), motionClips: new Map(),
    gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 }, blinkIndex: 0, smileIndex: 1, mouthIndex: 2,
    physicsGeneration: 0, frameId: 0,
  });
  stage.scene.add(mesh);
  return { stage, surface };
}

function view(host: ReturnType<typeof candidate>, now = START, token = 'host-scope') {
  return { characterId: 'gene-card', token, revision: 1, expressions: true, developerMode: false,
    parameters: host.parameters, snapshot: getMoodSnapshot(host.state, now, host.parameters) };
}

function diagnostics(stage: any) { return JSON.parse(stage.renderer.domElement.dataset.crying); }

test('one accepted host candidate runs one eight-second presentation without writing state or invoking desktop services', t => {
  const time = clock(t), host = candidate(), { stage, surface } = harness();
  let desktopCalls = 0;
  installGlobal(t, 'window', { desktop: new Proxy({}, { get() { desktopCalls++; throw new Error('presentation must not invoke host services'); } }) });
  const raw = JSON.stringify(host.state), parameters = JSON.stringify(host.parameters);
  stage.setMood(view(host));
  assert.equal(diagnostics(stage).id, 'accepted-reunion');
  for (const elapsed of [100, 650, 1_000, 3_000, 6_200, 7_000, 7_900]) {
    time.at(elapsed);
    stage.setMood(view(host, Date.now()));
    stage.updateTears(0);
    const frame = diagnostics(stage);
    assert.equal(frame.id, 'accepted-reunion');
    assert.equal(frame.elapsedMs, elapsed, 'mirror snapshots must not restart or extend the accepted event');
    assert.ok(frame.amount > 0 && frame.amount <= 1);
  }
  assert.equal(diagnostics(stage).phase, 'fade');
  time.at(8_000); stage.setMood(view(host, Date.now())); stage.updateTears(0);
  assert.equal(diagnostics(stage).phase, 'idle'); assert.equal(surface.amount, 0);
  for (let frame = 0; frame < 120; frame++) stage.updateTears(1 / 30);
  assert.equal(diagnostics(stage).phase, 'idle', 'delta alone cannot replay the completed identity');
  assert.equal(JSON.stringify(host.state), raw); assert.equal(JSON.stringify(host.parameters), parameters);
  assert.equal(host.state.recentEventIds.length, 1); assert.equal(desktopCalls, 0);
});

test('continuing accepted rua comforts the existing cry and fades visibly without making another reward', t => {
  const time = clock(t), host = candidate(), { stage, surface } = harness();
  stage.setMood(view(host));
  time.at(500); stage.updateTears(0);
  const rising = surface.amount; assert.ok(rising > 0);
  stage.setMoodContact({ ...EMPTY_CONTACT, contact: true, x: 0.1 });
  assert.equal(host.state.recentEventIds.length, 1, 'local contact alone is not a host reward');
  host.state = applyMoodEvent(host.state, { type: 'rua', id: 'accepted-comfort', effectiveMs: 500 }, Date.now(), host.parameters);
  const afterAcceptance = JSON.stringify(host.state);
  stage.setMood(view(host, Date.now()));
  time.at(800); stage.setMood(view(host, Date.now()));
  const peak = diagnostics(stage);
  assert.equal(peak.id, 'accepted-reunion'); assert.equal(peak.comforted, true); assert.ok(peak.amount > 0);
  time.at(1_400); stage.setMood(view(host, Date.now()));
  const settling = diagnostics(stage);
  assert.equal(settling.phase, 'fade'); assert.ok(settling.amount > 0 && settling.amount < peak.amount);
  time.at(2_000); stage.setMood(view(host, Date.now()));
  assert.equal(surface.amount, 0); assert.equal(diagnostics(stage).phase, 'idle');
  assert.equal(JSON.stringify(host.state), afterAcceptance); assert.equal(host.state.recentEventIds.length, 2);
  time.at(3_000); stage.setMood(view(host, Date.now()));
  assert.equal(diagnostics(stage).phase, 'idle', 'the still-live host candidate does not restart after comfort');
});

test('disabled, zero-strength, manual-face, hidden, zero-size and camera-drag candidates are consumed before later eligibility', t => {
  clock(t);
  const gates = [
    { name: 'expressions', block(stage: any, value: any) { value.expressions = false; }, unblock(stage: any, value: any) { value.expressions = true; } },
    { name: 'zero strength', block(stage: any, value: any) { value.snapshot.intensity.expression = 0; }, unblock(stage: any, value: any) { value.snapshot.intensity.expression = 50; } },
    { name: 'manual face', block(stage: any) { stage.moodFaceBlocked = true; }, unblock(stage: any) { stage.moodFaceBlocked = false; } },
    { name: 'hidden', block(stage: any) { stage.hostVisible = false; }, unblock(stage: any) { stage.hostVisible = true; } },
    { name: 'zero size', block(stage: any) { stage.container.clientWidth = 0; }, unblock(stage: any) { stage.container.clientWidth = 400; } },
    { name: 'camera drag', block(stage: any) { stage.controls.interacting = true; }, unblock(stage: any) { stage.controls.interacting = false; } },
  ];
  for (const gate of gates) {
    const host = candidate(), { stage, surface } = harness(), current = view(host);
    gate.block(stage, current); stage.setMood(current);
    assert.equal(diagnostics(stage).phase, 'idle', gate.name);
    gate.unblock(stage, current); stage.setMood({ ...current }); stage.updateTears(0.65);
    assert.equal(surface.amount, 0, `${gate.name}: an initially suppressed cue cannot start later`);
    assert.equal(diagnostics(stage).phase, 'idle', gate.name);
  }
});

test('setMood disables or changes context immediately and never resumes an old candidate under a new token', t => {
  const time = clock(t), host = candidate(), { stage, surface } = harness();
  stage.setMood(view(host)); time.at(650); stage.updateTears(0);
  assert.equal(surface.amount, 1);
  stage.setMood({ ...view(host, Date.now()), expressions: false });
  assert.equal(surface.amount, 0);
  stage.setMood(view(host, Date.now())); stage.updateTears(0.1);
  assert.equal(diagnostics(stage).phase, 'idle');
  stage.setMood(view(host, Date.now(), 'new-provider-context')); stage.updateTears(0.1);
  assert.equal(diagnostics(stage).phase, 'idle', 'a token change must not rebrand an old reunion');
  stage.setMood({ ...view(host, Date.now(), 'third-context'), characterId: 'other-card' });
  assert.equal(surface.amount, 0);
  const next = view(host, time.at(1_000), 'third-context');
  next.characterId = 'other-card';
  next.snapshot.reunion = { ...next.snapshot.reunion!, id: 'new-accepted-reunion', at: Date.now() };
  next.snapshot.lastInteractionAt = Date.now();
  stage.setMood(next); time.at(1_650); stage.updateTears(0);
  assert.equal(diagnostics(stage).id, 'new-accepted-reunion'); assert.equal(surface.amount, 1);
});

test('manual-face takeover, explicit cancellation, window adjustment and camera edit cancel immediately without a delayed replay', t => {
  const time = clock(t);
  installGlobal(t, 'document', { hidden: false });
  const cancellations = [
    { name: 'manual face', cancel(stage: any) { stage.moodFaceBlocked = true; stage.updateTears(0); }, release(stage: any) { stage.moodFaceBlocked = false; } },
    { name: 'explicit cancel', cancel(stage: any) { stage.stopTears(false); }, release() {} },
    { name: 'window adjust', cancel(stage: any) { stage.setBehaviorBlocked(true); }, release(stage: any) { stage.setBehaviorBlocked(false); } },
    { name: 'camera edit', cancel(stage: any) { stage.setCameraEditMode(true); }, release(stage: any) { stage.setCameraEditMode(false); } },
  ];
  for (const entry of cancellations) {
    time.at(0); const host = candidate(), { stage, surface } = harness();
    stage.setMood(view(host)); time.at(650); stage.updateTears(0); assert.ok(surface.amount > 0, entry.name);
    entry.cancel(stage); assert.equal(surface.amount, 0, `${entry.name} clears the visible surface synchronously`);
    entry.release(stage); stage.setMood(view(host, Date.now())); stage.updateTears(0.1);
    assert.equal(diagnostics(stage).phase, 'idle', `${entry.name} cannot replay the old identity`);
  }
});

test('native hide releases owned effects; show rebuilds a surface without resuming the previous cry', t => {
  const time = clock(t), host = candidate(), { stage, surface } = harness();
  installGlobal(t, 'document', { hidden: false });
  let requested = 0, cancelled = 0;
  installGlobal(t, 'requestAnimationFrame', () => ++requested);
  installGlobal(t, 'cancelAnimationFrame', () => { cancelled++; });
  stage.setMood(view(host)); time.at(650); stage.updateTears(0); assert.ok(surface.amount > 0);
  stage.setVisible(false);
  assert.equal(surface.disposed, 1); assert.equal(stage.proceduralTears, null);
  assert.equal(diagnostics(stage).amount, 0); assert.equal(stage.controls.enabled, false); assert.equal(cancelled, 1);
  stage.setVisible(true);
  assert.ok(stage.proceduralTears?.getState().supported); assert.equal(requested, 1);
  stage.setMood(view(host, Date.now())); stage.updateTears(0.1);
  assert.equal(diagnostics(stage).phase, 'idle'); assert.equal(stage.proceduralTears.getState().amount, 0);
  stage.stopTears(true);
});

test('zero-size resize releases tears and a visible resize rebuilds resources without replaying the cry or advancing the pose', t => {
  const time = clock(t), host = candidate(), { stage, surface } = harness();
  installGlobal(t, 'document', { hidden: false });
  const sizes: number[][] = [], renders: [Scene, PerspectiveCamera][] = [];
  let projections = 0, physicsChecks = 0, diagnosticsUpdates = 0;
  const projection = stage.camera.updateProjectionMatrix.bind(stage.camera);
  t.mock.method(stage.camera, 'updateProjectionMatrix', () => { projections++; projection(); });
  stage.renderer.setSize = (width: number, height: number, css: boolean) => {
    assert.equal(css, false); sizes.push([width, height]);
  };
  stage.renderer.render = (scene: Scene, camera: PerspectiveCamera) => { renders.push([scene, camera]); };
  stage.ensureLocalPhysics = () => { physicsChecks++; return Promise.resolve(); };
  stage.renderPhysicsDiagnostics = () => { diagnosticsUpdates++; };
  stage.animation = { helper: { update() { assert.fail('resize must not advance the authored animation'); } } };
  stage.head.position.set(0.2, 1.4, -0.1); stage.head.rotation.set(0.1, 0.2, -0.03);
  stage.camera.position.set(2, 3, 30);
  const originalMaterial = stage.mesh.material;
  const pose = { head: stage.head.quaternion.toArray(), position: stage.head.position.toArray(),
    morphs: [...stage.mesh.morphTargetInfluences], camera: stage.camera.position.toArray(), fov: stage.camera.fov };
  const raw = JSON.stringify(host.state);
  stage.setMood(view(host)); time.at(650); stage.updateTears(0); assert.equal(surface.amount, 1);
  Object.assign(stage.container, { clientWidth: 0, clientHeight: 0 });
  stage.resize();
  assert.equal(surface.disposed, 1); assert.equal(stage.proceduralTears, null);
  assert.equal(diagnostics(stage).phase, 'idle'); assert.equal(diagnostics(stage).amount, 0);
  time.at(900); Object.assign(stage.container, { clientWidth: 400, clientHeight: 560 });
  stage.resize();
  const rebuilt = stage.proceduralTears;
  assert.equal(rebuilt.getState().supported, true); assert.equal(rebuilt.getState().attached, true);
  stage.setMood(view(host, Date.now())); stage.updateTears(0.1);
  assert.equal(diagnostics(stage).phase, 'idle'); assert.equal(rebuilt.getState().amount, 0, 'size recovery cannot restart the consumed event');
  Object.assign(stage.container, { clientWidth: 700, clientHeight: 300 }); stage.resize();
  assert.equal(stage.proceduralTears, rebuilt, 'ordinary visible resize reuses the current material owner');
  assert.deepEqual(sizes, [[1, 1], [400, 560], [700, 300]]);
  assert.equal(projections, 3); assert.equal(physicsChecks, 3); assert.equal(diagnosticsUpdates, 3);
  assert.equal(renders.length, 3); for (const [scene, camera] of renders) { assert.equal(scene, stage.scene); assert.equal(camera, stage.camera); }
  assert.deepEqual(stage.head.quaternion.toArray(), pose.head); assert.deepEqual(stage.head.position.toArray(), pose.position);
  assert.deepEqual(stage.mesh.morphTargetInfluences, pose.morphs); assert.deepEqual(stage.camera.position.toArray(), pose.camera); assert.equal(stage.camera.fov, pose.fov);
  assert.equal(JSON.stringify(host.state), raw);
  stage.stopTears(true); assert.equal(stage.mesh.material, originalMaterial);
});

test('unverified targets give an explicit fallback and becoming supported cannot resurrect their consumed candidate', t => {
  const time = clock(t), host = candidate(), { stage } = harness();
  stage.proceduralTears = null; stage.tearsVerifiedGene = false;
  stage.rebuildTears();
  assert.equal(stage.proceduralTears, null); assert.match(stage.getMoodDegradation(), /泪水.*主进程.*Gene/);
  stage.setMood(view(host)); time.at(650); stage.updateTears(0);
  assert.equal(diagnostics(stage).phase, 'idle');
  stage.tearsVerifiedGene = true; stage.rebuildTears();
  assert.ok(stage.proceduralTears.getState().supported);
  stage.setMood(view(host, Date.now())); stage.updateTears(0.1);
  assert.equal(stage.proceduralTears.getState().amount, 0);
  stage.stopTears(true);
});

test('a failed surface is disposed, reports its fallback and never causes the same candidate to retry', t => {
  const time = clock(t), host = candidate(), { stage, surface } = harness();
  stage.setMood(view(host)); time.at(650); stage.updateTears(0); assert.equal(surface.amount, 1);
  surface.supported = false; stage.updateTears(0);
  assert.equal(surface.disposed, 1); assert.equal(stage.proceduralTears, null);
  assert.match(stage.getMoodDegradation(), /fixture surface/); assert.equal(diagnostics(stage).phase, 'idle');
  stage.rebuildTears(); stage.setMood(view(host, Date.now())); stage.updateTears(0.1);
  assert.equal(diagnostics(stage).phase, 'idle'); assert.equal(stage.proceduralTears.getState().amount, 0);
  stage.stopTears(true);
});

test('real Gene calibration rebuilds unwind tears before blush, preserve live pose and tear position, then teardown releases the rebuilt chain', async t => {
  const time = clock(t), host = candidate();
  const manifest = JSON.parse(await readFile('shared/bundled-assets.json', 'utf8'));
  const bytes = await readFile(join('assets/bundled', manifest.root, manifest.model.relativePath));
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder._loadTexture = () => { const texture = new Texture() as any; texture.readyCallbacks = []; return texture; };
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh;
  const originals = mesh.material as ShaderMaterial[], originalHook = mesh.onBeforeRender;
  const { stage } = harness();
  stage.proceduralTears = null; stage.mesh = mesh; stage.head = mesh.skeleton.bones.find(bone => bone.name === '頭');
  stage.eyes = ['左目', '右目'].map(name => mesh.skeleton.bones.find(bone => bone.name === name));
  stage.tearsAnchors = null; stage.tearsAnchorsProbed = false;
  stage.restPose = mesh.skeleton.bones.map(bone => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
  stage.scene.add(mesh);
  installGlobal(t, 'HTMLCanvasElement', class {});
  try {
    stage.rebuildBlush();
    const firstTears = stage.proceduralTears, firstBlush = stage.proceduralBlush;
    assert.equal(firstTears.getState().supported, true); assert.equal(firstBlush.getState().supported, true);
    const faceIndex = firstTears.getState().materialIndices[0], firstOuter = (mesh.material as ShaderMaterial[])[faceIndex];
    const firstInner = firstBlush.attachments[0].clone as ShaderMaterial;
    const disposed: string[] = [];
    firstOuter.addEventListener('dispose', () => disposed.push('tears'));
    firstInner.addEventListener('dispose', () => disposed.push('blush'));
    const frozenTearAnchors = structuredClone(stage.tearsAnchors);
    stage.setMood(view(host)); time.at(650); stage.updateTears(0);
    const amount = firstTears.getState().amount; assert.equal(amount, 1);
    stage.head.rotation.set(0.1, -0.3, 0.04);
    mesh.morphTargetInfluences![0] = 0.27;
    const liveHead = stage.head.quaternion.toArray(), liveMorphs = [...mesh.morphTargetInfluences!];
    stage.rebuildBlush({ ...DEFAULT_BLUSH_CALIBRATION, eyeOffsetX: 0.1, eyeOffsetY: 0.03 });
    assert.deepEqual(disposed, ['tears', 'blush'], 'outer material/callback owner is removed before its source');
    assert.equal(firstTears.getState().supported, false); assert.equal(firstBlush.getState().supported, false);
    assert.deepEqual(stage.head.quaternion.toArray(), liveHead); assert.deepEqual(mesh.morphTargetInfluences, liveMorphs);
    assert.deepEqual(stage.tearsAnchors, frozenTearAnchors, 'red-cheek calibration never moves the independently probed tear landmarks');
    assert.equal(stage.proceduralTears.getState().amount, amount, 'rebuilding a material does not restart the presentation clock');
    const outer = (mesh.material as ShaderMaterial[])[faceIndex], inner = stage.proceduralBlush.attachments[0].clone as ShaderMaterial;
    const key = outer.customProgramCacheKey();
    assert.equal(key.split(':soft-hearts-local-blush-v1').length, 2); assert.equal(key.split(':soft-hearts-surface-tears-v1').length, 2);
    const shader = { vertexShader: outer.vertexShader, fragmentShader: outer.fragmentShader, uniforms: outer.uniforms };
    outer.onBeforeCompile(shader as any, {} as any);
    assert.ok(shader.uniforms.shBlushAmount); assert.ok(shader.uniforms.shTearsAmount);
    assert.equal(shader.fragmentShader.split('vec3 shTearsMask(').length, 2);
    assert.ok(shader.fragmentShader.indexOf('diffuseColor.rgb = mix') < shader.fragmentShader.indexOf('outgoingLight = mix'));
    outer.addEventListener('dispose', () => disposed.push('new-tears'));
    inner.addEventListener('dispose', () => disposed.push('new-blush'));
    originals[faceIndex].addEventListener('dispose', () => disposed.push('original-face'));
    stage.clearModel();
    assert.deepEqual(disposed, ['tears', 'blush', 'new-tears', 'new-blush', 'original-face']);
    assert.equal(mesh.material, originals); assert.equal(mesh.onBeforeRender, originalHook);
    assert.equal(stage.mesh, null); assert.equal(stage.proceduralTears, null); assert.equal(stage.proceduralBlush, null);
    assert.equal(stage.tearsAnchors, null); assert.equal(stage.tearsVerifiedGene, false);
  } finally {
    if (stage.mesh) { stage.stopTears(true); stage.proceduralBlush?.dispose(); mesh.geometry.dispose(); for (const material of originals) material.dispose(); mesh.skeleton.dispose(); }
  }
});
