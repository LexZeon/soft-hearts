import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValidationIdentity, ensureDevelopmentProfile, nativeProductUnitPlan, requireUnitSummary, runtimeInputs, selectUnitTestFiles } from '../scripts/update-desktop.mjs';
import { assertPreparedSourceIdentity, assertRuntimeSourceEquivalence } from '../scripts/lib/smoke-isolation.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const full = { sourceHash: 'a'.repeat(64), inputs: ['src/main.ts', 'tests/first.test.ts', 'tests/platform.test.mjs'],
  expectedHash: 'a'.repeat(64), expectedCount: 3, expectedTestInputs: 2 };

test('a production-only list cannot qualify the frozen complete validation source', () => {
  assert.throws(() => assertValidationIdentity({ ...full, sourceHash: 'b'.repeat(64), inputs: ['src/main.ts'] }), /differ/);
  assert.throws(() => assertValidationIdentity({ sourceHash: 'b'.repeat(64), inputs: ['src/main.ts'], coordinated: false }), /no test files/);
});
test('equal counts do not conceal changed source bytes or missing expected identity', () => {
  assert.throws(() => assertValidationIdentity({ ...full, sourceHash: 'b'.repeat(64) }), /differ/);
  assert.throws(() => assertValidationIdentity({ ...full, expectedHash: undefined }), /requires/);
  assert.throws(() => assertValidationIdentity({ ...full, expectedTestInputs: 1 }), /differ/);
  assert.deepEqual(assertValidationIdentity(full), { sourceHash: full.sourceHash, inputCount: 3, testInputCount: 2 });
});
test('both existing TypeScript tests and platform JavaScript tests are selected without an empty glob', () => {
  assert.deepEqual(selectUnitTestFiles([...full.inputs, 'tests/helper.ts']), ['tests/first.test.ts', 'tests/platform.test.mjs']);
  assert.throws(() => selectUnitTestFiles(['src/main.ts']), /No executable/);
});
test('native product validation explicitly retains the stopped legacy scope and requires its new product coverage', () => {
  const required = ['tests/desktop-channel.test.ts', 'tests/desktop-entry-chain.test.ts', 'tests/desktop-shortcut.test.ts', 'tests/pin-delivery.test.ts'];
  const inputs = [...required, 'tests/start-latest.test.ts', 'tests/platform.test.mjs'];
  assert.throws(() => selectUnitTestFiles(inputs), /legacy PowerShell/);
  const plan = nativeProductUnitPlan(inputs);
  assert.equal(plan.originalLegacyScopePassed, false);
  assert.deepEqual(plan.legacyBlocked, [{ path: 'tests/start-latest.test.ts', reason: 'PS_SCRIPT_SCOPE_BLOCKED' }]);
  assert.ok(!plan.testFiles.includes('tests/start-latest.test.ts'));
  for (const file of required) assert.ok(plan.testFiles.includes(file));
  assert.throws(() => nativeProductUnitPlan(inputs.filter(file => file !== required[0])), /missing necessary coverage/);
});
test('the frozen validation copy contains every repository file the launcher and identity tests read', () => {
  // prepare() runs all unit tests inside .local/desktop-updates/<time>/source; a file missing there fails packaging.
  for (const file of ['package.json', 'start-soft-hearts.cmd', 'promote-to-stable.cmd']) assert.ok(runtimeInputs.fixed.includes(file), file);
  for (const folder of ['electron', 'scripts', 'tests', 'shared', 'src']) assert.ok(runtimeInputs.folders.includes(folder), folder);
});
test('a zero-test successful process is still a validation failure', () => {
  assert.throws(() => requireUnitSummary('ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n'), /nonempty/);
  assert.throws(() => requireUnitSummary('command exited zero'), /nonempty/);
  assert.throws(() => requireUnitSummary('# tests 2\n# pass 1\n# fail 1\n# skipped 0\n'), /nonempty/);
});
test('the final actual nonempty summary preserves its pass and skip counts', () => {
  assert.deepEqual(requireUnitSummary('ℹ tests 49\nℹ pass 47\nℹ fail 0\nℹ skipped 2\n'), { tests: 49, pass: 47, fail: 0, skipped: 2 });
  assert.deepEqual(requireUnitSummary('# tests 2\n# pass 2\n# fail 0\n# skipped 0\n'), { tests: 2, pass: 2, fail: 0, skipped: 0 });
});

