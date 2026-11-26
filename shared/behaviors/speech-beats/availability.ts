/**
 * I-185 第 3 条：每一轮只说此刻用不了的动作标记。
 *
 * 固定的那句（choose.ts speechBeatSentence）照旧列全部的词和意思，每轮一字不变；这里只在它后面加一小句"这一轮用不了：……"
 * （或"这一轮只能用：……"，哪个字少用哪个；都能用时一个字都不加）。筛的只有两样：
 *  - 此刻能不能做：她睡着、没在屏幕上（全屏让给了别的全屏程序、桌宠藏起来）→ 都用不了；手被猜拳、递东西、牵手占着 → 用到手臂的词
 *    （hand-cheek、v、hug）；通话里 → 默认都能用（SPEECH_BEAT_CALL_WORDS 是空的；原来 kiss、hug 在通话里不走过来，后来改了）。小窗和全屏都能做每一个词（小窗里亲、抱是原地做）。
 *  - 这个模型做不做得出来（模型体检那张表）：没有手臂骨（"能做手势"没有或关了）→ 用到手臂的词。kiss 不按模型筛：没有嘟嘴形态的用
 *    "う"等替身（showcase-motion.ts 的映射），闭眼、前倾哪个模型都有。
 * 从不按她的性格、角色卡筛：她做不做、怎么做由她自己定。心情视图里带着卡的心情模板，这里只读它的"睡着"。
 * 纯的：不碰时钟、文件、模型。
 */
import { SPEECH_BEAT_WORDS, type SpeechBeatWord } from './interface';

/** Which stage she is on: the companion window (its Unbound engine or the old stage), or full-screen Unbound. */
export type SpeechBeatSurface = 'window' | 'full';
export interface SpeechBeatSituation {
  surface: SpeechBeatSurface;
  /** Her stage can be seen now (out in full-screen: always, I-199; the companion window not hidden). */
  shown: boolean;
  asleep: boolean;
  /** A game, an offer or her reach for your hand holds her arms. */
  armsHeld: boolean;
  inCall: boolean;
  /** What the current model can do (its capability table); null: not known yet (nothing is left out for it). */
  model: { arms: boolean } | null;
  /**
   * 2026-11-23 (handbook「提示不是锁」4: "她这一轮做不了的事，提前告诉她"): full-screen only, why her kiss and hug cannot
   * walk up right now, when that is already known as the turn starts: you are pulling her, a kiss / hug / look is still playing, you are typing.
   * Information only (the page still plays the lighter one). Absent or null: none. Never a cooldown: what she writes has none.
   */
  closeNow?: SpeechBeatCloseNow | null;
}
export const SPEECH_BEAT_CLOSE_NOW = ['pulled', 'busy', 'typing'] as const;
export type SpeechBeatCloseNow = (typeof SPEECH_BEAT_CLOSE_NOW)[number];
const CLOSE_NOW_WORDS: Readonly<Record<SpeechBeatCloseNow, string>> = Object.freeze({ pulled: '用户正拉着你', busy: '上一个凑近的动作还没做完', typing: '用户正在打字' });
/** The words that move her arms. */
export const SPEECH_BEAT_ARM_WORDS: readonly SpeechBeatWord[] = Object.freeze(['hand-cheek', 'v', 'hug']);
/**
 * The close-moment words a call leaves out. Empty since 2026-11-22: kiss and
 * hug are usable in a call (asleep, a game's arms, a cooldown… still gate them). To undo: put ['kiss', 'hug'] back here AND in
 * CHAT_CLOSE_CALL_BLOCKS (shared/unbound/close-moments/chat.ts): the two lists are one decision (the line she is told, and the host's answer).
 */
export const SPEECH_BEAT_CALL_WORDS: readonly SpeechBeatWord[] = Object.freeze([]);

/** The words she cannot use now (in vocabulary order). No situation: none. */
export function unavailableBeatWords(s: SpeechBeatSituation | null | undefined): SpeechBeatWord[] {
  if (!s) return [];
  if (!s.shown || s.asleep) return [...SPEECH_BEAT_WORDS];
  const out = new Set<SpeechBeatWord>();
  if (s.armsHeld) for (const word of SPEECH_BEAT_ARM_WORDS) out.add(word);
  if (s.model && !s.model.arms) for (const word of SPEECH_BEAT_ARM_WORDS) out.add(word);
  if (s.inCall) for (const word of SPEECH_BEAT_CALL_WORDS) out.add(word);
  if (s.closeNow && CLOSE_NOW_WORDS[s.closeNow]) { out.add('kiss'); out.add('hug'); }
  return SPEECH_BEAT_WORDS.filter(word => out.has(word));
}

/** The one short line after the fixed sentence ('' when every word can be used now). */
export function speechBeatAvailabilityLine(s: SpeechBeatSituation | null | undefined, offered: readonly SpeechBeatWord[] = SPEECH_BEAT_WORDS): string {
  // `offered` (2026-11-24, the small window has no kiss / hug: window-close.ts): the line only names words the sentence offered her.
  const out = unavailableBeatWords(s).filter(word => offered.includes(word));
  if (!out.length) return '';
  if (out.length === offered.length) return '这一轮动作标记都用不了。';
  const why = s?.closeNow && CLOSE_NOW_WORDS[s.closeNow] ? `（kiss、hug：${CLOSE_NOW_WORDS[s.closeNow]}）` : '';
  const missing = `这一轮用不了：${out.join('、')}${why}。`;
  const left = `这一轮只能用：${offered.filter(word => !out.includes(word)).join('、')}${why}。`;
  return left.length < missing.length ? left : missing;
}

/** The parts of her mood view this reads (asleep only). The card's mood template rides along on the view; it is never read here. */
export interface SituationView { fatigue?: { sleeping?: boolean } | null; parameters?: { weights?: Readonly<Record<string, unknown>> } | null }
/** The capability card as far as this reads it ("能做手势": the arm bones). */
export interface SituationCard { gesture?: { enabled?: boolean } | null }

/** The situation from what the host knows. `card` null: the model is not known yet. */
export function speechBeatSituationOf(input: { surface: SpeechBeatSurface; shown: boolean; view: SituationView | null | undefined; asleep?: boolean; armsHeld: boolean;
  inCall: boolean; card: SituationCard | null | undefined; closeNow?: unknown }): SpeechBeatSituation {
  const closeNow = input.surface === 'full' && (SPEECH_BEAT_CLOSE_NOW as readonly unknown[]).includes(input.closeNow) ? input.closeNow as SpeechBeatCloseNow : null;
  return {
    ...(closeNow ? { closeNow } : {}),
    surface: input.surface === 'full' ? 'full' : 'window',
    shown: input.shown === true,
    asleep: input.asleep === true || input.view?.fatigue?.sleeping === true,
    armsHeld: input.armsHeld === true,
    inCall: input.inCall === true,
    model: input.card ? { arms: input.card.gesture?.enabled === true } : null,
  };
}
