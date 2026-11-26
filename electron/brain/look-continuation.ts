import type { StreamEvent } from '../../shared/brain/stream-event';
import { LookMarkerFilter, SEE_AND_SAY, type CloserMiss, type CloserOutcome, type CloserWhy, type LookMarkerChunk, type LookSense } from '../../shared/senses';
import type { ClaudeTurnControl, ClaudeTurnOutcome, CompanionClaudeTask } from './claude-session-types';
import { OpeningGate } from './reply-opening';

type Emit = (type: StreamEvent['type'], text: string) => void;

/**
 * I-166 她自己决定凑近看. One wrapper around her chat process's `stream`, used by the typed chat turn
 * (electron/wiring/brain-chat-wiring.ts) and by voice input and calls (electron/wiring/senses-voice-input-wiring.ts `claude`):
 *
 *  - Her hidden marker ⟦look-camera⟧ / ⟦look-screen⟧ (shared/senses/see-and-say/marker.ts) leaves the stream here, before the speech-beat
 *    filter, the reply protocol, the bubble, the voice and the archive see it. Only the first marker of a reply counts (one closer look per
 *    user message); any other is dropped. What she writes after it in that reply is held back (she was told to stop there).
 *  - When the reply ends with a marker, the sense is on (no "别看") and the turn was not stopped or superseded: a short "……" goes into the
 *    same bubble, one clear frame of that sense is taken (at most `closerTimeoutMs`; the capture port checks the switches), and the
 *    private note plus the frame go to the SAME warm process (PersistentClaudeChat.continueReply). Its reply streams into the same turn, so
 *    the reply and its continuation are shown, read and archived as one reply, once (the caller finishes its turn once, after this returns).
 *  - A timeout or no frame: she goes on without it (her note says she did not see it). The sense turning off or "别看" while waiting, a
 *    newer message (supersede) or a stop: no continuation, and nothing comes back later (no revival). No warm process to continue: the
 *    held rest of her reply goes out instead, as if she had not asked.
 * Memory only: no frame is kept here (the capture's own checks are read again where the message is written).
 */
