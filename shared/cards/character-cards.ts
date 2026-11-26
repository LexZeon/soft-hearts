import { DEFAULT_MOOD_PARAMETERS, validateMoodParameters, type MoodParameters } from '../foundation/mood';
import { validateMusicTaste } from '../senses';
import { validateCardSlips } from './card-slips';
import { normalizeCharacterVoice } from '../foundation/character-voice';
import { validateCardMilestone } from './card-milestone';
import { validateCardObject } from './card-objects';
// The card types live in shared/foundation/character-card.ts (2026-11-16); re-exported here so existing importers keep working.
import { CARD_LANGUAGES, cardLanguageOf, type CardMilestone, type CharacterTextDraft, type CharacterTextField, type CharacterMoodTemplate, type CardLanguage, type CharacterDraft, type CharacterCard, type CharacterCardState } from '../foundation/character-card';
export { CARD_LANGUAGES, cardLanguageOf, type CardMilestone, type CharacterTextDraft, type CharacterTextField, type CharacterMoodTemplate, type CardLanguage, type CharacterDraft, type CharacterCard, type CharacterCardState };

export const SLEEP_HABIT_MIDDLE = 50;
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
    Object.keys(input).some((key) => key !== 'mood' && key !== 'slowWarmUp' && key !== 'realerEmotions' && key !== 'understandingNotes' && key !== 'language' && key !== 'sleepHabit' && key !== 'musicTaste' && key !== 'slips' && key !== 'voice' && key !== 'milestone' && key !== 'object' && !Object.hasOwn(CHARACTER_TEXT_LIMITS, key))
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
    if (typeof input.slowWarmUp !== 'boolean') throw new Error('“慢慢熟悉”只能是开或关。');
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
  if (input.language !== undefined) {
    if (input.language !== 'zh-CN' && input.language !== 'en') throw new Error('角色卡的语言只能是 zh-CN 或 en。');
    result.language = input.language; // stored as given; a card with none reads as 'zh-CN' (cardLanguageOf), so an older card is what it always was
  }
  if (input.sleepHabit !== undefined) {
    if (typeof input.sleepHabit !== 'number' || !Number.isInteger(input.sleepHabit) || input.sleepHabit < 0 || input.sleepHabit > 100)
      throw new Error('“睡相”必须是 0～100 的整数（50 是中间）。');
    result.sleepHabit = input.sleepHabit;
  }
  if (input.musicTaste !== undefined) {
    const taste = validateMusicTaste(input.musicTaste); // all 50 (or null) is "none": the field is then left out
    if (taste) result.musicTaste = taste;
  }
  if (input.slips !== undefined) {
    const slips = validateCardSlips(input.slips); // 'default' means none: the field is then left out
    if (slips) result.slips = slips;
  }
  if (input.voice !== undefined) {
    const voice = normalizeCharacterVoice(input.voice); // I-162: never throws; an unusable voice is left out (she then reads with the default)
    if (voice) result.voice = voice;
  }
  if (input.milestone !== undefined) result.milestone = validateCardMilestone(input.milestone); // I-207: words only; a bad one refuses the card
  if (input.object !== undefined) result.object = validateCardObject(input.object); // I-208: the name and the fixed entries; a bad one refuses the card
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
/** I-071: the English wording of the persona's headings and the opening-variety rule (chat language 'en'). */
export const ENGLISH_PERSONA_WORDING = {
  name: 'Name: ', description: 'Description:', personality: 'Personality:', scenario: 'Scenario:',
  examples: 'Example dialogue:',
  examplesWithWording: 'Example dialogue (this is how she sounds: say your own words in this flavour, do not copy them as they are):',
  notes: 'Understanding notes (confirmed with the user; read titles, organizations and proper nouns on the card as these notes say):',
  openingVariety: 'Variety: do not open every reply with an ellipsis ("..."); once in a while is fine. Keep the personality and tone as they are, only vary how replies and sentences open each time.',
} as const;
/** A Chinese card compiles exactly as it did before I-071; an English card (`language: 'en'`) gets the English headings and rule. */
export function compileCharacterPersona(card: CharacterTextDraft & Pick<CharacterDraft, 'understandingNotes' | 'language'>): string {
  const en = cardLanguageOf(card) === 'en';
  const W = ENGLISH_PERSONA_WORDING;
  const examplesHeading = (wording: boolean): string => en ? (wording ? W.examplesWithWording : W.examples) : (wording ? EXAMPLES_HEADING : "对话示例：");
  const roleFields = [
    card.description,
    card.personality,
    card.scenario,
    card.examples,
  ];
  const notes = card.understandingNotes?.trim() ? `${en ? W.notes : UNDERSTANDING_NOTES_HEADING}\n${card.understandingNotes}` : "";
  // A legacy custom persona remains complete and unchanged, even at the old limit (I-018's notes, when there are any, follow it).
  const compose = (wording: boolean): string =>
    card.systemPrompt && roleFields.every((field) => !field.trim())
      ? [card.systemPrompt, notes].filter(Boolean).join("\n\n")
      : [
          card.systemPrompt,
          `${en ? W.name : "角色名称："}${card.name}`,
          card.description.trim() ? `${en ? W.description : "角色描述："}\n${card.description}` : "",
          notes,
          card.personality.trim() ? `${en ? W.personality : "性格："}\n${card.personality}` : "",
          card.scenario.trim() ? `${en ? W.scenario : "情境："}\n${card.scenario}` : "",
          card.examples.trim() ? `${examplesHeading(wording)}\n${card.examples}` : "",
          wording ? (en ? W.openingVariety : OPENING_VARIETY_RULE) : "",
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
