/**
 * 功能：本机姿势的几个新用处（I-189：你转身走开时她先停下朗读、侧过脸说话不算插她的话、点头摇头当回答、瘫坐或离屏太近、
 * 盯着屏幕很久、连续久坐、画面里好像还有一个人；记录 docs/claude/2026-11-22-i189-pose-uses.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：全部只用本机姿势信号（「姿势识别（本机）」开着才有；17 个身体点、朝向、坐站、动作大小、画面里几个人），不发图，
 * 不调 Claude。所以瘫坐、盯屏、久坐、两个人都只是
 * 交给她的信息（走 I-188 的时刻和总闸，或者放进她下一轮的资料），她自己决定理不理、怎么理；转身停朗读、侧脸不算插话、点头当
 * 回答是程序怎么处理你的输入。
 * 这些都只是试用值，没在真人画面上调过。
 */

export interface PoseUsesKnobs {
  readonly attention: {
    readonly sureConfidence: number; readonly towardConfidence: number; readonly gapMs: number; readonly minFrames: number;
    readonly freshMs: number; readonly absentFreshMs: number;
  };
  readonly readPause: { readonly awaySeconds: number; readonly resumeDelayMs: number; readonly endAfterSeconds: number };
  readonly bargeHold: { readonly turnedMs: number };
  readonly nod: {
    readonly windowSeconds: number; readonly step: number; readonly nodSwings: number; readonly shakeSwings: number;
    readonly nodRange: number; readonly shakeRange: number; readonly crossRatio: number; readonly spanMs: number; readonly minShoulder: number;
    readonly facingConfidence: number; readonly maxBodyMove: number; readonly quietAfterMs: number;
  };
  readonly posture: {
    readonly confidence: number; readonly slumpMinutes: number; readonly slumpShare: number; readonly windowMinutes: number;
    readonly closeShoulderShare: number; readonly closeMinutes: number; readonly perDay: number; readonly cooldownMinutes: number;
  };
  readonly staring: {
    readonly minutes: number; readonly stillEnergy: number; readonly towardConfidence: number; readonly glanceSeconds: number;
    readonly awaySeconds: number; readonly perDay: number;
  };
  readonly sitting: { readonly firstMinutes: number; readonly againMinutes: number; readonly standSeconds: number; readonly breakMinutes: number };
  readonly people: { readonly sustainSeconds: number; readonly endMinutes: number };
}

