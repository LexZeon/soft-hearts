import { createHash } from 'node:crypto';
import { RPS_VOICE_SAFETY, RPS_VOICE_SYSTEM_PROMPT, parseRpsVoice, rpsMomentClass, rpsReusableLine, rpsVoiceChance, rpsVoicePrompt,
  type RpsMoment, type RpsMomentClass } from '../../shared/rps-voice';
import type { RpsStore } from './store';

/** The character as the voice needs it (a subset of RpsCharacterState). */
export interface RpsVoiceCharacter {
  persona: string;
  parameters: Parameters<typeof rpsVoiceChance>[0]['parameters'];
  snapshot: { primary: string };
  fatigue: Parameters<typeof rpsVoiceChance>[0]['fatigue'];
}
export interface RpsVoiceTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface RpsVoiceOptions {
  /**
   * One short call with the small model (electron/inner-loop/model.ts quickLineWithClaude, the inner loop's tier),
   * resolving to its text. Omitted: she is never asked, only her remembered lines are used.
   */
  quick?(prompt: string, systemPrompt: string, signal: AbortSignal): Promise<string>;
  /** Claude answers now (electron/chat-availability.ts). */
  available?(): boolean;
  /** Her language habits for this card (personalize-language context), or ''. */
  language?(): string;
  store: Pick<RpsStore, 'voiceOn' | 'noteVoiceCall' | 'noteSaid' | 'remembered' | 'remember'>;
  localDate(ms: number): string;
  clock: () => number;
  random: () => number;
  timers: RpsVoiceTimers;
}
/** A call that has not answered by then is given up (the moment is long gone). */
export const RPS_VOICE_TIMEOUT_MS = 8_000;

/** Her remembered lines are kept per card text: a changed card starts afresh. */
export function rpsVoiceCardKey(persona: string): string {
  return createHash('sha256').update(`soft-hearts-rps-voice/v1\n${persona}`).digest('hex').slice(0, 32);
}

/**
 * One line she may say at one moment. `text`: undefined while it is still coming; '' or null once she says nothing
 * (quiet, a refused answer, a failed call with nothing remembered); otherwise her words.
 */
export class RpsLine {
  text: string | null | undefined = undefined;
  source: 'live' | 'remembered' | null = null;
  private listeners: (() => void)[] = [];
  private stop: (() => void) | null = null;
  constructor(readonly moment: RpsMoment, readonly cardKey: string) {}
  get settled(): boolean { return this.text !== undefined; }
  settle(text: string | null, source: 'live' | 'remembered' | null): void {
    if (this.settled) return;
    this.text = text; this.source = text ? source : null; this.stop = null;
    const listeners = this.listeners; this.listeners = [];
    for (const listener of listeners) { try { listener(); } catch { /* One listener never blocks another. */ } }
  }
  onSettled(listener: () => void): void { if (this.settled) listener(); else this.listeners.push(listener); }
  /** Nobody waits for it any more: stop the call (its answer is dropped). */
  abort(): void { const stop = this.stop; this.stop = null; this.listeners = []; stop?.(); }
  /** @internal */ bind(stop: () => void): void { this.stop = stop; }
}

/**
 * G1 猜拳: whether she says something at a moment and getting her words (shared/rps-voice.ts has the rules). The host
 * asks as soon as a round is decided; nothing here touches a window.
 */
export class RpsVoice {
  private lastRecalled = new Map<string, string>();
  /** Diagnostics for tests and the record (counts only). */
  readonly stats = { calls: 0, live: 0, remembered: 0, quiet: 0 };
  constructor(private readonly options: RpsVoiceOptions) {}

  /** Decides whether she says something at this moment; when she does, starts getting the line. null: she stays quiet. */
  plan(input: { character: RpsVoiceCharacter; moment: RpsMoment; saidThisMatch: number; spokeLastRound: boolean; room?: number | null }): RpsLine | null {
    const { character, moment } = input, now = this.options.clock(), today = this.options.localDate(now);
    const counts = this.options.store.voiceOn(today);
    const chance = rpsVoiceChance({ moment, parameters: character.parameters, mood: character.snapshot.primary, fatigue: character.fatigue,
      saidThisMatch: input.saidThisMatch, spokeLastRound: input.spokeLastRound, saidToday: counts.said, room: input.room ?? null });
    if (!(this.options.random() < chance)) { this.stats.quiet++; return null; }
    const key = rpsVoiceCardKey(character.persona), kind = rpsMomentClass(moment), line = new RpsLine(moment, key);
    const quick = this.options.quick;
    let available = false;
    try { available = !!quick && this.options.available?.() !== false; } catch { available = false; }
    if (!quick || !available || counts.calls >= RPS_VOICE_SAFETY.callsPerDay) {
      const text = this.recall(key, kind);
      if (!text) { this.stats.quiet++; return null; }
      line.settle(text, 'remembered');
      return line;
    }
    this.options.store.noteVoiceCall(today);
    this.stats.calls++;
    const controller = new AbortController();
    const timeout = this.options.timers.set(() => controller.abort(), RPS_VOICE_TIMEOUT_MS);
    line.bind(() => { this.options.timers.clear(timeout); controller.abort(); });
    let prompt: string;
    try {
      prompt = rpsVoicePrompt({ persona: character.persona, language: this.safeLanguage(), mood: character.snapshot.primary, fatigue: character.fatigue, moment });
    } catch { this.options.timers.clear(timeout); line.settle(this.recall(key, kind), 'remembered'); return line; }
    void Promise.resolve().then(() => quick(prompt, RPS_VOICE_SYSTEM_PROMPT, controller.signal)).then(raw => {
      this.options.timers.clear(timeout);
      if (controller.signal.aborted) return;
      const text = parseRpsVoice(raw);
      // A refused or malformed answer: one of her own earlier lines if she has one, else nothing.
      if (text === null) line.settle(this.recall(key, kind), 'remembered');
      else line.settle(text, 'live');
    }, () => {
      this.options.timers.clear(timeout);
      if (!controller.signal.aborted) line.settle(this.recall(key, kind), 'remembered');
      else line.settle(null, null);
    });
    return line;
  }

  /** Her line reached the window: count it, and keep a live line that fits any round of its kind for days without the model. */
  said(line: RpsLine): void {
    const text = line.text;
    if (!text) return;
    const today = this.options.localDate(this.options.clock());
    this.options.store.noteSaid(today);
    if (line.source === 'live') {
      this.stats.live++;
      const kind = rpsMomentClass(line.moment);
      if (kind && rpsReusableLine(text)) this.options.store.remember(line.cardKey, kind, text);
    } else this.stats.remembered++;
  }

  /** One of her earlier lines for this kind of moment, not the one she used last time; null when she has none. */
  private recall(key: string, kind: RpsMomentClass | null): string | null {
    if (!kind) return null;
    const lines = this.options.store.remembered(key, kind);
    if (!lines.length) return null;
    const last = this.lastRecalled.get(`${key}:${kind}`), choices = lines.length > 1 ? lines.filter(line => line !== last) : lines;
    const text = choices[Math.min(choices.length - 1, Math.floor(this.options.random() * choices.length))];
    this.lastRecalled.set(`${key}:${kind}`, text);
    return text;
  }

  private safeLanguage(): string { try { return this.options.language?.() ?? ''; } catch { return ''; } }
}
