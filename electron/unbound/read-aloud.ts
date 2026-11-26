/**
 * Read-aloud while she is out in Unbound (docs/claude/2026-11-15-unbound-read-aloud.md). The rule is the companion's: what is spoken
 * must be what was displayed. At home the proof is the companion's reply window (electron/brain/reply-window.ts PetReplyWindow); while she is
 * out it is her Unbound bubble, and this is that proof.
 *
 * The host records every piece of text it sends the bubble, each under a new revision (`sent`, `line`). The Unbound page tells
 * the host, from its own top frame, which revision its bubble has painted (shared/unbound/shown.ts); a report counts only when
 * its text is exactly what the host sent at that revision, comes in order, and the bubble can be seen (she is out, her window
 * is shown; a full-screen program in front never hides it, I-199). Anything that takes the bubble off the screen (a new reply, a retraction, the
 * window hidden, leaving Unbound, the page saying it is not visible) drops the proof, and a proof that was being waited on fails,
 * which cancels the readout exactly as a hidden companion bubble does.
 *
 * It has the same four methods electron/main.ts uses on the companion's reply window, so the host's read-aloud checks (sentence by
 * sentence, prefix mode through electron/voice/completed-prefix-proof.ts, cancel on mismatch, late results never revive) run
 * unchanged on it.
 */
import { CompletedPrefixProof, type CompletedPrefixBody } from '../voice';
import { parseUnboundShown, SHOWN_TEXT_MAX } from '../../shared/unbound/shown';

/** What the host's read-aloud checks need of a display proof (PetReplyWindow has the same four). */
export interface ReplyProofSurface {
  /** Prefix mode: resolves once the shown text covers `minimumEnd` of the (growing) body; `commit` runs with that exact text. */
  waitForCompletedPrefix(fullBody: CompletedPrefixBody, minimumEnd: number, signal: AbortSignal, remainingMs: number, commit: (text: string) => boolean): Promise<boolean>;
  /** Exactly `text` is the proven shown text now. */
  isCompletedPrefixCurrent(text: string): boolean;
  /** Resolves true once exactly `expectedText` (the whole bubble) is shown; false when that can no longer happen. */
  waitForPresentation(expectedText: string, signal?: AbortSignal): Promise<boolean>;
  /** Exactly `expectedText`, the whole bubble, is shown now. */
  isPresentationCurrent(expectedText: string): boolean;
  /** I-165: what the bubble holds now for the reply being read ('' = "……"), painted or not; null when it cannot be seen. */
  followingText?(): string | null;
}

export interface BubbleProofOptions {
  /** She is out, her window is shown and visible: her bubble can be seen at all. */
  active(): boolean;
  /**
   * I-174 item 2: her bubble is here although it cannot be seen now: only covered (shared/foundation/step-away.ts herHere: minimized;
   * a full-screen program never hides her, I-199). Her voice goes on following it (the bubble shows the words when she is back);
   * a paint receipt still needs active(). Absent: the same as active().
   */
  here?(): boolean;
  /** How long waitForPresentation waits for the page's report (the companion's receipt bound: 5 s). */
  timeoutMs?: number;
}

/** Revisions kept per bubble (a long reply streams in many pieces; a report for an older one than this is simply not counted). */
const MAX_REVISIONS = 4096;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

interface Bubble { id: string; text: string; revs: Array<{ rev: number; length: number }>; held: boolean }

export class UnboundBubbleProof implements ReplyProofSurface {
  private bubble: Bubble | null = null;
  /** Monotonic across bubbles, so a late report about an old bubble can never match a new one. */
  private counter = 0;
  private shown: { rev: number; text: string } | null = null;
  /** Bumped whenever the proven text changes or is dropped (the prefix proof's revision). */
  private generation = 0;
  private drops = 0;
  private readonly waiters = new Set<() => void>();
  private readonly prefix: CompletedPrefixProof;

  constructor(private readonly options: BubbleProofOptions) {
    this.prefix = new CompletedPrefixProof({
      snapshot: () => {
        const active = this.canShow(), text = this.shown?.text ?? '';
        return { text, revision: this.generation, ownerCurrent: active || this.isHere(), ready: active && !!this.bubble && !!text.trim() };
      },
      following: () => this.followingText(),
      current: text => this.isCompletedPrefixCurrent(text),
      // The snapshot's text is already a painted report: nothing more to wait for.
      waitExact: async text => this.isCompletedPrefixCurrent(text),
    });
  }

  /** Her bubble can be seen at all (the gates' "she can express herself" while she is out). */
  canShow(): boolean { try { return this.options.active() === true; } catch { return false; } }
  /** I-174: shown, or only covered for a while (her voice still follows the bubble). */
  isHere(): boolean { try { return this.options.here ? this.options.here() === true : this.canShow(); } catch { return false; } }
  /** The bubble's id now (null: none). */
  get currentId(): string | null { return this.bubble?.id ?? null; }
  /** The latest revision sent (what a 'done' or 'error' event carries). */
  get revision(): number { return this.counter; }
  /** The text proven on screen now ('' when none), for tests and the developer view. */
  /** The whole text the host has sent the bubble `id` so far (what a finished bubble shows); '' for another bubble. */
  textOf(id: string): string { return this.bubble && this.bubble.id === id ? this.bubble.text : ''; }
  get shownText(): string { return this.canShow() ? this.shown?.text ?? '' : ''; }

  // ---- host → page ------------------------------------------------------------------------------------------------------------

