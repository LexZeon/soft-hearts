/**
 * 功能：她说话时脸上的小重音：笑眼、挑眉、眯眼、脸红、点头、歪头（I-073 第 3 条，怎么调见 docs/claude/how-to-tune-mood-face.md「说话时的小重音」）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 分层（每层可以单独换）：意图（intent-table.ts，这一句想表达什么）→ 配方（recipes.ts，用哪根滑块、多大、怎么起落）
 * → 她来挑（choose.ts，按心情的激素数和角色倾向）→ 排时（timing.ts / layer.ts，落在声音的重音上）→ 滑块（procedural-life.ts）→ 模型。
 * 写死的只有四样（hard 下面）：嘴归口型、最小间隔和次数、幅度上限、被打断就作废。其余都在一个范围里浮动。
 * 这些都只是试用值，没在真机上看过。
 */

export const SPEECH_FACE_KNOBS = Object.freeze({
  hard: Object.freeze({
    // 用户可能怎么说：她说话时眼睛眉毛动得太勤，像在抽／一句话里眉毛挑了好几次
    // 怎么调：眼眉动作（笑眼、挑眉、眯眼）两次开始之间至少隔几秒；windowCount = 滚动 10 秒里最多几次。调大秒数 = 更稀
    faceGap: 1.6,
    faceWindowCount: 5,
    // 用户可能怎么说：她说话时老点头／头动得太多
    // 怎么调：点头、歪头两次开始之间至少隔几秒；windowCount = 滚动 10 秒里最多几次。点头和歪头本来就不会同时做
    headGap: 2.4,
    headWindowCount: 3,
    // 用户可能怎么说：她说话时老是脸红
    // 怎么调：说话时的脸红两次之间至少隔几秒（每句最多一次，写死）
    blushGap: 6,
    // 用户可能怎么说：她说话时笑眼／挑眉／脸红太夸张了
    // 怎么调：每根滑块在她当下心情的脸上最多再加多少（表情 0～1；点头、歪头是角度）。这是上限，她自己挑的通常比这小
    caps: Object.freeze({ smileEyes: 0.18, browUp: 0.16, jitome: 0.1, blush: 0.13, nodDeg: 2.5, tiltDeg: 3 }),
    // 用户可能怎么说：听歌时她眼睛睁得太大／闭眼享受闭得太多
    // 怎么调：I-077 听歌的反应也走这一层，多两根滑块的上限：eyeWide＝"眼睛一亮"（睁大眼），lidSoft＝"闭眼享受"（半垂的眼皮）。说话时不用它们
    musicCaps: Object.freeze({ eyeWide: 0.16, lidSoft: 0.4 }),
    // 用户可能怎么说：被打断以后她的脸收得太急／太慢
    // 怎么调：被打断、换话题、被拖动时，没做完的小动作从当前样子回到原样用几秒（速度连续地收，不补做）
    releaseSeconds: 0.35,
  }),
  timing: Object.freeze({
    // 用户可能怎么说：她的表情总比重音晚半拍／太早
    // 怎么调：动作至少提前多少秒开始，在重音那一刻最明显（实际提前多少由配方的起落决定，眼眉约 0.28 秒、点头约 0.3 秒）。来不及就不做，不为它让声音晚出来
    lead: 0.2,
    // 用户可能怎么说：她说完一句肯定的话，点头点得不是时候
    // 怎么调：多长的安静才算真正的句间停顿（秒）；比它短的字间停顿、网络断流都不算
    minPause: 0.18,
    // 怎么调：安静的判断：音量低于这一句最响处的几成算安静
    pauseLevel: 0.15,
    // 怎么调：提前多少秒看下一个分句（找重音用）
    lookahead: 0.6,
    // 用户可能怎么说：没开朗读时她的小表情太明显
    // 怎么调：没有声音可对时（系统语音、没开朗读），在分句开头做的那一下有多大（相对平常）
    onsetGain: 0.7,
    // 怎么调：估计说话速度（每秒几个字），没有声音数据时用来估计每个分句在哪：zh 中文、en 英文（按字母数）
    charsPerSecond: Object.freeze({ zh: 4.6, en: 14 }),
  }),
  choice: Object.freeze({
    // 用户可能怎么说：她说话时表情太少，像木头／太多了
    // 怎么调：意思明确的一句，做眼眉动作、头部动作、脸红的基础机会（0～1），再按心情和性格浮动。调大 = 更常做
    face: 0.6,
    head: 0.45,
    blush: 0.5,
    // 用户可能怎么说：她连标点都当真，一个问号就歪头
    // 怎么调：一句话的意思至少多明确（0～1）才会动。调大 = 只在很明显时才动
    minWeight: 0.5,
  }),
  // 用户可能怎么说：她来劲的时候说话表情还是一样小／她困了表情还那么多／她紧张的时候还在笑眼
  // 怎么调：心情的六种激素数（相对角色自己的基线，±50 点 = ±1；困看腺苷推出的疲倦）怎么改"做不做、做多大、挑哪种"。数字是每 1 的变化带来的倍数变化
  hormones: Object.freeze({
    // N（去甲肾上腺素）是"激活和警觉"，不是"兴奋"本身：它和谁一起高决定读法（docs/mood/expression-mapping.md）。
    // N 高时按 D 高、C 高（E 低）、单独高三种的占比混合：withD = 更来劲、更生动；withC = 紧张、受惊：少俏皮、不加笑眼和脸红，挑眉可以有但不是开心的那种；
    // alone = 警觉、专注。每项是 N 每高 1 带来的倍数变化：often 做得更勤、size 更大、playful 俏皮的变体、warm 笑眼和脸红、tense 绷着的眉。
    // 以后 N 改成偏向"害怕"（I-076，未定）时只改这张表。
    N: Object.freeze({
      withD: Object.freeze({ often: 0.5, size: 0.25, playful: 0.3, warm: 0, tense: 0 }),
      withC: Object.freeze({ often: -0.2, size: 0, playful: -0.8, warm: -0.8, tense: 0.5 }),
      alone: Object.freeze({ often: 0.1, size: 0, playful: 0, warm: 0, tense: 0.1 }),
      // 怎么调：不和 D、C 一起时，"单独高"占多少（相对 D、C 高出的量）
      aloneShare: 0.2,
    }),
    sleepy: Object.freeze({ often: -0.7, size: -0.4 }),
    O: Object.freeze({ warm: 0.5 }),
    C: Object.freeze({ playful: -0.5, tense: 0.3 }),
    D: Object.freeze({ happy: 0.4, smile: 0.6 }),
    E: Object.freeze({ size: -0.15, slow: 0.2, soft: 0.8 }),
  }),
  // 用户可能怎么说：活泼的角色说话也没什么表情／克制的角色表情太多
  // 怎么调：角色倾向（I-037，0～100，50 一般，±50 = ±1）怎么改"做不做、做多大"
  dispositions: Object.freeze({
    lively: Object.freeze({ often: 0.6, size: 0.15 }),
    restrained: Object.freeze({ often: -0.6, size: -0.3 }),
    volatile: Object.freeze({ often: 0.2, size: 0.2 }),
    shy: Object.freeze({ blush: 0.8 }),
    clingy: Object.freeze({ warm: 0.3 }),
  }),
});
