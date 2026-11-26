/**
 * I-209 step 4 (docs/claude/2026-11-24-i209-step4.md): a character's two calls in a chime-in on the full-screen stage, each her own:
 *
 *  - ask: her haiku reads her card's persona (as context) and the facts (facts.ts) and says yes or no.
 *  - speak: her line with her chat model (her whole card, her language, her mood, what was said on stage lately from her own archive, the
 *    same perception facts everyone has); she may say nothing ({"text":""}). Her line goes into HER bubble and is archived ONCE into her
 *    memory; a dropped (aborted) round never shows or archives.
 *
 * Stage voice: one voice at a time,
 * nothing lost, nothing doubled.
 *  - Her line waits until the stage is quiet: nothing else said or read (free) and no voice sounding (speaking), and that has lasted a
 *    moment (CHIME_SETTLE_MS: a gap between two sentences of someone's reading is not quiet). Someone speaking never drops her line: it
 *    waits as long as they speak (CHIME_FREE_MS is only a bound for a stage that never comes free at all).
 *  - Her voice reads it only once her bubble is proven on screen (`proven`: what is said must be what was shown), then the companion window
 *    reads it in HER card's voice (`voice`). The next line waits until her voice has ended.
 *  - The user's new turn (or leaving full screen) while she reads it: her reading stops (`cut`), as talking over her ends a reply's reading,
 *    so the reply to the user never sounds over her. A newer line of someone else cannot come while she speaks (it waits as hers did).
 *  - Every way it ends is a closed word for the journal: said, quiet, dropped (superseded before it showed), failed (her call failed),
 *    unreadable (her answer was not one line), busy (the stage never came free), not-shown (her bubble could not take it, or she left).
 * Modeled on the watch-facts turn (electron/senses/watch-continuity/facts-turn.ts). The Claude calls are ports (model.ts in the wiring).
 */
import { randomUUID } from 'node:crypto';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { withSpeechLanguage } from '../../../shared/brain/chat-language';
import { parseSenseLine } from '../../../shared/senses';
import { chimeDecisionPrompt, chimeLinePrompt, parseChimeDecision, type ChimeFacts } from './facts';
import type { ChimeLineOutcome } from './chime-in';

export interface ChimeTurnPorts {
  /** The chat model setting when chat runs on Claude, else null (then nothing is asked). */
  chatModel(): string | null;
  /** Her card: persona, language habits, speech language. */
  character(id: string): { persona: string; language?: string; speech?: CardLanguage } | null;
  /** Her own mood line (CompanionService mood chatContext for her). */
  mood(id: string): string;
  /** What was said on stage lately, from her own archive (names in it). */
  history(id: string): string;
  /** The perception facts everyone on stage reads (perceive.ts); '' when none. */
  sight?(id: string): string;
  /** Claude is available. */
  available(): boolean;
  decide(prompt: string, signal: AbortSignal): Promise<string>;
  line(prompt: string, model: string, signal: AbortSignal): Promise<string>;
  /** Nothing else is said or read now, no turn of the user's under way, the user not typing. */
  free(): boolean;
  /** She is still on stage. */
  onStage(id: string): boolean;
  /** Into her bubble (her window; the stage floor knows it is hers); false when it could not be shown. */
  show(id: string, lineId: string, text: string): boolean;
  /** Her bubble with this line is proven on screen (her page painted it). Absent: no proof is asked for. */
  proven?(lineId: string, text: string): boolean;
  /** The companion window reads it in her card's voice (held: never shown there); false when it could not be handed over. Absent: nothing is read. */
  voice?(id: string, lineId: string, text: string): boolean;
  /** A voice is reading now. */
  speaking(): boolean;
  /** Her reading of this line stops (the user's new turn talks over her). */
  cut?(lineId: string): void;
  /** Her line's floor ends (read through, or nothing to read). */
  release(lineId: string): void;
  /** One record of her line in her memory (it is then heard by the others); `current` rechecks inside the archive. */
  archive(id: string, lineId: string, text: string, at: number, current: () => boolean): Promise<unknown>;
  clock?(): number;
  sleep?(ms: number): Promise<void>;
  createId?(): string;
}

export const CHIME_CALL_MS = 30_000;
/** How long her written line may wait for the stage to come free. Only a bound: while someone speaks she waits (their reading is at most this long). */
export const CHIME_FREE_MS = 180_000;
/** The stage counts as quiet only after this long with nothing said, read or sounding (the gap between two sentences is not quiet). */
export const CHIME_SETTLE_MS = 600;
/** How long her bubble may take to be painted before her voice reads it (the look line's display wait). */
export const CHIME_SHOWN_MS = 5_000;
/** How long her voice may take to start, and to read her line, before the next one may speak anyway. */
export const CHIME_VOICE_START_MS = 4_000;
export const CHIME_VOICE_MS = 90_000;
const POLL_MS = 200;
/** The reasons ChimeIn aborts a round with: a newer line of someone else's ('line') leaves a line being read alone. */
export const CHIME_DROP_LINE = 'line';

