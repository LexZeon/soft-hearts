import {createHash} from 'node:crypto';
import {TextMemorials,type TextMemorialHumanTurn,type TextMemorialTurn} from './text-memorials';
import {TextMemorialStore,type TextMemorialScope} from './text-memorial-store';
import type {ProactiveSpeechGate} from './proactive-speech-gate';
import {textMemorialRecord as record,textMemorialText as text,textMemorialInteger as integer,
  type TextMemorialOffer,type TextMemorialOfferState,type TextMemorialAcknowledgement,type TextMemorialPresented,
  type TextMemorialEvent,type TextMemorialView,type TextMemorialEdit,type TextMemorialDelete} from '../shared/text-memorials';

interface Surface {waitForPresentation(text:string,signal?:AbortSignal):Promise<boolean>;isPresentationCurrent(text:string):boolean}
interface Dependencies {
  directory:string;gate:ProactiveSpeechGate;scope():TextMemorialScope|null;identity():string;gateScope():string;
  owner():number|null;surface():Surface|null;eligible():boolean;
  event(event:TextMemorialEvent):void;changed(view:TextMemorialView|null):void;
  archive(offer:Readonly<TextMemorialOffer>,at:number,current:()=>boolean):Promise<void>;
  freezeSpeech(owner:number,offer:Readonly<TextMemorialOffer>):void;cancelSpeech(id:string):void;
}
const scopeKey=(scope:TextMemorialScope)=>JSON.stringify([scope.characterId,scope.providerScope]);
const scopeId=(scope:TextMemorialScope)=>createHash('sha256').update(scopeKey(scope)).digest('hex');

