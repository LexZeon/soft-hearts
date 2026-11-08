import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AnimationClip, Bone, BufferGeometry, MeshBasicMaterial, NumberKeyframeTrack, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, type KeyframeTrack } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { BEHAVIOR_FACE_BINDING_IDS, type BehaviorFaceBindingId, type BehaviorMotionCue, type BehaviorMotionPlan, type BehaviorMotionResource, type BehaviorSemantic } from '../shared/behavior-motion';
import { BehaviorMotionPlayer, type BehaviorMotionGates } from '../src/stage/behavior-motion';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { createVmdParser } from '../src/stage/vmd';

const OPEN: BehaviorMotionGates = { enabled: true, visible: true, faceBlocked: false, directContact: false, windowAdjusting: false, cameraAdjusting: false };
const semantic: Record<BehaviorFaceBindingId, BehaviorSemantic> = {
  'face.smile': 'mood.content', 'face.embarrassed-smile': 'mood.close', 'face.happy': 'mood.happy', 'face.laugh': 'mood.excited',
  'face.compassion': 'mood.concerned', 'face.in-trouble': 'mood.tense-expectation', 'face.disappointed': 'mood.disappointed',
  'face.disgust': 'mood.upset', 'face.sentimental': 'mood.longing', 'face.sad': 'mood.sad', 'face.convinced': 'cue.motion',
};
function cue(id: string, bindingId: BehaviorFaceBindingId = 'face.happy', kind: 'state' | 'reaction' = 'state', at = 10_000): BehaviorMotionCue {
  return { id, bindingId, kind, semantic: kind === 'reaction' ? 'cue.satisfied' : semantic[bindingId], at, expiresAt: at + 11_500, strength: 0.6, stateKey: `${semantic[bindingId]}:neutral` };
}
function resource(value: BehaviorMotionCue, durationMs = 2_000): BehaviorMotionResource {
  return { cueId: value.id, bindingId: value.bindingId, packId: 'gene', motionId: value.bindingId.slice(5) as BehaviorMotionResource['motionId'],
    sha256: 'a'.repeat(64), durationMs, url: 'mmd-asset://approved-motion', recipe: 'emotion-face' };
}
const morph = (index: number, start = 1, end = start, duration = 2) => new NumberKeyframeTrack(`.morphTargetInfluences[${index}]`, [0, duration], [start, end]);
const clip = (tracks: KeyframeTrack[] = [morph(0)], duration = 2) => new AnimationClip('face-source', duration, tracks);
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(options: {
  targetSupported?: boolean;
  dictionary?: Record<string, number>; source?: AnimationClip;
  resolve?: (value: BehaviorMotionCue) => Promise<BehaviorMotionResource>;
  load?: (value: BehaviorMotionResource, mesh: SkinnedMesh) => Promise<AnimationClip>;
  suits?: (sha256: string) => boolean;
} = {}) {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material), head = new Bone(); head.name = '頭'; mesh.add(head); mesh.bind(new Skeleton([head]));
  mesh.morphTargetDictionary = options.dictionary ?? { にこり: 0, 笑い: 1, 困る: 2, 怒り: 3, じと目: 4, まばたき: 5, にっこり: 6, あ: 7, 赤み: 8, 全身: 9, 下: 10 };
  mesh.morphTargetInfluences = Array(12).fill(0.1);
  let now = 10_000; const cues = new Map<string, BehaviorMotionCue>(), resolved: string[] = [], loaded: SkinnedMesh[] = [];
  const player = new BehaviorMotionPlayer(mesh, {
    targetSupported: options.targetSupported ?? true,
    now: () => now,
    resolve: async id => { resolved.push(id); const value = cues.get(id)!; return options.resolve ? options.resolve(value) : resource(value); },
    load: async (value, target) => { loaded.push(target); return options.load ? options.load(value, target) : options.source ?? clip(); },
    ...(options.suits ? { suits: options.suits } : {}),
  });
  function update(plan: BehaviorMotionPlan | null, gates: Partial<BehaviorMotionGates> = {}, token = 'character-scope') {
    for (const value of [plan?.state, plan?.reaction]) if (value) cues.set(value.id, value);
    player.update(plan, token, { ...OPEN, ...gates });
  }
  return { mesh, head, player, update, resolved, loaded, clock(value: number) { now = value; }, dispose() { player.dispose(); geometry.dispose(); material.dispose(); mesh.skeleton.dispose(); } };
}

