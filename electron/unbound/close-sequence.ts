/**
 * The order of her action and her words, frame by frame (I-203 frames).
 * Before (2026-11-23): every word after a ⟦kiss⟧ / ⟦hug⟧ waited for the whole action (22:51: Gene stopped mid-sentence for the hug at character 95).
 * Now she places the frames, and only these hold her words (her reply's stream itself waits: electron/brain/speech-beats/turn.ts holds what
 * follows before anything sees it: the bubble, the read-aloud, the control window, the archive):
 *
 *   ⟦hug⟧ / ⟦kiss⟧   she starts coming over; the sentence she is in goes on while she walks; 2026-11-25: the sentences after it wait for the contact ('contact': her lips on / her arms round), or until it will
 *                    not happen (lighter, it ended, cut), at most `contactMs` after the page's ask (shared/behaviors/speech-beats/contact-hold.ts)
 *   ⟦hug-held⟧       the words after it wait until she is holding (the peek host's `held`), or until it will not happen (lighter, it ended)
 *   ⟦pause⟧          the words after it stop for a moment: the page reports reaching it once the words before it are said (`reached`),
 *                    then `seconds` (⟦pause long⟧ longer); any reply, not only a hug
 *   kiss contact     while her lips are on (a kiss from her reply holding) her words stop by themselves: `quiet()` is the wait the stream and
 *                    the read-aloud's next sentence obey; it ends as she pulls back (`finished`)
 *   ⟦let-go⟧         the page relays it to her body (the peek host's frame command); nothing waits here
 *
 * Interrupted: a large pull, or her face could not reach, during a kiss
 * or hug from her reply: `interrupted` ends every wait ('cut'), the contact, and tells the reply's turn (attached) so its remaining frames and
 * words stop being presented; the port `cut` lets the wiring stop the bubble and the reading first. The reply is still archived once, whole.
 *
 * Caps, so nothing stuck can freeze her reply: the page must reach a frame within `reachMs`, an action must come within `actionMs` of the
 * page's ask, and a contact lasts at most `actionMs`. A cap that lets her words go leaves one journal row ('waited'). Memory only.
 */
import { PEEK_TIMING } from '../../shared/unbound/director';
import type { ChatCloseAnswer, CloseCutCause, CloseCutFrame } from '../../shared/unbound/close-moments';

/** Why the words after the frame may go on. 'cut': the moment was interrupted (the turn stops presenting them). */
export type CloseBeatRelease = 'done' | 'lighter' | 'cap' | 'stopped' | 'cut';
/** The frames whose words wait. */
export type CloseWaitWord = 'hug-held' | 'pause' | 'contact';
/** 2026-11-25: which kiss / hug of this reply a 'contact' wait is for (its order among the reply's kiss / hug beats, from 1) and which it is. */
export interface CloseWaitBeat { nth: number; kind: 'kiss' | 'hug' }
/** What an interrupted moment was. */
export interface CloseCutEvent { kind: 'kiss' | 'hug'; frame: CloseCutFrame; cause: CloseCutCause }
/** What the reply's turn hears when its moment is interrupted; `shown`: how much of the reply was presented (null: everything given out so far). */
export interface CloseCutListener { cut(event: CloseCutEvent, shown: number | null): void }
/** The reply's side (the speech-beats turn): one wait per frame; `cancel` when the reply is stopped (nothing is let out after that). */
export interface CloseBeatGate {
  wait(word: CloseWaitWord, beat?: CloseWaitBeat): { done: Promise<CloseBeatRelease>; cancel(): void };
  /** While her lips are on in a kiss from her reply: resolves as she pulls back (null: her words may go). */
  quiet?(): Promise<void> | null;
  /** The latest reply listens for an interruption of its moment (while it is written and after it completed, until the next reply); returns the way to stop listening. */
  attach?(listener: CloseCutListener): () => void;
}
/** The peek host's side. */
export interface CloseBeatSequenceLink {
  asked(kind: 'kiss' | 'hug', answer: ChatCloseAnswer): void;
  /** The kiss / hug from her reply is holding (its face arrived). */
  held?(kind: 'kiss' | 'hug'): void;
  finished(): void;
  /** A large pull or a face that could not reach cut it short. */
  interrupted?(event: CloseCutEvent): void;
  /** The page's words reached a pause and the words before it are said: `seconds` of quiet from now. */
  reached?(word: 'pause', seconds: number): void;
  stop?(): void;
}
export interface CloseSequencePorts {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** A cap let her words go (the last resort): one journal row, so a wait that only a cap ended is visible next time (2026-11-23, 19:40 and 19:42). */
  capped?(kind: 'kiss' | 'hug' | null, phase: 'reach' | 'action'): void;
  /** Her lips on (true) / off (false) in a kiss from her reply: the bubble that follows her voice pauses its own clocks meanwhile. */
  contact?(on: boolean): void;
  /** Interrupted: the wiring stops her bubble and her reading of this reply now; returns how much of it was presented (null: not known). */
  cut?(event: CloseCutEvent): number | null;
}

