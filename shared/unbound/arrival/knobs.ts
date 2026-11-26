/**
 * 功能：全屏 Unbound 里"贴过来"的到达位置和停留（I-192；—要有停留，由她自己退开）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 规则在同一个文件夹（face.ts 脸停在镜头前多远、solve.ts 站哪和前倾多少、loop.ts 每帧把那个部位送到位置、hold.ts 停多久；什么输入能让她提前结束，统一在 shared/unbound/action-ends/）。
 * 这些都只是试用值，没在真机上看过。
 */
export interface ArrivalKnobs {
  readonly faceFill: number;
  readonly minFaceM: number;
  readonly kissYawDeg: number;
  readonly hugYawDeg: number;
  readonly minClearM: number;
  readonly hairSwingM: number;
  readonly holdMinS: number;
  readonly lookHoldS: number;
  readonly kissHoldS: number;
  readonly hugHoldS: number;
  readonly leanInHoldS: number;
  readonly holdCapS: number;
  readonly afterSpeechS: number;
  readonly closeHoldMinS: number;
  readonly kissEyesV: number;
  readonly kissMouthV: number;
  readonly hugEarU: number;
  readonly hugEarV: number;
  readonly hugHeadShare: number;
  readonly normalHeadShare: number;
  readonly stepHeadShare: number;
  readonly kissDipMaxM: number;
  readonly frameInset: number;
  readonly arriveWaitS: number;
  readonly peekEyes: number;
}

export const ARRIVAL_KNOBS: ArrivalKnobs = Object.freeze<ArrivalKnobs>({
  // 用户可能怎么说：亲亲、抱抱时她的脸凑得还不够近／太近了，只看得到半张脸
  // 怎么调：脸停住时，从眼睛上沿到嘴下面这一段占屏幕高度的几成（1 = 正好占满；越大越近，嘴和眼睛会先出画）。I-203 起只在不知道画面大小时用；平时亲亲看 kissEyesV / kissMouthV，抱抱看 hugHeadShare
  faceFill: 1.0,
  // 用户可能怎么说：小脸的模型贴得太近，身子都快贴到屏幕上了
  // 怎么调：不管脸多小，脸停住时离镜头至少多少米（和最初"凑近屏幕看看"差不多近：那时眼睛离镜头约 12 厘米）
  minFaceM: 0.15,
  // 用户可能怎么说：亲的时候头歪得太多／一点都没侧
  // 怎么调：亲亲停住时脸侧过去几度
  kissYawDeg: 8,
  // 用户可能怎么说：抱抱时脸没侧过去／侧得太多，连耳朵都看不到了
  // 怎么调：抱抱停住时脸朝外（画面右边）转过去几度（I-203 用户：抱抱头大概占比2/5右侧，脸测过去：镜头看到耳朵、脸颊、一只闭着的眼、一点嘴角）
  hugYawDeg: 75,
  // 用户可能怎么说：她贴过来时鼻子、刘海被镜头切掉了一块
  // 怎么调：她身上任何一处（鼻尖、刘海、头发、手）离镜头至少留多少米，到位置会穿就提前停
  minClearM: 0.04,
  // 用户可能怎么说：她停住时头发一甩就被镜头切进去了
  // 怎么调：再给头发往前甩留多少米
  hairSwingM: 0.025,
  // 用户可能怎么说：贴过来一下就走了，太短
  // 怎么调：凑近看、亲、抱至少停多少秒（心情、熟悉度、性格在上面加）
  holdMinS: 2,
  // 用户可能怎么说：凑近看你停得太短／太久
  // 怎么调：凑近看的基准停留秒数（再乘心情、熟悉度、性格，约 0.5～1.8 倍）
  lookHoldS: 3.5,
  // 用户可能怎么说：亲的那一下太短，看不清嘟嘴／亲太久了有点怪
  // 怎么调：亲亲的基准停留秒数（同上乘她的心情、熟悉度、性格）
  kissHoldS: 3,
  // 用户可能怎么说：抱抱太快就松开了／抱太久了
  // 怎么调：抱抱的基准停留秒数（同上）
  hugHoldS: 4.5,
  // 用户可能怎么说：聊天里她凑近一点马上又退回去了
  // 怎么调：回复里的"凑近一点"至少停多少秒（她这句还没说完就一直停着，到下面的上限为止）
  leanInHoldS: 3,
  // 用户可能怎么说：她贴过来停着不走，挡着我了
  // 怎么调：不管她在说什么，贴过来最多停多少秒就自己退开
  holdCapS: 12,
  // 用户可能怎么说：她说完话马上就退了，嘟嘴没看见
  // 怎么调：她停住时在说话，说完以后再停多少秒（嘟嘴只在不说话时出来）
  afterSpeechS: 1.6,
  // 用户可能怎么说：亲亲抱抱贴过来一下就走了／停得太久
  // 怎么调：亲亲、抱抱至少停多少秒（I-203，分镜画的是停 1.5 秒；停多久仍由她定，最多 holdCapS）
  closeHoldMinS: 1.5,
  // 用户可能怎么说：亲亲最近的时候眼睛太靠上／太靠下，看不到头发
  // 怎么调：亲亲停住时两只眼睛在画面里的高度（-1 = 底边，0 = 正中，1 = 顶边；分镜里在上部）
  kissEyesV: 0.53,
  // 用户可能怎么说：亲亲最近的时候嘴出画了／嘴太靠上
  // 怎么调：亲亲停住时嘴在画面里的高度（-1 = 底边；分镜里在下部）。和上一个一起定了她停多远：两个差得越多，她离得越近
  kissMouthV: -0.65,
  // 用户可能怎么说：抱抱时她的头太靠右／不够靠右
  // 怎么调：抱抱停住时镜头看到的那只耳朵在画面里横着的位置（0 = 正中，1 = 右边缘；用户的图里约在屏宽四分之三，即 0.5）
  hugEarU: 0.4,
  // 用户可能怎么说：抱抱时她的头太高／太低
  // 怎么调：那只耳朵在画面里的高度（0 = 正中，用户的图里在一半高）
  hugEarV: 0,
  // 用户可能怎么说：抱抱时她的头太大／太小
  // 怎么调：抱抱停住时她的头宽占屏幕宽的几成（用户：抱抱头大概占比2/5右侧）
  hugHeadShare: 0.4,
  // 用户可能怎么说：亲亲抱抱一开始她站得太远／太近
  // 怎么调：开始前她站在哪：头宽占屏幕宽的几成（分镜 01：约 1/5，居中）；退回来也回到这里
  normalHeadShare: 0.2,
  // 用户可能怎么说：她迈近的那一步太小／太大
  // 怎么调：迈近一步后头宽占屏宽的几成（分镜 02：约 2/5）——只用来量，不强推
  stepHeadShare: 0.4,
  // 用户可能怎么说：亲亲时画面忽然往下沉／亲亲最近时眼睛还是太靠下
  // 怎么调：亲亲时镜头（你的眼睛）最多往下降多少米，像你也凑过去迎她（近景镜头比她踮脚够得着的高度高，脸会偏下；只亲亲用，抱抱和小窗不动）
  kissDipMaxM: 0.06,
  // 用户可能怎么说：亲亲、抱抱停住时嘴（或一只眼睛）跑到画面外面去了
  // 怎么调：停住时眼睛和嘴离画面边缘至少留出半个画面的几成（她踮脚也够不着镜头的高度时，会停得稍远一点让眼睛和嘴都在画面里；0 = 贴着边）。I-203 起 0.06 → 0.15：亲亲最近时撅起的嘴不贴着下边缘
  frameInset: 0.15,
  // 用户可能怎么说：她凑过来以后愣了一下才停住／一直没停稳
  // 怎么调：前倾走完以后，最多再等几秒让脸真的到位（两眼和嘴进画面、不穿镜头）；等不到就算没做成：她退回来，不记成亲过／抱过（T-264），也不会定在那儿
  arriveWaitS: 2.5,
  // 用户可能怎么说：凑近看的时候只看到一只眼睛，想看到两只
  // 怎么调：凑近看停住时画面里放几只眼睛：1 = 一只眼睛贴满屏幕（I-104 你定的："整个屏幕差不多都是眼睛（一只）"），2 = 两只眼睛都在画面里（备选，没开）
  peekEyes: 1,
});

