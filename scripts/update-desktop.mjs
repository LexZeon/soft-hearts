// Validate a frozen runtime before replacing a desktop channel build. No Git or cloud access.
// Channels: development ("soft hearts next - 最新开发版") and stable ("soft hearts next - 稳定版"); names in lib/app-identity.mjs.
import { spawn } from 'node:child_process';
import { gateHeavy } from './dev/presence.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDeploymentProof, assertSmokeHarnessIdentity, assertSmokeReceipt, operatingSystemEnvironment, rejectExternalSmokeFlags } from './lib/smoke-isolation.mjs';
import { assertPreparedSourceIdentity, assertRuntimeSourceEquivalence } from './lib/smoke-isolation.mjs';
import { archiveStableHistory, bundleSnapshot, commitDeliveryPointer, pinDelivery } from './pin-delivery.mjs';
import { CHANNELS, EXECUTABLE_NAME, isOwnExecutable, isOwnShortcut, shortcutName } from './lib/app-identity.mjs';
import { ensureDevelopmentProfile, ensureStableProfileReference } from './lib/desktop-profiles.mjs';
export { ensureDevelopmentProfile, ensureStableProfileReference };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceArgument = process.argv.indexOf('--source');
const inputRoot = sourceArgument < 0 ? root : path.resolve(process.argv[sourceArgument + 1] ?? '');
const release = path.join(root, 'release');
const staging = path.join(root, '.local', 'desktop-updates');
// handbook and tools/bridge: unit tests read them (the companion rules stay tied to handbook/README.md and ideas.md;
// the scorer page tests load tools/bridge/scorer.html). Without them every unit run in the frozen copy failed, so no
// development version and no desktop shortcut was ever installed (R26, 2026-11-03). tests/frozen-inputs.test.mjs
// finds any other repository file a test reads that is missing here.
const folders = ['electron', 'shared', 'src', 'scripts', 'tests', 'assets/bundled', 'handbook', 'tools/bridge'];
// The public source snapshot has no handbook/ and no tools/bridge/ (maintainer-only): a missing one of these is an empty
// input there, not an error. Where they exist they count as before. Any other missing folder still fails.
const optionalFolders = new Set(['handbook', 'tools/bridge']);
// The double-click launchers are inputs too: their tests run inside the frozen copy.
const fixed = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts', 'index.html', 'LICENSE', 'ACKNOWLEDGEMENTS.md', 'THIRD_PARTY_NOTICES.md',
  'start-soft-hearts.cmd', 'promote-to-stable.cmd'];
