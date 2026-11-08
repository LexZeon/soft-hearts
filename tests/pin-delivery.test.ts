import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { commitDeliveryPointer, pinDelivery } from '../scripts/pin-delivery.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-delivery-pin-'));
  const root = path.join(directory, 'project space 中文');
  const candidate = path.join(root, '.local', 'desktop-updates', 'complete-candidate');
  const frozen = path.join(candidate, 'source');
  const bundle = path.join(frozen, 'release', 'win-arm64-unpacked');
  const sourceFile = path.join(frozen, 'shared', 'version.ts');
  const testFile = path.join(frozen, 'tests', 'version.test.ts');
  const asar = path.join(bundle, 'resources', 'app.asar');
  const executable = path.join(bundle, 'soft hearts next.exe');
  const latest = path.join(root, 'release', 'win-arm64-unpacked');
  const current = path.join(root, 'release', 'desktop-current.json');
  const manifest = path.join(root, 'release', 'desktop-delivered.json');
  const oldLauncher = path.join(root, 'release', 'start-delivered.ps1');
  const shortcut = path.join(directory, 'desktop', 'soft hearts next - 稳定版.lnk');
  const profile = path.join(root, 'release', 'desktop-profile.json');
  const privateFile = path.join(root, 'private-profile', 'characters.json');
  for (const file of [sourceFile, testFile, asar, shortcut, privateFile, path.join(latest, 'resources', 'app.asar')])
    await mkdir(path.dirname(file), { recursive: true });
  await writeFile(sourceFile, 'export const version = 1;');
  await writeFile(testFile, '// Synthetic frozen test input. This file is never executed.');
  await writeFile(asar, 'complete validated app');
  await writeFile(executable, 'fixture executable: never run');
  await writeFile(path.join(bundle, 'library.dll'), 'fixture library');
  await writeFile(path.join(latest, 'resources', 'app.asar'), 'latest remains independent');
  await writeFile(current, '{"latest":"unchanged"}');
  await writeFile(privateFile, 'private fixture outside the app');
  await writeFile(profile, JSON.stringify({ version: 1, directory: path.dirname(privateFile) }));
  await writeFile(manifest, '{"version":1,"buildId":"historical-f037","executable":"release/delivered/f037/soft hearts next.exe"}\n');
  await writeFile(oldLauncher, '# historical fixed launcher bytes; never executed\n');
  await writeFile(shortcut, 'historical complete-delivery shortcut bytes; never invoked');
  const mandatoryProductTests = ['tests/desktop-channel.test.ts', 'tests/desktop-entry-chain.test.ts', 'tests/desktop-shortcut.test.ts', 'tests/pin-delivery.test.ts'];
  const inputs = ['shared/version.ts', 'tests/version.test.ts', 'tests/start-latest.test.ts', ...mandatoryProductTests].sort();
  for (const file of inputs.filter(file => file.startsWith('tests/') && file !== 'tests/version.test.ts')) await writeFile(path.join(frozen, file), '// synthetic frozen input, never executed');
  const rows = await Promise.all(inputs.map(async name => [name, digest(await readFile(path.join(frozen, name)))]));
  const proofFile = path.join(candidate, 'validated.json');
  const base = {
    version: 1, entryKind: 'native-product-v1', sourceHash: digest(JSON.stringify(rows)),
    asarSha256: digest(await readFile(asar)), executableSha256: digest(await readFile(executable)),
    inputs, unpacked: path.relative(root, bundle), preparedAt: '2026-11-01T20:00:00.000Z',
    validationIdentity: { sourceHash: digest(JSON.stringify(rows)), inputs, unitSummary: { tests: 2, pass: 2, fail: 0, skipped: 0 },
      executedTestFiles: 5, unitPlan: { scope: 'native-product-and-existing-nonlegacy-v1',
        testFiles: inputs.filter(file => file.startsWith('tests/') && file !== 'tests/start-latest.test.ts'), mandatoryProductTests,
        legacyBlocked: [{ path: 'tests/start-latest.test.ts', reason: 'PS_SCRIPT_SCOPE_BLOCKED', sha256: digest(await readFile(path.join(frozen, 'tests/start-latest.test.ts'))) }], originalLegacyScopePassed: false } },
  };
  async function proof(overrides = {}) {
    const prepared = { ...base, ...overrides, smokePending: true };
    const preparedBytes = Buffer.from(JSON.stringify(prepared));
    const receipt = {
      version: 1, status: 'PASS', preparedSha256: digest(preparedBytes),
      identity: { entryKind: prepared.entryKind, sourceHash: prepared.sourceHash, asarSha256: prepared.asarSha256, executableSha256: prepared.executableSha256 },
      cleanup: { sdkCloseResolved: true, actualMainExited: true, fakeClaudeExited: true, profileRemoved: true, main: { absent: true } },
    };
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    const { smokePending, ...identity } = prepared;
    const result = { ...identity, safeSmoke: 1, preparedSha256: digest(preparedBytes), smokeReportSha256: digest(receiptBytes), validatedAt: '2026-11-01T20:01:00.000Z' };
    await writeFile(path.join(candidate, 'prepared.json'), preparedBytes);
    await writeFile(path.join(candidate, 'smoke-result.json'), receiptBytes);
    await writeFile(proofFile, JSON.stringify(result));
    return result;
  }
  const initialProof = await proof();
  const options = { stableShortcutPath: shortcut };
  return {
    root, candidate, frozen, bundle, sourceFile, testFile, asar, latest, current, manifest, oldLauncher, shortcut, profile, privateFile,
    initialProof, base, proofFile, proof, options,
    async close() {
      const absolute = path.resolve(directory);
      assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
      assert.ok(path.basename(absolute).startsWith('soft-delivery-pin-'));
      await rm(absolute, { recursive: true, force: true });
    },
  };
}

