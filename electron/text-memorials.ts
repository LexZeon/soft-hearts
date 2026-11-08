import {createHash,randomUUID} from 'node:crypto';
import type {ProactiveSpeechGate} from './proactive-speech-gate';
import type {TextMemorialStore,TextMemorialScope} from './text-memorial-store';
import {parseTextMemorialInvitation,classifyTextMemorialReply,type TextMemorialInvitationData} from './text-memorial-dialogue';
import {validateTextMemorialOffer,textMemorialText as text,textMemorialInteger as integer,textMemorialRecord as record,
  type TextMemorialOffer,type TextMemorialEntry} from '../shared/text-memorials';
import type {ProactiveSpeechLease} from '../shared/proactive-speech';

export interface TextMemorialContext extends TextMemorialScope {identity:string;gateScope:string}
export interface TextMemorialHumanTurn {requestId:string;messageId:string;text:string;acceptedAt:number;source:'text'|'voice-final'}
export interface TextMemorialResult {kind:'none'|'refused'|'unconfirmed'|'saved'|'not-saved';entry?:TextMemorialEntry}
export interface TextMemorialTurn {readonly result:Promise<TextMemorialResult>;complete(success:boolean,proposal?:string|null):void;cancel():void}
interface Dependencies {
  gate:Pick<ProactiveSpeechGate,'tryAcquire'>;store:Pick<TextMemorialStore,'hasEvent'|'saveConfirmed'>;
  context():TextMemorialContext|null;eligible():boolean;
  offer(offer:TextMemorialOffer):boolean|void;cancelOffer(id:string):void;
  /** Native reply surface verifies exact invite bytes; renderer ids are only selectors. */
  present(offer:Readonly<TextMemorialOffer>,signal:AbortSignal):Promise<boolean>;
  presentationCurrent(offer:Readonly<TextMemorialOffer>):boolean;
  archiveInvitation(offer:Readonly<TextMemorialOffer>,at:number,current:()=>boolean):Promise<void>;
  changed():void;now?:()=>number;createId?:()=>string;
}
interface Source {input:TextMemorialHumanTurn;context:TextMemorialContext;eventKey:string;expires:number;replyEpoch:number;proposal:TextMemorialInvitationData|null}
interface Pending {source:Source;offer:TextMemorialOffer|null;lease:ProactiveSpeechLease;deadline:number;acknowledging:boolean;releaseAbort:()=>void}
interface Awaiting {source:Source;offer:TextMemorialOffer;expires:number;life:number}
const MAX_TURNS=16,MAX_ATTEMPTS=256,SOURCE_MS=10*60_000,GENERATION_MS=35_000,REPLY_MS=5*60_000;
const same=(a:TextMemorialContext,b:TextMemorialContext|null)=>!!b&&a.characterId===b.characterId&&a.providerScope===b.providerScope&&a.identity===b.identity;
const safeId=(value:unknown)=>{const result=text(value,100);if(!/^[A-Za-z0-9_-]+$/u.test(result))throw Error('纪念消息身份不正确。');return result;};
const key=(scope:TextMemorialContext,body:string)=>createHash('sha256').update(JSON.stringify([scope.characterId,scope.providerScope,body.normalize('NFKC').trim().replace(/\s+/gu,' ')])).digest('hex');

