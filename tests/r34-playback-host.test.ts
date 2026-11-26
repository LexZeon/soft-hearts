import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { SpeechPlaybackActivity } from '../electron/voice/speech-playback-activity';
import { FatigueActivityBridge } from '../electron/mood/fatigue-activity';
import { SpeechRuntime } from '../electron/voice/speech-runtime';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { VisualSelfRuntime } from '../electron/senses/visual-self-runtime';
import { prepareCharacterSpeechPreview } from '../electron/voice/speech-preview';
import { ReplySpeechStyles } from '../electron/mood/speech-emotion';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig } from '../shared/voice/tts';
import { characterTtsConfig } from '../shared/voice/character-voice-resolver';
import { VoiceOutput } from '../src/voice/VoiceOutput';
import { WIRING_PRELUDE, wiringDeclaration, wiringFunction, wiringHandler } from './helpers/wiring-source';
import { ownLineYields } from '../shared/behaviors/interrupt/own-line';
import { readingScope } from '../electron/voice/stage-voices';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts', 'electron/wiring/voice-wiring.ts'.

// Wiring rewrite step 4: speechScope, replySpeechBusy, the playback lease's checks and the speech handlers are 声音's
// (electron/wiring/voice-wiring.ts); each is still exactly one in the wiring (main.ts and electron/wiring/*.ts), and what the moved lines
// read through the part's needs comes from the context's own names (WIRING_PRELUDE).
const declaration = (name: string): string => wiringFunction(name);
const callback = (name: string): string => wiringHandler(name);
const scopeDeclaration = wiringDeclaration('speechScope');
assert.match(scopeDeclaration, /^const speechScope = /);
const extracted = [
  WIRING_PRELUDE,
  wiringDeclaration('ownerScope').replace(/^const /, 'var '), // I-209 stage voice: speechScope(replyId) reads the reading's owner
  scopeDeclaration.replace(/^const /, 'var '),
  ...['replySpeechBusy', 'syncFatigueActivity', 'noteVisionUserActivity', 'cancelProactiveVision',
    'cancelAmbientPlayback', 'suspendAmbientSpeech', 'updateReadingPause', 'canBeginSpeechPlaybackActivity', 'replySurface', 'herOnScreen', 'heldLineSpeakable'].map(declaration),
  `var begin = ${callback('beginSpeechPlaybackActivity')};`,
  `var end = ${callback('endSpeechPlaybackActivity')};`,
  `var prepare = ${callback('prepareCharacterSpeechPreview')};`,
  `var speaking = ${callback('setAmbientAudioSpeaking')};`,
].join('\n');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 48; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('expected controlled lifecycle transition did not settle');
}
function harness() {
  const owner = 7, leases = new SpeechPlaybackActivity(), styles = new ReplySpeechStyles();
  const config = structuredClone(DEFAULT_TTS_CONFIG);
  let currentCard = { id: 'card-A', personality: 'Calm public fixture.', description: '', systemPrompt: '' };
  let modelPath = '/synthetic/model-A.pmx', available = true, visible = true, minimized = false;
  let activity: any, host: any;
  const bridge = new FatigueActivityBridge(value => { activity = value; }, async () => false);
  bridge.setSelection({ motion: null });
  const runtime = new SpeechRuntime(() => config, () => { host?.syncFatigueActivity(); }, async () => {});
  // No active visual/audio initiative exists. These are closed native-service ports,
  // while the real host cancellation declarations and style/runtime objects execute.
  const context: Record<string, any> = {
    ownLineYields, readingScope, // I-174 item 3: the rule noteVisionUserActivity asks; I-209 stage voice: whose reading scope
    r20ProactiveOffers:null, unbound: null, pet: null, createHash, structuredClone, Date, prepareCharacterSpeechPreview, effectiveTtsConfig, characterTtsConfig, DEFAULT_TTS_CONFIG,
    companion: { currentSpeechScope: () => { if (!available) throw Error('context unavailable'); return currentCard.id; },
      mood: { get: () => ({ snapshot: { primary: 'calm', context: 'neutral' } }) } },
    store: { current: { tts: config, model: { path: modelPath } } },
    characterCards: { getActive: () => currentCard },
    controls: null, windows: () => [{ webContents: { id: owner }, isVisible: () => visible, isMinimized: () => minimized }],
    fatigueActivityReady: true, exiting: false, fatigueActivity: bridge, speechPlaybackActivity: leases,
    speechRuntime: runtime, completedReplySpeech: new CompletedReplySpeech(), replySpeechStyles: styles,
    pending: new Map(), asrTask: null, foregroundAsr: { foregroundBusy: false }, readingInputSpeech: false,
    ambientSpeakingOwners: new Set(), userInputUntil: 0, visionGeneration: 0, ambientDeliveryGeneration: 0,
    lastVisionSpeech: null, lastAmbientSpeech: null, ambientAudio: null, audioReading: null,
    visionPresentation: { clear() {} }, proactiveSpeechGate: { cancel() {} },
    visualSelfRuntime: new VisualSelfRuntime(),
    proactiveVision: { cancel() {} }, cameraSamples: { cancel() {} }, ambientComments: { interrupt() {} },
  };
  vm.createContext(context);
  vm.runInContext(transformSync(extracted, { loader: 'ts', target: 'es2022' }).code, context);
  host = context; host.syncFatigueActivity();
  const beginCalls: { id: string; lease: string | null }[] = [], endCalls: { id: string; lease: string }[] = [];
  const systemCalls: { text: string; start(): void; finish(): void }[] = [];
  const errors: string[] = [];
  let holdNext = false, held: { lease: string | null; gate: ReturnType<typeof deferred<string | null>> } | null = null;
  let preparations = 0;
  const api = {
    onSpeechEvent: () => () => {},
    synthesizeSpeech: async () => { assert.fail('system scenario must not synthesize through a provider'); },
    cancelSpeech: async (id: string) => { runtime.cancel(owner, id); },
    releaseSpeech: async (id: string) => { runtime.release(owner, id); host.syncFatigueActivity(); },
    beginSpeechPlaybackActivity: async (id: string) => {
      const lease = await host.begin(owner, id); beginCalls.push({ id, lease });
      if (holdNext) { holdNext = false; const gate = deferred<string | null>(); held = { lease, gate }; return gate.promise; }
      return lease;
    },
    endSpeechPlaybackActivity: async (id: string, lease: string) => { endCalls.push({ id, lease }); host.end(owner, id, lease); },
  };
  const output = new VoiceOutput({
    api, getTtsConfig: () => config, getVoiceConfig: () => ({ enabled: true, voiceURI: '', rate: 1, volume: 0 }),
    createId: () => 'same-playback-id', onSpeaking: value => host.speaking(owner, value), onError: error => errors.push(error),
    createSystem: onSpeaking => ({ voices: () => [], stop() {},
      speak(text) { const completion = deferred<void>(); systemCalls.push({ text, start: () => onSpeaking(true), finish: () => { onSpeaking(false); completion.resolve(); } }); return completion.promise; } }),
  });
  return {
    owner, host, output, leases, styles, runtime, beginCalls, endCalls, systemCalls, errors,
    get activity() { return activity; }, get preparations() { return preparations; },
    prepare: async () => {
      preparations++; const scope = host.speechScope(); assert.equal(leases.busy, true, 'host lease exists before actual prepare');
      const result = host.prepare(owner);
      assert.equal(host.speechScope(), scope, 'prepare must not rotate the active speech scope');
      assert.equal(leases.busy, true, 'prepare clears styles/transport, not the admitted playback lease');
      return result;
    },
    holdNextBegin() { holdNext = true; },
    releaseHeldAck() { assert.ok(held); held.gate.resolve(held.lease); },
    setVisible(value: boolean) { visible = value; },
    setMinimized(value: boolean) { minimized = value; },
    setContextAvailable(value: boolean) { available = value; },
    switchScope() { currentCard = { ...currentCard, id: 'card-B' }; modelPath = '/synthetic/model-B.pmx'; context.store.current.model.path = modelPath; host.syncFatigueActivity(); },
  };
}

