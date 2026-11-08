import { PAUSE_TALK_KNOBS, type PauseTalkKnobs } from '../../shared/behaviors/pause-talk/knobs';
import { PAUSE_TALK_SYSTEM_PROMPT, parsePauseTalkAnswer, pauseTalkBackground, pauseTalkPrompt } from '../../shared/behaviors/pause-talk/choose';
import type { InteractionBudget } from '../../shared/behaviors/interaction-budget/interface';
import type {
  PauseTalkAsk, PauseTalkCue, PauseTalkCut, PauseTalkFirstChar, PauseTalkNow, PauseTalkPlan, PauseTalkSkip, PauseTalkStatus, PauseTalkView, PauseTalkWhy,
} from '../../shared/behaviors/pause-talk/interface';

export interface PauseTalkTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface PauseTalkHostOptions {
  /** The small model's one short call (electron/inner-loop/model.ts quickLineWithClaude, its text). */
  ask: PauseTalkAsk;
  /** The switch (settings.voice.pauseTalk === true), read when a message arrives and again before a plan goes out. */
  enabled(): boolean;
  /** Claude answers now (electron/chat-availability.ts): otherwise nobody is asked. */
  available(): boolean;
  /** Her, now: read when haiku's call starts and again when its answer arrives (a switched character drops the answer). */
  now(): PauseTalkNow | null;
  /** To every window: this reply's plan (desk:pause-talk). */
  send(cue: PauseTalkCue): void;
  /** Only then is anything kept for the developer panel (memory only). */
  developerMode(): boolean;
  /** The panel's line changed (developer mode only). */
  changed?(): void;
  knobs?: Partial<PauseTalkKnobs>;
  /** Wall clock (ms). */
  clock?: () => number;
  timers?: PauseTalkTimers;
  /** The local date key for the day's call count. */
  localDate?(ms: number): string;
  /**
   * I-010 互动余额 (a lively card may use a little more, a quiet one less, regulated by
   * the budget), read each time. Whether this message asks haiku at all is one roll on room('pausePlan') (a quiet card asks less
   * often; asking spends); whether a plan keeps "wait for you, then go on alone" is one roll on room('continue') (kept, it spends; the
   * user cutting in during that reply gives it back). Omitted or null: every message asks and every wait is kept, as before.
   */
  budget?(): Pick<InteractionBudget, 'room' | 'spend' | 'refund'> | null;
  /** The budget's rolls (tests inject a seeded one). */
  random?: () => number;
}

interface WhyRecord { requestId: string; at: number; skipped: PauseTalkSkip | null; status: PauseTalkStatus | null; ms: number | null; plan: PauseTalkPlan | null; carried: number;
  waitDropped?: true }
interface Turn {
  readonly requestId: string;
  readonly characterId: string;
  readonly startedAt: number;
  /** Her reply so far, exactly as the windows got it (the protocol's visible deltas); kept only for "没说完的话". */
  text: string;
  status: PauseTalkStatus | null;
  controller: AbortController | null;
  timeout: unknown;
  starting: unknown;
  why: WhyRecord | null;
  /** I-010: this reply's plan kept a wait, paid from the budget (given back if the user cuts in during it). */
  continueSpent: boolean;
}

const MAX_TEXT = 20_000;
const MAX_FIRST_CHARS = 20;
const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * F7 停停说说, host side (shared/behaviors/pause-talk/interface.ts has the contract). Hooked in where the I-023 调度台 is: the chat
 * entry calls userTurn once per ordinary user message, and it returns at once; haiku's one call for this reply starts
 * knobs.startDelayMs later on a timer, so Opus's turn is written out first and the first character never waits. A newer message
 * aborts the call still running; a cancelled or failed reply, a switched character or the switch turned off drops the answer.
 * With the switch off nothing at all happens here: no call, no timer, no plan, no background, no text kept.
 */
export class PauseTalkHost {
  private turn: Turn | null = null;
  private readonly whys: WhyRecord[] = [];
  private readonly firstChars: PauseTalkFirstChar[] = [];
  private calls = { date: '', count: 0 };
  private notifyHandle: unknown = null;
  private disposed = false;
  private readonly knobs: PauseTalkKnobs;
  private readonly clock: () => number;
  private readonly timers: PauseTalkTimers;
  /** Counts for tests and the record. */
  readonly stats = { asked: 0, answered: 0, failed: 0, dropped: 0, sent: 0, carried: 0 };

