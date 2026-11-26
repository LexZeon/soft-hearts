// I-136 Unbound v1 step 5d「碰了才软」(src/stage/jelly/soft-jelly.ts press / hold, stage-jelly.ts, src/stage/pull/soft-touch.ts):
// the touched soft region dents within layer 3's own cap and springs back from what shows; off (or nowhere soft) touches nothing; with
// the switch on but no touch, no material is patched and no vertex data is added; after the touch settles both go again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, type Material } from 'three';
import { SOFT_DEFAULTS, normalizeJellyTuning, resolveTouchSoft } from '../shared/stage/jelly-tuning';
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { SoftJelly } from '../src/stage/jelly/soft-jelly';
import { StageJelly } from '../src/stage/jelly/stage-jelly';
import { JELLY_REGION_ATTRIBUTE } from '../src/stage/jelly/soft-shader';
import { syntheticBody } from './helpers/jelly-body';

const INTO = new Vector3(0, 0, -1); // the camera looks at her face (+z) along -z
const patched = (materials: Material[]) => materials.some(material => Object.hasOwn(material, 'onBeforeCompile'));

test('off: a press touches nothing (no patch, no vertex data); on but untouched: the same', () => {
  const { mesh } = syntheticBody();
  const layer = new SoftJelly(mesh, false);
  const belly = layer.regions.findIndex(region => region.kind === 'belly');
  const centre = new Vector3().fromArray(layer.regions[belly].center);
  assert.equal(layer.press(centre, INTO), -1, 'the switch is off');
  layer.configureTouch(true);
  for (let i = 0; i < 20; i++) layer.update(1 / 60);
  assert.equal(mesh.geometry.getAttribute(JELLY_REGION_ATTRIBUTE), undefined, 'on, untouched: no vertex data');
  assert.equal(patched(mesh.material as Material[]), false, 'on, untouched: no material patched');
  assert.equal(layer.idle, true);
  assert.equal(layer.press(new Vector3(40, 40, 40), INTO), -1, 'nowhere soft');
});

test('a press dents only the touched region, within the cap; it springs back, and the patch and vertex data go again', () => {
  const { mesh } = syntheticBody();
  const layer = new SoftJelly(mesh, false);
  layer.configureTouch(true, 2);
  const belly = layer.regions.findIndex(region => region.kind === 'belly'), info = layer.regions[belly];
  assert.equal(layer.press(new Vector3().fromArray(info.center), INTO), belly);
  let peak = 0, others = 0, steps: number[] = [], last = 0;
  for (let i = 0; i < 240; i++) {
    layer.update(1 / 60);
    const shown = layer.shownOffsets(), size = shown[belly].length() / info.radius;
    peak = Math.max(peak, size); steps.push(Math.abs(size - last)); last = size;
    shown.forEach((offset, r) => { if (r !== belly) others = Math.max(others, offset.length()); });
    if (i === 3) assert.ok(patched(mesh.material as Material[]) && mesh.geometry.getAttribute(JELLY_REGION_ATTRIBUTE), 'touched: patched while it shows');
  }
  assert.ok(peak > 0.01, `it dents (${peak.toFixed(4)} of its size)`);
  assert.ok(peak <= SOFT_DEFAULTS.belly.maxOffset + 1e-9, `never past layer 3's cap ${SOFT_DEFAULTS.belly.maxOffset} (${peak.toFixed(4)}), even at strength 2`);
  assert.equal(others, 0, 'no other region moves');
  assert.ok(Math.max(...steps) < 0.4 * peak, 'it builds over frames (fades in), never one jump');
  assert.equal(layer.idle, true, 'settled');
  assert.equal(mesh.geometry.getAttribute(JELLY_REGION_ATTRIBUTE), undefined, 'settled: the vertex data is gone');
  assert.equal(patched(mesh.material as Material[]), false, 'settled: the materials are as they were');
});

test('holding moves the rest point (capped); letting go eases back from what shows, no jump', () => {
  const { mesh } = syntheticBody();
  const layer = new SoftJelly(mesh, false);
  layer.configureTouch(true);
  const arm = layer.regions.findIndex(region => region.kind === 'upperArms'), info = layer.regions[arm];
  layer.press(new Vector3().fromArray(info.center), INTO);
  let held = 0;
  for (let i = 0; i < 90; i++) { layer.hold(arm, new Vector3(100, 0, 0)); layer.update(1 / 60); held = layer.shownOffsets()[arm].length() / info.radius; }
  assert.ok(held > 0.01 && held <= SOFT_DEFAULTS.upperArms.maxOffset, `held within the cap (${held.toFixed(4)})`);
  layer.hold(arm, null);
  let previous = held, jump = 0;
  for (let i = 0; i < 240; i++) { layer.update(1 / 60); const now = layer.shownOffsets()[arm].length() / info.radius; jump = Math.max(jump, Math.abs(now - previous)); previous = now; }
  assert.ok(jump < 0.25 * held, `let go: eases back (largest frame step ${jump.toFixed(5)} vs held ${held.toFixed(4)})`);
  assert.ok(previous < 1e-4 * held + 1e-9);
});

test('the stage holder: the switch keeps the object (nothing built); a touch builds layer 3 only then; a pinch finds her cheek', () => {
  const { mesh } = syntheticBody();
  assert.equal(StageJelly.next(null, null, { enabled: false, strength: 1 }), null, 'off and no tuning: no object at all (as before)');
  const jelly = StageJelly.next(null, null, { enabled: true, strength: 1 })!;
  assert.ok(jelly && !jelly.idle && jelly.touchEnabled);
  jelly.frame(mesh, 1 / 60);
  assert.equal(jelly.softLayer, null, 'no touch yet: layer 3 is not built');
  const cheek = jelly.touchPressKind('cheeks', 1, INTO);
  const built = (jelly as StageJelly).softLayer as SoftJelly | null;
  assert.ok(cheek >= 0 && built?.regions[cheek].kind === 'cheeks' && built.regions[cheek].side === 1, 'her left cheek');
  for (let i = 0; i < 300; i++) jelly.frame(mesh, 1 / 60);
  assert.equal(jelly.softLayer, null, 'settled: layer 3 is dropped again');
  jelly.configureTouch(false);
  assert.equal(jelly.touchPress(new Vector3(), INTO), -1, 'switched off: no touch');
});

test('the switch: the lab\'s choice wins; unset follows the channel (on in development and source runs, off in stable); settings carry it only from the value', () => {
  assert.deepEqual(resolveTouchSoft(null, true), { enabled: true, strength: 1 });
  assert.deepEqual(resolveTouchSoft(null, false), { enabled: false, strength: 1 });
  const saved = normalizeJellyTuning({ touch: { enabled: false, strength: 9 } });
  assert.deepEqual(resolveTouchSoft(saved, true), { enabled: false, strength: 2 }, 'the lab said off; strength clamped');
  assert.equal(normalizeJellyTuning({}).touch, undefined, 'nothing saved: no field (old tunings unchanged)');
  assert.deepEqual(normalizeJellyTuning({ touch: { enabled: 'yes' } }).touch, { enabled: null, strength: 1 }, 'not a boolean: the channel decides');
  assert.deepEqual(normalizeModelPhysicsSettings({ touchSoft: { enabled: true, strength: 5 } }).touchSoft, { enabled: true, strength: 2 });
  assert.equal(normalizeModelPhysicsSettings({}, { touchSoft: { enabled: true, strength: 1 } }).touchSoft, undefined, 'never from the previous value');
});
