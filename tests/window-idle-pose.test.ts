// The companion window's idle is full-screen Unbound's idle (docs/claude/2026-11-21-window-idle-pose.md). The user (2026-11-21, dev
// build a8fe438d, the window engine on): "现在的One待机和unbound的One待机不一样怎么回事？" (a VRM), "mumi也是" (a PMX): in the window she stood
// in the model's rest pose with only the arms-down residual (arms spread down and out, elbows straight); in full-screen she stood in the
// bundled stand. A newly loaded model has no motion (the host clears it), so the window had no pose layer, and only full-screen filled
// it with her default stand (electron/unbound/source.ts withRestPose, 2026-11-15). Now one rule fills it on every stage
// (shared/actions/rest-stand.ts): the window engine (src/unbound/window-mode/window-pose-layers.ts) and the old stage (src/stage/mmd/pose.ts).
//
// Measured on the public Gene and a synthetic VRM (no private model), with the real clips, figure, window body and shipped idle; the old
// stage through the R29 harness (tests/helpers/gene-stage-harness.ts) at 60 and 30 fps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Quaternion, Vector3, type AnimationClip, type Bone, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { withRestStand } from '../shared/actions/rest-stand';
import type { AssetRef } from '../shared/foundation/settings';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { unboundSource, withRestPose } from '../electron/unbound/source';
import { askRestStand, layersWithRestStand } from '../src/stage/rest-stand';
import { windowMotionClips } from '../src/unbound/window-mode/window-pose-layers';
import { windowStageHost, WINDOW_STAGE_HOST_METHODS, type WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { windowPreviewStageHost, WINDOW_PREVIEW_HOST_METHODS } from '../src/unbound/window-mode/preview-port';
import { loadPoseClip } from '../src/unbound/rest-pose';
import { UnboundFigure } from '../src/unbound/figure';
import { WindowBody } from '../src/unbound/window-mode/window-body';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { parseVmdWith, type VmdDataTransform } from '../src/foundation/vmd';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import type { StandardBody } from '../src/unbound/model/standard-body';
import { STAND_VMD, TRACKED } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { syntheticStandardBody } from './helpers/unbound-vrm';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { catalogMotionFile } from './helpers/frame-stats';

const DEG = 180 / Math.PI;
const REST: AssetRef = { path: 'C:\\app\\assets\\bundled\\stand.vmd', url: 'mmd-asset://rest/stand.vmd', name: 'stand.vmd' };
const NONE = { ...DEFAULT_SETTINGS, motion: null, motionLayers: undefined };
const restHost = (): WindowStageHost => ({ getRestStand: async () => REST } as unknown as WindowStageHost);
const R29 = { 60: 0.12, 30: 0.4 } as Record<number, number>; // the largest "unexpected step" (deg) the full-screen pose switch is held to (tests/unbound-rest-pose.test.ts)

// ---- the rule ----------------------------------------------------------------------------------------------------------------
test('one rule for her default stand: the window and the old stage decide exactly as full-screen Unbound', () => {
  const a = (name: string): AssetRef => ({ path: `D:\\m\\${name}`, url: `mmd-asset://m/${name}`, name });
  const cases: [Parameters<typeof withRestStand>[0], boolean][] = [
    [{ pose: null, gesture: null, expression: null }, true], // no motion (a newly loaded model): legacy settings
    [{ pose: null, gesture: null, expression: null }, false],
    [{ pose: null, gesture: a('wave.vmd'), expression: a('face.vmd') }, false], // the pose cleared, a gesture and a face kept
    [{ pose: a('mine.vmd'), gesture: null, expression: a('mine.vmd') }, true], // an old single motion stays as it was
    [{ pose: a('mine.vmd'), gesture: null, expression: null }, false], // a picked pose always wins
  ];
  for (const [layers, legacy] of cases) {
    const ours = withRestStand(layers, legacy, REST);
    const full = withRestPose({ pose: layers.pose?.url ?? null, gesture: layers.gesture?.url ?? null, expression: layers.expression?.url ?? null, legacy }, REST.url);
    assert.deepEqual({ pose: ours.layers.pose?.url ?? null, gesture: ours.layers.gesture?.url ?? null, expression: ours.layers.expression?.url ?? null, legacy: ours.legacy },
      { pose: full.pose ?? full.rest ?? null, gesture: full.gesture, expression: full.expression, legacy: full.legacy }, JSON.stringify(layers));
    assert.equal(ours.rest, !layers.pose);
    assert.deepEqual(withRestStand(layers, legacy, null), { layers, legacy, rest: false }, 'without a default stand nothing changes');
  }
  // What a newly loaded model's settings look like to full-screen and to the window: the same.
  assert.deepEqual(unboundSource({ ...NONE, model: a('her.pmx') }, null).motion, { pose: null, gesture: null, expression: null, legacy: true });
});

test('asking for the default stand never throws and never hangs: no method, a failure, garbage or no answer is none', async () => {
  assert.equal(await askRestStand(undefined), null);
  assert.equal(await askRestStand({}), null);
  assert.equal(await askRestStand({ getRestStand: async () => { throw new Error('bundled files missing'); } }), null);
  assert.equal(await askRestStand({ getRestStand: async () => ({ url: '' }) as never }), null);
  assert.equal(await askRestStand({ getRestStand: () => new Promise<never>(() => {}) }, 20), null);
  assert.deepEqual(await askRestStand({ getRestStand: async () => REST }), REST);
  let asked = 0;
  const port = { getRestStand: async () => { asked++; return REST; } };
  await layersWithRestStand({ pose: REST, gesture: null, expression: null }, false, port);
  assert.equal(asked, 0, 'a picked pose: the host is not even asked');
});

test('the window ports carry the read and nothing else new: the companion window and the control window preview', async () => {
  assert.ok(WINDOW_STAGE_HOST_METHODS.includes('getRestStand') && WINDOW_PREVIEW_HOST_METHODS.includes('getRestStand'));
  const desktop = { getRestStand: async () => REST, isBehaviorModelSupported: async () => true, resolveChatGesture: async () => null, resolveHerAction: async () => null,
    resolveBehaviorMotion: async () => null, resolveHerLifeMotion: async () => null, reportHerAction: async () => {}, getBehaviorBodyPlan: async () => null,
    resolveBehaviorBody: async () => null } as unknown as WindowStageHost;
  assert.deepEqual(await windowStageHost(desktop).getRestStand!(), REST);
  assert.deepEqual(await windowPreviewStageHost(desktop).getRestStand!(), REST);
  const without = { ...desktop, getRestStand: undefined } as unknown as WindowStageHost;
  assert.equal(await windowStageHost(without).getRestStand!(), null, 'a preload without it: none, she stands as before');
});

test('the window engine plays her default stand when no pose is picked; it failing never stops a motion change, a picked one failing still does', async () => {
  const loaded: string[] = [];
  const load = async (url: string) => { loaded.push(url); if (url.includes('broken')) throw new Error('404'); return { name: url } as unknown as AnimationClip; };
  const none = await windowMotionClips(NONE, restHost(), load);
  assert.equal(none.rest, true); assert.equal(none.legacy, false); assert.equal(none.pose?.url, REST.url);
  assert.equal((none.clips.pose as unknown as { name: string }).name, REST.url);
  assert.equal(none.clips.expression, null, 'the stand never owns her face');
  const before = await windowMotionClips(NONE, {} as WindowStageHost, load);
  assert.deepEqual(before.clips, { pose: null, gesture: null, expression: null }, 'no port: as before this fix');
  const picked = { ...NONE, motion: { path: 'p', url: 'mmd-asset://m/mine.vmd', name: 'mine.vmd' } };
  const own = await windowMotionClips(picked, restHost(), load);
  assert.equal(own.rest, false); assert.equal(own.pose?.url, 'mmd-asset://m/mine.vmd');
  const brokenRest = await windowMotionClips(NONE, { getRestStand: async () => ({ ...REST, url: 'mmd-asset://x/broken.vmd' }) } as unknown as WindowStageHost, load);
  assert.equal(brokenRest.clips.pose, null, 'the default stand failing: she stands without it');
  await assert.rejects(windowMotionClips({ ...NONE, motion: { path: 'b', url: 'mmd-asset://x/broken.vmd', name: 'broken.vmd' } }, restHost(), load));
});

// ---- her body: the window against full-screen --------------------------------------------------------------------------------
async function standClipFor(mesh: SkinnedMesh, transform?: VmdDataTransform): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, transform);
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, mesh);
  clip.duration = Math.max(clip.duration, 120 / 30);
  return clip;
}

