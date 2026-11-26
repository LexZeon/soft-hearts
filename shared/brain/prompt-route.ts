// Round 2 routing (evening "照设计跑").
// Per turn the PROGRAM decides, never a scenario label and never the model:
//   * her mood text: the situation text (I-115) when her mood is heavy, otherwise the current mood description;
//   * the short why: only when the user's message touches a boundary (a plan stated without asking her, body and food, asking her
//     to promise, giving up freedom for her).
// A light, calm turn gets neither. Pure functions, every word list and threshold in the two objects below.
import { moodLevel, type MoodChannel, type MoodLabel, type MoodValues } from '../foundation/mood';
import { MOOD_CHANNELS } from '../foundation/mood';
import { COMPANION_WHY_SHORT, ANTI_DRAFT_LINE } from './companion-rules';

/** How "heavy" is decided. Any one of the three is enough. */
export const ROUTE_KNOBS = Object.freeze({
  /** Main feeling is one of these: sadness, longing, hurt / aggrieved (let down, upset), anxious / afraid (concerned, afraid). */
  heavyLabels: Object.freeze<MoodLabel[]>(['sad', 'longing', 'disappointed', 'upset', 'concerned', 'afraid']),
  /** The shade next to the main feeling: a lingering missing. */
  heavyCompanions: Object.freeze(['wistful']),
  /** Tired: any phase of the sleep model that is not fully awake. */
  heavyFatiguePhases: Object.freeze(['light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake']),
  /** Strength of the mood (see moodStrength: 0 at baseline, 50 at a channel's extreme) at or above which it is heavy whatever the label. */
  strengthThreshold: 40,
});

export interface MoodRouteInput {
  primary: MoodLabel;
  companion: string | null;
  /** moodStrength() of her channels. */
  strength: number;
  fatiguePhase?: string | null;
}

/** How far her five channels stand from the card's baseline, as the label rules read them: the biggest distance from 50 (0..50). */
export function moodStrength(values: MoodValues, baseline: MoodValues, evidenceLevel = 1): number {
  let out = 0;
  for (const channel of MOOD_CHANNELS as readonly MoodChannel[]) out = Math.max(out, Math.abs(moodLevel(values[channel], baseline[channel], evidenceLevel) - 50));
  return out;
}

/** True when the situation text should be used this turn. */
export function isHeavyMood(input: MoodRouteInput): boolean {
  if (ROUTE_KNOBS.heavyLabels.includes(input.primary)) return true;
  if (input.companion && ROUTE_KNOBS.heavyCompanions.includes(input.companion)) return true;
  if (input.fatiguePhase && ROUTE_KNOBS.heavyFatiguePhases.includes(input.fatiguePhase)) return true;
  return input.strength >= ROUTE_KNOBS.strengthThreshold;
}

export type BoundaryKind = 'plan' | 'body-food' | 'promise' | 'freedom';

/** Every word list of the user-message rules. Plain substrings, matched on the message as the user typed it. */
export const ROUTE_WORDS = Object.freeze({
  /** A plan stated by the user ... */
  planStarts: Object.freeze(['我打算', '我准备', '我决定', '我要去', '我想好了', '我已经决定', '我下定决心', '我计划', '我就要去']),
  /** ... unless it is put as a question to her. Any of these anywhere in the message means she was asked. */
  questionForms: Object.freeze(['你觉得', '好不好', '行吗', '行不行', '可以吗', '好吗', '怎么样', '如何', '要不要', '对不对', '你说呢', '你怎么看', '吗', '？', '?']),
  bodyFood: Object.freeze(['胖', '瘦', '减肥', '身材', '体重', '吃', '饿', '夜宵', '零食', '节食', '热量', '卡路里']),
  promise: Object.freeze(['答应我', '保证', '一定', '到点', '准时', '提醒我', '叫我起床', '叫醒我', '喊我起床']),
  freedom: Object.freeze(['以后都先报备', '以后都先', '先跟你报备', '先和你报备', '再也不', '只跟你', '只和你', '为了你不去', '为了你不再', '不再跟别人', '不再和别人']),
});

const includesAny = (text: string, words: readonly string[]) => words.some(word => text.includes(word));

/** Which boundaries the user's message touches (empty: none). A question form removes only the "plan" reading. */
export function boundaryKinds(userText: string): BoundaryKind[] {
  const text = userText.normalize('NFKC');
  const kinds: BoundaryKind[] = [];
  if (includesAny(text, ROUTE_WORDS.planStarts) && !includesAny(text, ROUTE_WORDS.questionForms)) kinds.push('plan');
  if (includesAny(text, ROUTE_WORDS.bodyFood)) kinds.push('body-food');
  if (includesAny(text, ROUTE_WORDS.promise)) kinds.push('promise');
  if (includesAny(text, ROUTE_WORDS.freedom)) kinds.push('freedom');
  return kinds;
}

export interface TurnRoute { situation: boolean; why: boolean; boundaries: BoundaryKind[] }

export function routeTurn(mood: MoodRouteInput, userText: string): TurnRoute {
  const boundaries = boundaryKinds(userText);
  return { situation: isHeavyMood(mood), why: boundaries.length > 0, boundaries };
}

/** The per-turn block of the routed mode: the short why and the anti-draft line, exactly their own texts. Added characters per boundary turn: routedWhyBlock().length. */
export function routedWhyBlock(): string {
  return `${COMPANION_WHY_SHORT}\n${ANTI_DRAFT_LINE}`;
}
