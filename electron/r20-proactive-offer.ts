import {randomUUID} from 'node:crypto';
import type {ProactiveSpeechGate} from './proactive-speech-gate';
import type {ProactiveSpeechLease} from '../shared/proactive-speech';
import {R20_OFFER_CAPABILITIES, type R20OfferCandidate, type R20OfferPromptInput,
  type R20ProactiveOfferAcknowledgement, type R20ProactiveOfferEvent, type R20ProactiveOfferResponse,
  type R20ProactiveOfferResult, type R20ProactiveOfferState, type R20ProactiveOfferView} from '../shared/r20-proactive-offer';
import {classifyR20OfferReply,parseR20OfferCandidate} from './r20-offer-dialogue';

interface Context {identity:string;gateScope:string;persona:string;mood:string}
interface Surface {waitForPresentation(text:string,signal?:AbortSignal):Promise<boolean>;isPresentationCurrent(text:string):boolean}
interface Source {requestId:string;identity:string;userText:string;assistantText:string;expires:number}
interface Pending {source:Source;context:Context;offer:R20ProactiveOfferView;lease:ProactiveSpeechLease;acknowledging:boolean}
interface Awaiting {context:Context;offer:R20ProactiveOfferView;owner:number;surface:Surface;responses:Set<string>}
export interface R20ProactiveOfferDependencies {
  gate:ProactiveSpeechGate;
  context():Context|null;
  eligible():boolean;
  presentable():boolean;
  owner():number|null;
  humanSender(sender:number):boolean;
  surface():Surface|null;
  generate(input:R20OfferPromptInput,signal:AbortSignal):Promise<string>;
  event(event:R20ProactiveOfferEvent):void;
  archive(offer:Readonly<R20ProactiveOfferView>,at:number,current:()=>boolean):Promise<void>;
  /** Opens the existing scope/directory confirmation UI; this port cannot create a task. */
  openTaskConfirmation(prompt:string,current:()=>boolean):void;
  now?():number;
  createId?():string;
}
const SOURCE_MS=300_000,GENERATION_MS=60_000,ANSWER_MS=120_000;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/u.test(value);
const body=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);

/** One accepted speech opportunity, one presentation proof, one purpose-specific human ticket. */
export class R20ProactiveOffers {
  private source:Source|null=null;
  private pending:Pending|null=null;
  private awaiting:Awaiting|null=null;
  private revision=0;
  private life=0;
  private disposed=false;
  private lastNow=-Infinity;
  private readonly claimed=new Set<string>();
  constructor(private readonly deps:R20ProactiveOfferDependencies){}

