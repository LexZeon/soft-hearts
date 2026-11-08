// Portable maintainer QA only. Importing this module starts no app or server.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isOwnExecutable } from './app-identity.mjs';
import { FAKE_CLAUDE_MARKER, readFakeClaudeLogs } from './fake-claude.mjs';

// Re-pinned after the Claude fork's profile-folder isolation (import only; the missing-path/no-fallback branch is unchanged).
export const LOCATOR_SHA256 = '47ff0d5a1e70f0c50a5baf1fe3a305efbca3dba24974d77d30c5df0a07c33a08';
export const DISCOVERY_SHA256 = '06d2908b534d1c010bcb82e35fb18c0de224b8172ca00fc64237792e4aaf8a95';
// scripts/claude-discovery.mjs: with CLAUDE_PATH set it returns exactly that file or 'invalid-override' and never
// searches PATH or the official install folders. The smoke points CLAUDE_PATH at an owned placeholder, so review
// that branch before updating this pin.
export const CLAUDE_DISCOVERY_SHA256 = 'eb824534abe88a81ce02c8f411ed9853d69cd82d02bc9566f123b9c70b68e5cc';
/** Smoke-owned files whose bytes must match the trusted updater's own copies (update-desktop.mjs). */
export const SMOKE_HARNESS_FILES = Object.freeze(['scripts/smoke.mjs', 'scripts/lib/smoke-isolation.mjs', 'scripts/lib/fake-claude.mjs']);
/** The model the synthetic profile selects; the fake checks it arrives as `--model`. */
export const SMOKE_CLAUDE_MODEL = 'haiku';
// Inert stand-in for CLAUDE_PATH: discovery accepts it, but it is not a program on Windows, and on other systems it
// only exits. The app reaches the fake Claude Code only through installClaudeInterposer.
export const CLAUDE_PLACEHOLDER_TEXT = '#!/bin/sh\n# soft hearts next smoke: CLAUDE_PATH placeholder, never a real Claude Code.\nexit 97\n';
// Variables a parent Claude Code session would leave behind. The packaged app must drop them before starting Claude Code.
export const CLAUDE_SESSION_DECOYS = Object.freeze({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'soft-hearts-smoke-decoy' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, file) => { const relative = path.relative(root, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const osKeys = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);

/** The synthetic profile's chat connection: Claude-only, a fixed alias, no address or key. */
export function fixtureProvider() { return { kind: 'claude', model: SMOKE_CLAUDE_MODEL }; }
export function rejectExternalSmokeFlags(environment) {
  // SOFT_HEARTS_CLAUDE_LIVE would let the unit-test stage spend the user's own Claude quota.
  for (const key of ['MMD_TEST_CODEX', 'MMD_TEST_LOCAL_URL', 'MMD_TEST_LOCAL_MODEL', 'SOFT_HEARTS_CLAUDE_LIVE'])
    assert.ok(!environment[key], 'Default smoke is synthetic only; run separately reviewed external-service QA instead of ' + key + '.');
}
export function operatingSystemEnvironment(parent) {
  const result = {};
  for (const key of Object.keys(parent)) if (osKeys.has(key.toUpperCase())) result[key.toUpperCase()] = parent[key];
  return result;
}
export function childEnvironment(parent, owned) {
  for (const key of ['codexHome', 'sentinel', 'claudeHome', 'claudePlaceholder', 'profile', 'localAppData']) assert.equal(typeof owned?.[key], 'string', 'Owned child path required: ' + key);
  // Codex: a missing sentinel. Claude Code: an inert owned placeholder (only the installed interposer turns it into
  // the fake) and an empty owned config folder, so even a wrongly started real CLI would find no login.
  // LOCALAPPDATA: the local pose-sensing components live under it (electron/pose/component-store.ts); the smoke
  // gets its own empty one, so it never cleans up or reads the user's downloaded components.
  return { ...operatingSystemEnvironment(parent), LOCALAPPDATA: owned.localAppData, CODEX_HOME: owned.codexHome, CODEX_PATH: owned.sentinel,
    CLAUDE_PATH: owned.claudePlaceholder, CLAUDE_CONFIG_DIR: owned.claudeHome, ...CLAUDE_SESSION_DECOYS, MMD_DESK_USER_DATA: owned.profile,
    // Away from the user's own companion at the bottom right (electron/pet-placement.ts).
    SOFT_HEARTS_TEST_PET_CORNER: 'top-left' };
}
export function assertLocatorBytes(bytes, discoveryBytes, claudeDiscoveryBytes) {
  assert.ok(Buffer.isBuffer(bytes) && Buffer.isBuffer(discoveryBytes) && Buffer.isBuffer(claudeDiscoveryBytes), 'All frozen Codex and Claude Code locator sources are mandatory.');
  assert.equal(sha(bytes), LOCATOR_SHA256, 'Codex host locator changed: review its explicit missing-path/no-fallback branch before updating this QA pin.');
  assert.equal(sha(discoveryBytes), DISCOVERY_SHA256, 'Shared Codex discovery changed: review its explicit missing-path/no-fallback branch before updating this QA pin.');
  assert.equal(sha(claudeDiscoveryBytes), CLAUDE_DISCOVERY_SHA256, 'Claude Code discovery changed: review its CLAUDE_PATH exact-file/no-fallback branch before updating this QA pin.');
}
const locatorSources = source => Promise.all(['electron/codex.ts', 'scripts/codex-discovery.mjs', 'scripts/claude-discovery.mjs'].map(file => readFile(path.join(source, file))));
export function assertSafeDeploymentProof(proof) {
  assert.ok(proof?.version === 1 && proof.safeSmoke === 1 && proof.smokePending !== true
    && Array.isArray(proof.inputs) && proof.inputs.length > 0
    && ['preparedSha256', 'smokeReportSha256'].every(key => typeof proof[key] === 'string' && /^[a-f0-9]{64}$/.test(proof[key])),
  'This candidate lacks the current safe smoke proof. Prepare a new candidate with desktop:update --prepare; existing proofs and desktop deliveries were preserved.');
}
export async function assertSmokeHarnessIdentity(source, trustedRoot, pinned = null) {
  const sourceRoot = await realpath(source), trusted = await realpath(trustedRoot), rows = [];
  for (const file of SMOKE_HARNESS_FILES) {
    const sourceFile = path.join(sourceRoot, file), trustedFile = path.join(trusted, file);
    const reason = 'Source smoke harness differs from this updater. Merge the reviewed safe smoke runner/helper before desktop:update --prepare; no smoke was executed.';
    try {
      assert.ok(inside(sourceRoot, await realpath(sourceFile)) && !(await lstat(sourceFile)).isSymbolicLink(), reason);
      assert.ok(inside(trusted, await realpath(trustedFile)) && !(await lstat(trustedFile)).isSymbolicLink(), reason);
      const expected = sha(await readFile(trustedFile));
      assert.equal(sha(await readFile(sourceFile)), expected, reason);
      rows.push([file, expected]);
    } catch (error) { throw Error(reason, { cause: error }); }
  }
  if (pinned) assert.deepEqual(rows, pinned, 'The trusted smoke harness changed during preparation. Prepare again from a stable source; no smoke was executed.');
  return rows;
}
export function assertSmokeReceipt(receipt, prepared, preparedSha256) {
  assert.ok(receipt?.version === 1 && receipt.status === 'PASS' && receipt.preparedSha256 === preparedSha256, 'Safe smoke did not return a successful receipt for this prepared package.');
  for (const key of ['sourceHash', 'asarSha256', 'executableSha256']) assert.equal(receipt.identity?.[key], prepared[key], 'Smoke package identity differs.');
  if (prepared.entryKind) assert.equal(receipt.identity?.entryKind, prepared.entryKind, 'Smoke product entry identity differs.');
  if (prepared.reusedFrom) assert.equal(receipt.identity?.validationSourceHash, prepared.validationIdentity?.sourceHash, 'Reused app lacks the complete validation identity.');
  // Receipts from the retired HTTP-fixture smoke recorded `serverClosed`; current ones record the fake Claude Code exits.
  const fixtureKey = receipt.cleanup && Object.hasOwn(receipt.cleanup, 'fakeClaudeExited') ? 'fakeClaudeExited' : 'serverClosed';
  for (const key of ['sdkCloseResolved', 'actualMainExited', fixtureKey, 'profileRemoved']) assert.equal(receipt.cleanup?.[key], true, 'Smoke cleanup was not confirmed.');
  assert.equal(receipt.cleanup?.main?.absent, true, 'Actual main exit was not observed.');
}
export async function assertOwnedProfile(owned) {
  const temp = await realpath(os.tmpdir());
  assert.ok(same(await realpath(owned.root), owned.root) && same(path.dirname(owned.root), temp) && path.basename(owned.root).startsWith('soft-hearts-smoke-'));
  assert.ok(same(owned.profile, path.join(owned.root, 'profile')) && same(owned.codexHome, path.join(owned.root, 'codex-home')) && same(owned.sentinel, path.join(owned.root, 'must-not-exist-codex.exe'))
    && same(owned.claudeHome, path.join(owned.root, 'claude-home')) && same(owned.claudePlaceholder, path.join(owned.root, 'claude-placeholder.exe'))
    && same(owned.fakeLog, path.join(owned.root, 'fake-claude')) && same(owned.localAppData, path.join(owned.root, 'local-app-data')), 'Owned child paths changed.');
  for (const name of ['profile', 'codexHome', 'claudeHome', 'fakeLog', 'localAppData']) {
    const directory = owned[name];
    assert.ok(!(await lstat(directory)).isSymbolicLink() && same(await realpath(directory), directory) && same(path.dirname(directory), owned.root), 'Owned profile/home boundary changed.');
  }
  assert.equal(await readFile(path.join(owned.profile, 'smoke-owner.json'), 'utf8'), owned.marker, 'Profile owner changed.');
  assert.deepEqual(await readdir(owned.codexHome), [], 'The scoped Codex home must remain empty.');
  // A real Claude Code would write its settings or login here; the fake never touches it.
  assert.deepEqual(await readdir(owned.claudeHome), [], 'The scoped Claude Code config folder must remain empty.');
  const placeholder = await lstat(owned.claudePlaceholder);
  assert.ok(placeholder.isFile() && !placeholder.isSymbolicLink() && same(await realpath(owned.claudePlaceholder), owned.claudePlaceholder), 'The Claude Code placeholder boundary changed.');
  assert.equal(await readFile(owned.claudePlaceholder, 'utf8'), CLAUDE_PLACEHOLDER_TEXT, 'The Claude Code placeholder changed.');
  try { await lstat(owned.sentinel); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('The must-not-exist Codex locator appeared; no discovery is allowed.');
}
export async function sourceFingerprint(source, inputs) {
  assert.ok(Array.isArray(inputs) && inputs.length > 0 && new Set(inputs).size === inputs.length);
  const rows = [];
  for (const file of [...inputs].sort()) {
    assert.ok(typeof file === 'string' && !path.isAbsolute(file) && !file.includes('\\') && !file.split('/').some(part => part === '..' || part === '.') && !file.includes('\0'));
    const physical = await realpath(path.join(source, file));
    assert.ok(inside(source, physical) && !(await lstat(path.join(source, file))).isSymbolicLink());
    rows.push([file, sha(await readFile(physical))]);
  }
  return sha(JSON.stringify(rows));
}

const maintainerOnly = new Set(['scripts/update-desktop.mjs', 'scripts/pin-delivery.mjs', 'scripts/pin-delivery.d.mts', 'scripts/start-latest.ps1', 'scripts/refresh-desktop-shortcuts.ps1', 'scripts/smoke.mjs', 'scripts/lib/smoke-isolation.mjs', 'scripts/lib/fake-claude.mjs', 'scripts/lib/fake-claude.d.mts', 'scripts/lib/desktop-profiles.mjs']);
export function assertRuntimeSourceEquivalence(oldRows, nextRows) {
  const old = new Map(oldRows), next = new Map(nextRows);
  assert.equal(old.size, oldRows.length); assert.equal(next.size, nextRows.length);
  for (const [file, digest] of [...oldRows, ...nextRows]) {
    assert.ok(typeof file === 'string' && /^[a-f0-9]{64}$/.test(digest));
    if (!file.startsWith('tests/') && !maintainerOnly.has(file)) assert.equal(old.get(file), next.get(file), 'Runtime reuse would change production or its build recipe: ' + file);
  }
}
export async function assertPreparedSourceIdentity(source, proofFile, proof) {
  const validation = proof.validationIdentity;
  if (!proof.reusedFrom) return assert.equal(await sourceFingerprint(source, proof.inputs), proof.sourceHash);
  assert.ok(validation && Array.isArray(validation.inputs) && validation.inputs.some(file => file.startsWith('tests/')));
  assert.equal(await sourceFingerprint(source, validation.inputs), validation.sourceHash);
  const workspace = path.resolve(path.dirname(proofFile), '../../..'), staging = path.join(workspace, '.local', 'desktop-updates');
  const oldFile = path.resolve(workspace, proof.reusedFrom.prepared);
  assert.ok(path.basename(oldFile) === 'prepared.json' && path.dirname(path.dirname(oldFile)) === staging && oldFile !== proofFile);
  const oldBytes = await readFile(oldFile), old = JSON.parse(oldBytes);
  assert.equal(sha(oldBytes), proof.reusedFrom.sha256);
  assert.ok(!old.reusedFrom && old.sourceHash === proof.sourceHash && old.asarSha256 === proof.asarSha256 && old.executableSha256 === proof.executableSha256);
  assert.deepEqual(old.inputs, proof.inputs);
  const oldSource = path.join(path.dirname(oldFile), 'source');
  assert.equal(await sourceFingerprint(oldSource, old.inputs), old.sourceHash);
  const rows = async (base, inputs) => Promise.all(inputs.map(async file => [file, sha(await readFile(path.join(base, file)))]));
  assertRuntimeSourceEquivalence(await rows(oldSource, old.inputs), await rows(source, validation.inputs));
}

// These functions are passed unchanged to Playwright's actual processes; each must stay self-contained.
export function inspectRunning({ app }, expected) {
  const fs = process.getBuiltinModule('module').createRequire(expected.profile + '/smoke-require.cjs')('original-fs');
  const equal = (a, b) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
  const profileMatches = equal(fs.realpathSync(app.getPath('userData')), expected.profile);
  const forbidden = Object.keys(process.env).some(key => {
    const name = key.toUpperCase();
    return (name.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_PATH'].includes(name)) || /PROXY|NODE_OPTIONS|(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE|BEARER)(?:_|$)/.test(name);
  });
  return { pid: process.pid, packaged: app.isPackaged, executable: fs.realpathSync(process.execPath), asar: fs.realpathSync(app.getAppPath()), profileMatches,
    markerMatches: profileMatches && fs.readFileSync(expected.profile + '/smoke-owner.json', 'utf8') === expected.marker,
    homeMatches: process.env.CODEX_HOME === expected.codexHome, locatorMatches: process.env.CODEX_PATH === expected.sentinel,
    claudeLocatorMatches: process.env.CLAUDE_PATH === expected.claudePlaceholder, claudeHomeMatches: process.env.CLAUDE_CONFIG_DIR === expected.claudeHome,
    profileEnvMatches: process.env.MMD_DESK_USER_DATA === expected.profile, localAppDataMatches: process.env.LOCALAPPDATA === expected.localAppData,
    forbiddenEnvironment: forbidden };
}
export function installMainBoundary({ app, session, desktopCapturer, ipcMain }, expected) {
  if (globalThis.__safeSmokeBoundary) throw Error('Smoke boundary already installed.');
  // Claude-only chat runs through a local process, so the main process has no reason to fetch at all.
  const state = { marker: expected.marker, fetchAttempts: 0, captureAttempts: 0, taskAttempts: 0, browserAttempts: 0, realtimeAttempts: 0, permissions: [], permissionOverflow: false, installedAt: Date.now() };
  const wrapper = async () => { state.fetchAttempts++; throw Error('Smoke blocked a main-process fetch.'); };
  Object.defineProperty(state, 'wrapper', { value: wrapper });
  Object.defineProperty(globalThis, 'fetch', { value: wrapper, writable: false, configurable: false });
  for (const name of ['WebSocket', 'EventSource']) Object.defineProperty(globalThis, name, { value: function () { state.realtimeAttempts++; throw Error('No main realtime connection in default smoke.'); }, writable: false, configurable: false });
  Object.defineProperty(desktopCapturer, 'getSources', { value: async () => { state.captureAttempts++; throw Error('No desktop capture in default smoke.'); }, writable: false, configurable: false });
  for (const method of ['startCodexTask', 'continueCodexTask', 'respondCodexApproval']) {
    ipcMain.removeHandler('desk:' + method); ipcMain.handle('desk:' + method, () => { state.taskAttempts++; throw Error('No agent execution in default smoke.'); });
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, done) => { state.browserAttempts++; done({ cancel: true }); });
  const permission = (kind, value) => { if (state.permissions.length < 64) state.permissions.push({ kind, name: typeof value === 'string' && /^[a-zA-Z-]{1,50}$/.test(value) ? value : 'other', returnedDenied: true }); else state.permissionOverflow = true; };
  session.defaultSession.setPermissionCheckHandler((_contents, value) => { permission('check', value); return false; });
  session.defaultSession.setPermissionRequestHandler((_contents, value, done) => { permission('request', value); done(false); });
  Object.defineProperty(globalThis, '__safeSmokeBoundary', { value: state });
}
/**
 * Turns the app's own Claude Code launch into the fake: `child_process.spawn` of exactly the owned CLAUDE_PATH
 * placeholder with the companion chat argv and shell:false starts `node fake-claude.mjs` instead, with the app's
 * own options (sanitized env, empty turn folder, pipes) untouched. Any other Claude Code launch is refused;
 * everything else passes through. The bundled host (esbuild CJS) reads `child_process.spawn` at call time.
 * Installed only from this harness, after launch, by evaluating in the app's main process: the app itself has
 * no fake transport and no switch that could enable one.
 */
export function installClaudeInterposer(_electron, expected) {
  if (globalThis.__safeSmokeClaude) throw Error('Claude Code interposer already installed.');
  const childProcess = process.getBuiltinModule('node:child_process');
  const paths = process.getBuiltinModule('node:path')[process.platform === 'win32' ? 'win32' : 'posix'];
  const original = childProcess.spawn;
  const key = value => { const resolved = paths.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const placeholder = key(expected.claudePlaceholder);
  // The packaging smoke keeps the default 8; source smokes (claude-smoke-fixture.mjs) switch characters often and pass more.
  const maxSpawns = Number.isSafeInteger(expected.maxSpawns) && expected.maxSpawns > 0 && expected.maxSpawns <= 256 ? expected.maxSpawns : 8;
  const state = { marker: expected.marker, spawned: [], denied: [], passedThrough: 0 };
  const deny = reason => { if (state.denied.length < 32) state.denied.push(reason); throw Error('Smoke refused a Claude Code launch: ' + reason); };
  const interposer = function spawn(file, args, options) {
    const list = Array.isArray(args) ? args : [];
    const target = typeof file === 'string' && file.length > 0 && key(file) === placeholder;
    const name = typeof file === 'string' ? paths.basename(file).toLowerCase() : '';
    const claudeLike = target || /^claude(?:\.(?:exe|cmd|bat|ps1))?$/.test(name)
      || list.some(value => typeof value === 'string' && /^--(?:input-format|output-format|strict-mcp-config|safe-mode|mcp-config|permission-prompt-tool)$/.test(value));
    if (!claudeLike) { state.passedThrough++; return Reflect.apply(original, this, arguments); }
    if (!target) deny('not the owned placeholder');
    if (list.length > 64 || !list.every(value => typeof value === 'string') || list[0] !== '-p') deny('not the companion chat argv');
    if (!list.includes('--strict-mcp-config') || list[list.indexOf('--tools') + 1] !== '') deny('tools or MCP servers not disabled');
    if (!options || typeof options !== 'object' || options.shell !== false || !options.env || typeof options.env !== 'object') deny('unsafe launch options');
    if (state.spawned.length >= maxSpawns) deny('too many Claude Code processes');
    const env = options.env, names = Object.keys(env).map(value => value.toUpperCase());
    const index = state.spawned.length;
    state.spawned.push({ index, model: list.includes('--model') ? list[list.indexOf('--model') + 1] : '', findings: {
      electronRunAsNode: names.includes('ELECTRON_RUN_AS_NODE'),
      sessionVariables: names.filter(value => value.startsWith('CLAUDE') && value !== 'CLAUDE_CONFIG_DIR').length,
      configDirMatches: env.CLAUDE_CONFIG_DIR === expected.claudeHome,
      noColor: env.NO_COLOR === '1', noAutoUpdater: env.DISABLE_AUTOUPDATER === '1',
      ownedTurnFolder: typeof options.cwd === 'string' && /[\\/]claude-chat[\\/](?:session|turn)-[^\\/]+$/.test(options.cwd),
      hidden: options.windowsHide === true,
    } });
    return Reflect.apply(original, this, [expected.fakeNode, [expected.fakeScript, expected.fakeMarker, paths.join(expected.fakeLog, 'spawn-' + index + '.jsonl'), ...list], options]);
  };
  Object.defineProperty(state, 'interposer', { value: interposer });
  Object.defineProperty(childProcess, 'spawn', { value: interposer, writable: false, configurable: false, enumerable: true });
  process.getBuiltinModule('node:module').syncBuiltinESMExports?.();
  Object.defineProperty(globalThis, '__safeSmokeClaude', { value: state });
}
export function inspectMainBoundary(_electron, expected) {
  const state = globalThis.__safeSmokeBoundary, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  if (!state || state.marker !== expected.marker || descriptor?.value !== state.wrapper || descriptor.writable || descriptor.configurable) throw Error('Smoke fetch boundary changed.');
  const claude = globalThis.__safeSmokeClaude, spawn = Object.getOwnPropertyDescriptor(process.getBuiltinModule('node:child_process'), 'spawn');
  if (!claude || claude.marker !== expected.marker || spawn?.value !== claude.interposer || spawn.writable || spawn.configurable) throw Error('Smoke Claude Code interposer changed.');
  return { fetchAttempts: state.fetchAttempts, captureAttempts: state.captureAttempts, taskAttempts: state.taskAttempts,
    browserAttempts: state.browserAttempts, realtimeAttempts: state.realtimeAttempts, permissions: [...state.permissions], permissionOverflow: state.permissionOverflow, installedAt: state.installedAt,
    claude: { spawned: claude.spawned.map(entry => ({ index: entry.index, model: entry.model, findings: { ...entry.findings } })), denied: [...claude.denied], passedThrough: claude.passedThrough } };
}
export function installRendererBoundary() {
  if (window.__safeSmokeRenderer) return;
  const state = { speech: 0, media: [], realtime: 0, mediaAbsent: !navigator.mediaDevices };
  const seals = [];
  const seal = (owner, name, value) => { Object.defineProperty(owner, name, { value, writable: false, configurable: false }); seals.push({ owner, name, value }); };
  if (window.speechSynthesis) seal(window.speechSynthesis, 'speak', () => { state.speech++; throw Error('No system speech in default smoke.'); });
  for (const name of ['WebSocket', 'EventSource']) seal(window, name, function () { state.realtime++; throw Error('No renderer network in default smoke.'); });
  if (navigator.mediaDevices) {
    seal(navigator, 'mediaDevices', navigator.mediaDevices);
    for (const name of ['getUserMedia', 'getDisplayMedia']) seal(navigator.mediaDevices, name,
      async () => { state.media.push(name); throw Error('No physical or display capture in default smoke.'); });
  }
  Object.defineProperty(state, 'seals', { value: seals });
  Object.defineProperty(window, '__safeSmokeRenderer', { value: state });
}
export function inspectRendererBoundary() {
  const state = window.__safeSmokeRenderer;
  if (!state || state.seals.some(({ owner, name, value }) => { const descriptor = Object.getOwnPropertyDescriptor(owner, name); return descriptor?.value !== value || descriptor.writable || descriptor.configurable; })) throw Error('Renderer denial boundary changed.');
  return { speech: state.speech, media: [...state.media], realtime: state.realtime, mediaAbsent: state.mediaAbsent };
}
export async function inspectSenderProvider(expected) {
  const provider = (await window.desktop.getSettings()).provider;
  const nodes = document.querySelectorAll('#provider-model'), node = nodes[0];
  if (nodes.length !== 1 || node.tagName !== 'INPUT' || node.type !== 'text') throw Error('Sender controls absent or ambiguous.');
  return { hostMatches: provider.kind === expected.kind && provider.model === expected.model, uiMatches: node.value === expected.model };
}

export async function createSmokeIsolation({ source, executable, proofFile, proofSha256 }) {
  source = await realpath(source); executable = await realpath(executable); proofFile = await realpath(proofFile);
  assert.ok(/^[a-f0-9]{64}$/.test(proofSha256 ?? ''), 'Explicit prepared-proof hash required.');
  assert.ok(same(source, path.join(path.dirname(proofFile), 'source')) && path.basename(proofFile) === 'prepared.json', 'Use a frozen candidate prepared by desktop:update, not a daily entry.');
  const bytes = await readFile(proofFile); assert.equal(sha(bytes), proofSha256);
  const proof = JSON.parse(bytes);
  assert.ok(proof.version === 1 && proof.smokePending === true && /^[a-f0-9]{64}$/.test(proof.sourceHash) && /^[a-f0-9]{64}$/.test(proof.executableSha256), 'A pending package/source identity is required; this is not a smoke result.');
  await assertPreparedSourceIdentity(source, proofFile, proof);
  assertLocatorBytes(...await locatorSources(source));
  assert.ok(inside(path.join(source, 'release'), executable) && isOwnExecutable(executable));
  const asar = await realpath(path.join(path.dirname(executable), 'resources/app.asar'));
  assert.equal(sha(await readFile(executable)), proof.executableSha256); assert.equal(sha(await readFile(asar)), proof.asarSha256);
  if (proof.bundleInputs) assert.equal(await sourceFingerprint(path.dirname(executable), proof.bundleInputs), proof.bundleSha256, 'Complete compiled bundle changed.');
  // The fake runs from the frozen copy that update-desktop already matched to its own (SMOKE_HARNESS_FILES).
  const fakeScript = path.join(source, 'scripts', 'lib', 'fake-claude.mjs');
  assert.ok(inside(source, await realpath(fakeScript)) && (await lstat(fakeScript)).isFile(), 'The reviewed fake Claude Code script is required.');
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'soft-hearts-smoke-')));
  const owned = { root, profile: path.join(root, 'profile'), codexHome: path.join(root, 'codex-home'), sentinel: path.join(root, 'must-not-exist-codex.exe'),
    claudeHome: path.join(root, 'claude-home'), claudePlaceholder: path.join(root, 'claude-placeholder.exe'), fakeLog: path.join(root, 'fake-claude'),
    localAppData: path.join(root, 'local-app-data'),
    marker: JSON.stringify({ version: 1, nonce: randomUUID(), sourceHash: proof.sourceHash }) };
  for (const directory of [owned.profile, owned.codexHome, owned.claudeHome, owned.fakeLog, owned.localAppData]) await mkdir(directory);
  await writeFile(path.join(owned.profile, 'smoke-owner.json'), owned.marker, { flag: 'wx' });
  await writeFile(owned.claudePlaceholder, CLAUDE_PLACEHOLDER_TEXT, { flag: 'wx', mode: 0o700 });
  const provider = fixtureProvider(), expected = { ...owned, ...provider, fakeNode: process.execPath, fakeScript, fakeMarker: FAKE_CLAUDE_MARKER };
  let mainPid;
  const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  const absent = () => !!mainPid && gone(mainPid);
  const fakeClaude = () => readFakeClaudeLogs(owned.fakeLog);
  const fakePids = () => fakeClaude().spawns.map(spawn => spawn.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
  return {
    ...owned, provider, proof, executable, asar, resultFile: path.join(path.dirname(proofFile), 'smoke-result.json'),
    environment: () => childEnvironment(process.env, owned),
    async beforeLaunch() { await assertOwnedProfile(owned); assertLocatorBytes(...await locatorSources(source)); },
    async running(instance) {
      await assertOwnedProfile(owned);
      const actual = await instance.evaluate(inspectRunning, expected);
      if (Number.isSafeInteger(actual.pid) && actual.pid > 0) mainPid ??= actual.pid;
      assert.ok(actual.pid === mainPid && actual.packaged && same(actual.executable, executable) && same(actual.asar, asar) && actual.profileMatches && actual.markerMatches
        && actual.homeMatches && actual.locatorMatches && actual.claudeLocatorMatches && actual.claudeHomeMatches && actual.profileEnvMatches && actual.localAppDataMatches
        && !actual.forbiddenEnvironment,
      'Actual packaged main/profile/environment mismatch.');
      return { mainPid, physicalProfileVerified: true };
    },
    async install(instance) {
      await this.running(instance); await instance.evaluate(installMainBoundary, expected); await instance.evaluate(installClaudeInterposer, expected);
      await instance.context().addInitScript(installRendererBoundary); for (const page of instance.windows()) await page.evaluate(installRendererBoundary);
    },
    /** What the fake Claude Code processes received and did (metadata only; see fake-claude.mjs). */
    fakeClaude,
    fakeClaudeGone: gone,
    /** All fake Claude Code processes ended (each exits when the app closes its stdin or ends it). */
    async waitForFakeClaudeExit(milliseconds = 4000) {
      const end = performance.now() + milliseconds;
      while (!fakePids().every(gone) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 60));
      return fakePids().every(gone);
    },
    async beforeMessage(instance, page) {
      await this.running(instance); const boundary = await instance.evaluate(inspectMainBoundary, expected);
      assert.equal(boundary.fetchAttempts, 0); assert.deepEqual(boundary.claude.denied, [], 'A Claude Code launch was refused.');
      assert.ok(instance.windows().includes(page) && !page.isClosed());
      const renderer = await page.evaluate(inspectRendererBoundary); assert.equal(renderer.mediaAbsent, false, 'Owned sender index lost its media API.');
      const actual = await page.evaluate(inspectSenderProvider, provider); assert.ok(actual.hostMatches && actual.uiMatches, 'Host and actual sender UI must match the synthetic Claude connection before each message.');
      return { hostAndSenderVerified: true, nonAtomicPreflight: true };
    },
    evidence: instance => instance.evaluate(inspectMainBoundary, expected),
    mainExit: () => ({ pid: mainPid ?? null, absent: absent(), scope: 'actual-main-only; not full-tree proof' }),
    async waitForMainExit(milliseconds = 4000) { const end = performance.now() + milliseconds; while (!absent() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 60)); return absent(); },
    async cleanup() { assert.ok(absent(), 'Keep the profile until actual main ESRCH is confirmed.'); await assertOwnedProfile(owned); await rm(root, { recursive: true, force: false }); },
    async finishIdentity() { assert.equal(sha(await readFile(proofFile)), proofSha256); await assertPreparedSourceIdentity(source, proofFile, proof); assert.equal(sha(await readFile(asar)), proof.asarSha256); assert.equal(sha(await readFile(executable)), proof.executableSha256); if (proof.bundleInputs) assert.equal(await sourceFingerprint(path.dirname(executable), proof.bundleInputs), proof.bundleSha256); return { sourceHash: proof.sourceHash, asarSha256: proof.asarSha256, executableSha256: proof.executableSha256, ...(proof.entryKind ? { entryKind: proof.entryKind } : {}), ...(proof.reusedFrom ? { validationSourceHash: proof.validationIdentity.sourceHash } : {}) }; },
  };
}
