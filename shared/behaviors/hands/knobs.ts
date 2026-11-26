/**
 * I-087 牵手、拉钩、击掌（docs/claude/2026-11-11-i087-hands-plan.md，做了什么见 docs/claude/2026-11-11-i087-hands.md）：旋钮和封闭的词。
 *
 * 一套动作三种用法：她的手伸向你的鼠标（src/initiative/hand-reach.ts），手的样子按用途换——
 *  - hold 牵手：张开的手；点一下她的手就牵上，牵着时她的手跟着鼠标走，偶尔轻轻回握一下；
 *  - pinky 拉钩：伸出小指；点一下就算约好了（P-001 刚记下的那件事）；
 *  - high-five 击掌：抬起手心；点一下就击掌（猜拳分出胜负、你说做完了一件事）。
 * 没点也没关系：过一会儿她自己把手收回去，不说你。
 */

export const HAND_USES = ['hold', 'pinky', 'high-five'] as const;
export type HandUse = (typeof HAND_USES)[number];

/**
 * 她为什么伸手（只有封闭的词，进体验记录）：
 *  rest 你的鼠标停在她身边；close 她这会儿很想亲近你（O 高）；scared 她有点怕、紧张（N、C 高）；herself 她自己想（没有特别的理由）；
 *  shy 关系刚开始，她有点害羞（伸手前会犹豫）；plan 你刚说了一件要做的事；game 猜拳分出了胜负；finished 你说做完了一件事。
 */
export const HAND_WHYS = ['rest', 'close', 'scared', 'herself', 'shy', 'plan', 'game', 'finished'] as const;
export type HandWhy = (typeof HAND_WHYS)[number];

/** 一次伸手怎么结束的：taken 点上了（牵上、拉上钩、击上掌）；not-taken 没点，她自己收回；let-go 牵着时松开了；interrupted 被别的事打断。 */
export const HAND_OUTCOMES = ['taken', 'not-taken', 'let-go', 'interrupted'] as const;
export type HandOutcome = (typeof HAND_OUTCOMES)[number];

/** 和摸头一样的 emoji 提示（src/mood/PetInteractionCursor.ts 那一套）：伸手等你、点上的那一下。 */
export type HandEmoji = '🫱' | '🤝' | '🤙' | '🤞' | '✋' | '🙌';
/** 伸手等你时的提示（2026-11-21 起和"碰上了"分开）：牵手 🫱（伸出的手）、拉钩 🤙、击掌 ✋。 */
export const HAND_EMOJI: Readonly<Record<HandUse, HandEmoji>> = Object.freeze({ hold: '🫱', pinky: '🤙', 'high-five': '✋' });
/** 碰上之后的提示：牵着时一直是 🤝，直到放手；拉钩 🤞、击掌 🙌 只亮一小会儿，然后回到平常的指针。 */
export const HAND_DONE_EMOJI: Readonly<Record<HandUse, HandEmoji>> = Object.freeze({ hold: '🤝', pinky: '🤞', 'high-five': '🙌' });

/** 一次伸手的样子（主机按心情算，舞台照着做）。都是 0..1 或开关，没有任何对话内容。 */
export interface HandStyle {
  /** 伸手前犹豫一下（关系刚开始、害羞）：伸到一半停一停再伸过来，第一次更像试探。 */
  readonly hesitant: boolean;
  /** 握得多紧（0.3 松 … 1 紧）：N、C 高握得紧；困了握得松。 */
  readonly grip: number;
  /** 牵着时轻轻晃手（D 高），0..1。 */
  readonly swing: number;
  /** 击掌更来劲（D 高），0..1：手抬得更高、碰一下更有劲。 */
  readonly lively: number;
  /** 会回握（O 高）：牵着时偶尔轻轻捏一下的间隔更短。 */
  readonly squeezeBack: boolean;
  /** 困了（A 高）：手跟得慢一点、握得松，可能牵着就睡着了。 */
  readonly sleepy: boolean;
}

