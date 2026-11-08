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
import type { VoiceConversationEvent } from '../shared/voice-conversation';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { ImmersiveNotice } from '../src/ui/ImmersiveNotice';
import { formatReplySegments } from '../src/ui/reply-segments';
import { appendReplyHistory, appendVoiceReply, trimReplyHistory } from '../src/ui/reply-history';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { validateChatRequest } from '../electron/validation';
import { MoodReplyProtocol } from '../electron/mood-chat';

import { PetUI } from '../src/ui/PetUI';
import { ReplyReader } from '../src/ui/ReplyReader';
import { ReplySpeechState } from '../src/ui/reply-speech';
import { VoiceDraftInput } from '../src/ui/VoiceDraftInput';
import { VoiceContinuationStatus } from '../src/ui/VoiceContinuationStatus';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { splitReplySegments } from '../shared/reply-segments';
import { draftAfterClear } from '../src/look-send';
// Execute the actual checked-in handler declarations, not a copied simulation.
// Only their UI/IPC collaborators are replaced; no app or browser is launched.
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const mainSha256 = createHash('sha256').update(mainSource).digest('hex');
const ast = ts.createSourceFile('src/main.ts', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['renderReadout', 'syncBodyInputGate', 'onStream', 'receiveChat', 'receiveVoiceConversation', 'stopChat', 'hideWaitingPresentation', 'beginChat', 'clearChat', 'endReplySpeech', 'addMessage',
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
const voiceReadyDeclarations = ast.statements.filter(statement => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'voiceSpeechReady'));
assert.equal(voiceReadyDeclarations.length, 1, 'must extract actual voiceSpeechReady declaration');
const voiceReadyDeclaration = voiceReadyDeclarations[0].getText(ast);
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
    formatReplySegments,appendReplyHistory,appendVoiceReply,trimReplyHistory,isPet,windowKind,settings,stage,HTMLElement,VoiceDraftInput,characterName,CompletedReplySpeechQueue,splitReplySegments} = deps;
  let {activeChat,activeUser,reply,history,assistantNode,chatOwner,hostVisible,awaitingChatState} = deps.initial;
  ${commandRowsDeclaration}
  const readoutControlTurns = new Map(); let pendingReadoutControl = null;
  const voiceUiGroups = new Map<string, { epoch: string; seq: number; message: ChatMessage; node: HTMLElement }>();
  const voiceReplyIds = new Set<string>();
  const voiceDraftInput = new VoiceDraftInput();
  const voiceContinuationStatus = deps.voiceContinuationStatus;
  const voiceDraftRecords = new Map<string, { root: HTMLElement; text: HTMLTextAreaElement }>();
  ${voiceReadyDeclaration}
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
  const conciseFailure=deps.conciseFailure;
  let immersiveDeveloperMode=deps.developerMode === true;
  const immersiveNotice=deps.immersiveNotice ?? null;
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
  return {onStream,receiveChat,receiveVoiceConversation,stopChat,hideWaitingPresentation,beginChat,clearChat,
    state: () => ({activeChat,activeUser,reply,history:[...history],assistantNode,chatOwner,hostVisible,awaitingChatState}),
    visible(value: boolean) { hostVisible=value; document.hidden=!value; },
    hostVisibility(value: boolean) { hostVisibilityCallback({windowId:1,revision:++visibilityRevision,visible:value,petVisible:true}); },
    documentVisibility(hidden: boolean) { document.hidden=hidden; documentVisibilityCallback(); }
  };
}`, { loader: 'ts', target: 'es2022' }).code;
// clearChat keeps the user's own draft snapshots when sharing is turned off (src/look-send.ts, Codex T-205 round 4).
const createFlow = new Function('uiText','uiHtml','uiMarkup','uiTemplate','draftAfterClear',`${transpiled}\nreturn createFlow;`).bind(null, uiText, uiHtml, uiMarkup, uiTemplate, draftAfterClear)() as (deps: Record<string, unknown>) => {
  onStream(event: StreamEvent): void;
  receiveChat(message: Record<string, unknown>): void;
  receiveVoiceConversation(event: VoiceConversationEvent): void;
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
function fixture(options: { developer?: boolean; isPet?: boolean; accepted?: boolean; active?: boolean; body?: string; voice?: boolean; owner?: 'pet' | 'controls'; history?: ChatMessage[]; notice?: ImmersiveNotice; backend?: 'claude' } = {}) {
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
  let clockNow=0, nextTimer=0; const timers=new Map<number,{at:number;callback:()=>void}>();
  const clock={now:()=>clockNow,set:(callback:()=>void,delay:number)=>{const id=++nextTimer;timers.set(id,{at:clockNow+delay,callback});return id as unknown as ReturnType<typeof setTimeout>;},clear:(id:ReturnType<typeof setTimeout>)=>{timers.delete(id as unknown as number);}};
  const advance=(ms:number)=>{const target=clockNow+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);clockNow=due[1].at;due[1].callback();}clockNow=target;};
  const state = new ReplyPresentationState(clock);
  if ((options.active ?? true) && (options.accepted ?? true)) { state.begin(id, body); }
  const settings = structuredClone(DEFAULT_SETTINGS); settings.provider.kind=options.backend??'claude'; settings.voice.enabled = options.voice ?? true;
  const voiceStatus = {textContent:'',hidden:false,setAttribute(){}};
  const api = createFlow({
    voiceContinuationStatus:new VoiceContinuationStatus(voiceStatus as unknown as HTMLElement),
    document: { hidden: false, activeElement: null, createElement: () => new StubNode(), getElementById: () => null },
    WindowVisibilityTracker, conciseFailure, developerMode: options.developer, immersiveNotice: options.notice,
    HTMLElement: StubNode, stage: { setBodyInputBlocked: (blocked: boolean) => record('body-input', blocked), setVisible: (visible: boolean) => record('stage-visible', visible) },
    window: { desktop: { cancel: async (cancelled: string) => { record('cancel', cancelled); },
      acknowledgeReplySpeechReady:async(replyId:string)=>{record('speech-ready',replyId);return true;},cancelReplySpeech:async(replyId:string)=>{record('speech-queue-cancel',replyId);} } },
    $: (key: string) => nodes.get(key), petUI: isPet ? petUI : undefined, speech,
    chatChannel: { postMessage: (message: unknown) => record('broadcast', message) }, chatContext: () => 'same-context',
    text: (key: string, value: string) => { record('text', key, value); const node = nodes.get(key); if (node) node.textContent = value; },
    notify: (...args: unknown[]) => record('toast', ...args), setChatBusy: (...args: unknown[]) => record('busy', ...args),
    renderReplyWaiting: (...args: unknown[]) => record('waiting-state', ...args), renderAttachments() {}, showCharacterGreeting() {},
    replyPresentation: state, formatReplySegments, appendReplyHistory, appendVoiceReply, trimReplyHistory, VoiceDraftInput, CompletedReplySpeechQueue,splitReplySegments,record,characterName: '桌面伙伴', isPet, windowKind: isPet ? 'pet' : 'controls', settings,
    initial: { activeChat: options.active === false ? null : id, activeUser: options.active === false ? null : user, reply: body,
      history: options.history ?? [], assistantNode: options.accepted === false || options.active === false ? null : answer,
      chatOwner: options.owner ?? (isPet ? 'pet' : 'controls'), hostVisible: true, awaitingChatState: options.active === false },
  });
  return { ...api, advance, id, user, body, calls, nodes, settings, voiceStatus, presentation: state, reader: () => reader,
    async finishSpeech(){for(let i=0;i<128;i++){if(!pendingSpeech){await new Promise(setImmediate);if(!pendingSpeech)return;}pendingSpeech?.();pendingSpeech=undefined;await new Promise(setImmediate);}assert.fail('bounded speech queue failed to finish');},
    of: (type: string) => calls.filter(call => call.type === type), endSpeech: () => { pendingSpeech?.(); pendingSpeech = undefined; }, speechPending: () => !!pendingSpeech };
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const event = (id: string, type: StreamEvent['type'], text = ''): StreamEvent => ({ id, kind: 'chat', type, text });


test('cancel and new turn invalidate pending readout without replay or lost draft',async()=>{
 const f=fixture({active:false,body:'',voice:false});f.beginChat({id:f.id,owner:'pet',messages:[f.user]});
 f.onStream(event(f.id,'delta','旧第一句。旧第二句。'));f.nodes.get('chat-input')!.value='新草稿';await f.stopChat();
 const before=f.of('show').length;f.advance(5000);f.onStream(event(f.id,'delta','迟到。'));assert.equal(f.of('show').length,before);
 assert.equal(f.nodes.get('chat-input')!.value,'新草稿');f.beginChat({id:'new-turn',owner:'pet',messages:[{role:'user',content:'新的'}]});
 f.onStream(event('new-turn','delta','新回复。'));assert.equal(f.of('show').at(-1)!.args[0],'新回复。');
});

test('one completed provider chunk stays honest and preserves long text',async()=>{
 const f=fixture({active:false,body:'',voice:false});f.beginChat({id:f.id,owner:'pet',messages:[f.user]});
 const raw=Array.from({length:145},(_,i)=>`第${i}句${'字'.repeat(45)}。`).join('');assert.ok(raw.length>6000);
 f.onStream(event(f.id,'delta',raw));assert.notEqual(f.of('show')[0].args[0],raw);assert.equal(f.reader(),raw);
 f.onStream(event(f.id,'done'));assert.equal(f.state().history.at(-1)!.content,raw);f.advance(145*2*4000);await drain();
 assert.equal(f.of('show').at(-1)!.args[0],raw);assert.equal(f.reader(),raw);assert.equal(f.of('speech-queue').length,0);
});
test('active cross-window hydration starts at a paced prefix and keeps its full reader',()=>{
 const f=fixture({active:false,body:'',voice:false}),raw='第一句。第二句。第三句。';
 f.receiveChat({type:'state',context:'same-context',history:[],activeChat:'peer-reply',activeUser:{role:'user',content:'你好'},reply:raw,chatOwner:'controls'});
 assert.deepEqual(f.of('show').map(c=>c.args[0]),['第一句。']);assert.equal(f.reader(),raw);
 f.advance(650);assert.equal(f.of('show').at(-1)!.args[0],'第一句。第二句。');
 f.onStream(event('peer-reply','delta','第四句。'));assert.equal(f.reader(),raw+'第四句。');
 f.advance(1300);assert.equal(f.of('show').at(-1)!.args[0],raw+'第四句。');
});

// Real handler and real fixed-action presenter; UI and timers are synthetic.
test('fixed whole-response status stays visible across delta and done while unknown status stays quiet',async()=>{
 class NoticeNode {textContent='';className='';hidden=false;classList={contains:(v:string)=>this.className.split(' ').includes(v),remove:(v:string)=>{this.className=this.className.split(' ').filter(x=>x!==v).join(' ');}};addEventListener(){}removeEventListener(){}}
 const nodes=new Map(['toast','notice-details','notice-detail-panel','notice-detail-text','notice-detail-close'].map(id=>[id,new NoticeNode()]));
 const notice=new ImmersiveNotice({getElementById:(id:string)=>nodes.get(id)??null} as unknown as Document);
 try {
  const f=fixture({active:false,body:'',voice:false,notice});f.beginChat({id:f.id,owner:'pet',messages:[f.user]});
  f.onStream(event(f.id,'status','未知内部诊断'));assert.equal(nodes.get('toast')!.classList.contains('show'),false);
  f.onStream(event(f.id,'status','本次回复整段到达，将逐句展示。'));assert.equal(nodes.get('toast')!.textContent,'本次回复整段到达，将逐句展示。');assert.equal(nodes.get('toast')!.classList.contains('show'),true);
  f.onStream(event(f.id,'delta','第一句。第二句。'));f.onStream(event(f.id,'status','另一个未知状态'));f.onStream(event(f.id,'done'));await drain();
  assert.equal(nodes.get('toast')!.textContent,'本次回复整段到达，将逐句展示。');assert.equal(nodes.get('toast')!.classList.contains('show'),true);
  f.onStream(event('old','status','本次回复整段到达，将逐句展示。'));assert.equal(nodes.get('toast')!.textContent,'本次回复整段到达，将逐句展示。');f.advance(5000);
 } finally {notice.dispose();}
});

function voiceReply(f: ReturnType<typeof fixture>, raw: string): VoiceConversationEvent {
 const identity = {epoch:'voice-epoch',owner:'pet' as const,groupId:'voice-group'};
 f.receiveVoiceConversation({...identity,type:'row',seq:1,text:'原语音问题'});
 f.receiveVoiceConversation({...identity,type:'start',replyId:f.id});
 f.receiveVoiceConversation({...identity,type:'delta',replyId:f.id,text:raw});
 f.receiveVoiceConversation({...identity,type:'terminal',replyId:f.id,complete:true});
 return {...identity,type:'speech',replyId:f.id,text:raw};
}

test('actual voice receiver shows queued versus a new continuation and clears status with chat reset', () => {
 const f=fixture({active:false,body:'',voice:false}),base={epoch:'voice-epoch',owner:'pet' as const,groupId:'voice-group'};
 f.receiveVoiceConversation({...base,type:'row',seq:1,text:'A'});
 f.receiveVoiceConversation({...base,type:'start',replyId:'first'});
 f.receiveVoiceConversation({...base,type:'row',seq:2,text:'A\nB'});
 f.receiveVoiceConversation({...base,type:'continuation',replyId:'first',state:'queued'});
 assert.match(f.voiceStatus.textContent,/排队/);
 f.receiveVoiceConversation({...base,type:'terminal',replyId:'first',complete:true});
 f.receiveVoiceConversation({...base,type:'start',replyId:'second'});
 f.receiveVoiceConversation({...base,type:'continuation',replyId:'second',state:'continuation'});
 assert.match(f.voiceStatus.textContent,/另发续接请求/);
 f.receiveVoiceConversation({...base,type:'continuation',replyId:'first',state:'settled'});
 assert.match(f.voiceStatus.textContent,/另发续接请求/);
 f.clearChat(false);assert.equal(f.voiceStatus.hidden,true);assert.equal(f.voiceStatus.textContent,'');
});

test('voice readout terminal and speech preserve paced monotonic text before completed playback',async()=>{
 const f=fixture({active:false,body:'',voice:true}),raw='第一句。第二句。第三句。';
 const speechEvent=voiceReply(f,raw);
 assert.deepEqual(f.of('show').map(c=>c.args[0]),['第一句。']);assert.equal(f.reader(),raw);
 f.receiveVoiceConversation(speechEvent);
 assert.equal(f.of('speech').length,0,'completed speech event must wait for the existing text clock');
 assert.equal(f.of('finish').length,0,'speech must not publish the full body before paced readout drains');
 f.advance(650);assert.equal(f.of('show').at(-1)!.args[0],'第一句。第二句。');assert.equal(f.of('speech').length,0);
 f.advance(650);await drain();assert.equal(f.of('speech').length,1);assert.equal(f.of('speech')[0].args[0],raw);
 const bodies=f.calls.filter(c=>c.type==='show'||c.type==='finish').map(c=>String(c.args[0]));
 assert.ok(bodies.every((body,index)=>!index||body.startsWith(bodies[index-1])),JSON.stringify(bodies));
 assert.equal(bodies.at(-1),raw);assert.equal(f.reader(),raw);
 assert.equal(f.state().history.filter(m=>m.role==='assistant').length,1);
 f.receiveVoiceConversation(speechEvent);assert.equal(f.of('speech').length,1,'same speech identity consumes once');
 await f.finishSpeech();f.advance(5000);assert.equal(f.of('speech').length,1);
});

test('voice readout pending speech is revoked on hide cancel new turn or disabled voice',async()=>{
 for(const mode of ['hide','cancel','new-turn','voice-off'] as const){
  const f=fixture({active:false,body:'',voice:true}),speechEvent=voiceReply(f,'第一句。第二句。');
  f.receiveVoiceConversation(speechEvent);assert.equal(f.of('speech').length,0,mode);
  if(mode==='hide'){f.visible(false);f.hideWaitingPresentation();}
  if(mode==='cancel')f.receiveVoiceConversation({epoch:'voice-epoch',owner:'pet',groupId:'voice-group',replyId:f.id,type:'cancelled'});
  if(mode==='new-turn')f.beginChat({id:'new-turn',owner:'pet',messages:[f.user]});
  if(mode==='voice-off')f.settings.voice.enabled=false;
  f.advance(5000);await drain();assert.equal(f.of('speech').length,0,mode);
  f.settings.voice.enabled=true;f.receiveVoiceConversation(speechEvent);f.advance(5000);
  assert.equal(f.of('speech').length,0,`${mode}: late old event must not replay`);
 }
});

test('voice readout already drained needs no extra delay and foreign speech cannot consume it',async()=>{
 const f=fixture({active:false,body:'',voice:true}),raw='单句。',speechEvent=voiceReply(f,raw);
 assert.equal(f.of('finish').at(-1)!.args[0],raw);assert.equal(f.of('speech').length,0);
 f.receiveVoiceConversation({epoch:'foreign-epoch',owner:'pet',groupId:'voice-group',replyId:f.id,type:'speech',text:raw});
 f.receiveVoiceConversation({epoch:'voice-epoch',owner:'controls',groupId:'voice-group',replyId:f.id,type:'speech',text:raw});
 f.receiveVoiceConversation({epoch:'voice-epoch',owner:'pet',groupId:'voice-group',replyId:'foreign-reply',type:'speech',text:raw});
 assert.equal(f.of('speech').length,0);
 f.receiveVoiceConversation(speechEvent);assert.equal(f.of('speech').length,1);
 assert.equal(f.of('speech')[0].args[0],raw);await f.finishSpeech();
});

test('R27 wiring: the actual renderReadout hands stable sentence ends to the pet bubble with the raw prefix', () => {
 const f=fixture({active:false,body:'',voice:false,backend:'claude'});f.beginChat({id:f.id,owner:'pet',messages:[f.user]});
 f.onStream(event(f.id,'delta','第一句。'));f.onStream(event(f.id,'delta','第二句。'));
 assert.deepEqual(f.of('show').map(c=>[c.args[0],c.args[2],c.args[3],c.args[4]]),[['第一句。',f.id,false,[4]]]);
 f.advance(650);assert.deepEqual(f.of('show').at(-1)!.args.slice(0,5),['第一句。第二句。',true,f.id,false,[4,8]]);
});