test('reusing a compiled artifact permits validation and entry changes but rejects product or recipe changes', () => {
  const old = [['src/main.ts', 'a'.repeat(64)], ['package.json', 'b'.repeat(64)], ['scripts/smoke.mjs', 'c'.repeat(64)]];
  const next = [...old.slice(0, 2), ['scripts/smoke.mjs', 'd'.repeat(64)], ['tests/new.test.mjs', 'e'.repeat(64)]];
  assert.doesNotThrow(() => assertRuntimeSourceEquivalence(old, next));
  assert.throws(() => assertRuntimeSourceEquivalence(old, next.map(row => row[0] === 'src/main.ts' ? [row[0], 'f'.repeat(64)] : row)), /production or its build recipe/);
  assert.throws(() => assertRuntimeSourceEquivalence(old, next.filter(row => row[0] !== 'package.json')), /production or its build recipe/);
  assert.throws(() => assertRuntimeSourceEquivalence(old, [...next, ['electron/new.ts', 'f'.repeat(64)]]), /production or its build recipe/);
});

test('the development profile is explicit and preserves normal data while refusing overlap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-channel-profile-'));
  try {
    await mkdir(path.join(root, 'release')); const normal = path.join(root, 'normal'); await mkdir(normal);
    const environment = { APPDATA: path.join(root, 'Roaming') }; await mkdir(environment.APPDATA);
    const normalConfig = JSON.stringify({ version: 1, directory: normal });
    await writeFile(path.join(root, 'release', 'desktop-profile.json'), normalConfig);
    await writeFile(path.join(normal, 'settings.json'), 'original private fixture');
    const created = await ensureDevelopmentProfile(root, environment);
    assert.equal(created.directory, path.join(environment.APPDATA, 'soft-hearts-claude-dev'));
    assert.equal((await ensureDevelopmentProfile(root, environment)).directory, created.directory);
    assert.equal(await readFile(path.join(normal, 'settings.json'), 'utf8'), 'original private fixture');
    assert.equal(await readFile(path.join(root, 'release', 'desktop-profile.json'), 'utf8'), normalConfig);
    await writeFile(path.join(root, 'release', 'desktop-development-profile.json'), normalConfig);
    await assert.rejects(ensureDevelopmentProfile(root, environment), /must be separate/);
    assert.equal(await readFile(path.join(root, 'release', 'desktop-development-profile.json'), 'utf8'), normalConfig);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('soft-channel-profile-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('a reused pending receipt binds separate original runtime and complete validation sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-channel-reuse-'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const oldCandidate = path.join(root, '.local', 'desktop-updates', 'old'), nextCandidate = path.join(root, '.local', 'desktop-updates', 'next');
  const oldSource = path.join(oldCandidate, 'source'), nextSource = path.join(nextCandidate, 'source');
  try {
    const oldFiles = { 'scripts/smoke.mjs': 'old inert maintainer script', 'shared/version.ts': 'same production' };
    const nextFiles = { ...oldFiles, 'scripts/smoke.mjs': 'new inert maintainer script', 'tests/basic.test.ts': 'inert synthetic test input' };
    for (const [base, entries] of [[oldSource, oldFiles], [nextSource, nextFiles]]) for (const [name, bytes] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(base, name)), { recursive: true }); await writeFile(path.join(base, name), bytes);
    }
    const identity = entries => digest(JSON.stringify(Object.keys(entries).sort().map(name => [name, digest(entries[name])])));
    const old = { version: 1, sourceHash: identity(oldFiles), inputs: Object.keys(oldFiles).sort(), asarSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
    const oldFile = path.join(oldCandidate, 'prepared.json'), oldBytes = JSON.stringify(old); await writeFile(oldFile, oldBytes);
    const proofFile = path.join(nextCandidate, 'prepared.json');
    const proof = { ...old, reusedFrom: { prepared: path.relative(root, oldFile), sha256: digest(oldBytes) }, validationIdentity: { sourceHash: identity(nextFiles), inputs: Object.keys(nextFiles).sort() } };
    await assertPreparedSourceIdentity(nextSource, proofFile, proof);
    await writeFile(path.join(nextSource, 'tests/basic.test.ts'), 'changed test after preparation');
    await assert.rejects(assertPreparedSourceIdentity(nextSource, proofFile, proof));
    await writeFile(path.join(nextSource, 'tests/basic.test.ts'), nextFiles['tests/basic.test.ts']);
    await writeFile(oldFile, oldBytes + ' ');
    await assert.rejects(assertPreparedSourceIdentity(nextSource, proofFile, proof));
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('soft-channel-reuse-'));
    await rm(root, { recursive: true, force: true });
  }
});
