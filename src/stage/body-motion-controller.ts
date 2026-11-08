import { AnimationClip, type SkinnedMesh } from 'three';
import { BEHAVIOR_RECIPES } from '../../shared/behavior-recipes';
import { BODY_START_AGE_MS, BODY_MOTION_REASONS, BODY_IDLE_REPORT_INTERVAL_MS, bodyIdentity, isBodyMotionCue,
  type BodyStageObservation, type BodyMotionCue, type BodyMotionPlan, type BodyMotionResource } from '../../shared/body-motion';
import type { BehaviorBodyPlay, BehaviorBodyState } from './behavior-body';
import { vmdDurationSeconds } from '../../shared/vmd-duration';

export interface BodyStageGates {
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly manualPose: boolean;
  readonly manualGesture: boolean;
  readonly manualExpression: boolean;
  readonly manualHead: boolean;
  readonly dynamicPose: boolean;
  readonly cameraOrWindow: boolean;
  readonly inputBlocked: boolean;
  readonly directContact: boolean;
  readonly music: boolean;
  readonly speaking: boolean;
  readonly waitingForReply: boolean;
  readonly chatGesture: boolean;
}
export interface BodyPlayerPort {
  play(input: BehaviorBodyPlay): boolean;
  beforeUpdate(delta: number, blocked: boolean): BehaviorBodyState;
  stop(): void;
  dispose(): void;
  getState(): BehaviorBodyState;
}
export interface BodyControllerDependencies {
  readonly player: BodyPlayerPort;
  readonly targetSupported: boolean;
  /** Optional Stage-owned bounded history survives Layered/player replacement. */
  readonly consumedIds?: Set<string>;
  getPlan(token: string, observation?: BodyStageObservation): Promise<BodyMotionPlan>;
  resolve(cueId: string, token: string): Promise<BodyMotionResource>;
  load(resource: BodyMotionResource, mesh: SkinnedMesh): Promise<AnimationClip>;
  /** Restore outer/continuous layers before changing mixer bindings, rebuild at dt0 afterwards. */
  mutate?<T>(mutation: () => T): T;
  /**
   * R29c cancel hand-off: called instead of a bare stop when a playing motion is
   * revoked (not on dispose or an immediate cancel). It must call `stop` exactly
   * once, synchronously, and may bridge the display from the pose shown before
   * it back to the still-running base (motion-transition.ts handOffToBase).
   */
  release?(trackNames: readonly string[], stop: () => void): void;
  now?: () => number;
}
const gateKeys = ['ready', 'enabled', 'visible', 'manualPose', 'manualGesture', 'manualExpression', 'manualHead', 'dynamicPose',
  'cameraOrWindow', 'inputBlocked', 'directContact', 'music', 'speaking', 'waitingForReply', 'chatGesture'] as const;
const closedGates: BodyStageGates = { ready: false, enabled: false, visible: false, manualPose: false, manualGesture: false, manualExpression: false,
  manualHead: false, dynamicPose: false, cameraOrWindow: false, inputBlocked: false, directContact: false, music: false,
  speaking: false, waitingForReply: false, chatGesture: false };
const keyFor = (cue: BodyMotionCue) => `${cue.token}|${cue.id}|${cue.recipeId}|${cue.at}|${cue.expiresAt}|${cue.durationMs}|${cue.strength}`;
const validTime = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 60_000;
function readPlan(value: BodyMotionPlan | null | undefined): BodyMotionPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['closed', 'maintainer-qa', 'idle-scheduler'].includes(value.mode) || !(BODY_MOTION_REASONS as readonly unknown[]).includes(value.reason)
    || value.mode === 'idle-scheduler' && !bodyIdentity(value.observationEpoch)
    || value.cue !== null && !isBodyMotionCue(value.cue)) return null;
  return Object.freeze({ mode: value.mode, reason: value.reason,
    cue: value.cue ? Object.freeze({ ...value.cue }) : null,
    ...(value.mode === 'idle-scheduler' ? { observationEpoch: value.observationEpoch } : {}) });
}
function checkedResource(value: BodyMotionResource, cue: BodyMotionCue): BodyMotionResource | null {
  const expected = BEHAVIOR_RECIPES[cue.recipeId];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !expected
    || value.cueId !== cue.id || value.recipeId !== cue.recipeId || value.packId !== expected.packId
    || value.motionId !== expected.motionId || value.sha256 !== expected.sha256 || value.maskId !== expected.mask
    || value.durationMs !== expected.durationMs || value.durationMs !== cue.durationMs || typeof value.url !== 'string') return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'mmd-asset:' || !/^[a-f0-9]{32}$/.test(url.hostname) || url.username || url.password || url.port
      || url.search || url.hash || decodeURIComponent(url.pathname) !== `/${expected.motionId}.vmd`) return null;
  } catch { return null; }
  return Object.freeze({ cueId: value.cueId, recipeId: value.recipeId, packId: value.packId, motionId: value.motionId,
    sha256: value.sha256, maskId: value.maskId, durationMs: value.durationMs, url: value.url });
}