test('native product coverage cannot silently drop its mandatory tests or turn blocked legacy checks into a pass', async () => {
  const f = await fixture();
  try {
    const plan = f.base.validationIdentity.unitPlan;
    for (const unitPlan of [
      { ...plan, originalLegacyScopePassed: true },
      { ...plan, testFiles: plan.testFiles.slice(1) },
      { ...plan, mandatoryProductTests: [] },
      { ...plan, legacyBlocked: [] },
      { ...plan, legacyBlocked: [{ ...plan.legacyBlocked[0], sha256: '0'.repeat(64) }] },
    ]) {
      await f.proof({ validationIdentity: { ...f.base.validationIdentity, unitPlan } });
      await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /coverage|blocked legacy/);
    }
  } finally { await f.close(); }
});

test('staging preserves both pointers, shortcut and profile while copying a complete immutable bundle', async () => {
  const f = await fixture();
  try {
    const protectedFiles = [f.current, f.manifest, f.shortcut, f.profile, f.privateFile, f.oldLauncher];
    const before = await Promise.all(protectedFiles.map(file => readFile(file)));
    const result = await pinDelivery(f.root, f.candidate, f.options);
    assert.equal(result.channel, 'stable');
    assert.equal(result.pointerUpdated, false);
    assert.equal(result.shortcutUpdated, false);
    assert.equal(result.runningVersionChanged, false);
    assert.equal(result.manifest.buildId, f.initialProof.sourceHash);
    assert.equal(result.manifest.entryKind, 'native-product-v1');
    assert.equal(Object.hasOwn(result.manifest, 'launcher'), false);
    assert.equal(Object.hasOwn(result.manifest, 'launcherSha256'), false);
    assert.equal(result.stableProfile, await realpath(path.dirname(f.privateFile)));
    assert.equal(result.ownerMarker, digest((await realpath(f.root)).toLowerCase() + '\nstable\n' + result.stableProfile!.toLowerCase()).slice(0, 24));
    assert.equal(result.manifest.validationSourceHash, f.initialProof.sourceHash);
    assert.equal(result.manifest.validationInputCount, f.base.inputs.length);
    assert.equal(result.manifest.asarSha256, f.initialProof.asarSha256);
    assert.match(result.manifest.executable, /^release\/stable\/[a-f0-9]{64}\/win-arm64-unpacked\/soft hearts next\.exe$/);
    assert.equal(await readFile(path.join(result.target, 'resources', 'app.asar'), 'utf8'), 'complete validated app');
    assert.deepEqual((await readdir(result.target)).sort(), ['library.dll', 'resources', 'soft hearts next.exe']);
    assert.equal(path.basename(result.manifestFile), 'stable-manifest.json');
    assert.equal(path.dirname(result.manifestFile), path.dirname(result.target));
    assert.equal(digest(await readFile(result.manifestFile)), result.manifestSha256);
    assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file))), before);
    const repeated = await pinDelivery(f.root, path.relative(f.root, f.candidate), f.options);
    assert.deepEqual(repeated.manifest, result.manifest);
    assert.equal(repeated.manifestSha256, result.manifestSha256);
    assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file))), before);
  } finally { await f.close(); }
});

