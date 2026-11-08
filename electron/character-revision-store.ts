import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { validateLanguageCharacterId, validateLanguageRevision } from '../shared/personalize-language';

export interface CharacterRevision<P> { revision: number; profile: P }
export interface CharacterRevisionState<P> extends CharacterRevision<P> { characterId: string; previous?: CharacterRevision<P>; storageError?: string }
interface Entry<P> extends CharacterRevision<P> { previous?: CharacterRevision<P> }
interface Codec<P> { file: string; label: string; noun?:string; corruptMessage?:string; empty(): P; validate(value: unknown): P }
const MAX_ENTRIES = 128, MAX_BYTES = 2_000_000;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid character revision storage');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).some(key=>!keys.includes(key)))throw Error('Unknown character revision fields');return row;
}
/** Shared mechanics for the two concrete optional personalize sidecars; no generic renderer port. */
export class CharacterRevisionStore<P> {
  private entries=new Map<string,Entry<P>>();
  private queue:Promise<unknown>=Promise.resolve();
  private storageError='';
  private readonly file:string;
  constructor(private readonly directory:string,private readonly characterIds:()=>readonly string[],
    private readonly codec:Codec<P>,private readonly writeAtomic:AtomicFileWriter=atomicWriteFile){
    if(!/^[a-z][a-z-]*\.json$/.test(codec.file))throw Error('Host sidecar filename');this.file=path.join(directory,codec.file);
  }
  async load():Promise<void>{
    await mkdir(this.directory,{recursive:true});const entries=new Map<string,Entry<P>>();
    try{
      if((await stat(this.file)).size>MAX_BYTES)throw Error('Too large');const bytes=await readFile(this.file);if(bytes.length>MAX_BYTES)throw Error('Too large');
      const raw=object(JSON.parse(bytes.toString('utf8')),['version','entries']);
      if(raw.version!==1||!Array.isArray(raw.entries)||raw.entries.length>MAX_ENTRIES)throw Error('Invalid storage');
      for(const value of raw.entries){const row=object(value,['characterId','revision','profile','previous']),id=validateLanguageCharacterId(row.characterId),revision=validateLanguageRevision(row.revision);
        if(entries.has(id)||revision<1)throw Error('Invalid revision');const entry:Entry<P>={revision,profile:this.codec.validate(row.profile)};
        if(row.previous!==undefined){const previous=object(row.previous,['revision','profile']),previousRevision=validateLanguageRevision(previous.revision);
          if(previousRevision>=revision)throw Error('Invalid previous revision');entry.previous={revision:previousRevision,profile:this.codec.validate(previous.profile)};}
        entries.set(id,entry);
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){this.entries.clear();this.storageError=this.codec.corruptMessage??`${this.codec.label}存档无法读取，原 ${this.codec.file} 已保留。修复并重新启动前不能覆盖。`;return;}}
    this.entries=entries;this.storageError='';
  }
  private exists(id:string):boolean{return this.characterIds().includes(id);}
  private character(value:unknown):string{const id=validateLanguageCharacterId(value);if(!this.exists(id))throw Error('角色卡不存在，请重新读取角色列表。');return id;}
  get(value:unknown):CharacterRevisionState<P>{const id=this.character(value),entry=this.entries.get(id);return {characterId:id,revision:this.storageError?0:entry?.revision??0,
    profile:this.effectiveProfile(id),...(!this.storageError&&entry?.previous?{previous:structuredClone(entry.previous)}:{}),...(this.storageError?{storageError:this.storageError}:{})};}
  effectiveProfile(id:string):P{return !this.storageError&&this.exists(id)&&this.entries.has(id)?structuredClone(this.entries.get(id)!.profile):this.codec.empty();}
  private mutate<T>(operation:()=>Promise<T>):Promise<T>{const pending=this.queue.then(operation,operation);this.queue=pending.catch(()=>{});return pending;}
  save(value:unknown,input:unknown,expectedRevision:unknown):Promise<CharacterRevisionState<P>>{const profile=this.codec.validate(input),revision=validateLanguageRevision(expectedRevision);return this.mutate(()=>this.change(value,revision,profile,false));}
  undo(value:unknown,expectedRevision:unknown):Promise<CharacterRevisionState<P>>{const revision=validateLanguageRevision(expectedRevision);return this.mutate(()=>this.change(value,revision,null,true));}
  private async change(value:unknown,expected:number,desired:P|null,undo:boolean):Promise<CharacterRevisionState<P>>{
    if(this.storageError)throw Error(this.storageError);const id=this.character(value),current=this.entries.get(id)??{revision:0,profile:this.codec.empty()};
    if(expected!==current.revision)throw Error(`这张卡的${this.codec.label}已有新修改。草稿已保留，请重新读取后确认。`);
    if(undo&&!current.previous)throw Error('没有可恢复的上次确认版本。');const profile=structuredClone(undo?current.previous!.profile:desired!);
    if(!undo&&JSON.stringify(profile)===JSON.stringify(current.profile))return this.get(id);
    const revision=current.revision+1;if(!Number.isSafeInteger(revision))throw Error(`${this.codec.label}修订号已达上限。`);
    const entry:Entry<P>={revision,profile,...(!undo?{previous:{revision:current.revision,profile:structuredClone(current.profile)}}:{})};
    let next=new Map(this.entries);next.set(id,entry);
    if(next.size>MAX_ENTRIES){const ids=new Set(this.characterIds());next=new Map([...next].filter(([key])=>ids.has(key)));}
    if(next.size>MAX_ENTRIES)throw Error(`${this.codec.label}存档数量已达上限，原${this.codec.noun??'记录'}已保留。`);
    const data=JSON.stringify({version:1,entries:[...next].map(([characterId,item])=>({characterId,...item}))},null,2);
    if(Buffer.byteLength(data,'utf8')>MAX_BYTES)throw Error(`${this.codec.label}存档过大，原${this.codec.noun??'记录'}已保留。`);
    await this.writeAtomic(this.file,data);this.entries=next;this.character(id);return this.get(id);
  }
}
