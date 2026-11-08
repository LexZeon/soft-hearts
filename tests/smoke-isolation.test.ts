import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, type Context } from 'node:vm';

// Dynamic URL keeps this test independent of JS declaration generation.
const helper = await import(new URL('../scripts/lib/smoke-isolation.mjs', import.meta.url).href);
const invoke = (context: Context, fn: Function, args = '') => runInContext(`(${fn.toString()})(${args})`, context);
const fixture = helper.fixtureProvider();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('synthetic connection is Claude-only with a fixed alias; flags cannot opt into real services', () => {
  assert.deepEqual(fixture, { kind: 'claude', model: 'haiku' });
  assert.equal(helper.SMOKE_CLAUDE_MODEL, 'haiku');
  for (const key of ['MMD_TEST_CODEX', 'MMD_TEST_LOCAL_URL', 'MMD_TEST_LOCAL_MODEL', 'SOFT_HEARTS_CLAUDE_LIVE']) assert.throws(() => helper.rejectExternalSmokeFlags({ [key]: '1' }));
  helper.rejectExternalSmokeFlags({});
});

test('OS whitelist never even reads excluded values; owned Codex, Claude Code and physical profile override caller', () => {
  const environment: Record<string, string> = { Path: 'synthetic-bin', SystemRoot: 'synthetic-system', LocalAppData: 'foreign-local', CODEX_HOME: 'foreign', CODEX_PATH: 'foreign', MMD_DESK_USER_DATA: 'foreign' };
  for (const name of ['API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'NODE_PATH', 'CODEX_AUTH_TOKEN', 'CODEX_PLUGINS', 'ELECTRON_RUN_AS_NODE', 'CLAUDE_PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDECODE'])
    Object.defineProperty(environment, name, { enumerable: true, get() { throw Error('Excluded environment was read.'); } });
  const owned = { codexHome: 'owned-home', sentinel: 'owned-missing', claudeHome: 'owned-claude-home', claudePlaceholder: 'owned-placeholder', profile: 'owned-profile', localAppData: 'owned-local' };
  const child = helper.childEnvironment(environment, owned);
  // LOCALAPPDATA too: the pose components live under it, and the smoke must never touch the user's (2026-11-03).
  assert.deepEqual(child, { PATH: 'synthetic-bin', SYSTEMROOT: 'synthetic-system', LOCALAPPDATA: 'owned-local', CODEX_HOME: 'owned-home', CODEX_PATH: 'owned-missing', CLAUDE_PATH: 'owned-placeholder',
    CLAUDE_CONFIG_DIR: 'owned-claude-home', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'soft-hearts-smoke-decoy', MMD_DESK_USER_DATA: 'owned-profile',
    SOFT_HEARTS_TEST_PET_CORNER: 'top-left' });
  for (const key of Object.keys(owned)) assert.throws(() => helper.childEnvironment({}, { ...owned, [key]: undefined }), /Owned child path required/);
});

test('actual locator pins are mandatory and reject any changed bytes', async () => {
  const source = process.env.SOFT_HEARTS_TEST_SOURCE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bytes = await readFile(path.join(source, 'electron/codex.ts'));
  const discoveryBytes = await readFile(path.join(source, 'scripts/codex-discovery.mjs'));
  const claudeBytes = await readFile(path.join(source, 'scripts/claude-discovery.mjs'));
  helper.assertLocatorBytes(bytes, discoveryBytes, claudeBytes);
  const changed = (value: Buffer) => Buffer.concat([value, Buffer.from('\n')]);
  assert.throws(() => helper.assertLocatorBytes(changed(bytes), discoveryBytes, claudeBytes));
  assert.throws(() => helper.assertLocatorBytes(bytes, changed(discoveryBytes), claudeBytes));
  assert.throws(() => helper.assertLocatorBytes(bytes, discoveryBytes, changed(claudeBytes)), /Claude Code discovery changed/);
  assert.throws(() => helper.assertLocatorBytes(bytes, discoveryBytes));
  assert.throws(() => helper.assertLocatorBytes(undefined, discoveryBytes, claudeBytes));
});

test('pinned Claude Code discovery takes the owned placeholder over a real claude.exe on PATH, and never falls back', async () => {
  const { discoverClaude } = await import('../scripts/claude-discovery.mjs');
  const files = new Set(['C:\\Temp\\soft-hearts-smoke-x\\claude-placeholder.exe', 'C:\\tools\\claude.exe', 'C:\\Users\\a\\.local\\bin\\claude.exe']);
  const io = { stat: async (file: string) => { if (!files.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { isFile: () => true }; }, access: async () => {} };
  const env = { CLAUDE_PATH: 'C:\\Temp\\soft-hearts-smoke-x\\claude-placeholder.exe', PATH: 'C:\\tools', USERPROFILE: 'C:\\Users\\a' };
  assert.deepEqual(await discoverClaude({ platform: 'win32', env, io }), { status: 'found', path: 'C:\\Temp\\soft-hearts-smoke-x\\claude-placeholder.exe' });
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, CLAUDE_PATH: 'C:\\Temp\\soft-hearts-smoke-x\\gone.exe' }, io }), { status: 'invalid-override', path: null });
});

