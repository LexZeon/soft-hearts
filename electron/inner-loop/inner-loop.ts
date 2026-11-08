import { randomUUID } from 'node:crypto';
import type { MoodParameters } from '../../shared/mood';
import type { ProactiveOrigin, ProactiveSpeechLease, ProactiveSpeechOpportunity } from '../../shared/proactive-speech';
import { INNER_INITIATIVE_LABEL } from '../../shared/vision-runtime';
import { innerLoopUserRecentlyActive, parseInnerLoopDecision, sanitizeInnerLoopDiagnostic, type InnerLoopAction, type InnerLoopCueKind,
  type InnerLoopDiagnostic, type InnerLoopFocus, type InnerLoopQuiet, type InnerLoopResult } from '../../shared/inner-loop';
import type { HerLifeActivity, HerLifeSwitchOffer } from '../../shared/her-life';
import { innerRhythmDraw, innerRhythmStretch, innerRhythmTalkScale } from '../../shared/behaviors/inner-rhythm/choose';
import type { ProactiveTalk } from '../../shared/behaviors/inner-rhythm/knobs';

/** One accepted mood cue now owned by the inner loop. */
export interface InnerLoopClaim { id: string; kind: InnerLoopCueKind; at: number; characterId: string }
/** Same shape as a visual initiative, so it uses the same bubble → presentation → archive → readout path. */
export interface InnerLoopMessage { id: string; text: string; origin: ProactiveOrigin }
export interface InnerLoopUsage { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }

export interface InnerLoopDependencies {
  gate: { tryAcquire(opportunity: ProactiveSpeechOpportunity, source: 'inner'): ProactiveSpeechLease | null };
  clock?: () => number;
  createId?: () => string;
  /** App setting `innerLoop` and the existing automatic-expression switch. */
  enabled(): boolean;
  /** At the cue: the existing canExpress gate (visible, no typing/chat/speech/drag, gate free) and an idle mood phase. */
  canStart(): boolean;
  /** While deciding and delivering: still visible, no typing, no chat, idle, switch on. */
  current(): boolean;
  scope(): { characterId: string; gateScope: string } | null;
  parameters(): MoodParameters;
  quiet(): InnerLoopQuiet;
  /** `focus` (I-020 #10): what the opening choice gave this speech opportunity for; absent for motion and for callers without the choice. */
  prompt(claim: Readonly<InnerLoopClaim>, allowSpeech: boolean, quiet: Readonly<InnerLoopQuiet>, herLife?: Readonly<HerLifeSwitchOffer> | null, play?: boolean,
    focus?: InnerLoopFocus): string;
  /**
   * 她自己的生活 ("换件事做"): on a motion opportunity, what she may switch to (read once, before the one call
   * that already happens); the choice is applied only if the host's offer still stands. Omitted: no option.
   */
  herLife?: {
    offer(claim: Readonly<InnerLoopClaim>): HerLifeSwitchOffer | null;
    switch(claim: Readonly<InnerLoopClaim>, activity: HerLifeActivity): void;
  };
  /**
   * G1 猜拳 ("邀请玩猜拳"): on a speech opportunity that may speak (not the night's rest reminder), whether the host
   * offers the invite option (read once, before the one call that already happens), and the visible, committed
   * invitation line's hand-off (the game's buttons). Omitted: no such option.
   */
  play?: {
    eligible(claim: Readonly<InnerLoopClaim>, quiet: Readonly<InnerLoopQuiet>): boolean;
    invited(claim: Readonly<InnerLoopClaim>): void;
  };
  decide(prompt: string, signal: AbortSignal): Promise<{ text: string; usage?: InnerLoopUsage | null }>;
  /** Present the decided look/motion as a new cue with id `eventId` (MoodHost attention, claimed). */
  realize(claim: Readonly<InnerLoopClaim>, kind: 'look' | 'motion', eventId: string): void;
  /** A speech claim that produced no visible line returns its hourly/unanswered quota. */
  releaseSpeech(claim: Readonly<InnerLoopClaim>): void;
  offer(message: InnerLoopMessage): boolean | void;
  /** Host-confirmed visible presentation; a renderer append alone is insufficient. */
  present(message: Readonly<InnerLoopMessage>, signal: AbortSignal): Promise<boolean>;
  presentationCurrent(message: Readonly<InnerLoopMessage>): boolean;
  cancelOffer?(id: string): void;
  archive(message: InnerLoopMessage): Promise<void>;
  /** `characterId`: whose opportunity it was (the 体验记录 needs it; the developer log does not). */
  record?(entry: InnerLoopDiagnostic, characterId: string): void;
  /**
   * while quiet (night or drowsy, never asleep) a speech opportunity may
   * still become one short, gentle rest reminder when the user was evidently awake (a real interaction within
   * min(speechIntervalMs, 30 min)); at most once per night, remembered across restarts.
   */
  restReminder?: {
    /** MoodState.lastInteractionAt: the last chat, pat or feeding. */
    lastInteractionAt(): number | null;
    /** innerLoopNightKey for this moment. */
    nightKey(now: number): string;
    /** Already reminded this night, or not known yet (fail closed). */
    used(nightKey: string): boolean;
    remember(nightKey: string): void;
  };
  /**
   * I-013 L1 rhythm (shared/behaviors/inner-rhythm/): the minimum spacing between two model calls stops being a fixed 2 × motionIntervalMs and
   * becomes that × a random draw × a deep-night factor × a user-away factor (all >= 1, so never earlier than before). Omitted: the old fixed spacing.
   */
  rhythm?: {
    random(): number;
    /** Minutes since the user's last interaction with her (chat, pat, feeding); null if unknown. */
    awayMinutes(): number | null;
    /** The system reads the user as away (locked, long idle: electron/user-activity.ts). */
    userAway(): boolean;
    /** 设置「她主动找你说话」: less stretches the spacing (and the speech chances too), more shortens it but never below today's minimum. Omitted: normal. */
    talk?(): ProactiveTalk;
  };
  /** The opportunity ended (any result): release per-request leases such as the profile context. */
  settled?(claim: Readonly<InnerLoopClaim>): void;
  decideTimeoutMs?: number;
}

