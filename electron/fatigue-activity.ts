import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {AssetRef, AppSettings} from '../shared/contracts';
import type {SleepEntryBlockers} from '../shared/fatigue';
import type {MotionLibrary} from './motion-library';

const CLOSED: SleepEntryBlockers = Object.freeze({chat:true,tts:true,manualMotion:true});
type Activity = Readonly<{initialized:boolean;chat:boolean;tts:boolean}>;
type Selection = Pick<AppSettings,'motion'|'motionLayers'>;

/** Background exception is the verified bundled resource, never a familiar name. */
export async function verifiedFatigueBackground(asset: AssetRef, library: Pick<MotionLibrary,'resolvePreview'>): Promise<boolean> {
  try {
    const approved=await library.resolvePreview('gene','stand');
    if(!path.isAbsolute(approved)||path.resolve(asset.path)!==path.resolve(approved))return false;
    const info=await lstat(approved);
    if(!info.isFile()||info.isSymbolicLink()||info.size!==56611)return false;
    const bytes=await readFile(approved);
    return bytes.length===56611&&bytes.subarray(0,30).toString('ascii').replace(/\0.*$/,'')==='Vocaloid Motion Data 0002'
      &&createHash('sha256').update(bytes).digest('hex')==='42080246b98aaa8a5b98d1ecd73994cf42b2587f9c04c3ed7435cf859fef83aa';
  }catch{return false;}
}

/** Current host ownership only; late file checks cannot release a newer selection. */
export class FatigueActivityBridge {
  private activity: Activity={initialized:false,chat:true,tts:true};
  private manual=true;
  private selection='';
  private generation=0;
  private disposed=false;
  private published: SleepEntryBlockers|null=null;
  constructor(private readonly publish:(value:SleepEntryBlockers)=>void,
    private readonly verify:(asset:AssetRef)=>Promise<boolean>){}
  setActivity(value:Activity):void{
    this.activity={initialized:value.initialized===true,chat:value.chat!==false,tts:value.tts!==false};
    this.emit();
  }
  setSelection(value:Selection):void{
    if(this.disposed)return;
    const pose=value.motion?{...value.motion}:null;
    const key=JSON.stringify([pose?.path??null,pose?.url??null,value.motionLayers?.gesture?.path??null,
      value.motionLayers?.gesture?.url??null,value.motionLayers?.expression?.path??null,value.motionLayers?.expression?.url??null]);
    if(key===this.selection)return;
    this.selection=key;const generation=++this.generation;
    this.manual=true;this.emit();
    if(value.motionLayers?.gesture||value.motionLayers?.expression)return;
    if(!pose){this.manual=false;this.emit();return;}
    void Promise.resolve().then(()=>this.verify(pose)).then(verified=>{
      if(!this.disposed&&generation===this.generation){this.manual=verified!==true;this.emit();}
    },()=>{/* Unknown or failed verification remains closed. */});
  }
  current():SleepEntryBlockers{
    return this.disposed||!this.activity.initialized?CLOSED:Object.freeze({chat:this.activity.chat,tts:this.activity.tts,manualMotion:this.manual});
  }
  dispose():void{this.disposed=true;this.generation++;this.emit();}
  private emit():void{
    const next=this.current(),old=this.published;
    if(old&&old.chat===next.chat&&old.tts===next.tts&&old.manualMotion===next.manualMotion)return;
    this.published=next;this.publish(next);
  }
}
