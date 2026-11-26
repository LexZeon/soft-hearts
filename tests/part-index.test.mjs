// Public pages of parts in folders (docs/claude/2026-11-16-overhaul-parts-1.md): the surface a part shows other parts
// (scripts/dev/part-surface.mjs) and pointing importers outside the part at its index (scripts/dev/retarget-imports.mjs --index).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retargetSource, retargetToIndex, specifierLike } from '../scripts/dev/retarget-imports.mjs';
import { exportKind, moduleRefs, partSurface } from '../scripts/dev/part-surface.mjs';
import { buildInventory } from '../scripts/dev/structure-inventory.mjs';
import { assignPart, isPublicPage } from '../scripts/dev/structure-parts.mjs';

function fakeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'part-index-'));
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  }
  return root;
}
const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the cards folders belong to the cards part and their index files are its public pages', () => {
  assert.equal(assignPart('electron/cards/character-cards.ts'), 'cards');
  assert.equal(assignPart('electron/cards/character-convert/service.ts'), 'cards');
  assert.equal(assignPart('shared/cards/presets/gene-balanced-card.json'), 'cards');
  assert.equal(assignPart('src/cards/CharacterPage.ts'), 'cards');
  assert.ok(isPublicPage('shared/cards/index.ts', 'cards'));
  assert.ok(!isPublicPage('shared/cards/character-cards.ts', 'cards'));
  assert.ok(!isPublicPage('electron/cards/character-convert/index.ts', 'cards'));
});

test('an index target becomes the folder for an extensionless specifier and keeps an extension otherwise', () => {
  assert.equal(specifierLike('../shared/cards/x', 'electron/a.ts', 'shared/cards/index.ts'), '../shared/cards');
  assert.equal(specifierLike('../shared/cards/x.ts', 'electron/a.ts', 'shared/cards/index.ts'), '../shared/cards/index.ts');
  assert.equal(specifierLike('../shared/cards/x.js', 'electron/a.ts', 'shared/cards/index.ts'), '../shared/cards/index.js');
  assert.equal(specifierLike('./x', 'shared/cards/a.ts', 'shared/cards/index.ts'), '.');
});

test('inline type queries are pointed at the index only for names it carries', () => {
  const files = new Set(['shared/cards/x.ts', 'shared/cards/index.ts', 'shared/contracts.ts']);
  const owners = new Map([['T', 'shared/cards/index.ts']]);
  const src = "a(): Promise<import('./cards/x').T>;\r\nb(): import(\"./cards/x\").Hidden;\r\nawait import('./cards/x');\r\n";
  const r = retargetSource(src, 'shared/contracts.ts', 'shared/cards/x.ts', owners, files);
  assert.equal(r.text, "a(): Promise<import('./cards').T>;\r\nb(): import(\"./cards/x\").Hidden;\r\nawait import('./cards/x');\r\n");
  assert.equal(r.edits.length, 1);
  assert.match(r.skipped[0].why, /Hidden/);
});

test('two import statements on one line are both rewritten', () => {
  const files = new Set(['shared/cards/x.ts', 'shared/cards/y.ts', 'shared/cards/index.ts', 'electron/a.ts']);
  const owners = new Map([['a', 'shared/cards/index.ts'], ['b', 'shared/cards/index.ts']]);
  const src = "import { a } from '../shared/cards/x'; import { b } from '../shared/cards/x';\n";
  const r = retargetSource(src, 'electron/a.ts', 'shared/cards/x.ts', owners, files);
  assert.equal(r.text, "import { a } from '../shared/cards'; import { b } from '../shared/cards';\n");
});

