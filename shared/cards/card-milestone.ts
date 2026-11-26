// I-207 角色卡里的"里程碑" (docs/claude/2026-11-23-card-milestone.md): a card may declare one thing that can happen between her and the user once
// (Gene: 这一单，签收). The card holds only the words; whether it happened is state per character (relationship file), never part of the card.
// She decides it happened: she writes one hidden closed marker `⟪milestone⟫` in her reply (the speech-beats filter takes it out of every path), the host
// records the local date once and later markers are ignored. Each turn she reads ONE information line about it, in the card's language. Pure: no clock, no I/O.
import type { CardLanguage, CardMilestone } from '../foundation/character-card';

/** The marker's first (and only) word, between ⟪ and ⟫ (the alarm marker's brackets: shared/behaviors/alarms/interface.ts). */
export const MILESTONE_MARK_WORD = 'milestone';
export const CARD_MILESTONE_FIELD_MAX = 24;
/** Characters that never belong in one of the declaration's words: a line break, a control character, any marker or tag bracket. */
const FORBIDDEN = /[\u0000-\u001f\u007f<>⟦⟧⟪⟫【】〖〗|[\]]/u;

function word(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`里程碑的“${label}”必须是文字。`);
  const text = value.trim();
  if (!text || Array.from(text).length > CARD_MILESTONE_FIELD_MAX || FORBIDDEN.test(text))
    throw new Error(`里程碑的“${label}”必须是 1～${CARD_MILESTONE_FIELD_MAX} 个字的一行普通文字（不含括号和竖线）。`);
  return text;
}

/** A card's declaration: exactly `name` (what it is called, "这一单"), `notYet` ("还没签收") and `reached` ("已签收"). Throws on anything else. */
export function validateCardMilestone(value: unknown): CardMilestone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('里程碑的格式不正确。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'name' && key !== 'notYet' && key !== 'reached')) throw new Error('里程碑只能有名字、还没到的说法和到了的说法。');
  return { name: word(input.name, '名字'), notYet: word(input.notYet, '还没到的说法'), reached: word(input.reached, '到了的说法') };
}

/** The marker body between the brackets: `milestone` and nothing else (any extra, a repeat key or another word is not the marker). */
export function isMilestoneMarker(body: unknown): boolean {
  return typeof body === 'string' && body.trim().toLowerCase() === MILESTONE_MARK_WORD;
}

/** A stored local date key ('2026-11-23') as the line says it: "11月23日" / "Nov 23". Anything else is '' (the line then names no date). */
export function milestoneDateText(date: string, language: CardLanguage): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return '';
  const month = Number(match[1]), day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return language === 'en' ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${day}` : `${month}月${day}日`;
}

/**
 * The one information line (no instruction about what to do or say). Not yet: the card's own words, plus one clause on how the marker is
 * spelled (she cannot write a marker she was never shown). Reached: the card's words and the date; nothing more is needed.
 * `date` is the stored local date key, or null while it has not happened.
 */
export function milestoneLine(milestone: CardMilestone, date: string | null, language: CardLanguage): string {
  const en = language === 'en';
  if (date === null)
    return en ? `${milestone.name}: ${milestone.notYet}. (Writing ⟪${MILESTONE_MARK_WORD}⟫ in a reply records the day; the marker is never shown.)`
      : `${milestone.name}：${milestone.notYet}。（回复里写 ⟪${MILESTONE_MARK_WORD}⟫ 就记下这一天，这个记号不显示。）`;
  const when = milestoneDateText(date, language);
  return en ? `${milestone.name}: ${milestone.reached}${when ? ` (${when})` : ''}.` : `${milestone.name}：${milestone.reached}${when ? `（${when}）` : ''}。`;
}

/** What the user's page (and, later, the archive page) shows of it: the card's words, whether it happened and the local date. */
export interface CardMilestoneView { readonly name: string; readonly notYet: string; readonly reached: string; readonly done: boolean; readonly date: string | null }
/**
 * The page's one write on the existing `herAlarms` window-to-host channel: clear it (the page confirms first; it goes into the recycle bin first). Reading it
 * moved to the archive's own read-only call (`getCharacterArchive`, shared/memory/archive.ts; I-208), so `milestone-view` is gone from this channel.
 */
export type CardMilestoneRequest = { readonly action: 'milestone-clear' };
export function isCardMilestoneRequest(value: unknown): value is CardMilestoneRequest {
  const action = value && typeof value === 'object' ? (value as { action?: unknown }).action : null;
  return action === 'milestone-clear';
}
export function cardMilestoneView(milestone: CardMilestone, date: string | null): CardMilestoneView {
  return { name: milestone.name, notYet: milestone.notYet, reached: milestone.reached, done: date !== null, date };
}
