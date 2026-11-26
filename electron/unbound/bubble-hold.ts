/**
 * I-165: full-screen Unbound's bubble follows her voice too.
 *
 * The host streams her reply into the Unbound page's bubble (electron/unbound/host.ts stream). While a reply is read aloud with its
 * bubble following the voice (the reading plan says so: CompletedReplySpeech.follows, frozen at acceptance from the knob both windows
 * read), its text is held here and sent on only as far as the voice has reached: "……" first, then each sentence when its audio starts
 * ('char' mode: through the sentence's estimated audio time). The read-aloud display proof (electron/unbound/read-aloud.ts) is unchanged:
 * every piece sent gets its revision and the page reports exactly what it painted.
 *
 * Shown at once, as before, whenever the voice will not follow: the reply is not followed, the reading ended or was cancelled (`release`),
 * or the voice stalled (shared/voice/bubble-follow/follow.ts). An 'error' passes straight through (the page hides the bubble); a 'done'
 * waits until everything was sent, so the bubble never starts fading before its last sentence was shown. A newer reply replaces an older
 * one; facts about another reply change nothing.
 */
import { BubbleFollow, type BubbleFollowRelease, type BubbleHeardPhase } from '../../shared/voice';
import type { PauseTalkCut } from '../../shared/brain';
import { parsePoseUseFact, POSE_USES_KNOBS } from '../../shared/senses';

/** A window's 'pose-use' fact (noteJournalFact) as far as the bubble cares: her reading paused, went on, or ended quietly because of where you are. */
export function readPauseOf(value: unknown): 'paused' | 'resumed' | 'ended' | null {
  const fact = parsePoseUseFact(value);
  return fact?.use === 'read-pause' && (fact.event === 'paused' || fact.event === 'resumed' || fact.event === 'ended') ? fact.event : null;
}

/** The window's pose-use fact reaches her bubble: paused (and went on, or ended quietly) pause and resume its clocks. Anything else changes nothing. */
export function applyReadPause(hold: { pauseForAway(): void; resumeFromAway(): void } | null | undefined, value: unknown): void {
  const event = readPauseOf(value);
  if (event === 'paused') hold?.pauseForAway(); else if (event) hold?.resumeFromAway();
}

/** One bubble event, as electron/unbound/host.ts sends it to the page ('hold' is the "……" of a held reply). */
export interface HeldBubbleEvent { id: string; type: 'hold' | 'delta' | 'done' | 'error'; text: string }
/** What the hold reads of the reading plan (electron/wiring/voice-wiring.ts connects it). */
export interface BubbleHoldPlan {
  /** Reply `id` is read aloud now with its bubble following the voice (read aloud on, the plan frozen as following). */
  follows(id: string): boolean;
  /** Where sentence `index` of reply `id` ends in its shown text, or null while unknown. */
  segmentEnd(id: string, index: number): number | null;
}
export interface BubbleHoldPorts {
  emit(event: HeldBubbleEvent): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Held { id: string; text: string; sent: number; done: boolean; doneSent: boolean; known: number }

export class UnboundBubbleHold {
  private readonly follow = new BubbleFollow();
  private plan: BubbleHoldPlan | null = null;
  private held: Held | null = null;
  private timer: unknown = null;
  /** I-177: the reply whose text is arriving now (held or not), and the one the user's send stopped (its stop event keeps the bubble). */
  private live: string | null = null;
  private stopped: { id: string; ended: boolean } | null = null;
  /** The reply whose clocks are paused (her reading was paused for you), and the safety that lets go of a pause nobody ended. */
  private pausedBy: string | null = null;
  private guard: unknown = null;
  constructor(private readonly ports: BubbleHoldPorts, private readonly maxPauseMs: number = POSE_USES_KNOBS.readPause.endAfterSeconds * 1000 + 5_000) {}

  /** The reading plan to ask (voice-wiring, once it has made it). */
  connect(plan: BubbleHoldPlan | null): void { this.plan = plan; }
  /** The reply being held now (tests and the developer view), or null. */
  get holding(): string | null { return this.held && this.follow.holding(this.held.id) ? this.held.id : null; }