test('the exact audited eyebrow/eye mask excludes mouth, natural blink, blush, unknown and all bones', async () => {
  let unsafeFactoryCalls = 0;
  const unsafe = new QuaternionKeyframeTrack('.bones[頭].quaternion', [0, 2], [0, 0, 0, 1, 0, 0.5, 0, Math.sqrt(0.75)]);
  unsafe.createInterpolant = () => { unsafeFactoryCalls++; throw new Error('body must never bind'); };
  const source = clip([unsafe, ...Array.from({ length: 11 }, (_, index) => morph(index))]);
  const f = fixture({ source });
  try {
    const original = [...f.mesh.morphTargetInfluences!], tracks = [...source.tracks], factories = tracks.map(track => track.createInterpolant);
    f.update({ state: cue('audited-mask'), reaction: null }); await flush();
    const state = f.player.frame(0.5);
    assert.deepEqual(state.state.propertyIndices, [0, 1, 2, 3, 4, 10]);
    assert.ok(f.mesh.morphTargetInfluences![0] > 0.5); assert.equal(unsafeFactoryCalls, 0);
    for (const index of [5, 6, 7, 8, 9]) assert.equal(f.mesh.morphTargetInfluences![index], original[index]);
    assert.deepEqual(f.head.quaternion.toArray(), [0, 0, 0, 1]);
    assert.deepEqual(source.tracks, tracks); assert.deepEqual(source.tracks.map(track => track.createInterpolant), factories); assert.equal(source.duration, 2);
    f.player.restore(); assert.deepEqual(f.mesh.morphTargetInfluences, original);
  } finally { f.dispose(); }
});

for (const supported of [false, undefined]) {
  test(`unreviewed target (${String(supported)}) cannot resolve or play even with approved-looking composite morph names`, async () => {
    const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
    mesh.morphTargetDictionary = { にこり: 0, 笑い: 1, あ: 2, 赤み: 3 };
    mesh.morphTargetInfluences = [0.17, 0.23, 0.31, 0.29];
    // A different PMX may use the same allowed names for groups containing mouth
    // vertices. Names alone are not target approval, regardless of these indices.
    const baseline = [...mesh.morphTargetInfluences]; let resolves = 0, loads = 0;
    const dependencies = {
      ...(supported === undefined ? {} : { targetSupported: supported }), now: () => 10_000,
      resolve: async () => { resolves++; return resource(cue('untrusted')); },
      load: async () => { loads++; return clip([morph(0), morph(1)]); },
    };
    const player = new BehaviorMotionPlayer(mesh, dependencies);
    try {
      player.update({ state: cue('untrusted'), reaction: null }, 'scope', OPEN);
      await flush(); player.frame(0.5);
      assert.equal(resolves, 0); assert.equal(loads, 0);
      assert.deepEqual(mesh.morphTargetInfluences, baseline);
      assert.equal(player.getState().state.degraded, 'unsupported-target');
      assert.equal(player.getState().active, false);
      dependencies.targetSupported = true;
      player.update({ state: cue('other-untrusted'), reaction: null }, 'scope', OPEN);
      await flush(); player.frame(0.5);
      assert.equal(resolves, 0, 'authorization is captured for this target, not a mutable dependency flag');
    } finally { player.dispose(); mesh.geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose(); }
  });
}

