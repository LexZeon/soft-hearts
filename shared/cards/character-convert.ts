// I-071 v2 第三步.
// Types and pure helpers shared by the host (electron/character-convert/), the channel tools and the Claude 助手 panel.
// Nothing here grants anything: the host's registry decides every call, and starting a conversion always opens the popup.
import { cardLanguageOf, type CardLanguage } from '../foundation/character-card';
import { cleanNickname } from '../memory';
import { ASSISTANT_NAME, ASSISTANT_CLI_NAME } from '../foundation/assistant-name';

/** The names the user decides one by one before anything starts: keep it, take Claude's suggestion, or type one. */
export type ConversionNameRole = 'her-name' | 'her-nickname' | 'user-nickname';
export const CONVERSION_NAME_LABELS: Readonly<Record<ConversionNameRole, string>> = Object.freeze({
  'her-name': '她在新卡上的名字', 'her-nickname': '你叫她的昵称', 'user-nickname': '她叫你的昵称',
});
/**
 * Forms of address found only in her notes, diary and profile (a pet name the user says often that is not stored as a nickname),
 * found locally before the conversion and decided by the user together with the three names above.
 * Every nickname and form of address has a fourth choice besides keep / suggestion / typed: `to: ''` = leave it unset for now (the
 * user makes the new language's pet names later by chatting with her). An alias that is not a name at all is `ignore: true`.
 */
export type ConversionAliasId = 'alias-1' | 'alias-2' | 'alias-3' | 'alias-4' | 'alias-5' | 'alias-6';
/** Fix 4: 6 (was 4, and a film character took a slot); only names her memories show as an address count (addresses.ts). */
export const MAX_CONVERSION_ALIASES = 6;
export const CONVERSION_ALIAS_LABEL = '她的记忆里常出现的称呼或名字';
const isAlias = (id: string): id is ConversionAliasId => /^alias-[1-6]$/.test(id);
/** Who a form of address names, when her memories show it (fix 4): the user, or her. Unknown is left out. */
export type ConversionReferent = 'user' | 'her';
/**
 * The card's own proper nouns (her organization, her title, places), found locally in the persona text and offered with the same
 * choices (keep / suggestion / typed / ignore): the official terms of a setting often differ from a literal translation. They go into
 * the same one glossary as the names.
 */
export type ConversionTermId = 'term-1' | 'term-2' | 'term-3' | 'term-4' | 'term-5' | 'term-6';
export const MAX_CONVERSION_TERMS = 6;
export const CONVERSION_TERM_LABEL = '角色设定里的专有名词（组织、头衔、地名）';
const isTerm = (id: string): id is ConversionTermId => /^term-[1-6]$/.test(id);
/** A proper noun's translation: one line, 1 to 40 characters, no control characters, no link. */
export function cleanTerm(value: string): string | null {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return !text || Array.from(text).length > 40 || CONTROL.test(text) || /https?:|www\./iu.test(text) ? null : text;
}
export type ConversionNameId = ConversionNameRole | ConversionAliasId | ConversionTermId;
export interface ConversionName { id: ConversionNameId; label: string; text: string; /** How often the text shows up (aliases only). */ uses?: number; /** Aliases only: who it names, when her memories show it. */ refers?: ConversionReferent }
export interface ConversionNameChoice { id: ConversionNameId; to: string; ignore?: boolean }
/**
 * (fix 3, user's card retest) A name the Claude 助手 found itself while reading the card's persona (prepare_character_conversion
 * returns a bounded excerpt): an organization, title, place (`term`) or a nickname (`alias`) the local search missed. Plain text
 * only; the host checks that `from` really occurs in the card or her memories, and the popup lists it like every other name.
 * One the user said is an ordinary word is simply not sent.
 */
export interface ConversionExtraName { kind: 'term' | 'alias'; from: string; to: string; /** Fix 5: who added it (the popup says so); absent = not said. */ by?: ConversionExtraBy }
/** `assistant-memory` is only ever set by the host (checkConversionExtra): the word was found in her notes or memories, not in the persona. The model may send user or assistant only. */
export type ConversionExtraBy = 'user' | 'assistant' | 'assistant-memory';
/** Fix 5: the popup's note on an extra name (the fourth test marked the user's own 老公 as found by Claude). */
export const CONVERSION_EXTRA_BY_LABELS: Readonly<Record<ConversionExtraBy | 'unknown', string>> = Object.freeze({
  user: '你补的', assistant: `${ASSISTANT_NAME} 在人设里找到的`, 'assistant-memory': `${ASSISTANT_NAME} 在记忆里找到的`, unknown: '另外补的',
});
/**
 * Fix 4: names the assistant or the user adds have their own caps, never shared with the ones found locally (the user's own
 * "老公" was refused because found names had filled the alias cap).
 */
