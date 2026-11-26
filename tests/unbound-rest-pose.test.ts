// Unbound with no pose layer (docs/claude/2026-11-15-unbound-own-model.md). The user's profile had no motion picked, so Unbound
// showed the model's bind pose, standing stock still, on the user's own model and on Gene alike. Now the host offers the bundled
// stand pose as her default stand (electron/unbound/source.ts withRestPose, host.ts restPose), the page loads it as her pose
// (src/unbound/rest-pose.ts), fitted to a model that is not the reviewed Gene the way the companion fits a library motion. A pose layer
// changing while she is shown is bridged, never a jump (src/unbound/clip-switch.ts), at 60 and 30 fps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Quaternion, Vector3, type AnimationClip, type Bone, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { UnboundHost, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource, withRestPose } from '../electron/unbound/source';
import { UNBOUND_REQUESTS, type UnboundMotion, type UnboundScene } from '../shared/unbound/scene';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { loadPoseClip } from '../src/unbound/rest-pose';
import { UnboundFigure } from '../src/unbound/figure';
import { parseVmdWith, type VmdDataTransform } from '../src/foundation/vmd';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { StageMotionRetarget } from '../src/actions/motion-retarget';
import { StageModelProfile } from '../src/stage/model-profile';
import { STAND_VMD, TRACKED } from './helpers/unbound-gene';
import { loadPublicGeneForTargets } from './public-gene-fixture';

const REST = 'mmd-asset://bundled/stand.vmd';
const DEG = 180 / Math.PI;

// ---- what the host gives the window ------------------------------------------------------------------------------------------
test('no pose layer: her pose is the default stand, body tracks only; a picked pose always wins', () => {
  const none = unboundSource({ ...DEFAULT_SETTINGS, model: { path: 'D:\\m\\her.pmx', url: 'mmd-asset://a/her.pmx', name: 'her.pmx' }, motion: null }, null).motion;
  assert.deepEqual(none, { pose: null, gesture: null, expression: null, legacy: true }, 'the profile the user had: no motion, legacy settings');
  assert.deepEqual(withRestPose(none, REST), { pose: null, gesture: null, expression: null, legacy: false, rest: REST });
  assert.deepEqual(withRestPose(none, null), none, 'without a default stand nothing changes');
  const picked: UnboundMotion = { pose: 'mmd-asset://b/mine.vmd', gesture: null, expression: 'mmd-asset://c/face.vmd', legacy: false };
  assert.deepEqual(withRestPose(picked, REST), picked);
  const legacy: UnboundMotion = { pose: 'mmd-asset://b/mine.vmd', gesture: null, expression: 'mmd-asset://b/mine.vmd', legacy: true };
  assert.deepEqual(withRestPose(legacy, REST), legacy, 'an old single motion stays as it was');
  // Pose cleared, a gesture and an expression picked: they stay; the stand fills only the pose.
  const layers: UnboundMotion = { pose: null, gesture: 'mmd-asset://g/wave.vmd', expression: 'mmd-asset://c/face.vmd', legacy: false };
  assert.deepEqual(withRestPose(layers, REST), { ...layers, rest: REST });
});

class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  private gone: (() => void)[] = [];
  readonly webContents = { id: 7, mainFrame: this.frame, send: () => {}, isDestroyed: () => false };
  destroyed = false; visible = false;
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {}
  setBounds(_bounds: Rect) {}
  onGone(callback: () => void) { this.gone.push(callback); }
  event(): UnboundIpcEvent { return { sender: { id: 7, mainFrame: this.frame }, senderFrame: this.frame }; }
}
const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };

async function sceneFrom(settings: AppSettings, restPose?: () => Promise<string | null>): Promise<UnboundScene> {
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>(), windows: FakeWindow[] = [];
  const pet = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getBounds: () => ({ x: 0, y: 0, width: 400, height: 560 }), setBounds() {}, hide() {}, showInactive() {} };
  const host = new UnboundHost({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    pet: () => pet, petWanted: () => true, developerMode: () => true, source: () => unboundSource(settings, null), reviewed: async () => false,
    restPose, display: () => DISPLAY, measure: async () => null,
    openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {}, readyTimeoutMs: 600_000,
  });
  host.apply({ active: true });
  for (let i = 0; i < 20 && !windows.length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const win = windows[0]!;
  const scene = await handlers.get(UNBOUND_REQUESTS.getScene)!(win.event()) as UnboundScene;
  host.quit();
  return scene;
}

