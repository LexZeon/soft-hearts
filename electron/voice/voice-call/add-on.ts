/**
 * I-197: in a call, from the moment the user's line is handed to her until her VOICE actually starts (text that
 * arrived without a sound yet still counts as not answered), a clear line the user adds is joined to the first one and the two are
 * answered together. This file only keeps that window; electron/voice/voice-chat-host.ts and voice-conversation-session.ts act on it.
 *
 * - `handed` opens the window for one call leg; `voiced` (the reading window's "this sentence is audible", noteReplySpeechHeard
 *   'start') closes it. With no reading in the call (read-aloud off) her first visible character closes it instead.
 * - While it is open her voice is silent, so the interruption gate's "she is speaking" is only her short filler sound (echo guard).
 * - A reply fully written but not yet sounding is held up to `holdMs` (`hold`): her voice starts (it stands), an add-on comes
 *   (it is dropped: never read, shown or archived), or the time runs out (it stands).
 * - One journal row per add-on: the gap since the first line was handed over, whether its request had been written, how many
 *   characters she wrote that were never voiced. Numbers and a flag only.
 * Electron-free; tests pass a fake clock and timers.
 */
import { VOICE_CALL_KNOBS } from '../../../shared/behaviors/voice-call/knobs';
import type { VoiceCallTimers } from './controller';

export type AddOnHold = 'voiced' | 'add-on' | 'timeout' | 'stopped' | 'none';
export interface AddOnJournalRow { gapMs: number; written: boolean; dropped: number }
export interface CallAddOnPorts {
  now(): number;
  /** A call is on and this window owns it. */
  inCall(owner: string): boolean;
  timers?: VoiceCallTimers;
  journal?(row: AddOnJournalRow): void;
  knobs?: { addOn: { holdMs: number } };
}

interface Reply {
  owner: string; handedAt: number; answered: boolean; asked: boolean; addOnAt: number | null; hold: ((verdict: AddOnHold) => void) | null;
  /** Her voice started while a line the user began earlier was still on its way: the window stays open until that line is settled. */
  deferred: boolean; deferTimer: unknown; joining: boolean;
}
const LIMIT = 8;

