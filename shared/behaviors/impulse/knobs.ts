/**
 * 功能：松绑——她自己想找你的冲动、什么时候伸手、说什么话头、偶尔的小毛病、做完以后回到心情
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"。方案见 docs/claude/2026-11-11-loosen-plan.md，
 * 做了什么见 docs/claude/2026-11-12-loosen.md。
 *
 * 读法：
 *  - 冲动（0～1）= base + 推的（O、D、N 相对角色卡基线，B 无聊、M 想念）× 性格倍数 − 收的（C 压力、A 困、刚被晾过）。
 *    激素都按"相对基线"读（moodLevel：50 = 在基线），−1～1；B、M 是 0～100，读成 0～1。
 *  - 五种想做的事（说话、邀你玩、给你留东西、哼歌、看你一眼）各有一组权重，从同一组数里算；收的那几项对它们各压多少也在这里。
 *  - 伸手（reach）：在原有的每秒一下里，冲动过了 from 才可能"想起来"，想起来的机会按冲动大小（像抛硬币，不是定时器），
 *    所以两次之间的间隔每次都不一样。你刚和她互动完，先安静一会儿（每轮在 quietAfter 范围里抽）。
 *  - 硬底线不是旋钮，写在 choose.ts 的 initiativeFloor：深夜和困了安静、睡着不说、你在开会或不在、在打字或把她藏起来不打扰、
 *    她说的上一句你还没回就不再追着说。
 * 这些都只是试用值，没在真机上看过。
 */

export const URGE_KINDS = ['speak', 'play', 'leave', 'hum', 'glance'] as const;
export type UrgeKind = (typeof URGE_KINDS)[number];
/** The inputs that push (O, D, N relative to the baseline; B, M as 0..1). */
export type UrgePush = 'O' | 'D' | 'N' | 'B' | 'M';
/** The inputs that hold back (C relative to the baseline, A sleepy, recently ignored). */
export type UrgeHold = 'C' | 'A' | 'ignored';

export interface UrgeKindKnob {
  readonly push: Readonly<Partial<Record<UrgePush, number>>>;
  /** How much each hold presses this kind (× the shared hold amount). */
  readonly hold: Readonly<Partial<Record<UrgeHold, number>>>;
}

