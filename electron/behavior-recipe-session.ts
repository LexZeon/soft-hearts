import { randomUUID } from 'node:crypto';
import { BEHAVIOR_COVERAGE, admitBehaviorRecipe, type BehaviorRecipeId, type RecipeChannel, type RecipeGates } from '../shared/behavior-recipes';
import type { BehaviorSemantic } from '../shared/behavior-motion';

export interface BehaviorRecipeRequest {
  /** Capture at source acceptance, before asynchronous interpretation/resource work. */
  readonly expectedScope: string;
  readonly sourceId: string;
  readonly semantic: BehaviorSemantic;
  readonly recipeId: BehaviorRecipeId;
  readonly acceptedAt: number;
  readonly strength: number;
}
export interface BehaviorRecipeTicket extends BehaviorRecipeRequest {
  readonly id: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly channel: RecipeChannel;
}
const MAX_START_AGE_MS = 1_500;
const MAX_CONSUMED = 256;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 60_000;

/**
 * Host-only optional presentation lease. No IPC, timer, player, storage or reward.
 * Accepted source identities come from the existing mood/controller, never a renderer.
 * Resolve existing face/chat resources through their existing pinned resolvers.
 */
export class BehaviorRecipeSession {
  private scope = '';
  private gates: RecipeGates | null = null;
  private readonly active = new Map<RecipeChannel, BehaviorRecipeTicket>();
  private readonly consumed = new Map<string, number>();
  private watermark = -1;
  private lastNow: number | null = null;
  private disposed = false;

  constructor(private readonly clock = Date.now, private readonly newId: () => string = randomUUID) {}

  /** Call synchronously for direct input/hide/context changes, including between animation ticks. */
  setContext(scope: string, gates: RecipeGates): void {
    if (this.disposed) return;
    if (!identity(scope) || scope !== this.scope) this.active.clear();
    this.scope = identity(scope) ? scope : '';
    this.gates = gates && typeof gates === 'object' ? Object.freeze({ ...gates }) : null;
    for (const [channel, cue] of this.active)
      if (!this.gates || !admitBehaviorRecipe(cue.recipeId, this.gates).allowed) this.active.delete(channel);
  }

  issue(request: BehaviorRecipeRequest): BehaviorRecipeTicket | null {
    const now = this.now();
    if (now === null || this.disposed || !this.scope || !request || request.expectedScope !== this.scope || !identity(request.sourceId)
      || !time(request.acceptedAt) || request.acceptedAt > now || now - request.acceptedAt > MAX_START_AGE_MS
      || !Number.isFinite(request.strength) || request.strength <= 0 || request.strength > 0.7
      || !Object.hasOwn(BEHAVIOR_COVERAGE, request.semantic)) return null;
    const row = BEHAVIOR_COVERAGE[request.semantic];
    // Pending resources are deliberately absent from the accepted-use set.
    if (!row.activeRecipes.includes(request.recipeId)) return null;
    const admission = this.gates && admitBehaviorRecipe(request.recipeId, this.gates);
    const channel: RecipeChannel = request.recipeId.startsWith('face.') ? 'expression' : 'gesture';
    const key = `${this.scope}:${channel}:${request.sourceId}`;
    if (this.consumed.has(key) || request.acceptedAt <= this.watermark) return null;
    // Consume valid host identities before gate admission; never defer input-conflicted reactions.
    this.consumed.set(key, request.acceptedAt);
    if (this.consumed.size > MAX_CONSUMED) {
      const oldest = this.consumed.keys().next().value!;
      this.watermark = Math.max(this.watermark, this.consumed.get(oldest)!);
      this.consumed.delete(oldest);
    }
    if (!admission || !admission.allowed) return null;
    const id = this.newId();
    if (!identity(id)) return null;
    const ticket = Object.freeze({ expectedScope: request.expectedScope, sourceId: request.sourceId, semantic: request.semantic, recipeId: request.recipeId,
      acceptedAt: request.acceptedAt, strength: request.strength, id, scope: this.scope,
      expiresAt: request.acceptedAt + admission.recipe.durationMs + MAX_START_AGE_MS, channel });
    this.active.set(channel, ticket);
    return ticket;
  }

  /** The caller still owns resource registration and must recheck before granting its URL. */
  async resolve<T>(ticket: BehaviorRecipeTicket, resolver: (ticket: BehaviorRecipeTicket) => Promise<T>): Promise<T | null> {
    if (!this.canStart(ticket)) return null;
    try {
      const resource = await resolver(ticket);
      return this.canStart(ticket) ? resource : null;
    } catch (error) {
      this.cancel(ticket.id);
      throw error;
    }
  }

  canStart(ticket: BehaviorRecipeTicket): boolean {
    const now = this.now();
    return now !== null && !this.disposed && !!ticket && this.active.get(ticket.channel) === ticket
      && ticket.scope === this.scope && now >= ticket.acceptedAt && now < ticket.expiresAt
      && now - ticket.acceptedAt <= MAX_START_AGE_MS && !!this.gates
      && admitBehaviorRecipe(ticket.recipeId, this.gates).allowed;
  }

  cancel(ticketId?: string): void {
    for (const [channel, ticket] of this.active) if (ticketId === undefined || ticket.id === ticketId) this.active.delete(channel);
  }
  dispose(): void { this.cancel(); this.disposed = true; this.scope = ''; this.gates = null; }

  private now(): number | null {
    const value = this.clock();
    if (!time(value) || (this.lastNow !== null && value < this.lastNow)) {
      // Retain the high-water clock. Repeated rollback samples cannot make a
      // previously rejected old source fresh again on the following call.
      this.cancel(); return null;
    }
    this.lastNow = value;
    for (const [channel, ticket] of this.active) if (ticket.expiresAt <= value) this.active.delete(channel);
    return value;
  }
}
