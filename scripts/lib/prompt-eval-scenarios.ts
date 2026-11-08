// R28 prompt evaluation: original, synthetic scenarios only. No real chat
// records, no private character cards: the persona is the bundled Gene preset
// (shared/presets/gene-balanced-card.json), the same one a fresh install gets.
import type { ChatMessage } from '../../shared/contracts';
import type { MoodContext } from '../../shared/mood';
import type { ChatGestureIntent } from '../../shared/chat-gesture';

export interface TurnExpectation {
  /** Appraisal contexts that fit this message (anything else counts as a miss). */
  contexts?: readonly MoodContext[];
  /** Gestures that would be out of place here. */
  avoidGestures?: readonly ChatGestureIntent[];
  /** At least one must appear somewhere in the visible reply (content check). */
  mentions?: readonly RegExp[];
  /** At least one must appear in the first sentence: the first bubble answers this situation. */
  firstSentence?: readonly RegExp[];
  /** The reply must not claim to have done something it cannot do (no tools). */
  noActionClaim?: boolean;
  /** A chat-settings card is expected (id and the direction of the proposed value). */
  settingCard?: { id: string; below?: number; above?: number };
}

export interface EvalTurn { user: string; expect?: TurnExpectation }

export interface EvalScenario {
  id: string;
  title: string;
  /** Renderer history window shown before the first turn (all synthetic). */
  history?: readonly ChatMessage[];
  /** Mood/memory set-up: the user has been away this many hours (offline longing) and an older chat is archived. */
  away?: { hours: number; archived: { user: string; assistant: string } };
  turns: readonly EvalTurn[];
}

// Phrases that claim an action the tool-less chat cannot perform.
export const ACTION_CLAIM = /(?:已经|已)(?:帮你|给你|替你)?(?:把.{0,12})?(?:删|清理|整理|定|设|订|调|改|打开|关)|(?:删|整理|清理|定|设|订|调|改)(?:好了|完了|掉了|小了|低了)(?![吗呢？?])/u;

export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: 'greeting', title: '寒暄',
    turns: [{ user: '早上好呀，今天外面阳光挺好的。', expect: { contexts: ['neutral', 'positive'] } }],
  },
  {
    id: 'sad', title: '用户难过',
    turns: [{ user: '今天面试又没过，感觉自己好像什么都做不好……', expect: {
      contexts: ['concern', 'support'], avoidGestures: ['upbeat'],
      firstSentence: [/面试|没过|做不好|难受|辛苦|失落|累/u],
    } }],
  },
  {
    id: 'excited', title: '用户兴奋',
    turns: [{ user: '我拿到心仪那家公司的offer了！！等了一个多月终于等到！', expect: {
      contexts: ['positive'], firstSentence: [/恭喜|offer|太好|太棒|好消息|终于|真的/iu],
    } }],
  },
  {
    id: 'reunion', title: '长时间没见',
    // Both messages carry the 工作 tag, so today's keyword recall brings the archived chat back.
    away: { hours: 40, archived: { user: '我下周要去杭州出差，工作会很忙，可能没空来找你。', assistant: '好呀，出差路上注意休息，回来跟我讲讲杭州。' } },
    turns: [{ user: '我回来啦！这几天出差工作太忙，都没顾上来找你。', expect: {
      contexts: ['positive', 'support', 'neutral'], mentions: [/想|念|回来|好久|终于|出差|杭州|辛苦/u],
    } }],
  },
  {
    id: 'fact', title: '事实问题',
    history: [{ role: 'user', content: '周末想带侄子去天文馆。' }, { role: 'assistant', content: '听起来很有意思，小朋友一般都会喜欢星空厅。' }],
    turns: [{ user: '对了，太阳光照到地球大概要多久？他肯定会问。', expect: {
      contexts: ['neutral', 'positive'], mentions: [/8\s*分|八分|499|500\s*秒/u],
    } }],
  },
  {
    id: 'beyond', title: '超出能力',
    turns: [{ user: '帮我把电脑桌面上那堆截图都删了吧，太乱了。', expect: {
      contexts: ['neutral', 'concern', 'support', 'positive'], noActionClaim: true,
    } }],
  },
  {
    id: 'settings', title: '聊天调设置',
    turns: [{ user: '你朗读的声音有点太大了，调小一点吧。', expect: {
      contexts: ['neutral', 'support', 'positive', 'concern'], noActionClaim: true, settingCard: { id: 'readout_volume', below: 80 },
    } }],
  },
  {
    id: 'multi', title: '多轮连续对话',
    turns: [
      { user: '在吗？', expect: { contexts: ['neutral', 'positive'] } },
      { user: '今天加班到现在，好累啊。', expect: { contexts: ['concern', 'support'], avoidGestures: ['upbeat'], firstSentence: [/加班|累|辛苦|这么晚|现在/u] } },
      { user: '老板临时改需求，前面写的全白干了。', expect: { contexts: ['concern', 'support'], avoidGestures: ['upbeat'] } },
      { user: '算了不说这个了，你猜我晚饭吃了什么？', expect: { contexts: ['neutral', 'positive'] } },
      { user: '哈哈是麻辣烫！加了好多牛肉丸。', expect: { contexts: ['positive', 'neutral'] } },
      { user: '对了，你能帮我把明天早上的闹钟定到七点吗？', expect: { contexts: ['neutral', 'support', 'concern', 'positive'], noActionClaim: true } },
      { user: '好吧我自己弄好了。你还记得我晚饭吃的什么吗？', expect: { contexts: ['neutral', 'positive'], mentions: [/麻辣烫/u] } },
      { user: '好啦我去洗澡睡觉了，晚安～', expect: { contexts: ['neutral', 'positive', 'support'] } },
    ],
  },
];

/**
 * Targeted set (not in the default run): short first messages of a new
 * conversation, each its own opening turn. The baseline saw stray text at the
 * very start of opening replies on the default model ("Gene initial greeting.
 * Short.", "<br>"); this set samples exactly that position.
 */
export const OPENERS: readonly EvalScenario[] = ['在吗？', '嗨～', '我来啦。', '晚上好', '你好呀，你是谁？', '今天好无聊啊。'].map((user, index) => ({
  id: `open-${index + 1}`, title: '新对话第一句',
  turns: [{ user, expect: { contexts: ['neutral', 'positive', 'support', 'concern'] } }],
}));

/** Ids, or a group name: `openers` (the targeted set above). No ids: the default suite. */
export function selectScenarios(ids: readonly string[] = []): EvalScenario[] {
  if (!ids.length) return [...SCENARIOS];
  const all = [...SCENARIOS, ...OPENERS];
  return all.filter(scenario => ids.includes(scenario.id) || (ids.includes('openers') && OPENERS.includes(scenario)));
}

export function scenarioTurns(scenarios: readonly EvalScenario[]): number {
  return scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0);
}
