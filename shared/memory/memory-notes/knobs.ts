/**
 * 功能：她把聊天记忆整理成笔记，想得起以前的事（I-021）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 三部分：
 *  - pace：后台什么时候、隔多久写一条笔记（新聊完的一段和旧对话补笔记走同一个节奏，新的、当前角色的先写）。
 *  - note：哪些段值得写、交给 haiku 的原文最多多长、写坏了重试几次。
 *  - recall：用户说话时，笔记里的词对上了加几分、多少分才算想起来（本机比对，不调模型）。
 *  - matter：I-089 回忆有轻重。几条都对得上时，哪条在她心里更重（情绪强、被提起过、没了结）排前面，刚讲过的退后。只排序，不会让对不上的事浮上来。
 * 交给聊天模型的 `<private-memory-data>` 仍是最多 3 段、3000 字的原文摘录（聊天记忆的「记忆试验参数」），这里调不大它。
 * 这些都只是试用值，没在真机上看过。
 */

export interface MemoryNotesKnobs {
  readonly pace: {
    readonly startDelaySeconds: number;
    readonly spacingSeconds: number;
    readonly quietSeconds: number;
    readonly dailyCalls: number;
    readonly errorPauseMinutes: number;
  };
  readonly note: {
    readonly minUserChars: number;
    readonly inputChars: number;
    readonly messageChars: number;
    readonly maxAttempts: number;
  };
  readonly recall: {
    readonly person: number;
    readonly longTerm: number;
    readonly shortTerm: number;
    readonly ownTag: number;
    readonly ownTagMaxNotes: number;
    readonly partial: number;
    readonly pointer: number;
    readonly followUp: number;
    readonly planHit: number;
    readonly withCue: number;
    readonly withoutCue: number;
  };
  readonly matter: {
    readonly maxBonus: number;
    readonly weightFull: number;
    readonly feltHalfLifeDays: number;
    readonly planDays: number;
    readonly planPart: number;
    readonly cooldownTurns: number;
    readonly cooldownPenalty: number;
  };
  readonly update: {
    readonly minPairs: number;
    readonly minShare: number;
    readonly maxShown: number;
    readonly penalty: number;
  };
}

