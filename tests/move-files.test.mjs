import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planMoves, applyPlan, rewriteSpecifier } from '../scripts/dev/move-files.mjs';

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-files-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

const FIXTURE = () => ({
  'electron/a.ts': "import { b } from './b';\r\nimport { c } from '../shared/c.ts';\r\nexport * from './sub/d';\r\nexport const a = b + c;\r\n",
  'electron/b.ts': "import { c } from '../shared/c';\nimport raw from '../shared/note.txt?raw';\nexport const b = c;\n",
  'electron/sub/d.ts': "import { b } from '../b';\nimport { c } from '../../shared/c';\nexport const d = b + c;\n",
  'shared/c.ts': "export const c = 1;\n",
  'shared/note.txt': 'hi',
  'shared/x.ts': "export { b } from '../electron/b.js';\nexport { c } from './c.js';\n",
  'src/ui/panel.ts': "import { b } from '../../electron/b';\nconst lazy = () => import('../../electron/b.ts');\n",
  'src/ui/index.ts': "export * from './panel';\n",
  'src/main.ts': "import './ui';\n",
  'tests/b.test.ts': [
    "import { b } from '../electron/b.ts';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const root = path.resolve(import.meta.dirname, '..');",
    "const t1 = fs.readFileSync(path.join(root, 'electron', 'b.ts'), 'utf8');",
    "const t2 = fs.readFileSync('electron/b.ts', 'utf8');",
    "const t3 = new URL('../electron/b.ts', import.meta.url);",
    "const t4 = `${root}/electron/b.ts`;",
    "const t5 = fs.readFileSync(path.join(root, 'electron/b.ts'));",
    "// the file electron/b.ts is read above",
    "",
  ].join('\n'),
  'scripts/tool.mjs': "import { c } from '../shared/c.ts';\n",
  'package.json': '{ "files": ["electron/b.ts"] }\n',
  'docs/note.md': 'See electron/b.ts for details.\n',
});

