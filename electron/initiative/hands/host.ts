/**
 * I-087 牵手、拉钩、击掌, host side (docs/claude/2026-11-11-i087-hands.md). One reach, three uses; each is one click in the companion window.
 *
 *  When she reaches (the host decides; the companion window never starts one by itself):
 *   - 牵手 (hold): your mouse rested near her (the companion window asks, handsRequest) — or she wants to by herself, on one of her own
 *     "small motion" opportunities (a mood cue of kind 'motion': the same cue, the same interval; nothing on top). Both by mood:
 *     O high → more often, N or C high (scared, tense) → more often and a tighter grip (not the relationship stage: rules audit item 15).
 *   - 拉钩 (pinky): you just said a plan she noted (P-001's early look recorded it).
 *   - 击掌 (high five): a rock-paper-scissors match was won, or you said you finished something (a local word check, nothing kept).
 *  Never while she is asleep, hidden, the user busy, patted or fed, in a game or handing something over (`free`).
 *
 *  Back to her mood: holding → the 'held-hands' moment (O up, C down, E a little; its own cooldown); a high five → 'high-five' (D);
 *  a pinky promise → the plan is marked as promised; not taken / let go → nothing at all (no guilt). The first hold ever is kept as a
 *  keepsake (我们的小东西) only while 「允许记录」 is on. One closed journal line per reach. Never a model call, a capture or the network.
 */
import { randomBytes } from 'node:crypto';
import {
  forgetPromises, handsAllowed, handsLean, noteFirstHold, noteHandsEnd, noteHandsOffer, notePromise, saysFinished, useOf,
  type HandsMood, type HandsSource,
} from '../../../shared/behaviors/hands/choose';
import { HANDS_KNOBS, HANDS_MOMENT_KINDS, type HandOutcome, type HandUse, type HandWhy } from '../../../shared/behaviors/hands/knobs';
import { readHandsAnswer, readHandsRequest, type HandsEvent } from '../../../shared/behaviors/hands/interface';
import type { HandsStore } from './store';

export interface HandsJournalInput { type: 'hands'; characterId: string; use: HandUse; outcome: HandOutcome; why: HandWhy[]; first?: true }

