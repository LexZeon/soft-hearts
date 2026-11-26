/**
 * 松绑: builds the ImpulseHost from what electron/main.ts already has, so main.ts only adds one creation, one tick and three hooks.
 * Every reader is lazy (main.ts creates some of these after this). Nothing here starts on its own.
 */
import type { MoodView } from '../../../shared/mood';
import type { PresenceView } from '../../../shared/senses';
import type { BudgetAsk, BudgetRoom, BudgetSpendKind } from '../../../shared/behaviors/interaction-budget/interface';
import type { HerLifeActivity, HerLifeSwitchOffer } from '../../../shared/stage';
import { proactiveTalk } from '../../../shared/behaviors/inner-rhythm/knobs';
import type { InitiativeRow } from '../../../shared/behaviors/impulse/interface';
import type { MoodMomentKind } from '../../../shared/foundation/mood-moments';
import type { CardSlips } from '../../../shared/foundation/character-card';
import { ImpulseHost,type ImpulseMoodRead } from './host';

export interface ImpulseWiring {
  mood(): {
    get(): Pick<MoodView, 'characterId' | 'expressions' | 'parameters' | 'snapshot' | 'fatigue'>;
    unansweredSpeech(): number;
    welcomeAttention(): boolean;
    glanceAttention(): boolean;
    moments: { note(kind: Exclude<MoodMomentKind, 'tailless'>, characterId?: string, key?: string): boolean };
  } | null;
  budget(): { room(characterId: string, kind: BudgetSpendKind, ask?: BudgetAsk): BudgetRoom } | null;
  herLife?(): { offer(characterId: string, canExpress: boolean): HerLifeSwitchOffer | null; switchTo(characterId: string, activity: HerLifeActivity, canExpress: boolean): boolean } | null;
  opening(): { expectReach(ms?: number): void; cancelReach(): void };
  quiet(): { asleep: boolean; quiet: boolean };
  presence(): PresenceView | null;
  /** The app setting 「内心循环」 (her own initiatives at all); off, she has no reach and nothing is written. Omitted: on. */
  enabled?(): boolean;
  /** The expression gate (visible, no typing, no chat or speech, not dragged, Claude available). */
  canExpress(): boolean;
  talk(): unknown;
  journal(row: InitiativeRow): void;
  /** P-001 step 3 (see ImpulseHostOptions.plan). Lazy: the plan memory starts after this host. */
  plan?(): { topic(): { id: string; text: string } | null; asked(id: string): void } | null | undefined;
  /** I-085 step 2 (see ImpulseHostOptions.lookFirst): one look before she speaks first. Omitted: no look. */
  lookFirst?(characterId: string): Promise<unknown>;
  /** The card's 小毛病 switch for this character (shared/cards/card-slips.ts); omitted or undefined: the default. */
  cardSlips?(characterId: string): CardSlips | undefined;
  clock?(): number;
  random?(): number;
}

export function createImpulseHost(w: ImpulseWiring): ImpulseHost {
  const read = (): ImpulseMoodRead | null => {
    const mood = w.mood();
    if (!mood || w.enabled?.() === false) return null;
    const view = mood.get();
    if (!view.characterId || !view.expressions) return null;
    const s = view.snapshot, p = view.parameters;
    return { characterId: view.characterId, values: s.values, baseline: p.baseline, evidence: p.evidence?.level ?? 1, boredom: s.boredom, longing: s.longing,
      A: typeof view.fatigue?.A === 'number' ? view.fatigue.A : null, personality: p.weights, cardSlips: w.cardSlips?.(view.characterId) ?? null, lastInteractionAt: s.lastInteractionAt,
      unanswered: mood.unansweredSpeech(), primary: s.primary, context: s.context, reason: s.reason };
  };
  return new ImpulseHost({
    clock: w.clock, random: w.random, mood: read, quiet: w.quiet, presence: w.presence, canExpress: w.canExpress,
    talk: () => proactiveTalk(w.talk()),
    balance: (characterId, want, mood) => {
      const budget = w.budget();
      if (!budget) return null;
      const room = budget.room(characterId, 'speak', { mood, want });
      return Number.isFinite(room?.factor) ? room.factor : null;
    },
    humOffered: characterId => w.herLife?.()?.offer(characterId, w.canExpress())?.choices.includes('humming') === true,
    talkNow: () => {
      const mood = w.mood(), opening = w.opening();
      if (!mood) return false;
      opening.expectReach();
      const ok = mood.welcomeAttention();
      if (!ok) opening.cancelReach();
      return ok;
    },
    glanceNow: () => !!w.mood()?.glanceAttention(),
    humNow: characterId => w.herLife?.()?.switchTo(characterId, 'humming', w.canExpress()) === true,
    lift: (kind, characterId, key) => !!w.mood()?.moments.note(kind, characterId, key),
    journal: w.journal,
    ...(w.lookFirst ? { lookFirst: w.lookFirst } : {}),
    plan: { due:() => w.plan?.()?.topic() ?? null, asked: id => { w.plan?.()?.asked(id); } },
  });
}
