/**
 * P1 第二阶段, host side (docs/claude/2026-11-03-pose-sensing-stage2.md): the local pose signals (electron/pose/, already checked
 * by parsePoseSignal) become her attention, the reactions she catches from the user, the "presence" for her mood, her own stretch
 * after the user sat long, one line for the inner loop and one material line for the diary. Owned by CompanionService, driven by
 * the existing one-second mood tick and by the signals themselves; it owns no timer (a reaction's delay is a start time the stage
 * waits for). Every decision goes through the replaceable policy (shared/pose-reactions.ts, I-013).
 *
 * Nothing here keeps or passes on anything but enums, booleans and times: the signal has no picture and no coordinate, and the
 * session, the view, the journal lines and the words for the inner loop and the diary are built from those alone.
 *
 * I-006 第 2 步 (docs/claude/2026-11-06-i006-step2.md): the same tick also reads the user's state (shared/behaviors/user-activity, off
 * when the 「知道你是不是在忙」 switch is off). When the user stops for a breather after being absorbed, she considers it once: by her
 * card, mood and sleepiness she sometimes stretches (the same small stretch), or, sleepy, yawns behind her hand (哈欠捂嘴, played by
 * the stage only in a whole-body framing). Not when the user came back to her, not while the user is with her or she is asleep; no
 * word, no reminder. After one she rests a while (time and your interactions with her, the policy's rule).
 */
import { randomUUID } from 'node:crypto';
import type { PoseSignal } from '../../shared/pose-signals';
import {
  POSE_MOMENTS_KEEP_MS, POSE_MOMENTS_MAX, POSE_REACTION_POLICY, decidePoseFollow, decidePosePause, emptyPoseFollowMemory, emptyPosePauseMemory, poseAsleep,
  poseAttention, poseDiaryLine, poseInnerLoopLine, poseOwnStretchDue, poseSessionLive, poseSummary, stepPoseSession,
  type PoseCharacter, type PoseCoverCue, type PosePauseMemory, type PoseFollowKind, type PoseFollowMemory, type PoseMomentEntry, type PoseReactionCue, type PoseReactionKind,
  type PoseReactionPolicy, type PoseReactionSource, type PoseReactionView, type PoseSession,
} from '../../shared/pose-reactions';
import type { PoseJournalEvent } from '../../shared/journal';
import type { UserActivityView } from '../../shared/behaviors/user-activity/interface';

export interface PoseReactionTickInput {
  now: number;
  /** "自动表现" (MoodView.expressions). */
  expressions: boolean;
  /** The existing companionCanExpress gate: visible, no typing, chat, speech or drag. */
  canExpress: boolean;
  character: PoseCharacter;
  /** I-006: the user's state now (UserActivityHost.view); null or absent: not known (the switch is off). */
  activity?: Pick<UserActivityView, 'state' | 'since' | 'cause' | 'pretended'> | null;
}

export interface PoseReactionHostOptions {
  /** Her view for this character changed (the mood view republishes it). */
  changed(characterId: string): void;
  /** 在场: the user arrived; MoodHost.presence takes `relief` off her boredom. */
  presence(characterId: string, relief: number, id: string): void;
  /** 体验记录 (shared/journal.ts `pose`): categories only. */
  journal?(characterId: string, event: PoseJournalEvent, kind: PoseFollowKind | null): void;
  /** I-006: how many interactions with her since `at` (I-010 互动余额's count); absent: 0 (time alone). */
  interactionsSince?(characterId: string, at: number): number;
  /** I-006: a live 哈欠捂嘴 cue from the her-action host (not sent; it rides on this cue); null: none (she stretches instead). */
  coverYawn?(): PoseCoverCue | null;
  policy?: PoseReactionPolicy;
  clock?: () => number;
  random?: () => number;
  id?: () => string;
}