test('actual character preview acquires the host lease before prepare and retains it until system completion', async () => {
  const h = harness();
  try {
    const scope = h.host.speechScope();
    h.styles.begin(h.owner, 'old-style', scope);
    h.styles.complete(h.owner, 'old-style', scope, { primary: 'calm', context: 'neutral' }, DEFAULT_TTS_CONFIG);
    await h.runtime.speak(h.owner, 'old-transport', 'public setup');
    assert.equal(h.runtime.busy, true, 'old routing is retained until actual prepare stops it');
    const completion = h.output.previewCharacter('public preview', h.prepare);
    assert.equal(h.leases.busy, true, 'lease admission is synchronous even though its ACK is awaited');
    await until(() => h.systemCalls.length === 1);
    assert.equal(h.preparations, 1); assert.equal(h.runtime.busy, false);
    assert.throws(() => h.styles.resolve(h.owner, 'old-style', scope));
    assert.equal(h.activity.tts, true); assert.equal(h.endCalls.length, 0);
    h.systemCalls[0].start();
    assert.equal(h.activity.tts, true); assert.equal(h.leases.busy, true);
    h.systemCalls[0].finish(); await completion;
    assert.deepEqual(h.endCalls, [{ id: h.beginCalls[0].id, lease: h.beginCalls[0].lease }]);
    assert.equal(h.leases.busy, false); assert.equal(h.activity.tts, false); assert.deepEqual(h.errors, []);
  } finally { h.output.dispose(); }
});