  /**
   * One of her reply's stream events on its way to the bubble. True: the hold took it (sends what may show now and the rest later);
   * false: send it as before.
   */
  take(event: { id: string; type: string; text: string }): boolean {
    if (this.muted !== null) { if (event.id === this.muted) return true; if (event.type === 'delta') this.muted = null; } // I-203: a cut reply sends nothing more here
    if (event.type === 'delta') { this.live = event.id; if (this.stopped && this.stopped.id !== event.id) this.stopped = null; }
    else if (event.type === 'done' && this.live === event.id) this.live = null;
    if (event.type === 'error') {
      const was = this.stopped?.id === event.id ? this.stopped : null;
      if (this.live === event.id) this.live = null;
      if (this.held?.id === event.id) this.drop();
      if (!was) return false;
      this.stopped = null;
      // The stop of a reply the user's send cut off: what was shown stays (a bubble that was ended already is not ended twice).
      if (!was.ended) this.ports.emit({ id: event.id, type: 'done', text: '' });
      return true;
    }
    if (event.type !== 'delta' && event.type !== 'done') return false;
    let held = this.held?.id === event.id ? this.held : null;
    if (!held) {
      if (event.type !== 'delta' || !this.follows(event.id) || !this.follow.begin(event.id, this.now())) return false;
      this.drop();
      held = this.held = { id: event.id, text: '', sent: 0, done: false, doneSent: false, known: 0 };
      this.ports.emit({ id: held.id, type: 'hold', text: '' });
    }
    if (event.type === 'delta') held.text += typeof event.text === 'string' ? event.text : '';
    else held.done = true;
    this.learn(held);
    this.pump();
    return true;
  }

  /** The reading window's fact: sentence `index` of reply `id` started, ended, or had nothing to say. */
  heard(id: string, index: number, phase: BubbleHeardPhase): void {
    const held = this.held;
    if (!held || held.id !== id) return;
    this.learn(held);
    this.follow.heard(id, index, phase, this.now());
    this.pump();
  }

  /** Reply `id` stops following (its reading ended, was cancelled or failed; `undefined`: whatever is held). Everything left goes now. */
  release(id: string | undefined, reason: BubbleFollowRelease): void {
    const held = this.held;
    if (!held || (id !== undefined && held.id !== id)) return;
    this.follow.release(held.id, reason);
    this.pump();
  }

  /**
   * I-177 (记录打断，回给角色): the user sent a line while her reply was still being let out. The bubble keeps exactly what
   * was shown (the held rest is never sent) and its end is sent now. Returns how far it got when part of the reply was never shown (an id and
   * a number, nothing of the text: the host hands her next turn a note, as for the companion's reply); null when all of it was shown or
   * nothing was held back. The reply's own stop event that follows is taken here (it does not clear the bubble).
   */
  interrupt(): PauseTalkCut | null {
    const held = this.held, id = held?.id ?? this.live;
    if (!id) return null;
    const cut = held && held.sent < held.text.length ? { id: held.id, shown: held.sent } : null;
    this.stopped = { id, ended: !!held };
    this.live = null;
    if (!held) return cut;
    this.drop();
    this.ports.emit({ id, type: held.sent > 0 ? 'done' : 'error', text: '' });
    return cut;
  }

  /**
   * 2026-11-24: her reading paused because you looked away (src/voice/away-read-pause.ts). The companion's bubble
   * paused with it, but this one kept its stall clocks running: 4 s after the paused sentence it let go of the whole reply, the bubble finished
   * and faded, and when you came back her voice read on under an empty screen. The window's own pause fact now stops these clocks too: nothing
   * is sent while paused, and her sentences show again from where they were.
   */
  pauseForAway(): void {
    const held = this.held;
    if (!held || this.pausedBy !== null) return;
    this.follow.pause(this.now());
    this.pausedBy = held.id;
    this.clearTimer();
    // A pause nobody ends (the window closed) must not hold her bubble for good: the window itself ends an away pause after endAfterSeconds.
    this.guard = (this.ports.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => { this.guard = null; this.resumeFromAway(); }, this.maxPauseMs);
  }
  /** The pause ended (you are back, or her reading ended quietly): the clocks go on from where they stopped. */
  resumeFromAway(): void {
    const held = this.held;
    this.clearGuard();
    const id = this.pausedBy;
    if (id === null) return;
    this.pausedBy = null;
    if (!held || held.id !== id) return;
    if (!this.lips) this.follow.resume(this.now()); // a kiss's lips (pause() below) may still be holding the same clocks
    this.pump();
  }
  private clearGuard(): void {
    if (this.guard === null) return;
    (this.ports.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.guard);
    this.guard = null;
  }

