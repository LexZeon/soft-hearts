import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,stat,rename} from 'node:fs/promises';
import path from 'node:path';
import {createAtomicFileWriter,type AtomicFileDependencies} from './atomic-file';
import {textMemorialRecord as record,textMemorialText as text,textMemorialInteger as integer,
  type TextMemorialView,type TextMemorialEntry,type TextMemorialExpected,type TextMemorialEdit,type TextMemorialDelete} from '../shared/text-memorials';

export interface TextMemorialScope {characterId:string;providerScope:string}
export interface ConfirmedTextMemorial {
  eventKey:string;invitationId:string;requestId:string;messageId:string;consentMessageId:string;
  text:string;purpose:string;confirmedAt:number;
}
interface StoredEntry extends TextMemorialEntry {eventKey:string;invitationId:string;requestId:string;messageId:string;consentMessageId:string}
interface Stored {version:1;scopeId:string;revision:number;entries:StoredEntry[];blocked:string[]}
interface Options {now?:()=>number;atomic?:AtomicFileDependencies;invalidated?:()=>void}
const MAX_BYTES=500_000,MAX_ENTRIES=128,MAX_BLOCKED=4096;
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const id=(value:unknown)=>text(value,100);
const initial=(scopeId:string):Stored=>({version:1,scopeId,revision:0,entries:[],blocked:[]});
function scopeKey(scope:TextMemorialScope):string {
  const value=record(scope,['characterId','providerScope']);return sha(JSON.stringify([text(value.characterId,100),text(value.providerScope,4096)]));
}
function validate(input:unknown,scopeId:string):Stored {
  const value=record(input,['version','scopeId','revision','entries','blocked']);
  if(value.version!==1||value.scopeId!==scopeId||!hex(scopeId)||!Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES
    ||!Array.isArray(value.blocked)||value.blocked.length>MAX_BLOCKED||value.blocked.some(key=>!hex(key))||new Set(value.blocked).size!==value.blocked.length)throw Error('文字纪念存档不正确。');
  const entries:StoredEntry[]=value.entries.map(input=>{
    const item=record(input,['id','text','purpose','createdAt','updatedAt','eventKey','invitationId','requestId','messageId','consentMessageId']);
    if(!hex(item.eventKey))throw Error('文字纪念来源不正确。');
    return {id:id(item.id),text:text(item.text,240),purpose:text(item.purpose,80),createdAt:integer(item.createdAt),updatedAt:integer(item.updatedAt),eventKey:item.eventKey,
      invitationId:id(item.invitationId),requestId:id(item.requestId),messageId:id(item.messageId),consentMessageId:id(item.consentMessageId)};
  });
  if(new Set(entries.map(entry=>entry.id)).size!==entries.length||new Set(entries.map(entry=>entry.eventKey)).size!==entries.length)throw Error('文字纪念重复。');
  return {version:1,scopeId,revision:integer(value.revision),entries,blocked:[...value.blocked] as string[]};
}
class StaleMemorial extends Error {}