interface Pending {
  claim: InnerLoopClaim;
  lease: ProactiveSpeechLease;
  allowSpeech: boolean;
  /** The night this opportunity may spend its one rest reminder on, or null. */
  reminderNight: string | null;
  quiet: InnerLoopQuiet;
  deadline: number;
  message: InnerLoopMessage | null;
  offeredAt: number | null;
  presenting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  called: boolean;
  /** The host offered "邀请玩猜拳" on this opportunity. */
  play: boolean;
  /** I-020 #10: what the opening choice gave it for (undefined: a motion opportunity, or a caller without the choice). */
  focus: InnerLoopFocus | undefined;
  decision: InnerLoopAction;
  ms: number | null;
  usage: InnerLoopUsage | null;
  releaseAbort: () => void;
}

const REQUEST_MS = 60_000;
const DECIDE_MS = 25_000;
const ACK_MS = 20_000;
const MAX_IDS = 256;
const NO_USAGE: InnerLoopUsage = { inputTokens: null, outputTokens: null, costUsd: null };

function remember(set: Set<string>, id: string): void {
  set.add(id);
  while (set.size > MAX_IDS) set.delete(set.values().next().value!);
}

/**
 * Her own decision on a mood cue. Motion cues come straight here; a speech cue comes only when the opening choice
 * (electron/inner-loop/opening-host.ts, I-020 #10) gave it her small feeling, an invite to play or the night's rest reminder
 * (`focus`). It owns at most one motion/speech opportunity at a time, holds the shared proactive-speech gate while deciding, and asks
 * the model at most once per opportunity (motion: at most every 2 × motionIntervalMs). Anything other
 * than a valid, visibly presented decision is "do nothing"; late results are dropped. No timer of its own.
 */
export class InnerLoop {
  private pending: Pending | null = null;
  private readonly claimed = new Set<string>();
  private readonly seen = new Set<string>();
  /** Last model call per character, either cue kind: a speech decision could already choose a motion. */
  private readonly lastAsked = new Map<string, number>();
  /** I-013: the random multiplier drawn after the last real ask, per character. */
  private readonly rhythmDraw = new Map<string, number>();
  private disposed = false;
  private lastNow = -Infinity;
  private readonly clock: () => number;
  constructor(private readonly deps: InnerLoopDependencies) { this.clock = deps.clock ?? Date.now; }