/** What prepare() freezes and fingerprints: these files plus everything under these folders. */
export const runtimeInputs = Object.freeze({ fixed: Object.freeze([...fixed]), folders: Object.freeze([...folders]) });
const scopeArgument = process.argv.includes('--validation-files') ? process.argv.indexOf('--validation-files') : process.argv.indexOf('--files');
const scopedFiles = scopeArgument < 0 ? null : JSON.parse(await readFile(process.argv[scopeArgument + 1], 'utf8'));
const argumentValue = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
export function assertValidationIdentity({ sourceHash, inputs, expectedHash, expectedCount, expectedTestInputs, coordinated = true }) {
  const testInputs = inputs.filter(file => file.startsWith('tests/')).length;
  if (coordinated && (!/^[a-f0-9]{64}$/.test(expectedHash ?? '') || !Number.isSafeInteger(expectedCount) || !Number.isSafeInteger(expectedTestInputs)))
    throw new Error('A coordinated validation requires its frozen expected hash, input count and test-input count.');
  if (expectedHash !== undefined && sourceHash !== expectedHash || expectedCount !== undefined && inputs.length !== expectedCount
    || expectedTestInputs !== undefined && testInputs !== expectedTestInputs)
    throw new Error('Selected validation files differ from the frozen expected source; no candidate was created.');
  if (!testInputs) throw new Error('The complete validation input has no test files; a production-only list cannot qualify a complete source.');
  return { sourceHash, inputCount: inputs.length, testInputCount: testInputs };
}
export function requireUnitSummary(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const value = name => [...text.matchAll(new RegExp('(?:^|\\n)(?:ℹ|#) ' + name + ' (\\d+)\\s*(?=\\r?\\n|$)', 'g'))].at(-1)?.[1];
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(name => [name, value(name) === undefined ? null : Number(value(name))]));
  if (!Number.isSafeInteger(summary.tests) || summary.tests <= 0 || summary.fail !== 0
    || !Number.isSafeInteger(summary.pass) || !Number.isSafeInteger(summary.skipped)
    || summary.pass + summary.skipped !== summary.tests)
    throw new Error('Unit execution did not prove a nonempty passing test set; exit zero alone is insufficient.');
  return summary;
}
export function selectUnitTestFiles(inputs) {
  const selected = inputs.filter(file => /^tests\/[^/]+\.test\.(?:ts|mjs)$/.test(file)).sort();
  if (!selected.length) throw new Error('No executable test inputs were selected.');
  if (selected.includes('tests/start-latest.test.ts')) throw Error('The legacy PowerShell test purpose remains blocked; it is not part of the native product validation scope.');
  return selected;
}
export function nativeProductUnitPlan(inputs) {
  const mandatoryProductTests = ['tests/desktop-channel.test.ts', 'tests/desktop-entry-chain.test.ts', 'tests/desktop-shortcut.test.ts', 'tests/pin-delivery.test.ts'];
  for (const file of mandatoryProductTests) if (!inputs.includes(file)) throw Error('The native product validation is missing necessary coverage: ' + file);
  const legacyBlocked = inputs.includes('tests/start-latest.test.ts') ? [{ path: 'tests/start-latest.test.ts', reason: 'PS_SCRIPT_SCOPE_BLOCKED' }] : [];
  return { scope: 'native-product-and-existing-nonlegacy-v1', testFiles: selectUnitTestFiles(inputs.filter(file => !legacyBlocked.some(row => row.path === file))),
    mandatoryProductTests, legacyBlocked, originalLegacyScopePassed: false };
}
function runtimePath(relative, base = root) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '.') || (!fixed.includes(relative) && !folders.some(folder => relative.startsWith(`${folder}/`)))) throw new Error('Invalid runtime file in validation scope.');
  return path.join(base, relative);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => { const relative = path.relative(parent, path.resolve(child)); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime source links are unsupported: ${entry.name}`);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
async function runtimeFilesAt(base) {
  const inFolder = async folder => {
    try { return await files(path.join(base, folder)); }
    catch (error) { if (error.code === 'ENOENT' && optionalFolders.has(folder)) return []; throw error; }
  };
  return [...fixed.map(file => path.join(base, file)), ...(await Promise.all(folders.map(inFolder))).flat()].sort();
}
async function runtimeFiles() {
  if (scopedFiles) { if (!Array.isArray(scopedFiles) || !scopedFiles.length || new Set(scopedFiles).size !== scopedFiles.length) throw new Error('Runtime scope must be a nonempty unique file list.'); return scopedFiles.map(file => runtimePath(file, inputRoot)).sort(); }
  return runtimeFilesAt(inputRoot);
}
async function fingerprint(paths, base) {
  const hashes = [];
  for (const file of paths) hashes.push([path.relative(base, file).replaceAll('\\', '/'), digest(await readFile(file))]);
  return digest(JSON.stringify(hashes));
}
/** The identity prepare() records as sourceHash (pinDelivery's buildId) for the complete workspace. */
export async function workspaceSourceHash(base = root) { return fingerprint(await runtimeFilesAt(base), base); }
async function run(command, args, cwd, log, env = {}, isolated = false) {
  const childEnv = { ...(isolated ? operatingSystemEnvironment(process.env) : process.env), ...env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'MMD_TEST_CODEX', 'MMD_TEST_LOCAL_URL', 'MMD_TEST_LOCAL_MODEL']) delete childEnv[key];
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psexecutionpolicypreference') delete childEnv[key];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log?.write(chunk); tail = (tail + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(tail) : reject(new Error(`Step failed (${code}): ${args[0]}\n${tail}`)));
  });
}
async function prepare({ unitPlan: unitPlanName = argumentValue('--unit-plan') } = {}) {
  rejectExternalSmokeFlags(process.env);
  if (inputRoot !== root && !within(path.join(root, '.local'), inputRoot)) throw new Error('A coordinated source snapshot must be inside this workspace .local directory.');
  const inputs = await runtimeFiles(), sourceHash = await fingerprint(inputs, inputRoot);
  const validationIdentity = assertValidationIdentity({ sourceHash,
    inputs: inputs.map(file => path.relative(inputRoot, file).replaceAll('\\', '/')),
    expectedHash: argumentValue('--expected-source-hash'),
    expectedCount: argumentValue('--expected-input-count') === undefined ? undefined : Number(argumentValue('--expected-input-count')),
    expectedTestInputs: argumentValue('--expected-test-input-count') === undefined ? undefined : Number(argumentValue('--expected-test-input-count')),
    coordinated: sourceArgument >= 0 || scopeArgument >= 0 });
  for (const file of ['electron/desktop-entry.ts', 'electron/desktop-channel.ts', 'electron/desktop-shortcut.ts'])
    if (!inputs.some(input => path.relative(inputRoot, input).replaceAll('\\', '/') === file)) throw Error('The complete native product entry sources are required.');
  if (!(await readFile(path.join(inputRoot, 'scripts', 'build-electron.mjs'), 'utf8')).includes('electron/desktop-entry.ts')) throw Error('The native product entry must be the actual build entry.');
  if (unitPlanName !== 'native-product-v1') throw Error('An explicit adopted native-product unit scope is required; legacy PowerShell checks remain blocked.');
  const unitPlan = nativeProductUnitPlan(inputs.map(file => path.relative(inputRoot, file).replaceAll('\\', '/')));
  // Fail in seconds with the file names, not minutes later inside the frozen unit run (R26).
  const unfrozen = await (await import('./lib/frozen-inputs.mjs')).unfrozenTestReads(inputRoot, runtimeInputs);
  if (unfrozen.length) throw Error('Unit tests read repository files that the frozen candidate would not contain; add them to runtimeInputs in scripts/update-desktop.mjs: '
    + unfrozen.slice(0, 8).map(row => `${row.file}:${row.line} reads ${row.path}`).join('; ') + '. Daily app was not changed.');
  const trustedHarness = await assertSmokeHarnessIdentity(inputRoot, root);
  const reuseArgument = argumentValue('--reuse-prepared');
  let reuse;
  if (reuseArgument) {
    const file = path.resolve(root, reuseArgument);
    if (path.basename(file) !== 'prepared.json' || path.dirname(path.dirname(file)) !== staging) throw Error('Reuse only an owned original prepared artifact.');
    const bytes = await readFile(file), old = JSON.parse(bytes), oldSource = path.join(path.dirname(file), 'source');
    if (old.reusedFrom || !Array.isArray(old.inputs) || old.sourceHash !== await fingerprint(old.inputs.map(name => runtimePath(name, oldSource)), oldSource)) throw Error('Original compiled source identity changed.');
    const rows = async (base, paths) => Promise.all(paths.map(async name => [name, digest(await readFile(runtimePath(name, base)))]));
    assertRuntimeSourceEquivalence(await rows(oldSource, old.inputs), await rows(inputRoot, inputs.map(file => path.relative(inputRoot, file).replaceAll('\\', '/'))));
    const bundle = path.resolve(root, old.unpacked);
    if (path.dirname(bundle) !== path.join(oldSource, 'release') || digest(await readFile(path.join(bundle, 'resources/app.asar'))) !== old.asarSha256
      || digest(await readFile(path.join(bundle, EXECUTABLE_NAME))) !== old.executableSha256) throw Error('Original compiled package changed.');
    reuse = { file, bytes, old, bundle, snapshot: await bundleSnapshot(root, bundle) };
  }
  const directory = path.join(staging, new Date().toISOString().replace(/[:.]/g, '-'));
  const source = path.join(directory, 'source');
  await mkdir(source, { recursive: true });
  for (const file of inputs) { const destination = path.join(source, path.relative(inputRoot, file)); await mkdir(path.dirname(destination), { recursive: true }); await cp(file, destination); }
  if (sourceHash !== await fingerprint(inputs.map(file => path.join(source, path.relative(inputRoot, file))), source)) throw new Error('Runtime source changed while freezing the candidate. Daily app was not changed.');
  await assertSmokeHarnessIdentity(source, root, trustedHarness);
  await symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'junction');
  const log = createWriteStream(path.join(directory, 'validation.log'));
  try {
    const testFiles = unitPlan.testFiles;
    let unitSummary;
    const steps = [
      ['assets', 'scripts/verify-bundled-assets.mjs', []],
      ['types', 'node_modules/typescript/bin/tsc', ['--noEmit']],
      ['unit tests', 'node_modules/tsx/dist/cli.mjs', ['--test', ...testFiles]],
    ];
    if (!reuse) steps.push(
      ['renderer', 'node_modules/vite/bin/vite.js', ['build']],
      ['host', 'scripts/build-electron.mjs', []],
      ['package', 'node_modules/electron-builder/out/cli/cli.js', ['--dir', '--win', `--${process.arch}`]],
    );
    for (const [label, script, args] of steps) { console.log(`Checking ${label}...`); const output = await run(process.execPath, [script, ...args], source, log);
      if (label === 'unit tests') unitSummary = requireUnitSummary(output); }
    const name = reuse ? path.basename(reuse.bundle) : process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`;
    const unpacked = path.join(source, 'release', name);
    if (reuse) {
      await mkdir(path.dirname(unpacked), { recursive: true });
      await cp(reuse.bundle, unpacked, { recursive: true, force: false, errorOnExist: true });
      if (!Buffer.from(reuse.bytes).equals(await readFile(reuse.file)) || digest(JSON.stringify(await bundleSnapshot(root, unpacked))) !== digest(JSON.stringify(reuse.snapshot))) throw Error('Complete reused artifact changed while copying.');
    }
    const executable = path.join(unpacked, EXECUTABLE_NAME);
    const asarSha256 = digest(await readFile(path.join(unpacked, 'resources', 'app.asar')));
    const executableSha256 = digest(await readFile(executable));
    const fullInputs = inputs.map(file => path.relative(inputRoot, file).replaceAll('\\', '/'));
    const snapshot = await bundleSnapshot(root, unpacked);
    const prepared = { version: 1, entryKind: 'native-product-v1', sourceHash: reuse?.old.sourceHash ?? sourceHash, asarSha256, executableSha256,
      inputs: reuse?.old.inputs ?? fullInputs, unpacked: path.relative(root, unpacked), preparedAt: new Date().toISOString(), smokePending: true,
      bundleInputs: snapshot.map(([file]) => file), bundleSha256: digest(JSON.stringify(snapshot)),
      ...(reuse ? { reusedFrom: { prepared: path.relative(root, reuse.file).replaceAll('\\', '/'), sha256: digest(reuse.bytes) } } : {}),
      validationIdentity: { ...validationIdentity, inputs: fullInputs, executedTestFiles: testFiles.length, unitSummary,
        unitPlan: { ...unitPlan, legacyBlocked: await Promise.all(unitPlan.legacyBlocked.map(async row => ({ ...row, sha256: digest(await readFile(path.join(source, row.path))) }))) } } };
    const preparedFile = path.join(directory, 'prepared.json'), preparedBytes = JSON.stringify(prepared, null, 2) + '\n';
    await writeFile(preparedFile, preparedBytes, { flag: 'wx' });
    await assertPreparedSourceIdentity(source, preparedFile, prepared);
    await assertSmokeHarnessIdentity(source, root, trustedHarness);
    console.log('Checking the packaged app with an isolated profile...');
    await run(process.execPath, ['scripts/smoke.mjs'], source, log, { MMD_TEST_EXE: executable, MMD_TEST_PREPARED: preparedFile, MMD_TEST_PREPARED_SHA256: digest(preparedBytes), ...(process.env.MMD_TEST_MODEL ? { MMD_TEST_MODEL: process.env.MMD_TEST_MODEL } : {}) }, true);
    const smokeBytes = await readFile(path.join(directory, 'smoke-result.json'));
    assertSmokeReceipt(JSON.parse(smokeBytes), prepared, digest(preparedBytes));
    if (sourceHash !== await fingerprint(inputs.map(file => path.join(source, path.relative(inputRoot, file))), source)) throw new Error('Frozen runtime source changed during validation. Daily app was not replaced.');
    if (sourceHash !== await fingerprint(inputs, inputRoot).catch(() => null)) console.log('New workspace edits are kept separate; this candidate contains only the frozen source set.');
    if (digest(await readFile(preparedFile)) !== digest(preparedBytes) || digest(await readFile(path.join(unpacked, 'resources', 'app.asar'))) !== asarSha256 || digest(await readFile(executable)) !== executableSha256) throw new Error('Prepared package changed during smoke. Daily app was not replaced.');
    const { smokePending, ...identity } = prepared;
    const proof = { ...identity, preparedSha256: digest(preparedBytes), smokeReportSha256: digest(smokeBytes), safeSmoke: 1, validatedAt: new Date().toISOString() };
    await writeFile(path.join(directory, 'validated.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
    console.log(`Validated candidate: ${path.relative(root, directory)}`);
    return directory;
  } finally { await new Promise(resolve => log.end(resolve)); }
}
const POINTERS = { development: 'desktop-current.json', stable: 'desktop-delivered.json' };
const MAX_ENTRY_RECEIPT_BYTES = 64 * 1024;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Nothing was changed; the user only has to do something first. */
export class DesktopRefusal extends Error {
  constructor(code, message) { super(message); this.name = 'DesktopRefusal'; this.code = code; }
}

/** Runs the installed product's one fixed desktop-entry action. It verifies itself and writes only its own channel's link. */
export async function runProductEntry(executable, args, cwd) {
  if (!isOwnExecutable(executable)) throw Error('Only the soft hearts next product entry may be run.');
  await run(executable, args, cwd, null, {}, true);
}
async function entryReceipt(workspace, { channel, executable, manifest, runEntry }) {
  if (!isOwnExecutable(executable) || !within(path.join(workspace, 'release', channel), executable)) throw Error('The channel executable is outside its own release folder.');
  const ticket = randomUUID().replaceAll('-', '');
  const maintenanceProfile = path.join(workspace, '.local', 'desktop-entry-maintenance', manifest.versionId);
  const receiptFile = path.join(maintenanceProfile, 'receipt-' + ticket + '.json');
  await runEntry(executable, ['--soft-hearts-install-desktop-entry', '--soft-hearts-entry-ticket=' + ticket], workspace);
  if ((await lstat(receiptFile)).isSymbolicLink()) throw Error('The product desktop entry receipt may not be a link.');
  const bytes = await readFile(receiptFile);
  if (bytes.length > MAX_ENTRY_RECEIPT_BYTES) throw Error('Invalid product desktop entry receipt size.');
  const result = JSON.parse(bytes);
  if (result.version !== 1 || result.ticket !== ticket || result.channel !== channel || result.executable !== executable
    || result.asarSha256 !== manifest.asarSha256 || result.maintenanceProfile !== maintenanceProfile
    || !Number.isSafeInteger(result.processId) || result.processId <= 0 || result.receipt?.channel !== channel) throw Error('Product desktop entry receipt identity changed.');
  return result;
}
function previousShortcutBytes(receipt) {
  if (!receipt?.previous) return null;
  const bytes = Buffer.from(String(receipt.previous.bytesBase64), 'base64');
  if (!/^[a-f0-9]{64}$/.test(receipt.previous.sha256 ?? '') || digest(bytes) !== receipt.previous.sha256) throw Error('The replaced shortcut bytes changed.');
  return bytes;
}
/** Puts back exactly what the product entry replaced, and only while the link still holds the bytes it wrote. */
async function restoreShortcut(receipt, channel) {
  try {
    const link = receipt?.shortcutPath;
    if (typeof link !== 'string' || !path.isAbsolute(link) || !isOwnShortcut(link, channel)) return 'NOT_OWNED_LEFT_ALONE';
    const current = await readFile(link).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!current) return 'MISSING';
    if (digest(current) !== receipt.shortcutSha256) return 'CHANGED_AFTER_SAVE_LEFT_ALONE';
    const previous = previousShortcutBytes(receipt);
    if (previous) await writeFile(link, previous); else await unlink(link);
    return previous ? 'PREVIOUS_BYTES_RESTORED' : 'NEW_LINK_REMOVED';
  } catch { return 'RESTORATION_UNCONFIRMED'; }
}

