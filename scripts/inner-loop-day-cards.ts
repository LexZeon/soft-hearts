// L1 inner loop: the two cards and the synthetic idle timeline of the measured day
// (docs/claude/2026-11-02-inner-loop.md). Gene is the preinstalled card; "Momo" is synthetic.
import definition from '../shared/presets/gene-balanced-card.json';
import { compileCharacterPersona, type CharacterTextDraft } from '../shared/character-cards';
import { DEFAULT_FATIGUE_PARAMETERS, type FatigueParameters } from '../shared/fatigue';
import { validateMoodParameters, type MoodParameters } from '../shared/mood';
import type { DayCard, IdleBlock } from './lib/inner-loop-day';

const MINUTE = 60_000;
const gene = definition.card as unknown as CharacterTextDraft & { mood: { parameters: MoodParameters } };

export const GENE_DAY_CARD: DayCard = {
  id: 'gene',
  persona: compileCharacterPersona(gene),
  parameters: validateMoodParameters(gene.mood.parameters),
};

const slowParameters = structuredClone(GENE_DAY_CARD.parameters);
// Slower: boredom grows half as fast after a longer grace, higher thresholds, rarer and fewer turns.
slowParameters.boredom = { graceMs: 8 * MINUTE, perMinute: 1.2, lookAt: 35, motionAt: 60, speechAt: 85 };
slowParameters.frequency = { motionIntervalMs: 10 * MINUTE, speechIntervalMs: 60 * MINUTE, speechPerHour: 1, speechWithoutReply: 1 };
slowParameters.weights = { playful: 0.6, close: 1.2, comfortable: 1.4, cautious: 1 };
slowParameters.intensity = { ...slowParameters.intensity, playful: 30, text: 40 };
/** More easily tired: a stronger body clock and an earlier light-drowsy threshold (night window ≈ 21:14–08:46). */
const tiredFatigue: FatigueParameters = { ...DEFAULT_FATIGUE_PARAMETERS, clockWeight: 0.16, lightEnter: 0.34, wakeTauMs: 14 * 3_600_000 };

export const SLOW_TIRED_CARD: DayCard = {
  id: 'momo',
  persona: compileCharacterPersona({
    name: 'Momo',
    description: '合成测试卡：慢热、容易犯困的室友型伙伴。',
    personality: '慢吞吞、懒洋洋，说话简短，常常打哈欠；嘴上嫌麻烦，其实很在意对方有没有好好吃饭睡觉。喜欢安静地待着，不爱主动找话题。',
    scenario: '和用户住在同一个桌面上，大部分时间在发呆或打盹。',
    greeting: '……嗯？你来啦。',
    examples: '用户：我回来了。\nMomo：嗯……欢迎回来。吃饭了没？\n用户：今天好累。\nMomo：那就早点睡。我也困了。',
    systemPrompt: '你是合成测试角色 Momo。保持慢热、简短、容易犯困的说话方式，但关心用户的作息和吃饭。',
  } as CharacterTextDraft),
  parameters: validateMoodParameters(slowParameters),
  fatigue: tiredFatigue,
};

/**
 * Synthetic visible-and-idle day: the user interacts at each start, then leaves her alone.
 * Morning, afternoon and late evening; 3 × 90 min = 4.5 idle hours per card.
 */
export const DAY_BLOCKS: readonly IdleBlock[] = [
  { startMinute: 10 * 60, idleMinutes: 90 },
  { startMinute: 15 * 60, idleMinutes: 90 },
  { startMinute: 21 * 60, idleMinutes: 90 },
];
