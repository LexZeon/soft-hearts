import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInstalledDesktopChannel } from '../electron/desktop-channel';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-native-channel-'));
  const root = path.join(temporary, 'project space 中文'), normal = path.join(temporary, 'normal'), development = path.join(temporary, 'development');
  for (const directory of [path.join(root, 'release'), normal, development]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(normal, 'settings.json'), 'private synthetic settings unchanged');
  for (const [channel, directory] of [['stable', normal], ['development', development]]) await writeFile(path.join(root, 'release', channel === 'stable' ? 'desktop-profile.json' : 'desktop-development-profile.json'), JSON.stringify({ version: 1, directory }));
  const install = async (channel: 'stable' | 'development', versionId: string) => {
    const versionRoot = path.join(root, 'release', channel, versionId), bundle = path.join(versionRoot, 'win-arm64-unpacked');
    await mkdir(path.join(bundle, 'resources'), { recursive: true });
    const executable = path.join(bundle, 'soft hearts next.exe'), asar = path.join(bundle, 'resources', 'app.asar');
    await writeFile(executable, 'synthetic executable bytes, never run'); await writeFile(asar, 'synthetic raw archive bytes');
    const manifest = { version: 1, entryKind: 'native-product-v1', channel, versionId, platform: 'win32', arch: 'arm64',
      executable: path.relative(root, executable).replaceAll('\\', '/'), exeSha256: hash(await readFile(executable)), asarSha256: hash(await readFile(asar)) };
    const manifestFile = path.join(versionRoot, channel + '-manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest));
    const input = { executable, packaged: true, platform: 'win32', defaultProfile: path.join(temporary, 'unused-default') };
    return { executable, asar, manifest, manifestFile, input };
  };
  return { root, normal, development, install, async close() {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('soft-native-channel-'));
    await rm(temporary, { recursive: true, force: true });
  } };
}

test('installed channels select their own immutable version and distinct physical profiles before any app lock', async () => {
  const f = await fixture();
  try {
    const stable = await f.install('stable', 'a'.repeat(64)), dev = await f.install('development', 'b'.repeat(64));
    await writeFile(path.join(f.root, 'release', 'desktop-delivered.json'), 'deliberately invalid mutable global pointer');
    const a = resolveInstalledDesktopChannel({ ...stable.input, requestedChannel: 'stable' })!, b = resolveInstalledDesktopChannel(dev.input)!;
    assert.equal(a.profile, f.normal); assert.equal(b.profile, f.development);
    assert.equal(a.executable, stable.executable); assert.equal(b.executable, dev.executable);
    assert.equal(a.asarSha256, stable.manifest.asarSha256);
    assert.equal(a.exeSha256, stable.manifest.exeSha256);
    assert.equal(a.ownerMarker, hash(f.root.toLowerCase() + '\n' + 'stable' + '\n' + f.normal.toLowerCase()).slice(0, 24));
    assert.notEqual(a.ownerMarker, b.ownerMarker); assert.notEqual(a.maintenanceProfile, a.profile);
    assert.match(a.maintenanceProfile, /desktop-entry-maintenance/);
    assert.equal(await readFile(path.join(f.normal, 'settings.json'), 'utf8'), 'private synthetic settings unchanged');
  } finally { await f.close(); }
});

test('missing or overlapping channel profiles and foreign explicit profiles fail closed', async () => {
  const f = await fixture();
  try {
    const dev = await f.install('development', 'b'.repeat(64));
    await writeFile(path.join(f.root, 'release', 'desktop-development-profile.json'), JSON.stringify({ version: 1, directory: f.normal }));
    assert.throws(() => resolveInstalledDesktopChannel(dev.input), /overlap/);
    await writeFile(path.join(f.root, 'release', 'desktop-development-profile.json'), JSON.stringify({ version: 1, directory: f.development }));
    assert.throws(() => resolveInstalledDesktopChannel({ ...dev.input, explicitProfile: f.normal }), /conflicts/);
    await rm(path.join(f.root, 'release', 'desktop-profile.json'));
    assert.throws(() => resolveInstalledDesktopChannel(dev.input));
  } finally { await f.close(); }
});

