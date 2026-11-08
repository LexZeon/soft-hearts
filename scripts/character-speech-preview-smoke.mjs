import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// PREPARED ONLY: run after the native/build owner explicitly hands over the slot.
// Requires an explicit packaged candidate; never falls back to a daily launcher.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(workspace, '.local/character-speech-preview-smoke', new Date().toISOString().replaceAll(':', '-'));
const marker = randomUUID(), hash = value => createHash('sha256').update(value).digest('hex');
const PANEL = '面板公开样例：语气清楚，节奏平稳，句间停顿紧凑。';
const PREVIEW = '这是一段公开的当前角色试听，我会认真听完，再自然回应。';
const VOICE = 'longanlingxin_v3.1', MODEL = 'qwen-audio-3.1-tts-flash', RATE = 0.9;
const BACKGROUND = '背景：此公开故事条目不应整体成为声音指令。';
const cards = [
  { key: 'reserved', identity: '内敛样例', name: '公开试听内敛样例', source: 'personality', sentence: '内敛样例说话克制含蓄，开心时轻轻表达，不会高声欢呼。' },
  { key: 'outgoing', identity: '外向样例', name: '公开试听外向样例', source: 'personality', sentence: '外向样例说话明快坦率，开心时热情，关心时自然直接。' },
  { key: 'legacy', identity: '旧卡样例', name: '公开试听旧卡样例', source: 'legacy-systemPrompt', sentence: '旧卡样例说话温和含蓄。开心时不会高声欢呼。' },
];
const checked = [], matrix = [], pageErrors = [];
let phase = 'prepare', instance, controls, pet, profile, profileReal, tempReal, exe, appDirectory, asar, asarHash;
let ownedProcess, appClosed = true, fixtureChats = 0, fixtureHttpErrors = 0;
// No HTTP origin is allowed: chat runs through the synthetic Claude Code process.
const origin = null;
const cleanup = { appClosed: false, serverClosed: false, profileRemoved: false };
let report = { status: 'FAIL', checked };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function poll(predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(60); }
  throw new Error(`Timed out: ${label}`);
}
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs): six declared mood turns only.
const claude = await createClaudeFixture({ respond: turn => {
  try {
    assert.ok(fixtureChats < 6, 'only six explicit public mood fixture turns are allowed');
    assert.equal(turn.model, claude.model);
    const stateMarker = turn.text.match(/<sh-state-[a-f0-9]+>/u)?.[0]; assert.ok(stateMarker);
    const last = turn.currentUser;
    const context = last === '公开试听心情 positive' ? 'positive' : last === '公开试听心情 concern' ? 'concern' : null;
    assert.ok(context, 'no background chat or arbitrary prompt is accepted'); fixtureChats++;
    const tail = stateMarker + JSON.stringify({ context, delta: {}, confidence: 0.99, reason: 'public preview fixture', gesture: 'none' }) + stateMarker.replace('<', '</');
    return '公开样例：我会认真听你说完，再陪你把事情做好。\n' + tail;
  } catch (error) {
    fixtureHttpErrors++;
    throw error;
  }
} });

