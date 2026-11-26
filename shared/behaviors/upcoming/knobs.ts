/**
 * 功能：她记得你说过的计划，到时候问起（P-001 第 1 步：记住并让你看得见）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：只有"允许记录"开着时，才会有这张小清单。你说"明天下午面试"，笔记写好后，这里把时间词换算成一个"到时间"
 * （只说了哪天按 18 点，上午按 12 点，下午按 18 点，晚上按第二天早上，说了几点按那之后 2 小时）；到时间之后的三天内可以被问起，
 * 过了就悄悄过期。这些都只是试用值，没在真机上看过。
 */

export interface UpcomingKnobs {
  readonly due: {
    readonly dayOnlyHour: number;
    readonly morningHour: number;
    readonly noonHour: number;
    readonly afternoonHour: number;
    readonly nightNextMorningHour: number;
    readonly clockDelayMinutes: number;
  };
  readonly keep: {
    readonly expireDays: number;
    readonly purgeDays: number;
    readonly maxPerCharacter: number;
    readonly maxBlockedSegments: number;
  };
  readonly early: {
    readonly quietSeconds: number;
    readonly dailyCalls: number;
    readonly contextMessages: number;
    readonly maxMessages: number;
  };
  readonly ask: {
    readonly nightFrom: number;
    readonly nightTo: number;
    readonly restMinutes: readonly [number, number];
    readonly gapTurns: readonly [number, number];
    readonly holdMinutes: number;
  };
  readonly text: {
    readonly whatChars: number;
    readonly saidChars: number;
    readonly perNote: number;
  };
}

export const UPCOMING_KNOBS: UpcomingKnobs = Object.freeze<UpcomingKnobs>({
  due: {
    // 用户可能怎么说：我只说了"周五"，她周五一大早就问我了／等到太晚才问
    // 怎么调：只说了哪天、没说上午下午时，当天几点以后才算到时间（0～23）
    dayOnlyHour: 18,
    // 用户可能怎么说：我说"明天上午"的事，她中午还没到就来问
    // 怎么调：说了"上午"时，几点以后才算到时间
    morningHour: 12,
    // 用户可能怎么说：我说"中午"的事，她问得太早／太晚
    // 怎么调：说了"中午"时，几点以后才算到时间
    noonHour: 14,
    // 用户可能怎么说：我说"明天下午"的事，她下午还没过完就问了
    // 怎么调：说了"下午"时，几点以后才算到时间
    afternoonHour: 18,
    // 用户可能怎么说：我说"今晚"的事，她当晚就问了／第二天很晚才问
    // 怎么调：说了"晚上"时，算到第二天早上几点
    nightNextMorningHour: 8,
    // 用户可能怎么说：我说"3 点开会"，她 3 点刚过就问了／隔太久才问
    // 怎么调：说了具体几点时，在那之后过多少分钟才算到时间
    clockDelayMinutes: 120,
  },

  keep: {
    // 用户可能怎么说：这件事她早就不该问了，还留着／我隔了好几天才来，她就不问了
    // 怎么调：到时间以后，最多再等几天；没碰上机会就悄悄过期
    expireDays: 3,
    // 用户可能怎么说：问过的、过期的事一直留在清单里
    // 怎么调：问过或过期的事，几天后从清单里自动清掉
    purgeDays: 7,
    // 用户可能怎么说：她记的事太多了／太少了
    // 怎么调：每个角色最多记几件事；满了就不再往里加（不会挤掉旧的）
    maxPerCharacter: 20,
    // 用户可能怎么说：我删掉的事，下次整理笔记又冒出来了
    // 怎么调：最多记住多少段"删过的事来自哪段聊天"（这些段的笔记不再往清单里加）
    maxBlockedSegments: 200,
  },

  early: {
    // 用户可能怎么说：我说了明天面试，她要等好久才记下来／我还在说话她就去看了
    // 怎么调：你说了带时间的打算后，停手多少秒，她才先单独看一眼这几句、记下计划（不用等整段聊完）
    quietSeconds: 120,
    // 用户可能怎么说：这件"先记下"的小调用太多了（防止出错时一直调用的保险）
    // 怎么调：一天最多先看几次
    dailyCalls: 30,
    // 用户可能怎么说：先记的时候她看不懂我在说什么事（前面的话没带上）
    // 怎么调：先记时，除了你没看过的那几句，再带上前面几句话当背景
    contextMessages: 4,
    // 用户可能怎么说：先记的那一次读的话太多／太少
    // 怎么调：先记时一次最多交给她读几句话（含背景）
    maxMessages: 12,
  },

  ask: {
    // 用户可能怎么说：凌晨她还问我白天的事／她该问的时候不问
    // 怎么调：从几点到几点（本地时间，0～24，前闭后开）她不问起你的计划；两个数一样就是整天都可以问
    nightFrom: 0,
    nightTo: 6,
    // 用户可能怎么说：她一口气问了我好几件事／问完一件很久都不问下一件
    // 怎么调：问起一件事以后，过多少分钟才会问下一件（每次在这个范围里抽，不是固定的；来找她和她先开口共用）
    restMinutes: [30, 90] as readonly [number, number],
    // 怎么调：来找她时问起一件事以后，你们又聊了几轮，才会再带下一件（每次在这个范围里抽）
    gapTurns: [2, 5] as readonly [number, number],
    // 用户可能怎么说：我一说开头她就当我没说，下一轮又带着同一件事（防止同一轮重复带，几分钟后自动放掉）
    // 怎么调：这一轮带上的那一行，多少分钟没回复完就放回去
    holdMinutes: 10,
  },

  text: {
    // 用户可能怎么说：清单里这件事的字太长了
    // 怎么调：一件事的简写最多多少字（用笔记里的简写，不存你的原句）
    whatChars: 20,
    // 用户可能怎么说：时间词记得不对
    // 怎么调：你说的时间词最多留多少字（原样抄下来，不改）
    saidChars: 16,
    // 用户可能怎么说：我一段话里说了好几件事，她只记了一件
    // 怎么调：一段聊天的笔记里最多收几件事
    perNote: 3,
  },
});