interface Body { mesh: SkinnedMesh; standard: StandardBody | null; transform?: VmdDataTransform; arms: Bone[][]; close(): void }
async function gene(): Promise<Body> {
  const fixture = await loadPublicGeneForTargets(), find = (name: string) => fixture.mesh.skeleton.bones.find(b => b.name === name)!;
  return { mesh: fixture.mesh, standard: null, arms: [['左腕', '左ひじ', '左手首'], ['右腕', '右ひじ', '右手首']].map(chain => chain.map(find)), close: () => fixture.close() };
}
async function vrm(): Promise<Body> {
  const body = await syntheticStandardBody('1.0'), bone = (slot: Parameters<StandardBody['model']['bone']>[0]) => body.model.bone(slot)!;
  // The VRM's OWN bones (what is drawn), not the standard skeleton's.
  return { mesh: body.mesh, standard: body, transform: body.transform, arms: [[bone('armLeft'), bone('elbowLeft'), bone('wristLeft')], [bone('armRight'), bone('elbowRight'), bone('wristRight')]],
    close: () => body.dispose() };
}
/** Per arm: the upper arm's and the forearm's world directions. */
function armDirections(body: Body): Vector3[] {
  body.mesh.updateMatrixWorld(true); body.standard?.model.object.updateMatrixWorld(true);
  const at = (b: Bone) => b.getWorldPosition(new Vector3());
  return body.arms.flatMap(([shoulder, elbow, wrist]) => [at(elbow!).sub(at(shoulder!)).normalize(), at(wrist!).sub(at(elbow!)).normalize()]);
}
const DOWN = new Vector3(0, -1, 0);

