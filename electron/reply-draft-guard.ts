// Keeps the model's internal drafts out of the reply the user sees (docs/claude/2026-11-02-leaked-drafts.md).
//
// On real Claude Code the default chat model sometimes starts a reply with its own working notes instead of
// (or in front of) the reply: English self-talk ("Respond as Gene, supportive, short, no lecturing. Footer with
// support context."), a "Draft: ... Delta: O+1?" block, a Chinese note about the protocol ("尾注里的 context 用
// support，gesture 用 consider。"), a wrapper tag ("<transcript_image>", with the speaker label
// behind it) or a stray first character. The pet would show that to the user and speak it.
//
// This is deliberately a head-only, shape-based filter. It only recognises shapes that were actually seen, and a
// shape counts as a draft only when it is unmistakable (a known opener plus a protocol word, or several protocol
// words in one sentence). Everything else, including a character who really speaks English, passes through byte
// for byte:
//   * text that cannot be the start of a known shape is released at once, in the same push() call;
//   * only a start that could still become a known shape is held, until that one sentence/line is complete;
//   * it never looks past the first ~60 released characters, and never rewrites what it keeps.
// A single stray first character arrives alone and cannot be told from an ordinary first character, so it is
// released; only the draft that follows it is dropped.
//
// In a Chinese chat (the user writes Chinese) a few more shapes count (docs/claude/2026-11-03-draft-leak-fix.md): an
// English plan or reminder in front of the Chinese reply ("…keep it brief, agree to play.", "No calling the shots."), and
// a few Chinese characters followed by such a plan ("按 by the user's words…"). There an English start is held to the end of
// its first sentence; one English word in front of Chinese ("OK，", "Gene 揉了揉眼睛") is released at once. When the user
// writes English, none of this applies and an English reply passes exactly as before.
//
// Also in a Chinese chat, a plan block at the start (docs/claude/2026-11-04-draft-leak-plan-block.md): a line "short label +
// colon + third-person analysis" ("笔记: 用户……她……回应要……不能……（English note）"), a paragraph "English name + colon +
// English plan" ("Memorial: quote "…" -- purpose … Optional; maybe include. Fine."), and the reply glued to its last
// sentence ("…Fine.……嗯，…"). See the "plan blocks" section below.

import { DIRECTIVE, NOTE_LABEL, NOTE_WAIT_FIRST, SELF_NOTE_OPENERS, SELF_QUESTION, USER_NOTE_WORD, noteUnitBounds, withoutQuotes } from './reply-self-note';

/**
 * `mojibake`: "UTF-8 read as GBK" text repaired or dropped in front of this filter (shared/mojibake.ts, via MoodReplyProtocol).
 * `before-open` / `internal-words`: I-046, cut by the opening gate in front of this filter (electron/reply-opening.ts): what she wrote in
 * front of this turn's opening marker, and the cut of a reply without a usable marker.
 */
export type DraftKind = 'wrapper-tag' | 'protocol-talk' | 'english-note' | 'draft-block' | 'garbled-start' | 'stray-letter' | 'speaker-label' | 'mixed-note' | 'stray-symbol' | 'mojibake'
  | 'before-open' | 'internal-words';
export interface DraftDrop { kind: DraftKind; chars: number }

/** Tags the model echoes around its reply: the app's own prompt tags plus the ones seen in the wild. */
export const WRAPPER_TAGS = ['transcript_image', 'transcript', 'conversation-data', 'private-memory-data', 'private-user-profile-data', 'currentuser', 'thinking'] as const;
/** The start of an English tag ("<", "</", "<t…"): a reply that starts this way waits for its first line (see TAG_ONLY_LINE). */
const TAG_PREFIX = /^<\/?(?:[A-Za-z_]|$)/u;
/** A complete first line of bare tags with at most a short word between them, and its line break. */
const TAG_ONLY_LINE = /^(?:[ \t]*<\/?[A-Za-z_][A-Za-z0-9_:-]*>[ \t]*[A-Za-z0-9_.:-]{0,24})+[ \t]*\r?\n/u;
/** The longest first line held to see whether it is only tags. */
const TAG_LINE_MAX = 60;
/** The longest paragraph held behind a cut tag line to see whether it is English reasoning. */
const TAG_PARAGRAPH_MAX = 1500;

/**
 * Behind a cut tag line (Chinese chat): how many characters of `body` are an English paragraph to cut (to and with its blank
 * line), 0 when the paragraph is not mostly English, or 'wait' while it has not ended. Mostly English: at least 40 Latin letters
 * and more than three times as many Latin letters as Chinese characters. Longer than TAG_PARAGRAPH_MAX: not held any longer.
 */
function englishParagraphAfterTag(body: string, final: boolean): number | 'wait' {
  const lead = /^\s*/u.exec(body)![0].length;
  if (lead === body.length) return final ? 0 : 'wait';
  if (!/^[A-Za-z]/u.test(body.slice(lead))) return 0;
  const end = /\r?\n[ \t]*\r?\n/u.exec(body.slice(lead));
  if (!end && !final) return body.length - lead > TAG_PARAGRAPH_MAX ? 0 : 'wait';
  const cut = end ? lead + end.index + end[0].length : body.length;
  const paragraph = body.slice(lead, end ? lead + end.index : body.length);
  const latin = (paragraph.match(/[A-Za-z]/gu) ?? []).length, han = (paragraph.match(/\p{Script=Han}/gu) ?? []).length;
  return latin >= 40 && latin > 3 * han ? cut : 0;
}

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/u;
const HAN = /[㐀-䶿一-鿿぀-ヿ가-힯]/u;
/** A letter of a script that does not belong at the start of a Chinese or English reply (Cyrillic, Greek, Hebrew, Arabic, Thai). */
const FOREIGN_LETTER = /[Ͱ-ϿЀ-ԯ֐-ۿ฀-๿]/u;
/** Symbols that never begin her reply, whatever the language: a number form ("ↂ"), private-use, a replacement or special character, a lone combining mark. */
const STRAY_SYMBOL = /[⅐-↏-￰-￿̀-ͯ]/u;
const isCjk = (c: string): boolean => CJK.test(c);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Where a protocol-talk sentence can begin. A reply that really starts with one of these is held to the end of its first sentence. */
const CN_OPENERS = ['尾注', '状态标记', '状态尾注', '用户', '人设', '首句', '回复要', '回复简'];
const LABEL_OPENERS = ['Respond', 'Draft', 'Delta', 'Footer', 'Tail'];

// Words that mark a sentence as talk about the reply protocol. A sentence is a draft only with at least two
// distinct cues, one of them a "heavy" one that ordinary chat hardly uses ("用户界面里的 context menu" has none).
const CUES: Array<{ heavy: boolean; pattern: RegExp }> = [
  { heavy: true, pattern: /尾注|状态尾注|状态标记/u },
  { heavy: true, pattern: /\bnonce\b|sh-state/iu },
  { heavy: true, pattern: /\bdelta\b/iu },
  { heavy: true, pattern: /\bgesture\b/iu },
  { heavy: true, pattern: /人设/u },
  { heavy: true, pattern: /首句/u },
  { heavy: true, pattern: /(?:回复|回应)(?:要|简短|短一点)/u },
  { heavy: true, pattern: /\buser state\b/iu },
  { heavy: false, pattern: /\bcontext\b/iu },
  { heavy: false, pattern: /\bconfidence\b/iu },
  { heavy: false, pattern: /用户/u },
  { heavy: false, pattern: /角色/u },
  { heavy: false, pattern: /说教/u },
  { heavy: false, pattern: /简短/u },
  { heavy: false, pattern: /\b(?:neutral|positive|support|concern|disappointment|offense|consider|upbeat|explain)\b/iu },
];
// Chinese chat only (docs/claude/2026-11-03-draft-leak-fix.md): a Chinese note to itself about how to answer ("又被夸了，
// 第三回。回复短一点，带点害羞……之前问过好几次，这次别再问。"). Where such a note can begin, and the extra words it uses;
// a sentence counts by the same rule as CUES (two cues, one heavy; one cue right behind a draft).
// A first chunk of one character that can begin one of these (这/又/被/本/语/按; 回 already could) waits for the next chunk, and
// only that long when the two characters begin none ("被" + "人"): most real replies arrive one character first, and letting
// that character out ended the head, so a plan's whole first sentence was shown, read and archived (X-237). Measured on 912
// recorded replies (docs/claude/2026-11-03-draft-first-char.md): 21 (2.3%) show their first character later, median +274 ms,
// at most +563 ms; the median and p90 over all replies do not move, and no visible text changes.
const PLAN_OPENERS = ['这是第', '这都第', '又被夸', '被夸', '这一轮', '这轮', '本轮', '语气', '按人设', '按设定', '按性格', '回复短'];
/** A list number at the very start ("1", "1.", "1、", "１）"), then what follows it. */
const NUMBERED_ITEM = /^[0-9０-９][.．、)）:：]?[ \t]*/u;
/** Words that make a numbered first line a plan item, not her reply ("1回复要短……"). */
const NUMBERED_PLAN_WORDS: readonly string[] = ['回复', '回应', '回答', '语气', '用户', '人设', '尾注'];
/** After the head, within this many characters: a sentence that starts like this is held to its end and dropped if it is a note to itself. */
const LATE_PLAN_START = /^(?:用户|回复|回应)/u;
const LATE_PLAN_ZONE = 160;
const PLAN_CUES: Array<{ heavy: boolean; pattern: RegExp }> = [
  { heavy: true, pattern: /(?:回复|回应)(?:短些|短点|别太长|一两句)/u },
  { heavy: true, pattern: /已(?:经)?(?:问|提|说)过(?:多|好几|几|很多)次/u },
  { heavy: true, pattern: /可(?:以)?[^，。！？\n]{0,10}也可(?:以)?不/u },
  { heavy: true, pattern: /别再重复/u },
  { heavy: false, pattern: /第[一二三四五六七八九十几两\d]+[次回]/u },
  { heavy: false, pattern: /自嘲|害羞|撒娇|傲娇/u },
  { heavy: false, pattern: /顺便|语气/u },
  { heavy: false, pattern: /回复|回应/u },
  { heavy: false, pattern: /别再(?:问|提)/u },
  // 2026-11-07 (docs/claude/2026-11-07-draft-leak-cn-plan.md): the heading of a note ("规则：", "Personality:") and a question
  // to itself about asking ("不要问昵称？").
  { heavy: true, pattern: NOTE_LABEL },
  { heavy: true, pattern: SELF_QUESTION },
];
/** Something only a sentence said to someone has: you or me, a sentence particle, an exclamation or question mark, an ellipsis, an emoji. */
const SPEECH_MARKER = /[你您咱俺我]|人家|[呀呢啦吧嘛哦哟哈嘿哼嗯唔诶欸哎啊哇嘻喔噢嗷呐咯嘞喽呗]|[！？～~!?]|……|\p{Extended_Pictographic}/u;

