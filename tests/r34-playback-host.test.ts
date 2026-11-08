import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { SpeechPlaybackActivity } from '../electron/speech-playback-activity';
import { FatigueActivityBridge } from '../electron/fatigue-activity';
import { SpeechRuntime } from '../electron/speech-runtime';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { VisualSelfRuntime } from '../electron/visual-self-runtime';
import { prepareCharacterSpeechPreview } from '../electron/speech-preview';
import { ReplySpeechStyles } from '../electron/speech-emotion';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig } from '../shared/tts';
import { VoiceOutput } from '../src/ui/VoiceOutput';

const hostSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', hostSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string): string {
  const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(nodes.length, 1, `actual host declaration ${name}`);
  return nodes[0].getText(ast);
}
function callback(name: string): string {
  const nodes: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'scopedHost'
      && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === name) nodes.push(n.arguments[1]);
    ts.forEachChild(n, visit);
  };
  visit(ast); assert.equal(nodes.length, 1, `actual scoped callback ${name}`);
  return nodes[0].getText(ast);
}
const scopeDeclarations = ast.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
  .filter(n => n.name.getText(ast) === 'speechScope');
assert.equal(scopeDeclarations.length, 1);
const extracted = [
  `var speechScope = ${scopeDeclarations[0].initializer!.getText(ast)};`,
  ...['replySpeechBusy', 'syncFatigueActivity', 'noteVisionUserActivity', 'cancelProactiveVision',
    'cancelAmbientPlayback', 'suspendAmbientSpeech', 'updateReadingPause', 'canBeginSpeechPlaybackActivity'].map(declaration),
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
    r20ProactiveOffers:null, createHash, structuredClone, Date, prepareCharacterSpeechPreview, effectiveTtsConfig, DEFAULT_TTS_CONFIG,
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