/**
 * Selects one validated candidate for a channel: stage an immutable copy, let that copy's product entry write its own
 * shortcut, then commit the channel pointer. If the commit fails the shortcut is put back. No app is started or stopped.
 */
export async function deployCandidate(workspaceRoot, candidate, { channel = 'development', environment = process.env, runEntry = runProductEntry, log = () => {} } = {}) {
  if (!CHANNELS.includes(channel)) throw Error('Unknown desktop channel.');
  const workspace = await realpath(path.resolve(workspaceRoot));
  const directory = await realpath(path.resolve(workspace, candidate));
  if (!within(path.join(workspace, '.local', 'desktop-updates'), directory)) throw Error('Only validated owned candidates may be selected.');
  await ensureStableProfileReference(workspace, environment);
  if (channel === 'development') {
    const profile = await ensureDevelopmentProfile(workspace, environment);
    if (profile.seeded) log({ event: 'seeded', profile: profile.directory, ...profile.seeded });
  }
  const staged = await pinDelivery(workspace, directory, { channel, deferHistory: true });
  const attempt = path.join(directory, `channel-${channel}-${stamp()}`);
  await writeFile(attempt + '-staged.json', JSON.stringify(staged, null, 2) + '\n', { flag: 'wx' });
  let entry = null, pointerCommitted = false;
  try {
    entry = await entryReceipt(workspace, { channel, executable: path.join(staged.target, EXECUTABLE_NAME), manifest: staged.manifest, runEntry });
    const history = channel === 'stable' ? await archiveStableHistory(workspace, { previousShortcut: previousShortcutBytes(entry.receipt) }) : null;
    const selected = { ...(await commitDeliveryPointer(workspace, staged, { shortcutReceipt: entry.receipt })), history };
    pointerCommitted = true;
    await writeFile(attempt + '-selected.json', JSON.stringify({ ...selected, productReceipt: entry }, null, 2) + '\n', { flag: 'wx' });
    log({ event: 'selected', channel, shortcutPath: entry.receipt.shortcutPath });
    return selected;
  } catch (error) {
    const shortcutState = !entry ? 'PRODUCT_ENTRY_DID_NOT_REPORT' : pointerCommitted ? 'SELECTED' : await restoreShortcut(entry.receipt, channel);
    await writeFile(attempt + '-failure.json', JSON.stringify({ channel, manifestSha256: staged.manifestSha256, shortcutState,
      pointerCommitConfirmed: pointerCommitted, companionProcessAction: 'NONE', error: String(error) }, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
    throw error;
  }
}

/** A channel pointer's bytes (committed, or archived in release/stable-history) as a soft hearts next channel version. */
function parseChannelPointer(bytes, channel) {
  if (bytes.length > 16384) throw Error('The channel pointer is too large.');
  const manifest = JSON.parse(bytes);
  if (manifest?.version !== 1 || manifest.entryKind !== 'native-product-v1' || manifest.channel !== channel || typeof manifest.executable !== 'string'
    || !new RegExp(`^release/${channel}/[a-f0-9]{64}/win-(?:x64|arm64)-unpacked/[^/]+$`).test(manifest.executable) || !isOwnExecutable(manifest.executable)
    || manifest.executable.split('/')[2] !== manifest.versionId || !/^[a-f0-9]{64}$/.test(manifest.buildId ?? '')) throw Error(`The ${channel} pointer is not a soft hearts next channel version.`);
  return manifest;
}
/** The committed version of a channel (release/desktop-current.json or desktop-delivered.json), or null when there is none. */
export async function readChannelPointer(workspaceRoot, channel) {
  if (!CHANNELS.includes(channel)) throw Error('Unknown desktop channel.');
  const workspace = await realpath(path.resolve(workspaceRoot));
  const file = path.join(workspace, 'release', POINTERS[channel]);
  let bytes;
  try { if ((await lstat(file)).isSymbolicLink()) throw Error('A channel pointer may not be a link.'); bytes = await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = parseChannelPointer(bytes, channel);
  return { manifest, bytes, sha256: digest(bytes), executable: path.join(workspace, ...manifest.executable.split('/')) };
}
/**
 * Re-runs each selected version's own entry so its shortcut exists and points at it. A channel without a version gets
 * no shortcut. With continueOnError one channel's failure is reported as `failed` and the other channel still runs.
 */
export async function refreshShortcuts(workspaceRoot, { channels = CHANNELS, runEntry = runProductEntry, continueOnError = false } = {}) {
  const workspace = await realpath(path.resolve(workspaceRoot)), results = [];
  for (const channel of channels) {
    try {
      const pointer = await readChannelPointer(workspace, channel);
      if (!pointer) { results.push({ channel, status: 'absent' }); continue; }
      const entry = await entryReceipt(workspace, { channel, executable: pointer.executable, manifest: pointer.manifest, runEntry });
      if (entry.receipt.manifestSha256 !== pointer.sha256) throw Error(`The refreshed ${channel} shortcut does not belong to the selected version (${await restoreShortcut(entry.receipt, channel)}).`);
      results.push({ channel, status: 'refreshed', shortcutPath: entry.receipt.shortcutPath });
    } catch (error) {
      if (!continueOnError) throw error;
      results.push({ channel, status: 'failed', error: String(error?.message ?? error) });
    }
  }
  return results;
}
/** The validated candidate whose deployment produced this exact channel pointer, or null. */
export async function findDeployedCandidate(workspaceRoot, channel, manifestSha256) {
  const workspace = await realpath(path.resolve(workspaceRoot)), staging = path.join(workspace, '.local', 'desktop-updates');
  let entries;
  try { entries = await readdir(staging, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const matches = [], selectedName = new RegExp(`^channel-${channel}-[0-9A-Za-z-]+-selected\\.json$`);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // Links are never followed.
    const directory = path.join(staging, entry.name);
    for (const name of await readdir(directory)) {
      if (!selectedName.test(name)) continue;
      const selected = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (selected?.channel === channel && selected.manifestSha256 === manifestSha256 && selected.pointerUpdated === true) matches.push(directory);
    }
  }
  return matches.sort().at(-1) ?? null;
}
async function versionIntact(pointer) {
  try {
    return digest(await readFile(pointer.executable)) === pointer.manifest.exeSha256
      && digest(await readFile(path.join(path.dirname(pointer.executable), 'resources', 'app.asar'))) === pointer.manifest.asarSha256;
  } catch { return false; }
}

/** start-soft-hearts.cmd: package, check and select the current source as the development version, then refresh both shortcuts. */
export async function installDevelopment(workspaceRoot = root, { environment = process.env, runEntry = runProductEntry, log = () => {},
  sourceHash = () => workspaceSourceHash(workspaceRoot), prepareCandidate = () => prepare({ unitPlan: 'native-product-v1' }) } = {}) {
  const workspace = await realpath(path.resolve(workspaceRoot));
  const current = await readChannelPointer(workspace, 'development');
  if (current && current.manifest.buildId === await sourceHash() && await versionIntact(current)
    && await findDeployedCandidate(workspace, 'development', current.sha256)) {
    const profile = await ensureDevelopmentProfile(workspace, environment);
    if (profile.seeded) log({ event: 'seeded', profile: profile.directory, ...profile.seeded });
    log({ event: 'up-to-date' });
    return { installed: false, refreshed: await refreshShortcuts(workspace, { runEntry, continueOnError: true }) };
  }
  log({ event: 'preparing' });
  const candidate = await prepareCandidate();
  const selected = await deployCandidate(workspace, candidate, { channel: 'development', environment, runEntry, log });
  return { installed: true, selected, refreshed: [{ channel: 'development', status: 'refreshed', shortcutPath: null },
    ...await refreshShortcuts(workspace, { channels: ['stable'], runEntry, continueOnError: true })] };
}

/** promote-to-stable.cmd: the already tested development version becomes stable. Nothing is rebuilt. */
export async function promoteDevelopment(workspaceRoot = root, { environment = process.env, runEntry = runProductEntry, log = () => {} } = {}) {
  const workspace = await realpath(path.resolve(workspaceRoot));
  const development = await readChannelPointer(workspace, 'development');
  if (!development) throw new DesktopRefusal('NO_DEVELOPMENT', 'There is no development version to promote yet.');
  const stable = await readChannelPointer(workspace, 'stable');
  if (stable && stable.manifest.buildId === development.manifest.buildId && stable.manifest.asarSha256 === development.manifest.asarSha256) {
    log({ event: 'already-stable' });
    return { promoted: false, refreshed: await refreshShortcuts(workspace, { channels: ['stable'], runEntry }) };
  }
  const candidate = await findDeployedCandidate(workspace, 'development', development.sha256);
  if (!candidate) throw new DesktopRefusal('NO_CANDIDATE', 'The validated files of the current development version are missing.');
  return { promoted: true, selected: await deployCandidate(workspace, candidate, { channel: 'stable', environment, runEntry, log }) };
}

/** What archivePrevious (pin-delivery.mjs) stores per replaced stable version, in the order its folder name hashes them. */
const HISTORY_MEMBERS = ['desktop-delivered.json', 'launcher.ps1', 'complete-delivery.lnk'];
async function assertNoLinks(base, file) {
  let current = base;
  for (const part of path.relative(base, file).split(path.sep)) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw Error('Desktop artifacts may not be links.'); }
}
/**
 * Every archived stable version, newest validation first. Each folder name is the hash of its HISTORY_MEMBERS, so one
 * that was changed, removed or added is refused before anything is chosen; other files are never read. Pointers of an
 * older format are never chosen.
 */
async function archivedStableVersions(workspace) {
  const history = path.join(workspace, 'release', 'stable-history');
  let entries;
  try { await assertNoLinks(workspace, history); entries = await readdir(history, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // Links and loose files are never followed.
    const directory = path.join(history, entry.name), members = [];
    try {
      if (!/^[a-f0-9]{64}$/.test(entry.name)) throw Error('unexpected folder');
      for (const name of HISTORY_MEMBERS) {
        const file = path.join(directory, name);
        try { await assertNoLinks(workspace, file); members.push([name, await readFile(file)]); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (members[0]?.[0] !== 'desktop-delivered.json' || digest(JSON.stringify(members.map(([name, bytes]) => [name, digest(bytes)]))) !== entry.name) throw Error('changed');
    } catch { throw new DesktopRefusal('BROKEN_ARCHIVE', `The archived stable version ${entry.name} was changed or is incomplete.`); }
    let manifest;
    try { manifest = parseChannelPointer(members[0][1], 'stable'); } catch { continue; }
    const time = Date.parse(manifest.validatedAt);
    if (Number.isFinite(time)) versions.push({ id: entry.name, bytes: members[0][1], manifest, time });
  }
  return versions.sort((a, b) => b.time - a.time);
}
/** The archived version's own immutable files, exactly as they were validated and installed. */
async function verifyArchivedVersion(workspace, archived) {
  try {
    const { manifest } = archived, versionRoot = path.join(workspace, 'release', 'stable', manifest.versionId);
    const manifestFile = path.join(versionRoot, 'stable-manifest.json'), executable = path.join(workspace, ...manifest.executable.split('/'));
    await assertNoLinks(workspace, manifestFile); await assertNoLinks(workspace, executable);
    const manifestBytes = await readFile(manifestFile);
    if (!manifestBytes.equals(archived.bytes) || !within(versionRoot, executable)) throw Error('manifest');
    const bundle = path.dirname(executable);
    if (digest(await readFile(executable)) !== manifest.exeSha256 || digest(await readFile(path.join(bundle, 'resources', 'app.asar'))) !== manifest.asarSha256
      || digest(JSON.stringify(await bundleSnapshot(workspace, bundle))) !== manifest.bundleSha256) throw Error('bytes');
    return { manifestFile, manifestBytes, executable, bundle };
  } catch { throw new DesktopRefusal('BROKEN_VERSION', `The files of the archived stable version ${archived.manifest.versionId} are missing or changed.`); }
}

/**
 * Puts the stable channel back on the previous archived stable version: no rebuild, no profile change. Only a version
 * that was archived and whose files still match exactly can be chosen; every refusal happens before anything is written.
 * Then that version's own product entry rewrites the stable shortcut, the replaced version is archived like a promotion
 * would, and the pointer is committed. If the commit fails, the shortcut is put back.
 */
export async function rollbackStable(workspaceRoot = root, { runEntry = runProductEntry, log = () => {} } = {}) {
  const workspace = await realpath(path.resolve(workspaceRoot));
  const current = await readChannelPointer(workspace, 'stable');
  if (!current) throw new DesktopRefusal('NO_STABLE', 'There is no stable version yet.');
  const currentTime = Date.parse(current.manifest.validatedAt);
  const target = (await archivedStableVersions(workspace)).find(row => row.manifest.versionId !== current.manifest.versionId && row.time < currentTime);
  if (!target) throw new DesktopRefusal('NO_PREVIOUS', 'No archived stable version is older than the current one.');
  const version = await verifyArchivedVersion(workspace, target);
  const referenceFile = path.join(workspace, 'release', 'desktop-profile.json');
  await assertNoLinks(workspace, referenceFile);
  const referenceBytes = await readFile(referenceFile), reference = JSON.parse(referenceBytes);
  if (reference?.version !== 1 || typeof reference.directory !== 'string' || !path.isAbsolute(reference.directory)) throw Error('The stable profile reference is invalid.');
  const stableProfile = await realpath(reference.directory);
  const staged = { channel: 'stable', manifest: target.manifest, target: version.bundle, manifestFile: version.manifestFile, manifestSha256: digest(version.manifestBytes),
    history: null, stableShortcutPath: null, stableProfile, stableProfileReferenceSha256: digest(referenceBytes),
    ownerMarker: digest(workspace.toLowerCase() + '\n' + 'stable' + '\n' + stableProfile.toLowerCase()).slice(0, 24), pointerUpdated: false, shortcutUpdated: false, runningVersionChanged: false };
  let entry = null;
  try {
    entry = await entryReceipt(workspace, { channel: 'stable', executable: version.executable, manifest: target.manifest, runEntry });
    if (entry.receipt.manifestSha256 !== staged.manifestSha256) throw Error('The stable shortcut does not belong to the archived version.');
    const history = await archiveStableHistory(workspace, { previousShortcut: previousShortcutBytes(entry.receipt) });
    const selected = { ...(await commitDeliveryPointer(workspace, staged, { shortcutReceipt: entry.receipt })), history, rolledBackFrom: current.manifest.versionId };
    log({ event: 'rolled-back', validatedAt: target.manifest.validatedAt, shortcutPath: entry.receipt.shortcutPath });
    return selected;
  } catch (error) {
    if (entry) error.shortcutState = await restoreShortcut(entry.receipt, 'stable');
    throw error;
  }
}

// The user reads these in the double-click window; details stay in English for diagnosis.
const SAY = {
  preparing: () => '正在更新开发版：检查类型、运行全部测试、打包，再用临时配置做一次冒烟测试。通常要几分钟，桌宠可以照常使用。',
  seeded: event => `第一次创建开发版配置（${event.profile}）：已从稳定版配置复制一次角色、语音等设置（${event.files} 个文件）。以后两边各自独立，不会再同步。`
    + (event.secretsNeedReentry ? '稳定版配置里没有解密密钥所需的 Local State，加密保存的密钥（比如百炼语音）要在开发版里重新填写。'
      : event.encryptedSettings ? '加密保存的密钥（比如百炼语音）连同解密用的 Local State 一起复制了；如果开发版里显示没有密钥，重新填写一次即可，稳定版不受影响。' : ''),
  selected: event => event.channel === 'development' ? '开发版已更新。' : '已把当前开发版设为稳定版，它继续使用原来的配置（%APPDATA%\\soft-hearts-claude）。',
  'up-to-date': () => '开发版已经是当前源码，不用重新打包。',
  'already-stable': () => '稳定版已经是当前开发版，只刷新了稳定版快捷方式。',
  'rolled-back': event => `已退回上一个稳定版（${event.validatedAt} 测过的那一版），桌面快捷方式“${shortcutName('stable').replace(/\.lnk$/u, '')}”已经指向它。`
    + '配置目录（%APPDATA%\\soft-hearts-claude）没有任何改动，对话、日记、画像和熟悉度都还在。如果稳定版正开着，请先从托盘菜单退出再打开。想再换成当前开发版，双击 promote-to-stable.cmd。',
};
const REFUSED = {
  NOT_WINDOWS: '这个操作只能在 Windows 上运行。什么都没有改动。',
  NO_DEVELOPMENT: '还没有开发版，所以不能设为稳定版。请先双击 start-soft-hearts.cmd，等窗口提示“开发版已更新”后再试。什么都没有改动。',
  NO_CANDIDATE: '找不到当前开发版打包时留下的检查记录（.local\\desktop-updates），没法确认它就是测过的版本，所以没有设为稳定版。请先双击 start-soft-hearts.cmd 重新生成开发版，再试一次。什么都没有改动。',
  NO_STABLE: '还没有稳定版，没有可以退回的版本。什么都没有改动。',
  NO_PREVIOUS: '没有比当前稳定版更早、而且已经归档的稳定版，所以没法退回。什么都没有改动。',
  BROKEN_ARCHIVE: '稳定版的归档记录（release\\stable-history）被改动过或不完整，没法确认上一版就是当时测过的版本，所以没有退回。什么都没有改动。',
  BROKEN_VERSION: '上一个稳定版的程序文件（release\\stable）缺失或被改动过，所以没有退回。什么都没有改动。',
};
const FAILED = {
  '--install': '开发版这次没有更新完成。桌宠已经用原来的方式启动，可以照常使用。下面是英文的具体原因，可以发给 Claude 排查：',
  '--promote': '没能把开发版设为稳定版。下面是英文的具体原因，可以发给 Claude 排查：',
  '--rollback-stable': '没能退回上一个稳定版。稳定版快捷方式已尽量放回原样。下面是英文的具体原因，可以发给 Claude 排查：',
  '--refresh-shortcuts': '桌面快捷方式没有刷新成功。下面是英文的具体原因，可以发给 Claude 排查：',
};
/** Prints one line per channel; returns false when a shortcut could not be refreshed. */
function sayShortcuts(results) {
  for (const result of results) {
    const name = shortcutName(result.channel).replace(/\.lnk$/u, '');
    if (result.status === 'refreshed') console.log(`桌面快捷方式已更新：${name}`);
    else if (result.status === 'failed') console.error(`“${name}”快捷方式这次没有刷新成功，另一个版本不受影响。英文原因：${result.error}`);
    else if (result.channel === 'stable') console.log(`还没有稳定版，所以没有创建“${name}”快捷方式。试用开发版满意后，双击 promote-to-stable.cmd 把它设为稳定版。`);
  }
  return !results.some(result => result.status === 'failed');
}
async function main() {
  const mode = process.argv[2] ?? '--install';
  // I-030: preparing and installing are heavy (all tests, packaging, the smoke): one at a time while the user is at the computer.
  if (mode === '--prepare' || mode === '--install') await gateHeavy(mode === '--prepare' ? 'prepare a candidate' : 'install the dev build');
  if (mode === '--prepare' || mode === '--deploy') {
    if (process.platform !== 'win32') throw new Error('Desktop deployment currently supports Windows only.');
    if (mode === '--prepare') { await prepare(); return; }
    const selected = await deployCandidate(root, process.argv[3] ?? '', { channel: argumentValue('--channel') ?? 'development', log: event => console.log(JSON.stringify(event)) });
    console.log(`Selected ${selected.channel}: ${path.join(selected.target, EXECUTABLE_NAME)}. No running app was stopped or started.`);
    return;
  }
  const say = event => { const line = SAY[event.event]?.(event); if (line) console.log(line); };
  const actions = {
    '--install': async () => {
      const result = await installDevelopment(root, { log: say });
      if (!sayShortcuts(result.refreshed)) process.exitCode = 1;
      if (result.installed) console.log('如果开发版已经开着，请先从它的托盘菜单退出，再双击快捷方式打开新版本。');
    },
    '--promote': async () => {
      const result = await promoteDevelopment(root, { log: say });
      if (result.promoted) console.log(`桌面快捷方式已更新：${shortcutName('stable').replace(/\.lnk$/u, '')}。如果稳定版已经开着，请先从它的托盘菜单退出再打开。`);
      else sayShortcuts(result.refreshed);
    },
    '--rollback-stable': async () => { await rollbackStable(root, { log: say }); },
    '--refresh-shortcuts': async () => sayShortcuts(await refreshShortcuts(root)),
  };
  if (!actions[mode]) throw new Error('Use --install (default), --promote, --rollback-stable, --refresh-shortcuts, --prepare --unit-plan native-product-v1, or --deploy <validated candidate directory> [--channel stable|development].');
  try {
    if (process.platform !== 'win32') throw new DesktopRefusal('NOT_WINDOWS', 'Desktop channels need Windows.');
    await actions[mode]();
  } catch (error) {
    if (error instanceof DesktopRefusal) { console.error(REFUSED[error.code] ?? error.message); process.exitCode = 2; return; }
    console.error(FAILED[mode]);
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
