// Stage one complete immutable channel version. Never start or stop an app.
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDeploymentProof, assertSmokeReceipt } from './lib/smoke-isolation.mjs';
import { EXECUTABLE_NAME, isOwnShortcut } from './lib/app-identity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const privateNames = new Set(['.local', 'settings.json', 'characters.json', 'memories.jsonl', 'mood-state.json', 'blush-calibrations.json', 'local state', 'desktop-profile.json', 'desktop-development-profile.json', 'desktop-asr.json']);
const neutralChanges = new Set(['scripts/update-desktop.mjs', 'scripts/pin-delivery.mjs', 'scripts/pin-delivery.d.mts', 'scripts/start-latest.ps1', 'scripts/refresh-desktop-shortcuts.ps1', 'scripts/smoke.mjs', 'scripts/lib/smoke-isolation.mjs', 'scripts/lib/fake-claude.mjs', 'scripts/lib/fake-claude.d.mts', 'scripts/lib/desktop-profiles.mjs']);
const inside =(parent, child) => { const rel = path.relative(parent, child); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
function relative(value) {
  if (typeof value !== 'string' || !value || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /[\0-\x1f]/.test(value)) throw Error('Invalid relative artifact path.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw Error('Artifact path escaped its boundary.');
  return parts.join('/');
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function noLinks(root, file) {
  if (!inside(root, file)) throw Error('Artifact path escaped its root.');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw Error('Artifact links are unsupported.'); }
}
async function directory(root, file) { if (!inside(root, file)) throw Error('Directory escaped its root.'); if (await exists(file)) { await noLinks(root, file); if (!(await lstat(file)).isDirectory()) throw Error('Expected a directory.'); } else await mkdir(file); }
async function records(root, source, inputs) {
  if (!Array.isArray(inputs) || !inputs.length || new Set(inputs).size !== inputs.length) throw Error('Invalid frozen input set.');
  const rows = [];
  for (const name of [...inputs].sort()) { const file = path.join(source, relative(name)); await noLinks(root, file); if (!(await lstat(file)).isFile()) throw Error('Frozen input is not a file.'); rows.push([name.replaceAll('\\', '/'), hash(await readFile(file))]); }
  return rows;
}
export async function bundleSnapshot(root, bundle) {
  const rows = [];
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, entry.name); await noLinks(root, file);
      if (privateNames.has(entry.name.toLowerCase())) throw Error('Private profile/configuration data cannot enter an app bundle.');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) rows.push([path.relative(bundle, file).replaceAll('\\', '/'), hash(await readFile(file))]);
      else throw Error('Unsupported bundle entry.');
    }
  }
  await visit(bundle); return rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
