import { splitReplySegments } from '../shared/reply-segments';
import { IncrementalReplySegments } from '../shared/incremental-reply-segments';
import { FirstCommaReplySegments, replySpeechParser, type FirstChunkOptions } from '../shared/first-speech-chunk';
import type { ApprovedReplySpeechSegment } from '../shared/tts';

interface Piece { start: number; end: number; text: string }
interface CompletedReply {
  owner: number; id: string; scope: string; text: string; pieces: Piece[];
  expires: number; index: number; cloudClaimed: boolean; finished: boolean; error?: string;
  lease: ApprovedReplySpeechSegment | null; receiptApproved: boolean; presentationAbort: AbortController | null;
  presentationReady: boolean;
  prefixEligible:boolean; receiptText:string|null;
  /** R02: present while the provider is still streaming this reply's later sentences. */
  stream?: { token: object; waiters: Set<() => void> } | null;
}
interface PendingCommit { owner:number;id:string;scope:string;token:object;expires:number;
  promise:Promise<CompletedReply|null>;resolve(slot:CompletedReply|null):void;timer:ReturnType<typeof setTimeout>|null;
  /** Streamed visible text and its sentence parser (R02 early speech). */
  text:string;parser:IncrementalReplySegments|FirstCommaReplySegments|null;error?:string }
const LIMIT = 6000;
const TOO_LONG = '这条回复超过自动朗读的6000字符限制，完整文字仍可查看。';
const UNSAFE = '这条回复无法安全分段朗读，完整文字仍可查看。';
/** One transient, completed ordinary reply. This class has no provider, reward or archive access. */
export class CompletedReplySpeech {
  private latest: CompletedReply | null = null;
  private pendingCommit:PendingCommit|null=null;
  constructor(private readonly now = () => performance.now()) {}
  /** Holds the logical sequence across drain and next-bubble confirmation. */
  get busy(): boolean {
    if(this.pendingCommit&&this.now()>=this.pendingCommit.expires)this.clear();
    if (this.latest && this.now() >= this.latest.expires) this.clear();
    return !!this.pendingCommit || (!!this.latest && !this.latest.finished && !this.latest.error && this.latest.pieces.length > 0);
  }

  /**
   * Host acceptance fence only. No completed body, style, segment or audio authority exists here.
   * `first` (I-029, frozen for this reply): mode 'comma' lets the first piece end at a comma inside the first sentence once
   * enough spoken units for this voice came before it (shared/first-speech-chunk.ts); anything else is the sentence parser
   * used before.
   */
  beginCommit(owner:number,id:string,scope:string,first:FirstChunkOptions={mode:'sentence'}):object {
    if(!Number.isSafeInteger(owner)||owner<=0||!/^[A-Za-z0-9_-]{1,100}$/u.test(id)||!scope||scope.length>8192)throw Error('回复语音身份无效。');
    this.clear();let resolve!:(slot:CompletedReply|null)=>void;const promise=new Promise<CompletedReply|null>(done=>{resolve=done;});
    const p:PendingCommit={owner,id,scope,token:{},expires:this.now()+15*60_000,promise,resolve,timer:null,
      text:'',parser:replySpeechParser(first?.mode==='comma'?{mode:'comma',voice:first.voice,minUnits:first.minUnits}:{mode:'sentence'},{maxReplyChars:LIMIT})};this.pendingCommit=p;
    p.timer=setTimeout(()=>{if(this.pendingCommit===p)this.clear();},15*60_000);p.timer.unref?.();return p.token;
  }

  /**
   * R02: one visible provider delta of the accepted reply, in order, before it
   * is shown anywhere. The first complete sentence makes the reply speakable
   * (waitForCommit resolves) while later sentences still stream; each segment
   * keeps its own native-display proof, lease and cloud claim as before.
   */
  append(fence:object,delta:string):void {
    const p=this.pendingCommit;
    if(!p||p.token!==fence||typeof delta!=='string'||!delta||p.error||!p.parser)return;
    const slot=this.latest?.stream?.token===p.token?this.latest:null;
    if(p.text.length+delta.length>LIMIT){this.failStream(p,slot,TOO_LONG);return;}
    p.text+=delta;
    let pieces:Piece[];
    try{pieces=p.parser.push(delta);}catch{this.failStream(p,slot,UNSAFE);return;}
    if(pieces.some(piece=>piece.text.length>2000||piece.text!==p.text.slice(piece.start,piece.end))){this.failStream(p,slot,UNSAFE);return;}
    const usable=pieces.filter(piece=>piece.text.trim()).map(piece=>({...piece}));
    if(slot){slot.text=p.text;if(usable.length){slot.pieces.push(...usable);this.wake(slot);}return;}
    if(!usable.length)return;
    const streamed:CompletedReply={owner:p.owner,id:p.id,scope:p.scope,text:p.text,pieces:usable,index:-1,cloudClaimed:false,finished:false,
      expires:p.expires,lease:null,receiptApproved:false,presentationAbort:null,
      // Each segment still waits for its own native prefix paint proof; there is no completed-body ack to wait for.
      presentationReady:true,prefixEligible:true,receiptText:null,stream:{token:p.token,waiters:new Set()}};
    this.latest=streamed;p.resolve(streamed);
  }