/** What a developer test command pretends the camera saw ("测试：我打了个哈欠" …). */
export type PoseSimulation = PoseFollowKind | 'sat' | 'arrive';
export type PoseSimulationResult = 'ok' | 'no-character' | 'expressions-off';
/** A test session holds this long, then sensing is "off" again unless real signals arrive. */
const SIMULATION_MS = 10 * 60_000;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export class PoseReactionHost {
  private session: PoseSession | null = null;
  private memory: PoseFollowMemory = emptyPoseFollowMemory();
  private current: (PoseReactionTickInput & { characterId: string }) | null = null;
  private cue: PoseReactionCue | null = null;
  private published: { characterId: string; attention: number; boost: number; cue: string | null } | null = null;
  /** Her own stretch: when she last stretched (any source) and how long this cycle's sitting must last. */
  private lastStretchAt: number | null = null;
  private ownDueMs: number | null = null;
  private moments: (PoseMomentEntry & { characterId: string })[] = [];
  /** I-006: the breather already considered (its start time), and her rest after the last one. */
  private pauseSeen: number | null = null;
  private pauseMemory: PosePauseMemory = emptyPosePauseMemory();
  private coverYawn: (() => PoseCoverCue | null) | null = null;

  constructor(private readonly options: PoseReactionHostOptions) {}

  /** I-006: the her-action host's 哈欠捂嘴 (electron/main.ts sets it once the her-action host exists). */
  setCoverYawn(source: (() => PoseCoverCue | null) | null): void { this.coverYawn = source; }

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private random(): number { return (this.options.random ?? Math.random)(); }
  private get policy(): PoseReactionPolicy { return this.options.policy ?? POSE_REACTION_POLICY; }

  /** A checked signal from local sensing (electron/pose/host.ts onSignal). */
  signal(signal: PoseSignal, now = this.now()): void {
    if (!Number.isFinite(now)) return;
    const current = this.current, character = current?.character;
    // A real signal ends a developer simulation.
    const previous = this.session && this.session.simulatedUntil === null && poseSessionLive(this.session, now) ? this.session : null;
    const step = stepPoseSession(previous, signal, now, this.policy.arriveAfterMs(character ?? FALLBACK_CHARACTER));
    this.session = step.session;
    if (current && validId(current.characterId)) {
      if (step.arrived) this.arrive(current, now);
      if (step.left) this.note(current.characterId, 'leave', null);
      for (const kind of step.events) this.consider(kind, current, now, false);
    }
    this.publish();
  }

  /**
   * Sensing stopped (the camera switch went off, the process gave up): everything about the user is forgotten at once, and off is
   * off — every reaction queued and not yet started is withdrawn (Codex T-112 round 032; a reaction already playing on the stage
   * plays out and eases back, it is the stage's and never jumps). A developer simulation holds until its own end.
   */
  sensing(on: boolean): void {
    if (on) return;
    if (this.session?.simulatedUntil != null) return;
    this.session = null; this.ownDueMs = null;
    if (this.cue?.source !== 'pause') this.cue = null; // a breather is not the camera's
    this.publish();
  }

  /** The existing one-second mood tick (CompanionService.herLifeTick). */
  tick(characterId: string, input: PoseReactionTickInput): void {
    if (!validId(characterId) || !Number.isFinite(input.now)) return;
    if (this.current && this.current.characterId !== characterId) { this.cue = null; this.ownDueMs = null; }
    this.current = { ...input, characterId };
    const now = input.now;
    if (this.session && !poseSessionLive(this.session, now)) { this.session = null; this.ownDueMs = null; }
    // 她自己的生活: the user has sat long; she stretches because she needs to, not to remind anyone. Only while she may show it.
    const session = this.session;
    if (session?.present && session.sittingSince !== null && input.expressions && input.canExpress && !poseAsleep(input.character) && input.character.posture > 0) {
      this.ownDueMs ??= this.policy.ownStretchAfterMs(input.character, () => this.random());
      if (poseOwnStretchDue(now - session.sittingSince, this.lastStretchAt, now, this.ownDueMs)) this.ownStretch(this.current, now);
    }
    this.breather(this.current, now);
    this.publish();
  }

  /** MoodView.pose for the current character; null while sensing is off and nothing is left to play. */
  view(characterId: string): PoseReactionView | null {
    const current = this.current;
    if (!current || current.characterId !== characterId) return null;
    const now = this.now(), live = poseSessionLive(this.session, now);
    const cue = this.cue && now - this.cue.at <= 10_000 ? { ...this.cue } : null;
    if (!live && !cue) return null;
    return { attention: live ? poseAttention(this.session) : 0, boost: round(this.policy.gazeBoost(current.character)), cue };
  }

  /** The inner loop's one line ('' while sensing is off). */
  innerLoopLine(now = this.now()): string { return poseInnerLoopLine(poseSummary(this.session, now)); }

  /** One material line for that day's diary ('' when nothing): her own moments for this character, counts only. */
  diaryLine(characterId: string, start: number, end: number): string {
    return poseDiaryLine(this.moments.filter(entry => entry.characterId === characterId), start, end);
  }

  /**
   * Developer test command: as if the camera saw it. A follow is forced (no chance, cooldown or gap: the user wants to see it),
   * everything else is the same path (her delay, her strength, the stage's giving way). Holds a pretend session for ten minutes.
   */
  simulate(kind: PoseSimulation, now = this.now()): PoseSimulationResult {
    const current = this.current;
    if (!current || !validId(current.characterId)) return 'no-character';
    if (!current.expressions) return 'expressions-off';
    const live = this.session && poseSessionLive(this.session, now) ? this.session : null;
    const base: PoseSession = live ? { ...live, events: { ...live.events } } : { lastSignalAt: now, simulatedUntil: null, present: true, presentSince: now, awaySince: null,
      facing: 'toward', posture: 'sitting', sittingSince: now, standingSince: null, events: {} };
    const session: PoseSession = { ...base, lastSignalAt: now, simulatedUntil: now + SIMULATION_MS, present: true, facing: 'toward',
      posture: base.posture === 'unknown' || base.posture === 'standing' ? 'sitting' : base.posture, presentSince: base.presentSince ?? now, awaySince: null,
      sittingSince: kind === 'sat' ? now - Math.max(50 * 60_000, this.ownDueMs ?? 0) : base.sittingSince ?? now };
    this.session = session;
    if (kind === 'arrive') this.arrive(current, now);
    else if (kind === 'sat') this.ownStretch(current, now);
    else { session.events[kind] = now; this.consider(kind, current, now, true); }
    this.publish();
    return 'ok';
  }

  // ------------------------------------------------------------ internals

  /**
   * I-006: the user stopped for a breather ("歇一下" because the user stopped, not because the user came to her). Considered once per
   * breather, at the first tick she may show it (自动表现 on, nobody typing, chatting, speaking or dragging, awake, a body that moves).
   */
  private breather(current: PoseReactionTickInput & { characterId: string }, now: number): void {
    const activity = current.activity;
    if (!activity || activity.state !== 'pause' || activity.cause === 'came' || !Number.isFinite(activity.since)) return;
    if (this.pauseSeen === activity.since) return;
    if (!current.expressions || !current.canExpress || poseAsleep(current.character) || !(current.character.posture > 0)) return;
    this.pauseSeen = activity.since;
    // Rest counts from her last breather reaction or her last stretch of any kind, whichever is later.
    const lastAt = Math.max(this.pauseMemory.lastAt ?? -Infinity, this.lastStretchAt ?? -Infinity);
    // Only a caught or her own stretch so far: the rest a caught stretch has.
    const memory: PosePauseMemory = { lastAt: Number.isFinite(lastAt) ? lastAt : null,
      restMs: this.pauseMemory.restMs ?? (Number.isFinite(lastAt) ? this.policy.followCooldownMs('stretch', current.character, () => this.random()) : null) };
    let interactions = 0;
    if (memory.lastAt !== null) { try { interactions = Math.max(0, Number(this.options.interactionsSince?.(current.characterId, memory.lastAt)) || 0); } catch { interactions = 0; } }
    const outcome = decidePosePause(memory, current.character, now, () => this.random(),
      { interactions, lastReactionAt: this.memory.lastReactionAt, force: activity.pretended === true }, this.policy);
    if (outcome.decision === 'pass') { this.note(current.characterId, 'pause-pass', null); return; }
    if (outcome.decision !== 'react') return;
    this.pauseMemory = outcome.memory;
    this.memory = { ...this.memory, lastReactionAt: now };
    const at = now + outcome.delayMs;
    let cover: PoseCoverCue | null = null;
    if (outcome.kind === 'yawn') {
      try { const live = (this.coverYawn ?? this.options.coverYawn)?.(); cover = live ? { id: live.id, at: live.at, expiresAt: live.expiresAt } : null; } catch { cover = null; }
    }
    // No live cue for the hand (no pet window): the stretch instead.
    const kind = outcome.kind === 'yawn' && cover ? 'yawn' : 'stretch';
    this.play(current.characterId, kind, 'pause', at, kind === 'stretch' ? this.policy.strength('stretch', current.character, () => this.random()) : outcome.strength, now);
    if (cover && this.cue) this.cue.cover = cover;
    if (kind === 'stretch') this.stretched(now);
    this.note(current.characterId, 'pause', kind);
  }

  private consider(kind: PoseFollowKind, current: PoseReactionTickInput & { characterId: string }, now: number, force: boolean): void {
    if (!current.expressions) return;
    if (!force && !current.canExpress) return; // she is with the user already (typing, a reply, a drag): this moment is not hers
    const outcome = decidePoseFollow(kind, this.memory, current.character, now, () => this.random(), this.policy, force);
    this.memory = outcome.memory;
    if (outcome.decision === 'pass') this.note(current.characterId, 'pass', kind);
    if (outcome.decision !== 'follow') return;
    this.play(current.characterId, kind, 'follow', now + outcome.delayMs, outcome.strength, now);
    if (kind === 'stretch') this.stretched(now);
    this.note(current.characterId, 'follow', kind);
  }

  private arrive(current: PoseReactionTickInput & { characterId: string }, now: number): void {
    this.note(current.characterId, 'arrive', null);
    if (!current.expressions) return;
    const relief = this.policy.presenceRelief(current.character);
    try { if (relief > 0) this.options.presence(current.characterId, relief, `pose-presence-${this.newId()}`); } catch { /* The mood side never blocks the signals. */ }
    if (poseAsleep(current.character)) return;
    const delay = this.policy.delayMs('glance', 'arrive', current.character, () => this.random());
    this.play(current.characterId, 'glance', 'arrive', now + delay, this.policy.strength('glance', current.character, () => this.random()), now);
  }

  private ownStretch(current: PoseReactionTickInput & { characterId: string }, now: number): void {
    const strength = this.policy.strength('stretch', current.character, () => this.random());
    this.play(current.characterId, 'stretch', 'own', now + this.policy.delayMs('stretch', 'own', current.character, () => this.random()), strength, now);
    this.memory = { ...this.memory, lastReactionAt: now };
    this.stretched(now);
    this.note(current.characterId, 'own', null);
  }

  private stretched(now: number): void {
    this.lastStretchAt = now;
    this.ownDueMs = null; // the next cycle draws its own time
  }

  private play(characterId: string, kind: PoseReactionKind, source: PoseReactionSource, at: number, strength: number, now: number): void {
    this.cue = { id: this.newId(), kind, source, at: Math.round(at), strength: Math.min(1.2, Math.max(0, Number.isFinite(strength) ? strength : 0)) };
    if (kind !== 'glance') {
      this.moments.push({ characterId, at: now, kind, source });
      this.moments = this.moments.filter(entry => now - entry.at <= POSE_MOMENTS_KEEP_MS).slice(-POSE_MOMENTS_MAX);
    }
  }

  private note(characterId: string, event: PoseJournalEvent, kind: PoseFollowKind | null): void {
    try { this.options.journal?.(characterId, event, kind); } catch { /* Keeping a record never changes what she does. */ }
  }

  private newId(): string { return (this.options.id ?? randomUUID)().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'pose'; }

  private publish(): void {
    const current = this.current;
    if (!current) return;
    const view = this.view(current.characterId);
    const next = { characterId: current.characterId, attention: view?.attention ?? -1, boost: view?.boost ?? -1, cue: view?.cue?.id ?? null };
    const last = this.published;
    if (last && last.characterId === next.characterId && last.attention === next.attention && last.boost === next.boost && last.cue === next.cue) return;
    this.published = next;
    try { this.options.changed(current.characterId); } catch { /* A closed window just misses this update. */ }
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;
/** Before the first tick (no card read yet): the default card's numbers. */
const FALLBACK_CHARACTER: PoseCharacter = { weights: null, mood: 'calm', fatigue: null, motionIntervalMs: 5 * 60_000, posture: 50, chatBoredomRelief: 20 };