test('staging archives exact historical f037 metadata, launcher and shortcut while preserving originals', async () => {
  const f = await fixture();
  try {
    const originals = new Map(await Promise.all([['desktop-delivered.json', f.manifest], ['launcher.ps1', f.oldLauncher], ['complete-delivery.lnk', f.shortcut]].map(async ([name, file]) => [name, await readFile(file)] as const)));
    const result = await pinDelivery(f.root, f.candidate, f.options);
    assert.ok(result.history);
    for (const member of result.history.members) {
      assert.deepEqual(await readFile(path.join(f.root, result.history.directory, member.name)), originals.get(member.name));
      assert.equal(member.sha256, digest(originals.get(member.name)!));
    }
    assert.equal(result.history.previous.buildId, 'historical-f037');
    await assert.rejects(pinDelivery(f.root, f.candidate, { ...f.options, stableShortcutPath: undefined }), /existing stable shortcut/);
    for (const codexLink of ['soft hearts - 完整交付版.lnk', 'soft hearts.lnk']) {
      const foreign = path.join(path.dirname(f.shortcut), codexLink);
      await writeFile(foreign, 'Codex edition link bytes: must never be read or archived');
      await assert.rejects(pinDelivery(f.root, f.candidate, { ...f.options, stableShortcutPath: foreign }), /Only the specified/);
    }
    assert.deepEqual(await readFile(f.shortcut), originals.get('complete-delivery.lnk'));
  } finally { await f.close(); }
});

test('development staging and pointer commit cannot replace the complete stable version or normal profile', async () => {
  const f = await fixture();
  try {
    const stable = await pinDelivery(f.root, f.candidate, f.options);
    const stableBytes = await readFile(stable.manifestFile);
    const before = await Promise.all([f.manifest, f.profile, f.shortcut].map(file => readFile(file)));
    const development = await pinDelivery(f.root, f.candidate, { ...f.options, channel: 'development' });
    assert.notEqual(development.target, stable.target);
    assert.match(development.manifest.executable, /^release\/development\/[a-f0-9]{64}\//);
    assert.equal(development.history, null);
    await assert.rejects(commitDeliveryPointer(f.root, development), /exact development shortcut/);
    const developmentLink = path.join(path.dirname(f.shortcut), 'soft hearts next - 最新开发版.lnk');
    await writeFile(developmentLink, 'synthetic development shortcut bytes: no shell operation');
    const developmentReceipt = await syntheticShortcutReceipt(f, development, developmentLink);
    for (const mismatch of [{ shortcutPath: f.shortcut }, { kind: 'native-stable-shortcut-v1' }, { arguments: '--soft-hearts-channel=stable' },
      { shortcutPath: path.join(path.dirname(f.shortcut), 'soft hearts.lnk') }])
      await assert.rejects(commitDeliveryPointer(f.root, development, { shortcutReceipt: { ...developmentReceipt, ...mismatch } }), /exact development shortcut/);
    assert.deepEqual(await readFile(f.current), Buffer.from('{"latest":"unchanged"}'));
    const committed = await commitDeliveryPointer(f.root, development, { shortcutReceipt: developmentReceipt });
    assert.equal(committed.pointerUpdated, true);
    assert.equal(committed.runningVersionChanged, false);
    assert.deepEqual(JSON.parse(await readFile(f.current, 'utf8')), development.manifest);
    assert.deepEqual(await Promise.all([f.manifest, f.profile, f.shortcut].map(file => readFile(file))), before);
    assert.deepEqual(await readFile(stable.manifestFile), stableBytes);
    assert.equal(await readFile(path.join(stable.target, 'resources', 'app.asar'), 'utf8'), 'complete validated app');
  } finally { await f.close(); }
});

test('modified frozen source, ASAR or executable cannot advance the complete delivery', async () => {
  const f = await fixture();
  try {
    const pinned = await pinDelivery(f.root, f.candidate, f.options);
    const previous = await readFile(f.manifest);
    await writeFile(f.sourceFile, 'changed unfinished source');
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /validation source identity differs/);
    await writeFile(f.sourceFile, 'export const version = 1;');
    await writeFile(f.asar, 'changed app package');
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /binary bytes changed/);
    await writeFile(f.asar, 'complete validated app');
    await writeFile(path.join(f.bundle, 'soft hearts next.exe'), 'changed executable');
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /binary bytes changed/);
    assert.deepEqual(await readFile(f.manifest), previous);
    assert.equal(await readFile(path.join(pinned.target, 'resources', 'app.asar'), 'utf8'), 'complete validated app');
  } finally { await f.close(); }
});