  get busy(): boolean { return this.pending !== null; }
  /** An offered line waiting for the pet's acknowledgement. */
  owns(id: unknown): boolean { return typeof id === 'string' && this.pending?.message?.id === id; }
  /** Cues this loop took; the host hides them from the renderer (no fixed line, no rule motion). */
  claims(cueId: unknown): boolean { return typeof cueId === 'string' && this.claimed.has(cueId); }

  /**
   * `focus` (I-020 #10): the opening choice gave this speech cue her small feeling ('mood'), an invite to play ('play') or the night's
   * rest reminder ('rest'); with a focus a listen-together pause-point cue (one with a source) is taken too. Without one a speech cue
   * keeps its old meaning (a source cue is refused, the invite is offered when eligible): single-claimant harnesses and the old arm
   * of the frequency comparison.
   */
  offerOpportunity(value: unknown, focus?: InnerLoopFocus): boolean {
    const cue = innerCue(value, focus !== undefined);
    if (!cue) return false;
    if (this.claimed.has(cue.id)) return true;
    if (this.disposed || this.seen.has(cue.id)) return false;
    // Decided once, on first sight: a cue the renderer may already show is never taken later.
    remember(this.seen, cue.id);
    const now = this.now();
    if (!Number.isFinite(now) || cue.until <= now || cue.at > now || this.pending) return false;
    if (!this.safe(() => this.deps.enabled())) return false;
    if (!this.safe(() => this.deps.canStart())) return false;
    let scope: { characterId: string; gateScope: string } | null = null;
    let p: MoodParameters;
    try { scope = this.deps.scope(); p = this.deps.parameters(); } catch { return false; }
    if (!scope) return false;
    const claim: InnerLoopClaim = { id: cue.id, kind: cue.kind, at: cue.at, characterId: scope.characterId };
    let quiet: InnerLoopQuiet;
    try { quiet = this.deps.quiet(); } catch { quiet = { asleep: false, drowsy: false, night: false, quiet: true }; }
    if (cue.kind === 'motion') {
      const last = this.lastAsked.get(scope.characterId);
      // A motion opportunity asks the model at most once per 2 × the card's motion interval
      // (since the last call of either kind); the others keep the existing rule motion.
      // With the rhythm (I-013): x her last random draw x the night / user-away stretch (all >= 1).
      if (last !== undefined && now >= last && now - last < 2 * p.frequency.motionIntervalMs * this.rhythmFactor(scope.characterId, quiet, true)) return false;
    }
    if (quiet.asleep) {
      if (cue.kind !== 'speech') return false;
      this.sleptThrough(claim);
      return true;
    }
    const speechLimits = p.frequency.speechPerHour > 0 && p.frequency.speechWithoutReply > 0;
    const reminderNight = cue.kind === 'speech' ? this.reminderNight(now, p, quiet) : null;
    const allowSpeech = cue.kind === 'speech' && speechLimits && (!quiet.quiet || reminderNight !== null);
    if (reminderNight) quiet = { ...quiet, restReminder: true };
    // With "少一点" the speech cues she could really speak on are spaced out the same way (the card's caps still decide the rest).
    if (cue.kind === 'speech' && (!allowSpeech || this.talkScale() > 1) && this.deps.rhythm) {
      // A speech cue she has nothing to say on (night, drowsy, limits) is a look-only call: it takes the night / user-away stretch too
      // (x her last random draw, but only when the stretch applies). Refused, the opening choice reads it as "这次不说" and returns the quota.
      const last = this.lastAsked.get(scope.characterId), stretch = this.rhythmFactor(scope.characterId, quiet, false);
      if (stretch > 1 && last !== undefined && now >= last && now - last < 2 * p.frequency.motionIntervalMs * stretch * (this.rhythmDraw.get(scope.characterId) ?? 1)) return false;
    }
    let lease: ProactiveSpeechLease | null = null;
    try { lease = this.deps.gate.tryAcquire({ scope: scope.gateScope, opportunityId: cue.id, expiresAt: now + REQUEST_MS }, 'inner'); }
    catch { lease = null; }
    if (!lease) return false;
    remember(this.claimed, cue.id);
    this.lastAsked.set(scope.characterId, now);
    this.drawRhythm(scope.characterId, p);
    const pending: Pending = { claim, lease, allowSpeech, reminderNight, quiet: { ...quiet }, deadline: now + REQUEST_MS,
      message: null, offeredAt: null, presenting: false, timer: null, called: false, play: false, focus: cue.kind === 'speech' ? focus : undefined, decision: 'none', ms: null,
      usage: null, releaseAbort: () => {} };
    const aborted = () => { if (this.pending === pending) this.finish(pending, 'cancelled'); };
    lease.signal.addEventListener('abort', aborted, { once: true });
    pending.releaseAbort = () => lease!.signal.removeEventListener('abort', aborted);
    this.pending = pending;
    void this.run(pending);
    return true;
  }