test('owned Temp/profile/home marker, Claude Code placeholder and missing locator fail closed before cleanup', async () => {
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'soft-hearts-smoke-')));
  const owned = { root, profile: path.join(root, 'profile'), codexHome: path.join(root, 'codex-home'), sentinel: path.join(root, 'must-not-exist-codex.exe'),
    claudeHome: path.join(root, 'claude-home'), claudePlaceholder: path.join(root, 'claude-placeholder.exe'), fakeLog: path.join(root, 'fake-claude'),
    localAppData: path.join(root, 'local-app-data'), marker: 'synthetic-owner-only' };
  try {
    for (const directory of [owned.profile, owned.codexHome, owned.claudeHome, owned.fakeLog, owned.localAppData]) await mkdir(directory);
    await assert.rejects(helper.assertOwnedProfile({ ...owned, localAppData: path.join(root, 'elsewhere') }), /Owned child paths changed/);
    await writeFile(path.join(owned.profile, 'smoke-owner.json'), owned.marker); await writeFile(owned.claudePlaceholder, helper.CLAUDE_PLACEHOLDER_TEXT);
    await helper.assertOwnedProfile(owned);
    await assert.rejects(helper.assertOwnedProfile({ ...owned, sentinel: path.join(root, 'other.exe') }));
    await assert.rejects(helper.assertOwnedProfile({ ...owned, claudePlaceholder: path.join(root, 'claude.exe') }));
    await writeFile(owned.sentinel, 'never executed'); await assert.rejects(helper.assertOwnedProfile(owned)); await rm(owned.sentinel);
    await writeFile(path.join(owned.codexHome, 'unexpected'), 'synthetic'); await assert.rejects(helper.assertOwnedProfile(owned)); await rm(path.join(owned.codexHome, 'unexpected'));
    await writeFile(path.join(owned.claudeHome, '.claude.json'), '{}'); await assert.rejects(helper.assertOwnedProfile(owned), /config folder must remain empty/); await rm(path.join(owned.claudeHome, '.claude.json'));
    await writeFile(owned.claudePlaceholder, 'MZ'); await assert.rejects(helper.assertOwnedProfile(owned), /placeholder changed/);
    await rm(owned.claudePlaceholder); await assert.rejects(helper.assertOwnedProfile(owned)); await writeFile(owned.claudePlaceholder, helper.CLAUDE_PLACEHOLDER_TEXT);
    await writeFile(path.join(owned.fakeLog, 'spawn-0.jsonl'), ''); await helper.assertOwnedProfile(owned);
    await writeFile(path.join(owned.profile, 'smoke-owner.json'), 'foreign'); await assert.rejects(helper.assertOwnedProfile(owned));
    await writeFile(path.join(owned.profile, 'smoke-owner.json'), owned.marker); await helper.assertOwnedProfile(owned);
    const inputs = ['profile/smoke-owner.json'];
    assert.equal(await helper.sourceFingerprint(root, inputs), hash(JSON.stringify([[inputs[0], hash(owned.marker)]])));
    await assert.rejects(helper.sourceFingerprint(root, ['../foreign'])); await assert.rejects(helper.sourceFingerprint(root, [...inputs, ...inputs]));
  } finally {
    assert.equal(path.dirname(root).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(root).startsWith('soft-hearts-smoke-')); await rm(root, { recursive: true });
  }
});

