import { randomUUID } from 'node:crypto';
import type { MoodChannel } from '../../shared/mood';
import { MOOD_JUDGE_KNOBS, type MoodJudgeKnobs } from '../../shared/behaviors/mood-judge/knobs';
/** I-037: the reaction host's mood lifts (electron/reactions/host.ts REACTION_LIFT_PREFIX). */
const REACTION_LIFT_PREFIX = 'reaction-';
import {
  MOOD_JUDGE_LIFT_PREFIX, MOOD_JUDGE_SYSTEM_PROMPT, batchDueAt, boundMoodJudgement, liftDelta, mergeMoodNote, mergeNote, mergeUserText,
  moodJudgeDay, moodJudgePrompt, moodJudgeReason, opusJudged, parseMoodJudgeAnswer, watchMoodJudge,
  type MoodJudgeCorrection, type MoodJudgeFrame, type MoodJudgeWatchState,
} from '../../shared/behaviors/mood-judge/choose';
import {
  moodJudgeDailyCap,
  type MoodJudgeAsk, type MoodJudgeItem, type MoodJudgeMoodNote, type MoodJudgeNote, type MoodJudgeNow, type MoodJudgeOutcome,
  type MoodJudgeView, type MoodJudgeWhy,
} from '../../shared/behaviors/mood-judge/interface';

export interface MoodJudgeTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
/** Why nothing is asked now (checked when a batch is due): she sleeps, a developer test mood, the pet hidden, Claude down, 自动表现 off. */
export type MoodJudgeQuiet = 'asleep' | 'test-mood' | 'hidden' | 'unavailable' | 'expressions-off';
/** The switch, the day's calls and the day's messages (electron/mood-judge/store.ts MoodJudgeStore). Without the message count the
 * limit stays at the base. */
export interface MoodJudgeSwitchStore {
  readonly enabled: boolean; today(day: string): number; noteCall(day: string): number;
  chatsToday?(day: string): number; noteChat?(day: string): number;
}

export interface MoodJudgeHostOptions {
  /** haiku's one short call (electron/inner-loop/model.ts quickLineWithClaude, its text). */
  ask: MoodJudgeAsk;
  store: MoodJudgeSwitchStore;
  /** The current character's "此刻", or null (no character yet). */
  now(): MoodJudgeNow | null;
  /** The first reason not to ask now, or null. */
  quiet(): MoodJudgeQuiet | null;
  /** Her reply is still being written (or spoken): wait, never compete with her first character. */
  busy(): boolean;
  /** MoodHost.lift: added to the numbers she has now (not an interaction, no boredom reset, no face of its own). */
  apply(lift: { id: string; delta: Partial<Record<MoodChannel, number>>; reason: string; context: 'neutral' }, characterId: string): void;
  /** Only then is anything kept for the developer panel (memory only). */
  developerMode(): boolean;
  /**
   * I-037: true while 新的反应方式 is on. Its one haiku call per message already gives the
   * message's mood, so the judge leaves the user's message, its chat event, her reply's tail and the reaction lifts alone (games,
   * her own lines, sleep, silences and the rest it still reads).
   */
  skipMessages?(): boolean;
  /** The panel's line changed (developer mode only; coalesced to a later tick). */
  changed?(): void;
  knobs?: Partial<MoodJudgeKnobs>;
  clock?: () => number;
  timers?: MoodJudgeTimers;
  /** The local date key the day's count belongs to (tests). */
  localDate?(ms: number): string;
  /** Lift ids (tests); default a random UUID, so an id from an earlier run (kept in the mood state) is never reused. */
  id?(): string;
}

interface Batch {
  readonly id: string;
  readonly characterId: string;
  readonly openedAt: number;
  items: MoodJudgeItem[];
  dueAt: number;
  timer: unknown;
}
interface InFlight {
  readonly batch: Batch;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly afterOpus: boolean;
  timeout: unknown;
  done: boolean;
}

/**
 * I-027 心情调整员, host side (shared/behaviors/mood-judge/interface.ts has the contract, choose.ts the pure parts).
 *
 * While the user's switch is off nothing is collected and nothing is asked: every entry point returns at once. On: what happened
 * is merged into one batch; when it is due (knobs.gatherMs after it opened, knobs.spacingMs after the last call) and none of the
 * quiet rules hold, haiku is asked once, in the background; one call at a time. Its answer, bounded, is added to her numbers now
 * through MoodHost.lift. A batch is used at most once; a character switch, falling asleep, a test mood, a timeout or a batch older
 * than knobs.staleMs drops it, and nothing is ever retried.
 */