test('the real app path: the host asks for the default stand before her window opens and puts it in her first scene', async () => {
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'D:\\m\\gene.pmx', url: 'mmd-asset://a/gene.pmx', name: 'gene.pmx' }, motion: null };
  assert.equal((await sceneFrom(settings, async () => REST)).motion.rest, REST);
  assert.equal((await sceneFrom(settings)).motion.rest, undefined, 'no port: as before');
  const failed = await sceneFrom(settings, async () => { throw new Error('bundled files missing'); });
  assert.equal(failed.motion.rest, undefined, 'a failed answer: she still comes out, without it');
  const picked = { ...settings, motion: { path: 'D:\\m\\mine.vmd', url: 'mmd-asset://b/mine.vmd', name: 'mine.vmd' } };
  const withPose = await sceneFrom(picked, async () => REST);
  assert.equal(withPose.motion.pose, 'mmd-asset://b/mine.vmd');
  assert.equal(withPose.motion.rest, undefined, 'a picked pose wins');
  assert.ok(!JSON.stringify(await sceneFrom(settings, async () => REST)).includes('D:\\\\'), 'still no file path in the scene');
});

test('the page: the default stand failing to load never stops her coming out; a picked pose failing still does', async () => {
  const loaded: string[] = [];
  const load = async (url: string) => { loaded.push(url); if (url.includes('broken')) throw new Error('404'); return url; };
  assert.equal(await loadPoseClip({ pose: null, gesture: null, expression: null, legacy: false, rest: REST }, load), REST);
  assert.equal(await loadPoseClip({ pose: 'mmd-asset://b/mine.vmd', gesture: null, expression: null, legacy: false, rest: REST }, load), 'mmd-asset://b/mine.vmd');
  assert.equal(await loadPoseClip({ pose: null, gesture: null, expression: null, legacy: false, rest: 'mmd-asset://x/broken.vmd' }, load), null);
  await assert.rejects(loadPoseClip({ pose: 'mmd-asset://x/broken.vmd', gesture: null, expression: null, legacy: false }, load));
  assert.equal(await loadPoseClip({ pose: null, gesture: null, expression: null, legacy: true }, load), null);
  assert.deepEqual(loaded, [REST, 'mmd-asset://b/mine.vmd', 'mmd-asset://x/broken.vmd', 'mmd-asset://x/broken.vmd']);
});

// ---- her body ----------------------------------------------------------------------------------------------------------------
async function standFor(mesh: SkinnedMesh, transform?: VmdDataTransform): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, transform);
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, mesh);
  clip.duration = Math.max(clip.duration, 120 / 30);
  return clip;
}

interface Stood { armDropDeg: number; elbowDeg: number; fingerDeg: number; chestSwayDeg: number; headRangeMm: number; comMargin: number | null; planted: boolean }
/**
 * Gene as the page builds her from a scene: the pose through loadPoseClip (the stand bytes for the default URL), fitted as the
 * page fits a model that is not reviewed. 3 s settle, then 4 s (one stand loop) measured at 60 fps.
 */
async function stand(motion: UnboundMotion, reviewed: boolean): Promise<Stood> {
  const fixture = await loadPublicGeneForTargets();
  try {
    const mesh = fixture.mesh, find = (name: string) => mesh.skeleton.bones.find(b => b.name === name)!;
    const transform = reviewed ? undefined : new StageMotionRetarget(mesh, new StageModelProfile(mesh, { reviewed: false }).profile, { reviewed: false }).transform;
    const finger = find('左人指２'), restFinger = finger.quaternion.clone();
    const pose = await loadPoseClip(motion, async url => { assert.equal(url, REST); return standFor(mesh, transform); });
    const figure = new UnboundFigure(mesh, { xM: 0, depthM: 8 });
    figure.setClips({ pose, gesture: null, expression: null }, motion.legacy);
    figure.setBreath(0.5);
    const heads: Vector3[] = [], chest: Quaternion[] = [];
    for (let i = 0; i <= 60 * 7; i++) {
      figure.frame(i ? 1 / 60 : 0);
      if (i >= 180) { heads.push(find('頭').getWorldPosition(new Vector3())); chest.push(find('上半身').getWorldQuaternion(new Quaternion())); }
    }
    const at = (bone: Bone) => bone.getWorldPosition(new Vector3());
    const arm = at(find('左ひじ')).sub(at(find('左腕'))), fore = at(find('左手首')).sub(at(find('左ひじ')));
    const range = (axis: 'x' | 'y' | 'z') => Math.max(...heads.map(h => h[axis])) - Math.min(...heads.map(h => h[axis]));
    const out = {
      armDropDeg: Math.atan2(-arm.y, Math.hypot(arm.x, arm.z)) * DEG, elbowDeg: arm.angleTo(fore) * DEG, fingerDeg: finger.quaternion.angleTo(restFinger) * DEG,
      chestSwayDeg: Math.max(...chest.map(q => q.angleTo(chest[0]!))) * DEG, headRangeMm: Math.max(range('x'), range('y'), range('z')) * 80,
      comMargin: figure.report?.comMargin ?? null, planted: !!figure.report?.feet.every(f => f.planted),
    };
    figure.dispose();
    return out;
  } finally { fixture.close(); }
}