export const ARRIVAL_KNOB_RANGES = Object.freeze({
  faceFill: Object.freeze([0.5, 1.6] as const), minFaceM: Object.freeze([0.08, 0.4] as const), kissYawDeg: Object.freeze([0, 20] as const), hugYawDeg: Object.freeze([0, 85] as const),
  minClearM: Object.freeze([0.02, 0.15] as const), hairSwingM: Object.freeze([0, 0.08] as const), holdMinS: Object.freeze([0.5, 6] as const),
  lookHoldS: Object.freeze([1, 10] as const), kissHoldS: Object.freeze([1, 10] as const), hugHoldS: Object.freeze([1, 10] as const), leanInHoldS: Object.freeze([1, 10] as const),
  holdCapS: Object.freeze([3, 30] as const), afterSpeechS: Object.freeze([0, 5] as const), closeHoldMinS: Object.freeze([0.5, 6] as const),
  kissEyesV: Object.freeze([0, 0.9] as const), kissMouthV: Object.freeze([-0.95, 0] as const), hugEarU: Object.freeze([0, 0.95] as const), hugEarV: Object.freeze([-0.6, 0.6] as const),
  hugHeadShare: Object.freeze([0.15, 0.8] as const), normalHeadShare: Object.freeze([0.08, 0.4] as const), stepHeadShare: Object.freeze([0.15, 0.6] as const), kissDipMaxM: Object.freeze([0, 0.08] as const),
  frameInset: Object.freeze([0, 0.4] as const), arriveWaitS: Object.freeze([0.5, 6] as const),
  peekEyes: Object.freeze([1, 2] as const),
});