test('R29d: a face motion that does not suit the model is not started (also from the clip cache); a playing one fades out on recheck', async () => {
  let suitable = false;
  const f = fixture({ suits: sha256 => { assert.equal(sha256, 'a'.repeat(64)); return suitable; } });
  try {
    f.update({ state: cue('unfit-first'), reaction: null }); await flush(); f.player.frame(0.5);
    assert.equal(f.player.getState().active, false); assert.equal(f.player.getState().state.degraded, 'unsuitable-model');
    suitable = true;
    f.update({ state: cue('fit-now', 'face.smile'), reaction: null }); await flush();
    for (let frame = 0; frame < 15; frame++) f.player.frame(1 / 30);
    const playing = f.player.getState().state.weight;
    assert.ok(playing > 0.3, `it plays once it suits (${playing})`);
    suitable = false; f.player.recheck();
    const weights: number[] = [];
    for (let frame = 0; frame < 12; frame++) { f.player.restore(); weights.push(f.player.frame(1 / 30).state.weight); }
    assert.ok(weights[0] > playing * 0.8, 'no one-frame cut: it fades from the shown weight');
    assert.ok(weights.slice(1).every((value, i) => value <= weights[i] + 1e-12), 'it only fades');
    assert.equal(f.player.getState().active, false, 'gone after the cancel fade');
    const loads = f.loaded.length;
    f.update({ state: cue('cached-unfit', 'face.happy'), reaction: null }); await flush(); f.player.frame(0.5);
    assert.equal(f.player.getState().active, false, 'a cached clip of an unfit motion is not started either');
    assert.equal(f.loaded.length, loads, 'it came from the cache');
  } finally { f.dispose(); }
});

test('state and reaction use advancing base values, restore in reverse and never accumulate', async () => {
  const f = fixture({ load: async value => clip([morph(0, value.bindingId === 'face.smile' ? 0.8 : 0.6)]) });
  try {
    const s = cue('layer-state', 'face.smile'), r = cue('layer-reaction', 'face.convinced', 'reaction'); r.semantic = 'cue.motion';
    f.update({ state: s, reaction: r }); await flush();
    for (let frame = 0; frame < 30; frame++) {
      f.player.restore(); const base = 0.1 + frame / 1_000; f.mesh.morphTargetInfluences![0] = base;
      const state = f.player.frame(1 / 30); const a = state.state.weight, b = state.reaction.weight;
      assert.ok(Math.abs(f.mesh.morphTargetInfluences![0] - ((base + (0.8 - base) * a) * (1 - b) + 0.6 * b)) < 1e-7);
      f.player.restore(); assert.equal(f.mesh.morphTargetInfluences![0], base); f.player.restore(); assert.equal(f.mesh.morphTargetInfluences![0], base);
    }
    f.player.frame(5); assert.equal(f.player.getState().active, false); assert.equal(f.mesh.morphTargetInfluences![0], 0.129);
  } finally { f.dispose(); }
});

test('same qualitative state key and repeated cue never restart the source or its async load', async () => {
  const f = fixture();
  try {
    const first = cue('same-state'); f.update({ state: first, reaction: null }); await flush(); f.player.frame(0.5);
    for (let count = 0; count < 8; count++) {
      f.update({ state: { ...first, id: `snapshot-${count}`, strength: 0.4 }, reaction: null });
      f.player.frame(0.1);
    }
    assert.equal(f.resolved.length, 1); assert.equal(f.loaded.length, 1); assert.ok(f.player.getState().state.elapsedMs > 1_200);
    f.player.frame(2); assert.equal(f.player.getState().active, false);
    f.update({ state: { ...first, id: 'new-id-same-key' }, reaction: null }); await flush();
    assert.equal(f.resolved.length, 1); assert.equal(f.player.getState().active, false, 'finished state falls back instead of holding or looping');
  } finally { f.dispose(); }
});

test('original interpolants, source timing and smooth in/out strengths are retained', async () => {
  const track = morph(0, 0, 1); let calls = 0;
  track.createInterpolant = () => ({ evaluate(time: number) { calls++; return [time * time / 4]; } }) as any;
  const f = fixture({ source: clip([track]) });
  try {
    f.mesh.morphTargetInfluences![0] = 0;
    f.update({ state: cue('authored-clock'), reaction: null }); await flush();
    assert.equal(f.player.frame(0).state.weight, 0);
    assert.ok(Math.abs(f.player.frame(0.125).state.weight - 0.3) < 1e-12);
    assert.ok(Math.abs(f.mesh.morphTargetInfluences![0] - (0.125 ** 2 / 4) * 0.3) < 1e-12);
    assert.equal(f.player.frame(0.125).state.weight, 0.6);
    const mid = f.player.frame(1.3).state.weight, out = f.player.frame(0.25).state.weight;
    assert.ok(mid > out && out > 0); f.player.frame(0.2); assert.equal(f.player.getState().active, false); assert.equal(f.mesh.morphTargetInfluences![0], 0);
    assert.equal(calls, 5);
  } finally { f.dispose(); }
});

