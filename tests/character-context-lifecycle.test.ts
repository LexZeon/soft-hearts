import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { VisualSelfRuntime } from '../electron/visual-self-runtime';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { cameraImagesRevoked } from '../electron/runtime';
import { t } from '../shared/ui-language';

// In a normal checkout, use ordinary project dependencies. The ignored overlay
// reuses pinned baseline modules; no app, store instance or service is launched.
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const baseline = existsSync(path.join(sourceRoot, 'shared/character-cards.ts')) ? null
  : JSON.parse(readFileSync(new URL('../../baseline.json', import.meta.url), 'utf8'));
const dependencyRoot = baseline ? path.resolve(baseline.source) : sourceRoot;
const cardsApi = await import(pathToFileURL(path.join(dependencyRoot, 'shared/character-cards.ts')).href);
const { memoryProviderScope } = await import(pathToFileURL(path.join(dependencyRoot, 'electron/companion.ts')).href);
const updatedText = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const originalText = baseline ? readFileSync(path.join(dependencyRoot, 'electron/main.ts'), 'utf8') : null;
const handlerNames = ['saveCharacterCard', 'activateCharacterCard', 'deleteCharacterCard', 'bindCharacterModel', 'importCharacterCard'];
const tree = (text: string) => ts.createSourceFile('electron/main.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(ast: ts.SourceFile, name: string) {
  const nodes = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, 'Extract one actual host declaration: ' + name);
  return nodes[0].getText(ast);
}
function variableStatement(ast: ts.SourceFile, name: string) {
  const nodes = ast.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === name));
  assert.equal(nodes.length, 1, 'Extract one actual host initial state: ' + name);
  return nodes[0].getText(ast);
}
function registration(ast: ts.SourceFile, name: string) {
  const register = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIPC')!;
  const matches = register.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ['host', 'scopedHost'].includes(node.expression.expression.getText(ast))
    && ts.isStringLiteral(node.expression.arguments[0]) && node.expression.arguments[0].text === name);
  assert.equal(matches.length, 1, 'Extract one actual IPC registration: ' + name);
  // The import handler shares its card-import step with the agent channel; extract that actual helper too.
  const helpers = name === 'importCharacterCard' ? register.body!.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === 'importCharacterCardContent')) : [];
  return [...helpers, matches[0]].map(node => node.getText(ast)).join('\n');
}
function factory(text: string) {
  const ast = tree(text);
  const declarations = ['clearVisionContext', 'syncCharacter', 'mediaChanged'].map(name => declaration(ast, name)).join('\n');
  // Current lifecycle code calls the real voice revoker. Extract its actual
  // no-capture host (the real VoiceChatHost, R33) too; never replace the new
  // dependency with a no-op. Historical source without this call needs no substituted voice capability.
  const voiceLifecycle = /\brevokeVoice\s*\(/.test(declarations)
    ? [variableStatement(ast, 'voiceHost'), declaration(ast, 'revokeVoice')].join('\n') : '';
  // Include the actual completed-reply revoker and its state. The external
  // reading-pause/window ports remain narrow observed collaborators below.
  const replyLifecycle = /\bclearReplySpeech\s*\(/.test(declarations)
    ? [variableStatement(ast, 'completedReplySpeech'), declaration(ast, 'cancelCompletedReply'), declaration(ast, 'clearReplySpeech')].join('\n') : '';
  // Include the actual new host visual-context state and runtime, rather than a no-op clear port.
  const visualLifecycle = /\bvisualSelfRuntime\b/.test(declarations)
    ? ['visualSelfRuntime', 'visualSelfIdentity', 'visualSelfScreenSourceId', 'visualSelfCameraOwnerId']
      .map(name => variableStatement(ast, name)).join('\n') : '';
  const handlers = handlerNames.map(name => registration(ast, name)).join('\n');
  const code = ts.transpileModule(`function create(deps: any) {
    const {characterCards,characterResponseService,store,companion,pending,media,screenSnapshots,screenGlance,
      stopSystemAudio,ambientComments,proactiveSpeechGate,cancelProactiveVision,speechRuntime,
      replySpeechStyles,broadcast,refreshVisionContext,publishVisionState,bundledAssets,assets,
      motionLibrary,sync,compileCharacterPersona,effectiveCharacterMood,memoryProviderScope,
      dialog,controls,stat,readFile,CompletedReplySpeech,VisualSelfRuntime,VoiceChatHost,suspendAmbientSpeech,windows,bodyAuthoring} = deps;
    // Optional profile management is outside this legacy character/media fixture.
    const userProfileManagement = undefined, languageAuthoring = undefined, visualAuthoring = undefined, surprisePreviewHost = undefined, activateUserProfile = async () => {};
    const poseSensing = undefined; // local pose sensing (electron/pose/) is outside this fixture too
    // I-036: the camera's 「发图片」 rule and the tray eye are outside this fixture too; the revocation rule is the real one.
    const cameraGlance = { reset() {} }, cameraEye = { images() {} }, cameraImagesRevoked = deps.cameraImagesRevoked;
    const localAsr = undefined, voiceRoute = { engine: 'compatible' }; // the local speech recognizer (electron/asr/) too
    const appJournal = { characters() {} }; // 体验记录 (electron/journal/) only observes the card state; outside this fixture too
    let moodModel = deps.moodModel, visionGeneration = 4, visionContextIdentity = 'synthetic-current-context',
      lookAttachments = deps.lookAttachments, lookTurns = deps.lookTurns, visionSupported = true, motionSelectionGeneration = 0,
      asrTask = null;
    let mutationQueue = Promise.resolve();
    const mutate = operation => { const result = mutationQueue.then(operation, operation); mutationQueue = result.catch(() => {}); return result; };
    const registrations = new Map();
    const host = (name, callback, controlOnly = true) => registrations.set(name, {callback, controlOnly});
    ${voiceLifecycle}
    ${replyLifecycle}
    ${visualLifecycle}
    ${declarations}
    ${handlers}
    return {registrations, syncCharacter, mediaChanged,
      state: () => ({visionGeneration,visionContextIdentity,visionSupported,motionSelectionGeneration})};
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('t', code + '\nreturn create;')(t) as (deps: Record<string, any>) => any;
}
const makeUpdated = factory(updatedText);
type Card = Record<string, any>;
function card(id: string, overrides: Card = {}): Card {
  return { id, name: id, description: '', personality: '', scenario: '', greeting: '', examples: '',
    systemPrompt: 'Same legacy persona', mood: cardsApi.defaultCharacterMoodTemplate(), ...overrides };
}
function draft(value: Card) {
  const { id: _id, modelPath: _path, modelName: _name, ...text } = structuredClone(value); return text;
}
function fixture(make = makeUpdated) {
  let activeId = 'active', nextId = 0;
  const cards = new Map<string, Card>([['active', card('active')], ['inactive', card('inactive')]]);
  const effects: Record<string, any> = { stops: 0, comments: 0, cueCancels: 0, visionCancels: 0, speechStops: 0,
    styleClears: 0, contexts: [], refreshed: 0, published: 0, syncs: 0, events: [], body: 'REPLY:BEFORE_SWITCH',
    camera: 'synthetic-frame', screen: 'synthetic-frame', playing: true, scopeUnready: false, load: null, readingPauseRequests: 0, bodyInvalidations: 0 };
  const current = { provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:43127/v1', model: 'fixture' },
    persona: cardsApi.compileCharacterPersona(cards.get('active')), model: { path: '/synthetic/current.pmx', name: 'fixture' },
    motion: { path: '/synthetic/current.vmd' }, motionLayers: { pose: 'retained' } };
  let committedScope = { characterId: activeId, providerScope: memoryProviderScope(current.provider) };
  const chat = new AbortController(), agent = new AbortController(), shared = new AbortController();
  const publicState = () => ({ activeId, cards: [...cards.values()].map(value => structuredClone(value)) });
  const characterCards = {
    getActive: () => structuredClone(cards.get(activeId)!), publicState,
    // C1: no preinstalled Gene card among these synthetic cards.
    async presetGeneId() { return null; },
    async save(value: Card, id?: string) { const target = id ?? 'created-' + ++nextId; cards.set(target, { ...(cards.get(target) ?? card(target)), ...structuredClone(value) }); return publicState(); },
    async activate(id: string) { assert.ok(cards.has(id)); activeId = id; return publicState(); },
    async bindModel(id: string, modelPath: string | null, name?: string) { const target = cards.get(id)!; if (modelPath === null) delete target.modelPath; else target.modelPath = modelPath; target.modelName = name; return publicState(); },
  };
  const media = { state: { voiceInput: false, voiceOwner: null, screenSharing: true, cameraSharing: true, cameraOwner: 'pet' },
    clearCamera() { effects.camera = null; }, sharesCameraFrames() { return false; } };
  const screenSnapshots = { state: { enabled: true }, configure() { effects.screen = null; },
    setOptions(value: any) { Object.assign(this.state, value); } };
  const deps = {
    cameraImagesRevoked,
    characterCards, store: { current, async persist(next: any) { Object.assign(current, next); return next; } },
    characterResponseService: {
      async remove(id: string) { cards.delete(id); if (activeId === id) activeId = cards.keys().next().value!; return {}; },
      async import(text: string) { const value = JSON.parse(text); await characterCards.save(value); return { characterId: 'created-' + nextId }; },
      get: (id: string) => ({ characterId: id }),
    },
    companion: { currentScope() { if (effects.scopeUnready) throw Error('scope pending'); return { ...committedScope }; },
      async context(id: string, provider: any, persona: string, parameters: any) {
        effects.contexts.push({ id, persona, parameters }); committedScope = { characterId: id, providerScope: memoryProviderScope(provider) };
      } },
    pending: new Map([['chat', { kind: 'chat', controller: chat }], ['agent', { kind: 'agent', controller: agent }]]),
    media, screenSnapshots, moodModel: current.model.path,
    // 屏幕只读大概: the rough reading (electron/screen-glance.ts) starts and stops with sharing.
    screenGlance: { setSharing(on: boolean) { effects.glance = on; } },
    bodyAuthoring: { invalidate() { effects.bodyInvalidations++; } },
    // The frame being taken for a message (electron/look-attachments.ts): clearing the vision context drops it.
    lookAttachments: { abort() { shared.abort(); }, get busy() { return !shared.signal.aborted; } },
    // 屏幕只读大概: clearing the vision context also closes her look offer (and the pet's prompt).
    lookTurns: { clear() { effects.lookOfferClears = (effects.lookOfferClears ?? 0) + 1; } },
    stopSystemAudio() { effects.stops++; }, ambientComments: { clear() { effects.comments++; } },
    proactiveSpeechGate: { cancel() { effects.cueCancels++; } }, cancelProactiveVision() { effects.visionCancels++; },
    speechRuntime: { stop() { effects.speechStops++; effects.playing = false; } }, replySpeechStyles: { clear() { effects.styleClears++; } },
    broadcast(channel: string, value: any) { effects.events.push({ channel, value }); if (channel === 'desk:vision-context-cleared') effects.body = ''; },
    refreshVisionContext() { effects.refreshed++; }, publishVisionState() { effects.published++; },
    bundledAssets: { async getDefaultAssets() { return effects.load ? await effects.load : { model: { path: '/synthetic/gene.pmx' } }; } },
    assets: { async register(modelPath: string) { return { path: modelPath }; } }, motionLibrary: { cancel() {} },
    compileCharacterPersona: cardsApi.compileCharacterPersona, effectiveCharacterMood: cardsApi.effectiveCharacterMood, memoryProviderScope,
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: ['/synthetic/import.json'] }; } }, controls: {},
    async stat() { return { size: 256 }; }, async readFile() { return JSON.stringify(draft(card('imported'))); },
    CompletedReplySpeech, VisualSelfRuntime, VoiceChatHost, suspendAmbientSpeech() { effects.readingPauseRequests++; }, windows: () => [],
  };
  // Actual sync() is an external port here; its model/privacy implementation is
  // separately checked byte-identical below, rather than copied into this fixture.
  (deps as any).sync = () => { effects.syncs++; };
  const api = make({ ...deps, sync: (deps as any).sync });
  return { api, cards, effects, current, chat, agent, shared, media, characterCards,
    invoke: (name: string, ...args: any[]) => api.registrations.get(name).callback(...args) };
}
function retained(f: ReturnType<typeof fixture>) {
  assert.equal(f.effects.body, 'REPLY:BEFORE_SWITCH'); assert.equal(f.effects.playing, true);
  assert.equal(f.effects.camera, 'synthetic-frame'); assert.equal(f.effects.screen, 'synthetic-frame');
  assert.equal(f.chat.signal.aborted, false); assert.equal(f.shared.signal.aborted, false);
  for (const name of ['stops','comments','cueCancels','visionCancels','speechStops','styleClears']) assert.equal(f.effects[name], 0, name);
  assert.equal(f.effects.bodyInvalidations, 0, 'unrelated edits retain the active body authoring session');
  assert.ok(f.effects.events.every((value: any) => ['desk:characters','desk:character-response'].includes(value.channel)));
}
function revoked(f: ReturnType<typeof fixture>) {
  assert.equal(f.effects.body, ''); assert.equal(f.effects.playing, false);
  assert.equal(f.effects.camera, null); assert.equal(f.effects.screen, null);
  assert.equal(f.chat.signal.aborted, true); assert.equal(f.shared.signal.aborted, true);
  assert.equal(f.agent.signal.aborted, false, 'character change does not inherit agent cancellation permissions');
  assert.equal(f.effects.bodyInvalidations, 1, 'actual context revocation invalidates body authoring');
  assert.equal(f.effects.contexts.length, 1); assert.equal(f.effects.refreshed, 1); assert.equal(f.effects.published, 1);
}

test('original actual inactive save reproduces the clearVisionContext/chat-cleared chain', { skip: !originalText }, async () => {
  const f = fixture(factory(originalText!)); await f.invoke('saveCharacterCard', draft(card('new')));
  assert.equal(f.characterCards.getActive().id, 'active');
  assert.equal(f.effects.body, ''); assert.ok(f.effects.events.some((value: any) => value.channel === 'desk:vision-context-cleared'));
});
test('inactive create/edit/import/delete/model binding publish metadata while retaining active chat/media/voice', async () => {
  const operations = [
    (f: ReturnType<typeof fixture>) => f.invoke('saveCharacterCard', draft(card('new'))),
    (f: ReturnType<typeof fixture>) => f.invoke('saveCharacterCard', draft(card('inactive', { greeting: 'new inactive greeting' })), 'inactive'),
    (f: ReturnType<typeof fixture>) => f.invoke('importCharacterCard'),
    (f: ReturnType<typeof fixture>) => f.invoke('deleteCharacterCard', 'inactive'),
    (f: ReturnType<typeof fixture>) => f.invoke('bindCharacterModel', 'inactive', true),
    (f: ReturnType<typeof fixture>) => f.invoke('bindCharacterModel', 'active', true),
    (f: ReturnType<typeof fixture>) => f.invoke('bindCharacterModel', 'active', false),
  ];
  for (const operation of operations) {
    const f = fixture(); await operation(f); retained(f);
    assert.equal(f.effects.contexts.length, 0, 'same active template must not be reapplied via a metadata update');
    assert.equal(f.effects.refreshed, 0); assert.equal(f.characterCards.getActive().id, 'active');
    assert.ok(f.effects.events.some((value: any) => value.channel === 'desk:characters'));
  }
});
test('inactive mood changes preserve active template; actual active template changes still refresh context without revoking', async () => {
  const f = fixture(), next = card('inactive'); next.mood.parameters.sensitivity.E = 1.2;
  await f.invoke('saveCharacterCard', draft(next), 'inactive'); retained(f); assert.equal(f.effects.contexts.length, 0);
  const active = card('active'); active.mood.parameters.sensitivity.E = 1.4;
  await f.invoke('saveCharacterCard', draft(active), 'active');
  assert.equal(f.effects.contexts.length, 1); assert.equal(f.effects.contexts[0].parameters.sensitivity.E, 1.4);
  assert.equal(f.effects.refreshed, 1); assert.equal(f.effects.published, 1); retained(f);
});
test('active persona, legacy name and greeting edits revoke old display/media/speech and requests', async () => {
  for (const change of [{ systemPrompt: 'New actual persona' }, { name: 'Renamed legacy role' }, { greeting: 'New greeting' }]) {
    const f = fixture(); await f.invoke('saveCharacterCard', draft(card('active', change)), 'active'); revoked(f);
  }
});
test('real active identity/provider/model differences and unresolved companion scope fail closed', async () => {
  for (const change of ['identity','provider','model','unresolved']) {
    const f = fixture(), previous = f.characterCards.getActive();
    if (change === 'identity') await f.characterCards.activate('inactive');
    if (change === 'provider') f.current.provider.model = 'new-provider-model';
    if (change === 'model') f.current.model.path = '/synthetic/replaced.pmx';
    if (change === 'unresolved') f.effects.scopeUnready = true;
    await f.api.syncCharacter(false, previous); revoked(f);
  }
});
test('explicit activation including same ID and active deletion retain the original revocation behavior', async () => {
  for (const [name, id] of [['activateCharacterCard','active'],['activateCharacterCard','inactive'],['deleteCharacterCard','active']]) {
    const f = fixture(); await f.invoke(name, id); revoked(f);
  }
});
test('explicit activation cancels before awaiting associated model resolution; failure keeps a safe fallback', async () => {
  const f = fixture(); f.cards.get('inactive')!.modelPath = 'bundled:gene';
  let reject!: (error: Error) => void; f.effects.load = new Promise((_resolve, fail) => { reject = fail; });
  const changing = f.invoke('activateCharacterCard', 'inactive');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.effects.speechStops, 1); assert.equal(f.chat.signal.aborted, true); assert.equal(f.effects.contexts.length, 0);
  reject(new Error('synthetic missing model')); const state = await changing;
  assert.ok(state.notice); assert.equal(f.current.model.path, '/synthetic/current.pmx'); revoked(f);
});
test('sharing off retains actual mediaChanged privacy clear and abort; provider handler and controls-only writes remain unchanged', async () => {
  const f = fixture(), previous = { ...f.media.state }; f.media.state.screenSharing = false;
  f.api.mediaChanged(previous);
  assert.equal(f.effects.body, ''); assert.equal(f.shared.signal.aborted, true); assert.equal(f.chat.signal.aborted, true);
  assert.equal(f.effects.bodyInvalidations, 1, 'sharing-off revokes the actual body authoring dependency');
  assert.equal(f.effects.glance, false, 'sharing off stops the rough reading');
  assert.equal(f.effects.lookOfferClears, 1, 'and closes her look offer');
  for (const name of handlerNames) assert.equal(f.api.registrations.get(name).controlOnly, true);
  if (originalText) {
    const old = tree(originalText), current = tree(updatedText);
    assert.equal(registration(current, 'saveSettings'), registration(old, 'saveSettings'));
    assert.equal(declaration(current, 'mediaChanged'), declaration(old, 'mediaChanged'));
    assert.equal(declaration(current, 'clearVisionContext').replace(/  (?:languageAuthoring|visualAuthoring|bodyAuthoring|surprisePreviewHost)\?\.invalidate\(\);\r?\n/g, ''), declaration(old, 'clearVisionContext'));
  }
});