export const CLOSE_SEQUENCE_CAPS = Object.freeze({
  /** The words before the frame are being shown (and read aloud, when the bubble follows the voice): this long at most until the page reaches it. */
  reachMs: 40_000,
  /** From the page's ask: the peek host's own timeout plus a margin (also the longest contact). */
  actionMs: PEEK_TIMING.maxPeekMs + 2_000,
  /**
   * 2026-11-25: from the page's ask, at most this long until her lips are on / her arms round, for the words after a kiss / hug's sentence
   * (a walk-up takes a few seconds; the page's own walk timeout and a failed reach end it earlier and let the words go at once).
   */
  contactMs: 20_000,
});

interface Waiting { word: CloseWaitWord; phase: 'reach' | 'action' | 'pause'; resolve(why: CloseBeatRelease): void; timer: unknown; beat?: CloseWaitBeat }

export class CloseBeatSequence implements CloseBeatGate, CloseBeatSequenceLink {
  private waiting: Waiting | null = null;
  /** The kiss / hug from her reply now: walking over (asked 'play'), or holding. */
  private close: { kind: 'kiss' | 'hug'; frame: CloseCutFrame } | null = null;
  private contact: { done: Promise<void>; resolve(): void; timer: unknown } | null = null;
  private listener: CloseCutListener | null = null;
  /** 2026-11-25: this reply's kiss / hug asks so far, and how the latest one went when none is on now (a 'contact' wait that starts after it knows). */
  private asks = 0;
  private settled: 'lighter' | 'over' | null = null;
  constructor(private readonly ports: CloseSequencePorts, private readonly caps: { reachMs: number; actionMs: number; contactMs?: number } = CLOSE_SEQUENCE_CAPS) {}

  /** A frame waiting now (tests, the developer view). */
  get holding(): { word: CloseWaitWord; phase: 'reach' | 'action' | 'pause' } | null { return this.waiting ? { word: this.waiting.word, phase: this.waiting.phase } : null; }
  /** Her lips are on in a kiss from her reply (her words stop meanwhile). */
  get inContact(): boolean { return !!this.contact; }

  wait(word: CloseWaitWord, beat?: CloseWaitBeat): { done: Promise<CloseBeatRelease>; cancel(): void } {
    this.release('stopped'); // a newer frame or reply: the older wait is over (its turn was stopped or moved on anyway)
    let resolve!: (why: CloseBeatRelease) => void;
    const done = new Promise<CloseBeatRelease>(r => { resolve = r; });
    if (word === 'hug-held' && this.close?.frame === 'holding') { resolve('done'); return { done, cancel() {} }; } // already holding: nothing to wait for
    // 2026-11-25: the words after a kiss / hug's sentence: the ask it is about has come (or a later one): landed, or will not, or still walking.
    const asked = word === 'contact' && (!beat || beat.nth <= this.asks);
    if (asked && (this.close?.frame === 'holding' || (!this.close && this.settled))) {
      resolve(!this.close && this.settled === 'lighter' && (!beat || beat.nth === this.asks) ? 'lighter' : 'done'); return { done, cancel() {} };
    }
    const entry: Waiting = { word, phase: (word === 'hug-held' || asked) && this.close ? 'action' : 'reach', resolve, timer: null, ...(beat ? { beat: { ...beat } } : {}) };
    entry.timer = this.timer(entry, entry.phase === 'action' ? this.actionCap(entry) : this.caps.reachMs);
    this.waiting = entry;
    return { done, cancel: () => { if (this.waiting === entry) this.release('stopped'); } };
  }

  quiet(): Promise<void> | null { return this.contact?.done ?? null; }

  attach(listener: CloseCutListener): () => void {
    this.listener = listener;
    this.close = null; // a new reply: the old one's moment is not this one's
    this.asks = 0; this.settled = null;
    return () => { if (this.listener === listener) this.listener = null; };
  }

