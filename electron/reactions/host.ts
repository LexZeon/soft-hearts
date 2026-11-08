import { randomUUID } from 'node:crypto';
import { MOOD_CHANNELS, type MoodLabel, type MoodValues } from '../../shared/mood';
import { moodJudgeDailyCap } from '../../shared/behaviors/mood-judge/interface';
import { moodJudgeDay } from '../../shared/behaviors/mood-judge/choose';
import type { Dispositions } from '../../shared/behaviors/reactions/dispositions';
import { WORD_EVENT_IDS, type ReactionEventId } from '../../shared/behaviors/reactions/events';
import { REACTION_KNOBS, REACTION_TABLE, type ReactionKnobs, type ReactionLevel, type ReactionRow } from '../../shared/behaviors/reactions/knobs';
import {
  MoodBlend, parseReactionAnswer, reactionPrompt, reactionSystemPrompt, scoreReactions, topPick, type ReactionTable,
} from '../../shared/behaviors/reactions/choose';
import type {
  MoodReactionNote, MoodReactionPort, ReactionAsk, ReactionBlock, ReactionDecider, ReactionDoneMark, ReactionHaikuOutcome, ReactionPerformed,
  ReactionPerformer, ReactionPick, ReactionScoring,
} from '../../shared/behaviors/reactions/interface';
import type { JournalInput } from '../../shared/journal';
import type { SenseId } from '../../shared/sense-router';

export type ReactionJournalInput = Extract<JournalInput, { type: 'reaction' }>;

export interface ReactionTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
/** Why haiku is not asked about a message (her reactions then come from her reply's tail, if it is warm). */
export type ReactionQuiet = 'asleep' | 'off' | 'hidden' | 'unavailable' | 'test-mood';
/** The switch and today's counts (electron/reactions/store.ts ReactionStore). */
export interface ReactionSwitchStore {
  readonly enabled: boolean; today(day: string): number; noteCall(day: string): number; chatsToday(day: string): number; noteChat(day: string): number;
}

/** The current character as the reactions see it: numbers, labels and her own card text; never the user's words. */
export interface ReactionNowSource {
  readonly characterId: string;
  readonly dispositions: Dispositions;
  readonly mood: MoodLabel;
  /** 心情 in words (MOOD_LABELS), for haiku's "此刻". */
  readonly moodWords: string;
  /** 困 in words ('' when awake). */
  readonly fatigue: string;
  readonly sleepy: boolean;
  readonly values: MoodValues | null;
  /** Her card's personality text (cut to knobs.personaChars in the prompt). */
  readonly persona: string;
}

/**
 * I-040 看一眼、听一下 (electron/sense-router/host.ts): the senses question rides on this host's one haiku call per message. `block` is
 * read when the call's prompt is built (null: none this time); `answer` is told once per message: the senses haiku named (null: asked
 * but nothing usable), or `taken` false when no call carried the block (quiet, no quota, superseded before it was asked).
 */
export interface ReactionSensePort {
  block(id: string): string | null;
  answer(id: string, senses: readonly SenseId[] | null, taken: boolean): void;
}

export interface ReactionHostOptions {
  /** haiku's one short call (electron/reactions/wiring.ts: the warm process when there is one, else quickLineWithClaude; its text). */
  ask: ReactionAsk;
  /**
   * A warm haiku is ready (electron/inner-loop/warm-line.ts WarmLine.ready): its call costs no process start, so with
   * knobs.warmParallel (the default) it is asked knobs.startDelayMs after the message, beside her reply. Absent or not ready, or the knob off: after her first character.
   */
  warm?(): boolean;
  store: ReactionSwitchStore;
  now(): ReactionNowSource | null;
  /** The first reason not to react at all now (asleep, 自动表现 off) or not to ask haiku (hidden, Claude down, a test mood); null: go. */
  quiet(): ReactionQuiet | null;
  /** The performers by key (electron/reactions/performers.ts; tests inject their own). */
  performers: Readonly<Record<string, ReactionPerformer>>;
  /** MoodHost.lift: the mood numbers from haiku's answer (its share), added now. */
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string }, characterId: string): void;
  /** 体验记录 (only categories, ids and numbers). */
  journal?(entry: ReactionJournalInput): void;
  /** I-040: the senses question on the same call (absent: the call is exactly as before). */
  senses?: ReactionSensePort;
  /** The developer panel's line changed (coalesced to a later tick). */
  changed?(): void;
  table?: ReactionTable;
  knobs?: Partial<ReactionKnobs>;
  clock?: () => number;
  timers?: ReactionTimers;
  random?: () => number;
  localDate?(ms: number): string;
  id?(): string;
}