function positiveUnitSummary(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const get = name => Number([...clean.matchAll(new RegExp('(?:^|\\n)(?:ℹ|#) ' + name + ' (\\d+)\\s*(?=\\r?\\n|$)', 'g'))].at(-1)?.[1]);
  const summary = { tests: get('tests'), pass: get('pass'), fail: get('fail'), skipped: get('skipped') };
  if (!Number.isSafeInteger(summary.tests) || summary.tests <= 0 || summary.fail !== 0 || summary.pass + summary.skipped !== summary.tests) throw Error('A zero-test or unproved formal run cannot qualify a channel version.');
  return summary;
}
async function candidateProof(root, candidate) {
  const staging = path.join(root, '.local', 'desktop-updates');
  if (!inside(staging, candidate)) throw Error('Only a validated owned candidate may be selected.');
  await noLinks(root, candidate);
  const proofBytes = await readFile(path.join(candidate, 'validated.json')), proof = JSON.parse(proofBytes);
  assertSafeDeploymentProof(proof);
  if (proof.entryKind !== 'native-product-v1') throw Error('The candidate does not contain the native product desktop entry.');
  const preparedBytes = await readFile(path.join(candidate, 'prepared.json')), receiptBytes = await readFile(path.join(candidate, 'smoke-result.json'));
  if (JSON.parse(preparedBytes).entryKind !== 'native-product-v1') throw Error('The original prepared app lacks the native product entry.');
  if (hash(preparedBytes) !== proof.preparedSha256 || hash(receiptBytes) !== proof.smokeReportSha256) throw Error('Candidate receipt changed.');
  assertSmokeReceipt(JSON.parse(receiptBytes), proof, proof.preparedSha256);
  const frozen = path.join(candidate, 'source'), validation = proof.validationIdentity;
  const inputs = validation?.inputs ?? proof.inputs, sourceHash = validation?.sourceHash ?? proof.sourceHash;
  const fullRows = await records(root, frozen, inputs);
  if (!HEX.test(sourceHash) || hash(JSON.stringify(fullRows)) !== sourceHash || !inputs.some(file => file.startsWith('tests/'))) throw Error('Complete validation source identity differs.');
  const plan = validation?.unitPlan;
  const required = ['tests/desktop-channel.test.ts', 'tests/desktop-entry-chain.test.ts', 'tests/desktop-shortcut.test.ts', 'tests/pin-delivery.test.ts'];
  const expectedFiles = inputs.filter(file => /^tests\/[^/]+\.test\.(?:ts|mjs)$/.test(file) && file !== 'tests/start-latest.test.ts').sort();
  if (plan?.scope !== 'native-product-and-existing-nonlegacy-v1' || plan.originalLegacyScopePassed !== false
    || JSON.stringify(plan.testFiles) !== JSON.stringify(expectedFiles) || validation.executedTestFiles !== expectedFiles.length
    || JSON.stringify(plan.mandatoryProductTests) !== JSON.stringify(required) || required.some(file => !expectedFiles.includes(file))) throw Error('The explicit native product validation coverage is incomplete.');
  const legacy = inputs.includes('tests/start-latest.test.ts') ? [{ path: 'tests/start-latest.test.ts', reason: 'PS_SCRIPT_SCOPE_BLOCKED', sha256: new Map(fullRows).get('tests/start-latest.test.ts') }] : [];
  if (JSON.stringify(plan.legacyBlocked) !== JSON.stringify(legacy)) throw Error('The blocked legacy script scope must remain explicitly recorded, never passed or silently skipped.');
  const summary = validation?.unitSummary ?? positiveUnitSummary(await readFile(path.join(candidate, 'validation.log'), 'utf8'));
  if (!Number.isSafeInteger(summary.tests) || summary.tests <= 0 || summary.fail !== 0
    || !Number.isSafeInteger(summary.pass) || summary.pass < 0 || !Number.isSafeInteger(summary.skipped) || summary.skipped < 0
    || summary.pass + summary.skipped !== summary.tests) throw Error('Formal validation is incomplete.');
  if (proof.reusedFrom) {
    const oldFile = path.resolve(root, relative(proof.reusedFrom.prepared));
    if (path.basename(oldFile) !== 'prepared.json' || path.dirname(path.dirname(oldFile)) !== staging || oldFile === path.join(candidate, 'prepared.json')) throw Error('Invalid prepared-runtime reuse origin.');
    await noLinks(root, oldFile); const oldBytes = await readFile(oldFile), old = JSON.parse(oldBytes);
    if (hash(oldBytes) !== proof.reusedFrom.sha256 || old.reusedFrom || old.sourceHash !== proof.sourceHash || old.asarSha256 !== proof.asarSha256 || old.executableSha256 !== proof.executableSha256 || JSON.stringify(old.inputs) !== JSON.stringify(proof.inputs)) throw Error('Actual reused runtime identity changed.');
    const oldRows = await records(root, path.join(path.dirname(oldFile), 'source'), old.inputs);
    if (hash(JSON.stringify(oldRows)) !== old.sourceHash) throw Error('Original compiled-runtime source changed.');
    const oldMap = new Map(oldRows), nextMap = new Map(fullRows);
    for (const [file, sha] of fullRows) if (!file.startsWith('tests/') && !neutralChanges.has(file) && oldMap.get(file) !== sha) throw Error('Runtime reuse would hide a production or build-recipe change.');
    for (const [file, sha] of oldRows) if (!file.startsWith('tests/') && !neutralChanges.has(file) && nextMap.get(file) !== sha) throw Error('Runtime reuse removed a production input.');
    if (JSON.parse(receiptBytes).identity?.validationSourceHash !== sourceHash) throw Error('Reused runtime lacks its complete validation identity receipt.');
  } else if (sourceHash !== proof.sourceHash) throw Error('Fresh runtime and complete validation identities differ.');
  const bundle = path.resolve(root, relative(proof.unpacked));
  if (path.dirname(bundle) !== path.join(frozen, 'release') || !/^win-(?:arm64-|x64-)?unpacked$/.test(path.basename(bundle))) throw Error('Invalid complete bundle location.');
  await noLinks(root, bundle);
  const exe = await readFile(path.join(bundle, EXECUTABLE_NAME)), asar = await readFile(path.join(bundle, 'resources', 'app.asar'));
  if (hash(exe) !== proof.executableSha256 || hash(asar) !== proof.asarSha256) throw Error('The validated binary bytes changed.');
  const arch = path.basename(bundle).includes('arm64') ? 'arm64' : 'x64';
  return { proof, proofBytes, bundle, arch, validationHash: sourceHash, validationCount: inputs.length, summary, snapshot: await bundleSnapshot(root, bundle) };
}
async function freshFile(file, bytes) { if (await exists(file)) { if (!(await readFile(file)).equals(bytes)) throw Error('An immutable metadata file differs.'); } else await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
/** `shortcutBytes` is the previous link as reported by the product entry that replaced it; null when there was none. */
async function archivePrevious(root, shortcut, { shortcutBytes = null, allowMissingShortcut = false } = {}) {
  const manifestFile = path.join(root, 'release', 'desktop-delivered.json');
  if (!(await exists(manifestFile))) return null;
  await noLinks(root, manifestFile); const manifestBytes = await readFile(manifestFile), previous = JSON.parse(manifestBytes);
  const launcher = path.join(root, previous.launcher ? relative(previous.launcher) : 'release/start-delivered.ps1');
  if (!inside(path.join(root, 'release'), launcher)) throw Error('Previous stable launcher escaped release.');
  const entries = [['desktop-delivered.json', manifestBytes]];
  if (await exists(launcher)) { await noLinks(root, launcher); entries.push(['launcher.ps1', await readFile(launcher)]); }
  if (shortcut) {
    if (!path.isAbsolute(shortcut) || !isOwnShortcut(shortcut, 'stable') || (await lstat(shortcut)).isSymbolicLink()) throw Error('Only the specified complete-delivery shortcut may be archived.');
    entries.push(['complete-delivery.lnk', await readFile(shortcut)]);
  } else if (shortcutBytes) entries.push(['complete-delivery.lnk', shortcutBytes]);
  else if (!allowMissingShortcut) throw Error('Archive the specified existing stable shortcut before selecting its next target.');
  const history = path.join(root, 'release', 'stable-history'); await directory(root, history);
  const id = hash(JSON.stringify(entries.map(([name, bytes]) => [name, hash(bytes)]))), target = path.join(history, id); await directory(root, target);
  for (const [name, bytes] of entries) await freshFile(path.join(target, name), bytes);
  return { directory: path.relative(root, target).replaceAll('\\', '/'), members: entries.map(([name, bytes]) => ({ name, sha256: hash(bytes) })), previous };
}

/** Stages a full bundle and immutable manifest. No pointer, shortcut, profile or process is changed. */
export async function pinDelivery(workspaceRoot, candidatePath, options = {}) {
  const root = await realpath(path.resolve(workspaceRoot)), candidate = path.resolve(root, candidatePath), channel = options.channel ?? 'stable';
  if (!['stable', 'development'].includes(channel)) throw Error('Unknown desktop channel.');
  const selected = await candidateProof(root, candidate), { proof } = selected;
  const release = path.join(root, 'release'); await directory(root, release);
  const channelRoot = path.join(release, channel); await directory(root, channelRoot);
  let stableProfile = null, stableProfileReferenceSha256 = null, ownerMarker = null;
  if (channel === 'stable') {
    const referenceFile = path.join(release, 'desktop-profile.json'); await noLinks(root, referenceFile);
    const bytes = await readFile(referenceFile); if (bytes.length > 16384) throw Error('Stable profile reference is too large.');
    const reference = JSON.parse(bytes);
    if (reference.version !== 1 || typeof reference.directory !== 'string' || !path.isAbsolute(reference.directory) || /[\x00-\x1f"]/.test(reference.directory)) throw Error('An explicit normal profile reference is required.');
    stableProfile = await realpath(reference.directory); if (!(await lstat(stableProfile)).isDirectory()) throw Error('Normal profile directory is unavailable.');
    stableProfileReferenceSha256 = hash(bytes);
    ownerMarker = hash(root.toLowerCase() + '\n' + channel + '\n' + stableProfile.toLowerCase()).slice(0, 24);
  }
  const versionId = hash(JSON.stringify({ sourceHash: proof.sourceHash, asarSha256: proof.asarSha256, executableSha256: proof.executableSha256, channel, entryKind: 'native-product-v1' }));
  const version = path.join(channelRoot, versionId); await directory(root, version);
  const target = path.join(version, `win-${selected.arch}-unpacked`);
  const expectedRows = selected.snapshot;
  const bundleSha256 = hash(JSON.stringify(expectedRows));
  if (await exists(target)) {
    if (hash(JSON.stringify(await bundleSnapshot(root, target))) !== bundleSha256) throw Error('The existing immutable complete version differs; it was not overwritten.');
  } else {
    const temp = path.join(version, `.stage-${randomUUID()}`);
    try { await cp(selected.bundle, temp, { recursive: true, force: false, errorOnExist: true }); if (hash(JSON.stringify(await bundleSnapshot(root, temp))) !== bundleSha256) throw Error('Complete bundle copy differs.'); await rename(temp, target); }
    finally { if (!inside(version, temp) || !path.basename(temp).startsWith('.stage-')) throw Error('Refusing unexpected cleanup.'); await rm(temp, { recursive: true, force: true }); }
  }
  const manifestFile = path.join(version, `${channel}-manifest.json`);
  const manifest = { version: 1, entryKind: 'native-product-v1', channel, versionId, executable: path.relative(root, path.join(target, EXECUTABLE_NAME)).replaceAll('\\', '/'), asarSha256: proof.asarSha256, exeSha256: proof.executableSha256, buildId: proof.sourceHash, validationSourceHash: selected.validationHash, validationInputCount: selected.validationCount, bundleSha256, platform: 'win32', arch: selected.arch, installedAt: proof.validatedAt, validatedAt: proof.validatedAt };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); await freshFile(manifestFile, bytes);
  // deferHistory: the product entry reports the link it replaced; the updater archives it before committing.
  const history = channel === 'stable' && !options.deferHistory ? await archivePrevious(root, options.stableShortcutPath) : null;
  if (!(await readFile(path.join(candidate, 'validated.json'))).equals(selected.proofBytes)) throw Error('Candidate changed while staging.');
  return { channel, manifest, target, manifestFile, manifestSha256: hash(bytes), history, stableShortcutPath: options.stableShortcutPath ?? null,
    stableProfile, stableProfileReferenceSha256, ownerMarker, pointerUpdated: false, shortcutUpdated: false, runningVersionChanged: false };
}

/** Archives the previous stable pointer, launcher and the link the product entry just replaced (if there was one). */
export async function archiveStableHistory(workspaceRoot, { previousShortcut = null } = {}) {
  if (previousShortcut !== null && !Buffer.isBuffer(previousShortcut)) throw Error('Invalid previous stable shortcut bytes.');
  return archivePrevious(await realpath(path.resolve(workspaceRoot)), null, { shortcutBytes: previousShortcut, allowMissingShortcut: true });
}

/** Commit only the exact staged metadata, after the product entry has saved and read back this channel's own link. */
export async function commitDeliveryPointer(workspaceRoot, staged, { shortcutReceipt } = {}) {
  const root = await realpath(path.resolve(workspaceRoot));
  if (!['stable', 'development'].includes(staged.channel)) throw Error('Unknown desktop channel.');
  const base = path.join(root, 'release', staged.channel), manifestFile = path.resolve(staged.manifestFile);
  if (!inside(base, manifestFile)) throw Error('Staged manifest escaped its channel.');
  await noLinks(root, manifestFile); const bytes = await readFile(manifestFile);
  if (hash(bytes) !== staged.manifestSha256 || JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(staged.manifest)) throw Error('Staged channel metadata changed.');
  if (hash(JSON.stringify(await bundleSnapshot(root, staged.target))) !== staged.manifest.bundleSha256) throw Error('Staged complete bundle changed.');
  if (staged.channel === 'stable') {
    const profileBytes = await readFile(path.join(root, 'release', 'desktop-profile.json'));
    if (hash(profileBytes) !== staged.stableProfileReferenceSha256 || !staged.stableProfile || !staged.ownerMarker) throw Error('The normal profile reference changed while selecting the entry.');
  }
  const receipt = shortcutReceipt, executable = path.join(root, relative(staged.manifest.executable));
  const shortcutPath = receipt?.shortcutPath, expectedArguments = '--soft-hearts-channel=' + staged.channel;
  if (!receipt || receipt.kind !== `native-${staged.channel}-shortcut-v1` || receipt.channel !== staged.channel || receipt.manifestSha256 !== staged.manifestSha256
    || receipt.executable !== executable || receipt.targetPath !== executable
    || typeof shortcutPath !== 'string' || !path.isAbsolute(shortcutPath) || !isOwnShortcut(shortcutPath, staged.channel)
    || (staged.channel === 'stable' && staged.stableShortcutPath && shortcutPath !== staged.stableShortcutPath) || receipt.arguments !== expectedArguments
    || !HEX.test(receipt.shortcutSha256 ?? '') || hash(await readFile(shortcutPath)) !== receipt.shortcutSha256)
    throw Error(`The exact ${staged.channel} shortcut save and readback receipt is required before committing its pointer.`);
  const file = path.join(root, 'release', staged.channel === 'stable' ? 'desktop-delivered.json' : 'desktop-current.json'), temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { ...staged, pointerUpdated: true, shortcutUpdated: true, runningVersionChanged: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) throw Error('Use the existing update-desktop --deploy channel workflow; this module only stages verified complete versions.');
