import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import ts from 'typescript';
import { AudioCaptureHost } from '../electron/audio-capture-host';
import { AudioReadingHostBroker } from '../electron/audio-reading-host-broker';
import { AudioReadingArchive } from '../electron/audio-reading-archive';
import { MediaRuntime } from '../electron/runtime';
import { poseCameraPolicy } from '../electron/pose/camera-gate';
import { SystemAudioRuntime } from '../electron/system-audio';
import { ForegroundAsr } from '../electron/foreground-asr';
import { SpeakingOwners } from '../electron/speaking-owners';
import { PauseGuard } from '../electron/pause-guard';
import { ListenTally } from '../electron/listen-tally';
import { AmbientAudioRuntime } from '../electron/ambient-audio-runtime';
import { AmbientAsrRoute, refusedReadingAck } from '../electron/asr/ambient-route';
import { AmbientComments, type AmbientCommentOffer } from '../electron/ambient-comments';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { audioReadingSources, audioReadingPurposes, parseAudioReadingIntent } from '../shared/audio-reading-toggles';
import { parseAudioReadingPcm, type AudioCaptureDescriptor, type AudioCaptureState } from '../shared/audio-capture';
import { listenSwitchOn } from '../shared/listen-together';
import { ListenKindHost } from '../shared/listen-kind';
import { ListenTogether } from '../electron/listen-together/host';
import type { AmbientLanguage } from '../shared/ambient-audio';
import { createMoodState, getMoodSnapshot, DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';

// Extract actual registrations and their actual finite helpers, never import main
// (which would import Electron/provider code) or reconstruct the new adapter.
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const methodNames = ['getAudioReadingView', 'getAudioCaptureState', 'setAudioReadingIntent',
  'ackAudioCapture', 'setAudioDanceIntent', 'submitAudioReadingPcm', 'getRuntimeState', 'setRuntimeState'];
function declaration(name: string): string {
  const matches = ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(matches.length, 1, `One actual declaration required: ${name}`);
  return matches[0].getText(ast);
}
function initial(name: string): string {
  const matches = ast.statements.filter((n): n is ts.VariableStatement => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name));
  assert.equal(matches.length, 1, `One actual initial statement required: ${name}`);
  return matches[0].getText(ast);
}
const register = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'registerIPC');
assert.ok(register?.body);
const registrations = methodNames.map(name => {
  const matches = register.body!.statements.filter(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && ['host', 'scopedHost'].includes(n.expression.expression.getText(ast))
    && ts.isStringLiteral(n.expression.arguments[0]) && n.expression.arguments[0].text === name);
  assert.equal(matches.length, 1, `One actual registration required: ${name}`);
  return matches[0].getText(ast);
});
const helpers = ['host', 'scopedHost', 'broadcast', 'readingContextIdentity', 'readingActive', 'syncAudioCapture',
  'allowsOwnedMedia', 'currentAmbientSession', 'initAudioReading', 'archiveReading', 'suspendAmbientSpeech',
  'updateReadingPause', 'replySpeechBusy', 'ownerFor', 'stopSystemAudio', 'journalStuck', 'noteStuck'].map(declaration);
const states = ['audioCapture', 'audioReading', 'readingStartedAt', 'readingInputSpeech', 'readingPaused',
  'readingLanguages', 'ambientSpeakingOwners', 'asrTask', 'voiceHost', 'ambientStore', 'ambientAudio', 'ambientComments',
  'windows', 'media', 'foregroundAsr', 'completedReplySpeech', 'suspendGuard', 'readingGuards', 'listenTally'].map(initial);
