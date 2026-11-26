/**
 * 功能：她睡下去的样子：困了的小动作、拿枕头躺下或趴桌、睡着时的呼吸和小动作、"zzz…"小气泡、醒来、睡着时被摸被叫、睡相（I-078 第 1～3 步）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法（什么时候困、什么时候睡着，仍由 shared/mood/fatigue.ts 的困意 A、疲倦 F 决定；这里只管"她怎么做"）：
 *  - 时间都是"平均值"，每次按她的性格和此刻的激素再上下浮动（对数正态，见 shared/behaviors/sleep-body/schedule.ts），不会每次一样。
 *  - 激素读法（-1～1，按角色自己的基线归一化）：N 高 → 更难入睡（坐下前拖得更久、更常点头惊醒）；C 高 → 睡不踏实（小动作更多、
 *    更常换手）；E 高 → 睡得安稳（小动作更少、呼吸更慢）；O 高 → 抱枕头更紧、脸更朝你；A 高 → 睡得更沉（小动作更少）。
 *  - 这些都只是第一版的试用值，没在真机上看过。
 */

type Range = readonly [number, number];

export interface SleepBodyKnobs {
  readonly drowsy: {
    readonly meanGapS: number;
    readonly lightMeanGapS: number;
    readonly minGapS: number;
    readonly spread: number;
    readonly yawn: number;
    readonly rub: number;
    readonly nod: number;
  };
  readonly settle: {
    readonly sitDelayS: Range;
    readonly sitDwellS: Range;
    readonly sitSeconds: number;
    readonly lieSeconds: number;
    readonly riseSeconds: number;
    readonly stretchAfterS: number;
  };
  readonly asleep: {
    readonly meanGapS: number;
    readonly minGapS: number;
    readonly spread: number;
    readonly breathRateHz: number;
    readonly breathDepth: number;
  };
  readonly murmur: {
    readonly meanGapS: number;
    readonly minGapS: number;
    readonly firstAfterS: number;
    readonly words: readonly string[];
  };
  readonly prefer: {
    readonly lie: number;
    readonly desk: number;
    readonly sit: number;
    readonly variety: number;
  };
  readonly framing: {
    readonly headMargin: number;
    readonly marginEnough: number;
    readonly bodyWeight: number;
    readonly slideCost: number;
    readonly maxSlide: number;
    readonly switchBetter: number;
    readonly switchAfterS: number;
  };
  readonly props: {
    readonly fadeSeconds: number;
    readonly softness: number;
    readonly rebound: number;
  };
  readonly touch: {
    readonly refractoryS: number;
    readonly humChance: number;
    readonly humMinGapS: number;
    readonly humWords: readonly string[];
    readonly liftMore: number;
    readonly rubAfterWoken: number;
  };
  readonly habit: {
    readonly restlessGap: number;
    readonly calmGap: number;
    readonly sizeRange: number;
    readonly turn: number;
    readonly hug: number;
    readonly armOut: number;
    readonly calmFewer: number;
  };
}