/**
 * Full-screen Unbound (src/unbound/main.ts loadFigure): the pose from the scene (withRestPose → loadPoseClip), set before her first
 * frame. Mean arm directions over t = 3..7 s at `fps`.
 */
async function fullScreen(make: () => Promise<Body>, fps: number): Promise<Vector3[]> {
  const body = await make();
  try {
    const figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 });
    const motion = withRestPose(unboundSource({ ...NONE, model: { path: 'm', url: 'mmd-asset://m/her.pmx', name: 'her.pmx' } }, null).motion, REST.url);
    figure.setClips({ pose: await loadPoseClip(motion, () => standClipFor(body.mesh, body.transform)), gesture: null, expression: null }, motion.legacy);
    return await sample(fps, dt => { figure.frame(dt); body.standard?.present(dt); }, body, () => figure.dispose());
  } finally { body.close(); }
}

/**
 * The window engine (window-stage.ts as it runs): the model loaded and settled (window-model.ts, then settle), the companion's settings'
 * motions through windowMotionClips with this host, set while she is not on screen yet, then the window body's real frames with the
 * shipped idle. `first`: the arm directions on her first drawn frame.
 */
async function windowIdle(make: () => Promise<Body>, fps: number, host: WindowStageHost, unseen = true) {
  const body = await make();
  try {
    const figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 });
    const idle = await shippedIdle();
    let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const windowBody = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random, body.standard);
    await new Promise(resolve => setImmediate(resolve));
    windowBody.settle();
    const { clips, legacy } = await windowMotionClips(NONE, host, () => standClipFor(body.mesh, body.transform));
    figure.setClips(clips, legacy, { unseen });
    let first: Vector3[] | null = null;
    const mean = await sample(fps, dt => {
      windowBody.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false });
      first ??= armDirections(body);
    }, body, () => windowBody.dispose(), true);
    return { mean, first: first! };
  } finally { body.close(); }
}

async function sample(fps: number, frame: (dt: number) => void, body: Body, dispose: () => void, skipDispose = false): Promise<Vector3[]> {
  const sums: Vector3[] = [];
  let n = 0;
  for (let i = 0; i <= fps * 7; i++) {
    frame(i ? 1 / fps : 0);
    if (i >= fps * 3) { armDirections(body).forEach((d, k) => { (sums[k] ??= new Vector3()).add(d); }); n++; }
  }
  if (!skipDispose) dispose();
  return sums.map(s => s.divideScalar(n).normalize());
}
const apart = (a: Vector3[], b: Vector3[]) => Math.max(...a.map((d, k) => d.angleTo(b[k]!) * DEG));
const outFromBody = (dirs: Vector3[]) => Math.max(dirs[0]!.angleTo(DOWN), dirs[2]!.angleTo(DOWN)) * DEG;