/** One model's presentation lease. It has no IPC writer, timer, rewards or stored settings. */
export class BodyMotionController {
  private token = '';
  private epoch = 0;
  private plan: BodyMotionPlan | null = null;
  private planKey = '';
  private gates: BodyStageGates = { ...closedGates };
  private readonly consumed: Set<string>;
  private planRequested = false;
  private qaPrepareAttempted = false;
  private pending = false;
  private pendingCue: BodyMotionCue | null = null;
  private playingCue: BodyMotionCue | null = null;
  private resource: BodyMotionResource | null = null;
  private lastNow: number | null = null;
  private disposed = false;
  private reason = 'not-ready';
  private error = '';
  private idleReportEpoch = '';
  private idleRevision = 0;
  private idleLastAt = -Infinity;
  private idleLastKey = '';
  private idleReportPending = 0;

  constructor(private readonly mesh: SkinnedMesh, private readonly dependencies: BodyControllerDependencies) {
    this.consumed = dependencies.consumedIds ?? new Set<string>();
  }

  update(value: BodyMotionPlan | null | undefined, token: string, gates: BodyStageGates): void {
    if (this.disposed) return;
    if (token !== this.token) {
      this.cancel(); this.token = bodyIdentity(token) ? token : ''; this.plan = null; this.planKey = '';
      this.planRequested = false;
      this.qaPrepareAttempted = false;
      this.idleReportEpoch = ''; this.idleLastKey = ''; this.idleLastAt = -Infinity; this.idleReportPending = 0;
    }
    this.gates = { ...gates };
    if (value !== undefined) {
      const plan = readPlan(value), key = plan ? `${plan.mode}|${plan.observationEpoch ?? ''}|${plan.cue ? keyFor(plan.cue) : 'none'}` : 'invalid';
      const observationalReady = plan?.mode === 'maintainer-qa' && !plan.cue && plan.reason === 'qa-ready';
      if (key !== this.planKey) {
        if (!(observationalReady && this.pending && !this.pendingCue && this.qaPrepareAttempted)) this.cancel();
        this.plan = plan; this.planKey = key;
      }
      else if (plan?.mode === 'idle-scheduler') this.plan = plan;
      // A pushed host plan is authoritative over an in-flight initial read.
      // qa-ready is a read-only observation; only the narrow prepare read can
      // consume its single-use opportunity once this Stage is fully ready.
      if (!observationalReady) this.planRequested = true;
      else if (!this.qaPrepareAttempted && !this.pending) this.planRequested = false;
    }
    const now = this.time();
    if (now !== null) this.reportIdleGates(now);
    if (now === null || !this.baseAllowed()) {
      this.consume(this.plan?.cue); this.cancel(); this.reason = this.dependencies.targetSupported ? 'blocked' : 'unsupported-target'; return;
    }
    // A repeated read-only qa-ready push must not revoke its own in-flight
    // prepare. Direct/local input still invalidates that pending generation.
    if (this.pending && !this.pendingCue && !this.plan?.cue) {
      if (!this.requestAllowed()) { this.cancel(); this.reason = 'blocked'; }
      return;
    }
    if (!this.planRequested) {
      if (!this.requestAllowed()) { this.reason = 'not-ready'; return; }
      this.planRequested = true;
      if (this.plan?.mode === 'maintainer-qa') this.qaPrepareAttempted = true;
      const epoch = this.epoch, expectedToken = this.token;
      this.pending = true;
      void this.dependencies.getPlan(expectedToken).then(plan => {
        if (!this.current(epoch, expectedToken) || !this.baseAllowed()) return;
        this.pending = false;
        if (plan.mode === 'maintainer-qa') this.qaPrepareAttempted = true;
        this.update(plan, expectedToken, this.gates);
      }, () => {
        if (this.current(epoch, expectedToken)) { this.pending = false; this.reason = 'plan-failed'; }
      });
      return;
    }
    if (!this.plan || this.plan.mode !== 'maintainer-qa' && this.plan.mode !== 'idle-scheduler') {
      this.consume(this.plan?.cue); this.cancel(); this.reason = 'closed'; return;
    }
    const cue = this.plan.cue;
    if (!cue) {
      if (this.plan.mode !== 'idle-scheduler' || this.playingCue || this.pendingCue) this.cancel();
      this.reason = this.plan.mode === 'idle-scheduler' ? this.plan.reason : 'no-cue'; return;
    }
    if (!this.owns(cue, now) || !this.allowed(cue)) {
      this.consume(cue); this.cancel(); this.reason = 'blocked-or-expired'; return;
    }
    if (this.playingCue || this.pendingCue) return;
    const consumed = `${cue.token}|${cue.id}`;
    if (this.consumed.has(consumed)) return;
    this.consume(cue);
    if (now - cue.at > BODY_START_AGE_MS) { this.reason = 'late'; return; }
    this.pending = true; this.pendingCue = cue; this.reason = 'loading';
    const epoch = this.epoch;
    void this.start(cue, epoch);
  }