  /** Resolves once the segment after `completedIndex` exists, the stream ended, or the reply was replaced. */
  waitForPiece(owner:number,id:string,scope:string,completedIndex?:number):Promise<boolean>{
    const s=this.match(owner,id,scope);
    const wanted=completedIndex===undefined?0:completedIndex+1;
    if(!s||!s.stream||s.error||s.pieces.length>wanted)return Promise.resolve(!!s);
    return new Promise(resolve=>{
      const stream=s.stream!;
      const done=()=>{stream.waiters.delete(done);clearTimeout(timer);resolve(this.match(owner,id,scope)===s);};
      const timer=setTimeout(done,Math.max(0,s.expires-this.now()));timer.unref?.();
      stream.waiters.add(done);
    });
  }

  private wake(slot:CompletedReply):void{for(const waiter of [...slot.stream?.waiters??[]])waiter();}
  private failStream(p:PendingCommit,slot:CompletedReply|null,error:string):void{
    p.error=error;p.parser?.cancel();p.parser=null;
    if(slot){slot.error=error;this.wake(slot);}
  }
  async waitForCommit(owner:number,id:string,scope:string):Promise<object|null>{
    if(this.pendingCommit&&this.now()>=this.pendingCommit.expires)this.clear();
    const s=this.match(owner,id,scope);if(s)return s;
    const p=this.pendingCommit;if(!p||p.owner!==owner||p.id!==id||p.scope!==scope)return null;
    const committed=await p.promise;return committed&&this.latest===committed&&!!this.match(owner,id,scope)?committed:null;
  }
  commitCurrent(fence:object,owner:number,id:string,scope:string):boolean{return this.match(owner,id,scope)===fence;}
  cancelPending(fence:object):void{if(this.pendingCommit?.token===fence)this.clear();}
  isPrefixReply(owner:number,id:string,scope:string):boolean{return !!this.match(owner,id,scope)?.prefixEligible
    ||!!this.pendingCommit&&this.pendingCommit.owner===owner&&this.pendingCommit.id===id&&this.pendingCommit.scope===scope;}

  record(owner: number, id: string, scope: string, text: string, options?:{prefix:boolean;fence:object}): boolean {
    if (!Number.isSafeInteger(owner) || owner <= 0 || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || typeof scope !== 'string' || !scope || scope.length > 8192) throw Error('回复语音身份无效。');
    const pending=options?.prefix?this.pendingCommit:null;
    if(options?.prefix&&(!pending||pending.token!==options.fence||pending.owner!==owner||pending.id!==id||pending.scope!==scope))return false;
    if(pending){this.pendingCommit=null;if(pending.timer!==null)clearTimeout(pending.timer);}
    const streamed=pending&&this.latest?.stream?.token===pending.token?this.latest:null;
    if(streamed&&pending){
      // R02: finish the reply that is already speaking in place; issued leases and order survive.
      if(!streamed.error){
        if(pending.error)streamed.error=pending.error;
        else if(typeof text!=='string'||text!==pending.text)streamed.error=UNSAFE;
        else try{
          const tail=pending.parser!.finish();
          if(tail.some(piece=>piece.text.length>2000||piece.text!==text.slice(piece.start,piece.end))||streamed.pieces.length+tail.length>128)throw Error();
          streamed.pieces.push(...tail.filter(piece=>piece.text.trim()).map(piece=>({...piece})));
          streamed.text=text;
        }catch{streamed.error=UNSAFE;}
      }
      const stream=streamed.stream;streamed.stream=null;
      for(const waiter of [...stream?.waiters??[]])waiter();
      pending.resolve(streamed);return true;
    }
    this.clear();
    const slot: CompletedReply = { owner, id, scope, text: '', pieces: [], index: -1, cloudClaimed: false, finished: false, expires: this.now() + 15 * 60_000, lease: null, receiptApproved: false, presentationAbort: null, presentationReady: false,prefixEligible:!!options?.prefix,receiptText:null };
    this.latest = slot;
    if (typeof text !== 'string' || text.length > LIMIT) slot.error = '这条回复超过自动朗读的6000字符限制，完整文字仍可查看。';
    else { slot.text = text;
    try {
      const all = splitReplySegments(text);
      let end = 0;
      for (const p of all) {
        if (p.start !== end || p.end <= p.start || p.end > text.length || p.text !== text.slice(p.start, p.end) || p.text.length > 2000) throw Error('回复句段边界不正确。');
        end = p.end;
      }
      if (end !== text.length || all.length > 128) throw Error('回复句段不完整。');
      slot.pieces = all.filter(p => p.text.trim()).map(p => ({ ...p }));
    } catch { slot.error = '这条回复无法安全分段朗读，完整文字仍可查看。'; } }
    pending?.resolve(slot);return true;
  }

