/**
 * 功能：她的即时反应（I-037 新的反应方式：反应清单、打分、haiku 挑）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法（方法）：
 *  - 反应清单 REACTION_TABLE：每种反应一行。events = 能引出它的事件和基础分（绝对分，0–100）；lean = 挂钩的倾向，
 *    倾向每比 50 高 1 点加多少（负数是减）；mood = 她此刻的心情标签加减多少；sleepy = 犯困时加减多少；
 *    recent = 刚做过同一种反应的"近期惩罚"：刚做完减 penalty，每过 halfLifeMs 减半（不是硬冷却，分数够高照样会再做）。
 *  - 得分 = 基础分 + 倾向加减 + 心情加减 + 犯困加减 − 近期惩罚 + 整体偏移 offset + 一点随机（±jitter），全是加减，不连乘。
 *  - 做不到的（模型没有那个部位、她睡着、脸红正在红、她正在别的互动里）直接不进候选（硬门槛，写在 electron/reactions/performers.ts）。
 *  - 身体互动（摸头、捏脸、喂点心）：分数最高的那个到了 actAt 就马上做。说的话：和她的回复并行问 haiku 一次，
 *    把每一类的前几个候选和分数交给它，它在候选里挑 0–2 个、给轻重和心情变化；haiku 没答时按她回复尾注的语境，用"暖心的话"那一类的最高分。
 *  - 加一种反应：在 REACTION_TABLE 里加一行（需要新的表现时再在 performers.ts 加一个表现），haiku 的说明自动从这一行生成。
 * 这些都只是试用值；真实 haiku 的挑法、用户觉得敏感不敏感，要用户在开发版里验收。
 */
import type { MoodLabel } from '../../mood';
import type { DispositionId } from './dispositions';
import type { ReactionEventId } from './events';

export const REACTION_LEVELS = ['light', 'mid', 'strong'] as const;
export type ReactionLevel = typeof REACTION_LEVELS[number];
export const REACTION_LEVEL_WORDS: Readonly<Record<ReactionLevel, string>> = Object.freeze({ light: '轻', mid: '中', strong: '重' });

/** 清单的一行（写法见文件头）。 */
export interface ReactionRow {
  readonly label: string;
  /** 给 haiku 的一句白话：这个反应看起来是什么样、什么时候合适。 */
  readonly describe: string;
  /** 哪个表现来做（electron/reactions/performers.ts 的键），和交给它的参数（小动作的词）。 */
  readonly performer: string;
  readonly arg?: string;
  readonly events: Partial<Record<ReactionEventId, number>>;
  readonly lean?: Partial<Record<DispositionId, number>>;
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly sleepy?: number;
  readonly recent: { readonly penalty: number; readonly halfLifeMs: number };
}

