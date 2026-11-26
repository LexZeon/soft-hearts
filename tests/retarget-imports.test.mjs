import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportedNames, retargetRepo, retargetSource, specifierLike } from '../scripts/dev/retarget-imports.mjs';

const owners = new Map([['AppSettings', 'shared/foundation/settings.ts'], ['ProviderConfig', 'shared/foundation/settings.ts'], ['ChatMessage', 'shared/foundation/chat.ts']]);
const files = new Set(['shared/contracts.ts', 'shared/foundation/settings.ts', 'shared/foundation/chat.ts', 'electron/a.ts']);

test('exportedNames reads declarations and re-exports, not export *', () => {
  const names = exportedNames('export interface A {}\nexport type B = 1;\nexport const C = 1;\nexport function d() {}\nexport { e, f as g } from "./x";\nexport type { H } from "./y";\nexport * from "./z";\n// export const Hidden = 1;\n');
  assert.deepEqual([...names].sort(), ['A', 'B', 'C', 'H', 'd', 'e', 'g']);
});

test('specifierLike keeps the old style', () => {
  assert.equal(specifierLike('../shared/contracts', 'electron/a.ts', 'shared/foundation/settings.ts'), '../shared/foundation/settings');
  assert.equal(specifierLike('../shared/contracts.ts', 'electron/a.ts', 'shared/foundation/settings.ts'), '../shared/foundation/settings.ts');
  assert.equal(specifierLike('../shared/contracts.js', 'electron/a.ts', 'shared/foundation/settings.ts'), '../shared/foundation/settings.js');
  assert.equal(specifierLike('./contracts', 'shared/b.ts', 'shared/foundation/settings.ts'), './foundation/settings');
});

test('a statement whose names all moved is retargeted; a mixed one is left; bytes around stay', () => {
  const src = "import type { AppSettings, ProviderConfig as P } from '../shared/contracts';\r\nimport { type DesktopAPI, AppSettings as S } from \"../shared/contracts\";\r\nconst x = 1;\r\n";
  const r = retargetSource(src, 'electron/a.ts', 'shared/contracts.ts', owners, files);
  assert.equal(r.text, "import type { AppSettings, ProviderConfig as P } from '../shared/foundation/settings';\r\nimport { type DesktopAPI, AppSettings as S } from \"../shared/contracts\";\r\nconst x = 1;\r\n");
  assert.equal(r.edits.length, 1);
  assert.match(r.skipped[0].why, /DesktopAPI/);
});

test('names from several new files split the statement, one per file, keeping type and the line ending', () => {
  const src = "x();\r\nimport type { AppSettings, ChatMessage } from '../shared/contracts';\r\n";
  const r = retargetSource(src, 'electron/a.ts', 'shared/contracts.ts', owners, files);
  assert.equal(r.text, "x();\r\nimport type { AppSettings } from '../shared/foundation/settings';\r\nimport type { ChatMessage } from '../shared/foundation/chat';\r\n");
});

test('export-from is retargeted; other modules and comments inside braces are left alone', () => {
  const src = "export type { ChatMessage } from '../shared/contracts';\nimport { AppSettings /* why */ } from '../shared/contracts';\nimport { ChatMessage } from '../shared/other';\n";
  const r = retargetSource(src, 'electron/a.ts', 'shared/contracts.ts', owners, new Set([...files, 'shared/other.ts']));
  assert.equal(r.text, "export type { ChatMessage } from '../shared/foundation/chat';\nimport { AppSettings /* why */ } from '../shared/contracts';\nimport { ChatMessage } from '../shared/other';\n");
  assert.match(r.skipped[0].why, /comment/);
});

test('retargetRepo writes the files, counts the importers that left, honours --exclude and --dry-run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retarget-'));
  try {
    const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t); };
    put('shared/foundation/settings.ts', 'export interface AppSettings { a: 1 }\n');
    put('shared/contracts.ts', "export type { AppSettings } from './foundation/settings';\nexport interface DesktopAPI {}\n");
    put('electron/a.ts', "import type { AppSettings } from '../shared/contracts';\n");
    put('electron/b.ts', "import type { AppSettings, DesktopAPI } from '../shared/contracts';\n");
    put('tests/c.test.ts', "import type { AppSettings } from '../shared/contracts';\n");
    const dry = retargetRepo({ root, from: 'shared/contracts.ts', to: ['shared/foundation/settings.ts'], exclude: ['tests/c.test.ts'], dryRun: true });
    assert.equal(dry.movedOff, 1);
    assert.match(fs.readFileSync(path.join(root, 'electron/a.ts'), 'utf8'), /contracts/);
    const real = retargetRepo({ root, from: 'shared/contracts.ts', to: ['shared/foundation/settings.ts'], exclude: ['tests/c.test.ts'] });
    assert.equal(real.movedOff, 1);
    assert.equal(fs.readFileSync(path.join(root, 'electron/a.ts'), 'utf8'), "import type { AppSettings } from '../shared/foundation/settings';\n");
    assert.match(fs.readFileSync(path.join(root, 'electron/b.ts'), 'utf8'), /contracts/);
    assert.match(fs.readFileSync(path.join(root, 'tests/c.test.ts'), 'utf8'), /contracts/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
