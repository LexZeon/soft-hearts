/**
 * #8 的假实现：卡上的五个数原样用，每轮都一样（= 原来的做法）。守约测试（tests/boredom-timing.test.ts）拿它和真实现跑同一组
 * 约定；别的测试要固定的无聊时刻（测心情算术、内心循环的节流）时也用它。以后接新实现，先拿它对一遍。
 */
import { boredomCardKey, boredomPlan, boredomRulesText, BOREDOM_KINDS } from './choose';
import type { BoredomIdle, BoredomKind, BoredomRules, BoredomTimingHost, BoredomTimingNow, BoredomTimingWhy } from './interface';

const MINUTE = 60_000;

export class FixedBoredomTiming implements BoredomTimingHost {
  private readonly rounds = new Map<string, { key: string; startedAt: number; lastIdleMs: number; rules: Readonly<BoredomRules>;
    plan: Record<BoredomKind, number | null>; happened: Partial<Record<BoredomKind, number>> }>();
  /** How many rounds began (tests). */
  started = 0;

  rules(characterId: string, card: Readonly<BoredomRules>, idle: Readonly<BoredomIdle>, now: () => BoredomTimingNow | null): Readonly<BoredomRules> {
    const key = boredomCardKey(card), idleMs = Math.max(0, Number.isFinite(idle.idleMs) ? idle.idleMs : 0), current = this.rounds.get(characterId);
    if (current && current.key === key && idleMs >= current.lastIdleMs) { current.lastIdleMs = idleMs; return current.rules; }
    void now;
    this.started++;
    const rules = Object.freeze({ ...card });
    this.rounds.set(characterId, { key, startedAt: idle.at - idleMs, lastIdleMs: idleMs, rules, plan: boredomPlan(rules, idle.boredom, idleMs / MINUTE), happened: {} });
    return rules;
  }

  happened(characterId: string, kind: BoredomKind, at: number): void {
    const round = this.rounds.get(characterId);
    if (!round || !BOREDOM_KINDS.includes(kind) || round.happened[kind] !== undefined) return;
    round.happened[kind] = Math.round((at - round.startedAt) / MINUTE * 10) / 10;
  }

  relieved(_characterId: string): void { /* The card's own rate already. */ }

  recent(characterId: string): readonly BoredomTimingWhy[] {
    const round = this.rounds.get(characterId);
    return round ? [{ startedAt: round.startedAt, current: true, tempo: '卡上的值', plan: { ...round.plan }, happened: { ...round.happened },
      why: ['假实现：卡上的值原样用，每轮都一样'], rules: boredomRulesText(round.rules), weights: '' }] : [];
  }
}