export const REACTION_TABLE: Readonly<Record<string, ReactionRow>> = Object.freeze({
  // 用户可能怎么说：夸她的时候脸红得太少／太多了／摸头摸一下就红
  // 怎么调：events 里各事件的基础分；lean.shy 是害羞的人多红多少；recent 是刚红过以后多久才容易再红（不是冷却，分够高照样红）
  blush: { label: '脸红', describe: '脸颊红起来（轻重是红的深浅），可以和别的反应一起', performer: 'blush',
    events: { praise: 58, 'good-news': 30, coax: 45, care: 42, warm: 50, pat: 52, pinch: 48 },
    lean: { shy: 0.8, volatile: 0.2, restrained: -0.3 },
    mood: { close: 6, happy: 4, content: 2, relieved: 2, upset: -20, disappointed: -15, concerned: -10, sad: -10 },
    sleepy: -8, recent: { penalty: 28, halfLifeMs: 60_000 } },

  // 用户可能怎么说：被夸了也不害羞／老是低头害羞
  // 怎么调：害羞＝一下子低头、垂眼看向一边、脸红、抿嘴笑，约 3 秒；events 是各事件的基础分，lean.shy 是害羞的人多做多少
  shy: { label: '害羞', describe: '一下子低头、垂眼看向一边、脸红、抿嘴笑，约 3 秒；被夸、被撒娇时最像', performer: 'shy',
    events: { praise: 52, 'good-news': 20, coax: 42, care: 30, warm: 40, pat: 25, pinch: 45 },
    lean: { shy: 0.9, restrained: -0.25, lively: -0.1 },
    mood: { close: 6, happy: 3, upset: -25, disappointed: -20, concerned: -15, sad: -15 },
    sleepy: -12, recent: { penalty: 35, halfLifeMs: 120_000 } },

  // 用户可能怎么说：报喜的时候她不够开心／一点小事就乐
  // 怎么调：开心＝心情往"愉快"那边抬一下（期待、舒适涨一点，脸上跟着笑），轻重见下面 happyLift
  happy: { label: '开心', describe: '一下子开心起来，脸上带笑（心情往愉快那边抬一下）', performer: 'happy',
    events: { praise: 45, 'good-news': 65, coax: 40, care: 50, warm: 45, pat: 30, pinch: 10, feed: 55 },
    lean: { soothable: 0.5, volatile: 0.4, restrained: -0.3, lively: 0.2 },
    mood: { upset: -25, disappointed: -15, sad: -15, concerned: -10, happy: 5, excited: 5 },
    sleepy: -10, recent: { penalty: 25, halfLifeMs: 120_000 } },

  // 用户可能怎么说：她点头点得太多／听到我关心她也不点头
  nod: { label: '点头', describe: '轻轻点一下头，表示听到了、认同、谢谢', performer: 'action', arg: 'nod',
    events: { praise: 30, 'good-news': 40, coax: 30, care: 45, warm: 35, pat: 20, feed: 35 },
    lean: { lively: 0.2, restrained: 0.1 }, sleepy: -5, recent: { penalty: 30, halfLifeMs: 90_000 } },

  // 用户可能怎么说：撒娇的时候想看她歪头
  tilt: { label: '歪头', describe: '歪一下头，俏皮或者有点疑惑、在撒娇', performer: 'action', arg: 'tilt',
    events: { praise: 30, 'good-news': 30, coax: 40, care: 30, pinch: 25 },
    lean: { lively: 0.3, clingy: 0.1 }, sleepy: -8, recent: { penalty: 30, halfLifeMs: 90_000 } },

  // 用户可能怎么说：比心太多／撒娇的时候想要她比心
  heart: { label: '比心', describe: '双手比个心，亲昵、撒娇、开心时', performer: 'action', arg: 'heart',
    events: { praise: 25, 'good-news': 35, coax: 45, care: 30, warm: 30 },
    lean: { clingy: 0.6, lively: 0.3, restrained: -0.4 }, mood: { upset: -30, disappointed: -20, concerned: -15 },
    sleepy: -10, recent: { penalty: 40, halfLifeMs: 180_000 } },

  // 用户可能怎么说：我报喜她都不鼓掌／一点小事就鼓掌
  clap: { label: '鼓掌', describe: '为你鼓掌，替你高兴（报喜时最像）', performer: 'action', arg: 'clap',
    events: { praise: 10, 'good-news': 55 },
    lean: { lively: 0.6, restrained: -0.3 }, mood: { upset: -30, disappointed: -20, sad: -20 },
    sleepy: -10, recent: { penalty: 35, halfLifeMs: 180_000 } },

  // 用户可能怎么说：想看她俏皮地眨眼
  wink: { label: '眨一只眼', describe: '俏皮地眨一只眼', performer: 'action', arg: 'wink',
    events: { praise: 25, 'good-news': 25, coax: 25 },
    lean: { lively: 0.6, restrained: -0.4, shy: -0.2 }, mood: { upset: -30, sad: -20 },
    sleepy: -10, recent: { penalty: 40, halfLifeMs: 180_000 } },

  // 用户可能怎么说：捏她脸的时候想看她撅嘴
  pout: { label: '撅嘴', describe: '撅一下嘴，假装不满、撒娇（说话时会等她说完）', performer: 'action', arg: 'pout',
    events: { pinch: 50, coax: 30, praise: 10 },
    lean: { lively: 0.3, clingy: 0.2, restrained: -0.3 }, mood: { close: 3 },
    sleepy: -5, recent: { penalty: 30, halfLifeMs: 90_000 } },

  // 用户可能怎么说：她挥手挥得莫名其妙
  wave: { label: '挥手', describe: '挥挥手，打招呼或者"不客气啦"', performer: 'action', arg: 'wave',
    events: { care: 15, 'good-news': 20 },
    lean: { lively: 0.4, restrained: -0.2 }, sleepy: -10, recent: { penalty: 40, halfLifeMs: 300_000 } },
});

