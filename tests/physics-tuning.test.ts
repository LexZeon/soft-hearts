/**
 * R01 物理调参台 (docs/claude/2026-11-17-physics-lab.md): the per-model tuning and its sidecar.
 * - Values are clamped and unknown fields dropped, wherever they come from (file, renderer, lab).
 * - The sidecar is keyed by the model's content hash, round-trips, and "恢复原样" removes one model's entry.
 * - It never rides in the physics switches' file, a character card or its export.
 * - With no tuning (or after removing it) the stage builds exactly the plan it built before the lab.
 * - The lab's gates (developer mode; its own main frame) and its preload whitelist.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MeshBasicMaterial } from 'three';
import { PhysicsTuningStore, PHYSICS_TUNING_FILE } from '../electron/stage/physics-tuning-store';
import { ModelPhysicsSettingsStore } from '../electron/stage/model-physics-settings';
import { labAllowed, labSenderAllowed } from '../electron/stage/physics-lab-guard';
import { createPhysicsLabApi } from '../electron/stage/physics-lab-preload-api';
import { DATA_MAP } from '../electron/foundation/data-map';
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { PHYSICS_LAB_API_KEYS, PHYSICS_LAB_EVENTS, PHYSICS_LAB_REQUESTS } from '../shared/stage/physics-lab';
import { isNeutralTuning, normalizeModelPhysicsTuning, type ModelPhysicsTuning } from '../shared/stage/physics-tuning';
import { LocalModelPhysics } from '../src/stage/model-physics';
import { buildPhysicsRigPlan, physicsRigSignature } from '../src/stage/physics-rig';
import { physicsGroups } from '../src/stage/physics-lab/groups';
import { loadAmmoForTests } from './helpers/ammo-node';
import { GENE_PMX, loadPmxMesh, runScenario } from './helpers/physics-lab-run';

const KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64);
const tuning = (groups: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ version: 1, rig: '87/92/224', substepHz: 65, collisions: { chestArms: false, hairBody: true }, groups, ...extra });

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-physics-tuning-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('every knob is clamped, unknown fields and bad group ids are dropped, and a wrong shape is refused', () => {
  const value = normalizeModelPhysicsTuning(tuning({
    'hair:4': { enabled: 'yes', strength: 7, engine: 'bullet', ammo: { damping: 99, spring: -3, angleLimit: 0, gravity: Infinity, mass: 1e9, evil: 1 },
      springBone: { elastic: 4, damping: -1, angleLimit: 900, gravity: 2, inertia: NaN } },
    'skirt:9': { enabled: false }, 'hair:../x': {}, 'chest:189': { engine: 'spring' },
  }, { substepHz: 10_000, collisions: { chestArms: 'true', hairBody: false }, path: 'C:/secret.pmx' }))!;
  assert.ok(value);
  assert.deepEqual(Object.keys(value.groups).sort(), ['chest:189', 'hair:4']);
  const hair = value.groups['hair:4'];
  assert.equal(hair.enabled, true, 'only a real boolean switches off');
  assert.equal(hair.strength, 1);
  assert.equal(hair.engine, 'ammo');
  assert.deepEqual(hair.ammo, { damping: 4, spring: 0, angleLimit: 0.25, gravity: 1, mass: 10 });
  assert.deepEqual(hair.springBone, { elastic: 1, damping: 0, angleLimit: 90, gravity: 1, inertia: 0.85 });
  assert.equal(value.groups['chest:189'].engine, 'spring');
  assert.equal(value.substepHz, 240);
  assert.deepEqual(value.collisions, { chestArms: false, hairBody: false });
  assert.equal('path' in value, false);
  for (const bad of [null, {}, { version: 2, rig: '1/2/3' }, tuning({}, { rig: 'C:/model.pmx' }), tuning({}, { rig: 12 })]) assert.equal(normalizeModelPhysicsTuning(bad), null);
});

test('the sidecar round-trips per model hash, removes one model, and a bad key or a missing file never creates anything', async t => {
  const dir = await directory(t);
  const store = new PhysicsTuningStore(dir);
  await store.load();
  assert.equal(store.get(KEY_A), null);
  assert.deepEqual(await readdir(dir), [], 'reading never creates the file');
  await assert.rejects(store.set('not-a-hash', tuning()), /内容身份/);
  await store.set(KEY_A, tuning({ 'hair:4': { ammo: { damping: 0.5 } } }));
  await store.set(KEY_B, tuning({ 'hair:4': { engine: 'spring' } }));
  const again = new PhysicsTuningStore(dir); await again.load();
  assert.equal(again.get(KEY_A)!.groups['hair:4'].ammo.damping, 0.5);
  assert.equal(again.get(KEY_B)!.groups['hair:4'].engine, 'spring');
  assert.equal(await again.remove(KEY_A), true);
  assert.equal(again.get(KEY_A), null);
  assert.ok(again.get(KEY_B), 'the other model keeps its tuning');
  assert.equal(await again.remove(KEY_A), false);
  const stored = JSON.parse(await readFile(path.join(dir, PHYSICS_TUNING_FILE), 'utf8'));
  assert.deepEqual(stored.models.map((row: { modelKey: string }) => row.modelKey), [KEY_B]);
  // A hand-edited file is clamped on load.
  await writeFile(path.join(dir, PHYSICS_TUNING_FILE), JSON.stringify({ version: 1, models: [{ modelKey: KEY_A, tuning: tuning({ 'hair:4': { ammo: { mass: 1e12 } } }) }, { modelKey: '../x', tuning: tuning() }] }));
  const edited = new PhysicsTuningStore(dir); await edited.load();
  assert.equal(edited.get(KEY_A)!.groups['hair:4'].ammo.mass, 10);
  assert.equal(edited.get('../x'), null);
  await writeFile(path.join(dir, PHYSICS_TUNING_FILE), '{broken');
  const broken = new PhysicsTuningStore(dir); await broken.load();
  assert.equal(broken.get(KEY_A), null);
});

test('the physics switches file never carries a tuning, even when one is handed to it', async t => {
  const dir = await directory(t);
  const file = path.join(dir, 'physics-settings.json');
  const store = new ModelPhysicsSettingsStore(file);
  await store.load();
  const saved = await store.persist({ hair: { enabled: true }, tuning: tuning() });
  assert.equal('tuning' in saved, false);
  assert.equal((await readFile(file, 'utf8')).includes('tuning'), false);
  await writeFile(file, JSON.stringify({ version: 1, settings: { hair: { enabled: true, strength: 0.5 }, tuning: tuning() } }));
  const loaded = await new ModelPhysicsSettingsStore(file).load();
  assert.equal('tuning' in loaded, false);
});

test('the sidecar is in the data map as never exported with a card, and no card code reads it', () => {
  const rows = DATA_MAP.filter(row => (row.paths as readonly string[]).includes(PHYSICS_TUNING_FILE));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cardExport, 'never');
  const cards = path.join(import.meta.dirname, '..', 'electron', 'cards');
  for (const name of readdirSync(cards, { recursive: true }) as string[]) {
    if (!name.endsWith('.ts')) continue;
    assert.equal(readFileSync(path.join(cards, name), 'utf8').includes('physics-tuning'), false, `electron/cards/${name} does not touch the tuning`);
  }
});

test('the settings carry a tuning only when the value itself has one (never inherited), so removing it really removes it', () => {
  const plain = normalizeModelPhysicsSettings({ hair: { enabled: true } });
  assert.equal('tuning' in plain, false);
  const withTuning = normalizeModelPhysicsSettings({ tuning: tuning() }, plain);
  assert.ok(withTuning.tuning);
  assert.equal('tuning' in normalizeModelPhysicsSettings({ hair: { strength: 0.3 } }, withTuning), false, 'absent: none');
  assert.equal('tuning' in normalizeModelPhysicsSettings({ tuning: null }, withTuning), false, 'null: none');
  assert.equal(normalizeModelPhysicsSettings({ hair: { strength: 0.3 } }, withTuning).hair.enabled, true, 'the switches still merge');
});

test('the lab opens only in developer mode and answers only its own main frame; its preload is a fixed whitelist', async () => {
  assert.throws(() => labAllowed(false), /开发者模式/);
  assert.doesNotThrow(() => labAllowed(true));
  const frame = {}, contents = { id: 7, mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: contents };
  assert.equal(labSenderAllowed(win, contents, frame), true);
  assert.equal(labSenderAllowed(win, contents, {}), false, 'a subframe');
  assert.equal(labSenderAllowed(win, { id: 1, mainFrame: frame }, frame), false, 'another window');
  assert.equal(labSenderAllowed(null, contents, frame), false);
  assert.equal(labSenderAllowed({ isDestroyed: () => true, webContents: contents }, contents, frame), false);
  const calls: unknown[][] = [];
  const api = createPhysicsLabApi({ invoke: async (...args) => { calls.push(args); return null; }, on: () => {}, removeListener: () => {} });
  assert.deepEqual(Object.keys(api).sort(), [...PHYSICS_LAB_API_KEYS].sort());
  await api.getModel(); await api.save(tuning() as ModelPhysicsTuning); await api.clear();
  assert.deepEqual(calls.map(call => call[0]), [PHYSICS_LAB_REQUESTS.model, PHYSICS_LAB_REQUESTS.save, PHYSICS_LAB_REQUESTS.clear]);
  assert.ok(Object.values({ ...PHYSICS_LAB_REQUESTS, ...PHYSICS_LAB_EVENTS }).every(channel => channel.startsWith('physics-lab:')));
});

test('with no tuning, a neutral one, a stale one, or after removing one, the stage builds exactly the plan it built before', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const ammo = await loadAmmoForTests();
  const before = JSON.stringify(buildPhysicsRigPlan(mesh));
  const signature = physicsRigSignature(mesh);
  const groups = physicsGroups(mesh, buildPhysicsRigPlan(mesh));
  const off = { version: 1, rig: signature, substepHz: 65, collisions: { chestArms: false, hairBody: true },
    groups: Object.fromEntries(groups.map(group => [group.id, { enabled: false }])) };
  const neutral = { ...off, groups: Object.fromEntries(groups.map(group => [group.id, {}])) };
  assert.equal(isNeutralTuning(normalizeModelPhysicsTuning(neutral)), true);
  const internals = (physics: LocalModelPhysics) => physics as unknown as { rig: unknown; parts: { hair: { tuned: { neutral: boolean; rig: unknown } } } };
  for (const candidate of [undefined, neutral, { ...off, rig: '1/2/3' }]) {
    const physics = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ hair: { enabled: true }, ...(candidate ? { tuning: candidate } : {}) }));
    assert.equal(JSON.stringify(internals(physics).rig), before);
    assert.equal(internals(physics).parts.hair.tuned.neutral, true);
    physics.dispose();
  }
  const tuned = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ hair: { enabled: true }, tuning: off }));
  assert.equal(internals(tuned).parts.hair.tuned.neutral, false);
  tuned.configure(normalizeModelPhysicsSettings({ tuning: null }, normalizeModelPhysicsSettings({ hair: { enabled: true } })));
  assert.equal(JSON.stringify(internals(tuned).rig), before, '恢复原样 rebuilds the original plan');
  assert.equal(internals(tuned).parts.hair.tuned.neutral, true);
  assert.equal(JSON.stringify(internals(tuned).parts.hair.tuned.rig), JSON.stringify(buildPhysicsRigPlan(mesh).hair));
  tuned.dispose();
  mesh.geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose();
});

test('a tuning acts per group: a switched-off group gets no output, the spring solver gives bounded motion', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const ammo = await loadAmmoForTests();
  const signature = physicsRigSignature(mesh);
  const groups = physicsGroups(mesh, buildPhysicsRigPlan(mesh));
  const longest = groups.reduce((a, b) => (b.outputBones.length > a.outputBones.length ? b : a));
  const base = { version: 1, rig: signature, substepHz: 65, collisions: { chestArms: false, hairBody: true } };
  const plain = runScenario(mesh, ammo, { hair: { enabled: true, strength: 1 } }, 'headTurn');
  assert.ok(plain.numbers[longest.id].swing > 0.05, 'the group moves without a tuning');
  const off = runScenario(mesh, ammo, { hair: { enabled: true, strength: 1 }, tuning: { ...base, groups: { [longest.id]: { enabled: false } } } } as never, 'headTurn');
  assert.ok(off.numbers[longest.id].swing < 0.002, `switched off: it follows the animation (${off.numbers[longest.id].swing})`);
  const other = groups.find(group => group.id !== longest.id && group.outputBones.length > 1)!;
  assert.ok(off.numbers[other.id].swing > 0.005, 'the other groups still move');
  for (const fps of [60, 30]) {
    const spring = runScenario(mesh, ammo, { hair: { enabled: true, strength: 1 }, tuning: { ...base, groups: { [longest.id]: { engine: 'spring' } } } } as never, 'headTurn', { fps });
    const n = spring.numbers[longest.id];
    assert.equal(spring.status, 'running');
    assert.ok(n.swing > 0.02 && Number.isFinite(n.unexpectedStep), `spring bones move (${fps} fps: ${n.swing})`);
    assert.ok(n.stretch < 1e-3, 'spring bones never stretch');
  }
  mesh.geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose();
});