  constructor(private readonly options: PauseTalkHostOptions) {
    this.knobs = { ...PAUSE_TALK_KNOBS, ...options.knobs };
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  private on(): boolean { return !this.disposed && this.safe(() => this.options.enabled() === true, false); }

  /**
   * An ordinary user message (the same text Opus gets). Returns at once: this turn's one line of background (her earlier reply's
   * unsaid part, when the window reported where the user cut in), or null. haiku, when asked at all, runs in the background.
   * `character` (her id now) is read only while the switch is on: off, nothing at all is looked at.
   */
  userTurn(requestId: string, text: unknown, cut: PauseTalkCut | null | undefined, character: string | (() => string)): string | null {
    if (this.disposed) return null;
    const previous = this.turn;
    this.supersede();
    this.turn = null;
    if (!this.on()) return null;
    const characterId = typeof character === 'function' ? this.safe(() => String(character() ?? ''), '') : String(character ?? '');
    let background: { line: string; chars: number } | null = null;
    // Only her latest reply, of the same character, which this host followed while the switch was on.
    if (cut && previous && cut.id === previous.requestId && previous.characterId === characterId)
      background = pauseTalkBackground(previous.text, cut.shown, this.knobs);
    if (background) this.stats.carried++;
    // I-010: the user cut into her earlier reply, so she never went on alone after its wait: that wait's spend comes back.
    if (cut && previous && cut.id === previous.requestId && previous.continueSpent) {
      previous.continueSpent = false;
      try { this.options.budget?.()?.refund(previous.characterId, `continue:${previous.requestId}`); } catch { /* Bookkeeping only. */ }
    }
    const now = this.clock();
    let skipped: PauseTalkSkip | null = null;
    if (!characterId) skipped = 'no-character';
    else if (!this.safe(() => this.options.available(), false)) skipped = 'unavailable';
    else if (!this.quotaLeft(now)) skipped = 'quota';
    else if (!this.budgetAllows(characterId, 'pausePlan')) skipped = 'budget';
    const turn: Turn = { requestId, characterId, startedAt: now, text: '', status: skipped ? null : 'pending', controller: null, timeout: null, starting: null, why: null,
      continueSpent: false };
    this.turn = turn;
    if (this.safe(() => this.options.developerMode(), false)) {
      turn.why = { requestId, at: now, skipped, status: turn.status, ms: null, plan: null, carried: background?.chars ?? 0 };
      this.whys.unshift(turn.why);
      this.whys.length = Math.min(this.whys.length, Math.max(1, this.knobs.whyKept));
      this.notify();
    }
    if (skipped) return background?.line ?? null;
    const controller = new AbortController();
    turn.controller = controller;
    turn.timeout = this.timers.set(() => this.finish(turn, 'timeout'), Math.max(0, this.knobs.timeoutMs));
    const userText = String(text ?? '');
    // Started later, on a timer: the chat handler that called this returns first and Opus's turn is written out before haiku's
    // process start holds the main thread. Never awaited by the chat turn.
    turn.starting = this.timers.set(() => {
      turn.starting = null;
      if (controller.signal.aborted || this.disposed || this.turn !== turn) return;
      const her = this.safe(() => this.options.now(), null);
      if (!her || her.characterId !== turn.characterId) { this.finish(turn, 'character'); return; }
      this.noteCall(this.clock());
      this.stats.asked++;
      try { this.options.budget?.()?.spend(turn.characterId, 'pausePlan', `pause:${turn.requestId}`); } catch { /* Bookkeeping never stops the call. */ }
      let call: Promise<string>;
      try { call = Promise.resolve(this.options.ask(pauseTalkPrompt(her, userText, this.knobs), PAUSE_TALK_SYSTEM_PROMPT, controller.signal)); }
      catch { this.finish(turn, 'error'); return; }
      void call.then(raw => this.answered(turn, raw), () => this.finish(turn, 'error'));
    }, Math.max(0, this.knobs.startDelayMs));
    return background?.line ?? null;
  }

  /** One visible piece of her reply (the same text the windows get), kept while the switch was on for this message. */
  delta(requestId: string, text: string): void {
    const turn = this.turn;
    if (!turn || turn.requestId !== requestId || typeof text !== 'string' || turn.text.length >= MAX_TEXT) return;
    turn.text = (turn.text + text).slice(0, MAX_TEXT);
  }

  /** Her reply was cancelled or failed: its plan is dropped (the call stops). Its text stays for a later cut. */
  cancel(requestId: string): void {
    const turn = this.turn;
    if (turn && turn.requestId === requestId) this.finish(turn, 'cancelled');
  }

  /** One reply's first visible character (electron/reply-latency.ts), for the developer panel: a number, the switch, whether it carried background. */
  noteFirstChar(ms: number | null, on: boolean, carried: boolean): void {
    if (this.disposed || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    this.firstChars.unshift({ at: this.clock(), ms: Math.round(ms), on: on === true, carried: carried === true });
    this.firstChars.length = Math.min(this.firstChars.length, MAX_FIRST_CHARS);
    this.notify();
  }

  /** The developer panel's view (copies; developer mode only, memory only). */
  view(): PauseTalkView | null {
    if (!this.safe(() => this.options.developerMode(), false)) return null;
    return { enabled: this.on(), why: this.whys.map(({ requestId: _id, ...why }) => structuredClone(why) as PauseTalkWhy), firstChar: this.firstChars.map(item => ({ ...item })) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.supersede();
    this.disposed = true;
    if (this.notifyHandle !== null) { this.timers.clear(this.notifyHandle); this.notifyHandle = null; }
    this.turn = null;
    this.whys.length = 0;
    this.firstChars.length = 0;
  }

  // ------------------------------------------------------------

  private answered(turn: Turn, raw: string): void {
    if (turn.status !== 'pending') return; // Voided, timed out or cancelled first: a late answer changes nothing.
    const plan = parsePauseTalkAnswer(raw, this.knobs);
    if (!plan) { this.finish(turn, 'bad-json'); return; }
    if (this.turn !== turn || !this.on()) { this.finish(turn, 'cancelled'); return; }
    const her = this.safe(() => this.options.now(), null);
    if (!her || her.characterId !== turn.characterId) { this.finish(turn, 'character'); return; }
    // I-010: "wait for you, and if you do not answer go on alone" is hers only while the budget has room for going on; without it
    // this reply does not stop to wait (its pauses stay). Kept, it spends (given back if the user cuts in, userTurn).
    let final = plan;
    if (plan.wait && this.options.budget) {
      if (this.budgetAllows(turn.characterId, 'continue')) {
        try { turn.continueSpent = this.options.budget()?.spend(turn.characterId, 'continue', `continue:${turn.requestId}`) === true; } catch { turn.continueSpent = false; }
      } else {
        final = { pauses: plan.pauses, wait: null };
        if (turn.why) turn.why.waitDropped = true;
      }
    }
    this.finish(turn, 'answered', final);
    try { this.options.send({ id: turn.requestId, pauses: final.pauses, wait: final.wait }); this.stats.sent++; } catch { /* A closed window misses it. */ }
  }

  /** I-010: one roll on the budget's room for `kind` (true without a budget, or when it cannot be read: as before). */
  private budgetAllows(characterId: string, kind: 'pausePlan' | 'continue'): boolean {
    const budget = this.safe(() => this.options.budget?.() ?? null, null);
    if (!budget) return true;
    let factor = 1;
    try { factor = budget.room(characterId, kind).factor; } catch { return true; }
    if (!Number.isFinite(factor)) return true;
    let roll = 0;
    try { roll = (this.options.random ?? Math.random)(); } catch { roll = 0; }
    return roll < Math.min(1, Math.max(0, factor));
  }

  private supersede(): void {
    const turn = this.turn;
    if (turn && turn.status === 'pending') this.finish(turn, 'superseded');
  }

  private finish(turn: Turn, status: Exclude<PauseTalkStatus, 'pending'>, plan: PauseTalkPlan | null = null): void {
    if (turn.status !== 'pending') return; // The first result counts.
    turn.status = status;
    if (turn.timeout !== null) { this.timers.clear(turn.timeout); turn.timeout = null; }
    if (turn.starting !== null) { this.timers.clear(turn.starting); turn.starting = null; } // Voided before it started: no call at all.
    if (status !== 'answered' && turn.controller && !turn.controller.signal.aborted) turn.controller.abort();
    if (status === 'answered') this.stats.answered++;
    else if (status === 'bad-json' || status === 'error' || status === 'timeout') this.stats.failed++;
    else this.stats.dropped++;
    if (turn.why) {
      turn.why.status = status; turn.why.ms = Math.max(0, this.clock() - turn.startedAt); turn.why.plan = plan;
      this.notify();
    }
  }

  private quotaLeft(now: number): boolean {
    const today = (this.options.localDate ?? localDay)(now);
    if (this.calls.date !== today) this.calls = { date: today, count: 0 };
    return this.calls.count < this.knobs.callsPerDay;
  }
  private noteCall(now: number): void {
    const today = (this.options.localDate ?? localDay)(now);
    if (this.calls.date !== today) this.calls = { date: today, count: 0 };
    this.calls.count++;
  }

  /** The panel hears about it on a later tick (coalesced): userTurn runs inside the chat handler and never does panel work there. */
  private notify(): void {
    if (this.disposed || this.notifyHandle !== null || !this.options.changed) return;
    this.notifyHandle = this.timers.set(() => {
      this.notifyHandle = null;
      if (this.disposed) return;
      try { this.options.changed?.(); } catch { /* The panel line never disturbs a chat turn. */ }
    }, 0);
  }
}