  /** Invoked before the existing helper's single nonzero update, never another solver. */
  beforeUpdate(delta: number, now: number, gates: BodyStageGates): void {
    if (this.disposed) return;
    this.gates = { ...gates };
    if (this.time(now) === null) { this.cancel(); this.reason = 'clock-invalid'; return; }
    this.reportIdleGates(now);
    const cue = this.playingCue ?? this.pendingCue;
    if (cue && (!this.owns(cue, now) || !this.allowed(cue))) {
      this.cancel(); this.reason = 'blocked-or-expired'; return;
    }
    if (!this.playingCue) return;
    this.dependencies.player.beforeUpdate(delta, false);
    if (!this.dependencies.player.getState().active) { this.playingCue = null; this.reason = 'finished'; }
  }

  ownsProperty(name: string): boolean {
    const state = this.dependencies.player.getState();
    return !!this.playingCue && state.active && state.trackNames.includes(name);
  }
  getState() {
    const player = this.dependencies.player.getState();
    return { ...player, pending: this.pending, supported: this.dependencies.targetSupported === true, mode: this.plan?.mode ?? 'closed',
      reason: this.reason, cueId: this.playingCue?.id ?? this.pendingCue?.id ?? null,
      recipeId: this.playingCue?.recipeId ?? this.pendingCue?.recipeId ?? null,
      packId: this.resource?.packId ?? null, motionId: this.resource?.motionId ?? null,
      sha256: this.resource?.sha256 ?? null, maskId: this.resource?.maskId ?? null, error: this.error };
  }

