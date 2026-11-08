import { randomUUID } from 'node:crypto';
import { withheldLook } from '../../shared/look-request';
import {
  SENSE_FIRST_LINE_HINT, SENSE_IDS, SENSE_JUDGE_SYSTEM_PROMPT, SENSE_ROUTER_KNOBS, SENSE_SUMMARY_SYSTEM_PROMPT, parseSenseJudge, parseSenseLine,
  parseSenseSummary, senseBlock, senseJudgePrompt, senseLineOrigin, senseLinePrompt, senseSummaryPrompt,
  type SenseId, type SenseLineMessage, type SenseNote, type SenseOn, type SenseRouterKnobs,
} from '../../shared/sense-router';
import type { ReactionSensePort } from '../reactions/host';

export interface SenseTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

/** Counts and timings only (never words, frames or summaries): the developer log. */
export interface SenseRouterLogEntry {
  outcome: 'said' | 'quiet' | 'nothing' | 'superseded' | 'stale' | 'reply-ended' | 'late' | 'failed' | 'not-shown' | 'busy';
  judge: 'merged' | 'own' | 'none';
  needed: number; seen: number; off: number;
  /** ms from the message: the judgment, the facts, the line shown (null: did not happen). */
  judgedMs: number | null; factsMs: number | null; shownMs: number | null;
}

export interface SenseRouterPorts {
  /** The feature's switch (knob; tests flip it). */
  enabled(): boolean;
  /** What the user has on right now (camera: 「发图片」 with its window and no "别看"; screen: sharing and no "别看"; transcript: 一起听 listening). */
  on(): SenseOn;
  /** The speech scope (character, provider, model): a change makes the turn stale. */
  identity(): string;
  /** The conversation (the "sense is off" line comes at most once in one). */
  conversation(): string;
  /** One frame now, as a data URL, memory only (null: none). Never called for a sense that is off or held. */
  capture(sense: 'camera' | 'screen', signal: AbortSignal): Promise<string | null>;
  /** The words heard lately (一起听, memory only), or null. */
  heard(): string | null;
  /** haiku once, text and at most one picture (electron/sense-router/model.ts). */
  ask(prompt: string, systemPrompt: string, images: readonly string[], signal: AbortSignal): Promise<string>;
  /** The chat model says her line (null: chat is not on Claude). */
  line(prompt: string, signal: AbortSignal): Promise<string> | null;
  /** The active card: id, compiled persona, language habits. */
  character(): { id: string; persona: string; language: string } | null;
  /** The chat's mood context (companion.mood.chatContext()). */
  mood(): string;
  /** She may speak now (pet shown, no chat turn, nothing being read, the user not typing, no game). */
  free(): boolean;
  /** To the pet window (desk:sense-line); false when it could not be sent. */
  publish(message: SenseLineMessage): boolean;
  speechStyle(id: string): void;
  /** One record of her line (memory, the control window's chat); `current` rechecks inside the archive. */
  archive(message: SenseLineMessage, current: () => boolean): Promise<void>;
  log?(entry: SenseRouterLogEntry): void;
  /**
   * I-047 陪看要及时 (electron/listen-together/watch-window.ts): `open`: haiku judged the user is talking about what is playing (starts
   * or renews the "talking about the show" window; it checks the refusal rules itself); `summary`: the facts haiku wrote for the
   * transcript, kept for the window's later turns. Both memory only; absent: nothing happens.
   */
  watch?: { open(text: string, conversation: string): void; summary(facts: string, conversation: string): void };
  knobs?: Partial<SenseRouterKnobs>;
  clock?: () => number;
  timers?: SenseTimers;
  createId?: () => string;
}

interface Turn {
  readonly id: string;
  readonly text: string;
  readonly identity: string;
  readonly conversation: string;
  readonly characterId: string;
  readonly at: number;
  /** The senses on when the message came, minus any this message holds back ("别看"): never read, never nagged about. */
  readonly on: SenseOn;
  readonly blocked: ReadonlySet<SenseId>;
  /** Senses her first reply already had (a clear frame she was asked to take, the 一起听 block). */
  readonly covered: Set<SenseId>;
  /** I-047: the last few exchanges before this message (cut short), for the judgment. */
  readonly context: readonly string[];
  judge: 'merged' | 'own' | 'none';
  judged: 'waiting' | 'asking' | 'done';
  judgedAt: number | null;
  firstChar: boolean;
  pending: number;
  factsAt: number | null;
  needed: number;
  seen: number;
  off: number;
  readonly notes: SenseNote[];
  reply: { ok: boolean; text: string } | null;
  joining: boolean;
  done: boolean;
  readonly controller: AbortController;
  deadline: unknown;
}
interface Showing { turn: Turn; message: SenseLineMessage; timer: unknown; resolve: (shown: boolean) => void }

