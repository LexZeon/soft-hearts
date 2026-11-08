/**
 * G1 猜拳: one match, best of three, as a pure state machine driven by explicit times (the host owns the one timer).
 *
 * Order inside every round (the user's original point 6: "她的选择必须在看到我的手之前就定下来"):
 *  1. her hand is picked and sealed (rpsCommit: SHA-256 over hand, intent, a random nonce and the time);
 *  2. only then does the round accept a hand (ready → count → wait);
 *  3. the reveal reads both; her sealed hand is never written again.
 * A hand that arrives before 布 waits for it; after 布 she holds her fist until the user throws (her hand stays hidden).
 *
 * How she takes the round (her reaction) is settled as soon as both hands are in, so the host can ask for her words
 * before the reveal shows anything (docs/claude/2026-11-03-rps-five-fixes.md). While she is saying something the host
 * holds the reveal (or the end) open with `hold`; nothing else waits on her words.
 */
import { RPS_FIRST_TO, RPS_MAX_ROUNDS, RPS_TIMING, rpsCommit, rpsJudge, rpsRevealAfterMs, type RpsCommitment, type RpsFace, type RpsHand, type RpsInputSource,
  type RpsOutcome, type RpsPhase, type RpsSecret, type RpsTiming, type RpsView } from './rps';
import { chooseRpsHand, chooseRpsReaction, rpsPlainLoss, type RpsCueKind, type RpsReaction, type RpsResolvedStyle } from './rps-personality';
import type { RpsGameRecord, RpsHabits, RpsRoundRecord } from './rps-memory';

export interface RpsMatchOptions {
  id: string;
  origin: 'her' | 'user';
  /** Uniform in [0, 1): her picks and reactions (the host uses crypto). */
  random: () => number;
  /** A fresh unguessable string per round (seal opener). */
  nonce: () => string;
  style: RpsResolvedStyle;
  /** Earlier matches (null while recording is off). */
  habits: RpsHabits | null;
  timing?: Partial<RpsTiming>;
  firstTo?: number;
  maxRounds?: number;
}

/** Where the match is and the face she makes there. */
export interface RpsCue { kind: RpsCueKind | null; face: RpsFace; tease: RpsHand | null }
type Phase = Exclude<RpsPhase, 'invite' | 'aside'> | 'over';
interface Round {
  number: number;
  secret: RpsSecret;
  commitment: RpsCommitment;
  user: { hand: RpsHand; source: RpsInputSource; at: number } | null;
  /** Settled when the user's hand arrives (her hand was sealed long before); shown only at the reveal. */
  reaction: RpsReaction | null;
  outcome: RpsOutcome | null;
}
export type RpsThrowResult = 'accepted' | 'duplicate' | 'stale' | 'closed';
export type RpsMatchEnd = 'finished' | 'timeout' | 'quit' | 'abandoned';

/** Host-only facts about the current round once both hands are in (never sent to a window before the reveal). */
export interface RpsRoundFacts {
  round: number;
  her: RpsHand;
  user: RpsHand;
  outcome: RpsOutcome;
  intent: RpsSecret['intent'];
  reaction: RpsReaction;
  /** The score once this round counts. */
  score: { her: number; user: number };
  /** This round decides the match ('her' / 'user'), or ends it undecided at the throw limit ('none'); null: more rounds follow. */
  last: 'her' | 'user' | 'none' | null;
  revealed: boolean;
  /** The rounds revealed before this one, oldest first. */
  earlier: RpsRoundRecord[];
}

export class RpsMatch {
  readonly id: string;
  readonly origin: 'her' | 'user';
  private readonly timing: RpsTiming;
  private readonly firstTo: number;
  private readonly maxRounds: number;
  private phase: Phase = 'ready';
  private phaseAt: number;
  private holdUntil: number | null = null;
  private round: Round;
  private readonly rounds: Round[] = [];
  private score = { her: 0, user: 0 };
  private softUsed = false;
  private readUsed = false;
  private teaseUsed = false;
  private cueValue: RpsCue = { kind: 'ready', face: 'nervous', tease: null };
  private ended: RpsMatchEnd | null = null;
  private revision = 0;

  constructor(private readonly options: RpsMatchOptions, now: number) {
    this.id = options.id; this.origin = options.origin;
    this.timing = { ...RPS_TIMING, ...options.timing };
    this.firstTo = options.firstTo ?? RPS_FIRST_TO;
    this.maxRounds = options.maxRounds ?? RPS_MAX_ROUNDS;
    this.phaseAt = now;
    this.round = this.seal(1, now);
  }

