import { DEFAULT_MOOD_PARAMETERS, validateMoodParameters, type MoodParameters } from './mood';

export interface CharacterTextDraft {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  greeting: string;
  examples: string;
  systemPrompt: string;
}
export type CharacterTextField = keyof CharacterTextDraft;
/** Portable template parameters only. Current values, B/M and private history never belong here. */
export interface CharacterMoodTemplate { version: 1; parameters: MoodParameters }
export interface CharacterDraft extends CharacterTextDraft {
  mood?: CharacterMoodTemplate;
  /**
   * 熟悉度 (docs/claude/2026-11-02-familiarity-plan.md): "关系慢慢升温". Off by default and when missing (older cards):
   * she is familiar from the first day. On: polite and curious at first, easier as the days add up; a slow-to-warm
   * card takes longer. It is a card setting, so it is exported; the relationship numbers themselves are not.
   */
  slowWarmUp?: boolean;
  /**
   * F6 "更真实的情绪" (shared/realer-emotions.ts): off by default and when missing (older cards). It only turns on after the
   * user saw what it does and agreed (the host's dialog); the card editor's save, import and the in-place update never turn it on.
   */
  realerEmotions?: boolean;
  /**
   * I-018 理解说明 (docs/claude/2026-11-03-character-understanding.md): how the words on this card are meant, as the user
   * confirmed in the discussion with Claude (a title is a post, not a profession; what not to play it as). Optional and
   * absent when empty, so a card without it compiles, stores and exports exactly as before. It is persona text, so it
   * travels with the card; the discussion itself never does.
   */
  understandingNotes?: string;
}
export interface CharacterCard extends CharacterDraft {
  id: string;
  modelName?: string;
}
export interface CharacterCardState {
  cards: CharacterCard[];
  activeId: string;
  notice?: string;
  /** C1: an informational line (which card a loaded model went with); never an error. */
  hint?: string;
  /** C2: a "换成她" waiting for her current line to finish (the card it will bring in). */
  switchingTo?: string;
  revision?: number;
}
export const MAX_CHARACTER_CARDS = 64;
export const MAX_CHARACTER_PERSONA = 12000;
/** I-018: a few lines to a dozen or so; it counts toward MAX_CHARACTER_PERSONA too. */
export const MAX_UNDERSTANDING_NOTES = 2000;
export const CHARACTER_TEXT_LIMITS: Record<CharacterTextField, number> = {
  name: 80,
  description: 4000,
  personality: 4000,
  scenario: 4000,
  greeting: 4000,
  examples: 8000,
  systemPrompt: 12000,
};
export const CHARACTER_CARD_FORMAT = "soft-hearts-character-card";
export const CHARACTER_CARD_VERSION = 2;
export const BUNDLED_CHARACTER_MODEL = "bundled:gene";

export function defaultCharacterMoodTemplate(): CharacterMoodTemplate {
  return { version: 1, parameters: validateMoodParameters(DEFAULT_MOOD_PARAMETERS) };
}
export function validateCharacterMoodTemplate(value: unknown): CharacterMoodTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('角色心情模板格式不正确。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || Object.keys(input).some(key => !['version', 'parameters'].includes(key)) || input.version !== 1)
    throw new Error('角色心情模板只支持 version 1 与完整 parameters。');
  return { version: 1, parameters: validateMoodParameters(input.parameters) };
}
/** Missing legacy templates inherit Gene; hosts may first migrate a saved private parameter profile. */
export function effectiveCharacterMood(card: Pick<CharacterDraft, 'mood'>): MoodParameters {
  return card.mood === undefined ? defaultCharacterMoodTemplate().parameters : validateCharacterMoodTemplate(card.mood).parameters;
}

