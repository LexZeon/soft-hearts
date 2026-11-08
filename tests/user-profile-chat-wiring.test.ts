import { lookOfferAllowed, perceptionTurnLine, perceptionTurnState } from '../shared/perception-rule';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { NO_LISTEN_ASK } from '../electron/listen-together/core';
import { scanBreathRequest } from '../shared/breath-request';
import { ReplyRhythmHost } from '../electron/reply-rhythm-host';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { CompanionCommandHost } from '../electron/companion-command-host';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { CompanionService, memoryProviderScope, type CompanionTurn } from '../electron/companion';
import { UserProfileStore } from '../electron/user-profile';
import { UserProfileManagement } from '../electron/user-profile-management';
import { UserProfileContext } from '../electron/user-profile-context';
import { UserProfileSource } from '../electron/user-profile-source';
import { UserProfileReplyCollector } from '../electron/user-profile-reply';
import { VisualSelfRuntime } from '../electron/visual-self-runtime';
import { validateChatRequest } from '../electron/validation';
import { validateUserProfileExpected } from '../shared/user-profile-ui';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import type { ChatRequest, StreamEvent } from '../shared/contracts';
import { TextMemorialHost } from '../electron/text-memorial-host';
import { MemoryStore } from '../electron/memory';
import { textMemorialReplyContext } from '../electron/text-memorials';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import type { TextMemorialPresented } from '../shared/text-memorials';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { freezeTurnSpeechStyle, ReplySpeechStyles } from '../electron/speech-emotion';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { ChatSettingProposals } from '../electron/chat-settings';
import { scanFramingRequest } from '../shared/framing-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { SingleEmojiCues, type SingleEmojiCue } from '../electron/single-emoji-cues';
import { DEFAULT_EMOJI_SETTINGS, readEmojiSettings } from '../shared/single-emoji';

