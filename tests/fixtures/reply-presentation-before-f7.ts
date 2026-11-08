// FROZEN REFERENCE, do not edit: src/ui/reply-presentation.ts exactly as it was before F7 停停说说 (commit bccbb60). Only
// tests/f7-pause-talk.test.ts uses it, to prove that with no pause plan (the switch off) the paced reveal paints the same text at
// the same moments as before, call for call.
import { IncrementalReplySegments, IncrementalReplyOverflow } from '../../shared/incremental-reply-segments';
import {
  AFTERTHOUGHT_EXTRA_MS, ELLIPSIS_PAUSE_MS, REPLY_RHYTHM_BUDGET_MS, REPLY_RHYTHM_FALLBACK_ENABLED, SHY_ELLIPSIS_PAUSE_MS,
  bubbleHoldMs, ellipsisStop, graphemeBoundaryAtOrBefore, isAfterthought, validReplyRhythmPacing, visibleLength,
} from '../../shared/reply-rhythm';

const MAX_CLOSED_IDS = 24;
type Readout = { id: string; raw: string; visible: number; since: number; done: boolean; fallback: boolean;
  parser: IncrementalReplySegments; boundaries: number[];
  timer: ReturnType<typeof setTimeout> | null; paint: ReadoutPaint; drained?: () => void;
  /** B06 feed pause: when it began, and whether a sentence was being held (its hold continues on resume). */
  pausedAt?: number; holding?: boolean;
  /**
   * F7 说话节奏 (shared/reply-rhythm.ts): this reply's frozen multiplier and shyness; how much of the 4 s budget its waits have
   * spent; the wait now running (so a feed pause charges only the part that passed); what the current hold is for; where the
   * current piece of a bubble began after a "……" stop; whether the one afterthought pause was used.
   */
  multiplier: number; shy: boolean; rhythmSet: boolean; waited: number; timerDelay: number; timerSetAt: number;
  stop: 'bubble' | 'ellipsis' | 'afterthought'; pieceFrom: number | null; afterthoughtUsed: boolean };
/** `sentenceEnds`: stable sentence boundaries inside `prefix` (display layout only). */
export type ReadoutPaint = (prefix: string, raw: string, sentenceEnds: readonly number[]) => void;
export interface ReadoutClock { now(): number; set(callback: () => void, delay: number): ReturnType<typeof setTimeout>; clear(timer: ReturnType<typeof setTimeout>): void }

/** Transient display state for host-accepted chat IDs; never a request or body store. */
export class ReplyPresentationState {
  /**
   * `onWaiting` (X1, src/ui/reply-thinking.ts): told synchronously whenever the
   * reply that is waiting for its first word changes (its id, or null once body
   * text arrives, it closes, clears or is suppressed). Presentation only: its
   * result is ignored and a throw cannot disturb this state.
   */
  constructor(private readonly clock: ReadoutClock = { now: () => performance.now(), set: (fn, delay) => setTimeout(fn, delay), clear: timer => clearTimeout(timer) },
    private readonly onWaiting?: (id: string | null) => void,
    /**
     * F7 兜底，待定 (shared/reply-rhythm.ts): the mood multiplier, visible-character hold, 4 s budget, "……" stop and afterthought
     * pause. Off by default (REPLY_RHYTHM_FALLBACK_ENABLED): the bubbles keep exactly R27's pacing. Tests turn it on to exercise it.
     */
    options: { rhythmFallback?: boolean } = {}) { this.fallback = options.rhythmFallback ?? REPLY_RHYTHM_FALLBACK_ENABLED; }
  private readonly fallback: boolean;
  private waitingNotified: string | null = null;
  private currentId: string | null = null;
  private bodySeen = false;
  private suppressed = false;
  private readonly closedIds = new Set<string>();
  private readout: Readout | null = null;
  /** B06: the paced reveal (and its advance to the next sentence bubble) is frozen while she eats. */
  private paused = false;
  /** F7: the pace the host froze for one reply (its first cue wins); a later readout of the same reply reuses it. */
  private rhythm: { id: string; multiplier: number; shy: boolean } | null = null;

