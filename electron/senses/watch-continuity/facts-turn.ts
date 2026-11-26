// 2026-11-24 her one immediate turn after the share was lost (docs/claude/2026-11-24-watch-turns-off.md, 续). Modeled on the sense router's second
// line (electron/senses/sense-router/host.ts): one tool-less call with the chat model (the facts in the prompt once, not kept), her line shown when she
// is free and archived ONCE after the companion window (or her Unbound bubble) reported it shown; a late, cancelled or other-character result never comes
// back. Brain interface: the one call is `line` (electron/senses/sense-router/model.ts senseLineWithClaude); nothing here knows Claude.
//
// She may choose to say nothing ({"text":""}); that is hers. 'undelivered' means nothing reached the user (not free in time, the call failed, a switch of
// character): the caller keeps the facts for her next turn.
import { randomUUID } from 'node:crypto';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { withSpeechLanguage } from '../../../shared/brain';
import { herVoiceRelaxed } from '../../../shared/voice';
import { parseSenseLine, watchLostOrigin, type SenseLineMessage } from '../../../shared/senses/sense-router';
import { lossPrompt } from './facts';
import type { WatchFactsOutcome } from './continuity';

export interface WatchFactsTurnPorts {
  /** The chat model setting when chat runs on Claude, else null (then nothing is asked). */
  chatModel(): string | null;
  /** The active card (id, persona, language habits, speech language). */
  character(): { id: string; persona: string; language: string; speech?: CardLanguage } | null;
  mood(): string;
  recentChat?(): string;
  /** The speech scope (character, provider, model): a change makes the turn stale. */
  identity(): string;
  /** Claude is available (a turn is not started while it is not). */
  available(): boolean;
  /** One tool-less call with the chat model (brain interface). */
  line(prompt: string, model: string, signal: AbortSignal): Promise<string>;
  /** She may speak now (shown, nothing of hers going on, the user not typing). */
  free(): boolean;
  /** To the companion window, or into her bubble while she is out in Unbound ('out'); false when it could not be delivered. */
  publish(message: SenseLineMessage): boolean | 'out';
  speechStyle(id: string): void;
  /** One record of her line; `current` rechecks inside the archive; `owner` (I-209 step 2): whose turn it was, so it goes into her memory only. */
  archive(message: SenseLineMessage, current: () => boolean, owner: string): Promise<void>;
  clock?: () => number;
  /** Tests inject; default setTimeout. */
  sleep?(ms: number): Promise<void>;
  createId?(): string;
}

/** Fallback bounds so an immediate turn never hangs: the call, the wait until she is free, the wait for the window to say it was shown. */
export const WATCH_TURN_CALL_MS = 30_000;
export const WATCH_TURN_FREE_MS = 30_000;
export const WATCH_TURN_SHOWN_MS = 15_000;
const POLL_MS = 250;

export class WatchFactsTurn {
  private running: { id: string; controller: AbortController; showing: { id: string; resolve(shown: boolean): void } | null } | null = null;
  private generation = 0;
  readonly counts = { started: 0, said: 0, quiet: 0, undelivered: 0 };

  constructor(private readonly ports: WatchFactsTurnPorts) {}

  private now(): number { return (this.ports.clock ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return this.ports.sleep ? this.ports.sleep(ms) : new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }); }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /** The facts go to her now; resolves how it ended. Only one runs at a time (another asked for meanwhile is 'undelivered'). */
  async say(facts: string, characterId: string | null): Promise<WatchFactsOutcome> {
    const model = this.safe(() => this.ports.chatModel(), null), character = this.safe(() => this.ports.character(), null);
    if (this.running || model === null || !character || character.id !== characterId || !this.safe(() => this.ports.available(), false)) return this.end('undelivered');
    const id = `sense-watch-${(this.ports.createId ?? randomUUID)()}`.slice(0, 100), identity = this.safe(() => this.ports.identity(), '');
    const run = { id, controller: new AbortController(), showing: null as { id: string; resolve(shown: boolean): void } | null };
    this.running = run; this.counts.started++;
    const generation = this.generation;
    const current = () => this.running === run && !run.controller.signal.aborted && generation === this.generation && this.safe(() => this.ports.identity(), '') === identity
      && this.safe(() => this.ports.character()?.id, null) === character.id;
    try {
      const prompt = withSpeechLanguage(lossPrompt({ persona: character.persona, language: character.language, mood: this.safe(() => this.ports.mood(), ''),
        recentChat: this.safe(() => this.ports.recentChat?.() ?? '', ''), facts, ...(herVoiceRelaxed() ? { relaxed: true } : {}) }), character.speech);
      const timer = setTimeout(() => run.controller.abort(), WATCH_TURN_CALL_MS); timer.unref?.();
      let raw: string | null;
      try { raw = await this.ports.line(prompt, model, run.controller.signal); } catch { raw = null; } finally { clearTimeout(timer); }
      if (!current()) return this.end('undelivered');
      const text = raw === null ? null : parseSenseLine(raw);
      if (text === null) return this.end('undelivered');
      if (text === 'quiet') return this.end('quiet');
      if (!await this.untilFree(current)) return this.end('undelivered');
      const message: SenseLineMessage = { id, text, origin: watchLostOrigin(id, Math.floor(this.now())) };
      if (!await this.show(run, message) || !current()) return this.end('undelivered');
      try { void this.ports.archive(structuredClone(message), current, character.id).catch(() => undefined); } catch { /* the bubble stays; only the record is lost */ }
      return this.end('said');
    } catch { return this.end('undelivered'); } finally { if (this.running === run) this.running = null; }
  }

  private end(outcome: WatchFactsOutcome): WatchFactsOutcome { this.counts[outcome === 'said' ? 'said' : outcome === 'quiet' ? 'quiet' : 'undelivered']++; return outcome; }

  private async untilFree(current: () => boolean): Promise<boolean> {
    const deadline = this.now() + WATCH_TURN_FREE_MS;
    for (;;) {
      if (!current()) return false;
      if (this.safe(() => this.ports.free(), false)) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
  }

  private show(run: NonNullable<WatchFactsTurn['running']>, message: SenseLineMessage): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (shown: boolean) => { if (timer) clearTimeout(timer); if (run.showing?.id === message.id) run.showing = null; resolve(shown); };
      run.showing = { id: message.id, resolve: finish };
      timer = setTimeout(() => finish(false), WATCH_TURN_SHOWN_MS); timer.unref?.();
      let sent = false;
      try { this.ports.speechStyle(message.id); sent = this.ports.publish(structuredClone(message)) !== false; } catch { sent = false; }
      if (!sent) finish(false);
    });
  }

  /** The companion window (or her Unbound bubble) reports her line `id` shown or not (the same `senseLineDone` channel the router uses). */
  done(fromWindow: boolean, value: unknown): boolean {
    const showing = this.running?.showing;
    if (fromWindow !== true || !showing || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.id !== showing.id || typeof record.shown !== 'boolean') return false;
    showing.resolve(record.shown);
    return true;
  }

  /** A new conversation, a switch of character, quit: what is running ends and never comes back. */
  cancel(): void { this.generation++; const run = this.running; this.running = null; run?.controller.abort(); run?.showing?.resolve(false); }
}
