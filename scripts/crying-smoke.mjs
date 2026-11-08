// Prepared maintainer QA only. Run after the native slot is explicitly handed over.
// node --import tsx scripts/crying-smoke.mjs
// Required: MMD_TEST_APP_DIR=<frozen candidate/source>, MMD_TEST_EXE=<its packaged EXE>.
// Optional: MMD_TEST_CANDIDATE_MANIFEST=<validated.json>; defaults to source/../validated.json.
// Optional: MMD_TEST_EXPECTED_STAGE_SHA256=<group-reviewed merged Stage hash>.
// Every profile/card/message is synthetic. No renderer-created crying state is injected.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createMoodState, serializeMoodState, DEFAULT_MOOD_PARAMETERS } from '../shared/mood.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/blush.ts';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';

const harnessFile = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(harnessFile), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const hashPattern = /^[a-f0-9]{64}$/;
async function hash(file) { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex'); }
function relativeFile(value) {
  assert.ok(typeof value === 'string' && value && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value), 'Source input must be relative.');
  const parts = value.replaceAll('\\', '/').split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\0')), 'No source traversal.');
  return parts.join('/');
}
async function checkedFile(directory, relative) {
  const file = path.join(directory, relativeFile(relative)); assert.ok(within(directory, file));
  assert.equal((await lstat(file)).isFile(), true); assert.ok(within(directory, await realpath(file)), 'Frozen inputs remain in their source.');
  return file;
}

assert.ok(process.env.MMD_TEST_APP_DIR && process.env.MMD_TEST_EXE, 'Both frozen APP_DIR and packaged EXE are required; the shared build is never launched.');
const suppliedSource = await realpath(process.env.MMD_TEST_APP_DIR);
const source = path.basename(suppliedSource).toLowerCase() === 'source' ? suppliedSource : await realpath(path.join(suppliedSource, 'source'));
assert.equal(samePath(source, await realpath(root)), false, 'APP_DIR must identify an immutable candidate, not this development source.');
const executable = await realpath(process.env.MMD_TEST_EXE), asar = await realpath(path.join(path.dirname(executable), 'resources', 'app.asar'));
const manifestFile = await realpath(process.env.MMD_TEST_CANDIDATE_MANIFEST ?? path.join(source, '..', 'validated.json'));
const manifestBytes = await readFile(manifestFile), proof = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(proof.version, 1); assert.ok(hashPattern.test(proof.sourceHash) && hashPattern.test(proof.asarSha256));
assert.ok(Array.isArray(proof.inputs) && proof.inputs.length > 0 && proof.inputs.length < 20_000 && new Set(proof.inputs).size === proof.inputs.length);
const exactFiles = ['shared/mood.ts', 'shared/mood-runtime.ts', 'shared/contracts.ts', 'shared/defaults.ts', 'shared/blush.ts',
  'shared/bundled-assets.json', 'electron/mood.ts', 'src/stage/procedural-blush.ts', 'src/stage/procedural-tears.ts',
  'src/stage/crying-timeline.ts', 'src/stage/MmdStage.ts', 'scripts/crying-smoke.mjs', 'scripts/lib/control-navigation.mjs'];
const exactHelpers = new Set(['shared/mood.ts', 'shared/defaults.ts', 'shared/blush.ts',
  'src/stage/procedural-tears.ts', 'src/stage/crying-timeline.ts', 'scripts/crying-smoke.mjs', 'scripts/lib/control-navigation.mjs']);