test('outside candidates and escaping frozen input or bundle paths are rejected before selection', async () => {
  const f = await fixture();
  try {
    const previous = await readFile(f.manifest);
    await assert.rejects(pinDelivery(f.root, f.latest, f.options), /validated owned candidate/);
    await f.proof({ validationIdentity: { ...f.base.validationIdentity, inputs: ['../private-profile/characters.json'] } });
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /escaped its boundary/);
    await f.proof({ unpacked: path.relative(f.root, f.latest) });
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /complete bundle location/);
    assert.deepEqual(await readFile(f.manifest), previous);
  } finally { await f.close(); }
});

test('accidentally bundled profile data is refused and never copied', async () => {
  const f = await fixture();
  try {
    const previous = await readFile(f.manifest);
    await writeFile(path.join(f.bundle, 'characters.json'), 'private fixture must not be pinned');
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /Private profile\/configuration data/);
    assert.deepEqual(await readFile(f.manifest), previous);
    assert.ok(!(await readdir(path.join(f.root, 'release'))).includes('stable'));
  } finally { await f.close(); }
});

test('an existing immutable complete bundle is never overwritten to hide changed bytes', async () => {
  const f = await fixture();
  try {
    const result = await pinDelivery(f.root, f.candidate, f.options);
    const previous = await readFile(f.manifest);
    const changed = path.join(result.target, 'library.dll');
    await writeFile(changed, 'unexpected local change');
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /immutable complete version differs/);
    assert.equal(await readFile(changed, 'utf8'), 'unexpected local change');
    assert.deepEqual(await readFile(f.manifest), previous);
  } finally { await f.close(); }
});

test('junctions or links in an unpacked bundle are rejected without reading their private contents', async t => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, 'private-profile');
    try { await symlink(outside, path.join(f.bundle, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('link creation unavailable'); return; } throw error; }
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /Artifact links are unsupported/);
    assert.equal(await readFile(f.privateFile, 'utf8'), 'private fixture outside the app');
  } finally { await f.close(); }
});

test('zero tests and missing smoke cleanup cannot qualify an immutable channel version', async () => {
  const f = await fixture();
  try {
    const previous = await readFile(f.manifest);
    await f.proof({ validationIdentity: { ...f.base.validationIdentity, unitSummary: { tests: 0, pass: 0, fail: 0, skipped: 0 } } });
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /Formal validation is incomplete/);
    await f.proof();
    const receiptFile = path.join(f.candidate, 'smoke-result.json');
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    receipt.cleanup.actualMainExited = false;
    const bytes = Buffer.from(JSON.stringify(receipt));
    await writeFile(receiptFile, bytes);
    await writeFile(f.proofFile, JSON.stringify({ ...f.initialProof, smokeReportSha256: digest(bytes) }));
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /cleanup was not confirmed/);
    assert.deepEqual(await readFile(f.manifest), previous);
  } finally { await f.close(); }
});

test('a candidate without the native product entry capability cannot stage a channel version', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.manifest);
    await f.proof({ entryKind: undefined });
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /native.product|native entry|entry capability/i);
    await f.proof({ entryKind: 'legacy-script-v1' });
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /native.product|native entry|entry capability/i);
    await f.proof();
    const preparedFile = path.join(f.candidate, 'prepared.json');
    const prepared = JSON.parse(await readFile(preparedFile, 'utf8'));
    delete prepared.entryKind;
    const preparedBytes = Buffer.from(JSON.stringify(prepared));
    const receiptFile = path.join(f.candidate, 'smoke-result.json');
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    receipt.preparedSha256 = digest(preparedBytes);
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    await writeFile(preparedFile, preparedBytes);
    await writeFile(receiptFile, receiptBytes);
    await writeFile(f.proofFile, JSON.stringify({ ...f.initialProof, preparedSha256: digest(preparedBytes), smokeReportSha256: digest(receiptBytes) }));
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /native.product|native entry|entry capability/i);
    assert.deepEqual(await readFile(f.manifest), before);
  } finally { await f.close(); }
});

