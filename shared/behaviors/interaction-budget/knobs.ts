/**
 * 功能：互动余额：她自己主动做的事有多少，跟着你们最近的互动和她的性格（I-010）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法（方案 docs/claude/2026-11-03-interaction-budget-plan.md，做法 docs/claude/2026-11-05-i010-interaction-budget.md）：
 *  - 余额 = 攒下的 + 保底。你的真实互动给"攒下的"加分（gains），它按半衰期慢慢少（halfLifeHours），最多攒到 earnedMax；
 *    "保底"在你一直不来时也会慢慢长回来，最多到 floor.max（和原来一样，无聊久了还能看你一眼、说一句）；保底只付 floor.pays
 *    里那几件（开口、邀请、看一看、聊刚听完的），小情绪、猜拳里的话、停停说说只能用你最近的互动攒下的。
 *  - 她自己主动做一件事就花一点（costs）：先花攒下的，再花保底。花多少还要 × 性格倍数（character：黏人、爱玩的花得少，
 *    谨慎的花得多）、深夜 × nightCost。
 *  - 余额只是软上限：余额够这一件，就完全不压；越接近花完，她这次做的可能越小（平滑，不会到某个数一刀切）；
 *    很想你、很兴奋这类强烈的情绪（strong）可以越过它。她想不想做，还是每个功能自己按心情和性格定，余额只说"这会儿有没有余地"。
 *  - 硬规则不在这里：没人回应不追着说（角色卡"没人回应最多几句"）、深夜和睡着安静、你在打字时不打扰、每天调用次数这类省额度的保护。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel } from '../../mood';

/** 你的真实互动，每种给多少分。 */
export const BUDGET_CREDIT_KINDS = ['message', 'answer', 'touch', 'food', 'game'] as const;
export type BudgetCreditKind = typeof BUDGET_CREDIT_KINDS[number];
/** 她自己主动做的事，每种花多少。 */
export const BUDGET_SPEND_KINDS = ['speak', 'invite', 'look', 'listen', 'need', 'gameLine', 'pausePlan', 'continue'] as const;
export type BudgetSpendKind = typeof BUDGET_SPEND_KINDS[number];

export interface InteractionBudgetKnobs {
  readonly gains: Readonly<Record<BudgetCreditKind, number>>;
  readonly halfLifeHours: number;
  readonly earnedMax: number;
  readonly floor: { readonly max: number; readonly perHour: number; readonly pays: readonly BudgetSpendKind[] };
  readonly costs: Readonly<Record<BudgetSpendKind, number>>;
  readonly nightCost: number;
  readonly character: { readonly close: number; readonly playful: number; readonly cautious: number; readonly min: number; readonly max: number };
  readonly share: Readonly<Partial<Record<BudgetSpendKind, number>>>;
  readonly strong: { readonly from: number; readonly full: number; readonly moods: Readonly<Partial<Record<MoodLabel, number>>> };
  readonly again: { readonly invite: number; readonly game: number; readonly playful: number; readonly cautious: number; readonly min: number; readonly max: number };
  readonly labels: Readonly<Record<BudgetCreditKind | BudgetSpendKind, string>>;
  readonly keepLog: number;
}

