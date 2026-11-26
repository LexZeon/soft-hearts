// I-154 batch 1, rows 40 + 41「物理」「果冻」(docs/claude/2026-11-19-unbound-in-window.md): the control window's hair / chest switches and the
// physics lab's live values reach Unbound's figure in the window (src/unbound/window-mode/window-physics.ts) as on the old stage:
//  - the settings are taken as given: nothing starts unless the user's saved switch says so, a partial update keeps the saved choice,
//    碰了才软 is exactly what the host resolved (off when absent; the stable channel's "off until you turn it on" is the host's);
//  - the physics loads only when wanted and shown, a late load for a gone model or older switches is dropped, switched off it fades in place;
//  - on the real Gene with the real Ammo, hair physics switched on and off at 60 and 30 fps: her hair moves, and nothing jumps.
// `PHYSICS_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, type SkinnedMesh } from 'three';
import { WindowPhysics, ENGINE_PHYSICS_RUNTIME, type WindowPhysicsFigure, type WindowPhysicsRuntime } from '../src/unbound/window-mode/window-physics';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings } from '../shared/stage';
import { loadAmmoForTests } from './helpers/ammo-node';
import { DEG, frameSteps, surprises, windowGene } from './helpers/unbound-window';

const REPORT = process.env.PHYSICS_REPORT === '1';
const OFF = normalizeModelPhysicsSettings(undefined);
const HAIR_ON: ModelPhysicsSettings = { ...OFF, hair: { enabled: true, strength: 0.65 } };
type Support = { supported: boolean; bones: number; bodies: number; reason: string | null };
const supported: Support = { supported: true, bones: 10, bodies: 10, reason: null }, unsupported: Support = { supported: false, bones: 0, bodies: 0, reason: 'none' };

function fakes(support = { hair: supported, chest: unsupported }) {
  const calls: string[] = [], jelly: (ModelPhysicsSettings['touchSoft'] | undefined)[] = [], made: { configure: ModelPhysicsSettings[] }[] = [];
  const pending: (() => void)[] = []; let loads = 0;
  const figure = (name: string): WindowPhysicsFigure => ({ mesh: { name } as unknown as SkinnedMesh,
    configureJelly: s => { jelly.push(s.touchSoft); }, attachPhysics: p => { calls.push(`${name} attach ${p ? 'physics' : 'null'}`); }, hidePhysics: () => { calls.push(`${name} hide`); } });
  const runtime: WindowPhysicsRuntime = {
    loadAmmo: () => { loads++; return new Promise(resolve => { pending.push(() => resolve({ destroy() {} })); }); },
    support: () => support,
    make: () => { const p = { configure: [] as ModelPhysicsSettings[] }; made.push(p); return { configure: (s: ModelPhysicsSettings) => p.configure.push(s) } as never; },
    outputBones: () => ({ hair: [1, 2], chest: [3] }),
  };
  return { calls, jelly, made, figure, runtime, loads: () => loads, release: async () => { for (const go of pending.splice(0)) go(); await new Promise(r => setImmediate(r)); } };
}

test('window physics: the saved switches win: off stays off (no Ammo), on starts it once, a partial update keeps the choice, off fades in place', async () => {
  // Not awaited: a load the fake never finishes would hang the test instead of failing it (an unwanted load is counted below).
  const f = fakes(), physics = new WindowPhysics(f.runtime);
  void physics.attach(f.figure('a'));
  void physics.set(OFF);
  assert.equal(f.loads(), 0, 'every switch off: the physics runtime is never loaded');
  assert.equal(physics.running, false);
  void physics.set(HAIR_ON);
  assert.equal(f.loads(), 1);
  await f.release();
  assert.equal(physics.running, true);
  assert.deepEqual(f.calls, ['a attach physics']);
  await physics.set({ quality: 'high' } as ModelPhysicsSettings); // a partial update (the old stage's normalize: missing fields keep the last valid)
  assert.equal(physics.settings.hair.enabled, true, 'the saved hair choice is kept');
  assert.equal(physics.settings.quality, 'high');
  await physics.set({ ...HAIR_ON, hair: { enabled: false, strength: 0.65 } });
  assert.equal(f.made[0].configure.at(-1)!.hair.enabled, false, 'switched off: the running physics is told (it fades itself out)');
  assert.ok(!f.calls.includes('a attach null'), 'never torn off at once (that would snap her hair)');
  assert.deepEqual(physics.outputBones(), [], 'nothing it moves counts for the pace once off');
  assert.equal(f.loads(), 1, 'no second load');
});

