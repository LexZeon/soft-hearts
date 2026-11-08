/**
 * #10 的假实现：守约测试（tests/opening-choice.test.ts）拿它和真实现跑同一组约定；以后接新实现，先拿它对一遍。
 * 不看心情、不算分量：按给定的顺序，挑第一件此刻真有、这次还没试过的（默认就是原来的固定顺序：屏幕 → 一起听 → 她自己 → 不说）。
 * 测试也用它把某一条路固定住（"只挑屏幕"），去看那条路自己的行为。
 */
import { OPENING_CANDIDATE_IDS, OPENING_CHOICE_KNOBS, type OpeningCandidateId } from './knobs';
import type { OpeningChoice, OpeningChoiceHost, OpeningNow, OpeningWhy } from './interface';

export class FixedOpeningChoice implements OpeningChoiceHost {
  readonly asked: { characterId: string; now: OpeningNow; without: OpeningCandidateId[] }[] = [];
  private readonly settled = new Map<string, { id: OpeningCandidateId; at: number }>();
  private readonly log: (OpeningWhy & { characterId: string })[] = [];
  /** `order`: the ones it may pick, first that is there wins (one left out is never picked). */
  constructor(private readonly order: readonly OpeningCandidateId[] = ['screen', 'listen', 'mood', 'play', 'quiet']) {}

  choose(characterId: string, now: OpeningNow, without: readonly OpeningCandidateId[] = []): OpeningChoice | null {
    this.asked.push({ characterId, now, without: [...without] });
    const id = this.order.find(candidate => OPENING_CANDIDATE_IDS.includes(candidate) && !without.includes(candidate)
      && (candidate === 'quiet' || now.available[candidate] === true));
    return id ? { id, label: OPENING_CHOICE_KNOBS.candidates[id].label, why: ['假实现：固定顺序'], weights: '' } : null;
  }

  settle(characterId: string, id: OpeningCandidateId, at: number): void { this.settled.set(characterId, { id, at }); }
  last(characterId: string): { readonly id: OpeningCandidateId; readonly at: number } | null { return this.settled.get(characterId) ?? null; }
  note(characterId: string, why: OpeningWhy): void { this.log.unshift({ characterId, ...why, why: [...why.why] }); }
  recent(characterId: string): readonly OpeningWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, 8).map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }
}
