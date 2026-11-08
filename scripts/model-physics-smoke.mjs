// Run only after the owner hands back the native slot. This script never builds.
// Required: MMD_TEST_APP_DIR=<frozen source>, MMD_TEST_EXE=<matching package>.
// MMD_PHYSICS_MODE=gene|private (private also requires explicitly authorized MMD_TEST_MODEL).
// MMD_PHYSICS_VISUAL_ONLY=1 is private-only chest contrast evidence, not the full matrix.
// Optional MMD_PHYSICS_OUTPUT=<ignored .local/physics-native directory>.
import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const harnessFile = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(harnessFile), '..');
const mode = process.env.MMD_PHYSICS_MODE ?? 'gene';
assert.ok(['gene', 'private'].includes(mode), 'MMD_PHYSICS_MODE must be gene or private.');
const visualOnly = process.env.MMD_PHYSICS_VISUAL_ONLY === '1';
assert.ok(!visualOnly || mode === 'private', 'Visual-only contrast requires MMD_PHYSICS_MODE=private.');
const outputRoot = path.resolve(process.env.MMD_PHYSICS_OUTPUT ?? path.join(workspace, '.local/physics-native'));
assert.ok(outputRoot.split(path.sep).includes('.local'), 'Keep native evidence inside an ignored .local directory.');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${visualOnly ? 'visual-' : ''}${mode}`;
const output = path.join(outputRoot, runId);
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async file => sha(await readFile(file));
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const checks = [], captures = [], rows = [], qualityRuns = [], errors = [], capacitySamples = [];
let contactEvidence = null;
let visualEvidence = null;
const cleanup = { appClosed: false, forcedOwnedProcessStop: false, profileRemoved: false, serversStarted: 0 };
let source, executable, asar, profile, modelPath, app, controls, pet, proof, identity, failure;
let phase = 'preflight', baselineSourceHash, baselineAsarHash, hostEvidence, identityVerified = false, finalChecksCompleted = false;
const privateStrings = [];
const safe = value => {
  let text = String(value);
  for (const privateValue of [...privateStrings].sort((a, b) => b.length - a.length)) {
    if (privateValue) text = text.split(privateValue).join('<isolated-path>');
  }
  return text;
};
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await pause(45);
  }
  throw new Error(`Timeout: ${label}`);
}
async function sourceFingerprint() {
  const hashes = [];
  for (const relative of [...proof.inputs].sort()) {
    assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) &&
      !relative.includes('\\') && !relative.split('/').some(part => part === '.' || part === '..'), 'Safe frozen manifest input.');
    const target = await realpath(path.join(source, relative));
    assert.ok(within(source, target), 'Every manifest source is inside the frozen source.');
    hashes.push([relative, await hash(target)]);
  }
  return sha(JSON.stringify(hashes));
}
function settingsSeed() {
  return {
    version: 1, model: null, motion: null,
    camera: { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 },
    provider: { kind: 'claude', model: '' }, // Never chats: Claude Code is an inert placeholder here.
    persona: '原创隔离物理验收。',
    pet: { visible: true, alwaysOnTop: false, clickThrough: false, followMouse: false,
      fps: 30, breath: 0, scale: 1, size: { width: 480, height: 640 } },
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 },
    voiceInput: { baseUrl: 'http://127.0.0.1:9/v1', model: 'no-transcription', language: 'zh', apiKey: '' },
    agent: { workingDirectory: '', model: '', writable: false },
  };
}

/** Original local VMD: head plus upper-body anchors, four-second periodic motion. */
async function writeDriveMotion(filename) {
  const bones = [
    { name: Buffer.from([0x93, 0xaa]), decoded: '頭', axis: 1, amplitude: 0.25 },
    { name: Buffer.from([0x8f, 0xe3, 0x94, 0xbc, 0x90, 0x67]), decoded: '上半身', axis: 0, amplitude: 0.10 },
    { name: Buffer.from([0x8f, 0xe3, 0x94, 0xbc, 0x90, 0x67, 0x32]), decoded: '上半身2', axis: 2, amplitude: 0.14 },
  ];
  const decoder = new TextDecoder('shift-jis');
  for (const bone of bones) assert.equal(decoder.decode(bone.name), bone.decoded);
  const frames = Array.from({ length: 25 }, (_, index) => index * 5);
  const frameBytes = 15 + 4 + 12 + 16 + 64;
  const data = Buffer.alloc(30 + 20 + 4 + bones.length * frames.length * frameBytes + 5 * 4);
  data.write('Vocaloid Motion Data 0002', 0, 'ascii');
  data.write('soft hearts QA', 30, 'ascii');
  let offset = 50;
  data.writeUInt32LE(bones.length * frames.length, offset); offset += 4;
  const interpolation = Buffer.from([20, 20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107]);
  for (const bone of bones) for (const frame of frames) {
    bone.name.copy(data, offset); offset += 15;
    data.writeUInt32LE(frame, offset); offset += 4;
    offset += 12; // Original motion has no translations.
    const angle = Math.sin(frame / 120 * Math.PI * 2) * bone.amplitude;
    const quaternion = [0, 0, 0, Math.cos(angle / 2)];
    quaternion[bone.axis] = Math.sin(angle / 2);
    for (const component of quaternion) { data.writeFloatLE(component, offset); offset += 4; }
    for (let block = 0; block < 4; block++) { interpolation.copy(data, offset); offset += 16; }
  }
  await writeFile(filename, data);
  return { sha256: sha(data), seconds: 4, frames: bones.length * frames.length,
    decodedBones: bones.map(bone => bone.decoded), source: 'original generated fixture; no downloaded motion' };
}

async function snapshot(window = pet) {
  return window.evaluate(() => {
    const canvas = document.querySelector('#stage canvas');
    const physics = JSON.parse(canvas?.dataset.modelPhysics ?? 'null');
    const gesture = JSON.parse(canvas?.dataset.chatGesture ?? '{}');
    const transition = JSON.parse(canvas?.dataset.motionTransition ?? '{}');
    const feedback = JSON.parse(canvas?.dataset.moodFeedback ?? '{}');
    const hand = document.querySelector('[data-pet-interaction-cursor]');
    const rect = canvas?.getBoundingClientRect();
    return { physics, baseTime: gesture.baseTime ?? null, layerTimes: transition.layerTimes ?? null,
      width: rect?.width, height: rect?.height, bufferWidth: canvas?.width, bufferHeight: canvas?.height,
      contact: { phase: feedback.phase, localPhase: document.querySelector('#mood-local-feedback')?.dataset.phase,
        active: feedback.activeContact, weight: feedback.contact, head: feedback.head,
        automaticHeadBlocked: feedback.headBlocked, handVisible: !!hand && !hand.hidden },
      displayDpr: devicePixelRatio, now: performance.now() };
  });
}
function finiteState(state) {
  assert.ok(state && !state.error && state.status !== 'error', 'No local physics runtime error.');
  for (const field of ['liveObjects', 'steps', 'bodyCount', 'constraintCount', 'avgStepMs'])
    assert.ok(Number.isFinite(state[field]) && state[field] >= 0, `Finite ${field}.`);
  for (const [name, part] of Object.entries(state.parts ?? {})) {
    for (const field of ['weight', 'maxAngle', 'maxDisplacement', 'stepMs', 'solverIterations'])
      assert.ok(Number.isFinite(part[field]) && part[field] >= 0, `Finite part ${field}.`);
    assert.ok(part.weight <= 1 && part.maxAngle <= (name === 'hair' ? 0.7 : 0.3) * part.weight + 1e-6, 'Each part respects its weighted angular limit.');
    for (const sample of part.samples ?? [])
      assert.ok([...sample.localQuatDelta, ...sample.positionDelta].every(Number.isFinite));
  }
}
function balanced(state, label, requireCounters = false) {
  if (requireCounters) for (const field of ['createdObjects', 'destroyedObjects', 'cleanupFailures'])
    assert.ok(Number.isFinite(state[field]), `${label}: actual owned ${field} must be present.`);
  assert.equal(state.liveObjects, 0, `${label}: no live owned objects.`);
  assert.equal(state.createdObjects ?? 0, state.destroyedObjects ?? 0, `${label}: created equals destroyed.`);
  assert.equal(state.cleanupFailures ?? 0, 0, `${label}: no cleanup failures.`);
}
function recordCapacity(label, state) {
  if (state.heapCapacityBytes === null || state.heapCapacityBytes === undefined) return;
  assert.ok(Number.isFinite(state.heapCapacityBytes) && state.heapCapacityBytes > 0);
  capacitySamples.push({ label, bytes: state.heapCapacityBytes });
}
async function physicsPatch(patch) {
  const before = (await snapshot()).baseTime;
  await controls.evaluate(value => window.desktop.setModelPhysicsSettings(value), patch);
  await wait(async () => controls.evaluate(async value => {
    const current = await window.desktop.getModelPhysicsSettings();
    return Object.entries(value).every(([key, wanted]) => typeof wanted === 'object'
      ? Object.entries(wanted).every(([field, setting]) => current[key][field] === setting)
      : current[key] === wanted);
  }, patch), 'sidecar readback');
  // Ordinary physics setting changes must not replace or rewind the Action.
  await pause(100);
  const after = (await snapshot()).baseTime;
  if (Number.isFinite(before) && Number.isFinite(after)) assert.ok(after >= before - 1e-6, 'Physics settings preserve the current Action clock.');
}
async function allOff() {
  await physicsPatch({ hair: { enabled: false }, chest: { enabled: false } });
  await wait(async () => (await snapshot()).physics?.liveObjects === 0, 'fade-out releases all worlds');
  const state = (await snapshot()).physics; finiteState(state); balanced(state, 'off');
  assert.equal(state.running, false);
  for (const part of Object.values(state.parts ?? {})) assert.equal(part.weight, 0);
  return state;
}
async function petVisible(visible) {
  await controls.evaluate(async shown => {
    const settings = await window.desktop.getSettings();
    await window.desktop.saveSettings({ ...settings, pet: { ...settings.pet, visible: shown } });
  }, visible);
  await wait(() => app.evaluate(({ BrowserWindow }, shown) => {
    const window = BrowserWindow.getAllWindows().find(win => {
      const url = win.webContents.getURL(); return url.includes('index.html') && new URL(url).searchParams.has('pet');
    });
    return !!window && window.isVisible() === shown;
  }, visible), 'native pet visibility');
}
async function pick(button, filename) {
  // Only this newly launched app's native picker changes, with an exact one-use choice.
  await app.evaluate(({ dialog }, selected) => {
    globalThis.__physicsQA.pick = selected;
    if (globalThis.__physicsQA.originalPicker) return;
    globalThis.__physicsQA.originalPicker = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      const filename = globalThis.__physicsQA.pick;
      globalThis.__physicsQA.pick = null;
      return filename ? { canceled: false, filePaths: [filename] } : { canceled: true, filePaths: [] };
    };
  }, filename);
  await controls.locator(button).click();
  await wait(() => app.evaluate(() => globalThis.__physicsQA.pick === null), 'real UI consumed one native picker selection');
}
async function importDrive(filename) {
  await pick('#import-motion', filename);
  await wait(async () => controls.evaluate(async expected => (await window.desktop.getSettings()).motion?.path === expected, filename), 'original VMD persisted through actual import UI');
  await wait(async () => Number.isFinite((await snapshot()).baseTime), 'VMD Action clock exists');
  await pause(500);
}

/** Read the current model's rendered scalp projection; never write its bones or contact state. */
async function scalpPoint(u) {
  return pet.evaluate(u => {
    const canvas = document.querySelector('#stage canvas');
    const region = JSON.parse(canvas?.dataset.interactionRegion ?? 'null');
    const fields = ['x', 'y', 'axisXX', 'axisXY', 'axisYX', 'axisYY'];
    if (!region || !fields.every(key => Number.isFinite(region[key]))) throw new Error('A real rendered scalp projection is required.');
    const rect = canvas.getBoundingClientRect();
    const reserved = [...document.querySelectorAll('.pet-toolbar,.pet-chat,.pet-size-panel,.pet-window-help,.pet-resize-handle,[data-mood-ui],#pet-edit-help,#pet-tooltip,#toast')]
      .map(element => element.getBoundingClientRect()).filter(value => value.width > 0 && value.height > 0);
    const point = (x, y) => ({ x: rect.left + region.x + region.axisXX * x + region.axisYX * y,
      y: rect.top + region.y + region.axisXY * x + region.axisYY * y });
    const usable = point => point.x > rect.left + 2 && point.y > rect.top + 2 &&
      point.x < Math.min(innerWidth, rect.right) - 2 && point.y < Math.min(innerHeight, rect.bottom) - 2 &&
      reserved.every(r => point.x < r.left || point.x >= r.right || point.y < r.top || point.y >= r.bottom);
    const v = [-0.3, 0, 0.2].find(v => [-0.3, 0, 0.3].every(u => usable(point(u, v))));
    if (v === undefined) throw new Error('The current model needs a visible scalp stroke outside UI reservations.');
    return point(u, v);
  }, u);
}

function assertPosePhase(previous, current, duration) {
  assert.ok(Number.isFinite(previous.baseTime) && Number.isFinite(current.baseTime) && current.baseTime >= previous.baseTime,
    'Direct contact preserves the forward mixer clock.');
  const oldPose = previous.layerTimes?.pose, newPose = current.layerTimes?.pose;
  assert.ok(Number.isFinite(oldPose) && Number.isFinite(newPose), 'The running authored pose Action exposes its actual phase.');
  const wrap = value => ((value % duration) + duration) % duration;
  const expected = wrap(oldPose + current.baseTime - previous.baseTime);
  const phaseError = Math.abs(wrap(newPose - expected + duration / 2) - duration / 2);
  assert.ok(phaseError <= 2 / 30 + 1e-6, 'Contact preserves the authored Action phase through normal four-second loop wrap.');
}

async function directContact(activeParts, driveFilename, driveDuration) {
  phase = 'direct-scalp-contact-with-physics';
  await controls.evaluate(() => window.desktop.setMoodExpressions(true));
  await pet.bringToFront();
  await pet.mouse.move(2, 2);
  await wait(async () => {
    const state = await snapshot();
    return state.contact.active === false && state.contact.weight < 0.01 && state.contact.automaticHeadBlocked === true;
  }, 'original head VMD keeps automatic head poses blocked before direct contact');
  const before = await snapshot(); finiteState(before.physics);
  assert.ok(Number.isFinite(before.baseTime) && before.physics.running);
  const samples = [];
  contactEvidence = { status: 'in-progress', input: 'controlled Playwright pointer over the current rendered scalp; no direct contact IPC or stage writes',
    authoredHeadMotion: 'preserved; only automatic emotion poses remain blocked; direct rua is an independent additive channel',
    before, samples, after: null, humanVisualReview: 'pending; inspect direct-rua stage captures', physicalDeviceTested: false };
  const firstPoint = await scalpPoint(0.25);
  await pet.mouse.move(firstPoint.x, firstPoint.y);
  await wait(async () => {
    const { contact } = await snapshot();
    return contact.active === true && contact.phase === 'rua' && contact.localPhase === 'rua' && contact.handVisible;
  }, 'real scalp pointer input enters rua without a direct IPC contact injection', 2000);
  for (let index = 0; index < 24; index++) {
    // Re-read the projection because the authored VMD continues moving the head.
    const point = await scalpPoint(Math.sin(index * Math.PI / 3) * 0.25);
    await pet.mouse.move(point.x, point.y, { steps: 2 });
    await pause(80);
    const state = await snapshot(); finiteState(state.physics);
    assertPosePhase(samples.at(-1) ?? before, state, driveDuration);
    assert.equal(state.contact.automaticHeadBlocked, true, 'Manual head VMD keeps priority over automatic emotion poses.');
    assert.ok(Array.isArray(state.contact.head) && state.contact.head.length === 3 && state.contact.head.every(Number.isFinite));
    assert.ok(Math.hypot(...state.contact.head) <= Math.PI / 15 + 1e-6, 'The separate direct-contact head delta remains bounded.');
    for (const part of activeParts) assert.ok(state.physics.parts[part].weight > 0 && state.physics.parts[part].solverIterations > 0,
      'Enabled local physics continues solving while the actual direct-contact layer is active.');
    samples.push(state);
    if ([5, 12, 20].includes(index)) await capture(`direct-rua-${index}`);
  }
  const steady = samples.slice(6);
  assert.ok(steady.every(state => state.contact.active && state.contact.phase === 'rua' && state.contact.localPhase === 'rua' &&
    state.contact.weight > 0.5 && state.contact.handVisible),
    'Sustained actual scalp input and physical output overlap across rendered frames.');
  const firstContactPhysics = steady[0].physics, lastContactPhysics = steady.at(-1).physics;
  assert.ok(Number.isFinite(firstContactPhysics.solveCalls) && Number.isFinite(lastContactPhysics.solveCalls) &&
    lastContactPhysics.solveCalls > firstContactPhysics.solveCalls && lastContactPhysics.steps > firstContactPhysics.steps,
  'Actual solver work advances inside sustained contact, rather than only before entry or after leaving.');
  assert.ok(steady.at(-1).baseTime > steady[0].baseTime + 0.1, 'The authored Action actually advances during sustained contact.');
  assert.ok(steady.some(state => Math.hypot(...state.contact.head) > 0.005), 'Contact produces a real nonzero bounded head delta.');
  for (const part of activeParts) assert.ok(steady.some(state => state.physics.parts[part].maxAngle > 1e-5 || state.physics.parts[part].maxDisplacement > 1e-5),
    'The active part has actual weighted physical output during contact.');
  await pet.mouse.move(2, 2);
  await wait(async () => {
    const state = await snapshot();
    return state.contact.active === false && state.contact.weight < 0.01 && !state.contact.handVisible &&
      Array.isArray(state.contact.head) && state.contact.head.every(Number.isFinite) && Math.hypot(...state.contact.head) < 0.005;
  }, 'leaving the scalp hides the cursor and settles the actual direct-contact head delta');
  const after = await snapshot(); finiteState(after.physics);
  assertPosePhase(samples.at(-1), after, driveDuration);
  assert.ok(after.physics.steps > before.physics.steps);
  const settings = await controls.evaluate(() => window.desktop.getSettings());
  assert.equal(settings.model?.path, selectedModelPath);
  assert.equal(settings.motion?.path, driveFilename);
  contactEvidence.after = after;
  contactEvidence.status = 'passed';
  check('actual scalp rua, bounded direct head delta and local physics coexist while the authored Action phase advances');
}
async function collect(label, milliseconds = 1500) {
  const result = await pet.evaluate(async milliseconds => {
    const start = performance.now(), samples = [], intervals = [];
    let lastSignature, lastAt;
    while (performance.now() - start < milliseconds) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const canvas = document.querySelector('#stage canvas');
      const state = JSON.parse(canvas?.dataset.modelPhysics ?? 'null');
      const baseTime = JSON.parse(canvas?.dataset.chatGesture ?? '{}').baseTime;
      const signature = JSON.stringify([baseTime, state?.steps, state?.solveCalls]);
      if (!state || signature === lastSignature) continue;
      const now = performance.now();
      if (lastAt !== undefined) intervals.push(now - lastAt);
      lastAt = now; lastSignature = signature;
      samples.push({ atMs: now - start, baseTime, totalStepMs: state.totalStepMs ?? 0, solveCalls: state.solveCalls ?? 0,
        steps: state.steps, liveObjects: state.liveObjects, status: state.status, error: state.error,
        parts: Object.fromEntries(Object.entries(state.parts ?? {}).map(([key, value]) => [key, {
          weight: value.weight, maxAngle: value.maxAngle, maxDisplacement: value.maxDisplacement, solverIterations: value.solverIterations,
        }])) });
    }
    return { samples, intervals, elapsedMs: performance.now() - start };
  }, milliseconds);
  assert.ok(result.samples.length >= Math.max(5, milliseconds / 150), `${label}: enough actual rendered samples.`);
  for (const sample of result.samples) {
    assert.ok(!sample.error && sample.status !== 'error');
    for (const [name, part] of Object.entries(sample.parts))
      assert.ok([part.weight, part.maxAngle, part.maxDisplacement].every(Number.isFinite) &&
        part.maxAngle <= (name === 'hair' ? 0.7 : 0.3) * part.weight + 1e-6);
  }
  const sorted = [...result.intervals].sort((a, b) => a - b);
  const intervals = { count: sorted.length, meanMs: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null, p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    maxMs: sorted.at(-1) ?? null };
  const first = result.samples[0], last = result.samples.at(-1);
  const entry = { label, elapsedMs: result.elapsedMs, renderedFrames: result.samples.length, intervals,
    totalStepMs: last.totalStepMs - first.totalStepMs, solveCalls: last.solveCalls - first.solveCalls,
    steps: last.steps - first.steps, samples: result.samples };
  rows.push(entry); return entry;
}
function outputFor(entry, activeParts) {
  for (const part of activeParts) assert.ok(entry.samples.some(sample => {
    const value = sample.parts[part];
    return value?.weight > 0 && (value.maxAngle > 0.00001 || value.maxDisplacement > 0.00001);
  }), `${part}: nonzero actual weighted local output under the imported motion.`);
  for (const part of ['hair', 'chest'].filter(part => !activeParts.includes(part)))
    assert.ok(entry.samples.every(sample => (sample.parts[part]?.weight ?? 0) === 0), `${part}: independent inactive output.`);
}
async function capture(label) {
  const viewport = await pet.locator('#stage canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height),
      reserved: [...document.querySelectorAll('.pet-toolbar,.pet-chat,.pet-size-panel,.pet-window-help,.pet-resize-handle,#pet-tooltip,#pet-edit-help,[data-mood-ui],#toast')]
        .map(node => node.getBoundingClientRect().toJSON()).filter(value => value.width > 0 && value.height > 0) };
  });
  const image = await app.evaluate(async ({ BrowserWindow }, viewport) => {
    const window = BrowserWindow.getAllWindows().find(win => {
      const url = win.webContents.getURL(); return url.includes('index.html') && new URL(url).searchParams.has('pet');
    });
    const image = await window.webContents.capturePage({ x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height });
    const size = image.getSize(), bitmap = image.toBitmap(); let modelPixels = 0;
    for (let offset = 3; offset < bitmap.length; offset += 4) {
      const pixel = (offset - 3) / 4, x = pixel % size.width * viewport.width / size.width + viewport.x,
        y = Math.floor(pixel / size.width) * viewport.height / size.height + viewport.y;
      if (bitmap[offset] > 16 && !viewport.reserved.some(rect => x >= rect.x && x <= rect.right && y >= rect.y && y <= rect.bottom)) modelPixels++;
    }
    return { png: image.toPNG().toString('base64'), width: size.width, height: size.height, modelPixels };
  }, viewport);
  assert.ok(image.modelPixels > 500, 'Actual app-stage capture has visible model pixels outside UI.');
  const filename = `${label}.png`, bytes = Buffer.from(image.png, 'base64');
  await writeFile(path.join(output, filename), bytes);
  captures.push({ filename, sha256: sha(bytes), width: image.width, height: image.height, modelPixels: image.modelPixels,
    snapshot: await snapshot(), humanVisualReview: 'pending' });
  return captures.at(-1);
}
async function captureSequence(label) {
  for (let index = 0; index < 4; index++) { await capture(`${label}-${index + 1}`); await pause(180); }
}
async function hostState() {
  return app.evaluate(() => {
    const qa = globalThis.__physicsQA;
    return { blockedHttp: qa.blockedHttp, permissionRequests: qa.permissionRequests, wasmRequests: qa.wasmRequests,
      runtimeScripts: qa.runtimeScripts, pendingWasm: qa.pendingWasm.length, providerCalls: qa.providerCalls, mediaCalls: qa.mediaCalls };
  });
}
async function releaseWasm() {
  if (!app) return;
  await app.evaluate(() => {
    const qa = globalThis.__physicsQA; qa.delayWasm = false;
    for (const done of qa.pendingWasm.splice(0)) done({ cancel: false });
  }).catch(() => {});
}
async function closeOwnedApp() {
  if (!app) return;
  const instance = app; app = null;
  const child = instance.process(); let timeout;
  try {
    await Promise.race([instance.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned app close timeout.')), 10000); })]);
  } catch {
    if (child.pid && child.exitCode === null) {
      cleanup.forcedOwnedProcessStop = true;
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }
  } finally { clearTimeout(timeout); }
  await wait(() => child.exitCode !== null || child.signalCode !== null, 'owned Electron process exited', 5000);
  cleanup.appClosed = true;
}

function chestSummary(frames) {
  const range = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { min: sorted[0], max: sorted.at(-1), range: sorted.at(-1) - sorted[0],
      p10: sorted[Math.floor((sorted.length - 1) * 0.1)], p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
      p90: sorted[Math.floor((sorted.length - 1) * 0.9)] };
  };
  const part = frame => frame.snapshot.physics.parts.chest;
  const components = new Map();
  for (const frame of frames) for (const sample of part(frame).samples ?? [])
    [...sample.localQuatDelta, ...sample.positionDelta].forEach((value, index) => {
      const key = `${sample.boneIndex}:${index}`; if (!components.has(key)) components.set(key, []);
      components.get(key).push(value);
    });
  return { angleRadians: range(frames.map(frame => part(frame).maxAngle)),
    displacementModelUnits: range(frames.map(frame => part(frame).maxDisplacement)),
    weight: range(frames.map(frame => part(frame).weight)),
    maxSampleComponentRange: Math.max(0, ...[...components.values()].map(values => range(values).range)),
    posePhasesSeconds: frames.map(frame => frame.posePhaseSeconds), mixerTimes: frames.map(frame => frame.snapshot.baseTime),
    actualCaptureStartIntervalsMs: frames.slice(1).map((frame, index) => frame.captureStartedMs - frames[index].captureStartedMs) };
}

async function visualFrames(target, label, count, checkClock = false, requirePoseStopped = false) {
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    await pause(Math.max(0, started + index * 80 - performance.now()));
    const captureStartedMs = performance.now() - started;
    const frame = await capture(`${label}-${String(index + 1).padStart(2, '0')}`);
    frame.captureStartedMs = captureStartedMs;
    frame.posePhaseSeconds = Number.isFinite(frame.snapshot.layerTimes?.pose)
      ? ((frame.snapshot.layerTimes.pose % fixture.seconds) + fixture.seconds) % fixture.seconds : null;
    target.push(frame); // Keep completed frames in partial reports before an assertion can fail.
    finiteState(frame.snapshot.physics);
    assert.equal(frame.snapshot.physics.parts?.hair.weight ?? 0, 0, 'Visual contrast keeps hair off.');
    if (requirePoseStopped) assert.equal(frame.snapshot.layerTimes?.pose, null, 'Settling frames contain no authored pose Action.');
    if (checkClock && target.length > 1) assertPosePhase(target.at(-2).snapshot, frame.snapshot, fixture.seconds);
  }
}

async function visualContrast(driveFile) {
  phase = 'visual-portrait';
  visualEvidence = { status: 'collecting', conditions: [], settling: { frames: [] }, fade: null, finalReset: null,
    requestedCaptureSpacingMs: 80, summary: null, humanVisualReview: 'pending',
    scope: 'visual-contrast-only', fullMatrixRun: false,
    sampling: 'Each native canvas capture has an immediately following actual diagnostic snapshot; exact GPU-frame identity is not claimed.' };
  await allOff();
  await controls.locator('#frame-portrait').click();
  await wait(() => controls.evaluate(async () => {
    const camera = (await window.desktop.getSettings()).camera;
    return ['yaw', 'pitch', 'distance', 'targetX', 'targetY', 'fov'].every(field =>
      Math.abs(camera[field] - Number(document.querySelector(`#camera-${field}`).value)) < 0.006);
  }), 'portrait preset is committed through the existing camera UI');
  await pause(250);
  const fixedCamera = await controls.evaluate(async () => (await window.desktop.getSettings()).camera);
  const fixedViewport = await snapshot();
  selectedModelPath = await controls.evaluate(async () => (await window.desktop.getSettings()).model.path);
  await pet.mouse.move(2, Math.max(2, await pet.evaluate(() => innerHeight - 2)));
  await wait(async () => ((await snapshot()).contact.weight ?? 0) < 0.01, 'neutral scalp contact before visual comparison');
  visualEvidence.camera = fixedCamera;
  for (const strength of [0.35, 0.8]) {
    phase = `visual-chest-${strength}`;
    await allOff();
    await controls.locator('#clear-motion').click();
    await wait(() => controls.evaluate(async () => (await window.desktop.getSettings()).motion === null), 'clear Action before comparable visual restart');
    await wait(async () => (await snapshot()).layerTimes?.pose === null, 'pet removed its prior pose Action before visual restart');
    await importDrive(driveFile);
    const actionStart = await snapshot();
    await physicsPatch({ hair: { enabled: false }, chest: { enabled: true, strength }, quality: 'standard' });
    await wait(async () => {
      const state = (await snapshot()).physics;
      return state.running && state.parts?.chest.solverIterations === 10 && Math.abs(state.parts.chest.weight - strength) < 0.002;
    }, 'chest-only standard solver reaches the requested output weight');
    await pause(600);
    // Start both short sequences in the same authored pose-phase window.
    await wait(async () => {
      const pose = (await snapshot()).layerTimes?.pose;
      return Number.isFinite(pose) && (pose % fixture.seconds + fixture.seconds) % fixture.seconds >= 2 &&
        (pose % fixture.seconds + fixture.seconds) % fixture.seconds < 2.12;
    }, 'comparable authored pose phase for chest contrast');
    const settings = await controls.evaluate(() => window.desktop.getSettings());
    assert.deepEqual(settings.camera, fixedCamera); assert.equal(settings.model.path, selectedModelPath);
    assert.equal(settings.motion.path, driveFile); assert.equal(settings.pet.fps, 30);
    const start = await snapshot();
    assert.equal(start.bufferWidth, fixedViewport.bufferWidth); assert.equal(start.bufferHeight, fixedViewport.bufferHeight);
    const condition = { strength, quality: 'standard', solverIterations: 10, warmMinimumMs: 600,
      sameModelAndMotion: true, fixedCamera, fps: settings.pet.fps, renderDpr: start.bufferWidth / start.width,
      actionStart, captureStart: start, frames: [], summary: null };
    visualEvidence.conditions.push(condition);
    await visualFrames(condition.frames, `visual-chest-${strength}`, 18, true);
    condition.summary = chestSummary(condition.frames);
    assert.ok(condition.frames.every(frame => Math.abs(frame.snapshot.physics.parts.chest.weight - strength) < 0.002));
    assert.ok(condition.frames.every(frame => frame.snapshot.physics.parts.chest.solverIterations === 10));
    assert.ok(condition.summary.angleRadians.max > 1e-5 || condition.summary.displacementModelUnits.max > 1e-5, 'Actual weighted chest output exists.');
    assert.ok(Math.max(condition.summary.angleRadians.range, condition.summary.displacementModelUnits.range,
      condition.summary.maxSampleComponentRange) > 1e-6, 'Chest diagnostics change during the authored drive.');
  }
  const [low, high] = visualEvidence.conditions;
  const phaseBins = condition => {
    const bins = new Map();
    for (const frame of condition.frames) {
      const key = Math.floor(frame.posePhaseSeconds / 0.2);
      if (!bins.has(key)) bins.set(key, []); bins.get(key).push(frame.snapshot.physics.parts.chest);
    }
    return bins;
  };
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const lowBins = phaseBins(low), highBins = phaseBins(high);
  const paired = [...lowBins.keys()].filter(key => highBins.has(key)).map(key => {
    const pair = field => ({ low: median(lowBins.get(key).map(part => part[field])), high: median(highBins.get(key).map(part => part[field])) });
    return { phaseBinStartSeconds: key * 0.2, angleRadians: pair('maxAngle'), displacementModelUnits: pair('maxDisplacement') };
  });
  const gain = field => {
    const values = paired.filter(row => row[field].low > 1e-6).map(row => row[field].high / row[field].low);
    return { median: values.length ? median(values) : null, validPhaseBins: values.length };
  };
  const angleGain = gain('angleRadians'), displacementGain = gain('displacementModelUnits');
  visualEvidence.summary = { comparedStrengths: [0.35, 0.8], requestedStrengthRatio: 0.8 / 0.35,
    overlappingPhaseBins: paired, medianMatchedPhaseAngleGain: angleGain.median,
    medianMatchedPhaseDisplacementGain: displacementGain.median, gainEvidence: { angle: angleGain, displacement: displacementGain }, telemetryContrast: 'pending',
    humanVisualReview: 'pending', naturalness: 'not assessed; higher strength is a comparison, not a new default',
    visibilityConclusion: 'Pending owner inspection of continuous native stage sequences; telemetry alone does not prove perceptible differentiation.' };
  const differentiated = paired.length >= 3 &&
    [angleGain, displacementGain].some(value => value.validPhaseBins >= 3 && Number.isFinite(value.median) && value.median > 1.1);
  visualEvidence.summary.telemetryContrast = differentiated ? 'observed-at-matched-pose-phases' : 'not-demonstrated';
  // Finish the high-strength settling and release evidence even if gain is inconclusive.
  phase = 'visual-high-settling';
  visualEvidence.settling.beforeClear = await snapshot();
  visualEvidence.settling.strength = 0.8; visualEvidence.settling.quality = 'standard';
  assert.ok(Math.abs(visualEvidence.settling.beforeClear.physics.parts.chest.weight - 0.8) < 0.002);
  await controls.locator('#clear-motion').click();
  await wait(() => controls.evaluate(async () => (await window.desktop.getSettings()).motion === null), 'high-strength Action cleared through UI');
  await wait(async () => (await snapshot()).layerTimes?.pose === null, 'pet removed its authored Action before settling capture');
  await visualFrames(visualEvidence.settling.frames, 'visual-high-settling', 12, false, true);
  visualEvidence.settling.summary = chestSummary(visualEvidence.settling.frames);
  phase = 'visual-disable-fade';
  await controls.evaluate(() => window.desktop.setModelPhysicsSettings({ chest: { enabled: false } }));
  visualEvidence.fade = await collect('visual-disable-fade', 600);
  visualEvidence.fadeSummary = { weights: visualEvidence.fade.samples.map(sample => sample.parts.chest?.weight ?? 0),
    finiteIntermediate: visualEvidence.fade.samples.some(sample => sample.parts.chest?.weight > 0 && sample.parts.chest.weight < 0.8) };
  const released = await allOff(); balanced(released, 'visual contrast release', true); recordCapacity('visual-release', released);
  await physicsPatch({ hair: { enabled: false }, chest: { enabled: false, strength: 0.35 }, quality: 'standard' });
  visualEvidence.finalReset = { state: (await snapshot()).physics, settings: await controls.evaluate(() => window.desktop.getModelPhysicsSettings()) };
  balanced(visualEvidence.finalReset.state, 'visual final reset', true);
  assert.deepEqual(visualEvidence.finalReset.settings.chest, { enabled: false, strength: 0.35 });
  assert.equal(visualEvidence.finalReset.settings.hair.enabled, false);
  assert.ok(visualEvidence.fadeSummary.finiteIntermediate, 'A finite intermediate fade is observed before owned objects reach zero.');
  assert.ok(differentiated, 'Chest strength contrast is not demonstrated; retain partial sequences for review without signing success.');
  visualEvidence.status = 'captured-review-pending';
  check('chest-only .35/.8 fixed-view matched-phase sequences, high settling, finite fade and owned-object release recorded for human review');
}

