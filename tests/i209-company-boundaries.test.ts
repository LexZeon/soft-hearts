// I-209's boundaries. Step 1 was "present, not talking"; step 3 (docs/claude/2026-11-24-i209-step3-instances.md) makes each one her own
// complete full screen: the pointer, the pull, the director, her words are her own host's and her own page's (the same code the first one runs).
// What stays bounded:
//  - the page's stage part only reads the shared world and steers her goal (her gait walks her there): it never imports the director, the pull,
//    her touches, her bubble or her mouth, and it never writes a bone or a position (no teleporting, R29);
//  - an instance's ports open no sense: nothing in the company code imports the senses part (one look for everyone, shared-senses.ts);
//  - the company code never imports the brain, the mood, memory or the initiative, and none of those imports the company: whose turn it is
//    crosses only as a card id through the brain's own gate (electron/brain/handed-line-gate.ts turnOwnerFor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filesIn = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap(name => {
  const rel = `${dir}/${name}`;
  return statSync(path.join(root, rel)).isDirectory() ? filesIn(rel) : /\.ts$/.test(name) ? [rel] : [];
});
const importsOf = (file: string) => [...readFileSync(path.join(root, file), 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2]!);
const COMPANY = ['src/unbound/company', 'electron/unbound/company', 'shared/unbound/company'];

test('the page\'s stage part reads the shared world and steers her goal only: no director, pull, touches, bubble or mouth; no bone or position written', () => {
  const forbidden = [/\/director\//, /\/director$/, /pull-/, /click-reporter/, /pointer-router/, /action-now/, /\/contact/, /out-touch/, /out-page/, /close-moment/, /speech-beat/, /bubbles/, /mouth/];
  for (const file of filesIn('src/unbound/company')) {
    for (const spec of importsOf(file)) assert.ok(!forbidden.some(pattern => pattern.test(spec)), `${file} imports ${spec}`);
    const text = readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/\.(place|placeMesh|setPoseTargets)\(|\.position\.(set|copy)\(|\.quaternion\./.test(text), `${file} moves her only through her goal (followTo)`);
  }
});

test('no company file opens a sense: none imports the senses part', () => {
  for (const dir of COMPANY) for (const file of filesIn(dir)) for (const spec of importsOf(file)) {
    assert.ok(!/(^|\/)senses(\/|$)/.test(spec), `${file} imports ${spec}`);
  }
});

test('no company file imports the brain, the mood, memory or the initiative; none of those imports the company', () => {
  const outside = /(^|\/)(brain|mood|memory|initiative)(\/|$)/;
  for (const dir of COMPANY) for (const file of filesIn(dir)) for (const spec of importsOf(file)) {
    assert.ok(!outside.test(spec), `${file} imports ${spec}`);
  }
  for (const dir of ['electron/brain', 'shared/brain', 'src/brain', 'electron/mood', 'shared/mood', 'electron/memory', 'electron/initiative']) {
    for (const file of filesIn(dir)) for (const spec of importsOf(file)) assert.ok(!/unbound\/company/.test(spec), `${file} imports ${spec}`);
  }
});