const sourceBefore = {};
for (const name of exactFiles) {
  assert.ok(proof.inputs.includes(name), `Validation record includes ${name}.`);
  sourceBefore[name] = await hash(await checkedFile(source, name));
  if (exactHelpers.has(name)) assert.equal(await hash(path.join(root, name)), sourceBefore[name], `Harness/helpers and frozen ${name} match exactly.`);
}
const expectedStage = process.env.MMD_TEST_EXPECTED_STAGE_SHA256?.toLowerCase();
if (expectedStage) {
  assert.ok(hashPattern.test(expectedStage), 'Expected merged Stage hash must be a complete SHA-256.');
  assert.equal(sourceBefore['src/stage/MmdStage.ts'], expectedStage, 'Stage matches the group-reviewed merged source.');
}
async function sourceFingerprint() {
  const entries = [];
  for (const name of [...proof.inputs].sort()) entries.push([relativeFile(name), await hash(await checkedFile(source, name))]);
  return digest(JSON.stringify(entries));
}
assert.equal(await sourceFingerprint(), proof.sourceHash, 'Complete frozen source matches its validation fingerprint.');
const before = { sourceHash: proof.sourceHash, asarSha256: await hash(asar), executableSha256: await hash(executable),
  manifestSha256: digest(manifestBytes), harnessSha256: await hash(harnessFile), stageSha256: sourceBefore['src/stage/MmdStage.ts'], exactSourceSha256: sourceBefore };
assert.equal(before.asarSha256, proof.asarSha256, 'The supplied packaged ASAR is the validated candidate.');

const output = path.join(root, '.local', 'crying-smoke', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const tempRoot = await realpath(tmpdir()), profile = await mkdtemp(path.join(tempRoot, 'soft-hearts-crying-'));
assert.equal(path.dirname(await realpath(profile)), tempRoot);
assert.match(path.basename(profile), /^soft-hearts-crying-/);
assert.equal(within(source, profile), false, 'The disposable profile is outside the frozen runtime.');

const scenarios = ['natural', 'comfort', 'pause', 'hide', 'token', 'new-chat', 'manual', 'blush', 'reload']
  .map(name => ({ name, id: randomUUID() }));
const byName = new Map(scenarios.map(row => [row.name, row]));
const fixtureResponses = new Map(), checks = [], samples = [], captures = [], requests = [], errors = [], serverErrors = [];
const untested = ['Unknown/private MMD fallback has no independent authorized PMX fixture in this harness; CPU support rejection is separate evidence.',
  'True physical input, user comfort/crying quality, arbitrary extreme angles, transparent hair and all user models are not signed off.',
  'Only owner visual review can establish visible tears, sliding beads, skin attachment and clearing; uniforms and changed PNG hashes are not that evidence.'];
let instance, controls, pet, identity, after, phase = 'fixtures', report, guardInstalled = false, sequence = 0;
const watched = new WeakSet();
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs); only registered messages are answered.
const claude = await createClaudeFixture({ respond: turn => {
  try {
    const fixture = fixtureResponses.get(turn.currentUser);
    assert.ok(fixture, 'Only registered original synthetic requests can reach the fixture.');
    assert.equal(turn.model, claude.model);
    assert.equal(turn.images.length, 0);
    const nonce = turn.nonce('state'); assert.ok(nonce && /^[a-f0-9]{32}$/.test(nonce), 'Use the real host reply protocol.');
    requests.push({ sequence: fixture.sequence, context: fixture.context, imageParts: 0 });
    return `这是原创隔离泪水验收回复。\n<sh-state-${nonce}>${JSON.stringify({ context: fixture.context, delta: {}, confidence: 0.99, reason: '原创合成验收场景', gesture: 'none' })}</sh-state-${nonce}>`;
  } catch (error) { serverErrors.push(String(error)); throw error; }
} });
function check(name, evidence = {}) { checks.push({ name, kind: 'technical', ...evidence }); console.log(`PASS ${name}`); }
function watch(page) {
  if (watched.has(page)) return; watched.add(page);
  page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push({ type: 'console-error', message: message.text() }); });
}
async function poll(page, predicate, argument, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.evaluate(predicate, argument)) return; await page.waitForTimeout(30); }
  throw new Error(`Timed out in ${phase}`);
}
const mood = () => controls.evaluate(() => window.desktop.getMood());
const frame = () => pet.evaluate(() => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? 'null'));
const zero = value => value && value.amount === 0 && value.phase === 'idle';
async function record(label) { const entry = { label, at: Date.now(), crying: await frame() }; samples.push(entry); return entry; }
async function capture(label) {
  const filename = `${label}.png`, file = path.join(output, filename);
  await pet.locator('#stage').screenshot({ path: file, omitBackground: true });
  captures.push({ file: filename, sha256: await hash(file), kind: 'app-stage-only', visualReview: 'pending', sample: await record(label) });
}
async function inactive(label, delayMs = 450) {
  await poll(pet, () => { const v = JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? 'null'); return v?.amount === 0 && v.phase === 'idle'; });
  await pet.waitForTimeout(delayMs); assert.ok(zero(await frame()), `${label}: old cue must not replay.`); await record(label);
}
async function select(name) {
  phase = `select-${name}`;
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), byName.get(name).id);
  await poll(controls, async id => (await window.desktop.getMood()).characterId === id, byName.get(name).id);
  const view = await mood(); assert.equal(view.snapshot.cryingCandidate, false); assert.ok(view.snapshot.longing >= DEFAULT_MOOD_PARAMETERS.longing.cryAt);
  return view;
}
async function chat(context = 'neutral') {
  const id = `crying-${++sequence}`, text = `原创隔离泪水场景 ${sequence}：我回来与你说话。`;
  fixtureResponses.set(text, { context, sequence });
  await controls.evaluate(({ id, text }) => window.desktop.chat({ id, messages: [{ role: 'user', content: text }], attachments: [] }), { id, text });
  await poll(controls, id => window.__cryingEvents.some(event => event.id === id && ['done', 'error'].includes(event.type)), id);
  const accepted = await controls.evaluate(id => ({ started: window.__cryingAccepted.filter(event => event.id === id), events: window.__cryingEvents.filter(event => event.id === id) }), id);
  assert.equal(accepted.started.length, 1, 'One real host acceptance, no synthetic renderer cry ID.');
  assert.equal(accepted.events.some(event => event.type === 'error'), false);
  return { id, at: Date.now(), accepted };
}
async function begin(name) {
  await select(name); const accepted = await chat();
  await poll(pet, id => { const v = JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? 'null'); return v?.id === id && v.amount > 0.02 && v.surface?.supported && v.surface.compiled > 0; }, accepted.id);
  const view = await mood(); assert.equal(view.snapshot.reunion?.id, accepted.id); assert.equal(view.snapshot.reunion?.crying, true);
  assert.equal(view.snapshot.cryingCandidate, true); assert.equal(view.snapshot.longing, 0);
  assert.equal(view.parameters.longing.cryAt, 85); assert.equal(view.parameters.longing.cryCooldownMs, 86_400_000); assert.equal(view.parameters.longing.cryDurationMs, 8_000);
  samples.push({ label: `${name}-accepted`, acceptedId: accepted.id, token: view.token, reunion: view.snapshot.reunion, crying: await frame() });
  return accepted;
}
async function savePetVisible(visible) {
  await controls.evaluate(async visible => { const settings = await window.desktop.getSettings(); settings.pet.visible = visible; await window.desktop.saveSettings(settings); }, visible);
}

