/**
 * 功能：全屏 Unbound 里她知道自己大概站在哪、并能自己决定走去哪（I-193，2026-11-22 起：角色可以读自己现在的坐标，决定移动到哪里；
 * 11-23 早上定为她自己决定、最好清楚自己的大概方位：每轮告诉她一句大概方位的文字，不给数字；去哪由她在回复里写 go-left 这类标记决定）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 规则在同一个文件夹（words.ts 把位置说成话；go.ts 把"去哪"的词变成一个走得到的位置；gates.ts 走不走的门；seen.ts 你看到她露出多少）。
 * I-212：位置用"横向（占屏幕宽度）"和"多大（她整个人占屏幕可用高度的比例，
 * 去掉任务栏；1 = 从任务栏站到屏幕顶）"两个数，和 shared/unbound/screen-terms 一样；换成米只在那里做。原来的米数按"8 米 = 0.5"换算过来，
 * 在当初定这些数的笔记本上看起来和以前一样，在大屏幕上跟着变大、小屏幕上跟着变小。I-211 起每轮那句带上数字（离你约几米、你看到她是全身还是半身、横向百分比）。
 * 这些都只是试用值，没在真机上看过。
 */
export interface HerPositionKnobs {
  readonly leftUntil: number;
  readonly rightFrom: number;
  readonly edgeShare: number;
  readonly veryNearSize: number;
  readonly nearSize: number;
  readonly farSize: number;
  readonly floorSize: number;
  readonly leftMin: number;
  readonly leftMax: number;
  readonly rightMin: number;
  readonly rightMax: number;
  readonly middleMin: number;
  readonly middleMax: number;
  readonly cornerMin: number;
  readonly cornerMax: number;
  readonly cornerSizeMin: number;
  readonly cornerSizeMax: number;
  readonly nearStepMin: number;
  readonly nearStepMax: number;
  readonly farStepMin: number;
  readonly farStepMax: number;
  readonly nearestSize: number;
  readonly farthestSize: number;
  readonly besideMin: number;
  readonly besideMax: number;
  readonly sameSpot: number;
  readonly sameSize: number;
  readonly stayMinutesMin: number;
  readonly stayMinutesMax: number;
  readonly cursorFreshMs: number;
  readonly comeNearToPlace: boolean;
  readonly chosenSpotMinutes: number;
  readonly seenKneesFrom: number;
  readonly seenWaistFrom: number;
  readonly seenChestFrom: number;
  readonly seenFaceFrom: number;
  readonly seenFaceCloseBelow: number;
  readonly firstBandPosition: number;
}