export const IMPULSE_KNOBS = Object.freeze({
  // 用户可能怎么说：她平时太主动了／她平时太安静了（不是某种心情的时候，是一直都这样）
  // 怎么调：base 是什么都没发生时的冲动（0～1）；伸手要冲动过 reach.from，所以 base 低于 from 时，平静的她不会自己来找你
  base: 0.15,

  // 用户可能怎么说：她开心、想我的时候也不来找我／她一无聊就来烦我
  // 怎么调：每一项推多少（O 亲近、D 愉快、N 来劲按相对基线 −1～1；B 无聊、M 想念按 0～1）
  push: { O: 0.45, D: 0.35, N: 0.15, B: 0.4, M: 0.45 },

  // 用户可能怎么说：她紧张、困的时候还老找我／我晾了她一次她就不找我了
  // 怎么调：C（压力，只算高过基线的）、A（困，从 sleepyFrom 到 sleepyFull）、刚被晾过（没回的句数和刚被拒的邀请，最多算 2 次）各收多少
  hold: { C: 0.35, A: 0.45, ignored: 0.18 },
  sleepyFrom: 0.4,
  sleepyFull: 0.75,

  // 用户可能怎么说：黏人的角色也不怎么来找我／拘谨的角色也老来
  // 怎么调：性格倍数 = 1 + 系数 ×（性格值 − 1），乘在推的那部分上，夹在 0.4～1.8
  personality: { close: 0.6, playful: 0.3, cautious: -0.45 },

  // 用户可能怎么说：她老邀我玩／她老递东西／她老看我（不是说话）
  // 怎么调：每种想做的事从同一组数里各取多少（push 是这种事的权重，hold 是收的那几项对它压多少倍）
  kinds: {
    speak: { push: { O: 1, D: 0.7, N: 0.6, B: 1, M: 1.2 }, hold: { C: 1, A: 1, ignored: 1.2 } },
    play: { push: { D: 1.3, N: 1.1, B: 1.2, O: 0.4 }, hold: { C: 1.4, A: 1.2, ignored: 1 } },
    leave: { push: { O: 1.2, M: 1.3, D: 0.4 }, hold: { C: 0.8, A: 0.8, ignored: 0.6 } },
    hum: { push: { D: 1, B: 0.8, N: 0.3 }, hold: { C: 1.2, A: 0.6, ignored: 0.3 } },
    glance: { push: { O: 1, M: 1.2, B: 0.6 }, hold: { C: 0.4, A: 0.6, ignored: 0.4 } },
  } as Readonly<Record<UrgeKind, UrgeKindKnob>>,

  // 用户可能怎么说：体验记录里"冲动"老是"强"／老是"弱"
  // 怎么调：冲动低于 low 记"弱"，到 high 以上记"强"，中间记"中"
  buckets: { low: 0.3, high: 0.6 },

  reach: {
    // 用户可能怎么说：她很想我的时候也半天不来／她稍微有点想就来
    // 怎么调：冲动过了 from 才可能自己来找你；冲动到 1 时平均多少分钟想起来一次（meanMinutes，越小越常）
    from: 0.22,
    meanMinutes: 10,
    // 用户可能怎么说：我刚和她说完话她又来了／聊完很久她都不来
    // 怎么调：你和她互动完以后，至少安静多少分钟（每轮在这个范围里抽，不是固定的）
    quietAfter: [3, 10] as readonly [number, number],
    // 用户可能怎么说：她想了一下没来，过一会儿又想（太频繁）
    // 怎么调：想起来一次以后（不管做没做），过多少分钟才会再想（每次抽）
    refractory: [5, 14] as readonly [number, number],
    // 用户可能怎么说：我在专心做事时她来得太多／太少
    // 怎么调：你在专心做事时，"说话"那一项 × 多少（会议、打字不在这里：那是底线，根本不说）
    busy: 0.45,
    // 怎么调：「她主动找你说话」设置的少一点 / 多一点，让想起来的机会 × 多少
    talkLess: 0.5,
    talkMore: 1.6,
    // 用户可能怎么说：她想起来了却老是"这次不说"／一想起来就说
    // 怎么调：想起来以后"这次不说"那一项的分量 = none + noneHold × 收的那部分（她的性格和心情决定；底线放行了她也可以不说）
    none: 0.35,
    noneHold: 1.2,
    // 怎么调：想起来以后，"看你一眼"和"哼歌"相对"说话"的分量
    glance: 0.55,
    hum: 0.45,
  },

  slip: {
    // 用户可能怎么说：她老是说话说一半改口，很做作／她说话太完美了，像机器
    // 怎么调：每次她开口时带一点小毛病的基础机会（0～1）；性格和心情再乘上去（见 choose.ts slipChance）
    chance: 0.07,
    // 怎么调：一次小毛病以后，多少分钟内不再有（每次在这个范围里抽，不固定）
    cooldownMinutes: [90, 240] as readonly [number, number],
  },

  topic: {
    // 用户可能怎么说：她老说同一件事／她每次都硬找话题
    // 怎么调：每种话头的基础分量（plan 是用户说过的计划到时间了，只在有这样一件事时才在候选里）；none 是"这次不给话头"（让她自己来，也可以不硬找）
    weights: { doing: 1.4, event: 1.3, you: 1.2, diary: 1, time: 0.7, mood: 0.8, plan: 2.4, none: 0.35 },
    // 怎么调：上一次、上上次用过的话头，这次分量 × 这几个数
    recent: [0.35, 0.7] as readonly number[],
    // 用户可能怎么说：她说的事我没接，她过一会儿又说同一件
    // 怎么调：她主动说了你没接、邀你玩你说下次，那一类话头（或邀请）多少小时内不再提
    quietHours: 3,
  },

  outcome: {
    // 用户可能怎么说：我隔了一会儿才回她，她就当我没理她
    // 怎么调：她主动说了一句以后，多少分钟内你和她有互动（发消息、摸头、喂点心）就算接了
    answerMinutes: 10,
    // 怎么调：刚拒过她的邀请，多少小时内还算"刚被晾过"（收冲动用）
    declineHours: 2,
  },
});

export type ImpulseKnobs = typeof IMPULSE_KNOBS;
