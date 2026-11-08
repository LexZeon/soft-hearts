import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test from 'node:test';
import {conciseFailure} from '../src/notice-policy';
import { WindowVisibilityTracker } from '../src/ui/window-visibility';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import type { ChatMessage, StreamEvent } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { formatReplySegments } from '../src/ui/reply-segments';
import { appendReplyHistory, trimReplyHistory } from '../src/ui/reply-history';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { validateChatRequest } from '../electron/validation';
import { MoodReplyProtocol } from '../electron/mood-chat';

import { PetUI } from '../src/ui/PetUI';
import { ReplyReader } from '../src/ui/ReplyReader';
import { ReplySpeechState } from '../src/ui/reply-speech';
import { VoiceDraftInput } from '../src/ui/VoiceDraftInput';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { splitReplySegments } from '../shared/reply-segments';
import { draftAfterClear } from '../src/look-send';
import { genericOutageLine, outageDisplayText } from '../shared/chat-availability';
// Execute the actual checked-in handler declarations, not a copied simulation.
// Only their UI/IPC collaborators are replaced; no app or browser is launched.
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const mainSha256 = createHash('sha256').update(mainSource).digest('hex');
const ast = ts.createSourceFile('src/main.ts', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['renderReadout', 'syncBodyInputGate', 'onStream', 'receiveChat', 'stopChat', 'hideWaitingPresentation', 'beginChat', 'clearChat', 'endReplySpeech', 'addMessage',
  'replySpeechContext', 'kickCompletedReply', 'startStreamingReplySpeech', 'reportReplySpeechError', 'prepareReplySpeechPresentation', 'finishReplySpeechPresentation', 'acceptWindowVisibility', 'projectPetVisibility', 'displayFailure', 'clearCommandMessageRows', 'receiveReadoutControl'];
const declarations = names.map(name => {
  const found = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.equal(found.length, 1, `must extract exactly one actual ${name}`);
  return found[0].getText(ast);
}).join('\n');
const commandRowsDeclarations = ast.statements.filter(statement => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'commandMessageRows'));
assert.equal(commandRowsDeclarations.length, 1, 'must extract actual commandMessageRows declaration');
const commandRowsDeclaration = commandRowsDeclarations[0].getText(ast);
const callbackSources = { host: [] as string[], document: [] as string[], segment: [] as string[] };
function findVisibilityCallbacks(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    if (node.expression.getText(ast) === 'window.desktop.onWindowVisibility') callbackSources.host.push(node.arguments[0].getText(ast));
    if (node.expression.getText(ast) === 'window.desktop.onReplySpeechSegment') callbackSources.segment.push(node.arguments[0].getText(ast));
    if (node.expression.getText(ast) === 'document.addEventListener' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'visibilitychange') callbackSources.document.push(node.arguments[1].getText(ast));
  }
  ts.forEachChild(node, findVisibilityCallbacks);
}
findVisibilityCallbacks(ast);
assert.equal(callbackSources.host.length, 1); assert.equal(callbackSources.document.length, 1);assert.equal(callbackSources.segment.length, 1);
const transpiled = transformSync(`function createFlow(deps: any) {
  const {document,window,$,petUI,speech:speechOutput,chatChannel,chatContext,text,notify,setChatBusy,
    renderReplyWaiting,renderAttachments,showCharacterGreeting,replyPresentation,
    formatReplySegments,appendReplyHistory,trimReplyHistory,isPet,windowKind,settings,stage,HTMLElement,VoiceDraftInput,characterName,CompletedReplySpeechQueue,splitReplySegments} = deps;
  let {activeChat,activeUser,reply,history,assistantNode,chatOwner,hostVisible,awaitingChatState} = deps.initial;
  ${commandRowsDeclaration}
  const readoutControlTurns = new Map(); let pendingReadoutControl = null;
  const voiceUiGroups = new Map<string, { epoch: string; seq: number; message: ChatMessage; node: HTMLElement }>();
  const voiceReplyIds = new Set<string>();
  const voiceDraftInput = new VoiceDraftInput();
  const voiceContinuationStatus = null;
  const voiceDraftRecords = new Map<string, { root: HTMLElement; text: HTMLTextAreaElement }>();
  let voiceSpeechReady: { replyId: string; epoch: string } | null = null;
  let releaseReplySpeech = null, initiativeGeneration = 0, chatRefillGeneration = 0, provisionalInitiative = null,
    activeVisionSpeechId = null, petTaskOfferCleanup = null, codexTasks = null,
    captureController = null, attachments = [];
  const moodCompanion = null, ambientAudioController = null, stopMotionPreview = () => {};
  // Profile panel visibility is outside this legacy conversation-flow fixture.
  const userProfilePanel = null;
  const textMemorialOffer = null; let activeMemorialSpeechId = null;
  const windowVisibility = new deps.WindowVisibilityTracker();
  windowVisibility.accept({windowId:1,revision:0,visible:true,petVisible:true});
  let visibilityRevision = 0, pendingPetVisibility = false;
  const characterState = {activeId:'fixture-character'};
  const conciseFailure=deps.conciseFailure,outageDisplayText=deps.outageDisplayText;
  let immersiveDeveloperMode=deps.developerMode === true;
  let ordinaryReplyPresentation = null,ordinaryVoiceConfig = null,speechPlaybackErrorShown = false;
  let queuedText = '',queuedPieces = [],queueEpoch=0;
  // This flow fixture supplies approved-segment IPC; the independent actual
  // host receipt/denial suite owns native authorization. Keep the real queue.
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(id,previous) {
      const epoch=queueEpoch;await Promise.resolve();if(epoch!==queueEpoch)return null;
      const index=previous===undefined?0:previous+1,piece=queuedPieces[index];if(!piece)return null;
      const segment={replyId:id,index,text:piece.text.trim(),visibleText:queuedText.slice(0,piece.end),context:{replyId:id,segmentIndex:index}};
      segmentCallback(segment);return segment;
    },
    async cancelReplySpeech(id) {queueEpoch++;deps.record?.('speech-queue-cancel',id);}
  },piece=>speechOutput.speak(piece.text,{...(ordinaryVoiceConfig??settings.voice)},piece.context),
    ()=>settings.voice.enabled&&(!isPet||(hostVisible&&!document.hidden)));
  const replySpeechQueue = {get replyId(){return queue.replyId;},cancel:()=>queue.cancel(),speak(id){deps.record?.('speech-queue',id);queuedText=reply;queuedPieces=splitReplySegments(reply).filter(p=>p.text.trim());return queue.speak(id);}};
  const speech = {...speechOutput,stop(){replySpeechQueue.cancel();speechOutput.stop();}};
  ${declarations}
  const segmentCallback = ${callbackSources.segment[0]};
  const hostVisibilityCallback = ${callbackSources.host[0]};
  const documentVisibilityCallback = ${callbackSources.document[0]};
  return {onStream,receiveChat,stopChat,hideWaitingPresentation,beginChat,clearChat,seedReadout(id: string) { replyPresentation.startReadout(id, (prefix: string, full: string) => renderReadout(id, prefix, full)); },
    state: () => ({activeChat,activeUser,reply,history:[...history],assistantNode,chatOwner,hostVisible,awaitingChatState}),
    visible(value: boolean) { hostVisible=value; document.hidden=!value; },
    hostVisibility(value: boolean) { hostVisibilityCallback({windowId:1,revision:++visibilityRevision,visible:value,petVisible:true}); },
    documentVisibility(hidden: boolean) { document.hidden=hidden; documentVisibilityCallback(); }
  };
}`, { loader: 'ts', target: 'es2022' }).code;
// clearChat keeps the user's own draft snapshots when sharing is turned off (src/look-send.ts, Codex T-205 round 4).
const createFlow = new Function('uiText','uiHtml','uiMarkup','uiTemplate','draftAfterClear',`${transpiled}\nreturn createFlow;`).bind(null, uiText, uiHtml, uiMarkup, uiTemplate, draftAfterClear)() as (deps: Record<string, unknown>) => {
  seedReadout(id: string): void;
  onStream(event: StreamEvent): void;
  receiveChat(message: Record<string, unknown>): void;
  stopChat(broadcast?: boolean): Promise<void>;
  hideWaitingPresentation(): void;
  beginChat(chat: { id: string; owner: 'pet' | 'controls'; messages: ChatMessage[] }): void;
  clearChat(broadcast?: boolean): void;
  visible(value: boolean): void;
  hostVisibility(value: boolean): void;
  documentVisibility(hidden: boolean): void;
  state(): { activeChat: string | null; activeUser: ChatMessage | null; reply: string; history: ChatMessage[]; assistantNode: StubNode | null; chatOwner: 'pet' | 'controls'; hostVisible: boolean; awaitingChatState: boolean };
};