async function launchTarget() {
  assert.ok(process.env.MMD_TEST_EXE && path.isAbsolute(process.env.MMD_TEST_EXE), 'MMD_TEST_EXE must name the explicit candidate executable');
  assert.ok(process.env.MMD_TEST_APP_DIR && path.isAbsolute(process.env.MMD_TEST_APP_DIR), 'MMD_TEST_APP_DIR must name its unpacked application directory');
  exe = await realpath(process.env.MMD_TEST_EXE); appDirectory = await realpath(process.env.MMD_TEST_APP_DIR);
  assert.equal(path.dirname(exe).toLowerCase(), appDirectory.toLowerCase());
  assert.ok((await lstat(exe)).isFile()); assert.ok((await lstat(appDirectory)).isDirectory());
  asar = path.join(appDirectory, 'resources/app.asar'); asarHash = hash(await readFile(asar));
  tempReal = await realpath(os.tmpdir()); profile = await mkdtemp(path.join(tempReal, 'soft-hearts-character-preview-'));
  profileReal = await realpath(profile);
  await writeFile(path.join(profile, 'qa-owner.json'), JSON.stringify({ marker }));
  // Preseed only public settings to keep startup away from the default chat adapter.
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ provider: claude.provider,
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 } }));
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'MMD_TEST_EXE', 'MMD_TEST_APP_DIR']) delete env[key];
  instance = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`, '--disable-background-networking',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1'], cwd: appDirectory, env, timeout: 30000 });
  ownedProcess = instance.process(); appClosed = false;
  await claude.install(instance);
  await instance.firstWindow();
  await poll(async () => {
    controls = instance.windows().find(page => /index\.html(?:\?|$)/u.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => /index\.html(?:\?|$)/u.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return controls && pet && await controls.evaluate(() => !!window.desktop);
  }, 'the two trusted product windows');
  assert.equal(await realpath(await instance.evaluate(({ app }) => app.getPath('userData'))), profileReal);
  const physical = await instance.evaluate(({ app }, expected) => {
    const fs = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')('original-fs');
    if (!app.isPackaged || fs.realpathSync(app.getPath('userData')).toLowerCase() !== expected.profile.toLowerCase()) return false;
    const owner = JSON.parse(fs.readFileSync(expected.profile + '/qa-owner.json', 'utf8'));
    if (owner.marker !== expected.marker) return false;
    fs.writeFileSync(expected.profile + '/qa-physical.json', JSON.stringify({ marker: expected.marker, checked: true }));
    return true;
  }, { profile: profileReal, marker });
  assert.equal(physical, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(profileReal, 'qa-physical.json'), 'utf8')), { marker, checked: true });
  await poll(() => instance.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter(win => /index\.html(?:\?|$)/u.test(win.webContents.getURL()));
    return windows.length === 2 && windows.every(win => !win.webContents.isLoadingMainFrame());
  }), 'initial product loading settled');
  for (const [kind, page] of [['controls', controls], ['pet', pet]]) page.on('pageerror', error => pageErrors.push({ kind, hash: hash(error.message) }));
}

async function installHarness() {
  await instance.evaluate(({ session }, allowedOrigin) => {
    const qa = globalThis.__characterPreviewQA = { requests: [], pending: [], holdNext: false, blocked: 0, permissions: 0 };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const allowed = new URL(details.url).origin === allowedOrigin; if (!allowed) qa.blocked++;
      callback({ cancel: !allowed });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { qa.permissions++; callback(false); });
    const original = globalThis.fetch;
    const makeResponse = () => new Response(`data: ${JSON.stringify({ output: { audio: { data: Buffer.alloc(48000).toString('base64') }, finish_reason: 'stop' } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    qa.release = () => { for (const pending of qa.pending.splice(0)) { pending.detach(); pending.resolve(makeResponse()); } };
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://character-preview-fixture.invalid/api/v1/services/audio/tts/SpeechSynthesizer') {
        if (qa.requests.length >= 16) throw new Error('Public mock request limit reached.');
        if (new Headers(init?.headers).get('authorization') !== 'Bearer public-preview-fixture-key') throw new Error('Fixture credential mismatch.');
        const payload = JSON.parse(String(init?.body));
        const entry = { model: payload.model, input: { ...payload.input }, held: qa.holdNext, aborted: false };
        qa.requests.push(entry); qa.holdNext = false;
        if (!entry.held) return makeResponse();
        return new Promise(resolve => {
          const abort = () => { entry.aborted = true; };
          const detach = () => init.signal?.removeEventListener('abort', abort);
          if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
          // Deliberately release this valid late HTTP result after product cancellation.
          qa.pending.push({ resolve, detach });
        });
      }
      if (new URL(url).origin !== allowedOrigin) { qa.blocked++; throw new Error('Non-fixture network disabled.'); }
      return original(input, init);
    };
  }, origin);
  await controls.context().addInitScript(() => {
    const qa = window.__characterPreviewQA = { sources: [], events: [], chatDone: [], deviceCalls: 0 };
    const sources = new WeakMap(), gains = new WeakMap();
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      if (this instanceof AudioBufferSourceNode && destination instanceof GainNode) gains.set(this, destination);
      return Reflect.apply(connect, this, [destination, ...args]);
    };
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const item = { at: performance.now(), duration: this.buffer?.duration ?? 0, gain: gains.get(this)?.gain.value ?? null, endedAt: null, stoppedAt: null };
      qa.sources.push(item); sources.set(this, item);
      this.addEventListener('ended', () => { item.endedAt = performance.now(); }, { once: true });
      return Reflect.apply(start, this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      const item = sources.get(this); if (item) item.stoppedAt = performance.now();
      return Reflect.apply(stop, this, args);
    };
    for (const method of ['getUserMedia', 'getDisplayMedia']) navigator.mediaDevices[method] = async () => {
      qa.deviceCalls++; throw new Error('No physical or display capture is allowed in this fixture.');
    };
  });
}
const hostState = () => instance.evaluate(() => ({ requests: globalThis.__characterPreviewQA.requests, pending: globalThis.__characterPreviewQA.pending.length,
  blocked: globalThis.__characterPreviewQA.blocked, permissions: globalThis.__characterPreviewQA.permissions }));