test('actual host scope/visibility gates and late begin ACK cannot release or start over newer playback', async () => {
  const h = harness();
  try {
    h.setVisible(false); assert.equal(await h.host.begin(h.owner, 'hidden'), null); assert.equal(h.leases.busy, false);
    h.setVisible(true); h.setMinimized(true); assert.equal(await h.host.begin(h.owner, 'minimized'), null);
    h.setMinimized(false); h.setContextAvailable(false);
    assert.equal(await h.host.begin(h.owner, 'unbound'), null, 'missing host scope stays closed');
    assert.equal(h.leases.busy, false, 'missing scope does not acquire a lease');
    h.setContextAvailable(true); h.host.syncFatigueActivity();
    h.holdNextBegin();
    const oldCompletion = h.output.speak('old A', { enabled: true, voiceURI: '', rate: 1, volume: 0 });
    await until(() => h.beginCalls.length === 1);
    const old = h.beginCalls[0]; assert.ok(old.lease); assert.equal(h.leases.busy, true);
    assert.equal(h.systemCalls.length, 0, 'pending ACK is not engine start or sound');
    h.switchScope(); h.output.stop(); await oldCompletion;
    const currentCompletion = h.output.speak('new B', { enabled: true, voiceURI: '', rate: 1, volume: 0 });
    await until(() => h.systemCalls.length === 1);
    const current = h.beginCalls[1]; assert.ok(current.lease); assert.notEqual(current.lease, old.lease);
    h.releaseHeldAck(); await until(() => h.endCalls.some(row => row.lease === old.lease));
    assert.deepEqual(h.systemCalls.map(row => row.text), ['new B']);
    assert.equal(h.leases.busy, true); assert.equal(h.activity.tts, true);
    h.host.end(h.owner, old.id, old.lease);
    assert.equal(h.leases.busy, true, 'repeated stale opaque end cannot clear B');
    h.systemCalls[0].start(); assert.equal(h.activity.tts, true);
    h.systemCalls[0].finish(); await currentCompletion;
    assert.equal(h.leases.busy, false); assert.equal(h.activity.tts, false);
    assert.equal(h.endCalls.filter(row => row.lease === current.lease).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.output.dispose(); }
});
