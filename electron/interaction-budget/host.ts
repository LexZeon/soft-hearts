import {
  budgetAgainAfter, budgetRoom, budgetScale, createBudget, creditBudget, interactionsSince, refundBudget, settleBudget, spendBudget, type BudgetState,
} from '../../shared/behaviors/interaction-budget/choose';
import { INTERACTION_BUDGET_KNOBS, type InteractionBudgetKnobs } from '../../shared/behaviors/interaction-budget/knobs';
import type {
  BudgetAsk, BudgetCharacterNow, BudgetCreditKind, BudgetRoom, BudgetSpendKind, InteractionBudget, InteractionBudgetView,
} from '../../shared/behaviors/interaction-budget/interface';

/** What each speaking candidate of the opening choice spends as (shared/behaviors/opening-choice/knobs.ts ids). */
export const OPENING_SPEND_KINDS = Object.freeze({ mood: 'speak', play: 'invite', screen: 'look', listen: 'listen' } as const satisfies Record<string, BudgetSpendKind>);

/**
 * The opening choice's view of the budget (electron/inner-loop/opening-host.ts OpeningBudget): the room to speak at all, the
 * candidate that spoke spends as its own kind, a cue that ended unspoken is given back. `get` is read each time (the companion
 * service is created after the inner loop in electron/main.ts); null means no budget, so no press.
 */
export function openingBudget(get: () => InteractionBudget | null | undefined) {
  return {
    room: (characterId: string, mood: string) => {
      const budget = get();
      return budget ? budget.room(characterId, 'speak', { mood }) : { factor: 1, words: '' };
    },
    spend: (characterId: string, cueId: string, candidate: keyof typeof OPENING_SPEND_KINDS) => { get()?.spend(characterId, OPENING_SPEND_KINDS[candidate] ?? 'speak', cueId); },
    refund: (characterId: string, cueId: string) => { get()?.refund(characterId, cueId); },
  };
}

export interface InteractionBudgetHostOptions {
  /** Wall clock (ms). */
  clock?: () => number;
  knobs?: InteractionBudgetKnobs;
}

interface Character { state: BudgetState; now: BudgetCharacterNow }

const HOUR = 3_600_000;
const KEEP_CHARACTERS = 64;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300;

/**
 * I-010 互动余额, host side (the contract is shared/behaviors/interaction-budget/interface.ts). One small state per character, in
 * memory only: a restart begins with the floor alone, as quiet as a long absence. Owns no timer and never calls back into the
 * mood host (the one-second tick hands it the card's tendencies and the night through observe()), so the developer view can
 * read it while the mood view is being built.
 */
export class InteractionBudgetHost implements InteractionBudget {
  private readonly characters = new Map<string, Character>();
  private readonly knobs: InteractionBudgetKnobs;
  private readonly clock: () => number;

  constructor(options: InteractionBudgetHostOptions = {}) {
    this.knobs = options.knobs ?? INTERACTION_BUDGET_KNOBS;
    this.clock = options.clock ?? Date.now;
  }

  private now(): number { const value = this.clock(); return Number.isFinite(value) ? value : Date.now(); }

  private character(characterId: string): Character | null {
    if (!validId(characterId)) return null;
    let entry = this.characters.get(characterId);
    if (!entry) {
      entry = { state: createBudget(this.now(), this.knobs), now: { weights: null, night: false } };
      this.characters.set(characterId, entry);
      while (this.characters.size > KEEP_CHARACTERS) this.characters.delete(this.characters.keys().next().value!);
    }
    return entry;
  }

  /** The one-second mood tick: the card's tendencies and whether it is her night now. */
  observe(characterId: string, now: BudgetCharacterNow): void {
    const entry = this.character(characterId);
    if (!entry) return;
    entry.now = { weights: now?.weights ? { ...now.weights } : null, night: now?.night === true };
  }

  credit(characterId: string, kind: BudgetCreditKind, id: string, at?: number): boolean {
    const entry = this.character(characterId);
    if (!entry || !validKey(id) || !(kind in this.knobs.gains)) return false;
    const result = creditBudget(entry.state, { kind, id, ...(typeof at === 'number' ? { at } : {}) }, this.now(), this.knobs);
    entry.state = result.state;
    return result.counted;
  }

  room(characterId: string, kind: BudgetSpendKind, ask?: BudgetAsk): BudgetRoom {
    const entry = this.character(characterId);
    if (!entry || !(kind in this.knobs.costs)) return { factor: 0, balance: 0, cost: 0, strong: false, words: '不认识的角色或事情：没有余地' };
    return budgetRoom(entry.state, kind, this.now(), { scale: budgetScale(entry.now.weights, this.knobs), night: entry.now.night, ...(ask ? { ask } : {}) }, this.knobs);
  }

  spend(characterId: string, kind: BudgetSpendKind, id: string): boolean {
    const entry = this.character(characterId);
    if (!entry || !validKey(id) || !(kind in this.knobs.costs)) return false;
    const result = spendBudget(entry.state, { kind, id, scale: budgetScale(entry.now.weights, this.knobs), night: entry.now.night }, this.now(), this.knobs);
    entry.state = result.state;
    return result.spent;
  }

  refund(characterId: string, id: string): boolean {
    const entry = validId(characterId) ? this.characters.get(characterId) : undefined;
    if (!entry || !validKey(id)) return false;
    const result = refundBudget(entry.state, id, this.now(), this.knobs);
    entry.state = result.state;
    return result.refunded;
  }

  interactionsSince(characterId: string, at: number): number {
    const entry = validId(characterId) ? this.characters.get(characterId) : undefined;
    return entry ? interactionsSince(entry.state, at) : 0;
  }

  againAfter(characterId: string, after: 'invite' | 'game'): number {
    const entry = validId(characterId) ? this.characters.get(characterId) : undefined;
    return budgetAgainAfter(after === 'game' ? 'game' : 'invite', entry?.now.weights, this.knobs);
  }

  view(characterId: string): InteractionBudgetView | null {
    const entry = validId(characterId) ? this.characters.get(characterId) : undefined;
    if (!entry) return null;
    const now = this.now(), settled = settleBudget(entry.state, now, this.knobs);
    const r = (value: number) => Math.round(value * 100) / 100;
    return { balance: r(settled.earned + settled.floor), earned: r(settled.earned), floor: r(settled.floor), scale: r(budgetScale(entry.now.weights, this.knobs)),
      night: entry.now.night, lastHour: interactionsSince(settled, now - HOUR), recent: settled.log.map(item => ({ ...item })) };
  }
}