test('retargetToIndex rewrites other parts and the contract, never the part itself, tests, or a name from another file', () => {
  const root = fakeRepo({
    'shared/cards/x.ts': 'export const a = 1;\nexport type T = 1;\nexport const hidden = 2;\n',
    'shared/cards/y.ts': 'export const a = 3;\n',
    'shared/cards/index.ts': "export { a } from './x';\nexport type { T } from './x';\n",
    'shared/cards/z.ts': "import { a } from './x';\n",
    'electron/mood/mood.ts': "import { a, type T } from '../../shared/cards/x';\r\nimport { a as b } from '../../shared/cards/y';\r\n",
    'electron/other-thing.ts': "import { a, hidden } from '../shared/cards/x';\n",
    'shared/contracts.ts': "export interface Api { t(): import('./cards/x').T }\n",
    'tests/t.test.ts': "import { a } from '../shared/cards/x';\n",
  });
  try {
    const r = retargetToIndex({ root, indexFile: 'shared/cards/index.ts', part: 'cards' });
    assert.equal(read(root, 'electron/mood/mood.ts'), "import { a, type T } from '../../shared/cards';\r\nimport { a as b } from '../../shared/cards/y';\r\n");
    assert.equal(read(root, 'electron/other-thing.ts'), "import { a, hidden } from '../shared/cards/x';\n");
    assert.equal(read(root, 'shared/contracts.ts'), "export interface Api { t(): import('./cards').T }\n");
    assert.equal(read(root, 'shared/cards/z.ts'), "import { a } from './x';\n");
    assert.equal(read(root, 'tests/t.test.ts'), "import { a } from '../shared/cards/x';\n");
    assert.equal(r.files.filter((f) => f.edits.length).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('moduleRefs reads inner names, renames, defaults, namespaces, export * and inline types', () => {
  const refs = moduleRefs('a.ts', "import d, { x as y, type T } from './m';\nimport * as ns from './n';\nexport * from './o';\nexport { p as q } from './p';\nimport './s.css';\nlet v: import('./t').U;\nconst lazy = () => import('./w');\n");
  const view = refs.map((r) => `${r.kind}:${r.spec}:${r.names.join(',')}`);
  assert.deepEqual(view, ['default:./m:', 'import:./m:x,T', 'namespace:./n:', 'export-star:./o:', 'export:./p:p', 'side-effect:./s.css:', 'inline-type:./t:U', 'dynamic:./w:']);
});

test('partSurface lists what outside source files import, with type or value read through re-exports', () => {
  const root = fakeRepo({
    'shared/cards/x.ts': "export const a = 1;\nexport interface T { n: 1 }\nimport type { V } from './v';\nexport type { V };\n",
    'shared/cards/v.ts': 'export type V = 2;\n',
    'shared/cards/r.ts': "export { a as b } from './x';\nimport { a } from './x';\nexport { a };\n",
    'shared/cards/z.ts': "import { a } from './x';\n",
    'electron/mood/mood.ts': "import { a as alias, type T, type V } from '../../shared/cards/x';\nimport { b } from '../../shared/cards/r';\nimport * as all from '../../shared/cards/x';\n",
    'tests/t.test.ts': "import { a } from '../shared/cards/x';\n",
  });
  try {
    const inv = buildInventory(root);
    const s = partSurface({ root, part: 'cards', inv });
    const x = s.files.find((f) => f.file === 'shared/cards/x.ts');
    assert.deepEqual(x.names.map((n) => `${n.name}:${n.kind}:${n.importers.join(',')}`), ['a:value:electron/mood/mood.ts', 'T:type:electron/mood/mood.ts', 'V:type:electron/mood/mood.ts']);
    assert.equal(x.other[0].kind, 'namespace');
    assert.deepEqual(s.files.find((f) => f.file === 'shared/cards/r.ts').names.map((n) => `${n.name}:${n.kind}`), ['b:value']);
    const fileSet = new Set(inv.records.keys());
    assert.equal(exportKind(root, 'shared/cards/r.ts', 'a', fileSet), 'value');
    assert.equal(exportKind(root, 'shared/cards/r.ts', 'nothing', fileSet), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