test('commit rejects changed staged metadata or dependency bytes and preserves the selected development pointer', async () => {
  const f = await fixture();
  try {
    const staged = await pinDelivery(f.root, f.candidate, { ...f.options, channel: 'development' });
    const previous = await readFile(f.current);
    const metadata = await readFile(staged.manifestFile);
    await writeFile(staged.manifestFile, metadata.toString() + ' ');
    await assert.rejects(commitDeliveryPointer(f.root, staged), /metadata changed/);
    await writeFile(staged.manifestFile, metadata);
    await writeFile(path.join(staged.target, 'library.dll'), 'changed staged dependency');
    await assert.rejects(commitDeliveryPointer(f.root, staged), /complete bundle changed/);
    assert.deepEqual(await readFile(f.current), previous);
    assert.equal(await readFile(f.shortcut, 'utf8'), 'historical complete-delivery shortcut bytes; never invoked');
  } finally { await f.close(); }
});

test('incoherent or negative formal summary counts cannot qualify a channel version', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.manifest);
    for (const unitSummary of [
      { tests: 2, pass: 0, fail: 0, skipped: 0 },
      { tests: 2, pass: 3, fail: 0, skipped: -1 },
      { tests: Number.MAX_SAFE_INTEGER + 1, pass: Number.MAX_SAFE_INTEGER + 1, fail: 0, skipped: 0 },
    ]) {
      await f.proof({ validationIdentity: { ...f.base.validationIdentity, unitSummary } });
      await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /Formal validation is incomplete/);
      assert.deepEqual(await readFile(f.manifest), before);
    }
  } finally { await f.close(); }
});

// These are synthetic filesystem receipts. They prove the commit gate only,
// never an Electron shell shortcut write, native entry or Explorer double-click.
async function syntheticShortcutReceipt(f: Awaited<ReturnType<typeof fixture>>, staged: any, shortcutPath = f.shortcut) {
  const executable = path.join(await realpath(f.root), staged.manifest.executable);
  return {
    kind: `native-${staged.channel}-shortcut-v1`, channel: staged.channel, manifestSha256: staged.manifestSha256, executable,
    shortcutPath, shortcutSha256: digest(await readFile(shortcutPath)),
    targetPath: executable,
    arguments: '--soft-hearts-channel=' + staged.channel, previous: null,
  };
}

test('stable pointer requires its exact current shortcut receipt and rejects missing, mismatched or stale receipts', async () => {
  const f = await fixture();
  try {
    const staged = await pinDelivery(f.root, f.candidate, f.options);
    const before = await readFile(f.manifest);
    await assert.rejects(commitDeliveryPointer(f.root, staged), /exact stable shortcut/);
    await writeFile(f.shortcut, 'synthetic next shortcut bytes: no shell operation');
    const receipt = await syntheticShortcutReceipt(f, staged);
    for (const mismatch of [
      { kind: 'legacy-script-shortcut-v1' },
      { channel: 'development' },
      { manifestSha256: '0'.repeat(64) },
      { executable: path.join(f.root, 'release', 'soft hearts.exe') }, // Codex edition name: never accepted
      { shortcutPath: path.join(path.dirname(f.shortcut), 'soft hearts.lnk') },
      { shortcutSha256: '0'.repeat(64) },
      { targetPath: path.join(f.root, 'other.exe') },
      { targetPath: path.join(f.root, 'foreign-tool', 'soft hearts.exe') },
      { arguments: '--soft-hearts-channel=stable --soft-hearts-build=' + staged.manifest.asarSha256 + ' --soft-hearts-desktop=' + staged.ownerMarker + ' "--user-data-dir=' + staged.stableProfile + '"' },
      { arguments: receipt.arguments + ' --soft-hearts-channel=development' },
    ]) {
      await assert.rejects(commitDeliveryPointer(f.root, staged, { shortcutReceipt: { ...receipt, ...mismatch } }), /exact stable shortcut/);
      assert.deepEqual(await readFile(f.manifest), before);
    }
    await writeFile(f.shortcut, 'later external change to synthetic shortcut');
    await assert.rejects(commitDeliveryPointer(f.root, staged, { shortcutReceipt: receipt }), /exact stable shortcut/);
    assert.deepEqual(await readFile(f.manifest), before);
  } finally { await f.close(); }
});