test('actual serialized main boundary refuses every fetch and requires the sealed Claude Code interposer', async () => {
  const delegated: any[] = [], handlers = new Map();
  const childProcess: { spawn: (...args: unknown[]) => unknown } = { spawn: () => { throw Error('Unsealed native launch.'); } };
  let check: Function = () => {}, request: Function = () => {};
  const expected = { ...fixture, marker: 'synthetic-marker', claudePlaceholder: path.join(os.tmpdir(), 'owned', 'claude-placeholder.exe') };
  const context = createContext({ URL, Buffer, Date, expected,
    fetch: async (...args: any[]) => { delegated.push(args); return 'local-response'; },
    process: { platform: process.platform, getBuiltinModule: (name: string) => name === 'node:child_process' ? childProcess : name === 'node:path' ? path : { syncBuiltinESMExports() {} } },
    electron: { app: {}, desktopCapturer: { getSources() { throw Error('Unsealed native call.'); } }, ipcMain: { removeHandler() {}, handle(name: string, fn: Function) { handlers.set(name, fn); } },
      session: { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionCheckHandler(fn: Function) { check = fn; }, setPermissionRequestHandler(fn: Function) { request = fn; } } } } });
  invoke(context, helper.installMainBoundary, 'electron,expected');
  assert.throws(() => invoke(context, helper.inspectMainBoundary, 'electron,expected'), /interposer changed/, 'The fetch boundary alone is not a complete smoke boundary.');
  invoke(context, helper.installClaudeInterposer, 'electron,expected');
  const call = (input: unknown, init?: unknown) => { context.input = input; context.init = init; return runInContext('fetch(input,init)', context); };
  let coerced = false;
  for (const input of ['http://127.0.0.1:49151/v1/chat/completions', 'https://api.anthropic.com/v1/messages', { toString() { coerced = true; return 'http://127.0.0.1/'; } }]) await assert.rejects(call(input, { method: 'POST' }));
  assert.equal(coerced, false); assert.equal(delegated.length, 0);
  assert.equal(check(null, 'background-sync'), false); let denied: unknown; request(null, 'media', (value: unknown) => { denied = value; }); assert.equal(denied, false);
  assert.throws(() => runInContext('new WebSocket("wss://example.invalid")', context));
  assert.throws(() => handlers.get('desk:startCodexTask')());
  assert.throws(() => childProcess.spawn('claude.exe', ['-p']), /refused a Claude Code launch/);
  const result = invoke(context, helper.inspectMainBoundary, 'electron,expected');
  assert.equal(result.fetchAttempts, 3); assert.equal(result.taskAttempts, 1); assert.equal(result.realtimeAttempts, 1);
  assert.deepEqual([...result.claude.denied], ['not the owned placeholder']); assert.equal(result.claude.spawned.length, 0);
  assert.equal(result.permissions[0].kind, 'check'); assert.equal(result.permissions[1].kind, 'request'); assert.ok(result.permissions.every((event: any) => event.returnedDenied));
  // A launch function other than the sealed interposer (e.g. a module the app swapped in) is detected.
  context.process = { platform: process.platform, getBuiltinModule: (name: string) => name === 'node:child_process' ? { spawn: () => null } : path };
  assert.throws(() => invoke(context, helper.inspectMainBoundary, 'electron,expected'), /interposer changed/);
});

test('actual sender inspector distinguishes host and UI mismatches and ambiguous controls', async () => {
  let provider: Record<string, string> = { ...fixture, baseUrl: 'http://127.0.0.1:11434/v1' };
  const nodes: Record<string, any[]> = { 'provider-model': [{ tagName: 'INPUT', type: 'text', value: fixture.model }] };
  const context = createContext({ expected: fixture, window: { desktop: { getSettings: async () => ({ provider }) } }, document: { querySelectorAll: (selector: string) => nodes[selector.slice(1)] ?? [] } });
  let result = await invoke(context, helper.inspectSenderProvider, 'expected'); assert.ok(result.hostMatches && result.uiMatches);
  provider = { ...provider, model: 'opus' }; result = await invoke(context, helper.inspectSenderProvider, 'expected'); assert.equal(result.hostMatches, false); assert.equal(result.uiMatches, true);
  provider = { ...provider, kind: 'ollama', model: fixture.model }; result = await invoke(context, helper.inspectSenderProvider, 'expected'); assert.equal(result.hostMatches, false);
  provider = { ...fixture }; nodes['provider-model'][0].value = 'sonnet'; result = await invoke(context, helper.inspectSenderProvider, 'expected'); assert.equal(result.hostMatches, true); assert.equal(result.uiMatches, false);
  nodes['provider-model'].push(nodes['provider-model'][0]); await assert.rejects(invoke(context, helper.inspectSenderProvider, 'expected'));
});