class StubNode {
  textContent = ''; value = ''; className = ''; scrollTop = 0; scrollHeight = 100;
  children: StubNode[] = []; parentElement: StubNode | null = null; removed = false;
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  readonly classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  append(...nodes: StubNode[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  querySelector() { return null; }
  replaceChildren() { this.children = []; }
  closest() { return this.parentElement ?? this; }
  remove() { this.removed = true; }
}
type Call = { type: string; args: unknown[] };
function fixture(options: { developer?: boolean; isPet?: boolean; accepted?: boolean; active?: boolean; body?: string; voice?: boolean; owner?: 'pet' | 'controls'; history?: ChatMessage[] } = {}) {
  const isPet = options.isPet ?? true, id = 'accepted-chat', user: ChatMessage = { role: 'user', content: '原问题：先解释，不执行。' };
  const body = options.body ?? '第一句。第二句。\n```js\nconst literal = "<b> & raw";\n```';
  const calls: Call[] = [], record = (type: string, ...args: unknown[]) => calls.push({ type, args });
  const nodes = new Map(['messages', 'chat-input', 'send-chat', 'chat-state'].map(key => [key, new StubNode()]));
  const answer = new StubNode(); answer.textContent = body;
  let reader = '', pendingSpeech: (() => void) | undefined;
  const speech = {
    speak(text: string, config: unknown, context: unknown) { record('speech', text, config, context); return options.voice === false ? Promise.resolve() : new Promise<void>(resolve => { pendingSpeech = resolve; }); },
    stop() { record('speech-stop'); pendingSpeech?.(); pendingSpeech = undefined; },
  };
  const petUI = {
    showAnswer(...args: unknown[]) { record('show', ...args); answer.textContent = String(args[0]); reader = answer.textContent; return answer; },
    expectAnswerSpeech(...args: unknown[]) { record('expect-speech', ...args); },
    finishAnswer(...args: unknown[]) { record('finish', ...args); answer.textContent = String(args[0]); reader = answer.textContent; },
    showWaiting(...args: unknown[]) { record('waiting', ...args); answer.textContent = ''; return answer; },
    beginAnswer(...args: unknown[]) { record('begin', ...args); },
    hideAnswer() { record('hide'); reader = ''; },
    setHostVisible(value: boolean) { record('host-visible', value); },
    refreshAnswerReader(text: string, streaming: boolean) { record('reader', text, streaming); reader = text; },
    endAnswerSpeech(...args: unknown[]) { record('speech-ended', ...args); },
    flushReplyPublication() { record('publication-drain');return Promise.resolve(); },
  };
  const time = fakeReadoutClock();
  const state = new ReplyPresentationState(time.clock);
  if ((options.active ?? true) && (options.accepted ?? true)) { state.begin(id, body); }
  const settings = structuredClone(DEFAULT_SETTINGS); settings.voice.enabled = options.voice ?? true;
  const api = createFlow({
    document: { hidden: false, activeElement: null, createElement: () => new StubNode(), getElementById: () => null },
    WindowVisibilityTracker, conciseFailure, outageDisplayText, developerMode: options.developer,
    HTMLElement: StubNode, stage: { setBodyInputBlocked: (blocked: boolean) => record('body-input', blocked), setVisible: (visible: boolean) => record('stage-visible', visible) },
    window: { desktop: { cancel: async (cancelled: string) => { record('cancel', cancelled); },
      acknowledgeReplySpeechReady:async(replyId:string)=>{record('speech-ready',replyId);return true;},cancelReplySpeech:async(replyId:string)=>{record('speech-queue-cancel',replyId);} } },
    $: (key: string) => nodes.get(key), petUI: isPet ? petUI : undefined, speech,
    chatChannel: { postMessage: (message: unknown) => record('broadcast', message) }, chatContext: () => 'same-context',
    text: (key: string, value: string) => { record('text', key, value); const node = nodes.get(key); if (node) node.textContent = value; },
    notify: (...args: unknown[]) => record('toast', ...args), setChatBusy: (...args: unknown[]) => record('busy', ...args),
    renderReplyWaiting: (...args: unknown[]) => record('waiting-state', ...args), renderAttachments() {}, showCharacterGreeting() {},
    replyPresentation: state, formatReplySegments, appendReplyHistory, trimReplyHistory, VoiceDraftInput, CompletedReplySpeechQueue,splitReplySegments,record,characterName: '桌面伙伴', isPet, windowKind: isPet ? 'pet' : 'controls', settings,
    initial: { activeChat: options.active === false ? null : id, activeUser: options.active === false ? null : user, reply: body,
      history: options.history ?? [], assistantNode: options.accepted === false || options.active === false ? null : answer,
      chatOwner: options.owner ?? (isPet ? 'pet' : 'controls'), hostVisible: true, awaitingChatState: options.active === false },
  });
  if ((options.active ?? true) && (options.accepted ?? true)) api.seedReadout(id);
  return { ...api, advance: time.advance, id, user, body, calls, nodes, settings, presentation: state, reader: () => reader,
    async finishSpeech(){for(let i=0;i<128;i++){if(!pendingSpeech){await new Promise(setImmediate);if(!pendingSpeech)return;}pendingSpeech?.();pendingSpeech=undefined;await new Promise(setImmediate);}assert.fail('bounded speech queue failed to finish');},
    of: (type: string) => calls.filter(call => call.type === type), endSpeech: () => { pendingSpeech?.(); pendingSpeech = undefined; }, speechPending: () => !!pendingSpeech };
}
function fakeReadoutClock() {
 let now=0,next=0;const timers=new Map<number,{at:number;callback:()=>void}>();
 const clock={now:()=>now,set:(callback:()=>void,delay:number)=>{const id=++next;timers.set(id,{at:now+delay,callback});return id as unknown as ReturnType<typeof setTimeout>;},clear:(id:ReturnType<typeof setTimeout>)=>{timers.delete(id as unknown as number);}};
 return {clock,advance(ms:number){const target=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].callback();}now=target;}};
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const event = (id: string, type: StreamEvent['type'], text = ''): StreamEvent => ({ id, kind: 'chat', type, text });

test('actual control-to-pet stop finishes the mirrored bubble before closing identity, exactly once', async t => {
  t.diagnostic(`actual src/main.ts sha256 ${mainSha256}`);
  const f = fixture({ owner: 'controls' });
  f.receiveChat({ type: 'stop', id: f.id, context: 'same-context' }); await drain();
  assert.equal(f.of('finish').length, 1); assert.equal(f.of('finish')[0].args[0], f.body + '\n\n[已停止]');
  assert.equal(f.of('finish')[0].args[1], f.id); assert.equal(f.of('finish')[0].args[4], true);
  assert.equal(f.state().activeChat, null); assert.equal(f.presentation.canPresent(f.id), false);
  assert.deepEqual(f.state().history, [f.user, { role: 'assistant', content: f.body }]);
  f.receiveChat({ type: 'stop', id: f.id, context: 'same-context' }); f.onStream(event(f.id, 'error', 'late error')); await drain();
  assert.equal(f.of('finish').length, 1); assert.equal(f.of('cancel').length, 1); assert.equal(f.of('speech').length, 0);
});

test('actual preaccept errors expose their reason and restore the draft without speech or host reply completion', () => {
  for (const reason of ['配置未能保存，请修正设置后重试。', '共享图片暂不可用。', '这条消息超过16000字符，本次没有发送。']) {
    const f = fixture({ accepted: false, body: '' });
    f.onStream(event(f.id, 'error', reason));
    assert.deepEqual(f.of('toast').map(call => call.args), [[reason, true]]);
    assert.equal(f.nodes.get('chat-input')!.value, f.user.content);
    assert.equal(f.of('speech').length, 0); assert.equal(f.of('finish').length, 0);
    assert.equal(f.of('show').filter(call => String(call.args[0]).trim()).length, 0);
    assert.equal(f.state().activeChat, null); assert.deepEqual(f.state().history, []);
  }
  const occupied = fixture({ accepted: false, body: '' }); occupied.nodes.get('chat-input')!.value = '用户新草稿';
  occupied.onStream(event(occupied.id, 'error', '失败')); assert.equal(occupied.nodes.get('chat-input')!.value, '用户新草稿');
});

test('actual length/error and stop retain raw partial text in the next continuation request, without TTS', async () => {
  for (const terminal of ['error', 'stop'] as const) {
    const f = fixture();
    if (terminal === 'error') f.onStream(event(f.id, 'error', '模型达到本次输出上限，已保留收到的正文。'));
    else await f.stopChat();
    const next = validateChatRequest({ id: 'continue', messages: [...f.state().history, { role: 'user', content: '请从末尾继续，仍然只解释。' }], attachments: [] });
    assert.deepEqual(next.messages.slice(0, 2), [f.user, { role: 'assistant', content: f.body }]);
    const prompt = buildCodexChatPrompt('合成人设，无执行工具。', next.messages);
    const input = JSON.parse(prompt.match(/<conversation-data>\n([\s\S]*)\n<\/conversation-data>$/)![1]);
    assert.equal(input.history.at(-1).content, f.body); assert.equal(input.currentUser, next.messages.at(-1)!.content);
    assert.equal(f.of('speech').length, 0); assert.equal(f.of('finish')[0].args[2], false);
  }
});

test('actual pet hide and restore suppress same-ID late bubble, completion and automatic speech, and the cleared reader stays unavailable', async () => {
  const f = fixture({ owner: 'pet' });
  f.visible(false); f.hideWaitingPresentation();
  f.onStream(event(f.id, 'delta', '\n隐藏后产生的正文。'));
  assert.equal(f.reader(), ''); assert.equal(f.of('show').length, 0); assert.equal(f.of('finish').length, 0);
  f.visible(true); f.onStream(event(f.id, 'delta', '\n恢复后到达的末句。')); f.onStream(event(f.id, 'done')); await drain();
  assert.equal(f.of('show').length, 0); assert.equal(f.of('finish').length, 0); assert.equal(f.of('speech').length, 0);
  assert.equal(f.reader(), '');
  assert.equal(f.of('reader').length, 0); assert.equal(f.state().activeChat, null);
  assert.equal(f.state().history.at(-1)!.content, f.body + '\n隐藏后产生的正文。\n恢复后到达的末句。');
});

test('actual pet hide stops already-started local speech and does not replay it', async () => {
  const f = fixture({ owner: 'pet' }); f.onStream(event(f.id, 'done'));await drain();
  assert.equal(f.of('speech').length, 1); assert.equal(f.speechPending(), true);
  f.visible(false); f.hideWaitingPresentation(); await drain();
  assert.equal(f.speechPending(), false); assert.equal(f.of('speech-stop').length, 1);
  f.visible(true); f.onStream(event(f.id, 'done')); await drain(); assert.equal(f.of('speech').length, 1);
});

test('actual controls hide preserves its existing background speech while the pet remains available', async () => {
  const f = fixture({ isPet: false, owner: 'controls' }); f.onStream(event(f.id, 'done'));await drain();
  assert.equal(f.speechPending(), true);
  f.visible(false); f.hideWaitingPresentation();
  assert.equal(f.of('speech-stop').length, 0); assert.equal(f.speechPending(), true);
  await f.finishSpeech();assert.equal(f.of('speech').map(call=>call.args[0]).join(''),splitReplySegments(f.body).filter(p=>p.text.trim()).map(p=>p.text.trim()).join(''));
  assert.equal(f.of('speech-queue').length,1);assert.equal(f.speechPending(),false);
});

test('actual completed-history pet hydration restores only the reader and leaves the original owner speech alone', async () => {
  const owner = fixture({ isPet: false, owner: 'controls' }); owner.onStream(event(owner.id, 'done'));await drain();
  assert.equal(owner.speechPending(), true);
  const pet = fixture({ active: false, body: '' });
  pet.receiveChat({ type: 'state', context: 'same-context', history: owner.state().history, activeChat: null, activeUser: null, reply: owner.body, chatOwner: 'controls' });
  assert.equal(pet.reader(), owner.body);
  for (const type of ['show', 'waiting', 'finish', 'begin', 'speech', 'speech-stop']) assert.equal(pet.of(type).length, 0, type);
  assert.equal(owner.speechPending(), true); assert.equal(owner.of('speech').length, 1);
  await owner.finishSpeech();
  const ended = owner.of('broadcast').map(call => call.args[0] as Record<string, unknown>).find(message => message.type === 'speech-ended');
  assert.ok(ended); pet.receiveChat(ended); assert.equal(pet.of('speech-ended').length, 1); assert.equal(pet.of('show').length, 0);
});

// Claude-only: the voiced case is the early completed-speech path, covered in r27-completed-prefix-renderer.test.ts.
test('actual successful done preserves raw slices and one completed reply identity, never formatted text or nonce', async () => {
  for (const enabled of [false]) {
    const f = fixture({ body: '', voice: enabled });
    const protocol = new MoodReplyProtocol(text => f.onStream(event(f.id, 'delta', text)));
    const raw = '第一句。第二句。\n```js\nconst literal = "<div> & raw";\n```';
    const wire = `${raw}\n${protocol.start}{"context":"neutral","delta":{},"confidence":1}${protocol.end}`;
    for (const chunk of [wire.slice(0, 8), wire.slice(8, -12), wire.slice(-12)]) protocol.push(chunk);
    protocol.finish(); f.onStream(event(f.id, 'done')); f.onStream(event(f.id, 'done')); f.advance(120000); await drain();
    assert.equal(f.of('speech-queue').length,0);assert.equal(f.of('speech').length,1);assert.equal(f.of('speech')[0].args[0],raw);assert.deepEqual(f.of('speech')[0].args[2],{replyId:f.id});
    assert.equal(f.of('finish').length,1);assert.equal(f.of('finish')[0].args[0],raw);assert.equal(f.of('finish')[0].args[2],false);
    assert.equal(f.state().history.at(-1)!.content, raw); assert.equal(f.state().reply.includes('sh-state-'), false);
    f.endSpeech(); await drain();
  }
});

test('actual new accepted ID and card-clear reject old deltas, done, hydration and stop-before-start', async () => {
  const f = fixture();
  f.beginChat({ id: 'new-chat', owner: 'pet', messages: [{ role: 'user', content: '新消息' }] });
  f.onStream(event(f.id, 'delta', '旧迟到')); f.onStream(event(f.id, 'done'));
  assert.equal(f.state().activeChat, 'new-chat'); assert.equal(f.state().reply, ''); assert.equal(f.of('speech').length, 0);
  f.clearChat(false); f.onStream(event('new-chat', 'delta', '切卡后的旧句')); f.onStream(event('new-chat', 'done')); await drain();
  assert.equal(f.state().activeChat, null); assert.deepEqual(f.state().history, []); assert.equal(f.reader(), '');
  const oldHydration = { type: 'state', context: 'same-context', history: [{ role: 'assistant', content: '迟到历史' }], activeChat: null };
  f.receiveChat(oldHydration); assert.deepEqual(f.state().history, []);
  const early = fixture({ active: false, body: '' }); early.receiveChat({ type: 'stop', id: 'stopped-before-start', context: 'same-context' });
  early.beginChat({ id: 'stopped-before-start', owner: 'pet', messages: [{ role: 'user', content: '不会启动' }] });
  assert.equal(early.of('waiting').length, 0); assert.equal(early.state().activeChat, null);
});

// Real caller/PetUI boundary regression: no browser or network.
function actualPetFlow(factory = createFlow) {
  const savedDocument = globalThis.document, savedWindow = globalThis.window;
  const nodes = new Map(['pet-answer-body', 'messages', 'chat-input', 'send-chat', 'chat-state'].map(id => [id, new StubNode()]));
  const body = nodes.get('pet-answer-body')!;
  let rawBody = '', bodyWrites = 0;
  Object.defineProperty(body, 'textContent', { get: () => rawBody, set: (value: string) => { rawBody = value; bodyWrites++; } });
  const doc = { hidden: false, activeElement: null, getElementById: (id: string) => nodes.get(id), createElement: () => new StubNode() };
  const updates: Record<string, unknown>[] = [], spoken: unknown[][] = [];
  const win = { desktop: { updatePetReply: async (patch: Record<string, unknown>) => { updates.push(patch); }, cancel: async () => {} } };
  globalThis.document = doc as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis;
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {}, removeEventListener() {} };
  const readerBody = { textContent: '', scrollTop: 0, focus() {} }, trigger = { disabled: true, onclick: null };
  const reader = new ReplyReader(dialog as unknown as HTMLDialogElement, readerBody as unknown as HTMLElement,
    trigger as unknown as HTMLButtonElement, { onclick: null } as unknown as HTMLButtonElement, { textContent: '' } as HTMLElement);
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { replySpeech: new ReplySpeechState(), replyReader: reader, anchor: { x: 1, y: 1, visible: true },
    interactionProgress: 0, setWindowAdjusting() {}, resetHover() {}, actions: { error(message: string) { assert.fail(message); } } });
  const settings = structuredClone(DEFAULT_SETTINGS); settings.voice.enabled = false;
  const time = fakeReadoutClock(), presentation = new ReplyPresentationState(time.clock);
  const api = factory({ document: doc, window: win, $: (id: string) => nodes.get(id), HTMLElement: StubNode, WindowVisibilityTracker, conciseFailure, outageDisplayText,
    petUI: ui, stage: { setBodyInputBlocked() {}, setVisible() {} }, speech: { stop() {}, speak(...args: unknown[]) { spoken.push(args); return Promise.resolve(); } },
    chatChannel: { postMessage() {} }, chatContext: () => 'same-context', text() {}, notify() {}, setChatBusy() {},
    renderReplyWaiting() {}, renderAttachments() {}, showCharacterGreeting() {}, replyPresentation: presentation,
    formatReplySegments, appendReplyHistory, trimReplyHistory, VoiceDraftInput,CompletedReplySpeechQueue,splitReplySegments, characterName: '桌面伙伴', isPet: true, windowKind: 'pet', settings,
    initial: { activeChat: null, activeUser: null, reply: '', history: [], assistantNode: null, chatOwner: null, hostVisible: true, awaitingChatState: false } });
  api.beginChat({ id: 'actual-pet-flow', owner: 'controls', messages: [{ role: 'user', content: 'CX_LONG' }] });
  bodyWrites = 0;
  return { ...api, advance: time.advance, ui, body, reader, readerBody, dialog, trigger, updates, spoken, writes: () => bodyWrites,
    dispose() { presentation.clear(); reader.dispose(); globalThis.document = savedDocument; globalThis.window = savedWindow; } };
}
const hugeRaw = '完整起点。\n' + '中文段落。日本語の文です。English sentence. Next sentence.\n'.repeat(900)
  + '```ts\nconst literal = "代码 A. B。";\n```\n- 列表项。仍在同一项。\n\nLONG_TAIL_BEFORE。';