export interface HandsHostOptions {
  store: Pick<HandsStore, 'load' | 'loaded' | 'ledger' | 'set' | 'known'>;
  /** 内心循环 and 自动表现 are on (off: she never reaches by herself; your resting mouse, a plan, a game and "done" still may). */
  enabled(): boolean;
  /** She may reach now: shown, awake, the user not busy, not patted or fed, no game or offer of hers going. */
  free(): boolean;
  /**
   * 2026-11-25 (16:26 "抱抱不行"): something of hers in full-screen Unbound has her now (she is coming up to the lens, kissing or hugging):
   * no new reach starts over it ("禁止" only stops a new one; the reach is hers to offer again later). Absent: never.
   */
  closeOn?(): boolean;
  characterId(): string;
  mood(characterId: string): HandsMood | null;
  /** To the companion window (desk:hands); false when it could not be sent. */
  send(event: HandsEvent): boolean;
  /** The mood moments 'held-hands' / 'high-five' (electron/mood/mood-moments.ts; their own cooldowns). */
  moment(kind: 'held-hands' | 'high-five', characterId: string, key: string): void;
  journal?(entry: HandsJournalInput): void;
  /** The user profile's 「允许记录」: the first hold is kept and pinky promises are marked only then. */
  recording(): boolean;
  /** 我们的小东西: the first time you held hands (electron/initiative/give/host.ts keepFirstHold). */
  keepFirstHold?(characterId: string, at: number): Promise<boolean>;
  /** P-001: ids of the plans noted since `since` (the ones a pinky promise is about). */
  recentPlans?(since: number): readonly string[];
  clock?: () => number;
  random?: () => number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Offer {
  readonly id: string; readonly characterId: string; readonly use: HandUse; readonly source: HandsSource; readonly why: HandWhy[];
  readonly at: number; readonly planSince: number; timer: unknown; taken: boolean;
}

const newId = () => `hands-${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '')}`;
/** How long after a won match (her arm comes back from the game first) and after her reply the high five comes (ms). */
export const HANDS_AFTER_MS = Object.freeze({ game: 1_800, finished: 1_200 });
/** Chance she answers a plan with her pinky, and a game or "done" with a high five (before the mood factor; at most 1). */
export const HANDS_CHANCE = Object.freeze({ plan: 0.75, game: 0.6, finished: 0.7 });

export class HandsHost {
  private offer: Offer | null = null;
  private readonly decided = new Map<string, boolean>();
  private readonly finished = new Set<string>();
  private readonly pendingTimers = new Set<unknown>();
  private disposed = false;
  readonly stats = { offered: 0, taken: 0, notTaken: 0, interrupted: 0, firstKept: 0, promised: 0 };
  constructor(private readonly options: HandsHostOptions) {}

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private random(): number { return (this.options.random ?? Math.random)(); }
  private get timers() {
    return this.options.timers ?? { set: (callback: () => void, ms: number) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /** Test seam / diagnostics: the reach going on now. */
  current(): { id: string; use: HandUse; source: HandsSource; taken: boolean } | null {
    const o = this.offer;
    return o ? { id: o.id, use: o.use, source: o.source, taken: o.taken } : null;
  }
  get active(): boolean { return this.offer !== null; }

  /**
   * One of her own small-motion opportunities (a mood cue of kind 'motion', from electron/main.ts's mood callback, before the inner
   * loop sees it): she may reach for your hand instead. Decided once per cue id; true = she took this cue (the renderer then shows
   * nothing else for it). Speech cues are never taken.
   */
  claimCue(cue: { id: string; kind: string } | null | undefined): boolean {
    if (!cue || cue.kind !== 'motion' || this.disposed) return false;
    const known = this.decided.get(cue.id);
    if (known !== undefined) return known;
    const taken = this.safe(() => this.options.enabled(), false) && this.tryOffer('own');
    this.decided.set(cue.id, taken);
    while (this.decided.size > 32) this.decided.delete(this.decided.keys().next().value!);
    return taken;
  }

  /** The companion window: your mouse rested within her reach for a moment ({ use: 'hold' }). */
  request(fromPet: boolean, value: unknown): boolean {
    if (fromPet !== true || !readHandsRequest(value) || this.disposed) return false;
    return this.tryOffer('rest');
  }

  /** P-001: a plan was just noted ('early': about two minutes after you said it). Only while recording is on (plans exist only then). */
  planNoted(via: string | undefined): void {
    if (via !== 'early' || this.disposed || !this.safe(() => this.options.recording(), false)) return;
    this.tryOffer('plan');
  }

  /** G1: a match ended with a winner (either of you): a high five a moment later, once her arm is back from the game. */
  gameEnded(result: unknown): void {
    if ((result !== 'her' && result !== 'user') || this.disposed) return;
    this.later(HANDS_AFTER_MS.game, () => this.tryOffer('game'));
  }

  /** A chat message of yours began: only whether it says you finished something is kept (in memory, by request id; never the words). */
  userSaid(requestId: string, text: unknown): void {
    if (typeof requestId !== 'string' || !requestId || !saysFinished(text)) return;
    this.finished.add(requestId);
    while (this.finished.size > 16) this.finished.delete(this.finished.values().next().value!);
  }

  /** Her reply to that message is done: a high five a moment after it (only when the message said you finished something). */
  chatDone(requestId: string, completed: boolean): void {
    if (!this.finished.delete(requestId) || !completed || this.disposed) return;
    this.later(HANDS_AFTER_MS.finished, () => this.tryOffer('finished'));
  }

  /** The companion window: exactly { id, outcome } for the reach going on now. */
  answer(fromPet: boolean, value: unknown): boolean {
    const answer = readHandsAnswer(value), offer = this.offer;
    if (fromPet !== true || !answer || !offer || answer.id !== offer.id) return false;
    if (answer.outcome === 'taken') {
      if (offer.taken) return false;
      this.taken(offer);
      if (offer.use !== 'hold') this.finish(offer, 'taken');
      return true;
    }
    if (answer.outcome === 'let-go' && !offer.taken) return false;
    this.finish(offer, answer.outcome);
    return true;
  }

  /** Recording went off by hand: the pinky promises go with the plans (they are deleted at the same moment). */
  recordingOff(): void {
    for (const characterId of this.options.store.known()) {
      const ledger = this.options.store.ledger(characterId);
      if (ledger && ledger.promises.length) void this.options.store.set(characterId, forgetPromises(ledger)).catch(() => false);
    }
  }

  /** The character changed, her switch went off, she was hidden: the reach goes back quietly (nothing is written but the line). */
  cancel(): void {
    const offer = this.offer;
    if (!offer) return;
    this.safe(() => this.options.send({ type: 'cancel', id: offer.id }), false);
    this.finish(offer, 'interrupted');
  }

  dispose(): void {
    this.cancel(); this.disposed = true;
    for (const handle of this.pendingTimers) this.timers.clear(handle);
    this.pendingTimers.clear(); this.decided.clear(); this.finished.clear();
  }

  private later(ms: number, run: () => void): void {
    const handle = this.timers.set(() => { this.pendingTimers.delete(handle); if (!this.disposed) run(); }, ms);
    this.pendingTimers.add(handle);
  }

  /** Counts, gaps, her mood's chance, then the offer itself. True when an offer went to the companion window. */
  private tryOffer(source: HandsSource): boolean {
    if (this.offer || this.disposed || !this.safe(() => this.options.free(), false)) return false;
    if (this.safe(() => this.options.closeOn?.() === true, false)) return false; // 2026-11-25: her close moment has her now
    const characterId = this.safe(() => this.options.characterId(), '');
    if (!characterId) return false;
    if (!this.options.store.loaded(characterId)) { void this.options.store.load(characterId).catch(() => {}); return false; }
    const ledger = this.options.store.ledger(characterId), now = this.now();
    if (!ledger || !handsAllowed(ledger, source, now)) return false;
    const mood = this.safe(() => this.options.mood(characterId), null);
    if (!mood) return false;
    const lean = handsLean(mood);
    const base = source === 'own' ? HANDS_KNOBS.own.chance : source === 'rest' ? HANDS_KNOBS.rest.chance : HANDS_CHANCE[source];
    // A plan, a game, a "done": her mood leans it, gently (she is glad with you either way); her own wish and your resting mouse: fully.
    const factor = source === 'own' || source === 'rest' ? lean.factor : Math.min(1.3, Math.max(0.6, lean.factor));
    if (!(this.random() < Math.min(1, base * factor))) return false;
    const use = useOf(source);
    const why: HandWhy[] = source === 'rest' ? ['rest', ...lean.why] : source === 'own' ? (lean.why.length ? [...lean.why] : ['herself'])
      : [source, ...lean.why.filter(w => w === 'shy')];
    const id = newId(), waitMs = Math.round(HANDS_KNOBS.waitMs[use] * (use === 'hold' ? lean.wait : 1));
    const offer: Offer = { id, characterId, use, source, why: [...new Set(why)], at: now, planSince: now - 60_000, timer: null, taken: false };
    const sent = this.safe(() => this.options.send({ type: 'offer', id, use, why: offer.why, waitMs, style: lean.style }), false);
    if (!sent) return false;
    this.offer = offer;
    this.stats.offered++;
    void this.options.store.set(characterId, noteHandsOffer(ledger, source, now)).catch(() => false);
    offer.timer = this.timers.set(() => { if (this.offer === offer && !offer.taken) this.finish(offer, 'not-taken'); }, waitMs + HANDS_KNOBS.answerSlackMs);
    return true;
  }

  private taken(offer: Offer): void {
    offer.taken = true;
    this.stats.taken++;
    const now = this.now(), characterId = offer.characterId;
    let first = false;
    if (offer.use === 'hold') {
      // Holding: stays until let go (the companion window says so); the host's own limit only guards a window that went silent.
      this.timers.clear(offer.timer);
      offer.timer = this.timers.set(() => { if (this.offer === offer) this.finish(offer, 'let-go'); }, HANDS_KNOBS.holdLimitMs);
      this.safe(() => this.options.moment(HANDS_MOMENT_KINDS.hold, characterId, offer.id), undefined);
      const ledger = this.options.store.ledger(characterId);
      if (ledger) {
        const recording = this.safe(() => this.options.recording(), false), next = noteFirstHold(ledger, recording);
        if (next.ledger !== ledger) void this.options.store.set(characterId, next.ledger).catch(() => false);
        if (next.keep) {
          first = true;
          void Promise.resolve(this.options.keepFirstHold?.(characterId, now)).then(kept => { if (kept) this.stats.firstKept++; }).catch(() => false);
        }
      }
    } else if (offer.use === 'high-five') {
      this.safe(() => this.options.moment(HANDS_MOMENT_KINDS['high-five'], characterId, offer.id), undefined);
    } else if (this.safe(() => this.options.recording(), false)) {
      // The pinky promise: the plans noted just before are marked (her plan memory reminds later through its own path).
      const plans = this.safe(() => this.options.recentPlans?.(offer.planSince) ?? [], [] as readonly string[]);
      const ledger = this.options.store.ledger(characterId);
      if (ledger && plans.length) {
        const next = notePromise(ledger, plans, now);
        if (next !== ledger) { this.stats.promised += next.promises.length - ledger.promises.length; void this.options.store.set(characterId, next).catch(() => false); }
      }
    }
    this.record(offer, 'taken', first);
  }

  private finish(offer: Offer, outcome: HandOutcome): void {
    if (this.offer !== offer) return;
    this.offer = null;
    this.timers.clear(offer.timer);
    if (outcome === 'not-taken') this.stats.notTaken++;
    else if (outcome === 'interrupted' && !offer.taken) this.stats.interrupted++;
    const ledger = this.options.store.ledger(offer.characterId);
    if (ledger) { const next = noteHandsEnd(ledger, outcome === 'taken' ? 'taken' : outcome, this.now()); if (next !== ledger) void this.options.store.set(offer.characterId, next).catch(() => false); }
    // One line per reach: the taken line was written at the touch; otherwise how it ended (not taken, interrupted before any touch).
    if (!offer.taken) this.record(offer, outcome === 'let-go' ? 'interrupted' : outcome, false);
  }

  private record(offer: Offer, outcome: HandOutcome, first: boolean): void {
    try { this.options.journal?.({ type: 'hands', characterId: offer.characterId, use: offer.use, outcome, why: [...offer.why], ...(first ? { first: true as const } : {}) }); }
    catch { /* A record never changes what she does. */ }
  }
}