  /** Step 1 of a round: her hand is decided and sealed before any input can be accepted. */
  private seal(number: number, now: number): Round {
    const pick = chooseRpsHand({ random: this.options.random, style: this.options.style, habits: this.options.habits, round: number,
      softUsed: this.softUsed, readUsed: this.readUsed });
    if (pick.intent === 'soft') this.softUsed = true;
    if (pick.intent === 'read') this.readUsed = true;
    const secret: RpsSecret = Object.freeze({ hand: pick.hand, intent: pick.intent, nonce: this.options.nonce() });
    return { number, secret, commitment: Object.freeze(rpsCommit(this.id, number, now, secret)), user: null, reaction: null, outcome: null };
  }

  get over(): boolean { return this.phase === 'over'; }
  get end(): RpsMatchEnd | null { return this.ended; }
  get currentPhase(): Phase { return this.phase; }
  get roundNumber(): number { return this.round.number; }
  get cue(): Readonly<RpsCue> { return this.cueValue; }
  /** Test and diagnostics seam: the sealed record of the current round (never sent before the reveal). */
  sealedForTest(): { secret: RpsSecret; commitment: RpsCommitment } { return { secret: this.round.secret, commitment: this.round.commitment }; }

  /** The user's hand for this round. Anything that does not belong to the open round is refused. */
  throwHand(input: { round: number; hand: RpsHand; source: RpsInputSource }, now: number): RpsThrowResult {
    if (this.phase === 'over' || this.phase === 'end') return 'closed';
    if (input.round !== this.round.number || this.phase === 'reveal') return 'stale';
    if (this.round.user) return 'duplicate';
    this.round.user = { hand: input.hand, source: input.source, at: now };
    // Her reaction is settled now (the same one draw it always took, before the next round's seal), so her words can be
    // prepared while the count runs; the reveal shows it.
    const outcome = rpsJudge(this.round.secret.hand, input.hand), after = this.after(outcome);
    this.round.reaction = chooseRpsReaction({ outcome, intent: this.round.secret.intent, userHand: input.hand, final: this.decided(after),
      teaseUsed: this.teaseUsed, style: this.options.style, random: this.options.random });
    if (this.round.reaction.tease) this.teaseUsed = true;
    this.revision++;
    // After 布 the reveal waits for nothing else.
    if (this.phase === 'wait') this.reveal(now);
    return 'accepted';
  }

  /** The current round once both hands are in (host only), or null. */
  facts(): RpsRoundFacts | null {
    const round = this.round;
    if (!round.user || !round.reaction) return null;
    const outcome = rpsJudge(round.secret.hand, round.user.hand), score = this.after(outcome, round.outcome !== null);
    const winner = this.decided(score);
    return { round: round.number, her: round.secret.hand, user: round.user.hand, outcome, intent: round.secret.intent, reaction: { ...round.reaction }, score,
      last: winner ?? (round.number >= this.maxRounds ? 'none' : null), revealed: round.outcome !== null,
      earlier: this.rounds.filter(r => r.user && r.outcome).map(r => ({ her: r.secret.hand, user: r.user!.hand, outcome: r.outcome! })) };
  }

  /** She will not say her pretend cheat this time (it needs her words): the round becomes a plain loss. Before or at the reveal. */
  cancelTease(): void {
    const round = this.round;
    if (!round.reaction?.tease) return;
    const outcome = rpsJudge(round.secret.hand, round.user!.hand);
    round.reaction = rpsPlainLoss(this.decided(this.after(outcome, round.outcome !== null)));
    if (round.outcome !== null && this.phase === 'reveal') { this.cueValue = { kind: round.reaction.kind, face: round.reaction.face, tease: null }; this.revision++; }
  }

  /** Keeps the reveal or the end open until `until` (she is still talking); null lets it run to its own time. A new phase clears it. */
  hold(until: number | null): void {
    if (this.phase !== 'reveal' && this.phase !== 'end') return;
    this.holdUntil = until === null || !Number.isFinite(until) ? null : until;
  }

  /** Moves past every deadline up to `now`; returns whether anything changed. */
  advance(now: number): boolean {
    let changed = false;
    for (let guard = 0; guard < 16; guard++) {
      const deadline = this.deadline();
      if (deadline === null || now < deadline) break;
      this.step(deadline);
      changed = true;
    }
    return changed;
  }

  /** The user left (×), or the host ends it (hidden, character switch, a chat message). */
  stop(now: number, why: 'quit' | 'abandoned'): void {
    if (this.phase === 'over') return;
    this.ended = why;
    if (why === 'quit') { this.enter('end', now); this.cueValue = { kind: 'bye', face: 'happy', tease: null }; }
    else this.enter('over', now);
  }

  /** When the next phase change is due (ms), or null while it waits for the user / is over. */
  deadline(): number | null {
    const t = this.timing, held = this.holdUntil ?? -Infinity;
    switch (this.phase) {
      case 'ready': return this.phaseAt + (this.round.number === 1 ? t.readyMs : t.nextMs);
      case 'count': return this.phaseAt + rpsRevealAfterMs(t);
      case 'wait': return this.phaseAt + t.waitMs;
      case 'reveal': return Math.max(this.phaseAt + t.reactMs, held);
      case 'end': return Math.max(this.phaseAt + t.endMs, held);
      default: return null;
    }
  }

