// keeps going or says so (续).
// The facts she is given when the share was lost, and when her window was away and came back. Facts only:
// what ended, when, why in plain words, how long. No suggested wording, no instruction, no "不要/别". What she says about it, if anything, is hers.
// Pure: no clock, no Electron. Never a title, a path or any of what was on the screen.
import type { WatchLostWhy, WatchNotResumedWhy } from '../../../shared/senses';

/** Plain words for how long (whole minutes; under one minute says so). */
export function spanWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到一分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** A local clock time, "14:32". */
export function clockWords(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const LOST_WORDS: Readonly<Record<WatchLostWhy, string>> = {
  'capture-lost': '屏幕画面连着取不到（共享的开关没有被他关）',
  'source-gone': '共享的那个窗口或屏幕不在了（共享的开关没有被他关）',
  unexplained: '没有哪一处说得出原因（不是他关的）',
};
const NOT_RESUMED_WORDS: Readonly<Record<WatchNotResumedWhy, string>> = {
  'turned-off': '这期间他把一起看或屏幕共享关了',
  'screen-gone': '屏幕共享已经不开着了',
  'not-allowed': '台词那一路现在开不起来',
  changed: '这期间换了角色或对话',
};

export interface LossFacts { cause: WatchLostWhy; at: number; lastedMs: number }
/** The facts of a lost share, for her one immediate turn (and her next turn when that one could not be said). */
export function lossFacts(loss: LossFacts): string {
  const lasted = loss.lastedMs >= 1_000 ? `这次一起看一共看了 ${spanWords(loss.lastedMs)}。` : '';
  return `一起看屏幕在 ${clockWords(loss.at)} 断了，原因：${LOST_WORDS[loss.cause]}。${lasted}`.trim();
}

export interface AwayFacts { awayMs: number; resumed: boolean; notResumed?: WatchNotResumedWhy }
/** The facts of her window being minimized and back, for her next turn (no call of its own). */
export function awayFacts(away: AwayFacts): string {
  const span = spanWords(away.awayMs);
  if (away.resumed) return `你的窗口最小化了 ${span}，这段时间一起看停着；窗口回来时一起看自己接着开了。`;
  const why = away.notResumed ? NOT_RESUMED_WORDS[away.notResumed] : '没有接着开';
  return `你的窗口最小化了 ${span}，这段时间一起看停着；窗口回来时一起看没有接着开（${why}）。`;
}

/** A block of facts as the chat turn takes it (one header, then the lines). */
export function factsBlock(lines: readonly string[]): string {
  if (!lines.length) return '';
  return ['【一起看的事实】（应用给你的事实，不是他说的话）', ...lines.map(line => `- ${line}`)].join('\n');
}

export interface LossPromptInput { persona: string; language?: string; mood?: string; recentChat?: string; facts: string; relaxed?: boolean }
/**
 * Her one immediate turn: who she is, how she feels, what the two of them talked about lately, the facts. The model says what it wants,
 * or nothing: how much and whether is hers. Only the answer's shape is asked for.
 */
export function lossPrompt(input: LossPromptInput): string {
  const person = input.relaxed === true ? '这个人' : '他';
  return [
    input.persona.trim(),
    (input.language ?? '').trim(),
    (input.mood ?? '').trim(),
    (input.recentChat ?? '').trim(),
    ['【此刻】', `你和${person}一起看屏幕的事有了变化（应用给的事实，不是${person}说的话）：`, `<watch-facts>\n${input.facts.replace(/[<>]/gu, '')}\n</watch-facts>`].join('\n'),
    ['【怎么说】', '- 说不说、说多少、怎么说，都由你定；不想说时 text 留空。', '- 不提应用、截图、转写、权限或任何内部数值。',
      '只输出一个 JSON 对象，只有 text 一个字段，不想说时是 {"text":""}。不要加其他字段、解释或代码块。'].join('\n'),
  ].filter(Boolean).join('\n\n');
}