export const INTERACTION_BUDGET_KNOBS: InteractionBudgetKnobs = Object.freeze<InteractionBudgetKnobs>({
  gains: {
    // 用户可能怎么说：我们聊了好多，她还是不怎么主动／我就发了几句，她就变得很热情
    // 怎么调：你发一条消息给她攒多少；调大 → 聊得多以后她更活跃
    message: 1,
    // 用户可能怎么说：我回了她主动说的话，她好像也没更愿意找我
    // 怎么调：你接住她主动说的那句（她说完、你还没回时你发的第一条，或在她的猜拳邀请上点"来！/下次吧"）攒多少；比普通消息多，因为说明你愿意接她的话
    answer: 1.5,
    // 用户可能怎么说：我摸摸她、喂她，她之后也不怎么找我
    // 怎么调：一次摸头或捏脸（从按下到松开算一次）攒多少
    touch: 0.5,
    // 怎么调：喂一次点心攒多少
    food: 0.5,
    // 怎么调：一起玩完一局猜拳攒多少
    game: 0.5,
  },

  // 用户可能怎么说：我走开一会儿回来，她攒着一堆话倒给我／我才走开一会儿，她就没劲了
  // 怎么调：攒下的余额过多少小时少一半；越小越快回到安静
  halfLifeHours: 3,

  // 用户可能怎么说：聊了一整天以后，她一直停不下来
  // 怎么调：攒下的最多多少（保底另算）；调小 → 再热闹也不会攒太多
  earnedMax: 12,

  floor: {
    // 用户可能怎么说：我一整天没理她，她一次都不来找我／我不理她，她还是隔一会儿就来
    // 怎么调：保底最多多少；1 = 和原来一样，无聊久了还能来找你一次（"没人回应最多几句"照旧管着追不追着说）
    max: 1,
    // 用户可能怎么说：我一天只来几下，她还是挺主动的／我隔很久才来一下，她都没精神找我
    // 怎么调：保底每小时长回多少（0.125 = 8 小时长满，一晚上正好长满）；越小，你一直不来、或者只偶尔来一下时她越安静
    // （0.25 时"一天只发三条消息"的那天她比原来还多一点，模拟 Gene 小情绪 2.7 → 3.2；0.125 时 2.7 → 2.5）
    perHour: 0.125,
    // 用户可能怎么说：我好久没理她，她还冒出小情绪／猜拳里话多
    // 怎么调：保底只能用来做这几件（方案："无聊久了还能看你一眼、说一句"）；不在这里的（小情绪、猜拳里一句、停停说说）只能用你最近的互动攒下的
    pays: ['speak', 'invite', 'look', 'listen'],
  },

  costs: {
    // 用户可能怎么说：她主动找我说话太勤了／太少了（和你们最近聊得多少有关时）
    // 怎么调：主动开口一次花多少（她挑说自己的小情绪、聊刚听完的、看一看屏幕、邀你玩，都在这一次说话时机里，先看余额够不够这一项）
    speak: 1,
    // 怎么调：邀请你玩猜拳一次花多少（挑中邀请时记在它头上）
    invite: 1,
    // 怎么调：按心情主动看一眼屏幕说一句（R10，挑中屏幕时）花多少
    look: 1,
    // 怎么调：一起听时在停顿点说一句（挑中聊刚听完的时）花多少
    listen: 1,
    // 用户可能怎么说：她的小情绪（有点闷、想找人说话……）太多了／我们挺热闹的她也没有
    // 怎么调：开始一件小需要花多少；比普通开口"重"一点
    need: 1.5,
    // 用户可能怎么说：猜拳时她话太多了／太少了
    // 怎么调：猜拳里她说一句花多少（每局一次一句的规则照旧在猜拳那边）
    gameLine: 0.5,
    // 用户可能怎么说：停停说说开着时，安静的角色也每条都问 haiku
    // 怎么调：停停说说每条消息问一次 haiku 花多少（你发消息本身会攒 1，所以聊天时几乎总有余额）
    pausePlan: 0.2,
    // 用户可能怎么说：她停下来等我，我没接，她又自己接着说下去了（我不在的时候也这样）
    // 怎么调：停停说说里"等你没接、她接着说完"花多少；余额不够时她这条回复就不停下来等你，一口气说完
    continue: 0.5,
  },

  // 用户可能怎么说：半夜她还是挺主动的
  // 怎么调：深夜（她的作息里的夜里）花费 × 这个数；深夜本来就只剩提醒休息，这里只让她更安静
  nightCost: 2,

  character: {
    // 用户可能怎么说：黏人的角色也不怎么主动／谨慎的角色太主动了
    // 怎么调：花费的性格倍数 = 1 + close ×（黏人 − 1）+ playful ×（爱玩 − 1）+ cautious ×（谨慎 − 1），再夹在 min～max；负数 = 越黏人花得越少
    close: -0.25,
    playful: -0.25,
    cautious: 0.35,
    min: 0.6,
    max: 1.6,
  },

  share: {
    // 用户可能怎么说：安静的角色也和活泼的一样费额度
    // 怎么调：停停说说里，性格倍数大于 1（安静、谨慎）的角色每条消息问 haiku 的机会 = 1 / 倍数，最少这么多；活泼的照旧每条都问
    pausePlan: 0.6,
  },

  strong: {
    // 用户可能怎么说：她很想我的时候也憋着不说
    // 怎么调：心情有多强烈（0～1）从 from 开始越过余额的压低，到 full 完全不压；moods 是哪几种心情算多强烈
    from: 0.9,
    full: 1,
    moods: { longing: 0.97, excited: 0.92 },
  },

  again: {
    // 用户可能怎么说：她刚邀请过我玩，又邀请／玩完没多久她又来邀请
    // 怎么调：上次邀请（或上次玩完）以后，你们之间要再有几次互动她才可能再邀请（原来是隔 2 小时、玩完 1 小时、每天最多 2 次）
    invite: 3,
    game: 3,
    // 怎么调：次数的性格调整：越爱玩少几次（× playful），越谨慎多几次（× cautious），夹在 min～max
    playful: -1,
    cautious: 1,
    min: 1,
    max: 6,
  },

  labels: {
    message: '你发消息', answer: '你接住她的话', touch: '摸头/捏脸', food: '喂点心', game: '一起玩完一局',
    speak: '她主动开口', invite: '她邀请玩猜拳', look: '她看一眼屏幕说一句', listen: '她聊刚听完的', need: '她的小情绪',
    gameLine: '她在猜拳里说一句', pausePlan: '停停说说问 haiku', continue: '停停说说等你后接着说',
  },

  keepLog: 12,
});
