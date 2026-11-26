/**
 * 功能：听歌时她有反应，不只是踩拍子（I-077 第 1 步：乐段起落、音色、歌的情绪；记录 docs/claude/2026-11-11-i077-music-reactions.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 分层（每层可以单独换）：听出来什么（hearing.ts：乐段抬升 / 落下、弹的还是拉长的、亮度、低音、歌的情绪；beat-clock.ts：拍子和四拍一组）
 * → 意图（director.ts：抬升 lift、落下 settle、喜欢 enjoy、被打动 moved）→ 配方（recipes.ts：每种 2～3 个变体）
 * → 她来挑（choose.ts：按激素相对基线和角色倾向）→ 排时（四拍一组的开头；拍子不清楚就在乐段变化处，轻一点）
 * → 脸（speech-face 的滑块，经 performPick）、头和舞（music-dance.ts 的 shape）→ 回到心情（shared/foundation/mood-moments.ts）。
 * 写死的只有：一首歌里的反应上限、两次反应的最小间隔、幅度上限（脸的上限在 speech-face/knobs.ts）、"一直跟着跳"时完全不动（R15 已确认）。
 * 这些都只是试用值，没在真歌、真机上看过。
 */

export const MUSIC_REACT_KNOBS = Object.freeze({
  section: Object.freeze({
    // 用户可能怎么说：歌明明进副歌了她没反应／一点小变化她就一惊一乍
    // 怎么调：拿最近 currentSeconds 秒和它前面 referenceSeconds 秒比；liftDb＝响了几分贝开始算"起来了"，fullDb＝几分贝算完全；densityRise＝鼓点密了几成开始算（0.25＝密了 25%）；bandShift＝频带的比例变了多少开始算。调大 = 只认更明显的变化
    currentSeconds: 1,
    referenceSeconds: 4,
    liftDb: 2,
    fullDb: 6,
    densityRise: 0.25,
    bandShift: 0.05,
    // 用户可能怎么说：乐段刚变她就反应，太急／变了好一会儿她才反应
    // 怎么调：变化要持续多少秒才算数（dwell）；两次乐段变化之间至少隔几秒（refractory）；score＝多大的变化分数（0～1）才开始算
    dwell: 0.6,
    refractory: 5,
    score: 0.5,
  }),
  tone: Object.freeze({
    // 用户可能怎么说：明明是一下一下弹的歌她却在慢慢晃／长音的歌她还在蹦
    // 怎么调：每个鼓点后音量在 windowSeconds 秒内掉多少分贝：掉 sustainDb 以下算"拉长的"，掉 pluckDb 以上算"一下一下弹的"；follow＝跟上新歌的快慢（秒）
    windowSeconds: 0.3,
    sustainDb: 3,
    pluckDb: 14,
    follow: 5,
  }),
  color: Object.freeze({
    // 用户可能怎么说：欢快的歌她不笑／慢歌她也没安静下来／歌的情绪她跟得太快、一会儿笑一会儿不笑
    // 怎么调：歌的情绪由速度、亮度、鼓点密度、弹的还是拉长的混成（-1 慢而暗 … +1 亮而欢快）；follow＝跟上的快慢（秒，越大越稳）；slowBpm、fastBpm＝多慢算慢、多快算快
    follow: 8,
    slowBpm: 80,
    fastBpm: 130,
    // 怎么调：亮度（高频 2～8 kHz 相对中频的比例）多少算暗、多少算亮
    darkShare: 0.05,
    brightShare: 0.3,
  }),
  style: Object.freeze({
    // 用户可能怎么说：不同的歌她跳得都一样／风格变化太夸张
    // 怎么调：弹的、亮的歌蹦得多几成（bounce）；拉长的、柔的歌慢慢晃的比例（slowSway，0～1）；低音重的歌点头重几成（nod）。0 = 不随歌变
    bounce: 0.35,
    slowSway: 0.6,
    nod: 0.3,
    // 怎么调：风格跟上新歌用几秒（越大越慢、越不容易看出跳变）；认出是音乐几秒后才开始按歌调
    follow: 3,
    settleSeconds: 4,
  }),
  face: Object.freeze({
    // 用户可能怎么说：欢快的歌她脸上没笑意／慢歌时她眼睛半闭太多
    // 怎么调：歌的情绪在脸上最多多少：smile＝亮而欢快时的笑眼，soft＝慢而暗时半垂的眼皮（0～1）
    smile: 0.05,
    soft: 0.12,
    // 怎么调：脸跟上歌的情绪用几秒
    follow: 3,
  }),
  choice: Object.freeze({
    // 用户可能怎么说：她听歌时反应太多，一惊一乍／太少，像没听见
    // 怎么调：一首歌里最多几次大一点的反应（perSong，写死的上限）；两次反应至少隔几秒（minGap，再加一点随机）
    perSong: 2,
    minGap: 12,
    // 怎么调：碰到乐段抬升、落下时做反应的基础机会（0～1），再按心情和性格浮动；每做过一次，下一次的机会乘 again
    lift: 0.65,
    settle: 0.45,
    again: 0.55,
    // 怎么调：她没在跳也没点头（只是听着）时机会再乘多少；拍子不清楚时幅度乘多少（在乐段变化处轻轻起）
    still: 0.5,
    gentle: 0.7,
    // 用户可能怎么说：一首很长又没什么起伏的歌，她一直没表情
    // 怎么调：没有乐段变化时，听了多少秒以后可能自己"享受"一下或被慢歌"打动"一下（每首最多一次）
    spontaneousAfter: 30,
    spontaneous: 0.5,
    // 怎么调：歌的情绪到多少算"慢而暗"（会被打动）、多少算"亮"（更常是享受）
    dark: -0.35,
    bright: 0.3,
    // 用户可能怎么说：她认出常放的歌，却没什么表示／每次认出来都一个样
    // 怎么调：认出常放的歌时做小反应的基础机会（0～1，再按心情、性格、口味浮动，也可能只是安静地认得）；同一首歌认出来之后至少隔几秒不再来第二次（repeatSeconds）
    recognize: 0.75,
    repeatSeconds: 600,
  }),
  taste: Object.freeze({
    // 用户可能怎么说：她喜欢的歌和不喜欢的歌，反应没什么差别／不喜欢的歌她几乎不动（不会没反应，也不会嫌弃）
    // 怎么调：喜欢的程度（-1～+1，由角色卡上的音乐口味和这首歌的速度、亮度、劲头算出）怎么改她的投入：often＝反应的机会，size＝反应的大小，dance＝舞的大小，mood＝听歌那一下心情的大小。0.5 = 最喜欢多 50%、最不对胃口少 50%；都有下限，不会变成零。口味没设（全 50）时全是 1，和没有口味功能时一模一样
    often: 0.5,
    size: 0.25,
    dance: 0.18,
    mood: 0.3,
    // 怎么调：喜欢的程度跟上这首歌用几秒（越大越稳，歌的特征晃一下她的投入不会跟着晃）；歌刚开始的头 settleSeconds 秒里，她的选择（做不做、做多大）直接按当时的特征算，不等它慢慢跟上
    follow: 4,
    settleSeconds: 8,
    // 怎么调：速度从多慢到多快对应"慢歌…快歌"那一条（bpm）；"劲头"由鼓点密度（denseOnsets＝每秒多少个鼓点算很密）、弹的程度和低音混成，下面三个是各自的比重
    slowBpm: 70,
    fastBpm: 140,
    denseOnsets: 4,
    energyDensity: 0.5,
    energyPluck: 0.25,
    energyBass: 0.25,
    // 怎么调：口味里有多少"有偏好"（每项离 50 越远越多）才算"口味很鲜明"，达到这么多时喜欢程度满分
    strongAt: 1,
  }),
  // 用户可能怎么说：她来劲时听歌反应还是很小／她困了还在一惊一乍／她紧张时还在晃
  // 怎么调：心情的激素数（相对角色自己的基线，±50 点 = ±1；困看腺苷推出的疲倦）怎么改"做不做、做多大"。N 和 D 一起高＝更来劲；A（困）和 C（紧张）＝更少、更小
  hormones: Object.freeze({
    ND: Object.freeze({ often: 0.5, size: 0.35 }),
    sleepy: Object.freeze({ often: -0.8, size: -0.5 }),
    C: Object.freeze({ often: -0.4, size: -0.3 }),
    E: Object.freeze({ soft: 0.8 }),
  }),
  // 用户可能怎么说：活泼的角色听歌也没什么反应／克制的角色反应太多
  // 怎么调：角色倾向（I-037，0～100，50 一般，±50 = ±1）怎么改"做不做、做多大"
  dispositions: Object.freeze({
    lively: Object.freeze({ often: 0.4, size: 0.2 }),
    restrained: Object.freeze({ often: -0.5, size: -0.3 }),
    volatile: Object.freeze({ often: 0.1, size: 0.2 }),
  }),
});
