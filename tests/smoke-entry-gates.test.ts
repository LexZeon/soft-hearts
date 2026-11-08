import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = await import(new URL('../scripts/lib/smoke-isolation.mjs', import.meta.url).href);
const currentSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const members: string[] = [...helper.SMOKE_HARNESS_FILES];
async function withTrees(run: (source: string, trusted: string) => Promise<void>) {
  const temporary = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporary, 'soft-hearts-smoke-entry-gates-')));
  const source = path.join(root, 'candidate'), trusted = path.join(root, 'trusted');
  try {
    for (const tree of [source, trusted]) for (const member of members) {
      await mkdir(path.dirname(path.join(tree, member)), { recursive: true });
      await writeFile(path.join(tree, member), await readFile(path.join(currentSource, member)));
    }
    await run(source, trusted);
  } finally {
    assert.equal(path.dirname(root).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(root).startsWith('soft-hearts-smoke-entry-gates-'));
    await rm(root, { recursive: true });
  }
}

test('deployment actual gate rejects legacy/missing/weak proof instead of entering receipt or deploy work', () => {
  const safe = { version: 1, inputs: ['scripts/smoke.mjs'], safeSmoke: 1, preparedSha256: 'a'.repeat(64), smokeReportSha256: 'b'.repeat(64) };
  helper.assertSafeDeploymentProof(safe);
  const { safeSmoke, preparedSha256, smokeReportSha256, ...legacy } = safe;
  assert.throws(() => helper.assertSafeDeploymentProof(legacy), /Prepare a new candidate/);
  for (const proof of [null, { ...safe, safeSmoke: true }, { ...safe, safeSmoke: '1' }, { ...safe, smokePending: true }, { ...safe, preparedSha256: undefined }, { ...safe, smokeReportSha256: 'not-a-hash' }, { ...safe, inputs: [] }]) assert.throws(() => helper.assertSafeDeploymentProof(proof));
});

test('actual harness gate rejects legacy runner, changed helper and missing member before restoring exact accepted source', async () => {
  await withTrees(async (source, trusted) => {
    const originalRunner = await readFile(path.join(source, members[0]));
    await writeFile(path.join(source, members[0]), '// inert legacy fixture; never executed\n');
    await assert.rejects(helper.assertSmokeHarnessIdentity(source, trusted), /Merge the reviewed safe smoke runner/);
    await writeFile(path.join(source, members[0]), originalRunner);
    const originalHelper = await readFile(path.join(source, members[1]));
    await writeFile(path.join(source, members[1]), '// inert changed helper; never imported\n');
    await assert.rejects(helper.assertSmokeHarnessIdentity(source, trusted));
    await rm(path.join(source, members[1])); await assert.rejects(helper.assertSmokeHarnessIdentity(source, trusted));
    await writeFile(path.join(source, members[1]), originalHelper);
    // The fake Claude Code the smoke launches is part of the reviewed harness too.
    assert.equal(members[2], 'scripts/lib/fake-claude.mjs');
    const originalFake = await readFile(path.join(source, members[2]));
    await writeFile(path.join(source, members[2]), '// inert changed fake; never executed\n');
    await assert.rejects(helper.assertSmokeHarnessIdentity(source, trusted), /Merge the reviewed safe smoke runner/);
    await writeFile(path.join(source, members[2]), originalFake);
    const pinned = await helper.assertSmokeHarnessIdentity(source, trusted);
    assert.deepEqual(pinned.map(([file]: [string, string]) => file), members);
    assert.deepEqual(await helper.assertSmokeHarnessIdentity(source, trusted, pinned), pinned);
  });
});

test('captured actual harness pins reject trusted and candidate drift even when their new bytes agree', async () => {
  await withTrees(async (source, trusted) => {
    const pinned = await helper.assertSmokeHarnessIdentity(source, trusted);
    for (const tree of [source, trusted]) await writeFile(path.join(tree, members[0]), '// inert matching drift; never executed\n');
    await assert.rejects(helper.assertSmokeHarnessIdentity(source, trusted, pinned), /trusted smoke harness changed/);
  });
});