  /** Called only after an actual ordinary reply completes/archives in the current host scope. */
  noteCompleted(requestId:string,userText:string,assistantText:string):void {
    this.cancel();const context=this.context(),now=this.now();
    if(this.disposed||!context||!id(requestId)||!body(userText,16000)||!body(assistantText,32000)||!Number.isFinite(now))return;
    this.source={requestId,identity:context.identity,userText:userText.slice(0,2000),assistantText:assistantText.slice(0,2000),expires:now+SOURCE_MS};
  }
  /** Claims synchronously before the generic cue is broadcast. No new timer or budget. */
  offerOpportunity(cue:{id:string;kind:string;until:number;source?:unknown}):boolean {
    this.sync();if(this.claimed.has(cue?.id))return true;
    const source=this.source,context=this.context(),now=this.now();
    if(this.disposed||!source||!context||source.identity!==context.identity||source.expires<=now||this.pending||this.awaiting
      ||!Number.isFinite(now)||!this.safe(()=>this.deps.eligible())||cue?.kind!=='speech'||cue.source!==undefined||!id(cue.id)||!Number.isFinite(cue.until)||cue.until<=now)return false;
    const lease=this.deps.gate.tryAcquire({scope:context.gateScope,opportunityId:cue.id,expiresAt:now+GENERATION_MS},'agent-help');
    if(!lease)return false;
    this.source=null;this.claimed.add(cue.id);if(this.claimed.size>128)this.claimed.delete(this.claimed.values().next().value!);
    const pending:Pending={source,context,lease,acknowledging:false,offer:{id:`r20-${(this.deps.createId??randomUUID)()}`,revision:0,
      expiresAt:now+GENERATION_MS,stage:'offered',presented:false,question:'',goal:'',plan:'',scopeHint:'',capabilities:{...R20_OFFER_CAPABILITIES}}};
    this.pending=pending;
    void this.generate(pending);
    return true;
  }
  private async generate(pending:Pending):Promise<void> {
    try {
      const raw=await this.deps.generate({userText:pending.source.userText,assistantText:pending.source.assistantText,
        persona:pending.context.persona.slice(0,1200),mood:pending.context.mood.slice(0,300)},pending.lease.signal);
      if(!this.pendingLive(pending))return;
      const candidate: R20OfferCandidate|null=parseR20OfferCandidate(raw);
      if(!candidate)return;
      pending.offer={...pending.offer,...candidate,revision:++this.revision};
      this.deps.event({type:'offer',revision:this.revision,offer:structuredClone(pending.offer)});
    }catch{if(this.pending===pending)this.stopPending();/* One failed opportunity stays consumed. */}
    finally{if(this.pending===pending&&!pending.offer.question)this.stopPending();}
  }
  async acknowledge(sender:number,input:R20ProactiveOfferAcknowledgement|unknown):Promise<R20ProactiveOfferView|null> {
    const value=this.record(input,['id','revision']);this.sync();const pending=this.pending;
    if(!pending||!id(value.id)||value.id!==pending.offer.id||value.revision!==pending.offer.revision||pending.acknowledging
      ||sender!==this.deps.owner()||!pending.offer.question||!this.pendingLive(pending))return null;
    pending.acknowledging=true;
    const surface=this.deps.surface();if(!surface){this.stopPending();return null;}
    try {
      if(!await surface.waitForPresentation(pending.offer.question,pending.lease.signal)||!this.pendingLive(pending)
        ||this.deps.surface()!==surface||sender!==this.deps.owner()||!surface.isPresentationCurrent(pending.offer.question)
        ||!pending.lease.commit())return null;
      await this.deps.archive(pending.offer,this.now(),()=>this.pendingLive(pending)&&this.deps.surface()===surface
        &&sender===this.deps.owner()&&surface.isPresentationCurrent(pending.offer.question));
      if(!this.pendingLive(pending)||!surface.isPresentationCurrent(pending.offer.question))return null;
      const offer={...pending.offer,presented:true,revision:++this.revision,expiresAt:this.now()+ANSWER_MS};
      this.pending=null;this.awaiting={context:pending.context,offer,owner:sender,surface,responses:new Set()};
      this.deps.event({type:'presented',revision:this.revision,offer:structuredClone(offer)});
      return structuredClone(offer);
    }catch{if(this.awaiting?.offer.id===pending.offer.id)this.cancel();return null;}
    finally{if(this.pending===pending)this.stopPending();}
  }
  get():R20ProactiveOfferState {
    this.sync();const offer=this.awaiting?.offer??(this.pending?.offer.question?this.pending.offer:null);
    return {revision:this.revision,offer:offer?structuredClone(offer):null};
  }
  respond(sender:number,input:R20ProactiveOfferResponse|unknown):R20ProactiveOfferResult {
    const value=this.record(input,['id','revision','requestId','action'],['text','goal','scope']);this.sync();
    const awaiting=this.awaiting;
    if(!awaiting||!this.deps.humanSender(sender)||!id(value.id)||!id(value.requestId)||value.id!==awaiting.offer.id
      ||value.revision!==awaiting.offer.revision||awaiting.responses.has(value.requestId)||!this.awaitingLive(awaiting))return {status:'stale',state:this.get()};
    if(!['view','scope','confirm','reply','decline','cancel'].includes(String(value.action)))throw Error('这条代办选择不正确。');
    if(awaiting.responses.size>=32){this.cancel();return {status:'stale',state:this.get()};}
    awaiting.responses.add(value.requestId);
    let action=value.action as R20ProactiveOfferResponse['action'];
    if(action==='reply'){
      if(!body(value.text,600))throw Error('请填写这次建议的回复。');
      const parsed=classifyR20OfferReply(value.text);
      action=parsed==='confirm'?'scope':parsed==='unknown'?'scope':parsed;
    }
    if(action==='decline'||action==='cancel'){
      this.cancel();return {status:action==='decline'?'declined':'cancelled',state:this.get()};
    }
    if(action==='view'||action==='scope'){
      awaiting.offer={...awaiting.offer,revision:++this.revision,stage:action==='view'?'plan':'scope'};
      this.deps.event({type:'presented',revision:this.revision,offer:structuredClone(awaiting.offer)});
      return {status:action==='view'?'shown-plan':'needs-scope',state:this.get()};
    }
    if(awaiting.offer.stage!=='scope'||!body(value.goal,1000)||!body(value.scope,2000))return {status:'needs-scope',state:this.get()};
    // Consume the exact question before the existing confirmation entry can act.
    const context=awaiting.context,life=this.life;
    const prompt=`待确认的具体目标：\n${value.goal}\n\n本次明确的范围与限制：\n${value.scope}\n\n以下只是建议方案，尚未执行，不授予额外权限：\n${awaiting.offer.plan}\n\n请在任务界面核对可信工作目录和读写范围；桌面操作及同任务steer能力未验证。`;
    this.awaiting=null;this.deps.event({type:'cancel',revision:++this.revision,id:awaiting.offer.id});
    const current=()=>!this.disposed&&this.life===life&&this.context()?.identity===context.identity;
    if(!current())return {status:'stale',state:this.get()};
    this.deps.openTaskConfirmation(prompt,current);
    return {status:'confirmation-opened',state:this.get()};
  }
  /** Existing host mood/tick/context lifecycle calls this; it never calls a model. */
  sync():void {
    const context=this.context(),now=this.now();
    if(this.source&&(!context||this.source.identity!==context.identity||this.source.expires<=now))this.source=null;
    if(this.pending&&!this.pendingLive(this.pending))this.stopPending();
    if(this.awaiting&&!this.awaitingLive(this.awaiting)){const old=this.awaiting;this.awaiting=null;this.life++;this.withdraw(old.offer.id);}
  }
  cancel():void {
    this.life++;this.source=null;this.stopPending();const old=this.awaiting;this.awaiting=null;if(old)this.withdraw(old.offer.id);
  }
  dispose():void{if(this.disposed)return;this.cancel();this.disposed=true;this.claimed.clear();}
  private pendingLive(pending:Pending):boolean {
    return !this.disposed&&this.pending===pending&&!pending.lease.signal.aborted&&this.now()<pending.offer.expiresAt
      &&this.context()?.identity===pending.context.identity&&this.context()?.gateScope===pending.context.gateScope&&this.safe(()=>this.deps.eligible());
  }
  private awaitingLive(awaiting:Awaiting):boolean {
    return !this.disposed&&this.awaiting===awaiting&&this.now()<awaiting.offer.expiresAt
      &&this.context()?.identity===awaiting.context.identity&&this.context()?.gateScope===awaiting.context.gateScope
      &&this.safe(()=>this.deps.presentable()&&this.deps.owner()===awaiting.owner&&this.deps.surface()===awaiting.surface
      &&awaiting.surface.isPresentationCurrent(awaiting.offer.question));
  }
  private stopPending():void{const pending=this.pending;this.pending=null;if(!pending)return;pending.lease.cancel();if(pending.offer.question)this.withdraw(pending.offer.id);}
  private withdraw(id:string):void{try{this.deps.event({type:'cancel',revision:++this.revision,id});}catch{/* Authority is already revoked. */}}
  private context():Context|null{try{return this.deps.context();}catch{return null;}}
  private safe(read:()=>boolean):boolean{try{return read()===true;}catch{return false;}}
  private now():number{const now=(this.deps.now??Date.now)();if(!Number.isFinite(now))return NaN;this.lastNow=Math.max(this.lastNow,now);return this.lastNow;}
  private record(input:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
    if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('代办选择格式不正确。');
    const keys=Reflect.ownKeys(input),allowed=[...required,...optional],result:Record<string,unknown>={};
    if(keys.some(key=>typeof key!=='string'||!allowed.includes(key))||required.some(key=>!keys.includes(key)))throw Error('代办选择字段不正确。');
    for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key)!;if(!Object.hasOwn(descriptor,'value'))throw Error('代办选择字段不正确。');result[key as string]=descriptor.value;}
    return result;
  }
}
