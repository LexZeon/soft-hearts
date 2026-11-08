import { lookOfferAllowed, perceptionTurnLine, perceptionTurnState } from '../shared/perception-rule';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { NO_LISTEN_ASK } from '../electron/listen-together/core';
import { scanBreathRequest } from '../shared/breath-request';
import { ReplyRhythmHost } from '../electron/reply-rhythm-host';
import { applyPetTopmost } from '../electron/pet-topmost';
import { applyPetWindowSettings, keepPetInWorkArea } from '../electron/pet-window-settings';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import ts from 'typescript';
import { AssetRegistry } from '../electron/assets';
import { MutationQueue } from '../electron/mutation-queue';
import { atomicWriteFile } from '../electron/atomic-file';
import { SettingsStore, publicSettings, type SecretStorage } from '../electron/settings';
import { CompanionService, memoryProviderScope, type CompanionTurn } from '../electron/companion';
import { CompanionCommandHost } from '../electron/companion-command-host';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { createCommandDialogueTurn } from '../electron/companion-command-dialogue';
import { scanFramingRequest } from '../shared/framing-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { WindowVisibility } from '../electron/window-visibility';
import { SingleEmojiCues } from '../electron/single-emoji-cues';
import { chatFailureEvent } from '../electron/chat-failure-event';
import { DraftOnlyReplyError } from '../electron/chat-incident-log';
import { DEFAULT_EMOJI_SETTINGS } from '../shared/single-emoji';
import { sizedPetBounds, scaledPetBounds } from '../electron/pet-view';
import { PetPointerInput } from '../electron/pet-pointer-input';
import { UserProfileStore } from '../electron/user-profile';
import { UserProfileManagement } from '../electron/user-profile-management';
import { UserProfileContext } from '../electron/user-profile-context';
import { UserProfileSource } from '../electron/user-profile-source';
import { UserProfileReplyCollector } from '../electron/user-profile-reply';
import { VisualSelfRuntime } from '../electron/visual-self-runtime';
import { validateChatRequest } from '../electron/validation';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import { ChatSettingProposals } from '../electron/chat-settings';
import type { CompanionCommandView } from '../shared/companion-commands';
import type { StreamEvent } from '../shared/contracts';
import type { MemoryMessagePage, MemoryReadQuery } from '../shared/memory';

