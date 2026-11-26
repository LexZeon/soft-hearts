/**
 * I-209 step 3 (同时启动三个全屏额外加功能"做", "不用量，直接做"):
 * the stage coordinator. Every character on stage is her own complete full-screen Unbound: her own host (electron/unbound/host.ts, the same
 * class the first one is), window, page, director, pull, close moments, bubble and life. This owns only what they must share:
 *
 *  - who is out: the panel's choice (company/host.ts, presence.ts) arrives as `sync(ids)`; a new one is made and comes out, one sent back
 *    walks out of the screen first (her page says when she is gone, or after LEAVE_MS her window closes anyway);
 *  - one world (stage-world.ts): one floor line (each window frames her own body against it, 2026-11-25), the bodies kept apart, the nearer window in front;
 *  - who you talk to: the last one you clicked (`address`); the input box opens beside her and her line becomes her turn;
 *  - one voice: her reply's bubble and mouth go to her window; the mouth only to whoever has the floor (shared/unbound/company/floor.ts),
 *    and the line her voice is sounding takes the floor the moment it becomes audible
 *    (`speechFace`): the mouth and her speaking face go to the window of the one whose line it is, never to whoever held the floor before;
 *  - one close moment: nobody starts a peek, kiss or hug while another one's plays (`closeBusy`);
 *  - one look (shared-senses.ts): the readings her life takes from the senses are taken once for everyone.
 * With one character on stage none of this acts: the first host does everything exactly as before (`speechTo` answers null, no view
 * carries anyone else).
 */
import { parseStageBody, type StageView } from '../../../shared/unbound/company/bodies';
import { MOUTH_READING_MAX, frameTimeFrom, type FrameTimeRow } from '../../../shared/stage';
import { sanitizeSpeechFaceCue, turnOf } from '../../../shared/voice';
import { SPEECH_FACE_RELAY } from '../mood-bridge';
import { StageFloor } from '../../../shared/unbound/company/floor';
import { UNBOUND_STAGE_EVENTS, UNBOUND_STAGE_REQUESTS } from '../../../shared/unbound/company/wire';
import { UNBOUND_EVENTS, type UnboundState } from '../../../shared/unbound/scene';
import type { Placement } from '../../../shared/unbound/world';
import type { UnboundHost, UnboundIpcEvent, UnboundWindowLike } from '../host';
import type { UnboundSpeechTarget } from '../host-ports';
import type { FanoutPort } from './ipc-fanout';
import { StageWorld } from './stage-world';
import { clearStartX } from '../../../shared/unbound/company/start-clear';

/** The first one's key on stage (a card id never starts with two underscores). */
export const MAIN_KEY = '__main';
/** A character sent back has this long to walk out before her window closes anyway (ms). */
export const LEAVE_MS = 8_000;
/** How many reply ids keep their owner (a reply older than this goes to the first one's window, as before). */
const ROUTES_KEEP = 64;
/** A page's frame-time row is taken at most this often (ms): a page asks once a minute, a broken or hostile one cannot flood the journal. */
export const FRAME_ROW_GAP_MS = 30_000;
/** A page's mouth row (one per reply she read) is taken at most this often (ms): a broken or hostile page cannot flood the journal. */
export const MOUTH_ROW_GAP_MS = 1_000;