export const MEMORY_NOTES_KNOBS: MemoryNotesKnobs = Object.freeze<MemoryNotesKnobs>({
  pace: {
    // 用户可能怎么说：一打开软件她就在后台调模型，太急了
    // 怎么调：启动以后至少等多少秒才开始整理笔记
    startDelaySeconds: 120,
    // 用户可能怎么说：旧对话的笔记补得太慢了／后台调模型太频繁了
    // 怎么调：两次整理之间至少隔多少秒（40 秒加上一次调用本身，一小时大约 70～80 段）
    spacingSeconds: 40,
    // 用户可能怎么说：我刚停下来她就在后台整理，等我真的闲下来再说
    // 怎么调：你最后一次和她互动（聊天、摸头、喂食）之后，至少过多少秒才开始整理
    quietSeconds: 90,
    // 用户可能怎么说：整理笔记一天用的额度太多了
    // 怎么调：一天最多整理几段（每段一次 haiku）；到了就等第二天接着补
    dailyCalls: 200,
    // 用户可能怎么说：Claude 出问题的时候她还一直在后台重试
    // 怎么调：调用出错（不是写坏了）以后歇多少分钟再试
    errorPauseMinutes: 5,
  },

  note: {
    // 用户可能怎么说：就说了一句"晚安"也写一条笔记，没必要
    // 怎么调：一段里你说的话加起来少于这么多字就不写笔记（这样的段还是能按原来的字面规则想起来）
    minUserChars: 8,
    // 用户可能怎么说：很长的一段聊天，笔记只记住了开头
    // 怎么调：交给 haiku 的原文最多多少字；超了就留开头和结尾、省略中间
    inputChars: 4000,
    // 用户可能怎么说：我发了一大段，笔记没记到后面的事
    // 怎么调：每一句最多交多少字
    messageChars: 600,
    // 用户可能怎么说：有的段一直没笔记
    // 怎么调：haiku 写出来的不合格时最多再试几次（原文变了会重新算）
    maxAttempts: 2,
  },

  recall: {
    // 用户可能怎么说：我提到朋友的名字，她想不起来我们聊过他
    // 怎么调：你这句话里出现了笔记里记的人名，加几分
    person: 6,
    // 用户可能怎么说：我说店名、地名、事情，她想不起来
    // 怎么调：出现了笔记里三个字以上的词（"拉面店""毕业旅行"），加几分
    longTerm: 4,
    // 用户可能怎么说：我随口说个"周末"，她就翻出不相干的旧事
    // 怎么调：出现了笔记里两个字的词（"周末""学校"），加几分；没有"还记得""那件事"这类话时，光靠它想不起来
    shortTerm: 2,
    // 用户可能怎么说：我说"我的梦游冷笑话"，她没想起来那次梦游写纸条（I-083，2026-11-11）
    // 怎么调：两个字的词正好是那条笔记自己的标签、标题里也有（写笔记时就认定它是这段的主题，比如"梦游写纸条"里的"梦游"），加几分；和三个字以上的词一样，不用"还记得"也能想起来
    ownTag: 4,
    // 用户可能怎么说：我一说某个外号和"可爱"，她就翻出一堆不相干的旧事
    // 怎么调：一个标签最多出现在几条笔记里，才算某条笔记自己的主题（你们的昵称、"可爱"这种几乎每条都有的不算）；调小 = 更严
    ownTagMaxNotes: 2,
    // 用户可能怎么说：我说"拉面"她想不起"拉面店"那次
    // 怎么调：只对上了笔记里一个词的头两个字或末两个字，加几分
    partial: 1,
    // 用户可能怎么说：我说"那家店""那部电影"，她不知道是哪个
    // 怎么调：你说"那家店""那部电影"这种指着以前的东西的话，笔记里有对得上的（"拉面店""电影"），加几分
    pointer: 3,
    // 用户可能怎么说：我问"去了吗""怎么样了"，她想不起来我们约过什么
    // 怎么调：你在问后来怎么样（"去了吗""怎么样了""后来呢"），笔记里正好记了打算，加几分
    followUp: 1,
    // 用户可能怎么说：我问"那家店去了吗"，她翻出的是别的打算
    // 怎么调：在问后来怎么样，而且笔记里的打算就是你说的那件事，再加几分
    planHit: 2,
    // 用户可能怎么说：我说"还记得……"，她还是说不记得
    // 怎么调：你在提以前的事（"还记得""那件事""那家店""去了吗"）时，笔记至少几分才算想起来；调小 = 更容易想起来
    withCue: 2,
    // 用户可能怎么说：我只是随口一说，她就翻出以前的事
    // 怎么调：没在提以前的事时，笔记至少几分才翻出来；调大 = 更不容易乱翻
    withoutCue: 4,
  },

  matter: {
    // 用户可能怎么说：她老翻出不重要的小事，重要的反而没想起来／她总想起同一件事
    // 怎么调：几条回忆都对得上时，"重要"最多给一条加几分排序（上限；比一个人名 6 分、三字词 4 分小，所以只能在对得上的几条里挑，不会翻出对不上的）。调大 = 重要的更靠前，0 = 不看轻重
    maxBonus: 3,
    // 用户可能怎么说：我们反复聊的事她该记得更牢
    // 怎么调：一段聊天被你明确提起（"还记得……"）后，记忆的分量比起点高出多少算"提了很多次"（满分）；原来每提一次加 10、5、2，一个月不提慢慢回落
    weightFull: 40,
    // 用户可能怎么说：开心或难过的大事忘得太快／小事记得太久
    // 怎么调：写笔记时她自己判断这段对你有多重（felt 0 到 3）；情绪越强忘得越慢。这是 felt 为 0 时分量减半要多少天，felt 每高一档久半倍
    feltHalfLifeDays: 45,
    // 用户可能怎么说：说好要做的事她早就不提了／还没了结的事一直占着位置
    // 怎么调：笔记里写着"打算做、还没做"的事，这么多天内更容易想起来，之后当普通回忆
    planDays: 21,
    // 用户可能怎么说：同上
    // 怎么调：没了结的打算算作几成的"重要"（0 到 1）
    planPart: 0.6,
    // 用户可能怎么说：刚讲过的旧事一轮一轮又被翻出来
    // 怎么调：一段回忆被她想起之后，接下来几句你说的话里先让别的靠前（你明确问"还记得……"时不受影响）。每换一句你说的话算一轮
    cooldownTurns: 3,
    // 用户可能怎么说：同上
    // 怎么调：刚想起过的回忆排序时扣几分（只是往后排，没有别的可选时还是会给她）
    cooldownPenalty: 4,
  },

  update: {
    // 用户可能怎么说：我早就说换了，她还拿旧的说／她把不相干的旧事也当成"已经变了"
    // 怎么调：你说"某件事变了"之后，她用写笔记时记下的"原来是什么"去对更早的笔记；至少对上几组相邻的字才算是在说那件事（调大 = 更保守，不容易误标，也更容易漏掉）
    minPairs: 2,
    // 用户可能怎么说：同上
    // 怎么调："原来是什么"那句话里，至少有多大比例（0 到 1）的相邻字在更早的笔记里出现，才算在说同一件事（原话整句出现则直接算）
    minShare: 0.5,
    // 用户可能怎么说：一条旧回忆后面跟了一大串更新
    // 怎么调：一条旧回忆最多附带几条后来的更新（最新的先）
    maxShown: 2,
    // 用户可能怎么说：已经变了的旧事还排在前面
    // 怎么调：带着"后来有更新"的旧回忆排序时扣几分（只是往后排；你明确问"还记得……"时不扣，没有别的可选时还是会给她，但会带着更新）
    penalty: 4,
  },
});
