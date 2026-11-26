/**
 * I-147 全身果冻: the jelly part of a model's lab tuning (shared/stage/jelly-tuning.ts) and its trip through the sidecar.
 * - Every knob is clamped; a layer is on only with a real `true`; unknown fields are dropped.
 * - The sidecar (physics-tuning.json) round-trips the new fields per model hash; a hand-edited file is clamped on load.
 * - The jelly part never counts as a physics change (the hair/chest worlds are not rebuilt for it, a jelly-only tuning is neutral).
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhysicsTuningStore, PHYSICS_TUNING_FILE } from '../electron/stage/physics-tuning-store';
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { isNeutralTuning, normalizeModelPhysicsTuning, tuningSignature } from '../shared/stage/physics-tuning';
import { FOLLOW_DEFAULTS, JELLY_BOUNDS, SOFT_DEFAULTS, defaultJellyTuning, jellyOff, normalizeJellyTuning } from '../shared/stage/jelly-tuning';

const KEY = 'c'.repeat(64);
const tuning = (extra: Record<string, unknown> = {}) => ({ version: 1, rig: '87/92/224', substepHz: 65, collisions: { chestArms: false, hairBody: true }, groups: {}, ...extra });

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-jelly-tuning-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('every jelly knob is clamped, a layer is on only with a real true, unknown fields are dropped', () => {
  const value = normalizeJellyTuning({
    follow: { enabled: 'true', regions: { head: { hz: 99, damping: -1, maxDeg: 400 }, arms: { maxDeg: NaN }, tail: { hz: 1 } } },
    soft: { enabled: true, evil: 1, regions: { belly: { enabled: 'no', hz: 0, damping: 9, maxOffset: 5, radius: 0, falloff: 100, gain: -3 }, cheeks: { enabled: false } } },
  });
  assert.equal(value.follow.enabled, false, 'only a real boolean switches a layer on');
  assert.equal(value.soft.enabled, true);
  assert.deepEqual(value.follow.regions.head, { hz: JELLY_BOUNDS.hz[1], damping: JELLY_BOUNDS.damping[0], maxDeg: JELLY_BOUNDS.maxDeg[1] });
  assert.equal(value.follow.regions.arms.maxDeg, FOLLOW_DEFAULTS.arms.maxDeg);
  assert.equal('tail' in value.follow.regions, false);
  assert.deepEqual(value.soft.regions.belly, { enabled: SOFT_DEFAULTS.belly.enabled, hz: JELLY_BOUNDS.hz[0], damping: JELLY_BOUNDS.damping[1],
    maxOffset: JELLY_BOUNDS.maxOffset[1], radius: JELLY_BOUNDS.radius[0], falloff: JELLY_BOUNDS.falloff[1], gain: JELLY_BOUNDS.gain[0] });
  assert.equal(value.soft.regions.cheeks.enabled, false);
  assert.equal('evil' in value.soft, false);
  assert.ok(JELLY_BOUNDS.maxDeg[1] <= 10 && JELLY_BOUNDS.maxOffset[1] <= 0.3, 'the bounds themselves stay modest');
  assert.equal(jellyOff(defaultJellyTuning()), true, 'the defaults are off');
  assert.equal(jellyOff(undefined), true);
});

test('the jelly part rides in the model tuning and the pet settings; absent stays absent', () => {
  assert.equal('jelly' in normalizeModelPhysicsTuning(tuning())!, false);
  const withJelly = normalizeModelPhysicsTuning(tuning({ jelly: { follow: { enabled: true } } }))!;
  assert.equal(withJelly.jelly!.follow.enabled, true);
  assert.equal(withJelly.jelly!.soft.enabled, false);
  assert.equal(normalizeModelPhysicsSettings({ tuning: tuning({ jelly: { soft: { enabled: true } } }) }).tuning!.jelly!.soft.enabled, true);
});

test('the jelly part never counts as a physics change: no world rebuild, and a jelly-only tuning is neutral for the physics', () => {
  const plain = normalizeModelPhysicsTuning(tuning({ substepHz: 120 }))!;
  const jelly = normalizeModelPhysicsTuning(tuning({ substepHz: 120, jelly: { follow: { enabled: true }, soft: { enabled: true } } }))!;
  assert.equal(tuningSignature(jelly), tuningSignature(plain));
  assert.equal(isNeutralTuning(normalizeModelPhysicsTuning(tuning({ jelly: { follow: { enabled: true } } }))), true);
});

test('the sidecar round-trips the jelly fields per model hash; a hand-edited file is clamped on load', async t => {
  const dir = await directory(t);
  const store = new PhysicsTuningStore(dir);
  await store.load();
  await store.set(KEY, tuning({ jelly: { follow: { enabled: true, regions: { arms: { maxDeg: 4 } } }, soft: { enabled: true, regions: { cheeks: { hz: 5, falloff: 2 } } } } }));
  const again = new PhysicsTuningStore(dir); await again.load();
  const jelly = again.get(KEY)!.jelly!;
  assert.equal(jelly.follow.enabled, true);
  assert.equal(jelly.follow.regions.arms.maxDeg, 4);
  assert.equal(jelly.soft.regions.cheeks.hz, 5);
  assert.equal(jelly.soft.regions.cheeks.falloff, 2);
  await writeFile(path.join(dir, PHYSICS_TUNING_FILE), JSON.stringify({ version: 1, models: [{ modelKey: KEY,
    tuning: tuning({ jelly: { follow: { enabled: true, regions: { head: { maxDeg: 90 } } }, soft: { enabled: true, regions: { belly: { maxOffset: 3 } } } } }) }] }));
  const edited = new PhysicsTuningStore(dir); await edited.load();
  assert.equal(edited.get(KEY)!.jelly!.follow.regions.head.maxDeg, JELLY_BOUNDS.maxDeg[1]);
  assert.equal(edited.get(KEY)!.jelly!.soft.regions.belly.maxOffset, JELLY_BOUNDS.maxOffset[1]);
});

test('a holder (Unbound) gets a jelly object only once a tuning turns a layer on, and keeps it to fade out', async () => {
  const { StageJelly } = await import('../src/stage/model-physics');
  const off = normalizeModelPhysicsTuning(tuning({ jelly: {} }))!, on = normalizeModelPhysicsTuning(tuning({ jelly: { soft: { enabled: true } } }))!;
  assert.equal(StageJelly.next(null, undefined), null);
  assert.equal(StageJelly.next(null, off), null, 'layers off: nothing is created');
  const jelly = StageJelly.next(null, on);
  assert.ok(jelly);
  assert.equal(StageJelly.next(jelly, off), jelly, 'switched off: the same object stays to fade out (the frame drops it when idle)');
  assert.equal(jelly!.idle, true, 'nothing ran, and the tuning turns nothing on: idle');
});