/** The mood lifts this host makes start with this (the 心情调整员 ignores them while the switch is on). */
export const REACTION_LIFT_PREFIX = 'reaction-';
/** The fixed reasons of those lifts (MoodHost keeps them as the mood's reason). */
export const REACTION_MOOD_REASON = '你说的话让她心情有点变化';

interface Turn {
  readonly id: string;
  readonly characterId: string;
  readonly text: string;
  haiku: 'waiting' | 'asking' | ReactionHaikuOutcome;
  /** parallel: asked beside her reply on the warm haiku; first-char: after her first character (the fallback). */
  mode: 'parallel' | 'first-char';
  /** When her first character showed (null: not yet). */
  firstCharAt: number | null;
  controller: AbortController | null;
  starting: unknown;
  openedAt: number;
  timeout: unknown;
  startedAt: number | null;
  scorings: readonly ReactionScoring[] | null;
  /** Her reply's tail arrived (its context). */
  tail: { context: string | undefined } | null;
  /** Its reactions were decided (by haiku, the tail's fallback, or nothing). */
  settled: boolean;
  /** I-040: the call carried the senses block; the sense port was told (once). */
  senseAsked: boolean;
  senseTold: boolean;
}

/** One decision (memory only, developer panel). */
export interface ReactionWhy {
  readonly at: number;
  readonly event: ReactionEventId | 'none';
  readonly decider: ReactionDecider;
  readonly haiku: ReactionHaikuOutcome | null;
  readonly candidates: readonly { id: string; score: number }[];
  readonly picks: readonly { id: string; level: ReactionLevel; done: boolean; why: ReactionBlock | null }[];
}

const ACT_SAFE = /^[a-z][a-z0-9-]{0,31}$/u;
const BUSY_RETRY_MS = 250;

/**
 * I-037 新的反应方式, host side (the contract is shared/behaviors/reactions/interface.ts; the pure parts choose.ts).
 *
 * While the switch is off nothing here runs: every entry point returns at once, MoodHost does not hold the port, the 心情调整员
 * reads messages as before. On:
 *  - A user message: one haiku call, aborted by the next message. With a warm haiku ready (knobs.warmParallel) it is asked
 *    knobs.startDelayMs after the message, beside her reply; otherwise once her reply showed its first character. Its answer
 *    (strictly parsed: only candidates of the class it named) picks 0–2 reactions and gives the mood's share (MoodBlend: haiku
 *    0.7 / her reply's tail 0.3). Failed, timed out, no quota, not asked: when her reply's tail is warm
 *    (positive / support) the top "暖心的话" reaction plays instead, if its score reaches knobs.actAt.
 *  - A pat, a pinch, a snack (MoodHost.observe): the top reaction of that class, once per contact, without haiku.
 *  - Every reaction passes its performer's gate right before it plays; stage reactions play one after another and wait at most
 *    knobs.freeWaitMs for her to be free. A message is asked about at most once; nothing is retried.
 */
export class ReactionHost {
  private turn: Turn | null = null;
  private readonly blend: MoodBlend;
  private readonly recentMarks = new Map<string, ReactionDoneMark[]>();
  private readonly contacts = new Map<string, number>();
  private readonly whys: ReactionWhy[] = [];
  private stageChain: Promise<void> = Promise.resolve();
  private stageFreeAt = 0;
  private notifyHandle: unknown = null;
  private disposed = false;
  /** The last 64 message ids already taken (a repeat is ignored). */
  private readonly seenIds = new Set<string>();
  private readonly knobs: ReactionKnobs;
  private readonly table: ReactionTable;
  private readonly clock: () => number;
  private readonly timers: ReactionTimers;
  private readonly system: string;
  /** Counts for tests. */
  readonly stats = { asked: 0, answered: 0, failed: 0, superseded: 0, performed: 0, blocked: 0, fallback: 0, parallel: 0, afterFirstChar: 0, demoted: 0 };