  /** The multiplier on the minimum spacing: her last random draw (only if `withDraw`) x the night / user-away stretch; 1 without the rhythm. */
  private rhythmFactor(characterId: string, quiet: Readonly<InnerLoopQuiet>, withDraw: boolean): number {
    const rhythm = this.deps.rhythm;
    if (!rhythm) return 1;
    let awayMinutes: number | null = null, userAway = false;
    try { awayMinutes = rhythm.awayMinutes(); } catch { awayMinutes = null; }
    try { userAway = rhythm.userAway() === true; } catch { userAway = false; }
    const product = (withDraw ? this.rhythmDraw.get(characterId) ?? 1 : 1) * innerRhythmStretch({ night: quiet.night, drowsy: quiet.drowsy, awayMinutes, userAway });
    const scale = this.talkScale();
    return scale === 1 ? product : Math.max(1, product * scale);
  }

  /** 设置「她主动找你说话」: 1 for 适中 (nothing changes), > 1 少一点, < 1 多一点; a failing reader counts as 适中. */
  private talkScale(): number {
    const rhythm = this.deps.rhythm;
    if (!rhythm?.talk) return 1;
    try { return innerRhythmTalkScale(rhythm.talk()); } catch { return 1; }
  }

  /** After a real ask: draw the random multiplier for the next spacing, not too close to the last one. */
  private drawRhythm(characterId: string, p: MoodParameters): void {
    const rhythm = this.deps.rhythm;
    if (!rhythm) return;
    try { this.rhythmDraw.set(characterId, innerRhythmDraw(() => rhythm.random(), p.weights.playful, this.rhythmDraw.get(characterId) ?? null)); }
    catch { this.rhythmDraw.delete(characterId); }
  }

  /** She is asleep (asleep / micro-awake), by the same quiet rules as her own decisions; electron/inner-loop/claim.ts asks it for every claimant. */
  asleep(): boolean {
    try { return this.deps.quiet().asleep === true; } catch { return false; }
  }

  /** The quiet rules now (night, drowsy, asleep), for the opening choice's "深夜""有点困". An unreadable clock counts as quiet. */
  quietNow(): InnerLoopQuiet {
    try { return { ...this.deps.quiet() }; } catch { return { asleep: false, drowsy: false, night: false, quiet: true }; }
  }

  /**
   * Look, don't take (I-020 #10): would offerOpportunity(cue, focus) take this cue now? The same gates (switch, expression gate, a
   * live cue never seen before, nothing pending, a scope), without remembering the cue, holding the gate or asking anything.
   */
  canTake(value: unknown, focus?: InnerLoopFocus): boolean {
    const cue = innerCue(value, focus !== undefined);
    if (!cue || this.disposed || this.pending || this.claimed.has(cue.id) || this.seen.has(cue.id)) return false;
    const now = this.now();
    if (!Number.isFinite(now) || cue.until <= now || cue.at > now) return false;
    if (!this.safe(() => this.deps.enabled()) || !this.safe(() => this.deps.canStart())) return false;
    try { return !!this.deps.scope(); } catch { return false; }
  }

