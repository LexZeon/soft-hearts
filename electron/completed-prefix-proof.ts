/** One event-driven wait for a completed host body's current native prefix.
 * This is a presentation condition on the original lease, never another plan. */
export interface CompletedPrefixSnapshot { text:string; revision:number; ready:boolean; ownerCurrent:boolean }
export interface CompletedPrefixProofPorts {
  snapshot():CompletedPrefixSnapshot;
  current(text:string):boolean;
  waitExact(text:string,signal:AbortSignal):Promise<boolean>;
}
/** R02: a streaming reply's body grows while its first sentence is proven, so it may be read live. */
export type CompletedPrefixBody = string | (() => string | null);
interface Pending {
  full:CompletedPrefixBody;end:number;last:string;revision:number|null;signal:AbortSignal;
  attempt:AbortController|null;timer:ReturnType<typeof setTimeout>|null;
  abort():void;commit(text:string):boolean;resolve(value:boolean):void;reject(error:unknown):void;
}
export class CompletedPrefixProof {
  private pending:Pending|null=null;
  constructor(private readonly ports:CompletedPrefixProofPorts){}
  wait(body:CompletedPrefixBody,end:number,signal:AbortSignal,remainingMs:number,commit:(text:string)=>boolean):Promise<boolean>{
    let full:string|null;try{full=typeof body==='function'?body():body;}catch{full=null;}
    if(this.pending||signal.aborted||full===null||!full.trim()||full.length>6000||!Number.isSafeInteger(end)||end<1||end>full.length
      ||!Number.isFinite(remainingMs)||remainingMs<=0||remainingMs>15*60_000)return Promise.resolve(false);
    return new Promise((resolve,reject)=>{
      const p:Pending={full:body,end,last:'',revision:null,signal,attempt:null,timer:null,commit,resolve,reject,abort:()=>this.finish(p,false)};
      this.pending=p;signal.addEventListener('abort',p.abort,{once:true});
      p.timer=setTimeout(()=>this.finish(p,false),remainingMs);p.timer.unref?.();
      if(signal.aborted)this.finish(p,false);else this.changed();
    });
  }
  /** Called only by existing content/layout/native-ACK events. No polling. */
  changed():void {
    const p=this.pending;if(!p)return;
    let s:CompletedPrefixSnapshot;try{s=this.ports.snapshot();}catch{this.finish(p,false);return;}
    if(p.signal.aborted||!s.ownerCurrent){this.finish(p,false);return;}
    let full:string|null;try{full=typeof p.full==='function'?p.full():p.full;}catch{full=null;}
    if(full===null||!full.startsWith(s.text)||!s.text.startsWith(p.last)){this.finish(p,false);return;}
    p.last=s.text;
    if(p.revision!==s.revision){p.attempt?.abort();p.attempt=null;p.revision=null;}
    if(!s.ready||s.text.length<p.end)return;
    let current=false;try{current=this.ports.current(s.text);}catch{this.finish(p,false);return;}
    if(current){this.finish(p,true,s.text);return;}
    if(p.revision===s.revision)return;
    p.revision=s.revision;const revision=s.revision,text=s.text,attempt=new AbortController();p.attempt=attempt;
    let proof:Promise<boolean>;try{proof=this.ports.waitExact(text,AbortSignal.any([p.signal,attempt.signal]));}catch{this.finish(p,false);return;}
    void proof.then(ok=>{
      if(this.pending!==p||p.attempt!==attempt)return;
      const latest=this.ports.snapshot();
      if(latest.revision!==revision){this.changed();return;}
      if(!ok||!latest.ownerCurrent||latest.text!==text||!this.ports.current(text)){this.finish(p,false);return;}
      this.finish(p,true,text);
    }).catch(()=>{if(this.pending===p&&p.attempt===attempt)this.finish(p,false);});
  }
  cancel():void{if(this.pending)this.finish(this.pending,false);}
  private finish(p:Pending,accepted:boolean,text?:string):void{
    if(this.pending!==p)return;this.pending=null;
    if(p.timer!==null)clearTimeout(p.timer);p.signal.removeEventListener('abort',p.abort);
    try{p.resolve(accepted&&text!==undefined&&p.commit(text));}catch(error){p.reject(error);}
    finally{p.attempt?.abort();}
  }
}