  constructor(private readonly options: ReactionHostOptions) {
    this.knobs = { ...REACTION_KNOBS, ...options.knobs };
    this.table = options.table ?? REACTION_TABLE;
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.blend = new MoodBlend(this.knobs.moodBlend);
    this.system = reactionSystemPrompt(this.table, this.knobs);
  }

  /** haiku's fixed system prompt (the warm process is started with it). */
  get systemPrompt(): string { return this.system; }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  get on(): boolean { return !this.disposed && this.safe(() => this.options.store.enabled === true, false); }
  private day(ms: number): string { return (this.options.localDate ?? moodJudgeDay)(ms); }
  capToday(): number { return moodJudgeDailyCap(this.knobs, this.safe(() => this.options.store.chatsToday(this.day(this.clock())), 0)); }
  todayCalls(): number { return this.safe(() => this.options.store.today(this.day(this.clock())), 0); }

  /** The port MoodHost holds while the switch is on (electron/mood.ts setReactionPort). */
  readonly port: MoodReactionPort = {
    ownsBlush: () => this.on,
    appraisal: (characterId, responseTo, delta) => {
      // A message from before the switch was on keeps its whole tail (MoodBlend does not know it).
      if (!this.on || typeof responseTo !== 'string' || (this.turn?.id === responseTo && this.turn.characterId !== characterId)) return delta;
      return this.blend.opus(responseTo, delta);
    },
    observe: note => {
      if (!this.on || !note) return;
      // Never inside MoodHost's update: on the next tick.
      this.timers.set(() => { if (!this.disposed) this.safe(() => this.observed(note), undefined); }, 0);
    },
  };

  // ---------------------------------------------------------------- a user message

  /** A user message (the same text Opus gets; typed or spoken). Returns at once. */
  userTurn(id: string, text: unknown): void {
    if (!this.on || typeof id !== 'string' || !id) return;
    // The same message again (a re-sent or retried request keeps its id): it was already counted and judged once (X-342).
    if (this.seenIds.has(id)) return;
    this.seenIds.add(id);
    if (this.seenIds.size > 64) this.seenIds.delete(this.seenIds.values().next().value!);
    this.safe(() => this.options.store.noteChat(this.day(this.clock())), 0);
    this.supersede();
    const now = this.safe(() => this.options.now(), null);
    if (!now) return;
    const quiet = this.safe(() => this.options.quiet(), 'unavailable' as ReactionQuiet);
    const quota = this.todayCalls() < this.capToday();
    const asked = !quiet && quota;
    const turn: Turn = { id, characterId: now.characterId, text: String(text ?? '').slice(0, Math.max(0, this.knobs.userTextChars) * 2),
      haiku: asked ? 'waiting' : quiet ? 'quiet' : 'quota', mode: 'first-char', firstCharAt: null, controller: null, starting: null, openedAt: 0, timeout: null, startedAt: null, scorings: null, tail: null, settled: false,
      senseAsked: false, senseTold: false };
    this.turn = turn;
    this.blend.open(id, asked);
    if (!asked) {
      this.tellSenses(turn, null);
      // Asleep or 自动表现 off: no reaction at all for this message (her tail cannot bring one either).
      if (quiet === 'asleep' || quiet === 'off') { turn.settled = true; this.record({ characterId: turn.characterId, event: 'none', decider: 'none', haiku: 'quiet', scoring: null, results: [] }); }
      return;
    }
    // A warm haiku (already started, booted): asked knobs.startDelayMs after the message, beside her reply (knobs.warmParallel).
    // Otherwise started once her first character is out (firstChar), at least knobs.startDelayMs after the message, at most
    // knobs.firstCharWaitMs after it: a process started together with her reply made her first character ~0.5 s slower (A/B 2026-11-06).
    turn.openedAt = this.clock();
    turn.mode = this.knobs.warmParallel === true && this.warmReady() ? 'parallel' : 'first-char';
    const wait = turn.mode === 'parallel' ? this.knobs.startDelayMs : Math.max(this.knobs.firstCharWaitMs, this.knobs.startDelayMs);
    turn.starting = this.timers.set(() => { turn.starting = null; this.start(turn); }, Math.max(0, wait));
  }

  private warmReady(): boolean { return this.safe(() => this.options.warm?.() === true, false); }