  private enter(phase: Phase, now: number): void { this.phase = phase; this.phaseAt = now; this.holdUntil = null; this.revision++; }

  /** The score once a round with `outcome` counts (unless it already did). */
  private after(outcome: RpsOutcome, counted = false): { her: number; user: number } {
    const score = { ...this.score };
    if (!counted && outcome === 'her') score.her++;
    if (!counted && outcome === 'user') score.user++;
    return score;
  }
  private decided(score: { her: number; user: number }): 'her' | 'user' | null {
    return score.her >= this.firstTo ? 'her' : score.user >= this.firstTo ? 'user' : null;
  }

  private step(at: number): void {
    switch (this.phase) {
      case 'ready': this.enter('count', at); this.cueValue = { kind: null, face: 'nervous', tease: null }; return;
      case 'count':
        if (this.round.user) this.reveal(at);
        else { this.enter('wait', at); this.cueValue = { kind: 'wait', face: 'expectant', tease: null }; }
        return;
      case 'wait':
        this.ended = 'timeout'; this.enter('end', at); this.cueValue = { kind: 'timeout', face: 'neutral', tease: null }; return;
      case 'reveal': {
        const final = this.result();
        if (final || this.round.number >= this.maxRounds) {
          if (!this.ended) this.ended = 'finished';
          this.enter('end', at);
          this.cueValue = { kind: 'bye', face: final === 'her' ? 'smug' : 'happy', tease: null };
          return;
        }
        this.rounds.push(this.round);
        this.round = this.seal(this.round.number + 1, at);
        this.enter('ready', at);
        this.cueValue = { kind: 'next', face: 'nervous', tease: null };
        return;
      }
      case 'end': this.enter('over', at); return;
      default: return;
    }
  }

  private reveal(at: number): void {
    const round = this.round, user = round.user!;
    const outcome = rpsJudge(round.secret.hand, user.hand);
    round.outcome = outcome;
    if (outcome === 'her') this.score.her++;
    if (outcome === 'user') this.score.user++;
    const reaction = round.reaction!;
    // The pretend hand is shown only while she says it (the host puts it into the view); the reveal shows her real hand.
    this.cueValue = { kind: reaction.kind, face: reaction.face, tease: null };
    this.enter('reveal', at);
  }

  /** The current round's reaction once it is revealed (host: the pretend cheat's hand). */
  reaction(): RpsReaction | null { return this.round.outcome !== null && this.round.reaction ? { ...this.round.reaction } : null; }

  result(): 'her' | 'user' | null { return this.decided(this.score); }

  /** The window's view. Her hand appears only once this round is revealed. */
  view(now: number, line: string | null): Omit<RpsView, 'revision'> & { revision: number } {
    const phase = this.phase === 'over' ? 'end' : this.phase;
    const revealed = this.round.outcome !== null;
    const deadline = this.deadline();
    return {
      id: this.id, revision: this.revision, phase, round: this.round.number, score: { ...this.score }, firstTo: this.firstTo,
      accepting: (this.phase === 'ready' || this.phase === 'count' || this.phase === 'wait') && !this.round.user,
      commitment: revealed ? null : { ...this.round.commitment },
      revealed: revealed ? { ...this.round.secret } : null,
      userHand: this.round.user?.hand ?? null,
      outcome: this.round.outcome,
      line, face: this.cueValue.face, tease: null,
      beatMs: this.timing.beatMs,
      phaseMs: deadline === null ? 0 : Math.max(0, deadline - this.phaseAt),
      elapsedMs: Math.max(0, now - this.phaseAt),
      result: this.phase === 'end' || this.phase === 'over' ? (this.ended === 'finished' ? this.result() : null) : this.result(),
    };
  }

  /** What stays (counts only): the rounds that were revealed. */
  record(now: number): RpsGameRecord {
    const all = [...this.rounds, ...(this.round.outcome !== null && !this.rounds.includes(this.round) ? [this.round] : [])];
    const rounds: RpsRoundRecord[] = all.filter(round => round.user && round.outcome).map(round => ({ her: round.secret.hand, user: round.user!.hand, outcome: round.outcome! }));
    const result = this.ended === 'finished' ? this.result() ?? 'none' : 'none';
    return { at: Math.floor(now), origin: this.origin, rounds, result };
  }

  /** Diagnostics: how many rounds used each intent (tests check the per-match caps). */
  intents(): { soft: number; read: number; tease: number } {
    const all = [...this.rounds, ...(this.rounds.includes(this.round) ? [] : [this.round])];
    return { soft: all.filter(round => round.secret.intent === 'soft').length, read: all.filter(round => round.secret.intent === 'read').length, tease: this.teaseUsed ? 1 : 0 };
  }
}
