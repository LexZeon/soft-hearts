import {randomUUID} from 'node:crypto';

const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
/** Sleep blocker only. It never authorizes synthesis, media or any provider. */
export class SpeechPlaybackActivity {
  private scope='';
  private disposed=false;
  private readonly owners=new Map<number,Map<string,string>>();
  constructor(private readonly token:()=>string=()=>randomUUID()){}
  setScope(scope:string):void{
    if(scope===this.scope)return;
    this.scope=typeof scope==='string'&&scope.length<=8192?scope:'';
    this.owners.clear();
  }
  begin(owner:number,id:unknown):string|null{
    if(this.disposed||!this.scope||!Number.isSafeInteger(owner)||owner<=0||!validId(id))return null;
    const entries=this.owners.get(owner)??new Map<string,string>();
    if(entries.has(id)||entries.size>=4)return null;
    const lease=this.token();
    if(typeof lease!=='string'||lease.length<16||lease.length>100)return null;
    entries.set(id,lease);this.owners.set(owner,entries);return lease;
  }
  end(owner:number,id:unknown,lease:unknown):boolean{
    if(!validId(id)||typeof lease!=='string')return false;
    const entries=this.owners.get(owner);
    if(!entries||entries.get(id)!==lease)return false;
    entries.delete(id);if(!entries.size)this.owners.delete(owner);return true;
  }
  dropOwner(owner:number):void{this.owners.delete(owner);}
  get busy():boolean{return [...this.owners.values()].some(entries=>entries.size>0);}
  dispose():void{this.disposed=true;this.scope='';this.owners.clear();}
}
