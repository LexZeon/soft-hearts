/**
 * 功能：按部位分层混合（I-175）：她边念边做表情时嘴还跟着声音动；鼓腮这类闭嘴的挪到停顿；她能定一个表情挂多久
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 规则在 mouth.ts、closed-mouth.ts（"做多久"在 ../speech-beats/how-long.ts），方案 docs/claude/2026-11-22-i175-mixer-plan.md。都是第一版的试用值，还没在真机上看过。
 * "做多久"的保险上限（12 秒）是边说边演自己的 SPEECH_BEAT_TIMING.holdCapMs，不在这里另写一份。
 */
export interface PartMixKnobs {
  readonly mouthTalkThrough: number;
  readonly smileTalkThrough: number;
  readonly mouthBaseFull: number;
  readonly vowelLeanFull: number;
  readonly smileVowelMax: number;
  readonly puckerVowelMax: number;
  readonly flapFloor: number;
  readonly flapPeakGap: number;
  readonly flapGapCeiling: number;
  readonly talkEaseOmega: number;
  readonly closedMouthDropS: number;
  readonly closedMouthMaxWaitS: number;
  readonly sentenceOpenS: number;
  readonly lidCeiling: number;
  readonly headHeldRad: number;
  readonly idleUnderHeld: number;
}

export const PART_MIX_KNOBS: PartMixKnobs = Object.freeze<PartMixKnobs>({
  // 用户可能怎么说：她边念边撅嘴（或边笑）时嘴张得太大，表情看不出来／嘴几乎不动，像对不上声音
  // 怎么调：有表情的底形时，口型开合留几成（0.6 = 六成；1 = 和平时一样大；不要设成 0，嘴会不动）
  mouthTalkThrough: 0.6,

  // 用户可能怎么说：她笑着说话时嘴张得太小，像闭着嘴在动／笑着说话嘴张得太大，看不出在笑
  // 怎么调：底形只是笑（嘴角上扬）时，口型开合留几成（0.9 = 九成；笑不怕张嘴挡住，所以比撅嘴的 0.6 大）
  smileTalkThrough: 0.9,

  // 用户可能怎么说：她只带一点点笑意说话，嘴的开合就小了一截
  // 怎么调：底形多强算"满"（0..1）：底形到这里，口型才打满上面那个折扣；小于它按比例少打一点
  mouthBaseFull: 0.5,

  // 用户可能怎么说：她撅着嘴说话，嘴形还是"啊"的样子，不像嘟囔
  // 怎么调：底形多强时口型偏到跟着底形的元音的最多那一份（撅 → う，笑 → い）；小于它按比例少偏
  vowelLeanFull: 0.5,

  // 用户可能怎么说：她笑着说话嘴几乎不张开（い的口型在很多模型上只张开一条缝）
  // 怎么调：笑着说话时口型最多几成换成"い/え"，其余留在"あ"（0.2 = 两成；1 = 全换成い，嘴会几乎不张）
  smileVowelMax: 0.2,

  // 用户可能怎么说：她撅着嘴说话不像嘟囔，还是"啊"
  // 怎么调：撅着嘴说话时口型最多几成换成"う/お"（1 = 全换；嘴张不开时下面的"最小张开"会自动多给"あ"）
  puckerVowelMax: 1,

  // 用户可能怎么说：她说话时嘴只是在动，几乎没张开
  // 怎么调：不管带什么表情，说话时嘴张开的程度最少是平时（没表情时）的几成（0.35 = 三成半；按模型自己的嘴量出来的张开算）
  flapFloor: 0.35,

  // 用户可能怎么说：这个模型说话嘴张得太小（One 只张开一条线）／太大（Gene 有时张得太大）
  // 怎么调：说话时嘴张到最大时上下唇分开多少（按这个模型自己量：眼睛到嘴的距离算 1）；每个模型都往这里校
  flapPeakGap: 0.24,

  // 用户可能怎么说：她说话有时嘴张得特别大，像打哈欠
  // 怎么调：口型最多让上下唇分开多少（眼睛到嘴的距离算 1）；量不出来的模型不管
  flapGapCeiling: 0.3,

  // 用户可能怎么说：一开口她的表情里张着的嘴一下子就收了（或者收得太慢，和口型打架）
  // 怎么调：说话时表情里"张嘴"的那部分让给口型的快慢（越大越快；14 大约 0.3 秒到位）
  talkEaseOmega: 14,

  // 用户可能怎么说：我让她鼓腮，她念完话过了好久才突然鼓起来，和刚才的事对不上
  // 怎么调：鼓腮、吐舌这类闭嘴的，念完（或停下来）以后多少秒内还没轮到就不做了
  closedMouthDropS: 3,

  // 用户可能怎么说：她念一段很长的话，我早先让她鼓腮，念完她还鼓
  // 怎么调：闭嘴的形态从排上队起最多等多少秒（保险，平时用不到）
  closedMouthMaxWaitS: 90,

  // 用户可能怎么说：朗读关着时，她的回复早就显示完了，鼓腮却等了好一会儿才做
  // 怎么调：朗读关着时，气泡多少秒没再出字就算这句话说完了（最后一句没写句号时用）
  sentenceOpenS: 1.5,

  // 用户可能怎么说：她笑着眨眼的时候眼皮像压过头了，眼睛下面凹进去
  // 怎么调：笑眼和眨眼加起来最多闭到多少（1 = 正好闭上；小于 1 留一条缝）
  lidCeiling: 1,

  // 用户可能怎么说：她点头或歪头的时候，头还在自己晃，像晃着点头
  // 怎么调：点头、歪头这类有意的头部动作多大（弧度）算"占着头"；占满时待机自己的晃动收到下一条那么多
  headHeldRad: 0.08,

  // 用户可能怎么说：她一点头，头就僵住了，不自然
  // 怎么调：有意的头部动作占着头时，待机自己的头部晃动还留几成（0..1；0 = 完全不晃，不建议）
  idleUnderHeld: 0.3,
});

/** 有表情的底形时，口型开合留几成（I-175 第 2 条，先 0.6）。 */
export const MOUTH_TALK_THROUGH = PART_MIX_KNOBS.mouthTalkThrough;
