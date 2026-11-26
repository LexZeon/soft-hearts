// I-071 v2 第三步 转换 (fix after the isolated test): forms of address that live only in her notes, diary and profile (a pet name
// the user says often, never stored as a nickname) used to be translated differently in every memory batch. They are found here,
// locally (no model call), and offered to the user in the same name-choice step as the stored nicknames, so the one glossary
// that goes to every call also covers them. Heuristic on purpose: it can miss one or suggest a word that is not a name; the user
// can say "this is not a name" for any of them.
// Fix 3 (user's card retest): a pet name used as a subject ("X说……") has no "叫你" in front of it, so the notes' own `people` lists
// (written by Claude when each note was made) are a main source now: a person named often across her notes, diary and profile is
// offered too. Proper nouns the patterns below find are only offered when the notes also name them (looksLikeName); the Claude
// 助手 reads the persona itself and proposes the rest (ConversionExtraName).
// Fix 4 (third test of the user's card): a film character from the notes' people lists was offered as a form of address and took
// one of the few slots. A people-list name is offered only with evidence that her memories use it to address or name someone
// (addressEvidence); and who a name refers to (the user or her) is read from the same evidence (addressReferent), so a name left
// for later can be replaced by a plain reference before any translation call (translate.ts).
import { MAX_CONVERSION_ALIASES, MAX_CONVERSION_TERMS, type ConversionCandidate, type ConversionReferent } from '../../../shared/cards/character-convert';

export interface AddressForm { text: string; uses: number; /** Who it names, when her memories show it. */ refers?: ConversionReferent }

// ---- Fix 4: how a name is used --------------------------------------------------------------------------------------------------
const Q_OPEN = '[「“"『\'‘]', Q_CLOSE = '[」”"』\'’]';
/** Right before a name that is being given or used as a name: "叫你「X", "叫她X", "小名X", "昵称是X", "calls me X", "nickname X". */
const NAMING_BEFORE = new RegExp(`(?:(?:叫|喊|唤作|唤|称呼)(?:着|过)?(?:你|我|她|他|用户|人家)(?:为|做|作|叫)?${Q_OPEN}?|(?:叫|喊|称呼)${Q_OPEN}|(?:小名|昵称|外号|爱称|绰号)(?:是|叫|为|叫做)?[：:]?${Q_OPEN}?`
  + `|\\bcall(?:s|ed|ing)?\\s+(?:you|me|her|him|the user)\\s+(?:by\\s+)?["'“‘]?|\\b(?:nickname|pet name)\\s+(?:is\\s+|was\\s+)?["'“‘]?)$`, 'iu');