  /** Her bubble went away (she came home, the window closed): nothing more is sent for the old reply. */
  reset(): void { this.drop(); this.live = null; this.stopped = null; this.muted = null; this.openLips(); }

  /**
   * I-203: her lips are on in a kiss from her reply (electron/unbound/close-sequence.ts contact): her voice starts no new sentence until she pulls
   * back (`quiet`: the read-aloud's next piece waits for it, electron/wiring/voice-wiring.ts), and the follow's stall clocks stand still meanwhile.
   * The sequence's own cap always ends a contact; a reset (she came home) ends it too.
   */
  pause(): void {
    this.follow.pause(this.now());
    if (!this.lips) { let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; }); this.lips = { done, resolve }; }
  }
  resume(): void { if (this.pausedBy === null) this.follow.resume(this.now()); this.pump(); this.openLips(); } // her away-pause (pauseForAway) may still be holding the same clocks
  /** While her lips are on: resolves as she pulls back. Null: her voice may go on. Never rejects. */
  quiet(): Promise<void> | null { return this.lips?.done ?? null; }
  private lips: { done: Promise<void>; resolve(): void } | null = null;
  private openLips(): void { const lips = this.lips; this.lips = null; lips?.resolve(); }

  /**
   * I-203: her kiss or hug from the reply on its way here was interrupted. The bubble keeps exactly what it
   * shows and ends now; nothing more of that reply is sent here (the rest still reaches the chat window and the archive, once). Returns how
   * many characters of it were shown when it was held following her voice (null: it was shown as it came, or no reply is on its way).
   */
  cut(): number | null {
    const held = this.held, id = held?.id ?? this.live;
    if (!id) return null;
    this.muted = id;
    this.live = null;
    if (this.stopped?.id === id) this.stopped = null;
    const shown = held ? held.sent : null;
    if (held) this.drop();
    if (!held || !held.doneSent) this.ports.emit({ id, type: shown === 0 ? 'error' : 'done', text: '' });
    return shown;
  }
  /** I-203: the reply whose bubble was cut: its later events are taken here and not sent. */
  private muted: string | null = null;

  private follows(id: string): boolean { try { return this.plan?.follows(id) === true; } catch { return false; } }
  private learn(held: Held): void {
    for (;;) {
      let end: number | null = null;
      try { end = this.plan?.segmentEnd(held.id, held.known) ?? null; } catch { end = null; }
      if (end === null) return;
      this.follow.segment(held.id, held.known, end, this.now());
      held.known++;
    }
  }
  private pump(): void {
    const held = this.held;
    if (!held) return;
    this.clearTimer();
    const now = this.now(), cap = this.follow.cap(held.id, now);
    let target = cap === null ? held.text.length : Math.min(cap, held.text.length);
    // Never between the two halves of a character outside the basic plane.
    if (target > 0 && target < held.text.length && /[\uD800-\uDBFF]/.test(held.text[target - 1])) target--;
    if (target > held.sent) { const text = held.text.slice(held.sent, target); held.sent = target; this.ports.emit({ id: held.id, type: 'delta', text }); }
    if (held.done && !held.doneSent && held.sent >= held.text.length) { held.doneSent = true; this.ports.emit({ id: held.id, type: 'done', text: '' }); }
    if (held.doneSent) { this.held = null; this.pausedBy = null; this.clearGuard(); return; }
    const next = this.follow.nextChange(now);
    if (next !== null) this.timer = (this.ports.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => { this.timer = null; this.pump(); }, Math.max(0, next - now));
  }
  private drop(): void { const held = this.held; this.held = null; this.pausedBy = null; this.clearGuard(); this.clearTimer(); if (held) this.follow.release(held.id, 'superseded'); }
  private clearTimer(): void {
    if (this.timer === null) return;
    (this.ports.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
}
