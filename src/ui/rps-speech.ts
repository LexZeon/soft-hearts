/**
 * G1 猜拳, pet window: her words in a game go where all her words go. So a line (`say` in the host's view) is shown in the ordinary answer
 * bubble (PetUI showAnswer / finishAnswer, like her other unprompted lines) and read by the ordinary voice with the line
 * as its reply id (the same speakable-text step skips bracketed actions, Bailian or system). Then the host hears `said`
 * and the game goes on. While a chat reply runs or the user is typing, the line is skipped and reported at once as not
 * shown (`skipped`: the host does not count it as said). A line still being read when its game ends, a new game opens or
 * a newer line comes is revoked here: the voice stops, the bubble ends, it is reported once (Codex T-112 round 028).
 * Nothing here archives: her game lines are not chat history (docs/claude/2026-11-03-rps-five-fixes.md).
 */
import type { AppSettings } from '../../shared/contracts';
import type { RpsSay, RpsView } from '../../shared/rps';
import { rpsReadMs } from '../../shared/rps-voice';
import type { SpeechRequestContext } from '../../shared/tts';

export interface RpsSayPorts {
  /** She may take the bubble now: no chat reply running, nothing typed, the pet shown. */
  free(): boolean;
  voiceOn(): boolean;
  /** The ordinary bubble: show `text` as reply `id`, expecting speech when the voice is on. */
  show(id: string, text: string, expectsSpeech: boolean): void;
  /** The ordinary voice: read `text` as reply `id`; settles when done or failed. */
  speak(id: string, text: string): Promise<void>;
  /** Reading reply `id` ended (the bubble fades as usual). */
  ended(id: string): void;
  /** Stop reading reply `id` now (it is the voice's current playback: its `speak` has not settled). */
  stop?(id: string): void;
  wait?(ms: number): Promise<void>;
}

/** The line being shown and read: the game view it belongs to, whether it went to the voice. */
interface Presenting { id: string; viewId: string; voice: boolean; over: boolean }

/** Shows and reads each new line once, then reports it: `shown` true once it was in the bubble, false when it was skipped. */
export class RpsSpeech {
  private readonly seen: string[] = [];
  private current: Presenting | null = null;
  constructor(private readonly ports: RpsSayPorts, private readonly done: (id: string, shown: boolean) => void) {}

  /** Every view from the host (older revisions were already filtered out). */
  view(view: RpsView | null): void {
    const current = this.current, say = view?.say;
    // Its game ended, a new one opened, or a newer line came: the line still being read goes now. The same game moving on
    // without the line does not cut her off (the host's hold ran out; she finishes the sentence).
    if (current && (!view || view.id !== current.viewId || (say && say.id !== current.id))) this.revoke(current);
    if (!view || !say || this.seen.includes(say.id)) return;
    this.seen.push(say.id);
    if (this.seen.length > 64) this.seen.shift();
    void this.present(say, view.id);
  }

  private async present(say: RpsSay, viewId: string): Promise<void> {
    const ports = this.ports;
    let free = false, voice = false;
    try { free = ports.free(); voice = free && ports.voiceOn(); } catch { free = false; }
    if (!free) { this.report(say.id, false); return; }
    try { ports.show(say.id, say.text, voice); } catch { this.report(say.id, false); return; }
    const presenting: Presenting = { id: say.id, viewId, voice, over: false };
    this.current = presenting;
    try {
      if (voice) await ports.speak(say.id, say.text);
      else await (ports.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(rpsReadMs(say.text));
    } catch { /* A failed voice still lets the game go on; the bubble stays as usual. */ }
    if (presenting.over) return; // Revoked while it was read: already ended and reported.
    this.finish(presenting);
  }

  private revoke(presenting: Presenting): void {
    if (presenting.voice) { try { this.ports.stop?.(presenting.id); } catch { /* The next playback stops it anyway. */ } }
    this.finish(presenting);
  }

  /** The line's reading is over (finished or revoked): the bubble ends as usual, the host hears it once. */
  private finish(presenting: Presenting): void {
    presenting.over = true;
    if (this.current === presenting) this.current = null;
    if (presenting.voice) { try { this.ports.ended(presenting.id); } catch { /* The bubble keeps its own timer. */ } }
    this.report(presenting.id, true);
  }

  private report(id: string, shown: boolean): void { try { this.done(id, shown); } catch { /* The host's hold runs out by itself. */ } }
}

/** What the pet window's src/main.ts hands over: its PetUI, its speech and its settings. */
export interface PetSayDeps {
  ui(): { showAnswer(text: string, streaming?: boolean, replyId?: string): unknown; finishAnswer(text?: string, replyId?: string, expectsSpeech?: boolean, preservePresentation?: boolean): void;
    endAnswerSpeech(id: string): void } | null | undefined;
  speech: { speak(text: string, config: AppSettings['voice'], context?: SpeechRequestContext): Promise<void>; stop?(): void };
  voice(): AppSettings['voice'];
  free(): boolean;
}
/** The ordinary bubble and voice, the same calls her other unprompted lines use (ambient comments, the inner loop). */
export function petSayPorts(deps: PetSayDeps): RpsSayPorts {
  return {
    free: () => !!deps.ui() && deps.free(),
    voiceOn: () => deps.voice().enabled === true,
    show: (id, text, expectsSpeech) => { const ui = deps.ui(); if (!ui) throw new Error('no pet bubble'); ui.showAnswer(text, true, id); ui.finishAnswer(text, id, expectsSpeech, true); },
    speak: (id, text) => deps.speech.speak(text, deps.voice(), { replyId: id }),
    ended: id => { deps.ui()?.endAnswerSpeech(id); },
    // Only called while this line's own `speak` has not settled, so the playback it stops is this line's (a newer
    // playback would already have stopped it and settled it).
    stop: () => { deps.speech.stop?.(); },
  };
}