/** Narrow host adapter; renderer ACK can only select a currently pending display id/revision. */
export class TextMemorialHost {
  private readonly store:TextMemorialStore;private readonly runtime:TextMemorials;
  private identity='';private scope='';private ready=false;private epoch=0;private disposed=false;
  private revision=0;private pending:TextMemorialOffer|null=null;
  private proof:{id:string;text:string;owner:number;surface:Surface;identity:string;archivedAt:number|null}|null=null;
  constructor(private readonly deps:Dependencies){
    this.store=new TextMemorialStore(deps.directory,{invalidated:()=>this.runtime?.cancel()});
    this.runtime=new TextMemorials({gate:deps.gate,store:this.store,
      context:()=>{const scope=this.currentScope();if(!scope||!this.ready)return null;return {...scope,identity:this.deps.identity(),gateScope:this.deps.gateScope()};},
      eligible:()=>this.deps.eligible(),
      offer:offer=>{if(!this.deps.eligible())return false;this.pending=offer;this.deps.event({type:'offer',revision:++this.revision,offer:structuredClone(offer)});},
      cancelOffer:id=>this.withdraw(id),present:async(offer,signal)=>{
        const surface=this.deps.surface(),identity=this.deps.identity(),owner=this.deps.owner();
        if(!surface||owner===null||signal.aborted||!this.deps.eligible())return false;
        const presented=await surface.waitForPresentation(offer.invite,signal);
        if(!presented||signal.aborted||surface!==this.deps.surface()||identity!==this.deps.identity()||owner!==this.deps.owner()||!this.deps.eligible()||!surface.isPresentationCurrent(offer.invite))return false;
        this.proof={id:offer.id,text:offer.invite,owner,surface,identity,archivedAt:null};return true;
      },presentationCurrent:offer=>this.proof?.id===offer.id&&this.canSpeak(this.proof.owner,offer.id),
      archiveInvitation:async(offer,at,current)=>{await deps.archive(offer,at,current);if(current()&&this.proof?.id===offer.id)this.proof.archivedAt=at;},changed:()=>this.publish(),
    });
  }
  /** Actual host context changes invalidate synchronously before optional sidecar loading. */
  sync():void {
    if(this.disposed)return;this.runtime.sweep();let scope:TextMemorialScope|null=null,identity='';
    try{scope=this.deps.scope();identity=this.deps.identity();}catch{/* transition */}
    const key=scope?scopeKey(scope):'';
    if(identity!==this.identity||key!==this.scope){this.runtime.cancel();this.identity=identity;}
    if(key===this.scope)return;
    this.scope=key;this.ready=false;const epoch=++this.epoch;this.store.deactivate();this.publish();
    if(!scope)return;
    void this.store.activate(scope).then(view=>{
      if(!this.disposed&&epoch===this.epoch&&key===this.scope&&view&&scopeId(scope!)===view.scopeId){this.ready=true;this.publish();}
    }).catch(()=>{/* Optional sidecar failure does not reject ordinary chat. */});
  }
  get():TextMemorialView|null {this.sync();return this.currentScope()&&this.ready?this.store.view():null;}
  getOffer():TextMemorialOfferState {
    if(this.pending&&!this.runtime.awaitingOffer(this.pending.id))this.withdraw(this.pending.id);
    return {revision:this.revision,offer:this.pending?structuredClone(this.pending):null};
  }
  async acknowledge(owner:number,input:TextMemorialAcknowledgement|unknown):Promise<TextMemorialPresented|null>{
    const value=record(input,['id','revision']),id=text(value.id,100),revision=integer(value.revision);
    if(!/^[A-Za-z0-9_-]+$/u.test(id))throw Error('纪念邀请身份不正确。');
    if(owner!==this.deps.owner()||!this.pending||this.pending.id!==id||revision!==this.revision)return null;
    const offered=this.pending,offer=await this.runtime.acknowledge(id);
    if(!offer||this.pending!==offered||!this.canSpeak(owner,id)||this.proof?.archivedAt===null||!this.proof)return null;
    this.pending=null;const presentedRevision=++this.revision;
    const origin={kind:'proactive' as const,id,at:this.proof.archivedAt,sources:['text'] as ['text'],labels:['本次文字纪念邀请'] as ['本次文字纪念邀请']};
    try{this.deps.freezeSpeech(owner,offer);this.deps.event({type:'presented',revision:presentedRevision,id,offer:structuredClone(offer),origin});}
    catch{this.runtime.cancel();return null;}
    return {revision:presentedRevision,offer,context:{replyId:id},origin};
  }
  /** A different nonempty assistant body cannot inherit this question's consent.
   * Human-send waiting/metadata and the same invitation text are not another question. */
  displayTextChanged(body:string):void {
    if(!body.trim())return;
    const id=this.pending?.id??this.proof?.id,invite=this.pending?.invite??this.proof?.text;
    if(!id||body===invite)return;
    if(!this.runtime.invalidateUnansweredQuestion(id))this.withdraw(id);
  }
  accept(input:TextMemorialHumanTurn,expectedIdentity:string):TextMemorialTurn|null {this.sync();return this.runtime.acceptUserTurn(input,expectedIdentity);}
  offerOpportunity(cue:{id:string;kind:string;until:number;source?:unknown}):boolean {this.sync();return this.runtime.hasClaimedOpportunity(cue.id)||this.runtime.offerOpportunity(cue);}
  canSpeak(owner:number,id:string):boolean {
    const proof=this.proof;if(!proof||proof.owner!==owner||proof.id!==id||this.disposed)return false;
    try{return this.deps.owner()===owner&&this.deps.surface()===proof.surface&&this.deps.identity()===proof.identity&&this.deps.eligible()&&proof.surface.isPresentationCurrent(proof.text);}catch{return false;}
  }
  ownsSpeech(id:string):boolean{return this.proof?.id===id;}
  authorizeSpeech(owner:number,id:string,body:unknown):boolean{return typeof body==='string'&&this.proof?.text===body&&this.canSpeak(owner,id);}
  async edit(input:TextMemorialEdit|unknown):Promise<TextMemorialView>{if(!this.get())throw Error('当前文字纪念尚未就绪。');await this.store.edit(input);const view=this.get();if(!view)throw Error('纪念范围已改变。');this.publish();return view;}
  async delete(input:TextMemorialDelete|unknown):Promise<TextMemorialView>{if(!this.get())throw Error('当前文字纪念尚未就绪。');await this.store.delete(input);const view=this.get();if(!view)throw Error('纪念范围已改变。');this.publish();return view;}
  cancel():void{this.runtime.cancel();}
  dispose():void{if(this.disposed)return;this.runtime.dispose();this.store.dispose();this.disposed=true;this.ready=false;this.epoch++;}
  private currentScope():TextMemorialScope|null {
    try{const scope=this.deps.scope();if(!scope||scopeKey(scope)!==this.scope||this.deps.identity()!==this.identity)return null;return scope;}catch{return null;}
  }
  private publish():void{try{this.deps.changed(this.get());}catch{/* Optional view delivery never rewrites storage truth. */}}
  private withdraw(id:string):void {
    const pending=this.pending?.id===id,proof=this.proof?.id===id;if(!pending&&!proof)return;
    if(pending)this.pending=null;if(proof){this.proof=null;try{this.deps.cancelSpeech(id);}catch{/* Proof is already revoked. */}}
    const revision=++this.revision;try{this.deps.event({type:'cancel',revision,id});}catch{/* A missing renderer cannot retain host consent. */}
  }
}