export interface ReactionKnobs {
  readonly offset: number;
  readonly jitter: number;
  readonly candidates: number;
  readonly floor: number;
  readonly actAt: number;
  readonly patRise: number;
  readonly levelAt: { readonly mid: number; readonly strong: number };
  readonly maxPicks: number;
  readonly moodBlend: { readonly haiku: number; readonly opus: number };
  readonly maxDelta: number;
  readonly startDelayMs: number;
  readonly firstCharWaitMs: number;
  readonly warmParallel: boolean;
  readonly timeoutMs: number;
  readonly minConfidence: number;
  readonly userTextChars: number;
  readonly personaChars: number;
  readonly callsPerDay: number;
  readonly callsPerChat: number;
  readonly callsPerDayMax: number;
  readonly stageGapMs: number;
  readonly freeWaitMs: number;
  readonly happyLift: Readonly<Record<ReactionLevel, { readonly D: number; readonly E: number }>>;
  readonly blushStrength: Readonly<Record<ReactionLevel, number>>;
  readonly blushFloor: number;
  readonly recentKept: number;
}

export const REACTION_KNOBS: ReactionKnobs = Object.freeze<ReactionKnobs>({
  // 用户可能怎么说：所有反应都触发得再敏感一点／太敏感了
  // 怎么调：整体偏移：每种反应的分数统一加这么多（正数更容易有反应，负数更少）
  offset: 0,

  // 用户可能怎么说：同样的事她每次反应都一模一样
  // 怎么调：每次打分加减一个不超过这么多的随机数（在她的性格范围里变）
  jitter: 4,

  // 用户可能怎么说：haiku 挑来挑去总是那几个
  // 怎么调：每一类事件交给 haiku 的候选最多几个（按分数从高到低）
  candidates: 4,

  // 用户可能怎么说：她做了一些完全不像她的反应
  // 怎么调：分数低于这个数的反应不进候选
  floor: 30,

  // 用户可能怎么说：摸头、捏脸、喂点心时她没什么反应／反应太多
  // 怎么调：不问 haiku 时（身体互动、haiku 没答），最高分到了这个数才做
  actAt: 50,

  // 用户可能怎么说：摸了好一会儿她才有反应／刚碰到头就害羞
  // 怎么调：一次摸头只反应一次；这一次摸头里亲近涨到角色卡"亲近门槛"的这么多倍时反应（原来的脸红要涨满 1 倍）
  patRise: 0.5,

  // 用户可能怎么说：脸红总是很淡／一下子红透了
  // 怎么调：不问 haiku 时，分数到 mid 算"中"，到 strong 算"重"，再低是"轻"
  levelAt: { mid: 60, strong: 75 },

  // 用户可能怎么说：一句话她做了一堆反应
  // 怎么调：一句话 haiku 最多挑几个反应
  maxPicks: 2,

  // 用户可能怎么说：她的心情还是太平／一句话心情就变了好多
  // 怎么调：haiku 和她自己的回复尾注都给了心情变化时，各占多少（加起来 1）；只有一边给时用那一边
  moodBlend: { haiku: 0.7, opus: 0.3 },

  // 用户可能怎么说：haiku 给的心情变化太大
  // 怎么调：haiku 给的每个心情数最多加减多少（和她回复尾注的上限一样）
  maxDelta: 6,

  // 用户可能怎么说：发消息以后她第一个字好像慢了一点
  // 怎么调：你发出消息后至少等多少毫秒再起 haiku 的进程（让她的回复先写出去）
  startDelayMs: 300,

  // 用户可能怎么说：发消息以后她第一个字慢了／她的反应来得太晚
  // 怎么调：haiku 等她回复的第一个字出来再起（2026-11-06 实测：和她的回复同时起，第一个字中位慢约 0.5 秒）；第一个字一直没来时最多等这么多毫秒
  firstCharWaitMs: 4_000,

  // 用户可能怎么说：她的反应来得太晚／发消息以后她第一个字慢了
  // 怎么调：true（默认）= 有提前待命的 haiku 时，发出后 startDelayMs 就和她的回答同时问（反应约 1.7 秒到，第一个字偶尔慢一点）；false = 等她第一个字出来再问待命的 haiku（约 2.9 秒到，第一个字不受影响）
  // 真 Claude 两轮共 20 对（2026-11-06 晚）：true 时首字逐对中位慢 44 ms、20 对里 11 对变慢，没过"不切换"的门槛（逐对中位慢 150 ms 以上且多数对变慢），所以默认 true（docs/claude/2026-11-07-reactions-warm-haiku.md）
  warmParallel: true,

  // 用户可能怎么说：haiku 卡住了，好久都没反应
  // 怎么调：从起 haiku 算起，多少毫秒还没答就放弃，改用她回复尾注的语境挑
  timeoutMs: 10_000,

  // 用户可能怎么说：haiku 拿不准还乱做反应
  // 怎么调：haiku 的把握（0～1）低于这个数，它的答案整条不用（改用尾注的语境挑）
  minConfidence: 0.6,

  // 用户可能怎么说：我说了一大段话，haiku 只看到开头
  // 怎么调：你说的话最多交给 haiku 多少个字（和发给 Opus 的是同一句，只截短）
  userTextChars: 200,

  // 用户可能怎么说：haiku 不了解她，挑得不像她
  // 怎么调：交给 haiku 的角色卡性格摘要最多多少个字（倾向总会给）
  personaChars: 160,

  // 用户可能怎么说：怕刷额度／聊得少的一天也要有反应
  // 怎么调：一天问 haiku 的打底次数；当天上限 = 这个数 + 每聊一句加的次数 × 今天聊的句数，不超过"最多"（和心情调整员同一个公式）
  callsPerDay: 120,

  // 用户可能怎么说：聊得多的时候傍晚以后她就没反应了
  // 怎么调：今天和她每聊一句，当天的上限多几次
  callsPerChat: 2,

  // 用户可能怎么说：怕哪天聊得特别多把额度刷光
  // 怎么调：不管聊多少，一天最多问 haiku 多少次（超了只用尾注的语境挑）
  callsPerDayMax: 800,

  // 用户可能怎么说：害羞和点头挤在一起了
  // 怎么调：两个要占舞台的反应（害羞、小动作）一前一后时，第二个在第一个做完后再等多少毫秒
  stageGapMs: 200,

  // 用户可能怎么说：捏完脸她过了好久才害羞
  // 怎么调：她正在别的互动里（被摸头、在吃）时，要占舞台的反应最多等她空下来多少毫秒，等不到就不做
  freeWaitMs: 1_500,

  // 用户可能怎么说：开心的反应太淡／太夸张
  // 怎么调：开心轻、中、重各让期待（D）和舒适（E）抬多少（乘角色卡敏感度；期待几分钟就回落一半）
  happyLift: { light: { D: 4, E: 2 }, mid: { D: 8, E: 4 }, strong: { D: 12, E: 6 } },

  // 用户可能怎么说：脸红轻重看不出区别
  // 怎么调：脸红轻、中、重各红多深（0～1，再乘角色卡的脸红强度）
  blushStrength: { light: 0.55, mid: 0.8, strong: 1 },

  // 用户可能怎么说：摸摸/夸她时脸红太淡，几乎看不出
  // 怎么调：反应脸红最深时至少红到多少（0～1，再乘上面轻中重；角色卡脸红强度更高时按角色卡的；角色卡把脸红关了或设成 0 仍然不红；和平时心情带出的脸红无关）
  blushFloor: 0.8,

  // 用户可能怎么说：近期惩罚记得太久
  // 怎么调：每个角色记住最近多少次做过的反应（算近期惩罚用）
  recentKept: 32,
});