  /** A streamed piece of reply `id` is sent to the bubble. Returns its revision. A new id replaces the bubble and its proof. */
  sent(id: string, delta: string): number {
    if (this.bubble?.id !== id) this.replace(id);
    const bubble = this.bubble!;
    if (typeof delta === 'string') bubble.text += delta;
    const rev = ++this.counter;
    bubble.revs.push({ rev, length: bubble.text.length });
    if (bubble.revs.length > MAX_REVISIONS) bubble.revs.shift();
    this.changed(); // what was proven stays proven: the bubble only appends
    return rev;
  }

  /** Her own whole line replaces the bubble (always a new bubble, even under the same id). */
  line(id: string, text: string): number { this.replace(id); return this.sent(id, text); }

  /** The bubble for `id` leaves the screen now (an error or a retraction: the page hides it at once). */
  ended(id: string): boolean {
    if (this.bubble?.id !== id) return false;
    this.bubble = null;
    this.drop();
    return true;
  }

  /** The window or the mode changed: nothing proven stays proven (a full-screen program in front is not such a change, I-199). */
  invalidate(): void { this.drop(); }

  // ---- page → host ------------------------------------------------------------------------------------------------------------

  /**
   * The page's report (the caller has checked it came from the shown Unbound window's own top frame). Counted only for the
   * current bubble, while it can be seen, for a revision the host sent, with exactly the text sent at that revision, and newer
   * than the last one counted. `visible: false` drops the proof.
   */
  report(value: unknown): boolean {
    const report = parseUnboundShown(value), bubble = this.bubble;
    if (!report || !bubble || report.id !== bubble.id || !this.canShow()) return false;
    if (!report.visible) {
      if (!this.shown) return false;
      this.drop();
      return true;
    }
    const at = bubble.revs.find(entry => entry.rev === report.rev);
    if (!at || at.length > SHOWN_TEXT_MAX || report.text !== bubble.text.slice(0, at.length) || !report.text.trim()) return false;
    if (this.shown && report.rev <= this.shown.rev) return false;
    this.shown = { rev: report.rev, text: report.text };
    this.generation++;
    this.changed();
    return true;
  }

  // ---- the proof ----------------------------------------------------------------------------------------------------------------

  isCompletedPrefixCurrent(text: string): boolean {
    return typeof text === 'string' && !!text.trim() && this.canShow() && !!this.bubble && this.shown?.text === text;
  }

  /**
   * I-165: her bubble is up holding this reply's place for her voice ("……": the host sent the reply's bubble but none of its text yet,
   * electron/unbound/bubble-hold.ts).
   */
  holdCurrent(): boolean { return this.canShow() && !!this.bubble && this.bubble.held && !this.bubble.text; }

  /**
   * I-165: what her bubble holds now for the reply being read ('' while "……"; else the text the host sent it), whether or not the page
   * reported its paint yet; null when her bubble cannot be seen. A reply that follows her voice is read on this alone: a late or
   * missing report from the page delays only the bubble, never her voice.
   */
  followingText(): string | null { return this.isHere() && this.bubble ? (this.bubble.held || this.bubble.text ? this.bubble.text : null) : null; }

  /** I-165: the reply's bubble goes up showing "……" (no text yet); its text follows through `sent` as her voice reaches it. */
  hold(id: string): number { this.replace(id); this.bubble!.held = true; this.changed(); return this.counter; }

  isPresentationCurrent(expectedText: string): boolean {
    return this.isCompletedPrefixCurrent(expectedText) && this.bubble!.text === expectedText;
  }

  waitForCompletedPrefix(fullBody: CompletedPrefixBody, minimumEnd: number, signal: AbortSignal, remainingMs: number, commit: (text: string) => boolean): Promise<boolean> {
    return this.prefix.wait(fullBody, minimumEnd, signal, remainingMs, commit);
  }

  waitForPresentation(expectedText: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof expectedText !== 'string' || !expectedText.trim() || expectedText.length > SHOWN_TEXT_MAX || signal?.aborted
      || !this.canShow() || this.bubble?.text !== expectedText) return Promise.resolve(false);
    if (this.isPresentationCurrent(expectedText)) return Promise.resolve(true);
    const bubble = this.bubble, drops = this.drops;
    return new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean) => {
        if (!this.waiters.delete(wake)) return;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const wake = () => {
        if (signal?.aborted || this.drops !== drops || this.bubble !== bubble || bubble.text !== expectedText || !this.canShow()) finish(false);
        else if (this.isPresentationCurrent(expectedText)) finish(true);
      };
      const abort = () => finish(false);
      this.waiters.add(wake);
      timer = setTimeout(() => finish(false), this.options.timeoutMs ?? 5_000);
      (timer as { unref?: () => void }).unref?.();
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  // ---- inside -----------------------------------------------------------------------------------------------------------------

  private replace(id: string): void {
    this.bubble = { id: ID.test(id) ? id : '', text: '', revs: [], held: false };
    this.drop();
  }
  private drop(): void {
    this.shown = null;
    this.generation++;
    this.drops++;
    this.changed();
  }
  private changed(): void {
    for (const wake of [...this.waiters]) wake();
    this.prefix.changed();
  }
}

/**
 * The id of her own line a broadcast takes back (the companion hides it too): a visual or inner-loop line's cancel, or an ambient
 * comment's cancel. Null for every other channel.
 */
export function retractedLineId(channel: string, value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { type?: unknown; id?: unknown };
  if (channel === 'desk:vision-initiative' && raw.type !== 'cancel') return null;
  if (channel !== 'desk:vision-initiative' && channel !== 'desk:ambient-comment-cancelled') return null;
  return typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null;
}
