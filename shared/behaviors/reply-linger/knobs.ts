/**
 * 功能：回复说完以后，气泡留多久（写死规则清单 #5）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 留多久 = 读得完（可读下限）+ 读完以后再留一会儿（余韵），再夹在 range 里：
 *  - 读得完：noticeMs +（最后一个气泡的字数 ÷ charsPerSecond）。只看最后一个气泡：前面的气泡在她说话时已经按 R27
 *    的节奏一个个停过了，收起时你还没读的是刚冒出来的那一个。心情和性格从不把它缩短。
 *  - 余韵：每次在 after 的范围里随机取一个点，再 × 心情、这会儿的倾向、角色卡性格、困不困（乘起来夹在 lean 里），
 *    最后一句在问你或把话递给你时再 × waiting。所以同一个场景两次只差余韵里的那一点随机，不会乱。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';

export interface ReplyLingerKnobs {
  readonly range: readonly [number, number];
  readonly readable: { readonly charsPerSecond: number; readonly noticeMs: number; readonly lettersPerChar: number };
  readonly after: readonly [number, number];
  readonly waiting: { readonly question: number; readonly handover: number };
  readonly mood: Readonly<Partial<Record<MoodLabel, number>>>;
  readonly now: Readonly<Partial<Record<MoodTendency | 'wistful', number>>>;
  readonly personality: Readonly<Partial<Record<MoodTendency, number>>>;
  readonly drowsy: number;
  readonly lean: readonly [number, number];
}

export const REPLY_LINGER_KNOBS: ReplyLingerKnobs = Object.freeze<ReplyLingerKnobs>({
  // 用户可能怎么说：一大段话还没看完就收了／气泡挂得太久了，一直挡着她
  // 怎么调：最短、最长各留多少毫秒（[2500, 20000] 是 2.5～20 秒）。太长的段落会被截在最长，全文可以点"查看完整回复"
  range: [2500, 20000],

  readable: {
    // 用户可能怎么说：我读字慢，一段话还没读完就没了／我读得快，气泡留得太久了
    // 怎么调：每秒按几个字算"读得完"。6 = 每分钟 360 字：普通成年人默读中文大约每分钟 300～500 字，桌面上的气泡是瞥一眼读的，取偏慢的一端。调小 = 留得更久
    charsPerSecond: 6,
    // 用户可能怎么说：我还没注意到气泡，它就收了
    // 怎么调：注意到气泡、把眼睛移过去要多久（毫秒），算在"读得完"里
    noticeMs: 1000,
    // 用户可能怎么说：她说英文的时候气泡留得太久了／太短了
    // 怎么调：几个英文字母或数字算一个字（3 = 一个英文单词大约像读 1～2 个汉字）。汉字、假名、表情各算 1 个字，标点和空格不算
    lettersPerChar: 3,
  },

  // 用户可能怎么说：气泡留久一点／气泡收得太突然，读完马上就没了／读完以后还挂着太久
  // 怎么调：读完以后再留多久（毫秒），每次在这两个数之间随机取一点：两个数一起加大 = 每个气泡都多留一会儿；两个数差得越多，同一句话两次留的时间差得越多
  after: [1500, 2300],

  waiting: {
    // 用户可能怎么说：她问我的时候别那么快收／她问我话时气泡挂太久了
    // 怎么调：最后一句在问你（以"？"或"吗"结尾）时，余韵 × 这个数
    question: 2.2,
    // 用户可能怎么说：她说"你呢""跟我说说"的时候，我还没想好怎么回气泡就没了
    // 怎么调：最后一句把话递给你（"你呢""跟我说说""告诉我""轮到你了"……）时，余韵 × 这个数
    handover: 1.9,
  },

  // 用户可能怎么说：她想我、黏我的时候说完话气泡收得太快了／她兴奋的时候气泡收得太慢了
  // 怎么调：她此刻的心情让余韵 × 多少（没写的心情 = 1）。大于 1 多留一会儿，小于 1 收得早一点
  mood: { close: 1.2, longing: 1.25, concerned: 1.2, 'tense-expectation': 1.2, sad: 1.15, disappointed: 1.1, relieved: 1.05,
    content: 1.05, happy: 0.92, excited: 0.85, upset: 0.9 },

  // 用户可能怎么说：她正黏着我的时候气泡多留一会儿／她调皮的时候收得利落点
  // 怎么调：她这会儿的情绪倾向（心情快照里最强的那一项）让余韵 × 多少
  now: { close: 1.15, wistful: 1.15, playful: 0.92 },

  // 用户可能怎么说：这个角色很黏人，说完话却收得很干脆，不像她
  // 怎么调：角色卡性格（weights，1 = 一般）的影响有多大：倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.75～1.35；负数 = 反过来
  personality: { close: 0.15, playful: -0.06 },

  // 用户可能怎么说：她困的时候说话气泡收得太快／太慢
  // 怎么调：她有点困、困了的时候余韵 × 多少
  drowsy: 1.1,

  // 用户可能怎么说：心情对气泡留多久的影响太大了／看不出心情的影响
  // 怎么调：心情、倾向、性格、困不困乘起来，最多把余韵缩到多少、放大到多少（不含"在等你回话"）
  lean: [0.7, 1.6],
});
