/**
 * I-175 按部位分层混合（方案 docs/claude/2026-11-22-i175-mixer-plan.md，清点 docs/claude/2026-11-21-i175-layering-survey.md）。
 * /22：反馈某表情的嘴型朗读时没显出来，建议朗读时优化嘴上的动作、找一个通用解法，并问做动作的回答可以配做多久；
 * 方案五条：1～4 按推荐，第 5 条"老舞台移植后可以删除了"（老舞台不接，I-176 删）。
 *
 * 这里是纯规则（不碰 three.js、不碰时钟；测试用假时钟）：她身上每个部位"谁在用、怎么叠"。
 *  - 部位表 PARTS：眼皮、眉毛、嘴形、嘴的开合（口型）、脸颊、头、脖子、身体、手臂、手。眼珠看哪里是共用的视线选择器，不在这里。
 *  - 每个来源报：用哪几个部位；每个部位上是"底形"（base，定一个样子，别的叠在上面）、"叠加"（additive，和别的相加或取大）还是
 *    "独占"（exclusive，这一小会儿整组归它：脸的独占 src/stage/face-exclusive.ts）；能不能边说边做（talkThrough）；进出用多久（easeS）。
 *  - 嘴（这次的核心，mouth.ts）：表情定底形（撅、笑、嘴角），口型在底形上开合，幅度打折（knobs.ts mouthTalkThrough = 0.6）；
 *    口型的元音跟着底形偏（撅 → う/お，笑 → い/え，别的 → あ；模型没有那个口型就退回 あ）。
 *  - 必须闭嘴的（鼓腮、吐舌、亲；撅嘴不算，它能边说边做）：排到下一个句间停顿或念完以后，念完 3 秒还没轮到就不做（closed-mouth.ts）。
 *  - "做多久"（第 3 步挪到 shared/behaviors/speech-beats/how-long.ts：读它的是边说边演）：不写 = 挂到同一条通道的下一拍或说完（上限 12 秒）；once ≈ 这一拍自己的时长；line = 到这句念完的停顿。
 * 底线（写死的）：声音永远不被打断，画面迁就声音；全部缓入缓出（R29）；姿势 / 手势 / 表情三条通道各自独立，混合只管它们落到同一个部位时怎么叠；
 * 不改模型原文件。
 */

/** 她身上的部位（每个部位一张"谁在用、怎么叠"）。 */
export const PARTS = ['eyelids', 'brows', 'mouthShape', 'mouthOpen', 'cheeks', 'head', 'neck', 'body', 'arms', 'hands'] as const;
export type Part = typeof PARTS[number];
export const PART_ZH: Readonly<Record<Part, string>> = Object.freeze({
  eyelids: '眼皮', brows: '眉毛', mouthShape: '嘴形', mouthOpen: '嘴的开合（口型）', cheeks: '脸颊', head: '头', neck: '脖子', body: '身体', arms: '手臂', hands: '手',
});

/** 在一个部位上怎么叠：底形（定样子，别的叠在上面）、叠加（相加或取大）、独占（这一小会儿整组归它）。 */
export type PartKind = 'base' | 'additive' | 'exclusive';

export interface PartClaim {
  readonly kind: PartKind;
  /** 她说话（朗读出声）时这个部位照样做（true），还是要让开、等停顿（false）。 */
  readonly talkThrough: boolean;
  /** 进出各用多久（秒，大约到九成）：从不一帧跳到位。 */
  readonly easeS: number;
}

export type SourceId = 'idle' | 'gaze' | 'lipSync' | 'speechBeat' | 'touchReaction' | 'feeling' | 'smallAction' | 'closedMouth' | 'handGame' | 'sleep' | 'talkCalm';

/** 一个来源：它用哪几个部位、各怎么叠。 */
export interface SourceDecl {
  readonly id: SourceId;
  readonly zh: string;
  readonly parts: Readonly<Partial<Record<Part, PartClaim>>>;
}

/** 嘴上的一个形态在说话时算什么：嘴形（底形，边说边做）、开合（口型拥有它）、闭嘴类（说话时不做）。 */
export type MouthRole = 'shape' | 'opening' | 'closed';

/** 口型的五个元音。 */
export const VOWELS = ['a', 'i', 'u', 'e', 'o'] as const;
export type Vowel = typeof VOWELS[number];
export type VowelWeights = Record<Vowel, number>;

/** 嘴的底形，从这一帧做出来的表情读出来（mouth.ts mouthBaseOf）。 */
export interface MouthBase {
  /** 撅、嘟、收拢（0..1）。 */
  readonly pucker: number;
  /** 笑、嘴角上扬（0..1）。 */
  readonly smile: number;
  /** 底形整体有多强（0..1）：口型的幅度按它打折。 */
  readonly strength: number;
}

/** 这一帧口型怎么开：幅度系数（说话时永远 ≥ knobs.mouthTalkThrough，从不为 0）和五个元音的分配（和为 1）。 */
export interface TalkThroughMouth {
  readonly scale: number;
  readonly vowels: Readonly<VowelWeights>;
  /**
   * 这样开合时嘴真正张开多少，和平时（没底形、全是あ）比：scale × Σ 份额 × 那个元音在这个模型上张开多少。
   * 说话时永远 ≥ knobs.flapFloor（不够时把份额挪回あ）。
   */
  readonly open: number;
  /** The floor moved shares back to あ this frame (the biased vowels alone would have parted the lips less than flapFloor). */
  readonly floored: boolean;
}

/** 一个闭嘴类形态等着开始时，这一帧的世界。 */
export interface ClosedMouthWorld {
  /** 带保持的"她在说话"（SpeechOwner：断口 < 0.4 秒算同一句）。开着时从不开始。 */
  readonly held: boolean;
  /** 朗读关着时，气泡里这句话还没显示完（句子中间）。 */
  readonly sentenceOpen: boolean;
  /** 别的门（摸她、手选表情、上一个形态还没收……）都放行。 */
  readonly free: boolean;
}