  /**
   * Look, don't take: this speech opportunity would be the night's one rest reminder: quiet
   * (night or drowsy, not asleep), the user evidently awake, not yet reminded tonight. Nothing is remembered.
   */
  restReminderDue(): boolean {
    const now = this.now();
    if (!Number.isFinite(now)) return false;
    let p: MoodParameters;
    try { p = this.deps.parameters(); } catch { return false; }
    const quiet = this.quietNow();
    return !quiet.asleep && this.reminderNight(now, p, quiet) !== null;
  }

  /** The night this speech opportunity may spend its one rest reminder on, or null. */
  private reminderNight(now: number, p: MoodParameters, quiet: InnerLoopQuiet): string | null {
    const speechLimits = p.frequency.speechPerHour > 0 && p.frequency.speechWithoutReply > 0;
    if (!quiet.quiet || !speechLimits || !this.deps.restReminder) return null;
    try {
      const reminder = this.deps.restReminder, night = reminder.nightKey(now);
      return innerLoopUserRecentlyActive(reminder.lastInteractionAt(), now, p) && !reminder.used(night) ? night : null;
    } catch { return null; }
  }

  /**
   * A speech cue she sleeps through (claimMoodCue gives it to nobody): silence without a model call, its quota returned
   * (the cooldown stays), recorded as 睡着. Unlike offerOpportunity it needs neither the switch, the expression gate nor
   * Claude, and takes a listen-together cue too: nothing is shown or asked either way. True: taken (claims() then holds it).
   */
  silence(value: unknown): boolean {
    const cue = innerCue(value, true);
    if (!cue || cue.kind !== 'speech') return false;
    if (this.claimed.has(cue.id)) return true;
    if (this.disposed || this.seen.has(cue.id)) return false;
    remember(this.seen, cue.id);
    let scope: { characterId: string; gateScope: string } | null = null;
    try { scope = this.deps.scope(); } catch { scope = null; }
    if (!scope) return false;
    this.sleptThrough({ id: cue.id, kind: cue.kind, at: cue.at, characterId: scope.characterId });
    return true;
  }

  /** Renderer acknowledgement of the offered bubble; commits only after host-confirmed presentation. */
  async ack(id: unknown): Promise<boolean> {
    const pending = this.pending, now = this.now();
    if (!pending || typeof id !== 'string' || pending.message?.id !== id || pending.offeredAt === null || pending.presenting) return false;
    if (!this.live(pending) || now - pending.offeredAt < 0 || now - pending.offeredAt >= ACK_MS) {
      this.finish(pending, 'undelivered');
      return false;
    }
    pending.presenting = true;
    try {
      const presentation = frozen(pending.message!);
      const shown = await untilAborted(this.deps.present(presentation, pending.lease.signal), pending.lease.signal);
      const completedAt = this.now();
      if (shown !== true || !this.live(pending) || completedAt - pending.offeredAt < 0 || completedAt - pending.offeredAt >= ACK_MS) {
        if (this.pending === pending) this.finish(pending, 'undelivered');
        return false;
      }
      // No await between this exact proof and the commit.
      if (this.deps.presentationCurrent(presentation) !== true || !pending.lease.commit()) {
        this.finish(pending, 'undelivered');
        return false;
      }
      const message = structuredClone(pending.message!);
      const invited = pending.decision === 'invite';
      this.finish(pending, 'delivered');
      // G1: the invitation was really shown and committed; only now do the game's buttons appear.
      if (invited) { try { this.deps.play?.invited(pending.claim); } catch { /* The game host refused; the line stays a line. */ } }
      // An archive failure cannot repeat a presentation or spend another opportunity.
      try { void this.deps.archive(message).catch(() => {}); } catch { /* Text stays visible; only the record is lost. */ }
      return true;
    } catch {
      if (this.pending === pending) this.finish(pending, 'undelivered');
      return false;
    }
  }

  /** User input, a new message, hiding, a character switch or the switch turning off. */
  cancel(): void { if (this.pending) this.finish(this.pending, 'cancelled'); }

  /**
   * Developer test command only (electron/test-commands/): forget when the model was last asked, so a test motion
   * opportunity is not held back by the 2 x motion-interval pacing. Quotas, gates and everything else are untouched.
   */
  resetPacing(): void { this.lastAsked.clear(); }