export class CallAddOn {
  private readonly replies = new Map<string, Reply>();
  private fillerOn = false;
  /** When the user last began to talk while she was silent (the window's verified speech-start); null once that speech was settled. */
  private speechAt: number | null = null;
  private readonly timers: VoiceCallTimers;
  constructor(private readonly ports: CallAddOnPorts) {
    this.timers = ports.timers ?? { set: (callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  /** A call leg's line was handed to her (the voice host's dispatch began). Outside a call nothing opens. */
  handed(replyId: string, owner: string): void {
    if (!this.call(owner)) return;
    this.replies.set(replyId, { owner, handedAt: this.ports.now(), answered: false, asked: false, addOnAt: null, hold: null, deferred: false, deferTimer: null, joining: false });
    if (this.replies.size > LIMIT) this.done(this.replies.keys().next().value!);
  }
  /**
   * The user began to talk (verified speech-start in the call's window). Only counts while some leg is still silent: a line begun before
   * her voice started belongs to the add-on even if it is recognized after her first sound (dev journal 2026-11-23 22:29).
   */
  speechStart(): void { if (this.silent()) this.speechAt = this.ports.now(); }
  /**
   * What the user began to say came to nothing as a line (no words, noise, a held clip, a voiceprint refusal): her voice that started
   * meanwhile now counts, as if it had started then.
   */
  settled(): void {
    this.speechAt = null;
    for (const [id, reply] of this.replies) if (reply.deferred) this.release(id, reply);
  }
  /** Her first visible character of this leg: answered only when the call does not read it aloud (no voice to wait for). */
  firstChar(replyId: string, reading: boolean): void { if (!reading) this.answer(replyId, 'voiced'); }
  /** The reading window says a sentence of this reply is audible now: her voice started, the window closes. */
  voiced(replyId: unknown): void { if (typeof replyId === 'string') this.answer(replyId, 'voiced'); }
  /** Her short filler sound ("嗯……") is sounding or stopped: while the window is open only it counts as her voice. */
  filler(on: boolean): void { this.fillerOn = on === true; }

  /** The window is open for this leg: in a call, handed over, voice not started yet. */
  open(replyId: string): boolean {
    const reply = this.replies.get(replyId);
    return !!reply && !reply.answered && this.call(reply.owner);
  }
  /** Some call leg is still unanswered: her reply's voice is silent now. */
  silent(): boolean { for (const id of this.replies.keys()) if (this.open(id)) return true; return false; }
  /** "She is speaking" for the interruption gate: while she is silent, only her filler sound (its echo guard stays). */
  herVoice(otherwise: () => boolean): boolean {
    if (this.silent()) return this.fillerOn;
    try { return otherwise() === true; } catch { return false; }
  }

  /**
   * An add-on was heard for this leg (the session asks to merge it). True when the leg is in its window; the leg is then dropped
   * when its stream ends (a written-but-silent reply waiting in `hold` is released at once).
   */
  request(replyId: string): boolean {
    const reply = this.replies.get(replyId);
    if (!reply || !this.open(replyId)) return false;
    reply.asked = true; reply.addOnAt ??= this.ports.now();
    reply.hold?.('add-on');
    return true;
  }
  /** A line was heard for this leg: true (and its arrival noted for the journal) when the leg is in its window. */
  heard(replyId: string): boolean {
    const reply = this.replies.get(replyId);
    if (!reply || !this.open(replyId)) return false;
    reply.addOnAt ??= this.ports.now();
    reply.joining = true; this.speechAt = null; // the line is here: her voice may not close the window before the merge is requested
    return true;
  }
  /** The add-on joined the request before it was written (no drop). */
  absorbed(replyId: string): void { const reply = this.replies.get(replyId); if (reply) reply.joining = false; this.join(replyId, false, 0); }
  /** An add-on was asked for this leg. */
  asked(replyId: string): boolean { return this.replies.get(replyId)?.asked === true; }

  /**
   * The leg's stream ended. Not in the window: 'none'. An add-on was asked: 'add-on' at once. Not read aloud: 'none'. Otherwise
   * wait for her voice ('voiced'), an add-on ('add-on'), the stop of the leg ('stopped') or `holdMs` ('timeout').
   */
  hold(replyId: string, signal: AbortSignal, reading: boolean): Promise<AddOnHold> {
    const reply = this.replies.get(replyId);
    if (!reply || !this.open(replyId)) return Promise.resolve('none');
    if (reply.asked) return Promise.resolve('add-on');
    if (!reading) return Promise.resolve('none');
    if (signal.aborted) return Promise.resolve('stopped');
    const ms = Math.max(0, (this.ports.knobs ?? VOICE_CALL_KNOBS).addOn.holdMs);
    return new Promise<AddOnHold>(resolve => {
      let timer: unknown = null;
      const finish = (verdict: AddOnHold) => {
        if (reply.hold !== finish) return;
        reply.hold = null; signal.removeEventListener('abort', stop);
        if (timer !== null) this.timers.clear(timer);
        resolve(verdict);
      };
      const stop = () => finish('stopped');
      reply.hold = finish;
      signal.addEventListener('abort', stop, { once: true });
      timer = this.timers.set(() => finish('timeout'), ms);
    });
  }

  /** The leg was dropped for an add-on after its request was written: one journal row. */
  dropped(replyId: string, chars: number): void { this.join(replyId, true, chars); }
  /** The leg ended: its window is gone. */
  done(replyId: string): void {
    const reply = this.replies.get(replyId);
    if (reply?.deferTimer != null) this.timers.clear(reply.deferTimer);
    reply?.hold?.('stopped'); this.replies.delete(replyId);
  }
  /** Hang-up: nothing carries over. */
  clear(): void { for (const id of [...this.replies.keys()]) this.done(id); this.fillerOn = false; this.speechAt = null; }

  private join(replyId: string, written: boolean, dropped: number): void {
    const reply = this.replies.get(replyId);
    if (!reply) return;
    const at = reply.addOnAt ?? this.ports.now();
    try { this.ports.journal?.({ gapMs: Math.max(0, Math.round(at - reply.handedAt)), written, dropped: Math.max(0, Math.floor(dropped)) }); } catch { /* a record only */ }
  }
  private answer(replyId: string, verdict: AddOnHold): void {
    const reply = this.replies.get(replyId);
    if (!reply || reply.answered || reply.deferred) return;
    if (this.waiting(reply)) { this.defer(replyId, reply); return; }
    reply.answered = true;
    reply.hold?.(verdict);
  }
  /** A line is on its way for this leg: the user began it before her voice started (and not long ago), or it is already joined. */
  private waiting(reply: Reply): boolean {
    if (reply.asked) return false;
    if (reply.joining) return true;
    if (this.speechAt === null || this.speechAt < reply.handedAt) return false;
    return this.ports.now() - this.speechAt < Math.max(0, (this.ports.knobs ?? VOICE_CALL_KNOBS).addOn.holdMs);
  }
  /** Her voice started but the window stays open; it ends by the line's arrival, its settling, or the same wait as a silent written reply. */
  private defer(replyId: string, reply: Reply): void {
    reply.deferred = true;
    const ms = Math.max(0, (this.ports.knobs ?? VOICE_CALL_KNOBS).addOn.holdMs);
    reply.deferTimer = this.timers.set(() => { reply.deferTimer = null; this.release(replyId, reply); }, ms);
  }
  private release(replyId: string, reply: Reply): void {
    if (reply.deferTimer != null) { this.timers.clear(reply.deferTimer); reply.deferTimer = null; }
    reply.deferred = false; reply.joining = false;
    if (this.replies.get(replyId) !== reply || reply.answered) return;
    reply.answered = true;
    reply.hold?.('voiced');
  }
  private call(owner: string): boolean { try { return this.ports.inCall(owner) === true; } catch { return false; } }
}