test('the channel is bound to its exact executable, raw archive and matching supplied markers', async () => {
  const f = await fixture();
  try {
    const stable = await f.install('stable', 'a'.repeat(64)); let rawReads = 0;
    const verified = resolveInstalledDesktopChannel({ ...stable.input, readRawArchive(file) { assert.equal(file, stable.asar); rawReads++; return Buffer.from('synthetic raw archive bytes'); } })!;
    assert.equal(rawReads, 1);
    assert.throws(() => resolveInstalledDesktopChannel({ ...stable.input, buildMarker: '0'.repeat(64) }), /marker mismatch/);
    assert.throws(() => resolveInstalledDesktopChannel({ ...stable.input, ownerMarker: '0'.repeat(24) }), /marker mismatch/);
    assert.equal(resolveInstalledDesktopChannel({ ...stable.input, buildMarker: verified.asarSha256, ownerMarker: verified.ownerMarker })!.versionId, 'a'.repeat(64));
    await writeFile(stable.asar, 'changed archive'); assert.throws(() => resolveInstalledDesktopChannel(stable.input), /bytes changed/);
    await writeFile(stable.asar, 'synthetic raw archive bytes'); await writeFile(stable.executable, 'changed executable');
    assert.throws(() => resolveInstalledDesktopChannel(stable.input), /bytes changed/);
  } finally { await f.close(); }
});

test('a foreign manifest target and an explicit wrong channel cannot redirect product startup', async () => {
  const f = await fixture();
  try {
    const stable = await f.install('stable', 'a'.repeat(64));
    assert.throws(() => resolveInstalledDesktopChannel({ ...stable.input, requestedChannel: 'development' }), /mismatch/);
    await writeFile(stable.manifestFile, JSON.stringify({ ...stable.manifest, executable: '../foreign.exe' }));
    assert.throws(() => resolveInstalledDesktopChannel(stable.input), /this product executable/);
  } finally { await f.close(); }
});

test('a managed install of the Codex executable name or a profile reference to the Codex profile is refused', async () => {
  const f = await fixture();
  try {
    const stable = await f.install('stable', 'a'.repeat(64));
    const codexExe = path.join(path.dirname(stable.executable), 'soft hearts.exe');
    await writeFile(codexExe, await readFile(stable.executable));
    await writeFile(stable.manifestFile, JSON.stringify({ ...stable.manifest, executable: path.relative(f.root, codexExe).replaceAll('\\', '/') }));
    assert.throws(() => resolveInstalledDesktopChannel({ ...stable.input, executable: codexExe }), /executable mismatch/);
    await writeFile(stable.manifestFile, JSON.stringify(stable.manifest));
    const codexProfile = path.join(path.dirname(f.normal), 'appdata', 'soft-hearts');
    await mkdir(codexProfile, { recursive: true });
    await writeFile(path.join(f.root, 'release', 'desktop-profile.json'), JSON.stringify({ version: 1, directory: codexProfile }));
    assert.throws(() => resolveInstalledDesktopChannel(stable.input), /Codex edition profile/);
  } finally { await f.close(); }
});

test('unmanaged portable launches preserve the original path; requested managed channels require a managed product', () => {
  const input = { executable: path.resolve('portable/soft hearts next.exe'), packaged: true, platform: 'win32', defaultProfile: path.resolve('default') };
  assert.equal(resolveInstalledDesktopChannel(input), null);
  assert.throws(() => resolveInstalledDesktopChannel({ ...input, requestedChannel: 'stable' }), /outside an immutable/);
  assert.equal(resolveInstalledDesktopChannel({ ...input, platform: 'darwin' }), null);
  assert.throws(() => resolveInstalledDesktopChannel({ ...input, packaged: false, requestedChannel: 'development' }), /installed Windows/);
});