export const HER_POSITION_KNOBS: HerPositionKnobs = Object.freeze<HerPositionKnobs>({
  // 用户可能怎么说：她明明在中间，却被说成偏左／偏右
  // 怎么调：横向（占屏幕宽度，0 = 最左，1 = 最右）小于这个算"偏左"
  leftUntil: 0.38,
  // 怎么调：横向大于这个算"偏右"；两个之间算"中间"
  rightFrom: 0.62,
  // 用户可能怎么说：她贴着边了却没说靠边／离边还挺远却说靠边
  // 怎么调：离左边或右边多近（占屏幕宽度）才算"靠着边缘"
  edgeShare: 0.14,
  // 用户可能怎么说：她凑得很近了，记录里却还写"比较近"
  // 怎么调：她占屏幕可用高度的比例到这么大算"几乎贴着屏幕"（1.2 = 比整个可用高度还高两成；以前的 3 米）
  veryNearSize: 1.2,
  // 用户可能怎么说：她明明离得挺近，记录里却写不远不近
  // 怎么调：占屏幕可用高度到这么大算"离用户比较近"（第一次出场是 0.5；以前的 6.6 米）
  nearSize: 0.6,
  // 怎么调：占屏幕可用高度小到这么小算"离用户比较远"（以前的 9.4 米）
  farSize: 0.43,
  // 用户可能怎么说：她站在任务栏上，却没说脚边是任务栏／凑近了脚沉到任务栏下面还说脚边是任务栏
  // 怎么调：没有画面读数时（只用于记录），占屏幕可用高度不超过这么大算脚踩在任务栏上沿那条线上（以前的 5 米）；每轮那句按真的取景算
  floorSize: 0.77,
  // 用户可能怎么说：她说"去左边"却走得太靠边／没走到左边
  // 怎么调："去左边"走到横向（占屏幕宽度）的哪一段里，在这一段里随机挑一点
  leftMin: 0.12,
  leftMax: 0.26,
  // 怎么调："去右边"的一段
  rightMin: 0.74,
  rightMax: 0.88,
  // 怎么调："到中间"的一段
  middleMin: 0.44,
  middleMax: 0.56,
  // 用户可能怎么说："去角落"没去到角落／去得太靠边被屏幕切掉
  // 怎么调："去角落"时离最近的左右边多近（横向，占屏幕宽度）
  cornerMin: 0.06,
  cornerMax: 0.12,
  // 用户可能怎么说："去角落"时她还是挺大／小得看不清
  // 怎么调："去角落"时她在屏幕上多大（占屏幕可用高度，在这一段里随机；角落是又远又靠边；以前的 10.4～11.6 米）
  cornerSizeMin: 0.352,
  cornerSizeMax: 0.39,
  // 用户可能怎么说："走近"一次走得太多／太少
  // 怎么调："走近"一次她在屏幕上变大到原来的几倍（在这个范围里随机；以前在 8 米处走 1.2～2.4 米）
  nearStepMin: 1.16,
  nearStepMax: 1.39,
  // 用户可能怎么说："走远"一次走得太多／太少
  // 怎么调："走远"一次她在屏幕上变小到原来的几倍（在这个范围里随机）
  farStepMin: 0.88,
  farStepMax: 0.78,
  // 用户可能怎么说：她说走近，却走到放不下全身、脚沉到任务栏下面
  // 怎么调："走近"一小步最多走到占屏幕可用高度这么大（再大就放不下全身；以前的 4.6 米）
  nearestSize: 0.83,
  // 怎么调："走远"最远走到占屏幕可用高度这么小（以前的 12 米；拉她远的下限是 0.33）
  farthestSize: 0.34,
  // 用户可能怎么说：她说到我鼠标旁边，却站在了鼠标正后面把它挡住／离得太远
  // 怎么调："到你鼠标旁边"站在鼠标横向位置的旁边多远（占屏幕宽度，在这个范围里随机，往空处多的那一边站）
  besideMin: 0.07,
  besideMax: 0.12,
  // 用户可能怎么说：她说去中间，其实已经在中间，却还迈了一步
  // 怎么调：目标离她现在的位置不到这么远（横向占屏幕宽度）、大小也差不到 sameSize，就当"已经在那儿"，不走
  sameSpot: 0.05,
  // 怎么调：大小差不到这么多（0.05 = 5%，约等于以前的 0.4 米）算同一个远近
  sameSize: 0.05,
  // 用户可能怎么说：她刚走到左边，过一会儿自己又走回去了
  // 怎么调：她按回复里写的走完以后，自己"换个地方站"至少等这么多分钟（在这个范围里随机，有精神的取短些）
  stayMinutesMin: 3,
  stayMinutesMax: 8,
  // 用户可能怎么说：她说到鼠标旁边，去的却是我很久以前放鼠标的地方
  // 怎么调：鼠标最后一次动过多久以内（毫秒）还算"知道鼠标在哪"；更久就不走（不去猜）
  cursorFreshMs: 120_000,
  // 用户可能怎么说：她说"走近"只挪了一小步／走近以后离我太近了
  // 怎么调：true = "走近"一次走到你设的默认位置那么大（没设就走到上半身入镜那么大），从不比那更近（更近是亲亲、抱抱的时刻）；false = 回到每次走一小步（nearStepMin～nearStepMax）
  comeNearToPlace: true,
  // 用户可能怎么说：我一忙她就从她自己选的地方走开了
  // 怎么调：她在回复里自己选了去哪（去左边、走近……）以后，这么多分钟里，程序自己的"换个地方站"（你在忙往后站、你停下往前站、你回来往前站、走开乱走）不把她从那儿挪走；睡意重时往角落、你拉她、玩游戏、她下一个去哪的词照旧；0 = 不留
  chosenSpotMinutes: 30,
  // 用户可能怎么说：她明明露出全身，却被告诉成膝盖以上／明明只到膝盖却说全身（I-211 每轮那句"用户看到的你是……"）
  // 怎么调：画面下沿切在她身高的多少以上算"膝盖以上"（0 = 脚底，1 = 头顶；更低算全身）
  seenKneesFrom: 0.04,
  // 怎么调：画面下沿切在她身高的多少以上算"半身（腰以上）"
  seenWaistFrom: 0.33,
  // 怎么调：画面下沿切在她身高的多少以上算"胸口以上"
  seenChestFrom: 0.6,
  // 怎么调：画面下沿切在她身高的多少以上算"只有脸"
  seenFaceFrom: 0.77,
  // 用户可能怎么说：她的脸都贴到屏幕上了，却只说"只有脸"
  // 怎么调：画面里露出的她不到身高的这么多（0.12 = 一成二，大约比一张脸还小）就说"脸贴得很近"
  seenFaceCloseBelow: 0.12,
  // 用户可能怎么说：她第一次出来太近／太远（晚："每个角色出来的默认位置是比较近的（半身以上）"）
  // 怎么调：没设默认位置、也没有上次的位置时，她出来的远近：落在"半身（腰以上）"这一档里的哪里（0 = 这一档最远的一头，露出得更多；1 = 最近的一头，快到胸口；0.5 = 中间）。按这块屏幕和她自己的身高算，高矮不同的模型露出的一样多
  firstBandPosition: 0.5,
});