test('natural blinking attenuates authored eye shapes while protected properties remain untouched', async () => {
  const f = fixture({ source: clip([morph(0), morph(1), morph(2)]) });
  try {
    const state = cue('blink-yield'); f.update({ state, reaction: null }, { naturalBlink: 1, protectedMorphIndices: [2, 5, 7, 8] }); await flush();
    const actual = f.player.frame(0.5);
    assert.ok(f.mesh.morphTargetInfluences![0] > 0.5); assert.equal(f.mesh.morphTargetInfluences![1], 0.1);
    assert.equal(f.mesh.morphTargetInfluences![2], 0.1); assert.deepEqual(actual.state.propertyIndices, [0, 1]);
    assert.equal(actual.state.samples.find(sample => sample.index === 1)!.value, 0.1);
    f.player.restore(); f.update({ state, reaction: null }, { naturalBlink: 0.5 }); f.player.frame(0);
    assert.ok(Math.abs(f.mesh.morphTargetInfluences![1] - 0.37) < 1e-7);
  } finally { f.dispose(); }
});

test('all conflict gates consume a reaction, cancel pending loads, restore and never replay it', async () => {
  for (const closed of [{ enabled: false }, { visible: false }, { faceBlocked: true }, { directContact: true }, { windowAdjusting: true }, { cameraAdjusting: true }]) {
    const waiting = deferred<AnimationClip>(), f = fixture({ load: () => waiting.promise });
    try {
      const reaction = cue('gated-reaction', 'face.smile', 'reaction');
      f.update({ state: null, reaction }); await flush(); assert.equal(f.player.getState().reaction.pending, true);
      f.update({ state: null, reaction }, closed); waiting.resolve(clip()); await flush(); f.player.frame(0.5);
      assert.equal(f.player.getState().active, false); assert.equal(f.mesh.morphTargetInfluences![0], 0.1);
      f.update({ state: null, reaction }); await flush(); assert.equal(f.resolved.length, 1); assert.equal(f.player.getState().active, false);
    } finally { f.dispose(); }
  }
  const f = fixture();
  try {
    const reaction = cue('already-blocked', 'face.smile', 'reaction'); f.update({ state: null, reaction }, { directContact: true });
    f.update({ state: null, reaction }); await flush(); assert.equal(f.resolved.length, 0);
  } finally { f.dispose(); }
});

test('a newly evaluated state may return after a gate, but the cancelled or expired cue may not', async () => {
  const f = fixture();
  try {
    const state = cue('state-before-contact'); f.update({ state, reaction: null }); await flush(); f.player.frame(0.5);
    // Pretrial 2026-11-03: a touch no longer cuts the face in one frame; it fades from what shows (CANCEL_FADE 0.2 s), nothing replays.
    const before = f.mesh.morphTargetInfluences![0];
    f.update({ state, reaction: null }, { directContact: true }); const fading = (f.player.frame(0.1), f.mesh.morphTargetInfluences![0]);
    assert.ok(fading < before && fading > 0.1, `fading ${fading} from ${before}`);
    f.player.frame(0.15); assert.equal(f.mesh.morphTargetInfluences![0], 0.1);
    f.update({ state, reaction: null }); await flush(); assert.equal(f.player.getState().active, false);
    f.update({ state: { ...state, id: 'new-state-after-contact' }, reaction: null }); await flush(); assert.equal(f.player.getState().active, true);
    // Pretrial 2026-11-03: a cue that runs out mid-face fades out from there (CANCEL_FADE 0.2 s) instead of dropping in one frame.
    const shownWeight = f.player.frame(0.5).state.weight;
    f.clock(state.expiresAt); const expiring = f.player.frame(0.1).state.weight;
    assert.ok(expiring > 0 && expiring < shownWeight, `fading ${expiring} from ${shownWeight}`);
    f.player.frame(0.15); assert.equal(f.player.getState().active, false);
    f.update({ state: { ...state, id: 'expired-state' }, reaction: null }); await flush(); assert.equal(f.player.getState().active, false);
  } finally { f.dispose(); }
});