/** Pure data only: callers render textContent/value; no paths, tools or runtime state. */
export function validateCharacterDraft(value: unknown): CharacterDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("角色卡格式不正确。");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== 'mood' && key !== 'slowWarmUp' && key !== 'realerEmotions' && key !== 'understandingNotes' && !Object.hasOwn(CHARACTER_TEXT_LIMITS, key))
  )
    throw new Error("角色卡只允许包含人设文字与版本化心情模板。");
  const result = {} as CharacterDraft;
  for (const [key, limit] of Object.entries(CHARACTER_TEXT_LIMITS) as [
    CharacterTextField,
    number,
  ][]) {
    const field = input[key] === undefined ? "" : input[key];
    if (
      typeof field !== "string" ||
      field.length > limit ||
      field.includes("\0")
    )
      throw new Error(`角色卡 ${key} 必须为 ${limit} 字以内的文字。`);
    result[key] = key === "name" ? field.trim() : field;
  }
  if (!result.name) throw new Error("请填写角色名称。");
  if (input.mood !== undefined) result.mood = validateCharacterMoodTemplate(input.mood);
  if (input.slowWarmUp !== undefined) {
    if (typeof input.slowWarmUp !== 'boolean') throw new Error('“关系慢慢升温”只能是开或关。');
    result.slowWarmUp = input.slowWarmUp;
  }
  if (input.realerEmotions !== undefined) {
    if (typeof input.realerEmotions !== 'boolean') throw new Error('“更真实的情绪”只能是开或关。');
    result.realerEmotions = input.realerEmotions;
  }
  if (input.understandingNotes !== undefined) {
    const notes = validateUnderstandingNotes(input.understandingNotes);
    if (notes) result.understandingNotes = notes;
  }
  compileCharacterPersona(result);
  return result;
}
/** I-018 理解说明: trimmed text within MAX_UNDERSTANDING_NOTES; '' means none (the field is then left out). */
export function validateUnderstandingNotes(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_UNDERSTANDING_NOTES || value.includes('\0'))
    throw new Error(`理解说明必须是 ${MAX_UNDERSTANDING_NOTES} 字以内的文字。`);
  return value.trim();
}
/** The heading the notes go under in her persona: a section of its own, right after the description. */
export const UNDERSTANDING_NOTES_HEADING = '理解说明（和用户确认过的理解；卡里的头衔、组织和专有名词按这里理解）：';
/**
 * R28 / F1 (real chats: 161 of 201 replies opened with an ellipsis, the card's example lines came back word for word about 24 times):
 * the examples show her voice, they are not a script, and an ellipsis is a colour, not a habit. Both sit in the persona, which a
 * session sends once (no per-turn cost); the card's own voice is kept.
 */
export const EXAMPLES_HEADING = '对话示例（这是她说话的味道：照着这个味道说自己的话，不要原样照抄）：';
export const OPENING_VARIETY_RULE = '表达变化：回复别总以省略号“……”开头，偶尔用一次可以；性格和口气照旧，只是开头和句子每次自己换着说。';
export function compileCharacterPersona(card: CharacterTextDraft & Pick<CharacterDraft, 'understandingNotes'>): string {
  const roleFields = [
    card.description,
    card.personality,
    card.scenario,
    card.examples,
  ];
  const notes = card.understandingNotes?.trim() ? `${UNDERSTANDING_NOTES_HEADING}\n${card.understandingNotes}` : "";
  // A legacy custom persona remains complete and unchanged, even at the old limit (I-018's notes, when there are any, follow it).
  const compose = (wording: boolean): string =>
    card.systemPrompt && roleFields.every((field) => !field.trim())
      ? [card.systemPrompt, notes].filter(Boolean).join("\n\n")
      : [
          card.systemPrompt,
          `角色名称：${card.name}`,
          card.description.trim() ? `角色描述：\n${card.description}` : "",
          notes,
          card.personality.trim() ? `性格：\n${card.personality}` : "",
          card.scenario.trim() ? `情境：\n${card.scenario}` : "",
          card.examples.trim() ? `${wording ? EXAMPLES_HEADING : "对话示例："}\n${card.examples}` : "",
          wording ? OPENING_VARIETY_RULE : "",
        ]
          .filter(Boolean)
          .join("\n\n");
  // The two added wordings never make a card that fitted before too long: a card at the limit keeps the plain wording.
  let text = compose(true);
  if (text.length > MAX_CHARACTER_PERSONA) text = compose(false);
  if (text.length > MAX_CHARACTER_PERSONA)
    throw new Error(
      `角色卡组合后的人设超过 ${MAX_CHARACTER_PERSONA} 字，请缩短文字。`,
    );
  return text;
}
