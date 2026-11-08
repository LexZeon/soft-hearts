// C3 用角色卡文件原地更新 (docs/claude/2026-11-03-card-update-in-place.md).
// Pure: what a card file would change on an existing card, and the lines a confirmation shows. No files, no store.
import {
  CHARACTER_TEXT_LIMITS, validateCharacterDraft,
  type CharacterCardState, type CharacterDraft, type CharacterMoodTemplate, type CharacterTextField,
} from './character-cards';
import type { CharacterResponseProfile } from './character-response';

export type CharacterCardFileFormat = 'soft-hearts-v1' | 'soft-hearts-v2' | 'soft-hearts-v3' | 'tavern-v2' | 'tavern';

/** A card file read by the strict card importer (electron/character-card-update.ts). */
export interface CharacterCardFileContent {
  format: CharacterCardFileFormat;
  /** The persona text (always), plus the mood template and "关系慢慢升温" when the format has them. */
  draft: CharacterDraft;
  /** Version 3 only: the file's own response profile. */
  response: CharacterResponseProfile | null;
}

/**
 * Which optional parts a format has at all. The rule (C3): a part the format has comes from the file (a version 2 file
 * without "关系慢慢升温" means off, the way the app exports it); a part the format does not have stays the card's own
 * (a Tavern card never resets her mood template or reactions to Gene's defaults).
 */
export function cardFileCarries(format: CharacterCardFileFormat): { mood: boolean; slowWarmUp: boolean; response: boolean } {
  const current = format === 'soft-hearts-v2' || format === 'soft-hearts-v3';
  return { mood: current, slowWarmUp: current, response: format === 'soft-hearts-v3' };
}

export type CardUpdatePart = 'replaced' | 'same' | 'kept';
export interface CharacterCardUpdateSummary {
  format: CharacterCardFileFormat;
  name: { before: string; after: string; changed: boolean };
  /** Persona text fields whose text differs, in the editor's order (the name included). */
  changedFields: CharacterTextField[];
  /** 'kept': the file has no mood template, so hers stays. */
  mood: CardUpdatePart;
  slowWarmUp: { before: boolean; after: boolean; part: CardUpdatePart };
  /** 'kept': the file has no response profile, so her reactions stay (only reported when she has some). */
  response: CardUpdatePart;
  /**
   * I-018 理解说明: a file that has notes brings them; a file without (every card made before notes existed, a Tavern
   * card) keeps hers ('kept', only reported when she has some). A file cannot say "no notes", so it never clears them.
   */
  understandingNotes: CardUpdatePart;
  /** The preinstalled Gene card: it keeps going with the preinstalled Gene model (C1). */
  presetGene: boolean;
  /** Nothing about the card would change. */
  unchanged: boolean;
}
/** The control window's preview of an update: a one-time token for its confirmation, never the file's text. */
export interface CharacterCardUpdatePreview { token: string; id: string; summary: CharacterCardUpdateSummary }

/** The host's plan for one card (the agent channel's dialog): `expected` ties the later update to this exact card state. */
export interface CharacterCardUpdatePlanView { id: string; summary: CharacterCardUpdateSummary; expected: string }
/** What an applied update returns to the agent channel. */
export interface CharacterCardUpdateOutcome { state: CharacterCardState; summary: CharacterCardUpdateSummary; notice?: string }

export interface CharacterCardUpdatePlan {
  /** The card's next draft: the file's persona text; mood and "关系慢慢升温" by the rule above. */
  draft: CharacterDraft;
  /** The response profile to save, or null to leave hers as it is. */
  response: CharacterResponseProfile | null;
  summary: CharacterCardUpdateSummary;
}