export class ChimeTurns {
  constructor(private readonly ports: ChimeTurnPorts) {}

  private now(): number { return (this.ports.clock ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return this.ports.sleep ? this.ports.sleep(ms) : new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }); }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /** Her decision: true only for a clear yes; a failure is thrown (the round journals it 'failed'). */
  async ask(id: string, facts: ChimeFacts, signal: AbortSignal): Promise<boolean> {
    const character = this.safe(() => this.ports.character(id), null);
    if (!character || this.safe(() => this.ports.chatModel(), null) === null || !this.safe(() => this.ports.available(), false)) return false;
    const raw = await this.bounded(signal, inner => this.ports.decide(chimeDecisionPrompt(character.persona, facts), inner));
    return !signal.aborted && parseChimeDecision(raw);
  }

  /** Her line: shown, read and archived once, or nothing at all. */
  async speak(id: string, facts: ChimeFacts, signal: AbortSignal): Promise<ChimeLineOutcome> {
    if (signal.aborted) return 'dropped';
    const model = this.safe(() => this.ports.chatModel(), null), character = this.safe(() => this.ports.character(id), null);
    if (model === null || !character || !this.safe(() => this.ports.available(), false)) return 'failed';
    const prompt = withSpeechLanguage(chimeLinePrompt({ persona: character.persona, language: character.language, mood: this.safe(() => this.ports.mood(id), ''),
      history: this.safe(() => this.ports.history(id), ''), sight: this.safe(() => this.ports.sight?.(id) ?? '', ''), facts }), character.speech);
    let raw: string | null;
    try { raw = await this.bounded(signal, inner => this.ports.line(prompt, model, inner)); } catch { raw = null; }
    if (signal.aborted) return 'dropped';
    if (raw === null) return 'failed';
    const text = parseSenseLine(raw);
    if (text === null) return 'unreadable';
    if (text === 'quiet') return 'quiet';
    const here = () => this.safe(() => this.ports.onStage(id), false);
    const quiet = await this.quiet(() => !signal.aborted && here());
    if (signal.aborted) return 'dropped';
    if (!here()) return 'not-shown';
    if (!quiet) return 'busy';
    const lineId = `sense-chime-${(this.ports.createId ?? randomUUID)()}`.slice(0, 100), at = Math.floor(this.now());
    if (!this.safe(() => this.ports.show(id, lineId, text), false)) return 'not-shown';
    try { void Promise.resolve(this.ports.archive(id, lineId, text, at, here)).catch(() => undefined); } catch { /* the bubble stays; only the record is lost */ }
    // Her voice: once her bubble is proven on screen; then wait for it to start (a bound: the voice may be off) and to end. The user talking
    // over her (or leaving) ends her reading; the floor passes either way.
    const talkedOver = () => signal.aborted && signal.reason !== CHIME_DROP_LINE, live = () => here() && !talkedOver();
    const proven = () => this.safe(() => this.ports.proven ? this.ports.proven(lineId, text) : true, false);
    if (await this.until(proven, live, CHIME_SHOWN_MS) && live() && this.safe(() => this.ports.voice?.(id, lineId, text) ?? false, false)
      && await this.until(() => this.safe(() => this.ports.speaking(), false), live, CHIME_VOICE_START_MS))
      await this.until(() => !this.safe(() => this.ports.speaking(), true), live, CHIME_VOICE_MS);
    if (!live()) this.safe(() => this.ports.cut?.(lineId), undefined);
    this.safe(() => this.ports.release(lineId), undefined);
    return 'said';
  }

  /** The stage quiet for CHIME_SETTLE_MS (nothing said or read, no voice sounding); false when it never came within CHIME_FREE_MS or `current` ended. */
  private async quiet(current: () => boolean): Promise<boolean> {
    const deadline = this.now() + CHIME_FREE_MS;
    let since: number | null = null;
    for (;;) {
      if (!current()) return false;
      if (this.safe(() => this.ports.free(), false) && !this.safe(() => this.ports.speaking(), true)) {
        since ??= this.now();
        if (this.now() - since >= CHIME_SETTLE_MS) return true;
      } else since = null;
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
  }

  private async bounded(signal: AbortSignal, run: (inner: AbortSignal) => Promise<string>): Promise<string> {
    const inner = new AbortController(), stop = () => inner.abort();
    if (signal.aborted) inner.abort(); else signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, CHIME_CALL_MS); timer.unref?.();
    try { return await run(inner.signal); } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }

  private async until(done: () => boolean, current: () => boolean, ms: number): Promise<boolean> {
    const deadline = this.now() + ms;
    for (;;) {
      if (!current()) return false;
      if (done()) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
  }
}