const POLL_MS = 150;
/** The pet window reports the line shown (or not) within this. */
export const SENSE_SHOW_MS = 15_000;
const NONE_ON: SenseOn = Object.freeze({ camera: false, screen: false, transcript: false });

/**
 * I-040 看一眼、听一下 on the host (the pure parts are shared/sense-router.ts; the plan docs/claude/2026-11-07-sense-router-plan.md).
 *
 * One message at a time. Her reply starts exactly as before; nothing here is awaited on the way to it. The judgment rides on the
 * reaction judge's call (ReactionSensePort, electron/reactions/host.ts); when that call is not made for this message, its own small
 * haiku call starts after her first character, and only while a sense is on. A needed sense that is on gives one sample right then
 * (a frame or the heard words, in memory) and haiku's one or two facts; a needed sense that is off gives "it is off" (once per
 * conversation). Once her first reply has ended (never during it) and the facts are in, the chat model says one short line in her
 * voice; it is shown when she is free and archived once. A newer message, a stopped or failed reply, another character or model,
 * the switch going off, or the deadline: everything of this turn is dropped, never shown late.
 */
export class SenseRouterHost {
  private turn: Turn | null = null;
  private showing: Showing | null = null;
  private disposed = false;
  /** Conversations whose "it is off" line was already used, per sense (the last few only). */
  private readonly offSaid = new Map<string, Set<SenseId>>();
  private readonly knobs: SenseRouterKnobs;
  private readonly clock: () => number;
  private readonly timers: SenseTimers;
  /** Counts for tests and the developer panel. */
  readonly stats = { turns: 0, merged: 0, own: 0, judged: 0, needed: 0, captured: 0, facts: 0, off: 0, lines: 0, shown: 0, dropped: 0, hints: 0 };

  constructor(private readonly ports: SenseRouterPorts) {
    this.knobs = { ...SENSE_ROUTER_KNOBS, ...ports.knobs };
    this.clock = ports.clock ?? Date.now;
    this.timers = ports.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  get enabled(): boolean { return !this.disposed && this.safe(() => this.ports.enabled() === true, false); }

  /** The reaction host's port: the senses question on its call. */
  readonly port: ReactionSensePort = {
    block: id => {
      const turn = this.turn;
      if (!turn || turn.id !== id || !this.current(turn) || turn.judge !== 'merged' || turn.judged !== 'waiting') return null;
      turn.judged = 'asking';
      return senseBlock(turn.on, turn.context);
    },
    answer: (id, senses, taken) => {
      const turn = this.turn;
      if (!turn || turn.id !== id || turn.judge !== 'merged' || turn.done) return;
      if (!taken) { this.ownJudge(turn); return; }
      this.judged(turn, senses);
    },
  };

  /**
   * A user message (main.ts, right after the reaction host took it). `merged`: the reaction judge will ask haiku about it (its port
   * then carries the question); `covered`: senses this message already brings to her (a clear frame she was asked to take).
   */
  userTurn(id: string, text: unknown, options: { merged: boolean; covered?: readonly SenseId[]; context?: readonly string[] }): void {
    this.supersede();
    if (!this.enabled || typeof id !== 'string' || !id) return;
    const character = this.safe(() => this.ports.character(), null);
    const identity = this.safe(() => this.ports.identity(), '');
    if (!character || !identity) return;
    const words = String(text ?? '');
    // A "别看" in this very message: no frame of the camera or the screen, and no "it is off" about them either.
    const withheld = withheldLook(words);
    const blocked = new Set<SenseId>(withheld === 'refused' || withheld === 'unread' ? ['camera', 'screen'] : []);
    const now = this.safe(() => this.ports.on(), NONE_ON);
    const on: SenseOn = { camera: now.camera === true && !blocked.has('camera'), screen: now.screen === true && !blocked.has('screen'), transcript: now.transcript === true };
    const anyOn = SENSE_IDS.some(sense => on[sense]);
    // Nothing on and no free ride on the reaction call: nothing to ask (an own call only to say "it is off" is not worth one).
    if (!options.merged && !anyOn) return;
    const turn: Turn = { id, text: words.slice(0, 2_000), identity, conversation: this.safe(() => this.ports.conversation(), ''), characterId: character.id, at: this.clock(),
      on, blocked, covered: new Set(options.covered ?? []), context: (options.context ?? []).slice(0, 8), judge: options.merged ? 'merged' : 'own', judged: 'waiting', judgedAt: null, firstChar: false, pending: 0,
      factsAt: null, needed: 0, seen: 0, off: 0, notes: [], reply: null, joining: false, done: false, controller: new AbortController(), deadline: null };
    turn.deadline = this.timers.set(() => { if (!turn.done && !this.isShowing(turn)) this.end(turn, 'late'); }, Math.max(0, this.knobs.joinDeadlineMs));
    this.turn = turn;
    this.stats.turns++;
    if (options.merged) this.stats.merged++;
  }

  /**
   * Her first line's private context, this turn only (local, no wait): '' unless a sense is on that this message does not already
   * bring her. main.ts adds it where the turn's perception line goes.
   */
  firstLineHint(id: string, covered: readonly SenseId[] = []): string {
    const turn = this.turn;
    if (!turn || turn.id !== id || !this.current(turn)) return '';
    for (const sense of covered) turn.covered.add(sense);
    if (this.knobs.firstLineHint !== true) return '';
    if (!SENSE_IDS.some(sense => turn.on[sense] && !turn.covered.has(sense))) return '';
    this.stats.hints++;
    return SENSE_FIRST_LINE_HINT;
  }

  /** Her reply to `id` showed its first character: an own judgment may start now (never beside her first character). */
  firstChar(id: string): void {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.firstChar) return;
    turn.firstChar = true;
    if (turn.judge === 'own' && turn.judged === 'waiting') this.runOwnJudge(turn);
  }

