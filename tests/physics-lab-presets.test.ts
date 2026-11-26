// T-252: saving to the model reloads the physics lab (the host's onChanged); the A/B slots must stay usable through that reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropForeignPresets, usablePresetSlots } from '../src/stage/physics-lab/preset-store';

const preset = (rig: string) => ({ tuning: { rig } });

test('A and B stay usable after a reload of the same model (saving, 恢复原样)', () => {
  const presets = { A: preset('rig-1'), B: preset('rig-1') };
  dropForeignPresets(presets, 'rig-1');
  assert.deepEqual(usablePresetSlots(presets, 'rig-1'), ['A', 'B']);
});

test('a slot saved on another model is dropped, one filled slot stays', () => {
  const presets: Partial<Record<'A' | 'B', ReturnType<typeof preset>>> = { A: preset('rig-1'), B: preset('rig-2') };
  dropForeignPresets(presets, 'rig-1');
  assert.deepEqual(Object.keys(presets), ['A']);
  assert.deepEqual(usablePresetSlots(presets, 'rig-1'), ['A']);
  assert.deepEqual(usablePresetSlots({}, 'rig-1'), []);
});