  /** I-040: message `id` is the current one and its haiku call is still to come or running (the senses question can ride on it). */
  asking(id: string): boolean { const turn = this.turn; return !!turn && turn.id === id && (turn.haiku === 'waiting' || turn.haiku === 'asking') && !turn.senseTold; }

  private tellSenses(turn: Turn, senses: readonly SenseId[] | null): void {
    if (turn.senseTold || !this.options.senses) return;
    turn.senseTold = true;
    this.safe(() => this.options.senses!.answer(turn.id, senses, turn.senseAsked), undefined);
  }

  /** Her reply to message `id` showed its first character (main.ts, the chat stream's first delta): haiku may start now. */
  firstChar(id: string): void {
    const turn = this.turn;
    if (!turn || turn.id !== id) return;
    if (turn.firstCharAt === null) turn.firstCharAt = this.clock();
    if (turn.mode !== 'first-char' || turn.haiku !== 'waiting' || turn.starting === null) return;
    this.timers.clear(turn.starting);
    turn.starting = this.timers.set(() => { turn.starting = null; this.start(turn); }, Math.max(0, turn.openedAt + this.knobs.startDelayMs - this.clock()));
  }

  private start(turn: Turn): void {
    if (this.turn !== turn || turn.haiku !== 'waiting' || this.disposed) return;
    if (!this.on) { this.haikuOver(turn, 'quiet'); return; }
    // Quiet now although it was not when the message came (自动表现 turned off, she fell asleep, hid... while it waited):
    // no call (X-342), the same as if it had been quiet then. Asleep or off: no reaction at all, her tail cannot bring one either.
    const quiet = this.safe(() => this.options.quiet(), 'unavailable' as ReactionQuiet);
    if (quiet) {
      const silent = quiet === 'asleep' || quiet === 'off';
      if (silent) turn.settled = true;
      this.haikuOver(turn, 'quiet');
      if (silent) this.record({ characterId: turn.characterId, event: 'none', decider: 'none', haiku: 'quiet', scoring: null, results: [] });
      return;
    }
    if (turn.mode === 'parallel' && !this.warmReady()) {
      // The warm haiku went away meanwhile: no process is started beside her first character; back to waiting for it.
      turn.mode = 'first-char';
      this.stats.demoted++;
      const due = turn.firstCharAt !== null ? 0 : turn.openedAt + Math.max(this.knobs.firstCharWaitMs, this.knobs.startDelayMs) - this.clock();
      if (due > 0) { turn.starting = this.timers.set(() => { turn.starting = null; this.start(turn); }, due); return; }
    }
    const now = this.safe(() => this.options.now(), null);
    if (!now || now.characterId !== turn.characterId) { this.haikuOver(turn, 'superseded'); return; }
    let prompt: string;
    try {
      const at = this.clock(), recent = this.recentFor(now.characterId, at);
      const reactionNow = { characterId: now.characterId, dispositions: now.dispositions, mood: now.mood, sleepy: now.sleepy, at, recent };
      turn.scorings = WORD_EVENT_IDS.map(event => scoreReactions(event, reactionNow, { table: this.table, knobs: this.knobs, gate: (id, row) => this.gate(id, row, event, now.characterId), random: this.options.random }));
      prompt = reactionPrompt({ dispositions: now.dispositions, persona: now.persona, mood: now.mood, moodWords: now.moodWords, fatigue: now.fatigue,
        values: now.values, scorings: turn.scorings, text: turn.text }, this.table, this.knobs);
      // I-040: the senses block goes right before the last line ("只输出 JSON。").
      const block = this.options.senses ? this.safe(() => this.options.senses!.block(turn.id), null) : null;
      if (typeof block === 'string' && block) {
        const at = prompt.lastIndexOf('\n');
        prompt = at < 0 ? `${prompt}\n${block}` : `${prompt.slice(0, at)}\n${block}${prompt.slice(at)}`;
        turn.senseAsked = true;
      }
    } catch { this.haikuOver(turn, 'error'); return; }
    const controller = new AbortController();
    turn.controller = controller; turn.haiku = 'asking'; turn.startedAt = this.clock();
    this.safe(() => this.options.store.noteCall(this.day(this.clock())), 0);
    this.stats.asked++;
    if (turn.mode === 'parallel') this.stats.parallel++; else this.stats.afterFirstChar++;
    turn.timeout = this.timers.set(() => this.haikuOver(turn, 'timeout'), Math.max(0, this.knobs.timeoutMs));
    let call: Promise<string>;
    try { call = Promise.resolve(this.options.ask(prompt, this.system, controller.signal)); } catch { this.haikuOver(turn, 'error'); return; }
    void call.then(raw => this.answered(turn, raw), () => this.haikuOver(turn, 'error'));
  }

