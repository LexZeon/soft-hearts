/**
 * 边说边演 in a call. Typed chat has it since the
 * 2-4 steps; a call's leg now does too, the same way read-aloud does: her markers leave the stream first (also with the switch off, and in a
 * voice turn outside a call: only the words go on), the beats that fall before a shown piece of text go to the windows as 'beats' events, and
 * the windows play each one when the call's own reading reaches its sentence (the reading's start cues carry the progress: the same cues typed
 * read-aloud uses, because a call reads through the same plan, electron/voice/voice-call/streaming-speech.ts). Not here: the call's
 * interruption rule, the camera glance of every call turn, what is read (clean words only), the archive of the words, the mood.
 *
 * Electron-free; the brain's turn (electron/brain/speech-beats/turn.ts) comes in through `begin`, so this part never imports that one.
 */
import { SpeechBeatFilter, type SpeechBeat, type SpeechBeatsEvent } from '../../../shared/brain';

/** What a call leg needs of the brain's SpeechBeatTurn (it satisfies this as it is). */
export interface CallBeatTurn {
  /** `spoken`: in a call (every reply has words; no "only markers" reply). */
  sentence(spoken?: boolean): string;
  input(push: (type: 'delta', text: string) => void): (type: 'delta', text: string) => void;
  end(push: (type: 'delta', text: string) => void): void;
  shown(delta: string): void;
  complete(shownText: string): { beats: readonly SpeechBeat[]; performanceOnly: boolean; line: string; history: string | null };
  cancel(): void;
}

export interface CallBeatPorts {
  /** A turn for one reply; `on` is the switch as it is now (read once per leg). */
  begin(on: boolean, send: (event: SpeechBeatsEvent) => void): CallBeatTurn;
  /** The switch 「边说边演」 (stable build: off until the user turns it on). */
  enabled(): boolean;
  /** A finished reply that had beats goes in the beats file (its grey line, and for the long window); never throws into the call. */
  record(scope: unknown, replyId: string, outcome: { beats: readonly SpeechBeat[]; line: string; performanceOnly: boolean }): void;
}

/**
 * One leg's beats. `call`: this leg is read while it streams (a call); anything else only filters, as before (no events, no record, no prompt line).
 * Without ports (a test that does not give them) it also only filters.
 */
export class CallBeats {
  private readonly turn: CallBeatTurn | null;
  private readonly filter = new SpeechBeatFilter();
  private done = false;

  constructor(private readonly ports: CallBeatPorts | undefined, call: boolean, send: (event: SpeechBeatsEvent) => void) {
    let on = false;
    try { on = call && !!ports && ports.enabled() === true; } catch { on = false; }
    this.turn = call && ports ? ports.begin(on, send) : null;
  }

  /** The line added to this leg's persona (she may write the markers); empty when the switch is off or this is not a call. */
  sentence(): string { return this.turn?.sentence(true) ?? ''; }

  /** The stream's push: her markers leave first; the clean words go on. */
  input(push: (type: 'delta', text: string) => void): (type: 'delta', text: string) => void {
    if (this.turn) return this.turn.input(push);
    return (type, text) => { const clean = this.filter.push(typeof text === 'string' ? text : '').text; if (clean) push(type, clean); };
  }

  /** The stream ended without being stopped: what the filter held for a marker that never closed is let out. */
  end(push: (type: 'delta', text: string) => void): void {
    if (this.turn) { this.turn.end(push); return; }
    const rest = this.filter.end().text;
    if (rest) push('delta', rest);
  }

  /** A piece of words about to be shown (and read): the beats before it go out first. */
  shown(text: string): void { this.turn?.shown(text); }

  /**
   * The reply finished: the rest of its beats and the grey line of a performance-only one go out; the file entry is made under `fileAs` (the archive's turn
   * id: an utterance is one turn however many legs answered it, so only its first leg is filed: null for the later ones, whose words sit after it).
   * `scope`: the chat archive's scope.
   */
  complete(shownText: string, scope: unknown, fileAs: string | null): void {
    if (!this.turn || this.done) return;
    this.done = true;
    const outcome = this.turn.complete(shownText);
    if (fileAs && outcome.beats.length) { try { this.ports?.record(scope, fileAs, outcome); } catch { /* the file only keeps what her long window and the grey line need */ } }
  }

  /** Stopped, merged into the next sentences, failed, or the call moved on: nothing more is sent. */
  cancel(): void { this.done = true; this.turn?.cancel(); }
}
