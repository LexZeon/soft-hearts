/**
 * 功能：边说边演：她每句话前面带看不见的表情、动作标记，说到那里就演；有时整条只演不说
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：标记写成 ⟦词⟧，词只能是 interface.ts 的封闭词表；本机把标记从字里去掉，记成拍子（choose.ts）。
 * 方案 docs/claude/2026-11-19-per-reply-choreo-plan.md。这些都是第一版的猜测值，还没用真的回复量过（方案第 5 步会量）。
 */

export interface SpeechBeatKnobs {
  readonly maxBeats: number;
  readonly maxAtOnce: number;
  readonly markerMaxChars: number;
  readonly describeMax: number;
}

export const SPEECH_BEAT_KNOBS: SpeechBeatKnobs = Object.freeze<SpeechBeatKnobs>({
  // 用户可能怎么说：她一条回复里动个不停，像在表演
  // 怎么调：一条回复最多演几拍，多出来的标记丢掉（字照常显示）
  maxBeats: 16,

  // 用户可能怎么说：一句话开头她同时做好几个动作，乱糟糟的
  // 怎么调：同一个位置（同一句话开头）最多叠几拍
  maxAtOnce: 3,

  // 用户可能怎么说：她回复里偶尔漏出一段英文单词或方括号
  // 怎么调：从 ⟦ 起最多等多少个字还没看到 ⟧，就认定这不是一个完整的标记（⟦ 和后面的英文字母丢掉，其余照常显示）
  markerMaxChars: 24,

  // 用户可能怎么说：只演不说的那条，聊天页的灰色小字太长了
  // 怎么调：灰色小字最多写几个动作
  describeMax: 3,
});

/** 第 3 步：拍子什么时候演（schedule.ts）。都是第一版的猜测值，第 5 步用真的回复量过再调。 */
export interface SpeechBeatTimingKnobs {
  readonly performanceGapMs: number;
  readonly burstKeep: number;
  readonly burstWindowMs: number;
  readonly voiceMsPerChar: number;
  readonly voiceGraceMs: number;
  readonly staleMs: number;
  readonly holdCapMs: number;
  readonly spanGraceMs: number;
}

export const SPEECH_BEAT_TIMING: SpeechBeatTimingKnobs = Object.freeze<SpeechBeatTimingKnobs>({
  // 用户可能怎么说：只演不说的时候，她的表情一个接一个换得太快（或太慢）
  // 怎么调：只演不说的回复，相邻两拍隔多少毫秒（方案定的是 0.6～1.2 秒）
  performanceGapMs: 850,

  // 用户可能怎么说：朗读关着、回复一下子全出来时，她的表情连着换好几下，像抽搐
  // 怎么调：朗读关着时，一阵子里最多演几个位置的拍子，多的挪到下一阵子再演（2026-11-23 起不丢；同一句话开头叠在一起的算一个位置）
  burstKeep: 2,

  // 用户可能怎么说：朗读关着时，回复出得快，后面几句她就没表情了
  // 怎么调：上一条里的"一阵子"有多长（毫秒）；短一点，后面的句子就还能演
  burstWindowMs: 1500,

  // 用户可能怎么说：朗读开着时，一句话说到一半的那个表情来得太早（或太晚）
  // 怎么调：朗读时估计每个字念多少毫秒，用来算一句话中间的拍子什么时候到
  voiceMsPerChar: 220,

  // 用户可能怎么说：朗读开着，这条却没念出来，她也没有表情
  // 怎么调：朗读开着但这条一直没开始念，字都显示完以后再等多少毫秒，就改成跟着字演
  voiceGraceMs: 2500,

  // 用户可能怎么说：她过了很久才突然做了个表情，和刚才的话对不上
  // 怎么调：一条回复开始多少毫秒以后，还没演的拍子全部作废（保险，平时用不到）
  staleMs: 120000,

  // 用户可能怎么说：她笑了一下，下一句话还在笑，可那个笑一直挂着不放（或者笑一会儿就没了）
  // 怎么调：一个表情、看向或眼神从开始演起，最多挂多少毫秒（保险：正常是挂到她换下一个，或这条回复说完）
  holdCapMs: 12000,

  // 用户可能怎么说：她话刚说完，表情就立刻收了（或者话说完了表情还挂着）
  // 怎么调：这条回复说完（念完，或朗读关着时字显示完）以后，再等多少毫秒让挂着的表情落下去
  spanGraceMs: 900,
});

/** 2026-11-24：小窗里有没有亲亲抱抱（window-close.ts 读它；全屏不受影响）。 */
export interface SpeechBeatWindowKnobs {
  readonly windowCloseMoments: boolean;
}

export const SPEECH_BEAT_WINDOW: SpeechBeatWindowKnobs = Object.freeze<SpeechBeatWindowKnobs>({
  // 用户可能怎么说：小窗里的亲亲抱抱效果不好先不要（想要回来时说"小窗的亲亲抱抱放回来"）
  // 怎么调：false（现在）：小窗里她回复里的 ⟦kiss⟧ / ⟦hug⟧ 和 hug-held、pause、let-go 什么都不演，也不告诉她能写，灰色小字不写；true：小窗照常原地亲、抱；全屏不看这个值，一直有
  windowCloseMoments: false,
});

/** 2026-11-25：全屏里她写了亲亲、抱抱，后面的话等不等真的亲上、抱住（contact-hold.ts）。 */
export interface SpeechBeatContactKnobs {
  readonly wordsWaitForContact: boolean;
}

export const SPEECH_BEAT_CONTACT: SpeechBeatContactKnobs = Object.freeze<SpeechBeatContactKnobs>({
  // 用户可能怎么说：她亲我抱我之前就先说"好了、成功了"（或者：走过来的路上我想听她一直说下去）
  // 怎么调：true（现在）：全屏里她写了 ⟦kiss⟧ / ⟦hug⟧，那一句照常边走边说，后面的句子等她真的亲上、抱住才出来（亲的时候嘴贴着一直不说，退开再说；抱住以后照常说）；没走过来、被拉开或等太久，后面的话马上放出来；false：照 11-23 的做法，后面的话不等
  wordsWaitForContact: true,
});