test('moving a leaf rewrites importers in sibling, parent and child folders and the moved file own imports', () => {
  const root = makeRepo(FIXTURE());
  const r = planMoves({ root, moves: [{ from: 'electron/b.ts', to: 'electron/mood/b.ts' }] });
  assert.equal(r.ok, true, r.errors.join('\n'));
  applyPlan(r, root);
  assert.equal(exists(root, 'electron/b.ts'), false);
  assert.equal(exists(root, 'electron/mood/b.ts'), true);
  // sibling importer (no extension)
  assert.match(read(root, 'electron/a.ts'), /from '\.\/mood\/b';/);
  // child folder importer
  assert.match(read(root, 'electron/sub/d.ts'), /from '\.\.\/mood\/b';/);
  // parent folder importers: with extension, no extension, .js style, dynamic import
  assert.match(read(root, 'src/ui/panel.ts'), /from '\.\.\/\.\.\/electron\/mood\/b';/);
  assert.match(read(root, 'src/ui/panel.ts'), /import\('\.\.\/\.\.\/electron\/mood\/b\.ts'\)/);
  assert.match(read(root, 'shared/x.ts'), /from '\.\.\/electron\/mood\/b\.js';/);
  assert.match(read(root, 'shared/x.ts'), /from '\.\/c\.js';/);
  // the moved file's own imports, including a ?raw suffix
  const moved = read(root, 'electron/mood/b.ts');
  assert.match(moved, /from '\.\.\/\.\.\/shared\/c';/);
  assert.match(moved, /from '\.\.\/\.\.\/shared\/note\.txt\?raw';/);
  // untouched files stay byte for byte
  assert.equal(read(root, 'shared/c.ts'), FIXTURE()['shared/c.ts']);
  // a root config naming the path
  assert.equal(read(root, 'package.json'), '{ "files": ["electron/mood/b.ts"] }\n');
  // markdown is listed, not rewritten
  assert.equal(read(root, 'docs/note.md'), FIXTURE()['docs/note.md']);
  assert.deepEqual(r.docsMentions.map((d) => d.file), ['docs/note.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CRLF is kept and the import style stays as written', () => {
  const root = makeRepo(FIXTURE());
  const r = planMoves({ root, moves: [{ from: 'electron/b.ts', to: 'electron/mood/b.ts' }] });
  applyPlan(r, root);
  const a = read(root, 'electron/a.ts');
  assert.ok(a.includes('\r\n'));
  assert.equal(a.split('\r\n').length, 5);
  assert.equal(a.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(a, /from '\.\/mood\/b';\r\n/);
  assert.match(a, /from '\.\.\/shared\/c\.ts';\r\n/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('path literals in a test are rewritten: repo path, ../ path, join pieces, template, comment', () => {
  const root = makeRepo(FIXTURE());
  const r = planMoves({ root, moves: [{ from: 'electron/b.ts', to: 'electron/mood/b.ts' }] });
  applyPlan(r, root);
  const t = read(root, 'tests/b.test.ts');
  assert.match(t, /from '\.\.\/electron\/mood\/b\.ts';/);
  assert.match(t, /path\.join\(root, 'electron\/mood\/b\.ts'\), 'utf8'\)/);
  assert.match(t, /readFileSync\('electron\/mood\/b\.ts', 'utf8'\)/);
  assert.match(t, /new URL\('\.\.\/electron\/mood\/b\.ts', import\.meta\.url\)/);
  assert.match(t, /`\$\{root\}\/electron\/mood\/b\.ts`/);
  assert.match(t, /path\.join\(root, 'electron\/mood\/b\.ts'\)\)/);
  assert.match(t, /\/\/ the file electron\/mood\/b\.ts is read above/);
  assert.equal(/electron\/b\.ts/.test(t), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a folder index import stays a folder import when the index moves with its folder', () => {
  const root = makeRepo(FIXTURE());
  const r = planMoves({ root, moves: [{ from: 'src/ui/', to: 'src/panels/' }] });
  assert.equal(r.ok, true, r.errors.join('\n'));
  applyPlan(r, root);
  assert.match(read(root, 'src/main.ts'), /import '\.\/panels';/);
  assert.match(read(root, 'src/panels/panel.ts'), /from '\.\.\/\.\.\/electron\/b';/);
  assert.equal(exists(root, 'src/ui'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('moving two files together rewrites the imports between them', () => {
  const root = makeRepo(FIXTURE());
  const r = planMoves({ root, moves: [{ from: 'electron/a.ts', to: 'electron/x/a.ts' }, { from: 'electron/b.ts', to: 'electron/x/b.ts' }] });
  applyPlan(r, root);
  assert.match(read(root, 'electron/x/a.ts'), /from '\.\/b';/);
  assert.match(read(root, 'electron/x/a.ts'), /from '\.\.\/\.\.\/shared\/c\.ts';/);
  assert.match(read(root, 'electron/x/a.ts'), /export \* from '\.\.\/sub\/d';/);
  assert.match(read(root, 'electron/sub/d.ts'), /from '\.\.\/x\/b';/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dry run changes nothing on disk', () => {
  const root = makeRepo(FIXTURE());
  const out = execFileSync(process.execPath, [path.resolve('scripts/dev/move-files.mjs'), '--root', root, '--from', 'electron/b.ts', '--to', 'electron/mood/b.ts', '--dry-run'], { encoding: 'utf8' });
  assert.match(out, /\[dry run\]/);
  assert.match(out, /electron\/mood\/b/);
  assert.match(out, /tsc --noEmit/);
  assert.equal(exists(root, 'electron/b.ts'), true);
  assert.equal(exists(root, 'electron/mood'), false);
  assert.equal(read(root, 'electron/a.ts'), FIXTURE()['electron/a.ts']);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).split('\n').filter((l) => l && !l.startsWith('A ')).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses an existing target, duplicate targets, a missing source and a target outside the repo', () => {
  const root = makeRepo(FIXTURE());
  const bad = (moves) => planMoves({ root, moves });
  let r = bad([{ from: 'electron/b.ts', to: 'electron/a.ts' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /already exists/);
  r = bad([{ from: 'electron/a.ts', to: 'electron/z.ts' }, { from: 'electron/b.ts', to: 'electron/z.ts' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /same target/);
  r = bad([{ from: 'electron/nope.ts', to: 'electron/z.ts' }]);
  assert.match(r.errors.join('\n'), /does not exist/);
  r = bad([{ from: 'electron/a.ts', to: '../outside.ts' }]);
  assert.match(r.errors.join('\n'), /outside the repo/);
  const cli = (args) => { try { execFileSync(process.execPath, [path.resolve('scripts/dev/move-files.mjs'), '--root', root, ...args], { encoding: 'utf8', stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  assert.equal(cli(['--from', 'electron/b.ts', '--to', 'electron/a.ts']), 1);
  assert.equal(exists(root, 'electron/b.ts'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rewriteSpecifier keeps the style: none, full, js, folder, query', () => {
  const base = { fromOld: 'src/a.ts', fromNew: 'src/a.ts', targetOld: 'src/u/x.ts', targetNew: 'src/v/x.ts' };
  assert.equal(rewriteSpecifier({ ...base, spec: './u/x' }), './v/x');
  assert.equal(rewriteSpecifier({ ...base, spec: './u/x.ts' }), './v/x.ts');
  assert.equal(rewriteSpecifier({ ...base, spec: './u/x.js' }), './v/x.js');
  assert.equal(rewriteSpecifier({ ...base, spec: './u/x?raw' }), './v/x?raw');
  assert.equal(rewriteSpecifier({ ...base, targetOld: 'src/u/index.ts', targetNew: 'src/v/index.ts', spec: './u' }), './v');
});

test('an extensionless file next to a folder of the same name stays ../name from inside that folder (electron/asr.ts and electron/asr/, parts 3)', () => {
  const moved = { fromOld: 'electron/asr/voice-route.ts', fromNew: 'electron/senses/asr/voice-route.ts', targetOld: 'electron/asr.ts', targetNew: 'electron/senses/asr.ts' };
  assert.equal(rewriteSpecifier({ ...moved, spec: '../asr' }), '../asr');
  assert.equal(rewriteSpecifier({ ...moved, spec: '../asr.ts' }), '../asr.ts');
  // a folder's own index from inside the folder is still '.'
  assert.equal(rewriteSpecifier({ fromOld: 'src/u/a.ts', fromNew: 'src/v/a.ts', targetOld: 'src/u/index.ts', targetNew: 'src/v/index.ts', spec: '.' }), '.');
});

test("a join whose first piece is only '..' starts the path at the next piece (scripts/soft-hearts-mcp.mjs, parts 2)", () => {
  const root = makeRepo({
    'shared/cat.json': '{}\n',
    'scripts/shim.mjs': "const p = path.join(here, '..', 'shared', 'cat.json');\nconst q = path.join(here, '../shared/cat.json');\n",
  });
  const r = planMoves({ root, moves: [{ from: 'shared/cat.json', to: 'shared/safety/cat.json' }] });
  assert.equal(r.ok, true, r.errors.join('\n'));
  applyPlan(r, root);
  const text = read(root, 'scripts/shim.mjs');
  assert.match(text, /path\.join\(here, '\.\.', 'shared\/safety\/cat\.json'\)/);
  assert.match(text, /path\.join\(here, '\.\.\/shared\/safety\/cat\.json'\)/);
  fs.rmSync(root, { recursive: true, force: true });
});
