// The renderer golden (scripts/dev/renderer-golden.mjs; docs/claude/2026-11-16-src-main-split.md): per window, the ordered start-up
// subscriptions, DesktopAPI calls and constructions of src/main.ts, read across the renderer wiring files. Splitting src/main.ts must
// leave it unchanged; an intended change regenerates it (and says why in the commit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRendererGolden, importTimeEffects, RENDERER_GOLDEN_FILE } from '../scripts/dev/renderer-golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGENERATE = 'regenerate with `node scripts/dev/renderer-golden.mjs --write` only if the change is intended, and say why in the commit';
const live = buildRendererGolden(ROOT);

test('the renderer wiring matches the golden (tests/fixtures/renderer-golden.json)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, RENDERER_GOLDEN_FILE), 'utf8'));
  for (const key of Object.keys(golden)) assert.deepEqual(live[key], golden[key], `renderer golden: "${key}" changed; ${REGENERATE}`);
  assert.deepEqual(Object.keys(live).sort(), Object.keys(golden).sort(), `renderer golden: sections changed; ${REGENERATE}`);
});

test('nothing in src/wiring runs on import (the entry decides the window first)', () => {
  assert.deepEqual(importTimeEffects(ROOT), []);
});

test('the golden is not empty where it matters', () => {
  assert.ok(live.subscriptions.pet.includes('onStream') && live.subscriptions.controls.includes('onStream'));
  assert.ok(live.subscriptions.pet.includes('onPetFramingRequest') && !live.subscriptions.controls.includes('onPetFramingRequest'));
  assert.ok(live.startup.controls.includes('call:renderControls') && !live.startup.pet.includes('call:renderControls'));
  assert.ok(live.startup.pet.includes('call:renderPet') && !live.startup.controls.includes('call:renderPet'));
  assert.ok(live.counts.petSubscriptions > 30 && live.counts.controlSubscriptions > 30);
});
