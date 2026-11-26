import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseImports, resolveImport, maskCode, buildInventory, writeReports } from '../scripts/dev/structure-inventory.mjs';
import { assignPart, GROUP_IDS } from '../scripts/dev/structure-parts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = (src) => parseImports(src).map((i) => i.spec);

test('import parser reads static, type, re-export, side-effect, dynamic and multi-line forms', () => {
  const src = [
    "import a from './a';",
    "import { b, type C as D } from '../shared/b';",
    "import type { T } from './t';",
    "import * as ns from './ns';",
    "export * from './re';",
    "export { x } from './x';",
    "import './style.css';",
    "const m = await import('./lazy');",
    "const r = require('./req');",
    'import {',
    '  one,',
    '  two as three,',
    "} from './multi';",
  ].join('\n');
  assert.deepEqual(specs(src), ['./a', '../shared/b', './t', './ns', './re', './x', './style.css', './lazy', './req', './multi']);
  const named = parseImports(src);
  assert.deepEqual(named[1].names, ['b', 'D']);
  assert.equal(named[2].typeOnly, true);
  assert.deepEqual(named[9].names, ['one', 'three']);
});

test('import parser ignores comments, strings, templates and regex literals', () => {
  const src = [
    "// import x from './comment-line';",
    "/* import y from './comment-block'; */",
    "const text = \"import z from './in-string'\";",
    'const t = `import w from "./in-template"`;',
    "const re = /import v from '.\\/x'/;",
    "const glob = 'src/**/*.ts'; import real from './real';",
    "const d = a / b; import after from './after';",
  ].join('\n');
  assert.deepEqual(specs(src), ['./real', './after']);
});

test('maskCode keeps offsets and newlines', () => {
  const src = "const a = 'x'; // c\nconst b = `t${1}`;\n";
  assert.equal(maskCode(src).length, src.length);
  assert.equal(maskCode(src).split('\n').length, src.split('\n').length);
});

test('resolveImport finds .ts, index.ts and strips suffixes', () => {
  const files = new Set(['shared/a.ts', 'shared/dir/index.ts', 'src/style.css', 'electron/w.ts', 'shared/data.json']);
  assert.equal(resolveImport('electron/main.ts', '../shared/a', files), 'shared/a.ts');
  assert.equal(resolveImport('electron/main.ts', '../shared/dir', files), 'shared/dir/index.ts');
  assert.equal(resolveImport('src/main.ts', './style.css?inline', files), 'src/style.css');
  assert.equal(resolveImport('electron/main.ts', './w.js', files), 'electron/w.ts');
  assert.equal(resolveImport('electron/main.ts', '../shared/data.json', files), 'shared/data.json');
  assert.equal(resolveImport('electron/main.ts', 'node:path', files), null);
  assert.equal(resolveImport('electron/main.ts', './missing', files), null);
});

test('part rules place known files', () => {
  const expect = {
    'electron/main.ts': 'wiring',
    'electron/desktop-entry.ts': 'wiring',
    'shared/contracts.ts': 'wiring',
    'src/main.ts': 'wiring',
    'electron/profile.ts': 'foundation',
    'electron/graceful-quit.ts': 'foundation',
    'electron/brain/companion.ts': 'brain',
    'electron/senses/media-runtime.ts': 'senses',
    'shared/foundation/mood.ts': 'foundation',
    'electron/settings/settings.ts': 'settings',
    'src/settings/layout.ts': 'settings',
    'shared/actions/her-actions.ts': 'actions',
    'shared/actions/r32/motion-tag-index.ts': 'actions',
    'src/stage/PetUI.ts': 'stage',
    'electron/stage/her-life/host.ts': 'stage',
    'src/stage/MmdStage.ts': 'stage',
    'electron/senses/face/host.ts': 'senses',
    'electron/memory/memory.ts': 'memory',
    'electron/mood/mood.ts': 'mood',
    'electron/brain/reply-draft-guard.ts': 'brain',
    'electron/brain/claude-session.ts': 'brain',
    'src/unbound/gait.ts': 'unbound',
    'electron/initiative/rps/host.ts': 'initiative',
    'electron/safety/agent-channel/app-tools.ts': 'safety',
    'electron/safety/preload.ts': 'safety',
    'electron/cards/character-cards.ts': 'cards',
    'electron/voice/tts.ts': 'voice',
    'shared/behaviors/blush/knobs.ts': 'mood',
    'electron/brain/opening-host.ts': 'brain',
  };
  for (const [file, part] of Object.entries(expect)) assert.equal(assignPart(file), part, file);
  assert.equal(assignPart('scripts/dev/heavy.mjs'), null);
});

test('inventory runs on the repo: every electron / shared / src file has a part, and the reports are written', () => {
  const inv = buildInventory(ROOT);
  const source = [...inv.records.values()].filter((r) => r.group === 'source');
  assert.ok(source.length > 1000, 'expected the whole source tree');
  // a file the rules cannot place is allowed (a new file before its rule), but then it must be listed, not lost
  for (const rec of source) assert.ok(rec.part === null ? inv.unassigned.includes(rec.path) : GROUP_IDS.includes(rec.part), rec.path);
  // the imports are read (electron/main.ts had 100+; step 4h moved 大脑 out and dropped the 200+ it no longer used, leaving 80-odd)
  assert.ok(inv.records.get('electron/main.ts').imports.length > 40);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-inventory-'));
  try {
    writeReports(inv, out, ROOT);
    for (const f of ['inventory.json', 'inventory.md', 'main-wiring.md', 'switches.md']) assert.ok(fs.statSync(path.join(out, f)).size > 500, f);
    const json = JSON.parse(fs.readFileSync(path.join(out, 'inventory.json'), 'utf8'));
    assert.equal(json.files['electron/main.ts'].part, 'wiring');
    // main.ts, desktop-entry.ts, src/main.ts, shared/contracts.ts (wiring rewrite step 2), and the files in electron/wiring/ (step 3)
    const wiringFolder = Object.keys(json.files).filter((f) => f.startsWith('electron/wiring/'));
    assert.ok(wiringFolder.length >= 6 && wiringFolder.every((f) => json.files[f].part === 'wiring' && f.endsWith('-wiring.ts')), wiringFolder.join(', '));
    // ... and the renderer's wiring files in src/wiring/ (overhaul step 5, docs/claude/2026-11-16-src-main-split.md)
    const rendererWiring = Object.keys(json.files).filter((f) => f.startsWith('src/wiring/'));
    assert.ok(rendererWiring.every((f) => json.files[f].part === 'wiring' && f.endsWith('-wiring.ts')), rendererWiring.join(', '));
    assert.equal(json.parts.wiring.files, 4 + wiringFolder.length + rendererWiring.length);
    assert.deepEqual(json.unassigned, inv.unassigned);
    const md = fs.readFileSync(path.join(out, 'inventory.md'), 'utf8');
    for (const f of inv.unassigned) assert.ok(md.includes(f), `${f} listed in inventory.md`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