let fixture, manifestIdentity, initial, baseConditions, localAssetIdentity, selectedModelPath;
try {
  assert.ok(process.env.MMD_TEST_APP_DIR && process.env.MMD_TEST_EXE, 'Require frozen MMD_TEST_APP_DIR and packaged MMD_TEST_EXE.');
  source = await realpath(process.env.MMD_TEST_APP_DIR);
  executable = await realpath(process.env.MMD_TEST_EXE);
  assert.notEqual(source.toLowerCase(), (await realpath(workspace)).toLowerCase(), 'Use an independent frozen source, not the shared working build.');
  const manifestFile = path.join(path.dirname(source), 'validated.json');
  proof = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(proof.version, 1); assert.ok(proof.inputs?.length && /^[a-f0-9]{64}$/.test(proof.sourceHash));
  assert.ok(within(path.dirname(source), executable), 'Packaged executable belongs to this frozen candidate.');
  asar = await realpath(path.join(path.dirname(executable), 'resources/app.asar'));
  baselineAsarHash = await hash(asar); baselineSourceHash = await sourceFingerprint();
  assert.equal(baselineAsarHash, proof.asarSha256); assert.equal(baselineSourceHash, proof.sourceHash);
  manifestIdentity = { sourceHash: proof.sourceHash, asarSha256: baselineAsarHash, validatedAt: proof.validatedAt,
    manifestSha256: await hash(manifestFile), harnessSha256: await hash(harnessFile) };
  const wasmNames = [], scriptNames = [];
  for (const name of await readdir(path.join(source, 'dist/assets'))) {
    if (!/\.(?:js|wasm)$/.test(name)) continue;
    const digest = await hash(path.join(source, 'dist/assets', name));
    if (digest === '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93') wasmNames.push(name);
    if (digest === '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228') scriptNames.push(name);
  }
  assert.equal(wasmNames.length, 1, 'Exactly one reviewed local Ammo WASM asset was emitted.');
  assert.equal(scriptNames.length, 1, 'Exactly one unmodified reviewed local Ammo script was emitted.');
  const wasmUrl = pathToFileURL(path.join(asar, 'dist/assets', wasmNames[0])).href;
  const scriptUrl = pathToFileURL(path.join(asar, 'dist/assets', scriptNames[0])).href;
  localAssetIdentity = { wasmFilename: wasmNames[0], scriptFilename: scriptNames[0],
    wasmSha256: '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93',
    scriptSha256: '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228' };
  if (mode === 'private') {
    assert.ok(process.env.MMD_TEST_MODEL, 'Private mode requires a separately authorized MMD_TEST_MODEL.');
    modelPath = await realpath(process.env.MMD_TEST_MODEL);
    assert.ok(/\.(pmx|pmd)$/i.test(modelPath));
  }
  const temporaryRoot = await realpath(tmpdir());
  profile = await mkdtemp(path.join(temporaryRoot, 'soft-physics-'));
  assert.ok(within(temporaryRoot, await realpath(profile)));
  privateStrings.push(source, executable, asar, profile, workspace, modelPath ?? '', modelPath ? path.dirname(modelPath) : '');
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settingsSeed()));
  const driveFile = path.join(output, 'original-drive.vmd'); fixture = await writeDriveMotion(driveFile);
  // Claude Code: inert placeholder + empty config folder; Codex: a missing path.
  const env = (await createClaudeIsolation()).environment(Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^MMD_|^VITE_DEV_SERVER_URL$|^ELECTRON_RUN_AS_NODE$/.test(name))));
  phase = 'launch';
  app = await electron.launch({ executablePath: executable, cwd: source,
    args: [`--user-data-dir=${profile}`, `--soft-hearts-build=${proof.sourceHash}`], env, timeout: 30000 });
  await app.firstWindow();
  identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'),
    appPath: app.getAppPath(), pid: process.pid, build: app.commandLine.getSwitchValue('soft-hearts-build') }));
  assert.ok(identity.packaged); assert.equal((await realpath(identity.profile)).toLowerCase(), profile.toLowerCase());
  assert.equal((await realpath(identity.appPath)).toLowerCase(), asar.toLowerCase()); assert.equal(identity.build, proof.sourceHash);
  identityVerified = true;
  await app.evaluate(async ({ session, desktopCapturer }, { wasmUrl, scriptUrl }) => {
    const qa = globalThis.__physicsQA = { blockedHttp: [], permissionRequests: [], wasmRequests: [], pendingWasm: [],
      runtimeScripts: [], delayWasm: false, providerCalls: 0, mediaCalls: 0, originalPicker: null, pick: null };
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, name, done) => { qa.permissionRequests.push(name); done(false); });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      if (/^(?:https?|wss?):/i.test(details.url)) { qa.blockedHttp.push(new URL(details.url).origin); done({ cancel: true }); return; }
      if (details.url === scriptUrl) qa.runtimeScripts.push({ webContentsId: details.webContentsId, at: Date.now() });
      if (details.url === wasmUrl) {
        qa.wasmRequests.push({ webContentsId: details.webContentsId, at: Date.now() });
        if (qa.delayWasm) { qa.pendingWasm.push(done); return; }
      } else if (/\.wasm(?:[?#]|$)/i.test(details.url)) { done({ cancel: true }); return; }
      done({ cancel: false });
    });
    globalThis.fetch = async () => { qa.providerCalls++; throw new Error('HTTP is disabled in isolated physics QA.'); };
    desktopCapturer.getSources = async () => { qa.mediaCalls++; throw new Error('Desktop capture is disabled in isolated physics QA.'); };
    for (const name of ['http', 'https']) {
      const module = process.getBuiltinModule(name);
      for (const method of ['request', 'get']) module[method] = () => { qa.providerCalls++; throw new Error('HTTP is disabled in isolated physics QA.'); };
    }
  }, { wasmUrl, scriptUrl });
  await wait(() => {
    controls = app.windows().find(window => window.url().includes('index.html') && !new URL(window.url()).searchParams.has('pet'));
    pet = app.windows().find(window => window.url().includes('index.html') && new URL(window.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'both isolated app windows');
  for (const window of [controls, pet]) {
    window.on('pageerror', error => errors.push(safe(error.message)));
    await window.waitForFunction(() => !!window.desktop && !!document.querySelector('#stage canvas'));
    await window.evaluate(() => {
      window.__physicsEvents = [];
      window.__physicsUnsubscribe = window.desktop.onModelPhysicsSettings(value => window.__physicsEvents.push(value));
      window.__physicsMediaCalls = 0;
      if (navigator.mediaDevices) for (const name of ['getUserMedia', 'getDisplayMedia'])
        Object.defineProperty(navigator.mediaDevices, name, { configurable: true, value: async () => {
          window.__physicsMediaCalls++; throw new Error('Media is disabled in physics QA.');
        } });
    });
  }
  const tab = await controls.locator('#model-physics-controls').evaluate(element => element.closest('.tab-panel')?.id.replace(/^tab-/, ''));
  assert.ok(tab); await navigateControlPage(controls, tab);
  await controls.locator('#use-bundled-model').click();
  await wait(async () => (await snapshot()).physics?.support?.hair.supported, 'public Gene is ready', 45000);
  if (mode === 'private') {
    await pick('#import-model', modelPath);
    await wait(async () => controls.evaluate(async expected => (await window.desktop.getSettings()).model?.path === expected, modelPath), 'authorized model selection');
    await wait(async () => { const value = (await snapshot()).physics; return value?.support.hair.supported && value?.support.chest.supported; }, 'authorized model supports both independent parts', 45000);
  }
  await controls.locator('#frame-full').click(); await pause(650);
  initial = await snapshot(); finiteState(initial.physics);
  assert.ok(initial.width > 0 && initial.height > 0 && initial.bufferWidth / initial.width <= 1.51 &&
    initial.bufferHeight / initial.height <= 1.51, 'Existing renderer DPR stays bounded.');
  assert.equal(initial.physics.previewOnly, false); balanced(initial.physics, 'default off');
  assert.deepEqual(initial.physics.enabled, { hair: false, chest: false });
  assert.equal((await hostState()).wasmRequests.length, 0, 'Default off loads no WASM.');
  assert.equal((await snapshot(controls)).physics.previewOnly, true);
  if (mode === 'gene') {
    assert.equal(initial.physics.support.chest.supported, false);
    assert.ok(initial.physics.support.chest.reason);
    assert.equal(await controls.locator('#physics-chest-enabled').isDisabled(), true);
  }
  check('default off, explicit support/fallback, and zero WASM/world allocation');
  assert.equal(await pet.evaluate(() => window.desktop.setModelPhysicsSettings({ quality: 'high' }).then(() => false, () => true)), true, 'Pet cannot write control-only settings.');
  if (visualOnly) {
    await visualContrast(driveFile);
  } else {
  await importDrive(driveFile);
  selectedModelPath = await controls.evaluate(async () => (await window.desktop.getSettings()).model.path);
  baseConditions = await controls.evaluate(async ({ model, motion }) => {
    const value = await window.desktop.getSettings();
    return { camera: value.camera, fps: value.pet.fps, breath: value.pet.breath, followMouse: value.pet.followMouse,
      sameModel: value.model?.path === model, originalMotionSelected: value.motion?.path === motion };
  }, { model: selectedModelPath, motion: driveFile });
  assert.ok(baseConditions.sameModel && baseConditions.originalMotionSelected);
  phase = 'preview-isolation';
  await petVisible(false);
  await controls.locator('#physics-hair-enabled').check();
  await wait(() => controls.evaluate(async () => (await window.desktop.getModelPhysicsSettings()).hair.enabled), 'real checkbox writes the independent sidecar');
  await pause(500);
  const preview = (await snapshot(controls)).physics; finiteState(preview); balanced(preview, 'preview');
  assert.equal(preview.previewOnly, true); assert.equal((await hostState()).wasmRequests.length, 0);
  await physicsPatch({ hair: { enabled: false } }); await petVisible(true); await pause(150);
  check('enabled controls preview does not load a second Ammo runtime or allocate worlds');

  phase = 'cancel-late-local-initialization';
  await app.evaluate(() => { globalThis.__physicsQA.delayWasm = true; });
  await physicsPatch({ hair: { enabled: true } });
  await wait(async () => (await hostState()).pendingWasm === 1, 'only fixed local WASM request delayed');
  await physicsPatch({ hair: { enabled: false } }); await releaseWasm(); await pause(900);
  const cancelled = (await snapshot()).physics; finiteState(cancelled); balanced(cancelled, 'cancelled late initialization');
  assert.equal(cancelled.running, false); assert.equal(cancelled.enabled.hair, false);
  assert.equal(cancelled.createdObjects ?? 0, 0, 'Cancelled initialization created no native object.');
  check('fixed local WASM delayed completion cannot recreate a cancelled world');
  await capture('off-before');
  const offBaseline = await collect('off-baseline', 2000);
  outputFor(offBaseline, []);

  phase = 'independent-local-output';
  const combinations = mode === 'private' ? [['chest'], ['hair'], ['hair', 'chest']] : [['hair']];
  for (const active of combinations) {
    await allOff();
    await physicsPatch({ hair: { enabled: active.includes('hair'), strength: 0.65 },
      chest: { enabled: active.includes('chest'), strength: 0.35 }, quality: 'standard' });
    await wait(async () => (await snapshot()).physics?.running, 'actual solver is running'); await pause(450);
    const entry = await collect(`active-${active.join('-')}`, 2000); outputFor(entry, active);
    await captureSequence(`active-${active.join('-')}`);
    const previewState = (await snapshot(controls)).physics; balanced(previewState, 'active preview');
    check(`actual weighted ${active.join('+')} output and continuous app-stage captures`);
  }
  const activeParts = mode === 'private' ? ['hair', 'chest'] : ['hair'];
  phase = 'quality-measurements';
  for (const [quality, iterations] of [['low', 4], ['standard', 10], ['high', 20]]) {
    await physicsPatch({ quality }); await pause(350);
    const before = await snapshot(); finiteState(before.physics);
    for (const part of activeParts) assert.equal(before.physics.parts[part].solverIterations, iterations);
    const entry = await collect(`quality-${quality}`, 4000); outputFor(entry, activeParts);
    assert.ok(entry.solveCalls > 0 && entry.steps > 0 && entry.totalStepMs >= 0);
    const conditions = await controls.evaluate(async ({ model, motion }) => {
      const value = await window.desktop.getSettings();
      return { camera: value.camera, fps: value.pet.fps, breath: value.pet.breath, followMouse: value.pet.followMouse,
        sameModel: value.model?.path === model, originalMotionSelected: value.motion?.path === motion };
    }, { model: selectedModelPath, motion: driveFile });
    assert.deepEqual(conditions, baseConditions);
    assert.equal(before.bufferWidth, initial.bufferWidth); assert.equal(before.bufferHeight, initial.bufferHeight);
    qualityRuns.push({ quality, iterations, conditions, renderDpr: before.bufferWidth / before.width,
      totalStepMs: entry.totalStepMs, solveCalls: entry.solveCalls, steps: entry.steps,
      solverMeanMs: entry.totalStepMs / entry.solveCalls, intervals: entry.intervals,
      note: 'Same model/motion/camera/FPS/DPR; continuously advancing periodic input. No hardware-independent CPU/FPS guarantee.' });
  }
  check('measured low/standard/high work and frame intervals with verified 4/10/20 solver iterations');
  await directContact(activeParts, driveFile, fixture.seconds);
  phase = 'independent-zero-strength';
  for (const zeroPart of activeParts) {
    await physicsPatch({ hair: { strength: zeroPart === 'hair' ? 0 : 0.65 }, chest: { strength: zeroPart === 'chest' ? 0 : 0.35 } });
    await pause(450); const entry = await collect(`zero-${zeroPart}`, 1000);
    assert.ok(entry.samples.every(sample => (sample.parts[zeroPart]?.weight ?? 0) === 0));
    assert.ok(entry.samples.every(sample => (sample.parts[zeroPart]?.solverIterations ?? 0) === 0), 'Zero-strength part releases its solver.');
    outputFor(entry, activeParts.filter(part => part !== zeroPart));
    if (activeParts.length === 1) balanced((await snapshot()).physics, 'single zero-strength part', true);
  }
  await physicsPatch({ hair: { strength: 0.65 }, chest: { strength: 0.35 }, quality: 'standard' });
  await pause(350);
  check('zero output strength is independent of the other part and quality budget');
  phase = 'stationary-and-action-switch';
  const beforeSwitch = await snapshot();
  await controls.locator('#clear-motion').click();
  await wait(async () => controls.evaluate(async () => (await window.desktop.getSettings()).motion === null), 'clear motion through real UI');
  await pause(800); await collect('stationary-after-clear', 1800); await capture('stationary');
  await importDrive(driveFile); await collect('after-motion-reimport', 1200);
  finiteState((await snapshot()).physics);
  rows.push({ label: 'explicit-action-switch', previousBaseTime: beforeSwitch.baseTime, afterBaseTime: (await snapshot()).baseTime,
    note: 'Only explicit import/clear changes the selected Action; no stage/bone mutation.' });
  check('static pose, explicit action changes and finite bounded recovery');
  phase = 'off-fade-and-toggle-cycles';
  await controls.evaluate(() => window.desktop.setModelPhysicsSettings({ hair: { enabled: false }, chest: { enabled: false } }));
  const fade = await collect('disable-fade', 600);
  assert.ok(fade.samples.some(sample => activeParts.some(part => {
    const weight = sample.parts[part]?.weight ?? 0; return weight > 0 && weight < 0.65;
  })), 'Disable presents a finite intermediate fade before zero.');
  const off = await allOff();
  rows.push({ label: 'fade-end', observedWeights: fade.samples.map(sample => Object.fromEntries(Object.entries(sample.parts).map(([part, value]) => [part, value.weight]))), state: off });
  for (let cycle = 0; cycle < 4; cycle++) {
    await physicsPatch({ hair: { enabled: true }, chest: { enabled: mode === 'private' } });
    await wait(async () => (await snapshot()).physics.liveObjects > 0, 'toggle allocates owned objects');
    await pause(350); const active = (await snapshot()).physics; finiteState(active);
    const released = await allOff(); balanced(released, `toggle-${cycle + 1}`, true);
    recordCapacity(`toggle-${cycle + 1}`, released); rows.push({ label: `toggle-${cycle + 1}`, active, released });
  }
  check('four repeatable enable/disable cycles and fade completion balance owned Ammo objects');
  phase = 'hide-resume';
  await physicsPatch({ hair: { enabled: true }, chest: { enabled: mode === 'private' } });
  for (let cycle = 0; cycle < 3; cycle++) {
    await wait(async () => (await snapshot()).physics.liveObjects > 0, 'before hide running');
    await petVisible(false);
    await wait(async () => (await snapshot()).physics.liveObjects === 0, 'hidden lifecycle snapshot shows actual release');
    const hidden = await snapshot(); balanced(hidden.physics, 'hidden', true);
    recordCapacity(`hide-${cycle + 1}`, hidden.physics); await pause(cycle === 0 ? 1250 : 450);
    const stillHidden = await snapshot(); assert.equal(stillHidden.physics.steps, hidden.physics.steps);
    await petVisible(true);
    await wait(async () => (await snapshot()).physics.liveObjects > 0, 'resume rebuilds current world');
    const resumed = await snapshot();
    assert.ok(resumed.physics.steps - hidden.physics.steps <= 24, 'Resume does not replay the hidden interval.');
    rows.push({ label: `hide-resume-${cycle + 1}`, hidden, stillHidden, resumed });
  }
  await capture('after-resume'); check('three native hide/show cycles release worlds and discard accumulated time');
  if (capacitySamples.length >= 3) assert.ok(capacitySamples.slice(2).every(sample => sample.bytes === capacitySamples[2].bytes),
    'Equal warmed worlds fit the retained WASM capacity without continuing growth.');
  phase = 'model-replacement-release';
  const beforeModelChange = (await snapshot()).physics; assert.ok(beforeModelChange.liveObjects > 0);
  await controls.evaluate(async () => {
    const settings = await window.desktop.getSettings();
    await window.desktop.saveSettings({ ...settings, model: null, motion: null, motionLayers: undefined });
  });
  await wait(async () => {
    const state = (await snapshot()).physics, released = state?.lastPhysicsRelease;
    return state?.parts === null && state.status === 'off' && state.liveObjects === 0 && released?.status === 'disposed' &&
      Number.isFinite(released.createdObjects) && released.createdObjects >= beforeModelChange.createdObjects;
  }, 'current old model lifecycle release is observable, not an earlier snapshot');
  const cleared = (await snapshot()).physics; balanced(cleared.lastPhysicsRelease, 'old model released', true); balanced(cleared, 'cleared model');
  assert.ok(cleared.lastPhysicsRelease.createdObjects > 0);
  rows.push({ label: 'model-replacement-release', before: beforeModelChange, after: cleared });
  await allOff(); await controls.locator('#use-bundled-model').click();
  await wait(async () => (await snapshot()).physics.support.hair.supported, 'new public Gene model ready', 45000);
  balanced((await snapshot()).physics, 'new model remains off');
  check('model replacement destroys the old world and does not leak old presentation into the new model');
  }
  phase = 'final-privacy-and-identity';
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  const audio = await controls.evaluate(() => window.desktop.getSystemAudioState());
  assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false); assert.equal(audio.active, false);
  const settings = await controls.evaluate(() => window.desktop.getSettings());
  assert.equal(settings.provider.kind, 'claude'); assert.equal(settings.provider.model, '');
  assert.equal(settings.voice.enabled, false); assert.equal(settings.voice.volume, 0);
  for (const window of [controls, pet]) assert.equal(await window.evaluate(() => window.__physicsMediaCalls), 0);
  hostEvidence = await hostState();
  assert.deepEqual(hostEvidence.blockedHttp, []); assert.deepEqual(hostEvidence.permissionRequests, []); assert.equal(hostEvidence.providerCalls, 0); assert.equal(hostEvidence.mediaCalls, 0);
  assert.equal(hostEvidence.pendingWasm, 0); assert.ok(hostEvidence.wasmRequests.length >= 1);
  const controlId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => {
    const url = win.webContents.getURL(); return url.includes('index.html') && !new URL(url).searchParams.has('pet');
  }).webContents.id);
  assert.ok(hostEvidence.wasmRequests.every(request => request.webContentsId !== controlId), 'Preview never requests WASM.');
  assert.ok(hostEvidence.runtimeScripts.length >= 1 && hostEvidence.runtimeScripts.every(request => request.webContentsId !== controlId), 'Only the pet requests the reviewed classic runtime script.');
  assert.deepEqual(errors, []); assert.equal(await hash(asar), baselineAsarHash); assert.equal(await sourceFingerprint(), baselineSourceHash);
  assert.ok(await controls.evaluate(() => window.__physicsEvents.length > 0));
  assert.ok(await pet.evaluate(() => window.__physicsEvents.length > 0));
  check('zero HTTP/provider/media/permission calls, controls-only writes, broadcasts and unchanged frozen identity');
  finalChecksCompleted = true;
  if (visualEvidence) visualEvidence.finalChecks = { status: 'passed', privacy: true, frozenHashesUnchanged: true };
} catch (error) {
  failure = safe(error?.stack ?? error);
  if (pet) await capture('failure-stage').catch(() => {});
} finally {
  await releaseWasm();
  if (visualOnly && app && controls && pet) {
    try {
      await physicsPatch({ hair: { enabled: false }, chest: { enabled: false, strength: 0.35 }, quality: 'standard' });
      await wait(async () => (await snapshot()).physics.liveObjects === 0, 'visual finally releases owned worlds');
      const state = (await snapshot()).physics; finiteState(state); balanced(state, 'visual finally', !!state.createdObjects);
      if (visualEvidence) visualEvidence.finalReset = { state, settings: await controls.evaluate(() => window.desktop.getModelPhysicsSettings()) };
    } catch (error) { errors.push(`visual-reset:${safe(error.message)}`); }
    if (identityVerified && !finalChecksCompleted) {
      try {
        const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
        const audio = await controls.evaluate(() => window.desktop.getSystemAudioState());
        const settings = await controls.evaluate(() => window.desktop.getSettings());
        assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false);
        assert.equal(audio.active, false); assert.equal(settings.voice.enabled, false); assert.equal(settings.voice.volume, 0);
        assert.equal(settings.provider.kind, 'claude'); assert.equal(settings.provider.model, '');
        for (const window of [controls, pet]) assert.equal(await window.evaluate(() => window.__physicsMediaCalls), 0);
        hostEvidence = await hostState();
        assert.deepEqual(hostEvidence.blockedHttp, []); assert.deepEqual(hostEvidence.permissionRequests, []);
        assert.equal(hostEvidence.providerCalls, 0); assert.equal(hostEvidence.mediaCalls, 0); assert.equal(hostEvidence.pendingWasm, 0);
        assert.equal(await hash(asar), baselineAsarHash); assert.equal(await sourceFingerprint(), baselineSourceHash);
        finalChecksCompleted = true;
        if (visualEvidence) visualEvidence.finalChecks = { status: 'passed-after-partial-run', privacy: true, frozenHashesUnchanged: true };
      } catch (error) { errors.push(`visual-final-check:${safe(error.message)}`); }
    }
  }
  if (app) hostEvidence = await hostState().catch(() => hostEvidence);
  for (const window of [controls, pet].filter(Boolean)) await window.evaluate(() => window.__physicsUnsubscribe?.()).catch(() => {});
  try { await closeOwnedApp(); } catch (error) { errors.push(`cleanup:${safe(error.message)}`); }
  if (profile && cleanup.appClosed) {
    try {
      const temporaryRoot = await realpath(tmpdir()), physical = await realpath(profile);
      assert.ok(within(temporaryRoot, physical) && path.basename(physical).startsWith('soft-physics-'), 'Delete only this helper-created temporary profile.');
      await rm(physical, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); cleanup.profileRemoved = true;
    } catch (error) { errors.push(`profile-cleanup:${safe(error.message)}`); }
  }
  const technicalChecksPassed = !failure && errors.length === 0 && cleanup.appClosed && cleanup.profileRemoved;
  const report = { status: technicalChecksPassed ? (visualOnly ? 'REVIEW_PENDING' : 'PASS') : 'FAILED',
    scope: visualOnly ? 'visual-contrast-only' : 'full-matrix', technicalChecksPassed,
    mode, runId, phase, identity: identity ? { packaged: identity.packaged, pid: identity.pid, build: identity.build,
      explicitPhysicalProfileVerified: identityVerified, packagedAsarVerified: identityVerified } : null,
    manifest: manifestIdentity, localAssets: localAssetIdentity, fixture, model: mode === 'private' ? 'explicitly authorized external model; path omitted' : 'bundled public Gene',
    checks, initial, baseConditions, qualityRuns, contactEvidence, visualEvidence, rows, captures, hostEvidence, errors, failure, cleanup,
    wasmCapacity: { meaning: 'Retained HEAP8 capacity, not live native allocations or OS RSS; module unloading is not claimed.', samples: capacitySamples },
    limits: { humanVisualReview: 'pending; owner must inspect continuous stage captures', physicalInputTested: false,
      normalProfileRead: false, desktopCapture: false, realMediaCapture: false, chatOrProviderInvocation: false,
      offAndSingleModelDoNotProveChest: true, hardwareIndependentPerformanceGuarantee: false,
      ruaDirectContact: visualOnly ? 'Not repeated in visual-contrast-only mode; the separate full-matrix report retains its own contact evidence.'
        : 'The scalp-input phase must have contactEvidence.status=passed; controlled input does not sign physical mouse/touchpad feel or human visual preference.',
      initializationScope: 'Seed disables all automatic services; HTTP/permissions/media guards installed immediately after isolated app launch.' } };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputRoot, `latest-${visualOnly ? 'visual-' : ''}${mode}.json`), JSON.stringify({ runId, report: `${runId}/report.json`, status: report.status, scope: report.scope }, null, 2));
  console.log(JSON.stringify({ status: report.status, scope: report.scope, mode, runId, checks: checks.length, captures: captures.length, cleanup }));
  if (report.status === 'FAILED') process.exitCode = 1;
}