test('window physics: 碰了才软 is exactly what the host resolved; the window never turns it on by itself', async () => {
  const f = fakes(), physics = new WindowPhysics(f.runtime);
  void physics.attach(f.figure('a'));
  assert.equal(f.jelly.at(-1), undefined, 'nothing from the host yet: absent (off)');
  void physics.set({ ...OFF, touchSoft: { enabled: false, strength: 1 } }); // stable, never turned on: the host resolves off
  assert.deepEqual(f.jelly.at(-1), { enabled: false, strength: 1 });
  void physics.set({ ...OFF, touchSoft: { enabled: true, strength: 1.4 } }); // the user turned it on in the lab
  assert.deepEqual(f.jelly.at(-1), { enabled: true, strength: 1.4 });
  void physics.set(OFF); // an update without it: off (only from the value itself, as the old stage)
  assert.equal(f.jelly.at(-1), undefined);
  void physics.attach(f.figure('b')); // a new model gets the current value, not an older one
  assert.equal(f.jelly.at(-1), undefined);
  assert.equal(f.loads(), 0);
});

test('window physics: loads only when wanted and shown; a late load for a gone model or older switches is dropped; hidden pauses it', async () => {
  const f = fakes(), physics = new WindowPhysics(f.runtime);
  physics.setShown(false);
  await physics.attach(f.figure('a'));
  await physics.set(HAIR_ON);
  assert.equal(f.loads(), 0, 'hidden: not loaded');
  physics.setShown(true);
  assert.equal(f.loads(), 1, 'shown: now');
  void physics.attach(f.figure('b')); // the model changed while it loaded (b loads its own)
  await f.release();
  assert.ok(!f.calls.includes('a attach physics'), 'the old model does not get it');
  assert.deepEqual(f.calls, ['b attach physics'], 'the model shown now does');
  void physics.attach(f.figure('c'));
  assert.equal(f.loads(), 3);
  void physics.set(OFF); // switched off while it loaded
  await f.release();
  assert.ok(!f.calls.includes('c attach physics'), 'switched off meanwhile: dropped');
  assert.equal(physics.running, false);
  void physics.set(HAIR_ON);
  await f.release();
  assert.ok(f.calls.includes('c attach physics'));
  physics.setShown(false);
  assert.ok(f.calls.includes('c hide'), 'hidden: paused');
  const g = fakes({ hair: unsupported, chest: unsupported }), other = new WindowPhysics(g.runtime);
  await other.attach(g.figure('c')); await other.set(HAIR_ON);
  assert.equal(g.loads(), 0, 'a model without a supported part: never loaded');
});

// ---- the real Gene with the real Ammo ------------------------------------------------------------------------------------------------

const NODE_RUNTIME: WindowPhysicsRuntime = { ...ENGINE_PHYSICS_RUNTIME, loadAmmo: loadAmmoForTests };