export interface ContinuableChat {
  stream(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome>;
  continueReply?(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit): Promise<ClaudeTurnOutcome | null>;
}

/**
 * A clear frame taken for her closer look: its data, asked again on every read (a frame whose source went off is gone). `still` (I-168):
 * whether it may still be seen, without the picture: the check the warm process keeps when the frame stays there (keepClearFrames).
 */
export interface ClearLook { dataUrls(): string[]; still?(): boolean }

/**
 * One closer look as the journal sees it (closed words and numbers; never a frame or a word). `miss` says why no
 * clear picture came, `tries` how many captures were tried (absent: one, or none at all).
 */
export interface CloserLookEntry { sense: LookSense; outcome: CloserOutcome; why?: CloserWhy; ms?: number; miss?: CloserMiss; tries?: number }
/** How the capture went (electron/senses/look-attachments.ts LookAttachments.closer reports it once). */
export interface CloserCaptureReport { tries: number; miss?: CloserMiss }

export interface LookContinuationPorts {
  /** Which senses may give a clear frame right now: on, and no "别看" holding them. */
  senses(): { camera: boolean; screen: boolean };
  /** One clear frame of `sense` (null: none). The port checks the switches; a change while it is taken drops it. `report`: why none, and the tries. */
  capture(sense: LookSense, signal: AbortSignal, report?: (detail: CloserCaptureReport) => void): Promise<ClearLook | null>;
  /** The continuation's private note, in her language (shared/senses/see-and-say/words.ts closerLookNote). */
  note(sense: LookSense, seen: boolean, off?: boolean): string;
  journal?(entry: CloserLookEntry): void;
  knobs?: { closerLook: boolean; closerTimeoutMs: number; dots: string; keepClearFrames?: boolean };
  /**
   * The reply's fixed opening marker ('' or absent: the turn mode, or no gate). 2026-11-21 (dev journal 20:41 and 20:42: her first character
   * at 11 and 13 s): a reply that began with the look marker had no opening marker yet, so the opening gate downstream held her "……" and
   * the whole continuation until the reply was complete. With this, a first part without the marker gets it from here right before the
   * app's own "……" (what she wrote in front of it without a marker is dropped by the gate, as always), and the continuation passes a
   * gate of its own: only what she writes after her marker in it goes on (the note names it); none at all: the forgotten-marker cut at
   * its end, as the turn's gate does.
   */
  opening?: string;
  now?(): number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** The stream a turn uses: her closer look around `chat` when it is wired (I-166), else `chat` itself. */
export function lookStream(chat: ContinuableChat, look: { continuation: LookContinuation } | null | undefined) {
  return (task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> =>
    look ? look.continuation.stream(chat, task, signal, emit, control) : chat.stream(task, signal, emit, control);
}

const ENDS_IN_DOTS =/(?:…|\.\.\.|。。。)\s*$/u;
/** The private tail's markers (the turn's nonce is not known here: any of the families counts), for the continuation's own opening gate. */
const TAIL_FAMILIES = ['state', 'memorial', 'setting', 'file'] as const;
const CONTINUATION_TAIL = /<\/?sh-(?:state|memorial|setting|file)-[a-f0-9]{1,32}>/iu;
function mayBeContinuationTail(text: string): boolean {
  return TAIL_FAMILIES.some(family => { const start = `<sh-${family}-`; return start.startsWith(text) || (text.startsWith(start) && /^[a-f0-9]{0,32}$/iu.test(text.slice(start.length))); });
}
/** The continuation's own gate: only her words after `marker` in it go on (reply-opening.ts OpeningGate, tail found by family). */
export function continuationGate(marker: string): OpeningGate {
  return new OpeningGate({ marker, tailAt: text => CONTINUATION_TAIL.exec(text)?.index ?? -1, mayBeTail: mayBeContinuationTail });
}
const defaultTimers = { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export class LookContinuation {
  /** Counts and the last continuation latency (marker seen → her next character), for the developer panel and the numbers. */
  readonly stats = { requested: 0, taken: 0, failed: 0, cancelled: 0, off: 0, lastMs: null as number | null };
  constructor(private readonly ports: LookContinuationPorts) {}

  async stream(chat: ContinuableChat, task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    const knobs = this.ports.knobs ?? SEE_AND_SAY, now = this.ports.now ?? (() => performance.now());
    const filter = new LookMarkerFilter();
    let wanted: LookSense | null = null, held = '', forwarded = '', phase: 'first' | 'looking' | 'more' = 'first', cut = false;
    let lookAbort: AbortController | null = null, innerSupersede: (() => boolean) | null = null, told = false;
    const out = (text: string) => { if (!text) return; forwarded += text; emit('delta', text); };
    const absorb = (chunk: LookMarkerChunk) => {
      if (wanted) { held += chunk.text; return; }
      if (!chunk.marks.length) { out(chunk.text); return; }
      out(chunk.text.slice(0, chunk.at[0]));
      wanted = chunk.marks[0];
      held += chunk.text.slice(chunk.at[0]);
    };
    // The caller's supersede (voice: the next sentences merge in) also reaches the wait and the continuation.
    const supersede = (): boolean => {
      if (phase === 'looking') { cut = true; lookAbort?.abort(); return true; }
      try { return innerSupersede ? innerSupersede() : false; } catch { return false; }
    };
    const inner: ClaudeTurnControl | undefined = control?.started ? { started: given => {
      innerSupersede = given;
      if (told) return;
      told = true;
      try { control.started!(supersede); } catch { /* a hook never changes the turn */ }
    } } : undefined;
    const first = await chat.stream(task, signal, (type, text) => { if (type === 'delta') absorb(filter.push(text)); else emit(type, text); }, inner);
    absorb(filter.end());
    const sense = wanted as LookSense | null;
    if (!sense) return { superseded: first.superseded, output: forwarded };
    this.stats.requested++;
    let miss: CloserMiss | undefined, tries = 0;
    const journal = (outcome: CloserOutcome, why?: CloserWhy, ms?: number) => {
      this.stats[outcome]++;
      try { this.ports.journal?.({ sense, outcome, ...(why ? { why } : {}), ...(ms !== undefined ? { ms } : {}), ...(miss ? { miss } : {}), ...(tries > 1 ? { tries } : {}) }); } catch { /* journal only */ }
    };
    if (first.superseded || signal.aborted) { journal('cancelled', first.superseded ? 'superseded' : 'stopped'); return { superseded: first.superseded, output: forwarded }; }
    const allowed = (): boolean => { try { return this.ports.senses()[sense] === true; } catch { return false; } };
    const marker = this.ports.opening ?? '';
    // 2026-11-22: a reply that was only the marker, with the sense off (or no frame), must not leave an empty bubble: she goes on in words.
    const wordless = (text: string) => !(marker ? text.split(marker).join('') : text).trim();
    const ensureWords = () => { if (wordless(forwarded)) out(knobs.dots || '……'); };
    const canLook = allowed() && knobs.closerLook;
    if (!chat.continueReply || (!canLook && !wordless(forwarded + held))) {
      if (!allowed()) journal('off'); else journal('cancelled', knobs.closerLook ? 'no-process' : undefined);
      out(held);
      ensureWords();
      return { superseded: false, output: forwarded };
    }
    const startedAt = now();
    // 2026-11-21: the first part never opened the reply (she began with the look marker): open it here, at the app's own "……".
    const gate = marker && !forwarded.includes(marker) ? continuationGate(marker) : null;
    if (gate) out(marker);
    const gated = (text: string, final = false) => (gate ? gate.push(text) + (final ? gate.finish(true) : '') : text);
    if (canLook && knobs.dots && !ENDS_IN_DOTS.test(forwarded)) out(knobs.dots);
    // Off (nothing to wait for): she is told and goes on in words, in the same warm process and the same reply.
    let off = !canLook, closed = off;
    if (off) journal('off');
    phase = 'looking';
    const controller = new AbortController();
    lookAbort = controller;
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    let frame: ClearLook | null = null, why: CloserWhy | undefined, timedOut = false;
    const timers = this.ports.timers ?? defaultTimers;
    const timer = off ? null : timers.set(() => { timedOut = true; controller.abort(); }, Math.max(0, knobs.closerTimeoutMs));
    try {
      if (!off) frame = await new Promise<ClearLook | null>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('closer look ended')), { once: true });
        this.ports.capture(sense, controller.signal, detail => { tries = detail.tries; miss = detail.miss; }).then(resolve, reject);
      });
      if (!frame) { why = 'no-frame'; miss ??= 'capture-failed'; }
    } catch { frame = null; why = timedOut ? 'timeout' : 'error'; if (timedOut) miss = 'timeout'; }
    finally { if (timer !== null) timers.clear(timer); signal.removeEventListener('abort', stop); lookAbort = null; }
    if (signal.aborted) { journal('cancelled', 'stopped'); signal.throwIfAborted(); }
    if (cut) { journal('cancelled', 'superseded'); return { superseded: true, output: forwarded }; }
    // "别看" or the switch off while she waited: she does not look, and her reply ends as she wrote it (a reply with no words yet goes on in words).
    if (!off && !allowed()) {
      miss = 'held';
      journal('cancelled', 'held');
      if (!wordless(forwarded + held)) { out(gated(held, true)); return { superseded: false, output: forwarded }; }
      off = true; closed = true; frame = null;
    }
    phase = 'more';
    const look = frame;
    let images: string[] = [];
    // continueReply reads the frames first, then the note: the note says "seen" only when a frame really goes with it.
    const more = Object.create(task, {
      imageDataUrls: { get: () => { try { images = look && allowed() ? look.dataUrls() : []; } catch { images = []; } return images; }, enumerable: true },
      prompt: { get: () => this.ports.note(sense, images.length > 0, off), enumerable: true },
      // I-168: the clear frame stays in the warm process like a small one (its own check, never the picture); off: it retires the process after use.
      callGlance: { value: look?.still && knobs.keepClearFrames === true ? { glanceOnly: () => true, still: () => () => { try { return look.still!() === true; } catch { return false; } }, past: () => '' } : undefined, enumerable: true },
      refusalFallback: { value: undefined, enumerable: true },
    }) as CompanionClaudeTask;
    const after = new LookMarkerFilter(); // a second marker is never acted on (one closer look per message), and never shown
    let firstAt: number | null = null, result: ClaudeTurnOutcome | null = null;
    try {
      result = await chat.continueReply(more, signal, (type, text) => {
        if (type !== 'delta') { emit(type, text); return; }
        const clean = gated(after.push(text).text);
        if (clean && firstAt === null) firstAt = now();
        out(clean);
      });
    } catch (error) {
      if (signal.aborted) { journal('cancelled', 'stopped'); throw error; }
      result = null; why = 'error';
    }
    if (!result) {
      if (!closed) journal('cancelled', why === 'error' ? 'error' : 'no-process');
      out(gated(firstAt === null ? held : '', true));
      ensureWords();
      return { superseded: false, output: forwarded };
    }
    out(gated(after.end().text, true));
    ensureWords();
    const ms = firstAt === null ? undefined : Math.max(0, Math.round(firstAt - startedAt));
    if (ms !== undefined) this.stats.lastMs = ms;
    if (closed) return { superseded: result.superseded, output: forwarded };
    // 2026-11-22: a picture taken but no longer allowed when it was to go is 'dropped' (its source went off, or "别看", in between).
    if (images.length) { miss = undefined; journal('taken', undefined, ms); } else { if (look) miss = 'dropped'; journal('failed', why ?? 'no-frame', ms); }
    return { superseded: result.superseded, output: forwarded };
  }
}
