/**
 * 心情说明：三个会改她心情的模型
 * （Opus 回复尾注、反应判定 haiku、心情调整员 haiku）共用的**唯一**一份说明。
 *
 * - 四层：激素 D/O/E/N/C（+A 腺苷，困，由疲倦模型算，模型不调）；心情数值 B 无聊、M 想念（单独存在，模型不调，只当背景）；
 *   推导出来的心情名字；性格（角色卡的基线）。读数一律看相对基线。
 * - 组合成心情名字的门槛句子**从 shared/foundation/mood.ts 的 MOOD_LABEL_THRESHOLDS 生成**（getMoodSnapshot 读的就是它），改门槛这里跟着变。
 * - 两种写法：完整版给 haiku（系统提示词里，固定、可缓存）；精简版给 Opus 尾注（每轮都带，字数要少，首字 A/B 见记录）。
 *
 * 纯文本，没有模型调用、没有文件。改这里的字会改三个提示词：Opus 那一句改了要重做首字 A/B。
 */
import { MOOD_CHANNELS, MOOD_LABEL_THRESHOLDS, moodLevel, type MoodChannel, type MoodValues } from './mood';

type Thresholds = typeof MOOD_LABEL_THRESHOLDS;

/** 激素的名字和大致管什么（手册 handbook/how-we-work.md「心情相关的事，按激素和心情数值来想」）。 */
export const MOOD_HORMONES: Readonly<Record<MoodChannel, { readonly hormone: string; readonly short: string; readonly means: string }>> = Object.freeze({
  D: { hormone: '多巴胺', short: '期待', means: '奖励、期待与想去做：好事、新鲜事让它涨，落空让它降；和 E 一起高是开心，和 N 一起高是兴奋' },
  O: { hormone: '催产素', short: '亲近', means: '亲近与陪伴感：被关心、被惦记、和好让它涨，被冷落让它降' },
  E: { hormone: '内啡肽', short: '舒适', means: '舒缓、安心与满足：被安慰、被照顾让它涨，受惊、委屈让它降' },
  N: { hormone: '去甲肾上腺素', short: '唤醒', means: '被唤醒、警觉的程度，本身不分好坏：和 D 一起高是兴奋，和 C 一起高是紧张、担心，再加上 E 低、又有吓人的事就是害怕' },
  C: { hormone: '皮质醇', short: '压力', means: '压力与不安：被吓、被凶、吵架、被晾着让它涨，被安慰、道歉、和好让它降' },
});

/** 常见的事一般动哪几个数（方向，不是固定量；起伏大的性格动得多）。 */
export const MOOD_EVENT_GUIDE: readonly (readonly [string, string])[] = Object.freeze([
  ['被夸', 'D↑ O↑ E↑（害羞的人 N 也小涨）'],
  ['报喜', 'D↑ E↑，N 小涨'],
  ['被关心、被惦记', 'O↑ E↑ C↓'],
  ['被安慰、被哄', 'E↑ C↓，N 回落'],
  ['被逗、开玩笑', 'D↑ N 小涨；玩笑过头才 C↑'],
  ['道歉', 'C↓ O 小涨'],
  ['被晾着、被敷衍', 'D↓ O↓ C 小涨'],
  ['吵了一句、被凶', 'C↑ N↑ E↓ O↓'],
  ['她自己被吓一跳、听到吓到她的事（你自己被吓到、开玩笑说吓死了、讲别人或剧情里的害怕不算）', 'N↑ C↑ E↓（这时情境是 fright）'],
  ['用户说累、难过', '她会担心你：C 小涨 O↑，不是她自己受了打击'],
]);

const sign = (key: 'min' | 'max' | 'below') => (key === 'min' ? '≥' : key === 'max' ? '≤' : '<');
/** 一条门槛的白话：D≥60、E≥55 这样，顺序照常量里写的。 */
function rule(entry: Partial<Record<'min' | 'max' | 'below', Partial<Record<MoodChannel, number>>>>): string {
  const parts: string[] = [];
  for (const key of ['min', 'max', 'below'] as const)
    for (const [channel, value] of Object.entries(entry[key] ?? {})) parts.push(`${channel}${sign(key)}${value}`);
  return parts.join('、');
}

