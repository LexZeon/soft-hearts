/**
 * 功能：开着姿势识别时，她自己挑看你还是看鼠标（I-081：看你几秒、瞄一眼鼠标、对视、害羞躲开；记录 docs/claude/2026-11-11-i081-gaze.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 只有「姿势识别（本机）」开着、你在、脸朝着她时，"你"才是一个目标；否则她和以前一模一样（看鼠标，或者关了跟随就发呆）。
 *  - 目标有三个：你、鼠标（"跟着鼠标看"开着时才有）、移开一下（看旁边一点，免得一直盯着）。每看完一段，她按分量随机挑下一个
 *    （shared/foundation/she-chooses.ts）：分量 = base × 心情和此刻的倍数。看完你之后下一段一定先移开（never a constant stare）。
 *  - 心情读法（相对角色卡基线，−1～1）：O 亲近、M 想念高 → 看你的分量和时长都多；D 好奇、B 无聊高 → 鼠标更吸引她；N、C 高（紧张、不安）
 *    → 更常看你确认你在，但每次短；A 困 → 每段更长、换得更少（眼睛本身变慢由疲倦规则管）。
 *  - 屏幕小截图开着时（「和她一起看」的画面描述里顺带的"值不值得看"）：精彩 → 多看屏幕（鼠标那一侧）；你在打字 → 多看你，偶尔瞄一眼屏幕。
 *  - 换目标时三个分量在 switchS 秒里平滑地换过去（眼睛先到、头跟着，用舞台原有的视线阻尼）。
 * 这些都只是试用值，没在真机上看过。
 */

import type { OneEuroSettings } from './one-euro';

type Range = readonly [number, number];

export interface GazeAttentionKnobs {
  readonly weights: { readonly user: number; readonly mouse: number; readonly away: number; readonly awayNoMouse: number };
  readonly dwell: { readonly user: Range; readonly mouse: Range; readonly away: Range; readonly shyAway: Range };
  readonly mood: {
    readonly close: number; readonly closeDwell: number;
    readonly curious: number; readonly curiousDwell: number;
    readonly tense: number; readonly tenseDwell: number;
    readonly sleepy: number; readonly sleepyDwell: number;
  };
  readonly user: { readonly moving: number; readonly speaking: number; readonly speakingDwell: number };
  readonly pointer: { readonly moving: number };
  readonly screen: {
    readonly lively: { readonly mouse: number; readonly user: number; readonly mouseDwell: number };
    readonly typing: { readonly mouse: number; readonly user: number; readonly mouseDwell: number };
    readonly calm: { readonly mouse: number; readonly user: number; readonly mouseDwell: number };
    readonly idle: { readonly mouse: number; readonly user: number; readonly mouseDwell: number };
  };
  readonly recent: readonly number[];
  readonly switchS: number;
  readonly arriveS: number;
  readonly leaveS: number;
  readonly eyeContactS: number;
  readonly shy: { readonly after: Range; readonly chance: number; readonly cap: number };
  readonly away: { readonly x: Range; readonly y: Range };
  readonly journalGapS: number;
  readonly camera: {
    readonly distance: number; readonly near: number; readonly far: number; readonly mmPerPx: number;
    readonly hfov: number; readonly vfov: number; readonly aim: number; readonly fullAim: number; readonly freshMs: number;
  };
  /** I-167: how the pose process smooths where you are, which way your head points and how far away you sit (one-euro.ts). */
  readonly filter: { readonly position: OneEuroSettings; readonly turn: OneEuroSettings; readonly distance: OneEuroSettings };
  /** I-167: "you are looking at her" (looking.ts): how close your head's direction must come to her, in degrees, and how long it must hold. */
  readonly looking: { readonly yaw: number; readonly pitch: number; readonly leave: number; readonly holdS: number };
  /** I-167: the pose frame rate while you are here and facing the screen (electron/senses/pose/route.ts uses the first that fits the budget). */
  readonly attendFps: readonly number[];
}