test('actual PetUI keeps fast burst paced while the full reader and archive retain raw text', async t => {
  t.diagnostic(`main sha256 ${mainSha256}; real PetUI and ReplyReader, synthetic clock`);
  const f = actualPetFlow();
  try {
    f.onStream(event('actual-pet-flow', 'delta', hugeRaw));
    assert.equal(f.writes(), 1);assert.ok(f.body.textContent.startsWith('完整起点。'));assert.notEqual(f.body.textContent,hugeRaw);
    f.reader.open();assert.equal(f.readerBody.textContent,hugeRaw);f.readerBody.scrollTop=350;
    const added='\nLONG_FINAL_SENTINEL。';f.onStream(event('actual-pet-flow','delta',added));
    assert.equal(f.writes(),1);assert.equal(f.readerBody.textContent,hugeRaw+added);assert.equal(f.readerBody.scrollTop,350);
    f.onStream(event('actual-pet-flow','done'));await drain();assert.notEqual(f.body.textContent,hugeRaw+added);
    assert.deepEqual(f.state().history,[{role:'user',content:'CX_LONG'},{role:'assistant',content:hugeRaw+added}]);
    assert.equal(f.readerBody.textContent,hugeRaw+added);assert.equal(f.spoken.length,0);
  } finally { f.dispose(); }
});

