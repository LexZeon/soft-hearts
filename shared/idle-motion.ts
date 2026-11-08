/**
 * Optional, host-owned idle presentation only. This module has no timers,
 * settings, reward callbacks, asset paths or animation-player access.
 *
 * The host registry must supply continuously reviewed idle-use recipes. A
 * renderer, motion filename or a sampled catalog entry cannot approve a use.
 * Stage/resource wiring and real continuous playback validation remain separate.
 * Dwell/strength limits are trial presentation defaults pending experience; this
 * scheduler never changes mood values or the existing attention/speech quotas.
 */
export const IDLE_DWELL_MIN_MS = 45_000;
export const IDLE_DWELL_MAX_MS = 90_000;
export const IDLE_CLOCK_GAP_MS = 5_000;
export const IDLE_MAX_START_AGE_MS = 1_500;
export const IDLE_MAX_STRENGTH = 0.3;
export const IDLE_MAX_RECIPES = 16;
export const IDLE_OWNER_MAX_LENGTH = 128;

export interface IdleMotionCandidate {
  readonly recipeId: string;
  readonly revision: string;
  readonly sha256: string;
  /** The complete reviewed source pass; the scheduler never crops or loops it. */
  readonly durationMs: number;
  readonly strength: number;
  readonly validation: 'continuous-use-verified' | 'sampled' | 'untested';
}

export interface IdleMotionGates {
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly targetVerified: boolean;
  readonly manualPose: boolean;
  readonly manualGesture: boolean;
  readonly dynamicPose: boolean;
  readonly manualExpression: boolean;
  readonly manualHead: boolean;
  readonly directContact: boolean;
  readonly speaking: boolean;
  readonly waitingForReply: boolean;
  readonly music: boolean;
  readonly windowCameraInput: boolean;
  readonly preview: boolean;
}

export interface IdleMotionTick {
  /** Opaque host generation, renewed on character/model/provider changes. */
  readonly scopeToken: string;
  readonly now: number;
  readonly gates: IdleMotionGates;
  /** Host posture intensity, already mapped to 0..1. Zero cancels optional idle. */
  readonly intensity: number;
}

export interface IdleMotionCue {
  readonly id: string;
  readonly ownerToken: string;
  readonly scopeToken: string;
  readonly recipeId: string;
  readonly revision: string;
  readonly sha256: string;
  /** Proposal issuance only; this is not the source playback epoch. */
  readonly at: number;
  /** Bounded lease including loading grace plus the complete original pass. */
  readonly expiresAt: number;
  /** Original source duration, unchanged by the loading grace. */
  readonly durationMs: number;
  readonly strength: number;
}

export type IdleMotionReason = 'waiting' | 'playing' | 'issued' | 'blocked' | 'invalid-input'
  | 'no-approved-recipes' | 'no-alternative' | 'disposed';
export interface IdleMotionDecision {
  readonly cue: IdleMotionCue | null;
  readonly nextAt: number | null;
  readonly reason: IdleMotionReason;
}

const identity = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const finiteTime = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 180_000;
const gateKeys = ['enabled', 'visible', 'targetVerified', 'manualPose', 'manualGesture', 'dynamicPose', 'manualExpression', 'manualHead',
  'directContact', 'speaking', 'waitingForReply', 'music', 'windowCameraInput', 'preview'] as const;
function allowed(gates: IdleMotionGates): boolean {
  return !!gates && gateKeys.every(key => typeof gates[key] === 'boolean') && gates.enabled && gates.visible && gates.targetVerified
    && !gates.manualPose && !gates.manualGesture && !gates.dynamicPose && !gates.manualExpression && !gates.manualHead
    && !gates.directContact && !gates.speaking && !gates.waitingForReply && !gates.music && !gates.windowCameraInput && !gates.preview;
}
function candidateKey(candidate: IdleMotionCandidate): string {
  return `${candidate.recipeId}|${candidate.revision}|${candidate.sha256}|${candidate.durationMs}|${candidate.strength}`;
}
function copyCandidate(value: IdleMotionCandidate): Readonly<IdleMotionCandidate> | null {
  if (!value || value.validation !== 'continuous-use-verified' || !identity(value.recipeId)
    || !identity(value.revision) || typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)
    || !Number.isFinite(value.durationMs) || value.durationMs < 250 || value.durationMs > 30_000
    || !Number.isFinite(value.strength) || value.strength <= 0 || value.strength > IDLE_MAX_STRENGTH) return null;
  return Object.freeze({ recipeId: value.recipeId, revision: value.revision, sha256: value.sha256.toLowerCase(),
    durationMs: value.durationMs, strength: value.strength, validation: value.validation });
}

/**
 * Lazy runtime scheduler. Call from the host's existing bounded tick and before
 * resolving a cue. The stage consumes cue IDs once; use canStart before and after
 * asynchronous asset loading. Do not queue a rejected cue for later playback.
 * Source elapsed starts at the actual accepted stage start, not cue.at. The
 * scheduler retains only a lease with loading grace; it never crops a late-start
 * source pass. The 'playing' decision denotes that lease, not a playback receipt.
 */
export class IdleMotionScheduler {
  private readonly ownerToken: string;
  private randomState: number;
  private candidates: readonly Readonly<IdleMotionCandidate>[] = [];
  private poolKey = '';
  private poolChanged = false;
  private scopeToken: string | null = null;
  private lastNow: number | null = null;
  private nextAt: number | null = null;
  private cue: IdleMotionCue | null = null;
  private lastRecipeId: string | null = null;
  private sequence = 0;
  private disposed = false;

