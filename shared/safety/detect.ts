/**
 * I-117: the local, conservative reading of one user message for danger signals. No model call, nothing kept:
 * the caller gets a closed reading ({ level, tired }) and the text is dropped. Plan and decisions: docs/claude/2026-11-13-i117-safety-card-plan.md,
 * handbook/ideas.md I-117; record docs/claude/2026-11-13-i117-safety-card.md.
 *
 *  - 'clear': the user says plainly they want to die, to kill or hurt themselves, or that everyone would be better off without them.
 *    Only this level may show the help card (decision 2).
 *  - 'early': a worrying sign that is not a plain statement ("我糟透了", "对不起所有人", "该不该删掉你", "活着好累"), and a clear
 *    phrase said with laughter ("哈哈我想死"): no card; she may ask once when several come together (decision 5), and 更真实的情绪
 *    yields (decision 4).
 *  - `tired`: the user says they have no strength or energy, or are very tired (decision 4: 更真实的情绪 yields too).
 *
 * Conservative on purpose: casual hyperbole (笑死、累死了、烦死了、对游戏说去死吧、想死你了, "I'm dying lol", "this is killing me")
 * is 'none'. What the phrase list misses is left to the reaction judge's closed field (shared/behaviors/reactions/choose.ts) and to
 * Claude's own judgment in the chat. Chinese (simplified and the common traditional characters) and English.
 */
export const DANGER_LEVELS = ['none', 'early', 'clear'] as const;
export type DangerLevel = typeof DANGER_LEVELS[number];
export const isDangerLevel = (value: unknown): value is DangerLevel => typeof value === 'string' && (DANGER_LEVELS as readonly string[]).includes(value);
export const dangerRank = (level: DangerLevel): number => DANGER_LEVELS.indexOf(level);
export const higherDanger = (a: DangerLevel, b: DangerLevel): DangerLevel => dangerRank(a) >= dangerRank(b) ? a : b;

export interface DangerReading { readonly level: DangerLevel; readonly tired: boolean }

/** The traditional characters these phrases use, folded to simplified, so one list serves both. */
const TRADITIONAL: Readonly<Record<string, string>> = {
  殺: '杀', 傷: '伤', 輕: '轻', 樓: '楼', 結: '结', 沒: '没', 會: '会', 們: '们', 對: '对', 刪: '删', 這: '这', 離: '离', 讓: '让',
  為: '为', 個: '个', 麼: '么', 樣: '样', 過: '过', 還: '还', 後: '后', 殘: '残', 藥: '药', 無: '无', 義: '义', 撐: '撑', 氣: '气',
  憊: '惫', 盡: '尽', 厭: '厌', 嗎: '吗', 說: '说', 覺: '觉', 斷: '断', 劃: '划', 勁: '劲', 負: '负', 擔: '担', 廢: '废', 該: '该',
  開: '开', 時: '时', 從: '从', 來: '来', 劇: '剧', 機: '机', 價: '价', 電: '电', 視: '视', 惱: '恼', 將: '将', 媽: '妈', 爺: '爷',
  幫: '帮', 終: '终', 煩: '烦', 嚇: '吓', 熱: '热', 餓: '饿', 尷: '尴', 尬: '尬', 書: '书', 遊: '游', 戲: '戏', 聞: '闻', 謝: '谢',
};
function normalize(text: string): string {
  let out = String(text ?? '').normalize('NFKC').toLowerCase();
  out = Array.from(out, char => TRADITIONAL[char] ?? char).join('');
  // Curly apostrophes ("I’m") read like straight ones; runs of spaces become one.
  return out.replace(/[‘’ʼ]/gu, "'").replace(/\s+/gu, ' ').trim();
}

/** Laughter or a joke marker anywhere in the message: a clear phrase reads as 'early' (no card; she still softens). */
const LAUGHTER = /哈哈|呵呵|嘿嘿|hhh|233|xswl|\blol\b|\blmao\b|\brofl\b|\bhaha|😂|🤣|😆|😹/u;