test('token, desired cue, mesh identity and disposal invalidate late async results', async () => {
  for (const cancel of ['token', 'plan', 'mesh', 'dispose']) {
    const waiting = deferred<BehaviorMotionResource>(), f = fixture({ resolve: () => waiting.promise });
    try {
      const state = cue('late-result'); f.update({ state, reaction: null }); await flush();
      if (cancel === 'token') f.update(null, {}, 'another-character');
      if (cancel === 'plan') f.update(null);
      if (cancel === 'mesh') f.mesh.morphTargetDictionary = { にこり: 11 };
      if (cancel === 'dispose') f.player.dispose();
      waiting.resolve(resource(state)); await flush(); f.player.frame(0.5);
      assert.equal(f.player.getState().active, false, cancel); assert.equal(f.loaded.length, 0, cancel);
      assert.deepEqual(f.mesh.morphTargetInfluences, Array(12).fill(0.1));
    } finally { f.dispose(); }
  }
  const waiting = deferred<AnimationClip>(), first = fixture({ load: () => waiting.promise }), second = fixture();
  try {
    first.update({ state: cue('old-model'), reaction: null }); await flush(); assert.equal(first.loaded[0], first.mesh);
    first.player.dispose(); waiting.resolve(clip()); await flush(); first.player.frame(0.5); second.player.frame(0.5);
    assert.deepEqual(first.mesh.morphTargetInfluences, Array(12).fill(0.1)); assert.deepEqual(second.mesh.morphTargetInfluences, Array(12).fill(0.1));
  } finally { first.dispose(); second.dispose(); }
});

test('new state exits old source smoothly before entering the latest replacement', async () => {
  const f = fixture({ load: async value => clip([morph(0, value.bindingId === 'face.happy' ? 1 : 0)]) });
  try {
    f.update({ state: cue('old-state'), reaction: null }); await flush(); f.player.frame(0.5);
    const previous = f.mesh.morphTargetInfluences![0];
    f.update({ state: cue('new-state', 'face.smile'), reaction: null }); await flush();
    assert.equal(f.mesh.morphTargetInfluences![0], previous, 'updating a plan does not change the displayed output');
    f.player.frame(0.05); const fading = f.mesh.morphTargetInfluences![0]; assert.ok(fading < previous && fading > 0.1);
    f.player.frame(0.16); assert.equal(f.mesh.morphTargetInfluences![0], 0.1);
    assert.equal(f.player.getState().state.id, 'new-state'); f.player.frame(0.125);
    assert.ok(f.mesh.morphTargetInfluences![0] < 0.1 && f.mesh.morphTargetInfluences![0] > 0.04);
  } finally { f.dispose(); }
});

test('invalid resources, nonfinite/out-of-bounds tracks and duplicate mappings fail closed', async () => {
  for (const patch of [{ cueId: 'foreign' }, { bindingId: 'face.smile' }, { motionId: 'smile' }, { packId: 'other' }, { recipe: 'body' }, { durationMs: NaN }, { sha256: 'bad' }, { url: 'https://example.invalid/motion.vmd' }]) {
    const f = fixture({ resolve: async value => ({ ...resource(value), ...patch }) as BehaviorMotionResource });
    try { f.update({ state: cue('invalid-resource'), reaction: null }); await flush(); assert.equal(f.loaded.length, 0); assert.equal(f.player.getState().state.degraded, 'invalid-resource'); }
    finally { f.dispose(); }
  }
  const invalid = morph(0); invalid.values[1] = NaN;
  for (const source of [clip([invalid]), clip([morph(12)]), clip([morph(0), morph(0)]), clip([morph(0, 2)]), clip([morph(0)], 4)]) {
    const f = fixture({ source });
    try { f.update({ state: cue('invalid-track'), reaction: null }); await flush(); f.player.frame(0.5); assert.equal(f.player.getState().active, false); assert.deepEqual(f.mesh.morphTargetInfluences, Array(12).fill(0.1)); }
    finally { f.dispose(); }
  }
  const dictionaries: Record<string, number>[] = [{ にこり: 0, あ: 0 }, { にこり: 100 }, { mouth: 0 }, { 'なぬ！': 0, 'なぬ!': 1 }];
  for (const dictionary of dictionaries) {
    const f = fixture({ dictionary });
    try { f.update({ state: cue('bad-dictionary'), reaction: null }); await flush(); assert.equal(f.player.getState().active, false); assert.equal(f.player.getState().state.degraded, 'no-compatible-morphs'); }
    finally { f.dispose(); }
  }
});

