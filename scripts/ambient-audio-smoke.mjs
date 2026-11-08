import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';

// PREPARED QA: execute only after receiving the project's native/build slot.
// No normal profile, real microphone, desktop video, real ASR or cloud TTS.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, '.local/ambient-audio-smoke');
const withComments = process.env.MMD_TEST_AMBIENT_COMMENTS === '1';
const deriveLyrics = process.env.MMD_TEST_DERIVE_LYRICS === '1';
const AUDIO_READY_MS = 30_000;
const NORMAL_SPEECH_INTERVAL_MS = 30 * 60_000;
const PUBLIC_PERSONA = '公开声音样例说话克制温和，关心时自然直接，喜欢先认真听完再作简短回应。';
const PUBLIC_COMMENT = '这段歌声里的牵挂很轻，我想再陪你听一会儿。';
const samples = [
  { code: 'zh', text: '这是公开的中文歌词片段。', mode: 'music' },
  { code: 'ja', text: 'これは公開の日本語の台詞です。', mode: 'movie' },
  { code: 'en', text: 'This is a public English dialogue sample.', mode: 'movie' },
];
const checked = [], remaining = [], failures = [], pageErrors = [];
const fixture = { queue: [], asr: [], asrCalls: 0, unexpectedAsrRequests: 0, chatRequests: 0, commentRequests: 0, commentPersona: false, commentAudio: false, held: new Set(), lastAsrAt: 0 };
const totals = { captures: 0, maxLiveCaptures: 0, microphoneRequests: 0, controlCaptures: 0, ttsRequests: 0, remoteRequests: 0 };
let instance, controls, pet, profile, profileReal, origin, phase = 'prepare';
let report = { status: 'FAIL', phase: 'not-started', checked, remaining, failures };
let initialAsarHash = null;
let commentReadinessEvidence = null;
let automaticCommentEvidence = null, lyricsDerivationEvidence = null;
let currentProcess, ownedAppClosed = true;
const cleanup = { appClosed: false, serverClosed: false, profileRemoved: false, profileRetained: false };
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function poll(predicate, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(60); }
  throw new Error(`Timed out: ${label}`);
}
function asrBody(entry) {
  const count = Math.ceil(entry.sampleCount / 64_000);
  return { text: entry.text, ...(entry.code ? { language: entry.code,
    language_detection: { version: 2, source: 'sensevoice-model', mode: 'auto', scope: 'subwindow-observations',
      sample_rate: 16000, sample_count: entry.sampleCount, raw_language: `<|${entry.code}|>`, has_text: true,
      windows: Array.from({ length: count }, (_, index) => ({ start_sample: Math.floor(entry.sampleCount * index / count),
        end_sample: Math.floor(entry.sampleCount * (index + 1) / count), raw_language: `<|${entry.code}|>`, raw_event: '<|Speech|>', has_text: true })),
      languages: [entry.code], window_analysis: 'complete' } }
    : { language: 'chinese' }) };
}
// Chat (ordinary replies and ambient comments) goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs);
// the local HTTP fixture below now serves only speech recognition.
const claude = await createClaudeFixture({ respond: turn => {
  assert.equal(turn.model, claude.model);
  const prompt = turn.text;
  if (prompt.includes('<external-audio-data>') && prompt.includes('只输出JSON对象')) {
    fixture.commentRequests++; fixture.commentPersona ||= prompt.includes(PUBLIC_PERSONA); fixture.commentAudio ||= prompt.includes(samples[0].text);
    return JSON.stringify({ comment: PUBLIC_COMMENT });
  }
  fixture.chatRequests++;
  const marker = prompt.match(/<sh-state-[a-f0-9]+>/u)?.[0]; assert.ok(marker, 'ordinary chat must use its existing validated mood protocol');
  const meta = marker + JSON.stringify({ context: 'positive', delta: {}, reason: 'public audio response fixture', confidence: 0.99, gesture: 'none' }) + marker.replace('<', '</');
  return '我听见了，会记得你刚才真正表达的想法。\n' + meta;
} });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw new Error('Fixture body too large'); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    if (pathname === '/v1/audio/transcriptions') {
      fixture.asrCalls++;
      const form = await new Request('http://127.0.0.1/asr', { method: 'POST', headers: request.headers, body }).formData();
      assert.equal(form.get('model'), 'sensevoice-fixture'); assert.equal(form.get('response_format'), 'verbose_json');
      assert.equal(form.get('language_detection_mode'), 'sensevoice-windows-v2');
      assert.equal(form.has('language'), false, 'ambient detection must not send a forced language hint');
      const file = form.get('file'); assert.ok(file && typeof file.arrayBuffer === 'function');
      const audio = Buffer.from(await file.arrayBuffer());
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.readUInt32LE(24), 16000);
      assert.equal(audio.readUInt16LE(22), 1); assert.equal(audio.readUInt16LE(34), 16);
      assert.equal(audio.readUInt32LE(40), audio.length - 44); assert.ok(audio.length > 44 && audio.length <= 384_044);
      assert.ok(audio.subarray(44).some(value => value !== 0), 'real PCM tap must receive the synthetic sound');
      const queued = fixture.queue.shift();
      if (!queued) fixture.unexpectedAsrRequests++;
      assert.ok(queued, 'no ASR request is allowed without a queued fixture');
      const entry = { ...queued, sampleCount: audio.readUInt32LE(40) / 2 };
      fixture.lastAsrAt = Date.now();
      const receipt = { code: entry.code ?? 'unknown', bytes: audio.length, pcmSha256: hash(audio.subarray(44)), held: !!entry.hold, aborted: false };
      fixture.asr.push(receipt);
      response.on('close', () => { if (!response.writableEnded) receipt.aborted = true; fixture.held.delete(response); });
      if (entry.hold) { fixture.held.add(response); response.__fixtureEntry = entry; return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(asrBody(entry))); return;
    }
    response.writeHead(404); response.end('Unknown local fixture endpoint.');
  } catch { if (!response.headersSent) response.writeHead(500); response.end('Local fixture rejected its request.'); }
});
function releaseHeld() {
  for (const response of [...fixture.held]) {
    fixture.held.delete(response);
    if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(asrBody(response.__fixtureEntry))); }
  }
}
async function pagesReady() {
  await instance.firstWindow();
  await poll(async () => {
    controls = instance.windows().find(page => /index\.html(?:\?|$)/u.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => /index\.html(?:\?|$)/u.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return controls && pet && await controls.evaluate(() => !!window.desktop);
  }, 'public application windows');
  assert.equal(await realpath(await instance.evaluate(({ app }) => app.getPath('userData'))), profileReal, 'test must own its physical profile');
  await poll(() => instance.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter(win => /index\.html(?:\?|$)/u.test(win.webContents.getURL()));
    return windows.length === 2 && windows.every(win => !win.webContents.isLoadingMainFrame());
  }), 'initial loads settled');
  for (const [kind, page] of [['controls', controls], ['pet', pet]]) page.on('pageerror', error => pageErrors.push({ kind, hash: hash(error.message).slice(0, 16) }));
}
async function installGuards() {
  await instance.evaluate(({ session }, allowedOrigin) => {
    const qa = globalThis.__ambientHostQA = { remote: 0, tts: 0, ttsRequests: [] };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const allowed = details.url.startsWith(allowedOrigin + '/'); if (!allowed) qa.remote++;
      callback({ cancel: !allowed });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://tts-fixture.invalid/api/v1/services/audio/tts/SpeechSynthesizer') {
        qa.tts++;
        const payload = JSON.parse(init.body);
        if (typeof payload.input?.text !== 'string') throw new Error('Missing mock TTS text.');
        qa.ttsRequests.push({ at: Date.now(), text: payload.input.text });
        const data = Buffer.alloc(3 * 24000 * 2).toString('base64');
        return new Response(`data: ${JSON.stringify({ output: { audio: { data }, finish_reason: 'stop' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (!url.startsWith(allowedOrigin + '/')) { qa.remote++; throw new Error('External network disabled by isolated fixture.'); }
      return originalFetch(input, init);
    };
  }, origin);
  for (const page of [controls, pet]) await page.evaluate(() => {
    window.__ambientNativeDenied = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__ambientNativeDenied++; throw new Error('Fixture never opens a physical microphone or camera.'); };
    const playback = window.__ambientPlaybackQA = { sources: [], speechEvents: [] };
    window.__ambientSettingsQA = { voiceEnabled: null, volume: null };
    window.desktop.onSettings(settings => { window.__ambientSettingsQA = { voiceEnabled: settings.voice.enabled, volume: settings.voice.volume }; });
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (...args) {
      const node = createSource.apply(this, args), context = this;
      const nativeStart = node.start, nativeStop = node.stop;
      let record;
      node.start = function (...startArgs) {
        nativeStart.apply(this, startArgs);
        record = { at: Date.now(), endedAt: null, stopAt: null,
          capture: window.__ambientQA?.captures.some(value => value.context === context) ?? false,
          sampleRate: node.buffer?.sampleRate, samples: node.buffer?.length, duration: node.buffer?.duration,
          silentPcm: !!node.buffer && Array.from({ length: node.buffer.numberOfChannels }, (_, channel) =>
            node.buffer.getChannelData(channel).every(value => value === 0)).every(Boolean) };
        playback.sources.push(record);
      };
      node.stop = function (...stopArgs) { if (record) record.stopAt = Date.now(); return nativeStop.apply(this, stopArgs); };
      node.addEventListener('ended', () => { if (record) record.endedAt = Date.now(); }, { once: true });
      return node;
    };
    window.desktop.onSpeechEvent(event => playback.speechEvents.push({ at: Date.now(), id: event.id, type: event.type }));
  });
  await controls.evaluate(() => {
    window.__ambientControlCaptures = 0;
    navigator.mediaDevices.getDisplayMedia = async () => { window.__ambientControlCaptures++; throw new Error('Only the pet fixture may supply a synthetic stream.'); };
  });
  await pet.evaluate(() => {
    const qa = window.__ambientQA = { captures: [], calls: 0, maxLive: 0, committed: [], offers: [], speechCues: [], constraints: [], states: [] };
    navigator.mediaDevices.getDisplayMedia = async options => {
      qa.calls++; qa.constraints.push({ audio: options.audio === true, video: options.video === true });
      const context = new AudioContext(), destination = context.createMediaStreamDestination();
      await context.resume();
      const item = { context, destination, stream: destination.stream, sources: new Set() }; qa.captures.push(item);
      qa.maxLive = Math.max(qa.maxLive, qa.captures.filter(value => value.stream.getAudioTracks().some(track => track.readyState === 'live')).length);
      // Destination is a MediaStreamAudioDestinationNode, never the speaker destination.
      return destination.stream;
    };
    qa.play = async (seconds = 0.65) => {
      const item = [...qa.captures].reverse().find(value => value.stream.getAudioTracks().some(track => track.readyState === 'live'));
      if (!item) throw new Error('No owned synthetic stream is active.');
      const buffer = item.context.createBuffer(1, Math.round(item.context.sampleRate * seconds), item.context.sampleRate);
      const data = buffer.getChannelData(0); for (let index = 0; index < data.length; index++) data[index] = 0.14 * Math.sin(index * 2 * Math.PI * 240 / item.context.sampleRate);
      const source = item.context.createBufferSource(); source.buffer = buffer; source.connect(item.destination); item.sources.add(source);
      await new Promise(resolve => { source.onended = () => { source.disconnect(); item.sources.delete(source); resolve(); }; source.start(); });
    };
    qa.dispose = async () => {
      for (const item of qa.captures) {
        for (const source of item.sources) { try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
        item.sources.clear(); for (const track of item.stream.getTracks()) track.stop(); item.destination.disconnect();
        if (item.context.state !== 'closed') await item.context.close();
      }
    };
    window.desktop.onAmbientCommentOffer(value => qa.offers.push({ id: value.id, sessionId: value.sessionId, text: value.text }));
    window.desktop.onAmbientCommentCommitted(value => qa.committed.push({ id: value.id, text: value.text }));
    window.desktop.onAmbientAudioState(value => qa.states.push({ at: Date.now(), active: value.active, suspended: value.suspended, sessionId: value.sessionId }));
    window.desktop.onMood(view => {
      const cue = view.snapshot.cue;
      if (!cue || cue.kind !== 'speech' || qa.speechCues.some(value => value.id === cue.id)) return;
      qa.speechCues.push({ id: cue.id, at: cue.at, source: cue.source ? { ...cue.source } : null,
        boredom: view.snapshot.boredom, speechIntervalMs: view.parameters.frequency.speechIntervalMs });
      qa.speechCues = qa.speechCues.slice(-16);
    });
  });
}
async function launch() {
  const environment = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete environment.ELECTRON_RUN_AS_NODE;
  instance = await electron.launch({ ...(process.env.MMD_TEST_EXE ? { executablePath: path.resolve(process.env.MMD_TEST_EXE), args: [`--user-data-dir=${profile}`] }
    : { args: [appDirectory, `--user-data-dir=${profile}`] }), cwd: appDirectory, env: environment, timeout: 30_000 });
  currentProcess = instance.process(); ownedAppClosed = false;
  await claude.install(instance);
  await pagesReady(); await installGuards();
}
async function closeApp() {
  if (!instance) return;
  if (pet && !pet.isClosed()) {
    await pet.evaluate(async () => {
      await window.desktop.stopAmbientAudio().catch(() => {});
      await window.desktop.setSystemAudioSharing(false).catch(() => {});
      await window.__ambientQA?.dispose?.();
    }).catch(() => {});
    const browserCounts = await pet.evaluate(() => ({ captures: window.__ambientQA.calls, maxLive: window.__ambientQA.maxLive, devices: window.__ambientNativeDenied })).catch(() => null);
    if (browserCounts) { totals.captures += browserCounts.captures; totals.maxLiveCaptures = Math.max(totals.maxLiveCaptures, browserCounts.maxLive); totals.microphoneRequests += browserCounts.devices; }
  }
  if (controls && !controls.isClosed()) totals.controlCaptures += await controls.evaluate(() => window.__ambientControlCaptures + window.__ambientNativeDenied).catch(() => 0);
  const hostCounts = await instance.evaluate(() => globalThis.__ambientHostQA).catch(() => null);
  if (hostCounts) { totals.ttsRequests += hostCounts.tts; totals.remoteRequests += hostCounts.remote; }
  await instance.close();
  await poll(() => currentProcess.exitCode !== null || currentProcess.signalCode !== null, 'owned Electron exited', 20_000);
  ownedAppClosed = true; instance = controls = pet = null;
}
const state = () => pet.evaluate(() => window.desktop.getAmbientAudioState());
const records = query => controls.evaluate(value => window.desktop.listAmbientTranscripts(value), query ?? {});
const audioStats = () => pet.evaluate(() => ({ calls: window.__ambientQA.calls, maxLive: window.__ambientQA.maxLive,
  live: window.__ambientQA.captures.filter(value => value.stream.getAudioTracks().some(track => track.readyState === 'live')).length }));
async function setAutomaticVoice(enabled) {
  await controls.evaluate(async value => {
    const settings = await window.desktop.getSettings();
    settings.voice = { ...settings.voice, enabled: value, volume: 0 };
    await window.desktop.saveSettings(settings);
  }, enabled);
  await poll(async () => (await controls.locator('#voice-enabled').isChecked()) === enabled
    && await pet.evaluate(value => window.__ambientSettingsQA.voiceEnabled === value && window.__ambientSettingsQA.volume === 0, enabled),
  'public voice setting reached controls and the pet settings subscription');
  const settings = await controls.evaluate(() => window.desktop.getSettings());
  assert.equal(settings.voice.enabled, enabled); assert.equal(settings.voice.volume, 0);
}
async function visibleReplyText(text) {
  await poll(async () => {
    const reply = instance.windows().find(page => page.url().endsWith('#soft-hearts-reply'));
    if (!reply) return false;
    const nativeVisible = await instance.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const owner = windows.find(win => /index\.html(?:\?|$)/u.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'));
      const bubble = windows.find(win => win.webContents.getURL().endsWith('#soft-hearts-reply'));
      return !!owner && !!bubble && owner.isVisible() && !owner.isMinimized() && bubble.isVisible()
        && !bubble.isMinimized() && bubble.getOpacity() > 0 && bubble.getParentWindow() === owner;
    });
    return nativeVisible && reply.evaluate(expected => {
      const element = document.getElementById('reply-body'); if (!element) return false;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), body = getComputedStyle(document.body);
      return !document.hidden && document.visibilityState === 'visible' && element.textContent === expected
        && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible'
        && Number(style.opacity) > 0 && body.display !== 'none' && body.visibility === 'visible' && Number(body.opacity) > 0;
    }, text);
  }, 'actual auxiliary reply window visibly contains the complete comment');
}
async function automaticCommentPlayback(session, baseline) {
  await poll(async () => (await instance.evaluate(() => globalThis.__ambientHostQA.ttsRequests)).length > baseline.requests,
    'automatic comment dispatched actual mock-provider TTS');
  const requests = (await instance.evaluate(() => globalThis.__ambientHostQA.ttsRequests)).slice(baseline.requests);
  assert.deepEqual(requests.map(value => value.text), [PUBLIC_COMMENT], 'the automatic request must contain the exact accepted comment');
  const playback = () => pet.evaluate(from => ({ sources: window.__ambientPlaybackQA.sources.slice(from.sources),
    events: window.__ambientPlaybackQA.speechEvents.slice(from.events), states: window.__ambientQA.states }), baseline);
  await poll(async () => (await playback()).sources.some(value => !value.capture), 'real automatic AudioBufferSourceNode.start');
  await visibleReplyText(PUBLIC_COMMENT);
  assert.equal((await state()).suspended, true, 'host suspension must cover actual automatic playback');
  const live = await playback(), audioEvent = live.events.find(value => value.type === 'audio');
  assert.ok(audioEvent);
  await poll(async () => (await playback()).events.some(value => value.id === audioEvent.id && value.type === 'done'), 'transport done precedes final PCM drain');
  const source = live.sources.find(value => !value.capture);
  assert.equal(source.sampleRate, 24000); assert.equal(source.samples, 72_000); assert.equal(source.silentPcm, true);
  assert.equal(source.endedAt, null, 'the automatic source must still be draining after transport completion');
  const asrBefore = fixture.asrCalls;
  await pet.evaluate(() => window.__ambientQA.play()); await delay(200);
  assert.equal(fixture.asrCalls, asrBefore, 'automatic comment audio cannot create a transcription request');
  await poll(async () => { const value = (await playback()).sources.find(item => !item.capture); return !!value && value.endedAt !== null; }, 'real automatic source ended naturally');
  const final = await playback(), sources = final.sources.filter(value => !value.capture);
  assert.equal(sources.length, 1); assert.equal(sources[0].stopAt, null, 'automatic playback must end naturally, not by cancellation');
  assert.ok(sources[0].endedAt - sources[0].at >= 2900);
  await poll(async () => !(await state()).suspended, 'source suspension releases after final automatic PCM drain');
  await poll(async () => (await playback()).states.some(value => value.sessionId === session.sessionId && !value.suspended && value.at >= sources[0].endedAt),
    'final source release reached the real state subscription');
  const states = (await playback()).states.filter(value => value.sessionId === session.sessionId && value.at >= requests[0].at - 1000);
  const suspendedAt = states.findIndex(value => value.suspended);
  assert.ok(suspendedAt >= 0);
  const released = states.slice(suspendedAt + 1).find(value => !value.suspended);
  assert.ok(released && released.at >= sources[0].endedAt, 'no suspended=false may precede the real final ended event');
  await delay(650); assert.equal(fixture.asrCalls, asrBefore, 'TTS tail guard must not replay withheld sound');
  assert.equal((await instance.evaluate(() => globalThis.__ambientHostQA.ttsRequests)).length, baseline.requests + 1);
  return { exactAutomaticCommentText: true, auxiliaryReplyVisibleWithFullText: true, automaticRequests: 1,
    actualBufferSourceStarted: true, actualNaturalEnded: true, silentPcm: true,
    playbackMilliseconds: sources[0].endedAt - sources[0].at, suspensionThroughFinalPcm: true, noEchoAsrRequest: true };
}
async function deriveVerifiedLyricsInExistingPet() {
  // This optional branch reuses the already-authorized QA pet. It never launches
  // another app, fetches a source, opens a device, or creates a speaker context.
  const directory = path.resolve(workspace, '../../../.local/ambient-audio-development/fixtures/lyrics-fixture');
  const sourceName = 'twinkle-little-star-dcoetzee-original.ogg';
  const derivedName = 'twinkle-little-star-dcoetzee-en-sung-000-010-16k-mono.wav';
  const sourceSha256 = '0a9b05a0929699e30cf5f6f124c6e05251ed1505e2a5eb954746e7cd6a6c2f40';
  const manifestPath = path.join(directory, 'manifest.json');
  assert.equal(await realpath(directory), directory);
  for (const name of ['manifest.json', sourceName]) {
    const info = await lstat(path.join(directory, name));
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.isFile(), true);
    assert.ok(info.size <= (name === sourceName ? 15 * 1024 * 1024 : 64 * 1024));
  }
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.fixtureId, 'twinkle-little-star-dcoetzee-en-sung');
  assert.equal(manifest.source.file, sourceName); assert.equal(manifest.source.sha256, sourceSha256);
  assert.equal(manifest.source.reviewedVersionId, 503543089);
  assert.equal(manifest.rights.performanceAndRecording.licenseId, 'CC0-1.0');
  assert.equal(manifest.rights.lyrics.status, 'public-domain-original-English-lyrics');
  const original = await readFile(path.join(directory, sourceName));
  assert.equal(original.length, 2_884_672); assert.equal(hash(original), sourceSha256);
  const rendered = await pet.evaluate(async encoded => {
    if (typeof OfflineAudioContext !== 'function') return { unsupported: true };
    const binary = atob(encoded), input = new Uint8Array(binary.length);
    for (let index = 0; index < input.length; index++) input[index] = binary.charCodeAt(index);
    const context = new OfflineAudioContext({ numberOfChannels: 1, length: 160_000, sampleRate: 16000 });
    let decoded;
    try { decoded = await context.decodeAudioData(input.buffer); }
    catch (error) { if (error?.name === 'NotSupportedError' || error?.name === 'EncodingError') return { unsupported: true }; throw error; }
    if (decoded.numberOfChannels !== 1 || decoded.sampleRate !== 16000 || Math.abs(decoded.duration - 125.68192708333333) > 0.01)
      throw new Error('Verified lyric source decoded with unexpected metadata.');
    const source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination); source.start(0, 0, 10);
    const output = await context.startRendering(); source.disconnect();
    const samples = output.getChannelData(0), wav = new Uint8Array(44 + samples.length * 2), view = new DataView(wav.buffer);
    const ascii = (offset, value) => { for (let index = 0; index < value.length; index++) wav[offset + index] = value.charCodeAt(index); };
    ascii(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index++) {
      if (!Number.isFinite(samples[index])) throw new Error('Nonfinite lyric PCM sample.');
      const value = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
    }
    let data = ''; for (let offset = 0; offset < wav.length; offset += 32768) data += String.fromCharCode(...wav.subarray(offset, offset + 32768));
    return { wav: btoa(data), decodedDurationSeconds: decoded.duration, userAgent: navigator.userAgent };
  }, original.toString('base64'));
  if (rendered.unsupported) {
    remaining.push({ check: 'verified-sung-lyrics-pcm-derivation', reason: 'This existing pet does not support offline Vorbis decoding; original source retained, no generated substitute or tool installation.' });
    return { status: 'pending-offline-decoder', recognitionTested: false };
  }
  const wav = Buffer.from(rendered.wav, 'base64');
  assert.equal(wav.length, 320_044); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320_000); assert.ok(wav.subarray(44).some(value => value !== 0));
  const derived = { file: derivedName, bytes: wav.length, sha256: hash(wav), pcmSha256: hash(wav.subarray(44)),
    sourceSha256, sourceStartSeconds: 0, sourceEndSeconds: 10, durationSeconds: 10, sampleRateHz: 16000, channels: 1, bitsPerSample: 16,
    tool: 'Chromium OfflineAudioContext in existing isolated QA pet', userAgent: rendered.userAgent,
    options: { numberOfChannels: 1, length: 160000, sampleRate: 16000, sourceStart: [0, 0, 10],
      pcm16: 'clamp[-1,1], round(negative*32768; otherwise*32767), signed little-endian', decodeEntireBoundedOriginal: true },
    decodedDurationSeconds: rendered.decodedDurationSeconds, audibleOutput: false, extraAppOrServiceLaunches: 0,
    lyricAlignmentVerified: false, recognitionTested: false };
  const target = path.join(directory, derivedName);
  let existing;
  try { const info = await lstat(target); assert.equal(info.isSymbolicLink(), false); assert.equal(info.isFile(), true); assert.equal(info.size, wav.length); existing = await readFile(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) assert.equal(hash(existing), derived.sha256, 'an existing different excerpt must never be overwritten');
  if (manifest.derived) { assert.equal(manifest.derived.file, derivedName); assert.equal(manifest.derived.sourceSha256, sourceSha256); assert.equal(manifest.derived.sha256, derived.sha256); }
  assert.equal(hash(await readFile(manifestPath)), hash(manifestBytes), 'fixture manifest changed during offline rendering');
  if (!existing) await writeFile(target, wav, { flag: 'wx' });
  manifest.derived = derived; manifest.status = 'derived-ready-unrecognized';
  manifest.validation.pcmDerivation = 'complete-offline-audio-context'; manifest.validation.durationAtMost12Seconds = true;
  manifest.validation.preparationCountersScope = 'Existing zero app/service/ASR counters describe the original download preparation; derived records the later existing-pet offline conversion separately.';
  manifest.plannedDerivation.status = 'superseded-by-recorded-offline-derivation'; delete manifest.plannedDerivation.pendingReason;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  checked.push('verified CC0 singing source derived offline to ten-second 16 kHz mono PCM16');
  return { status: 'derived-ready-unrecognized', bytes: derived.bytes, sha256: derived.sha256, pcmSha256: derived.pcmSha256,
    durationSeconds: 10, extraAppOrServiceLaunches: 0, audibleOutput: false, recognitionTested: false };
}
async function startPurpose(mode) {
  await pet.bringToFront();
  const panel = pet.locator('#ambient-audio-controls');
  if (!await panel.locator('.ambient-audio-panel').isVisible()) await pet.locator('#pet-system-audio-sharing').click({ force: true });
  await panel.getByRole('button', { name: mode === 'music' ? '听音乐' : '陪看电影', exact: true }).click();
  const before = (await audioStats()).calls;
  await panel.getByRole('button', { name: '开始理解', exact: true }).click();
  await poll(async () => { const value = await state(); return value.active && value.mode === mode && (await audioStats()).live === 1; }, 'explicit purpose start');
  assert.equal((await audioStats()).calls, before + 1, 'purpose start must use one existing-capture acquisition, not a second ASR capture');
  return state();
}
async function stopPurpose() {
  await pet.locator('#ambient-audio-controls').getByRole('button', { name: '停止理解', exact: true }).click();
  await poll(async () => !(await state()).active && (await audioStats()).live === 0, 'understanding and tracks stop');
}
async function playEntry(entry) {
  await poll(() => Date.now() - fixture.lastAsrAt >= 2300, 'host minimum ASR interval');
  fixture.queue.push(entry); const before = fixture.asr.length;
  await pet.evaluate(() => window.__ambientQA.play());
  await poll(() => fixture.asr.length === before + 1, 'real PCM tap reached mock ASR');
  if (!entry.hold) await poll(async () => (await records({ query: entry.text })).total === 1, 'successful final text archived');
}
async function profileArchive() { return JSON.parse(await readFile(path.join(profile, 'system-audio-transcripts.json'), 'utf8')); }
function assertNormalAudioBudget(mood) {
  assert.equal(mood.parameters.boredom.speechAt, 75, 'the fixture must not lower the generic boredom speech threshold');
  assert.equal(mood.parameters.frequency.speechIntervalMs, NORMAL_SPEECH_INTERVAL_MS);
  assert.equal(mood.parameters.frequency.speechPerHour, 2); assert.equal(mood.parameters.frequency.speechWithoutReply, 1);
  assert.ok(mood.snapshot.boredom < 75, 'audio readiness must be tested below the generic boredom threshold');
}
async function waitForAudioSourceReadiness(session) {
  const captures = (await audioStats()).calls;
  const captureObservedAt = Date.now();
  assert.ok(session.active && session.mode === 'music' && Number.isSafeInteger(session.startedAt));
  assertNormalAudioBudget(await controls.evaluate(() => window.desktop.getMood()));
  await poll(async () => {
    const current = await state(), audio = await audioStats();
    assert.equal(current.sessionId, session.sessionId); assert.equal(current.active, true); assert.equal(current.suspended, false);
    assert.equal(audio.calls, captures); assert.equal(audio.live, 1);
    assert.equal(fixture.asr.length, 0, 'the fresh source observation is deliberately sent after stable readiness');
    assert.equal(fixture.commentRequests, 0, 'stable silence alone grants no source-specific comment');
    assert.equal(await pet.evaluate(() => window.__ambientQA.offers.length), 0);
    return Date.now() - captureObservedAt >= AUDIO_READY_MS;
  }, 'thirty seconds of explicit stable understanding without a source observation', AUDIO_READY_MS + 5000);
  assertNormalAudioBudget(await controls.evaluate(() => window.desktop.getMood()));
}

try {
  await mkdir(output, { recursive: true });
  if (process.env.MMD_TEST_EXE)
    initialAsarHash = hash(await readFile(path.join(path.dirname(path.resolve(process.env.MMD_TEST_EXE)), 'resources', 'app.asar')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-ambient-smoke-')); profileReal = await realpath(profile);
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1,
    provider: claude.provider,
    voiceInput: { baseUrl: origin + '/v1', model: 'sensevoice-fixture', language: '', apiKey: '' },
    voice: { enabled: false, voiceURI: '', volume: 0, rate: 1 },
    pet: { visible: true, alwaysOnTop: false, clickThrough: false, followMouse: false, fps: 24, breath: 0, scale: 1 },
  }));
  phase = 'isolated public profile setup'; await launch();
  await controls.evaluate(async ({ origin, persona, provider }) => {
    await window.desktop.useBundledModel();
    const before = await window.desktop.getCharacterCards();
    const saved = await window.desktop.saveCharacterCard({ name: '公开声音验收角色', description: '', personality: persona,
      scenario: '', greeting: '', examples: '', systemPrompt: '' });
    const card = saved.cards.find(value => !before.cards.some(previous => previous.id === value.id));
    if (!card) throw new Error('Public fixture card missing.'); await window.desktop.activateCharacterCard(card.id);
    const settings = await window.desktop.getSettings();
    settings.provider = { ...settings.provider, ...provider };
    settings.voiceInput = { baseUrl: origin + '/v1', model: 'sensevoice-fixture', language: '', apiKey: '' };
    settings.voice = { ...settings.voice, enabled: false, volume: 0 };
    settings.tts = { provider: 'bailian', apiHost: 'https://tts-fixture.invalid', region: 'fixture', model: 'qwen-audio-3.1-tts-flash',
      voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, apiKey: 'public-fixture-only', introduced: true, styleBindings: [] };
    await window.desktop.saveSettings(settings);
  }, { origin, persona: PUBLIC_PERSONA, provider: claude.provider });
  await closeApp();
  await launch();
  assert.equal((await controls.evaluate(() => window.desktop.getSettings())).model?.name, 'gene.pmx');
  assert.equal((await state()).active, false); assert.equal((await records()).total, 0);
  checked.push(phase);
  if (deriveLyrics) {
    phase = 'optional verified singing fixture offline PCM derivation';
    lyricsDerivationEvidence = await deriveVerifiedLyricsInExistingPet();
  }

  phase = 'opening purpose menu does not capture or transcribe';
  await pet.bringToFront(); await pet.locator('#pet-system-audio-sharing').click({ force: true });
  await pet.locator('#ambient-audio-controls').getByRole('button', { name: '陪看电影', exact: true }).click();
  await delay(300); assert.equal((await audioStats()).calls, 0); assert.equal(fixture.asr.length, 0); assert.equal((await state()).active, false);
  const foreignDenied = await controls.evaluate(async () => { try { await window.desktop.beginAmbientAudio('music'); return false; } catch { return true; } });
  assert.equal(foreignDenied, true); checked.push(phase);

  phase = 'music purpose real PCM tap and sourced Chinese lyrics archive';
  const musicSession = await startPurpose('music');
  let automaticBaseline;
  if (withComments) {
    phase = 'audio-source readiness preserves low boredom and the normal thirty-minute speech budget';
    await waitForAudioSourceReadiness(musicSession); checked.push(phase);
    phase = 'explicit public automatic voice setup before the fresh first transcript';
    await setAutomaticVoice(true);
    automaticBaseline = { requests: (await instance.evaluate(() => globalThis.__ambientHostQA.ttsRequests)).length,
      ...await pet.evaluate(() => ({ sources: window.__ambientPlaybackQA.sources.length, events: window.__ambientPlaybackQA.speechEvents.length })) };
    assert.equal(automaticBaseline.requests, 0); checked.push(phase);
    phase = 'music purpose real PCM tap and fresh sourced Chinese lyrics archive';
  }
  await playEntry(samples[0]);
  const chinese = (await records({ query: samples[0].text })).records[0];
  assert.equal(chinese.mode, 'music'); assert.deepEqual(chinese.language, { status: 'detected', language: 'zh', source: 'provider' });
  assert.equal((await profileArchive()).responses.length, 0, 'ASR is not a user response'); checked.push(phase);

  phase = 'real source-specific proactive cue, visible pet acknowledgement, both archives and actual user response';
  if (withComments) {
    await poll(async () => (await controls.evaluate(id => window.desktop.readAmbientComments(id), chinese.id)).some(value => value.text === PUBLIC_COMMENT), 'real cue through displayed pet acknowledgement', 45_000);
    automaticCommentEvidence = await automaticCommentPlayback(musicSession, automaticBaseline);
    const speechCue = await pet.evaluate(({ sessionId, observationId }) => window.__ambientQA.speechCues.find(value =>
      value.source?.kind === 'ambient' && value.source.sessionId === sessionId && value.source.observationId === observationId),
    { sessionId: musicSession.sessionId, observationId: chinese.id });
    assert.ok(speechCue, 'the accepted opportunity must name the exact host-accepted audio observation');
    assert.ok(speechCue.at - musicSession.startedAt >= AUDIO_READY_MS); assert.ok(speechCue.at >= chinese.endedAt);
    assert.ok(speechCue.boredom < 75); assert.equal(speechCue.speechIntervalMs, NORMAL_SPEECH_INTERVAL_MS);
    assertNormalAudioBudget(await controls.evaluate(() => window.desktop.getMood()));
    commentReadinessEvidence = { stableMilliseconds: AUDIO_READY_MS, cueAfterSessionMilliseconds: speechCue.at - musicSession.startedAt,
      exactSourceObservation: true, boredomBelowGenericThreshold: true, speechIntervalMilliseconds: NORMAL_SPEECH_INTERVAL_MS };
    await visibleReplyText(PUBLIC_COMMENT);
    const comments = await controls.evaluate(id => window.desktop.readAmbientComments(id), chinese.id); assert.equal(comments.length, 1);
    const memory = await controls.evaluate(text => window.desktop.listMemories({ query: text }), PUBLIC_COMMENT);
    const initiative = memory.records.find(value => value.origin?.sources.includes('ambient')); assert.ok(initiative);
    const body = await controls.evaluate(id => window.desktop.readMemory(id), initiative.id);
    assert.ok(body.messages.some(value => value.role === 'assistant' && value.content === PUBLIC_COMMENT));
    assert.equal((await profileArchive()).responses.length, 0);
    await setAutomaticVoice(false);
    const ttsBeforeUserReply = (await instance.evaluate(() => globalThis.__ambientHostQA.ttsRequests)).length;
    const asrBeforeUserReply = fixture.asrCalls;
    await navigateControlPage(controls, 'chat');
    await controls.locator('#chat-input').fill('我很喜欢这首歌里克制的表达。'); await controls.locator('#chat-input').press('Enter');
    await poll(async () => (await profileArchive()).responses.length === 1, 'actual accepted user response receipt');
    await poll(() => controls.evaluate(() => !document.getElementById('send-chat').classList.contains('hidden')), 'ordinary user reply completed without automatic voice');
    assert.equal((await instance.evaluate(() => globalThis.__ambientHostQA.ttsRequests)).length, ttsBeforeUserReply);
    assert.equal(fixture.asrCalls, asrBeforeUserReply);
    assert.ok(fixture.commentRequests >= 1 && fixture.commentPersona && fixture.commentAudio);
    checked.push(phase);
    remaining.push({ check: 'transient-long-term-candidate-introspection', reason: 'No test RPC is added. Native user-response receipt is checked; exact candidate classification remains covered by pure store tests.' });
  } else remaining.push({ check: phase, reason: 'Prepared optional MMD_TEST_AMBIENT_COMMENTS=1 fixture; no cue/ack/candidate native result is claimed by the default run.' });

  phase = 'silence does not create ASR work';
  const quietCount = fixture.asrCalls; await delay(1300); assert.equal(fixture.asrCalls, quietCount); checked.push(phase);
  phase = 'actual silent TTS playback excludes system-audio transcription';
  await navigateControlPage(controls, 'providers'); await controls.locator('#tts-preview').click();
  await poll(async () => (await state()).suspended, 'actual host TTS suspension');
  const duringSpeech = fixture.asrCalls; await pet.evaluate(() => window.__ambientQA.play()); await delay(800);
  assert.equal(fixture.asrCalls, duringSpeech);
  await poll(async () => !(await state()).suspended, 'actual TTS completion'); await delay(650);
  assert.equal(fixture.asrCalls, duringSpeech, 'preview final drain and tail cannot replay audio to ASR');
  assert.ok((await instance.evaluate(() => globalThis.__ambientHostQA)).tts >= 1, 'the TTS gate must come from actual mock-provider synthesis');
  checked.push(phase);

  phase = 'movie purpose Japanese and English original text with tag search/read';
  await stopPurpose(); await startPurpose('movie');
  await playEntry(samples[1]); await playEntry(samples[2]);
  for (const sample of samples.slice(1)) {
    const record = (await records({ query: sample.text })).records[0]; assert.equal(record.mode, 'movie');
    assert.deepEqual(record.language, { status: 'detected', language: sample.code, source: 'provider' });
    assert.equal((await controls.evaluate(id => window.desktop.readAmbientTranscript(id), record.id)).text, sample.text);
  }
  await navigateControlPage(controls, 'memory'); await controls.locator('#ambient-transcript-query').fill(samples[1].text);
  await controls.locator('#ambient-transcript-search').click();
  await poll(async () => (await controls.locator('#ambient-transcript-list [data-record-id]').count()) === 1, 'history search UI');
  await controls.locator('#ambient-transcript-list [data-record-id]').click();
  assert.equal(await controls.locator('#ambient-transcript-original').textContent(), samples[1].text);
  assert.equal((await records({ tag: 'movie' })).total, 2); checked.push(phase);

  phase = 'stop aborts delayed ASR and its late response cannot append';
  await playEntry({ code: 'en', text: 'This delayed text must never appear.', hold: true });
  const beforeStop = (await records()).total; await stopPurpose(); releaseHeld(); await delay(400);
  assert.equal((await records()).total, beforeStop); assert.equal((await records({ query: 'delayed text' })).total, 0); checked.push(phase);
  assert.ok((await audioStats()).maxLive <= 1);

  phase = 'explicit history delete removes source and linked comments';
  await controls.locator('#ambient-transcript-query').fill(samples[0].text); await controls.locator('#ambient-transcript-search').click();
  await poll(async () => (await controls.locator('#ambient-transcript-list [data-record-id]').count()) === 1, 'delete selection');
  await controls.locator('#ambient-transcript-list [data-record-id]').click();
  await controls.locator('#ambient-transcript-delete').click();
  await controls.locator('#ambient-transcript-delete').click();
  await poll(async () => (await records({ query: samples[0].text })).total === 0, 'confirmed original deletion');
  assert.deepEqual(await controls.evaluate(id => window.desktop.readAmbientComments(id), chinese.id), []);
  const persistedIds = (await records()).records.map(value => value.id).sort(); assert.equal(persistedIds.length, 2); checked.push(phase);

  phase = 'restart retains surviving text and deletion, with all media purposes initially off';
  await closeApp(); await launch();
  assert.equal((await state()).active, false); assert.equal((await audioStats()).calls, 0);
  assert.deepEqual((await records()).records.map(value => value.id).sort(), persistedIds);
  assert.equal((await records({ query: samples[0].text })).total, 0);
  const devices = await pet.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(devices.voiceInput, false); assert.equal(devices.cameraSharing, false); assert.equal(devices.screenSharing, false);
  checked.push(phase);
  remaining.push({ check: 'music-versus-movie-visible-motion', reason: 'Purpose state and one capture pipeline are exercised; exact dance enable routing has controller pure tests. Native visual contrast/naturalness needs a separate public-Gene review.' });
  remaining.push({ check: 'real-trilingual-ASR-and-lyrics-quality', reason: 'This run uses generated non-speech PCM and mock sourced language metadata. It is not a language-recognition accuracy test.' });
  assert.deepEqual(pageErrors, []);
  assert.equal(fixture.unexpectedAsrRequests, 0);
  assert.equal(fixture.asrCalls, fixture.asr.length, 'every ASR attempt must reach one validated queued receipt; rejected malformed work is a failure');
  if (withComments) assert.equal(fixture.commentRequests, 1, 'new segments, user reply and purpose changes cannot bypass the normal thirty-minute speech cooldown');
  claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  report = { status: 'PASS', phase: 'complete', checked, remaining, failures, packaged: !!process.env.MMD_TEST_EXE,
    syntheticPcmToRealAudioContextTap: true, mockedAsrRequests: fixture.asr.length, mockedWindowEvidenceV2: true,
    commentFixtureEnabled: withComments, commentReadinessEvidence, automaticCommentEvidence,
    lyricsDerivationEnabled: deriveLyrics, lyricsDerivationEvidence,
    realCloudRequests: 0, realAsrServiceUsed: false, realMicrophoneUsed: false, realDesktopVideoUsed: false,
    normalProfileUsed: false, audibleOutput: false, subjectiveLanguageOrVoiceVerified: false };
} catch (error) {
  failures.push({ phase, kind: error instanceof Error && ['AssertionError', 'Error', 'TimeoutError'].includes(error.name) ? error.name : 'FixtureFailure' });
  report = { status: 'FAIL', phase, checked, remaining, failures, packaged: !!process.env.MMD_TEST_EXE,
    realCloudRequests: 0, normalProfileUsed: false, subjectiveLanguageOrVoiceVerified: false };
  process.exitCode = 1;
} finally {
  try { await closeApp(); } catch { ownedAppClosed = false; process.exitCode = 1; }
  cleanup.appClosed = ownedAppClosed;
  releaseHeld();
  if (server.listening) await new Promise(resolve => server.close(resolve)); cleanup.serverClosed = true;
  { const fake = await claude.close(); cleanup.fakeClaudeExited = fake.fakeClaudeExited && fake.claudeHomeEmpty; if (!cleanup.fakeClaudeExited) process.exitCode = 1; }
  if (profile && ownedAppClosed) {
    try {
      const current = await realpath(profile), temp = await realpath(os.tmpdir());
      assert.equal(current, profileReal); assert.equal((await lstat(profile)).isSymbolicLink(), false);
      assert.ok(current.startsWith(temp + path.sep) && path.basename(current).startsWith('soft-hearts-ambient-smoke-'));
      await rm(current, { recursive: true, force: false }); cleanup.profileRemoved = true;
    } catch { cleanup.profileRetained = true; }
  } else if (profile) cleanup.profileRetained = true;
  if (!cleanup.appClosed) { report.status = 'FAIL'; report.failures.push({ phase: 'cleanup', kind: 'OwnedAppStillRunning' }); }
  if (initialAsarHash) {
    try {
      const current = hash(await readFile(path.join(path.dirname(path.resolve(process.env.MMD_TEST_EXE)), 'resources', 'app.asar')));
      if (current !== initialAsarHash) throw new Error('Frozen package identity changed.');
      report.asarSha256 = initialAsarHash; report.frozenPackageUnchanged = true;
    } catch { report.status = 'FAIL'; report.failures.push({ phase: 'package-identity', kind: 'FrozenPackageChanged' }); process.exitCode = 1; }
  }
  report = { ...report, totals, cleanup, pageErrors, executed: true, evidenceScope: 'actual-current-run-only' };
  if (totals.remoteRequests || totals.microphoneRequests || totals.controlCaptures || totals.maxLiveCaptures > 1) { report.status = 'FAIL'; process.exitCode = 1; }
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