test('Gene with no pose layer stands in the default stand, not the bind pose, reviewed or not', async () => {
  const none: UnboundMotion = { pose: null, gesture: null, expression: null, legacy: true };
  const before = await stand(none, true);
  // Before the fix (what the user saw): the bind pose with only the arms-down residual: straight elbows and fingers, no sway.
  assert.ok(before.elbowDeg < 5 && before.fingerDeg < 0.5 && before.chestSwayDeg < 0.05, JSON.stringify(before));
  for (const reviewed of [true, false]) {
    const after = await stand(withRestPose(none, REST), reviewed);
    assert.ok(after.armDropDeg > before.armDropDeg + 3, `arms hang lower (${after.armDropDeg.toFixed(1)}° vs ${before.armDropDeg.toFixed(1)}°)`);
    assert.ok(after.elbowDeg > 8, `elbows soften (${after.elbowDeg.toFixed(1)}°)`);
    assert.ok(after.fingerDeg > 5, `fingers relax (${after.fingerDeg.toFixed(1)}°)`);
    assert.ok(after.chestSwayDeg > 0.5, `she sways (${after.chestSwayDeg.toFixed(2)}°)`);
    assert.ok(after.headRangeMm > before.headRangeMm, 'her head moves more than with breath alone');
    assert.ok(after.planted && after.comMargin !== null && after.comMargin > 0.03, `on both feet, balanced (${JSON.stringify(after)})`);
  }
});

/** Largest per-frame step (deg) of the tracked bones over a pose switch at t = 2 s, and the largest change of that step (R29c's "unexpected step"). */
async function switchSteps(fps: number, from: 'none' | 'stand', to: 'none' | 'stand') {
  const fixture = await loadPublicGeneForTargets();
  try {
    const mesh = fixture.mesh, stand = await standFor(mesh);
    const figure = new UnboundFigure(mesh, { xM: 0, depthM: 8 });
    const clips = (k: string) => ({ pose: k === 'stand' ? stand : null, gesture: null, expression: null });
    figure.setClips(clips(from), from === 'none');
    const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
    let previous: Quaternion[] | null = null;
    const steps: number[] = [];
    for (let i = 0; i <= fps * 4; i++) {
      if (i === fps * 2) figure.setClips(clips(to), to === 'none');
      figure.frame(i ? 1 / fps : 0);
      const now = bones.map(b => b.getWorldQuaternion(new Quaternion()));
      if (previous) steps.push(Math.max(...now.map((q, k) => q.angleTo(previous![k]!) * DEG)));
      previous = now;
    }
    figure.dispose();
    const after = steps.slice(fps * 2 - 1);
    return { max: Math.max(...after), unexpected: Math.max(...after.slice(1).map((s, i) => Math.abs(s - after[i]!))), settled: after.at(-1)! };
  } finally { fixture.close(); }
}

test('a pose layer changing while she is shown glides there (60 and 30 fps), it never jumps', async () => {
  // Before: 75–86° on one frame at either rate.
  for (const fps of [60, 30]) for (const [from, to] of [['none', 'stand'], ['stand', 'none']] as const) {
    const s = await switchSteps(fps, from, to);
    assert.ok(s.max * fps < 130, `${fps} fps ${from}→${to}: at most ${(s.max * fps).toFixed(0)}°/s`);
    assert.ok(s.unexpected < (fps === 60 ? 0.12 : 0.4), `${fps} fps ${from}→${to}: unexpected step ${s.unexpected.toFixed(3)}°`);
    assert.ok(s.settled < 0.2, 'and it settles');
  }
});
