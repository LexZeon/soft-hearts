import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory, checkLayers, debtGrowth, wiringFilePart } from '../scripts/dev/structure-inventory.mjs';
import { PART_FOLDERS } from '../scripts/dev/structure-parts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fake inventory: files = { path: [part, [imported paths]] } (every file is a source file). */
function fakeInv(files) {
  const records = new Map();
  for (const [p, [part, imports]] of Object.entries(files)) {
    records.set(p, { path: p, group: 'source', part, imports: imports.map((to, i) => ({ to, line: i + 1, typeOnly: false })) });
  }
  return { records };
}

test('the layer debt does not grow (scripts/dev/layer-debt.json is the ceiling; lower it with --update-baseline)', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/dev/layer-debt.json'), 'utf8'));
  const layers = checkLayers(buildInventory(ROOT));
  const grown = debtGrowth(layers.counts, baseline);
  assert.deepEqual(grown, [], `new layer violations (see node scripts/dev/structure-inventory.mjs --check-layers, .local/structure/layers.md): ${JSON.stringify(grown)}`);
});

test('foundation importing a part is a violation, grouped by the imported part; foundation importing foundation is not', () => {
  const inv = fakeInv({
    'shared/foundation/settings.ts': ['trunk', ['shared/foundation/mood.ts', 'shared/memory/memory.ts', 'shared/contracts.ts']],
    'shared/foundation/mood.ts': ['mood', []],
    'shared/memory/memory.ts': ['memory', []],
    'shared/contracts.ts': ['trunk', []],
  });
  const r = checkLayers(inv);
  assert.equal(r.counts['foundation-imports-part'].total, 2, 'the part file and the contract');
  assert.deepEqual(r.counts['foundation-imports-part'].byPart, { memory: 1, trunk: 1 });
  assert.equal(r.counts['part-imports-part-internal'].total, 0);
  assert.equal(r.counts['imports-contract'].total, 0, 'a foundation file reaching up to the contract counts once, as foundation debt');
});

test('the contract may import any part; only the wiring, the preload and the contract may import it', () => {
  const inv = fakeInv({
    'shared/contracts.ts': ['trunk', ['shared/memory/memory.ts', 'shared/foundation/settings.ts']],
    'shared/memory/memory.ts': ['memory', ['shared/contracts.ts']],
    'shared/foundation/settings.ts': ['trunk', []],
    'electron/main.ts': ['trunk', ['shared/contracts.ts']],
    'electron/memory/wiring.ts': ['memory', ['shared/contracts.ts']],
    'electron/safety/preload.ts': ['safety', ['shared/contracts.ts']],
    'src/ui/Panel.ts': ['stage', ['shared/contracts.ts', 'shared/foundation/settings.ts']],
  });
  const r = checkLayers(inv);
  assert.deepEqual(r.contract, ['shared/contracts.ts']);
  assert.equal(r.counts['foundation-imports-part'].total, 0);
  assert.equal(r.counts['part-imports-part-internal'].total, 0, 'contract -> memory is allowed; memory -> contract is imports-contract, not part debt');
  assert.deepEqual(r.violations.filter((v) => v.rule === 'imports-contract').map((v) => v.from).sort(), ['shared/memory/memory.ts', 'src/ui/Panel.ts']);
  assert.deepEqual(r.counts['imports-contract'].byPart, { memory: 1, stage: 1 });
});

test('a part may import foundation, but another part only through its public page', () => {
  const inv = fakeInv({
    'electron/mood/a.ts': ['mood', ['shared/foundation/mood.ts', 'electron/memory/b.ts', 'electron/memory/index.ts']],
    'electron/memory/b.ts': ['memory', []],
    'electron/memory/index.ts': ['memory', ['electron/memory/b.ts']],
    'shared/foundation/mood.ts': ['mood', []],
  });
  // no part folder yet (memory has one since overhaul parts 2: set it aside for this check): both cross-part imports are debt
  const registered = PART_FOLDERS.memory;
  delete PART_FOLDERS.memory;
  try {
    assert.equal(checkLayers(inv).counts['part-imports-part-internal'].total, 2);
    PART_FOLDERS.memory = ['electron/memory/'];
    const r = checkLayers(inv);
    assert.equal(r.counts['part-imports-part-internal'].total, 1);
    assert.equal(r.violations.find((v) => v.rule === 'part-imports-part-internal').to, 'electron/memory/b.ts');
    assert.deepEqual(r.counts['part-imports-part-internal'].byPart, { mood: 1 });
  } finally { if (registered) PART_FOLDERS.memory = registered; else delete PART_FOLDERS.memory; }
});