for (const fps of [60, 30]) {
  test(`window physics on Gene (${fps} fps): hair switched on at 2 s and off at 6 s moves her hair and never jumps`, async t => {
    const run = async (withPhysics: boolean) => {
      const g = await windowGene(), physics = new WindowPhysics(NODE_RUNTIME);
      try {
        await physics.attach(g.figure);
        const hair = ENGINE_PHYSICS_RUNTIME.outputBones(g.fixture.mesh).hair.map(i => g.fixture.mesh.skeleton.bones[i]);
        const frames: { t: number; hair: Quaternion[]; body: Quaternion[] }[] = [];
        for (let frame = 0; frame <= fps * 10; frame++) {
          const time = frame / fps;
          if (withPhysics && frame === 2 * fps) await physics.set(HAIR_ON);
          if (withPhysics && frame === 6 * fps) await physics.set({ ...HAIR_ON, hair: { enabled: false, strength: 0.65 } });
          // A small sway of her body (the cursor), so the hair has something to follow.
          g.body.frame(frame ? 1 / fps : 0, { pointer: { x: Math.sin(time * 1.7) * 0.9, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false });
          frames.push({ t: time, hair: hair.map(b => b.getWorldQuaternion(new Quaternion())), body: g.rotations() });
        }
        return { frames, running: physics.running };
      } finally { g.close(); }
    };
    const [control, on] = [await run(false), await run(true)];
    const window = (frames: typeof on.frames, from: number, to: number, key: 'hair' | 'body') => frames.filter(f => f.t >= from && f.t <= to).map(f => f[key]);
    const moved = Math.max(...on.frames.map((f, i) => Math.max(...f.hair.map((q, b) => q.angleTo(control.frames[i].hair[b]) * DEG))));
    const hairOwn = surprises(window(control.frames, 1, 10, 'hair')).perFrame;
    const hairOn = surprises(window(on.frames, 1.9, 3, 'hair')).perFrame, hairOff = surprises(window(on.frames, 5.9, 8, 'hair')).perFrame;
    const hairRunning = surprises(window(on.frames, 3, 5.9, 'hair')).perFrame;
    const bodyDiff = Math.max(...on.frames.map((f, i) => Math.max(...f.body.map((q, b) => q.angleTo(control.frames[i].body[b]) * DEG))));
    const steps = { on: Math.max(...frameSteps(window(on.frames, 1.9, 3, 'hair'))), off: Math.max(...frameSteps(window(on.frames, 5.9, 8, 'hair'))), own: Math.max(...frameSteps(window(control.frames, 1, 10, 'hair'))) };
    const after = Math.max(...on.frames.at(-1)!.hair.map((q, b) => q.angleTo(control.frames.at(-1)!.hair[b]) * DEG));
    const numbers = { hairMovedDeg: +moved.toFixed(2), surprise: { own: +Math.max(...hairOwn).toFixed(3), switchOn: +Math.max(...hairOn).toFixed(3), running: +Math.max(...hairRunning).toFixed(3), switchOff: +Math.max(...hairOff).toFixed(3) },
      stepDeg: { own: +steps.own.toFixed(3), switchOn: +steps.on.toFixed(3), switchOff: +steps.off.toFixed(3) }, bodyDiffDeg: +bodyDiff.toFixed(4), hairAfterOffDeg: +after.toFixed(3) };
    if (REPORT) console.log(`[window physics ${fps}] ${JSON.stringify(numbers)}`);
    t.diagnostic(JSON.stringify(numbers));
    assert.ok(moved > 1, `her hair moves with physics on (${moved.toFixed(2)}°)`);
    // Switching on and off is not a jump: no worse than the physics' own running motion.
    // Switching is the physics' own 0.22 s linear fade (LocalModelPhysics, the same class and the same numbers as the old stage): a short
    // ease, never a snap. A snap (the physics torn off at once) would be the whole swing in one frame (about the hair moved above).
    const snap = fps === 60 ? 1.5 : 3;
    assert.ok(Math.max(...hairOn) <= snap, `switched on: ${Math.max(...hairOn).toFixed(3)}°`);
    assert.ok(Math.max(...hairOff) <= snap, `switched off: ${Math.max(...hairOff).toFixed(3)}°`);
    assert.ok(after < 0.5, `faded out by 4 s after (${after.toFixed(3)}°)`);
    assert.ok(bodyDiff < 0.05, `her body is not touched by the hair physics (${bodyDiff}°)`);
  });
}