  /** Her first reply to `id` ended: `ok` (complete) with its visible text, or not (stopped, failed): then nothing follows. */
  replyDone(id: string, ok: boolean, text: string): void {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.reply) return;
    turn.reply = { ok: ok === true, text: String(text ?? '') };
    if (!turn.reply.ok) { this.end(turn, 'reply-ended'); return; }
    this.tryJoin(turn);
  }

  /** The pet window: her line `id` was shown (and read) or could not be. */
  done(fromPet: boolean, value: unknown): boolean {
    const showing = this.showing;
    if (fromPet !== true || !showing || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.id !== showing.message.id || typeof record.shown !== 'boolean') return false;
    this.showing = null;
    this.timers.clear(showing.timer);
    showing.resolve(record.shown);
    return true;
  }

  /** Anything that voids the current turn from outside (a new conversation, the vision context cleared, a character switch). */
  cancel(): void { this.supersede(); }
  dispose(): void { this.supersede(); this.disposed = true; }

  // ---------------------------------------------------------------- the judgment

  /** The reaction call did not carry the question after all: its own call, after her first character, only while a sense is on. */
  private ownJudge(turn: Turn): void {
    if (turn.judged === 'done') return;
    if (!SENSE_IDS.some(sense => turn.on[sense])) { this.judged(turn, null); return; }
    turn.judge = 'own';
    turn.judged = 'waiting';
    if (turn.firstChar) this.runOwnJudge(turn);
  }

  private runOwnJudge(turn: Turn): void {
    if (!this.current(turn) || turn.judged !== 'waiting') return;
    turn.judged = 'asking';
    this.stats.own++;
    void this.within(turn, signal => this.ports.ask(senseJudgePrompt(turn.on, turn.text, 400, turn.context), SENSE_JUDGE_SYSTEM_PROMPT, [], signal), this.knobs.judgeTimeoutMs)
      .then(raw => { if (this.current(turn)) this.judged(turn, raw === null ? null : parseSenseJudge(raw)); });
  }

  private judged(turn: Turn, senses: readonly SenseId[] | null): void {
    if (turn.judged === 'done' || !this.current(turn)) return;
    turn.judged = 'done';
    turn.judgedAt = this.clock();
    this.stats.judged++;
    const said = this.offSaid.get(turn.conversation);
    for (const sense of senses ?? []) {
      // I-047: the user is talking about what is playing (and 一起听 is on): the window starts or renews, covered or not.
      if (sense === 'transcript' && turn.on.transcript) this.safe(() => this.ports.watch?.open(turn.text, turn.conversation), undefined);
      if (turn.blocked.has(sense) || turn.covered.has(sense)) continue;
      turn.needed++;
      this.stats.needed++;
      if (turn.on[sense]) { this.collect(turn, sense); continue; }
      if (!said?.has(sense) && !turn.notes.some(note => note.sense === sense)) turn.notes.push({ sense, kind: 'off' });
    }
    this.tryJoin(turn);
  }

  /** One sample of a sense that is on, and haiku's facts about it. The sample lives only in this call. */
  private collect(turn: Turn, sense: SenseId): void {
    turn.pending++;
    void (async () => {
      try {
        // Still on now (the user may have turned it off or said "别看" meanwhile): else nothing is read.
        const now = this.safe(() => this.ports.on(), NONE_ON);
        if (now[sense] !== true || !this.current(turn)) return;
        let images: string[] = [], heard = '';
        if (sense === 'transcript') {
          heard = this.safe(() => this.ports.heard(), null) ?? '';
          if (!heard.trim()) return;
        } else {
          const frame = await this.within(turn, signal => this.ports.capture(sense, signal), this.knobs.summaryTimeoutMs);
          if (!frame || !this.current(turn) || this.safe(() => this.ports.on(), NONE_ON)[sense] !== true) return;
          images = [frame];
          this.stats.captured++;
        }
        const raw = await this.within(turn, signal => this.ports.ask(senseSummaryPrompt(sense, turn.text, heard, this.knobs), SENSE_SUMMARY_SYSTEM_PROMPT, images, signal), this.knobs.summaryTimeoutMs);
        images = []; heard = '';
        const facts = raw === null ? null : parseSenseSummary(raw, this.knobs);
        if (!facts || !this.current(turn)) return;
        turn.notes.push({ sense, kind: 'seen', facts });
        if (sense === 'transcript') this.safe(() => this.ports.watch?.summary(facts, turn.conversation), undefined); // I-047: kept for the window's later turns (memory only)
        turn.factsAt = this.clock();
        turn.seen++;
        this.stats.facts++;
      } catch { /* No facts from this sense. */ }
      finally {
        turn.pending--;
        this.tryJoin(turn);
      }
    })();
  }

  // ---------------------------------------------------------------- the join

  private tryJoin(turn: Turn): void {
    if (turn.done || turn.joining || turn.judged !== 'done' || turn.pending > 0 || !turn.reply) return;
    if (!this.current(turn)) { this.end(turn, 'stale'); return; }
    if (!turn.notes.length) { this.end(turn, 'nothing'); return; }
    turn.joining = true;
    void this.join(turn);
  }

  private async join(turn: Turn): Promise<void> {
    const notes = [...turn.notes].sort((a, b) => SENSE_IDS.indexOf(a.sense) - SENSE_IDS.indexOf(b.sense));
    // "It is off" counts as said once the line is asked for (whatever she then says): at most once per conversation.
    for (const note of notes) if (note.kind === 'off') {
      const set = this.offSaid.get(turn.conversation) ?? new Set<SenseId>();
      set.add(note.sense);
      this.offSaid.set(turn.conversation, set);
      while (this.offSaid.size > 16) this.offSaid.delete(this.offSaid.keys().next().value!);
      turn.off++;
      this.stats.off++;
    }
    try {
      const character = this.safe(() => this.ports.character(), null);
      if (!character || character.id !== turn.characterId) return this.end(turn, 'stale');
      const prompt = senseLinePrompt({ persona: character.persona, language: character.language, mood: this.safe(() => this.ports.mood(), ''),
        userText: turn.text, reply: turn.reply?.text ?? '', notes }, this.knobs);
      // The facts are no longer kept once they are in her prompt.
      turn.notes.length = 0;
      this.stats.lines++;
      const raw = await this.within(turn, signal => this.ports.line(prompt, signal), this.knobs.lineTimeoutMs);
      if (!this.current(turn)) return this.end(turn, 'stale');
      const text = raw === null ? null : parseSenseLine(raw);
      if (text === null) return this.end(turn, 'failed');
      if (text === 'quiet') return this.end(turn, 'quiet');
      if (!await this.untilFree(turn)) return this.end(turn, this.current(turn) ? 'busy' : 'stale');
      const id = `sense-${(this.ports.createId ?? randomUUID)()}`.slice(0, 100), at = Math.floor(this.clock());
      const message: SenseLineMessage = { id, text, origin: senseLineOrigin(id, at, notes) };
      const shown = await this.show(turn, message);
      if (!shown || !this.current(turn)) return this.end(turn, 'not-shown');
      this.stats.shown++;
      // Shown once: archived once. A failed archive never repeats the line.
      try { void this.ports.archive(structuredClone(message), () => this.current(turn)).catch(() => {}); } catch { /* The bubble stays; only the record is lost. */ }
      return this.end(turn, 'said', this.clock() - turn.at);
    } catch { return this.end(turn, 'failed'); }
  }

  private show(turn: Turn, message: SenseLineMessage): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const showing: Showing = { turn, message, resolve, timer: null };
      showing.timer = this.timers.set(() => { if (this.showing === showing) { this.showing = null; resolve(false); } }, SENSE_SHOW_MS);
      this.showing = showing;
      let sent = false;
      try { this.ports.speechStyle(message.id); sent = this.ports.publish(structuredClone(message)) !== false; } catch { sent = false; }
      if (!sent && this.showing === showing) { this.showing = null; this.timers.clear(showing.timer); resolve(false); }
    });
  }

  private isShowing(turn: Turn): boolean { return this.showing?.turn === turn; }

  /** Her first reply has ended; wait until she is free (its voice done, nothing typed); false when it does not happen in time. */
  private async untilFree(turn: Turn): Promise<boolean> {
    const deadline = this.clock() + this.knobs.freeWaitMs;
    for (;;) {
      if (!this.current(turn)) return false;
      if (this.safe(() => this.ports.free(), false)) return true;
      if (this.clock() >= deadline) return false;
      await this.sleep(turn, POLL_MS);
    }
  }

  // ---------------------------------------------------------------- bookkeeping

  private current(turn: Turn): boolean {
    if (this.disposed || turn.done || this.turn !== turn || turn.controller.signal.aborted || !this.enabled) return false;
    const character = this.safe(() => this.ports.character(), null);
    return !!character && character.id === turn.characterId && this.safe(() => this.ports.identity(), '') === turn.identity
      && this.safe(() => this.ports.conversation(), '') === turn.conversation;
  }

  private supersede(): void {
    const turn = this.turn;
    if (turn && !turn.done) this.end(turn, 'superseded');
    this.turn = null;
  }

  private end(turn: Turn, outcome: SenseRouterLogEntry['outcome'], shownMs: number | null = null): void {
    if (turn.done) return;
    turn.done = true;
    turn.notes.length = 0;
    if (!turn.controller.signal.aborted) turn.controller.abort();
    if (turn.deadline !== null) { this.timers.clear(turn.deadline); turn.deadline = null; }
    const showing = this.showing;
    if (showing?.turn === turn && outcome !== 'said') { this.showing = null; this.timers.clear(showing.timer); showing.resolve(false); }
    if (outcome !== 'said' && outcome !== 'quiet' && outcome !== 'nothing') this.stats.dropped++;
    // Only turns that got as far as a judgment are worth a line in the developer log.
    if (turn.judged === 'waiting' && outcome === 'superseded') return;
    const rel = (at: number | null) => at === null ? null : Math.max(0, Math.round(at - turn.at));
    const entry: SenseRouterLogEntry = { outcome, judge: turn.judge, needed: turn.needed, seen: turn.seen, off: turn.off,
      judgedMs: rel(turn.judgedAt), factsMs: rel(turn.factsAt), shownMs: shownMs === null ? null : Math.round(shownMs) };
    this.safe(() => this.ports.log?.(entry), undefined);
  }

  /** The call's text, or null on timeout, abort or failure. */
  private async within<T>(turn: Turn, call: (signal: AbortSignal) => Promise<T> | null, ms: number): Promise<T | null> {
    if (turn.controller.signal.aborted) return null;
    const controller = new AbortController();
    const stop = () => controller.abort();
    turn.controller.signal.addEventListener('abort', stop, { once: true });
    const timer = this.timers.set(stop, Math.max(0, ms));
    try {
      const pending = call(controller.signal);
      if (!pending) return null;
      return await new Promise<T | null>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(null), { once: true });
        void pending.then(value => resolve(controller.signal.aborted ? null : value), () => resolve(null));
      });
    } catch { return null; }
    finally { this.timers.clear(timer); turn.controller.signal.removeEventListener('abort', stop); }
  }

  private sleep(turn: Turn, ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = this.timers.set(resolve, ms);
      turn.controller.signal.addEventListener('abort', () => { this.timers.clear(timer); resolve(); }, { once: true });
    });
  }
}