for (const [label, make] of [['Gene (PMX)', gene], ['a VRM (synthetic)', vrm]] as const) {
  test(`${label}: the window's idle arms are full-screen's, at 60 and 30 fps (before: the rest pose's arms, spread out)`, async () => {
    for (const fps of [60, 30]) {
      const full = await fullScreen(make, fps);
      const before = await windowIdle(make, fps, {} as WindowStageHost);
      const after = await windowIdle(make, fps, restHost());
      const note = `${label} ${fps} fps: upper arm from the body full-screen ${outFromBody(full).toFixed(1)}°, window before ${outFromBody(before.mean).toFixed(1)}°, after ${outFromBody(after.mean).toFixed(1)}°; ` +
        `window vs full-screen before ${apart(before.mean, full).toFixed(1)}°, after ${apart(after.mean, full).toFixed(1)}°`;
      console.log(note);
      assert.ok(apart(before.mean, full) > 10, `before differed (${note})`);
      assert.ok(apart(after.mean, full) < 3, `after: the same idle arms (${note})`);
      // Her first drawn frame already stands in the stand: nothing glides in as she fades in.
      assert.ok(apart(after.first, after.mean) < 6, `first frame ${apart(after.first, after.mean).toFixed(1)}° from her idle (${note})`);
    }
  });
}

test('the window: her first motions set while she is not on screen are simply there; set while shown they glide (60 and 30 fps)', async () => {
  for (const fps of [60, 30]) {
    const shown = await windowIdle(gene, fps, restHost(), false);
    const unseen = await windowIdle(gene, fps, restHost(), true);
    console.log(`window first frame vs idle (${fps} fps): set while shown ${apart(shown.first, shown.mean).toFixed(1)}° (glides in), not shown yet ${apart(unseen.first, unseen.mean).toFixed(1)}°`);
    assert.ok(apart(shown.first, shown.mean) > apart(unseen.first, unseen.mean) + 5, 'shown: bridged from where she was (never a jump)');
  }
});

test('the window: clearing a picked pose while she is shown hands over to the default stand smoothly (60 and 30 fps)', async () => {
  const neutral = new URL(catalogMotionFile('100style-idles', 'neutral-idle'));
  for (const fps of [60, 30]) {
    const body = await gene();
    try {
      const figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 }), idle = await shippedIdle();
      let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const windowBody = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random, null);
      await new Promise(resolve => setImmediate(resolve));
      windowBody.settle();
      const picked = { ...NONE, motion: { path: 'n', url: neutral.href, name: 'neutral-idle.vmd' } };
      const clipOf = async (url: string) => {
        const bytes = await readFile(url === REST.url ? STAND_VMD : neutral);
        const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        const clip = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder.build(vmd, body.mesh);
        clip.duration = Math.max(clip.duration, 4); return clip;
      };
      const first = await windowMotionClips(picked, restHost(), clipOf), cleared = await windowMotionClips(NONE, restHost(), clipOf);
      figure.setClips(first.clips, first.legacy, { unseen: true });
      const bones = TRACKED.map(name => body.mesh.skeleton.bones.find(b => b.name === name)!);
      const frames: Quaternion[][] = [];
      for (let i = 0; i <= fps * 5; i++) {
        if (i === fps * 2) figure.setClips(cleared.clips, cleared.legacy, { unseen: false }); // shown: the user clears the pose
        windowBody.frame(i ? 1 / fps : 0, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false });
        body.mesh.updateMatrixWorld(true);
        frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      }
      windowBody.dispose();
      const at = frames.slice(fps * 2 - 2), step = (i: number) => at[i]!.map((q, b) => q.angleTo(at[i - 1]![b]!) * DEG);
      const stepsDeg = at.slice(1).map((_, i) => Math.max(...step(i + 1)));
      const surprise = Math.max(...at.slice(2).map((_, i) => Math.max(...step(i + 2).map((s, b) => Math.abs(s - step(i + 1)[b]!)))));
      console.log(`window clear pose → default stand (${fps} fps): largest step ${Math.max(...stepsDeg).toFixed(2)}°/frame, unexpected step ${surprise.toFixed(3)}°`);
      assert.ok(Math.max(...stepsDeg) * fps < 130, `${fps} fps: at most ${(Math.max(...stepsDeg) * fps).toFixed(0)}°/s`);
      assert.ok(surprise < R29[fps]!, `${fps} fps: unexpected step ${surprise.toFixed(3)}°`);
    } finally { body.close(); }
  }
});

// ---- the old stage -------------------------------------------------------------------------------------------------------------
const NO_LAYERS = { pose: null, gesture: null, expression: null };
