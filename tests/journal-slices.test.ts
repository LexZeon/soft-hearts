// The experience journal split into per-part slices (docs/claude/2026-11-16-journal-split.md): shared/memory/journal.ts is the core
// (version, limits, JOURNAL_TYPES, the joined input type, the dispatcher) and each part's entry types live in
// shared/<part>/journal-entries.ts. These checks keep it that way: every type in exactly one slice, no per-type code in the core,
// no slice reaching into another part, each slice on its part's public page, every file small. The lines themselves are held by
// tests/journal-behaviour.test.ts, the types by tests/journal-surface.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNAL_TYPES } from '../shared/memory/journal';

// The part table is a plain .mjs script without types (scripts/dev/structure-parts.mjs).
const partsScript: string = '../scripts/dev/structure-parts.mjs';
const { assignPart, PART_IDS } = await import(partsScript) as { assignPart(relPath: string): string | null; PART_IDS: string[] };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The parts that have a slice, in part order (the order of the core's four slice tables). */
const SLICE_PARTS = ['stage', 'senses', 'memory', 'mood', 'brain', 'initiative', 'safety', 'cards', 'voice'];
const cap = (part: string) => part[0]!.toUpperCase() + part.slice(1);
const sliceFile = (part: string) => `shared/${part}/journal-entries.ts`;
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

async function slice(part: string) {
  const module = await import(`../${sliceFile(part)}`) as Record<string, unknown>;
  return {
    module,
    types: module[`${part.toUpperCase()}_JOURNAL_TYPES`] as readonly string[],
    build: module[`build${cap(part)}JournalEntry`],
    reason: module[`${part}JournalReason`],
    describe: module[`describe${cap(part)}JournalEntry`],
  };
}

test('the slices are exactly these files, in part order, each with its four names', async () => {
  const present = PART_IDS.filter((part: string) => fs.existsSync(path.join(ROOT, sliceFile(part))));
  assert.deepEqual(present, SLICE_PARTS, 'a new slice is added to SLICE_PARTS here and to the four slice tables of shared/memory/journal.ts');
  for (const part of SLICE_PARTS) {
    const s = await slice(part);
    assert.ok(Array.isArray(s.types) && s.types.length > 0, `${part}: ${part.toUpperCase()}_JOURNAL_TYPES`);
    for (const fn of [s.build, s.reason, s.describe]) assert.equal(typeof fn, 'function', `${part}: the builder, the reason and the panel line`);
  }
});

test('every journal type is in exactly one slice, and each slice lists its types in JOURNAL_TYPES order', async () => {
  const seen = new Map<string, string>();
  for (const part of SLICE_PARTS) {
    const { types } = await slice(part);
    for (const type of types) {
      assert.ok(!seen.has(type), `${type} is in the ${seen.get(type)} and the ${part} slices`);
      seen.set(type, part);
    }
    assert.deepEqual([...types], JOURNAL_TYPES.filter(type => types.includes(type)), `${part}: types in JOURNAL_TYPES order`);
  }
  assert.deepEqual([...seen.keys()].sort(), [...JOURNAL_TYPES].sort(), 'every type in JOURNAL_TYPES has a slice, and no slice has a type the list lacks');
});

test('the core has no per-type code: no case, no type name outside JOURNAL_TYPES', () => {
  const core = read('shared/memory/journal.ts');
  assert.doesNotMatch(core, /\bcase\s+'/, 'shared/memory/journal.ts dispatches by slice; a type\'s code goes into its slice');
  const afterList = core.slice(core.indexOf('export type JournalType ='));
  for (const type of JOURNAL_TYPES) assert.ok(!afterList.includes(`'${type}'`), `shared/memory/journal.ts names '${type}' outside JOURNAL_TYPES`);
});

test('a slice imports only its own part and the foundation (so no slice adds a path between parts)', () => {
  for (const part of SLICE_PARTS) {
    const file = sliceFile(part);
    for (const m of read(file).matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]!));
      const owner = assignPart(`${target}.ts`) ?? assignPart(`${target}/index.ts`);
      assert.ok(owner === part || owner === 'foundation', `${file} imports ${m[1]} (${owner}): a slice takes another part's words only from the foundation`);
      assert.ok(!/^shared\/[a-z]+$/.test(target), `${file} imports ${m[1]}: its own part's files directly, never a public page`);
    }
  }
});

test('each slice is on its part\'s public page (the core reaches it through it), and the memory slice next to the core', async () => {
  for (const part of SLICE_PARTS) {
    const s = await slice(part);
    const page = part === 'memory' ? s.module : await import(`../shared/${part}/index.ts`) as Record<string, unknown>;
    for (const name of [`${part.toUpperCase()}_JOURNAL_TYPES`, `build${cap(part)}JournalEntry`, `${part}JournalReason`, `describe${cap(part)}JournalEntry`])
      assert.equal(page[name], s.module[name], `shared/${part}/index.ts exports ${name} from ./journal-entries`);
  }
});

test('no slice sits in an import cycle, and the core reads its slice tables only when called', async () => {
  // A slice imports only its own part's files and the foundation; were one of them to import back through its part's public page,
  // the slice could run before what it reads. The core is in one cycle (memory page -> journal.ts -> cards page ->
  // cards/character-convert.ts -> memory page, which uses cleanNickname only inside functions), so it touches nothing at load.
  const inventoryScript: string = '../scripts/dev/structure-inventory.mjs';
  const { buildInventory } = await import(inventoryScript) as { buildInventory(root: string): { records: Map<string, { path: string; group: string; imports: { to: string; kind: string; typeOnly: boolean }[] }> } };
  const inv = buildInventory(ROOT);
  const valueImports = (file: string) => (inv.records.get(file)?.imports ?? []).filter(i => !i.typeOnly && i.kind !== 'dynamic' && i.kind !== 'require').map(i => i.to);
  for (const part of SLICE_PARTS) {
    const start = sliceFile(part);
    const seen = new Set<string>(), queue = [...valueImports(start)];
    while (queue.length) {
      const file = queue.pop()!;
      assert.notEqual(file, start, `${start} is in an import cycle`);
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...valueImports(file));
    }
  }
  const core = read('shared/memory/journal.ts');
  for (const table of ['SLICE_TYPES', 'SLICE_BUILD', 'SLICE_REASON', 'SLICE_DESCRIBE']) {
    // Read at load, a table fails under CommonJS in that cycle (tests/fatigue-host.test.ts and tests/b06-pat-speech-proof.test.ts load it so).
    assert.match(core, new RegExp(`const ${table} = \\(\\): `), `${table} is read on first use, not while the file loads`);
  }
});

test('every journal file stays small enough to read in one go (under 40 KB)', () => {
  for (const file of ['shared/memory/journal.ts', 'shared/foundation/journal-fields.ts', ...SLICE_PARTS.map(sliceFile)]) {
    const size = fs.statSync(path.join(ROOT, file)).size;
    assert.ok(size < 40 * 1024, `${file} is ${size} bytes`);
  }
});
