// I-067: when a card is imported or updated, the app looks for the few common mistakes a machine can
// reliably spot (docs/character-card-guide.md, "写卡最常犯的错") and says so in a sentence or two. It never blocks the
// import and never changes the card. Pure: no files, no store. Only checks that rarely misfire are here; the rest of the
// guide's list (hurtful settings, adult content, copied lines) needs judgement and stays with the user and their Claude.
import { t } from '../foundation/ui-language';
import type { CharacterTextDraft } from '../foundation/character-card';

export const MAX_CARD_LINT_NOTES = 3;
type Card = Partial<CharacterTextDraft>;
const text = (card: Card, ...fields: (keyof CharacterTextDraft)[]) => fields.map(field => String(card[field] ?? ''));

// Guide 1: "扮演 X" / "你是一个 AI" openers.
const OPEN = String.raw`^[\s"'“「『]*`;
const ROLE_PLAY_OPENER = new RegExp(
  `${OPEN}(?:现在)?(?:请)?(?:你)?(?:来|要|需要)?扮演|${OPEN}(?:你是|你就是)(?:一个|一名|一款)?\\s*(?:AI|A\\.I\\.|人工智能|语言模型|大语言模型|聊天机器人)`, 'i');
// I-071 v2: an English card's openers ("Act as ...", "You are an AI ..."). A Chinese card never has these, so both are always checked.
const ENGLISH_ROLE_PLAY_OPENER = /^[\s"'“]*(?:please\s+)?(?:role-?play|act|pretend)\s+(?:as|to be)\b|^[\s"'“]*you are (?:just )?(?:an?\s+)?(?:AI|A\.I\.|artificial intelligence|language model|large language model|chat ?bot)\b/i;
const roleOpener = (card: Card) => text(card, 'systemPrompt', 'personality', 'description').some(value => ROLE_PLAY_OPENER.test(value) || ENGLISH_ROLE_PLAY_OPENER.test(value));

// Guide 3: example lines that all look the same. Only the character's lines count, and only with at least 3 of them.
const USER_LABEL = /^(?:用户|user|你|玩家|我|me|\{\{user\}\})$/i;
function characterLines(examples: string): string[] {
  const lines = examples.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const labelled = lines.map(line => /^([^：:\n]{1,24})[：:]\s*(.*)$/.exec(line));
  if (!labelled.some(Boolean)) return lines;
  return labelled.flatMap(match => match && !USER_LABEL.test(match[1].trim()) && match[2] ? [match[2]] : []);
}
function fixedExamples(examples: string): boolean {
  const lines = characterLines(examples);
  if (lines.length < 3) return false;
  if (lines.every(line => /^(?:……|\.{2,}|。{2,}|…)/.test(line))) return true;
  const actions = lines.map(line => /^[（(*]([^）)*]{1,30})[）)*]|[（(*]([^）)*]{1,30})[）)*]$/.exec(line));
  if (actions.every(Boolean)) {
    const inner = actions.map(match => (match![1] ?? match![2]).trim());
    return new Set(inner).size === 1;
  }
  return false;
}

// Guide 4: a personality word with a number ("黏人度 90", "好感度：80", "傲娇值 7/10"). The mood numbers live in `mood`.
const TRAIT = '(?:黏人|粘人|好感|傲娇|害羞|亲密|撒娇|温柔|活泼|话痨|信任|依赖|占有|冷淡|热情|开朗|内向|外向|吃醋|脾气|主动|耐心)';
const NOT_A_DATE = '(?![\\d岁月日号点年天时分秒个次])';
const TRAIT_NUMBER = new RegExp(`${TRAIT}(?:度|值|指数|等级)\\s*[:：=是为]?\\s*\\d+${NOT_A_DATE}|${TRAIT}\\s*[:：=]\\s*\\d+${NOT_A_DATE}`);
const traitNumber = (card: Card) => text(card, 'systemPrompt', 'personality', 'description', 'scenario').some(value => TRAIT_NUMBER.test(value));

