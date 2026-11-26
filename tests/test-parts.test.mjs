// Tests by program part (scripts/dev/test-parts.mjs, docs/claude/2026-11-16-tests-by-part.md): the owner of each test comes from its
// import graph and path literals; the committed scripts/dev/test-parts.json must be current; test-affected --owned and
// test-all --by-part use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS, plan } from '../scripts/dev/ops.mjs';
import { JSON_PATH, REGENERATE, buildTestParts, computeTestParts, readersOf, serialize, summarize, timingReport } from '../scripts/dev/test-parts.mjs';
import { loadGraph, ownedTests } from '../scripts/dev/test-affected.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-parts-'));
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  }
  return root;
}

const FAKE = {
  'electron/mood/a.ts': 'export const a = 1;\n',
  'electron/mood/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'electron/brain/c.ts': 'export const c = 1;\n',
  'electron/voice/d.ts': 'export const d = 1;\n',
  'electron/senses/e.ts': 'export const e = 1;\n',
  'electron/stage/f.ts': 'export const f = 1;\n',
  'electron/main.ts': 'export const main = 1;\n',
  'shared/foundation/f.ts': 'export const fo = 1;\n',
  'tests/mood-two.test.ts': "import { a } from '../electron/mood/a';\nimport { b } from '../electron/mood/b';\nimport { c } from '../electron/brain/c';\n",
  'tests/tie.test.ts': "import { d } from '../electron/voice/d';\nimport { c } from '../electron/brain/c';\n",
  'tests/wide.test.ts': "import '../electron/mood/a';\nimport '../electron/brain/c';\nimport '../electron/voice/d';\nimport '../electron/senses/e';\nimport '../electron/stage/f';\n",
  'tests/foundation-only.test.ts': "import '../shared/foundation/f';\n",
  'tests/reads-main.test.ts': "import fs from 'node:fs';\nconst text = fs.readFileSync('electron/main.ts', 'utf8');\n",
  'tests/reads-voice-folder.test.ts': "const dir = 'electron/voice/d.ts';\n",
  'tests/nothing.test.ts': "import test from 'node:test';\n",
};

test('each test is owned by the part most of its touched files belong to, and lists every part it touches', async () => {
  const g = await loadGraph(fakeRepo(FAKE));
  const map = computeTestParts(g);
  assert.deepEqual(Object.keys(map), [...Object.keys(map)].sort(), 'sorted keys');
  assert.deepEqual(map['tests/mood-two.test.ts'], { owner: 'mood', parts: ['mood', 'brain'] });
  // a tie goes to the part earlier in PART_IDS (mood, brain, ... voice): brain before voice
  assert.deepEqual(map['tests/tie.test.ts'], { owner: 'brain', parts: ['brain', 'voice'] });
  assert.equal(map['tests/wide.test.ts'].parts.length, 5);
  assert.deepEqual(map['tests/foundation-only.test.ts'], { owner: 'foundation', parts: ['foundation'] });
  assert.deepEqual(map['tests/reads-main.test.ts'], { owner: 'wiring', parts: ['wiring'] }, 'a test that reads electron/main.ts as text touches it');
  assert.deepEqual(map['tests/reads-voice-folder.test.ts'], { owner: 'voice', parts: ['voice'] });
  assert.deepEqual(map['tests/nothing.test.ts'], { owner: 'none', parts: [] });
  assert.deepEqual(readersOf('electron/main.ts', g), ['tests/reads-main.test.ts']);
});

test('the summary counts tests per owner and the ones touching more than 3 real parts', async () => {
  const map = computeTestParts(await loadGraph(fakeRepo(FAKE)));
  const s = summarize(map);
  assert.equal(s.total, 7);
  assert.equal(s.perOwner.mood, 1);
  assert.equal(map['tests/wide.test.ts'].owner, 'stage', 'a five-way tie goes to the earliest part in PART_IDS');
  assert.equal(s.wide, 1);
  assert.equal(Object.values(s.perOwner).reduce((a, b) => a + b, 0), s.total);
});

test('owned selection takes the tests of the named parts only', () => {
  const map = { 'tests/a.test.ts': { owner: 'mood', parts: ['mood'] }, 'tests/b.test.ts': { owner: 'brain', parts: ['brain', 'mood'] }, 'tests/c.test.ts': { owner: 'mood', parts: ['mood'] } };
  assert.deepEqual(ownedTests(map, ['mood']), ['tests/a.test.ts', 'tests/c.test.ts']);
  assert.deepEqual(ownedTests(map, ['brain', 'mood']), ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']);
  assert.deepEqual(ownedTests(map, ['voice']), []);
});

test('the timing report adds up time per owner and lists the slowest files', () => {
  const map = { 'tests/a.test.ts': { owner: 'mood' }, 'tests/b.test.ts': { owner: 'mood' }, 'tests/c.test.ts': { owner: 'brain' } };
  const r = timingReport({ 'tests/a.test.ts': 100, 'tests/b.test.ts': 300, 'tests/c.test.ts': 150, 'tests/new.test.ts': 10 }, map, { top: 2 });
  assert.deepEqual(r.owners.map((o) => [o.owner, o.ms, o.files]), [['mood', 400, 2], ['brain', 150, 1], ['none', 10, 1]]);
  assert.deepEqual(r.slowest.map((s) => s.file), ['tests/b.test.ts', 'tests/c.test.ts']);
});

test('the ops line "owned" runs test-affected --owned with the parts after it', () => {
  assert.ok(OPS.owned);
  assert.deepEqual(plan(['owned', 'mood']).run.slice(1), ['scripts/dev/test-affected.mjs', '--owned', 'mood']);
});

// The public snapshot (scripts/release/export-public.mjs) leaves out tests this list names; the list is the maintainer's, so this check runs in the development repository only.
const IN_SNAPSHOT = !fs.existsSync(path.join(REPO, 'scripts', 'pretrial'));
test('scripts/dev/test-parts.json is current', { skip: IN_SNAPSHOT }, async () => {
  const { map } = await buildTestParts(REPO);
  const have = fs.existsSync(JSON_PATH) ? fs.readFileSync(JSON_PATH, 'utf8') : '';
  assert.equal(have, serialize(map), `scripts/dev/test-parts.json is out of date (a test file or an import changed). Regenerate it: ${REGENERATE}`);
});