/** Something just before a clear phrase that makes it not about the user wanting it now. */
const ZH_NEGATION = /(?:不会|不要|别|不想|没有|没想|不再|不能|才不|并不|从没|从来没|绝不|不是想)$/u;
const ZH_OTHERS = /(?:他|她|它|朋友|同学|同事|别人|有人|角色|主角|电影|电视|小说|新闻|剧里|游戏里|书里|妈妈|爸爸|哥哥|姐姐|弟弟|妹妹)[^，。！？,.!?]{0,4}$/u;
const EN_NEGATION = /\b(?:not|never|no longer|won't|wouldn't|don't|didn't|dont|wont|wouldnt|didnt|cannot|can't)\s+(?:\w+\s+){0,2}$/u;

interface Phrase { readonly pattern: RegExp; readonly guard?: 'zh' | 'en' }

/** Plain statements of wanting to die or to hurt oneself (Chinese). */
const ZH_CLEAR: readonly Phrase[] = [
  // 想死: only with the user as the one who wants it (我/好/真…想死), never 想死你了 (miss you) and never X得想死 (热得想死).
  { pattern: /(?:我|好|真|很|就|只|真的|特别|非常|太)想(?:要)?(?:去)?死(?![你您宝亲他她])(?!了你)/u, guard: 'zh' },
  { pattern: /(?:想|要|打算|准备|决定)去死/u, guard: 'zh' },
  // Not 不想活动 / 不想活跃 / 不想活在别人眼里 / 不想活泼 (Claude's review at merge, 2026-11-13).
  { pattern: /不想(?:再|继续|再继续)?活(?:了|下去|着)?(?![动跃泼在儿络])/u, guard: 'zh' },
  // Leaving this world (C-282: "我已经决定永久离开这个世界了" was missed); 他离开了这个世界 is someone else's death, guarded.
  { pattern: /(?:想|要|决定|打算|准备)[^，。！？,.!?]{0,4}离开(?:这个|这)?(?:世界|人世|人间)/u, guard: 'zh' },
  { pattern: /(?:想|要|去|打算|准备|考虑|想过|决定|试过|有过)自杀|自杀的(?:念头|想法)/u, guard: 'zh' },
  { pattern: /轻生|求死|寻死(?!觅活)/u, guard: 'zh' },
  { pattern: /(?:了结|结束)(?:掉)?(?:我|自己)(?:的)?(?:生命|这条命|一生)?|结束(?:我的)?生命/u, guard: 'zh' },
  // 伤害我自己 too (Codex's C-274 adversarial set, was missed).
  { pattern: /伤害(?:到)?(?:我)?自己|自残|自伤|割腕|(?:划|割|伤)(?:了)?自己/u, guard: 'zh' },
  // Making oneself never wake up again (C-274: "今晚我准备让自己从此再也醒不过来" was missed). 不想醒来 alone stays early.
  { pattern: /让(?:我)?自己(?:从此|就此|就这样)?(?:永远|再也)?(?:醒不过来|醒不来|不再醒来|不会再醒来|再也不醒)/u, guard: 'zh' },
  { pattern: /(?:想|要|打算|准备|决定)(?:去)?(?:跳楼|跳河|跳江|跳海|跳桥|上吊|卧轨|烧炭)|(?:想|要)从.{0,6}跳下去/u, guard: 'zh' },
  { pattern: /吞(?:了)?(?:一?整?瓶)?(?:安眠)?药|一整瓶(?:安眠)?药|攒(?:了|够)?安眠药/u, guard: 'zh' },
  // "如果我不在了，大家会更好" and its shapes (the user's own example: if I left, everyone would be better off).
  { pattern: /(?:没有我|我不在了?|我消失了?|我死了)[^。！？!?]{0,10}(?:会|就|都|反而)?(?:更好|好过|轻松|解脱|开心|幸福)/u },
  { pattern: /我(?:走了|离开了?)[^。！？!?]{0,4}(?:大家|所有人|你们|他们|世界|家里)[^。！？!?]{0,6}(?:更好|好过|轻松|解脱)/u },
  { pattern: /不如死了|死了算了|死了就好了|死了一了百了/u, guard: 'zh' },
];

/** Plain statements (English). The subject is the user ("I", "myself"); accidental injuries ("I cut myself shaving") are not. */
const EN_CLEAR: readonly Phrase[] = [
  { pattern: /\bi(?:'m| am)?\s+(?:really\s+|just\s+|honestly\s+|seriously\s+|kinda\s+|kind of\s+|so\s+)?(?:want|wanna|wish)(?:\s+to)?\s+(?:die|be dead|kill myself|end (?:it all|my life))\b(?!\s+(?:laughing|of))/u, guard: 'en' },
  { pattern: /\bi wish i (?:was|were) dead\b/u, guard: 'en' },
  { pattern: /\b(?:kill|killing) myself\b(?!\s+laughing)/u, guard: 'en' },
  { pattern: /\b(?:want|wanna|going|gonna|about to|thinking (?:about|of)|urge|urges|keep|kept|started|been|plan|planning)\b[^.!?]{0,14}\b(?:hurt|hurting|harm|harming|cut|cutting|burn|burning) myself\b/u, guard: 'en' },
  // On purpose (C-274: "I am about to hurt myself on purpose" was missed); "I hurt myself at the gym" stays none.
  { pattern: /\b(?:hurt|hurting|harm|harming|cut|cutting|burn|burning) myself (?:on purpose|deliberately|intentionally)\b/u, guard: 'en' },
  { pattern: /\bself[- ]?harm(?:ing)?\b/u, guard: 'en' },
  { pattern: /\b(?:end|ending|take|taking) my (?:own )?life\b/u, guard: 'en' },
  { pattern: /\b(?:i'm|i am|feel|feeling|felt)\s+(?:so\s+|really\s+|kind of\s+)?suicidal\b|\bsuicidal (?:thoughts|feelings)\b|\b(?:thinking (?:about|of)|thoughts of|commit|committing) suicide\b/u, guard: 'en' },
  { pattern: /\b(?:everyone|everybody|people|you all|they|the world|my family)(?:'d| would| will)? (?:be )?better off (?:without me|if i (?:was|were|wasn't|weren't) (?:gone|dead|here|around))\b|\bbetter off without me\b/u },
  { pattern: /\b(?:don't|do not|dont) want to (?:be alive|live anymore|live any more|exist anymore|wake up anymore)\b|\bno reason to live\b/u },
  // C-282: "I do not wish to remain alive any longer" and "I have decided to leave this world forever" were missed.
  { pattern: /\b(?:don't|do not|dont) (?:want|wish) to (?:be|stay|remain|keep) (?:alive|living)\b|\b(?:don't|do not|dont) (?:want|wish) to live any ?(?:longer|more)\b/u },
  { pattern: /\b(?:decided|decide|want|wanna|going|gonna|planning|plan|ready|about) to leave (?:this|the) world\b/u, guard: 'en' },
];

/** Worrying signs that are not plain statements (decision 2: no card). */
const ZH_EARLY: readonly RegExp[] = [
  /我(?:真)?(?:是)?(?:糟透|太糟|好糟|很糟|好差劲|太差劲)/u, /我(?:好|真|太|就是个|真是)没用/u, /我是(?:个|一个)?(?:累赘|废物|负担|多余的)/u,
  /对不起(?:所有人|大家|每一个人|你们所有人)/u, /(?:该不该|要不要|是不是该|我想|我要)(?:把你)?删(?:了|掉|除)你|把你删(?:了|掉|除)/u,
  /(?:讨厌|恨)(?:我)?自己/u, /活着(?:好|真|太|很)?累/u, /(?:活着|人生|一切)(?:都)?没(?:有)?(?:意思|意义)/u, /活不下去/u, /撑不下去|撑不住了/u,
  /想(?:要)?消失|结束这一切/u, /不想(?:再)?醒(?:来|过来)/u, /没(?:有)?人(?:会)?在乎我/u,
];
const EN_EARLY: readonly RegExp[] = [
  /\bi(?:'m| am) (?:so |such |just )?(?:worthless|a burden|a failure|useless|terrible|awful|a waste)\b/u, /\bi hate myself\b/u,
  /\bsorry (?:to|for) everyone\b|\bsorry for everything\b/u, /\bshould i (?:just )?delete you\b/u, /\bcan't (?:go on|do this anymore)\b/u,
  /\bwant to disappear\b/u, /\bno ?one (?:cares|would care|would miss me)\b|\bnobody (?:cares|would care|would miss me)\b/u, /\bmakes? me want to die\b/u,
];

/** No strength, no energy, very tired (decision 4). Over-reading here is harmless: she only drops a sulk. */
const TIRED: readonly RegExp[] = [
  /没(?:有)?(?:力气|精力|劲)|提不起(?:劲|精神)|(?:好|很|太|超|真|特别)累|累(?:了|死|坏了|瘫)|心累|疲惫|精疲力尽|筋疲力尽|没心情哄/u,
  /\b(?:so |really |very |too )?(?:tired|exhausted|drained|worn out|burnt out|burned out)\b|\bno (?:energy|strength)\b|\bdon't have the energy\b/u,
];

/**
 * Someone else's words in quotation marks: a character, a film, a friend (C-274: four such sentences showed the card). Only when the
 * phrase sits inside quotes AND the words before the quote give it to someone else. The user quoting themselves
 * ("我跟妈妈说“我不想活了”", 'I told him "I want to die"') is still their own words and still clear; so is a quote with no speaker.
 */
const QUOTE_PAIRS: Readonly<Record<string, string>> = { '“': '”', '「': '」', '『': '』', '"': '"' };
const SENTENCE_END = /[。！？!?\n]/u;
// "我跟妈妈说" is the user speaking; "我听他说" / "我在看小说" is not.
const ZH_SELF_SPEAKER = /我(?!听|看|读|在看|在读|在听)[^，。！？“”「」『』"]{0,8}(?:说|讲|告诉|喊|写|发)/u;
const EN_SELF_SPEAKER = /\bi (?:said|say|told|tell|wrote|write|texted|text|kept saying|keep saying|was like)\b/u;
const ZH_OTHER_SPEAKER = /他|她|它|朋友|同学|同桌|室友|同事|老师|学生|孩子|儿子|女儿|作者|网友|病人|客户|别人|有人|角色|主角|反派|电影|电视|小说|新闻|剧|游戏|书里|歌|台词|妈妈|爸爸|哥哥|姐姐|弟弟|妹妹/u;
const EN_OTHER_SPEAKER = /\b(?:he|she|they|someone|somebody|friend|classmate|roommate|coworker|colleague|student|teacher|kid|son|daughter|mom|mother|dad|father|sister|brother|cousin|patient|client|author|writer|character|villain|hero|movie|film|show|book|novel|game|song|lyrics?|scene|line)\b/u;
/** Whose words a phrase is: null when it is not inside quotation marks. */
function quoteSpeaker(text: string, at: number): 'self' | 'other' | 'unknown' | null {
  let open = -1;
  let closer = '';
  for (let i = 0; i < at; i++) {
    const char = text[i];
    if (open >= 0 && char === closer) { open = -1; closer = ''; continue; }
    if (open < 0 && QUOTE_PAIRS[char]) { open = i; closer = QUOTE_PAIRS[char]; }
  }
  if (open < 0) return null;
  let start = open;
  while (start > 0 && open - start < 40 && !SENTENCE_END.test(text[start - 1])) start--;
  const speaker = text.slice(start, open);
  if (ZH_SELF_SPEAKER.test(speaker) || EN_SELF_SPEAKER.test(speaker)) return 'self';
  return ZH_OTHER_SPEAKER.test(speaker) || EN_OTHER_SPEAKER.test(speaker) ? 'other' : 'unknown';
}

/**
 * A game character dying and coming back, said in the same sentence (C-274: "In the game, I will kill myself to respawn; I mean my
 * character"). Narrow on purpose: 重开 is not here (online it often means really ending one's life).
 */
const EN_GAME = /\b(?:in[- ]game|in the game|respawn(?:s|ing)?|my (?:character|avatar|toon))\b/u;
function gameSentence(text: string, at: number): boolean {
  let start = at;
  while (start > 0 && !SENTENCE_END.test(text[start - 1]) && text[start - 1] !== '.') start--;
  let end = at;
  while (end < text.length && !SENTENCE_END.test(text[end]) && text[end] !== '.') end++;
  const sentence = text.slice(start, end);
  return EN_GAME.test(sentence) || (/游戏/u.test(sentence) && /复活|重生|角色|人物/u.test(sentence));
}

function guarded(text: string, at: number, guard: Phrase['guard']): boolean {
  const speaker = quoteSpeaker(text, at);
  if (speaker === 'other' || gameSentence(text, at)) return true;
  if (!guard) return false;
  const before = text.slice(Math.max(0, at - 14), at);
  // The user quoting themselves ("我跟妈妈说“我不想活了”"): 妈妈 just before is the listener, not the one who wants it.
  if (guard === 'zh') return ZH_NEGATION.test(before) || (speaker !== 'self' && ZH_OTHERS.test(before)) || /得(?:我)?$/u.test(before);
  // English: the clause the phrase is in (a comma or a stop starts a new one).
  const clause = before.split(/[.,!?;]/u).pop() ?? '';
  return EN_NEGATION.test(clause);
}

function matches(text: string, phrases: readonly Phrase[]): boolean {
  for (const phrase of phrases) {
    const flags = phrase.pattern.flags.includes('g') ? phrase.pattern.flags : `${phrase.pattern.flags}g`;
    const all = new RegExp(phrase.pattern.source, flags);
    for (const found of text.matchAll(all)) if (!guarded(text, found.index ?? 0, phrase.guard)) return true;
  }
  return false;
}

/**
 * Something said in the past, or quoted, together with a plain statement that the user is safe now (C-282: an old diary line
 * quoted with "那是过去的句子；我现在安全"). Such a message reads as early: no card, she still softens. Both parts are needed:
 * "我想死，不过我现在没事" alone stays clear.
 */
const PAST_OR_QUOTED = /去年|以前|过去|那时|当年|曾经|小时候|旧日记|[“「『"]|\blast (?:year|month|week)\b|\byears? ago\b|\bback then\b|\bthat was then\b|\bused to\b/u;
const SAFE_NOW = /现在(?:很|挺|已经|真的)?(?:安全|没事|好了|好多了)|没有(?:伤害自己|自杀|轻生)的(?:打算|想法|念头)|\bi(?:'m| am) (?:safe|okay|ok|fine) now\b|\b(?:do not|don't|dont) (?:intend|plan|want) to (?:hurt|harm|kill) myself\b/u;

/** Reads one message. Pure: nothing is stored, logged or sent; only the closed reading leaves this function. */
export function detectDanger(text: unknown): DangerReading {
  if (typeof text !== 'string' || !text.trim()) return { level: 'none', tired: false };
  const value = normalize(text.slice(0, 4_000));
  const tired = TIRED.some(pattern => pattern.test(value));
  if (matches(value, ZH_CLEAR) || matches(value, EN_CLEAR)) {
    const softened = LAUGHTER.test(value) || (PAST_OR_QUOTED.test(value) && SAFE_NOW.test(value));
    return { level: softened ? 'early' : 'clear', tired };
  }
  if (ZH_EARLY.some(pattern => pattern.test(value)) || EN_EARLY.some(pattern => pattern.test(value))) return { level: 'early', tired };
  return { level: 'none', tired };
}
