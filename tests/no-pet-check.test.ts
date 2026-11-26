// no-pet-ok-file: this test has to write the word it forbids
// The no-pet check (scripts/dev/no-pet-check.mjs, I-160): nothing may call her "pet" any more than today; the baseline file only shrinks.
import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain .mjs script without types
import { HINT, describeNew, inScope, loadBaseline, nameHasPet, newOnes, petMatches, scanFile, scanRepository } from '../scripts/dev/no-pet-check.mjs';

type Hit = { line: number; category: string; text: string };
const hits = (file: string, text: string): Hit[] => scanFile(file, text);

test('the real repository uses "pet" no more than the baseline says (fix: write companion, or she / her / her name; or a no-pet-ok: reason on the line)', () => {
  const fresh = newOnes(scanRepository(), loadBaseline());
  assert.deepEqual(describeNew(fresh), [], HINT);
});

test('one more use in an old file is reported, with the file and the numbers', () => {
  const fresh = newOnes({ counts: { 'src/a.ts': 3 }, names: [] }, { counts: { 'src/a.ts': 2 }, names: [] });
  assert.deepEqual(fresh.counts, [{ file: 'src/a.ts', now: 3, was: 2 }]);
  assert.match(describeNew(fresh)[0], /2 处变成 3 处/);
  assert.deepEqual(newOnes({ counts: { 'src/a.ts': 2 }, names: [] }, { counts: { 'src/a.ts': 5 }, names: [] }).counts, []);
});

test('a new file with a use is reported; a new file whose NAME carries the word is reported even with no use inside', () => {
  assert.deepEqual(newOnes({ counts: { 'src/new.ts': 1 }, names: [] }, { counts: {}, names: [] }).counts, [{ file: 'src/new.ts', now: 1, was: 0 }]);
  const named = newOnes({ counts: {}, names: ['src/stage/pet-new.ts'] }, { counts: {}, names: ['src/stage/pet-old.ts'] });
  assert.deepEqual(named.names, ['src/stage/pet-new.ts']);
  assert.equal(nameHasPet('src/stage/PetUI.ts'), true);
  assert.equal(nameHasPet('src/pet/other.ts'), true);
  assert.equal(nameHasPet('src/stage/carpet.ts'), false);
});

test('a new use in a comment is counted as a comment', () => {
  const found = hits('src/x.ts', ['const a = 1; // the pet jumps', '/* the pets sleep */', '/** her pet window */'].join('\n'));
  assert.deepEqual(found.map(h => h.category), ['comment', 'comment', 'comment']);
});

test('a new identifier in any naming style is counted as an identifier', () => {
  const source = 'const petWindow = 1; function isPet() {} class PetUI {} const PET_MAX = 3; type Pets = 1; const x = a.showPet; const y = { pet: 1 };';
  const found = hits('src/x.ts', source);
  assert.equal(found.length, 7);
  assert.deepEqual([...new Set(found.map(h => h.category))], ['identifier']);
});

test('strings: with spaces they are text, without spaces they are keys; module paths are import paths', () => {
  const source = ["const a = 'show the pet now';", "const b = 'show_pet';", "const c = `pet-window`;", "import x from './pet-view';"].join('\n');
  assert.deepEqual(hits('electron/x.ts', source).map(h => h.category), ['string-text', 'string-key', 'string-key', 'import-path']);
});

test('English interface text is told apart: a value in an English dictionary is ui-text', () => {
  const found = hits('shared/foundation/ui-copy.demo.en.ts', "export const COPY = { '桌宠': 'The pet window is hidden' };");
  assert.deepEqual(found.map(h => h.category), ['ui-text']);
});

test('"pet name" (a nickname), petal, carpet, repetition, competent, petition are not counted', () => {
  const source = '// give her a pet name, or a Pet-Name; a petal in the carpet; repetition is competent; a petition; PETG; Peter\nconst petal = 1;';
  assert.deepEqual(hits('src/x.ts', source), []);
  assert.deepEqual(petMatches('pet name pet-name pets name a pet').map((m: { index: number }) => m.index), [30]);
});

test('a no-pet-ok comment on the line or the line above exempts it, and says why', () => {
  const same = "const a = 'show_pet'; // no-pet-ok: tool name Claude already has saved";
  assert.deepEqual(hits('src/x.ts', same), []);
  const above = "// no-pet-ok: the old settings key\nconst b = settings.pet;\nconst c = settings.pet;";
  assert.equal(hits('src/x.ts', above).length, 1);
  assert.equal(hits('src/x.ts', above)[0].line, 3);
  assert.equal(hits('handbook/x.md', 'we say pet here <!-- no-pet-ok: quoting the old word -->').length, 0);
});

test('a file about the word itself can opt out in its first lines, but not further down', () => {
  assert.deepEqual(hits('docs/claude/x.md', '<!-- no-pet-ok-file: the audit -->\nthe pet'), []);
  const late = `${'line\n'.repeat(12)}// no-pet-ok-file: too late\n\nthe pet`;
  assert.equal(hits('docs/claude/x.md', late).length, 1);
});

test('which files are looked at: the code folders, handbook and docs/claude markdown; not archive, assets, other docs or the baselines', () => {
  assert.equal(inScope('src/a.ts'), true);
  assert.equal(inScope('tests/fixtures/x.json'), true);
  assert.equal(inScope('handbook/ideas.md'), true);
  assert.equal(inScope('docs/claude/x.md'), true);
  assert.equal(inScope('docs/archive/x.md'), false);
  assert.equal(inScope('docs/mood/README.md'), false);
  assert.equal(inScope('assets/bundled/x.json'), false);
  assert.equal(inScope('scripts/dev/no-pet-baseline.json'), false);
  assert.equal(inScope('node_modules/x/index.js'), false);
  assert.equal(inScope('src/stage/README.md'), true);
});