  /**
   * Synchronous revoke: cancelled loads and consumed identities never resume.
   * Ownership ends now either way; unless `immediate` (hide, scope or model
   * change, dispose), the display is handed back through `release`.
   */
  cancel(immediate = false): void {
    const state = this.dependencies.player.getState(), hadBindings = state.active;
    this.epoch++;
    this.pending = false; this.pendingCue = null; this.playingCue = null;
    if (!hadBindings) { this.dependencies.player.stop(); return; }
    const stop = () => { this.mutate(() => this.dependencies.player.stop()); };
    if (!immediate && this.dependencies.release) this.dependencies.release(state.trackNames, stop);
    else stop();
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancel(true); this.dependencies.player.dispose(); this.disposed = true;
    this.plan = null; this.resource = null; if (!this.dependencies.consumedIds) this.consumed.clear();
  }
  private async start(cue: BodyMotionCue, epoch: number): Promise<void> {
    const current = () => {
      const now = this.time();
      return now !== null && this.current(epoch, cue.token) && this.pendingCue === cue
        && this.owns(cue, now) && this.allowed(cue) && now - cue.at <= BODY_START_AGE_MS;
    };
    try {
      if (!current()) return;
      const value = await this.dependencies.resolve(cue.id, cue.token);
      if (!current()) return;
      const resource = checkedResource(value, cue);
      if (!resource) { this.reason = 'invalid-resource'; return; }
      const clip = await this.dependencies.load(resource, this.mesh);
      if (!current()) return;
      // One canonical duration (shared/vmd-duration.ts): the loader replaced
      // MMDLoader's Float32 keyframe time with the parser's frames/30, the same
      // double the host recipe holds. Anything else is a trimmed/retimed source.
      if (!(clip instanceof AnimationClip) || clip.duration !== vmdDurationSeconds(cue.durationMs)) {
        this.reason = 'invalid-duration'; return;
      }
      const accepted = this.mutate(() => this.dependencies.player.play({ id: cue.id, clip, maskId: resource.maskId,
        durationMs: cue.durationMs, strength: cue.strength }));
      if (accepted) { this.playingCue = cue; this.resource = resource; this.reason = 'playing'; this.error = ''; }
      else this.reason = this.dependencies.player.getState().reason;
    } catch {
      if (this.current(epoch, cue.token)) { this.reason = 'load-failed'; this.error = '临时身体动作未能载入，本轮保持原动作'; }
    } finally {
      if (this.current(epoch, cue.token) && this.pendingCue === cue) { this.pending = false; this.pendingCue = null; }
    }
  }
  private baseAllowed(): boolean {
    const gates = this.gates;
    return this.dependencies.targetSupported === true && bodyIdentity(this.token)
      && gateKeys.every(key => typeof gates[key] === 'boolean') && gates.ready && gates.enabled && gates.visible;
  }
  private allowed(cue: BodyMotionCue): boolean {
    const gates = this.gates;
    return this.baseAllowed() && !gates.manualPose && !gates.manualGesture && !gates.manualExpression && !gates.manualHead && !gates.dynamicPose
      && !gates.cameraOrWindow && !gates.inputBlocked && !gates.directContact && !gates.music && !gates.waitingForReply
      && !gates.chatGesture && (cue.recipeId === 'body.confirm' || !gates.speaking);
  }
  private requestAllowed(): boolean {
    const gates = this.gates;
    return this.baseAllowed() && !gates.manualPose && !gates.manualGesture && !gates.manualExpression && !gates.manualHead && !gates.dynamicPose
      && !gates.cameraOrWindow && !gates.inputBlocked && !gates.directContact && !gates.music
      && !gates.waitingForReply && !gates.chatGesture && !gates.speaking;
  }
  private owns(cue: BodyMotionCue, now: number): boolean {
    return !!this.plan && (this.plan.mode === 'maintainer-qa' || this.plan.mode === 'idle-scheduler') && !!this.plan.cue && keyFor(cue) === keyFor(this.plan.cue)
      && isBodyMotionCue(cue) && cue.token === this.token && now >= cue.at && now < cue.expiresAt;
  }
  private consume(cue?: BodyMotionCue | null): void {
    if (!cue || !isBodyMotionCue(cue)) return;
    this.consumed.add(`${cue.token}|${cue.id}`);
    if (this.consumed.size > 256) this.consumed.delete(this.consumed.values().next().value!);
  }
  private current(epoch: number, token: string) { return !this.disposed && this.epoch === epoch && this.token === token; }
  /** Uses the existing frame path; no timer, and the default empty pool sends nothing. */
  private reportIdleGates(now: number): void {
    if (this.plan?.mode !== 'idle-scheduler' || !this.plan.observationEpoch || !bodyIdentity(this.token)) return;
    const observationEpoch = this.plan.observationEpoch;
    if (observationEpoch !== this.idleReportEpoch) {
      this.idleReportEpoch = observationEpoch; this.idleRevision = 0; this.idleLastAt = -Infinity;
      this.idleLastKey = ''; this.idleReportPending = 0;
    }
    const key = JSON.stringify(this.gates);
    // Changed blockers must leave immediately, even while an older allow read awaits.
    if (key === this.idleLastKey && (this.idleReportPending || now - this.idleLastAt < BODY_IDLE_REPORT_INTERVAL_MS)) return;
    if (this.idleRevision >= Number.MAX_SAFE_INTEGER) { this.cancel(); return; }
    const revision = ++this.idleRevision, token = this.token, epoch = this.epoch;
    const observation: BodyStageObservation = Object.freeze({ ...this.gates, preview: false, epoch: observationEpoch, revision });
    this.idleLastKey = key; this.idleLastAt = now; this.idleReportPending = revision;
    let request: Promise<BodyMotionPlan>;
    try { request = this.dependencies.getPlan(token, observation); }
    catch { this.idleReportPending = 0; this.cancel(); return; }
    void request.then(plan => {
      if (!this.current(epoch, token) || this.idleReportEpoch !== observationEpoch || this.idleRevision !== revision) return;
      this.update(plan, token, this.gates);
    }, () => {
      if (this.current(epoch, token) && this.idleRevision === revision) { this.cancel(); this.reason = 'plan-failed'; }
    }).finally(() => { if (this.idleReportPending === revision) this.idleReportPending = 0; });
  }
  private time(value = (this.dependencies.now ?? Date.now)()): number | null {
    if (!validTime(value) || this.lastNow !== null && value < this.lastNow) return null;
    this.lastNow = value; return value;
  }
  private mutate<T>(callback: () => T): T { return this.dependencies.mutate ? this.dependencies.mutate(callback) : callback(); }
}