try {
  const settings = structuredClone(DEFAULT_SETTINGS); settings.provider = { ...settings.provider, ...claude.provider };
  settings.voice.enabled = false; settings.voice.volume = 0; settings.pet.followMouse = false; settings.pet.breath = 0; settings.pet.alwaysOnTop = false;
  settings.voiceInput = { ...settings.voiceInput, apiKey: '' }; settings.agent = { workingDirectory: '', model: '', writable: false };
  const now = Date.now();
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings));
  await writeFile(path.join(profile, 'characters.json'), JSON.stringify({ version: 1, activeId: scenarios[0].id,
    cards: scenarios.map(row => ({ id: row.id, name: `Crying fixture ${row.name}`, description: '原创公开 Gene 隔离验收角色。', personality: '均衡。', scenario: '', greeting: '', examples: '', systemPrompt: '',
      mood: { version: 1, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS) } })) }));
  await writeFile(path.join(profile, 'mood-state.json'), JSON.stringify({ version: 1, profiles: scenarios.map(row => {
    const state = createMoodState(now); state.lastInteractionAt = now - 80 * 3_600_000;
    return { characterId: row.id, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), state: serializeMoodState(state) };
  }) }));
  phase = 'launch';
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' });
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], cwd: source, env });
  await claude.install(instance);
  instance.on('window', watch); await instance.firstWindow();
  identity = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath(), pid: process.pid }));
  assert.ok(identity.packaged); assert.ok(samePath(await realpath(identity.profile), await realpath(profile))); assert.ok(samePath(await realpath(identity.appPath), asar));
  // Chat runs through the fake Claude Code process: no host or renderer HTTP is allowed at all.
  await instance.evaluate(({ session }) => {
    globalThis.__cryingDenied = []; globalThis.__cryingPermissions = []; globalThis.__cryingHostDenied = [];
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { globalThis.__cryingPermissions.push(permission); done(false); });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      const denied = /^(?:https?|wss?):/i.test(details.url);
      if (denied) globalThis.__cryingDenied.push(details.url); done({ cancel: denied });
    });
    globalThis.fetch = function (resource) {
      const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      globalThis.__cryingHostDenied.push(url); return Promise.reject(new Error('QA blocked host network'));
    };
  }); guardInstalled = true;
  for (let attempt = 0; attempt < 250 && (!controls || !pet); attempt++) {
    for (const page of instance.windows()) {
      watch(page); if (!page.url().includes('index.html')) continue;
      if (new URL(page.url()).searchParams.has('pet')) pet = page; else controls = page;
    }
    if (!controls || !pet) await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(controls && pet);
  await controls.evaluate(async () => {
    window.__cryingEvents = []; window.__cryingAccepted = [];
    window.desktop.onStream(event => window.__cryingEvents.push(event)); window.desktop.onChatStarted(event => window.__cryingAccepted.push(event));
    await window.desktop.useBundledModel(); await window.desktop.recoverPet(); await window.desktop.setMoodDeveloperMode(true); await window.desktop.setMoodExpressions(true);
  });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').surface?.supported === true);
  assert.equal(await controls.evaluate(() => window.desktop.isBehaviorModelSupported()), true);
  await controls.locator('#frame-portrait').click(); await pet.waitForTimeout(250);
  check('exact packaged/profile/source identity and host content-verified Gene support', { sourceHash: before.sourceHash, asarSha256: before.asarSha256 });

  phase = 'natural-envelope'; await select('natural'); await capture('natural-00-before');
  const natural = await chat();
  await poll(pet, id => { const v = JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}'); return v.id === id && v.amount > 0.02; }, natural.id);
  assert.equal((await mood()).snapshot.reunion?.id, natural.id); await capture('natural-01-rise');
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').elapsedMs >= 1000);
  await capture('natural-02-bead-a'); await pet.waitForTimeout(550); await capture('natural-03-bead-b');
  const moving = captures.slice(-2).map(capture => capture.sample.crying);
  assert.equal(moving[0].id, natural.id); assert.equal(moving[1].id, natural.id); assert.ok(moving[1].elapsedMs > moving[0].elapsedMs);
  assert.ok(moving.every(value => value.surface?.compiled > 0 && value.amount > 0.1));
  const baseCamera = await controls.evaluate(async () => (await window.desktop.getSettings()).camera);
  for (const [name, offset] of [['natural-04-left', -25], ['natural-05-right', 25]]) {
    await controls.evaluate(camera => window.desktop.savePetView({ camera }), { ...baseCamera, yaw: baseCamera.yaw + offset }); await pet.waitForTimeout(180); await capture(name);
  }
  await controls.evaluate(camera => window.desktop.savePetView({ camera }), baseCamera);
  await inactive('natural-ended', 350); await capture('natural-06-end');
  check('one accepted cue has a bounded rise/hold/fade clock and advancing bead sampling', { acceptedId: natural.id, visualReview: 'pending' });
  const repeat = await chat(); assert.equal((await mood()).snapshot.cryingCandidate, false); await inactive('cooldown-no-second-cry');
  check('later ordinary response cannot mint a second cry during the unchanged host cooldown', { acceptedId: repeat.id });

  phase = 'comfort'; const comfort = await begin('comfort'); await pet.waitForTimeout(1000); const followup = await chat('support');
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').comforted === true);
  await capture('comfort-fade'); await inactive('comfort-ended', 300);
  assert.ok(Date.now() - comfort.at < 6_000, 'A subsequent valid response must settle before the normal eight-second deadline.');
  check('a different accepted user response naturally shortens the cry without a second cue', { acceptedId: comfort.id, comfortingId: followup.id });

  phase = 'pause'; const paused = await begin('pause'); await controls.evaluate(() => window.desktop.setMoodExpressions(false)); await inactive('expressions-off', 100);
  await controls.evaluate(() => window.desktop.setMoodExpressions(true)); await inactive('expressions-on-no-replay'); check('expression pause clears and does not replay the consumed cue', { acceptedId: paused.id });

  phase = 'hide'; const hidden = await begin('hide'); await savePetVisible(false); await inactive('hidden-release', 100);
  assert.equal((await frame()).surface, null, 'Hiding releases the owned surface wrapper.');
  await savePetVisible(true); await inactive('shown-no-replay');
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').surface?.supported === true);
  check('hide releases its surface and showing reconstructs support without replay', { acceptedId: hidden.id });

  phase = 'token-switch'; const switched = await begin('token'), oldToken = (await mood()).token;
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), byName.get('natural').id); await inactive('other-character');
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), byName.get('token').id); assert.notEqual((await mood()).token, oldToken); await inactive('token-back-no-replay');
  check('character/token changes cancel and returning cannot replay the same accepted identity', { acceptedId: switched.id });

  phase = 'new-chat'; const reset = await begin('new-chat'), resetToken = (await mood()).token;
  await controls.evaluate(() => window.desktop.newConversation()); assert.notEqual((await mood()).token, resetToken); await inactive('new-conversation-no-replay');
  check('new conversation invalidates the host context and clears the old cry', { acceptedId: reset.id });

  phase = 'manual-expression'; const manual = await begin('manual'); await controls.evaluate(() => window.desktop.installMotionPack('gene', 'happy', 'expression'));
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.moodFeedback ?? '{}').faceBlocked === true);
  await inactive('manual-face-active'); await controls.evaluate(() => window.desktop.clearMotionLayer('expression')); await inactive('manual-face-cleared-no-replay');
  check('manual expression owns the face and clearing it does not replay the cancelled cry', { acceptedId: manual.id });

  phase = 'blush-layering'; await begin('blush');
  const calibration = await controls.evaluate(() => window.desktop.getBlushCalibration()); assert.ok(calibration.modelKey);
  const beforeCalibration = await record('blush-before-calibration');
  await controls.evaluate(({ key, value }) => window.desktop.setBlushCalibration(key, value), { key: calibration.modelKey, value: { ...DEFAULT_BLUSH_CALIBRATION, eyeOffsetX: 0.08 } });
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').surface?.supported === true);
  const afterCalibration = await record('blush-after-calibration'); assert.equal(afterCalibration.crying.id, beforeCalibration.crying.id);
  await navigateControlPage(controls, 'providers', { target: 'blush-calibration' });
  await controls.locator('#blush-calibration-preview').click(); await controls.waitForTimeout(100);
  const previewSurface = await controls.evaluate(() => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').surface);
  assert.ok(previewSurface?.supported && previewSurface.attached); await controls.waitForTimeout(3250);
  const endedSurface = await controls.evaluate(() => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').surface);
  assert.ok(endedSurface?.supported && endedSurface.attached);
  const currentView = await mood(), withoutBlush = structuredClone(currentView.parameters); withoutBlush.blush.enabled = false;
  await controls.evaluate(({ parameters, expected }) => window.desktop.setMoodParameters(parameters, expected), { parameters: withoutBlush, expected: { characterId: currentView.characterId, token: currentView.token } });
  await inactive('blush-disabled-no-old-cry');
  await controls.evaluate(({ key, value }) => window.desktop.setBlushCalibration(key, value), { key: calibration.modelKey, value: DEFAULT_BLUSH_CALIBRATION });
  check('blush calibration/preview rebuild keeps the tears wrapper attached with no shader failure; disabling clears safely', { visualReview: 'pending', structuralOwnership: 'CPU LIFO tests are separate' });

  phase = 'model-reload'; const reloaded = await begin('reload');
  await controls.evaluate(async () => { const settings = await window.desktop.getSettings(); settings.model = null; await window.desktop.saveSettings(settings); });
  await inactive('no-model-released', 100); assert.equal((await frame()).surface, null);
  await controls.evaluate(() => window.desktop.useBundledModel());
  await poll(pet, () => JSON.parse(document.querySelector('#stage canvas')?.dataset.crying ?? '{}').surface?.supported === true);
  await inactive('gene-reloaded-no-replay'); check('model teardown releases the surface and reloading Gene cannot replay an old cue', { acceptedId: reloaded.id });

  phase = 'privacy-and-integrity';
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false); assert.equal(runtime.voiceOwner, null); assert.equal(runtime.cameraOwner, null);
  assert.equal((await controls.evaluate(() => window.desktop.getSystemAudioState())).active, false);
  const privacy = await instance.evaluate(() => ({ denied: globalThis.__cryingDenied, hostDenied: globalThis.__cryingHostDenied, permissions: globalThis.__cryingPermissions }));
  assert.deepEqual(privacy, { denied: [], hostDenied: [], permissions: [] }); assert.deepEqual(serverErrors, []); assert.deepEqual(errors, []);
  claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  check('all media remains off, no permissions requested and only the synthetic Claude Code chat is used');
  report = { status: 'technical-passed-pending-visual-review', identity, before, source, executable, profile, output, checks, samples, captures, requests, errors, serverErrors, privacy, untested,
    visualAcceptance: { status: 'pending-owner-review', required: ['Natural before/rise/two moving-bead frames/end show actual visible tears and complete clearing.', 'Both 25-degree views remain attached and respect the actual face/hair occlusion.', 'Comfort fade visibly settles; no frozen wet marks or stale old surface remains.'] } };
} catch (error) {
  process.exitCode = 1; let diagnostic; try { diagnostic = pet && await frame(); } catch {}
  report = { status: 'failed', phase, error: String(error.stack ?? error), before, identity, source, executable, profile, output, checks, samples, captures, requests, errors, serverErrors, diagnostic, untested };
  console.error(error);
} finally {
  const cleanup = { appClosed: false, fakeClaudeExited: false, syntheticProfileRetained: true };
  try { if (instance) await instance.close(); cleanup.appClosed = true; } catch (error) { errors.push({ type: 'cleanup-app', message: String(error) }); process.exitCode = 1; }
  const fake = await claude.close(); cleanup.fakeClaudeExited = fake.fakeClaudeExited;
  if (!fake.fakeClaudeExited || !fake.claudeHomeEmpty) { errors.push({ type: 'cleanup-fake-claude', ...fake }); process.exitCode = 1; }
  try {
    after = { asarSha256: await hash(asar), executableSha256: await hash(executable), manifestSha256: await hash(manifestFile), harnessSha256: await hash(harnessFile),
      sourceHash: await sourceFingerprint(), stageSha256: await hash(path.join(source, 'src/stage/MmdStage.ts')),
      exactSourceSha256: Object.fromEntries(await Promise.all(exactFiles.map(async name => [name, await hash(path.join(source, name))]))) };
    assert.deepEqual(after, before, 'ASAR, EXE, source, helpers and harness remain immutable throughout QA.');
  } catch (error) { errors.push({ type: 'integrity', message: String(error) }); process.exitCode = 1; }
  if (!report) report = { status: 'failed', phase, before, checks, captures, errors, serverErrors, untested };
  if (process.exitCode && report.status !== 'failed') report.status = 'failed-after-cleanup-or-integrity';
  report.after = after; report.cleanup = cleanup; report.guardInstalled = guardInstalled;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