export const POSE_USES_KNOBS: PoseUsesKnobs = Object.freeze<PoseUsesKnobs>({
  attention: {
    // 用户可能怎么说：要多有把握才算"你转开了"（太容易误判就调大）
    // 怎么调：0～1，朝向的把握；只有到这个数，转开才会停朗读、才不算插话
    sureConfidence: 0.6,
    // 用户可能怎么说：要多有把握才算"你又朝着屏幕了"
    // 怎么调：0～1
    towardConfidence: 0.4,
    // 用户可能怎么说：中间夹着一两帧看不清时，转开还算不算在继续
    // 怎么调：毫秒；看不清的帧短于这个不打断，"一帧拿不准"永远不会让她停
    gapMs: 700,
    // 用户可能怎么说：至少要几帧都看清你转开了才算
    minFrames: 3,
    // 用户可能怎么说：姿势信号多久没来就当"不知道"（不知道时什么都不做）
    // 怎么调：毫秒
    freshMs: 3_000,
    // 用户可能怎么说：画面里没人时，信号多久没来就当"不知道"
    // 怎么调：毫秒；没人时信号本来两秒才来一次
    absentFreshMs: 5_000,
  },
  readPause: {
    // 用户可能怎么说：我转身或走开多久，她才停下朗读
    // 怎么调：秒；停在一句说完的地方，气泡留着
    awaySeconds: 2,
    // 用户可能怎么说：我转回来后她隔多久接着念
    // 怎么调：毫秒
    resumeDelayMs: 500,
    // 用户可能怎么说：我走开多久她就不等了，后面的话只留在气泡里不念了
    // 怎么调：秒
    endAfterSeconds: 90,
  },
  bargeHold: {
    // 用户可能怎么说：通话里我侧过脸多久，开口就不算插她的话
    // 怎么调：毫秒
    turnedMs: 500,
  },
  nod: {
    // 用户可能怎么说：她问完一句"要不要……？"之后多久内点头摇头还算回答
    // 怎么调：秒；从她这句说完、念完起算，她还在念时不算（2026-11-24 收紧：8 秒 → 5 秒，念着时也不算）
    windowSeconds: 5,
    // 用户可能怎么说：点头摇头一下要动多大才算一次来回
    // 怎么调：按肩宽算的比例；越大越要用力点（0.06 → 0.08）
    step: 0.08,
    // 用户可能怎么说：点头要来回几下才算
    // 怎么调：单程数，不是来回数；2 = 点一下，4 = 连点两下（2026-11-24 起要连点两下）
    nodSwings: 4,
    // 用户可能怎么说：摇头要来回几下才算
    // 怎么调：单程数；4 = 左右各两次（2026-11-24：3 → 4）
    shakeSwings: 4,
    // 用户可能怎么说：点头时鼻子上下至少动多少
    // 怎么调：按肩宽算的比例
    nodRange: 0.2,
    // 用户可能怎么说：摇头时鼻子左右至少动多少
    // 怎么调：按肩宽算的比例
    shakeRange: 0.22,
    // 用户可能怎么说：点头时左右晃得太多就不算点头（反过来摇头也一样）
    // 怎么调：0～1；另一个方向的幅度要小于这个比例
    crossRatio: 0.4,
    // 用户可能怎么说：一次点头或摇头最多看多长一段
    // 怎么调：毫秒；连点两下要在这么长的时间里做完（1800 → 1500）
    spanMs: 1_500,
    // 用户可能怎么说：人在画面里太小（离得太远）时不看点头
    // 怎么调：肩宽占画面宽的比例
    minShoulder: 0.08,
    // 用户可能怎么说：点头摇头要多正对着屏幕才算（斜着脸、低头看键盘都不算）
    // 怎么调：0～1，朝向的把握；原来用的是 0.4，现在要 0.6
    facingConfidence: 0.6,
    // 用户可能怎么说：身子晃得多大就不算点头摇头（在椅子上挪、往前凑、转身）
    // 怎么调：按肩宽算的比例；两肩中点这一小段时间里移动超过它，就当整个人在动
    maxBodyMove: 0.3,
    // 用户可能怎么说：我刚敲完字或刚说完话，多久之内不认点头
    // 怎么调：毫秒；打字、通话时本来就不认，这是放开后再等的时间
    quietAfterMs: 1_500,
  },
  posture: {
    // 用户可能怎么说：要多有把握才算"瘫坐着"
    // 怎么调：0～1
    confidence: 0.5,
    // 用户可能怎么说：瘫坐多久才告诉她
    // 怎么调：分钟
    slumpMinutes: 20,
    // 用户可能怎么说：这段时间里大部分时候都瘫着才算（中间坐直一下不算打断）
    // 怎么调：0～1
    slumpShare: 0.8,
    // 用户可能怎么说：瘫坐按最近多长一段时间算
    // 怎么调：分钟；要比 slumpMinutes 长
    windowMinutes: 25,
    // 用户可能怎么说：肩膀在画面里多宽就算离屏幕太近
    // 怎么调：肩宽占画面宽的比例
    closeShoulderShare: 0.45,
    // 用户可能怎么说：离屏幕很近多久才告诉她
    // 怎么调：分钟
    closeMinutes: 5,
    // 用户可能怎么说：坐姿的事一天最多告诉她几次
    perDay: 2,
    // 用户可能怎么说：告诉过她一次坐姿的事，多久以后才会再告诉
    // 怎么调：分钟
    cooldownMinutes: 180,
  },
  staring: {
    // 用户可能怎么说：盯着屏幕多久没怎么动才告诉她
    // 怎么调：分钟
    minutes: 40,
    // 用户可能怎么说：动作多小才算"没怎么动"
    // 怎么调：0～1，姿势信号里的动作大小
    stillEnergy: 0.15,
    // 用户可能怎么说：要多有把握才算"朝着屏幕"
    // 怎么调：0～1
    towardConfidence: 0.4,
    // 用户可能怎么说：中间瞄一眼别处多久不算打断"盯着屏幕"
    // 怎么调：秒
    glanceSeconds: 15,
    // 用户可能怎么说：盯了很久之后，把视线移开多久也告诉她
    // 怎么调：秒
    awaySeconds: 20,
    // 用户可能怎么说：盯屏幕的事一天最多告诉她几次
    perDay: 2,
  },
  sitting: {
    // 用户可能怎么说：连续坐多久没起身才告诉她
    // 怎么调：分钟
    firstMinutes: 60,
    // 用户可能怎么说：告诉过一次后，连续坐到多久再告诉她一次
    // 怎么调：分钟（从这次坐下算）
    againMinutes: 150,
    // 用户可能怎么说：站起来多久才算起身了一次
    // 怎么调：秒
    standSeconds: 5,
    // 用户可能怎么说：离开画面多久也算起身了一次
    // 怎么调：分钟
    breakMinutes: 2,
  },
  people: {
    // 用户可能怎么说：画面里要连续多久都有两个人，才把这件事告诉她
    // 怎么调：秒
    sustainSeconds: 10,
    // 用户可能怎么说：另一个人离开多久才算走了（再出现算新的一次）
    // 怎么调：分钟
    endMinutes: 2,
  },
});
