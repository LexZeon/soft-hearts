// Prepare outside the frozen source; execute only after the native lease is handed back.
// MMD_CHAT_NATIVE_LEASE=1 MMD_TEST_APP_DIR=<frozen source> MMD_TEST_EXE=<same package>
// MMD_TEST_MODEL=<already authorized PMX/PMD> MMD_CHAT_MODEL_SHA256=<root's exact content hash>
// There is no Gene/model fallback. No normal profile, real provider, speech or media is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const harnessFile = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(harnessFile), '..');
let ignoredRoot = workspace;
while (path.basename(ignoredRoot) !== '.local' && path.dirname(ignoredRoot) !== ignoredRoot) ignoredRoot = path.dirname(ignoredRoot);
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-current-model`;
const outputRoot = path.resolve(process.env.MMD_CHAT_OUTPUT ?? path.join(ignoredRoot, 'chat-motion-repair-native'));
const output = path.join(outputRoot, runId);
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (base, child) => { const relative = path.relative(base, child); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
const checks = [], errors = [], fixtureErrors = [], fixtureInterference = [], requests = [], captures = [], performances = [], priority = [], privateStrings = [];
const plans = new Map();
const motionDurations = new Map();
let idleReference = [];
const cleanup = { appClosed: false, forcedOwnedProcessStop: false, profileRemoved: false, serverClosed: false };
const fixtures = {
  explain: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', durationMs: 6000, sha256: '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d' },
  consider: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', durationMs: 6000, sha256: '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d' },
  upbeat: { packId: 'mpi-embm-gestures', motionId: 'conversation-joy', durationMs: 2933.333, sha256: '027860a2db2891277a36e723dc69300b16828a701e33169ec29edd3397db710b' },
};
let source, executable, asar, proof, profile, modelPath, requiredModelHash, app, controls, pet, claude;
// No HTTP origin is allowed: chat runs through the synthetic Claude Code process (scripts/lib/claude-smoke-fixture.mjs).
const origin = null;
let phase = 'preflight', sequence = 0, outputReady = false, identityVerified = false;
let baselineSourceHash, baselineAsarHash, manifestIdentity, identity, modelIdentity, fixtureMood, physicsCross, hostEvidence, failure, failureKind, failureState, finalChecksCompleted = false;
let poseDuration = 10;
const safe = value => privateStrings.sort((a, b) => b.length - a.length).reduce((text, item) => item ? text.split(item).join('<isolated-path>') : text, String(value));
const check = label => { checks.push(label); console.log(`PASS ${label}`); };

async function wait(predicate, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(45); }
  throw new Error(`Timeout: ${label}`);
}
async function fingerprint() {
  const entries = [];
  for (const relative of [...proof.inputs].sort()) {
    assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.split('/').some(item => item === '.' || item === '..'));
    const file = await realpath(path.join(source, relative)); assert.ok(within(source, file));
    entries.push([relative, await hash(file)]);
  }
  return sha(JSON.stringify(entries));
}
async function evidenceDirectory() {
  assert.equal(path.basename(ignoredRoot), '.local', 'Run this helper from an ignored local source checkout.');
  assert.ok(within(ignoredRoot, outputRoot) && within(outputRoot, output) && !within(source, output));
  assert.ok(samePath(await realpath(ignoredRoot), ignoredRoot));
  let current = ignoredRoot;
  for (const component of path.relative(ignoredRoot, output).split(path.sep)) {
    current = path.join(current, component);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current); assert.ok(info.isDirectory() && !info.isSymbolicLink());
  }
  outputReady = true;
}
function asset(file) { return { path: file, name: path.basename(file), url: 'mmd-asset://fixture/pending' }; }
function seed(stand) {
  return { version: 1, model: asset(modelPath), motion: asset(stand), motionLayers: { gesture: null, expression: null },
    camera: { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 },
    provider: claude.provider,
    persona: '原创隔离会话动作验证。只回复本机合成测试，不使用工具。',
    pet: { visible: true, alwaysOnTop: false, clickThrough: false, followMouse: false, breath: 0, fps: 30, scale: 1, size: { width: 480, height: 640 } },
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 },
    voiceInput: { baseUrl: 'http://127.0.0.1:9/v1', model: 'no-transcription', language: 'zh', apiKey: '' },
    agent: { workingDirectory: '', model: '', writable: false } };
}
async function publicMotion(catalog, packId, motionId) {
  const pack = catalog.packs.find(item => item.id === packId), motion = pack?.motions.find(item => item.id === motionId);
  assert.ok(pack && motion, 'Required curated local motion exists.');
  const file = await realpath(path.join(source, 'assets/bundled', pack.source, pack.id, pack.revision, motion.relativePath));
  assert.ok(within(source, file)); assert.equal(await hash(file), motion.sha256);
  assert.ok(Number.isFinite(motion.durationFrames) && motion.durationFrames > 0);
  motionDurations.set(`${packId}/${motionId}`, motion.durationFrames / 30);
  return { file, motion };
}
async function settings() { return controls.evaluate(() => window.desktop.getSettings()); }
async function mood(page = controls) { return page.evaluate(() => window.desktop.getMood()); }
async function state(page = pet) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#stage canvas'), feedback = JSON.parse(canvas?.dataset.moodFeedback ?? '{}');
    return { ...JSON.parse(canvas?.dataset.chatGesture ?? '{}'),
      poseTime: JSON.parse(canvas?.dataset.motionTransition ?? '{}').layerTimes?.pose ?? null,
      directInput: { phase: feedback.phase ?? null, active: feedback.activeContact ?? null, hover: feedback.hover ?? null } };
  });
}
function requireDirectInputClear(frame, label) {
  const input = frame.directInput;
  assert.ok(input && typeof input.phase === 'string' && typeof input.active === 'boolean' && Number.isFinite(input.hover), 'Required direct-input diagnostic must be present.');
  if (input.phase === 'idle' && input.active === false && input.hover === 0) return;
  fixtureInterference.push({ label, directInput: input, blocked: frame.blocked ?? null, blockedReason: frame.blockedReason ?? null });
  const error = new Error(`Fixture interference: direct pointer/contact attention changed ${label}; this is not signed as a chat-wiring failure.`);
  error.code = 'fixture-input-interference'; throw error;
}
async function currentModel(verifyBytes = false) {
  const value = await settings(); assert.ok(value.model && samePath(value.model.path, modelPath), 'The required current-model reference stays selected; no fallback.');
  if (verifyBytes) assert.equal(await hash(modelPath), requiredModelHash, 'The exact authorized model bytes stay unchanged.');
}
async function memorySummary() {
  return controls.evaluate(async () => {
    const messages = []; let count = 0;
    for (let offset = 0; offset < 100; offset += 50) {
      const page = await window.desktop.listMemories({ offset, limit: 50 });
      for (const record of page.records) {
        assertBound(record.messageCount);
        count += record.messageCount;
        for (let messageOffset = 0; messageOffset < record.messageCount; messageOffset += 10) {
          const part = await window.desktop.readMemory(record.id, { messageOffset, messageLimit: 10, textLimit: 1 });
          messages.push(...part.messages.map(({ turnId, role, status }) => ({ turnId, role, status })));
        }
      }
      if (offset + page.records.length >= page.total) return { count, messages };
    }
    throw new Error('Synthetic archive exceeded its bounded QA scope.');
    function assertBound(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new Error('Synthetic message count is invalid.'); }
  });
}
async function ready(reason = null) {
  await wait(async () => {
    const frame = await state();
    return Number.isFinite(frame.baseTime) && Number.isFinite(frame.poseTime) && frame.blocked === (reason !== null) && frame.blockedReason === reason;
  }, `model and selected pose ready (${reason ?? 'compatible'})`, 60000);
  await currentModel(); await pause(450);
}
function armAngle(a, b) {
  const right = new Map(b.arms ?? []); let maximum = 0;
  for (const [name, q] of a.arms ?? []) {
    if (!/^(?:左|右)(?:肩|腕|ひじ|肘|手首)$/.test(name)) continue;
    const other = right.get(name); if (!other) continue;
    assert.ok([...q, ...other].every(Number.isFinite)); const norm = Math.hypot(...q) * Math.hypot(...other); assert.ok(norm > 0);
    maximum = Math.max(maximum, 2 * Math.acos(Math.min(1, Math.abs(q.reduce((sum, value, index) => sum + value * other[index], 0) / norm))));
  }
  return maximum;
}
function continuousPose(before, after) {
  assert.ok(Number.isFinite(before.baseTime) && after.baseTime > before.baseTime);
  const expected = ((before.poseTime + after.baseTime - before.baseTime) % poseDuration + poseDuration) % poseDuration;
  const distance = Math.abs(after.poseTime - expected), phaseError = Math.min(distance, Math.abs(poseDuration - distance));
  assert.ok(phaseError < 0.12, `The selected pose Action keeps its phase (${phaseError}).`);
  return { mixerDelta: after.baseTime - before.baseTime, posePhaseError: phaseError, poseDuration };
}
async function recordIdleReference() {
  idleReference = await pet.evaluate(async duration => {
    const samples = [], started = performance.now(); let previous;
    while (performance.now() - started < duration * 2000 + 5000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const canvas = document.querySelector('#stage canvas'), frame = JSON.parse(canvas?.dataset.chatGesture ?? '{}'), feedback = JSON.parse(canvas?.dataset.moodFeedback ?? '{}');
      const poseTime = JSON.parse(canvas?.dataset.motionTransition ?? '{}').layerTimes?.pose;
      const directInput = { phase: feedback.phase ?? null, active: feedback.activeContact ?? null, hover: feedback.hover ?? null };
      if (directInput.phase !== 'idle' || directInput.active !== false || directInput.hover !== 0) return { samples, interference: { ...frame, directInput } };
      if (!Number.isFinite(frame.baseTime) || !Number.isFinite(poseTime) || frame.baseTime === previous) continue;
      if (frame.active || frame.blocked) throw new Error('Idle reference cannot include a chat overlay or blocked pose.');
      previous = frame.baseTime; samples.push({ baseTime: frame.baseTime, poseTime, arms: frame.arms, directInput });
      if (samples.length > 1024) throw new Error('Idle reference exceeded bounded frame count.');
      if (samples.length > 1 && frame.baseTime - samples[0].baseTime >= duration + 0.05) return { samples, interference: null };
    }
    throw new Error('The actual idle Action did not complete its reference cycle.');
  }, poseDuration).then(result => { if (result.interference) requireDirectInputClear(result.interference, 'idle reference'); return result.samples; });
  assert.ok(idleReference.length >= 60 && idleReference.at(-1).baseTime - idleReference[0].baseTime >= poseDuration);
}
function restoredAtPhase(frame) {
  assert.ok(idleReference.length);
  const phaseDistance = sample => { const distance = Math.abs(sample.poseTime - frame.poseTime); return Math.min(distance, Math.abs(poseDuration - distance)); };
  const reference = idleReference.reduce((best, sample) => phaseDistance(sample) < phaseDistance(best) ? sample : best);
  const phaseError = phaseDistance(reference), armError = armAngle(reference, frame);
  assert.ok(phaseError < 0.12 && armError < 0.025, `Arms restore to the sampled real idle at the same Action phase (${phaseError}, ${armError}).`);
  return { phaseError, armError };
}
async function capture(label) {
  await currentModel();
  const viewport = await pet.locator('#stage canvas').evaluate(canvas => {
    const box = canvas.getBoundingClientRect();
    return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height),
      reserved: [...document.querySelectorAll('.pet-toolbar,.pet-chat,.pet-size-panel,.pet-window-help,.pet-resize-handle,#pet-tooltip,#pet-edit-help,[data-mood-ui],#toast')]
        .map(node => node.getBoundingClientRect().toJSON()).filter(rect => rect.width > 0 && rect.height > 0) };
  });
  const image = await app.evaluate(async ({ BrowserWindow }, viewport) => {
    const win = BrowserWindow.getAllWindows().find(item => new URL(item.webContents.getURL()).searchParams.has('pet'));
    const value = await win.webContents.capturePage({ x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height });
    const size = value.getSize(), pixels = value.toBitmap(); let modelPixels = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      const index = (offset - 3) / 4, x = index % size.width * viewport.width / size.width + viewport.x, y = Math.floor(index / size.width) * viewport.height / size.height + viewport.y;
      if (pixels[offset] > 16 && !viewport.reserved.some(rect => x >= rect.x && x <= rect.right && y >= rect.y && y <= rect.bottom)) modelPixels++;
    }
    return { png: value.toPNG().toString('base64'), width: size.width, height: size.height, modelPixels };
  }, viewport);
  assert.ok(image.modelPixels > 500, 'The application-stage crop contains model pixels outside UI.');
  const filename = `${label}.png`, bytes = Buffer.from(image.png, 'base64'); await writeFile(path.join(output, filename), bytes);
  captures.push({ filename, sha256: sha(bytes), width: image.width, height: image.height, modelPixels: image.modelPixels, state: await state(), visualReview: 'pending' });
}
function registerPlan(gesture, context = 'neutral', options = {}) {
  const serial = ++sequence, text = options.text ?? `原创隔离动作场景${serial}：这是一次${gesture}日常回应。`;
  const plan = { serial, id: null, text, gesture, context, delta: options.delta ?? {}, delayMs: options.delayMs ?? 35 };
  plans.set(text, plan); return plan;
}
async function beginUI(gesture, context = 'neutral', options = {}) {
  requireDirectInputClear(await state(), 'before accepted UI reply');
  const plan = registerPlan(gesture, context, options);
  const starts = await controls.evaluate(() => window.__chatRepairStarted.length), eventStart = await controls.evaluate(() => window.__chatRepairEvents.length);
  await navigateControlPage(controls, 'chat');
  await controls.locator('#chat-input').fill(plan.text); await controls.locator('#send-chat').click();
  await wait(() => controls.evaluate(start => window.__chatRepairStarted.length > start, starts), 'UI submission is accepted by the host');
  const accepted = await controls.evaluate(start => window.__chatRepairStarted[start], starts);
  assert.ok(typeof accepted.id === 'string' && accepted.owner === 'controls'); plan.id = accepted.id;
  return { id: plan.id, eventStart, serial: plan.serial };
}
async function completed(turn, allowError = false) {
  await wait(() => controls.evaluate(turn => window.__chatRepairEvents.slice(turn.eventStart).some(event => event.id === turn.id && ['done', 'error'].includes(event.type)), turn), 'accepted reply completion');
  const events = await controls.evaluate(turn => window.__chatRepairEvents.slice(turn.eventStart).filter(event => event.id === turn.id), turn);
  if (!allowError) assert.ok(!events.some(event => event.type === 'error'), 'The synthetic reply completes without errors.');
  const body = events.filter(event => event.type === 'delta').map(event => event.text).join('');
  assert.ok(!body.includes('<sh-state-') && !body.includes('"gesture"'), 'Split nonce metadata never reaches visible body.');
  return events;
}
async function inactive() { await wait(async () => (await state()).active === false, 'gesture ends'); }
async function active(turn) {
  await completed(turn);
  await wait(async () => { requireDirectInputClear(await state(), 'waiting for host cue'); return !!(await mood()).gesture; }, 'completed reply produces one validated host cue');
  const view = await mood();
  await wait(async () => { const frame = await state(); requireDirectInputClear(frame, 'waiting for model playback'); return frame.active && frame.id === view.gesture.id; }, 'the required model actually binds and plays the cue');
  return view;
}
async function play(label, intent, context = 'neutral', options = {}) {
  const saved = await settings(), disk = await readFile(path.join(profile, 'settings.json')), before = await state(), secondaryBefore = await state(controls); await capture(`${label}-before`);
  const turn = await beginUI(intent, context, options), view = await active(turn), cue = view.gesture;
  assert.equal(cue.intent, options.expectedIntent ?? intent);
  const resource = fixtures[cue.intent]; assert.ok(resource);
  const other = await mood(pet); assert.equal(other.token, view.token); assert.deepEqual(other.gesture, cue);
  const receipt = await Promise.all([controls, pet].map(page => page.evaluate(id => window.__chatRepairCues.some(item => item?.id === id), cue.id)));
  assert.deepEqual(receipt, [true, true]);
  await wait(async () => { const frame = await state(controls); requireDirectInputClear(frame, 'waiting for control preview playback'); return frame.active === true && frame.id === cue.id; }, 'the control preview consumes and plays the same cue');
  const secondaryStart = await state(controls);
  assert.ok(secondaryStart.trackNames.filter(name => /(?:左|右)(?:腕|ひじ|肘|手首)/.test(name)).length >= 4);
  const frames = [], secondaryFrames = []; let middle = false, fading = false;
  const deadline = Date.now() + resource.durationMs + 5000;
  while (Date.now() < deadline) {
    const [frame, secondary] = await Promise.all([state(), state(controls)]); frames.push(frame); secondaryFrames.push(secondary);
    requireDirectInputClear(frame, `${label} pet samples`); requireDirectInputClear(secondary, `${label} control samples`); if (!frame.active) break;
    if (secondary.active) assert.equal(secondary.id, cue.id);
    assert.equal(frame.id, cue.id); assert.equal(frame.blocked, false); assert.equal(frame.blockedReason, null); assert.equal(frame.error, '');
    for (const key of ['packId', 'motionId', 'sha256']) assert.equal(frame[key], resource[key]);
    assert.ok(Math.abs(frame.durationMs - resource.durationMs) < 1);
    assert.ok(frame.trackNames.filter(name => /(?:左|右)(?:腕|ひじ|肘|手首)/.test(name)).length >= 4, 'Actual arm/wrist tracks are bound, beyond a status panel.');
    if (!middle && frame.elapsedMs >= resource.durationMs * 0.35) { await capture(`${label}-middle`); await pause(140); await capture(`${label}-middle-next`); middle = true; }
    fading ||= frame.phase === 'fading'; await pause(90);
  }
  const after = await state(), samples = frames.filter(frame => frame.active); assert.equal(after.active, false);
  assert.ok(middle && fading && samples.length >= 8 && Math.max(...samples.map(frame => frame.elapsedMs)) >= resource.durationMs * 0.85);
  const changes = samples.slice(1).map((frame, index) => armAngle(samples[index], frame));
  const maximumDeparture = Math.max(...samples.map(frame => armAngle(before, frame)));
  assert.ok(changes.filter(angle => angle > 0.004).length >= 4 && maximumDeparture > 0.035, 'Real arms change over the performance, beyond two degrees.');
  const secondarySamples = secondaryFrames.filter(frame => frame.active && frame.id === cue.id);
  const secondaryChanges = secondarySamples.slice(1).map((frame, index) => armAngle(secondarySamples[index], frame));
  assert.ok(secondarySamples.length >= 8 && secondaryChanges.filter(angle => angle > 0.004).length >= 4
    && Math.max(...secondarySamples.map(frame => armAngle(secondaryBefore, frame))) > 0.035, 'The control preview also changes real arm rotations under that one cue.');
  assert.ok(frames.every((frame, index) => !index || frame.baseTime >= frames[index - 1].baseTime));
  const clock = continuousPose(before, after); await wait(async () => (await state(controls)).active === false, 'control preview gesture ends');
  await pause(250); const settled = await state(), secondarySettled = await state(controls);
  const restoration = restoredAtPhase(settled), secondaryRestoration = restoredAtPhase(secondarySettled);
  await capture(`${label}-after`); assert.deepEqual(await settings(), saved); assert.ok((await readFile(path.join(profile, 'settings.json'))).equals(disk));
  assert.equal((await mood()).snapshot.lastInteractionAt, view.snapshot.lastInteractionAt, 'Rendering and the other window mint no reward.');
  performances.push({ label, requestId: turn.id, cue, resource, frames, clock, maximumDeparture, boundTrackCount: samples[0].trackNames.length,
    restoration, secondaryRenderer: { id: secondaryStart.id, active: secondaryStart.active, elapsedMs: secondaryStart.elapsedMs, weight: secondaryStart.weight,
      trackNames: secondaryStart.trackNames, frames: secondaryFrames, restoration: secondaryRestoration }, settingsPreserved: true });
  return { turn, cue };
}
async function activatePose(packId, motionId) {
  await controls.evaluate(({ packId, motionId }) => window.desktop.installMotionPack(packId, motionId, 'pose'), { packId, motionId });
  poseDuration = motionDurations.get(`${packId}/${motionId}`); assert.ok(Number.isFinite(poseDuration) && poseDuration > 0);
}
async function negativePriority(label, layer, packId, motionId, reason) {
  await controls.evaluate(({ packId, motionId, layer }) => window.desktop.installMotionPack(packId, motionId, layer), { packId, motionId, layer });
  if (layer === 'pose') { poseDuration = motionDurations.get(`${packId}/${motionId}`); assert.ok(Number.isFinite(poseDuration) && poseDuration > 0); }
  await ready(reason); const selected = await settings(), before = await state();
  const turn = await beginUI('explain'); await completed(turn); await pause(650);
  const view = await mood(), after = await state(); requireDirectInputClear(after, `${label} negative-priority samples`); assert.ok(view.gesture); assert.equal(after.active, false); assert.equal(after.blockedReason, reason);
  assert.deepEqual(await settings(), selected); const clock = continuousPose(before, after);
  priority.push({ label, requestId: turn.id, consumedCue: view.gesture.id, reason: after.blockedReason, selectedMotionPreserved: true, clock });
  if (layer === 'gesture') await controls.evaluate(() => window.desktop.clearMotionLayer('gesture'));
  else await activatePose('100style-idles', 'neutral-idle');
  await ready(); await pause(350); assert.equal((await state()).active, false, 'Clearing the conflict cannot replay its consumed cue.');
}
async function noLatePlayback(label, cueId, milliseconds = 1100) {
  const deadline = Date.now() + milliseconds, frames = [];
  while (Date.now() < deadline) { const frame = await state(); requireDirectInputClear(frame, label); assert.ok(!frame.active || frame.id !== cueId, `${label}: no old cue replay`); frames.push({ active: frame.active, id: frame.id, baseTime: frame.baseTime, blockedReason: frame.blockedReason, directInput: frame.directInput }); await pause(25); }
  return frames;
}
async function restoreCurrentModel() {
  await app.evaluate(({ dialog }, file) => {
    const qa = globalThis.__chatRepairQA; qa.pick = file;
    if (!qa.originalPicker) { qa.originalPicker = dialog.showOpenDialog; dialog.showOpenDialog = async () => {
      const selected = qa.pick; qa.pick = null; return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] };
    }; }
  }, modelPath);
  await navigateControlPage(controls, 'appearance'); await controls.locator('#import-model').click();
  await wait(() => app.evaluate(() => globalThis.__chatRepairQA.pick === null), 'one authorized model picker result consumed');
  await activatePose('100style-idles', 'neutral-idle'); await ready(); await navigateControlPage(controls, 'chat');
}
async function privacy() {
  const value = await settings(), runtime = await controls.evaluate(() => window.desktop.getRuntimeState()), audio = await controls.evaluate(() => window.desktop.getSystemAudioState());
  assert.equal(value.provider.kind, 'claude'); assert.equal(value.provider.model, claude.model); assert.equal(value.voice.enabled, false); assert.equal(value.voice.volume, 0);
  assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false); assert.equal(audio.active, false);
  for (const page of [controls, pet]) assert.equal(await page.evaluate(() => window.__chatRepairMediaCalls), 0);
  hostEvidence = await app.evaluate(() => { const qa = globalThis.__chatRepairQA; return { externalHttp: qa.externalHttp, permissions: qa.permissions, mediaCalls: qa.mediaCalls, speechCalls: qa.speechCalls, localProviderRequests: qa.localProviderRequests, heldLoads: qa.held.length }; });
  assert.deepEqual(hostEvidence.externalHttp, []); assert.deepEqual(hostEvidence.permissions, []); assert.equal(hostEvidence.mediaCalls, 0); assert.equal(hostEvidence.speechCalls, 0); assert.equal(hostEvidence.heldLoads, 0);
  // Chat never fetches: every reply came from the fake Claude Code process, which saw exactly the declared turns.
  assert.equal(hostEvidence.localProviderRequests, 0); assert.equal(claude.turns.length, requests.length);
  claude.assertClean(); assert.deepEqual((await claude.evidence(app)).denied, []);
  await currentModel(true); assert.equal(await hash(asar), baselineAsarHash); assert.equal(await fingerprint(), baselineSourceHash);
}
async function closeOwned() {
  if (!app) return;
  await app.evaluate(() => { const qa = globalThis.__chatRepairQA; if (qa) { qa.holdPetGesture = false; for (const done of qa.held.splice(0)) done({ cancel: false }); } }).catch(() => {});
  const instance = app; app = null; const child = instance.process(); let timer;
  try { await Promise.race([instance.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned app close timeout.')), 10000); })]); }
  catch (error) {
    errors.push(`close:${safe(error.message)}`);
    if (child.pid && child.exitCode === null) { cleanup.forcedOwnedProcessStop = true;
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }
  } finally { clearTimeout(timer); }
  await wait(() => child.exitCode !== null || child.signalCode !== null, 'owned app process exit', 5000); cleanup.appClosed = true;
}

try {
  assert.equal(process.env.MMD_CHAT_NATIVE_LEASE, '1', 'Obtain the native resource handoff before execution.');
  assert.ok(process.env.MMD_TEST_APP_DIR && process.env.MMD_TEST_EXE && process.env.MMD_TEST_MODEL && /^[a-f0-9]{64}$/i.test(process.env.MMD_CHAT_MODEL_SHA256 ?? ''), 'Frozen app, matching package, current authorized model and its exact hash are mandatory; no fallback.');
  source = await realpath(process.env.MMD_TEST_APP_DIR); executable = await realpath(process.env.MMD_TEST_EXE); modelPath = await realpath(process.env.MMD_TEST_MODEL); requiredModelHash = process.env.MMD_CHAT_MODEL_SHA256.toLowerCase();
  privateStrings.push(source, executable, modelPath, path.dirname(modelPath), workspace);
  const modelInfo = await lstat(modelPath); assert.ok(modelInfo.isFile() && modelInfo.size > 0 && modelInfo.size <= 512 * 1024 * 1024);
  assert.ok(!samePath(source, workspace)); assert.ok(/\.(pmx|pmd)$/i.test(modelPath)); assert.equal(await hash(modelPath), requiredModelHash);
  proof = JSON.parse(await readFile(path.join(path.dirname(source), 'validated.json'), 'utf8'));
  assert.equal(proof.version, 1); assert.ok(Array.isArray(proof.inputs) && proof.inputs.length && /^[a-f0-9]{64}$/.test(proof.sourceHash));
  assert.ok(within(path.dirname(source), executable), 'The package belongs to the supplied frozen candidate.');
  asar = await realpath(path.join(path.dirname(executable), 'resources/app.asar')); privateStrings.push(asar);
  baselineSourceHash = await fingerprint(); baselineAsarHash = await hash(asar); assert.equal(baselineSourceHash, proof.sourceHash); assert.equal(baselineAsarHash, proof.asarSha256);
  manifestIdentity = { sourceHash: proof.sourceHash, asarSha256: baselineAsarHash, harnessSha256: await hash(harnessFile) };
  modelIdentity = { sha256: requiredModelHash, exactRequiredContentVerified: true, modelFallbackAllowed: false };
  const catalog = JSON.parse(await readFile(path.join(source, 'shared/motion-catalog.json'), 'utf8'));
  const stand = await publicMotion(catalog, 'gene', 'stand');
  for (const fixture of Object.values(fixtures)) assert.equal((await publicMotion(catalog, fixture.packId, fixture.motionId)).motion.sha256, fixture.sha256);
  await publicMotion(catalog, '100style-idles', 'neutral-idle'); await publicMotion(catalog, '100style-idles', 'arms-folded-idle'); await publicMotion(catalog, 'mpi-embm-gestures', 'conversation-neutral');
  await evidenceDirectory();
  claude = await createClaudeFixture({ respond: async turn => {
    try {
      const plan = plans.get(turn.currentUser);
      assert.ok(plan, 'Only registered synthetic UI messages reach the fake Claude Code.');
      const marker = turn.nonce('state'); assert.ok(marker && /^[a-f0-9]{32}$/.test(marker));
      requests.push({ planSerial: plan.serial, gesture: plan.gesture, context: plan.context, markerPresent: true });
      const tail = `\n<sh-state-${marker}>${JSON.stringify({ context: plan.context, delta: plan.delta, reason: '原创隔离动作验证', confidence: 0.99, gesture: plan.gesture })}</sh-state-${marker}>`;
      turn.delta('这是本机合成的原创会话动作验证回复。'); await pause(plan.delayMs);
      if (turn.cancelled) return; turn.delta(tail.slice(0, 17)); await pause(35);
      if (turn.cancelled) return; turn.delta(tail.slice(17)); turn.done();
    } catch (error) { fixtureErrors.push(safe(error.message)); throw error; }
  } });
  profile = await mkdtemp(path.join(await realpath(tmpdir()), 'soft-chat-motion-repair-')); privateStrings.push(profile);
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(seed(stand.file)));
  phase = 'launch';
  const env = claude.environment(Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^MMD_|^VITE_DEV_SERVER_URL$|^ELECTRON_RUN_AS_NODE$/.test(name))));
  app = await electron.launch({ executablePath: executable, cwd: source, args: [`--user-data-dir=${profile}`, `--soft-hearts-build=${proof.sourceHash}`], env, timeout: 30000 });
  await claude.install(app); await app.firstWindow();
  identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), build: app.commandLine.getSwitchValue('soft-hearts-build'), pid: process.pid }));
  assert.equal(identity.packaged, true); assert.ok(samePath(await realpath(identity.profile), profile)); assert.ok(samePath(await realpath(identity.appPath), asar)); assert.equal(identity.build, proof.sourceHash); identityVerified = true;
  await app.evaluate(({ session, desktopCapturer }, allowed) => {
    const qa = globalThis.__chatRepairQA = { externalHttp: [], permissions: [], mediaCalls: 0, speechCalls: 0, localProviderRequests: 0, holdPetGesture: false, petId: null, held: [], pick: null, originalPicker: null };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { const value = args[0], url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url);
      // `allowed` is null: chat runs through the fake Claude Code process, so every host fetch is refused.
      if (url.origin !== allowed) { qa.externalHttp.push(url.origin); throw new Error('External provider denied by isolated chat-motion QA.'); }
      qa.localProviderRequests++; return originalFetch(...args);
    };
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { qa.permissions.push(permission); done(false); });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      if (/^(?:https?|wss?):/i.test(details.url) && new URL(details.url).origin !== allowed) { qa.externalHttp.push(new URL(details.url).origin); done({ cancel: true }); return; }
      if (qa.holdPetGesture && details.webContentsId === qa.petId && /^mmd-asset:/i.test(details.url) && decodeURIComponent(new URL(details.url).pathname).endsWith('/speaking-gesture-2.vmd')) { qa.held.push(done); return; }
      done({ cancel: false });
    });
    desktopCapturer.getSources = async () => { qa.mediaCalls++; throw new Error('No desktop sources in isolated chat-motion QA.'); };
  }, origin);
  const watched = new WeakSet(), watch = page => { if (watched.has(page)) return; watched.add(page); page.on('pageerror', error => errors.push(safe(error.message))); page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push(safe(message.text())); }); };
  app.on('window', watch);
  await wait(async () => { for (const page of app.windows()) { watch(page); const url = new URL(page.url()); if (!url.pathname.endsWith('/index.html')) continue; if (url.searchParams.has('pet')) pet = page; else controls = page; } return !!controls && !!pet; }, 'both actual app renderers');
  for (const page of [controls, pet]) {
    page.setDefaultTimeout(20000); await page.waitForFunction(() => !!window.desktop?.getMood && !!document.querySelector('#stage canvas'));
    await page.evaluate(() => {
      window.__chatRepairEvents = []; window.__chatRepairCues = []; window.__chatRepairStarted = []; window.__chatRepairMediaCalls = 0;
      window.desktop.onStream(event => window.__chatRepairEvents.push(event));
      window.desktop.onMood(view => window.__chatRepairCues.push(view.gesture));
      window.desktop.onChatStarted(event => window.__chatRepairStarted.push({ id: event.id, owner: event.owner }));
      if (navigator.mediaDevices) for (const method of ['getUserMedia', 'getDisplayMedia']) Object.defineProperty(navigator.mediaDevices, method, { configurable: true, value: async () => { window.__chatRepairMediaCalls++; throw new Error('No media capture in isolated chat-motion QA.'); } });
      if (window.speechSynthesis) window.speechSynthesis.speak = () => { window.__chatRepairMediaCalls++; throw new Error('No system speech in isolated chat-motion QA.'); };
    });
  }
  await app.evaluate(({ BrowserWindow }) => { globalThis.__chatRepairQA.petId = BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).searchParams.has('pet')).webContents.id; });
  await controls.evaluate(async () => { await window.desktop.setMoodDeveloperMode(true); await window.desktop.setMoodExpressions(true); await window.desktop.recoverPet(); });
  // Arrange only this owned test pet away from the real pointer. Native input
  // remains enabled and the existing per-frame interference guards stay strict.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).searchParams.has('pet'));
    const cursor = screen.getCursorScreenPoint(), bounds = win.getBounds(), margin = 24;
    const candidates = screen.getAllDisplays().flatMap(display => {
      const area = display.workArea;
      return [area.x + margin, area.x + area.width - bounds.width - margin].flatMap(x =>
        [area.y + margin, area.y + area.height - bounds.height - margin].map(y => ({ x, y })));
    });
    const spot = candidates.find(point => cursor.x < point.x - margin || cursor.x > point.x + bounds.width + margin || cursor.y < point.y - margin || cursor.y > point.y + bounds.height + margin);
    if (!spot) throw new Error('No isolated test-window position clear of the current native pointer.');
    win.setPosition(spot.x, spot.y);
  });
  await controls.locator('#frame-full').click();
  await pet.mouse.move(1, 1); await ready();
  fixtureMood = await controls.evaluate(async () => { const view = await window.desktop.getMood(); return { expressions: view.expressions, posture: view.parameters.intensity.posture }; });
  assert.equal(fixtureMood.expressions, true); assert.ok(Number.isFinite(fixtureMood.posture) && fixtureMood.posture > 0);
  if (process.env.MMD_CHAT_HAIR_CROSS === '1') {
    await controls.evaluate(() => window.desktop.setModelPhysicsSettings({ hair: { enabled: true, strength: 0.65 }, chest: { enabled: false }, quality: 'standard' }));
    await wait(() => pet.evaluate(() => {
      const value = JSON.parse(document.querySelector('#stage canvas').dataset.modelPhysics ?? '{}');
      return value.support?.hair?.supported && value.enabled?.hair && value.parts?.hair?.weight >= 0.649 && value.liveObjects > 0;
    }), 'actual current-model hair solver active during chat cross-check', 30000);
    physicsCross = { hairEnabled: true, strength: 0.65, chestEnabled: false, quality: 'standard', actualAllocationAndWeightVerified: true };
  }
  assert.ok((await state()).arms?.filter(([name]) => /^(?:左|右)(?:腕|ひじ|肘|手首)$/.test(name)).length >= 4, 'Required model exposes real standard arm bones.');
  await privacy(); check('01 exact mandatory current-model hash, frozen package identity, two renderers and no speech/media/cloud');

  phase = 'late-clip-load';
  await app.evaluate(() => { globalThis.__chatRepairQA.holdPetGesture = true; });
  const loading = await beginUI('explain'); await completed(loading); const oldCue = (await mood()).gesture; assert.ok(oldCue);
  await wait(() => app.evaluate(() => globalThis.__chatRepairQA.held.length > 0), 'the cold pet gesture resource is actually held');
  await controls.evaluate(id => window.desktop.cancel(id), loading.id); await inactive();
  await app.evaluate(() => { const qa = globalThis.__chatRepairQA; qa.holdPetGesture = false; for (const done of qa.held.splice(0)) done({ cancel: false }); });
  const lateFrames = await noLatePlayback('cancelled late clip', oldCue.id); assert.equal((await mood()).gesture, null);
  check('02 an actually delayed cold resource cannot play a consumed cancelled cue');

  phase = 'compatible-neutral-idle';
  await activatePose('100style-idles', 'neutral-idle'); await ready();
  await recordIdleReference();
  const explain = await play('current-model-explain', 'explain');
  const upbeat = await play('current-model-upbeat', 'upbeat', 'positive', { delta: { D: 3, E: 2 } });
  const consider = await play('current-model-consider', 'consider', 'concern', { delta: { C: 3 } });
  assert.notEqual(explain.cue.id, upbeat.cue.id); assert.notEqual(explain.cue.id, consider.cue.id); assert.notEqual(fixtures.explain.sha256, fixtures.upbeat.sha256);
  assert.ok(consider.cue.strength < explain.cue.strength && consider.cue.strength < upbeat.cue.strength);
  check('03 accepted UI replies drive the required model arms in compatible Neutral Idle; semantics change resource/strength, with phase and recovery');

  phase = 'manual-priority';
  await negativePriority('explicit manual gesture', 'gesture', 'mpi-embm-gestures', 'conversation-neutral', 'manual-gesture');
  await negativePriority('unreviewed dynamic pose', 'pose', '100style-idles', 'arms-folded-idle', 'manual-pose');
  const fresh = await play('after-manual-conflict-fresh-reply', 'explain'); assert.notEqual(fresh.cue.id, explain.cue.id);
  check('04 manual gesture and non-reviewed dynamic pose retain priority with a specific reason; conflict removal never replays an old cue');

  phase = 'cancellation-and-scope';
  const cancel = await beginUI('explain'), cancelView = await active(cancel); await controls.evaluate(id => window.desktop.cancel(id), cancel.id); await inactive(); await noLatePlayback('explicit stop', cancelView.gesture.id, 400);
  const superseded = await beginUI('explain'), supersededView = await active(superseded);
  const replacement = await beginUI('none'); await completed(replacement); await inactive(); await noLatePlayback('new accepted message', supersededView.gesture.id, 400);
  const cleared = await beginUI('explain'), clearedView = await active(cleared); await controls.evaluate(() => window.desktop.newConversation()); await inactive(); await noLatePlayback('new conversation', clearedView.gesture.id, 400);
  const delayed = await beginUI('upbeat', 'positive', { delayMs: 850 });
  await wait(() => controls.evaluate(id => window.__chatRepairEvents.some(event => event.id === id && event.type === 'delta'), delayed.id), 'delayed synthetic body arrived');
  const oldToken = (await mood()).token;
  await controls.evaluate(async () => { const value = await window.desktop.getSettings(); value.model = null; value.motion = null; value.motionLayers = undefined; await window.desktop.saveSettings(value); });
  await wait(async () => (await mood()).token !== oldToken, 'model generation changes the host visual token');
  await completed(delayed, true); await pause(950); assert.equal((await mood()).gesture, null);
  await restoreCurrentModel(); await inactive(); assert.equal((await state()).active, false);
  check('05 explicit stop, new message/scope and delayed reply across a model generation cannot resurrect a cue; same required model is restored');

  phase = 'two-window-race-and-replay';
  requireDirectInputClear(await state(), 'before two-window race');
  const baseRequests = requests.length, startCues = await Promise.all([controls, pet].map(page => page.evaluate(() => window.__chatRepairCues.length)));
  const raceMemoryBefore = await memorySummary();
  const eventStart = await controls.evaluate(() => window.__chatRepairEvents.length);
  const race = ['controls', 'pet'].map(owner => { const plan = registerPlan('explain', 'neutral', { delayMs: 700 }); plan.id = `chat-repair-race-${owner}-${plan.serial}`; return plan; });
  const outcomes = await Promise.all([controls, pet].map((page, index) => page.evaluate(async plan => {
    try { await window.desktop.chat({ id: plan.id, messages: [{ role: 'user', content: plan.text }], attachments: [] }); return { id: plan.id, accepted: true }; }
    catch { return { id: plan.id, accepted: false }; }
  }, race[index])));
  assert.equal(outcomes.filter(item => item.accepted).length, 1);
  const winner = race.find(plan => outcomes.find(item => item.id === plan.id).accepted), winnerTurn = { id: winner.id, eventStart }, winnerView = await active(winnerTurn);
  assert.equal(requests.length, baseRequests + 1);
  const raceMemoryAfter = await memorySummary(); assert.equal(raceMemoryAfter.count, raceMemoryBefore.count + 2);
  assert.deepEqual(raceMemoryAfter.messages.filter(message => message.turnId === winner.id).map(message => message.role).sort(), ['assistant', 'user']);
  const loser = race.find(plan => plan.id !== winner.id); assert.ok(!raceMemoryAfter.messages.some(message => message.turnId === loser.id));
  const uniqueCues = async () => Promise.all([controls, pet].map((page, index) => page.evaluate(start => [...new Set(window.__chatRepairCues.slice(start).filter(Boolean).map(cue => cue.id))], startCues[index])));
  assert.deepEqual(await uniqueCues(), [[winnerView.gesture.id], [winnerView.gesture.id]]); await inactive();
  const replayStart = await controls.evaluate(() => window.__chatRepairEvents.length), beforeReplay = await mood(), beforeReplayRequests = requests.length, beforeReplayMemory = await memorySummary();
  const transportRejected = await controls.evaluate(async winner => { try { await window.desktop.chat({ id: winner.id, messages: [{ role: 'user', content: winner.text }], attachments: [] }); return false; } catch { return true; } }, winner);
  if (!transportRejected) assert.ok((await completed({ id: winner.id, eventStart: replayStart }, true)).some(event => event.type === 'error'));
  assert.equal(requests.length, beforeReplayRequests); assert.equal((await mood()).snapshot.lastInteractionAt, beforeReplay.snapshot.lastInteractionAt);
  assert.deepEqual(await memorySummary(), beforeReplayMemory);
  assert.deepEqual(await uniqueCues(), [[winnerView.gesture.id], [winnerView.gesture.id]]); await noLatePlayback('completed request replay', winnerView.gesture.id);
  const forbidden = await controls.evaluate(async () => { try { await window.desktop.resolveChatGesture('forged', 'forged'); return false; } catch { return true; } }); assert.equal(forbidden, true);
  check('06 two windows accept one provider request and host cue; completed IDs and forged resolution create no playback or reward');

  phase = 'final-integrity'; await privacy(); assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []);
  finalChecksCompleted = true;
  performances.push({ label: 'late-load-cancellation', consumedCueId: oldCue.id, lateFrames }, { label: 'two-window-race', outcomes, winnerCueId: winnerView.gesture.id, providerRequests: requests.length - baseRequests,
    memoryCounts: [raceMemoryBefore.count, raceMemoryAfter.count, beforeReplayMemory.count], completedReplayAddsNoMemory: true });
} catch (error) {
  failure = safe(error.stack ?? error); failureKind = error.code ?? 'technical-check-failure'; process.exitCode = 1; console.error(`${phase}: ${safe(error.message)}`);
  if (pet && controls) failureState = { pet: await state().catch(() => null), controls: await state(controls).catch(() => null) };
  if (pet && controls) await capture('failure-stage').catch(() => {});
} finally {
  await closeOwned().catch(error => { errors.push(`cleanup:${safe(error.message)}`); process.exitCode = 1; });
  // serverClosed keeps its report key: the synthetic chat fixture (now the fake Claude Code) has fully stopped.
  if (claude) { const fake = await claude.close(); cleanup.serverClosed = fake.fakeClaudeExited && fake.claudeHomeEmpty; } else cleanup.serverClosed = true;
  if (profile && cleanup.appClosed) {
    try { const resolved = await realpath(profile), temporary = await realpath(tmpdir());
      assert.ok(samePath(path.dirname(resolved), temporary) && path.basename(resolved).startsWith('soft-chat-motion-repair-') && samePath(resolved, profile));
      await rm(resolved, { recursive: true, force: true }); cleanup.profileRemoved = true;
    } catch (error) { errors.push(`profile-cleanup:${safe(error.message)}`); process.exitCode = 1; }
  }
  if (outputReady) {
    const technicalChecksPassed = finalChecksCompleted && !failure && errors.length === 0 && fixtureErrors.length === 0 && cleanup.appClosed && !cleanup.forcedOwnedProcessStop && cleanup.profileRemoved && cleanup.serverClosed;
    const report = { status: technicalChecksPassed ? 'REVIEW_PENDING' : 'FAILED', scope: 'current-authorized-model-chat-motion-repair', technicalChecksPassed, runId, phase,
      failure, failureKind, failureState, identity: identityVerified ? { packaged: identity.packaged, pid: identity.pid, build: identity.build, explicitTemporaryProfileVerified: true, packagedAsarVerified: true } : null,
      manifest: manifestIdentity, model: modelIdentity, fixtureMood, physicsCross, idleReference, checks, performances, priority, captures, hostEvidence, errors, fixtureErrors, fixtureInterference,
      requests: requests.map(request => ({ ...request, acceptedRequestId: [...plans.values()].find(plan => plan.serial === request.planSerial)?.id ?? null })), cleanup,
      limits: { normalProfileRead: false, normalExpressionSettingsVerified: false, realCurrentProviderTested: false, actualCodexInvoked: false, speechOrMediaUsed: false, subjectiveNaturalnessApproved: false, physicalInputTested: false,
        visualReview: 'pending; root must inspect the actual current-model upper-arm/wrist start, body and restore captures',
        selectedPose: 'Stand reference followed by exact curated Neutral Idle; normal user pose identity is separately verified by root, not assumed here',
        observations: 'Controlled Electron UI/CDP/native app-stage crops, not desktop screenshots or physical-input acceptance',
        deduplication: 'A completed request ID cannot replay; fresh request IDs are new accepted turns, not regeneration identity',
        initialization: 'only synthetic saved settings; no automatic model fallback; guards installed immediately after owned launch' } };
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, checks: checks.length, captures: captures.length, cleanup }));
    if (!technicalChecksPassed) process.exitCode = 1;
  }
}