test('controls caller still renders segmented prose from each cumulative delta', () => {
  const f = fixture({ isPet: false, body: '', owner: 'controls', voice: false });
  f.onStream(event(f.id, 'delta', '第一句。'));
  f.onStream(event(f.id, 'delta', '第二句。'));
  assert.equal(f.state().assistantNode!.textContent, '第一句。'); f.advance(650);
  assert.equal(f.state().assistantNode!.textContent, '第一句。\n\n第二句。');
  assert.equal(f.state().reply, '第一句。第二句。');
});

function expectClearedReader(f: ReturnType<typeof actualPetFlow>): void {
  assert.equal(f.dialog.open, false);
  assert.equal(f.trigger.disabled, true);
  assert.equal(f.readerBody.textContent, '');
}

test('actual host/document visibility callbacks keep suppressed ID reader cleared through show, late delta/done and later visibility; next accepted ID works', async () => {
  for (const hostFirst of [true, false]) {
    const f = actualPetFlow();
    try {
      const original = '隐藏前正文。', hidden = '隐藏时追加。', late = '恢复后追加。';
      f.onStream(event('actual-pet-flow', 'delta', original)); f.reader.open();
      assert.equal(f.readerBody.textContent, original); assert.equal(f.dialog.open, true);
      if (hostFirst) { f.hostVisibility(false); f.documentVisibility(true); }
      else { f.documentVisibility(true); f.hostVisibility(false); }
      expectClearedReader(f);
      f.onStream(event('actual-pet-flow', 'delta', hidden)); expectClearedReader(f);
      if (hostFirst) { f.hostVisibility(true); f.documentVisibility(false); }
      else { f.documentVisibility(false); f.hostVisibility(true); }
      expectClearedReader(f);
      f.onStream(event('actual-pet-flow', 'delta', late)); expectClearedReader(f);
      f.onStream(event('actual-pet-flow', 'done')); await drain(); expectClearedReader(f);
      f.hostVisibility(true); f.documentVisibility(false); expectClearedReader(f);
      assert.equal(f.state().history.at(-1)!.content, original + hidden + late, 'suppressed reply still archives raw content once');
      assert.equal(f.state().history.filter(m => m.role === 'assistant').length, 1);
      assert.equal(f.spoken.length, 0);
      f.beginChat({ id: 'next-accepted', owner: 'controls', messages: [{ role: 'user', content: '下一条' }] });
      f.onStream(event('actual-pet-flow', 'delta', '旧ID迟到')); expectClearedReader(f);
      f.onStream(event('next-accepted', 'delta', '新的回复可阅读。'));
      assert.equal(f.trigger.disabled, false); f.reader.open(); assert.equal(f.readerBody.textContent, '新的回复可阅读。');
      f.onStream(event('next-accepted', 'done')); await drain();
      assert.equal(f.readerBody.textContent, '新的回复可阅读。');
    } finally { f.dispose(); }
  }
});

