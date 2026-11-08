import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Isolated profile; MMD_TEST_SILENT=1 skips all generated test tones.
// No raw audio or desktop frames are saved (the optional screenshot is the app's stage only).
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const silent = process.env.MMD_TEST_SILENT === '1';
const output = path.join(workspace, '.local/system-audio-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
delete env.ELECTRON_RUN_AS_NODE;
const checked = [], skipped = [], errors = [];
let instance, controls, pet;
let phase = 'launch', report, concurrentMedia;
async function poll(fn, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(`Timeout during ${phase}`);
}
const state = () => pet.evaluate(() => window.desktop.getSystemAudioState());
const sampleState = () => pet.evaluate(() => ({
  captures: window.__audioQA.streams.map(stream => stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }))),
  contexts: window.__audioQA.contexts.map(context => context.state),
  reads: window.__audioQA.reads, maxRms: window.__audioQA.maxRms,
  nativeRequests: window.__audioQA.nativeRequests,
}));
async function toggle() {
  await pet.mouse.move(30, 30);
  await pet.locator('#pet-system-audio-sharing').click({ force: true });
}
async function released() {
  await poll(async () => !(await state()).active);
  await poll(async () => {
    const value = await sampleState();
    return value.contexts.every(entry => entry === 'closed') && value.captures.flat().every(track => track.state === 'ended');
  });
}
try {
  const options = process.env.MMD_TEST_EXE
    ? { executablePath: process.env.MMD_TEST_EXE, args: [] } : { args: [appDirectory] };
  options.args.push(`--user-data-dir=${profile}`);
  instance = await electron.launch({ ...options, cwd: appDirectory, env, timeout: 30000 });
  const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  instance.on('window', watch);
  await instance.firstWindow();
  await poll(async () => {
    controls = instance.windows().find(page => /index\.html/.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => /index\.html/.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return !!controls && !!pet;
  });
  for (const page of instance.windows()) watch(page);
  await pet.waitForSelector('#pet-system-audio-sharing');
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), profile);
  assert.deepEqual(await state(), { active: false });
  const before = await controls.evaluate(() => window.desktop.getSettings());
  const persistedBefore = await readFile(path.join(profile, 'settings.json'), 'utf8');
  await pet.evaluate(() => {
    const qa = window.__audioQA = {
      streams: [], contexts: [], reads: 0, maxRms: 0, nativeRequests: 0,
      holdNext: false, held: false, releaseCapture: null, denyNext: false,
    };
    const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async options => {
      if (qa.denyNext) { qa.denyNext = false; throw new DOMException('QA capture denial', 'NotAllowedError'); }
      const hold = qa.holdNext; qa.holdNext = false;
      qa.nativeRequests++;
      const stream = await capture(options); qa.streams.push(stream);
      if (hold) {
        qa.held = true;
        await new Promise(resolve => { qa.releaseCapture = resolve; });
        qa.held = false; qa.releaseCapture = null;
      }
      return stream;
    };
    const BaseContext = window.AudioContext;
    window.AudioContext = class extends BaseContext { constructor(...args) { super(...args); qa.contexts.push(this); } };
    const read = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (samples) {
      read.call(this, samples);
      let energy = 0; for (const value of samples) energy += value * value;
      qa.reads++; qa.maxRms = Math.max(qa.maxRms, Math.sqrt(energy / samples.length));
    };
  });
  phase = 'default and permission boundaries';
  assert.equal(await controls.evaluate(async () => { try { await window.desktop.setSystemAudioSharing(true); return false; } catch { return true; } }), true);
  assert.equal(await pet.evaluate(async () => { try { await navigator.mediaDevices.getUserMedia({ audio: true }); return false; } catch { return true; } }), true);
  assert.deepEqual(await state(), { active: false });
  checked.push(phase);

  phase = 'real loopback start and compatibility video release';
  await toggle();
  await poll(async () => (await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed')) === 'true');
  await poll(async () => (await sampleState()).reads >= 5);
  const started = await sampleState();
  assert.equal(started.captures.length, 1);
  assert.ok(started.captures[0].some(track => track.kind === 'audio' && track.state === 'live'));
  assert.ok(started.captures[0].filter(track => track.kind === 'video').every(track => track.state === 'ended'));
  assert.equal(started.contexts[0], 'running');
  checked.push(phase);

  phase = 'generated system music reaches the real analyser';
  if (silent) {
    skipped.push({ check: phase, reason: 'MMD_TEST_SILENT=1: real loopback start and analyser reads are checked; audible/nonzero RMS is not retested.' });
  } else {
    await navigateControlPage(controls, 'appearance');
    await controls.evaluate(async () => {
      const context = window.__testMusic = new AudioContext();
      await context.resume();
      for (let beat = 0; beat < 10; beat++) {
        const time = context.currentTime + 0.2 + beat * 0.45;
        const tone = context.createOscillator(), gain = context.createGain();
        tone.frequency.value = beat < 5 ? 90 : 660;
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.06, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.25);
        tone.connect(gain); gain.connect(context.destination);
        tone.start(time); tone.stop(time + 0.3);
      }
    });
    await poll(async () => (await sampleState()).maxRms > 0.012);
    await pet.waitForTimeout(4700);
    assert.ok((await pet.locator('#pet-media-indicator').textContent()).includes('本机'));
    await pet.locator('#stage').screenshot({ path: path.join(output, 'music-stage.png') });
    await controls.evaluate(async () => { await window.__testMusic.close(); });
    checked.push(phase);
  }
  const observed = await sampleState();

  phase = 'manual stop releases tracks and audio context';
  await toggle();
  await released();
  const stoppedReads = (await sampleState()).reads;
  await pet.waitForTimeout(250);
  assert.equal((await sampleState()).reads, stoppedReads);
  assert.equal(await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed'), 'false');
  checked.push(phase);

  phase = 'rapid cancel never overlaps native capture and a late real stream is released';
  const requestsBeforeHold = (await sampleState()).nativeRequests;
  await pet.evaluate(() => { window.__audioQA.holdNext = true; });
  await toggle();
  await poll(() => pet.evaluate(() => window.__audioQA.held));
  await toggle();
  await poll(async () => !(await state()).active);
  await toggle();
  await poll(async () => (await pet.locator('#toast').textContent()).includes('上一轮系统声音连接仍在结束'));
  assert.equal((await sampleState()).nativeRequests, requestsBeforeHold + 1);
  assert.equal(await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed'), 'false');
  await pet.evaluate(() => { window.__audioQA.releaseCapture(); });
  await released();
  await pet.waitForTimeout(100);
  assert.equal((await sampleState()).nativeRequests, requestsBeforeHold + 1, 'no automatic restart after the late real stream settles');
  await toggle();
  await poll(async () => (await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed')) === 'true');
  assert.equal((await sampleState()).nativeRequests, requestsBeforeHold + 2);
  await toggle(); await released();
  checked.push(phase);

  phase = 'injected capture denial reports its stage, revokes the grant and allows a real retry';
  const requestsBeforeDenial = (await sampleState()).nativeRequests;
  await pet.evaluate(() => { window.__audioQA.denyNext = true; });
  await toggle();
  await poll(async () => /系统声音采集被拒绝.*采集；NotAllowedError/.test(await pet.locator('#toast').textContent()));
  await released();
  assert.equal(await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed'), 'false');
  assert.equal((await sampleState()).nativeRequests, requestsBeforeDenial, 'the synthetic denial must not invoke native capture');
  await toggle();
  await poll(async () => (await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed')) === 'true');
  assert.equal((await sampleState()).nativeRequests, requestsBeforeDenial + 1);
  await toggle(); await released();
  checked.push(phase);

  phase = 'host hide revokes active capture';
  await toggle();
  await poll(async () => (await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed')) === 'true');
  const petId = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /[?&]pet(?:[=&]|$)/.test(win.webContents.getURL())).id);
  await instance.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).hide(), petId);
  await poll(async () => !(await state()).active);
  await poll(async () => (await sampleState()).captures.flat().every(track => track.state === 'ended'));
  await instance.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).show(), petId);
  checked.push(phase);

  phase = 'synthetic silent microphone and real loopback can be enabled together';
  await pet.evaluate(() => {
    const qa = window.__audioQA;
    const original = navigator.mediaDevices.getUserMedia;
    const context = new AudioContext(), source = context.createConstantSource();
    const destination = context.createMediaStreamDestination();
    source.offset.value = 0; source.connect(destination); source.start();
    const fixture = qa.silentMic = { context, source, stream: destination.stream, requests: 0 };
    qa.restoreMicrophone = async () => {
      navigator.mediaDevices.getUserMedia = original;
      qa.restoreMicrophone = null;
      source.stop(); source.disconnect(); destination.disconnect();
      for (const track of destination.stream.getTracks()) track.stop();
      if (context.state !== 'closed') await context.close();
    };
    navigator.mediaDevices.getUserMedia = async options => {
      if (options?.audio && !options.video) {
        fixture.requests++;
        await context.resume();
        return destination.stream;
      }
      return original.call(navigator.mediaDevices, options);
    };
  });
  await pet.mouse.move(30, 30);
  await pet.locator('#pet-voice-input').click({ force: true });
  await poll(async () => (await pet.evaluate(() => window.desktop.getRuntimeState())).voiceInput);
  await poll(async () => (await pet.locator('#pet-voice-state').textContent()).includes('正在聆听'));
  await toggle();
  await poll(async () => (await pet.locator('#pet-system-audio-sharing').getAttribute('aria-pressed')) === 'true');
  const simultaneous = await pet.evaluate(async () => ({
    runtime: await window.desktop.getRuntimeState(),
    system: await window.desktop.getSystemAudioState(),
    micRequests: window.__audioQA.silentMic.requests,
    microphoneLive: window.__audioQA.silentMic.stream.getAudioTracks().some(track => track.readyState === 'live'),
    loopbackLive: window.__audioQA.streams.at(-1).getAudioTracks().some(track => track.readyState === 'live'),
  }));
  assert.equal(simultaneous.runtime.voiceInput, true);
  assert.equal(simultaneous.runtime.voiceOwner, 'pet');
  assert.equal(simultaneous.system.active, true);
  assert.equal(simultaneous.micRequests, 1, 'only the silent WebAudio microphone adapter is used');
  assert.equal(simultaneous.microphoneLive, true);
  assert.equal(simultaneous.loopbackLive, true);
  await pet.waitForTimeout(1000);
  assert.ok((await pet.locator('#pet-voice-state').textContent()).includes('正在聆听'), 'zero input must remain below the VAD threshold');
  await toggle();
  await pet.locator('#pet-voice-input').click({ force: true });
  await poll(async () => {
    const runtime = await pet.evaluate(() => window.desktop.getRuntimeState());
    return !runtime.voiceInput && runtime.voiceOwner === null;
  });
  await poll(() => pet.evaluate(() => window.__audioQA.silentMic.stream.getTracks().every(track => track.readyState === 'ended')));
  await pet.evaluate(async () => { await window.__audioQA.restoreMicrophone(); });
  await released();
  concurrentMedia = { microphone: 'synthetic silent WebAudio; no physical device', loopback: 'real native capture', bothGrantsActive: true, allTracksAndContextsReleased: true };
  checked.push(phase);

  phase = 'no settings, mic or vision context persisted';
  const runtime = await pet.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(runtime.voiceInput, false); assert.equal(runtime.cameraSharing, false); assert.equal(runtime.screenSharing, false);
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSettings()), before);
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), persistedBefore);
  assert.deepEqual(errors, []);
  checked.push(phase);
  report = { passed: true, checked, skipped, audio: observed, concurrentMedia, audibleRmsRetested: !silent, errors };
} catch (error) { report = { passed: false, phase, checked, skipped, concurrentMedia, audibleRmsRetested: false, error: String(error), errors }; process.exitCode = 1; }
finally {
  if (pet && !pet.isClosed()) await pet.evaluate(() => { window.__audioQA?.releaseCapture?.(); }).catch(() => {});
  if (pet && !pet.isClosed()) await pet.evaluate(async () => {
    if (!window.__audioQA?.restoreMicrophone) return;
    try { await window.desktop.setRuntimeState({ voiceInput: false }); }
    finally { await window.__audioQA.restoreMicrophone(); }
  }).catch(() => {});
  if (controls && !controls.isClosed()) await controls.evaluate(async () => { await window.__testMusic?.close(); }).catch(() => {});
  if (instance) await instance.close().catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