const TEXT_FIELDS = Object.keys(CHARACTER_TEXT_LIMITS) as CharacterTextField[];
const sameMood = (a: CharacterMoodTemplate | undefined, b: CharacterMoodTemplate | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameResponse = (a: CharacterResponseProfile, b: CharacterResponseProfile) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What updating `current` (an existing card, as the host has it) from `file` does. The id, the model link and the
 * picture are not part of a draft at all, so they cannot change here.
 */
export function planCharacterCardUpdate(current: CharacterDraft, currentResponse: CharacterResponseProfile, file: CharacterCardFileContent,
  options: { presetGene?: boolean } = {}): CharacterCardUpdatePlan {
  const carries = cardFileCarries(file.format);
  const text = Object.fromEntries(TEXT_FIELDS.map(key => [key, file.draft[key]])) as Pick<CharacterDraft, CharacterTextField>;
  const mood = carries.mood && file.draft.mood !== undefined ? file.draft.mood : current.mood;
  const warmBefore = current.slowWarmUp === true;
  const warmAfter = carries.slowWarmUp ? file.draft.slowWarmUp === true : warmBefore;
  const notes = file.draft.understandingNotes ?? current.understandingNotes;
  const draft = validateCharacterDraft({ ...text, ...(mood !== undefined ? { mood } : {}), ...(warmAfter ? { slowWarmUp: true } : {}),
    ...(notes ? { understandingNotes: notes } : {}) });
  const changedFields = TEXT_FIELDS.filter(key => draft[key] !== current[key]);
  const response = carries.response && file.response ? file.response : null;
  const responsePart: CardUpdatePart = response ? (sameResponse(response, currentResponse) ? 'same' : 'replaced')
    : currentResponse.rules.length ? 'kept' : 'same';
  const moodPart: CardUpdatePart = carries.mood ? (sameMood(draft.mood, current.mood) ? 'same' : 'replaced') : 'kept';
  const warmPart: CardUpdatePart = carries.slowWarmUp ? (warmAfter === warmBefore ? 'same' : 'replaced') : 'kept';
  const notesPart: CardUpdatePart = file.draft.understandingNotes !== undefined
    ? (file.draft.understandingNotes === current.understandingNotes ? 'same' : 'replaced')
    : current.understandingNotes ? 'kept' : 'same';
  const summary: CharacterCardUpdateSummary = {
    format: file.format,
    name: { before: current.name, after: draft.name, changed: draft.name !== current.name },
    changedFields,
    mood: moodPart,
    slowWarmUp: { before: warmBefore, after: warmAfter, part: warmPart },
    response: responsePart,
    understandingNotes: notesPart,
    presetGene: options.presetGene === true,
    unchanged: !changedFields.length && moodPart !== 'replaced' && warmPart !== 'replaced' && responsePart !== 'replaced' && notesPart !== 'replaced',
  };
  return { draft, response: responsePart === 'replaced' ? response : null, summary };
}

/** Field names as the card editor labels them (src/ui/CharacterCards.ts). */
export const CARD_FIELD_LABELS: Readonly<Record<CharacterTextField, string>> = Object.freeze({
  name: '角色名称', description: '角色简介', personality: '性格与说话方式', scenario: '相处情境',
  greeting: '开场白', examples: '对话示例', systemPrompt: '补充系统指令',
});
const FORMAT_LABELS: Readonly<Record<CharacterCardFileFormat, string>> = Object.freeze({
  'soft-hearts-v1': 'soft hearts v1', 'soft-hearts-v2': 'soft hearts v2', 'soft-hearts-v3': 'soft hearts v3',
  'tavern-v2': 'Tavern V2', tavern: 'Tavern',
});

/** Copy lookup: `source` is fixed authored copy with {0}… markers; the control window passes its UI language, the host plain Chinese. */
export type CardUpdateCopy = (source: string, ...values: readonly unknown[]) => string;
export const plainCardUpdateCopy: CardUpdateCopy = (source, ...values) =>
  source.replace(/\{(\d+)\}/g, (marker, index: string) => Number(index) < values.length ? String(values[Number(index)]) : marker);

export interface CardUpdateLine { text: string; warning?: boolean }

/** The confirmation's lines: a different name first and flagged, then what changes, then what stays. */
export function cardUpdateSummaryLines(summary: CharacterCardUpdateSummary, copy: CardUpdateCopy = plainCardUpdateCopy): CardUpdateLine[] {
  const lines: CardUpdateLine[] = [];
  if (summary.name.changed)
    lines.push({ warning: true, text: copy('名字不一样：文件里叫「{0}」，现在叫「{1}」。更新后她会叫「{0}」。确认这是同一个角色再更新。', summary.name.after, summary.name.before) });
  const fields = summary.changedFields.filter(key => key !== 'name').map(key => copy(CARD_FIELD_LABELS[key]));
  lines.push({ text: fields.length ? copy('会换成文件里的：{0}。', fields.join(copy('、'))) : copy('人设文字和现在一样。') });
  lines.push({ text: summary.mood === 'replaced' ? copy('心情模板：换成文件里的（当前心情不清零，按新参数接着走）。')
    : summary.mood === 'same' ? copy('心情模板：和现在一样。') : copy('心情模板：文件里没有，保留她现在的。') });
  if (summary.slowWarmUp.part === 'replaced')
    lines.push({ text: summary.slowWarmUp.after ? copy('「关系慢慢升温」：改为打开。') : copy('「关系慢慢升温」：改为关闭。') });
  else if (summary.slowWarmUp.part === 'kept' && summary.slowWarmUp.before)
    lines.push({ text: copy('「关系慢慢升温」：文件里没有，保持打开。') });
  if (summary.response === 'replaced') lines.push({ text: copy('反应细调：换成文件里的。') });
  else if (summary.response === 'kept') lines.push({ text: copy('反应细调：文件里没有，保留她现在的。') });
  if (summary.understandingNotes === 'replaced') lines.push({ text: copy('理解说明：换成文件里的。') });
  else if (summary.understandingNotes === 'kept') lines.push({ text: copy('理解说明：文件里没有，保留她现在的。') });
  if (summary.presetGene) lines.push({ text: copy('这是预装的 Gene 卡：更新后她仍然用预装 Gene 模型。') });
  lines.push({ text: copy('她的聊天、日记、画像、熟悉度和昵称都会保留；模型和头像不变。更新前会先备份角色卡存档。') });
  lines.push({ text: copy('文件格式：{0}。', FORMAT_LABELS[summary.format]) });
  return lines;
}
