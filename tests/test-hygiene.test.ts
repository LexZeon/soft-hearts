/**
 * Tests that cannot take the machine (2026-11-20): a failing assert.deepEqual prints a diff of both sides, and a model's expression binds
 * hold three.js meshes (geometry, skeleton, materials, parents: a graph of millions of values). One such failing compare in
 * tests/vrm-native-load.test.ts grew its process to 32 GB while the user was using the computer. Binds are compared as numbers (index,
 * weight, `bind.mesh === …`); this check refuses a test file that compares a bind list or a bind's mesh as an object.
 * scripts/dev/test-all.mjs adds a 4 GB V8 heap cap, but that did NOT stop this case (46 GB with the cap: the memory is outside the heap),
 * so this check is the guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name))
  : /\.(ts|mjs)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);

/** An equality assert whose first argument is a raw bind list (…expression(…), …faceShape(…) not mapped to plain values). */
const RAW_BINDS = new RegExp(String.raw`assert\.(?:deepEqual|deepStrictEqual|equal|strictEqual)\(\s*[\w.!?\[\]]+\.(?:expression|expressionNamed|faceShape)!?\([^()]*\)\s*,`);
/** A bind's mesh (a three.js object) as a compared value inside an equality assert. */
const MESH_VALUE = new RegExp(String.raw`assert\.(?:deepEqual|deepStrictEqual)\(.*\bbind\.mesh\b(?!\s*[=!]==)`);

export function offending(text: string): string[] {
  return text.split('\n').filter(line => RAW_BINDS.test(line) || MESH_VALUE.test(line));
}

test('the check catches a raw bind list and a mesh inside deepEqual, and lets numbers through', () => {
  const call = (inner: string) => `  assert.deepEqual(${inner}, []);`;
  assert.equal(offending(call("model.expression('jitome')")).length, 1);
  assert.equal(offending(call("body.model.faceShape!('cheekPuff')")).length, 1);
  assert.equal(offending(call("loaded.expression('blink').map(bind => [bind.mesh, bind.index])")).length, 1);
  assert.equal(offending(call("model.expression('jitome').map(bind => [bind.index, bind.weight])")).length, 0);
  assert.equal(offending(call("loaded.expression('blink').map(bind => [bind.mesh === mesh, bind.index])")).length, 0);
});

test('no test compares three.js objects through a failing-diff path', () => {
  const self = path.resolve(import.meta.filename);
  const found = files(root).filter(file => path.resolve(file) !== self).flatMap(file => offending(readFileSync(file, 'utf8')).map(line => `${path.relative(root, file)}: ${line.trim()}`));
  assert.deepEqual(found, [], 'compare binds as numbers (index, weight, bind.mesh === …)');
});
