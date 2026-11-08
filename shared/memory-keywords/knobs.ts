/**
 * 功能：记忆关键词：用关键词和权重找记忆（I-049、I-048）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 三部分：
 *  - write：写进索引的关键词的长度、个数上限，和旧笔记转换时各类词给多大权重。
 *  - match：你说话时，本机怎么用关键词给记忆打分（不调模型）。
 *  - kinds / sources：不同种类的关键词、不同来源的记忆各乘多少。
 * 这些都只是试用值，没在真机上看过。
 */

export const KEYWORD_KINDS = ['work', 'person', 'place', 'event', 'object', 'topic', 'plan'] as const;
export type KeywordKind = typeof KEYWORD_KINDS[number];
export const KEYWORD_SOURCES = ['chat', 'listen', 'watch'] as const;
export type KeywordSource = typeof KEYWORD_SOURCES[number];

export interface MemoryKeywordsKnobs {
  readonly write: {
    readonly perNote: number;
    readonly termChars: number;
    readonly aliases: number;
    readonly aliasChars: number;
    readonly fromPerson: number;
    readonly fromThing: number;
    readonly fromTag: number;
  };
  readonly match: {
    readonly top: number;
    readonly previousLines: number;
    readonly previousShare: number;
    readonly minScore: number;
    readonly halfLifeDays: number;
    readonly oldestShare: number;
    readonly chatScale: number;
  };
  readonly kinds: Readonly<Record<KeywordKind, number>>;
  readonly sources: Readonly<Record<KeywordSource, number>>;
}

export const MEMORY_KEYWORDS_KNOBS: MemoryKeywordsKnobs = Object.freeze<MemoryKeywordsKnobs>({
  write: {
    // 用户可能怎么说：一段记忆挂了太多关键词，什么都能撞上
    // 怎么调：每条记忆最多留几个关键词
    perNote: 12,
    // 用户可能怎么说：关键词是一整句话，没法对上
    // 怎么调：一个关键词最多多少字
    termChars: 20,
    // 用户可能怎么说：同一个东西换个叫法她就找不到
    // 怎么调：一个关键词最多留几个别名
    aliases: 5,
    // 用户可能怎么说：别名太长
    // 怎么调：一个别名最多多少字
    aliasChars: 20,
    // 用户可能怎么说：旧笔记里的人名排不到前面
    // 怎么调：旧笔记转换时，人名的权重（0～1）
    fromPerson: 0.9,
    // 用户可能怎么说：旧笔记里的店名事情排不到前面
    // 怎么调：旧笔记转换时，事物（店、地方、事情）的权重（0～1）
    fromThing: 0.6,
    // 用户可能怎么说：旧笔记里的标签乱撞
    // 怎么调：旧笔记转换时，标签的权重（0～1）
    fromTag: 0.3,
  },

  match: {
    // 用户可能怎么说：她一次想起的太多／太少
    // 怎么调：一次最多挑几条记忆（不超过聊天记忆本来的 3 条上限）
    top: 3,
    // 用户可能怎么说：我说"那个呢"她不知道指什么
    // 怎么调：除了你这句话，再看前面几句聊天
    previousLines: 2,
    // 用户可能怎么说：前面聊过的词老是把这句话带偏
    // 怎么调：前面几句里对上的词，分量是这句话的多少倍（0～1）
    previousShare: 0.5,
    // 用户可能怎么说：随口一个词她就翻出旧事
    // 怎么调：一条记忆至少多少分才算对上；调大 = 更不容易乱翻
    minScore: 0.3,
    // 用户可能怎么说：她老想起很久以前的，不想最近的
    // 怎么调：记忆每过多少天，分数减半
    halfLifeDays: 45,
    // 用户可能怎么说：很旧的事再怎么提她也想不起来
    // 怎么调：再旧的记忆也至少保留多少分之几的分数（0～1）
    oldestShare: 0.35,
    // 用户可能怎么说：关键词对上了，她还是想不起那次聊天／一个词就翻出旧事
    // 怎么调：关键词对上聊天记忆时，分数乘多少再加到聊天回忆原来的分数上（6 = 对上一个满分的人名，和笔记里的人名一样重）
    chatScale: 6,
  },

  kinds: {
    // 用户可能怎么说：我提到作品名她没反应／反应太大
    // 怎么调：作品名的关键词分量
    work: 1,
    // 用户可能怎么说：我提到人名她想不起来
    // 怎么调：人名的关键词分量
    person: 1,
    // 用户可能怎么说：我说地名店名她想不起来
    // 怎么调：地点的关键词分量
    place: 0.9,
    // 用户可能怎么说：我提到某件事她想不起来
    // 怎么调：事件的关键词分量
    event: 0.8,
    // 用户可能怎么说：我提到某个东西她想不起来
    // 怎么调：物品的关键词分量
    object: 0.6,
    // 用户可能怎么说：泛泛的话题词老是撞上
    // 怎么调：话题的关键词分量
    topic: 0.5,
    // 用户可能怎么说：我约过的事她想不起来
    // 怎么调：打算的关键词分量
    plan: 0.8,
  },

  sources: {
    // 用户可能怎么说：想起的总是看剧的事，不是我们聊的
    // 怎么调：聊天笔记的分量
    chat: 1,
    // 用户可能怎么说：一起听过的东西她想不起来
    // 怎么调：一起听笔记的分量
    listen: 0.85,
    // 用户可能怎么说：一起看过的东西她想不起来／老是提起
    // 怎么调：陪看笔记（画面描述和概要）的分量
    watch: 0.85,
  },
});
