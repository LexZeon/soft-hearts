// The internal channel's golden (scripts/dev/app-tools-golden.ts, docs/claude/2026-11-17-app-tools-split.md). The user's own Claude
// operates the companion through these tools: which tools exist, each one's tier, when it needs the user's words, when it always opens a
// dialog, what the dialog and the notice say, what it does to the app, what it offers to undo, and the handbook text it reads. Any of
// those changing is a real change for the user, so it must show here and be regenerated on purpose:
//   node node_modules/tsx/dist/cli.mjs scripts/dev/app-tools-golden.ts --write    (and say why in the commit)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { behaviourGolden, catalogGolden, definitionsGolden, exposureGolden, helpersGolden } from './helpers/app-tools-world';
import { GOLDEN_FILE, surfaceGolden } from '../scripts/dev/app-tools-golden';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN_FILE), 'utf8')) as Record<string, any>;
const REGENERATE = 'if this change is intended, regenerate with `node node_modules/tsx/dist/cli.mjs scripts/dev/app-tools-golden.ts --write` and say why in the commit';
const same = (live: unknown, recorded: unknown, what: string) => {
  assert.deepEqual(live, recorded, `${what} changed; ${REGENERATE}`);
  assert.equal(JSON.stringify(live), JSON.stringify(recorded), `${what}: the order changed; ${REGENERATE}`);
};

test('the catalog the user\'s Claude reads: tools, descriptions, input schemas, settings, never-exposed, always-dialog', () => {
  const live = catalogGolden() as Record<string, unknown>;
  assert.deepEqual(Object.keys(live), Object.keys(golden.catalog));
  for (const key of Object.keys(golden.catalog)) same(live[key], golden.catalog[key], `catalog.${key}`);
});

test('the tool list: the same tools in the same order, each with the same tier, flags and hooks', () => {
  const live = definitionsGolden() as { name: string }[];
  same(live.map(item => item.name), golden.definitions.map((item: { name: string }) => item.name), 'the tool names (a tool added, removed, renamed or registered twice)');
  for (const [i, item] of live.entries()) same(item, golden.definitions[i], `tool ${item.name}`);
});

test('which tools exist with 三方互通 on and off, and their tiers', () => {
  same(exposureGolden(), golden.exposure, 'exposure');
});

test('exported helpers and texts', () => {
  const live = helpersGolden();
  assert.deepEqual(Object.keys(live), Object.keys(golden.helpers));
  for (const key of Object.keys(golden.helpers)) same(live[key], golden.helpers[key], `helpers.${key}`);
});

test('every tool, every sample, every way it can be called: the same answer, dialog, notice, record, host operations and undo', async () => {
  const live = await behaviourGolden();
  assert.deepEqual(Object.keys(live), Object.keys(golden.behaviour), `tools in the behaviour golden; ${REGENERATE}`);
  for (const tool of Object.keys(golden.behaviour)) {
    assert.deepEqual(Object.keys(live[tool]), Object.keys(golden.behaviour[tool]), `${tool}: samples; ${REGENERATE}`);
    for (const sample of Object.keys(golden.behaviour[tool])) {
      const runs = golden.behaviour[tool][sample];
      assert.deepEqual(Object.keys(live[tool][sample]), Object.keys(runs), `${tool} ${sample}: modes`);
      for (const mode of Object.keys(runs)) assert.deepEqual(live[tool][sample][mode], runs[mode], `${tool} ${sample} (${mode}) changed; ${REGENERATE}`);
    }
  }
});

test('the export surface of app-tools.ts (types read with the checker)', async () => {
  const live = await surfaceGolden(ROOT) as Record<string, unknown>;
  assert.deepEqual(Object.keys(live), Object.keys(golden.surface), `exports added or removed; ${REGENERATE}`);
  for (const name of Object.keys(golden.surface)) same(live[name], golden.surface[name], `export ${name}`);
});