test('bad clocks and cues do not load, mutate or extend source playback', async () => {
  const f = fixture();
  try {
    for (const patch of [{ strength: NaN }, { strength: 0.8 }, { at: 10_001 }, { expiresAt: 9_999 }, { at: 8_499 }, { semantic: 'reserved.physics.*' }, { stateKey: '' }]) {
      f.update({ state: { ...cue(`bad-${f.resolved.length}-${JSON.stringify(patch)}`), ...patch } as BehaviorMotionCue, reaction: null }); await flush();
    }
    assert.equal(f.resolved.length, 0);
    f.update({ state: cue('finite-clock'), reaction: null }); await flush();
    for (const delta of [NaN, Infinity, -1]) assert.equal(f.player.frame(delta).state.elapsedMs, 0);
    f.player.frame(0.5); const once = [...f.mesh.morphTargetInfluences!];
    for (let count = 0; count < 12; count++) { f.player.frame(0); assert.deepEqual(f.mesh.morphTargetInfluences, once); }
    f.player.frame(1_000_000); assert.equal(f.player.getState().active, false); assert.equal(f.mesh.morphTargetInfluences![0], 0.1);
  } finally { f.dispose(); }
});

test('cache and consumed identities stay bounded and returned diagnostics are copies', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 150; index++) f.update({ state: null, reaction: cue(`consumed-${index}`, 'face.smile', 'reaction') }, { faceBlocked: true });
    assert.equal(f.player.getState().consumedIds, 128);
    for (const binding of BEHAVIOR_FACE_BINDING_IDS) {
      const value = cue(`cache-${binding}`, binding, binding === 'face.convinced' ? 'reaction' : 'state');
      if (binding === 'face.convinced') value.semantic = 'cue.motion';
      f.update({ state: value.kind === 'state' ? value : null, reaction: value.kind === 'reaction' ? value : null }); await flush(); f.player.frame(0.3);
    }
    assert.equal(f.player.getState().cacheSize, 8); assert.ok(f.loaded.every(mesh => mesh === f.mesh));
    const state = f.player.getState(); state.reaction.propertyIndices.length = 0; state.reaction.samples.length = 0; state.reaction.weight = 99;
    assert.notEqual(f.player.getState().reaction.weight, 99); assert.ok(f.player.getState().reaction.propertyIndices.length > 0);
  } finally { f.dispose(); }
});

test('a real advancing MMD base retains its Action identity and time through restricted face playback', async () => {
  const f = fixture(), animation = new LayeredMmdAnimation(f.mesh);
  try {
    const source = new QuaternionKeyframeTrack('.bones[頭].quaternion', [0, 8], [0, 0, 0, 1, 0, Math.sin(0.2), 0, Math.cos(0.2)]);
    animation.setClips({ pose: clip([source], 8), gesture: null, expression: null });
    const mixer = animation.helper.objects.get(f.mesh)!.mixer! as any, action = mixer._actions[0];
    f.update({ state: cue('base-clock'), reaction: null }); await flush();
    for (let frame = 0; frame < 75; frame++) {
      f.player.restore(); animation.helper.update(1 / 30); const head = f.head.quaternion.toArray(); f.player.frame(1 / 30);
      assert.deepEqual(f.head.quaternion.toArray(), head);
    }
    assert.equal(mixer._actions[0], action); assert.ok(Math.abs(action.time - 2.5) < 1e-8); assert.equal(f.player.getState().active, false);
  } finally { f.dispose(); animation.dispose(); }
});

