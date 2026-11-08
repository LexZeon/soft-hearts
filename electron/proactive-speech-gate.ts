import {
  PROACTIVE_RECENT_OPPORTUNITIES,
  PROACTIVE_REQUEST_LIMIT_MS,
  type ProactiveSpeechLease,
  type ProactiveSpeechOpportunity,
  type ProactiveSpeechSource,
} from '../shared/proactive-speech';

interface ActiveLease {
  id: string;
  scope: string;
  source: ProactiveSpeechSource;
  expiresAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProactiveSpeechGateOptions {
  /**
   * She is asleep (electron/main.ts: InnerLoop.asleep(), the same reading as the opening choice's "睡着时谁都不开口").
   * While it holds, nothing new starts, a line still out is dropped at the next look (every mood publish sets the scope) and no
   * lease commits: a request sent while she was falling asleep and answered after she fell asleep is never shown or kept (T-209).
   * Read only while a line is out or about to start; a throwing reader counts as awake (the behavior before this check).
   */
  resting?: () => boolean;
}

/**
 * One host-owned instance serves ordinary attention, vision and ambient comments.
 * MoodHost has already consumed the speech cooldown/hour/unanswered quota before
 * this gate receives an opportunity. This class never creates one or rewards it.
 */
export class ProactiveSpeechGate {
  private scope = '';
  private disposed = false;
  private active: ActiveLease | null = null;
  private readonly used = new Map<string, number>();
  private lastNow = -Infinity;

  constructor(private readonly clock: () => number = Date.now, private readonly options: ProactiveSpeechGateOptions = {}) {}

  /** Scope is host-private (character/provider/model generation), never UI metadata. */
  setScope(scope: string): void {
    if (this.disposed) return;
    // Every mood publish lands here: she may have just fallen asleep with a line still out.
    this.sweep();
    if (this.scope === scope) return;
    this.cancel('scope');
    this.scope = typeof scope === 'string' && scope.length <= 16_000 ? scope : '';
    // Keep already consumed identities across provider/model changes. Changing
    // context cannot turn the same accepted attention cue into another turn.
  }

  get busy(): boolean { this.sweep(); return this.active !== null; }

  tryAcquire(opportunity: ProactiveSpeechOpportunity, source: ProactiveSpeechSource): ProactiveSpeechLease | null {
    const now = this.sweep();
    if (this.disposed || !Number.isFinite(now) || !opportunity || !this.scope
      || opportunity.scope !== this.scope || !validId(opportunity.opportunityId)
      || (source !== 'vision' && source !== 'ambient' && source !== 'memorial' && source !== 'agent-help' && source !== 'inner')
      || !Number.isFinite(opportunity.expiresAt) || opportunity.expiresAt <= now
      || opportunity.expiresAt - now > PROACTIVE_REQUEST_LIMIT_MS
      || this.active || this.used.has(opportunity.opportunityId)
      || this.used.size >= PROACTIVE_RECENT_OPPORTUNITIES || this.resting()) return null;

    const controller = new AbortController();
    const lease: ActiveLease = {
      id: opportunity.opportunityId, scope: this.scope, source,
      expiresAt: opportunity.expiresAt, controller,
      timer: setTimeout(() => this.cancelLease(lease, 'expired'), opportunity.expiresAt - now),
    };
    lease.timer.unref?.();
    this.used.set(lease.id, lease.expiresAt);
    this.active = lease;
    return Object.freeze({
      id: lease.id, source, signal: controller.signal,
      commit: () => this.commit(lease),
      cancel: () => this.cancelLease(lease, 'cancelled'),
    });
  }

  cancel(reason = 'cancelled'): void {
    if (this.active) this.cancelLease(this.active, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel('dispose');
    this.disposed = true;
    this.scope = '';
    this.used.clear();
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isFinite(value)) return NaN;
    // A wall-clock adjustment must not make an expired opportunity young again.
    this.lastNow = Math.max(this.lastNow, value);
    return this.lastNow;
  }

  private sweep(): number {
    const now = this.now();
    if (!Number.isFinite(now)) { this.cancel('clock'); return now; }
    if (this.active && this.active.expiresAt <= now) this.cancelLease(this.active, 'expired');
    // The reader may publish the mood view again (and so come back here): hold on to the lease that was out.
    const active = this.active;
    if (active && this.resting()) this.cancelLease(active, 'resting');
    for (const [id, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(id);
    return now;
  }

  private resting(): boolean {
    try { return this.options.resting?.() === true; } catch { return false; }
  }

  /** The last look before a line counts as said: asleep now (and no publish in between) still refuses it. */
  private commit(lease: ActiveLease): boolean {
    const now = this.sweep();
    if (this.disposed || !Number.isFinite(now) || this.active !== lease
      || lease.controller.signal.aborted || lease.scope !== this.scope || lease.expiresAt <= now) return false;
    clearTimeout(lease.timer);
    this.active = null;
    return true;
  }

  private cancelLease(lease: ActiveLease, reason: string): void {
    if (this.active !== lease) return;
    clearTimeout(lease.timer);
    this.active = null;
    // No external content or path is included in cancellation errors.
    const safeReason = ['scope', 'dispose', 'expired', 'clock', 'resting'].includes(reason) ? reason : 'cancelled';
    lease.controller.abort(new DOMException(`Proactive speech ${safeReason}`, 'AbortError'));
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}