  /** Called from the existing one-second mood tick: no timer of its own. */
  sweep(): void {
    const pending = this.pending;
    if (pending && !this.live(pending)) this.finish(pending, this.now() >= pending.deadline ? 'timeout' : 'cancelled');
  }

  dispose(): void { this.cancel(); this.disposed = true; }

  private async run(pending: Pending): Promise<void> {
    // Leave the mood publish callback before reading context (chatContext reads the mood host again).
    await Promise.resolve();
    if (!this.live(pending)) { if (this.pending === pending) this.finish(pending, 'cancelled'); return; }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.deps.decideTimeoutMs ?? DECIDE_MS);
    timer.unref?.();
    const signal = AbortSignal.any([pending.lease.signal, timeout.signal]);
    const started = this.now();
    let text: string;
    let offer: HerLifeSwitchOffer | null = null;
    if (pending.claim.kind === 'motion') { try { offer = this.deps.herLife?.offer(pending.claim) ?? null; } catch { offer = null; } }
    // #10: the invite is offered when the opening choice picked it (or, without the choice, whenever eligible); never for 'mood' or 'rest'.
    if (pending.claim.kind === 'speech' && pending.allowSpeech && !pending.reminderNight && this.deps.play && pending.focus !== 'mood' && pending.focus !== 'rest') {
      try { pending.play = this.deps.play.eligible(pending.claim, pending.quiet) === true; } catch { pending.play = false; }
    }
    try {
      const focus = pending.focus;
      const prompt = offer ? this.deps.prompt(pending.claim, pending.allowSpeech, pending.quiet, offer)
        : focus ? this.deps.prompt(pending.claim, pending.allowSpeech, pending.quiet, null, pending.play, focus)
          : pending.play ? this.deps.prompt(pending.claim, pending.allowSpeech, pending.quiet, null, true)
            : this.deps.prompt(pending.claim, pending.allowSpeech, pending.quiet);
      pending.called = true;
      const result = await untilAborted(this.deps.decide(prompt, signal), signal);
      pending.usage = usage(result?.usage);
      text = typeof result?.text === 'string' ? result.text : '';
    } catch {
      pending.ms = pending.called ? Math.max(0, this.now() - started) : null;
      if (this.pending === pending) this.finish(pending, timeout.signal.aborted ? 'timeout' : pending.lease.signal.aborted ? 'cancelled' : 'error');
      return;
    } finally { clearTimeout(timer); }
    pending.ms = Math.max(0, this.now() - started);
    // A late answer after a cancellation, switch or expiry is dropped.
    if (!this.live(pending)) { if (this.pending === pending) this.finish(pending, 'cancelled'); return; }
    // #10 "邀你玩猜拳": invite or not; an ordinary line was not one of the options.
    const decision = parseInnerLoopDecision(text, pending.allowSpeech, offer, pending.play, !(pending.focus === 'play' && pending.play));
    if (!decision) return this.finish(pending, 'invalid');
    pending.decision = decision.action;
    if (decision.action === 'none') return this.finish(pending, 'ok');
    if (decision.action === 'switch') {
      // The host re-checks its offer (the user may have come back during the call); a refusal changes nothing.
      try { this.deps.herLife?.switch(pending.claim, decision.activity!); } catch { /* Nothing is shown. */ }
      return this.finish(pending, 'ok');
    }
    if (decision.action === 'look' || decision.action === 'motion') {
      const eventId = (this.deps.createId ?? randomUUID)();
      // The realized cue is shown by the existing rules; it is never claimed again.
      remember(this.seen, eventId);
      try { this.deps.realize(pending.claim, decision.action, eventId); } catch { /* The mood host refused; nothing is shown. */ }
      return this.finish(pending, 'ok');
    }
    const at = Math.floor(this.now());
    const message: InnerLoopMessage = { id: pending.claim.id, text: decision.text!,
      origin: { kind: 'proactive', id: pending.claim.id, at, sources: ['inner'], labels: [INNER_INITIATIVE_LABEL] } };
    pending.message = message;
    pending.offeredAt = at;
    pending.timer = setTimeout(() => { if (this.pending === pending) this.finish(pending, 'undelivered'); },
      Math.max(0, Math.min(ACK_MS, pending.deadline - at)));
    pending.timer.unref?.();
    let offered: boolean | void = false;
    try { offered = this.deps.offer(structuredClone(message)); } catch { offered = false; }
    if (offered === false && this.pending === pending) this.finish(pending, 'undelivered');
  }

  private finish(pending: Pending, result: InnerLoopResult): void {
    if (this.pending !== pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.releaseAbort();
    const delivered = result === 'delivered';
    if (delivered && pending.reminderNight) {
      try { this.deps.restReminder?.remember(pending.reminderNight); } catch { /* Not remembered: at worst one more gentle reminder. */ }
    }
    if (pending.message && !delivered) {
      try { this.deps.cancelOffer?.(pending.message.id); } catch { /* A closed window already lost the offer. */ }
    }
    pending.message = null;
    if (!delivered) {
      if (pending.claim.kind === 'speech') this.release(pending.claim);
      pending.lease.cancel();
    }
    try { this.deps.settled?.(pending.claim); } catch { /* Lease bookkeeping never changes the result. */ }
    this.record({ at: pending.claim.at, cue: pending.claim.kind, called: pending.called, decision: pending.decision, result,
      quiet: pending.claim.kind === 'speech' && pending.quiet.quiet, restReminder: pending.reminderNight !== null, ms: pending.ms, ...(pending.usage ?? NO_USAGE) }, pending.claim.characterId);
  }

  /** Asleep: the speech opportunity becomes silence without a model call and returns its quota. */
  private sleptThrough(claim: InnerLoopClaim): void {
    remember(this.claimed, claim.id);
    this.release(claim);
    this.record({ at: claim.at, cue: 'speech', called: false, decision: 'none', result: 'asleep', quiet: true, ms: null, ...NO_USAGE }, claim.characterId);
  }

  private release(claim: InnerLoopClaim): void {
    try { this.deps.releaseSpeech(claim); } catch { /* The quota stays charged; never retried. */ }
  }

  private live(pending: Pending): boolean {
    if (this.disposed || this.pending !== pending || pending.lease.signal.aborted || this.now() >= pending.deadline) return false;
    if (!this.safe(() => this.deps.current())) return false;
    try { return this.deps.scope()?.characterId === pending.claim.characterId; } catch { return false; }
  }

  private record(entry: InnerLoopDiagnostic, characterId: string): void {
    const clean = sanitizeInnerLoopDiagnostic(entry);
    if (!clean) return;
    try { this.deps.record?.(clean, characterId); } catch { /* Diagnostics never change a decision. */ }
  }

  private safe(check: () => boolean): boolean {
    try { return check() === true; } catch { return false; }
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isFinite(value)) return NaN;
    this.lastNow = Math.max(this.lastNow, value);
    return this.lastNow;
  }
}

/** `withSource`: a listen-together pause-point cue too (silence, or a speech cue the opening choice gave a focus, I-020 #10). */
function innerCue(value: unknown, withSource = false): { id: string; kind: InnerLoopCueKind; at: number; until: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cue = value as Record<string, unknown>;
  if ((cue.kind !== 'motion' && cue.kind !== 'speech') || (!withSource && cue.source !== undefined)
    || typeof cue.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(cue.id)
    || typeof cue.at !== 'number' || !Number.isFinite(cue.at) || typeof cue.until !== 'number' || !Number.isFinite(cue.until)) return null;
  return { id: cue.id, kind: cue.kind, at: cue.at, until: cue.until };
}

function usage(value: unknown): InnerLoopUsage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  return { inputTokens: count(v.inputTokens), outputTokens: count(v.outputTokens), costUsd: count(v.costUsd) };
}

function frozen(message: InnerLoopMessage): Readonly<InnerLoopMessage> {
  const copy = structuredClone(message);
  Object.freeze(copy.origin.sources);
  Object.freeze(copy.origin.labels);
  Object.freeze(copy.origin);
  return Object.freeze(copy);
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Inner loop cancelled', 'AbortError')); };
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