export const MAX_CONVERSION_EXTRA = 8;
export const MAX_CONVERSION_EXTRA_ALIASES = 4;
export const MAX_CONVERSION_EXTRA_TERMS = 6;
/** The original text of an extra name: one line, 1 to 24 characters, no control characters, no link, no path or markup characters. */
export function cleanExtraFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return !text || Array.from(text).length > 24 || CONTROL.test(text) || /https?:|www\.|[\\/<>{}`]/iu.test(text) ? null : text;
}

export const CONVERSION_TARGET_LABELS: Readonly<Record<CardLanguage, string>> = Object.freeze({ en: '英文版', 'zh-CN': '中文版' });
export const CONVERSION_LANGUAGE_NAMES: Readonly<Record<CardLanguage, string>> = Object.freeze({ en: 'English', 'zh-CN': '简体中文' });

/** How much is carried over (bounded so one conversion stays a handful of calls). */
export const CONVERSION_LIMITS = Object.freeze({
  /** Her chat notes (聊天笔记, not the profile's 她记得的事 plans), newest first. */
  notes: 200,
  /** The last days of her diary. */
  diaryDays: 30,
  /** I-088 第 1 条: the newest weekly and monthly look-backs. */
  reviewWeeks: 4,
  reviewMonths: 2,
  /** Source characters per memory translation call (one JSON batch). Fix 6: halved (the sixth test: a 9000-character batch took 52 to over 120 s; about half normally finishes well under a minute). */
  batchChars: 4_500,
  /** One retry for the items a batch left out or got wrong. */
  retries: 1,
  /** A whole conversion gives up after this long. */
  jobMs: 30 * 60_000,
});

/**
 * Fix 6: said with every failure that is not about the memories' content (a timeout, a call error, an interruption): the sixth test
 * showed a bare "Claude 回复超时，已停止。" that did not say whether the original was safe or what to do. Short on purpose (the
 * result line is capped at 300 characters).
 */
export const CONVERSION_UNTOUCHED_NOTE = '原来的角色一点没动，也没有留下半成品；直接再转一次就行，刚才选的名字可以照用。';

export interface ConversionCounts {
  /** Notes she has (all) and how many are carried (≤ CONVERSION_LIMITS.notes). */
  notes: number; notesCarried: number;
  profileEntries: number; diaryDays: number; memes: number;
  /** I-088 第 1 条: her weekly and monthly look-backs that are carried (the newest weeks and months). */
  reviews?: number;
  /** Fix 8: diary days older than the carried window, and look-backs older than the carried weeks and months (listed, not carried). */
  diaryOlder?: number; reviewsOlder?: number;
  knownDays: number; qualityDays: number; metDate: string | null;
}

/**
 * Fix 8 (Codex T-240 F05): the history caps are by design (the newest CONVERSION_LIMITS.notes notes, diaryDays days, reviewWeeks weeks
 * and reviewMonths months), but what they leave behind is said in the result, not only in the popup's counts.
 */
export function conversionCappedItems(counts: ConversionCounts): ConversionLeftOutItem[] {
  const out: ConversionLeftOutItem[] = [];
  if (counts.notes > counts.notesCarried) out.push({ key: 'cap-notes', kind: 'note', title: `更早的 ${counts.notes - counts.notesCarried} 条聊天笔记`, reasons: ['capped'] });
  if (counts.diaryOlder) out.push({ key: 'cap-diary', kind: 'diary', title: `更早的 ${counts.diaryOlder} 天日记`, reasons: ['capped'] });
  if (counts.reviewsOlder) out.push({ key: 'cap-reviews', kind: 'review', title: `更早的 ${counts.reviewsOlder} 段回顾`, reasons: ['capped'] });
  return out;
}

/**
 * Fix 3, said exactly (fix 8, Codex T-240 F06): the new card asks the user once more what to call them (nicknameAsked starts over)
 * only when no nickname for the user is carried AND one was left for later: the stored nickname, or a form of address from her
 * memories set to 「先不带」. A carried nickname, or nothing left for later (the user may have said no before): it stays as it was.
 */
export function nicknameAskStartsOver(storedUserNickname: string | null | undefined, chosenUserNickname: string | null | undefined, aliasLeftForLater: boolean): boolean {
  return !chosenUserNickname && (!!storedUserNickname || aliasLeftForLater);
}

/** What prepare_character_conversion shows before anything starts (read only). */
export interface ConversionPreview {
  source: { id: string; name: string; language: CardLanguage };
  target: CardLanguage;
  /** Every name the user must decide (convert_character_language refuses until each has a choice). */
  names: ConversionName[];
  counts: ConversionCounts;
  copied: string[];
  notCopied: string[];
  voice: string;
  /** Per-character settings: what is carried to the new card and what stays off (shown in the popup). */
  settings: { carried: string[]; off: string[] };
  /** Model calls this will make on the user's own Claude Code (one long persona call + memory batches). */
  calls: number;
  cost: string;
  /**
   * The card's persona text, bounded (CONVERSION_PERSONA_EXCERPT_CHARS): the assistant reads it for proper nouns and nicknames the
   * local search missed and offers them as `extra` names. Data, never instructions.
   */
  persona: string;
  /** Fix 6: bounded names from her memories that are not offered above (data, not instructions); the assistant adds the real pet names and variants as `extra`. */
  candidates?: ConversionCandidate[];
}
export const CONVERSION_PERSONA_EXCERPT_CHARS = 6_000;

/** Fix 6: a name that is not offered yet, seen often in her memories (people lists) or quoted there; the assistant judges whether it is a pet name or a variant of one. */
export interface ConversionCandidate { text: string; uses: number; source: 'people' | 'quoted' }

export type ConversionStepId = 'backup' | 'read' | 'persona' | 'memories' | 'check' | 'save';
export const CONVERSION_STEPS: readonly ConversionStepId[] = ['backup', 'read', 'persona', 'memories', 'check', 'save'];
export const CONVERSION_STEP_LABELS: Readonly<Record<ConversionStepId, string>> = Object.freeze({
  backup: '先备份', read: '读她的记忆（只读）', persona: '翻译人设', memories: '翻译记忆', check: '检查新卡', save: '保存新角色',
});
export type ConversionStepStatus = 'waiting' | 'running' | 'done' | 'skipped';
export interface ConversionStep { id: ConversionStepId; status: ConversionStepStatus; done?: number; total?: number }

/**
 * Fix 5 (fourth test of the user's card): why a memory item was left out after its one re-ask (closed list, each said separately):
 * a name left for later came back, a name the user chose was not followed, source-language text remained (or the mark was copied),
 * a pet name was made up, or the answer never had the right shape.
 */
export type ConversionLeftOutReason = 'left-name' | 'name' | 'leftover' | 'invented' | 'format' | 'missing' | 'cut' | 'capped' | 'duplicate' | 'private' | 'no-room';
/**
 * Fix 8 (Codex T-240 F04/F05): besides the items a re-ask could not fix, what came back missing or cut, what the stores refuse, what
 * the history caps left behind and a voice binding with no room are said too (never silently dropped). Only the first five are
 * translation failures (they count toward the one-in-ten stop); the others never stop a conversion.
 */
export const CONVERSION_LEFT_OUT_REASONS: readonly ConversionLeftOutReason[] = ['left-name', 'name', 'leftover', 'invented', 'format', 'missing', 'cut', 'capped', 'duplicate', 'private', 'no-room'];
export const CONVERSION_FAILURE_REASONS: readonly ConversionLeftOutReason[] = ['left-name', 'name', 'leftover', 'invented', 'format'];
export const CONVERSION_LEFT_OUT_REASON_LABELS: Readonly<Record<ConversionLeftOutReason, string>> = Object.freeze({
  'left-name': '又写出了先不带的名字',
  name: '没按你选的译名写（名字或称呼和你选的不一致）',
  leftover: '还留着原来语言的字',
  invented: '像是自己编了一个昵称或爱称',
  format: '两次都没有对上格式',
  missing: '翻回来是空的或少了，这部分没有带',
  cut: '翻得太长，被截短了，后面没有带',
  capped: '超出这次带过去的范围（设计如此），没有带',
  duplicate: '和另一条重复，只带了一条',
  private: '看起来像密码、密钥或文件路径，画像不收',
  'no-room': '朗读设置已经满 64 条，为了不挤掉别的角色的，新卡的没有加',
});
/** One item that was not carried, or not whole: its plain title (a note's title, a diary day…), never its text. */
export const CONVERSION_LEFT_OUT_KINDS = ['note', 'diary', 'review', 'profile', 'voice', 'persona'] as const;
export interface ConversionLeftOutItem { key: string; kind: (typeof CONVERSION_LEFT_OUT_KINDS)[number]; title: string; reasons: ConversionLeftOutReason[] }
/** At most this many left-out items are listed by title (more are counted only). */
export const MAX_LEFT_OUT_LISTED = 20;

export type ConversionJobState = 'running' | 'done' | 'failed' | 'cancelled';
export interface ConversionJobView {
  id: string;
  sourceId: string; sourceName: string; target: CardLanguage;
  state: ConversionJobState;
  steps: ConversionStep[];
  startedAt: number; finishedAt?: number;
  /** Once saving began a cancel no longer applies. */
  cancellable: boolean;
  newCardId?: string; newName?: string;
  /** Import-check reminders on the new card (never stop it). */
  lint?: string[];
  /** A failure's fixed message (never a stack, a path or a memory). */
  error?: string;
  /** What was carried, for the result line. */
  carried?: { notes: number; profileEntries: number; diaryDays: number; reviews?: number; voice: string; recording?: boolean };
  /** Fix 5: memory items not carried (titles and reasons only; the first MAX_LEFT_OUT_LISTED), and how many there were in all. */
  leftOut?: { title: string; kind: ConversionLeftOutItem['kind']; reasons: ConversionLeftOutReason[] }[];
  leftOutCount?: number;
}

/** Fix 5: one plain line per left-out item for the result ("「title」：reason、reason"). */
export function leftOutLines(job: Pick<ConversionJobView, 'leftOut'>): string[] {
  return (job.leftOut ?? []).map(item => `「${item.title}」：${item.reasons.map(reason => CONVERSION_LEFT_OUT_REASON_LABELS[reason]).join('、')}`);
}
/** Fix 8: every listed item is a translation failure (else the list also holds what came back missing or cut, a cap, a binding…). */
export const leftOutAllFailures = (job: Pick<ConversionJobView, 'leftOut'>): boolean =>
  (job.leftOut ?? []).every(item => item.reasons.every(reason => CONVERSION_FAILURE_REASONS.includes(reason)));
/** Fix 5: the counts by reason, without titles (the external channel and the assistant's transcript). */
export function leftOutSummary(job: Pick<ConversionJobView, 'leftOut' | 'leftOutCount'>): string {
  const count = job.leftOutCount ?? job.leftOut?.length ?? 0;
  if (!count) return '';
  const counts = CONVERSION_LEFT_OUT_REASONS.map(reason => [reason, (job.leftOut ?? []).filter(item => item.reasons.includes(reason)).length] as const).filter(([, n]) => n);
  const by = counts.map(([reason, n]) => `${n} 条${CONVERSION_LEFT_OUT_REASON_LABELS[reason]}`).join('；');
  return leftOutAllFailures(job) ? `有 ${count} 条记忆重问一次还是翻得不合格，没有带过去（${by}）` : `有 ${count} 项没有完整带过去（${by}）`;
}

export function conversionTargetOf(language: CardLanguage): CardLanguage { return language === 'en' ? 'zh-CN' : 'en'; }

/** The names to decide for this card and relationship, in a fixed order; empty ones are left out. */
export function conversionNames(card: { name: string }, relationship: { nickname: string | null; herNickname: string | null } | null,
  aliases: readonly { text: string; uses: number; refers?: ConversionReferent | null }[] = [], terms: readonly { text: string; uses: number }[] = []): ConversionName[] {
  const names: ConversionName[] = [{ id: 'her-name', label: CONVERSION_NAME_LABELS['her-name'], text: card.name }];
  if (relationship?.herNickname) names.push({ id: 'her-nickname', label: CONVERSION_NAME_LABELS['her-nickname'], text: relationship.herNickname });
  if (relationship?.nickname) names.push({ id: 'user-nickname', label: CONVERSION_NAME_LABELS['user-nickname'], text: relationship.nickname });
  aliases.slice(0, MAX_CONVERSION_ALIASES).forEach((alias, index) => names.push({ id: `alias-${index + 1}` as ConversionAliasId, label: CONVERSION_ALIAS_LABEL, text: alias.text, uses: alias.uses, ...(alias.refers ? { refers: alias.refers } : {}) }));
  terms.slice(0, MAX_CONVERSION_TERMS).forEach((term, index) => names.push({ id: `term-${index + 1}` as ConversionTermId, label: CONVERSION_TERM_LABEL, text: term.text, uses: term.uses }));
  return names;
}

export interface ConversionRequest { characterId: string; language: CardLanguage; names: ConversionNameChoice[]; /** Names the assistant found and the user decided (absent = none). */ extra?: ConversionExtraName[] }

const CONTROL = /[\u0000-\u001f\u007f]/u;
/** Strict shape of convert_character_language's arguments (no userWords here: the registry takes it out first). */
export function validateConversionRequest(raw: unknown): ConversionRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数必须是一个对象。');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['characterId', 'language', 'names', 'extra'].includes(key))) throw new Error('只接受 characterId、language、names 和 extra。');
  if (typeof input.characterId !== 'string' || !input.characterId || input.characterId.length > 256 || CONTROL.test(input.characterId)) throw new Error('characterId 不正确。');
  if (input.language !== 'en' && input.language !== 'zh-CN') throw new Error('language 只能是 en 或 zh-CN。');
  const extra = validateExtraNames(input.extra);
  if (!Array.isArray(input.names) || input.names.length > 3 + MAX_CONVERSION_ALIASES + MAX_CONVERSION_TERMS) throw new Error(`names 是每个名字的选择（最多 ${3 + MAX_CONVERSION_ALIASES + MAX_CONVERSION_TERMS} 个）。`);
  const names: ConversionNameChoice[] = [];
  for (const item of input.names) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'id' && key !== 'to' && key !== 'ignore')) throw new Error('names 里每一项只有 id、to 和（称呼才有的）ignore。');
    const { id, to, ignore } = item as Record<string, unknown>;
    if (ignore !== undefined && ignore !== true) throw new Error('ignore 只能是 true（这个称呼不是名字）。');
    if (typeof id !== 'string' || (id !== 'her-name' && id !== 'her-nickname' && id !== 'user-nickname' && !isAlias(id) && !isTerm(id))) throw new Error('names 的 id 只能是 her-name、her-nickname、user-nickname、alias-1…alias-6 或 term-1…term-6。');
    if (names.some(name => name.id === id)) throw new Error('names 里每个 id 只能出现一次。');
    if (typeof to !== 'string') throw new Error('to 是用户选的名字（原样保留就填原来的名字）。');
    names.push({ id, to, ...(ignore === true && typeof id === 'string' && (isAlias(id) || isTerm(id)) ? { ignore: true } : {}) });
  }
  return { characterId: input.characterId, language: input.language, names, ...(extra.length ? { extra } : {}) };
}

/** `extra`'s shape: at most MAX_CONVERSION_EXTRA plain from/to pairs, each `from` once. Where they occur is checked by the host. */
function validateExtraNames(raw: unknown): ConversionExtraName[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CONVERSION_EXTRA) throw new Error(`extra 是你在人设里找到的名字（最多 ${MAX_CONVERSION_EXTRA} 个）。`);
  const out: ConversionExtraName[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'kind' && key !== 'from' && key !== 'to' && key !== 'by')) throw new Error('extra 里每一项只有 kind、from、to 和 by。');
    const { kind, from, to, by } = item as Record<string, unknown>;
    if (by !== undefined && by !== 'user' && by !== 'assistant') throw new Error('extra 的 by 只能是 user（用户自己补的）或 assistant（你在人设里找到的）。');
    if (kind !== 'term' && kind !== 'alias') throw new Error('extra 的 kind 只能是 term（专有名词）或 alias（称呼）。');
    const text = cleanExtraFrom(from);
    if (!text) throw new Error('extra 的 from 是卡里的原词：1～24 个字，一行，不带链接、路径或符号。');
    if (out.some(other => other.from.toLocaleLowerCase() === text.toLocaleLowerCase())) throw new Error('extra 里每个原词只能出现一次。');
    if (typeof to !== 'string') throw new Error('extra 的 to 是用户选的译名（保留就填原词）。');
    if (kind === 'term' && !cleanTerm(to)) throw new Error(`「${text}」的译名要 1～40 个字（保留就填原词）；用户说它不是专有名词就不要放进 extra。`);
    if (kind === 'alias' && to.trim() && !cleanNickname(to)) throw new Error(`「${text}」换成的称呼不能用：最多 8 个字；先不带就填空。`);
    out.push({ kind, from: text, to: kind === 'term' ? cleanTerm(to)! : to.trim() ? cleanNickname(to)! : '', ...(by ? { by: by as ConversionExtraBy } : {}) });
  }
  return out;
}

/**
 * Fix 6 (sixth test: the assistant once marked a term it found itself as "你补的"): only the user's own words can set `by:"user"`.
 * Run on the arguments of convert_character_language before the tool sees them: an item stays `by:"user"` only when its original
 * word occurs in something the user typed in this conversation (`userTexts`: their messages, minus the labels of buttons the
 * assistant offered); every other item, with or without a `by`, is the assistant's own find. Anything that is not the expected
 * shape is left alone for the tool's own validation to refuse.
 */
export function enforceExtraBy(args: unknown, userTexts: readonly string[]): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const extra = (args as { extra?: unknown }).extra;
  if (!Array.isArray(extra)) return args;
  const typed = userTexts.map(text => text.normalize('NFKC').toLocaleLowerCase());
  return { ...(args as object), extra: extra.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const from = typeof (item as { from?: unknown }).from === 'string' ? (item as { from: string }).from.normalize('NFKC').trim().toLocaleLowerCase() : '';
    // The host decides from the evidence, both ways: the user's own words hold the name -> the user's addition, whatever the model
    // claimed; otherwise the assistant's find (a model claim of `user` without evidence is the downgrade).
    const byUser = !!from && typed.some(text => typedName(text, from));
    return { ...(item as object), by: byUser ? 'user' : 'assistant' };
  }) };
}

const HAN_AT = /\p{Script=Han}/u;
/** A particle that may follow a name the user typed ("叫她小橙吧"); any other Han character continues a longer word ("小橙子"). */
const NAME_TAIL = /^[吧呀啊吗嘛呢了哦啦哈呗~～]/u;
/** Before a name the user is giving: 叫 / 喊 / 叫做 / 就叫 / 改成 (+ 她/我/你/他), or a list going on after a quoted one (和 / 、 / 跟 / 还有). */
const NAME_LEAD = /(?:(?:叫做|就叫|改成|叫|喊)(?:她|我|你|他)?[:：]?|[和、跟]|还有)\s*$/u;
/**
 * Fix 8 (Codex T-240): did the user type `name` (folded) as a name, not as a piece of a longer word? A Latin name: a whole word,
 * any case ("May" is not in "Maybe later"). A Chinese one: it ends where a word ends (the end, a non-Han character or a particle) and
 * it stands alone (the start or a non-Han character before it), is quoted, follows 叫/喊/叫做/就叫/改成 or a list word, or the message
 * is short and mostly the name.
 */
function typedName(typed: string, name: string): boolean {
  if (/^[a-z0-9]/u.test(name)) return new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(typed);
  const letters = Array.from(typed.replace(/[\s\p{P}\p{S}]/gu, '')).length;
  for (let at = typed.indexOf(name); at >= 0; at = typed.indexOf(name, at + 1)) {
    const before = typed.slice(0, at), after = typed.slice(at + name.length);
    if (HAN_AT.test(after[0] ?? '') && !NAME_TAIL.test(after)) continue; // a longer word: 小橙子, 小橙色
    const alone = !HAN_AT.test(before.slice(-1));
    const quoted = /[「“"『'‘]\s*$/u.test(before) && /^\s*[」”"』'’]/u.test(after);
    const mostly = letters <= Array.from(name).length + 4 && Array.from(name).length * 2 >= letters;
    if (alone || quoted || NAME_LEAD.test(before) || mostly) return true;
  }
  return false;
}

/**
 * The host's check of `extra` against the source: each `from` must occur in the card's persona or her memories (`corpus`), must
 * not repeat a name the preview already lists. Fix 4: extra names have caps of their own (MAX_CONVERSION_EXTRA_ALIASES / _TERMS), so a
 * name the user adds is never refused because the found ones filled theirs.
 */
export function checkConversionExtra(listed: readonly ConversionName[], extra: readonly ConversionExtraName[], corpus: string, persona?: string): ConversionExtraName[] {
  const lowered = corpus.toLocaleLowerCase();
  for (const item of extra) {
    if (!lowered.includes(item.from.toLocaleLowerCase())) throw new Error(`「${item.from}」在这张卡的人设和她的记忆里都没有出现，不能加。`);
    if (listed.some(name => name.text.toLocaleLowerCase() === item.from.toLocaleLowerCase())) throw new Error(`「${item.from}」已经在 names 里了，选一次就够。`);
  }
  if (extra.filter(item => item.kind === 'term').length > MAX_CONVERSION_EXTRA_TERMS) throw new Error(`另外加的专有名词最多 ${MAX_CONVERSION_EXTRA_TERMS} 个，挑最重要的。`);
  if (extra.filter(item => item.kind === 'alias').length > MAX_CONVERSION_EXTRA_ALIASES) throw new Error(`另外加的称呼最多 ${MAX_CONVERSION_EXTRA_ALIASES} 个，挑最常用的。`);
  // The source of a find the assistant made: the persona's own text, or else her notes and memories (said so in the popup).
  const personaText = persona?.toLocaleLowerCase();
  return extra.map(item => ({ ...item, ...(item.by === 'assistant' && personaText !== undefined && !personaText.includes(item.from.toLocaleLowerCase()) ? { by: 'assistant-memory' as const } : {}) }));
}

/**
 * Each name the preview listed must have the user's choice; the result is clean (a nickname by the relationship's own rule,
 * her name as a card name). Throws a fixed message naming what is missing or wrong.
 */
export function resolveConversionNames(listed: readonly ConversionName[], chosen: readonly ConversionNameChoice[]): Record<ConversionNameRole, string | null> {
  const out: Record<ConversionNameRole, string | null> = { 'her-name': null, 'her-nickname': null, 'user-nickname': null };
  for (const choice of chosen) if (!listed.some(name => name.id === choice.id)) throw new Error(`没有「${isAlias(choice.id) ? CONVERSION_ALIAS_LABEL : isTerm(choice.id) ? CONVERSION_TERM_LABEL : CONVERSION_NAME_LABELS[choice.id]}」可以选（没有这一项）。`);
  for (const name of listed) {
    const choice = chosen.find(item => item.id === name.id);
    if (!choice) throw new Error(`「${name.label}」（${name.text}）还没选：保留原样、换成建议的，还是用户自己打一个？每个名字都要用户选过才能开始。`);
    if (isTerm(name.id)) {
      if (!choice.ignore && !cleanTerm(choice.to)) throw new Error(`「${name.text}」要保留、换成建议的、自己打一个（1～40 个字），或选「忽略」（它不是专有名词）。`);
    } else if (isAlias(name.id)) {
      if (!choice.ignore && choice.to.trim() && !cleanNickname(choice.to)) throw new Error(`「${name.text}」换成的称呼不能用：最多 8 个字（英文按字母算），不能带引号、链接或奇怪的符号；先不带就填空，不是称呼就选「忽略」。`);
    } else if (name.id === 'her-name') {
      const text = choice.to.normalize('NFKC').replace(/\s+/gu, ' ').trim();
      if (!text || Array.from(text).length > 40 || CONTROL.test(text)) throw new Error('新卡的名字要 1～40 个字。');
      out['her-name'] = text;
    } else if (!choice.to.trim()) {
      out[name.id] = null; // 先不带，以后在聊天里起: the new card has no nickname for this role
    } else {
      const text = cleanNickname(choice.to);
      if (!text) throw new Error(`「${name.label}」不能用这个：昵称最多 8 个字（英文按字母算），不能带引号、链接或奇怪的符号。`);
      out[name.id] = text;
    }
  }
  return out;
}

/** The chosen translations of the forms of address found in her memories, for the glossary ("" = left unset; ignored ones are left out). */
export type ResolvedAlias = { from: string; to: string; kind?: 'term'; refers?: ConversionReferent };
export function resolveConversionAliases(listed: readonly ConversionName[], chosen: readonly ConversionNameChoice[], extra: readonly ConversionExtraName[] = []): ResolvedAlias[] {
  const out: ResolvedAlias[] = [];
  for (const name of listed) {
    if (!isAlias(name.id) && !isTerm(name.id)) continue;
    const choice = chosen.find(item => item.id === name.id);
    if (!choice || choice.ignore) continue;
    if (isTerm(name.id)) out.push({ from: name.text, to: cleanTerm(choice.to) ?? name.text, kind: 'term' });
    else out.push({ from: name.text, to: choice.to.trim() ? cleanNickname(choice.to) ?? '' : '', ...(name.refers ? { refers: name.refers } : {}) });
  }
  for (const item of extra) out.push(item.kind === 'term' ? { from: item.from, to: item.to, kind: 'term' } : { from: item.from, to: item.to });
  return out;
}

/**
 * The fixed cost line. Uses the user's own Claude Code; no extra money. Fix 4: the planned number is exact
 * (the assistant said "about 3", it was 4 with one re-ask): one persona call and one per memory batch; a call whose answer is not
 * usable is asked once more, so the most it can be is twice that.
 */
export function conversionCostText(calls: number, model: string, effort: string): string {
  const memory = Math.max(0, calls - 1);
  return `会用你自己的 ${ASSISTANT_CLI_NAME}（${model}，思考强度${effort === 'low' ? '低' : effort === 'high' ? '高' : '中'}）：一共 ${calls} 次调用（人设 1 次${memory ? `、记忆 ${memory} 次` : ''}）；`
    + `哪一次翻得不合格会重问一次，每次多 1 次，最多一共 ${calls * 2} 次。算在你的套餐额度里，不另外花钱。大约要几分钟，可以随时取消。`;
}

/**
 * Fix 4: what the assistant shows first, before it asks any name (the first turn of the third test asked a name first and gave the
 * cost a turn later, as "about 3"). Plain text written here from the preview, never by the model.
 */
export function conversionIntroText(preview: Pick<ConversionPreview, 'source' | 'target' | 'copied' | 'notCopied' | 'cost'>): string {
  return [
    `会新建一个${CONVERSION_TARGET_LABELS[preview.target]}角色，原来的「${preview.source.name}」一个字都不动，之后两边记忆不同步。`,
    `带过去（翻译后复制一次）：${preview.copied.join('；')}。`,
    `不带：${preview.notCopied.join('；')}。`,
    `额度：${preview.cost}`,
  ].join('\n');
}

/** Fix 5: the field of prepare's result that asks the model to show `intro` first (the Claude 助手 shows it itself and drops it). */
export const CONVERSION_INTRO_NEXT_KEY = 'introNext';

export const CONVERSION_NOT_COPIED: readonly string[] = Object.freeze([
  '原始聊天记录（太长，翻译太费额度）',
  '心情数值（新角色从自己的基线开始）',
  '按心情反应细调、她的反应倾向、贴图和动作细调（新卡用默认的，可以在角色页再调）',
  '“更真实的情绪”开关（要你在新卡上自己同意一次）',
  '你说过的带时间的打算（用户画像里的“她记得的事”）',
]);

export function conversionCopiedLines(counts: ConversionCounts, target: CardLanguage): string[] {
  const language = target === 'en' ? '英文' : '中文';
  return [
    `人设：按意思翻成${language}（不逐字，不用原作台词），之后跑一遍导入自查`,
    `聊天笔记（她整理的聊天要点）：${counts.notesCarried} 条${counts.notes > counts.notesCarried ? `（共 ${counts.notes} 条，带最近的 ${counts.notesCarried} 条）` : ''}，翻成${language}`,
    `你的画像：${counts.profileEntries} 条，翻成${language}`,
    `最近 ${CONVERSION_LIMITS.diaryDays} 天的日记：${counts.diaryDays} 天（含只属于你们的梗 ${counts.memes} 个），翻成${language}`,
    ...(counts.reviews ? [`她写的每周、每月回顾：最近的 ${counts.reviews} 段，翻成${language}`] : []),
    `认识的天数和熟悉度：${counts.knownDays} 天${counts.metDate ? `（${counts.metDate} 认识）` : ''}，原样带过去`,
    // Fix 5: no "昵称：按你的选择" line (each nickname has its own line right below it in the popup).
    '模型：和原来一样',
  ];
}

/**
 * Fix 8 (Codex T-240 F07): where 「允许记录」 for the new card really comes from. Since 2026-11-07 it is one switch shared by every
 * character (the user's last choice, `user-profiles/recording.json`): when the user has chosen it, that choice decides and the
 * conversion carries nothing of its own. Only when it was never chosen does each card's own marker decide: then the new card gets
 * the marker of the profile that is carried (the current connection's, or, when that one is empty and off, the one changed last).
 */
export interface ConversionRecordingSource { global?: boolean | null; otherConnection?: boolean }
const PERMISSIONS_OFF = '“更真实的情绪”、屏幕、摄像头、麦克风、付费朗读等授权：不带，要你在新卡上或全局设置里自己同意';
/** What the popup says about the per-character settings: what is carried and what stays off. */
export function conversionSettingsLines(recording: boolean, source: ConversionRecordingSource = {}): { carried: string[]; off: string[] } {
  if (typeof source.global === 'boolean') return source.global
    ? { carried: ['「允许记录」：原来开着，新卡也开着——这是所有角色共用的一个开关（跟着你最后一次的选择），转换不改它'], off: [PERMISSIONS_OFF] }
    : { carried: [], off: ['「允许记录」：这是所有角色共用的一个开关（跟着你最后一次的选择），现在关着，新卡也关着。带过去的画像和日记在打开之前不会被用到；想用要在用户画像里自己打开', PERMISSIONS_OFF] };
  const which = source.otherConnection ? '（按带过去的那份画像：当前连接没有画像，用的是之前用过的另一个连接的）' : '';
  return recording
    ? { carried: [`「允许记录」：原来开着，新卡也开着${which}（带过去的画像和日记要靠它才会被用到，她也才会继续写新的日记）`], off: [PERMISSIONS_OFF] }
    : { carried: [],
      off: [`「允许记录」：原来就关着，新卡也关着${which}。带过去的画像和日记在打开之前不会被用到，也不会写新的日记；想用要在用户画像里自己打开`, PERMISSIONS_OFF] };
}

/** True when the card can be converted to `target` (its own language differs). */
export function canConvert(card: { language?: unknown }, target: CardLanguage): boolean { return cardLanguageOf(card) !== target; }
