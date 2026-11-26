// keeps going or says so (续, asked whether she should be told
// when the share breaks and whether watching should go on after her window was minimized: "要的，可以让角色知道信息").
//
// Two things, one object, no Electron:
//  1. The share really lost (the capture gave nothing, the chosen window or screen went, or watching ended and nobody could say why; never when the user
//     turned it off, never her window's own steps): she gets the facts in ONE immediate turn (one Claude call) and can tell the user in her own words.
//     At most one turn per loss. If the user already has a message in flight, or the turn could not be said, the facts ride on her next turn instead.
//  2. Her window minimized: watching pauses as it always did (privacy: off the screen the computer's sound stops), and resumes by itself when the window
//     comes back, only if nothing the user turned off meanwhile (the screen, the dialogue), the screen is still allowed, and she is still the same character.
//     Her next turn is told the facts (no call of its own).
// The journal gets a closed-word row for each (shared/senses/journal-entries.ts watch-change). The facts are plain (electron/senses/watch-continuity/facts.ts).
import type { WatchLostWhy, WatchNotResumedWhy, WatchOffWhy } from '../../../shared/senses';
import { awayFacts, factsBlock, lossFacts } from './facts';

/** How her one immediate turn ended: said (she spoke), quiet (it was hers to stay quiet), undelivered (nothing reached the user: the facts wait for her next turn). */
export type WatchFactsOutcome = 'said' | 'quiet' | 'undelivered';

export interface WatchContinuityPorts {
  now(): number;
  characterId(): string | null;
  /** 一起看 is on right now (screen shared and the dialogue on). */
  watching(): boolean;
  /** The screen's switch opening counter (MediaRuntime.openings.screen): off and on again is a new opening. */
  screenOpening(): number;
  /** The screen is on and she may look (not refused). */
  screenAllowed(): boolean;
  /** Turns the dialogue back on through the user's own switch path (resolves true when it is on). Never called unless every condition still holds. */
  resume(): Promise<boolean>;
  /** One journal row (closed words). */
  journal(row: { event: 'share-lost' | 'paused' | 'resumed' | 'not-resumed'; why?: WatchLostWhy | WatchNotResumedWhy; awayS?: number }): void;
  /** The user has a chat message being answered now: the immediate turn is not started on top of it. */
  userTurnInFlight(): boolean;
}

/** Fallback: this many captures in a row that gave nothing, while watching and her window on screen, count as the share lost. */
export const CAPTURE_MISSES_FOR_LOSS = 3;
/** Fallback: a note nobody took by then is old news (a next turn that comes hours later does not start with it). */
export const NOTE_MAX_AGE_MS = 6 * 3_600_000;
const MAX_NOTES = 4;

interface Paused { at: number; opening: number; characterId: string | null; userOff: boolean }
interface Note { text: string; at: number; characterId: string | null }

export class WatchContinuity {
  private paused: Paused | null = null;
  private resuming = false;
  private lossOpen = false;
  private misses = 0;
  private onSince = 0;
  private notes: Note[] = [];
  private speaker: ((facts: string, characterId: string | null) => Promise<WatchFactsOutcome>) | null = null;

  constructor(private readonly ports: WatchContinuityPorts) {}

  /** The immediate turn's runner (electron/senses/watch-continuity/facts-turn.ts), attached once it exists. */
  attachSpeaker(speak: (facts: string, characterId: string | null) => Promise<WatchFactsOutcome>): void { this.speaker = speak; }

  // ---- watching on and off (the detector, electron/senses/watch-off-notice.ts)

  /** 一起看 came on (also when it resumed): a new stretch, a new loss can happen. */
  began(): void { this.onSince = this.ports.now(); this.lossOpen = false; this.misses = 0; }

  /** 一起看 went from on to off, with the cause the places that end it noted. Her window's own steps and the user's off are not losses. */
  ended(why: WatchOffWhy, lastedMs: number): void {
    if (this.paused || why !== 'other') return;
    this.lose('unexplained', lastedMs);
  }

  // ---- the share itself

