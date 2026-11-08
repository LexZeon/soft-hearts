import { randomUUID } from 'node:crypto';
import { BODY_MAX_STRENGTH, BODY_START_AGE_MS, bodyIdentity, isBodyRecipeId,
  BODY_IDLE_OBSERVATION_TTL_MS, type BodyStageObservation,
  type BodyMotionCue, type BodyMotionPlan, type BodyMotionReason, type BodyRecipeId } from '../shared/body-motion';
import { IdleMotionScheduler, type IdleMotionCandidate, type IdleMotionGates } from '../shared/idle-motion';
import { vmdDurationMs } from '../shared/vmd-duration';
import { CONTINUOUS_IDLE_CANDIDATES, reviewedIdleCandidates } from './idle-motion-registry';

export interface BodyMotionHostGates {
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly phase: string;
  readonly posture: number;
  readonly waitingForReply: boolean;
  readonly gestureActive: boolean;
}
const SOURCE_DURATION: Readonly<Record<BodyRecipeId, number>> = Object.freeze({
  'idle.neutral': 10_000, 'idle.proud': vmdDurationMs(161), 'body.confirm': 10_000,
});
const eligible = (gates: BodyMotionHostGates): boolean => !!gates && gates.enabled === true && gates.visible === true
  && gates.phase === 'idle' && gates.waitingForReply === false && gates.gestureActive === false
  && Number.isFinite(gates.posture) && gates.posture > 0 && gates.posture <= 100;
const finiteTime = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 60_000;

/**
 * Normal automatic body/idle choices remain HARD CLOSED. The only optional cue
 * is one host-configured startup QA recipe, never a persisted/runtime renderer
 * option. prepare is called only after the stage reports ready and the host has
 * independently verified current Gene content. No mood events or writes occur.
 */
export class BodyMotionController {
  private configured = false;
  private qaRecipe: BodyRecipeId | null = null;
  private spent = false;
  private scope: string | null = null;
  private cue: Readonly<BodyMotionCue> | null = null;
  private lastNow: number | null = null;
  private reason: BodyMotionReason = 'normal-pool-closed';
  private readonly idle: IdleMotionScheduler;
  private readonly idleCount: number;
  private idleEpoch = randomUUID();
  private idleRevision = 0;
  private idleStage: { token: string; value: BodyStageObservation; receivedAt: number; targetVerified: boolean } | null = null;
  private idlePlan: BodyMotionPlan = { mode: 'closed', cue: null, reason: 'normal-pool-closed' };

  constructor(private readonly clock = Date.now, private readonly newId: () => string = randomUUID,
    options: { readonly idleCandidates?: readonly IdleMotionCandidate[] } = {}) {
    this.idle = new IdleMotionScheduler(randomUUID());
    const candidates = reviewedIdleCandidates(options.idleCandidates ?? CONTINUOUS_IDLE_CANDIDATES);
    this.idle.replaceCandidates(candidates); this.idleCount = candidates.length;
  }

  /** Called synchronously before async model verification. A newer denial revokes immediately. */
  observeIdleStage(token: string, value: BodyStageObservation): boolean {
    if (this.qaRecipe || !this.idleCount || !bodyIdentity(token) || value.epoch !== this.idleEpoch) return false;
    const now = this.readClock(); if (now === null) return false;
    const previous = this.idleStage;
    if (value.revision <= this.idleRevision) {
      this.idle.cancel(); this.idleStage = null;
      this.idlePlan = { mode: 'idle-scheduler', observationEpoch: this.idleEpoch, cue: null, reason: 'idle-blocked' };
      return false;
    }
    this.idleRevision = value.revision;
    this.idleStage = { token, value, receivedAt: now, targetVerified: previous?.token === token && previous.targetVerified };
    if (!this.idleStageAllowed(value)) { this.idle.cancel(); this.idlePlan = { mode: 'idle-scheduler', observationEpoch: this.idleEpoch, cue: null, reason: 'idle-blocked' }; }
    return true;
  }