test('an exact synthetic stable receipt advances only its pointer and retains the archived original bytes', async () => {
  const f = await fixture();
  try {
    const oldManifest = await readFile(f.manifest), oldShortcut = await readFile(f.shortcut);
    const protectedBefore = await Promise.all([f.current, f.profile, f.privateFile, f.oldLauncher].map(file => readFile(file)));
    const staged = await pinDelivery(f.root, f.candidate, f.options);
    await writeFile(f.shortcut, 'synthetic selected stable shortcut bytes: no native Save');
    const receipt = await syntheticShortcutReceipt(f, staged);
    const result = await commitDeliveryPointer(f.root, staged, { shortcutReceipt: receipt });
    assert.equal(result.pointerUpdated, true);
    assert.equal(result.shortcutUpdated, true);
    assert.equal(result.runningVersionChanged, false);
    assert.deepEqual(JSON.parse(await readFile(f.manifest, 'utf8')), staged.manifest);
    assert.deepEqual(await Promise.all([f.current, f.profile, f.privateFile, f.oldLauncher].map(file => readFile(file))), protectedBefore);
    assert.ok(staged.history);
    assert.deepEqual(await readFile(path.join(f.root, staged.history.directory, 'desktop-delivered.json')), oldManifest);
    assert.deepEqual(await readFile(path.join(f.root, staged.history.directory, 'complete-delivery.lnk')), oldShortcut);
  } finally { await f.close(); }
});

test('stable staging requires an absolute existing normal profile directory without copying its private contents', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.manifest);
    for (const reference of [
      { version: 1, directory: 'relative-private-profile' },
      { version: 2, directory: path.dirname(f.privateFile) },
    ]) {
      await writeFile(f.profile, JSON.stringify(reference));
      await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /explicit normal profile reference/);
    }
    await writeFile(f.profile, JSON.stringify({ version: 1, directory: f.privateFile }));
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /Normal profile directory is unavailable/);
    await writeFile(f.profile, JSON.stringify({ version: 1, directory: path.join(f.root, 'does-not-exist') }));
    await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /ENOENT/);
    assert.deepEqual(await readFile(f.manifest), before);
    assert.equal(await readFile(f.privateFile, 'utf8'), 'private fixture outside the app');
  } finally { await f.close(); }
});

test('stable commit rejects even a same-directory normal profile reference whose bytes changed after staging', async () => {
  const f = await fixture();
  try {
    const staged = await pinDelivery(f.root, f.candidate, f.options);
    const before = await readFile(f.manifest);
    await writeFile(f.shortcut, 'synthetic next shortcut bytes: no shell operation');
    const receipt = await syntheticShortcutReceipt(f, staged);
    const reference = JSON.parse(await readFile(f.profile, 'utf8'));
    await writeFile(f.profile, JSON.stringify(reference, null, 2));
    await assert.rejects(commitDeliveryPointer(f.root, staged, { shortcutReceipt: receipt }), /normal profile reference changed/);
    assert.deepEqual(await readFile(f.manifest), before);
    assert.equal(await readFile(f.privateFile, 'utf8'), 'private fixture outside the app');
  } finally { await f.close(); }
});

test('native capability must also match the actual smoke receipt identity rather than only prepared metadata', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.manifest);
    for (const entryKind of [undefined, 'legacy-script-v1']) {
      await f.proof();
      const receiptFile = path.join(f.candidate, 'smoke-result.json');
      const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
      receipt.identity.entryKind = entryKind;
      const bytes = Buffer.from(JSON.stringify(receipt));
      await writeFile(receiptFile, bytes);
      await writeFile(f.proofFile, JSON.stringify({ ...f.initialProof, smokeReportSha256: digest(bytes) }));
      await assert.rejects(pinDelivery(f.root, f.candidate, f.options), /identity differs|native.product|native entry/i);
      assert.deepEqual(await readFile(f.manifest), before);
    }
  } finally { await f.close(); }
});