// Read the assembled Main under test. Never import Electron or execute app startup.
// The acceptance, sender/frame guard, task owner, native presentation callback,
// serialized commit and sync below are actual source, not test reimplementations.
const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const nodes: ts.Node[] = [];
function visit(node: ts.Node): void { nodes.push(node); ts.forEachChild(node, visit); }
visit(ast);
function one<T extends ts.Node>(items: T[], label: string): T {
  assert.equal(items.length, 1, `Actual Main must have one ${label}`); return items[0];
}
function fn(name: string): string {
  return one(ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name), name).getText(ast);
}
function declaration(name: string): ts.VariableDeclaration {
  return one(nodes.filter((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText(ast) === name), name);
}
function scopedCall(name: string): ts.CallExpression {
  const call = one(nodes.filter((n): n is ts.CallExpression => ts.isCallExpression(n)
    && n.expression.getText(ast) === 'scopedHost' && ts.isStringLiteral(n.arguments[0])
    && n.arguments[0].text === name), `${name} scopedHost registration`);
  assert.equal(call.arguments[2]?.getText(ast), 'false'); return call;
}
const hostConstructor = one(nodes.filter((n): n is ts.NewExpression => ts.isNewExpression(n)
  && n.expression.getText(ast) === 'CompanionCommandHost'), 'CompanionCommandHost construction');
const visibilityListener = declaration('publishVisibility').initializer;
assert.ok(visibilityListener && ts.isArrowFunction(visibilityListener));
const visibilityRegistrations = nodes.filter((n): n is ts.CallExpression => ts.isCallExpression(n)
  && n.expression.getText(ast) === 'win.on' && n.arguments[1]?.getText(ast) === 'publishVisibility');
assert.deepEqual(visibilityRegistrations.map(n => (n.arguments[0] as ts.StringLiteral).text).sort(), ['hide', 'minimize', 'restore', 'show']);
const navigationRegistration = one(nodes.filter((n): n is ts.CallExpression => ts.isCallExpression(n)
  && n.expression.getText(ast) === 'win.webContents.on' && ts.isStringLiteral(n.arguments[0])
  && n.arguments[0].text === 'did-start-navigation' && n.arguments[1].getText(ast).includes('companionCommands?.invalidate()')), 'command navigation invalidation');
const emojiPetLifecycleRegistrations = nodes.filter((n): n is ts.CallExpression => ts.isCallExpression(n)
  && n.expression.getText(ast) === 'pet.on' && ts.isStringLiteral(n.arguments[0])
  && ['hide', 'minimize'].includes(n.arguments[0].text)
  && n.arguments[1]?.getText(ast).includes('singleEmojiCues?.invalidate()'));
assert.deepEqual(emojiPetLifecycleRegistrations.map(n => (n.arguments[0] as ts.StringLiteral).text).sort(), ['hide', 'minimize']);
const helpers = ['companionBreathTarget', 'noteCompanionBreathWrite', 'commitCompanionBreath', 'currentProfileMessage', 'acceptProfileMessage', 'visualSelfData', 'chatContextData',
  'companionCommandContext', 'companionCommandTarget', 'companionFramingTarget', 'noteCompanionTopmostWrite', 'noteCompanionVisibilityWrite',
  'noteCompanionFollowMouseWrite', 'commitCompanionTopmost', 'commitCompanionVisibility', 'commitCompanionFollowMouse', 'commitCompanionCommand', 'cancelProactiveVision',
  'companionReadoutVolumeTarget', 'noteCompanionReadoutVolumeWrite', 'commitCompanionReadoutVolume',
  'companionReadoutStopTarget', 'stopCompanionReadout', 'cancelCompletedReply',
  'noteVisionUserActivity', 'nativeVisibility', 'publishWindowVisibility', 'sync', 'ownerFor', 'scopedHost', 'broadcast', 'send', 'launchTask',
  'singleEmojiContext', 'refreshSingleEmojiContext'];
const compiled = ts.transpileModule(`
const mutations = new MutationQueue();
let companionCommands = null, companionCommandExpiry = null, petFraming = null;
let companionCommandRevision = 0, companionCommandObservedTop = store.current.pet.alwaysOnTop;
let companionVisibilityRevision = 0, companionVisibilityObserved = store.current.pet.visible;
let companionBreathRevision = 0, companionBreathObserved = store.current.pet.breath;
let companionFollowMouseRevision = 0, companionFollowMouseObserved = store.current.pet.followMouse;
let companionReadoutVolumeRevision = 0, companionReadoutVolumeObserved = store.current.voice.volume;
let userInputUntil = 0, visionGeneration = 0, lastVisionSpeech = null;
const voiceHost = { history: null, capture: null, busy: false }; // No voice capture in this visibility fixture (R33 host state).
let bodyModelGeneration = 0, windowOperationRevision = 0;
let bodyModelKey = JSON.stringify([null, null]), bodySelectionKey = null, moodModel = null;
let surprisePreviewHost = undefined; // Exact initial state: this visibility-only fixture opens no surprise preview.
let observedEmojiContext = '';
const singleEmojiWindow = null; // This host fixture has no Electron glyph window.
const chatAvailability = { notice: () => undefined, quietFailure: error => error }; // launchTask asks for an "outage" notice on a failed chat; this fixture has no Claude outage.
const chatIncidents = { record: () => false }; // The developer-mode incident log is outside this fixture.
const singleEmojiCues = new SingleEmojiCues({
  context: singleEmojiContext,
  settings: () => ({...DEFAULT_EMOJI_SETTINGS, enabled: true}),
  available: () => !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(),
  // Explicit synthetic glyph boundary only; the real cue/context logic runs.
  show: cue => { emojiBoundary.shown.push(cue); emojiBoundary.active = true; return true; },
  hide: () => { emojiBoundary.active = false; emojiBoundary.clears++; },
});
let appliedPetScale = store.current.pet.scale ?? 1, appliedPetSize = JSON.stringify(store.current.pet.size ?? null);
const windowVisibility = new WeakMap();
const ${declaration('mutate').getText(ast)};
const ${declaration('windows').getText(ast)};
${helpers.map(fn).join('\n')}
companionCommands = ${hostConstructor.getText(ast)};
${scopedCall('chooseCompanionCommand').getText(ast)};
${scopedCall('chat').getText(ast)};
function bindWindow(win) {
  const windowId = win.webContents.id, owner = ownerFor(windowId);
  const publishVisibility = ${visibilityListener.getText(ast)};
  ${visibilityRegistrations.map(n => n.getText(ast) + ';').join('\n')}
  ${navigationRegistration.getText(ast)};
}
bindWindow(controls); bindWindow(pet);
${emojiPetLifecycleRegistrations.map(n => n.getText(ast) + ';').join('\n')}
return {
  syncHost: () => sync(),
  seedEmoji: id => singleEmojiCues.offer(id, 'smile', singleEmojiContext()),
  manual: value => mutate(() => commitCompanionCommand(value, 'pet.set-visible')),
  manualFollowMouse: value => mutate(() => commitCompanionCommand(value, 'pet.set-follow-mouse')),
  manualTopmost: value => mutate(() => commitCompanionCommand(value, 'pet.set-always-on-top')),
  manualVolume: value => mutate(() => commitCompanionReadoutVolume(value)),
  target: (sender, completingOwnHide = false) => companionCommandTarget(sender, 'pet.set-visible', completingOwnHide),
  queue: () => mutations.idle(),
  dispose: () => { singleEmojiCues.dispose(); if (companionCommandExpiry) clearTimeout(companionCommandExpiry); companionCommands.invalidate(); },
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Sent = { channel: string; value: any };
class NativeWindow extends EventEmitter {
  visible: boolean; minimized: boolean; destroyed = false; failHide = false; failSettingsBroadcast = false;
  calls: string[] = []; sent: Sent[] = [];
  bounds = { x: 30, y: 40, width: 400, height: 560 };
  topmost = true;
  webContents: EventEmitter & { id: number; mainFrame: object; isDestroyed(): boolean; send(channel: string, value: unknown): void };
  constructor(id: number, visible: boolean, minimized = false, delivered: (value: Sent) => void) {
    super(); this.visible = visible; this.minimized = minimized;
    this.webContents = Object.assign(new EventEmitter(), { id, mainFrame: {}, isDestroyed: () => this.destroyed,
      send: (channel: string, value: unknown) => {
        if (channel === 'desk:settings' && this.failSettingsBroadcast) throw Error('synthetic settings broadcast failure');
        const record = { channel, value: structuredClone(value) }; this.sent.push(record); delivered(record);
      } });
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isAlwaysOnTop() { return this.topmost; }
  setAlwaysOnTop(value: boolean) { this.topmost = value; this.calls.push('topmost'); }
  moveTop() { this.calls.push('moveTop'); }
  setIgnoreMouseEvents() { this.calls.push('mouse'); }
  getBounds() { return { ...this.bounds }; }
  setBounds(value: typeof this.bounds) { this.bounds = { ...value }; this.calls.push('bounds'); }
  showInactive() { this.visible = true; this.calls.push('show'); this.emit('show'); }
  hide() { this.calls.push('hide'); if (this.failHide) throw Error('synthetic native hide failed'); this.visible = false; this.emit('hide'); }
  restore() { this.minimized = false; this.visible = true; this.calls.push('restore'); this.emit('restore'); }
}
type Fixture = {
  store: SettingsStore; controls: NativeWindow; pet: NativeWindow; profiles: UserProfileStore;
  output(id: string): string; terminal(id: string): StreamEvent[]; views(): CompanionCommandView[];
  send(id: string, text: string, sender?: NativeWindow): Promise<void>;
  invoke(id: string, text: string, sender: unknown, frame: unknown): unknown;
  choose(owner: NativeWindow, requestId: string, choiceId: string, foreignFrame?: boolean): Promise<CompanionCommandView | null>;
  manual(value: boolean): Promise<unknown>; manualFollowMouse(value: boolean): Promise<unknown>;
  manualTopmost(value: boolean): Promise<unknown>; target(sender: number): unknown;
  manualVolume(percent: number): Promise<unknown>;
  plans: CompletedReplySpeech; notices: string[]; speechScope(): string;
  disk(): Promise<any>; writes(): number; failWrite(value: boolean): void; providerCalls: string[];
  archive(id: string, query?: MemoryReadQuery): ReturnType<CompanionService['memory']['read']>;
  syncHost(): void; seedEmoji(id: string): boolean; changeEmojiContext(): Promise<void>;
  emojiBoundary: { active: boolean; shown: unknown[]; clears: number };
};

async function fixture(run: (f: Fixture) => Promise<void>, initial: { desired?: boolean; visible?: boolean; minimized?: boolean; followMouse?: boolean; volume?: number } = {}): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'soft-r41-host-path-'));
  let writes = 0, failWrite = false;
  const secret: SecretStorage = { isEncryptionAvailable: () => false,
    encryptString: () => { throw Error('Fixture has no key'); }, decryptString: () => { throw Error('Fixture has no encrypted key'); } };
  const assets = new AssetRegistry();
  const store = new SettingsStore(root, secret, assets, async (file, data) => {
    assert.equal(file, path.join(root, 'settings.json'));
    if (failWrite) throw Object.assign(Error('synthetic SettingsStore write failure'), { code: 'EIO' });
    await atomicWriteFile(file, data); writes++;
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.model = null; settings.motion = null;
  settings.provider = { kind: 'claude', baseUrl: 'http://127.0.0.1:1/v1', model: 'r41-cpu-fixture' };
  settings.persona = 'Public synthetic visibility fixture.';
  settings.voice.enabled = false; settings.voice.volume = initial.volume ?? 0;
  if (settings.voiceInput) settings.voiceInput.apiKey = '';
  if (settings.tts) settings.tts.apiKey = '';
  settings.pet.visible = initial.desired ?? true;
  if (initial.followMouse !== undefined) settings.pet.followMouse = initial.followMouse;
  await writeFile(path.join(root, 'settings.json'), JSON.stringify(settings));
  await store.load();
  const accepted = await store.save(structuredClone(store.current));
  assert.equal(accepted.pet.visible, settings.pet.visible); assert.equal('apiKey' in accepted.provider, false);
  assert.equal(accepted.model, null); assert.equal(accepted.motion, null); writes = 0;
  const initialDisk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  const pending = new Map<string, { owner: number; kind: string; controller: AbortController }>();
  const terminalEvents: StreamEvent[] = [], deliveries: Sent[] = [], waiters = new Map<string, () => void>();
  const delivered = (record: Sent) => {
    deliveries.push(record);
    if (record.channel === 'desk:stream' && ['done', 'error'].includes(record.value.type)) {
      terminalEvents.push(record.value); waiters.get(record.value.id)?.();
    }
  };
  const controls = new NativeWindow(42, true, false, delivered);
  const pet = new NativeWindow(99, initial.visible ?? settings.pet.visible, initial.minimized ?? false, () => {});
  const companion = new CompanionService(path.join(root, 'ordinary'), () => {});
  const turns = new Map<string, CompanionTurn>(), originalBegin = companion.begin.bind(companion);
  companion.begin = async (...args) => { const turn = await originalBegin(...args); turns.set(turn.id, turn); return turn; };
  let userProfileContext: UserProfileContext | undefined;
  const profiles = new UserProfileStore(path.join(root, 'profiles'), { onInvalidated: () => userProfileContext?.invalidate() });
  userProfileContext = new UserProfileContext(profiles);
  const management = new UserProfileManagement(profiles, () => {}, () => companion.currentScope());
  const visualSelfRuntime = new VisualSelfRuntime();
  const ipc = new Map<string, (event: any, ...args: any[]) => any>();
  const notices: string[] = [], providerCalls: string[] = [];
  const acceptedIds: string[] = [], rewards: Array<{ type: string; id: string }> = [];
  const note = (name: string) => () => { notices.push(name); };
  const plans = new CompletedReplySpeech();
  const emojiBoundary = { active: false, shown: [] as unknown[], clears: 0 };
  const forbidden = (name: string) => () => { throw Error(`Outside visibility fixture: ${name}`); };
  const env = {
    MutationQueue,
    store, controls, pet, companion, pending, createHash, randomUUID, memoryProviderScope, path,
    SingleEmojiCues, DEFAULT_EMOJI_SETTINGS, emojiBoundary,
    chatFailureEvent, DraftOnlyReplyError,
    CompanionCommandHost, classifyCompanionCommand, formatCompanionCommandReceipt, createCommandDialogueTurn, scanBreathRequest, scanFramingRequest, scanStopReadoutRequest,
    completedReplySpeech: plans, suspendAmbientSpeech: note('speech-gate'),
    // R27 developer-mode timing probe (electron/reply-latency.ts) is outside this target.
    replyLatency: { begin() {}, delta() {}, complete() {}, end() {} },
    publicSettings, WindowVisibility, sizedPetBounds, scaledPetBounds, validateChatRequest,
    UserProfileReplyCollector, userProfiles: profiles, userProfileManagement: management, userProfileContext,
    userProfileSource: new UserProfileSource(), visualSelfRuntime,
    ipcMain: { handle: (name: string, handler: (event: any, ...args: any[]) => any) => { assert.ok(!ipc.has(name)); ipc.set(name, handler); } },
    characterCards: { getActive: () => ({ id: 'r41-character' }) }, personalizeLanguage: undefined, speechScope: () => companion.currentSpeechScope(),
    r20ProactiveOffers:null, rps: { host: { chatTurn: () => null, chatDone: () => {} } }, moduleRouter: { userTurn: () => {} }, moodJudge: { host: { userText: () => {} } }, reactions: { userTurn: () => {}, firstChar: () => {}, host: { asking: () => false } }, senseRouter: { userTurn() {}, cancel() {}, firstChar() {}, hint: () => '', replyDone() {} }, pauseTalk: { userTurn: () => null, delta() {}, cancel() {} }, journalCharacterId: () => null, textMemorialHost: null, ambientComments: undefined, ambientAudio: undefined,
    // 识图第 1 步 (electron/main.ts chat handler): this turn's perception line and her offer to look; sharing off here.
    media: { state: { screenSharing: false, cameraSharing: false }, revision: 0 }, perceptionTurnState, perceptionTurnLine, lookOfferAllowed, lookScope: () => '', lookTurns: new LookTurns(), herState: { chatTurn: () => undefined }, turnAwareness: { line: () => '' },
    roughForTurn: () => undefined, // 屏幕只读大概: sharing off here, so nothing about what the user does
    // 关掉之后的旧帧: the chat handler asks which attachments may still go (none are shared frames here).
    lookAttachments: new LookAttachments(new LookTurns(), { noteActivity() {}, state: () => ({ screen: false, camera: false, scope: '' }), sharesCameraFrames: () => false,
      revision: () => 0, generation: () => 0, opening: () => 0, captureScreen: async () => null, captureCamera: async () => null }),
    applyPetTopmost, applyPetWindowSettings, keepPetInWorkArea,
    listenTogether: null, // I-016 一起听: not started in this fixture (a question about what she heard adds nothing)
    NO_LISTEN_ASK, // I-021: what a turn gets without 一起听 (tests/listen-late-window.test.ts)
    visionPresentation: { clear: note('vision-clear') }, proactiveVision: { cancel: note('vision-cancel') },
    cameraSamples: { cancel: note('camera-cancel') }, proactiveSpeechGate: { cancel: note('proactive-cancel') },
    cancelAmbientPlayback: note('ambient-cancel'), refreshVisualSelfContext: note('visual-context'),
    revokeVoice: note('voice-revoke'), syncFatigueActivity: note('fatigue'),
    speechRuntime: { stop: note('speech-stop'), cancelReply: note('exact-reply-cancel') }, clearReplySpeech: note('reply-clear'),
    cancelReplyStyle: note('style-cancel'), petWindowDrag: null, petReply: null,
    // Click-through ignore flag (electron/pet-pointer-input.ts); the cursor never matters with click-through off.
    petPointerInput: new PetPointerInput({ window: () => pet, cursor: () => ({ x: 0, y: 0 }) }),
    fatigueActivity: { setSelection: note('fatigue-selection') }, refreshVisionContext: note('vision-context'), updateTray: note('tray'),
    stopSystemAudio: note('audio-stop'), releaseHiddenCamera: note('hidden-camera-release'),
    clearVisionContext: note('vision-context-clear'),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    replySpeechStyles: { begin: note('style-begin'), complete: forbidden('completed provider speech'), cancel: note('exact-style-cancel') },
    replyRhythm: new ReplyRhythmHost(),
    claudeChat: { stream: async () => { providerCalls.push('chat'); throw Error('Synthetic fixture forbids provider dispatch'); } },
    chatSettings: new ChatSettingProposals({ settings: () => store.current, send: forbidden('chat settings card') }),
    // Ordinary chat goes to the persistent Claude session; these only prepare that (forbidden) dispatch.
    freezeTurnSpeechStyle: () => {}, buildCodexChatPrompt: () => '', characterSpeechPersona: () => '', completedFatigueFeeling: () => undefined,
    effectiveTtsConfig: () => DEFAULT_TTS_CONFIG, DEFAULT_TTS_CONFIG, app: { getPath: () => root }, PROFILE_FOLDER: 'synthetic-profile',
    streamClaude: async () => { providerCalls.push('codex'); throw Error('Synthetic fixture forbids Claude dispatch'); },
  };
  type Actual = { manual(value: boolean): Promise<unknown>; manualFollowMouse(value: boolean): Promise<unknown>;
    manualVolume(percent: number): Promise<unknown>;
    manualTopmost(value: boolean): Promise<unknown>; target(sender: number): unknown; queue(): Promise<unknown>; dispose(): void;
    syncHost(): void; seedEmoji(id: string): boolean };
  let actual: Actual | undefined;
  try {
    await companion.load(); await companion.context('r41-character', store.current.provider, store.current.persona);
    const originalMoodEvent = companion.mood.event.bind(companion.mood);
    companion.mood.event = (...args) => {
      rewards.push({ type: args[0].type, id: args[0].id }); return originalMoodEvent(...args);
    };
    await management.activate(companion.currentScope());
    const profile = management.get(); assert.ok(profile);
    management.setEnabled({ scopeId: profile.scopeId, generation: profile.generation, revision: profile.revision, enabled: true });
    actual = new Function(...Object.keys(env), compiled)(...Object.values(env)) as Actual;
    const invoke = (id: string, text: string, sender: any, frame: unknown) => ipc.get('desk:chat')!({ sender, senderFrame: frame },
      { id, messages: [{ role: 'user', content: text }], attachments: [] });
    await run({ store, controls, pet, profiles, providerCalls, plans, notices, speechScope: () => companion.currentSpeechScope(),
      output: id => controls.sent.filter(r => r.channel === 'desk:stream' && r.value.id === id && r.value.type === 'delta').map(r => r.value.text).join(''),
      terminal: id => terminalEvents.filter(r => r.id === id),
      views: () => deliveries.filter(r => r.channel === 'desk:companion-command').map(r => r.value),
      invoke,
      async send(id, text, sender = controls) {
        let resolve!: () => void; const completed = new Promise<void>(r => { resolve = r; });
        waiters.set(id, resolve); let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          invoke(id, text, sender.webContents, sender.webContents.mainFrame);
          assert.equal(pending.has(id), true); acceptedIds.push(id);
          await Promise.race([completed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Owned Main task did not settle')), 5000); })]);
          await nextTurn(); assert.equal(pending.has(id), false);
          const terminal = terminalEvents.filter(r => r.id === id); assert.equal(terminal.length, 1);
          if (terminal[0].type === 'error') throw Error(terminal[0].text);
        } finally { if (timeout) clearTimeout(timeout); waiters.delete(id); }
      },
      choose: async (owner, requestId, choiceId, foreignFrame = false) => ipc.get('desk:chooseCompanionCommand')!({
        sender: owner.webContents, senderFrame: foreignFrame ? {} : owner.webContents.mainFrame }, { requestId, choiceId }),
      manual: value => actual!.manual(value), manualFollowMouse: value => actual!.manualFollowMouse(value),
      manualTopmost: value => actual!.manualTopmost(value), target: sender => actual!.target(sender),
      manualVolume: value => actual!.manualVolume(value),
      disk: async () => JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')),
      writes: () => writes, failWrite: value => { failWrite = value; },
      syncHost: () => actual!.syncHost(), seedEmoji: id => actual!.seedEmoji(id), emojiBoundary,
      changeEmojiContext: async () => {
        await companion.context('r41-next-synthetic-character', store.current.provider, store.current.persona);
        actual!.syncHost();
      },
      archive: (id, query) => { const turn = turns.get(id); assert.ok(turn); return companion.memory.read(turn.scope, turn.recordId, query); },
    });
    const finalDisk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
    const withoutVisibility = (value: any) => { const clone = structuredClone(value); delete clone.pet.visible; return clone; };
    assert.deepEqual(withoutVisibility(finalDisk), withoutVisibility(initialDisk), 'Visibility must not normalize unrelated saved settings.');
    assert.equal(profiles.view().entries.length, 0, 'Command turns must not become additional literal-profile collection.');
    assert.deepEqual(rewards.filter(event => event.type === 'chat').map(event => event.id), acceptedIds,
      'Each actual accepted turn earns its original chat event once; choices/manual changes create none.');
    assert.equal(rewards.filter(event => event.type === 'appraisal').length, 0,
      'Plain host receipts carry no model appraisal and cannot mint a second reward.');
  } finally {
    for (const task of pending.values()) task.controller.abort();
    actual?.dispose(); management.dispose(); visualSelfRuntime.dispose();
    await companion.flush(); await nextTurn();
    assert.equal(pending.size, 0, 'Retain owned fixture files if an actual Main task is unresolved.');
    const physical = await realpath(root), temp = await realpath(tmpdir());
    assert.equal(path.dirname(physical), temp); assert.ok(path.basename(physical).startsWith('soft-r41-host-path-'));
    await rm(physical, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

test('actual controls chat shows the hidden pet through real SettingsStore, serialized Main commit and dialogue', async () => {
  await fixture(async f => {
    await f.send('show-hidden', '把桌宠显示出来');
    assert.equal(f.store.current.pet.visible, true); assert.equal((await f.disk()).pet.visible, true); assert.equal(f.writes(), 1);
    assert.equal(f.pet.visible, true); assert.ok(f.pet.calls.includes('show')); assert.ok(!f.pet.calls.includes('bounds'));
    assert.equal(f.output('show-hidden'), '桌宠窗口已显示。'); assert.deepEqual(f.providerCalls, []);
    const receipt = f.views().at(-1)!.receipt!; assert.equal(receipt.actionId, 'pet.set-visible');
    assert.equal(receipt.persistence, 'saved'); assert.equal(receipt.nativeValue, true);
    assert.deepEqual(f.archive('show-hidden')!.messages.map(m => [m.role, m.content, m.status]), [
      ['user', '把桌宠显示出来', 'complete'], ['assistant', '桌宠窗口已显示。', 'complete'],
    ]);
  }, { desired: false, visible: false });
});

test('actual Main sync preserves a current emoji, retires context changes, and real pet hide hook clears without reward or native glyph', async () => {
  await fixture(async f => {
    f.syncHost();
    assert.equal(f.seedEmoji('current-host-event'), true);
    assert.equal(f.emojiBoundary.active, true);
    const clears = f.emojiBoundary.clears;
    f.syncHost();
    assert.equal(f.emojiBoundary.active, true);
    assert.equal(f.emojiBoundary.clears, clears, 'Unchanged sync must not retire the same current cue.');
    await f.changeEmojiContext();
    assert.equal(f.emojiBoundary.active, false);
    assert.ok(f.emojiBoundary.clears > clears);
    assert.equal(f.emojiBoundary.shown.length, 1);
    assert.deepEqual(f.providerCalls, []);
    assert.equal(f.writes(), 0);
  });
  await fixture(async f => {
    f.syncHost();
    assert.equal(f.seedEmoji('before-real-hide'), true);
    await f.manual(false);
    assert.equal(f.pet.visible, false);
    assert.equal(f.emojiBoundary.active, false, 'Actual pet.on hide callback retires the real cue controller.');
    assert.equal(f.emojiBoundary.shown.length, 1);
    assert.deepEqual(f.providerCalls, []);
  });
});

test('desired-visible minimized pet restores native display without pretending another settings write', async () => {
  await fixture(async f => {
    await f.send('restore-minimized', '显示桌宠');
    assert.equal(f.writes(), 0); assert.equal((await f.disk()).pet.visible, true);
    assert.equal(f.pet.minimized, false); assert.ok(f.pet.calls.includes('restore'));
    assert.equal(f.views().at(-1)!.receipt!.persistence, 'unchanged');
    assert.equal(f.views().at(-1)!.receipt!.nativeValue, true); assert.equal(f.output('restore-minimized'), '桌宠窗口已显示。');
    assert.deepEqual(f.providerCalls, []);
  }, { desired: true, visible: true, minimized: true });
});

test('controls hide and issued own-pet hide keep truthful receipt and completed dialogue at controls', async () => {
  for (const ownPet of [false, true]) await fixture(async f => {
    const id = ownPet ? 'pet-own-hide' : 'controls-hide';
    await f.send(id, '请隐藏桌宠', ownPet ? f.pet : f.controls);
    assert.equal(f.pet.visible, false); assert.equal(f.controls.visible, true); assert.equal(f.writes(), 1);
    assert.equal((await f.disk()).pet.visible, false); assert.equal(f.output(id), '桌宠窗口已隐藏。');
    assert.equal(f.views().at(-1)!.receipt!.nativeValue, false); assert.equal(f.terminal(id)[0].type, 'done');
    assert.equal(f.target(f.pet.webContents.id), null, 'A later hidden pet request gets no continuing-own-hide privilege.');
    assert.deepEqual(f.providerCalls, []);
  });
});

test('actual controls command refuses an unavailable pet without provider fallback, persistence or a new window', async () => {
  await fixture(async f => {
    const existingPet = f.pet;
    f.pet.destroyed = true;
    await f.send('show-unavailable', '显示桌宠');
    assert.equal(f.writes(), 0); assert.equal(f.store.current.pet.visible, false);
    assert.equal((await f.disk()).pet.visible, false); assert.deepEqual(f.providerCalls, []);
    assert.equal(f.pet, existingPet); assert.equal(f.pet.destroyed, true);
    assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []);
    const receipt = f.views().at(-1)!.receipt!;
    assert.equal(receipt.actionId, 'pet.set-visible'); assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.persistence, 'not-committed'); assert.equal(receipt.presentation, 'not-requested');
    const body = f.output('show-unavailable'); assert.ok(body.trim());
    assert.equal(body, formatCompanionCommandReceipt(receipt));
    assert.deepEqual(f.terminal('show-unavailable').map(event => event.type), ['done']);
    assert.deepEqual(f.archive('show-unavailable')!.messages.map(m => [m.role, m.content, m.status]), [
      ['user', '显示桌宠', 'complete'], ['assistant', body, 'complete'],
    ]);
  }, { desired: false, visible: false });
});

test('actual scoped sender/frame gate, quote boundary, cancellation, stale choice and manual conflict refuse extra writes', async () => {
  await fixture(async f => {
    assert.throws(() => f.invoke('foreign', '隐藏桌宠', { id: 500, mainFrame: {} }, {}), /来源未授权/);
    assert.throws(() => f.invoke('foreign-frame', '隐藏桌宠', f.controls.webContents, {}), /来源未授权/);
    assert.equal(f.views().length, 0); assert.equal(f.writes(), 0);
    await assert.rejects(f.send('quoted', '他说“隐藏桌宠”'), /forbids provider dispatch/);
    assert.equal(f.writes(), 0); assert.equal(f.pet.visible, true); assert.deepEqual(f.providerCalls, ['chat']);
    await f.send('clarify-cancel', '我看不到桌宠了');
    let view = f.views().at(-1)!; assert.equal(view.choices.length, 3);
    assert.equal(await f.choose(f.pet, view.requestId, view.choices[0].choiceId), null);
    await assert.rejects(f.choose(f.controls, view.requestId, view.choices[0].choiceId, true), /来源未授权/);
    const cancelled = await f.choose(f.controls, view.requestId, view.choices.find(c => c.label === '取消')!.choiceId);
    assert.equal(cancelled!.receipt!.status, 'cancelled'); assert.equal(f.writes(), 0);
    await f.send('clarify-stale', '我看不到桌宠了'); view = f.views().at(-1)!;
    f.pet.webContents.emit('did-start-navigation');
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId), null); assert.equal(f.writes(), 0);
    await f.send('clarify-conflict', '我看不到桌宠了'); view = f.views().at(-1)!;
    await f.manual(false); assert.equal(f.writes(), 1);
    const conflict = await f.choose(f.controls, view.requestId, view.choices[0].choiceId);
    assert.equal(conflict!.receipt!.status, 'conflict'); assert.equal(f.writes(), 1);
    assert.equal((await f.disk()).pet.visible, false); assert.deepEqual(f.providerCalls, ['chat']);
  });
});

test('real persistence failure and native presentation failure never produce a successful hide statement', async () => {
  await fixture(async f => {
    f.failWrite(true); await f.send('save-failed', '隐藏桌宠');
    assert.equal(f.writes(), 0); assert.equal(f.store.current.pet.visible, true); assert.equal((await f.disk()).pet.visible, true);
    assert.equal(f.pet.visible, true); assert.match(f.output('save-failed'), /无法确认/);
    assert.equal(f.views().at(-1)!.receipt!.persistence, 'unknown'); assert.deepEqual(f.providerCalls, []);
  });
  await fixture(async f => {
    f.pet.failHide = true; await f.send('native-failed', '隐藏桌宠');
    assert.equal(f.writes(), 1); assert.equal(f.store.current.pet.visible, false); assert.equal((await f.disk()).pet.visible, false);
    assert.equal(f.pet.visible, true); assert.notEqual(f.output('native-failed'), '桌宠窗口已隐藏。');
    const receipt = f.views().at(-1)!.receipt!;
    assert.equal(receipt.persistence, 'saved'); assert.equal(receipt.presentation, 'failed'); assert.equal(receipt.nativeValue, true);
    assert.deepEqual(f.providerCalls, []);
  });
});

// Follow-mouse cases add one existing boolean setting; original six cases above
// remain intact. These phrases must be consumed by the actual integrated parser.
const followOn = '开启桌宠鼠标跟随';
const followOff = '关闭桌宠鼠标跟随';
const followChoice = '调整鼠标跟随';
function withoutFollowMouse(value: any): unknown {
  const copy = structuredClone(value); delete copy.pet.followMouse; return copy;
}
type FollowHistory = ReadonlyArray<Readonly<MemoryMessagePage>>;
function completeFollowHistory(f: Fixture, id: string): FollowHistory {
  // MemoryStore's default page has four messages. These fixtures contain at most
  // three turns, so request the real bounded ten-message page and reject any
  // remaining page/text offset instead of calling a partial page full history.
  const record = f.archive(id, { messageOffset: 0, messageLimit: 10, textOffset: 0, textLimit: 4000 });
  assert.ok(record); assert.equal(record.messageOffset, 0); assert.equal(record.nextMessageOffset, undefined);
  assert.equal(record.messages.length, record.messageCount);
  for (const message of record.messages) {
    assert.equal(message.contentOffset, 0); assert.equal(message.nextTextOffset, undefined);
    assert.equal(message.totalCharacters, Array.from(message.content).length);
    assert.equal(typeof message.id, 'string'); assert.ok(message.id.length > 0);
  }
  return Object.freeze(record.messages.map(message => Object.freeze(structuredClone(message))));
}
function assertFollowReply(f: Fixture, id: string, prior: FollowHistory = [], userText = followOn): NonNullable<CompanionCommandView['receipt']> {
  const receipt = f.views().filter(view => view.requestId === id && view.receipt).at(-1)!.receipt!;
  assert.equal(receipt.actionId, 'pet.set-follow-mouse');
  assert.ok(!Object.hasOwn(receipt, 'nativeValue'), 'A settings acknowledgement must not manufacture gaze/native success.');
  const body = f.output(id); assert.ok(body.trim());
  assert.equal(body, formatCompanionCommandReceipt(receipt));
  assert.deepEqual(f.terminal(id).map(event => event.type), ['done']);
  const messages = completeFollowHistory(f, id);
  assert.equal(messages.length, prior.length + 2, 'Exactly one user/assistant pair is appended for this accepted turn.');
  assert.deepEqual(messages.slice(0, prior.length), prior, 'All earlier message IDs, text, timestamps and status stay unchanged.');
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
  const user = messages[prior.length], assistant = messages[prior.length + 1];
  assert.deepEqual([user.turnId, user.role, user.content, user.status], [id, 'user', userText, 'complete']);
  assert.deepEqual([assistant.turnId, assistant.role, assistant.content, assistant.status], [id, 'assistant', body, 'complete']);
  assert.equal(messages.filter(message => message.turnId === id).length, 2, 'Current request has only its two new message identities.');
  return receipt;
}

test('actual follow-mouse chat saves only the fixed setting, acknowledges once and does not call native presentation', async () => {
  await fixture(async f => {
    const before = await f.disk();
    let previousId: string | null = null;
    for (const [id, text, value, persistence, writes] of [
      ['follow-on', followOn, true, 'saved', 1],
      ['follow-on-repeat', followOn, true, 'unchanged', 1],
      ['follow-off', followOff, false, 'saved', 2],
    ] as const) {
      const prior = previousId === null ? [] : completeFollowHistory(f, previousId);
      await f.send(id, text);
      assert.equal(f.store.current.pet.followMouse, value); assert.equal((await f.disk()).pet.followMouse, value);
      assert.equal(f.writes(), writes); const receipt = assertFollowReply(f, id, prior, text);
      assert.equal(receipt.status, persistence); assert.equal(receipt.persistence, persistence);
      assert.equal(receipt.presentation, 'not-requested'); assert.equal(receipt.value, value);
      previousId = id;
      assert.deepEqual(withoutFollowMouse(await f.disk()), withoutFollowMouse(before),
        'Camera, visibility, topmost, keys and every unrelated persisted field must be preserved.');
      assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []);
    }
    assert.deepEqual(f.providerCalls, []);
  }, { followMouse: false });
});

test('actual follow-mouse unavailable target, persistence failure and broadcast failure remain truthful without provider fallback', async () => {
  await fixture(async f => {
    const before = await f.disk(); f.pet.destroyed = true;
    await f.send('follow-unavailable', followOn); const receipt = assertFollowReply(f, 'follow-unavailable');
    assert.equal(receipt.status, 'rejected'); assert.equal(receipt.persistence, 'not-committed');
    assert.equal(receipt.presentation, 'not-requested'); assert.equal(f.writes(), 0);
    assert.deepEqual(await f.disk(), before); assert.deepEqual(f.providerCalls, []);
    assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []); assert.equal(f.pet.destroyed, true);
  }, { followMouse: false });
  await fixture(async f => {
    const before = await f.disk(); f.failWrite(true);
    await f.send('follow-persist-failed', followOn); const receipt = assertFollowReply(f, 'follow-persist-failed');
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.persistence, 'unknown');
    assert.equal(receipt.presentation, 'not-requested'); assert.equal(f.writes(), 0);
    assert.equal(f.store.current.pet.followMouse, false); assert.deepEqual(await f.disk(), before);
    assert.deepEqual(f.providerCalls, []); assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []);
  }, { followMouse: false });
  await fixture(async f => {
    const before = await f.disk(); f.controls.failSettingsBroadcast = true;
    await f.send('follow-broadcast-failed', followOn); const receipt = assertFollowReply(f, 'follow-broadcast-failed');
    assert.equal(receipt.status, 'saved'); assert.equal(receipt.persistence, 'saved');
    assert.equal(receipt.presentation, 'unknown'); assert.equal(f.writes(), 1);
    assert.equal(f.store.current.pet.followMouse, true); assert.equal((await f.disk()).pet.followMouse, true);
    assert.deepEqual(withoutFollowMouse(await f.disk()), withoutFollowMouse(before));
    f.controls.failSettingsBroadcast = false;
    const prior = completeFollowHistory(f, 'follow-broadcast-failed');
    await f.send('follow-after-broadcast-failure', followOff);
    assert.equal(assertFollowReply(f, 'follow-after-broadcast-failure', prior, followOff).presentation, 'not-requested');
    assert.equal(f.writes(), 2); assert.deepEqual(await f.disk(), before);
    assert.deepEqual(f.providerCalls, []); assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []);
  }, { followMouse: false });
});

test('actual follow-mouse choices ignore unrelated topmost ABA, reject related ABA and cannot repeat an opaque choice', async () => {
  await fixture(async f => {
    const before = await f.disk(), originalTop = f.store.current.pet.alwaysOnTop;
    await f.send('follow-unrelated-cas', followChoice);
    let view = f.views().at(-1)!; assert.equal(view.choices.length, 3);
    await f.manualTopmost(!originalTop); await f.manualTopmost(originalTop);
    assert.equal(f.writes(), 2); const nativeCount = f.pet.calls.length;
    const first = await f.choose(f.controls, view.requestId, view.choices[0].choiceId);
    assert.ok(first?.receipt); assert.notEqual(first.receipt.status, 'conflict');
    assert.ok(first.receipt.status === 'saved' || first.receipt.status === 'unchanged');
    assert.equal(first.receipt.actionId, 'pet.set-follow-mouse'); assert.equal(first.receipt.presentation, 'not-requested');
    assert.ok(!Object.hasOwn(first.receipt, 'nativeValue'));
    assert.equal(f.pet.calls.length, nativeCount, 'Only the explicit manual topmost writes may touch native presentation.');
    const afterFirst = f.writes();
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId), null);
    assert.equal(f.writes(), afterFirst);
    await f.send('follow-related-aba', followChoice); view = f.views().at(-1)!;
    assert.equal(view.choices.length, 3); const value = f.store.current.pet.followMouse;
    await f.manualFollowMouse(!value); await f.manualFollowMouse(value);
    assert.equal(f.writes(), afterFirst + 2); const beforeConflict = await f.disk();
    const conflict = await f.choose(f.controls, view.requestId, view.choices[0].choiceId);
    assert.equal(conflict!.receipt!.status, 'conflict'); assert.equal(conflict!.receipt!.actionId, 'pet.set-follow-mouse');
    assert.equal(f.writes(), afterFirst + 2); assert.deepEqual(await f.disk(), beforeConflict);
    assert.equal(f.pet.calls.length, nativeCount);
    await f.manualFollowMouse(false);
    assert.deepEqual(await f.disk(), before); assert.equal(f.pet.calls.length, nativeCount);
    assert.deepEqual(f.providerCalls, []);
  }, { followMouse: false });
});

const withoutReadoutVolume = (value: any) => {
  const copy = structuredClone(value); delete copy.voice.volume; return copy;
};

test('actual chat volume command persists only future volume through real SettingsStore without enabling reading or provider dispatch', async () => {
  await fixture(async f => {
    const before = await f.disk();
    for (const percent of [0, 40, 100]) {
      const id = `readout-volume-${percent}`, text = `把朗读音量设为 ${percent}%。`;
      await f.send(id, text);
      const disk = await f.disk(), receipt = f.views().at(-1)!.receipt!;
      assert.equal(disk.voice.volume, percent / 100); assert.equal(f.store.current.voice.volume, percent / 100);
      assert.equal(disk.voice.enabled, false); assert.deepEqual(withoutReadoutVolume(disk), withoutReadoutVolume(before));
      assert.equal(receipt.actionId, 'voice.set-volume'); assert.equal(receipt.persistence, 'saved');
      assert.equal(receipt.presentation, 'not-requested'); assert.equal(receipt.value, percent);
      assert.ok(!Object.hasOwn(receipt, 'nativeValue')); assert.match(f.output(id), /后续朗读/);
      const messages = f.archive(id, { messageLimit: 10, textLimit: 4000 })!.messages;
      assert.deepEqual(messages.slice(-2).map(m => [m.role, m.content, m.status]), [
        ['user', text, 'complete'], ['assistant', f.output(id), 'complete'],
      ]);
    }
    assert.equal(f.writes(), 3); assert.deepEqual(f.providerCalls, []);
    assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []);
    await f.send('readout-volume-unchanged', '把朗读音量设为100%');
    assert.equal(f.writes(), 3); assert.equal(f.views().at(-1)!.receipt!.persistence, 'unchanged');
    await f.manualVolume(60); assert.deepEqual(await f.disk(), before);
  }, { volume: 0.6 });
});

test('actual volume choices retain unrelated settings, reject relevant ABA and consume exactly one opaque choice', async () => {
  await fixture(async f => {
    const before = await f.disk(), originalTop = f.store.current.pet.alwaysOnTop;
    await f.send('volume-choice', '把音量设为40%');
    let view = f.views().at(-1)!; assert.equal(view.choices.length, 2); assert.equal(f.writes(), 0);
    await f.manualTopmost(!originalTop); await f.manualTopmost(originalTop);
    const currentDisk = await f.disk(), writes = f.writes();
    const saved = await f.choose(f.controls, view.requestId, view.choices[0].choiceId);
    assert.equal(saved!.receipt!.status, 'saved'); assert.equal(saved!.receipt!.value, 40);
    assert.equal(f.writes(), writes + 1); assert.equal((await f.disk()).voice.volume, 0.4);
    assert.deepEqual(withoutReadoutVolume(await f.disk()), withoutReadoutVolume(currentDisk));
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId), null);
    assert.equal(f.writes(), writes + 1);
    await f.send('volume-related-aba', '把音量设为40%'); view = f.views().at(-1)!;
    await f.manualVolume(30); await f.manualVolume(40);
    const beforeConflict = await f.disk(), beforeCount = f.writes();
    assert.equal((await f.choose(f.controls, view.requestId, view.choices[0].choiceId))!.receipt!.status, 'conflict');
    assert.deepEqual(await f.disk(), beforeConflict); assert.equal(f.writes(), beforeCount);
    await f.send('volume-cancel', '朗读声音小一点'); view = f.views().at(-1)!;
    assert.equal((await f.choose(f.controls, view.requestId, view.choices.at(-1)!.choiceId))!.receipt!.status, 'cancelled');
    assert.equal(f.writes(), beforeCount);
    await f.manualVolume(60); assert.deepEqual(await f.disk(), before);
    assert.deepEqual(f.providerCalls, []);
  }, { volume: 0.6 });
});

test('actual volume save failure and settings-broadcast failure retain distinct truthful receipts without audio', async () => {
  await fixture(async f => {
    const before = await f.disk(); f.failWrite(true);
    await f.send('volume-save-failure', '把朗读音量设为40%');
    let receipt = f.views().at(-1)!.receipt!;
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.persistence, 'unknown');
    assert.doesNotMatch(f.output('volume-save-failure'), /已设为/); assert.equal(f.writes(), 0);
    assert.deepEqual(await f.disk(), before); assert.equal(f.store.current.voice.volume, 0.6);
    f.failWrite(false); f.controls.failSettingsBroadcast = true;
    await f.send('volume-sync-failure', '把朗读音量设为40%'); receipt = f.views().at(-1)!.receipt!;
    assert.equal(receipt.status, 'saved'); assert.equal(receipt.persistence, 'saved'); assert.equal(receipt.presentation, 'unknown');
    assert.match(f.output('volume-sync-failure'), /已设为 40%.*后续朗读.*界面/u);
    assert.equal((await f.disk()).voice.volume, 0.4); assert.equal(f.store.current.voice.enabled, false);
    assert.deepEqual(withoutReadoutVolume(await f.disk()), withoutReadoutVolume(before));
    f.controls.failSettingsBroadcast = false; await f.manualVolume(60); assert.deepEqual(await f.disk(), before);
    assert.deepEqual(f.providerCalls, []); assert.deepEqual(f.pet.calls, []); assert.deepEqual(f.controls.calls, []);
  }, { volume: 0.6 });
});

test('actual volume choice cannot survive navigation, provider context change or foreign frame', async () => {
  await fixture(async f => {
    const before = await f.disk();
    assert.throws(() => f.invoke('volume-foreign-frame', '把朗读音量设为40%', f.controls.webContents, {}));
    assert.equal(f.writes(), 0);
    await f.send('volume-navigation', '把音量设为40%'); let view = f.views().at(-1)!;
    f.controls.webContents.emit('did-start-navigation');
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId), null);
    await f.send('volume-provider-change', '把音量设为40%'); view = f.views().at(-1)!;
    const provider = structuredClone(f.store.current.provider);
    await f.store.persist({ ...f.store.current, provider: { ...provider, model: 'new-synthetic-context' } });
    const count = f.writes();
    assert.equal((await f.choose(f.controls, view.requestId, view.choices[0].choiceId))!.receipt!.status, 'expired');
    assert.equal(f.writes(), count); assert.equal(f.store.current.voice.volume, 0.6);
    await f.store.persist({ ...f.store.current, provider }); assert.deepEqual(await f.disk(), before);
    assert.deepEqual(f.providerCalls, []);
  }, { volume: 0.6 });
});

test('actual readout-stop chat captures old plan before cleanup, cancels once and never writes or revokes capture', async () => {
  await fixture(async f => {
    await f.send('stop-warmup', '把朗读音量设为0%');
    f.notices.length = 0; const before = await f.disk(), writes = f.writes();
    f.plans.record(99, 'readout-A', f.speechScope(), '第一句。第二句。');
    await f.send('stop-current', '请停止当前朗读');
    const receipt = f.views().at(-1)!.receipt!;
    assert.equal(receipt.actionId, 'voice.stop-readout'); assert.equal(receipt.status, 'stopped');
    assert.equal(receipt.effect, 'stopped'); assert.equal(receipt.persistence, 'not-committed');
    assert.equal(f.plans.busy, false); assert.match(f.output('stop-current'), /已停止本次回复朗读/);
    assert.equal(f.notices.filter(x => x === 'exact-reply-cancel').length, 1);
    for (const forbidden of ['speech-stop', 'reply-clear', 'voice-revoke', 'audio-stop', 'hidden-camera-release'])
      assert.equal(f.notices.includes(forbidden), false, forbidden);
    assert.equal(f.controls.sent.filter(r => r.channel === 'desk:chat-started' && r.value.id === 'stop-current')[0].value.readoutControl, true);
    assert.equal(f.controls.sent.filter(r => r.channel === 'desk:reply-speech-cancelled' && r.value === 'readout-A').length, 1);
    const archive = f.archive('stop-current', { messageLimit: 10, textLimit: 4000 })!;
    assert.ok(archive.messages.some(r => r.role === 'user' && r.content === '请停止当前朗读'));
    assert.ok(archive.messages.some(r => r.role === 'assistant' && r.content.includes('已停止本次回复朗读')));
    await f.send('stop-no-current', '停止朗读');
    assert.equal(f.views().at(-1)!.receipt!.status, 'no-current');
    assert.equal(f.notices.filter(x => x === 'exact-reply-cancel').length, 1);
    assert.equal(f.writes(), writes); assert.deepEqual(await f.disk(), before); assert.deepEqual(f.providerCalls, []);
  });
});

test('actual stop choices cancel harmlessly, reject duplicate and never stop a replacement plan even with the same ID', async () => {
  await fixture(async f => {
    await f.send('stop-choice-warmup', '把朗读音量设为0%'); f.notices.length = 0;
    f.plans.record(99, 'same-reply', f.speechScope(), '旧朗读。');
    const old = f.plans.captureReadout(f.speechScope());
    await f.send('stop-ambiguous', '停一下'); let view = f.views().at(-1)!;
    assert.equal(view.choices.length, 2); assert.equal(f.plans.captureReadout(f.speechScope()), old);
    f.plans.record(99, 'same-reply', f.speechScope(), '较新朗读。');
    const newer = f.plans.captureReadout(f.speechScope());
    assert.notEqual(newer, old);
    const stale = await f.choose(f.controls, view.requestId, view.choices[0].choiceId);
    assert.equal(stale!.receipt!.status, 'conflict'); assert.equal(f.plans.captureReadout(f.speechScope()), newer);
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId), null);
    await f.send('stop-cancel-choice', '停止声音'); view = f.views().at(-1)!;
    assert.equal((await f.choose(f.controls, view.requestId, view.choices[1].choiceId))!.receipt!.status, 'cancelled');
    assert.equal(f.plans.captureReadout(f.speechScope()), newer);
    await f.send('stop-choice-navigation', '停一下'); view = f.views().at(-1)!;
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId, true).catch(() => null), null);
    f.controls.webContents.emit('did-start-navigation');
    assert.equal(await f.choose(f.controls, view.requestId, view.choices[0].choiceId), null);
    assert.equal(f.plans.captureReadout(f.speechScope()), newer);
    assert.equal(f.notices.includes('exact-reply-cancel'), false); assert.equal(f.writes(), 0);
    f.plans.clear();
  });
});