export const SLEEP_BODY_KNOBS: SleepBodyKnobs = Object.freeze<SleepBodyKnobs>({
  // 困了但还没睡着（"有点困""困"）时的小动作：小哈欠、揉眼睛、点头打瞌睡又惊醒。
  drowsy: {
    // 用户可能怎么说：她困的时候小动作太多了，一直在打哈欠揉眼睛／困了却什么都不做
    // 怎么调：明显困的时候，两个小动作之间平均隔多少秒；越大越少
    meanGapS: 45,
    // 用户可能怎么说：她只是有点困就一直打哈欠
    // 怎么调：只是有点困的时候平均隔多少秒；越大越少
    lightMeanGapS: 120,
    // 用户可能怎么说：她刚打完哈欠马上又揉眼睛，太密了
    // 怎么调：两个小动作之间至少隔多少秒
    minGapS: 18,
    // 用户可能怎么说：她的小动作间隔太规律了，像定时器
    // 怎么调：间隔的随机程度（对数正态的宽度，0.2 很规律，0.8 很随意）
    spread: 0.55,
    // 用户可能怎么说：她老是打哈欠／怎么从来不打哈欠
    // 怎么调：小哈欠的分量（和下面两个比，越大越常是它）
    yawn: 1,
    // 用户可能怎么说：她揉眼睛太多了／想多看她揉眼睛
    // 怎么调：揉眼睛的分量
    rub: 0.8,
    // 用户可能怎么说：她点头打瞌睡又惊醒太多了
    // 怎么调：点头惊醒的分量（N 高时会再多一些）
    nod: 0.9,
  },
  // 入睡的过程：坐下（跪坐）→ 拿出枕头躺下，或者趴到小桌上。困意进入"将睡未睡"那 30 秒里完成。
  settle: {
    // 用户可能怎么说：她一进入快睡着就马上坐下了，太快／坐下之前拖太久
    // 怎么调：进入"将睡未睡"后，过多少秒开始坐下（最少～最多，秒；N 高时偏向最多）
    sitDelayS: [1.5, 6],
    // 用户可能怎么说：她坐下以后马上就躺了／坐着发呆太久才躺
    // 怎么调：坐稳以后过多少秒开始躺下或趴下（最少～最多，秒）
    sitDwellS: [2, 6],
    // 用户可能怎么说：她坐下太快、像摔下去／坐下太慢
    // 怎么调：从站着到跪坐大约多少秒
    sitSeconds: 3.2,
    // 用户可能怎么说：她躺下、趴下太快／太慢
    // 怎么调：从跪坐到躺好或趴好大约多少秒（E 高更慢，C 高更快）
    lieSeconds: 4.2,
    // 用户可能怎么说：她醒了起身太快／太慢
    // 怎么调：从睡姿起身到站好大约多少秒
    riseSeconds: 3.6,
    // 用户可能怎么说：她醒来站好之后伸懒腰太早／太晚
    // 怎么调：站起来之后过多少秒伸懒腰
    stretchAfterS: 0.6,
  },
  // 睡着时：呼吸和偶尔的小动作（蹭蹭枕头、换个手、叹口气、缩一缩）。
  asleep: {
    // 用户可能怎么说：她睡着了还动来动去／睡着像个雕像
    // 怎么调：两个小动作之间平均隔多少秒（C 高更常动，E 高、A 高更少）
    meanGapS: 80,
    // 用户可能怎么说：她睡着时刚动完又动
    // 怎么调：两个小动作之间至少隔多少秒
    minGapS: 25,
    // 用户可能怎么说：她睡着的小动作太规律
    // 怎么调：间隔的随机程度（0.2 很规律，0.8 很随意）
    spread: 0.6,
    // 用户可能怎么说：她睡着时呼吸太快／太慢
    // 怎么调：每秒几次呼吸（0.22 ≈ 每分钟 13 次；E 高、A 高时再慢一点）
    breathRateHz: 0.22,
    // 用户可能怎么说：看不出她在呼吸／呼吸起伏太大
    // 怎么调：胸口和肩膀随呼吸起伏的幅度（弧度）
    breathDepth: 0.022,
  },
  // 睡着时偶尔冒一个不出声的小气泡"zzz…"。
  murmur: {
    // 用户可能怎么说：她睡着冒 zzz 太频繁了／从来没见她冒 zzz
    // 怎么调：两个小气泡之间平均隔多少秒
    meanGapS: 330,
    // 用户可能怎么说：zzz 刚冒完又冒
    // 怎么调：两个小气泡之间至少隔多少秒
    minGapS: 150,
    // 用户可能怎么说：她刚睡着就冒 zzz，太刻意
    // 怎么调：睡着以后至少过多少秒才可能冒第一个
    firstAfterS: 60,
    // 用户可能怎么说：zzz 的样子太单调／不喜欢某一个
    // 怎么调：可能出现的文字（每次随机挑一个，不和上一次一样）
    words: ['zzz…', 'Zzz…', '…zz', '唔…zzz', '呼…zzz', '嗯…'],
  },
  // 睡姿的偏好：镜头放得下的前提下，按这些分量和她的性格挑。
  prefer: {
    // 用户可能怎么说：想多看她枕着枕头躺着睡
    // 怎么调：侧躺枕枕头的基础偏好（O 高时再加一点）
    lie: 0.5,
    // 用户可能怎么说：想多看她趴在小桌上睡
    // 怎么调：趴桌睡的基础偏好
    desk: 0.42,
    // 用户可能怎么说：她怎么总是坐着打盹
    // 怎么调：坐着打盹的偏好（只在躺和趴都放不进镜头时才该用到，所以很小）
    sit: 0.05,
    // 用户可能怎么说：她每次都用同一个睡姿
    // 怎么调：换个和上次不一样的睡姿的加分
    variety: 0.12,
  },
  // 按镜头挑睡姿：头必须完整在画面里，还要留边；从不动你的镜头，只挪她自己。
  framing: {
    // 用户可能怎么说：她睡着时头太贴窗口边了
    // 怎么调：头（含头发）到窗口边至少留多少（半个窗口的比例，0.06 ≈ 窗口宽的 3%）
    headMargin: 0.06,
    // 用户可能怎么说：（一般不用调）
    // 怎么调：留边超过多少就不再加分
    marginEnough: 0.25,
    // 用户可能怎么说：她睡着时身体大半在画面外
    // 怎么调：身体在画面里的比例的加分权重
    bodyWeight: 0.35,
    // 用户可能怎么说：她躺下时往旁边挪得太多
    // 怎么调：往旁边挪的扣分（每挪一个身高扣多少）
    slideCost: 0.6,
    // 用户可能怎么说：她为了躺进画面挪得太远
    // 怎么调：最多往旁边挪多少（身高的比例）
    maxSlide: 0.35,
    // 用户可能怎么说：我稍微动一下镜头她就换睡姿
    // 怎么调：另一个睡姿要好多少分才换（只在当前睡姿还放得下时才看这个）
    switchBetter: 0.3,
    // 用户可能怎么说：镜头动了她过了好久才换姿势
    // 怎么调：另一个睡姿要一直更好多少秒才换
    switchAfterS: 2,
  },
  // 枕头和小白桌。
  props: {
    // 用户可能怎么说：枕头和桌子出现、消失得太突然
    // 怎么调：枕头和桌子淡入淡出用多少秒
    fadeSeconds: 1.2,
    // 用户可能怎么说：枕头看起来太硬／太软
    // 怎么调：头压进枕头的深度（头半径的比例）
    softness: 0.28,
    // 用户可能怎么说：枕头回弹太慢／像果冻一样晃
    // 怎么调：枕头回弹的弹性（越大越快回去，太大会晃）
    rebound: 9,
  },
  // 第 2 步：睡着时被摸、被叫。被摸：眼皮动一下、往枕头里蹭（趴桌时头在手臂上转一下），偶尔小声哼一下，又睡回同一个姿势。
  touch: {
    // 用户可能怎么说：我连着摸她，她每次都蹭一下，太机械
    // 怎么调：两次"被摸到时的小反应"之间至少隔多少秒
    refractoryS: 4,
    // 用户可能怎么说：摸她睡觉时她老哼／从来不哼
    // 怎么调：被摸时冒一个不出声的"嗯…"小气泡的机会（0～1）
    humChance: 0.15,
    // 用户可能怎么说：她被摸时哼得太密
    // 怎么调：哼一下和上一个小气泡（含 zzz）之间至少隔多少秒
    humMinGapS: 120,
    // 用户可能怎么说：她哼的字太单调／不喜欢某一个
    // 怎么调：被摸时可能哼的字（随机挑一个，不和上一次一样）
    humWords: ['嗯…', '唔…', '嗯~', '唔嗯…'],
    // 用户可能怎么说：跟她说话时她头抬得太少／太多
    // 怎么调：和她说话把她叫得越醒，头从枕头上多抬多少（0 不加；0.5 = 最多再抬一半）
    liftMore: 0.5,
    // 用户可能怎么说：被叫醒以后她不揉眼睛／老揉
    // 怎么调：没睡够被叫醒、站起来后揉一下眼睛的机会（自然醒是一半）
    rubAfterWoken: 0.85,
  },
  // 第 3 步：睡相（角色卡上的性格，安安静静 ↔ 爱翻身、抱枕头）。卡上不填就是中间，和第 1 步一模一样。激素照旧起作用：
  // C 高更不踏实，E 高更安稳，O 高抱枕头更紧。
  habit: {
    // 用户可能怎么说：睡相差的角色动得还不够多／太多了
    // 怎么调：睡相最差时，睡着时小动作的平均间隔乘多少（越小越频繁）
    restlessGap: 0.55,
    // 用户可能怎么说：睡相好的角色还是动得太多
    // 怎么调：睡相最好时，平均间隔乘多少（越大越安静）
    calmGap: 1.7,
    // 用户可能怎么说：睡相差的角色动作幅度不够大／睡相好的还是动得太大
    // 怎么调：小动作幅度随睡相变化多少（0.5：最好时一半大，最差时一倍半）
    sizeRange: 0.5,
    // 用户可能怎么说：想多看她翻身
    // 怎么调：睡相差的那头"翻个身"的分量（中间是 0）
    turn: 0.9,
    // 用户可能怎么说：想多看她抱紧枕头
    // 怎么调：睡相差的那头"抱紧枕头"的分量（O 高时再加）
    hug: 0.8,
    // 用户可能怎么说：想多看她把手伸出来
    // 怎么调：睡相差的那头"把手伸出来"的分量
    armOut: 0.7,
    // 用户可能怎么说：睡相好的角色还是常常换手、缩腿
    // 怎么调：睡相最好时，换手和缩腿的分量剩多少（0～1）
    calmFewer: 0.4,
  },
});
