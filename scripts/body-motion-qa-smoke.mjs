// STATIC maintainer harness; run only after the resource owner grants the native slot.
// Command: pnpm exec tsx scripts/body-motion-qa-smoke.mjs
// Required: MMD_TEST_APP_DIR=frozen-source MMD_TEST_EXE=isolated-package BODY_QA_RECIPE=neutral|proud|confirm
// One invocation launches one candidate/one fresh Temp profile. No normal data,
// user assets, launcher, ASR, chat, media, captures or direct motion activation.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, serializeMoodState } from '../shared/mood.ts';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const choice = process.env.BODY_QA_RECIPE;
const candidates = Object.freeze({
  neutral: { recipeId: 'idle.neutral', packId: '100style-idles', motionId: 'neutral-idle', maskId: 'candidate-pose-v1', durationMs: 10_000,
    sha256: '58887fab2e456bc9f5da21f275cc986a5fa8e96997b61b481e064ca3696002bb' },
  proud: { recipeId: 'idle.proud', packId: '100style-idles', motionId: 'proud-idle', maskId: 'candidate-pose-v1', durationMs: 161 / 30 * 1_000,
    sha256: '811ae39e09565bf824baf4803f8467b2881f1b42088448a49e9cb2fde7403a05' },
  confirm: { recipeId: 'body.confirm', packId: 'gene', motionId: 'convinced', maskId: 'candidate-head-v1', durationMs: 10_000,
    sha256: '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82' },
});
assert.ok(typeof choice === 'string' && Object.hasOwn(candidates, choice), 'Choose exactly neutral, proud or confirm.');
assert.ok(process.env.MMD_TEST_APP_DIR && process.env.MMD_TEST_EXE, 'Explicit frozen source and actual isolated packaged executable are required.');
const source = await realpath(path.resolve(process.env.MMD_TEST_APP_DIR));
const executable = await realpath(path.resolve(process.env.MMD_TEST_EXE));
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
assert.ok(!same(source, root), 'The mutable harness workspace cannot be used as the frozen app source.');
assert.ok((await lstat(source)).isDirectory()); assert.ok((await lstat(executable)).isFile());
const candidate = candidates[choice], asar = await realpath(path.join(path.dirname(executable), 'resources/app.asar'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileSha = async filename => sha(await readFile(filename));
const helpers = ['shared/defaults.ts', 'shared/mood.ts', 'shared/mood-runtime.ts', 'shared/body-motion.ts', 'shared/behavior-recipes.ts',
  'shared/contracts.ts', 'electron/main.ts', 'electron/mood.ts', 'electron/body-motion.ts', 'electron/body-motion-access.ts',
  'electron/body-motion-bindings.ts', 'electron/body-motion-qa.ts', 'electron/preload.ts', 'src/main.ts', 'src/stage/MmdStage.ts',
  'src/stage/body-motion-controller.ts', 'src/stage/behavior-body.ts', 'src/stage/motion-layers.ts', 'src/stage/vmd.ts',
  'src/stage/vmd-tracks.ts', 'shared/bundled-assets.json', 'shared/motion-catalog.json', 'scripts/body-motion-qa-smoke.mjs'];
const helperHashes = {};
for (const relative of helpers) {
  helperHashes[relative] = await fileSha(path.join(source, relative));
  assert.equal(await fileSha(path.join(root, relative)), helperHashes[relative], `Harness/runtime helper mismatch: ${relative}`);
}
async function visit(relative, base = source) {
  const result = [];
  for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Frozen runtime contains a link: ${child}`);
    if (entry.isDirectory()) result.push(...await visit(child, base));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}
const fixed = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts', 'index.html', 'LICENSE', 'ACKNOWLEDGEMENTS.md', 'THIRD_PARTY_NOTICES.md'];
const sourceFiles = [...fixed, ...(await Promise.all(['electron', 'shared', 'src', 'scripts', 'tests', 'assets/bundled'].map(folder => visit(folder)))).flat()].sort();
async function fingerprint(files) {
  const rows = [];
  for (const relative of files) rows.push([relative, await fileSha(path.join(source, relative))]);
  return sha(Buffer.from(JSON.stringify(rows)));
}
const sourceFingerprint = await fingerprint(sourceFiles), asarSha256 = await fileSha(asar);
if (process.env.BODY_QA_SOURCE_SHA256) assert.equal(sourceFingerprint, process.env.BODY_QA_SOURCE_SHA256);
if (process.env.BODY_QA_ASAR_SHA256) assert.equal(asarSha256, process.env.BODY_QA_ASAR_SHA256);
// Prove the actual package carries the frozen compiled output, not only a
// similarly named executable beside some unrelated TypeScript snapshot.
const requireSource = createRequire(path.join(source, 'package.json'));
const builderRequire = createRequire(requireSource.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asarModule = await import(pathToFileURL(appBuilderRequire.resolve('@electron/asar')).href);
const extractFile = asarModule.extractFile ?? asarModule.default?.extractFile;
assert.equal(typeof extractFile, 'function', 'Use the already installed ASAR reader; do not install tools during this run.');
const compiled = [...await visit('dist'), ...await visit('dist-electron')].sort();
assert.ok(compiled.includes('dist-electron/main.cjs') && compiled.includes('dist/index.html'));
const compiledHashes = {};
for (const relative of compiled) {
  compiledHashes[relative] = await fileSha(path.join(source, relative));
  assert.equal(sha(extractFile(asar, relative)), compiledHashes[relative], `Frozen/package byte mismatch: ${relative}`);
}
const manifest = JSON.parse(await readFile(path.join(source, 'shared/bundled-assets.json'), 'utf8'));
const catalog = JSON.parse(await readFile(path.join(source, 'shared/motion-catalog.json'), 'utf8'));
const modelPath = await realpath(path.join(source, 'assets/bundled', manifest.root, manifest.model.relativePath));
assert.equal(await fileSha(modelPath), '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37');
function motionFile(packId, motionId) {
  const pack = catalog.packs.find(value => value.id === packId), motion = pack?.motions.find(value => value.id === motionId);
  assert.ok(pack && motion); return { ...motion, filename: path.join(source, 'assets/bundled', pack.source, pack.id, pack.revision, motion.relativePath) };
}
const stand = motionFile('gene', 'stand'), selected = motionFile(candidate.packId, candidate.motionId);
assert.equal(await fileSha(stand.filename), '42080246b98aaa8a5b98d1ecd73994cf42b2587f9c04c3ed7435cf859fef83aa');
assert.equal(await fileSha(selected.filename), candidate.sha256);
// One canonical duration (shared/vmd-duration.ts): frames / 30 * 1000, the same double on host, parser, clip and player state.
assert.equal(selected.durationFrames / 30 * 1_000, candidate.durationMs);

const canonicalTemp = await realpath(tmpdir());
const profile = await realpath(await mkdtemp(path.join(canonicalTemp, `soft-hearts-body-qa-${randomUUID()}-`)));
assert.ok(same(path.dirname(profile), canonicalTemp));
assert.match(path.basename(profile), /^soft-hearts-body-qa-[A-Za-z0-9_-]{16,80}$/);
assert.ok(!(await lstat(profile)).isSymbolicLink());
const output = path.resolve(root, '..', 'qa-evidence', `${new Date().toISOString().replace(/[:.]/g, '-')}-${choice}`);
await mkdir(output, { recursive: true });
const checks = [], samples = [], errors = [];
let app, controls, pet, report, identity, fixtureHashes, phase = 'fixtures';
// No chat in body QA: Claude Code is only an inert placeholder with an empty config folder, Codex a missing path.
const claude = await createClaudeIsolation();
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
async function frame() {
  return pet.evaluate(() => {
    const canvas = document.querySelector('#stage canvas');
    return { at: Date.now(), body: JSON.parse(canvas?.dataset.bodyMotion ?? 'null'),
      transition: JSON.parse(canvas?.dataset.motionTransition ?? '{}'), base: JSON.parse(canvas?.dataset.chatGesture ?? '{}') };
  });
}
async function poll(predicate, timeout = 45_000, interval = 40) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, interval)); }
  throw new Error(`Timeout during ${phase}`);
}
function assertSample(row, cueId) {
  const body = row.body;
  assert.equal(body.cueId, cueId); assert.equal(body.recipeId, candidate.recipeId);
  assert.equal(body.packId, candidate.packId); assert.equal(body.motionId, candidate.motionId);
  assert.equal(body.sha256, candidate.sha256); assert.equal(body.maskId, candidate.maskId);
  assert.equal(body.durationMs, candidate.durationMs);
  assert.ok(body.weight >= 0 && body.weight <= 0.2 + 1e-8);
  assert.ok(body.elapsedMs >= 0 && body.elapsedMs < candidate.durationMs);
  assert.ok(body.trackNames.length > 0 && body.trackNames.every(name => /^\.bones\[[^\]]+\]\.(?:position|quaternion)$/.test(name)));
  assert.ok(body.trackNames.every(name => !/(?:指|目|眼|口|唇|眉|頬|髪|首飾り)/.test(name)));
  if (choice === 'confirm') assert.deepEqual([...body.trackNames].sort(), ['.bones[首].quaternion', '.bones[頭].quaternion'].sort());
  assert.ok(Number.isFinite(row.base.baseTime)); assert.ok(Number.isFinite(row.transition.layerTimes?.pose));
  assert.ok(Array.isArray(body.samples) && body.samples.length >= 7, 'Read actual final public-Gene bones from the QA-only Stage diagnostic.');
  for (const sample of body.samples) {
    assert.equal(typeof sample.name, 'string');
    assert.ok(Array.isArray(sample.quaternion) && sample.quaternion.length === 4 && sample.quaternion.every(Number.isFinite));
    assert.ok(Array.isArray(sample.position) && sample.position.length === 3 && sample.position.every(Number.isFinite));
  }
}
function quaternionDistance(first, next) {
  const scale = Math.hypot(...first) * Math.hypot(...next);
  assert.ok(scale > 1e-12);
  const dot = first.reduce((sum, value, index) => sum + value * next[index], 0) / scale;
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}
const positionDistance = (first, next) => Math.hypot(...first.map((value, index) => next[index] - value));
try {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.model = { path: modelPath, name: 'gene.pmx', url: 'mmd-asset://fixture/gene.pmx' };
  settings.motion = { path: stand.filename, name: 'stand.vmd', url: 'mmd-asset://fixture/stand.vmd' };
  settings.motionLayers = { gesture: null, expression: null };
  settings.provider = { kind: 'claude', baseUrl: DEFAULT_SETTINGS.provider.baseUrl, model: '' };
  settings.persona = '公开 Gene 隔离动作验收。';
  settings.voice.enabled = false; settings.voice.volume = 0;
  settings.pet.followMouse = false; settings.pet.breath = 0; settings.pet.alwaysOnTop = false;
  settings.pet.visible = true; settings.pet.clickThrough = false; settings.pet.fps = 30;
  settings.camera = { yaw: 0, pitch: 0, distance: 55, targetX: 0, targetY: 10, targetZ: 0, fov: 32 };
  const cardId = randomUUID(), now = Date.now();
  const state = createMoodState(now); state.lastInteractionAt = now;
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings, null, 2));
  await writeFile(path.join(profile, 'characters.json'), JSON.stringify({ version: 1, revision: 0, activeId: cardId,
    cards: [{ id: cardId, name: 'Gene QA fixture', description: '公开 Gene 合成验收；不代表默认角色绑定。',
      personality: '均衡。', scenario: '', greeting: '', examples: '', systemPrompt: '',
      mood: { version: 1, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS) } }] }, null, 2));
  await writeFile(path.join(profile, 'mood-state.json'), JSON.stringify({ version: 1, profiles: [
    { characterId: cardId, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), state: serializeMoodState(state) }] }, null, 2));
  fixtureHashes = { settings: await fileSha(path.join(profile, 'settings.json')), cards: await fileSha(path.join(profile, 'characters.json')) };
  phase = 'launch';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|MMD_DESK_USER_DATA|MMD_TEST_|CODEX_|OPENAI_|ANTHROPIC_|DASHSCOPE_)/.test(key)) delete env[key];
  Object.assign(env, claude.environment({}));
  app = await electron.launch({ executablePath: executable, cwd: source, env,
    args: [`--behavior-body-qa=${choice}`, `--user-data-dir=${profile}`] });
  identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath(),
    executable: process.execPath, pid: process.pid, argv: [...process.argv] }));
  assert.equal(identity.packaged, true); assert.ok(same(await realpath(identity.profile), profile));
  assert.ok(same(await realpath(identity.appPath), asar)); assert.ok(same(await realpath(identity.executable), executable));
  assert.deepEqual(identity.argv.filter(value => value.startsWith('--behavior-body-qa')), [`--behavior-body-qa=${choice}`]);
  assert.deepEqual(identity.argv.filter(value => value.startsWith('--user-data-dir')), [`--user-data-dir=${profile}`]);
  await app.evaluate(({ session }) => {
    globalThis.__bodyQaDenied = []; globalThis.__bodyQaPermissions = [];
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, name, done) => { globalThis.__bodyQaPermissions.push(name); done(false); });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
      const denied = /^(?:https?|wss?|ftp):/i.test(request.url);
      if (denied) globalThis.__bodyQaDenied.push(request.url); done({ cancel: denied });
    });
  });
  await poll(() => {
    for (const page of app.windows()) {
      if (!page.url().includes('index.html')) continue;
      if (!page.__bodyQaAttached) { page.__bodyQaAttached = true; page.on('pageerror', error => errors.push(error.message)); }
      if (new URL(page.url()).searchParams.has('pet')) pet = page; else controls = page;
    }
    return !!(pet && controls);
  });
  check('packaged executable/ASAR, exact startup arguments and unique canonical Temp profile');
  phase = 'natural-stage-prepare';
  // Do not call getBehaviorBodyPlan/resolveBehaviorBody, useBundledModel,
  // recoverPet, activateCharacterCard or any motion playback API here. The pet
  // Stage must prepare and resolve naturally after its committed Stand is ready.
  const first = await poll(async () => { const row = await frame(); return row.body?.active && row.body.weight > 0 ? row : null; });
  const hostView = await controls.evaluate(() => window.desktop.getMood());
  const hostCue = hostView.body?.cue;
  assert.ok(hostCue); assert.equal(hostView.body.mode, 'maintainer-qa');
  assert.equal(hostCue.id, first.body.cueId); assert.equal(hostCue.token, hostView.token); assert.equal(hostCue.recipeId, candidate.recipeId);
  assert.ok(hostCue.strength > 0 && hostCue.strength <= 0.2 + 1e-8);
  assert.equal(hostCue.durationMs, candidate.durationMs);
  assert.ok(first.body.elapsedMs <= 1_000, 'This invocation must observe near the start, not attach to an old performance.');
  assertSample(first, hostCue.id); samples.push(first);
  check('natural host cue reaches the pinned resolver and actual Stage player without direct playback calls');
  phase = 'original-single-source-pass';
  await poll(async () => {
    const row = await frame();
    if (row.body?.active) { assertSample(row, hostCue.id); samples.push(row); return false; }
    samples.push(row); return row.body && !row.body.pending;
  }, candidate.durationMs + 8_000, 40);
  const active = samples.filter(row => row.body?.active);
  assert.ok(active.length > 20);
  assert.ok(active.some(row => row.body.weight > 0.19), 'Bounded trial strength reaches the accepted plateau.');
  assert.ok(active.some(row => row.body.elapsedMs >= candidate.durationMs - 250), 'Sample the complete original pass through its final fade.');
  for (let index = 1; index < active.length; index++) {
    assert.ok(active[index].body.elapsedMs >= active[index - 1].body.elapsedMs, 'Source clock never restarts.');
    const advance = active[index].base.baseTime - active[index - 1].base.baseTime;
    assert.ok(advance >= -1e-8, 'Original mixer clock never rewinds.');
    const before = active[index - 1].transition.layerTimes.pose, after = active[index].transition.layerTimes.pose;
    const expected = (before + advance) % (stand.durationFrames / 30);
    assert.ok(Math.min(Math.abs(after - expected), Math.abs(after - expected - stand.durationFrames / 30),
      Math.abs(after - expected + stand.durationFrames / 30)) < 0.005,
      'Stand original phase continues through its source loop, independently of the body pass.');
  }
  assert.ok(active.at(-1).base.baseTime - active[0].base.baseTime > candidate.durationMs / 1_000 * 0.7);
  const firstBones = new Map(active[0].body.samples.map(sample => [sample.name, sample]));
  const movement = {};
  for (const row of active) for (const sample of row.body.samples) {
    const initial = firstBones.get(sample.name); assert.ok(initial);
    const record = movement[sample.name] ??= { maxRotationRadians: 0, maxPositionDistance: 0 };
    record.maxRotationRadians = Math.max(record.maxRotationRadians, quaternionDistance(initial.quaternion, sample.quaternion));
    record.maxPositionDistance = Math.max(record.maxPositionDistance, positionDistance(initial.position, sample.position));
  }
  const ownedNames = choice === 'confirm' ? ['首', '頭'] : ['首', '頭', '上半身', '左腕', '右腕'];
  assert.ok(ownedNames.some(name => movement[name]?.maxRotationRadians > 1e-5 || movement[name]?.maxPositionDistance > 1e-5),
    'An actually rendered owned bone varies numerically during the original source pass.');
  for (const name of ['左人指１', '右人指１']) {
    assert.ok(movement[name], `The actual non-overlapping ${name} is sampled.`);
    assert.ok(movement[name].maxRotationRadians < 1e-5 && movement[name].maxPositionDistance < 1e-5,
      'Original static Stand fingers remain unmodified by the automatic body mask.');
  }
  check('single original source clock, bounded strength, final fade and independently advancing Stand phase');
  phase = 'no-replay-no-reward';
  for (let index = 0; index < 30; index++) {
    const row = await frame(); assert.equal(row.body?.active, false); assert.equal(row.body?.pending, false);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const afterView = await controls.evaluate(() => window.desktop.getMood());
  assert.deepEqual(afterView.snapshot.values, DEFAULT_MOOD_PARAMETERS.baseline);
  assert.equal(afterView.snapshot.event, null); assert.equal(afterView.snapshot.phase, 'idle');
  assert.equal(afterView.snapshot.boredom, 0); assert.equal(afterView.snapshot.longing, 0);
  assert.deepEqual(afterView.parameters, DEFAULT_MOOD_PARAMETERS);
  assert.equal(afterView.body?.cue?.id ?? hostCue.id, hostCue.id, 'No replacement cue is invented.');
  assert.equal(await fileSha(path.join(profile, 'settings.json')), fixtureHashes.settings);
  assert.equal(await fileSha(path.join(profile, 'characters.json')), fixtureHashes.cards);
  check('no repeated cue, no mood reward and settings/cards bytes unchanged');
  phase = 'privacy-and-freeze';
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.deepEqual(runtime, { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
  const privacy = await app.evaluate(() => ({ denied: globalThis.__bodyQaDenied, permissions: globalThis.__bodyQaPermissions }));
  assert.deepEqual(privacy, { denied: [], permissions: [] }); assert.equal(await claude.claudeHomeEmpty(), true); assert.deepEqual(errors, []);
  assert.equal(await fingerprint(sourceFiles), sourceFingerprint); assert.equal(await fileSha(asar), asarSha256);
  check('media/permissions/provider traffic remain off and frozen source/package stay byte-identical');
  report = { status: 'passed-pending-visual-review', recipe: choice, candidate, sourceFingerprint, asarSha256,
    helperHashes, compiledHashes, identity, profile, checks, hostCue, samples, movement, privacy, errors, fixtureHashes,
    limits: ['Prepared for an explicitly coordinated native slot; this script itself is not authorization to run.',
      'Fresh synthetic public Gene/Stand profile only; no normal profile/export, real provider, media, launcher or ASR.',
      'Action/property-clock samples do not constitute continuous visible-use, side/back camera or subjective naturalness approval.',
      'No screenshots are captured. Candidate normal runtime pool remains closed; no daily deployment is claimed.'] };
} catch (error) {
  process.exitCode = 1;
  let diagnostic; try { if (pet) diagnostic = await frame(); } catch {}
  report = { status: 'failed', recipe: choice, phase, error: String(error.stack ?? error), sourceFingerprint, asarSha256,
    helperHashes, compiledHashes, identity, profile, checks, samples, errors, fixtureHashes, diagnostic };
  console.error(error);
} finally {
  const cleanup = { appClosed: false };
  try { if (app) await app.close(); cleanup.appClosed = true; }
  catch (error) { process.exitCode = 1; cleanup.error = String(error); }
  // Preserve the isolated evidence and profile. Never clean unrelated processes,
  // remove a computed directory tree or touch the normal desktop application.
  report = { ...report, ...(cleanup.error ? { status: 'failed-cleanup' } : {}), cleanup };
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Evidence: ${path.join(output, 'report.json')}`);
}