test('normal completion and explicit stop retain full reader on harmless visible callbacks; clearing still requires hide', async () => {
  for (const terminal of ['done', 'stop'] as const) {
    const f = actualPetFlow();
    try {
      f.onStream(event('actual-pet-flow', 'delta', hugeRaw)); f.reader.open(); f.readerBody.scrollTop = 350;
      if (terminal === 'done') f.onStream(event('actual-pet-flow', 'done'));
      else await f.stopChat(false);
      await drain();
      const completed = f.readerBody.textContent;
      assert.ok(completed.startsWith('完整起点。\n') && completed.includes('LONG_TAIL_BEFORE。'));
      if (terminal === 'stop') assert.match(completed, /\[已停止\]$/);
      assert.equal(f.trigger.disabled, false); assert.equal(f.readerBody.scrollTop, 350);
      f.hostVisibility(true); f.documentVisibility(false);
      assert.equal(f.readerBody.textContent, completed); assert.equal(f.readerBody.scrollTop, 350);
      f.hostVisibility(false); expectClearedReader(f);
      f.hostVisibility(true); f.documentVisibility(false); expectClearedReader(f);
    } finally { f.dispose(); }
  }
});

test('R38 actual error presentation keeps body/history and raw diagnostics only in explicit developer output or details',()=>{
  const raw='Error invoking remote method: fetch failed https://example.invalid/private';
  for(const developer of [false,true]){
    const f=fixture({developer,voice:false,body:'已收到的正文。'});f.onStream(event(f.id,'error',raw));
    const shown=f.state().assistantNode!.textContent;assert.ok(shown.includes(f.body));assert.equal(shown.includes(raw),developer);
    assert.equal(f.state().history.at(-1)!.content,f.body);assert.deepEqual(f.of('toast').map(c=>c.args),[[raw,true]]);
    assert.equal(f.of('speech').length,0);assert.equal(f.state().activeChat,null);
  }
});