type Mode = 'complete' | 'partial-error' | 'stop' | 'late-model';
const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const expressions: string[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'scopedHost'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'chat') {
    assert.equal(node.arguments[2]?.getText(ast), 'false');
    expressions.push(node.arguments[1].getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert.equal(expressions.length, 1);
const helpers = ['currentProfileMessage', 'acceptProfileMessage', 'visualSelfData', 'chatContextData',
  'companionCommandContext', 'companionCommandTarget', 'noteCompanionTopmostWrite', 'commitCompanionTopmost', 'cancelProactiveVision', 'noteVisionUserActivity',
  'singleEmojiContext', 'refreshSingleEmojiContext'].map(name => {
  const found = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1); return found[0].getText(ast);
});
// The accepted chat route now uses the real command admission before ordinary chat.
// Extract its actual helpers and retain the real ledger/classifier; ordinary-profile
// cases have no native windows. An unexpected published command fails this fixture.
const commandDependencies = `let userInputUntil=0,visionGeneration=0,lastVisionSpeech=null;
let companionCommandRevision = 0;
let companionCommandObservedTop;
let bodyModelGeneration = 0, observedEmojiContext = '';
const singleEmojiCues = new SingleEmojiCues({
  context: singleEmojiContext, settings: () => emojiSettings,
  available: () => emojiBoundary.available(),
  show: cue => emojiBoundary.show(cue), hide: () => emojiBoundary.hide()
}, () => emojiBoundary.clock);
const companionCommands = new CompanionCommandHost({now: Date.now, id: randomUUID,
  target: companionCommandTarget, classify: classifyCompanionCommand, format: formatCompanionCommandReceipt,
  enqueue: operation => operation(), commit: commitCompanionTopmost,
  publish: () => { throw Error('Command presentation is outside this ordinary-profile target'); }});`;
const compiled = ts.transpileModule(`${helpers.join('\n')}\n${commandDependencies}\nreturn {handler: (${expressions[0]}),cancelProactiveVision,singleEmojiCues,singleEmojiContext,refreshSingleEmojiContext,
setEmojiModelGeneration: value => { bodyModelGeneration=value; refreshSingleEmojiContext(); }};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function fixture(run: (f: {
  service: CompanionService; profiles: UserProfileStore; management: UserProfileManagement;
  send(id: string, text: string, binding?: 'current' | 'missing' | 'stale', mode?: Mode): Promise<void>;
  output: Map<string, string>; turns: Map<string, CompanionTurn>; events: string[];
  providerCalls: string[]; notices: string[]; failProfileWrite(value: boolean): void;
  memorial: TextMemorialHost | null;cancelMemorialContext():void;
  offerMemorial(): {id:string;revision:number} | null;
  presentMemorial(): Promise<TextMemorialPresented | null>;
  speechPlan:CompletedReplySpeech|null;speechStyles:ReplySpeechStyles|null;
  emoji: {
    shown: SingleEmojiCue[]; current(): SingleEmojiCue | null; context(): string;
    cues: SingleEmojiCues; refresh(): void; advance(ms: number): void;
  };
}) => Promise<void>, options: {memorial?:boolean;voice?:boolean;emoji?:boolean} = {}) {
  // The system temp folder: never next to the checkout (in the main folder that was OneDrive, outside the repository).
  const root = path.join(tmpdir(), 'soft-hearts-validation-chat-member');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider = { kind: 'claude', baseUrl: 'https://never-called.invalid/v1', model: 'in-process-synthetic' };
  settings.voice.enabled = options.voice ?? false;
  const speechPlan=options.voice?new CompletedReplySpeech():null,speechStyles=options.voice?new ReplySpeechStyles():null;
  const service = new CompanionService(path.join(directory, 'ordinary'), () => {});
  const invitationMemory=options.memorial?new MemoryStore(path.join(directory,'ordinary'),'text-invitations'):null;
  let context: UserProfileContext | undefined, failWrite = false;
  const profiles = new UserProfileStore(path.join(directory, 'profiles'), {
    onInvalidated: () => { context?.invalidate(); },
    atomic: { rename: async (...args) => {
      if (failWrite) throw Object.assign(Error('synthetic profile persistence failure'), { code: 'EIO' });
      await rename(...args);
    } },
  });
  context = new UserProfileContext(profiles);
  const notices: string[] = [], output = new Map<string, string>(), turns = new Map<string, CompanionTurn>();
  const events: string[] = [], providerCalls: string[] = [];
  const management = new UserProfileManagement(profiles, () => { notices.push('profile-view'); }, () => {
    try { return service.currentScope(); } catch { return null; }
  });
  const pending = new Map<string, { controller: AbortController }>();
  const visualSelfRuntime = new VisualSelfRuntime();
  const operations = new Map<string, Promise<void>>(), modes = new Map<string, Mode>();
  const memorialGate=new ProactiveSpeechGate();let shownMemorial='';let readyMemorial!:()=>void;
  const memorialReady=new Promise<void>(resolve=>{readyMemorial=resolve;});let cueIndex=0;
  const memorialSurface={waitForPresentation:async(body:string)=>shownMemorial===body,isPresentationCurrent:(body:string)=>shownMemorial===body};
  const memorial=options.memorial?new TextMemorialHost({directory:path.join(directory,'text-memorials'),gate:memorialGate,
    scope:()=>{try{return service.currentScope();}catch{return null;}},identity:()=>service.currentSpeechScope(),gateScope:()=>service.currentSpeechScope(),
    owner:()=>99,surface:()=>memorialSurface,
    eligible:()=>pending.size===0,event:()=>{},changed:view=>{if(view)readyMemorial();},
    archive:async(offer,at,current)=>{assert.ok(invitationMemory);await invitationMemory.appendInitiative(service.currentScope(),{id:offer.id,text:offer.invite,at,origin:{kind:'proactive',id:offer.id,at,sources:['text'],labels:['本次文字纪念邀请']}},current);},
    freezeSpeech:()=>{notices.push('memorial-style-frozen');},cancelSpeech:()=>{},
  }):null;
  const originalBegin = service.begin.bind(service);
  service.begin = async (...args) => { const turn = await originalBegin(...args); turns.set(turn.id, turn); return turn; };
  const originalMoodEvent = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { events.push(args[0].type); return originalMoodEvent(...args); };
  const emojiSettings = readEmojiSettings({ ...DEFAULT_EMOJI_SETTINGS, enabled: options.emoji === true });
  const shownEmoji: SingleEmojiCue[] = [];
  let currentEmoji: SingleEmojiCue | null = null;
  // This is an explicit synthetic glyph boundary, not a native-window surrogate.
  // The actual cue class still owns selection, once/expiry/cooldown and cancellation.
  const emojiBoundary = {
    clock: Date.now(),
    available() {
      assert.equal(options.emoji, true, 'no glyph/native surface is allowed in the ordinary-profile-only cases');
      return true;
    },
    show(cue: SingleEmojiCue) {
      assert.equal(options.emoji, true, 'an unrequested glyph surface fails closed');
      currentEmoji = { ...cue }; shownEmoji.push(currentEmoji); return true;
    },
    hide() { currentEmoji = null; },
  };
  let actual!: {
    handler:(sender:number,request:unknown)=>void; cancelProactiveVision():void;
    singleEmojiCues:SingleEmojiCues; singleEmojiContext():string; refreshSingleEmojiContext():void;
    setEmojiModelGeneration(value:number):void;
  };
  const env = {
    createHash, randomUUID, CompanionCommandHost, classifyCompanionCommand, formatCompanionCommandReceipt, scanBreathRequest, scanFramingRequest, scanStopReadoutRequest, pet: null,
    SingleEmojiCues, emojiSettings, emojiBoundary,
    r20ProactiveOffers:null, rps: { host: { chatTurn: () => null, chatDone: () => {} } }, moduleRouter: { userTurn: () => {} }, moodJudge: { host: { userText: () => {} } }, reactions: { userTurn: () => {}, firstChar: () => {}, host: { asking: () => false } }, senseRouter: { userTurn() {}, cancel() {}, firstChar() {}, hint: () => '', replyDone() {} }, pauseTalk: { userTurn: () => null, delta() {}, cancel() {} }, journalCharacterId: () => null, textMemorialHost:memorial,textMemorialReplyContext,
    // 识图第 1 步 (electron/main.ts chat handler): this turn's perception line and her offer to look; sharing off here.
    media: { state: { screenSharing: false, cameraSharing: false }, revision: 0 }, perceptionTurnState, perceptionTurnLine, lookOfferAllowed, lookScope: () => '', lookTurns: new LookTurns(), herState: { chatTurn: () => undefined }, turnAwareness: { line: () => '' },
    roughForTurn: () => undefined, // 屏幕只读大概: sharing off here, so nothing about what the user does
    // 关掉之后的旧帧: the chat handler asks which attachments may still go (none are shared frames here).
    lookAttachments: new LookAttachments(new LookTurns(), { noteActivity() {}, state: () => ({ screen: false, camera: false, scope: '' }), sharesCameraFrames: () => false,
      revision: () => 0, generation: () => 0, opening: () => 0, captureScreen: async () => null, captureCamera: async () => null }),
    listenTogether: null, // I-016 一起听: not started in this fixture (a question about what she heard adds nothing)
    NO_LISTEN_ASK, // I-021: what a turn gets without 一起听 (tests/listen-late-window.test.ts)
    validateChatRequest, UserProfileReplyCollector, userProfiles: profiles, userProfileManagement: management,
    userProfileContext: context, userProfileSource: new UserProfileSource(), companion: service,
    visualSelfRuntime, refreshVisualSelfContext: () => {},
    store: { current: settings, directory }, pending, structuredClone, Date,
    revokeVoice: () => {},
    visionPresentation:{clear:()=>{notices.push('vision-proof-cleared');}},proactiveVision:{cancel:()=>{notices.push('visual-initiative-cancelled');}},
    cameraSamples:{cancel:()=>{notices.push('camera-broker-cancelled');}},cancelAmbientPlayback:()=>{notices.push('ambient-cancelled');},
    syncFatigueActivity:()=>{notices.push('fatigue-observed');},
    launchTask(id: string, _kind: string, _sender: number,
      operation: (signal: AbortSignal, emit: (type: StreamEvent['type'], text: string) => void) => Promise<void>, onStarted: () => void) {
      const controller = new AbortController(); pending.set(id, { controller });
      // Same acceptance ordering as Main: owned controller first, synchronous onStarted, operation later.
      onStarted();
      const result = Promise.resolve().then(() => operation(controller.signal, (type, text) => {
        if (type === 'delta') output.set(id, (output.get(id) ?? '') + text);
      })).finally(() => { if (pending.get(id)?.controller === controller) pending.delete(id); });
      operations.set(id, result);
    },
    ambientComments: undefined, ambientAudio: undefined, proactiveSpeechGate: memorialGate,
    speechScope: () => service.currentSpeechScope(), replySpeechStyles: speechStyles ?? { begin: () => {}, complete: () => false }, replyRhythm: new ReplyRhythmHost(),
    // The ordinary route always uses the persistent Claude session (Claude-only edition); this stands in for it.
    claudeChat: { async stream(task: { replyId: string; session: { persona: string; messages: ChatRequest['messages'] } }, signal: AbortSignal,
      push: (type: StreamEvent['type'], text: string) => void) {
      const request = { id: task.replyId, messages: task.session.messages }, emit = (text: string) => push('delta', text);
      providerCalls.push(request.id); signal.throwIfAborted();
      if (modes.get(request.id) === 'partial-error') { emit('Partial body.'); throw Error('synthetic provider interruption'); }
      if (modes.get(request.id) === 'stop') { emit('Stopped body.'); pending.get(request.id)!.controller.abort(); signal.throwIfAborted(); }
      const open = /<sh-state-[a-f0-9]+>/u.exec(task.session.persona)?.[0]; assert.ok(open);
      const memorialOpen=/<sh-memorial-[a-f0-9]+>/u.exec(task.session.persona)?.[0];
      const quote=request.messages.at(-1)!.content,purpose='留作共同经历的文字纪念';
      assert.equal(turns.get(request.id)?.textMemorialProposal?.(),null,'proposal stays private and unavailable before completion');
      const proposal=options.memorial&&memorialOpen?memorialOpen+JSON.stringify({quote,purpose,invite:'你愿意把“'+quote+'”'+purpose+'吗？'})+memorialOpen.replace('<','</'):'';
      const wire='Received.'+request.id+String.fromCharCode(10)+open+JSON.stringify({context:'neutral',delta:{},reason:'本轮正常回应',confidence:0.9,gesture:'none'})+open.replace('<','</')+proposal;
      for(const unit of wire)emit(unit);
      if(modes.get(request.id)==='late-model')actual.setEmojiModelGeneration(1);
    } },
    freezeTurnSpeechStyle, buildCodexChatPrompt, path, app: { getPath: () => directory }, PROFILE_FOLDER: 'synthetic-profile',
    chatSettings: new ChatSettingProposals({ settings: () => settings, send: () => { throw Error('Settings cards are outside this target'); } }),
    streamCodex: () => { throw Error('Claude execution forbidden in this target'); },
    memoryProviderScope, voiceHost: { history: null, capture: undefined }, cancelReplyStyle: () => {},
    characterCards: { getActive: () => ({ id: 'synthetic-character' }) }, personalizeLanguage: undefined,
    effectiveTtsConfig: () => DEFAULT_TTS_CONFIG, DEFAULT_TTS_CONFIG,
    composeSpeechConfig: () => DEFAULT_TTS_CONFIG, characterSpeechPersona: () => '', completedFatigueFeeling: () => undefined,
    completedReplySpeech: speechPlan ?? { beginCommit: () => ({}), append: () => {}, cancelPending: () => {},
      record: () => { throw Error('Voice is outside this target'); } },
    // R27 developer-mode timing probe (electron/reply-latency.ts) is outside this target.
    replyLatency: { begin() {}, delta() {}, complete() {}, end() {} },
    suspendAmbientSpeech: () => { if(!options.voice)throw Error('Voice is outside this target');notices.push('ordinary-speech-planned'); },
    speechRuntime: { stop: () => {} }, clearReplySpeech: () => {}, windows: () => [], ownerFor: () => 'controls',
    broadcast: (channel: string) => { notices.push(channel); },
  };
  // Use a closed same-realm function so the real store's plain-object validation is exercised unchanged.
  actual = new Function(...Object.keys(env), compiled)(...Object.values(env)) as typeof actual;
  const handler=actual.handler;
  try {
    await service.load(); await service.context('synthetic-character', settings.provider, settings.persona);
    await invitationMemory?.load();
    await management.activate(service.currentScope());
    if(memorial){memorial.sync();await memorialReady;}
    const initial = management.get(); assert.ok(initial);
    management.setEnabled({ scopeId: initial.scopeId, generation: initial.generation, revision: initial.revision, enabled: true });
    await run({ service, profiles, management, output, turns, events, providerCalls, notices,
      failProfileWrite: value => { failWrite = value; },memorial,speechPlan,speechStyles,cancelMemorialContext:()=>actual.cancelProactiveVision(),
      emoji: { shown: shownEmoji, current: () => currentEmoji, context: () => actual.singleEmojiContext(),
        cues: actual.singleEmojiCues, refresh: () => actual.refreshSingleEmojiContext(),
        advance: ms => { emojiBoundary.clock += ms; } },
      offerMemorial(){
        assert.ok(memorial);memorialGate.setScope(service.currentSpeechScope());
        const claimed=memorial.offerOpportunity({id:'synthetic-existing-opportunity-'+(++cueIndex),kind:'speech',until:Date.now()+5000});
        const state=memorial.getOffer();return claimed&&state.offer?{id:state.offer.id,revision:state.revision}:null;
      },
      async presentMemorial(){assert.ok(memorial);const state=memorial.getOffer();assert.ok(state.offer);shownMemorial=state.offer.invite;return memorial.acknowledge(99,{id:state.offer.id,revision:state.revision});},
      async send(id, text, binding = 'current', mode = 'complete') {
        const view = management.get(); assert.ok(view);
        const profile = { scopeId: view.scopeId, generation: view.generation + (binding === 'stale' ? 1 : 0), revision: view.revision };
        modes.set(id, mode);
        handler(42, { id, messages: [{ role: 'user', content: text }], attachments: [], ...(binding === 'missing' ? {} : { profile }) });
        const result = operations.get(id); assert.ok(result); await result;
      },
    });
  } finally {
    actual.singleEmojiCues.dispose();
    speechPlan?.clear();speechStyles?.clear();
    memorial?.dispose();memorialGate.dispose();
    visualSelfRuntime.dispose();
    management.dispose(); await service.flush();await invitationMemory?.flush();
    assert.equal(pending.size, 0);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root));
    assert.ok(path.basename(directory).startsWith('case-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

test('actual chat acceptance and completion collect once while ordinary body, archive and reward remain single', async () => {
  await fixture(async f => {
    await f.send('literal-success', '我喜欢茶。');
    const view = f.profiles.view(); assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].text, '我喜欢茶。'); assert.equal(view.entries[0].source.requestId, 'literal-success');
    assert.equal(f.output.get('literal-success'), 'Received.literal-success');
    assert.deepEqual(f.events, ['chat', 'appraisal']);
    const turn = f.turns.get('literal-success'); assert.ok(turn);
    assert.equal(turn.profileReplyAccepted?.(), true);
    const record = f.service.memory.read(turn.scope, turn.recordId); assert.ok(record);
    assert.deepEqual(record.messages.map(m => [m.role, m.content, m.status]), [
      ['user', '我喜欢茶。', 'complete'], ['assistant', 'Received.literal-success', 'complete'],
    ]);
    await assert.rejects(f.send('literal-success', '我喜欢茶。'), /已经结束|正在进行/);
    assert.equal(f.profiles.view().entries.length, 1); assert.deepEqual(f.providerCalls, ['literal-success']);
    assert.deepEqual(f.events, ['chat', 'appraisal']);
  });
});

test('missing or stale binding and known roleplay refuse profile collection without stopping ordinary replies', async () => {
  await fixture(async f => {
    const currentReplyComplete = (id: string) => {
      const turn = f.turns.get(id); assert.ok(turn);
      assert.equal(turn.profileReplyAccepted?.(), true);
      assert.equal(f.service.memory.read(turn.scope, turn.recordId)?.messages.at(-1)?.status, 'complete');
    };
    await f.send('missing-binding', '我喜欢茶。', 'missing');
    currentReplyComplete('missing-binding');
    await f.send('stale-binding', '我喜欢咖啡。', 'stale');
    currentReplyComplete('stale-binding');
    assert.equal(f.profiles.view().entries.length, 0);
    let view = f.management.get(); assert.ok(view);
    f.management.setEnabled({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, enabled: false });
    await f.send('off-roleplay', 'Pretend that I prefer quiet mornings.', 'missing');
    currentReplyComplete('off-roleplay');
    view = f.management.get(); assert.ok(view);
    f.management.setEnabled({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, enabled: true });
    await f.send('same-session', '我喜欢清晨。');
    currentReplyComplete('same-session');
    assert.equal(f.profiles.view().entries.length, 0);
    await f.service.newConversation();
    await f.send('new-session', '我喜欢清晨。');
    currentReplyComplete('new-session');
    assert.equal(f.profiles.view().entries.length, 1);
    assert.equal(f.profiles.view().entries[0].source.requestId, 'new-session');
    for (const id of ['missing-binding', 'stale-binding', 'off-roleplay', 'same-session', 'new-session']) {
      assert.equal(f.output.get(id), `Received.${id}`);
    }
    assert.equal(f.turns.get('same-session')?.profileReplyAccepted?.(), false, 'old completion authority expires on conversation change');
  });
});

test('provider interruption and stop cancel collection; profile I/O failure leaves a completed ordinary reply retryable', async () => {
  await fixture(async f => {
    for (const [id, status, mode] of [['partial', 'error', 'partial-error'], ['stopped', 'stopped', 'stop']] as const) {
      await assert.rejects(f.send(id, '我喜欢清晨。', 'current', mode));
      assert.equal(f.profiles.view().entries.length, 0);
      const turn = f.turns.get(id); assert.ok(turn);
      assert.equal(turn.profileReplyAccepted?.(), false);
      assert.equal(f.service.memory.read(turn.scope, turn.recordId)?.messages.at(-1)?.status, status);
    }
    f.failProfileWrite(true);
    await f.send('profile-io-failure', '我喜欢清晨。');
    assert.equal(f.output.get('profile-io-failure'), 'Received.profile-io-failure');
    assert.equal(f.turns.get('profile-io-failure')?.profileReplyAccepted?.(), true);
    assert.equal(f.profiles.view().entries.length, 0);
    f.failProfileWrite(false);
    await f.send('new-request-retry', '我喜欢清晨。');
    assert.equal(f.profiles.view().entries.length, 1);
    assert.equal(f.profiles.view().entries[0].source.requestId, 'new-request-retry');
  });
});

test('optional chat profile binding clones exactly three validated fields and never executes descriptor getters', () => {
  const profile = { scopeId: 'a'.repeat(64), generation: 3, revision: 2 };
  const request = { id: 'binding-validation', messages: [{ role: 'user' as const, content: '普通消息' }], attachments: [], profile };
  const cloned = validateChatRequest(request);
  assert.deepEqual(cloned.profile, profile); assert.notEqual(cloned.profile, profile);
  assert.deepEqual(Object.keys(cloned.profile!).sort(), ['generation', 'revision', 'scopeId']);
  assert.equal(validateChatRequest({ ...request, profile: undefined }).profile, undefined);
  assert.equal(validateUserProfileExpected(undefined), null);
  for (const value of [{ ...profile, extra: true }, { ...profile, generation: -1 }, { ...profile, revision: 1.2 }, { ...profile, scopeId: 'bad' }])
    assert.throws(() => validateChatRequest({ ...request, profile: value }));
  let getterCalls = 0;
  const outer = { ...request };
  Object.defineProperty(outer, 'profile', { get() { getterCalls++; return profile; } });
  assert.throws(() => validateChatRequest(outer));
  const nested = { ...profile };
  Object.defineProperty(nested, 'revision', { get() { getterCalls++; return 2; } });
  assert.throws(() => validateUserProfileExpected(nested));
  assert.equal(getterCalls, 0);
});

test('actual ordinary host chat prepares one private proposal on its existing stream then saves only after presented affirmative',async()=>{
 await fixture(async f=>{
  const profile=f.management.get()!;f.management.setEnabled({scopeId:profile.scopeId,generation:profile.generation,revision:profile.revision,enabled:false});
  const quote='今天我终于完成了自己的第一幅画。';
  await f.send('memorial-source',quote);assert.deepEqual(f.providerCalls,['memorial-source']);
  assert.equal(f.output.get('memorial-source'),'Received.memorial-source');
  const turn=f.turns.get('memorial-source')!;assert.ok(turn.textMemorialProposal?.());
  const record=f.service.memory.read(turn.scope,turn.recordId)!;
  assert.equal(record.messages.length,2);assert.equal(record.messages[1].content,'Received.memorial-source');
  assert.ok(!JSON.stringify(record.messages).includes('sh-memorial-'));assert.deepEqual(f.events,['chat','appraisal']);
  assert.ok(f.offerMemorial());assert.deepEqual(f.providerCalls,['memorial-source'],'the existing opportunity makes no second provider request');
  const presented=await f.presentMemorial();assert.ok(presented);assert.deepEqual(presented.origin.sources,['text']);
  assert.equal(f.memorial!.get()!.entries.length,0);assert.deepEqual(f.events,['chat','appraisal'],'invitation archive creates no reward');
  await f.send('memorial-affirm','可以记下来');
  assert.deepEqual(f.providerCalls,['memorial-source','memorial-affirm']);
  assert.deepEqual(f.memorial!.get()!.entries.map(entry=>entry.text),[quote]);
  assert.equal(f.management.get()!.enabled,false,'one consent does not enable automatic profile collection');
  assert.equal(f.profiles.view().entries.length,0);assert.deepEqual(f.events,['chat','appraisal','chat','appraisal']);
 },{memorial:true});
});

test('actual chat refusal and later conversation change cannot persist or repeat a previous invitation',async()=>{
 await fixture(async f=>{
  const quote='今天我做完了一件珍贵的小事。';
  await f.send('decline-source',quote);assert.ok(f.offerMemorial());await f.presentMemorial();
  await f.send('decline-answer','不要记下来');assert.equal(f.memorial!.get()!.entries.length,0);
  await f.send('repeat-source',quote);const before=f.providerCalls.length;assert.equal(f.offerMemorial(),null);assert.equal(f.providerCalls.length,before);
  await f.send('other-source','今天我又学会了一首新曲子。');assert.ok(f.offerMemorial());await f.presentMemorial();
  f.cancelMemorialContext();
  await f.send('cancelled-affirm','好的');assert.equal(f.memorial!.get()!.entries.length,0);
  await f.send('new-context-source','今天我给自己做了一顿特别的晚饭。');assert.ok(f.offerMemorial());await f.presentMemorial();
  await f.service.newConversation();f.memorial!.sync();
  await f.send('late-old-affirm','好的');assert.equal(f.memorial!.get()!.entries.length,0);
 },{memorial:true});
});

test('actual completed ordinary speech plan contains only public deltas while the prepared memorial proposal stays private',async()=>{
 await fixture(async f=>{
  const quote='今天我完成了一件想珍藏的事。';
  await f.send('memorial-voice-source',quote);
  assert.deepEqual(f.providerCalls,['memorial-voice-source']);assert.deepEqual(f.events,['chat','appraisal']);
  const turn=f.turns.get('memorial-voice-source')!;assert.ok(turn.textMemorialProposal?.()?.includes(quote));
  const plans=f.speechPlan!,styles=f.speechStyles!,scope=f.service.currentSpeechScope();
  const lease=plans.next(42,turn.id,scope);assert.ok(lease);
  const body=plans.fullPresentationText(42,turn.id,scope,lease);
  assert.equal(body,'Received.memorial-voice-source');assert.equal(lease.text,body);
  assert.equal(JSON.stringify([lease,body]).includes('sh-memorial-'),false);assert.equal(JSON.stringify([lease,body]).includes(quote),false);
  assert.ok(styles.resolveStyle(42,turn.id,scope));
  assert.equal(plans.approvedSegment(42,turn.id,scope,0),null,'completed text is not actual native disclosure');
  assert.throws(()=>plans.authorizeCloud(42,turn.id,scope,0,lease.text));
  const archived=f.service.memory.read(turn.scope,turn.recordId)!;
  assert.equal(archived.messages[1].content,body);assert.equal(f.memorial!.get()!.entries.length,0);
 },{memorial:true,voice:true});
});

test('actual completed host reply emits at most one synthetic glyph without a second archive or reward; stop and stale context never replay it', async () => {
  await fixture(async f => {
    await f.send('emoji-current-one', '我喜欢茶。');
    assert.equal(f.emoji.shown.length, 1);
    assert.ok(f.emoji.current());
    const first = f.turns.get('emoji-current-one')!;
    const oldContext = f.emoji.context(), mood = first.speechMood()!;
    assert.ok(mood);
    assert.equal(f.emoji.cues.offerReply('reply-emoji-current-one', mood, oldContext), false);
    assert.equal(f.emoji.shown.length, 1, 'the same completed reply is consumed once');
    assert.deepEqual(f.events, ['chat', 'appraisal']);
    const firstRecord = f.service.memory.read(first.scope, first.recordId)!;
    assert.equal(firstRecord.messages.length, 2, 'cosmetic rendering does not archive a second reply');
    assert.equal(firstRecord.messages[1].content, 'Received.emoji-current-one');

    await assert.rejects(f.send('emoji-stop', '我喜欢清晨。', 'current', 'stop'));
    await assert.rejects(f.send('emoji-error', '我喜欢咖啡。', 'current', 'partial-error'));
    assert.equal(f.emoji.current(), null, 'ordinary acceptance cancels the preceding cosmetic cue');
    assert.equal(f.emoji.shown.length, 1, 'neither stopped nor interrupted work creates a cue');

    f.emoji.advance(9_000);
    await f.send('emoji-late-model', '我喜欢音乐。', 'current', 'late-model');
    const late = f.turns.get('emoji-late-model')!;
    // The archive is intentionally paged (default four messages). Inspect this
    // fourth turn's own pair instead of accidentally reading the earlier stop.
    const latePage = f.service.memory.read(late.scope, late.recordId, { messageOffset: 6, messageLimit: 2 })!;
    assert.equal(latePage.messages[0].content, '我喜欢音乐。');
    assert.equal(latePage.messages[1].content, 'Received.emoji-late-model');
    assert.equal(latePage.messages[1].status, 'complete');
    assert.equal(f.emoji.shown.length, 1, 'a successful body after model-generation loss does not regain cosmetic authority');
    await f.send('emoji-current-two', '我喜欢画画。');
    assert.equal(f.emoji.shown.length, 2); assert.ok(f.emoji.current());
    const currentContext = f.emoji.context();
    await f.service.newConversation(); f.emoji.refresh();
    assert.notEqual(f.emoji.context(), currentContext);
    assert.equal(f.emoji.current(), null, 'the actual refresh helper withdraws the old current cue');
    assert.equal(f.emoji.cues.offerReply('late-old-completion', mood, currentContext), false);
    assert.equal(f.emoji.shown.length, 2);
    assert.deepEqual(f.providerCalls, ['emoji-current-one', 'emoji-stop', 'emoji-error', 'emoji-late-model', 'emoji-current-two']);
    assert.equal(f.events.filter(event => event === 'chat').length, 5);
    assert.equal(f.events.filter(event => event === 'appraisal').length, 3);
  }, { emoji: true });
});