test('nothing imports the wiring except other wiring; wiring may import any part', () => {
  const inv = fakeInv({
    'electron/main.ts': ['trunk', ['electron/mood/a.ts', 'electron/memory/wiring.ts']],
    'electron/memory/wiring.ts': ['memory', ['electron/memory/b.ts']],
    'electron/memory/b.ts': ['memory', ['electron/main.ts']],
    'electron/mood/a.ts': ['mood', ['electron/memory/wiring.ts']],
  });
  const r = checkLayers(inv);
  assert.equal(r.counts['imports-wiring'].total, 2);
  assert.deepEqual(r.violations.filter((v) => v.rule === 'imports-wiring').map((v) => v.from).sort(), ['electron/memory/b.ts', 'electron/mood/a.ts']);
  assert.equal(r.counts['part-imports-part-internal'].total, 0);
});

test('debtGrowth reports a rise in a rule total or in one part, and nothing for a fall', () => {
  const baseline = { rules: { 'imports-wiring': { total: 3, byPart: { trunk: 2, senses: 1 } } } };
  const same = { 'imports-wiring': { total: 3, byPart: { trunk: 2, senses: 1 } } };
  assert.deepEqual(debtGrowth(same, baseline), []);
  const fewer = { 'imports-wiring': { total: 1, byPart: { trunk: 1 } } };
  assert.deepEqual(debtGrowth(fewer, baseline), []);
  const moved = { 'imports-wiring': { total: 3, byPart: { trunk: 1, senses: 2 } } };
  assert.deepEqual(debtGrowth(moved, baseline), [{ rule: 'imports-wiring', part: 'senses', now: 2, was: 1 }]);
  const more = { 'imports-wiring': { total: 4, byPart: { trunk: 2, senses: 1, mood: 1 } } };
  assert.equal(debtGrowth(more, baseline).length, 2);
});

test("a part's wiring file reaches only into its own part; other parts through their public pages (wiring-imports-other-internal)", () => {
  const inv = fakeInv({
    'electron/wiring/cards-wiring.ts': ['wiring', ['electron/cards/character-cards.ts', 'electron/mood/index.ts', 'electron/memory/recycle-wiring.ts', 'electron/foundation/assets.ts', 'electron/wiring/shell-wiring.ts']],
    'electron/wiring/shell-wiring.ts': ['wiring', ['electron/memory/app-session/host.ts']],
    'electron/cards/character-cards.ts': ['cards', []],
    'electron/mood/index.ts': ['mood', []],
    'electron/memory/recycle-wiring.ts': ['memory', []],
    'electron/memory/app-session/host.ts': ['memory', []],
    'electron/foundation/assets.ts': ['foundation', []],
  });
  const r = checkLayers(inv);
  // cards-wiring -> memory's internal file counts; its own part, a public page, the foundation and other wiring do not; the skeleton
  // (shell-wiring) is not a part's wiring, so it is not counted here
  assert.deepEqual(r.violations.filter((v) => v.rule === 'wiring-imports-other-internal').map((v) => [v.from, v.to]),
    [['electron/wiring/cards-wiring.ts', 'electron/memory/recycle-wiring.ts']]);
  assert.deepEqual(r.counts['wiring-imports-other-internal'].byPart, { cards: 1 });
  assert.equal(r.counts['part-imports-part-internal'].total, 0, 'the wiring is still wiring for the other rules');
});

test('a part wiring split over two files is checked as that part (wiring rewrite step 4h: brain-chat-wiring.ts is 大脑\'s)', () => {
  assert.equal(wiringFilePart('electron/wiring/brain-wiring.ts'), 'brain');
  assert.equal(wiringFilePart('electron/wiring/brain-chat-wiring.ts'), 'brain');
  assert.equal(wiringFilePart('electron\\wiring\\stage-wiring.ts'), 'stage');
  for (const skeleton of ['ipc', 'shell', 'lifecycle', 'clock', 'parts', 'ports']) assert.equal(wiringFilePart(`electron/wiring/${skeleton}-wiring.ts`), null, skeleton);
  assert.equal(wiringFilePart('electron/wiring/brainy-wiring.ts'), null, 'a prefix is a whole part id');
  assert.equal(wiringFilePart('electron/brain/pause-talk/wiring.ts'), null);
});