test('all eleven real Gene recipes sample only audited face properties without touching source bytes or the body', async () => {
  const catalog = JSON.parse(await readFile('shared/motion-catalog.json', 'utf8'));
  const manifest = JSON.parse(await readFile('shared/bundled-assets.json', 'utf8'));
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js'; const { MMDParser } = await import(parserModule);
  const bytes = await readFile(join('assets/bundled', manifest.root, manifest.model.relativePath));
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder.build = () => data.materials.map((value: { name: string }) => { const material = new MeshBasicMaterial(); material.name = value.name; return material; });
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh;
  const requests = new Map<string, BehaviorMotionCue>(), originals: { clip: AnimationClip; tracks: KeyframeTrack[]; factories: unknown[] }[] = [];
  const player = new BehaviorMotionPlayer(mesh, {
    targetSupported: true,
    now: () => 10_000,
    async resolve(id) { const value = requests.get(id)!, entry = catalog.packs[0].motions.find((motion: any) => motion.id === value.bindingId.slice(5)); return { ...resource(value, entry.durationFrames / 30 * 1_000), sha256: entry.sha256 }; },
    async load(value, target) {
      assert.equal(target, mesh);
      const pack = catalog.packs[0], entry = pack.motions.find((motion: any) => motion.id === value.motionId);
      const bytes = await readFile(join('assets/bundled', pack.source, pack.id, pack.revision, entry.relativePath));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256);
      let endFrame = 0; const parser = createVmdParser(report => { endFrame = report.durationFrames; }) as { parseVmd(buffer: ArrayBuffer, convert: boolean): unknown };
      const vmd = parser.parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
      const source = loader.animationBuilder.build(vmd, mesh) as AnimationClip; source.duration = Math.max(source.duration, endFrame / 30);
      originals.push({ clip: source, tracks: [...source.tracks], factories: source.tracks.map(track => track.createInterpolant) }); return source;
    },
  });
  try {
    const body = mesh.skeleton.bones.map(bone => ({ q: bone.quaternion.toArray(), p: bone.position.toArray() }));
    const dictionary = mesh.morphTargetDictionary!;
    assert.equal(data.morphs[dictionary['にこり']].panel, 1); assert.equal(data.morphs[dictionary['笑い']].panel, 2); assert.equal(data.morphs[dictionary['にっこり']].panel, 3);
    for (const bindingId of BEHAVIOR_FACE_BINDING_IDS) {
      player.stop(); const value = cue(`real-${bindingId}`, bindingId, bindingId === 'face.convinced' ? 'reaction' : 'state');
      if (value.kind === 'reaction') value.semantic = 'cue.motion'; requests.set(value.id, value);
      player.update({ state: value.kind === 'state' ? value : null, reaction: value.kind === 'reaction' ? value : null }, 'gene-only', OPEN);
      for (let attempt = 0; attempt < 100 && player.getState()[value.kind].pending; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
      const state = player.frame(0.5)[value.kind]; assert.equal(state.active, true, bindingId); assert.ok(state.samples.some(sample => sample.value > sample.base), bindingId);
      assert.ok(state.propertyIndices.length > 0 && state.propertyIndices.length < 10);
      for (const name of ['あ', 'にっこり', 'まばたき', '赤み', '頬照り', '頬全消し']) assert.equal(mesh.morphTargetInfluences![dictionary[name]], 0, `${bindingId}/${name}`);
      mesh.skeleton.bones.forEach((bone, index) => { assert.deepEqual(bone.quaternion.toArray(), body[index].q); assert.deepEqual(bone.position.toArray(), body[index].p); });
      player.restore(); assert.ok(mesh.morphTargetInfluences!.every(value => value === 0));
    }
    assert.equal(originals.length, 11);
    for (const original of originals) { assert.deepEqual(original.clip.tracks, original.tracks); assert.deepEqual(original.clip.tracks.map(track => track.createInterpolant), original.factories); }
  } finally {
    player.dispose(); mesh.geometry.dispose(); mesh.skeleton.dispose(); for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  }
});