/** Only host-selected scopes and explicit one-shot confirmations reach this private sidecar. */
export class TextMemorialStore {
  private active:Stored|null=null;private epoch=0;private writeEpoch=0;private queue:Promise<unknown>=Promise.resolve();private disposed=false;
  constructor(private readonly directory:string,private readonly options:Options={}){}
  async activate(scope:TextMemorialScope):Promise<TextMemorialView|null>{
    const key=scopeKey(scope);if(this.disposed)return null;if(this.active?.scopeId===key)return this.view();
    const epoch=++this.epoch;this.active=null;this.changed();let state=initial(key);
    try{const file=this.file(key);if((await stat(file)).size>MAX_BYTES)throw Error('文字纪念存档过大。');const bytes=await readFile(file,'utf8');if(Buffer.byteLength(bytes)>MAX_BYTES)throw Error('文字纪念存档过大。');state=validate(JSON.parse(bytes),key);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(this.disposed||epoch!==this.epoch)return null;this.active=state;return this.view();
  }
  view():TextMemorialView|null {
    const state=this.active;if(this.disposed||!state)return null;
    return {scopeId:state.scopeId,generation:this.epoch,revision:state.revision,entries:state.entries.map(({id,text,purpose,createdAt,updatedAt})=>({id,text,purpose,createdAt,updatedAt}))};
  }
  deactivate():void {if(this.disposed)return;this.epoch++;this.active=null;this.changed();}
  hasEvent(eventKey:string):boolean {return !this.active||this.active.blocked.includes(eventKey)||this.active.entries.some(entry=>entry.eventKey===eventKey);}
  /** The runtime consumes its exact affirmative token before invoking this method. */
  saveConfirmed(input:ConfirmedTextMemorial,current:()=>boolean):Promise<TextMemorialEntry|null>{
    const value=record(input,['eventKey','invitationId','requestId','messageId','consentMessageId','text','purpose','confirmedAt']);
    if(!hex(value.eventKey))throw Error('文字纪念来源不正确。');
    const accepted:ConfirmedTextMemorial={eventKey:value.eventKey,invitationId:id(value.invitationId),requestId:id(value.requestId),messageId:id(value.messageId),consentMessageId:id(value.consentMessageId),text:text(value.text,240),purpose:text(value.purpose,80),confirmedAt:integer(value.confirmedAt)};
    const epoch=this.epoch,writeEpoch=this.writeEpoch;
    return this.serial(async()=>{
      const base=this.active;
      if(this.disposed||!base||epoch!==this.epoch||writeEpoch!==this.writeEpoch||!current()||this.hasEvent(accepted.eventKey)||base.entries.length>=MAX_ENTRIES)return null;
      const next=structuredClone(base),entry:StoredEntry={id:randomUUID(),text:accepted.text,purpose:accepted.purpose,createdAt:accepted.confirmedAt,updatedAt:accepted.confirmedAt,
        eventKey:accepted.eventKey,invitationId:accepted.invitationId,requestId:accepted.requestId,messageId:accepted.messageId,consentMessageId:accepted.consentMessageId};
      next.entries.push(entry);next.revision++;
      try{await this.persist(base,next,()=>epoch===this.epoch&&writeEpoch===this.writeEpoch&&this.active===base&&current());}
      catch(error){if(error instanceof StaleMemorial)return null;throw error;}
      const {id,text,purpose,createdAt,updatedAt}=entry;return {id,text,purpose,createdAt,updatedAt};
    });
  }
  edit(input:TextMemorialEdit|unknown):Promise<TextMemorialView>{
    const value=record(input,['scopeId','generation','revision','id','text','purpose']),expected=this.expected(value);
    const entryId=id(value.id),body=text(value.text,240),purpose=text(value.purpose,80);this.invalidate();const epoch=this.epoch,writeEpoch=this.writeEpoch;
    return this.serial(async()=>{const base=this.require(expected),next=structuredClone(base),entry=next.entries.find(entry=>entry.id===entryId);if(!entry)throw Error('纪念已不存在。');
      entry.text=body;entry.purpose=purpose;entry.updatedAt=integer((this.options.now??Date.now)());next.revision++;
      await this.persist(base,next,()=>this.epoch===epoch&&writeEpoch===this.writeEpoch&&this.active===base);return this.view()!;});
  }
  delete(input:TextMemorialDelete|unknown):Promise<TextMemorialView>{
    const value=record(input,['scopeId','generation','revision','id']),expected=this.expected(value),entryId=id(value.id);this.invalidate();const epoch=this.epoch,writeEpoch=this.writeEpoch;
    return this.serial(async()=>{const base=this.require(expected),entry=base.entries.find(entry=>entry.id===entryId);if(!entry)throw Error('纪念已不存在。');
      const next=structuredClone(base);if(next.blocked.length>=MAX_BLOCKED)throw Error('纪念删除记录已满。');next.blocked.push(entry.eventKey);next.entries=next.entries.filter(entry=>entry.id!==entryId);next.revision++;
      await this.persist(base,next,()=>this.epoch===epoch&&writeEpoch===this.writeEpoch&&this.active===base);return this.view()!;});
  }
  invalidate():void {this.changed();}
  dispose():void{if(this.disposed)return;this.disposed=true;this.epoch++;this.active=null;this.changed();}
  private expected(value:Record<string,unknown>):TextMemorialExpected {
    if(!hex(value.scopeId))throw Error('纪念范围不正确。');return {scopeId:value.scopeId,generation:integer(value.generation),revision:integer(value.revision)};
  }
  private require(expected:TextMemorialExpected):Stored {
    const state=this.active;if(this.disposed||!state||state.scopeId!==expected.scopeId||this.epoch!==expected.generation||state.revision!==expected.revision)throw Error('文字纪念已变化，请刷新。');return state;
  }
  private changed():void {this.writeEpoch++;try{this.options.invalidated?.();}catch{/* Local commit guards remain authoritative. */}}
  private file(key:string):string{return path.join(this.directory,`text-memorial-${key}.json`);}
  private async persist(base:Stored,next:Stored,current:()=>boolean):Promise<void>{
    validate(next,next.scopeId);const bytes=JSON.stringify(next)+'\n';
    const valid=()=>!this.disposed&&this.active===base&&current();if(Buffer.byteLength(bytes)>MAX_BYTES||!valid())throw new StaleMemorial();
    await mkdir(this.directory,{recursive:true,mode:0o700});const move=this.options.atomic?.rename??rename;
    const writer=createAtomicFileWriter({...this.options.atomic,rename:async(from,to)=>{if(!valid())throw new StaleMemorial();await move(from,to);}});
    await writer(this.file(next.scopeId),bytes);if(this.active===base)this.active=next;
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.queue.then(work,work);this.queue=result.catch(()=>{});return result;}
}
