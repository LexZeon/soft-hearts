import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import {CompletedPrefixProof, type CompletedPrefixBody} from './completed-prefix-proof';
import { PET_TOPMOST_LEVEL } from './pet-topmost';
import path from 'node:path';
import { layoutReply, type ReplyAnchor, type ReplyLayout, type ReplySide } from './reply-layout';
import { ReplyLifetime } from './reply-lifetime';
import { REPLY_HTML } from './reply-html';
import { validateReplyUpdate } from './reply-input';
import { ReplyPresentation } from './reply-presentation';
import type { PetReplyPieces } from '../shared/contracts';
import { replyLingerWithoutMood } from '../shared/behaviors/reply-linger/choose';
import { safeLingerMs } from '../shared/behaviors/reply-linger/perform';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';
import type { PetReplyLingerAnswer, ReplyLingerBubble } from '../shared/behaviors/reply-linger/interface';

/** Developer timing only: told when reply text reaches and is painted by the native bubble. No authority. */
export interface ReplySurfaceObserver { rendered(text: string): void; painted(text: string): void }

const REPLY_URL = `data:text/html;charset=utf-8,${encodeURIComponent(REPLY_HTML)}#soft-hearts-reply`;
interface NextPresentationWaiter {
  expectedText: string;
  afterRevision: number;
  started: boolean;
  resolve(value: boolean): void;
  controller: AbortController;
  signal?: AbortSignal;
  onAbort(): void;
  timer?: ReturnType<typeof setTimeout>;
}
interface ConfirmedPresentation {
  window: BrowserWindow;
  recipient: BrowserWindow['webContents'];
  token: string;
  text: string;
  signal?: AbortSignal;
}