export const NEUTRAL_HAND_STYLE: HandStyle = Object.freeze({ hesitant: false, grip: 0.6, swing: 0, lively: 0, squeezeBack: false, sleepy: false });

export const HANDS_KNOBS = Object.freeze({
  /** 伸到位以后等你多久（毫秒，按用途）；O 高时乘 lean.waitLonger（等得更久）。 */
  waitMs: Object.freeze({ hold: 12_000, pinky: 12_000, 'high-five': 7_000 } as Readonly<Record<HandUse, number>>),
  /** 主机这边的兜底：窗口一直没回答，这么久以后当没点（毫秒，加在 waitMs 上）。 */
  answerSlackMs: 20_000,
  /** 牵着的时候窗口没有回音，主机最多等这么久就当松开了（毫秒；正常由窗口说"松开了"）。 */
  holdLimitMs: 6 * 60 * 60_000,
  /** 拉钩、击掌点上以后，手碰一下停这么久再收回（毫秒）。 */
  touchMs: 750,
  /** 牵着时鼠标走远（够不着、或出了窗口）多久算松开（毫秒）。 */
  farMs: 500,
  /** 牵着时偶尔轻轻回握一下：两次之间（毫秒，随机在这中间）；会回握（O 高）时乘 squeezeBack。 */
  squeezeEveryMs: Object.freeze([7_000, 16_000] as const),
  squeezeBack: 0.6,
  /**
   * 她自己想牵（一次"小动作时机"轮到她时，主机先看她想不想伸手；同一个时机、同一份间隔，没有另加的时机）：基础机会，乘心情倍数；
   * 两次自己伸手之间至少隔 gapMs，一天最多 perDay 次。
   */
  own: Object.freeze({ chance: 0.16, gapMs: 25 * 60_000, perDay: 5 }),
  /** 你的鼠标停在她身边：窗口问一次，主机按心情给一个机会；离上一次伸手至少 gapMs，上一次你没点之后至少 afterNotTakenMs。 */
  rest: Object.freeze({ chance: 0.55, gapMs: 4 * 60_000, afterNotTakenMs: 12 * 60_000, perDay: 12 }),
  /** 窗口这边：鼠标在她够得着的地方、几乎不动，停多久才问（毫秒，随机在这中间），两次问之间至少多久。 */
  restAsk: Object.freeze({ stillMs: Object.freeze([2_500, 4_500] as const), everyMs: 40_000, moveNdc: 0.02 }),
  /** 拉钩：每天最多几次；击掌：每天最多几次、两次之间至少多久。 */
  pinkyPerDay: 4,
  highFive: Object.freeze({ perDay: 8, gapMs: 3 * 60_000 }),
  /** 读心情（相对角色卡基线的 moodLevel，50 = 在基线上）。 */
  lean: Object.freeze({
    /** O 每高出基线一档（level +10），"想牵你"的机会 ×(1+oStep)；低于基线同样往下。 */
    oStep: 0.18,
    /** N、C 较高的那个高过 tenseHigh 后线性往上，到 100 时 ×tenseBoost：害怕、紧张时更想找你的手（和递东西相反：那时她先顾自己）。 */
    tenseHigh: 62, tenseBoost: 2.2,
    floor: 0.25, ceil: 3,
    /** O level ≥ closeO：等得更久、会回握；D level ≥ playfulD：击掌更来劲、牵着轻轻晃手；A ≥ sleepyA：握得松、跟得慢。 */
    closeO: 62, playfulD: 62, sleepyA: 0.55,
    waitLonger: 1.4,
  }),
});

/** 她的心情小瞬间（shared/foundation/mood-moments.ts）：牵上了、击上掌了。拉钩只记进她的计划记忆；没点、松开什么都不写。 */
export const HANDS_MOMENT_KINDS = Object.freeze({ hold: 'held-hands', 'high-five': 'high-five' } as const);
