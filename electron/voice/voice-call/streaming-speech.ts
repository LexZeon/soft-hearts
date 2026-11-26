/**
 * I-091 step 4: during a call her replies are read sentence by sentence while the rest is still being written, through the very
 * same host plan typed chat uses (electron/voice/completed-reply-speech.ts, R02): the first complete sentence is read as soon as it is
 * on screen, every sentence keeps its own display proof, lease and cloud claim, and the reply is archived and rewarded once by
 * the voice host as before (nothing here touches the archive or the mood).
 *
 * Why this is safe where R33 waited for the whole reply: the user's speech may still be merged into or continue a reply, so an
 * early reading could turn out wrong. A call has barge-in (step 1): the moment the user speaks, her reading stops and the rest
 * of the reply is not read. The same goes for a reply that is stopped to merge more of what the user said, or one that fails.
 *
 * Only text that already passed the reply filter and the opening marker reaches `delta` (the voice host hands over exactly what
 * it shows); a reply whose text the filter holds to the end arrives at the end and is read then, as before. Outside a call
 * `begin` returns false and nothing changes. Electron-free: electron/main.ts passes the real plan and styles in.
 */
import type { FirstChunkOptions } from '../../../shared/voice/first-speech-chunk';
import { VOICE_CALL_KNOBS } from '../../../shared/behaviors/voice-call/knobs';
import type { ReplyPieceParser } from '../completed-reply-speech';
import type { ReadingCancelBy } from '../../../shared/voice';
import { MergeShortPieces } from './merge-short';

/** The slice of CompletedReplySpeech this needs. */
export interface CallSpeechPlan {
  beginCommit(owner: number, id: string, scope: string, first?: FirstChunkOptions, wrap?: (parser: ReplyPieceParser) => ReplyPieceParser): object;
  append(fence: object, delta: string): void;
  record(owner: number, id: string, scope: string, text: string, options?: { prefix: boolean; fence: object }): boolean;
  cancelPending(fence: object): void;
}

export interface CallStreamingSpeechPorts {
  plan: CallSpeechPlan;
  /** A call is on for this window and she reads aloud. */
  active(owner: string): boolean;
  /** The voice reading this reply: 'system' is free; anything else bills per call. */
  voice(): { provider: string; firstChunk?: 'comma' | 'sentence' };
  /** Freezes this turn's voice, pace and the first-piece rule, as typed chat does when it accepts a turn (never throws into the call). */
  freeze(input: { sender: number; replyId: string; scope: string; userText: string }): void;
  /** Her reading of this reply was authorized (the interruption ledger learns what can be interrupted). */
  started(replyId: string): void;
  /** Her call reading is audible or queued to play now (a sentence of the plan, or the window's sound), whatever the reply's text is doing. */
  playing?(): boolean;
  /** A reading is being cancelled, and why (the journal's reading-time line says who cut it; closed words only). */
  cancelled?(by: ReadingCancelBy): void;
  knobs?: { speech: { paidMinChunkChars: number } };
}

interface Streamed { fence: object; sender: number; scope: string; text: string }

export class CallStreamingSpeech {
  private readonly streams = new Map<string, Streamed>();
  /** I-204: the last few call replies' written text, read or not, kept growing after a cut (the cut note tells her the unspoken rest). */
  private readonly written = new Map<string, string>();
  /** The last reply that finished writing (she may still be reading its later sentences). */
  private finished = '';
  constructor(private readonly ports: CallStreamingSpeechPorts) {}

  /** What she is reading in the call now (the streaming reply, or the last one that finished writing): the echo check only. */
  readingText(): string { let text = this.finished; for (const stream of this.streams.values()) text = stream.text; return text; }

  /**
   * Her call reading is going on now: a reply whose text has begun to reach the plan, or a reading still audible or queued after the text
   * finished (the interruption gate must know she is speaking). No clock: it follows the plan's and the window's own state.
   */
  reading(): boolean {
    for (const stream of this.streams.values()) if (stream.text) return true;
    try { return this.ports.playing?.() === true; } catch { return false; }
  }

  /** I-204: what this call reply has written so far (all of it, read aloud or not), or null when it is not one of the last few. */
  writtenText(replyId: string): string | null { return this.written.get(replyId) ?? null; }

  /** Whether this reply is read while it streams (the voice host then sends no whole-reply 'speech' event for it). */
  has(replyId: string): boolean { return this.streams.has(replyId); }

  /** A call turn's reply is about to stream. False: not in a call (or she does not read aloud), the old way applies. */
  begin(input: { owner: string; sender: number; replyId: string; scope: string; userText: string }): boolean {
    let on = false;
    try { on = this.ports.active(input.owner); } catch { on = false; }
    if (!on) return false;
    try { this.ports.cancelled?.('new-reply'); } catch { /* journal only */ } // a reading this begin() cuts (one still playing) was cut by this reply
    this.cancelAll(); // one reply at a time (the plan holds one too)
    this.finished = '';
    const voice = this.ports.voice(), paid = voice.provider !== 'system';
    const min = Math.max(0, Math.floor((this.ports.knobs ?? VOICE_CALL_KNOBS).speech.paidMinChunkChars));
    let fence: object;
    try {
      fence = this.ports.plan.beginCommit(input.sender, input.replyId, input.scope, { mode: voice.firstChunk === 'comma' ? 'comma' : 'sentence', voice: voice.provider },
        paid && min > 0 ? parser => new MergeShortPieces(parser, min) : undefined);
    } catch { return false; }
    this.streams.set(input.replyId, { fence, sender: input.sender, scope: input.scope, text: '' });
    this.written.set(input.replyId, ''); if (this.written.size > 4) this.written.delete(this.written.keys().next().value!);
    try { this.ports.freeze({ sender: input.sender, replyId: input.replyId, scope: input.scope, userText: input.userText }); } catch { /* the plan still reads in her default voice */ }
    try { this.ports.started(input.replyId); } catch { /* ledger only */ }
    return true;
  }

  /** The next visible (already filtered) text of the reply. */
  delta(replyId: string, text: string): void {
    if (typeof text !== 'string' || !text) return;
    const written = this.written.get(replyId);
    if (written !== undefined && written.length + text.length <= 20_000) this.written.set(replyId, written + text); // also after a cut: never read, only told
    const stream = this.streams.get(replyId);
    if (!stream) return;
    stream.text += text;
    try { this.ports.plan.append(stream.fence, text); } catch { /* a bad stream just stops being read */ }
  }

  /** The reply finished complete: the plan reads what is left and ends. Returns whether the plan accepted it. */
  complete(replyId: string): boolean {
    const stream = this.streams.get(replyId);
    if (!stream) return false;
    this.streams.delete(replyId); this.finished = stream.text;
    try { return this.ports.plan.record(stream.sender, replyId, stream.scope, stream.text, { prefix: true, fence: stream.fence }); }
    catch { this.ports.plan.cancelPending(stream.fence); return false; }
  }

  /** The reply was stopped, merged into the user's next words, failed, or the user talked over it: nothing more of it is read. */
  cancel(replyId: string): void {
    const stream = this.streams.get(replyId);
    if (!stream) return;
    this.streams.delete(replyId);
    try { this.ports.cancelled?.('superseded'); } catch { /* journal only */ }
    this.ports.plan.cancelPending(stream.fence);
  }

  /** Cancels whatever reply is streaming now (barge-in, hang-up). */
  cancelAll(): void { for (const id of [...this.streams.keys()]) this.cancel(id); }
}