test('renderer denial installs on media-absent reply and seals available media without a native call', async () => {
  let native = 0;
  for (const present of [false, true]) {
    const window = { speechSynthesis: { speak() { native++; } } };
    const context = createContext({ window, navigator: present ? { mediaDevices: { getUserMedia() { native++; }, getDisplayMedia() { native++; } } } : {} });
    invoke(context, helper.installRendererBoundary);
    assert.throws(() => runInContext('new window.EventSource("https://example.invalid")', context));
    if (present) await assert.rejects(runInContext('navigator.mediaDevices.getUserMedia({video:true})', context));
    const result = invoke(context, helper.inspectRendererBoundary); assert.equal(result.mediaAbsent, !present); assert.equal(result.realtime, 1); assert.equal(result.media.length, present ? 1 : 0);
    assert.equal(runInContext('Object.getOwnPropertyDescriptor(window,"WebSocket").writable', context), false);
    if (present) assert.equal(runInContext('Object.getOwnPropertyDescriptor(navigator,"mediaDevices").configurable', context), false);
  }
  assert.equal(native, 0);
});

test('actual main inspector records wrong physical profile without reading its owner marker', () => {
  let markerReads = 0;
  const expected = { profile: 'owned-profile', marker: 'owned-marker', codexHome: 'owned-home', sentinel: 'owned-missing', claudePlaceholder: 'owned-placeholder', claudeHome: 'owned-claude-home' };
  const env: Record<string, string> = { CODEX_HOME: expected.codexHome, CODEX_PATH: expected.sentinel, CLAUDE_PATH: expected.claudePlaceholder, CLAUDE_CONFIG_DIR: expected.claudeHome, MMD_DESK_USER_DATA: expected.profile };
  const context = createContext({ expected, electron: { app: { isPackaged: true, getPath: () => 'foreign-profile', getAppPath: () => 'synthetic.asar' } },
    process: { pid: 1234, execPath: 'synthetic.exe', env, getBuiltinModule: () => ({ createRequire: () => () => ({ realpathSync: (value: string) => value, readFileSync() { markerReads++; throw Error('Must not read foreign profile.'); } }) }) } });
  let result = invoke(context, helper.inspectRunning, 'electron,expected'); assert.equal(result.pid, 1234); assert.equal(result.profileMatches, false); assert.equal(result.markerMatches, false); assert.equal(markerReads, 0);
  assert.ok(result.claudeLocatorMatches && result.claudeHomeMatches && !result.forbiddenEnvironment);
  env.CLAUDE_PATH = 'C:\\Users\\someone\\.local\\bin\\claude.exe'; env.CLAUDE_CONFIG_DIR = 'C:\\Users\\someone\\.claude';
  result = invoke(context, helper.inspectRunning, 'electron,expected'); assert.equal(result.claudeLocatorMatches, false); assert.equal(result.claudeHomeMatches, false);
});

test('prepared identity and actual cleanup receipt are all mandatory for validation', () => {
  const proof = { sourceHash: 'a'.repeat(64), asarSha256: 'b'.repeat(64), executableSha256: 'c'.repeat(64) }, pin = 'd'.repeat(64);
  const receipt = { version: 1, status: 'PASS', preparedSha256: pin, identity: proof, cleanup: { sdkCloseResolved: true, actualMainExited: true, fakeClaudeExited: true, profileRemoved: true, main: { absent: true } } };
  helper.assertSmokeReceipt(receipt, proof, pin);
  assert.throws(() => helper.assertSmokeReceipt({ ...receipt, status: 'FAIL' }, proof, pin));
  assert.throws(() => helper.assertSmokeReceipt(receipt, proof, 'e'.repeat(64)));
  assert.throws(() => helper.assertSmokeReceipt({ ...receipt, identity: { ...proof, sourceHash: 'f'.repeat(64) } }, proof, pin));
  for (const name of ['sdkCloseResolved', 'actualMainExited', 'fakeClaudeExited', 'profileRemoved']) assert.throws(() => helper.assertSmokeReceipt({ ...receipt, cleanup: { ...receipt.cleanup, [name]: false } }, proof, pin));
  assert.throws(() => helper.assertSmokeReceipt({ ...receipt, cleanup: { ...receipt.cleanup, main: { absent: false } } }, proof, pin));
  // A receipt from the retired HTTP-fixture smoke (already validated candidates) still needs its own fixture close.
  const { fakeClaudeExited, ...legacy } = receipt.cleanup;
  helper.assertSmokeReceipt({ ...receipt, cleanup: { ...legacy, serverClosed: true } }, proof, pin);
  assert.throws(() => helper.assertSmokeReceipt({ ...receipt, cleanup: { ...legacy, serverClosed: false } }, proof, pin));
  assert.throws(() => helper.assertSmokeReceipt({ ...receipt, cleanup: legacy }, proof, pin));
  assert.throws(() => helper.assertSmokeReceipt({ ...receipt, cleanup: { ...receipt.cleanup, fakeClaudeExited: false, serverClosed: true } }, proof, pin));
});