/** 组合成心情名字的规则（按程度），从 shared/foundation/mood.ts 的门槛生成；顺序 = 判定先后。 */
export function moodLabelRuleLines(t: Thresholds = MOOD_LABEL_THRESHOLDS): string[] {
  const tension = rule(t.tension);
  return [
    '正在担心用户的情境（concern）：担心',
    `不满：被冒犯（offense）且 ${tension}`,
    `害怕：刚有吓人的事（fright）且 ${rule(t.afraid)}；没有吓人的事就不算害怕`,
    `失落：有让她失望的事（disappointment）且 ${rule(t.disappointed)}`,
    `${tension}：积极情境里再有 ${rule(t.tenseExpectation)} 是紧张期待，否则是担心`,
    '久别重逢是释然；心情数值 M（想念）高是想念、伤感',
    `兴奋：积极情境里 ${rule(t.excited)}`,
    `愉快：积极情境里 ${rule(t.happy)}`,
    `亲近：${rule(t.close)}`,
    `满足：${rule(t.content)}`,
    '都不是：平静',
  ];
}

/** 完整版（给 haiku 的系统提示词；固定文字，可缓存）。 */
export function moodGuideFull(t: Thresholds = MOOD_LABEL_THRESHOLDS): string {
  return [
    '【她的心情是怎么构成的】',
    `1. 五个数是受激素启发的模拟通道（0～100，不是真实激素）：${MOOD_CHANNELS.map(c => `${c} ${MOOD_HORMONES[c].hormone}（${MOOD_HORMONES[c].short}）：${MOOD_HORMONES[c].means}`).join('；')}。`,
    '   还有 A 腺苷（困）由疲倦模型按时间算，你不调。',
    '2. 心情数值：B 无聊、M 想念，是激素表达不了的部分，单独存在、按时间和互动变，你不调，只当背景。',
    '3. 读数看相对她自己基线的"程度"：50 = 正好在基线；60 = 从基线往 100 走了五分之一；40 = 往 0 走了五分之一。基线是她的性格，不是要拉回 50。',
    `4. 几个数一起（按程度）才组成有名字的心情，按下面的顺序判：${moodLabelRuleLines(t).join('；')}。只加 O 不会让她开心；想让她开心要 D 和 E 一起动。`,
    `5. 常见的事一般动哪几个数：${MOOD_EVENT_GUIDE.map(([what, how]) => `${what} ${how}`).join('；')}。`,
    '6. 不做的事：不越过给你的上限；旧事、回忆不重发奖励；B、M、A 不归你调；没有真实发生的事就不动。',
  ].join('\n');
}

/** 精简版（Opus 回复尾注，每轮都带：字越少越好，改了要重做首字 A/B）。 */
export const MOOD_GUIDE_COMPACT = 'D多巴胺期待、O催产素亲近、E内啡肽舒适、N去甲肾上腺素唤醒（配D兴奋，配C紧张）、C皮质醇压力；吓到她用fright：N、C升，E降。';

/** 一行"现在多少/基线多少"（Opus 尾注用，D62/50 这样）。没有数就是空串。 */
export function moodNowCompact(values: MoodValues | null | undefined, baseline: MoodValues | null | undefined): string {
  if (!values || !baseline) return '';
  const parts = MOOD_CHANNELS.map(c => {
    const v = values[c], b = baseline[c];
    return Number.isFinite(v) && Number.isFinite(b) ? `${c}${Math.round(v)}/${Math.round(b)}` : null;
  });
  return parts.every(Boolean) ? `她现在（值/基线）：${parts.join(' ')}。` : '';
}

/** haiku 用的一行：每个数的值、基线和程度（门槛按程度判）。 */
export function moodNowFull(values: MoodValues, baseline: MoodValues, evidence = 1, words: Readonly<Record<MoodChannel, string>> | null = null): string {
  return MOOD_CHANNELS.map(c => `${words ? `${words[c]} ` : ''}${c} ${Math.round(values[c])}（基线 ${Math.round(baseline[c])}，程度 ${Math.round(moodLevel(values[c], baseline[c], evidence))}）`).join('、');
}