export class MoodJudgeHost {
  private batch: Batch | null = null;
  private inflight: InFlight | null = null;
  private lastCallAt: number | null = null;
  private watchState: MoodJudgeWatchState | null = null;
  private herLine: { characterId: string; timer: unknown } | null = null;
  private readonly history = new Map<string, MoodJudgeCorrection[]>();
  private readonly applied = new Set<string>();
  private readonly whys: MoodJudgeWhy[] = [];
  private notifyHandle: unknown = null;
  private disposed = false;
  private seq = 0;
  private readonly knobs: MoodJudgeKnobs;
  private readonly clock: () => number;
  private readonly timers: MoodJudgeTimers;
  /** Counts for tests. */
  readonly stats = { asked: 0, applied: 0, dropped: 0 };

  constructor(private readonly options: MoodJudgeHostOptions) {
    this.knobs = { ...MOOD_JUDGE_KNOBS, ...options.knobs };
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  private get on(): boolean { return !this.disposed && this.safe(() => this.options.store.enabled === true, false); }
  /** I-037: 新的反应方式 is on (its haiku call gives each message's mood). */
  private skipping(): boolean { return this.safe(() => this.options.skipMessages?.() === true, false); }
  private day(ms: number): string { return (this.options.localDate ?? moodJudgeDay)(ms); }
  /** Today's limit as of now (the switch panel shows it). */
  capToday(): number { return this.cap(this.day(this.clock())); }
  /** Today's limit: the base plus a little for each message today, never above the maximum. */
  private cap(day: string): number { return moodJudgeDailyCap(this.knobs, this.safe(() => this.options.store.chatsToday?.(day) ?? 0, 0)); }

  // ---------------------------------------------------------------- what happened

  /** An accepted mood change (MoodHost.setJudgeObserver). The judge's own lift is never an event. */
  noteMood(note: MoodJudgeMoodNote): void {
    if (!this.on || !note || typeof note.id !== 'string' || note.id.startsWith(MOOD_JUDGE_LIFT_PREFIX) || typeof note.characterId !== 'string') return;
    // The user's message (not a game's, not her tail) answers her proactive line.
    if (note.type === 'chat' && note.reason !== '和用户玩了猜拳' && this.herLine?.characterId === note.characterId) this.answerHerLine(true);
    if (this.skipping() && (note.type === 'chat' || note.type === 'appraisal' || note.id.startsWith(REACTION_LIFT_PREFIX))) return;
    const at = this.clock();
    this.add(note.characterId, items => mergeMoodNote(items, note, at));
  }

  /** The user's message, the same text Opus gets (main.ts chat entry and voice). Cut to knobs.userTextChars; memory only, until the call. */
  userText(id: string, text: unknown, voice = false): void {
    if (!this.on || typeof id !== 'string' || !id || this.skipping()) return;
    // Today's limit grows with the messages she got today; only the count is kept.
    this.safe(() => this.options.store.noteChat?.(this.day(this.clock())), 0);
    // The character the last view showed (free); building "此刻" here would add work on the send path before her first character.
    const characterId = this.watchState?.characterId ?? this.safe(() => this.options.now()?.characterId ?? null, null);
    if (!characterId) return;
    const at = this.clock();
    this.add(characterId, items => mergeUserText(items, id, text, voice, at, this.knobs.userTextChars));
  }

  /** A game's result, her line said aloud, and what watch() saw. */
  note(note: MoodJudgeNote): void {
    if (!this.on || !note || typeof note.characterId !== 'string') return;
    if (note.kind === 'her-line') {
      this.clearHerLine();
      const timer = this.timers.set(() => { if (this.herLine?.timer === timer) this.answerHerLine(false); }, Math.max(0, this.knobs.herLineAnswerMs));
      this.herLine = { characterId: note.characterId, timer };
    }
    const at = this.clock();
    this.add(note.characterId, items => mergeNote(items, note, at));
  }

  /**
   * Every published mood view, as a frame (electron/mood-judge/wiring.ts moodJudgeFrame). The state is followed even while the
   * switch is off, so turning it on never turns old changes into news. Never applies anything itself.
   */
  watch(frame: MoodJudgeFrame): void {
    if (this.disposed || !frame || typeof frame.characterId !== 'string' || !frame.characterId) return;
    const step = watchMoodJudge(this.watchState, frame, this.knobs);
    this.watchState = step.state;
    // Another character or her falling asleep: the open batch and a call still running are dropped at once (the call is stopped).
    if (step.switched) { this.dropBatch('character'); this.clearHerLine(); if (this.inflight) this.finish(this.inflight, 'character'); }
    if (step.fellAsleep) { this.dropBatch('asleep'); if (this.inflight) this.finish(this.inflight, 'asleep'); }
    for (const note of step.notes) this.note(note);
  }

  // ---------------------------------------------------------------- the switch, the panel

  /** The switch changed (the store already holds it). Off: the open batch and any call still running are dropped. */
  switched(): void {
    if (this.on) return;
    this.dropBatch('off');
    if (this.inflight) this.finish(this.inflight, 'off');
    this.clearHerLine();
    this.notify();
  }

  /** The developer panel's view (developer mode only; memory only, no words). */
  view(): MoodJudgeView | null {
    if (!this.safe(() => this.options.developerMode(), false)) return null;
    const day = this.day(this.clock()), today = this.safe(() => this.options.store.today(day), 0), cap = this.cap(day);
    return { enabled: this.on, today, cap, capReached: today >= cap, recent: this.whys.map(why => structuredClone(why)) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.dropBatch('off');
    if (this.inflight) this.finish(this.inflight, 'off');
    this.clearHerLine();
    this.disposed = true;
    if (this.notifyHandle !== null) { this.timers.clear(this.notifyHandle); this.notifyHandle = null; }
  }

  // ---------------------------------------------------------------- batching

  private add(characterId: string, merge: (items: MoodJudgeItem[]) => MoodJudgeItem[]): void {
    if (this.batch && this.batch.characterId !== characterId) this.dropBatch('character');
    if (!this.batch) {
      const openedAt = this.clock();
      const batch: Batch = { id: String(++this.seq), characterId, openedAt, items: [], dueAt: batchDueAt(openedAt, this.lastCallAt, this.knobs), timer: null };
      this.batch = batch;
      this.schedule(batch, batch.dueAt);
    }
    try { this.batch.items = merge(this.batch.items); } catch { /* A note that does not fit changes nothing. */ }
  }

  private schedule(batch: Batch, at: number): void {
    if (batch.timer !== null) this.timers.clear(batch.timer);
    batch.timer = this.timers.set(() => { batch.timer = null; this.due(batch); }, Math.max(0, at - this.clock()));
  }

  private dropBatch(outcome: MoodJudgeOutcome): void {
    const batch = this.batch;
    if (!batch) return;
    this.batch = null;
    if (batch.timer !== null) { this.timers.clear(batch.timer); batch.timer = null; }
    this.stats.dropped++;
    this.record({ at: this.clock(), events: batch.items.length, outcome });
  }

  /** The batch is due: ask now, wait a little (her reply is still coming, another call runs), or drop it. */
  private due(batch: Batch): void {
    if (this.batch !== batch) return;
    if (!this.on) { this.dropBatch('off'); return; }
    if (!batch.items.length) { this.batch = null; return; }
    // Reading her view may publish it, and watch() may drop this very batch (she fell asleep, another character): check again after.
    const now = this.safe(() => this.options.now(), null);
    if (this.batch !== batch) return;
    if (!now || now.characterId !== batch.characterId) { this.dropBatch('character'); return; }
    const quiet = this.safe(() => this.options.quiet(), 'unavailable' as MoodJudgeQuiet);
    if (this.batch !== batch) return;
    if (quiet) { this.dropBatch(quiet); return; }
    const at = this.clock();
    if (this.safe(() => this.options.store.today(this.day(at)), Infinity) >= this.cap(this.day(at))) { this.dropBatch('quota'); return; }
    const spaced = this.lastCallAt === null ? -Infinity : this.lastCallAt + this.knobs.spacingMs;
    if (this.inflight || this.safe(() => this.options.busy(), true) || at < spaced) {
      if (at - batch.dueAt > this.knobs.staleMs) { this.dropBatch('stale'); return; }
      this.schedule(batch, Math.max(at + this.knobs.busyRecheckMs, spaced));
      return;
    }
    this.send(batch, now, at);
  }

  private send(batch: Batch, now: MoodJudgeNow, at: number): void {
    this.batch = null; // What happens from here on is the next batch.
    const afterOpus = opusJudged(batch.items);
    let prompt: string;
    try { prompt = moodJudgePrompt(now, batch.items, this.knobs); } catch { this.stats.dropped++; this.record({ at, events: batch.items.length, outcome: 'error' }); return; }
    const flight: InFlight = { batch, startedAt: at, controller: new AbortController(), afterOpus, timeout: null, done: false };
    this.inflight = flight;
    this.lastCallAt = at;
    this.safe(() => this.options.store.noteCall(this.day(at)), 0);
    this.stats.asked++;
    flight.timeout = this.timers.set(() => this.finish(flight, 'timeout'), Math.max(0, this.knobs.timeoutMs));
    let call: Promise<string>;
    try { call = Promise.resolve(this.options.ask(prompt, MOOD_JUDGE_SYSTEM_PROMPT, flight.controller.signal)); }
    catch { this.finish(flight, 'error'); return; }
    void call.then(raw => this.answered(flight, raw), () => this.finish(flight, 'error'));
  }

  /** haiku answered: still the same character, awake, no test mood, not too old? Then the bounded correction, once. */
  private answered(flight: InFlight, raw: string): void {
    if (flight.done || this.inflight !== flight) return;
    const at = this.clock(), batch = flight.batch;
    if (!this.on) { this.finish(flight, 'off'); return; }
    const now = this.safe(() => this.options.now(), null);
    if (flight.done) return;
    if (!now || now.characterId !== batch.characterId) { this.finish(flight, 'character'); return; }
    const quiet = this.safe(() => this.options.quiet(), null);
    if (flight.done) return;
    if (quiet === 'asleep' || quiet === 'test-mood' || quiet === 'expressions-off') { this.finish(flight, quiet); return; }
    if (at - flight.startedAt > this.knobs.staleMs || at < flight.startedAt) { this.finish(flight, 'stale'); return; }
    const answer = parseMoodJudgeAnswer(raw);
    if (!answer) { this.finish(flight, 'invalid'); return; }
    const history = this.history.get(batch.characterId) ?? [];
    const bounded = boundMoodJudgement(answer, { afterOpus: flight.afterOpus, history, at }, this.knobs);
    const base = { why: answer.why, fits: answer.fits, confidence: answer.confidence, ...(flight.afterOpus ? { afterOpus: true } : {}) };
    if (!bounded) { this.finish(flight, 'low-confidence', base); return; }
    const lift = liftDelta(bounded, now.sensitivity);
    if (!Object.keys(lift).length || this.applied.has(batch.id)) { this.finish(flight, 'nothing', base); return; }
    this.applied.add(batch.id);
    if (this.applied.size > 256) this.applied.delete(this.applied.values().next().value!);
    try {
      // "neutral": a correction is no moment of its own (no face, no supportive afterglow on the label, Opus's 话题情境 untouched).
      this.options.apply({ id: `${MOOD_JUDGE_LIFT_PREFIX}${this.options.id?.() ?? randomUUID()}`, delta: lift, reason: moodJudgeReason(answer.why), context: 'neutral' }, batch.characterId);
    } catch { this.finish(flight, 'error', base); return; }
    // Corrections add to the numbers she has now; the hour's net and a quick reversal are judged on what was asked to move.
    const corrections = [...history.filter(entry => at - entry.at < 3_600_000), { at, delta: { ...bounded } }];
    this.history.set(batch.characterId, corrections.slice(-64));
    this.stats.applied++;
    this.finish(flight, 'applied', { ...base, delta: { ...bounded } });
  }

  private finish(flight: InFlight, outcome: MoodJudgeOutcome, extra: Partial<MoodJudgeWhy> = {}): void {
    if (flight.done) return; // The first result counts; a late one changes nothing.
    flight.done = true;
    if (flight.timeout !== null) { this.timers.clear(flight.timeout); flight.timeout = null; }
    if (outcome !== 'applied' && !flight.controller.signal.aborted) flight.controller.abort();
    if (this.inflight === flight) this.inflight = null;
    if (outcome !== 'applied') this.stats.dropped++;
    this.record({ ...extra, at: flight.startedAt, events: flight.batch.items.length, outcome, ms: Math.max(0, this.clock() - flight.startedAt) });
  }

  // ---------------------------------------------------------------- her line answered or not

  private answerHerLine(answered: boolean): void {
    const pending = this.herLine;
    if (!pending) return;
    this.clearHerLine();
    this.note({ kind: 'her-line-answer', characterId: pending.characterId, answered });
  }
  private clearHerLine(): void {
    if (this.herLine) { this.timers.clear(this.herLine.timer); this.herLine = null; }
  }

  // ---------------------------------------------------------------- the panel's record

  private record(why: MoodJudgeWhy): void {
    if (!this.safe(() => this.options.developerMode(), false)) return;
    this.whys.unshift(why);
    this.whys.length = Math.min(this.whys.length, Math.max(1, this.knobs.whyKept));
    this.notify();
  }

  private notify(): void {
    if (this.disposed || this.notifyHandle !== null || !this.options.changed) return;
    this.notifyHandle = this.timers.set(() => {
      this.notifyHandle = null;
      if (this.disposed) return;
      try { this.options.changed?.(); } catch { /* The panel line never disturbs her. */ }
    }, 0);
  }
}