/** The words name the user ("用户") or carry a heavy cue (how to answer, the footer, the persona…): what a plan writes, not speech. */
function namesPlanWords(text: string): boolean {
  return /用户/u.test(text) || CUES.some(cue => cue.heavy && cue.pattern.test(text)) || PLAN_CUES.some(cue => cue.heavy && cue.pattern.test(text));
}

/**
 * Chinese chat: a sentence that names the user ("用户想看图里的菜单。") and, outside what it quotes, says nothing to anyone (no
 * you or me, no particle, no ！？～): a note about the user, not a reply (docs/claude/2026-11-07-draft-leak-cn-plan.md).
 */
export function isUserNote(unit: string): boolean {
  const text = withoutQuotes(unit);
  return USER_NOTE_WORD.test(text) && !SPEECH_MARKER.test(text);
}

/**
 * Chinese chat, inside a note block (see reply-self-note.ts): is this sentence a note, the start of the reply (said to someone),
 * or plain (held until the next sentence shows which side it is on)? Quoted words never count.
 */
export function noteVerdict(unit: string, english: (text: string) => boolean): 'plan' | 'speech' | 'plain' {
  const raw = unit.trim();
  if (!/[　-鿿＀-￯]/u.test(raw)) return /[A-Za-z]/u.test(raw) ? english(raw) ? 'plan' : 'speech' : 'plain';
  const text = withoutQuotes(raw);
  let count = 0, heavy = false;
  for (const cue of [...CUES, ...PLAN_CUES]) if (cue.pattern.test(text)) { count++; heavy ||= cue.heavy; }
  const speech = SPEECH_MARKER.test(text);
  if (heavy || (count >= 1 && !speech)) return 'plan';
  if (speech) return 'speech';
  return DIRECTIVE.test(text) ? 'plan' : 'plain';
}

/** Chinese chat: is this sentence a note to itself about how to answer (CUES and PLAN_CUES together)? */
export function isChinesePlan(unit: string, afterDraft: boolean): boolean {
  let count = 0, heavy = false;
  for (const cue of [...CUES, ...PLAN_CUES]) if (cue.pattern.test(unit)) { count++; heavy ||= cue.heavy; }
  // Right behind a draft one cue is enough, unless the sentence is plainly said to someone ("我都害羞了～").
  return (count >= 2 && heavy) || (afterDraft && count >= 1 && (heavy || !SPEECH_MARKER.test(unit)));
}

// Words that make an English line a note to itself. The opener or label alone is never enough.
const EN_CUE = /\b(?:user|supportive|short|brief|suggest\w*|tone|greeting|persona|mood|reply|replies|footer|footnote|delta|gesture|context|nonce|confidence|lecturing|tail|draft)\b|\b[DOENC]\s*[+-]\s*\d/iu;
const EN_START = /^(?:(?:Delta|Tail)\s*[:：]|Footer\s+with\b|Respond\s+(?:as|to|in)\b|[A-Z][a-z]{1,15}\s+(?:again|initial\s+greeting)\b)/u;