  /** A frame of the shared screen was taken. */
  captureOk(): void { this.misses = 0; this.lossOpen = false; }
  /** A frame could not be taken although the screen is shared and she may look. */
  captureMissed(): void {
    if (!this.ports.watching() || this.paused) return;
    if (++this.misses >= CAPTURE_MISSES_FOR_LOSS) this.lose('capture-lost', this.ports.now() - this.onSince);
  }
  /** The window or screen the user chose to share went away (the read fell back to the companion's screen). */
  sourceGone(): void {
    if (!this.ports.watching() || this.paused) return;
    this.lose('source-gone', this.ports.now() - this.onSince);
  }

  private lose(cause: WatchLostWhy, lastedMs: number): void {
    if (this.lossOpen) return; // one loss, one turn
    this.lossOpen = true;
    const at = this.ports.now(), characterId = this.ports.characterId();
    try { this.ports.journal({ event: 'share-lost', why: cause }); } catch { /* the journal never changes what she does */ }
    const facts = lossFacts({ cause, at, lastedMs });
    if (this.ports.userTurnInFlight() || !this.speaker) { this.keep(facts, characterId); return; }
    void this.speaker(facts, characterId).then(outcome => { if (outcome === 'undelivered') this.keep(facts, characterId); }, () => this.keep(facts, characterId));
  }

  // ---- her window away and back

  /** Her window was minimized (called before the computer's sound is stopped). */
  minimized(): void {
    if (this.paused || !this.ports.watching()) return;
    this.paused = { at: this.ports.now(), opening: this.ports.screenOpening(), characterId: this.ports.characterId(), userOff: false };
    try { this.ports.journal({ event: 'paused' }); } catch { /* the same */ }
  }

  /** The user turned the screen or the dialogue off (their own switch): what was paused is not started again. */
  userOff(): void { if (this.paused) this.paused.userOff = true; }

  /** Her window is back on the screen. */
  async restored(): Promise<void> {
    const pause = this.paused;
    if (!pause || this.resuming) return;
    this.resuming = true;
    try {
      const awayMs = Math.max(0, this.ports.now() - pause.at), awayS = Math.round(awayMs / 1000);
      const stays: WatchNotResumedWhy | null = pause.userOff ? 'turned-off'
        : pause.characterId !== this.ports.characterId() ? 'changed'
        : !this.ports.screenAllowed() || this.ports.screenOpening() !== pause.opening ? 'screen-gone' : null;
      let notResumed: WatchNotResumedWhy | null = stays;
      if (!notResumed) {
        let ok = false;
        try { ok = await this.ports.resume(); } catch { ok = false; }
        if (!ok) notResumed = this.paused?.userOff ? 'turned-off' : 'not-allowed';
        else if (this.paused?.userOff) notResumed = 'turned-off';
      }
      this.paused = null;
      if (notResumed) {
        try { this.ports.journal({ event: 'not-resumed', why: notResumed, awayS }); } catch { /* the same */ }
        if (notResumed !== 'changed') this.keep(awayFacts({ awayMs, resumed: false, notResumed }), pause.characterId);
      } else {
        try { this.ports.journal({ event: 'resumed', awayS }); } catch { /* the same */ }
        this.keep(awayFacts({ awayMs, resumed: true }), pause.characterId);
      }
    } finally { this.resuming = false; }
  }

  /** Whether a pause is waiting for her window to come back (tests, the developer view). */
  get waiting(): boolean { return this.paused !== null; }

  // ---- what her next turn is told

  private keep(text: string, characterId: string | null): void {
    this.notes.push({ text, at: this.ports.now(), characterId });
    while (this.notes.length > MAX_NOTES) this.notes.shift();
  }

  /** The block of facts for the next chat turn, once ('' when there is none). Notes of another character, or too old, are dropped. */
  takeNotes(): string {
    const now = this.ports.now(), me = this.ports.characterId();
    const mine = this.notes.filter(note => now - note.at <= NOTE_MAX_AGE_MS && note.characterId === me);
    this.notes = [];
    return factsBlock(mine.map(note => note.text));
  }

  /** A character change or "forget": the facts of the old conversation go. */
  clear(): void { this.notes = []; this.paused = null; this.lossOpen = false; this.misses = 0; }
}
