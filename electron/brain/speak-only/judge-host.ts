// I-098 B: when and how often the post-reply judge is asked (electron/brain/speak-only/rules.ts). One call per message at most, after
// her reply completed; the next message aborts a call still running (its answer is then never used); a call that takes longer
// than `timeoutMs` is aborted; a daily cap (memory only). Nothing is retried. Whether and how the answer moves her mood is the
// companion's (CompanionService, the tail's own path).
import { parseSpeakOnlyJudgment, speakOnlyJudgePrompt, SPEAK_ONLY_JUDGE_SYSTEM, type SpeakOnlyJudgeInput, type SpeakOnlyJudgment } from './judge';

/** Which haiku answered: the reactions' warm process (a second step on it) or a one-off call (electron/brain/speak-only/route.ts). */
export type SpeakOnlyVia = 'warm' | 'one-shot';
/** An answer that says which haiku gave it. */
export interface SpeakOnlyAnswer { text: string; via: SpeakOnlyVia }
/**
 * The small model's one call: prompt, fixed system prompt, abort signal → its text, or its text and which haiku answered
 * (electron/brain/speak-only/route.ts in the app: the reactions' warm haiku when it is there, else quickLineWithClaude).
 */
export type SpeakOnlyAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string | SpeakOnlyAnswer>;

export interface SpeakOnlyJudgeOptions {
  ask: SpeakOnlyAsk;
  timeoutMs?: number;
  dailyCap?: number;
  clock?: () => number;
  localDate?: (ms: number) => string;
}

/**
 * What one message's judge came to (never text):
 * - judged: a usable answer (`judgment`), and `raw` its text for the experiment's private record;
 * - unusable: answered, but the answer failed the tail's rules (or was low confidence);
 * - failed: the call threw or timed out; capped: today's cap was reached (no call);
 * - superseded: a newer message began (or the turn stopped being current) before the answer was used.
 */
export type SpeakOnlyOutcome =
  | { kind: 'judged'; judgment: SpeakOnlyJudgment; raw: string; ms: number; via?: SpeakOnlyVia }
  | { kind: 'unusable'; raw: string; ms: number; via?: SpeakOnlyVia }
  | { kind: 'failed'; ms: number }
  | { kind: 'capped' }
  | { kind: 'superseded' };

export class SpeakOnlyJudge {
  private latest: string | null = null;
  private controller: AbortController | null = null;
  private readonly asked = new Set<string>();
  private day = '';
  private count = 0;
  /** Counts for tests and the developer line. */
  readonly stats = { asked: 0, judged: 0, unusable: 0, failed: 0, capped: 0, superseded: 0 };

  constructor(private readonly options: SpeakOnlyJudgeOptions) {}

  /** A new message began: an earlier message's call still running is aborted, and its answer will not be used. */
  begin(id: string): void {
    if (this.latest !== id) { this.controller?.abort(); this.controller = null; }
    this.latest = id;
  }
  /** The message whose answer may still be used (the newest one begun). */
  isLatest(id: string): boolean { return this.latest === id; }

  /** Asks about message `id` once (a second call for the same id is 'superseded' and asks nothing). */
  async judge(id: string, input: SpeakOnlyJudgeInput): Promise<SpeakOnlyOutcome> {
    if (this.asked.has(id) || this.latest !== id) { this.stats.superseded++; return { kind: 'superseded' }; }
    this.asked.add(id);
    if (this.asked.size > 256) this.asked.delete(this.asked.values().next().value!);
    const clock = this.options.clock ?? Date.now;
    const day = (this.options.localDate ?? (ms => new Date(ms).toDateString()))(clock());
    if (day !== this.day) { this.day = day; this.count = 0; }
    if (this.count >= (this.options.dailyCap ?? 800)) { this.stats.capped++; return { kind: 'capped' }; }
    this.count++;
    this.stats.asked++;
    const controller = new AbortController();
    this.controller = controller;
    const started = clock();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    (timer as { unref?: () => void }).unref?.();
    let raw: string, via: SpeakOnlyVia | undefined;
    try {
      const answer = await this.options.ask(speakOnlyJudgePrompt(input), SPEAK_ONLY_JUDGE_SYSTEM, controller.signal);
      if (answer && typeof answer === 'object') { raw = answer.text; via = answer.via === 'warm' || answer.via === 'one-shot' ? answer.via : undefined; }
      else raw = answer;
    } catch {
      if (this.latest !== id) { this.stats.superseded++; return { kind: 'superseded' }; }
      this.stats.failed++; return { kind: 'failed', ms: clock() - started };
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
    const ms = clock() - started;
    if (this.latest !== id) { this.stats.superseded++; return { kind: 'superseded' }; }
    if (controller.signal.aborted) { this.stats.failed++; return { kind: 'failed', ms }; }
    const judgment = parseSpeakOnlyJudgment(typeof raw === 'string' ? raw : '', input.actions ?? []);
    if (!judgment) { this.stats.unusable++; return { kind: 'unusable', raw: String(raw ?? '').slice(0, 4000), ms, ...(via ? { via } : {}) }; }
    this.stats.judged++;
    return { kind: 'judged', judgment, raw: raw.slice(0, 4000), ms, ...(via ? { via } : {}) };
  }

  dispose(): void { this.controller?.abort(); this.controller = null; this.latest = null; }
}