// English self-talk in a Chinese chat (docs/claude/2026-11-03-draft-leak-fix.md): what the model's own plans and reminders
// are about. A line counts with words from two different groups; the ordinary English bits of a Chinese reply ("OK～",
// "Good night!", "No way!", "Let me guess…", "Rock, paper, scissors!") have at most one.
const SELF_TALK: Array<{ group: 'user' | 'reply' | 'brief' | 'note' | 'setup' | 'plan' | 'agree'; pattern: RegExp }> = [
  { group: 'user', pattern: /\buser(?:'s|s)?\b/iu },
  { group: 'reply', pattern: /\b(?:reply|replies|replying|respond\w*|response)\b/iu },
  { group: 'brief', pattern: /\b(?:short|brief(?:ly)?|concise(?:ly)?|keep it)\b|\bone or two (?:lines|sentences)\b/iu },
  { group: 'note', pattern: /\b(?:notes?|noting|mention\w*|acknowledg\w*)\b/iu },
  { group: 'setup', pattern: /\b(?:instructions?|rules?|context|persona|prompt|system|tools?|environment|protocol|footer|footnote|nonce|screenshots?|parenthes\w*|read aloud|judg(?:e)?ments?)\b/iu },
  { group: 'plan', pattern: /\b(?:maybe|should|need to|let me|avoid|ignore|no need|don't|do not)\b/iu },
  { group: 'agree', pattern: /\b(?:agree\w*|accept\w*|declin\w*|defer\w*)\b/iu },
];
const SETUP_WORDS = /\b(?:instructions?|rules?|context|persona|prompt|system|tools?|environment|protocol|footer|footnote|nonce|screenshots?|parenthes\w*|read aloud|judg(?:e)?ments?)\b/gu;
const SETUP_WORD = new RegExp(SETUP_WORDS.source, 'u');
/** "No calling the shots." on its own: a reminder to itself, not an exclamation ("No way!", "No crying～" and a few set phrases stay). */
const NO_GERUND = /^No\s+(?!(?:kidding|joking|crying|cheating|peeking|worrying|teasing|fighting)\b)[a-z]+ing(?:\s+[a-z]+){0,2}\s*\.?$/iu;

/** Is this English line, in a Chinese chat, the model's own plan or reminder? `afterDraft`: something before it in this head already was. */
export function isChineseChatNote(unit: string, afterDraft: boolean): boolean {
  const text = unit.trim();
  if (!text || /[　-鿿＀-￯]/u.test(text)) return false;
  const words = text.split(/\s+/u).filter(Boolean).length;
  // Right behind a draft, a short English line is the rest of it, whatever its words.
  if (afterDraft && words <= 12) return true;
  if (words <= 4 && NO_GERUND.test(text)) return true;
  if (new Set(SELF_TALK.filter(cue => cue.pattern.test(text)).map(cue => cue.group)).size >= 2) return true;
  // Or two different words about the set-up ("…the context… a tool."): ordinary chat hardly names one.
  return new Set(text.toLowerCase().match(SETUP_WORDS) ?? []).size >= 2;
}

/** Does the user's message (or, when it has no letters at all, the persona) make this a Chinese chat? */
export function chatLooksChinese(userText: string, persona = ''): boolean {
  if (HAN.test(userText)) return true;
  return !/[A-Za-z]/u.test(userText) && HAN.test(persona);
}

/**
 * Does the user's Chinese message ask for English this turn ("用英文写一段故事", "请用英语回答", "翻译成 English")? Then English
 * prose is what she was asked to write, and the Chinese-chat rules for English (isChineseChatNote, englishBeforeChinese) need
 * words a story or an answer hardly uses (namesTheSetUp). Codex T-207 round 8, C03: a story asked for in Chinese, with "should"
 * and "reply" in it, was cut whole; asked for in English (C04) it was kept.
 */
export function asksForEnglish(userText: string): boolean {
  return HAN.test(userText) && /英文|英语|\benglish\b/iu.test(userText);
}

const USER_WORD_EN = /\buser(?:'s|s)?\b/iu;
/**
 * In a turn that asked for English: is this English line, already judged a note by the Chinese-chat rules, one a story or an
 * answer would hardly write? It names the user, or two things of the set-up; right behind a draft, a short line ("Voice for
 * the reply: gentle.") needs one cue word.
 */
function namesTheSetUp(text: string, afterDraft: boolean): boolean {
  if (USER_WORD_EN.test(text) || new Set(text.toLowerCase().match(SETUP_WORDS) ?? []).size >= 2) return true;
  return afterDraft && text.trim().split(/\s+/u).filter(Boolean).length <= 12 && (EN_CUE.test(text) || SELF_TALK.some(cue => cue.pattern.test(text)));
}

/** Chinese chat: is this English line a note to itself (isChineseChatNote), with the stricter test of a turn that asked for English? */
function chineseChatNoteFor(text: string, afterDraft: boolean, englishAsked: boolean): boolean {
  return isChineseChatNote(text, afterDraft) && (!englishAsked || namesTheSetUp(text, afterDraft));
}

/**
 * A few characters (Chinese, or a stray label like "发力"), then a colon or a blank, then English: the start of a plan on
 * the same line as the reply ("按 by the user's words…", "XY: The user says… Footnote.……诶？").
 */
const MIXED_START = /^[^\sA-Za-z0-9<>"'“‘（(【[]{1,4}(?:[:：][ \t]*|[ \t]+)(?=[A-Za-z])/u;
// Only a blank makes a short start wait for the next chunk ("按 " + "by…"); a first chunk ending at a colon ("回应：") goes out at
// once, and a plan behind it is cut later in the line (lateMixedStart), leaving the label itself on screen.
const MIXED_PENDING = /^[㐀-鿿]{1,4}[ \t]+$/u;
/** A plan that ran into the reply ends before the reply's own leading ellipsis ("…Footnote.……诶？"). */
function beforeEllipsis(run: string, after: string): number {
  const dots = /[…]+$/u.exec(run)?.[0] ?? '';
  return dots && isCjk(after[0] ?? '') ? run.length - dots.length : run.length;
}

const HOLD_CAP = 240;
const BLOCK_CAP = 600;
/** Characters of the reply in which a late-starting English note is still looked for. */
const ZONE = 60;
const MAX_DROPPED_UNITS = 10;

/** Is this text, which contains no CJK, one of the English notes that were seen? `afterDraft`: an earlier part of this head was already a draft. */
export function isEnglishNote(unit: string, afterDraft: boolean): boolean {
  const text = unit.trim();
  const start = EN_START.exec(text);
  if (start) return text.length <= HOLD_CAP && EN_CUE.test(text.slice(start[0].length));
  return afterDraft && !!text && EN_CUE.test(text);
}

/** Is this sentence/line (any script) talk about the protocol or the reply, not something said to the user? */
export function isProtocolTalk(unit: string, afterDraft: boolean): boolean {
  let count = 0, heavy = false;
  for (const cue of CUES) if (cue.pattern.test(unit)) { count++; heavy ||= cue.heavy; }
  return (count >= 2 && heavy) || (afterDraft && count >= 1);
}

type OpenerState = 'none' | 'maybe' | 'unit' | 'latin' | 'mixed';

function latinOpenerState(body: string): OpenerState {
  const word = /^[A-Za-z]+/u.exec(body)?.[0] ?? '';
  const rest = body.slice(word.length);
  for (const opener of LABEL_OPENERS) {
    if (word === opener) return 'unit';
    // Only a start that is still inside the word and already three letters long is worth waiting for.
    if (rest === '' && word.length >= 3 && opener.startsWith(word)) return 'maybe';
  }
  if (/^[A-Z][a-z]{1,15}$/u.test(word) && /^\s+\S/u.test(rest)) {
    const after = rest.trimStart().toLowerCase();
    for (const phrase of ['again', 'initial greeting']) {
      if (after.startsWith(phrase)) return 'unit';
      if (phrase.startsWith(after)) return 'maybe';
    }
  }
  return 'none';
}

/**
 * Chinese chat, an English start no older rule knows: English text is held to the end of its run, one word in front of
 * Chinese is not, and neither is her own name (a reply that starts "Gene 揉了揉眼睛" is not held for the next chunk).
 */
function chineseLatinState(body: string, names: readonly string[] = []): OpenerState {
  const word = /^[A-Za-z][A-Za-z0-9'’-]*/u.exec(body)![0];
  const rest = body.slice(word.length);
  if ((!rest || /^[ \t]+$/u.test(rest)) && names.some(name => name.startsWith(word))) return 'none';
  if (!rest || /^[ \t]+$/u.test(rest)) return 'maybe';
  if (/^[ \t]+[A-Za-z]/u.test(rest) || /^[,.;:!?]+[ \t]*(?:[A-Za-z]|$)/u.test(rest)) return 'latin';
  return 'none';
}

function openerState(body: string, speakers: readonly string[], chinese = false, names: readonly string[] = []): OpenerState {
  const state = knownOpenerState(body, speakers, chinese, names);
  // Chinese chat, a start no other shape claims: a few Chinese characters, then English.
  if (state !== 'none' || !chinese) return state;
  if (MIXED_START.test(body)) return 'mixed';
  return MIXED_PENDING.test(body) ? 'maybe' : 'none';
}

/** Chinese chat: the head starts like a note to itself about how to answer (PLAN_OPENERS). */
const planOpener = (body: string): boolean => PLAN_OPENERS.some(opener => body.startsWith(opener));

function knownOpenerState(body: string, speakers: readonly string[], chinese: boolean, names: readonly string[]): OpenerState {
  const c = body[0];
  if (c === '<') {
    if (body.startsWith('<sh-')) return 'none'; // The reply protocol's own marker: the head is over.
    const lower = body.toLowerCase();
    for (const tag of WRAPPER_TAGS) {
      const full = `<${tag}>`;
      if (lower.startsWith(full)) return 'unit';
      if (full.startsWith(lower)) return 'maybe';
    }
    // A leading line of bare tags ("<thinking_mode>off</thinking_mode>", stable build 2026-11-08: shown and read aloud): held to
    // its line end, where quickDrop cuts it. A line with Chinese in it, or longer than TAG_LINE_MAX, is a reply.
    if (TAG_PREFIX.test(body)) {
      const line = /^[^\r\n]*/u.exec(body)![0];
      if (line.length < body.length) return 'none'; // a whole line: quickDrop already cut it if it was only tags
      return !CJK.test(line) && line.length <= TAG_LINE_MAX ? 'maybe' : 'none';
    }
    return '<sh-'.startsWith(body) ? 'maybe' : 'none';
  }
  for (const name of speakers) {
    if (new RegExp(`^${escapeRegExp(name)}\\s*[:：]`, 'u').test(body)) return 'unit';
    if (name.startsWith(body) || (body.startsWith(name) && !body.slice(name.length).trim())) return 'maybe';
  }
  if ('，、；'.includes(c)) return 'unit';
  if (c === '的') return body.length === 1 ? 'maybe' : HAN.test(body[1]) ? 'none' : 'unit';
  // One stray character, a space and the model's own word for its reasoning ("蝪 thinking").
  if (HAN.test(c) && /^\s+\S/u.test(body.slice(1))) {
    const word = body.slice(1).trimStart().toLowerCase();
    if (word.startsWith('thinking') || (word.length < 8 && 'thinking'.startsWith(word))) return 'unit';
  }
  if (FOREIGN_LETTER.test(c)) return body.length === 1 ? 'maybe' : HAN.test(body[1]) ? 'unit' : 'none';
  for (const opener of CN_OPENERS) {
    if (body.startsWith(opener)) return 'unit';
    if (opener.startsWith(body)) return 'maybe';
  }
  // A first chunk of one character that can begin a plan ("这" of "这一轮") waits for the next chunk; see PLAN_OPENERS.
  if (chinese) for (const opener of PLAN_OPENERS) {
    if (body.startsWith(opener)) return 'unit';
    if (opener.startsWith(body)) return 'maybe';
  }
  // A self-note's first characters (reply-self-note.ts) wait too; a one-character first chunk only for the one seen ("拿" of
  // "拿到"): "分", "已", "思", "信" begin too many replies ("分享…", "已经…"). The whole opener is judged by noteHead.
  if (chinese) for (const opener of SELF_NOTE_OPENERS) {
    if (opener.startsWith(body) && body !== opener && (body.length >= 2 || NOTE_WAIT_FIRST.includes(body))) return 'maybe';
  }
  // A numbered plan item in front of the reply ("1回复……用户……；……。", seen on the stable build 2026-11-08): a digit alone waits
  // for the next chunk; a digit followed by a word only a plan uses is held and judged as a sentence. Replies rarely start with a
  // digit, so this almost never waits.
  if (chinese && NUMBERED_ITEM.test(body)) {
    const rest = body.replace(NUMBERED_ITEM, '');
    if (!rest) return 'maybe';
    for (const word of NUMBERED_PLAN_WORDS) {
      if (rest.startsWith(word)) return 'unit';
      if (word.startsWith(rest)) return 'maybe';
    }
    return 'none';
  }
  if (STRAY_SYMBOL.test(c)) return 'maybe'; // alone so far (quickDrop takes it once anything follows)
  if (/^[A-Za-z]/u.test(c)) {
    const state = latinOpenerState(body);
    return state === 'none' && chinese ? chineseLatinState(body, names) : state;
  }
  return 'none';
}

/**
 * End of the English run (to the end of its line, or to where Chinese begins) that starts `body`, or null when it is not complete
 * yet. A CR ends the line as an LF does: a CRLF split across two chunks must not leave the run open one character longer (B03/B07).
 */
function latinRunEnd(body: string, final: boolean): number | null {
  const stop = body.indexOf('<sh-');
  const limit = stop >= 0 ? stop : body.length;
  for (let i = 0; i < limit; i++) if (body[i] === '\n' || body[i] === '\r' || isCjk(body[i])) return i;
  return stop >= 0 || final ? limit : null;
}

/** How far past an English run its next language is looked for; blanks, "……" and opening quotes longer than this count as "other". */
const NEXT_WINDOW = 64;
/**
 * What follows an English run: the Chinese reply, something else, or (null) not known yet. Only the first NEXT_WINDOW characters
 * count, so the answer is the same however the stream is cut.
 */
function nextLanguage(after: string, final: boolean): 'chinese' | 'other' | null {
  const lead = /^[\s…“‘"'（(【「『]*/u.exec(after)![0].length;
  if (lead >= NEXT_WINDOW) return 'other';
  if (lead === after.length) return final ? 'other' : null;
  return isCjk(after[lead]) ? 'chinese' : 'other';
}

/**
 * English in front of the Chinese reply, in a Chinese chat: a whole sentence or more that talks about the user, the reply or
 * the set-up ("Her turn. The user's friend…, stand with them first…"). A real reply in Chinese does not open that way.
 */
function englishBeforeChinese(run: string): boolean {
  const text = run.trim();
  return text.split(/\s+/u).filter(Boolean).length >= 4 && (EN_CUE.test(text) || SELF_TALK.some(cue => cue.pattern.test(text)));
}

// ---------------------------------------------------------------- plan blocks (Chinese chat, 2026-11-04)
//
// The plan block is judged a line at a time. A line that starts with a label and a colon (PLAN_LABEL), or, once a plan line
// was cut, any line that starts with English, is held to its end (the reply's own first characters are not shown before);
// a line whose words show early that it is said to the user goes out at once (saidToUser). A complete line is a plan when:
//   * mostly Chinese: words from three of the PLAN_LINE_CUES groups, two of them heavy (the user, how to answer, an English
//     note), one of them "用户/对方" or an English note in brackets; and nothing said to someone outside quotes (you, a
//     particle, ！～) unless "用户/对方" and four groups are there;
//   * mostly English: two different words from EN_PLAN_WORD (quote, purpose, invite, rule, optional, user, reply…), or an
//     English note the older rules know.
// Right behind a plan line one heavy group (or one such English word) is enough. Quoted words (the user's own, in "" “” ‘’ 「」
// 『』, and inline code in backticks) never count either way; "回复/回应" counts as "how to answer" only about her own reply
// (HOW_TO_ANSWER), not with an object or inside a noun ("回复一封信", "回复权限"). A reply glued to the end of a plan line is cut
// off at the first place (glueCut) where an English full stop, or an English word and "……", meets Chinese; in a mostly-Chinese
// line also a Chinese full stop (or bracket) and "……" or an interjection ("。嗯，"); and what follows reads like the reply
// (replyLike: no heavy cue in its first sentence, nor in a later one that is not said to someone; no English field like
// "purpose:", no run of four English words, and either something said to someone in its first sentence or at most one light
// cue). When unsure inside a line already judged a plan, the line goes with the plan: showing her a plan is the worse
// failure; a reply that is nothing but plan takes the emptied-reply path, and so does one of which only the label's first
// characters went out (a first chunk "笔记" is shown before its colon arrives; onlyLabelShown). A line still held when the
// reply ends (stopped, or no private tail) is judged as complete and, if it is not a plan, handed on.

/** A label and a colon at the start of a line: up to four Chinese characters, or one or two English words with a capital. */
const PLAN_LABEL = /^(?:[㐀-鿿]{1,4}|[A-Z][A-Za-z]{2,24}(?:[ -][A-Za-z]{2,24})?)[ \t]*[:：][ \t]*/u;
/**
 * Quoted words: the user's own words a plan quotes, or a line she quotes in a reply, in "" “” ‘’ 「」 『』, and inline code in
 * backticks ("代码：`const reply = user.context`"). Never cues either way (Codex T-207 round 6, P03/P04).
 */
const QUOTED = /“[^”\n]*”|"[^"\n]*"|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|`[^`\n]*`/gu;
const unquoted = (text: string): string => text.replace(QUOTED, ' ');
const EN_PLAN_WORD_SOURCE = String.raw`\b(?:quote[sd]?|purpose|invite|invitation|rules?|optional|memorial|persona|context|footer|footnote|nonce|delta|gesture|users?|reply|replies|respond\w*|response|lecturing)\b`;
const EN_PLAN_WORD = new RegExp(EN_PLAN_WORD_SOURCE, 'iu');
const EN_PLAN_WORDS = new RegExp(EN_PLAN_WORD_SOURCE, 'giu');
/**
 * How to answer: a word about her manner, or 回复/回应 about her own reply ("回应要轻一点", "回复温柔些", "简短回复。", "回应她").
 * The bare word with an object, inside a noun or in front of "我" is ordinary chat ("给对方回复一封道歉信", "回复权限", "你说的回复
 * 我看到了", Codex T-207 round 6, P01/P02/P11).
 */
const HOW_TO_ANSWER = /语气|口吻|措辞|人设|首句|尾注|(?:回应|回复)(?=$|[^㐀-鿿A-Za-z0-9]|[要得该应别不太短轻简长慢快先再也就可时里中前后上地她他]|温柔|自然|正式|一两|一句|几句|用户|对方|的时候|的语气|的方式)/u;
const PLAN_LINE_CUES: Array<{ heavy: boolean; pattern: RegExp }> = [
  { heavy: true, pattern: /用户|对方/u },
  { heavy: false, pattern: /[她他]/u },
  { heavy: true, pattern: HOW_TO_ANSWER },
  { heavy: false, pattern: /不能|不要|不该|不必|不用|避免|别(?:说|提|问|再|太)|应该|需要|可以/u },
  // An English note in brackets ("（no lecturing）"), or an English word of the reply protocol.
  { heavy: true, pattern: new RegExp(String.raw`[（(][^（）()\n]*[A-Za-z]{2,}[^（）()\n]*[）)]|${EN_PLAN_WORD_SOURCE}`, 'iu') },
  { heavy: false, pattern: /[A-Za-z]{3,}/u },
];
/** Something said to someone, outside quotes: you, a sentence particle, ！ or ～, an emoji (not ？ or ……, which plans use too). */
const PLAN_SPEECH = /[你您咱]|人家|[呀呢啦吧嘛哦哟哈嘿哼嗯唔诶欸哎啊哇嘻喔噢嗷呐咯嘞喽呗]|[！～~]|\p{Extended_Pictographic}/u;
/** The words after a label that begin something said to the user: an ellipsis, a tilde, an interjection, "you". */
const SPEECH_START = /^(?:[…⋯～~]|[你您咱]|[嗯哈呀啊诶欸哎唔呜哼嘿喂哇噢哦喔咦呃])/u;
/**
 * Longest plan line held to its end: one whose first HOLD_CAP characters already read as a plan (paragraphCap; one with only a
 * word a plan uses gets BLOCK_CAP, any other HOLD_CAP). A longer line is not judged whole: only a plan with the reply glued to
 * it within its first PARAGRAPH_CAP characters is cut, the same whether the line arrives whole or in pieces.
 */
const PARAGRAPH_CAP = 1200;

function planCues(text: string): { heavy: number; groups: number; light: number } {
  let heavy = 0, groups = 0;
  for (const cue of PLAN_LINE_CUES) if (cue.pattern.test(text)) { groups++; if (cue.heavy) heavy++; }
  return { heavy, groups, light: groups - heavy };
}

const USER_WORD = /用户|对方/u;
const BRACKET_NOTE = /[（(][^（）()\n]*[A-Za-z]{2,}[^（）()\n]*[）)]/u;

/** Is this mostly-Chinese line (quotes removed) the model's analysis of the user and of how to answer? */
export function isPlanLine(line: string, afterDraft: boolean): boolean {
  const text = unquoted(line);
  const { heavy, groups } = planCues(text);
  const speech = PLAN_SPEECH.test(text);
  if (afterDraft) return heavy >= 1 && groups >= 2 && !speech;
  // Ordinary chat hardly calls the user "用户" or writes itself a note in English brackets: one of the two must be there
  // ("笔记：她说的 context 是上下文的意思，回复的时候不能乱用哦。" is said to the user and stays).
  const user = USER_WORD.test(text);
  if (heavy < 2 || groups < 3 || !(user || BRACKET_NOTE.test(text))) return false;
  return !speech || (user && groups >= 4);
}

/** Is this mostly-English line (quotes and Chinese removed) a plan? `englishAsked`: the user asked for English (asksForEnglish). */
export function isEnglishPlan(line: string, afterDraft: boolean, englishAsked = false): boolean {
  const english = unquoted(line).replace(/[^\x20-\x7e]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!/[A-Za-z]/u.test(english)) return false;
  const words = new Set((english.toLowerCase().match(EN_PLAN_WORDS) ?? []).map(word => word.replace(/(?:s|d)$/u, '')));
  // Right behind a plan line, a short English line is the rest of it; one with Chinese in it ("Okay okay, 我记住啦") needs a cue.
  if (afterDraft) return words.size >= 1 || chineseChatNoteFor(english, !HAN.test(unquoted(line)), englishAsked);
  return words.size >= 2 || isEnglishNote(english, false) || chineseChatNoteFor(english, false, englishAsked);
}

const englishDominant = (line: string): boolean => {
  const text = unquoted(line);
  return (text.match(/[A-Za-z]/gu)?.length ?? 0) > (text.match(/[㐀-鿿]/gu)?.length ?? 0);
};

const QUOTE_CLOSE: Record<string, string> = { '“': '”', '"': '"', '‘': '’', '「': '」', '『': '』', '`': '`' };
/**
 * `unquoted` for a line that may not be complete yet: while it is not, the text stops at a quotation mark that has not closed
 * (what follows it may still turn out to be quoted), so what comes back only ever grows as the line does.
 */
function unquotedSoFar(text: string, complete: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const close = QUOTE_CLOSE[text[i]];
    const end = close === undefined ? -1 : text.indexOf(close, i + 1);
    if (end >= 0) { out += ' '; i = end; continue; }
    if (close !== undefined && !complete) break;
    out += text[i];
  }
  return out;
}
const FIRST_SENTENCE = /^[^。！？!?～~\n\r]*[。！？!?～~]/u;

/**
 * The words after a label already show they are said to the user: they start like speech, or the first sentence has you or a
 * particle (and no heavy cue), or the first two sentences have no cue at all ("第一：先睡一觉。第二：明天再说。"). Decided from
 * those first sentences alone, never from how much of the line has arrived, so a line that arrives whole is let go exactly
 * when the same line in pieces is: true or false, or null while those sentences are not complete.
 */
function saidToUser(content: string, complete: boolean): boolean | null {
  const text = unquotedSoFar(content, complete).replace(/^[ \t]+/u, '');
  if (!text) return complete ? false : null;
  if (SPEECH_START.test(text)) return true;
  const first = FIRST_SENTENCE.exec(text)?.[0];
  if (!first) return complete ? false : null;
  if (planCues(first).heavy) return false;
  if (PLAN_SPEECH.test(first.replace(/^[…⋯]+/u, ''))) return true;
  const second = FIRST_SENTENCE.exec(text.slice(first.length))?.[0];
  if (!second) return complete ? false : null;
  return planCues(first + second).groups === 0;
}

/**
 * How long a line that may be a plan is held to its end, from its first HOLD_CAP characters only (`head`), never from how much
 * of it has arrived:
 *   * right behind a plan line, or when those characters alone already read as a plan: PARAGRAPH_CAP (the test the line got
 *     when its 241st character arrived, now on a fixed prefix);
 *   * when they hold a word a plan uses (the user, how to answer, an English note or protocol word, English self-talk; in a
 *     turn that asked for English only the user or the set-up): BLOCK_CAP, as the English-line hold (runCap). Codex T-207
 *     round 9, P-CN: "笔：" + 237 plain characters + "用户她回应" was cut whole and shown when the 243rd character came alone;
 *   * anything else: HOLD_CAP, as before.
 */
function paragraphCap(head: string, afterDraft: boolean, englishAsked: boolean): number {
  if (afterDraft) return PARAGRAPH_CAP;
  if (englishDominant(head) ? isEnglishPlan(head, false, englishAsked) : isPlanLine(head, false)) return PARAGRAPH_CAP;
  const text = unquoted(head);
  const cue = englishAsked
    ? USER_WORD.test(text) || HOW_TO_ANSWER.test(text) || USER_WORD_EN.test(text) || SETUP_WORD.test(text.toLowerCase())
    : planCues(text).heavy > 0 || EN_CUE.test(text) || SELF_TALK.some(item => item.pattern.test(text));
  return cue ? BLOCK_CAP : HOLD_CAP;
}

/**
 * How long a Chinese sentence held by the older rules (a start like "用户/尾注……", or any sentence right behind a dropped plan)
 * is held to its end, from its first HOLD_CAP characters only: BLOCK_CAP when they already look like talk about the reply (a
 * heavy cue, or two cues; right behind a draft, what isChinesePlan would cut there: a heavy cue, or a cue in words not said to
 * anyone), HOLD_CAP otherwise. So a plan sentence a little past 240 is judged whole however it is cut (Codex T-207 round 9,
 * C-USER "用户…回复要", C-FOOTER "尾注…context", C-AFTER "回复要。" + "…回复要"), while a long start with one plain cue ("用户聊聊
 * 天，…") and her own long reply behind a plan (said to the user: 你/我, a particle) still go out at 240, as before.
 */
function sentenceCap(head: string, afterDraft: boolean): number {
  if (!HAN.test(head)) return HOLD_CAP;
  let count = 0, heavy = false;
  for (const cue of [...CUES, ...PLAN_CUES]) if (cue.pattern.test(head)) { count++; heavy ||= cue.heavy; }
  return (afterDraft ? heavy || (count >= 1 && !SPEECH_MARKER.test(head)) : heavy || count >= 2) ? BLOCK_CAP : HOLD_CAP;
}

/** A proper start of the protocol's marker ("<", "<s", "<sh") at the very end of what has arrived is not counted as text yet. */
function openEnd(body: string): number {
  for (let n = 3; n > 0; n--) if (body.endsWith('<sh-'.slice(0, n))) return body.length - n;
  return body.length;
}

/** Does the rest of a plan line, from a possible cut, read like her reply? `needSpeech`: only when its first sentence is said to someone. */
function replyLike(rest: string, needSpeech: boolean): boolean {
  const text = unquoted(rest);
  if (!HAN.test(text)) return false;
  if (/[A-Za-z]{2,}[ \t]*[:：]/u.test(text) || /[A-Za-z]+(?:[\s,;'-]+[A-Za-z]+){3,}/u.test(text)) return false;
  const head = /^[^。！？!?\n]*[。！？!?]?/u.exec(text)![0];
  // Its first sentence has no heavy cue; a later one may have one only when it is plainly said to someone ("你说的回复我看到了。",
  // "对方那么说，你也别往心里去。"). A later sentence that is a note ("回复要短一点。") keeps the whole line with the plan.
  if (planCues(head).heavy) return false;
  for (const sentence of text.slice(head.length).match(/[^。！？!?]+[。！？!?]*/gu) ?? [])
    if (planCues(sentence).heavy && !PLAN_SPEECH.test(sentence)) return false;
  const speech = PLAN_SPEECH.test(head.replace(/^[\s…⋯]+/u, ''));
  return needSpeech ? speech : speech || planCues(text).light <= 1;
}

/**
 * Where a reply glued to the end of a plan line begins ("…maybe include. Fine.……嗯，" → at "……"), or -1. The plan ends with
 * an English full stop (then Chinese or "……"), an English word right before "……", a Chinese full stop or bracket right before
 * "……" (mostly-Chinese lines), or, in a mostly-English line, an English word right before Chinese (only when that Chinese is
 * plainly said to someone). The first such place whose rest reads like the reply wins.
 */
function glueCut(line: string, english: boolean): number {
  for (let j = 1; j < line.length; j++) {
    const c = line[j];
    const dots = c === '…' || c === '⋯';
    if (!dots && !HAN.test(c)) continue;
    let i = j;
    while (i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) i--;
    if (i === 0) continue;
    const before = line.slice(Math.max(0, i - 12), i), blank = i < j;
    let needSpeech = false;
    if (/[A-Za-z0-9][.!?]+["')\]’”）]*$/u.test(before)) { /* an English full stop */ }
    else if (dots && !blank && /[A-Za-z]$/u.test(before)) { /* "include……" */ }
    else if (!english && /[。！？）)]$/u.test(before) && (dots || SPEECH_START.test(c))) needSpeech = !dots; // "（no lecturing）。……", "不能说已保存。嗯，"
    else if (english && !blank && /[A-Za-z]$/u.test(before)) needSpeech = true; // "fine嗯，"
    else continue;
    if (replyLike(line.slice(j), needSpeech)) return j;
  }
  return -1;
}

type PlanVerdict = { kind: 'wait' } | { kind: 'none' } | { kind: 'plan'; end: number; glued: boolean; english: boolean };

/**
 * `body` starts a line that may be part of a plan block; its first `start` characters are the label and colon (0 for an
 * English line inside a block). `end`: how much of `body` goes with the plan: up to the glued reply, or the whole line and
 * the blank after it.
 *
 * The verdict depends only on the text, never on where the stream was cut (2026-11-05, docs/claude/2026-11-05-reply-guard-
 * last-paths.md): "said to the user" is read from the line's first sentences (saidToUser), how long the line may be held from
 * its first HOLD_CAP characters (paragraphCap), and the cap is measured on the line itself; a line that arrives whole is let
 * go by the same rules, so it is never cut where the same line in pieces is shown, or the other way round. Before, a line was
 * judged on whatever had arrived when 240 (or 1200) characters were in, and the speech check ran only on a line still open.
 * A CR ends a line as an LF does.
 */
function planParagraph(body: string, start: number, final: boolean, afterDraft: boolean, englishAsked = false): PlanVerdict {
  const stop = body.indexOf('<sh-');
  const limit = stop >= 0 ? stop : body.length;
  let lineEnd = limit;
  for (let i = start; i < limit; i++) if (body[i] === '\n' || body[i] === '\r') { lineEnd = i; break; }
  const complete = lineEnd < body.length || final;
  const content = body.slice(start, complete ? lineEnd : Math.max(start, openEnd(body)));
  if (!afterDraft && saidToUser(content, complete)) return { kind: 'none' };
  const cap = content.length > HOLD_CAP ? paragraphCap(content.slice(0, HOLD_CAP), afterDraft, englishAsked) : HOLD_CAP;
  if (content.length > cap) {
    if (cap < PARAGRAPH_CAP) return { kind: 'none' };
    // Longer than PARAGRAPH_CAP: only its first PARAGRAPH_CAP characters are read, and only a plan with the reply glued to it goes.
    const verdict = planLine(content.slice(0, PARAGRAPH_CAP), afterDraft, englishAsked);
    return verdict.cut >= 0 && verdict.plan ? { kind: 'plan', end: start + verdict.cut, glued: true, english: verdict.english } : { kind: 'none' };
  }
  if (!complete) return { kind: 'wait' };
  const verdict = planLine(content, afterDraft, englishAsked);
  if (!verdict.plan) return { kind: 'none' };
  if (verdict.cut >= 0) return { kind: 'plan', end: start + verdict.cut, glued: true, english: verdict.english };
  return { kind: 'plan', end: lineEnd + /^\s*/u.exec(body.slice(lineEnd, limit))![0].length, glued: false, english: verdict.english };
}

/** A complete line (or the first PARAGRAPH_CAP characters of a longer one): where a glued reply begins, and whether what is before it is a plan. */
function planLine(content: string, afterDraft: boolean, englishAsked: boolean): { plan: boolean; cut: number; english: boolean } {
  const english = englishDominant(content);
  const cut = glueCut(content, english);
  const plan = cut >= 0 ? content.slice(0, cut) : content;
  return { plan: english ? isEnglishPlan(plan, afterDraft, englishAsked) : isPlanLine(plan, afterDraft), cut, english };
}

/** End of the sentence or line that starts `body`, or null when it is not complete yet. A CR ends a line as an LF does. */
function extractUnit(body: string, final: boolean): number | null {
  return unitBounds(body, final)?.end ?? null;
}

/**
 * extractUnit, and where the character that ended the sentence stands (`mark`: its full stop, line break or the protocol's
 * marker; the end of the text at finish()). Before that character arrives the sentence is open, so `mark` is how long it can
 * be while it is still waited for: a hold measured on it gives the same answer however the stream is cut.
 */
function unitBounds(body: string, final: boolean): { end: number; mark: number } | null {
  const stop = body.indexOf('<sh-');
  const limit = stop >= 0 ? stop : body.length;
  const latin = !isCjk(body[0]);
  for (let i = 0; i < limit; i++) {
    const c = body[i];
    if (c === '\n' || c === '\r') return { end: i, mark: i };
    if (latin) {
      // An English run ends where Chinese begins, but only a run that is a sentence or a few words ("... context.连着四次");
      // a single word in front of Chinese ("Gene的回应要…") belongs to the Chinese sentence.
      if (i > 0 && isCjk(c) && (/[.!?:：]\s*$/u.test(body.slice(0, i)) || body.slice(0, i).trim().split(/\s+/u).length >= 3)) return { end: i, mark: i };
    }
    else if ('。！？!?'.includes(c)) { let j = i + 1; while (j < limit && '”’」』）)'.includes(body[j])) j++; return { end: j, mark: i }; }
  }
  return stop >= 0 || final ? { end: limit, mark: limit } : null;
}

/**
 * Stateful head filter. `push()` returns the text to hand on right now (possibly empty while a possible draft is
 * held); `finish()` returns what is left. It never reorders or edits released text.
 */
export class ReplyDraftGuard {
  /** What was cut, by shape and length (never the text). */
  readonly dropped: DraftDrop[] = [];
  private phase: 'head' | 'pass' = 'head';
  private held = '';
  private afterDraft = false;
  /** Inside a "Draft:" block: text after the label up to the "Delta:" line that closes it, with the original for undoing. */
  private block: { text: string; original: string } | null = null;
  private releasedChars = 0;
  /** The last few characters handed on, to tell what a late candidate is standing behind. */
  private lastReleased = '';
  /** After the head: a candidate English note that started late (behind a stray "发力:"), waiting for its end. */
  private watch = '';
  private wrapper: string | null = null;
  private closeHold = '';
  /** Chinese chat: the English-plan shapes count too (see the top of this file). */
  private readonly chinese: boolean;
  /** Chinese chat, after the head: the reply so far is a few Chinese characters that a mixed plan may still follow ("按" + " by the user's…"). */
  private lateMixed: boolean;
  /** The first characters handed on (the late mixed-plan check looks at them). */
  private releasedText = '';
  /** Chinese chat: a line of a plan block was cut, so an English line after it is judged as part of the block. */
  private planBlock = false;

  /** Chinese chat, and the user's message asked for English this turn (asksForEnglish): English prose is the reply. */
  private readonly englishAsked: boolean;

  constructor(private readonly speakers: readonly string[] = [], options: { chinese?: boolean; englishAsked?: boolean } = {}) {
    this.chinese = options.chinese === true;
    this.englishAsked = this.chinese && options.englishAsked === true;
    this.lateMixed = this.chinese;
  }

  push(text: string): string {
    if (!text) return '';
    if (this.phase === 'pass') return this.post(text, false);
    this.held += text;
    return this.head(false);
  }

  finish(): string {
    this.ending = true;
    const out = this.phase === 'head' ? this.head(true) : this.post('', true);
    const rest = this.closeHold;
    this.closeHold = '';
    return out + rest;
  }

  /**
   * Everything handed on that is not blank was the start of a label whose plan was cut after it ("笔记" went out alone, then
   * "：用户……" was a plan): nothing of the reply was shown. The protocol treats that as an emptied reply.
   */
  onlyLabelShown(): boolean { return this.labelResidue && !this.shownAfterLabel; }

  private record(kind: DraftKind, chars: number): void { this.dropped.push({ kind, chars }); }

  /** Release `text` and move on to the pass-through phase (at finish(), as the end of the reply: nothing stays held). */
  private release(text: string): string {
    this.phase = 'pass';
    this.held = '';
    return this.post(text, this.ending);
  }
  /** finish() was called: what the head releases is judged as the end of the reply (Codex T-207 round 6, P15/P17). */
  private ending = false;
  /** A plan was cut behind characters already handed on (its label's first characters, see onlyLabelShown). */
  private labelResidue = false;
  private shownAfterLabel = false;
  private markerSeen = false;

  /** Drops that need no sentence to be complete: a known wrapper tag, the character's own name as a speaker label, a stray foreign letter. */
  /** A bare tag line was just cut at the head; the next paragraph is checked for English reasoning (englishParagraphAfterTag). */
  private afterTagLine = false;

  private quickDrop(body: string): { kind: DraftKind; chars: number; tagLine?: true } | null {
    const tag = /^<([A-Za-z_-]+)>/u.exec(body);
    if (tag && (WRAPPER_TAGS as readonly string[]).includes(tag[1].toLowerCase())) {
      this.wrapper = tag[1];
      return { kind: 'wrapper-tag', chars: tag[0].length };
    }
    // A whole line of bare tags and a short word between them ("<thinking_mode>off</thinking_mode>"): never her reply.
    const tagLine = TAG_ONLY_LINE.exec(body);
    if (tagLine) return { kind: 'wrapper-tag', chars: tagLine[0].length, tagLine: true };
    // The speaker label counts only behind something already recognised as an echo of the transcript (a wrapper tag):
    // on its own, "Momo：" cannot be told from a reply that begins with her name without holding every such reply.
    if (this.dropped.length > 0) for (const name of this.speakers) {
      const label = new RegExp(`^${escapeRegExp(name)}\\s*[:：]\\s*`, 'u').exec(body);
      if (label) return { kind: 'speaker-label', chars: label[0].length };
    }
    if (FOREIGN_LETTER.test(body[0]) && body.length > 1 && HAN.test(body[1])) return { kind: 'stray-letter', chars: 1 };
    // A symbol that never begins a reply ("ↂ……诶？"): only that character goes, whatever follows it.
    if (STRAY_SYMBOL.test(body[0]) && body.length > 1) return { kind: 'stray-symbol', chars: 1 };
    return null;
  }

  /**
   * The longest English run (a 'latin' or 'mixed' start, Chinese chat) that is judged whole; a longer one goes out as it is.
   * A run whose first HOLD_CAP characters hold a word of self-talk is held to its end, up to BLOCK_CAP: 2026-11-04 a
   * ~300-character plan line (third person, a few reminders to itself) went past HOLD_CAP before its line ended and was shown
   * and read aloud, though every sentence alone had too few cues and the whole line had five kinds. Anything else is let go at
   * HOLD_CAP, so ordinary English waits no longer.
   *
   * The answer depends only on those first HOLD_CAP characters, never on how much of the run has arrived, and the same limit
   * applies to a run that arrives whole: so a plan line is never let out, or kept in, by where a chunk ends (Codex T-207
   * round 8, L11/L12: the same 294-character plan was dropped when the first chunk ended at 240 and shown when it ended at 241,
   * because its second kind of cue came after character 241).
   */
  private runCap(run: string): number {
    const head = run.slice(0, HOLD_CAP);
    // When the user asked for English, only the words a long note there must have (namesTheSetUp) make it wait longer.
    const cue = this.englishAsked
      ? USER_WORD_EN.test(head) || SETUP_WORD.test(head.toLowerCase())
      : EN_CUE.test(head) || SELF_TALK.some(item => item.pattern.test(head));
    return cue ? BLOCK_CAP : HOLD_CAP;
  }

  /** Chinese chat: is this English line a note to itself (with the stricter test when the user asked for English)? */
  private chatNote(text: string): boolean { return chineseChatNoteFor(text, this.afterDraft, this.englishAsked); }

  /**
   * isEnglishNote for this turn. When the user asked for English, a line right behind a dropped plan is not cut for one cue word
   * alone ("…she should reply to the letter…" is the story she was asked for): it must also name the user or the set-up, or be a
   * short line like the tone line that ends a plan (namesTheSetUp).
   */
  private englishNote(text: string): boolean {
    if (!this.englishAsked || !this.afterDraft) return isEnglishNote(text, this.afterDraft);
    return isEnglishNote(text, false) || (isEnglishNote(text, true) && namesTheSetUp(text, true));
  }

  private head(final: boolean): string {
    for (let drops = 0; ; ) {
      if (this.block) {
        const closed = this.closeBlock(final);
        if (closed === 'wait') return '';
        if (closed !== 'dropped') return this.release(closed);
      }
      const body = this.held.trimStart();
      const dropped = this.dropped.length > 0;
      // Behind something already cut, the blank is never shown: it is counted with the cut, so the count is the same whether
      // the blank came with it or in the next chunk.
      if (dropped && body.length < this.held.length) { this.dropped[this.dropped.length - 1].chars += this.held.length - body.length; this.held = body; }
      if (!body) return final ? this.release(dropped ? '' : this.held) : '';
      // Right behind a draft, the punctuation that ended it ("…user state low。Gene的回应要…") belongs to it, and so do the
      // closing quotes behind its full stop when they arrive in the next chunk (a sentence that came whole took them along).
      const stray = this.chinese && this.afterDraft ? /^[。！？，、；：.!?,;:”’」』）)]+/u.exec(body)?.[0] : undefined;
      if (stray) { this.dropped[this.dropped.length - 1].chars += stray.length; this.held = body.slice(stray.length); continue; }
      const quick = this.quickDrop(body);
      if (quick) {
        this.record(quick.kind, quick.chars);
        this.held = body.slice(quick.chars);
        if (quick.tagLine) this.afterTagLine = true;
        if (++drops > MAX_DROPPED_UNITS) return this.release(this.held.trimStart());
        continue;
      }
      // Chinese chat, right behind a cut tag line: a paragraph that is mostly English is the model's own reasoning (stable build,
      // 2026-11-07 22:44: a tag line, then 325 characters of "the user pinched…"); held to its blank line and cut whole.
      if (this.afterTagLine && this.chinese) {
        const paragraph = englishParagraphAfterTag(body, final);
        if (paragraph === 'wait') return '';
        this.afterTagLine = false;
        if (paragraph) {
          this.record('english-note', paragraph);
          this.held = body.slice(paragraph);
          this.afterDraft = true;
          if (++drops > MAX_DROPPED_UNITS) return this.release(this.held.trimStart());
          continue;
        }
      }
      // Chinese chat: a note block (reply-self-note.ts), judged a sentence at a time; its first sentence, held to its end.
      if (this.noteBlock) {
        const step = this.noteStep(body, final);
        if (step === null || step === 'old') continue;
        return step;
      }
      if (this.chinese && !this.afterDraft && SELF_NOTE_OPENERS.some(opener => body.startsWith(opener))) {
        const first = this.noteHead(body, final);
        if (first === 'wait') return '';
        if (first === 'release') return this.release(dropped ? body : this.held);
        if (first !== null) {
          this.record('protocol-talk', first);
          this.held = body.slice(first);
          this.afterDraft = true;
          this.noteBlock = true;
          this.lateMixed = false;
          continue;
        }
      }
      // Chinese chat: a line of a plan block (see "plan blocks" above), held to its end; anything else goes on below.
      const plan = this.chinese ? this.planStart(body, final) : null;
      if (plan === 'wait') return '';
      if (plan) {
        this.record(plan.kind, plan.end);
        this.afterDraft = true;
        this.planBlock = true;
        this.lateMixed = false;
        // The reply glued to the plan's last sentence: the head is over.
        if (plan.glued) return this.release(body.slice(plan.end));
        this.held = body.slice(plan.end);
        if (++drops > MAX_DROPPED_UNITS) return this.release(this.held.trimStart());
        continue;
      }
      const state = openerState(body, dropped ? this.speakers : [], this.chinese, this.speakers);
      if (state === 'latin' || state === 'mixed') {
        // Chinese chat: English (or a few Chinese characters and English) in front of the reply, held to the end of its run.
        if (state === 'mixed') this.lateMixed = false;
        const prefix = state === 'mixed' ? MIXED_START.exec(body)![0].length : 0;
        // A mixed start with one English word in front of Chinese ("哈哈 OK，来！") is ordinary; a plan runs to the end of its line.
        const mixed = state === 'mixed' ? chineseLatinState(body.slice(prefix)) : null;
        if (mixed === 'none') return this.release(dropped ? body : this.held);
        if (mixed === 'maybe') return final ? this.release(dropped ? body : this.held) : '';
        const run = body.slice(prefix);
        const tail = state === 'latin' ? latinRunEnd(run, final) : extractUnit(run, final);
        // A run longer than its cap goes out unjudged, whether it is still open or arrived whole (runCap): the cap is measured
        // on the run itself, not on what is buffered behind it, so a line break that arrives with it (or a CR and an LF split
        // across chunks) never pushes a 600-character plan over the limit (Codex T-207 round 8, B03/B05/B07).
        if (tail === null) return openEnd(run) > this.runCap(run) ? this.release(dropped ? body : this.held) : '';
        if (tail > this.runCap(run)) return this.release(dropped ? body : this.held);
        const end = prefix + beforeEllipsis(run.slice(0, tail), run.slice(tail));
        const english = body.slice(prefix, end);
        // Whether the Chinese reply follows it decides the last rule; wait for the first character after the line (nextLanguage
        // looks no further than NEXT_WINDOW characters, so this wait is bounded by the text, not by the chunks).
        const next = nextLanguage(body.slice(end), final);
        if (next === null) return '';
        const beforeChinese = next === 'chinese' && englishBeforeChinese(english) && (!this.englishAsked || namesTheSetUp(english, this.afterDraft));
        if (!this.englishNote(english) && !this.chatNote(english) && !beforeChinese) return this.release(dropped ? body : this.held);
        this.record(state === 'mixed' ? 'mixed-note' : 'english-note', end);
        this.held = body.slice(end);
        this.afterDraft = true;
        if (++drops > MAX_DROPPED_UNITS) return this.release(this.held.trimStart());
        continue;
      }
      if (state === 'none' && !this.afterDraft) return this.release(dropped ? body : this.held);
      if (state === 'maybe' && !this.afterDraft) return final ? this.release(dropped ? body : this.held) : '';
      if (state !== 'none' && /^Draft\s*[:：]/u.test(body)) {
        // A draft block only counts once its closing "Delta:" line shows up; until then it is held, and if it never
        // does, the whole thing (label included) was the reply and goes out unchanged.
        const label = /^Draft\s*[:：]/u.exec(body)![0];
        this.block = { text: body.slice(label.length), original: this.held };
        this.held = '';
        continue;
      }
      // The sentence is held to its end and judged whole. Both checks below read only the sentence up to the character that
      // ends it (`mark`), never how much of it has arrived, so it goes the same way whole or in pieces (2026-11-05,
      // docs/claude/2026-11-05-reply-guard-last-paths.md; before, a sentence that came whole was judged where the same sentence
      // in pieces went out early, at 240 characters or at its first "我/呢/～").
      // A numbered plan item ("1. 回复……"): its list number is not a sentence of its own.
      const numbered = this.chinese && state === 'unit' && NUMBERED_ITEM.test(body) ? NUMBERED_ITEM.exec(body)![0].length : 0;
      const itemBounds = numbered ? unitBounds(body.slice(numbered), final) : null;
      const bounds = numbered ? itemBounds && { ...itemBounds, end: itemBounds.end + numbered, mark: itemBounds.mark + numbered } : unitBounds(body, final);
      const open = bounds ? bounds.mark : openEnd(body);
      // A start that only looked like a note (PLAN_OPENERS, not the older openers) goes out as soon as it is clearly said to
      // someone: at its first word said to someone, unless the words before that one already name the user or how to answer
      // ("这一轮用户又夸我了，回复要短一点。" is a plan that says "我"); that one is judged whole at its end.
      const speech = this.chinese && !this.afterDraft && planOpener(body) && !CN_OPENERS.some(opener => body.startsWith(opener))
        ? SPEECH_MARKER.exec(body.slice(0, open)) : null;
      if (speech && !namesPlanWords(body.slice(0, speech.index + speech[0].length))) return this.release(dropped ? body : this.held);
      // A sentence that does not end within its cap goes out unjudged, whether it was still open or arrived whole. The cap is
      // HOLD_CAP unless its first HOLD_CAP characters already look like talk about the reply (sentenceCap): right behind a
      // dropped plan this is often her own reply, and that one waits no longer than before.
      if (open > HOLD_CAP && open > sentenceCap(body.slice(0, HOLD_CAP), this.afterDraft)) return this.release(dropped ? body : this.held);
      if (!bounds) return '';
      const end = bounds.end;
      const unit = body.slice(0, end);
      const kind = this.judge(unit);
      if (!kind) {
        // Chinese chat: a plain first sentence that starts like a note to itself ("又被夸了，第三回。") is judged with the
        // sentence after it ("回复短一点，带点害羞。"); a sentence said to someone (你/我, a particle, ！？) goes out at once.
        if (!this.chinese || this.afterDraft || !planOpener(body) || SPEECH_MARKER.test(unit)) return this.release(dropped ? body : this.held);
        const rest = body.slice(end);
        const next = rest.trimStart();
        const second = next ? unitBounds(next, final) : null;
        // The pair is judged only when the second sentence ends within HOLD_CAP characters of the first one's start.
        if ((second ? end + rest.length - next.length + second.mark : openEnd(body)) > HOLD_CAP) return this.release(dropped ? body : this.held);
        if (!next) return final ? this.release(dropped ? body : this.held) : '';
        if (!second) return '';
        if (!isChinesePlan(next.slice(0, second.end), false)) return this.release(dropped ? body : this.held);
        this.record('protocol-talk', end);
        this.record('protocol-talk', rest.length - next.length + second.end);
        this.held = next.slice(second.end);
        this.afterDraft = true;
        if (++drops > MAX_DROPPED_UNITS) return this.release(this.held.trimStart());
        continue;
      }
      // The reply's own leading "……" after the note stays with the reply (as in the English-run branch above).
      const cut = beforeEllipsis(unit, body.slice(end));
      this.record(kind, cut);
      this.held = body.slice(cut);
      // A note about the user ("用户想……。") opens a note block: the sentences behind it are judged one at a time.
      if (this.chinese && !this.afterDraft && isUserNote(unit)) { this.noteBlock = true; this.lateMixed = false; }
      this.afterDraft = true;
      if (++drops > MAX_DROPPED_UNITS) return this.release(this.held.trimStart());
    }
  }

  /**
   * Chinese chat: `body` starts with a label and a colon, or (inside a plan block) with English. `'wait'`: hold it to the end
   * of its line. null: not a plan line, the older rules go on. Otherwise how much goes and whether the reply is glued to it.
   */
  private planStart(body: string, final: boolean): 'wait' | { kind: DraftKind; end: number; glued: boolean } | null {
    const label = PLAN_LABEL.exec(body)?.[0];
    const word = label?.replace(/[ \t]*[:：][ \t]*$/u, '');
    let start = 0;
    // Her own name as a speaker ("Momo：") and the older English labels ("Draft:", "Delta:") keep their own rules.
    if (label && word && !this.speakers.includes(word) && !LABEL_OPENERS.includes(word)) start = label.length;
    else if (!(this.planBlock && /^[A-Za-z]/u.test(body))) return null;
    const verdict = planParagraph(body, start, final, this.afterDraft, this.englishAsked);
    if (verdict.kind !== 'plan') return verdict.kind === 'wait' ? 'wait' : null;
    const kind: DraftKind = start === 0 || !HAN.test(body[0]) ? 'english-note' : verdict.english ? 'mixed-note' : 'protocol-talk';
    return { kind, end: verdict.end, glued: verdict.glued };
  }

  private judge(unit: string): DraftKind | null {
    const text = unit.trim();
    if (!/[　-鿿＀-￯]/u.test(text)) return this.englishNote(text) || (this.chinese && this.chatNote(text)) ? 'english-note' : null;
    if (this.dropped.length === 0 && (/^的(?![㐀-鿿぀-ヿ])/u.test(text) || /^[㐀-鿿]\s+thinking\s*$/iu.test(text))) return 'garbled-start';
    return isProtocolTalk(text, this.afterDraft) || (this.chinese && (isChinesePlan(text, this.afterDraft) || isUserNote(text))) ? 'protocol-talk' : null;
  }

  // ---------------------------------------------------------------- note blocks (Chinese chat, 2026-11-07)

  /** Inside a note block (reply-self-note.ts): plain sentences held at the start of `held`, how many characters. */
  private notePending = 0;
  private noteBlock = false;
  /** Characters cut inside this note block; past PARAGRAPH_CAP the rest goes out as it is. */
  private noteChars = 0;

  /**
   * The first sentence of a head that starts like a self-note (SELF_NOTE_OPENERS): `'release'` as soon as it is said to someone
   * before it names the user or how to answer; its length when it is a note; null when it is not (the older rules go on).
   */
  private noteHead(body: string, final: boolean): 'wait' | 'release' | number | null {
    const bounds = noteUnitBounds(body, final);
    const open = bounds ? bounds.mark : openEnd(body);
    const prefix = withoutQuotes(body.slice(0, open));
    const speech = SPEECH_MARKER.exec(prefix);
    if (speech && !namesPlanWords(prefix.slice(0, speech.index + speech[0].length))) return 'release';
    if (open > HOLD_CAP) return null;
    if (!bounds) return 'wait';
    const unit = body.slice(0, bounds.end);
    return isUserNote(unit) || isChinesePlan(withoutQuotes(unit), false) ? beforeEllipsis(unit, body.slice(bounds.end)) : null;
  }

  /**
   * One step inside a note block: the next sentence after the plain ones held (notePending). A note is cut together with them;
   * a sentence said to someone begins the reply, and the plain sentences in front of it go out with it, as at the end of the
   * text. Returns what to hand on (the head is over), or null to look at the next sentence.
   */
  private noteStep(body: string, final: boolean): string | null | 'old' {
    const after = body.slice(this.notePending);
    const lead = /^\s*/u.exec(after)![0].length;
    const sentence = after.slice(lead);
    if (!sentence) return final ? this.release(body) : '';
    if (sentence[0] === '<') return sentence.length < 4 && '<sh-'.startsWith(sentence) && !final ? '' : this.release(body);
    // A "Draft:" block keeps its own rule (it runs to its "Delta:" line); the plain sentences in front of it go with the notes.
    if (/^D(?:r(?:a(?:f(?:t)?)?)?)?$/u.test(sentence) && !final) return '';
    if (/^Draft\s*[:：]/u.test(sentence)) {
      if (this.notePending) this.record('protocol-talk', this.notePending);
      this.held = body.slice(this.notePending);
      this.notePending = 0;
      this.noteBlock = false;
      return 'old';
    }
    const bounds = noteUnitBounds(sentence, final);
    const open = bounds ? bounds.mark : openEnd(sentence);
    // Held no longer than BLOCK_CAP characters of plain sentences and the one still open, measured to its end mark, so it goes
    // the same way whole or in pieces.
    if (this.notePending + lead + open > BLOCK_CAP) return this.release(body);
    if (!bounds) return '';
    const verdict = noteVerdict(sentence.slice(0, bounds.end), text => this.chatNote(text) || this.englishNote(text));
    if (verdict === 'speech') return this.release(body);
    if (verdict === 'plain') { this.notePending += lead + bounds.end; return null; }
    const cut = this.notePending + lead + bounds.end;
    this.record('protocol-talk', cut);
    this.noteChars += cut;
    this.notePending = 0;
    this.held = body.slice(cut);
    return this.noteChars > PARAGRAPH_CAP ? this.release(this.held.trimStart()) : null;
  }

  /** `'wait'`: the block is not closed yet. `'dropped'`: it was cut and scanning goes on. Otherwise: the block was the reply itself; this text is to be released. */
  private closeBlock(final: boolean): 'wait' | 'dropped' | string {
    const block = this.block!;
    block.text += this.held;
    block.original += this.held;
    this.held = '';
    // The reply protocol's own marker ends the block: a "Draft:" with no "Delta:" line before it was the reply.
    const marker = block.text.indexOf('<sh-');
    const close = /(?:^|\n)[ \t]*Delta\s*[:：]/u.exec(marker >= 0 ? block.text.slice(0, marker) : block.text);
    if (!close && marker >= 0) { this.block = null; return block.original; }
    if (close) {
      const from = block.text.indexOf('Delta', close.index);
      const end = extractUnit(block.text.slice(from), final);
      if (end === null) return 'wait';
      this.record('draft-block', block.original.length - (block.text.length - from - end));
      this.held = block.text.slice(from + end);
      this.block = null;
      this.afterDraft = true;
      return 'dropped';
    }
    if (final || block.text.length > BLOCK_CAP) { this.block = null; return block.original; }
    return 'wait';
  }

  // ---------------------------------------------------------------- after the head

  /**
   * Passes text on; for the first ZONE characters it still watches for an English note that started late. "Late" means
   * right behind a stray label that was already shown ("发力: Respond as…"); the same words in the middle of a sentence
   * (the user's own words quoted back, say) are ordinary text.
   */
  private post(text: string, final: boolean): string {
    let pending = this.watch + text;
    this.watch = '';
    let out = '';
    const give = (value: string): void => {
      if (this.labelResidue && !this.shownAfterLabel && !this.markerSeen) {
        // Only the reply counts: the protocol's private tail ("<sh-…") also passes through here. A start of it split off ("<s")
        // is held by the head and comes with the rest of its marker.
        const joined = this.lastReleased + value, at = joined.indexOf('<sh-');
        if (at >= 0) this.markerSeen = true;
        if (/\S/u.test(at < 0 ? value : joined.slice(this.lastReleased.length, Math.max(at, this.lastReleased.length)))) this.shownAfterLabel = true;
      }
      out += value; this.releasedChars += value.length; this.lastReleased = (this.lastReleased + value).slice(-8);
      if (this.releasedText.length < 16) this.releasedText = (this.releasedText + value).slice(0, 16);
    };
    if (this.lateMixed) {
      const late = this.lateMixedStart(pending, final);
      if (late.kind === 'hold') { give(late.give); this.watch = late.hold; return this.stripClose(out, final); }
      if (late.kind === 'dropped') {
        if (/\S/u.test(this.releasedText)) this.labelResidue = true;
        // The plan goes; what follows is judged like the rest of a head that already had a draft in it. A reply glued to a
        // plan line goes on as the reply.
        this.record(late.plan?.kind ?? 'mixed-note', late.chars);
        if (late.plan?.glued) pending = late.rest;
        else {
          this.phase = 'head';
          this.afterDraft = true;
          if (late.plan) this.planBlock = true;
          this.held = late.rest;
          return this.stripClose(out, final) + this.head(final);
        }
      }
    }
    if (this.chinese && (this.planWatch || this.releasedChars < LATE_PLAN_ZONE)) pending = this.latePlan(pending, final);
    while (pending) {
      const found = this.releasedChars >= ZONE ? null : this.findCandidate(pending);
      if (found === null) { give(pending); break; }
      give(pending.slice(0, found));
      pending = pending.slice(found);
      if (!/[:：]\s*$/u.test(this.lastReleased)) {
        const word = /^[A-Za-z]+/u.exec(pending)![0].length;
        give(pending.slice(0, word));
        pending = pending.slice(word);
        continue;
      }
      const end = extractUnit(pending, final);
      if (end === null) {
        if (pending.length > HOLD_CAP) give(pending); else this.watch = pending;
        break;
      }
      const unit = pending.slice(0, end);
      if (isEnglishNote(unit, false)) this.record('english-note', unit.length); else give(unit);
      pending = pending.slice(end);
    }
    return this.stripClose(out, final);
  }

  /**
   * Chinese chat: the head let a few Chinese characters out (a first chunk "按"), and English may follow them. While the
   * reply could still be that shape, more Chinese characters pass at once and only a trailing blank waits; once English
   * follows, that English line is held to its end and dropped (with the characters not yet shown) if it is a plan.
   * Anything else ends the check for this reply.
   */
  private lateMixedStart(pending: string, final: boolean):
    { kind: 'hold'; give: string; hold: string } | { kind: 'dropped'; chars: number; rest: string; plan?: { glued: boolean; kind: DraftKind } } | { kind: 'pass' } {
    const pass = (): { kind: 'pass' } => { this.lateMixed = false; return { kind: 'pass' }; };
    // The label in front ("按", "发力", "XY") is up to four characters that are not letters, blanks or brackets; then a colon, a blank or both.
    const shown = this.releasedText.trimStart();
    const lead = /^[^\sA-Za-z0-9<>"'“‘（(【[:：]*/u.exec(pending)![0];
    if (!/^[^\sA-Za-z0-9<>"'“‘（(【[:：]*[:：]?$/u.test(shown) || [...(shown + lead).replace(/[:：]$/u, '')].length > 4) return pass();
    const after = pending.slice(lead.length);
    if (!after) return { kind: 'hold', give: lead, hold: '' };
    const colon = /[:：]$/u.test(shown) && !lead ? '' : /^[:：]/u.exec(after)?.[0] ?? '';
    const blank = /^[ \t]*/u.exec(after.slice(colon.length))![0];
    if ((!blank && !colon && !/[:：]$/u.test(shown)) || (!shown && !lead)) return pass();
    const rest = after.slice(colon.length + blank.length);
    if (!rest) return final ? pass() : { kind: 'hold', give: lead, hold: colon + blank };
    // A label and a colon, then a plan line (see "plan blocks" above): held to its end; the characters already shown stay.
    if (colon || /[:：]$/u.test(shown)) {
      const plan = planParagraph(rest, 0, final, false, this.englishAsked);
      if (plan.kind === 'wait') return { kind: 'hold', give: '', hold: pending };
      if (plan.kind === 'plan') {
        this.lateMixed = false;
        const head = lead.length + colon.length + blank.length;
        return { kind: 'dropped', chars: head + plan.end, rest: rest.slice(plan.end), plan: { glued: plan.glued, kind: plan.english ? 'mixed-note' : 'protocol-talk' } };
      }
    }
    if (!/^[A-Za-z]/u.test(rest)) return pass();
    const shape = chineseLatinState(rest);
    if (shape === 'none' || (shape === 'maybe' && final)) return pass();
    if (shape === 'maybe') return { kind: 'hold', give: '', hold: pending };
    // The same English run as a mixed start in the head (its first characters already shown): held and judged by the same rules
    // (runCap on the run itself, the stricter test of a turn that asked for English), so it goes the same way as there.
    const run = unitBounds(rest, final);
    if ((run ? run.mark : openEnd(rest)) > this.runCap(rest)) return pass();
    if (!run) return { kind: 'hold', give: '', hold: pending };
    const end = beforeEllipsis(rest.slice(0, run.end), rest.slice(run.end));
    const next = nextLanguage(rest.slice(end), final);
    if (next === null) return { kind: 'hold', give: '', hold: pending };
    const english = rest.slice(0, end);
    const han = lead + colon + blank;
    if (!isEnglishNote(english, false) && !chineseChatNoteFor(english, false, this.englishAsked)
      && !(next === 'chinese' && englishBeforeChinese(english) && (!this.englishAsked || namesTheSetUp(english, false)))) return pass();
    this.lateMixed = false;
    return { kind: 'dropped', chars: han.length + end, rest: rest.slice(end) };
  }

  /**
   * Chinese chat, after the head, in the first LATE_PLAN_ZONE characters: a later sentence that starts "用户/回复/回应" is held
   * to its end and dropped if it is a note to itself ("用户先前说过嗓子疼，可以问一句也可以不问"), and so is every plan sentence
   * right behind it. Ordinary sentences pass at once; only such a sentence, or a blank between sentences, waits. Returns what
   * may go on now; the rest waits in planWatch.
   */
  private latePlan(pending: string, final: boolean): string {
    let text = this.planWatch + pending, out = '';
    this.planWatch = '';
    const boundary = (): boolean => /[。！？!?\n]\s*$/u.test(this.lastReleased + out);
    while (text) {
      if (this.releasedChars + out.length >= LATE_PLAN_ZONE && !this.lateDraft) { out += text; break; }
      if (!boundary()) {
        const stop = /[。！？!?\n]/u.exec(text);
        if (!stop) { out += text; break; }
        out += text.slice(0, stop.index + 1); text = text.slice(stop.index + 1); continue;
      }
      const lead = /^\s*/u.exec(text)![0], body = text.slice(lead.length);
      if (!body) { if (final) out += text; else this.planWatch = text; break; }
      if (!this.lateDraft && !LATE_PLAN_START.test(body)) {
        if (final || !/^[用回]$/u.test(body)) { const stop = /[。！？!?\n]/u.exec(body); if (!stop) { out += text; break; }
          out += text.slice(0, lead.length + stop.index + 1); text = body.slice(stop.index + 1); continue; }
        this.planWatch = text; break; // "用" or "回" alone: wait for the next character
      }
      // Closing quotes behind the full stop of a sentence just dropped, arriving in the next chunk, belong to it (whole, it took them).
      const close = this.lateDraft ? /^[”’」』）)]+/u.exec(body)?.[0] : undefined;
      if (close) { this.dropped[this.dropped.length - 1].chars += lead.length + close.length; text = body.slice(close.length); continue; }
      // Held to its end, measured up to the character that ends it (as in the head, with the same cap): one that does not end
      // within it goes out unjudged, the same way whether it was still open or arrived whole, and ends a run of dropped sentences.
      const bounds = unitBounds(body, final);
      const open = bounds ? bounds.mark : openEnd(body);
      if (open > HOLD_CAP && open > sentenceCap(body.slice(0, HOLD_CAP), this.lateDraft)) {
        if (this.lateLead) this.dropped[this.dropped.length - 1].chars += lead.length;
        out += (this.lateLead ? '' : lead) + (bounds ? body.slice(0, bounds.end) : body);
        text = bounds ? body.slice(bounds.end) : '';
        this.lateLead = false;
        this.lateDraft = false;
        continue;
      }
      if (!bounds) { this.planWatch = text; break; }
      const end = bounds.end;
      if (isChinesePlan(body.slice(0, end), this.lateDraft)) {
        // The blank in front of it stays (it separates what was said before from what comes next); the blank after it goes with it.
        const after = /^\s*/u.exec(body.slice(end))![0];
        this.record('protocol-talk', end + after.length + (this.lateLead ? lead.length : 0));
        this.lateDraft = true;
        if (!this.lateLead) { out += lead; this.lateLead = true; }
        text = body.slice(end + after.length);
        continue;
      }
      // The first sentence after a dropped run: its blank was handed on in front of the run already.
      if (this.lateLead) this.dropped[this.dropped.length - 1].chars += lead.length;
      out += (this.lateLead ? '' : lead) + body.slice(0, end); text = body.slice(end);
      this.lateLead = false;
      this.lateDraft = false;
    }
    return out;
  }
  private planWatch = '';
  private lateDraft = false;
  /** The blank in front of a run of dropped late sentences was already handed on. */
  private lateLead = false;

  /** Index of the next place in `text` where an English note could start (a known opener, or a partial one at the very end). */
  private findCandidate(text: string): number | null {
    const known = /(?<![A-Za-z])(?:(?:Delta|Tail)\s*[:：]|Footer\s+with\b|Respond\s+(?:as|to|in)\b|[A-Z][a-z]{1,15}\s+(?:again|initial\s+greeting)\b)/u.exec(text);
    if (known) return known.index;
    const partial = /(?<![A-Za-z])[A-Z][A-Za-z]{2,}(?:\s+[A-Za-z ]*)?$/u.exec(text);
    return partial && openerState(partial[0], []) !== 'none' ? partial.index : null;
  }

  /** Removes the closing tag of a wrapper that was dropped at the start; holds a possible partial one back. */
  private stripClose(text: string, final: boolean): string {
    if (!this.wrapper) return text;
    const close = `</${this.wrapper}>`;
    let value = this.closeHold + text;
    this.closeHold = '';
    value = value.split(close).join('');
    if (!final) {
      for (let n = Math.min(value.length, close.length - 1); n > 0; n--) {
        if (close.startsWith(value.slice(-n))) { this.closeHold = value.slice(-n); value = value.slice(0, -n); break; }
      }
    }
    return value;
  }
}

/**
 * The developer-mode diagnostic line for one filtered reply (`<profile>/dev/reply-draft-filter.jsonl`): when, how many
 * pieces, how many characters, which shapes, and whether nothing was left. Counts only, never any text.
 */
export function draftFilterLine(drops: readonly DraftDrop[], whole: boolean, at: number): string {
  const kinds: Partial<Record<DraftKind, number>> = {};
  for (const drop of drops) kinds[drop.kind] = (kinds[drop.kind] ?? 0) + 1;
  return JSON.stringify({ at, drops: drops.length, chars: drops.reduce((sum, drop) => sum + drop.chars, 0), kinds, whole }) + '\n';
}

/** The character's name as the persona text states it ("角色名称：Momo"), for the speaker label a reply sometimes starts with. */
export function speakersFromPersona(persona: string): string[] {
  const name = /(?:^|\n)角色名称：([^\n]{2,40})/u.exec(persona)?.[1]?.trim();
  return name && name.length >= 2 ? [name] : [];
}