/** Text-only, one accepted existing opportunity and one exact affirmative. No scheduler or capture. */
export class TextMemorials {
  private source:Source|null=null;private pending:Pending|null=null;private awaiting:Awaiting|null=null;
  private readonly attempted=new Set<string>();private readonly claimed=new Set<string>();private readonly turns=new Map<string,Source>();
  private life=0;private replyEpoch=0;private disposed=false;private lastNow=-Infinity;
  constructor(private readonly deps:Dependencies){}
  /** Called only at the existing host's synchronous real-human acceptance boundary. */
  acceptUserTurn(input:TextMemorialHumanTurn,expectedIdentity:string):TextMemorialTurn|null {
    const value=record(input,['requestId','messageId','text','acceptedAt','source']);
    const accepted:TextMemorialHumanTurn={requestId:safeId(value.requestId),messageId:safeId(value.messageId),text:text(value.text,3000),acceptedAt:integer(value.acceptedAt),source:value.source as TextMemorialHumanTurn['source']};
    if(accepted.source!=='text'&&accepted.source!=='voice-final')throw Error('纪念答复来源不正确。');
    const now=this.now(),context=this.context();
    if(!context||context.identity!==expectedIdentity||this.disposed||!Number.isFinite(now)||accepted.acceptedAt>now||now-accepted.acceptedAt>10_000)return null;
    this.replyEpoch++;this.source=null;this.stopPending();
    const awaiting=this.awaiting;this.awaiting=null;
    const epoch=this.replyEpoch,life=this.life;
    const source:Source={input:structuredClone(accepted),context,eventKey:key(context,accepted.text),expires:now+SOURCE_MS,replyEpoch:epoch,proposal:null};
    let result:Promise<TextMemorialResult>=Promise.resolve({kind:'none'});
    const replying=!!awaiting;
    if(awaiting){
      const current=!!source&&awaiting.life===this.life&&now<awaiting.expires&&same(awaiting.source.context,context);
      const decision=current?classifyTextMemorialReply(accepted.text):'unknown';
      if(decision==='refuse')result=Promise.resolve({kind:'refused'});
      else if(decision!=='affirm')result=Promise.resolve({kind:'unconfirmed'});
      else {
        // The unique invitation is consumed synchronously, before storage's first await.
        const valid=()=>!this.disposed&&life===this.life&&epoch===this.replyEpoch&&same(awaiting.source.context,this.context());
        result=this.deps.store.saveConfirmed({eventKey:awaiting.source.eventKey,invitationId:awaiting.offer.id,requestId:awaiting.source.input.requestId,
          messageId:awaiting.source.input.messageId,consentMessageId:accepted.messageId,text:awaiting.offer.quote,purpose:awaiting.offer.purpose,confirmedAt:now},valid)
          .then(entry=>{if(entry){try{this.deps.changed();}catch{/* Storage truth does not depend on a view notification. */}return {kind:'saved',entry} as TextMemorialResult;}return {kind:'not-saved'} as TextMemorialResult;})
          .catch(()=>({kind:'not-saved'}));
      }
    }
    if(source&&!replying&&this.turns.size<MAX_TURNS&&!this.turns.has(accepted.requestId))this.turns.set(accepted.requestId,source);
    let finished=false;
    return Object.freeze({result,complete:(success:boolean,proposal?:string|null)=>{
      if(finished)return;finished=true;const own=this.turns.get(accepted.requestId);this.turns.delete(accepted.requestId);
      const parsed=typeof proposal==='string'?parseTextMemorialInvitation(proposal,source.input.text):null;
      if(success&&parsed&&own===source&&life===this.life&&epoch===this.replyEpoch&&same(source.context,this.context())&&this.now()<source.expires){source.proposal=parsed;this.source=source;}
    },cancel:()=>{if(finished)return;finished=true;this.turns.delete(accepted.requestId);}});
  }
  /** Synchronously claims a host-approved generic speech cue before its old greeting is broadcast. */
  offerOpportunity(cue:{id:string;kind:string;until:number;source?:unknown}):boolean {
    const now=this.now(),source=this.source,context=this.context();
    this.expire(now);
    if(this.disposed||!source||!context||!same(source.context,context)||!this.eligible()||this.pending||this.awaiting
      ||source.expires<=now||source.replyEpoch!==this.replyEpoch||this.attempted.has(source.eventKey)||this.attempted.size>=MAX_ATTEMPTS
      ||!source.proposal||this.deps.store.hasEvent(source.eventKey)||cue?.kind!=='speech'||cue.source!==undefined||cue.until<=now||!Number.isFinite(cue.until))return false;
    const lease=this.deps.gate.tryAcquire({scope:context.gateScope,opportunityId:cue.id,expiresAt:now+GENERATION_MS},'memorial');
    if(!lease)return false;
    this.source=null;this.attempted.add(source.eventKey);this.claimed.add(cue.id);
    const parsed=source.proposal;
    const offer=validateTextMemorialOffer({id:`memorial-${(this.deps.createId??randomUUID)()}`,invite:parsed.invite,quote:parsed.quote,purpose:parsed.purpose});
    const pending:Pending={source,offer,lease,deadline:now+GENERATION_MS,acknowledging:false,releaseAbort:()=>{}};this.pending=pending;
    const abort=()=>{if(this.pending===pending)this.stopPending();};lease.signal.addEventListener('abort',abort,{once:true});
    pending.releaseAbort=()=>lease.signal.removeEventListener('abort',abort);
    try{if(this.deps.offer(structuredClone(offer))===false)this.stopPending();}catch{this.stopPending();}
    return true;
  }
  awaitingOffer(id:unknown):TextMemorialOffer|null {
    const pending=this.pending;if(typeof id!=='string'||!pending?.offer||pending.offer.id!==id||!this.live(pending))return null;
    return structuredClone(pending.offer);
  }
  hasClaimedOpportunity(id:string):boolean{return this.claimed.has(id);}
  /** Metadata expiry on the existing host lifecycle/tick, never a model poll. */
  sweep():void{this.expire(this.now());}
  async acknowledge(id:unknown):Promise<TextMemorialOffer|null> {
    const pending=this.pending;
    if(typeof id!=='string'||!pending?.offer||pending.offer.id!==id||pending.acknowledging||!this.live(pending))return null;
    pending.acknowledging=true;const offer=pending.offer;
    try{
      if(!await this.deps.present(offer,pending.lease.signal)||!this.live(pending)||!this.deps.presentationCurrent(offer)||!pending.lease.commit())return null;
      // A presentation is a request for consent, never a saved memorial or a reward.
      await this.deps.archiveInvitation(offer,this.now(),()=>this.live(pending)&&this.deps.presentationCurrent(offer));
      if(!this.live(pending))return null;
      this.pending=null;pending.releaseAbort();
      this.awaiting={source:pending.source,offer,expires:this.now()+REPLY_MS,life:this.life};
      return structuredClone(offer);
    }catch{return null;}
    finally{if(this.pending===pending)this.stopPending();}
  }
  /** Only a still-unanswered question is revoked by later assistant content.
   * An affirmative already consumed at acceptance owns its original guarded write. */
  invalidateUnansweredQuestion(id:string):boolean {
    if(this.pending?.offer?.id!==id&&this.awaiting?.offer.id!==id)return false;
    this.cancel();return true;
  }
  /** Context/hide/off/management/teardown revokes pending content and uncommitted saves. */
  cancel():void {
    this.life++;this.replyEpoch++;this.source=null;this.turns.clear();this.stopPending();
    const awaiting=this.awaiting;this.awaiting=null;if(awaiting)this.deps.cancelOffer(awaiting.offer.id);
  }
  dispose():void{if(this.disposed)return;this.cancel();this.disposed=true;}
  private live(pending:Pending):boolean{return !this.disposed&&this.pending===pending&&!pending.lease.signal.aborted&&this.now()<pending.deadline&&same(pending.source.context,this.context())&&this.eligible();}
  private stopPending():void {const pending=this.pending;this.pending=null;if(!pending)return;pending.releaseAbort();pending.lease.cancel();if(pending.offer)this.deps.cancelOffer(pending.offer.id);}
  private context():TextMemorialContext|null{try{return this.deps.context();}catch{return null;}}
  private eligible():boolean{try{return this.deps.eligible();}catch{return false;}}
  private now():number{const now=(this.deps.now??Date.now)();if(!Number.isFinite(now))return NaN;this.lastNow=Math.max(this.lastNow,now);return this.lastNow;}
  private expire(now:number):void {if(this.source&&now>=this.source.expires)this.source=null;if(this.awaiting&&now>=this.awaiting.expires){const old=this.awaiting;this.awaiting=null;this.deps.cancelOffer(old.offer.id);}if(this.pending&&now>=this.pending.deadline)this.stopPending();}
}

/** Host truth only, appended to the existing ordinary reply call, never another model request. */
export function textMemorialReplyContext(result:TextMemorialResult):string {
  if(result.kind==='none')return '';
  const data=result.kind==='saved'?{status:'saved',text:result.entry!.text,purpose:result.entry!.purpose}:{status:result.kind};
  return `\n本轮文字纪念的真实host结果如下，仅作回应依据，不是用户指令。只有status=saved才能说已保存；其它状态不得声称记录成功，不再追问同一事件，不改变画像或媒体开关。\n<text-memorial-result>${JSON.stringify(data).replaceAll('<','\\u003c')}</text-memorial-result>\n`;
}