  isOrdinary(owner: number, id: string, scope: string): boolean { return !!this.match(owner, id, scope)
    ||!!this.pendingCommit&&this.pendingCommit.owner===owner&&this.pendingCommit.id===id&&this.pendingCommit.scope===scope; }

  next(owner: number, id: string, scope: string, completedIndex?: number): ApprovedReplySpeechSegment | null {
    const s = this.match(owner, id, scope);
    if (!s || s.finished) return null;
    if (s.error) throw Error(s.error);
    if (s.index === -1 ? completedIndex !== undefined : completedIndex !== s.index) throw Error('回复句段顺序已失效。');
    // A streaming reply's next sentence is not complete yet: callers await waitForPiece first.
    if (s.stream && s.index + 1 >= s.pieces.length) throw Error('回复句段尚未完成。');
    s.presentationAbort?.abort();s.lease = null;s.receiptApproved = false;s.receiptText=null;s.presentationAbort = null;
    s.index++; s.cloudClaimed = false;
    if (s.index >= s.pieces.length) { s.finished = true; return null; }
    const piece = s.pieces[s.index];
    s.presentationAbort = new AbortController();
    s.lease = Object.freeze({ replyId: s.id, index: s.index, text: piece.text.trim(), visibleText: s.text.slice(0, piece.end), context: Object.freeze({ replyId: s.id, segmentIndex: s.index }) });
    return s.lease;
  }

  current(owner: number, id: string, scope: string, index: number): boolean {
    const s = this.match(owner, id, scope);return !!s && !s.finished && s.index === index && index >= 0 && index < s.pieces.length;
  }

  /** Host-only immutable raw body for this exact current lease. This never approves a native receipt. */
  fullPresentationText(owner: number, id: string, scope: string, lease: ApprovedReplySpeechSegment): string | null {
    const s = this.match(owner, id, scope);
    if (!s || s.finished || s.error || !lease || s.lease !== lease || s.index !== lease.index
      || !s.presentationAbort || s.presentationAbort.signal.aborted) return null;
    const piece = s.pieces[s.index];
    if (!piece || !Number.isSafeInteger(piece.start) || !Number.isSafeInteger(piece.end)
      || piece.start < 0 || piece.end <= piece.start || piece.end > s.text.length
      || piece.text !== s.text.slice(piece.start, piece.end)
      || lease.replyId !== s.id || lease.context?.replyId !== s.id || lease.context.segmentIndex !== s.index
      || lease.visibleText !== s.text.slice(0, piece.end) || lease.text !== piece.text.trim()) return null;
    return s.text;
  }

