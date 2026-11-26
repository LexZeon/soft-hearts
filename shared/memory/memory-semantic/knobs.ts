/**
 * 功能：按意思想起旧事（本机小模型 BGE，I-111）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 三部分：
 *  - match：你说话时，一句话和旧记忆"意思有多近"（0～1 的相似度）到多少才算想起来、想起来算几分。分数和关键词、笔记用同一把尺（一个人名 6 分、三字词 4 分），语义最多 3 分，所以字面对上的永远排在只靠意思的前面。
 *  - text：每条旧记忆拿哪些字去算"意思"，你这句话最多取多少字。
 *  - pace：后台什么时候、一次补多少条旧记忆的"意思"，模型放着不用多久就关掉。
 * 开关在「聊天记忆」里，默认关；关着不下载、不算。这些都只是试用值，没在真机上看过。
 */

export interface MemorySemanticKnobs {
  readonly match: {
    readonly floor: number;
    readonly floorJitter: number;
    readonly ceiling: number;
    readonly maxScore: number;
    readonly withLiteralMax: number;
    readonly top: number;
  };
  readonly text: {
    readonly queryChars: number;
    readonly messageChars: number;
    readonly memoryChars: number;
    readonly minChars: number;
  };
  readonly pace: {
    readonly tickSeconds: number;
    readonly batch: number;
    readonly saveSeconds: number;
    readonly idleStopMinutes: number;
    readonly prefetchMs: number;
  };
}

export const MEMORY_SEMANTIC_KNOBS: MemorySemanticKnobs = Object.freeze<MemorySemanticKnobs>({
  match: {
    // 用户可能怎么说：我随口一句话她就翻出不相干的旧事／我说"我家那只猫"她明明有这段却没想起来
    // 怎么调：意思相似度（0～1）至少多少才算想起来；调大 = 更不容易乱翻。本机量过：对得上的多在 0.45～0.75，毫不相干的句子也会到 0.4～0.57，所以不能再低
    floor: 0.55,
    // 用户可能怎么说：她每次想起的总是同一批，没变化
    // 怎么调：每一轮在上面的线上再随机加 0 到这么多（每句话各抽一次），让擦边的记忆有时想起来、有时不；0 = 每次一样
    floorJitter: 0.03,
    // 用户可能怎么说：意思几乎一样的话，她还是想得不够起劲
    // 怎么调：相似度到多少算"满分"；从线到这里分数线性涨到 maxScore
    ceiling: 0.75,
    // 用户可能怎么说：只靠意思想起来的太容易排到前面／太靠后
    // 怎么调：只靠意思想起一条，最多算几分（比一个人名 6 分、三字词 4 分小，字面对上的排在前面）
    maxScore: 3,
    // 用户可能怎么说：字面和意思都对得上的，应该更靠前一点
    // 怎么调：这条记忆字面（关键词、笔记）已经对上了，意思再给它最多加几分
    withLiteralMax: 1,
    // 用户可能怎么说：她一次想起的太多
    // 怎么调：一句话最多取几条"只靠意思"的候选（聊天记忆本来一次最多 3 条，这里再收一道）
    top: 2,
  },
  text: {
    // 用户可能怎么说：我发了一大段，她只抓到开头
    // 怎么调：你这句话最多取多少字去算意思
    queryChars: 120,
    // 用户可能怎么说：一段聊天里我说的话很长，意思被稀释
    // 怎么调：每条旧记忆里你的每一句最多取多少字
    messageChars: 80,
    // 用户可能怎么说：旧记忆只有开头被记住了
    // 怎么调：每条旧记忆一共最多取多少字（只取你说的话，不取她的回答）
    memoryChars: 240,
    // 用户可能怎么说：只说了"嗯""好"的聊天也被算进来了
    // 怎么调：你在一段里说的话少于这么多字，就不算意思（这样的段还是按原来的字面规则想起来）
    minChars: 6,
  },
  pace: {
    // 用户可能怎么说：旧记忆补得太慢／后台一直在算
    // 怎么调：后台每隔多少秒看一次有没有新的或没算过的记忆（你在聊天、说话时不算）
    tickSeconds: 5,
    // 用户可能怎么说：补旧记忆时电脑有点卡
    // 怎么调：每次最多补几条（一条约 3 毫秒，8 条一起约 15 毫秒）
    batch: 16,
    // 用户可能怎么说：想让新记忆更快能被想起来／少写点硬盘
    // 怎么调：算出来的结果最多隔多少秒写一次文件（补完一批也会写）
    saveSeconds: 30,
    // 用户可能怎么说：开着这个功能电脑一直占着内存
    // 怎么调：模型放着不用多少分钟就关掉（约 160 MB 内存），下次用时再开
    idleStopMinutes: 10,
    // 用户可能怎么说：开了这个功能，回我变慢了
    // 怎么调：你发消息后，最多等模型算你这句话多少毫秒；等不到这一轮就只用字面，不拖回复。模型已开着时一般 3 毫秒
    prefetchMs: 150,
  },
});