/** Right after one: "X」这个称呼", "X是她的小名", "X as a nickname". */
const NAMING_AFTER = new RegExp(`^(?:${Q_CLOSE}?(?:这个|这种|是(?:她|我|你|他|用户)的)?(?:称呼|昵称|小名|外号|爱称|叫法)|["'”’]?\\s*(?:as (?:a|her|his|my|your) )?(?:nickname|pet name))`, 'iu');
/** Who is being named, from the words before the name: 我/她 (her, in her diary and notes), 他/用户 (the user); 你 is unclear. */
const WHO_BEFORE = /(?:(?:叫|喊|唤作|唤|称呼)(?:着|过)?(你|我|她|他|用户|人家)|(你|我|她|他|用户)的(?:小名|昵称|外号|爱称|绰号)|给(你|我|她|他|用户)起了?(?:个|一个)?(?:小名|昵称|外号|爱称|绰号)|\bcall(?:s|ed|ing)?\s+(you|me|her|him|the user))/giu;
const WHO_AFTER = /^[」”"』'’]?是(你|我|她|他|用户)的(?:小名|昵称|外号|爱称|绰号)/u;
const referentOf = (word: string): ConversionReferent | null => /^(?:我|她|人家|me|her)$/iu.test(word) ? 'her' : /^(?:他|用户|him|the user)$/iu.test(word) ? 'user' : null;
/** A name merely mentioned as someone in a work or a public person: "电影里的X", "X（漫威角色）", "X这个反派", "the movie character X". */
const MENTION_BEFORE = /(?:(?:电影|影片|电视剧|剧|游戏|手游|动画|动漫|番剧|漫画|小说|漫威)(?:里|中|里面)?的?|(?:明星|歌手|演员|偶像|主播|作家|角色)|\b(?:movie|film|game|anime|manga|show|series|novel|actor|actress|singer|celebrity|character)\s+)$/iu;
const MENTION_AFTER = /^(?:[（(][^）)]{0,12}(?:角色|电影|游戏|动漫|漫画|明星|歌手|演员|character|movie|game|actor|singer)|(?:这个|是(?:个|一个)?)?(?:电影|游戏|动漫|漫画)?(?:角色|反派|主角|英雄|人物)|\s+(?:from|in)\s+(?:the\s+|a\s+)?(?:movie|film|game|anime|show|series|novel))/iu;
/** A clause that starts with the name doing or saying something ("X说……", "X又……", "X said …"). */
const SUBJECT_AFTER = /^(?:说|问|想|觉得|告诉|让|给|带|喜欢|要|又|也|还|今天|昨天|刚|很|最近|和我|跟我|叫|夸|抱|亲|喊|在|会|就|总|老是|一直|突然|居然|答应|陪|帮|请|\s+(?:said|asked|told|says|asks|tells|wants|wanted|likes|liked|thinks|thought|went|came|got|loves|called|calls)\b)/iu;
const CLAUSE_START = /(?:^|[，。！？；：、\n「“"'（(,.!?;:]\s*)$/u;

interface Occurrence { before: string; after: string }
function occurrences(name: string, text: string): Occurrence[] {
  const out: Occurrence[] = [], lowered = text.toLocaleLowerCase(), needle = name.toLocaleLowerCase(), latin = /^[A-Za-z]/u.test(name);
  for (let at = lowered.indexOf(needle); at >= 0; at = lowered.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    if (latin && (/[A-Za-z]/u.test(text[at - 1] ?? '') || /[A-Za-z]/u.test(text[end] ?? ''))) continue; // a Latin name is a whole word
    out.push({ before: text.slice(Math.max(0, at - 20), at), after: text.slice(end, end + 20) });
  }
  return out;
}
/** Calling someone by it in a quoted line: "「X，……", "“X！", "……，X~」" (an address, so the mark: "Good night, the user" reads wrong). */
const vocative = (o: Occurrence) => (/[「“"‘]\s*$/u.test(o.before) && /^\s*[，,！!~～？?]/u.test(o.after)) || (/[，,]\s*$/u.test(o.before) && /^\s*[！!~～]?\s*[」”"’]/u.test(o.after));
const naming = (o: Occurrence) => NAMING_BEFORE.test(o.before) || NAMING_AFTER.test(o.after) || vocative(o);
const mention = (o: Occurrence) => MENTION_BEFORE.test(o.before) || MENTION_AFTER.test(o.after);

// ---- Fix 5: a name being called out ---------------------------------------------------------------------------------------------
// The fourth test of the user's card: "连叫多声“X”" and "逗她叫X" (X her pet name, left for later) were replaced by her own name,
// so the memory said the user "called Phoenix many times". Where a name is what someone calls out, it is the name itself that the
// sentence is about: the neutral mark, not the referent. Used for that replacement only (addressEvidence keeps the narrower rule,
// so these do not make more names into offered forms of address).
/** Right before a called-out name: 叫 / 喊 / 唤 (叫做, 称为…), an optional count (了多声, 几遍, 一句), an optional opening quote. */
const CALLING_BEFORE = new RegExp(`(?:(?:叫做|叫作|称作|称为|唤作|叫|喊|唤|嚷)(?:了|过|着)?(?:[一两二三四五六七八九十几多好百]+|\\d+)?(?:声|遍|句|下|回|次)?${Q_OPEN}?`
  + `|\\b(?:call(?:s|ed|ing)?|yell(?:s|ed|ing)?|shout(?:s|ed|ing)?)(?:\\s+out)?(?:\\s+(?:you|me|her|him|the user|them))?(?:\\s+by)?\\s*["'“‘]?)$`, 'iu');
/** The name standing alone in quotes ("“X”"): the word itself is meant. */
const quotedAlone = (o: Occurrence) => /[「“"‘『]\s*$/u.test(o.before) && /^\s*[」”"’』]/u.test(o.after);
const calling = (o: Occurrence) => CALLING_BEFORE.test(o.before) || quotedAlone(o);

/**
 * True when the name is given, used or called out as a name where it stands ("叫她X", "小名X", "calls me X", "X这个称呼"; fix 5:
 * "连叫多声“X”", "逗她叫X", "called out X", "“X”" on its own): then it is replaced by the neutral mark, never by whom it names.
 */
export function inNamingContext(name: string, before: string, after: string): boolean { const o = { before, after }; return naming(o) || calling(o); }

/**
 * Evidence that her memories use `name` to address or name someone, not merely mention it: a naming context anywhere ("叫你X",
 * "小名X", "X这个称呼", "calls me X"), or, when it is never marked as a character of a work or a public person, a clause that
 * starts with it doing or saying something in at least two separate texts ("X说……" in two notes). Conservative and documented: a
 * pet name used only once or twice as a subject is missed (the assistant and the user can still add it).
 */
export function addressEvidence(name: string, texts: readonly string[]): boolean { return addressEvidenceAcross([name], texts); }

/**
 * I-088: the same evidence rules (naming context anywhere; else never a mention, and a subject clause in two texts) read over all
 * the names one person goes by in her notes ("小明" in one note, "明哥" in another): the evidence of each adds up, the veto of a
 * mention stays (any of them marked as a character of a work or a public person means none of it counts).
 */
export function addressEvidenceAcross(names: readonly string[], texts: readonly string[]): boolean {
  const all = names.flatMap(name => texts.flatMap(text => occurrences(name, text)));
  if (all.some(naming)) return true;
  if (all.some(mention)) return false;
  return texts.filter(text => names.some(name => occurrences(name, text).some(o => CLAUSE_START.test(o.before) && SUBJECT_AFTER.test(o.after)))).length >= 2;
}

/**
 * Who `name` refers to, when the words around it say so: "叫她X" / "我的小名X" / "calls me X" (her; her notes speak of her as 她, her
 * diary as 我) or "叫用户X" / "他的外号X" / "calls him X" (the user). Both, or neither: null (unclear).
 */
export function addressReferent(name: string, texts: readonly string[]): ConversionReferent | null {
  const seen = new Set<ConversionReferent>();
  for (const text of texts) for (const o of occurrences(name, text)) {
    const window = o.before.slice(-12);
    let last: RegExpExecArray | null = null;
    for (const match of window.matchAll(WHO_BEFORE)) if (match.index! + match[0].length >= window.length - 3) last = match as RegExpExecArray;
    const word = last ? last.slice(1).find(Boolean) : WHO_AFTER.exec(o.after)?.[1];
    const who = word ? referentOf(word) : null;
    if (who) seen.add(who);
  }
  return seen.size === 1 ? [...seen][0]! : null;
}

const OPEN = '「“"『\'‘', CLOSE = '」”"』\'’';
const ZH_VERB = '(?:叫|喊|唤作|唤|称呼)(?:着|过)?(?:你|我|她|他|用户)(?:为|做|作|叫)?';
const ZH_QUOTED = new RegExp(`${ZH_VERB}[${OPEN}]([^${CLOSE}\\n]{1,8})[${CLOSE}]`, 'gu');
const ZH_PLAIN = new RegExp(`${ZH_VERB}([\\u4e00-\\u9fff]{2,4})`, 'gu');
const PARTICLE = /[啦呀吧的了啊哦嘛呢哈哟]$/u;
const ZH_LEXICON = /(?:小|大)?(?:宝宝|宝贝|笨蛋|傻瓜|乖乖|小可爱|亲爱的|崽崽|团子)/gu;
const EN_VERB = '\\bcall(?:s|ed|ing)?\\s+(?:you|me|her|him|the user)\\s+(?:by\\s+)?';
const EN_QUOTED = new RegExp(`${EN_VERB}[${OPEN}]([^${CLOSE}\\n]{1,16})[${CLOSE}]`, 'giu');
const EN_PLAIN = new RegExp(`${EN_VERB}([A-Z][A-Za-z-]{1,15})\\b`, 'gu');
const EN_LEXICON = /\b(?:sweetie|sweetheart|darling|honey|babe|buddy|goofball|dummy|princess)\b/giu;

const MIN_EXPLICIT = 2, MIN_PLAIN = 3, MIN_LEXICON = 3, MIN_PERSON = 3, MAX_CHARS = 8;
/** People in a note that are roles, not names (they translate as ordinary words). */
const GENERIC_PEOPLE = new Set(['用户', '我', '你', '她', '他', '它', '自己', '大家', '别人', '朋友', '朋友们', '好朋友', '同学', '同事', '老师', '老板', '领导', '家人', '家里人',
  '妈妈', '爸爸', '母亲', '父亲', '哥哥', '姐姐', '弟弟', '妹妹', '奶奶', '爷爷', '外婆', '外公', '姥姥', '姥爷', '室友', '男朋友', '女朋友', '对象', '医生', '店员', '网友',
  '陌生人', '邻居', '孩子', '猫', '狗', '小猫', '小狗', '猫咪', '狗狗', 'user', 'the user', 'me', 'you', 'her', 'him', 'she', 'he', 'friend', 'friends', 'mom', 'dad', 'mother',
  'father', 'brother', 'sister', 'boss', 'teacher', 'coworker', 'colleague', 'roommate', 'boyfriend', 'girlfriend', 'doctor', 'family', 'cat', 'dog']);
/** Fix 8: a role word ("用户", "朋友", "the user"…), never a name of its own (variants.ts keeps it out of a left-out name's forms). */
export const isRoleWord = (text: string): boolean => GENERIC_PEOPLE.has(text.normalize('NFKC').trim().toLocaleLowerCase());
/** A note's people entry that can be a name: not a role, not "the user's X". */
function personName(raw: string): string | null {
  const text = raw.normalize('NFKC').trim();
  return !text || GENERIC_PEOPLE.has(text.toLocaleLowerCase()) || /的|'s\b|^用户|^the user/iu.test(text) ? null : text;
}

const key = (text: string) => text.toLocaleLowerCase();
const count = (haystack: string, needle: string): number => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
};

/**
 * The forms of address that show up often in `texts`, most frequent first (at most MAX_CONVERSION_ALIASES). `known` are the names
 * that are already decided or stored (her name, the two nicknames): they and anything built from them are left out.
 */
export function findAddressForms(texts: readonly string[], known: readonly string[], people: readonly string[] = [],
  aliasGroups: readonly (readonly string[])[] = []): AddressForm[] {
  const all = texts.join('\n');
  const found = new Map<string, { text: string; min: number; explicit: number }>();
  const add = (raw: string, min: number) => {
    const text = raw.trim();
    if (!text || Array.from(text).length > MAX_CHARS || /[\s\d]/u.test(text) || (/^[一-鿿]+$/u.test(text) && Array.from(text).length < 2)) return;
    const entry = found.get(key(text)) ?? { text, min, explicit: 0 };
    entry.explicit++; entry.min = Math.min(entry.min, min);
    found.set(key(text), entry);
  };
  for (const match of all.matchAll(ZH_QUOTED)) add(match[1]!, MIN_EXPLICIT);
  for (const match of all.matchAll(EN_QUOTED)) add(match[1]!, MIN_EXPLICIT);
  for (const match of all.matchAll(EN_PLAIN)) add(match[1]!, MIN_PLAIN);
  for (const match of all.matchAll(ZH_PLAIN)) {
    const run = Array.from(match[1]!);
    for (let length = 2; length <= run.length; length++) { const candidate = run.slice(0, length).join(''); if (!PARTICLE.test(candidate)) add(candidate, MIN_PLAIN); }
  }
  for (const match of all.matchAll(ZH_LEXICON)) add(match[0], MIN_LEXICON);
  for (const match of all.matchAll(EN_LEXICON)) add(match[0], MIN_LEXICON);
  // The people her notes name (a pet name used as a subject has no "叫你" in front of it). Fix 4: only when her memories show the
  // name used to address or name someone (a film character the notes merely mention took a slot in the third test).
  for (const person of people) { const name = personName(person); if (name && addressEvidence(name, texts)) add(name, MIN_PERSON); }
  // I-088: the names one person goes by (her notes' people-and-things entries, with the user's merges): the evidence of the names adds
  // up, so a name used twice under two spellings counts, and every other name of that person is offered with it. The same rules as
  // above decide (a name marked as a character of a work, or a role word, is still left out); a group with no evidence adds nothing.
  for (const group of aliasGroups) {
    const names = [...new Set(group.map(personName).filter((name): name is string => !!name))];
    if (names.length < 2 || !addressEvidenceAcross(names, texts)) continue;
    // The uses add up too: the person is used MIN_PERSON times in all, so each name seen at least once is offered.
    if (names.reduce((sum, name) => sum + count(all, name), 0) < MIN_PERSON) continue;
    for (const name of names) if (!texts.some(text => occurrences(name, text).some(mention))) add(name, 1);
  }

  const knownText = known.map(name => name.trim()).filter(Boolean);
  const lowered = all.toLocaleLowerCase();
  const rows: AddressForm[] = [];
  for (const { text, min } of found.values()) {
    const uses = Math.max(count(all, text), count(lowered, key(text)));
    if (uses < min) continue;
    if (knownText.some(name => key(name) === key(text) || (Array.from(name).length >= 2 && (key(text).includes(key(name)) || key(name).includes(key(text)))))) continue;
    const refers = addressReferent(text, texts);
    rows.push({ text, uses, ...(refers ? { refers } : {}) });
  }
  // A shorter piece of a longer candidate that is used as often ("小团" inside "小团子") is not a name of its own.
  const kept = rows.filter(row => !rows.some(other => other !== row && key(other.text).includes(key(row.text)) && other.uses >= row.uses * 0.6));
  return kept.sort((a, b) => b.uses - a.uses || a.text.localeCompare(b.text)).slice(0, MAX_CONVERSION_ALIASES);
}

// ---- The card's own proper nouns -------------------------------------------------------------------------------------------------
const ZH_STOP = '的了是在和与有，。！？、；：“”「」『』（）()\\d\\s';
const ZH_ORG = new RegExp(`[^${ZH_STOP}]{2,6}(?:组织|公司|学院|学校|协会|骑士团|议会|研究所|研究院|基地|联盟|集团|军团|部队|王国|帝国|工会|事务所|剧团)`, 'gu');
const ZH_TITLE = new RegExp(`[^${ZH_STOP}她他你我它都也就还叫担任当做为]{1,4}(?:队长|团长|会长|议长|首领|博士|教授|殿下|长官|女王|公主|骑士|总管|大小姐|执行官|指挥官)`, 'gu');
const ZH_BRACKET = /[《「『“]([^》」』”\n，。！？]{2,12})[》」』”]/gu;
const EN_MULTI = /\b[A-Z][a-z]+(?:\s+(?:of|the|and|for)\s+[A-Z][a-z]+|\s+[A-Z][a-z]+)+\b/gu;
const EN_SINGLE = /(?<=[a-z,]\s)[A-Z][a-z]{3,}\b/gu;
const TERM_COMMON = new Set(['The', 'This', 'That', 'She', 'He', 'They', 'Her', 'His', 'You', 'Your', 'Chinese', 'English']);

/**
 * Proper nouns of the card (organization, title, place) found in its persona texts: bracketed or quoted names, names ending in an
 * organization or title word, capitalized phrases. A guess; the user decides each (keep / suggestion / typed / ignore).
 * `corpus` is where the uses are counted.
 */
export function findProperNouns(cardTexts: readonly string[], known: readonly string[], corpus: readonly string[] = cardTexts,
  looksLikeName: (text: string) => boolean = () => true): AddressForm[] {
  const card = cardTexts.join('\n'), all = corpus.join('\n');
  const found = new Map<string, { text: string; single: boolean }>();
  const add = (raw: string, single = false) => {
    const text = raw.trim().replace(/^(?:The|A|An)\s+/u, '');
    if (!text || Array.from(text).length > 24 || TERM_COMMON.has(text) || (/^[\u4e00-\u9fff]+$/u.test(text) && Array.from(text).length < 2)) return;
    if (!found.has(key(text))) found.set(key(text), { text, single });
  };
  for (const match of card.matchAll(ZH_BRACKET)) add(match[1]!);
  for (const match of card.matchAll(ZH_ORG)) add(match[0]);
  for (const match of card.matchAll(ZH_TITLE)) add(match[0]);
  for (const match of card.matchAll(EN_MULTI)) add(match[0]);
  for (const match of card.matchAll(EN_SINGLE)) add(match[0], true);
  const knownText = known.map(name => name.trim()).filter(Boolean);
  const lowered = all.toLocaleLowerCase();
  const rows: AddressForm[] = [];
  for (const { text, single } of found.values()) {
    const uses = Math.max(count(all, text), count(lowered, key(text)));
    if (single && uses < 2) continue;
    if (!looksLikeName(text)) continue; // a pattern match the notes never name is most likely an ordinary word
    if (knownText.some(name => key(name) === key(text) || (Array.from(name).length >= 2 && (key(text).includes(key(name)) || key(name).includes(key(text)))))) continue;
    rows.push({ text, uses });
  }
  const kept = rows.filter(row => !rows.some(other => other !== row && key(other.text).includes(key(row.text)) && other.uses >= row.uses * 0.6));
  return kept.sort((a, b) => b.uses - a.uses || a.text.localeCompare(b.text)).slice(0, MAX_CONVERSION_TERMS);
}

// ---- Fix 6: candidates from her memories, for the assistant to judge ------------------------------------------------------------------
// The sixth test: pet names that were never used as "叫你X" and never as a subject twice (a variant spelling of a left-for-later
// nickname, a "小X" form, a playful "X笨X" form, a title-like address for the user) were offered to nobody and came out translated.
// The local rules cannot tell those from ordinary words, but the assistant (already in this turn, reading the persona) can. So the
// host hands it the most frequent names from the notes' people lists and short quoted words from her memories that are not offered
// already, bounded; it offers the real ones as extra items (the evidence and caps of `checkConversionExtra` still apply).
export type CandidateName = ConversionCandidate;
export const MAX_CANDIDATES_PEOPLE = 7, MAX_CANDIDATES_QUOTED = 5;
const QUOTED_SHORT = /[「“"『]([^」”"』\n]{2,8})[」”"』]/gu;

export function findCandidateNames(texts: readonly string[], people: readonly string[], offered: readonly string[]): CandidateName[] {
  const skip = new Set(offered.map(name => key(name.normalize('NFKC').trim())).filter(Boolean));
  const taken = new Set<string>();
  const out: CandidateName[] = [];
  const take = (source: CandidateName['source'], tally: Map<string, { text: string; uses: number }>, min: number, max: number, keepOrder = false) => {
    const rows = [...tally.values()].filter(row => row.uses >= min && !skip.has(key(row.text)) && !taken.has(key(row.text)))
      .sort((a, b) => keepOrder ? 0 : b.uses - a.uses || a.text.localeCompare(b.text)).slice(0, max);
    for (const row of rows) { taken.add(key(row.text)); out.push({ text: row.text, uses: row.uses, source }); }
  };
  const crowd = new Map<string, { text: string; uses: number }>();
  for (const person of people) {
    const name = personName(person);
    if (!name || Array.from(name).length > 12) continue;
    const entry = crowd.get(key(name)) ?? { text: name, uses: 0 };
    entry.uses++; crowd.set(key(name), entry);
  }
  take('people', crowd, 2, MAX_CANDIDATES_PEOPLE);
  // Quoted short phrases are mostly ordinary speech ("还困么", a joke line); only the form of address is wanted. So they are ranked by
  // how much each looks like one (after 叫/喊/称呼/昵称, a 小/老/阿 form, a vocative at the start of a line, seen in several notes) and the
  // ones that end like a sentence are pushed down; use count only breaks ties. The slot count is unchanged.
  // Fix 8 (Codex T-240): ordinary words that merely start many lines ("“明天”" in six notes) could still fill the slots by line starts and
  // spread. Now a word needs at least one address signal before anything else counts: after 叫/喊/称呼/昵称/叫做…, a vocative at a line
  // start (the quote followed by ，/！/~), or a name-like shape (小/老/阿 in front, a doubled syllable, ending in 宝/酱/崽/仔). A line
  // start alone is no signal. Words without any signal rank below every signalled one (by use count only among themselves).
  const quoted = new Map<string, { text: string; uses: number; score: number; signal: boolean; notes: Set<number> }>();
  texts.forEach((text, index) => { for (const match of text.matchAll(QUOTED_SHORT)) {
    const word = match[1]!.trim();
    if (!word || /[\s\d，。！？、；：,.!?;:~～…]/u.test(word) || PARTICLE.test(word) || GENERIC_PEOPLE.has(word.toLocaleLowerCase())) continue;
    const entry = quoted.get(key(word)) ?? { text: word, uses: 0, score: 0, signal: false, notes: new Set<number>() };
    const at = match.index ?? 0, end = at + match[0].length, before = text.slice(Math.max(0, at - 8), at), lineStart = text.slice(0, at).split(/\n/u).pop() ?? '';
    entry.uses++; entry.notes.add(index);
    if (/(?:叫|喊|唤|称呼|称为|昵称|外号|小名|叫做|叫她|叫我|叫你)[了过着成作]?\s*$/u.test(before)) { entry.score += 3; entry.signal = true; }
    if (!lineStart.trim() && /^\s*[，,！!~～]/u.test(text.slice(end))) { entry.score += 1; entry.signal = true; }
    quoted.set(key(word), entry);
  } });
  for (const entry of quoted.values()) {
    if (/^[小老阿]/u.test(entry.text)) entry.score += 2;
    if (/^[小老阿]|(\p{Script=Han})\1$|[宝酱崽仔]$/u.test(entry.text)) entry.signal = true;
    entry.score += Math.min(3, entry.notes.size - 1);
    if (/[么吗呢吧了啊嘛]$/u.test(entry.text)) entry.score -= 4;
    else if (Array.from(entry.text).length > 4 && /[么吗呢吧了啊嘛的是不在有]/u.test(entry.text)) entry.score -= 2;
  }
  const ranked = new Map([...quoted.entries()].sort(([, x], [, y]) => Number(y.signal) - Number(x.signal)
    || (x.signal ? y.score - x.score : 0) || y.uses - x.uses || x.text.localeCompare(y.text)));
  take('quoted', ranked, 2, MAX_CANDIDATES_QUOTED, true);
  return out;
}