const createHost = new Function('deps', ts.transpileModule(`
  const {ipcMain,pet,controls,store,companion,systemAudio,speechRuntime,mediaChanged,cancelAmbientPlayback,
    speechScope,transcribeWav,DEFAULT_SETTINGS,AudioCaptureHost,AudioReadingHostBroker,
    MediaRuntime,ForegroundAsr,CompletedReplySpeech,parseAudioReadingIntent,parseAudioReadingPcm,audioReadingSources,
    audioReadingPurposes,createHash,randomUUID,Date,syncFatigueActivity,VoiceChatHost,poseCameraPolicy,poseSensing,voiceRoute,SpeakingOwners,PauseGuard,ListenTally,appJournal,journalCharacterId,
    ambientAsr,refusedReadingAck,listenSwitchOn} = deps;
  ${states.join('\n')}
  ${helpers.join('\n')}
  ambientStore=deps.archive; ambientAudio=deps.legacy;
  initAudioReading();
  ${registrations.join('\n')}
  return { media, capture:audioCapture, broker:audioReading, foregroundAsr,
    allowsOwnedMedia,currentAmbientSession,stopSystemAudio,
    installComments(value) { ambientComments=value; },
    installListen(value) { listenTogether=value; },
    pauseInput(value) { readingInputSpeech=value; updateReadingPause(); },
  };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText) as
  (deps: Record<string, unknown>) => {
    media: MediaRuntime; capture: AudioCaptureHost; broker: AudioReadingHostBroker; foregroundAsr: ForegroundAsr;
    allowsOwnedMedia(owner: 'pet' | 'controls', kind: 'audio' | 'video', camera?: boolean): boolean;
    currentAmbientSession(): import('../electron/ambient-comments').AmbientCommentSession | null;
    stopSystemAudio(): void; installComments(value: AmbientComments): void; installListen(value: ListenTogether): void; pauseInput(value: boolean): void;
  };

const language: AmbientLanguage = { status: 'detected', language: 'zh', source: 'provider' };
const scope = { characterId: 'synthetic-card', providerScope: 'synthetic-provider' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await turn(); }
  assert.fail('The bounded pure fixture did not settle');
}

async function fixture(t: TestContext, options: { engine?: 'local' | 'compatible' } = {}) {
  let clock = 1_000_000;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-reading-wiring-'));
  const archive = new AudioReadingArchive(directory, { now: () => clock });
  await archive.load();
  const v1Baseline = await readFile(path.join(directory, 'system-audio-transcripts.json'));
  const config = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic-asr', language: 'zh', apiKey: '' };
  const store = { current: { model: null, voiceInput: config } };
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const events: Array<{ recipient: number; channel: string; value: unknown }> = [];
  const publications: AudioCaptureState[] = [];
  const makeWindow = (id: number) => ({
    isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    webContents: { id, mainFrame: {}, isDestroyed: () => false,
      send: (channel: string, value: unknown) => {
        events.push({ recipient: id, channel, value: structuredClone(value) });
        if (id === 2 && channel === 'desk:audio-capture-state') publications.push(structuredClone(value as AudioCaptureState));
      } },
  });
  const controls = makeWindow(1), pet = makeWindow(2);
  const boundaries = { mediaChanged: 0, playbackCancelled: 0, userChat: 0, steer: 0, noteTranscript: 0, generated: 0 };
  const companion = new Proxy({ currentScope: () => scope }, {
    get(target, key, receiver) {
      // Fail closed and observe any attempted user-chat/steer collaborator access.
      // The actual new adapter is only entitled to read currentScope here.
      if (typeof key === 'string' && /chat|userTurn|steer/i.test(key)) {
        if (/steer/i.test(key)) boundaries.steer++; else boundaries.userChat++;
        throw Error('An ambient adapter attempted a user conversation route');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const recognitions: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<{ text: string; language: AmbientLanguage }>> }> = [];
  const legacy = new AmbientAudioRuntime({ getScope: () => scope, getContextIdentity: () => 'synthetic-context',
    getVoiceConfig: () => ({ ...config, language: '' }), canStart: () => false, canTranscribe: () => false,
    isSpeaking: () => false, transcribe: async () => { throw Error('No legacy recognition is authorized in this fixture'); },
    store: archive, now: () => clock });
  // The local recognizer (I-016, Codex T-207: played sound is transcribed only on this computer), answering when the test says.
  const recognizeLocal = (_wav: ArrayBuffer, _language: string, signal: AbortSignal) => {
    const result = deferred<{ text: string; language: AmbientLanguage }>(); recognitions.push({ signal, result });
    return result.promise.then(value => ({ text: value.text, tags: { language: value.language.status === 'detected' ? value.language.language : null, event: null, emotion: null } }));
  };
  const api = createHost({ ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    assert.equal(handlers.has(name), false); handlers.set(name, handler);
  } }, pet, controls, archive, legacy, store, companion,
    systemAudio: new SystemAudioRuntime('win32'), speechRuntime: { busy: false },
    mediaChanged: () => { boundaries.mediaChanged++; }, cancelAmbientPlayback: () => { boundaries.playbackCancelled++; },
    speechScope: () => 'synthetic-context',
    // Fatigue observation is outside this audio-reading wiring fixture's scope.
    syncFatigueActivity: () => {},
    // The actual voice host (R33), constructed with no capture: foreground ASR reads its capture.
    VoiceChatHost,
    // The camera policy main.ts gives the media runtime; no pose host in this fixture (camera requests are refused).
    poseCameraPolicy, poseSensing: null,
    // 识别方式 (electron/asr/voice-route.ts): the compatible address here, so voice input is never refused by this fixture.
    voiceRoute: { policy: { blocked: () => null }, engine: 'compatible' },
    // Her pauses let go by themselves (2026-11-06): the real lease/guard classes, a journal that records nothing.
    SpeakingOwners, PauseGuard, ListenTally, appJournal: { record() {} }, journalCharacterId: () => null,
    // 陪听歌、看剧的转写 (electron/asr/ambient-route.ts): the actual route on the local recognizer above (ready, never refused),
    // or on 识别方式 = compatible, where the words are refused and only the rhythm turns on.
    ambientAsr: new AmbientAsrRoute({ config: () => ({ ...config, engine: options.engine ?? 'local' }),
      local: () => ({ ready: true, voiceBlocked: () => null, recognize: recognizeLocal }), journal: () => {}, characterId: () => null }), refusedReadingAck,
    // I-016 一起听: the actual single-switch rule (the computer's sound cells on ⇒ its rhythm on too).
    listenSwitchOn,
    transcribeWav: async () => { throw Error('Foreground recognition is not requested by this fixture'); },
    DEFAULT_SETTINGS: { voiceInput: config }, AudioCaptureHost, AudioReadingHostBroker, MediaRuntime, ForegroundAsr, CompletedReplySpeech,
    parseAudioReadingIntent, parseAudioReadingPcm, audioReadingSources, audioReadingPurposes, createHash, randomUUID,
    Date: class extends Date { static override now() { return clock; } },
  });
  const gate = new ProactiveSpeechGate(() => clock), offers: AmbientCommentOffer[] = [];
  const generation = deferred<string>();
  const comments = new AmbientComments({ store: archive, gate, currentSession: api.currentAmbientSession,
    canComment: () => true, persona: () => 'Synthetic persona', moodText: () => 'Synthetic idle',
    generate: () => { boundaries.generated++; return generation.promise; }, offer: value => { offers.push(value); }, now: () => clock });
  const actualNote = comments.noteTranscript.bind(comments);
  comments.noteTranscript = record => { boundaries.noteTranscript++; actualNote(record); };
  api.installComments(comments);
  // I-016 一起听: the actual listen-together host (its own file in this temp directory), music playing, so a piece joins a
  // segment. No note call happens in this fixture (segments stay open).
  const kinds = new ListenKindHost(); kinds.set({ kind: 'music', confidence: 1, since: clock - 1, revision: 1 });
  const listen = new ListenTogether({ directory, kinds, characterId: () => scope.characterId, listening: () => true,
    quick: async () => { throw Error('No note call is authorized in this fixture'); }, now: () => clock });
  api.installListen(listen);
  const listenPieces = () => listen.core.segmentsFor(scope.characterId).flatMap(s => s.pieces);
  const call = (name: string, sender: number = 2, ...args: unknown[]) => {
    const win = sender === 1 ? controls : sender === 2 ? pet : makeWindow(sender);
    const handler = handlers.get(`desk:${name}`); assert.ok(handler);
    return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
  };
  const intent = (source: 'system-audio' | 'microphone', purpose: 'music' | 'movie', enabled: boolean) =>
    call('setAudioReadingIntent', 2, { source, purpose, enabled });
  const ackReady = async () => {
    await flush();
    for (const source of audioReadingSources) {
      const slot = api.capture.getState().slots[source];
      if (slot) assert.equal(call('ackAudioCapture', slot.owner === 'pet' ? 2 : 1,
        { id: slot.id, source, revision: slot.revision, phase: 'ready' }), true);
    }
    await flush();
  };
  const releaseAcks = new Set<string>();
  const ackReleased = async () => {
    await flush();
    for (const source of audioReadingSources) {
      const last = [...publications].reverse().find(state => state.slots[source])?.slots[source];
      if (!api.capture.getState().slots[source] && last && !releaseAcks.has(last.id)) {
        assert.equal(call('ackAudioCapture', last.owner === 'pet' ? 2 : 1,
          { id: last.id, source, revision: last.revision, phase: 'released' }), true);
        releaseAcks.add(last.id);
      }
    }
    await flush();
  };
  const pcm = (slot: AudioCaptureDescriptor, sequence: number, startedAtMs = clock - 100) => ({
    token: slot.ambient!, captureRevision: slot.revision, sequence, startedAtMs, pcm16: new ArrayBuffer(3200),
  });
  t.after(async () => {
    comments.clear(); gate.dispose(); api.broker.dispose(); api.capture.dropOwner('pet'); api.capture.dropOwner('controls');
    for (const recognition of recognitions) recognition.result.resolve({ text: '', language });
    await api.broker.settled();
    await archive.flush(); await listen.dispose();
    const owned = path.resolve(directory);
    assert.equal(path.dirname(owned), path.resolve(os.tmpdir()));
    assert.ok(path.basename(owned).startsWith('soft-hearts-reading-wiring-'));
    await rm(owned, { recursive: true, force: true });
  });
  return { ...api, call, intent, ackReady, ackReleased, pcm, handlers, controls, pet, archive, directory, v1Baseline,
    events, publications, recognitions, boundaries, comments, gate, offers, generation, listen, listenPieces, kinds,
    now: () => clock, advance: (ms: number) => { clock += ms; } };
}

test('actual six host IPCs and two event channels preserve all sixteen source/purpose combinations', async t => {
  const f = await fixture(t);
  assert.equal(f.handlers.size, 8, 'six new host registrations plus two existing runtime registrations');
  for (let mask = 0; mask < 16; mask++) {
    const publicationStart = f.publications.length;
    let bit = 0;
    for (const source of audioReadingSources) for (const purpose of audioReadingPurposes)
      await f.intent(source, purpose, !!(mask & (1 << bit++)));
    await f.ackReady();
    const state = f.call('getAudioCaptureState') as AudioCaptureState;
    const view = f.broker.getView();
    assert.equal(f.call('getAudioReadingView') && view.overall.active, mask !== 0);
    for (const [index, source] of audioReadingSources.entries()) {
      assert.equal(!!state.slots[source], !!(mask & (3 << (index * 2))));
      assert.equal(view.sources[source].music.intent, !!(mask & (1 << (index * 2))));
      assert.equal(view.sources[source].movie.intent, !!(mask & (2 << (index * 2))));
      const identities = new Set(f.publications.slice(publicationStart).flatMap(value => value.slots[source]?.id ?? []));
      assert.equal(identities.size, state.slots[source] ? 1 : 0, 'purposes never create another physical identity for the source');
    }
    assert.ok(Object.values(state.slots).filter(Boolean).length <= 2);
    for (const source of audioReadingSources) for (const purpose of audioReadingPurposes) await f.intent(source, purpose, false);
    await f.ackReleased();
    assert.deepEqual(f.capture.getState().slots, { 'system-audio': null, microphone: null });
    assert.deepEqual(await f.broker.settled(), { released: true });
  }
  for (const channel of ['desk:audio-capture-state', 'desk:audio-reading-view'])
    assert.deepEqual(new Set(f.events.filter(e => e.channel === channel).map(e => e.recipient)), new Set([1, 2]));
  assert.equal(f.recognitions.length, 0);
});

test('Codex T-207: with 识别方式 = compatible the actual switch handler turns on only the rhythm, says why, and no clip is recognized', async t => {
  const f = await fixture(t, { engine: 'compatible' });
  const ack = await f.intent('system-audio', 'music', true) as { accepted: boolean; cell: { intent: boolean } };
  assert.equal(ack.accepted, false); assert.equal(ack.cell.intent, false, 'the words cell stays off');
  assert.deepEqual(f.events.filter(e => e.channel === 'desk:audio-reading-refused').map(e => [e.recipient, e.value]), [[2, 'not-local']],
    'only the pet hears why (her notice), and the reason is not-local');
  assert.equal(f.capture.getState().slots['system-audio']?.dance, true, 'the rhythm is on');
  assert.equal(listenSwitchOn(f.broker.getView(), true), true, 'the one switch shows on (rhythm only)');
  await f.ackReady();
  assert.equal(f.broker.getView().sources['system-audio'].music.intent, false);
  assert.equal(f.recognitions.length, 0, 'nothing is transcribed, so nothing can leave the computer');
});

test('actual scoped host rejects foreign/frame senders and chat/ambient share the authoritative microphone owner', async t => {
  const f = await fixture(t);
  assert.throws(() => f.call('getAudioCaptureState', 99), /未授权/);
  assert.throws(() => f.handlers.get('desk:getAudioReadingView')!({ sender: f.pet.webContents, senderFrame: {} }), /未授权/);
  await assert.rejects(async () => f.call('setAudioReadingIntent', 1, { source: 'microphone', purpose: 'music', enabled: true }));
  f.call('setRuntimeState', 1, { voiceInput: true });
  const chat = f.capture.getState().slots.microphone!;
  await f.intent('microphone', 'music', true); await f.ackReady();
  const shared = f.capture.getState().slots.microphone!;
  assert.equal(shared.id, chat.id); assert.equal(shared.owner, 'controls');
  f.call('setRuntimeState', 2, { voiceInput: true });
  assert.equal((f.call('getRuntimeState') as { voiceOwner: string }).voiceOwner, 'controls');
  assert.equal(f.allowsOwnedMedia('controls', 'audio'), true);
  assert.equal(f.allowsOwnedMedia('pet', 'audio'), false);
  assert.deepEqual(f.call('submitAudioReadingPcm', 2, f.pcm(shared, 1)), { accepted: false, reason: 'inactive' });
  f.call('setRuntimeState', 1, { voiceInput: false });
  assert.equal(f.capture.getState().slots.microphone!.id, chat.id);
  assert.equal(f.capture.getState().slots.microphone!.chat, false);
  assert.ok(f.capture.getState().slots.microphone!.ambient);
  assert.equal(f.allowsOwnedMedia('controls', 'audio'), true);
  await f.intent('microphone', 'music', false); await f.ackReleased();
  assert.equal(f.allowsOwnedMedia('controls', 'audio'), false);
  await f.intent('microphone', 'music', true); await f.ackReady();
  assert.equal(f.capture.getState().slots.microphone!.owner, 'pet');
  assert.equal(f.allowsOwnedMedia('controls', 'audio'), false, 'old owner loses audio authority');
});

test('actual PCM revision fence and ASR cancellation reject stale buffers; the computer sound joins its segment once, without user chat', async t => {
  const f = await fixture(t);
  for (const source of audioReadingSources) for (const purpose of audioReadingPurposes) await f.intent(source, purpose, true);
  await f.ackReady(); f.advance(1000);
  const original = f.capture.getState().slots.microphone!;
  await assert.rejects(async () => f.call('submitAudioReadingPcm', 2, { ...f.pcm(original, 1), deviceId: 'no-device-capability' }));
  assert.throws(() => f.call('submitAudioReadingPcm', 99, f.pcm(original, 1)), /未授权/);
  assert.equal((f.call('submitAudioReadingPcm', 2, f.pcm(original, 1)) as { accepted: boolean }).accepted, true);
  await until(() => f.recognitions.length === 1);
  await f.intent('microphone', 'music', false); await f.intent('microphone', 'movie', false);
  await f.ackReleased();
  assert.equal(f.recognitions[0].signal.aborted, true);
  await f.intent('microphone', 'music', true); await f.intent('microphone', 'movie', true); await f.ackReady();
  assert.deepEqual(f.call('submitAudioReadingPcm', 2, f.pcm(original, 2)), { accepted: false, reason: 'inactive' });
  f.recognitions[0].result.resolve({ text: 'late discarded synthetic transcript', language });
  await flush(); await turn();
  assert.equal(f.archive.list(scope).total, 0);
  assert.equal(f.listenPieces().length, 0, 'I-016: a late result never joins a listen-together segment either');
  f.advance(200);
  const beforePause = f.capture.getState().slots.microphone!;
  assert.equal((f.call('submitAudioReadingPcm', 2, f.pcm(beforePause, 2)) as { accepted: boolean }).accepted, true);
  await until(() => f.recognitions.length === 2);
  f.pauseInput(true);
  assert.equal(f.capture.getState().slots.microphone!.id, beforePause.id, 'speech pause retains the physical capture');
  assert.equal(f.broker.getView().sources.microphone.capture.phase, 'paused');
  assert.equal(f.recognitions[1].signal.aborted, true, 'pause revokes the in-flight background consumer');
  f.pauseInput(false);
  f.recognitions[1].result.resolve({ text: 'late cancelled while input speech had priority', language });
  await flush(); await turn();
  assert.equal(f.archive.list(scope).total, 0);
  assert.equal(f.listenPieces().length, 0);
  assert.deepEqual(f.call('submitAudioReadingPcm', 2, f.pcm(beforePause, 3)), { accepted: false, reason: 'inactive' });
  const oldBuffer = f.capture.getState().slots.microphone!;
  await f.intent('microphone', 'music', false); await f.intent('microphone', 'music', true);
  assert.equal(f.capture.getState().slots.microphone!.id, oldBuffer.id);
  assert.deepEqual(f.call('submitAudioReadingPcm', 2, f.pcm(oldBuffer, 2)), { accepted: false, reason: 'inactive' });
  f.advance(200);
  const text = '同一段明确合成声音具有足够长度用于跨源去重';
  for (const source of audioReadingSources) {
    const slot = f.capture.getState().slots[source]!;
    assert.equal((f.call('submitAudioReadingPcm', 2, f.pcm(slot, 3)) as { accepted: boolean }).accepted, true);
  }
  await until(() => f.recognitions.length === 3);
  f.recognitions[2].result.resolve({ text, language });
  await until(() => f.recognitions.length === 4);
  f.recognitions[3].result.resolve({ text, language });
  await f.broker.settled(); await f.archive.flush(); await flush();
  // I-016 (replacing R13's long-term raw archive): each piece joins the listen-together segment of what is
  // playing; only the computer's sound is kept (the microphone is not part of 「和她一起听」), and nothing new reaches the old archive.
  await until(() => f.listenPieces().length === 1);
  const [piece] = f.listenPieces();
  assert.equal(piece.text, text); assert.equal(piece.language, 'zh');
  assert.equal(f.archive.list(scope).total, 0, 'nothing new in the long-term transcript archive');
  assert.equal(f.boundaries.noteTranscript, 0, 'no per-transcript comment opportunity');
  assert.equal(f.boundaries.userChat, 0); assert.equal(f.boundaries.steer, 0);
  assert.equal(f.events.some(e => e.channel === 'desk:stream' || e.channel === 'desk:chat-started'), false);
  const names = await readdir(f.directory);
  assert.equal(names.includes('audio-reading-v2.json'), false);
  assert.deepEqual(await readFile(path.join(f.directory, 'system-audio-transcripts.json')), f.v1Baseline,
    'the legitimate loaded v1 archive stays byte-identical');
  // Codex T-207 round 2: an open song lives in memory only (the host may still take it back) and is written once it has ended.
  const onDisk = async () => JSON.parse(await readFile(path.join(f.directory, 'listen-together.json'), 'utf8').catch(() => '{"version":1,"segments":[]}'));
  await f.listen.core.flush();
  assert.equal((await onDisk()).segments.length, 0, 'the open song is not on disk yet');
  f.kinds.set({ kind: 'quiet', confidence: 1, since: f.now(), revision: 2 }); f.listen.core.tick(); await f.listen.core.flush();
  const persisted = await onDisk();
  assert.equal(persisted.version, 1); assert.equal(persisted.segments.length, 1);
  assert.deepEqual(Object.keys(persisted.segments[0].pieces[0]).sort(), ['at', 'end', 'language', 'text'], 'text only, never audio');
});

test('I-016: a transcript piece no longer offers a per-transcript comment; a cue for it starts no model request', async t => {
  const f = await fixture(t);
  for (const source of audioReadingSources) for (const purpose of audioReadingPurposes) await f.intent(source, purpose, true);
  await f.ackReady(); f.advance(31_000);
  const slot = f.capture.getState().slots['system-audio']!;
  assert.equal((f.call('submitAudioReadingPcm', 2, f.pcm(slot, 1)) as { accepted: boolean }).accepted, true);
  await until(() => f.recognitions.length === 1);
  f.recognitions[0].result.resolve({ text: '合成背景材料仅作为外部声音材料保存', language });
  await f.broker.settled(); await f.archive.flush(); await flush();
  // (I-016 step 5): she speaks only at a natural pause from a note, never per transcript piece.
  await until(() => f.listenPieces().length === 1);
  assert.equal(f.boundaries.noteTranscript, 0);
  assert.equal(f.comments.nextSourceObservation(), undefined, 'no per-transcript observation');
  const session = f.currentAmbientSession()!;
  const snapshot = getMoodSnapshot(createMoodState(f.now()), f.now());
  // A cue carrying an observation id the old path would have used finds nothing to comment on.
  snapshot.cue = { id: 'one-owned-opportunity', kind: 'speech', at: f.now(), until: f.now() + 40_000,
    source: { kind: 'ambient', sessionId: session.sessionId, observationId: `${session.sessionId}:1` } };
  const view: MoodView = { characterId: scope.characterId, revision: 1, token: 'synthetic-mood-token', developerMode: false,
    expressions: false, parameters: DEFAULT_MOOD_PARAMETERS, snapshot, gesture: null };
  for (let i = 0; i < 4; i++) f.comments.observe(view);
  assert.equal(f.boundaries.generated, 0); assert.equal(f.gate.busy, false); assert.equal(f.offers.length, 0);
  assert.equal(f.boundaries.userChat, 0); assert.equal(f.boundaries.steer, 0);
});