const audioState = () => controls.evaluate(() => structuredClone(window.__characterPreviewQA));
const holdNext = () => instance.evaluate(() => { globalThis.__characterPreviewQA.holdNext = true; });
const releaseHeld = () => instance.evaluate(() => globalThis.__characterPreviewQA.release());
async function activate(card) {
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), card.id);
  await poll(() => controls.evaluate(async value => (await window.desktop.getCharacterCards()).activeId === value.id
    && document.querySelector('.emotional-voice-context')?.textContent?.includes(value.name), card), card.key + ' active identity reflected in UI');
  assert.equal(await controls.locator('#tts-voice').inputValue(), VOICE); assert.equal(Number(await controls.locator('#tts-rate').inputValue()), RATE);
}
async function mood(context) {
  const before = (await audioState()).chatDone.length;
  await navigateControlPage(controls, 'chat');
  await controls.locator('#chat-input').fill('公开试听心情 ' + context); await controls.locator('#chat-input').press('Enter');
  await poll(() => controls.evaluate(async value => window.__characterPreviewQA.chatDone.length === value.before + 1
    && (await window.desktop.getMood()).snapshot.context === value.context
    && document.querySelector('#chat-state')?.textContent === '回复完成', { before, context }), 'validated completed ' + context + ' chat');
  await navigateControlPage(controls, 'providers');
}
function assertPayload(payload, card, context, panel = false) {
  assert.equal(payload.model, MODEL); assert.equal(payload.input.voice, VOICE); assert.equal(payload.input.rate, RATE);
  assert.equal(payload.input.text, PREVIEW); assert.equal(payload.input.format, 'pcm'); assert.equal(payload.input.sample_rate, 24000);
  const instruction = payload.input.instruction;
  if (panel) { assert.equal(instruction, PANEL); return; }
  assert.ok(instruction.startsWith('角色口吻参考：\n'));
  for (const sentence of card.sentence.match(/[^。！？]+[。！？]?/gu) ?? []) assert.ok(instruction.includes(sentence));
  const current = instruction.split('\n').find(line => line.startsWith('本轮语气：'));
  assert.ok(current?.includes(context === 'positive' ? '开心和欣喜' : '关心、支持或安慰'));
  assert.ok(instruction.indexOf(card.identity) < instruction.indexOf('本轮语气：'));
  assert.ok(instruction.includes(PANEL)); assert.ok(instruction.length <= 1000); assert.ok(!instruction.includes(BACKGROUND));
  for (const other of cards.filter(other => other.key !== card.key)) assert.ok(!instruction.includes(other.identity));
}
async function startUiPreview(panel = false) {
  await navigateControlPage(controls, 'providers');
  await controls.locator('#tts-preview-text').fill(PREVIEW);
  await controls.locator(panel ? '#tts-preview-panel' : '#tts-preview').click();
}
async function drainSince(before, label) {
  await poll(() => controls.evaluate(count => window.__characterPreviewQA.sources.length === count + 1, before.sources.length), label + ' actual PCM start');
  const during = await audioState(), source = during.sources.at(-1);
  assert.equal(source.gain, 0); assert.equal(source.duration, 1);
  await poll(() => controls.evaluate(offset => {
    const events = window.__characterPreviewQA.events.slice(offset), audio = events.find(event => event.type === 'audio');
    return audio && events.some(event => event.id === audio.id && event.type === 'done');
  }, before.events.length), label + ' network done');
  await poll(() => controls.evaluate(count => window.__characterPreviewQA.sources.length === count + 1
    && window.__characterPreviewQA.sources.at(-1).endedAt !== null && document.querySelector('#tts-playback-status')?.dataset.phase === 'idle', before.sources.length), label + ' PCM natural drain');
  const after = await audioState(), end = after.sources.at(-1), events = after.events.slice(before.events.length);
  const audio = events.find(event => event.type === 'audio'), done = events.find(event => event.id === audio?.id && event.type === 'done');
  assert.ok(done && done.at < end.endedAt, 'network completion must precede the real PCM drain');
  assert.equal(end.stoppedAt, null); assert.ok(end.endedAt - end.at >= 900, 'one-second PCM must not be truncated');
  return { browserStartToEndMs: end.endedAt - end.at, gain: end.gain };
}
async function uiCase(card, context, panel = false) {
  phase = `${card.key}-${panel ? 'panel' : context}`;
  const before = await audioState(), count = (await hostState()).requests.length;
  await startUiPreview(panel); await poll(async () => (await hostState()).requests.length === count + 1, phase + ' actual adapter request');
  const payload = (await hostState()).requests[count]; assertPayload(payload, card, context, panel);
  const timing = await drainSince(before, phase);
  matrix.push({ card: card.key, source: card.source, mode: panel ? 'panel-only' : 'current-character', context,
    instruction: payload.input.instruction, instructionSha256: hash(payload.input.instruction), model: payload.model, voice: payload.input.voice, rate: payload.input.rate, ...timing });
  checked.push(phase + '-actual-ui-preload-host-http-and-player-drain');
}
async function rejectContext(page, id, context) {
  const count = (await hostState()).requests.length;
  await page.evaluate(async value => window.desktop.synthesizeSpeech(value.id, '公开的旧身份检查。', value.context), { id, context });
  await poll(() => page.evaluate(value => window.__characterPreviewQA.events.some(event => event.id === value && event.type === 'error' && !event.cancelled), id), id + ' rejected by real IPC');
  assert.equal((await hostState()).requests.length, count);
  assert.equal(await page.evaluate(value => window.__characterPreviewQA.events.some(event => event.id === value && ['audio', 'done'].includes(event.type)), id), false);
}