// Guide 9: long replies, Markdown, lists. A "不要……" earlier in the same clause is the card saying the opposite, so it is skipped.
// Only instruction shapes: "愿望清单", "大部分点心", "她回答得很详细" are ordinary card text and must not match.
const LONG_OR_MARKDOWN = /(?:至少|不少于|不低于|最少|起码)\s*\d+\s*(?:个)?[字词]|markdown|分[点条](?:列出|回答|作答|说明|陈述|叙述)|(?:用|以|按|列成|写成)[^，。\n]{0,4}(?:列表|清单)|(?:列表|清单)(?:形式|格式)|(?:回复|回答|输出)(?:要|需要|请|必须|应该|应当|尽量)[^，。\n]{0,4}(?:详细|详尽|长篇|长一点|长一些)|长篇大论/gi;
const NEGATION = /[不别勿禁免少无]/;
function wantsLongOrMarkdown(card: Card): boolean {
  return text(card, 'systemPrompt', 'personality', 'description', 'scenario', 'examples').some(value => {
    for (const match of value.matchAll(LONG_OR_MARKDOWN)) {
      const before = value.slice(0, match.index ?? 0);
      const clause = before.slice(Math.max(before.search(/[^，。；！？,.;!?\n]*$/), before.length - 12));
      if (!NEGATION.test(clause)) return true;
    }
    return false;
  });
}

// Guide 10: a file path or something key-shaped inside the card.
const PATH_LIKE = /[A-Za-z]:\\[^\s]|[\\/]Users[\\/]|[\\/]home[\\/][A-Za-z0-9_.-]+[\\/]/;
const KEY_LIKE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/,
  /(?<![0-9A-Za-z+/])(?=[A-Za-z+/]*\d)(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{40,}={0,2}/,
];
const pathOrKey = (card: Card) => text(card, 'name', 'description', 'personality', 'scenario', 'greeting', 'examples', 'systemPrompt')
  .some(value => PATH_LIKE.test(value) || KEY_LIKE.some(pattern => pattern.test(value)));

export interface CardLintOptions {
  /** The names of the cards already in the app, when this card would be imported as a new one (not for an in-place update). */
  existingNames?: readonly string[];
}

/** At most three short reminders (in the current interface language), the ones that matter most first. */
export function lintCharacterCard(card: Card, options: CardLintOptions = {}): string[] {
  const notes: string[] = [];
  const name = String(card.name ?? '').trim();
  if (name && options.existingNames?.some(existing => String(existing).trim() === name))
    notes.push(t('已经有一张叫「{0}」的卡；如果是想改她，请用「更新」，不要新建，否则聊天、日记和熟悉度都接不上。', { 0: name }));
  if (pathOrKey(card)) notes.push(t('卡里好像有文件路径或密钥一样的字符串；卡可能被导出分享，建议删掉。'));
  if (roleOpener(card)) notes.push(t('人设以「扮演……」或「你是一个 AI」开头，她可能先回一句「明白了」；建议改成「你就是她」，或用第三人称描述。'));
  if (wantsLongOrMarkdown(card)) notes.push(t('卡里要求长回复、列表或 Markdown；气泡和朗读都会很难受，建议改成「一般一到三句，口语」。'));
  if (traitNumber(card)) notes.push(t('文字里写了「性格词 + 数字」（比如黏人度 90）；这不会生效，数值请写在「心情和反应」里。'));
  if (fixedExamples(String(card.examples ?? ''))) notes.push(t('对话示例每句的格式都一样（比如都用省略号开头或带同一个动作）；她会把格式也学走，建议长短和句式错开。'));
  return notes.slice(0, MAX_CARD_LINT_NOTES);
}

/** One line for the app's notice slot and the channel's result; `existing` is whatever notice the import already had. */
export function cardLintNotice(notes: readonly string[], existing?: string): string | undefined {
  const joined = notes.length ? `${t('提醒（不影响导入）：')}${notes.join(' ')}` : '';
  return [existing, joined].filter(Boolean).join(' ') || undefined;
}