  private answered(turn: Turn, raw: string): void {
    if (turn.haiku !== 'asking' || this.disposed) return;
    if (!this.on) { this.haikuOver(turn, 'quiet'); return; }
    const answer = parseReactionAnswer(raw, turn.scorings ?? [], this.knobs, { senses: turn.senseAsked });
    if (!answer) { this.haikuOver(turn, 'invalid'); return; }
    // I-040: the senses are told whatever the confidence of the reaction part.
    this.tellSenses(turn, answer.senses ?? null);
    if (!(answer.confidence >= this.knobs.minConfidence)) { this.haikuOver(turn, 'low-confidence'); return; }
    this.endCall(turn, answer.event === 'none' ? 'none' : 'answered');
    this.stats.answered++;
    // Her mood: haiku's share now (all of it when her tail gave nothing, the rest of it when her tail came first).
    this.applyMood(turn, this.blend.haiku(turn.id, answer.delta), 'mood');
    turn.settled = true;
    const now = this.safe(() => this.options.now(), null);
    if (!now || now.characterId !== turn.characterId) { this.record({ characterId: turn.characterId, event: answer.event, decider: 'haiku', haiku: turn.haiku as ReactionHaikuOutcome, scoring: null,
      results: answer.picks.map(pick => ({ ...pick, done: false, why: 'stale' as ReactionBlock })) }); return; }
    const scoring = answer.event === 'none' ? null : turn.scorings?.find(item => item.event === answer.event) ?? null;
    this.play(answer.event, answer.picks, 'haiku', turn.haiku as ReactionHaikuOutcome, scoring, turn.characterId);
  }

  /** haiku did not answer usably: its mood share goes to her tail (if it came), and her warm tail may still bring a reaction. */
  private haikuOver(turn: Turn, outcome: ReactionHaikuOutcome): void {
    if (turn.haiku !== 'waiting' && turn.haiku !== 'asking') return;
    this.endCall(turn, outcome);
    this.tellSenses(turn, null);
    if (outcome === 'superseded') this.stats.superseded++; else this.stats.failed++;
    this.applyMood(turn, this.blend.haiku(turn.id, null), 'tail');
    if (outcome === 'superseded') { turn.settled = true; this.record({ characterId: turn.characterId, event: 'none', decider: 'none', haiku: outcome, scoring: null, results: [] }); return; }
    if (turn.tail) this.fallback(turn);
  }

  private endCall(turn: Turn, outcome: ReactionHaikuOutcome): void {
    turn.haiku = outcome;
    if (turn.starting !== null) { this.timers.clear(turn.starting); turn.starting = null; }
    if (turn.timeout !== null) { this.timers.clear(turn.timeout); turn.timeout = null; }
    if (outcome !== 'answered' && outcome !== 'none' && turn.controller && !turn.controller.signal.aborted) turn.controller.abort();
  }

