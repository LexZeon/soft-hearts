/**
 * I-010 的假实现：永远有余地、什么都不记（= 互动余额以前的做法：只有各功能自己的规则）。
 * 守约测试（tests/interaction-budget.test.ts）拿它和真实现跑同一组约定；别的测试想要"不压"时也用它。
 * 注意："上次邀请以后互动了几次"在这里永远是很大的数，所以用它时猜拳邀请只剩各自的心情和安静规则。
 */
import type { BudgetAsk, BudgetCreditKind, BudgetRoom, BudgetSpendKind, InteractionBudget, InteractionBudgetView } from './interface';

export class OpenBudget implements InteractionBudget {
  /** Counts for tests. */
  readonly calls = { credit: 0, room: 0, spend: 0, refund: 0 };
  credit(_characterId: string, _kind: BudgetCreditKind, _id: string, _at?: number): boolean { this.calls.credit++; return true; }
  room(_characterId: string, _kind: BudgetSpendKind, _ask?: BudgetAsk): BudgetRoom {
    this.calls.room++;
    return { factor: 1, balance: Infinity, cost: 0, strong: false, words: '假实现：永远有余地' };
  }
  spend(_characterId: string, _kind: BudgetSpendKind, _id: string): boolean { this.calls.spend++; return true; }
  refund(_characterId: string, _id: string): boolean { this.calls.refund++; return true; }
  interactionsSince(_characterId: string, _at: number): number { return Number.MAX_SAFE_INTEGER; }
  againAfter(_characterId: string, _after: 'invite' | 'game'): number { return 0; }
  view(_characterId: string): InteractionBudgetView | null { return null; }
}