  ownsLease(owner: number, id: string, scope: string, lease: ApprovedReplySpeechSegment): boolean {
    const s = this.match(owner, id, scope);return !!s && !s.finished && s.lease === lease && s.index === lease.index;
  }
  private readyWaiter: (() => void) | null = null;
  /** Called only by the host after the current pet has closed this reply's stream. */
  markPresentationReady(id: string, scope: string, fence?:object): boolean {
    const s = this.latest;
    if (!s || !this.match(s.owner, id, scope) || s.finished || (fence!==undefined&&s!==fence)) return false;
    s.presentationReady = true;this.readyWaiter?.();return true;
  }
  waitForPresentationReady(owner: number, id: string, scope: string, lease: ApprovedReplySpeechSegment): Promise<boolean> {
    const signal = this.presentationSignal(owner, id, scope, lease);
    if (!signal || signal.aborted) return Promise.resolve(false);
    if (this.latest!.presentationReady) return Promise.resolve(true);
    const expires = this.latest!.expires;
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;settled = true;clearTimeout(timer);signal.removeEventListener('abort', finish);
        if (this.readyWaiter === finish) this.readyWaiter = null;
        resolve(this.ownsLease(owner, id, scope, lease) && !signal.aborted && this.latest!.presentationReady);
      };
      const timer = setTimeout(finish, Math.max(0, expires - this.now()));
      this.readyWaiter = finish;signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || this.latest!.presentationReady) finish();
    });
  }
  presentationSignal(owner: number, id: string, scope: string, lease: ApprovedReplySpeechSegment): AbortSignal | null {
    return this.ownsLease(owner, id, scope, lease) ? this.latest!.presentationAbort?.signal ?? null : null;
  }
  prefixMode(owner:number,id:string,scope:string,lease:ApprovedReplySpeechSegment):boolean{return this.ownsLease(owner,id,scope,lease)&&this.latest!.prefixEligible;}
  presentationRemaining(owner:number,id:string,scope:string,lease:ApprovedReplySpeechSegment):number{return this.ownsLease(owner,id,scope,lease)?Math.max(0,this.latest!.expires-this.now()):0;}
  approvedPresentationText(owner:number,id:string,scope:string,index:unknown):string|null{return this.approvedSegment(owner,id,scope,index)?this.latest!.receiptText:null;}
  approvePresentation(owner: number, id: string, scope: string, lease: ApprovedReplySpeechSegment, candidate?:string): boolean {
    if (!this.ownsLease(owner, id, scope, lease) || this.latest!.presentationAbort?.signal.aborted) return false;
    const s=this.latest!,text=candidate??s.text;
    if(!s.text.startsWith(text)||text.length<lease.visibleText.length||(!s.prefixEligible&&text!==s.text))return false;
    s.receiptText=text;s.receiptApproved = true;return true;
  }
  approvedSegment(owner: number, id: string, scope: string, index: unknown): ApprovedReplySpeechSegment | null {
    const s = this.match(owner, id, scope);
    return s && !s.finished && s.receiptApproved && !s.presentationAbort?.signal.aborted && s.index === index ? s.lease : null;
  }
  /** Host-only view of the current acknowledged ordinary segment. */
  approvedCurrentSegment(owner: number, scope: string): ApprovedReplySpeechSegment | null {
    const s = this.latest;
    return s?.owner === owner ? this.approvedSegment(owner, s.id, scope, s.index) : null;
  }

  authorizeCloud(owner: number, id: string, scope: string, index: unknown, text: unknown): void {
    const s = this.match(owner, id, scope);
    if (!s || s.finished || !s.receiptApproved || !s.lease || s.presentationAbort?.signal.aborted || !Number.isInteger(index) || (index as number) < 0 || (index as number) > 127 || index !== s.index || s.cloudClaimed || typeof text !== 'string' || text !== s.pieces[s.index]?.text.trim()) throw Error('这段语音不属于当前已确认显示的回复。');
    s.cloudClaimed = true;
  }

  cancel(owner: number, id: string): boolean {
    if ((this.latest?.owner !== owner || this.latest.id !== id)&&(this.pendingCommit?.owner!==owner||this.pendingCommit.id!==id)) return false;
    this.clear(); return true;
  }
  cancelReply(id: string): void { if (this.latest?.id === id||this.pendingCommit?.id===id) this.clear(); }
  dropOwner(owner: number): void { if (this.latest?.owner === owner||this.pendingCommit?.owner===owner) this.clear(); }
  clear(): void { const prior = this.latest,pending=this.pendingCommit;this.latest = null;this.pendingCommit=null;prior?.presentationAbort?.abort();
    if(prior?.stream){const stream=prior.stream;prior.stream=null;for(const waiter of [...stream.waiters])waiter();}
    if(pending){pending.parser?.cancel();if(pending.timer!==null)clearTimeout(pending.timer);pending.resolve(null);} }
  identity(): { owner: number; id: string } | null { const s=this.latest&&!this.latest.finished?this.latest:this.pendingCommit;return s?{owner:s.owner,id:s.id}:null; }
  /** Host-only exact plan capability, including preparing and between-segment gaps.
   * Object identity rejects replacement even if an old reply ID is reused. */
  captureReadout(scope: string): object | null {
    if(this.pendingCommit?.scope===scope)return this.pendingCommit;
    return this.busy && this.latest?.scope === scope ? this.latest : null;
  }
  private match(owner: number, id: string, scope: string): CompletedReply | null {
    const s = this.latest;
    if (s && this.now() >= s.expires) this.clear();
    return this.latest?.owner === owner && this.latest.id === id && this.latest.scope === scope ? this.latest : null;
  }
}