/** A text-only auxiliary window avoids clipping, moving or widening the MMD viewport. */
export class PetReplyWindow {
  private window: BrowserWindow | null = null;
  private ready = false;
  private disposed = false;
  private text = '';
  private contentRevision = 0;
  private nextPresentation: NextPresentationWaiter | null = null;
  private waiting = false;
  private segmented = false;
  /** R27 display layout of the current text revision; never part of the receipt or speech proof. */
  private pieces: PetReplyPieces | null = null;
  private observer: ReplySurfaceObserver | null = null;
  private interactionOpacity = 1;
  /**
   * B06: bumped when a pat/feed fade
   * starts and when it ends. The fade invalidates the paint receipt (a faded
   * bubble proves nothing); the fade-in mints a fresh one for the same text, and
   * the prefix proof sees a new revision, so a sentence waiting for its proof
   * resumes instead of failing and cancelling the rest of the readout.
   */
  private fadeRevision = 0;
  private sentText: string | undefined;
  private anchor: ReplyAnchor = { x: 0, y: 0, visible: false };
  private side?: ReplySide;
  private emojiLayoutListener: (() => void) | null = null;
  /** Host-only planned AND still-visible native bounds, for a separate glyph
   * surface. Neither renderer can place a window or move the other surface. */
  setEmojiLayoutListener(listener: () => void): void { this.emojiLayoutListener = listener; }
  emojiExclusions(): Array<{ x: number; y: number; width: number; height: number }> {
    const bounds = [];
    const planned = this.currentLayout()?.bounds;
    if (planned) bounds.push({ ...planned });
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) bounds.push(this.window.getBounds());
    return bounds;
  }
  private readonly presentation = new ReplyPresentation();
  private lastConfirmed: ConfirmedPresentation | null = null;
  private completedPrefixPaint:ConfirmedPresentation|null=null;
  private readonly completedPrefixProof=new CompletedPrefixProof({
    snapshot:()=>{
      const win=this.window;
      const ownerCurrent=!this.disposed&&!this.owner.isDestroyed()&&this.owner.isVisible()&&!this.owner.isMinimized()&&this.owner.getOpacity()>0
        &&(!win||!this.ready||this.waiting||!this.text.trim()||(!win.isDestroyed()&&win.isVisible()&&!win.isMinimized()
          &&win.webContents.getURL()===REPLY_URL&&win.webContents.mainFrame.url===REPLY_URL));
      return {text:this.text,revision:this.contentRevision+this.fadeRevision,ownerCurrent,
        ready:ownerCurrent&&this.ready&&!this.waiting&&!this.segmented&&!!this.currentLayout()&&this.interactionOpacity>0&&this.actuallyVisible()};
    },
    current:text=>this.isCompletedPrefixCurrent(text),
    waitExact:async(text,signal)=>{
      const shown=await this.waitForPresentation(text,signal),proof=this.lastConfirmed;
      if(shown&&proof&&this.proofCurrent(proof,text))this.completedPrefixPaint={...proof,signal:undefined};
      return shown&&this.isCompletedPrefixCurrent(text);
    },
  });
  private readonly lifetime = new ReplyLifetime(() => this.clear());
  private readonly move = () => this.sync();
  private readonly hidden = () => this.clear();
  private readonly restored = () => {
    this.clear();
    const win = this.window;
    // Windows restores owned HWNDs after the parent's restore event, without a
    // second Electron show event. Re-hide after that native operation unwinds.
    setImmediate(() => { if (win && this.window === win && !win.isDestroyed() && !this.hasContent()) win.hide(); });
  };
  private readonly closed = () => this.dispose();
  private readonly presented = (event: IpcMainEvent, token: unknown) => {
    const win = this.window;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || event.senderFrame?.url !== REPLY_URL || win.webContents.getURL() !== REPLY_URL) return;
    if (this.presentation.acknowledge(token, win.webContents, this.actuallyVisible())) this.notify('painted');
    this.completedPrefixProof.changed();
  };
  /**
   * #5: `linger` decides how long a completed reply stays (electron/main.ts hands it MoodHost.decideReplyLinger, which adds her
   * mood and card). It is asked once per 'complete', with exactly what this window shows; its answer is the only lifetime.
   */
  constructor(private readonly owner: BrowserWindow, private readonly linger: (bubble: ReplyLingerBubble) => number = replyLingerWithoutMood) {
    owner.on('move', this.move); owner.on('resize', this.move);
    owner.on('hide', this.hidden); owner.on('minimize', this.hidden); owner.on('restore', this.restored);
    owner.on('closed', this.closed);
    ipcMain.on('desk:reply-presented', this.presented);
  }
  /**
   * Returns this reply's lifetime when `value` completes it, and while a completed reply is kept, how long it still stays
   * from now (its countdown runs only while it can be seen, Codex T-207 2C); the pet window keeps the same deadline from it
   * (src/ui/PetUI.ts).
   */
  update(value: unknown): PetReplyLingerAnswer | undefined {
    const answer = this.apply(value);
    this.trackSight();
    if (answer || this.disposed || this.waiting || !this.text.trim()) return answer;
    const left = this.lifetime.remaining();
    return left === undefined ? undefined : { lingerMs: Math.round(left) };
  }
  private apply(value: unknown): PetReplyLingerAnswer | undefined {
    const patch = validateReplyUpdate(value);
    if (this.disposed) return;
    if (patch.anchor) this.anchor = { ...patch.anchor };
    if (patch.state === 'hidden') { this.clear(); return; }
    if (patch.state === 'waiting') this.cancelNextPresentation();
    const wasFaded = this.interactionOpacity <= 0;
    if (patch.interactionOpacity !== undefined) this.interactionOpacity = patch.interactionOpacity;
    const fadeEnded = wasFaded && this.interactionOpacity > 0;
    if (wasFaded !== this.interactionOpacity <= 0) this.fadeRevision++;
    if (patch.state !== undefined) this.waiting = patch.state === 'waiting';
    const segmentationChanged = patch.segmented !== undefined && this.segmented !== patch.segmented;
    if (patch.segmented !== undefined) this.segmented = patch.segmented;
    if (this.waiting) { this.text = ''; this.pieces = null; }
    else if (patch.text !== undefined) { this.text = patch.text; this.pieces = patch.pieces ? { mode: patch.pieces.mode, ends: [...patch.pieces.ends] } : null; this.contentRevision++; }
    if (patch.state === 'waiting' || patch.state === 'streaming') this.lifetime.streaming();
    let answer: PetReplyLingerAnswer | undefined;
    if (patch.state === 'complete') { const lingerMs = this.lingerFor(); this.lifetime.complete(lingerMs); answer = { lingerMs }; }
    if (!this.hasContent()) { this.cancelNextPresentation(); this.lastConfirmed = null;this.completedPrefixPaint=null;this.presentation.clear(); this.window?.hide();this.completedPrefixProof.changed(); return answer; }
    this.ensureWindow();
    if (this.waiting) { this.lastConfirmed = null; this.presentation.clear(); }
    else if ((patch.text !== undefined || segmentationChanged || fadeEnded) && this.window && !this.window.isDestroyed()) { this.lastConfirmed = null;this.completedPrefixPaint=null; this.presentation.begin(this.text, this.window.webContents); }
    this.sync();
    if (!this.waiting && patch.text !== undefined) this.acceptNextContent(patch.segmented === true);
    else if (segmentationChanged && this.nextPresentation?.started) this.cancelNextPresentation();
    this.completedPrefixProof.changed();
    return answer;
  }
  /** #5: nothing readable shows → nothing to linger over (the shortest; nothing asked or remembered). A throwing decider → the longest. */
  private lingerFor(): number {
    if (!this.text.trim()) return REPLY_LINGER_KNOBS.range[0];
    const pieces = this.pieces ? { mode: this.pieces.mode, ends: [...this.pieces.ends] } : null;
    try { return safeLingerMs(this.linger({ text: this.text, pieces, segmented: this.segmented })); } catch { return safeLingerMs(NaN); }
  }
  clear(): void { this.completedPrefixProof.cancel();this.completedPrefixPaint=null;this.cancelNextPresentation(); this.lifetime.cancel(); this.lastConfirmed = null; this.presentation.clear(); this.text = ''; this.pieces = null; this.waiting = false; this.segmented = false; this.interactionOpacity = 1; if (this.window && !this.window.isDestroyed()) this.window.hide(); }
  /** The latency probe only (electron/reply-latency.ts: developer mode, and the journal's first-character number); replaces any previous observer. */
  setObserver(observer: ReplySurfaceObserver | null): void { this.observer = observer; }
  private notify(kind: keyof ReplySurfaceObserver): void {
    if (!this.observer || this.waiting || !this.text.trim()) return;
    try { this.observer[kind](this.text); } catch { /* Timing must never affect presentation. */ }
  }
  /** Completed host body only; commit executes atomically with the current native proof. */
  waitForCompletedPrefix(fullBody:CompletedPrefixBody,minimumEnd:number,signal:AbortSignal,remainingMs:number,commit:(text:string)=>boolean):Promise<boolean>{
    return this.completedPrefixProof.wait(fullBody,minimumEnd,signal,remainingMs,commit);
  }
  /** Paint evidence can be reused while current; lease authority stays in the host plan. */
  isCompletedPrefixCurrent(text:string):boolean{return !!this.completedPrefixPaint&&this.proofCurrent(this.completedPrefixPaint,text);}
  /** Register before the broadcast; only a new explicit segmented text revision can satisfy this one-shot wait. */
  waitForNextPresentation(expectedText: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || this.nextPresentation || typeof expectedText !== 'string' || !expectedText.trim() || expectedText.length > 32000 || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter: NextPresentationWaiter = { expectedText, afterRevision: this.contentRevision, started: false, resolve, controller: new AbortController(), signal, onAbort: () => this.finishNextPresentation(waiter, false) };
      this.nextPresentation = waiter;
      waiter.timer = setTimeout(() => this.finishNextPresentation(waiter, false), 5000);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }
  private acceptNextContent(segmented: boolean): void {
    const waiter = this.nextPresentation;
    if (!waiter || this.contentRevision <= waiter.afterRevision) return;
    if (waiter.started || !segmented || this.text !== waiter.expectedText) { this.finishNextPresentation(waiter, false); return; }
    waiter.started = true;
    const revision = this.contentRevision;
    const signal = waiter.signal ? AbortSignal.any([waiter.signal, waiter.controller.signal]) : waiter.controller.signal;
    void this.waitForPresentation(waiter.expectedText, signal).then(presented => {
      const current = this.nextPresentation === waiter && !signal.aborted && this.contentRevision === revision && this.isPresentationCurrent(waiter.expectedText);
      this.finishNextPresentation(waiter, presented && current);
    }, () => this.finishNextPresentation(waiter, false));
  }
  private finishNextPresentation(waiter: NextPresentationWaiter, value: boolean): void {
    if (this.nextPresentation !== waiter) return;
    this.nextPresentation = null;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (!value) waiter.controller.abort();
    waiter.resolve(value);
  }
  private cancelNextPresentation(): void {
    if (this.nextPresentation) this.finishNextPresentation(this.nextPresentation, false);
  }
  /** Host-only exact-text receipt. It never waits for an absent anchor or creates/replays content. */
  async waitForPresentation(expectedText: string, signal?: AbortSignal): Promise<boolean> {
    const win = this.window;
    if (this.disposed || this.waiting || this.text !== expectedText || !win || win.isDestroyed() || !this.currentLayout() || this.interactionOpacity <= 0) return false;
    if (this.ready && !this.actuallyVisible()) { this.invalidatePresentation(); return false; }
    const recipient = win.webContents, token = this.presentation.currentToken(recipient);
    if (!token) return false;
    const presented = await this.presentation.waitForPresentation(expectedText, signal);
    const proof: ConfirmedPresentation = { window: win, recipient, token, text: expectedText, signal };
    if (!presented || !this.proofCurrent(proof, expectedText)) return false;
    this.lastConfirmed = proof;
    return true;
  }
  /** Synchronous host commit/TTS guard; never mints a revision or re-renders old text. */
  isPresentationCurrent(expectedText: string): boolean {
    const proof = this.lastConfirmed;
    if (!proof) return false;
    const current = this.proofCurrent(proof, expectedText);
    if (!current && proof.text === expectedText) this.lastConfirmed = null;
    return current;
  }
  private proofCurrent(proof: ConfirmedPresentation, expectedText: string): boolean {
    try {
      return !this.disposed && !proof.signal?.aborted && proof.text === expectedText && this.text === expectedText
        && this.window === proof.window && !proof.window.isDestroyed() && proof.window.webContents === proof.recipient
        && !proof.recipient.isDestroyed() && proof.recipient.getURL() === REPLY_URL && proof.recipient.mainFrame.url === REPLY_URL
        && this.presentation.isCurrent(proof.token, proof.recipient) && this.actuallyVisible();
    } catch { return false; }
  }
  private invalidatePresentation(): void { this.cancelNextPresentation(); this.lastConfirmed = null;this.completedPrefixPaint=null; this.presentation.invalidate();this.completedPrefixProof.changed(); }
  private hasContent(): boolean { return this.waiting || !!this.text.trim(); }
  private currentLayout(): ReplyLayout | null {
    if (this.disposed || this.owner.isDestroyed() || !this.hasContent() || !this.owner.isVisible() || this.owner.isMinimized() || this.owner.getOpacity() <= 0) return null;
    const owner = this.owner.getBounds();
    const mouth = { x: Math.round(owner.x + Math.max(0, Math.min(owner.width, this.anchor.x))), y: Math.round(owner.y + Math.max(0, Math.min(owner.height, this.anchor.y))) };
    const area = screen.getDisplayNearestPoint(mouth).workArea;
    return layoutReply(owner, this.anchor, area, this.side, this.waiting);
  }
  private actuallyVisible(): boolean {
    const win = this.window;
    return !!win && !win.isDestroyed() && this.ready && !this.waiting && this.interactionOpacity > 0
      && win.isVisible() && !win.isMinimized() && win.getOpacity() > 0 && win.getParentWindow() === this.owner && !!this.currentLayout();
  }
  /**
   * #5 / Codex T-207 2C: the reply can be seen, so its lifetime counts: the bubble window is loaded and shown at her face. Its
   * own root cause was a countdown that started at 'complete' while the bubble could not show yet (window loading, no face on
   * screen), leaving it 167 ms once it did. A pat or feed fade does not stop the count (user-confirmed: fades never renew).
   */
  private canBeSeen(): boolean {
    const win = this.window;
    return !!win && !win.isDestroyed() && this.ready && !this.waiting && !!this.text.trim()
      && win.isVisible() && !win.isMinimized() && win.getOpacity() > 0 && win.getParentWindow() === this.owner && !!this.currentLayout();
  }
  private trackSight(): void { if (!this.disposed) this.lifetime.visible(this.canBeSeen()); }
  sync(): void {
    this.place();
    this.trackSight();
  }
  private place(): void {
    // Re-evaluate the other surface before moving/showing this reply. The
    // planned geometry is already current even while its native paint is late.
    this.emojiLayoutListener?.();
    if (!this.window || this.window.isDestroyed() || this.owner.isDestroyed()) return;
    const layout = this.currentLayout();
    if (!layout) { this.invalidatePresentation(); this.window.hide(); return; }
    if (this.interactionOpacity <= 0) this.invalidatePresentation();
    if (!this.ready) { if (this.window.isVisible()) this.window.hide(); return; }
    this.side = layout.side;
    if (this.window.isAlwaysOnTop() !== this.owner.isAlwaysOnTop()) this.window.setAlwaysOnTop(this.owner.isAlwaysOnTop(), PET_TOPMOST_LEVEL);
    const current = this.window.getBounds();
    if (Object.entries(layout.bounds).some(([key, value]) => current[key as keyof typeof current] !== value)) this.window.setBounds(layout.bounds);
    const textChanged = this.text !== this.sentText;
    this.window.webContents.send('desk:reply-render', { ...(textChanged ? { text: this.text } : {}), waiting: this.waiting, segmented: this.segmented,
      pieces: this.waiting ? null : this.pieces, layout, interactionOpacity: this.interactionOpacity,
      presentationToken: this.waiting ? null : this.presentation.currentToken(this.window.webContents) });
    this.sentText = this.text;
    if (textChanged) this.notify('rendered');
    if (!this.window.isVisible()) this.window.showInactive();
    this.completedPrefixProof.changed();
  }
  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) return;
    this.ready = false;
    this.sentText = undefined;
    const win = this.window = new BrowserWindow({
      parent: this.owner, width: 1, height: 1, show: false, transparent: true,
      backgroundColor: '#00000000', frame: false, resizable: false, movable: false,
      focusable: false, hasShadow: false, skipTaskbar: true, title: 'soft hearts · 回复',
      webPreferences: { preload: path.join(__dirname, 'reply-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true },
    });
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    // Windows can automatically restore owned windows alongside their parent.
    win.on('show', () => { if (!this.currentLayout()) { this.invalidatePresentation(); win.hide(); } this.trackSight(); });
    win.on('hide', () => { if (this.window === win) { this.invalidatePresentation(); this.trackSight(); } });
    win.on('minimize', () => { if (this.window === win) { this.invalidatePresentation(); this.trackSight(); } });
    win.on('closed', () => { if (this.window === win) { this.completedPrefixProof.cancel();this.completedPrefixPaint=null;this.cancelNextPresentation(); this.lastConfirmed = null; this.presentation.clear(); this.window = null; this.ready = false; this.trackSight(); } });
    win.webContents.on('did-fail-load', () => { if (this.window === win) { this.invalidatePresentation(); this.ready = false; win.hide(); } });
    win.webContents.on('render-process-gone', () => { if (this.window === win) { this.invalidatePresentation(); this.ready = false; win.hide(); } });
    win.webContents.on('did-start-loading', () => { if (this.window === win && this.ready) { this.invalidatePresentation(); this.ready = false; win.hide(); } });
    win.webContents.on('destroyed', () => { if (this.window === win) { this.invalidatePresentation(); this.ready = false; this.trackSight(); } });
    void win.loadURL(REPLY_URL).then(() => {
      if (this.disposed || this.window !== win || win.isDestroyed()) return;
      this.ready = true; this.sync();
    }).catch(error => { if (!this.disposed && this.window === win) { this.invalidatePresentation(); this.ready = false; console.error('回答气泡无法打开：', error); } });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.clear();
    this.presentation.dispose(); ipcMain.removeListener('desk:reply-presented', this.presented);
    this.owner.removeListener('move', this.move); this.owner.removeListener('resize', this.move);
    this.owner.removeListener('hide', this.hidden); this.owner.removeListener('minimize', this.hidden); this.owner.removeListener('restore', this.restored); this.owner.removeListener('closed', this.closed);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