  asked(kind: 'kiss' | 'hug', answer: ChatCloseAnswer): void {
    this.asks++;
    // 2026-11-25: a second ask that does not walk up (one is already on: 'busy') leaves the one on as it is.
    if (answer === 'play') { this.close = { kind, frame: 'walking' }; this.settled = null; }
    else if (!this.close) this.settled = 'lighter';
    const w = this.waiting;
    if (!w || w.word === 'pause' || w.phase !== 'reach') return; // a pause waits for the page, not for the action
    if (w.word === 'contact' && w.beat && w.beat.nth > this.asks) return; // not the kiss / hug this wait is about yet
    if (!this.close) { this.release(w.word === 'contact' && w.beat && w.beat.nth < this.asks ? 'done' : 'lighter'); return; }
    this.clear(w);
    w.phase = 'action';
    w.timer = this.timer(w, this.actionCap(w));
  }

  held(kind: 'kiss' | 'hug'): void {
    this.close = { kind, frame: 'holding' };
    if (this.waiting?.word === 'hug-held' || (this.waiting?.word === 'contact' && this.waiting.phase === 'action')) this.release('done'); // 2026-11-25: landed
    if (kind === 'kiss' && !this.contact) { // her mouth is busy: her words stop until she pulls back
      let resolve!: () => void;
      const done = new Promise<void>(r => { resolve = r; });
      const contact = { done, resolve, timer: null as unknown };
      try { contact.timer = this.ports.setTimer(() => { if (this.contact === contact) this.endContact(); }, this.caps.actionMs); } catch { contact.timer = null; }
      this.contact = contact;
      try { this.ports.contact?.(true); } catch { /* the bubble's clocks only */ }
    }
  }

  finished(): void {
    this.close = null; this.settled = 'over';
    this.endContact();
    const w = this.waiting;
    if ((w?.word === 'hug-held' || w?.word === 'contact') && w.phase === 'action') this.release('done'); // it ended without holding (a timeout): nothing to wait for
  }

  interrupted(event: CloseCutEvent): void {
    const mine = this.close !== null; // the moment of the reply attached now (asked after it began); an older reply's is not this one's to cut
    this.close = null; this.settled = 'over';
    this.endContact();
    if (!mine) return;
    let shown: number | null = null;
    try { shown = this.ports.cut?.(event) ?? null; } catch { shown = null; }
    const listener = this.listener;
    try { listener?.cut(event, shown); } catch { /* the reply goes on being archived */ }
    this.release('cut');
  }

  reached(word: 'pause', seconds: number): void {
    const w = this.waiting;
    if (word !== 'pause' || !w || w.word !== 'pause' || w.phase !== 'reach') return;
    this.clear(w);
    w.phase = 'pause';
    try { w.timer = this.ports.setTimer(() => { if (this.waiting === w) this.release('done'); }, Math.max(0, Math.min(12, Number.isFinite(seconds) ? seconds : 0)) * 1000); }
    catch { this.release('done'); }
  }

  stop(): void { this.close = null; this.settled = 'over'; this.endContact(); this.release('stopped'); }

  /** The cap of a wait whose action is on: a hug-held's as before; 2026-11-25: the words after a kiss / hug's sentence wait at most `contactMs`. */
  private actionCap(entry: Waiting): number { return entry.word === 'contact' ? this.caps.contactMs ?? CLOSE_SEQUENCE_CAPS.contactMs : this.caps.actionMs; }

  private endContact(): void {
    const contact = this.contact;
    if (!contact) return;
    this.contact = null;
    if (contact.timer !== null) { try { this.ports.clearTimer(contact.timer); } catch { /* gone */ } }
    try { this.ports.contact?.(false); } catch { /* the bubble's clocks only */ }
    contact.resolve();
  }
  private timer(entry: Waiting, ms: number): unknown {
    try {
      return this.ports.setTimer(() => {
        if (this.waiting !== entry) return;
        const kind = this.close?.kind ?? entry.beat?.kind ?? (entry.word === 'hug-held' ? 'hug' : null); // a pause with no kiss / hug: no kind (the wiring writes no row)
        try { this.ports.capped?.(kind, entry.phase === 'action' ? 'action' : 'reach'); } catch { /* a note never holds her words */ }
        this.release('cap');
      }, ms);
    } catch { return null; }
  }
  private clear(entry: Waiting): void { if (entry.timer !== null) { try { this.ports.clearTimer(entry.timer); } catch { /* gone */ } entry.timer = null; } }
  private release(why: CloseBeatRelease): void {
    const w = this.waiting;
    if (!w) return;
    this.waiting = null;
    this.clear(w);
    w.resolve(why);
  }
}