  /** F7: this reply's pace from the host. Only the first cue for a reply counts: a mood change mid-reply never changes it. */
  setRhythm(id: string, cue: unknown): boolean {
    if (!this.fallback) return false;
    const pacing = validReplyRhythmPacing({ ...(cue && typeof cue === 'object' ? cue : {}), id });
    if (!pacing || this.closedIds.has(id) || this.rhythm?.id === id) return false;
    this.rhythm = { id, multiplier: pacing.multiplier, shy: pacing.shy };
    const s = this.readout;
    if (s && s.id === id && !s.rhythmSet) { s.multiplier = pacing.multiplier; s.shy = pacing.shy; s.rhythmSet = true; }
    return true;
  }
  /** The multiplier pacing reply `id` now (1 until its cue arrives, or with no readout). */
  rhythmOf(id: string): number { return this.readout?.id === id ? this.readout.multiplier : 1; }

  /** Freeze the paced reveal where it is; content keeps arriving but nothing new is painted. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    const s = this.readout;
    if (s) this.freeze(s);
  }

  /** Continue from the same sentence: a held sentence keeps the rest of its hold, text that arrived meanwhile follows. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const s = this.readout;
    if (!s || s.pausedAt === undefined) return;
    const now = this.clock.now(), holding = s.holding;
    s.since += now - s.pausedAt; s.pausedAt = undefined; s.holding = undefined;
    if (s.fallback) { if (s.visible < s.raw.length) this.paintFallback(s); this.queueReadout(s); return; }
    if (!holding) {
      // Exactly what readoutContent does for the sentence still streaming when nothing is held.
      const currentEnd = this.ends(s).find(end => end >= s.visible) ?? s.raw.length;
      if (currentEnd > s.visible) { s.visible = currentEnd; s.since = now; this.paintVisible(s); }
    }
    this.queueReadout(s);
  }

  get readoutPaused(): boolean { return this.paused; }

  private freeze(s: Readout): void {
    if (s.pausedAt !== undefined) return;
    s.pausedAt = this.clock.now(); s.holding = s.timer !== null;
    // F7: the part of the running wait that passed counts against the budget; the rest is scheduled again on resume.
    if (s.timer !== null) { this.clock.clear(s.timer); s.timer = null; s.waited += Math.min(s.timerDelay, Math.max(0, s.pausedAt - s.timerSetAt)); }
  }

  begin(id: string, accumulatedText = ''): boolean {
    if (!id || id === this.currentId || this.closedIds.has(id)) return false;
    this.clear();
    this.currentId = id;
    this.bodySeen = !!accumulatedText.trim();
    this.suppressed = false;
    this.notifyWaiting();
    return true;
  }

  content(id: string, accumulatedText: string): void {
    if (id === this.currentId && accumulatedText.trim()) { this.bodySeen = true; this.notifyWaiting(); }
  }
  private notifyWaiting(): void {
    const waiting = this.isWaiting(this.currentId) ? this.currentId : null;
    if (waiting === this.waitingNotified || !this.onWaiting) return;
    this.waitingNotified = waiting;
    try { this.onWaiting(waiting); } catch { /* A presentation observer never disturbs the reply. */ }
  }
  /** Presentation only: raw history and the full reader remain independent. */
  startReadout(id: string, paint: ReadoutPaint): void {
    this.cancelReadout();
    const rhythm = this.rhythm?.id === id ? this.rhythm : null;
    this.readout = { id, raw: '', visible: 0, since: this.clock.now(), done: false, fallback: false,
      parser: new IncrementalReplySegments({ maxReplyChars: 100000, maxSegments: 100000 }), boundaries: [], timer: null, paint,
      multiplier: rhythm?.multiplier ?? 1, shy: rhythm?.shy ?? false, rhythmSet: !!rhythm, waited: 0, timerDelay: 0, timerSetAt: 0,
      stop: 'bubble', pieceFrom: null, afterthoughtUsed: false };
    if (this.paused) this.freeze(this.readout);
  }
  readoutContent(id: string, raw: string): void {
    const s = this.readout; if (!s || s.id !== id || s.done || !raw.startsWith(s.raw)) return;
    const delta = raw.slice(s.raw.length); s.raw = raw;
    if (!s.fallback) {
      try { s.boundaries.push(...s.parser.push(delta).map(part => part.end)); }
      catch (error) { if (!(error instanceof IncrementalReplyOverflow)) throw error; s.fallback = true; }
    }
    if (this.paused) return;
    if (s.fallback) { this.paintFallback(s); return; }
    if (s.timer !== null) return;
    const ends = this.ends(s);
    const currentEnd = ends.find(end => end >= s.visible) ?? raw.length;
    if (currentEnd > s.visible) { s.visible = currentEnd; s.since = this.clock.now(); this.paintVisible(s); }
    this.queueReadout(s);
  }
  finishReadout(id: string, drained: () => void): void {
    const s = this.readout; if (!s || s.id !== id) return;
    if (!s.fallback) {
      try { s.boundaries.push(...s.parser.finish().map(part => part.end)); }
      catch (error) { if (!(error instanceof IncrementalReplyOverflow)) throw error; s.fallback = true; }
    }
    s.done = true; s.drained = drained;
    if (this.paused) return;
    if (s.fallback) this.paintFallback(s); this.queueReadout(s);
  }
  cancelReadout(): void {
    const s = this.readout; this.readout = null;
    if (s?.timer !== null && s?.timer !== undefined) this.clock.clear(s.timer);
    s?.parser.cancel();
  }
  private paintFallback(s: Readout): void {
    if (s.timer !== null) { this.clock.clear(s.timer); s.timer = null; }
    s.visible = s.raw.length; s.paint(s.raw, s.raw, []);
  }
  private paintVisible(s: Readout): void {
    const ends = s.boundaries.filter(end => end > 0 && end <= s.visible);
    s.paint(s.raw.slice(0, s.visible), s.raw, ends);
  }
  private ends(s: Readout): number[] {
    const raw = s.raw, boundaries = [...s.boundaries];
    if (boundaries.at(-1) !== raw.length) boundaries.push(raw.length);
    // A very long sentence still needs bounded readable pages. Never split a
    // surrogate pair and never omit a raw code unit from the full reader.
    const ends: number[] = []; let start = 0;
    for (const boundary of boundaries) {
      // R27: whitespace alone (a trailing newline, a paragraph gap) never earns
      // its own readable hold; it joins the text before it.
      if (boundary > start && ends.length && !raw.slice(start, boundary).trim()) { ends[ends.length - 1] = boundary; start = boundary; continue; }
      // R27: the first sentence is never paged. It stays visible as it streams;
      // later long sentences keep bounded readable pages.
      while (start > 0 && boundary - start > 48) {
        // F7: a page never ends inside a grapheme (a combined emoji), nor between a surrogate pair.
        let end = graphemeBoundaryAtOrBefore(raw, start, start + 48);
        if (end <= start) end = start + 48;
        if (/[\uD800-\uDBFF]/u.test(raw[end - 1]) && /[\uDC00-\uDFFF]/u.test(raw[end])) end--;
        ends.push(end); start = end;
      }
      if (boundary > start) { ends.push(boundary); start = boundary; }
    }
    return ends;
  }
  private queueReadout(s: Readout): void {
    if (this.readout !== s || s.timer !== null || this.paused) return;
    if (s.fallback && s.visible < s.raw.length) this.paintFallback(s);
    if (s.visible >= s.raw.length) { if (s.done) { const done = s.drained; s.drained = undefined; done?.(); } return; }
    // F7: every wait this reply adds on purpose shares one 4 s budget. Once it is spent the rest appears as it is generated,
    // each sentence still its own bubble and in order: nothing is skipped, nothing speeds up to catch up.
    const left = this.fallback ? REPLY_RHYTHM_BUDGET_MS - s.waited : Infinity;
    if (left <= 0) {
      s.visible = s.raw.length; s.since = this.clock.now(); s.stop = 'bubble'; s.pieceFrom = null;
      this.paintVisible(s); this.queueReadout(s); return;
    }
    // The time already spent generating counts (since): a slow reply never waits on top of its own slowness.
    const now = this.clock.now(), delay = Math.min(left, Math.max(0, this.holdFor(s) - (now - s.since)));
    s.timerDelay = delay; s.timerSetAt = now;
    s.timer = this.clock.set(() => {
      if (this.readout !== s) return; s.timer = null; s.waited += delay;
      this.advance(s);
    }, delay);
  }
  /** The wait the current state asks for: a bubble's readable hold, a "……" stop, or the pause before her afterthought. */
  private holdFor(s: Readout): number {
    if (!this.fallback) {
      // R27 as confirmed: the previous piece's code units × 70 ms + 250 ms, 0.65–4 s.
      const ends = this.ends(s), previous = ends.findIndex(end => end >= s.visible);
      return Math.max(650, Math.min(4000, 250 + (s.visible - (previous > 0 ? ends[previous - 1] : 0)) * 70));
    }
    if (s.stop === 'ellipsis') return (s.shy ? SHY_ELLIPSIS_PAUSE_MS : ELLIPSIS_PAUSE_MS) * s.multiplier;
    if (s.stop === 'afterthought') return AFTERTHOUGHT_EXTRA_MS * s.multiplier;
    const ends = this.ends(s), previous = ends.findIndex(end => end >= s.visible);
    const bubbleStart = previous > 0 ? ends[previous - 1] : 0;
    const start = s.pieceFrom !== null && s.pieceFrom > bubbleStart && s.pieceFrom < s.visible ? s.pieceFrom : bubbleStart;
    return bubbleHoldMs(visibleLength(s.raw.slice(start, s.visible)), s.multiplier);
  }
  /** One step of the paced reveal: to the next bubble (or page), or first to a "……" stop inside a later one. */
  private advance(s: Readout): void {
    const ends = this.ends(s), next = ends.find(end => end > s.visible) ?? s.raw.length;
    // Her afterthought ("啊对了……"): her own next sentence, after a little more wait, at most once per reply.
    if (this.fallback && s.stop === 'bubble' && !s.afterthoughtUsed && s.visible > 0 && this.sentenceStart(s, s.visible) && isAfterthought(s.raw.slice(s.visible, next))) {
      s.afterthoughtUsed = true; s.stop = 'afterthought'; s.since = this.clock.now(); this.queueReadout(s); return;
    }
    const stop = this.fallback ? ellipsisStop(s.raw, s.visible, next, ends[0] ?? s.raw.length) : null;
    if (stop !== null) { s.stop = 'ellipsis'; s.pieceFrom = null; }
    else { s.pieceFrom = s.stop === 'ellipsis' ? s.visible : null; s.stop = 'bubble'; }
    s.visible = stop ?? next; s.since = this.clock.now(); this.paintVisible(s); this.queueReadout(s);
  }
  private sentenceStart(s: Readout, at: number): boolean {
    return s.boundaries.some(end => end <= at && !s.raw.slice(end, at).trim());
  }

  /** True while the existing readout still has text to reveal or awaits completion. */
  get readoutPending(): boolean {
    const s = this.readout; return !!s && (!s.done || s.visible < s.raw.length);
  }

  isWaiting(id: string | null): boolean {
    return id !== null && id === this.currentId && !this.bodySeen && !this.suppressed;
  }
  /** Suppressed requests may still finish/archive, but cannot replay after show. */
  canPresent(id: string | null): boolean { return id !== null && id === this.currentId && !this.suppressed; }
  has(id: string | null): boolean { return id !== null && id === this.currentId; }

  /** Hiding this window cannot later revive the same request's waiting display. */
  suppressWaiting(): void {
    if (this.currentId !== null) this.suppressed = true;
    this.notifyWaiting();
  }

  close(id: string | null): void {
    if (!id) return;
    this.closedIds.add(id);
    if (this.closedIds.size > MAX_CLOSED_IDS)
      this.closedIds.delete(this.closedIds.values().next().value!);
    if (id === this.currentId) {
      this.currentId = null;
      this.bodySeen = this.suppressed = false;
      this.notifyWaiting();
    }
  }

  clear(): void { this.cancelReadout(); this.close(this.currentId); }
}