  private idleStageAllowed(v: BodyStageObservation): boolean {
    return v.ready && v.enabled && v.visible && !v.manualPose && !v.manualGesture && !v.manualExpression
      && !v.manualHead && !v.dynamicPose && !v.cameraOrWindow && !v.inputBlocked && !v.directContact
      && !v.music && !v.speaking && !v.waitingForReply && !v.chatGesture && !v.preview;
  }

  private observeIdle(token: string, gates: BodyMotionHostGates, now: number): BodyMotionPlan {
    if (!this.idleCount) return this.idlePlan = { mode: 'closed', cue: null, reason: 'normal-pool-closed' };
    const stage = this.idleStage?.token === token ? this.idleStage : null;
    const fresh = !!stage && now >= stage.receivedAt && now - stage.receivedAt <= BODY_IDLE_OBSERVATION_TTL_MS;
    const v = fresh ? stage!.value : null;
    const blocked = !v;
    const input: IdleMotionGates = {
      enabled: gates.enabled && !!v?.enabled && !!v?.ready,
      visible: gates.visible && !!v?.visible, targetVerified: fresh && stage!.targetVerified,
      manualPose: blocked || v!.manualPose, manualGesture: blocked || v!.manualGesture,
      dynamicPose: blocked || v!.dynamicPose, manualExpression: blocked || v!.manualExpression,
      manualHead: blocked || v!.manualHead, directContact: gates.phase !== 'idle' || blocked || v!.directContact,
      speaking: blocked || v!.speaking, waitingForReply: gates.waitingForReply || gates.gestureActive || blocked || v!.waitingForReply || v!.chatGesture,
      music: blocked || v!.music, windowCameraInput: blocked || v!.cameraOrWindow || v!.inputBlocked,
      preview: blocked || v!.preview,
    };
    const decision = this.idle.tick({ scopeToken: `${token}_${this.idleEpoch}`, now, gates: input, intensity: gates.posture / 100 });
    const c = decision.cue;
    this.idlePlan = Object.freeze({ mode: 'idle-scheduler', observationEpoch: this.idleEpoch, reason: `idle-${decision.reason}` as BodyMotionReason,
      cue: c && isBodyRecipeId(c.recipeId) ? Object.freeze({ id: c.id, token, recipeId: c.recipeId,
        at: c.at, expiresAt: c.expiresAt, durationMs: c.durationMs, strength: c.strength }) : null });
    return this.idlePlan;
  }

  /** Host-only, once per process startup; invalid configuration cannot be retried. */
  configureQa(recipeId: unknown): boolean {
    if (this.configured) return false;
    this.configured = true;
    if (!isBodyRecipeId(recipeId)) { this.reason = 'normal-pool-closed'; return false; }
    this.idle.cancel(); this.idleStage = null;
    this.qaRecipe = recipeId; this.reason = 'qa-ready';
    return true;
  }

  observe(token: string, gates: BodyMotionHostGates): BodyMotionPlan {
    const now = this.readClock();
    if (!bodyIdentity(token)) { this.cancel('invalid-scope'); return this.plan(); }
    if (this.scope !== null && this.scope !== token) this.cancel();
    this.scope = token;
    if (now === null) return this.plan();
    if (!this.qaRecipe) return this.observeIdle(token, gates, now);
    if (!this.qaRecipe) { this.cue = null; return this.plan(); }
    if (!eligible(gates)) {
      this.cue = null; this.reason = 'blocked';
      return this.plan();
    }
    if (this.cue && now >= this.cue.expiresAt) { this.cue = null; this.reason = 'expired'; }
    if (!this.cue && !this.spent) this.reason = 'qa-ready';
    else if (!this.cue && this.spent && (this.reason === 'blocked' || this.reason === 'qa-issued' || this.reason === 'qa-ready'))
      this.reason = 'qa-consumed';
    return this.plan();
  }