  /** Supply a fresh host per-instance owner token; never reuse a stable service name across instances. */
  constructor(ownerToken: string, seed = 0x6d2b79f5) {
    if (typeof ownerToken !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ownerToken))
      throw new TypeError('Idle owner token must be an opaque per-instance identity of at most 128 characters.');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new TypeError('Idle seed must be uint32.');
    this.ownerToken = ownerToken;
    this.randomState = seed || 0x6d2b79f5;
  }

  /** Host-registry input only. There is intentionally no default/unreviewed pool. */
  replaceCandidates(values: readonly IdleMotionCandidate[]): void {
    if (this.disposed) return;
    // Oversized or ambiguous pools fail closed instead of choosing by input order.
    const copied = Array.isArray(values) && values.length <= IDLE_MAX_RECIPES
      ? values.map(copyCandidate).filter((value): value is Readonly<IdleMotionCandidate> => value !== null) : [];
    const duplicates = new Set<string>();
    const seen = new Set<string>();
    for (const value of copied) {
      if (seen.has(value.recipeId)) duplicates.add(value.recipeId);
      seen.add(value.recipeId);
    }
    const next = copied.filter(value => !duplicates.has(value.recipeId))
      .sort((left, right) => left.recipeId < right.recipeId ? -1 : left.recipeId > right.recipeId ? 1 : 0);
    const key = next.map(candidateKey).join('\n');
    if (key === this.poolKey) return;
    this.candidates = Object.freeze(next);
    this.poolKey = key;
    this.poolChanged = true;
    // Revocation is synchronous, including between host ticks / async resolves.
    this.cue = null;
    this.nextAt = null;
  }

  tick(input: IdleMotionTick): IdleMotionDecision {
    if (this.disposed) return this.decision('disposed');
    if (!input || !identity(input.scopeToken) || !finiteTime(input.now)
      || !Number.isFinite(input.intensity) || input.intensity < 0 || input.intensity > 1) {
      this.cancel();
      this.lastNow = null;
      return this.decision('invalid-input');
    }
    const changedScope = input.scopeToken !== this.scopeToken;
    const clockBreak = this.lastNow !== null && (input.now < this.lastNow || input.now - this.lastNow > IDLE_CLOCK_GAP_MS);
    this.lastNow = input.now;
    if (changedScope) {
      this.scopeToken = input.scopeToken;
      this.lastRecipeId = null;
    }
    if (changedScope || clockBreak || this.poolChanged) this.cancel();
    this.poolChanged = false;
    if (!allowed(input.gates) || input.intensity === 0) {
      this.cancel();
      return this.decision('blocked');
    }
    if (!this.candidates.length) {
      this.cancel();
      return this.decision('no-approved-recipes');
    }
    if (this.cue) {
      if (input.now < this.cue.expiresAt) return this.decision('playing');
      this.cue = null;
      this.nextAt = null;
    }
    const choices = this.candidates.filter(value => value.recipeId !== this.lastRecipeId);
    if (!choices.length) {
      this.nextAt = null;
      return this.decision('no-alternative');
    }
    if (this.nextAt === null) {
      this.nextAt = input.now + this.dwell();
      return this.decision('waiting');
    }
    if (input.now < this.nextAt) return this.decision('waiting');
    if (input.now - this.nextAt > IDLE_MAX_START_AGE_MS) {
      // Missing a quiet opportunity never creates catch-up playback.
      this.nextAt = input.now + this.dwell();
      return this.decision('waiting');
    }
    const selected = choices[Math.floor(this.random() * choices.length)];
    this.lastRecipeId = selected.recipeId;
    this.nextAt = null;
    if (this.sequence >= Number.MAX_SAFE_INTEGER) { this.dispose(); return this.decision('disposed'); }
    this.sequence += 1;
    this.cue = Object.freeze({ id: `idle-${this.ownerToken}-${this.sequence}`, ownerToken: this.ownerToken, scopeToken: input.scopeToken,
      recipeId: selected.recipeId, revision: selected.revision, sha256: selected.sha256,
      at: input.now, expiresAt: input.now + IDLE_MAX_START_AGE_MS + selected.durationMs, durationMs: selected.durationMs,
      strength: selected.strength * input.intensity });
    return this.decision('issued');
  }

  /** Active ownership only; do not use this to bypass canStart's loading age. */
  ownsCue(cueId: string, scopeToken: string, now: number): boolean {
    return !this.disposed && finiteTime(now) && !!this.cue && this.cue.id === cueId
      && this.cue.scopeToken === scopeToken && now >= this.cue.at && now < this.cue.expiresAt;
  }

  canStart(cueId: string, scopeToken: string, now: number): boolean {
    return this.ownsCue(cueId, scopeToken, now) && !!this.cue && now - this.cue.at <= IDLE_MAX_START_AGE_MS;
  }

  /** Direct input, hide or lost UI must call this immediately, not pause a cue. */
  cancel(): void { this.cue = null; this.nextAt = null; }

  dispose(): void {
    this.cancel(); this.disposed = true; this.candidates = []; this.poolKey = '';
    this.scopeToken = null; this.lastNow = null; this.lastRecipeId = null;
  }

  private decision(reason: IdleMotionReason): IdleMotionDecision {
    return Object.freeze({ cue: this.cue, nextAt: this.nextAt, reason });
  }
  private dwell(): number { return IDLE_DWELL_MIN_MS + Math.floor(this.random() * (IDLE_DWELL_MAX_MS - IDLE_DWELL_MIN_MS + 1)); }
  private random(): number {
    let value = this.randomState;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x1_0000_0000;
  }
}