try {
  await mkdir(output, { recursive: true });
  await launchTarget(); await installHarness();
  phase = 'public-fixtures';
  const ids = await controls.evaluate(async fixture => {
    await window.desktop.useBundledModel(); const ids = [];
    for (const card of fixture.cards) {
      const previous = await window.desktop.getCharacterCards();
      const saved = await window.desktop.saveCharacterCard({ name: card.name, description: '', personality: card.source === 'personality' ? card.sentence : '',
        scenario: '', greeting: '', examples: '', systemPrompt: card.source === 'legacy-systemPrompt' ? fixture.background.repeat(30) + '\n说话方式：' + card.sentence : '' });
      const current = saved.cards.find(value => !previous.cards.some(old => old.id === value.id)); if (!current) throw new Error('Public fixture card missing.');
      if (card.source === 'legacy-systemPrompt' && (current.personality !== '' || current.description !== '' || !current.systemPrompt.includes(card.sentence)))
        throw new Error('Legacy fixture must retain its actual empty personality and original system prompt.');
      ids.push(current.id);
    }
    await window.desktop.activateCharacterCard(ids[0]);
    const settings = await window.desktop.getSettings(); if (settings.model?.name !== 'gene.pmx') throw new Error('Bundled Gene required.');
    settings.provider = { ...settings.provider, ...fixture.provider };
    settings.voice = { ...settings.voice, enabled: false, volume: 0 };
    settings.tts = { provider: 'bailian', apiHost: 'https://character-preview-fixture.invalid', region: 'public-fixture', model: fixture.model,
      voice: fixture.voice, rate: fixture.rate, emotion: 'custom', instruction: fixture.panel, introduced: true, apiKey: 'public-preview-fixture-key', styleBindings: [] };
    await window.desktop.saveSettings(settings); return ids;
  }, { cards, provider: claude.provider, background: BACKGROUND, model: MODEL, voice: VOICE, rate: RATE, panel: PANEL });
  cards.forEach((card, index) => { card.id = ids[index]; });
  await Promise.all([controls.reload(), pet.reload()]);
  for (const page of [controls, pet]) {
    await page.waitForFunction(() => typeof window.desktop?.prepareCharacterSpeechPreview === 'function');
    await page.evaluate(() => {
      const qa = window.__characterPreviewQA;
      window.desktop.onSpeechEvent(event => qa.events.push({ id: event.id, type: event.type, cancelled: !!event.cancelled, at: performance.now() }));
      window.desktop.onStream(event => { if (event.kind === 'chat' && event.type === 'done') qa.chatDone.push(event.id); });
    });
  }
  await controls.bringToFront(); await navigateControlPage(controls, 'providers');
  assert.equal(await controls.locator('#tts-preview').textContent(), '试听当前角色');
  assert.equal(await controls.locator('#tts-preview-panel').textContent(), '仅试听面板风格');
  checked.push('explicit-packaged-candidate-physical-temporary-profile-and-deny-external-network');
  for (const card of cards) {
    await activate(card);
    for (const context of ['positive', 'concern']) { await mood(context); await uiCase(card, context); }
    await uiCase(card, 'concern', true);
  }

  phase = 'owner-boundary';
  const prepared = await controls.evaluate(() => window.desktop.prepareCharacterSpeechPreview());
  assert.equal(await pet.evaluate(async () => { try { await window.desktop.prepareCharacterSpeechPreview(); return false; } catch { return true; } }), true);
  const ownerBefore = (await hostState()).requests.length, audioBefore = (await audioState()).sources.length;
  await holdNext();
  await controls.evaluate(value => { void window.desktop.synthesizeSpeech('qa-owner-controls', '公开的窗口归属检查。', value).catch(() => {}); }, prepared);
  await poll(async () => (await hostState()).pending === 1 && (await hostState()).requests.length === ownerBefore + 1, 'owned host transport held');
  await rejectContext(pet, 'qa-wrong-owner', prepared);
  await pet.evaluate(() => window.desktop.cancelSpeech('qa-owner-controls'));
  assert.equal((await hostState()).requests[ownerBefore].aborted, false, 'wrong owner may not cancel current host transport');
  await releaseHeld();
  await poll(() => controls.evaluate(() => window.__characterPreviewQA.events.some(event => event.id === 'qa-owner-controls' && event.type === 'done')), 'current owner completed');
  assert.equal((await audioState()).sources.length, audioBefore, 'direct host ownership probe does not create a separate renderer player');
  await controls.evaluate(() => window.desktop.cancelSpeech('qa-owner-controls'));
  await rejectContext(controls, 'qa-consumed-owner-context', prepared);
  checked.push('pet-prepare-denied-wrong-owner-cannot-synthesize-or-cancel-and-consumed-context-rejected');

  phase = 'stop-before-first-pcm';
  const stopBefore = await audioState(), stopCount = (await hostState()).requests.length;
  await holdNext(); await startUiPreview();
  await poll(async () => (await hostState()).pending === 1 && (await hostState()).requests.length === stopCount + 1, 'UI preview awaiting mock HTTP');
  await controls.locator('#tts-stop').click();
  await poll(async () => (await hostState()).requests[stopCount].aborted, 'UI stop cancelled the real host signal');
  await releaseHeld(); await delay(250);
  assert.equal((await audioState()).sources.length, stopBefore.sources.length);
  assert.equal((await audioState()).events.filter(event => event.type === 'audio').length, stopBefore.events.filter(event => event.type === 'audio').length);
  assert.equal(await controls.locator('#tts-playback-status').getAttribute('data-phase'), 'idle');
  checked.push('UI-stop-before-first-pcm-drops-a-valid-late-http-result');

  phase = 'stale-prepared-role';
  await activate(cards[0]); const stale = await controls.evaluate(() => window.desktop.prepareCharacterSpeechPreview());
  await activate(cards[1]); const staleBefore = await audioState(), staleCount = (await hostState()).requests.length;
  await startUiPreview(); await poll(async () => (await hostState()).requests.length === staleCount + 1, 'new role preview reached HTTP');
  assertPayload((await hostState()).requests[staleCount], cards[1], 'concern');
  await poll(() => controls.evaluate(count => window.__characterPreviewQA.sources.length === count + 1, staleBefore.sources.length), 'new role PCM started');
  await rejectContext(controls, 'qa-old-role-preview', stale);
  await drainSince(staleBefore, 'new role survives stale prepared identity');
  checked.push('real-prepared-old-role-context-rejected-without-truncating-new-ui-audio');

  phase = 'late-replaced-role';
  await activate(cards[0]); const replaceBefore = await audioState(), replaceCount = (await hostState()).requests.length;
  await holdNext(); await startUiPreview(); await poll(async () => (await hostState()).pending === 1, 'old role HTTP held');
  assertPayload((await hostState()).requests[replaceCount], cards[0], 'concern');
  await activate(cards[1]); await poll(async () => (await hostState()).requests[replaceCount].aborted, 'role switch aborted old transport');
  await startUiPreview(); await poll(async () => (await hostState()).requests.length === replaceCount + 2, 'replacement role reached HTTP');
  assertPayload((await hostState()).requests[replaceCount + 1], cards[1], 'concern');
  await poll(() => controls.evaluate(count => window.__characterPreviewQA.sources.length === count + 1, replaceBefore.sources.length), 'replacement PCM started');
  await releaseHeld(); await drainSince(replaceBefore, 'late replaced role'); await delay(200);
  assert.equal((await audioState()).sources.length, replaceBefore.sources.length + 1);
  checked.push('role-switch-cancels-held-preview-and-late-result-cannot-replay-over-replacement');

  phase = 'final-checks';
  const host = await hostState(), audio = await audioState();
  assert.equal(host.requests.length, 14); assert.equal(fixtureChats, 6); assert.equal(fixtureHttpErrors, 0);
  claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  assert.equal(audio.sources.length, 11); assert.ok(audio.sources.every(value => value.endedAt !== null && value.stoppedAt === null && value.gain === 0));
  assert.equal(host.pending, 0); assert.equal(host.blocked, 0); assert.equal(host.permissions, 0); assert.deepEqual(pageErrors, []);
  for (const page of [controls, pet]) {
    const state = await page.evaluate(async () => ({ runtime: await window.desktop.getRuntimeState(), system: await window.desktop.getSystemAudioState(),
      ambient: await window.desktop.getAmbientAudioState(), devices: window.__characterPreviewQA.deviceCalls }));
    assert.equal(state.runtime.voiceInput, false); assert.equal(state.runtime.screenSharing, false); assert.equal(state.runtime.cameraSharing, false);
    assert.equal(state.system.active, false); assert.equal(state.ambient.active, false); assert.equal(state.devices, 0);
  }
  const settings = await controls.evaluate(() => window.desktop.getSettings());
  assert.equal(settings.voice.enabled, false); assert.equal(settings.voice.volume, 0); assert.equal(settings.model.name, 'gene.pmx');
  assert.equal(new Set(matrix.map(value => JSON.stringify([value.model, value.voice, value.rate]))).size, 1);
  report = { status: 'PASS', phase, checked, matrix, syntheticTtsRequests: host.requests.length, validatedPublicChatTurns: fixtureChats,
    actualPcmSourceStarts: audio.sources.length, actualPcmNaturalEnds: audio.sources.filter(value => value.endedAt !== null && value.stoppedAt === null).length,
    sameModelVoiceRate: true, volume: 0, networkGuardBlockedRequests: host.blocked, realCloudRequests: 0, normalProfileUsed: false,
    packagedAsarSha256: asarHash, stalePreparedRoleRejected: true, lateStoppedOrReplacedPcmPlayed: false,
    subjectiveListeningVerified: false, actualNormalCardVerified: false, realMusicOrMovieListeningVerified: false,
    pendingPreparePromiseNativeRaceVerified: false,
    limits: ['Public card fixtures and muted mock PCM establish plumbing, not the user\'s actual card or subjective voice quality.',
      'Public APIs cannot deterministically hold the prepare IPC return. Its pending-Promise stop/replace race remains a separate pure-test result.',
      'No real microphone, camera, system audio, ASR, cloud request, permission shortcut or mood parameter mutation.'] };
} catch (error) {
  report = { status: 'FAIL', phase, checked, matrix, failureType: error?.name ?? 'Error', failureSha256: hash(String(error?.message ?? error)), pageErrors };
  process.exitCode = 1;
} finally {
  if (instance) {
    await controls?.evaluate(async () => { document.querySelector('#tts-stop')?.click(); await window.desktop.cancelSpeech('qa-owner-controls').catch(() => {}); }).catch(() => {});
    await releaseHeld().catch(() => {});
    let closeTimer;
    await Promise.race([instance.close(), new Promise((_resolve, reject) => {
      closeTimer = setTimeout(() => reject(new Error('Owned close timeout.')), 15000);
    })]).catch(() => {}).finally(() => clearTimeout(closeTimer));
    if (ownedProcess && ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
      try { ownedProcess.kill(); } catch { /* It may have exited between the check and kill. */ }
    }
    if (ownedProcess) await poll(() => ownedProcess.exitCode !== null || ownedProcess.signalCode !== null, 'owned candidate exit', 20000).then(() => { appClosed = true; }).catch(() => {});
    cleanup.appClosed = appClosed;
  }
  // serverClosed keeps its report key: the synthetic chat fixture (now the fake Claude Code) has fully stopped.
  { const fake = await claude.close(); cleanup.serverClosed = fake.fakeClaudeExited && fake.claudeHomeEmpty; }
  if (asar) report.candidateAsarUnchanged = await readFile(asar).then(value => hash(value) === asarHash).catch(() => false);
  if (profile && appClosed) {
    try {
      const physical = await realpath(profile), owner = JSON.parse(await readFile(path.join(physical, 'qa-owner.json'), 'utf8'));
      assert.equal(physical, profileReal); assert.equal(path.dirname(physical), tempReal);
      assert.ok(path.basename(physical).startsWith('soft-hearts-character-preview-')); assert.equal(owner.marker, marker);
      await rm(physical, { recursive: true, force: true }); cleanup.profileRemoved = true;
    } catch { /* Retain this owned test profile if cleanup cannot prove its exact identity. */ }
  }
  report.cleanup = cleanup;
  if (report.status === 'PASS' && (!cleanup.appClosed || !cleanup.serverClosed || !cleanup.profileRemoved || !report.candidateAsarUnchanged)) { report.status = 'FAIL'; report.phase = 'cleanup'; process.exitCode = 1; }
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
