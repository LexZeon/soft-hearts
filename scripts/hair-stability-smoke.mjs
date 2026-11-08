// Native lease required. This script checks an already frozen/package-validated
// candidate; it never builds, deploys, reads a normal profile, or starts a service.
// MMD_HAIR_NATIVE_LEASE=1 MMD_TEST_APP_DIR=<frozen source> MMD_TEST_EXE=<same package>
// MMD_HAIR_MODE=gene|private; private requires separately authorized MMD_TEST_MODEL.
// Optional MMD_HAIR_OUTPUT=<ignored .local output directory>.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';

const harnessFile = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(harnessFile), '..');
const mode = process.env.MMD_HAIR_MODE ?? 'gene';
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`;
const outputRoot = path.resolve(process.env.MMD_HAIR_OUTPUT ?? path.join(workspace, '.local/hair-stability-native'));
const output = path.join(outputRoot, runId);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async file => sha(await readFile(file));
const within = (base, target) => { const relative = path.relative(base, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
let ignoredRoot = workspace;
while (path.basename(ignoredRoot) !== '.local' && path.dirname(ignoredRoot) !== ignoredRoot) ignoredRoot = path.dirname(ignoredRoot);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], traces = [], captures = [], fixtures = [], errors = [], privateStrings = [];
const cleanup = { appClosed: false, forcedOwnedProcessStop: false, profileRemoved: false, serversStarted: 0 };
// Engineering limits for the actual current camera/CSS viewport, in DIP per
// display frame. World units differ across models and remain diagnostic only.
// These constants cannot be overridden through the environment, and neither
// they nor a positive world-Y delta sign perceptible sag or naturalness.
const QUIET = Object.freeze({ maxScreenFrameDisplacementDip: 0.25, minimumScreenSamples: 1, seconds: 2 });
const TRANSIENT_MAX_SCREEN_DISPLACEMENT_DIP = 2;
let phase = 'preflight', source, executable, asar, proof, profile, modelPath, app, controls, pet;
let manifestIdentity, identity, assetIdentity, baselineSourceHash, baselineAsarHash, conditions, hostEvidence, failure;
let identityVerified = false, diagnosticContractVerified = false, finalChecksCompleted = false;
let outputReady = false;
const safe = value => privateStrings.sort((a, b) => b.length - a.length).reduce((text, item) => item ? text.split(item).join('<isolated-path>') : text, String(value));
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
async function wait(predicate, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(40); }
  throw new Error(`Timeout: ${label}`);
}
async function fingerprint() {
  const entries = [];
  for (const relative of [...proof.inputs].sort()) {
    assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.split('/').some(part => part === '.' || part === '..'));
    const file = await realpath(path.join(source, relative));
    assert.ok(within(source, file), 'Every frozen input remains inside its candidate source.');
    entries.push([relative, await hash(file)]);
  }
  return sha(JSON.stringify(entries));
}
async function createEvidenceDirectory() {
  assert.equal(path.basename(ignoredRoot), '.local', 'Run this maintainer helper from an ignored local source checkout.');
  assert.ok(within(ignoredRoot, outputRoot) && within(outputRoot, output), 'Evidence stays within this checkout ignored root.');
  assert.ok(samePath(await realpath(ignoredRoot), ignoredRoot), 'Ignored root is not a redirected directory.');
  let current = ignoredRoot;
  for (const component of path.relative(ignoredRoot, output).split(path.sep)) {
    current = path.join(current, component);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current); assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'No evidence-directory symlink or file.');
  }
  outputReady = true;
}
function seed() {
  return { version: 1, model: null, motion: null,
    camera: { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 },
    provider: { kind: 'claude', model: '' }, // Never chats: Claude Code is an inert placeholder here.
    persona: '原创隔离头发稳定性验收。',
    pet: { visible: true, alwaysOnTop: false, clickThrough: false, followMouse: false, breath: 0, fps: 30, scale: 1, size: { width: 480, height: 640 } },
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 },
    voiceInput: { baseUrl: 'http://127.0.0.1:9/v1', model: 'no-transcription', language: 'zh', apiKey: '' },
    agent: { workingDirectory: '', model: '', writable: false } };
}
/** Own fixture bytes: constant head pitch, or slow head pitch followed by a long hold. */
async function writeMotion(name, keys) {
  const encodedHead = Buffer.from([0x93, 0xaa]);
  assert.equal(new TextDecoder('shift-jis').decode(encodedHead), '頭');
  const recordBytes = 15 + 4 + 12 + 16 + 64;
  const bytes = Buffer.alloc(30 + 20 + 4 + keys.length * recordBytes + 5 * 4);
  bytes.write('Vocaloid Motion Data 0002', 0, 'ascii'); bytes.write('soft hearts hair QA', 30, 'ascii');
  let offset = 50; bytes.writeUInt32LE(keys.length, offset); offset += 4;
  const interpolation = Buffer.from([20, 20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107]);
  for (const [frame, pitch] of keys) {
    encodedHead.copy(bytes, offset); offset += 15; bytes.writeUInt32LE(frame, offset); offset += 4;
    offset += 12;
    for (const component of [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]) { bytes.writeFloatLE(component, offset); offset += 4; }
    for (let block = 0; block < 4; block++) { interpolation.copy(bytes, offset); offset += 16; }
  }
  const file = path.join(output, `${name}.vmd`); await writeFile(file, bytes);
  fixtures.push({ filename: path.basename(file), sha256: sha(bytes), headPitchKeys: keys, seconds: keys.at(-1)[0] / 30, source: 'original local generated VMD, no downloaded motion' });
  return file;
}
async function snapshot(window = pet) {
  return window.evaluate(() => {
    const canvas = document.querySelector('#stage canvas'), rect = canvas?.getBoundingClientRect();
    const physics = JSON.parse(canvas?.dataset.modelPhysics ?? 'null');
    const transition = JSON.parse(canvas?.dataset.motionTransition ?? '{}');
    const feedback = JSON.parse(canvas?.dataset.moodFeedback ?? '{}');
    return { physics, poseTime: transition.layerTimes?.pose ?? null,
      directInput: { phase: feedback.phase ?? null, active: feedback.activeContact ?? null, hover: feedback.hover ?? null },
      baseTime: JSON.parse(canvas?.dataset.chatGesture ?? '{}').baseTime ?? null,
      width: rect?.width, height: rect?.height, bufferWidth: canvas?.width, bufferHeight: canvas?.height, displayDpr: devicePixelRatio, now: performance.now() };
  });
}
function finite(snapshotValue, requireHair = true) {
  const physics = snapshotValue.physics;
  assert.ok(physics && !physics.error && physics.status !== 'error', 'No physics runtime error.');
  for (const name of ['steps', 'liveObjects']) assert.ok(Number.isFinite(physics[name]) && physics[name] >= 0, `Finite diagnostic ${name}.`);
  // A default-off stage has not allocated LocalModelPhysics, so only the base
  // contract exists. Once attached, actual ownership counters are mandatory.
  if (requireHair || physics.parts) for (const name of ['createdObjects', 'destroyedObjects', 'cleanupFailures']) assert.ok(Number.isFinite(physics[name]) && physics[name] >= 0, `Finite owned diagnostic ${name}.`);
  assert.equal(physics.cleanupFailures ?? 0, 0);
  if (!requireHair) return;
  const hair = physics.parts?.hair;
  assert.ok(hair, 'Hair display diagnostics exist.');
  for (const name of ['weight', 'maxAngle', 'maxDisplacement', 'frameSerial', 'maxFrameAngle', 'maxFrameDisplacement', 'maxWorldFrameDisplacement', 'maxWorldDownward', 'outputBoneCount']) assert.ok(Number.isFinite(hair[name]) && hair[name] >= 0, `Required all-visible-output diagnostic ${name}.`);
  assert.ok(Number.isInteger(hair.screenSampleCount) && hair.screenSampleCount >= 0 && hair.screenSampleCount <= hair.outputBoneCount, 'Finite bounded projected sample count.');
  assert.ok(hair.maxScreenFrameDisplacementDip === null || (Number.isFinite(hair.maxScreenFrameDisplacementDip) && hair.maxScreenFrameDisplacementDip >= 0), 'Projection is finite nonnegative DIP or explicitly unavailable.');
  if (hair.screenSampleCount > 0) assert.ok(Number.isFinite(hair.maxScreenFrameDisplacementDip), 'A valid projected sample count requires actual DIP measurement.');
  assert.ok(hair.outputBoneCount > 4, 'This model diagnostic covers all visible-influence hair bones, beyond the old first-four samples.');
  assert.ok(hair.weight <= 1 && hair.maxAngle <= 0.7 * hair.weight + 1e-6, 'Weighted local angular safety limit holds.');
  assert.equal(physics.parts.chest.weight, 0, 'Chest stays independent and off.');
}
async function patchPhysics(patch) {
  const before = await snapshot();
  await controls.evaluate(value => window.desktop.setModelPhysicsSettings(value), patch);
  await wait(() => controls.evaluate(async value => {
    const actual = await window.desktop.getModelPhysicsSettings();
    return Object.entries(value).every(([key, wanted]) => typeof wanted === 'object' ? Object.entries(wanted).every(([field, expected]) => actual[key][field] === expected) : actual[key] === wanted);
  }, patch), 'physics settings committed');
  const after = await snapshot();
  if (Number.isFinite(before.poseTime) && Number.isFinite(after.poseTime)) assert.ok(after.poseTime >= before.poseTime - 1e-5, 'Physics change did not restart the current long authored hold.');
}
async function allOff() {
  await patchPhysics({ hair: { enabled: false }, chest: { enabled: false } });
  await wait(async () => (await snapshot()).physics?.liveObjects === 0, 'off fades and releases worlds');
  const value = await snapshot(); finite(value, false);
  assert.equal(value.physics.createdObjects ?? 0, value.physics.destroyedObjects ?? 0);
  assert.equal(value.physics.running, false); return value;
}
async function pick(button, filename) {
  await app.evaluate(({ dialog }, selected) => {
    const qa = globalThis.__hairQA; qa.pick = selected;
    if (!qa.originalPicker) {
      qa.originalPicker = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => { const value = qa.pick; qa.pick = null; return value ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] }; };
    }
  }, filename);
  await controls.locator(button).click();
  await wait(() => app.evaluate(() => globalThis.__hairQA.pick === null), 'one exact local picker choice consumed');
}
async function importMotion(filename) {
  await pick('#import-motion', filename);
  await wait(() => controls.evaluate(async expected => (await window.desktop.getSettings()).motion?.path === expected, filename), 'original VMD selected through real import UI');
  const reference = await controls.evaluate(async () => (await window.desktop.getSettings()).motion);
  const petId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).searchParams.has('pet')).webContents.id);
  assert.ok(typeof reference.url === 'string');
  await wait(() => app.evaluate((_electron, { url, petId }) => globalThis.__hairQA.localRequests.some(item => item.url === url && item.webContentsId === petId), { url: reference.url, petId }), 'pet fetched the newly registered original motion');
  await wait(async () => Number.isFinite((await snapshot()).poseTime), 'actual pose Action clock');
  await pause(600);
}
async function collect(label, milliseconds = 2000) {
  const samples = await pet.evaluate(async milliseconds => {
    const start = performance.now(), result = []; let previous;
    while (performance.now() - start < milliseconds) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const canvas = document.querySelector('#stage canvas'), physics = JSON.parse(canvas?.dataset.modelPhysics ?? 'null');
      const feedback = JSON.parse(canvas?.dataset.moodFeedback ?? '{}');
      const hair = physics?.parts?.hair;
      if (!hair || hair.frameSerial === previous) continue;
      previous = hair.frameSerial;
      result.push({ atMs: performance.now() - start, physics, directInput: { phase: feedback.phase ?? null, active: feedback.activeContact ?? null, hover: feedback.hover ?? null }, poseTime: JSON.parse(canvas?.dataset.motionTransition ?? '{}').layerTimes?.pose ?? null });
    }
    return result;
  }, milliseconds);
  assert.ok(samples.length >= milliseconds / 110, `${label}: enough distinct actual display frames.`);
  for (const sample of samples) finite(sample);
  const hair = samples.map(item => item.physics.parts.hair), intervals = samples.slice(1).map((item, i) => item.atMs - samples[i].atMs);
  const projectedHair = hair.filter(item => item.screenSampleCount > 0 && Number.isFinite(item.maxScreenFrameDisplacementDip));
  const row = { label, elapsedMs: samples.at(-1).atMs, samples, renderedFrames: samples.length,
    frameIntervalMeanMs: intervals.reduce((sum, value) => sum + value, 0) / Math.max(1, intervals.length),
    frameIntervalMaxMs: Math.max(0, ...intervals),
    maxFrameAngle: Math.max(...hair.map(item => item.maxFrameAngle)),
    meanFrameAngle: hair.reduce((sum, item) => sum + item.maxFrameAngle, 0) / hair.length,
    maxFrameDisplacement: Math.max(...hair.map(item => item.maxFrameDisplacement)),
    maxWorldFrameDisplacement: Math.max(...hair.map(item => item.maxWorldFrameDisplacement)),
    maxWorldDownward: Math.max(...hair.map(item => item.maxWorldDownward)),
    maxScreenFrameDisplacementDip: projectedHair.length ? Math.max(...projectedHair.map(item => item.maxScreenFrameDisplacementDip)) : null,
    screenValidFrames: projectedHair.length, unpairedProjectionFrames: hair.length - projectedHair.length,
    minimumScreenSampleCount: Math.min(...hair.map(item => item.screenSampleCount)),
    lastScreenSampleCount: hair.at(-1).screenSampleCount,
    outputBoneCount: hair[0].outputBoneCount };
  traces.push(row); return row;
}
function projectedLimit(row, limitDip, requireEveryFrame = false) {
  row.projectedLimitDip = limitDip; row.requireEveryProjectedFrame = requireEveryFrame;
  assert.ok(row.screenValidFrames > 0 && row.lastScreenSampleCount > 0 && Number.isFinite(row.maxScreenFrameDisplacementDip), `${row.label}: actual camera projection is required; world/local values cannot substitute.`);
  if (requireEveryFrame) {
    assert.equal(row.screenValidFrames, row.renderedFrames, `${row.label}: every quiet frame must have valid in-view projected output samples.`);
    assert.ok(row.minimumScreenSampleCount >= QUIET.minimumScreenSamples);
  }
  assert.ok(row.maxScreenFrameDisplacementDip <= limitDip, `${row.label}: projected display displacement exceeds ${limitDip} DIP/frame.`);
}
function quiet(row) {
  // Includes every visible-influence output bone that has an in-view paired
  // projection. A local angle on a short link does not measure visible jitter.
  row.quietGateApplied = true;
  for (const sample of row.samples) {
    assert.equal(sample.directInput.phase, 'idle', `${row.label}: direct input must not change the held authored pose.`);
    assert.equal(sample.directInput.active, false, `${row.label}: physical pointer contact interfered with the quiet fixture.`);
    assert.equal(sample.directInput.hover, 0, `${row.label}: hover attention interfered with the quiet fixture.`);
  }
  projectedLimit(row, QUIET.maxScreenFrameDisplacementDip, true);
}
async function capture(label) {
  const viewport = await pet.locator('#stage canvas').evaluate(canvas => {
    const box = canvas.getBoundingClientRect();
    return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height),
      reserved: [...document.querySelectorAll('.pet-toolbar,.pet-chat,.pet-size-panel,.pet-window-help,.pet-resize-handle,#pet-tooltip,#pet-edit-help,[data-mood-ui],#toast')].map(node => node.getBoundingClientRect().toJSON()).filter(rect => rect.width > 0 && rect.height > 0) };
  });
  const image = await app.evaluate(async ({ BrowserWindow }, viewport) => {
    const win = BrowserWindow.getAllWindows().find(item => new URL(item.webContents.getURL()).searchParams.has('pet'));
    const image = await win.webContents.capturePage({ x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height });
    const size = image.getSize(), pixels = image.toBitmap(); let modelPixels = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      const pixel = (offset - 3) / 4, x = pixel % size.width * viewport.width / size.width + viewport.x, y = Math.floor(pixel / size.width) * viewport.height / size.height + viewport.y;
      if (pixels[offset] > 16 && !viewport.reserved.some(rect => x >= rect.x && x <= rect.right && y >= rect.y && y <= rect.bottom)) modelPixels++;
    }
    return { png: image.toPNG().toString('base64'), width: size.width, height: size.height, modelPixels };
  }, viewport);
  assert.ok(image.modelPixels > 500, 'Target app-stage capture contains actual model pixels outside UI.');
  const filename = `${label}.png`, bytes = Buffer.from(image.png, 'base64'); await writeFile(path.join(output, filename), bytes);
  captures.push({ filename, sha256: sha(bytes), width: image.width, height: image.height, modelPixels: image.modelPixels, snapshot: await snapshot(), visualReview: 'pending' });
}
async function sequence(label, count = 8) {
  for (let index = 1; index <= count; index++) { await capture(`${label}-${String(index).padStart(2, '0')}`); await pause(120); }
}
async function visible(shown) {
  await controls.evaluate(async shown => { const settings = await window.desktop.getSettings(); await window.desktop.saveSettings({ ...settings, pet: { ...settings.pet, visible: shown } }); }, shown);
  await wait(() => app.evaluate(({ BrowserWindow }, shown) => BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).searchParams.has('pet'))?.isVisible() === shown, shown), 'owned native pet visibility');
}
async function privacy() {
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState()), audio = await controls.evaluate(() => window.desktop.getSystemAudioState());
  const settings = await controls.evaluate(() => window.desktop.getSettings()), mood = await controls.evaluate(() => window.desktop.getMood());
  assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false); assert.equal(audio.active, false);
  assert.equal(settings.voice.enabled, false); assert.equal(settings.voice.volume, 0); assert.equal(settings.provider.kind, 'claude'); assert.equal(settings.provider.model, '');
  assert.equal(settings.pet.breath, 0); assert.equal(settings.pet.followMouse, false); assert.equal(settings.pet.fps, 30); assert.equal(mood.expressions, false);
  assert.deepEqual(settings.camera, conditions.camera, 'Off/on and quality comparisons keep the same camera.');
  for (const window of [controls, pet]) assert.equal(await window.evaluate(() => window.__hairMediaCalls), 0);
  hostEvidence = await app.evaluate(() => { const qa = globalThis.__hairQA; return { blockedHttp: qa.blockedHttp, permissionRequests: qa.permissionRequests, providerCalls: qa.providerCalls, mediaCalls: qa.mediaCalls, wasmRequests: qa.wasmRequests, runtimeScripts: qa.runtimeScripts }; });
  assert.deepEqual(hostEvidence.blockedHttp, []); assert.deepEqual(hostEvidence.permissionRequests, []); assert.equal(hostEvidence.providerCalls, 0); assert.equal(hostEvidence.mediaCalls, 0);
  assert.equal(await hash(asar), baselineAsarHash); assert.equal(await fingerprint(), baselineSourceHash);
}
async function closeOwned() {
  if (!app) return;
  const instance = app; app = null; const child = instance.process(); let timer;
  try { await Promise.race([instance.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned app close timeout.')), 10000); })]); }
  catch (error) {
    errors.push(`natural-close:${safe(error.message)}`);
    if (child.pid && child.exitCode === null) {
      cleanup.forcedOwnedProcessStop = true;
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }
  } finally { clearTimeout(timer); }
  await wait(() => child.exitCode !== null || child.signalCode !== null, 'owned Electron exited', 5000); cleanup.appClosed = true;
}

try {
  assert.equal(process.env.MMD_HAIR_NATIVE_LEASE, '1', 'Obtain the native resource handoff before running this helper.');
  assert.ok(['gene', 'private'].includes(mode)); assert.ok(outputRoot.split(path.sep).includes('.local'), 'Only ignored local evidence output.');
  assert.ok(process.env.MMD_TEST_APP_DIR && process.env.MMD_TEST_EXE, 'Supply one frozen candidate and its matching packaged executable.');
  source = await realpath(process.env.MMD_TEST_APP_DIR); executable = await realpath(process.env.MMD_TEST_EXE);
  assert.ok(!samePath(source, workspace), 'The helper must run outside the immutable frozen source.');
  assert.ok(!within(source, output), 'Evidence must not mutate frozen source.');
  const manifestFile = path.join(path.dirname(source), 'validated.json'); proof = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(proof.version, 1); assert.ok(Array.isArray(proof.inputs) && proof.inputs.length && /^[a-f0-9]{64}$/.test(proof.sourceHash));
  assert.ok(within(path.dirname(source), executable), 'Packaged executable belongs to this candidate.');
  asar = await realpath(path.join(path.dirname(executable), 'resources/app.asar'));
  baselineAsarHash = await hash(asar); baselineSourceHash = await fingerprint();
  assert.equal(baselineAsarHash, proof.asarSha256); assert.equal(baselineSourceHash, proof.sourceHash);
  manifestIdentity = { sourceHash: proof.sourceHash, asarSha256: baselineAsarHash, manifestSha256: await hash(manifestFile), harnessSha256: await hash(harnessFile) };
  const vendor = { wasm: [], script: [] };
  for (const name of await readdir(path.join(source, 'dist/assets'))) {
    if (!/\.(js|wasm)$/.test(name)) continue;
    const digest = await hash(path.join(source, 'dist/assets', name));
    if (digest === '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93') vendor.wasm.push(name);
    if (digest === '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228') vendor.script.push(name);
  }
  assert.equal(vendor.wasm.length, 1); assert.equal(vendor.script.length, 1);
  const wasmUrl = pathToFileURL(path.join(asar, 'dist/assets', vendor.wasm[0])).href, scriptUrl = pathToFileURL(path.join(asar, 'dist/assets', vendor.script[0])).href;
  assetIdentity = { wasmFilename: vendor.wasm[0], scriptFilename: vendor.script[0], wasmSha256: '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93', scriptSha256: '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228' };
  if (mode === 'private') { assert.ok(process.env.MMD_TEST_MODEL, 'Private model must be separately authorized.'); modelPath = await realpath(process.env.MMD_TEST_MODEL); assert.ok(/\.(pmx|pmd)$/i.test(modelPath)); }
  await createEvidenceDirectory();
  profile = await mkdtemp(path.join(await realpath(tmpdir()), 'soft-hair-stability-'));
  privateStrings.push(source, executable, asar, profile, workspace, modelPath ?? '', modelPath ? path.dirname(modelPath) : '');
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(seed()));
  const upright = await writeMotion('original-upright-hold', [[0, 0], [7200, 0]]);
  const tilt = await writeMotion('original-20deg-hold', [[0, Math.PI / 9], [7200, Math.PI / 9]]);
  const slow = await writeMotion('original-slow-head-then-hold', [[0, 0], [60, 0.25], [120, -0.25], [180, 0], [7200, 0]]);
  phase = 'launch';
  // Claude Code: inert placeholder + empty config folder; Codex: a missing path.
  const env = (await createClaudeIsolation()).environment(Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^MMD_|^VITE_DEV_SERVER_URL$|^ELECTRON_RUN_AS_NODE$/.test(name))));
  app = await electron.launch({ executablePath: executable, cwd: source, args: [`--user-data-dir=${profile}`, `--soft-hearts-build=${proof.sourceHash}`], env, timeout: 30000 });
  await app.firstWindow();
  identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath(), pid: process.pid, build: app.commandLine.getSwitchValue('soft-hearts-build') }));
  assert.equal(identity.packaged, true); assert.ok(samePath(await realpath(identity.profile), profile)); assert.ok(samePath(await realpath(identity.appPath), asar)); assert.equal(identity.build, proof.sourceHash); identityVerified = true;
  await app.evaluate(({ session, desktopCapturer }, { wasmUrl, scriptUrl }) => {
    const qa = globalThis.__hairQA = { blockedHttp: [], permissionRequests: [], providerCalls: 0, mediaCalls: 0, wasmRequests: [], runtimeScripts: [], localRequests: [], originalPicker: null, pick: null };
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { qa.permissionRequests.push(permission); done(false); });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      if (/^(?:https?|wss?):/i.test(details.url)) { qa.blockedHttp.push(new URL(details.url).origin); done({ cancel: true }); return; }
      if (qa.localRequests.length < 512) qa.localRequests.push({ url: details.url, webContentsId: details.webContentsId });
      if (details.url === scriptUrl) qa.runtimeScripts.push({ webContentsId: details.webContentsId });
      if (details.url === wasmUrl) qa.wasmRequests.push({ webContentsId: details.webContentsId });
      else if (/\.wasm(?:[?#]|$)/i.test(details.url)) { done({ cancel: true }); return; }
      done({ cancel: false });
    });
    globalThis.fetch = async () => { qa.providerCalls++; throw new Error('No HTTP in isolated hair QA.'); };
    desktopCapturer.getSources = async () => { qa.mediaCalls++; throw new Error('No desktop capture in isolated hair QA.'); };
    for (const name of ['http', 'https']) for (const method of ['request', 'get']) process.getBuiltinModule(name)[method] = () => { qa.providerCalls++; throw new Error('No HTTP in isolated hair QA.'); };
  }, { wasmUrl, scriptUrl });
  await wait(() => {
    controls = app.windows().find(win => win.url().includes('index.html') && !new URL(win.url()).searchParams.has('pet'));
    pet = app.windows().find(win => win.url().includes('index.html') && new URL(win.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'both isolated windows');
  for (const window of [controls, pet]) {
    window.on('pageerror', error => errors.push(safe(error.message)));
    await window.waitForFunction(() => !!window.desktop && !!document.querySelector('#stage canvas'));
    await window.evaluate(() => {
      window.__hairMediaCalls = 0;
      if (navigator.mediaDevices) for (const name of ['getUserMedia', 'getDisplayMedia']) Object.defineProperty(navigator.mediaDevices, name, { configurable: true, value: async () => { window.__hairMediaCalls++; throw new Error('No media in isolated hair QA.'); } });
    });
  }
  const tab = await controls.locator('#model-physics-controls').evaluate(node => node.closest('.tab-panel')?.id.replace(/^tab-/, ''));
  assert.ok(tab); await navigateControlPage(controls, tab);
  await controls.locator('#use-bundled-model').click();
  await wait(async () => (await snapshot()).physics?.support?.hair.supported, 'Gene support ready', 45000);
  if (mode === 'private') {
    await pick('#import-model', modelPath);
    await wait(() => controls.evaluate(async expected => (await window.desktop.getSettings()).model?.path === expected, modelPath), 'authorized model persisted');
    // This is the already authorized hair+chest fixture, distinct from Gene.
    // Requiring its known structural signature avoids accepting stale Gene
    // diagnostics while the asynchronous private model load is still pending.
    await wait(async () => {
      const support = (await snapshot()).physics?.support;
      return support?.hair.supported && support?.chest.supported;
    }, 'authorized model structural signature ready', 45000);
  }
  await controls.evaluate(() => window.desktop.setMoodExpressions(false));
  await wait(() => pet.evaluate(async () => !(await window.desktop.getMood()).expressions), 'automatic mood presentation disabled in temporary profile');
  await controls.locator('#frame-full').click(); await pause(650);
  const initial = await snapshot(); finite(initial, false);
  assert.ok(initial.width > 0 && initial.height > 0 && initial.bufferWidth / initial.width <= 1.51 && initial.bufferHeight / initial.height <= 1.51);
  assert.deepEqual(initial.physics.enabled, { hair: false, chest: false }); assert.equal(initial.physics.liveObjects, 0);
  assert.equal((await snapshot(controls)).physics.previewOnly, true);
  conditions = await controls.evaluate(async () => { const settings = await window.desktop.getSettings(); return { camera: settings.camera, fps: settings.pet.fps, breath: settings.pet.breath, followMouse: settings.pet.followMouse, scale: settings.pet.scale }; });
  await pet.mouse.move(1, 1);
  conditions.views = [{ name: 'full', camera: structuredClone(conditions.camera), projectedQuietGateApplied: true }];
  check('fixed 30FPS/bounded DPR/camera, explicit hair support and isolated default-off profile');

  for (const [label, motion] of [['upright', upright], ['20deg-tilt', tilt]]) {
    phase = `${label}-off-reference`;
    await allOff(); await importMotion(motion); await sequence(`${label}-off`, 4);
    phase = `${label}-on-static-settle`;
    await patchPhysics({ hair: { enabled: true, strength: 0.65 }, chest: { enabled: false }, quality: 'standard' });
    await wait(async () => (await snapshot()).physics?.parts?.hair?.weight >= 0.649, 'hair fully faded in');
    finite(await snapshot()); diagnosticContractVerified = true;
    await pause(8000);
    const row = await collect(`${label}-quiet`, QUIET.seconds * 1000); quiet(row);
    await sequence(`${label}-on-quiet`);
    check(`${label}: valid projected visible-influence hair outputs meet held-pose DIP stability limits after settling`);
  }

  // A closer fixed view supplies visible hair comparison evidence without
  // silently applying the full-view engineering limit to a different scale.
  // Its complete projected/world/local measurements remain in the report.
  phase = 'portrait-20deg-visual-only';
  await allOff();
  await controls.locator('#frame-portrait').click(); await pause(650);
  const portraitCamera = await controls.evaluate(async () => (await window.desktop.getSettings()).camera);
  conditions.views.push({ name: 'portrait-20deg', camera: portraitCamera, projectedQuietGateApplied: false, purpose: 'separate pending visual comparison; a number does not sign naturalness' });
  await sequence('portrait-20deg-off', 4);
  await patchPhysics({ hair: { enabled: true, strength: 0.65 }, quality: 'standard' });
  await wait(async () => (await snapshot()).physics?.parts?.hair?.weight >= 0.649, 'portrait hair fully faded in');
  await pause(8000);
  const portrait = await collect('portrait-20deg-diagnostic-only', 2000); portrait.quietGateApplied = false;
  await sequence('portrait-20deg-on-quiet');
  await allOff();
  // Drive the actual form so its local settings and subsequent import/visibility
  // saves agree with the host. A same-window raw IPC save excludes that sender
  // from sync and leaves an old portrait form ready to overwrite the host.
  await controls.locator('#frame-full').click();
  await wait(() => controls.evaluate(async expected => JSON.stringify((await window.desktop.getSettings()).camera) === JSON.stringify(expected), conditions.camera), 'exact full camera restored after portrait scope');
  await pause(600);
  check('separate fixed portrait off/on comparison recorded and exact full camera restored; visual approval remains pending');

  phase = 'slow-motion-and-stop';
  await allOff(); await importMotion(slow);
  await patchPhysics({ hair: { enabled: true, strength: 0.65 }, quality: 'standard' });
  await collect('slow-head-motion', 5000); await sequence('slow-motion-stop', 4); await pause(8000);
  const stopped = await collect('motion-stopped-quiet', 2000); quiet(stopped); await sequence('stopped-quiet');
  check('slow authored head movement stops into a stable held pose without changing the original Action');

  for (const quality of ['low', 'high', 'standard']) {
    phase = `quality-${quality}`;
    await patchPhysics({ quality });
    const transition = await collect(`${quality}-switch-transient`, 1000);
    assert.equal(transition.samples.at(-1).physics.quality, quality);
    projectedLimit(transition, TRANSIENT_MAX_SCREEN_DISPLACEMENT_DIP);
    await pause(4000); const row = await collect(`${quality}-held-quiet`, 2000); quiet(row);
    await capture(`${quality}-held`);
    if (quality === 'low') {
      for (let window = 1; window <= 4; window++) {
        await pause(1000); quiet(await collect(`low-long-held-${window}`, 2000));
      }
      await capture('low-long-held');
    }
  }
  check('all quality switches retain strength, bounded transition and subsequent static stability');

  phase = 'visible-renderer-stall';
  const stall = await pet.evaluate(async () => {
    const read = () => { const canvas = document.querySelector('#stage canvas'); return { physics: JSON.parse(canvas.dataset.modelPhysics), poseTime: JSON.parse(canvas.dataset.motionTransition).layerTimes.pose }; };
    const before = read(), start = performance.now(); while (performance.now() - start < 600) { /* owned renderer stall fixture */ }
    const blockedMs = performance.now() - start, resumeStart = performance.now();
    let firstAfter, callbacks = 0;
    do {
      await new Promise(resolve => requestAnimationFrame(resolve)); callbacks++; firstAfter = read();
    } while (firstAfter.physics.parts.hair.frameSerial <= before.physics.parts.hair.frameSerial && performance.now() - resumeStart < 250);
    return { before, firstAfter, blockedMs, callbacks, firstDisplayWaitMs: performance.now() - resumeStart };
  });
  traces.push({ label: 'visible-stall-first-frame', ...stall });
  finite(stall.before); finite(stall.firstAfter); assert.ok(stall.blockedMs >= 590);
  assert.ok(stall.firstAfter.physics.parts.hair.frameSerial > stall.before.physics.parts.hair.frameSerial);
  assert.ok(stall.firstAfter.poseTime - stall.before.poseTime <= 0.2, 'Visible stall does not advance the authored clip by the full gap.');
  assert.ok(stall.firstAfter.physics.steps - stall.before.physics.steps <= 16, 'Stall has bounded solve work, no backlog catch-up.');
  assert.ok(stall.firstAfter.physics.parts.hair.screenSampleCount > 0 && Number.isFinite(stall.firstAfter.physics.parts.hair.maxScreenFrameDisplacementDip), 'First post-stall display has actual paired in-view projections.');
  assert.ok(stall.firstAfter.physics.parts.hair.maxScreenFrameDisplacementDip <= TRANSIENT_MAX_SCREEN_DISPLACEMENT_DIP, 'First post-stall display avoids a large projected discontinuity.');
  const resumed = await collect('post-stall-recovery', 1500); projectedLimit(resumed, TRANSIENT_MAX_SCREEN_DISPLACEMENT_DIP); await sequence('post-stall', 4);
  await pause(6000); quiet(await collect('post-stall-quiet', 2000));
  check('real 600ms owned-renderer stall is bounded, does not catch up, and settles stably');

  phase = 'hide-resume';
  await visible(false); const hidden = await snapshot(); finite(hidden);
  assert.equal(hidden.physics.liveObjects, 0); const hiddenSerial = hidden.physics.parts.hair.frameSerial;
  await pause(700); const stillHidden = await snapshot();
  assert.equal(stillHidden.physics.steps, hidden.physics.steps); assert.equal(stillHidden.physics.parts.hair.frameSerial, hiddenSerial);
  await visible(true);
  const show = await collect('resume-transient', 1500); projectedLimit(show, TRANSIENT_MAX_SCREEN_DISPLACEMENT_DIP);
  await wait(async () => (await snapshot()).physics.parts.hair.weight >= 0.649, 'visible hair resumes');
  await pause(6000); quiet(await collect('resumed-held-quiet', 2000)); await sequence('resumed-quiet', 4);
  check('hide immediately releases and freezes physics; resume has bounded display recovery and quiet hold');

  phase = 'final-identity-privacy-release';
  await allOff(); await privacy(); assert.deepEqual(errors, []);
  const controlId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('pet')).webContents.id);
  assert.ok(hostEvidence.wasmRequests.length > 0 && hostEvidence.wasmRequests.every(item => item.webContentsId !== controlId));
  assert.ok(hostEvidence.runtimeScripts.length > 0 && hostEvidence.runtimeScripts.every(item => item.webContentsId !== controlId));
  finalChecksCompleted = true; check('owned objects released, no HTTP/provider/media/permissions and frozen identity unchanged');
} catch (error) {
  failure = safe(error?.stack ?? error);
  if (pet) await capture('failure-stage').catch(() => {});
} finally {
  if (identityVerified && app && controls && pet) {
    await allOff().catch(error => errors.push(`off-cleanup:${safe(error.message)}`));
    if (conditions) await privacy().catch(error => errors.push(`final-privacy:${safe(error.message)}`));
  }
  try { await closeOwned(); } catch (error) { errors.push(`app-cleanup:${safe(error.message)}`); }
  if (profile && cleanup.appClosed) {
    try {
      const temporaryRoot = await realpath(tmpdir()), physical = await realpath(profile);
      assert.ok(within(temporaryRoot, physical) && path.basename(physical).startsWith('soft-hair-stability-'));
      await rm(physical, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); cleanup.profileRemoved = true;
    } catch (error) { errors.push(`profile-cleanup:${safe(error.message)}`); }
  }
  const technicalChecksPassed = !failure && errors.length === 0 && finalChecksCompleted && diagnosticContractVerified && cleanup.appClosed && !cleanup.forcedOwnedProcessStop && cleanup.profileRemoved;
  const report = { status: technicalChecksPassed ? 'REVIEW_PENDING' : 'FAILED', scope: 'hair-static-gravity-and-stability', technicalChecksPassed, mode, runId, phase,
    identity: identity ? { packaged: identity.packaged, pid: identity.pid, build: identity.build, explicitTemporaryProfileVerified: identityVerified, packagedAsarVerified: identityVerified } : null,
    manifest: manifestIdentity, localAssets: assetIdentity, conditions, fixtures, checks, traces, captures, quietLimits: QUIET, transientMaxScreenFrameDisplacementDip: TRANSIENT_MAX_SCREEN_DISPLACEMENT_DIP,
    metricRevision: { priorAbsoluteWorldGateRemoved: true, reason: 'Model/world unit scales differ. The engineering gate now uses actual camera/viewport projection in DIP; this is a metric correction, not a claim that prior scene-unit values prove naturalness.', environmentOverrideAllowed: false },
    downwardEvidence: { status: 'pending-owner-visible-sag-review', samples: traces.filter(row => typeof row.maxWorldDownward === 'number').map(row => ({ label: row.label, maxWorldDownward: row.maxWorldDownward, positive: row.maxWorldDownward > 0 })), noAbsoluteWorldAmplitudeGate: true },
    diagnosticMeaning: { frameSerial: 'visible nonzero physics display frame, no progress on getDiagnostics or frame(0)', angularAndDisplacement: 'all visible-influence output bones, excluding simulation-only auxiliary bones; relative local physics output between display frames; finite diagnostic values only, not visible-jitter gates', maxWorldFrameDisplacement: 'maximum adjacent nonzero-display-frame world displacement of visible-influence hair bone origins; includes authored base movement and model scale, reported without a cross-model hard limit', maxScreenFrameDisplacementDip: 'paired previous/current world bone origins projected with the actual current camera and CSS viewport; only valid depth/in-view pairs count; DIP per display frame includes authored movement, so the quiet gate applies only to held full-view poses with automatic motion disabled', screenSampleCount: 'count of actual valid in-view paired output-bone projections; every gated quiet frame requires at least one, initial unpaired transient frames are reported explicitly', maxWorldDownward: 'max(base authored world Y - applied physics world Y, 0) among visible-influence hair bone origins in actual scene/world units; finite numeric evidence only, not skinned centroid, perceptibility or a visual judgment' },
    hostEvidence, cleanup, failure, errors,
    limits: { humanVisualReview: 'pending; owner must inspect off/on, held tilt, motion stop and recovery sequences before signing perceptible downward response or absence of twitching', subjectiveNaturalnessApproved: false, physicalInputTested: false, normalProfileRead: false, desktopScreenshot: false, mediaCapture: false, realProviderCalls: false, noHardwareIndependentPerformanceGuarantee: true, initialization: 'automatic services disabled in isolated seed; request/permission/media guards installed immediately after owned launch', captures: 'discrete app-stage samples, not continuous video; actual capture times are in each snapshot' } };
  // Preflight may fail before output creation. This remains an ignored evidence
  // path and never touches the candidate or any normal user profile.
  if (outputReady) {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(outputRoot, `latest-${mode}.json`), JSON.stringify({ runId, report: `${runId}/report.json`, status: report.status }, null, 2));
  }
  console.log(JSON.stringify({ status: report.status, mode, runId, checks: checks.length, captures: captures.length, cleanup }));
  if (!technicalChecksPassed) process.exitCode = 1;
}