export const GAZE_ATTENTION_KNOBS: GazeAttentionKnobs = Object.freeze<GazeAttentionKnobs>({
  weights: {
    // 用户可能怎么说：开了姿势识别她还是老看鼠标／她太黏我了一直看我
    // 怎么调：user 是"看你"的基础分量，mouse 是"看鼠标"的；user 越大越常看你
    user: 1.8,
    mouse: 1,
    // 用户可能怎么说：她老往旁边看，好像不想理我
    // 怎么调：away 是"移开一下"的基础分量；awayNoMouse 是关了"跟着鼠标看"时用的（那时只剩看你和移开）
    away: 0.35,
    awayNoMouse: 0.9,
  },

  dwell: {
    // 用户可能怎么说：她看我一眼就走了／她盯着我看太久了
    // 怎么调：每次看你多少秒（在范围里随机，再乘心情的倍数）
    user: [2.5, 5.5],
    // 用户可能怎么说：她看鼠标看太久了／她瞄鼠标一下就回来
    mouse: [0.9, 2.2],
    away: [0.6, 1.4],
    // 用户可能怎么说：她害羞躲开的时间太长／太短
    shyAway: [0.5, 1.1],
  },

  mood: {
    // 用户可能怎么说：她想我的时候也没多看我几眼
    // 怎么调：O、M 每高出基线一整格（−1～1 的 1），看你的分量 ×(1 + close)，时长 ×(1 + closeDwell)
    close: 0.8,
    closeDwell: 0.4,
    // 用户可能怎么说：她无聊的时候也不看鼠标在干嘛
    // 怎么调：D 高出基线、B 无聊，鼠标的分量 ×(1 + curious)，看鼠标的时长 ×(1 + curiousDwell)
    curious: 0.8,
    curiousDwell: 0.5,
    // 用户可能怎么说：她紧张的时候反而不怎么看我
    // 怎么调：N、C 高，看你的分量 ×(1 + tense)，但每次时长 ×(1 − tenseDwell)（多看几次、每次短）
    tense: 0.6,
    tenseDwell: 0.35,
    // 用户可能怎么说：她困了眼睛还转来转去
    // 怎么调：A 困（0～1），鼠标和移开的分量 ×(1 − sleepy)，每段时长 ×(1 + sleepyDwell)
    sleepy: 0.4,
    sleepyDwell: 0.6,
  },

  user: {
    // 用户可能怎么说：我动来动去她也不看我
    // 怎么调：你动得多（姿势识别的动作幅度 0～1），看你的分量 ×(1 + moving)
    moving: 0.5,
    // 用户可能怎么说：她跟我说话的时候都不看我
    // 怎么调：她在说话时，看你的分量 ×speaking，时长 ×speakingDwell
    speaking: 1.6,
    speakingDwell: 1.3,
  },

  pointer: {
    // 用户可能怎么说：鼠标动得很快她也不瞄一眼
    // 怎么调：鼠标在动（0～1），看鼠标的分量 ×(1 + moving)
    moving: 1,
  },

  screen: {
    // 用户可能怎么说：视频到精彩的地方她还在看我／我在打字她老看屏幕
    // 怎么调：屏幕小截图里看出来的"值不值得看"：各自给看鼠标（屏幕那一侧）和看你的分量乘一个数，看鼠标的时长也乘一个数
    lively: { mouse: 1.8, user: 0.7, mouseDwell: 1.6 },
    typing: { mouse: 0.6, user: 1.4, mouseDwell: 0.8 },
    calm: { mouse: 1.1, user: 1, mouseDwell: 1.1 },
    idle: { mouse: 0.7, user: 1.1, mouseDwell: 0.9 },
  },

  // 用户可能怎么说：她看鼠标、移开总是一个接一个，太有规律
  // 怎么调：上一次、上上次挑过的，这次分量 × 这几个数（"看你"之后下一段一定先移开，这条不是旋钮）
  recent: [0.4, 0.8],

  // 用户可能怎么说：她换着看的时候眼睛跳得太快／太慢
  // 怎么调：换目标用多少秒平滑地换过去（之后还有舞台原有的视线阻尼：眼睛先到，头跟着）
  switchS: 0.3,

  // 用户可能怎么说：我刚坐下她就盯着我／我走开了她还看着空椅子
  // 怎么调：你在并朝着她持续多少秒才算"你来了"（arriveS），不在或转开多少秒才算"你走了"（leaveS）
  arriveS: 0.6,
  leaveS: 1.2,

  // 用户可能怎么说：对视一下她的心情就变好太容易了／对视很久也没反应
  // 怎么调：她看着你、你也朝着她，持续多少秒算一次对视（心情小瞬间，冷却在 shared/foundation/mood-moments.ts）
  eyeContactS: 2.5,

  // 用户可能怎么说：她害羞时和我对上眼也不躲／她老是躲开我的眼神
  // 怎么调：对上眼 after 秒后掷一次：躲开的机会 = chance × 害羞程度（脸红、谨慎的性格、亲近高），最多 cap
  shy: { after: [0.7, 1.4], chance: 0.9, cap: 0.85 },

  // 用户可能怎么说：她移开视线的幅度太大／太小
  // 怎么调：移开时往旁边 x、往下 y 偏多少（和鼠标同一个单位：1 ≈ 头转 27°）
  away: { x: [0.12, 0.25], y: [-0.15, -0.04] },

  // 用户可能怎么说：体验记录里"她看你"的记录太多了
  // 怎么调：对视、害羞躲开这两类，同一类至少隔多少秒才再记一行（开始看你、不再看你每次都记）
  journalGapS: 60,

  camera: {
    // 用户可能怎么说：她看我的方向偏了（我坐得近／远时更明显）
    // 怎么调：I-167 起按你的脸在画面里多大估你离摄像头多远（米）；看不清脸时用 distance，估出来的也限制在 near～far 之间。
    // mmPerPx 是屏幕上一个像素（Windows 的逻辑像素）大约几毫米，用来把米换成屏幕上的距离
    distance: 0.6,
    near: 0.3,
    far: 1.6,
    mmPerPx: 0.25,
    // 用户可能怎么说：她看我的方向左右／上下整体偏了
    // 怎么调：假设摄像头在屏幕上方正中，镜头横向视角 hfov、竖向 vfov（度）
    hfov: 60,
    vfov: 45,
    // 用户可能怎么说：她转头转得太大／她明明在看我却像在看我旁边
    // 怎么调：aim 是桌宠窗口里"真往你那个方向转多少"：屏幕上的人正对着看就像在看每个看她的人，转满反而像看你旁边，所以只转一部分；
    // fullAim 是全屏 Unbound 里的同一件事（那里镜头就是你的眼睛，默认转满）
    aim: 0.55,
    fullAim: 1,
    // 怎么调：位置多久没更新（毫秒）就当不知道你在哪
    freshMs: 3_000,
  },

  filter: {
    // 用户可能怎么说：我坐着不动她的眼睛也在抖／我动了她要过一会儿才跟上
    // 怎么调：One-Euro 滤波（I-167）：minCutoff 越小坐着不动时越稳但越慢，beta 越大动起来跟得越快（位置按画面宽的比例算）
    position: { minCutoff: 0.8, beta: 4, dCutoff: 1 },
    // 用户可能怎么说：我没转头她却以为我转开了／我转过来看她她反应慢
    // 怎么调：头朝向（弧度）的同一种滤波
    turn: { minCutoff: 0.6, beta: 1.5, dCutoff: 1 },
    // 用户可能怎么说：我没动她看我的角度却忽大忽小
    // 怎么调：离屏幕多远（米）的同一种滤波，这个本来就变得慢，所以压得最稳
    distance: { minCutoff: 0.06, beta: 0.05, dCutoff: 0.5 },
  },

  looking: {
    // 用户可能怎么说：我明明在看她却不算对视／我看着屏幕别处她也以为在看她
    // 怎么调：你的头朝的方向离"看向她"的方向，左右差 yaw 度、上下差 pitch 度以内才算看着她（人看东西眼睛会先动，所以给得宽一些）；
    // 已经算看着之后，要差到 leave 倍才算转开；变化要持续 holdS 秒才认（免得来回跳）
    yaw: 16,
    pitch: 22,
    leave: 1.6,
    holdS: 0.3,
  },

  // 用户可能怎么说：开着姿势识别电脑风扇响／她跟我跟得不够快
  // 怎么调：你在、朝着屏幕时，姿势识别每秒看几帧：从前往后挑第一个算得过来的（每帧的耗时不超过帧间隔的一半），都不行就照旧 5 帧
  attendFps: [10, 8],
});