  /** A single ready attempt is consumed even if the current host gate denies it. */
  prepare(token: string, gates: BodyMotionHostGates, targetVerified: boolean, stage?: BodyStageObservation): BodyMotionPlan {
    if (!this.qaRecipe) {
      if (!bodyIdentity(token) || !stage || stage.epoch !== this.idleEpoch || this.idleStage?.token !== token || this.idleStage.value.revision !== stage.revision)
        return this.idlePlan;
      this.idleStage.targetVerified = targetVerified === true;
      return this.observe(token, gates);
    }
    // A stale renderer prepare cannot change/cancel a newer host scope.
    if (!bodyIdentity(token) || (this.scope !== null && this.scope !== token))
      return Object.freeze({ cue: null, mode: this.qaRecipe ? 'maintainer-qa' : 'closed', reason: 'invalid-scope' });
    const observed = this.observe(token, gates);
    if (!this.qaRecipe) return observed;
    // A fresh host denial revokes an already issued lease too. Single-use
    // admission must never turn an earlier successful model check into authority
    // after that target stops being supported.
    if (targetVerified !== true) { this.cancel('unsupported-target'); return this.plan(); }
    if (this.spent) return observed;
    this.spent = true;
    if (!eligible(gates) || this.lastNow === null
      || observed.reason === 'clock-break') {
      this.reason = observed.reason;
      this.cue = null; return this.plan();
    }
    const id = this.newId();
    if (!bodyIdentity(id)) { this.reason = 'invalid-scope'; return this.plan(); }
    const at = this.lastNow, durationMs = SOURCE_DURATION[this.qaRecipe];
    const strength = Math.min(BODY_MAX_STRENGTH, 0.2 * gates.posture / 50);
    this.cue = Object.freeze({ id, token, recipeId: this.qaRecipe, at,
      expiresAt: at + durationMs + BODY_START_AGE_MS, durationMs, strength });
    this.reason = 'qa-issued';
    return this.plan();
  }

  /** The full lease covers an original pass from the latest accepted start. */
  ownsCue(cueId: string, token: string): boolean {
    const now = this.readClock();
    if (!this.qaRecipe) return now !== null && !!this.idleStage?.targetVerified && this.idle.ownsCue(cueId, `${token}_${this.idleEpoch}`, now);
    return now !== null && !!this.cue && this.cue.id === cueId && this.cue.token === token
      && this.scope === token && now >= this.cue.at && now < this.cue.expiresAt;
  }
  canStartCue(cueId: string, token: string): boolean {
    if (!this.qaRecipe) { const now = this.readClock(); return now !== null && !!this.idleStage?.targetVerified && this.idle.canStart(cueId, `${token}_${this.idleEpoch}`, now); }
    if (!this.ownsCue(cueId, token)) return false;
    return !!this.cue && this.lastNow !== null && this.lastNow - this.cue.at <= BODY_START_AGE_MS;
  }
  cancel(reason: BodyMotionReason = 'cancelled'): boolean {
    const changed = this.cue !== null || this.idlePlan.cue !== null;
    this.idle.cancel(); this.idleStage = null;
    this.idleEpoch = randomUUID(); this.idleRevision = 0;
    this.idlePlan = this.idleCount ? { mode: 'idle-scheduler', observationEpoch: this.idleEpoch, cue: null, reason: 'idle-blocked' }
      : { mode: 'closed', cue: null, reason: 'normal-pool-closed' };
    this.cue = null;
    if (this.qaRecipe) { this.spent = true; this.reason = reason; }
    return changed;
  }

  private readClock(): number | null {
    let now: number;
    try { now = this.clock(); } catch { this.cancel('clock-break'); return null; }
    if (!finiteTime(now)) { this.cancel('clock-break'); return null; }
    if (this.lastNow !== null && (now < this.lastNow || now - this.lastNow > 5_000)) {
      // Keep the high-water mark on rollback; an old source cannot become fresh.
      this.lastNow = Math.max(this.lastNow, now);
      this.cancel('clock-break'); return null;
    }
    this.lastNow = now;
    return now;
  }
  private plan(): BodyMotionPlan {
    if (!this.qaRecipe) return this.idlePlan;
    return Object.freeze({ cue: this.cue, mode: this.qaRecipe ? 'maintainer-qa' : 'closed', reason: this.reason });
  }
}