export interface StageInstance { host: UnboundHost; port: FanoutPort }
export interface CompanyStageLinks {
  primary(): UnboundHost;
  primaryPort: FanoutPort;
  /** The card of the one you talk with (the first one on stage); null: none. */
  primaryId(): string | null;
  /** Her own host (her own ports and ipc port); null when she cannot come out now (no model). */
  make(id: string): Promise<StageInstance | null>;
  /** Which character a reply belongs to (the brain's turn owner); null: not known. */
  replyOwner?(replyId: string): string | null;
  /** A card's name (for the box of the one you clicked); null: not known. */
  name?(id: string): string | null;
  /** 2026-11-24: one page's frame times of the last minute, as a checked journal row (`key` is MAIN_KEY for the first one). */
  frames?(key: string, row: FrameTimeRow): void;
  /** 2026-11-25: one page's mouth while she read one reply (MAIN_KEY for the first one): a 'mouth-reading' row under her id (the journal checks the fields). */
  mouth?(key: string, sentences: unknown[]): void;
  clock(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

interface Extra { id: string; host: UnboundHost | null; port: FanoutPort | null; win: UnboundWindowLike | null; leaving: unknown; out: boolean }

export class CompanyStage {
  private readonly extras = new Map<string, Extra>();
  private mainWin: UnboundWindowLike | null = null;
  private wanted: string[] = [];
  private addressed = MAIN_KEY;
  private readonly routes = new Map<string, string>();
  private readonly done = new Set<string>();
  /** Whose mouth the voice moves now (each window hears a change once). */
  private readonly mouths = new Map<string, boolean>();
  /** Whether her voice sounds now (the last speaking fact), so a mouth moved to the line's owner opens at once. */
  private voiceOn = false;
  private readonly frameRowAt = new Map<string, number>();
  private readonly mouthRowAt = new Map<string, number>();
  readonly floor = new StageFloor();
  readonly world: StageWorld;

  constructor(private readonly links: CompanyStageLinks) {
    this.world = new StageWorld({
      ids: () => this.keys(), send: (id, view) => this.sendView(id, view), raise: id => { try { this.winOf(id)?.raise?.(); } catch { /* a closing window */ } },
      placement: id => this.hostOf(id)?.her.placement ?? null, leaving: id => this.extras.get(id)?.leaving != null, clock: links.clock, focus: () => this.addressed,
    });
    this.listen(MAIN_KEY, links.primaryPort);
  }

  // ---- who is on stage ----------------------------------------------------------------------------------------------------------

  /** Everyone on stage now (shown), the first one first. */
  keys(): string[] { return [...(this.mainOut() ? [MAIN_KEY] : []), ...[...this.extras.values()].filter(extra => extra.out).map(extra => extra.id)]; }
  /** How many are on stage. */
  get present(): number { return this.keys().length; }
  /** The host of one on stage (MAIN_KEY: the first one), or null. */
  hostOf(key: string): UnboundHost | null { return key === MAIN_KEY ? this.links.primary() : this.extras.get(key)?.host ?? null; }
  private mainOut(): boolean { return this.links.primary().state === 'unbound'; }
  private winOf(key: string): UnboundWindowLike | null { return key === MAIN_KEY ? this.mainWin : this.extras.get(key)?.win ?? null; }

  /** The panel's choice (who besides the first one): the new ones come out, those no longer chosen walk out. */
  sync(ids: readonly string[]): void {
    this.wanted = this.mainOut() ? ids.filter(id => id !== this.links.primaryId()) : [];
    for (const extra of [...this.extras.values()]) if (!this.wanted.includes(extra.id)) this.sendBack(extra);
    for (const id of this.wanted) if (!this.extras.has(id)) void this.bringOut(id);
  }

  /** The first one's mode changed: leaving full screen takes everyone with her at once. */
  mainChanged(state: UnboundState): void {
    if (state !== 'unbound') { for (const extra of [...this.extras.values()]) this.close(extra); this.floor.clear(); this.mouths.clear(); this.voiceOn = false; this.addressed = MAIN_KEY; this.mainWin = null; }
    this.world.changed();
  }

  /** A window was made for one on stage (the host's openWindow): its requests are hers, and it is where her views go. */
  opened(key: string, win: UnboundWindowLike): void {
    if (key === MAIN_KEY) this.mainWin = win; else { const extra = this.extras.get(key); if (extra) extra.win = win; }
    win.onGone(() => { if (key === MAIN_KEY && this.mainWin === win) this.mainWin = null; else { const extra = this.extras.get(key); if (extra?.win === win) extra.win = null; } });
  }

  private async bringOut(id: string): Promise<void> {
    const extra: Extra = { id, host: null, port: null, win: null, leaving: null, out: false };
    this.extras.set(id, extra);
    let made: StageInstance | null = null;
    try { made = await this.links.make(id); } catch (error) { console.error(error); }
    if (this.extras.get(id) !== extra || !this.wanted.includes(id) || !made) { if (made) this.dispose(made); if (this.extras.get(id) === extra) this.extras.delete(id); return; }
    extra.host = made.host; extra.port = made.port;
    this.listen(id, made.port);
    made.host.enter();
  }

  /** Her own host's mode changed (the instance's modeChanged port). */
  extraChanged(id: string, state: UnboundState): void {
    const extra = this.extras.get(id);
    if (!extra) return;
    if (state === 'unbound') { extra.out = true; this.world.changed(); this.world.restack(); return; }
    if (state === 'normal' && extra.host) { // her window closed, or she could not come out: she is off stage
      const wasOut = extra.out;
      this.close(extra);
      if (wasOut || !this.wanted.includes(id)) this.world.changed();
    }
  }

  /** She is being sent back: her page walks her out; her window closes when she is gone or after LEAVE_MS. */
  private sendBack(extra: Extra): void {
    if (extra.leaving != null) return;
    if (!extra.out) { this.close(extra); return; }
    extra.leaving = this.links.setTimer(() => this.close(extra), LEAVE_MS);
    this.floor.leave(extra.id);
    if (this.addressed === extra.id) this.addressed = MAIN_KEY;
    this.world.changed();
  }

  private close(extra: Extra): void {
    if (this.extras.get(extra.id) !== extra) return;
    this.extras.delete(extra.id);
    if (extra.leaving != null) this.links.clearTimer(extra.leaving);
    this.floor.leave(extra.id); this.mouths.delete(extra.id); this.frameRowAt.delete(extra.id); this.mouthRowAt.delete(extra.id);
    if (this.addressed === extra.id) this.addressed = MAIN_KEY;
    if (extra.host && extra.port) this.dispose({ host: extra.host, port: extra.port });
    this.world.changed();
  }

  private dispose(made: StageInstance): void {
    try { made.host.exit(); } catch (error) { console.error(error); }
    try { made.host.quit(); } catch (error) { console.error(error); }
    for (const channel of Object.values(UNBOUND_STAGE_REQUESTS)) made.port.ipcMain.removeHandler(channel);
  }

  /** Her page's two requests (each window's own port: a request is hers only when her window sent it from its top frame). */
  private listen(key: string, port: FanoutPort): void {
    const mine = (event: UnboundIpcEvent) => { const win = this.winOf(key); return !!win && event?.sender?.id === win.webContents.id && event.senderFrame === event.sender.mainFrame; };
    port.ipcMain.handle(UNBOUND_STAGE_REQUESTS.body, (event, value) => {
      if (!mine(event) || !this.world.report(key, value) || (value as { arrived?: unknown }).arrived !== true) return;
      const body = parseStageBody(value); // her step aside ended: her place now (so nothing walks her back), kept as her last place
      if (body) this.hostOf(key)?.arrived({ xM: body.xM, depthM: body.depthM });
    });
    port.ipcMain.handle(UNBOUND_STAGE_REQUESTS.frames, (event, value) => { if (mine(event)) this.frameRow(key, value); });
    port.ipcMain.handle(UNBOUND_STAGE_REQUESTS.mouth, (event, value) => { if (mine(event)) this.mouthRow(key, value); });
    port.ipcMain.handle(UNBOUND_STAGE_REQUESTS.left, event => { const extra = this.extras.get(key); if (mine(event) && extra && extra.leaving != null) this.close(extra); });
  }

  /** One page's frame times of the last minute: checked into a journal row (closed fields and numbers; how many are on stage is the stage's own count). */
  private frameRow(key: string, value: unknown): void {
    const now = this.links.clock(), last = this.frameRowAt.get(key);
    if ((last !== undefined && now - last < FRAME_ROW_GAP_MS) || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const row = frameTimeFrom({ ...(value as Record<string, unknown>), onStage: Math.max(1, this.present) });
    if (!row) return;
    this.frameRowAt.set(key, now);
    try { this.links.frames?.(key, row); } catch { /* the journal never changes what happens on stage */ }
  }

  /** One page's mouth while she read one reply: her own window's, under her own id (the journal rebuilds the row from checked fields only). */
  private mouthRow(key: string, value: unknown): void {
    const now = this.links.clock(), last = this.mouthRowAt.get(key);
    const sentences = value && typeof value === 'object' && !Array.isArray(value) ? (value as { sentences?: unknown }).sentences : null;
    if ((last !== undefined && now - last < MOUTH_ROW_GAP_MS) || !Array.isArray(sentences) || !sentences.length || sentences.length > MOUTH_READING_MAX) return;
    this.mouthRowAt.set(key, now);
    try { this.links.mouth?.(key, sentences); } catch { /* the journal never changes what happens on stage */ }
  }

  private sendView(key: string, view: StageView): void {
    const win = this.winOf(key);
    try { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(UNBOUND_STAGE_EVENTS.stage, view); } catch { /* a closing window misses one view */ }
  }

  /** A broadcast of hers (her live mood view, StageMoods.onView) to her own window only; the first one's come through her host as before. */
  relay(id: string, channel: string, value: unknown): void { const extra = this.extras.get(id); if (extra?.out) extra.host?.mood(channel, value); }
  /** I-209 step 4: what the senses took once (the wiring picks which: the music frames and settings) to every other window on stage too. */
  relayAll(channel: string, value: unknown): void { for (const extra of this.extras.values()) if (extra.out) extra.host?.mood(channel, value); }

  // ---- who you talk to ----------------------------------------------------------------------------------------------------------

  /** You clicked her (MAIN_KEY: the first one): your words go to her from now on ("点谁和谁说"). */
  address(key: string): void {
    if (!(key === MAIN_KEY || this.extras.get(key)?.out) || key === this.addressed) return;
    this.addressed = key;
    if (this.present > 1) this.world.changed(); // every page hears who you are with (the others draw at their idle rate)
  }
  /** Whose input box, whose said line: the host of the one you clicked last (the first one until you click someone else). */
  addressedHost(): UnboundHost { return (this.addressed !== MAIN_KEY && this.extras.get(this.addressed)?.host) || this.links.primary(); }
  /** With several on stage, the name of the one you talk to (her box says "对 A 说点什么…"); null alone or not known: "对她说", as before. */
  addresseeName(): string | null {
    if (this.present < 2) return null;
    const id = this.addresseeId() ?? this.links.primaryId();
    try { return id ? this.links.name?.(id) ?? null : null; } catch { return null; }
  }
  /** The card your next line goes to when it is not the first one (null: the first one, as before). */
  addresseeId(): string | null { return this.addressed !== MAIN_KEY && this.extras.get(this.addressed)?.out ? this.addressed : null; }

  // ---- one voice ----------------------------------------------------------------------------------------------------------------

  /**
   * Where a reply's bubble goes (`replyId`), or her mouth (null: whoever has the floor). Null while she is alone on stage: the first host
   * then does what it always did. A reply of someone no longer on stage goes to the first one's window.
   */
  speechTo(replyId: string | null): UnboundSpeechTarget | null {
    if (!this.extras.size) return null;
    if (replyId === null) {
      const holder = this.floor.holder;
      return this.target(holder ? this.keyOf(holder.owner) : MAIN_KEY, null);
    }
    return this.target(this.keyOf(this.ownerOf(replyId)), replyId);
  }

  /** Whose line `replyId` is (a card id; '' for the first one's or not known), remembered for the last ROUTES_KEEP lines. */
  private ownerOf(replyId: string): string {
    let owner = this.routes.get(replyId);
    if (owner === undefined) {
      try { owner = this.links.replyOwner?.(replyId) ?? ''; } catch { owner = ''; }
      this.routes.set(replyId, owner);
      while (this.routes.size > ROUTES_KEEP) this.routes.delete(this.routes.keys().next().value!);
    }
    return owner;
  }

  /**
   * 2026-11-25: her voice's
   * facts while others are on stage (relaySpeechFace: a sentence of line X became audible, its loudness, a stop). A sentence becoming audible
   * is the truth of whose voice sounds: line X takes the floor at once (StageFloor.sounding) and, while the voice sounds, the mouth closes in
   * the window that had it and opens in hers. The floor used to move only when the line before had both its "done" and a "voice stopped"
   * after it; a line never voiced, or a "done" that came after the voice stopped, left the floor one line behind, so each one's voice moved
   * the previous speaker's mouth. Each fact goes to the window of the one whose line it is (her speaking face); a stop to every window.
   * False while she is alone: the first host relays it as before.
   */
  speechFace(cue: unknown): boolean {
    if (!this.extras.size) return false;
    const fact = sanitizeSpeechFaceCue(cue);
    if (!fact) return true;
    if (fact.kind === 'stop') { for (const key of this.keys()) this.faceTo(key, fact); return true; }
    const line = turnOf(fact.key), key = this.keyOf(this.ownerOf(line));
    if (fact.kind === 'start' && fact.voiced) this.sounding(line, key);
    this.faceTo(key, fact);
    return true;
  }
  private faceTo(key: string, fact: unknown): void { try { this.hostOf(key)?.mood(SPEECH_FACE_RELAY, fact); } catch { /* a closing window */ } }

  /** Line `replyId` of `key` sounds now: hers is the floor, and the open mouth moves to her window (never two open at once). */
  private sounding(replyId: string, key: string): void {
    const before = this.floor.holder;
    if (before?.replyId === replyId) return;
    if (before) this.done.delete(before.replyId);
    this.floor.sounding(replyId, key);
    for (const [other, open] of this.mouths) if (open && other !== key) this.mouthTo(other, false);
    if (this.voiceOn) this.mouthTo(key, true);
  }

  /** Her mouth in window `key` opens or closes (each window hears a change once). */
  private mouthTo(key: string, on: boolean): void {
    if (this.mouths.get(key) === on) return;
    this.mouths.set(key, on);
    this.toWindow(key, UNBOUND_EVENTS.speaking, on);
  }
  private toWindow(key: string, channel: string, value: unknown): void {
    const win = this.winOf(key);
    try { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value); } catch { /* a closing window */ }
  }

  /**
   * I-209 step 4: a line of hers that is not a reply of the brain's (her chime-in) belongs to her: its bubble goes to her window and it takes
   * the floor like a reply (electron/brain/stage-chat/turns.ts). `release`: its floor ends (read through, or the voice is off).
   */
  own(replyId: string, owner: string): void {
    this.routes.set(replyId, owner);
    while (this.routes.size > ROUTES_KEEP) this.routes.delete(this.routes.keys().next().value!);
  }
  release(replyId: string): void { if (this.floor.holder?.replyId === replyId || this.floor.queue.some(turn => turn.replyId === replyId)) this.pass(replyId); }
  /** Who is on stage, as card ids (the first one's card included); [] while she is alone or not out. */
  ids(): string[] { if (this.present < 2) return []; const main = this.links.primaryId(); return this.keys().map(key => key === MAIN_KEY ? main ?? '' : key).filter(Boolean); }

  /** I-209 stage voice: whose window the bubble of line `replyId` goes to (MAIN_KEY: the first one's; voice-proof.ts). */
  windowOf(replyId: string): string { return this.speechTo(replyId) ? this.keyOf(this.routes.get(replyId) ?? '') : MAIN_KEY; }

  private keyOf(owner: string): string { return owner && owner !== this.links.primaryId() && this.extras.get(owner)?.out ? owner : MAIN_KEY; }

  private target(key: string, replyId: string | null): UnboundSpeechTarget {
    return {
      send: (channel, value) => {
        if (replyId && channel === UNBOUND_EVENTS.bubble) this.floorFor(key, replyId, value);
        if (channel !== UNBOUND_EVENTS.speaking) { this.toWindow(key, channel, value); return; }
        this.voiceOn = value === true;
        this.mouthTo(key, value === true);
        if (value !== true) this.voiceStopped();
      },
      cue: type => { const host = this.hostOf(key); host?.peek?.chat(type); host?.life?.chat(type); },
    };
  }

  /** A reply's first words take the floor (or wait); its end (an error, or read through) passes it on, and her mouth closes. */
  private floorFor(key: string, replyId: string, value: unknown): void {
    const type = (value as { type?: unknown } | null)?.type;
    if (type === 'delta') this.floor.ask(replyId, key);
    else if (type === 'done') this.done.add(replyId);
    else if (type === 'error') this.pass(replyId);
  }
  private voiceStopped(): void { const holder = this.floor.holder; if (holder && this.done.has(holder.replyId)) this.pass(holder.replyId); }
  private pass(replyId: string): void {
    const before = this.floor.holder;
    this.floor.end(replyId);
    this.done.delete(replyId);
    const after = this.floor.holder;
    if (before && before.owner !== after?.owner) this.mouthTo(this.keyOf(before.owner), false);
  }

  // ---- one close moment ---------------------------------------------------------------------------------------------------------

  /** Someone other than `key` plays a peek, a kiss or a hug now: `key` starts none (she can come when it is over). */
  closeBusy(key: string): boolean {
    for (const other of this.keys()) if (other !== key && this.hostOf(other)?.peek?.active) return true;
    return false;
  }

  /** The place an extra comes out at, clear of everyone already standing (her page then places her there). */
  clearOf(key: string, at: Placement, bounds: { minX: number; maxX: number }): Placement {
    const bodies = this.world.bodies();
    bodies.delete(key);
    return clearStartX(bodies.values(), at, bounds); // shared/unbound/company/start-clear.ts
  }
}