test('X2 actual chat failure while Claude is unavailable: her own line in ordinary mode, nothing new on a repeat, raw text only in developer mode',()=>{
  const raw='You\'ve hit your session limit · resets 1:20pm (America/Los_Angeles)';
  const outageEvent=(id:string,speak:boolean,line:string|null):StreamEvent=>({...event(id,'error',raw),outage:{kind:'quota',speak,line}});
  // First failure, no body yet: her line in the bubble and the message, no technical text and no toast on this window.
  const first=fixture({voice:false,body:''});first.onStream(outageEvent(first.id,true,'今天说太多话啦，先歇一会儿。'));
  assert.equal(first.state().assistantNode!.textContent,'今天说太多话啦，先歇一会儿。');
  assert.ok(!first.state().assistantNode!.textContent.includes('limit'));
  assert.deepEqual(first.of('toast'),[]);
  assert.equal(first.of('finish').at(-1)!.args[0],'今天说太多话啦，先歇一会儿。');
  assert.equal(first.of('speech').length,0);assert.equal(first.state().activeChat,null);assert.deepEqual(first.state().history,[]);
  // No cached line yet: the generic gentle sentence, still not the raw error.
  const generic=fixture({voice:false,body:''});generic.onStream(outageEvent(generic.id,true,null));
  assert.equal(generic.state().assistantNode!.textContent,genericOutageLine('quota'));
  // A repeat of something she already said: no bubble, no toast, the draft is back in the input, history untouched.
  const repeat=fixture({voice:false,body:''});repeat.onStream(outageEvent(repeat.id,false,null));
  assert.equal(repeat.state().assistantNode,null);
  assert.deepEqual(repeat.of('toast'),[]);
  assert.equal(repeat.nodes.get('chat-input')!.value,repeat.user.content);
  assert.equal(repeat.of('finish').length,0);assert.ok(repeat.of('hide').length>=1);
  assert.deepEqual(repeat.state().history,[]);assert.equal(repeat.state().activeChat,null);
  // Developer mode keeps the raw failure and the toast, exactly as before.
  const developer=fixture({developer:true,voice:false,body:''});developer.onStream(outageEvent(developer.id,true,'今天说太多话啦，先歇一会儿。'));
  assert.ok(developer.state().assistantNode!.textContent.includes(raw));
  assert.deepEqual(developer.of('toast').map(c=>c.args),[[raw,true]]);
  // A failure that is not an outage keeps the ordinary path.
  const ordinary=fixture({voice:false,body:''});ordinary.onStream(event(ordinary.id,'error','配置未能保存'));
  assert.deepEqual(ordinary.of('toast').map(c=>c.args),[['配置未能保存',true]]);
  // Text that had already streamed stays, with her line after it; the line itself never enters the history.
  const partial=fixture({voice:false,body:'说到一半'});partial.onStream(outageEvent(partial.id,true,'网断了，等一下哦。'));
  assert.ok(partial.state().assistantNode!.textContent.startsWith('说到一半'));assert.ok(partial.state().assistantNode!.textContent.endsWith('网断了，等一下哦。'));
  assert.equal(partial.state().history.at(-1)!.content,'说到一半');
});