  private supersede(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.haiku === 'waiting' || turn.haiku === 'asking') this.haikuOver(turn, 'superseded');
    turn.settled = true;
  }

  /** Her tail came and haiku is out: the top "暖心的话" reaction when the tail is warm (and nothing when it is not). */
  private fallback(turn: Turn): void {
    if (turn.settled) return;
    turn.settled = true;
    const warm = turn.tail?.context === 'positive' || turn.tail?.context === 'support';
    const haiku = turn.haiku as ReactionHaikuOutcome;
    if (!warm) { this.record({ characterId: turn.characterId, event: 'none', decider: 'none', haiku, scoring: null, results: [] }); return; }
    this.stats.fallback++;
    this.reactTop('warm', turn.characterId, 'fallback', haiku);
  }

  private applyMood(turn: Turn, delta: Partial<MoodValues>, part: 'mood' | 'tail'): void {
    if (!MOOD_CHANNELS.some(c => Number.isFinite(delta[c]) && delta[c] !== 0)) return;
    const id = `${REACTION_LIFT_PREFIX}${part}-${turn.id}`.slice(0, 160);
    this.safe(() => this.options.lift({ id, delta, reason: REACTION_MOOD_REASON }, turn.characterId), undefined);
  }

  // ---------------------------------------------------------------- what MoodHost told

  private observed(note: MoodReactionNote): void {
    if (!this.on) return;
    if (note.type === 'appraisal') {
      const turn = this.turn;
      if (!turn || turn.id !== note.responseTo || turn.characterId !== note.characterId || turn.tail) return;
      turn.tail = { context: note.context };
      if (turn.haiku !== 'waiting' && turn.haiku !== 'asking' && turn.haiku !== 'answered' && turn.haiku !== 'none') this.fallback(turn);
      return;
    }
    if (note.type !== 'rua' && note.type !== 'food') return;
    const event: ReactionEventId = note.type === 'food' ? 'feed' : note.pinch ? 'pinch' : 'pat';
    // A long pat sends many events: one reaction per contact. A pat counts once her closeness rose by knobs.patRise of the card's threshold.
    if (event === 'pat' && !(note.oAfter >= note.threshold * this.knobs.patRise)) return;
    const contact = `${note.characterId}:${event}:${note.session ?? note.id}`;
    if (this.contacts.has(contact)) return;
    this.contacts.set(contact, this.clock());
    while (this.contacts.size > 64) this.contacts.delete(this.contacts.keys().next().value!);
    const quiet = this.safe(() => this.options.quiet(), null);
    if (quiet === 'asleep' || quiet === 'off') return;
    this.reactTop(event, note.characterId, 'top', null);
  }

  /** No haiku: the top reaction of this class when its score reaches knobs.actAt. */
  private reactTop(event: ReactionEventId, characterId: string, decider: ReactionDecider, haiku: ReactionHaikuOutcome | null): void {
    const now = this.safe(() => this.options.now(), null);
    if (!now || now.characterId !== characterId) return;
    const at = this.clock();
    const scoring = scoreReactions(event, { characterId, dispositions: now.dispositions, mood: now.mood, sleepy: now.sleepy, at, recent: this.recentFor(characterId, at) },
      { table: this.table, knobs: this.knobs, gate: (id, row) => this.gate(id, row, event, characterId), random: this.options.random });
    const pick = topPick(scoring, this.knobs);
    if (!pick) { this.record({ characterId, event, decider: 'none', haiku, scoring, results: [] }); return; }
    this.play(event, [pick], decider, haiku, scoring, characterId);
  }

  // ---------------------------------------------------------------- performing

  private gate(id: string, row: ReactionRow, event: ReactionEventId, characterId: string): ReactionBlock | null {
    const performer = this.options.performers[row.performer];
    if (!performer) return 'no-performer';
    try { return performer.gate(row, { characterId, event }); } catch { return 'failed'; }
  }

  private play(event: ReactionEventId | 'none', picks: readonly ReactionPick[], decider: ReactionDecider, haiku: ReactionHaikuOutcome | null, scoring: ReactionScoring | null, characterId: string): void {
    const results: { id: string; level: ReactionLevel; done: boolean; why: ReactionBlock | null }[] = [];
    const pending: Promise<void>[] = [];
    if (event === 'none') { this.record({ characterId, event, decider, haiku, scoring, results }); return; }
    for (const pick of picks) {
      const row = this.table[pick.id], performer = row ? this.options.performers[row.performer] : undefined;
      const result = { id: pick.id, level: pick.level, done: false, why: null as ReactionBlock | null };
      results.push(result);
      if (!row || !performer) { result.why = 'no-performer'; continue; }
      const key = `${pick.id}-${this.options.id?.() ?? randomUUID()}`;
      const finish = (performed: ReactionPerformed) => {
        if (performed.done) { result.done = true; this.mark(characterId, pick.id); this.stats.performed++; }
        else { result.why = performed.why; this.stats.blocked++; }
      };
      const attempt = async (): Promise<ReactionPerformed> => {
        const now = this.safe(() => this.options.now(), null);
        if (!this.on || !now || now.characterId !== characterId) return { done: false, why: 'stale' };
        const blocked = this.safe(() => performer.gate(row, { characterId, event }), 'failed' as ReactionBlock);
        if (blocked) return { done: false, why: blocked };
        try { return await performer.perform(row, pick.level, { characterId, event, id: pick.id, key }); } catch { return { done: false, why: 'failed' }; }
      };
      if (!performer.stage) {
        pending.push(attempt().then(finish));
        continue;
      }
      // Stage reactions one after another: the next one starts after the last one's length plus knobs.stageGapMs, and waits at
      // most knobs.freeWaitMs for her to be free (a pat, a snack, another show).
      const run = this.stageChain.then(async () => {
        const wait = Math.max(0, this.stageFreeAt - this.clock());
        if (wait > 0) await this.sleep(wait);
        const startedAt = this.clock();
        let performed = await attempt();
        while (!performed.done && performed.why === 'busy' && this.clock() - startedAt < this.knobs.freeWaitMs) {
          await this.sleep(BUSY_RETRY_MS);
          performed = await attempt();
        }
        if (performed.done) this.stageFreeAt = this.clock() + Math.max(0, performer.durationMs ?? 0) + this.knobs.stageGapMs;
        finish(performed);
      });
      this.stageChain = run.catch(() => {});
      pending.push(this.stageChain);
    }
    void Promise.all(pending).then(() => this.record({ characterId, event, decider, haiku, scoring, results }));
  }

  private sleep(ms: number): Promise<void> { return new Promise(done => { this.timers.set(done, ms); }); }

  private mark(characterId: string, id: string): void {
    const list = this.recentMarks.get(characterId) ?? [];
    list.push({ id, at: this.clock() });
    this.recentMarks.set(characterId, list.slice(-Math.max(1, this.knobs.recentKept)));
  }
  private recentFor(characterId: string, _at: number): readonly ReactionDoneMark[] { return [...(this.recentMarks.get(characterId) ?? [])]; }

  // ---------------------------------------------------------------- the record

  private record(input: { characterId: string; event: ReactionEventId | 'none'; decider: ReactionDecider; haiku: ReactionHaikuOutcome | null; scoring: ReactionScoring | null;
    results: readonly { id: string; level: ReactionLevel; done: boolean; why: ReactionBlock | null }[] }): void {
    const why: ReactionWhy = { at: this.clock(), event: input.event, decider: input.decider, haiku: input.haiku,
      candidates: (input.scoring?.candidates ?? []).filter(item => ACT_SAFE.test(item.id)).map(item => ({ id: item.id, score: item.score })),
      picks: input.results.filter(item => ACT_SAFE.test(item.id)).map(item => ({ ...item })) };
    this.whys.unshift(why);
    this.whys.length = Math.min(this.whys.length, 8);
    this.safe(() => this.options.journal?.({ type: 'reaction', characterId: input.characterId, event: why.event, decider: why.decider, haiku: why.haiku,
      candidates: why.candidates.slice(0, 4), picks: why.picks.map(item => ({ id: item.id, level: item.level, done: item.done, ...(item.why ? { why: item.why } : {}) })) }), undefined);
    this.notify();
  }

  /** The last few decisions, newest first (memory only; ids, numbers and closed outcomes). */
  recent(): readonly ReactionWhy[] { return this.whys.map(item => structuredClone(item)); }

  /** The switch changed (the store already holds it). Off: a call still running is stopped, nothing more is played. */
  switched(): void {
    if (this.on) return;
    const turn = this.turn;
    if (turn && (turn.haiku === 'waiting' || turn.haiku === 'asking')) { this.endCall(turn, 'quiet'); turn.settled = true; }
    this.turn = null;
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    const turn = this.turn;
    if (turn && (turn.haiku === 'waiting' || turn.haiku === 'asking')) this.endCall(turn, 'quiet');
    this.turn = null;
    this.disposed = true;
    if (this.notifyHandle !== null) { this.timers.clear(this.notifyHandle); this.notifyHandle = null; }
  }

  private notify(): void {
    if (this.disposed || this.notifyHandle !== null || !this.options.changed) return;
    this.notifyHandle = this.timers.set(() => {
      this.notifyHandle = null;
      if (!this.disposed) this.safe(() => this.options.changed?.(), undefined);
    }, 0);
  }
}
