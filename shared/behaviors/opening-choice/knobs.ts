/**
 * 功能：她想找你说话时，这次说什么（写死规则清单 #10、#13）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 只管"这次说什么"，不管"什么时候说、说几次"：开口时机还是心情时钟给的那一个（无聊门槛、间隔、每小时上限、
 * 没人接就不再说都照角色卡），这里多不出一次机会。纪念邀请、深夜提醒休息、睡着不说都不在这里挑（见 interface.ts）。
 *
 * 读法：
 *  - base：基础分量；0 = 从不挑它。候选只有此刻真有的才进来（开关没开、不在停顿点、猜拳邀请条件不满足的，根本不出现）。
 *  - mood：她此刻的心情让分量 × 多少（没写的心情 = 1）。
 *  - now：她这会儿的情绪倾向（心情快照里真的够强的那一项：调皮、黏人、放松、拘谨、想念的余韵）× 多少。
 *  - personality：角色卡性格（weights，1 = 一般）的影响有多大：倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3。
 *  - moments：此刻的事（见下面 moments 的名字）× 多少。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';

export const OPENING_CANDIDATE_IDS = ['listen', 'screen', 'mood', 'play', 'quiet'] as const;
export type OpeningCandidateId = typeof OPENING_CANDIDATE_IDS[number];
export const OPENING_MOMENTS = ['need', 'bored', 'night', 'drowsy', 'unanswered', 'busy'] as const;
export type OpeningMoment = typeof OPENING_MOMENTS[number];

export interface OpeningCandidateKnob {
  readonly label: string;
  readonly base: number;
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly now?: Partial<Record<MoodTendency | 'wistful', number>>;
  readonly personality?: Partial<Record<MoodTendency, number>>;
  readonly moments?: Partial<Record<OpeningMoment, number>>;
}

export interface OpeningChoiceKnobs {
  readonly recent: readonly number[];
  readonly candidates: Readonly<Record<OpeningCandidateId, OpeningCandidateKnob>>;
  readonly moments: {
    readonly need: { readonly label: string };
    readonly bored: { readonly label: string; readonly from: number };
    readonly night: { readonly label: string };
    readonly drowsy: { readonly label: string };
    readonly unanswered: { readonly label: string };
    readonly busy: { readonly label: string };
  };
}

export const OPENING_CHOICE_KNOBS: OpeningChoiceKnobs = Object.freeze<OpeningChoiceKnobs>({
  // 用户可能怎么说：她老说同一类事（上次说屏幕这次还说屏幕）／她太刻意地换话题了
  // 怎么调：上一次、上上次挑过的那一类，分量 × 这几个数；越小越不重复，1 = 不管重复（从不完全排除）
  recent: [0.55, 0.8],

  candidates: {
    // 用户可能怎么说：她太爱聊歌了／一起听的时候她都不聊歌
    // 怎么调：太多/太少 → base（0 = 一起听时从不聊歌）；深夜、困的时候 → moments 里的 night、drowsy（现在约三分之一）
    listen: { label: '聊刚听完的', base: 1.4,
      mood: { happy: 1.3, excited: 1.4, content: 1.2, close: 1.2, relieved: 1.1, longing: 0.9, concerned: 0.8, disappointed: 0.7, sad: 0.7, upset: 0.5, 'tense-expectation': 0.8 },
      now: { playful: 1.2, close: 1.2, comfortable: 1.1 }, personality: { playful: 0.3, close: 0.2 }, moments: { night: 0.33, drowsy: 0.33, busy: 0.4 } },
    // 用户可能怎么说：她太爱说屏幕了／开着屏幕主动聊天她也很少说屏幕
    // 怎么调：太多/太少 → base（0 = 开着也从不说屏幕）；深夜、困的时候 → moments 里的 night、drowsy（现在约三分之一）
    screen: { label: '说说你屏幕上的', base: 1.4,
      mood: { happy: 1.2, excited: 1.3, content: 1.1, calm: 1.1, longing: 0.8, concerned: 0.9, disappointed: 0.7, sad: 0.6, upset: 0.5, 'tense-expectation': 0.8 },
      now: { playful: 1.3, comfortable: 1.1, cautious: 0.8 }, personality: { playful: 0.4 }, moments: { night: 0.33, drowsy: 0.33, busy: 0.3 } },
    // 用户可能怎么说：她老说自己的小情绪、撒娇太多了／她从来不说自己的事
    // 怎么调：太多/太少 → base；她正好有一件小需要时更想说多少 → moments.need
    mood: { label: '说说她的小情绪', base: 1,
      mood: { longing: 1.6, close: 1.3, sad: 1.2, disappointed: 1.1, relieved: 1.1, concerned: 1.1 },
      now: { close: 1.4, wistful: 1.5 }, personality: { close: 0.5 }, moments: { need: 1.8, bored: 1.2, busy: 0.75 } },
    // 用户可能怎么说：她老邀我玩猜拳／她都不邀我玩
    // 怎么调：太多/太少 → base（0 = 从不在这里邀你玩）；什么时候能邀（每天几次、刚玩过不邀）是猜拳自己的规则，不在这里
    play: { label: '邀你玩猜拳', base: 0.7,
      mood: { happy: 1.4, excited: 1.5, content: 1.1, longing: 0.7, concerned: 0.5, 'tense-expectation': 0.6, disappointed: 0.4, sad: 0.3, upset: 0.2 },
      now: { playful: 1.5, cautious: 0.7 }, personality: { playful: 0.8 }, moments: { bored: 1.3, busy: 0.2 } },
    // 用户可能怎么说：她太安静了，到了想说话的时候老是不说／她太吵了，该多安静一点
    // 怎么调：太多/太少 → base；谨慎的卡更常不说 → personality.cautious；深夜、困了、上次想说话你没来 → moments
    quiet: { label: '这次不说', base: 0.45,
      mood: { upset: 1.8, sad: 1.5, disappointed: 1.5, concerned: 1.3, 'tense-expectation': 1.3, happy: 0.8, excited: 0.7 },
      now: { cautious: 1.5, comfortable: 1.2 }, personality: { cautious: 1 }, moments: { night: 2, drowsy: 2, unanswered: 1.4, busy: 3 } },
  },

  moments: {
    need: { label: '她正好有一件小需要' },
    // 用户可能怎么说：她才闲了一会儿就说自己无聊
    // 怎么调：无聊到多少（0～100）算"闲了很久"；开口时机本身要到卡上的说话门槛（默认 75）才有
    bored: { label: '闲了很久', from: 90 },
    night: { label: '深夜' },
    drowsy: { label: '有点困' },
    unanswered: { label: '上次想找你说话以后，你还没来过' },
    // 用户可能怎么说：我在专心做事的时候她还是来找我说话／我专心的时候她一句都不说了
    // 怎么调：各候选里的 moments.busy 倍数：想找你说话的几件 <1，"这次不要" >1；小情绪的倍数最大、再加上心情倍数，所以她很想你、有小情绪时仍然能开口
    busy: { label: '你在专心做事' },
  },
});
