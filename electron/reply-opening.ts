// I-046 只放行开头标记之后的话 (docs/claude/2026-11-07-draft-leak-envelope-plan.md; the user said "做" on 2026-11-07).
//
// The shape filter (reply-draft-guard.ts) can only cut a draft that looks like one seen before. On 2026-11-07 a Chinese plan with
// no fixed opening went through whole and was read aloud. So every turn now carries an opening marker with this turn's code, and
// only what she writes after it is shown, read aloud and archived: whatever came in front of it is dropped, whatever it looks like.
//   * The reply streams from the marker on, as before (the head filter still runs on what follows it).
//   * An older turn's marker, or one she made up, does not count.
//   * No marker (she forgot it): nothing is shown until her words are complete (the state tail began, or the stream ended). Then the
//     words only the protocol uses ("正文：", 尾注, a memorial field…) cut what stands in front of the reply, and the head filter runs
//     on the rest as it always did. With none of those words the text is exactly what it was.
//   * The marker with nothing behind it (she put it after her reply): handled like a forgotten one.
// The protocol text never says 信 / 信封 / letter / envelope (22:5x: her way of speaking must not change).

import { INTERNAL_WORD_RULES, type InternalWordRule, type ReplyMarkerState } from '../shared/reply-check';

/**
 * The app's switch: electron/main.ts passes it to CompanionService.setReplyOpening (off there by default, so the older tests keep
 * the protocol they cover). Off, the reply protocol is byte for byte what it was before I-046; the check of what was shown (the
 * journal's reply-check line, residue only) runs either way.
 *
 * OFF (2026-11-07): the real-Claude A/B did not clear the plan's 150 ms line for her first character
 * (docs/claude/2026-11-07-draft-leak-envelope.md). The stream sends a tiny first piece and then usually pauses before the rest; with a
 * marker that first piece is the invisible marker, so the pause comes before her first word. The user decides whether to accept it.
 */
export const REPLY_OPENING_ENABLED = false;
/**
 * Which marker:
 *   turn   the plan's form: this turn's code (`<sh-open-xxxxxxxx>`), named by one sentence at the start of the turn's protocol text;
 *   fixed  one marker for every turn (`<sh-open>`), named once in the fixed system prompt; the turn's text stays as it was.
 * The first-character A/B decides (docs/claude/2026-11-07-draft-leak-envelope.md).
 */
export type OpeningMode = 'turn' | 'fixed';
export const REPLY_OPENING_MODE: OpeningMode = 'turn';
/** The mode the app runs with, or false (off): what main.ts, the system prompts and the evaluation use. */
export const APP_REPLY_OPENING: OpeningMode | false = REPLY_OPENING_ENABLED ? REPLY_OPENING_MODE : false;

/** Hex characters of this turn's code in the marker: the first ones of the state tail's nonce (fewer tokens before her first word). */
export const OPENING_CODE_CHARS = 8;
export const openingMarker = (nonce: string): string => `<sh-open-${nonce.slice(0, OPENING_CODE_CHARS)}>`;
/** What this turn's protocol text begins with in place of "先正常回复用户。" ('turn'). */
export const openingSentence = (marker: string): string => `给用户的回复写在本轮开头标记${marker}之后。`;
/** The one marker of every turn ('fixed'). */
export const FIXED_OPENING_MARKER = '<sh-open>';
/** The fixed system prompt's sentence naming it ('fixed'): the same thing the turn sentence says, said once. */
export const OPENING_SYSTEM_SENTENCE = `每一轮给用户的回复都写在开头标记${FIXED_OPENING_MARKER}之后。`;

/** A well-formed opening marker of any form: one of another turn, or one she made up, when it is not this turn's. */
const OPENING_SHAPE = /<\/?sh-open(?:-[a-f0-9]{1,32})?>/iu;
/** Any opening-marker shape, also cut off before its ">": never shown. */
const ANY_OPENING = /<\/?sh-open(?:-[a-f0-9]{0,32})?>?/giu;

type WordRule = Exclude<InternalWordRule, 'english-line'>;
const WORD_RULES = INTERNAL_WORD_RULES.filter((rule): rule is WordRule => rule !== 'english-line');
const RULES: Readonly<Record<WordRule, RegExp>> = {
  marker: /<\/?sh-(?:open(?:-[a-f0-9]{0,32})?|(?:state|memorial|setting)-[a-f0-9]{0,32})>?/iu,
  'body-label': /正文\s*[:：]/u,
  'tail-word': /尾注|状态标记|开头标记|私有上下文/u,
  'memorial-field': /纪念(?:邀请|提议)|私有提议|(?<![A-Za-z])["“]?(?:quote|purpose|invite)["”]?\s*[:：=]/iu,
  'field-name': /(?<![A-Za-z])["“]?(?:context|delta|confidence|gesture)["”]?\s*[:：=]/iu,
};
/**
 * Units of their own whatever is around them: a marker, and a drafted reply's label. With `wholeLine` the label takes the rest of its
 * line along (a draft of the reply, when more follows it); without, only the label (the reply itself follows it on the line).
 */
const hardSource = (rule: WordRule, wholeLine: boolean): string | null =>
  rule === 'marker' ? String.raw`<\/?sh-(?:open(?:-[a-f0-9]{0,32})?|(?:state|memorial|setting)-[a-f0-9]{0,32})>?`
    : rule === 'body-label' ? String.raw`正文\s*[:：]` + (wholeLine ? String.raw`[^\n]*` : '') : null;

/** The rules that count this turn: one the user's own message also matches does not (she may be talking about 尾注 in a thesis). */
function activeRules(userText: string): WordRule[] {
  return WORD_RULES.filter(rule => !RULES[rule].test(userText));
}
/** A sentence of English words only (three or more, no Chinese or Japanese or Korean): in a Chinese chat, self-talk inside a plan. */
const englishLine = (unit: string): boolean => !/[㐀-鿿぀-ヿ가-힯]/u.test(unit) && /[A-Za-z]{2,}(?:[\s,.'’-]+[A-Za-z]{2,}){2,}/u.test(unit);

/** Which of the protocol's own words `text` holds (none that the user's message holds too). Names only, for the reply's check. */
export function internalWords(text: string, userText = ''): InternalWordRule[] {
  return activeRules(userText).filter(rule => RULES[rule].test(text));
}

interface Unit { start: number; end: number; rules: InternalWordRule[] }

/** Lines and sentences of `text`; a marker and a "正文：" label (with the rest of its line, `wholeLine`) are units of their own. */
function unitsOf(text: string, active: readonly WordRule[], wholeLine: boolean): Unit[] {
  const units: Unit[] = [];
  const add = (start: number, end: number, rules?: InternalWordRule[]) => {
    if (end > start) units.push({ start, end, rules: rules ?? active.filter(rule => RULES[rule].test(text.slice(start, end))) });
  };
  const soft = (from: number, to: number) => {
    const ends = /\n|[。！？!?…]+[”’」』）)]*/gu;
    ends.lastIndex = from;
    let start = from;
    for (let match = ends.exec(text); match && match.index < to; match = ends.exec(text)) {
      const end = Math.min(to, match.index + match[0].length);
      add(start, end); start = end;
    }
    add(start, to);
  };
  const hard = active.filter(rule => hardSource(rule, wholeLine));
  if (!hard.length) { soft(0, text.length); return units; }
  const pattern = new RegExp(hard.map(rule => `(${hardSource(rule, wholeLine)})`).join('|'), 'giu');
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    soft(at, match.index);
    add(match.index, match.index + match[0].length, [hard[match.slice(1).findIndex(Boolean)]]);
    at = match.index + match[0].length;
  }
  soft(at, text.length);
  return units;
}

export interface OpeningCut { text: string; chars: number; rules: InternalWordRule[] }

/** The last stretch of units without a protocol word ('' when there is none); with `afterPlan`, only one behind the first plan unit. */
function lastClean(text: string, units: readonly Unit[], afterPlan: boolean): string {
  const floor = afterPlan ? units.findIndex(unit => unit.rules.length) + 1 : 0;
  let last = units.length - 1;
  while (last >= floor && (units[last].rules.length || !text.slice(units[last].start, units[last].end).trim())) last--;
  if (last < floor) return '';
  let first = last;
  while (first > floor && !units[first - 1].rules.length) first--;
  return text.slice(units[first].start, units[last].end).replace(ANY_OPENING, '').trim();
}

/**
 * A reply she wrote without this turn's marker: when it holds the protocol's own words, her reply is the last stretch of lines and
 * sentences without any; everything else goes. A "正文：…" line is a draft of the reply when more follows it, and the reply itself
 * when nothing does. In a Chinese chat (`chinese`), a sentence of English words only counts as part of such a plan too. No protocol
 * words: `text` exactly as it is (an English sentence alone never cuts anything). Nothing left: '' (an emptied reply, F4).
 * `afterPlan`: her reply can only come behind the plan (she wrote this turn's marker with nothing after it, so what stands in front
 * of the plan is no reply put before a closing note); without it, a reply in front of a closing note ("…
尾注：") stays.
 */
export function openingCut(text: string, options: { userText?: string; chinese?: boolean; afterPlan?: boolean } = {}): OpeningCut {
  const active = activeRules(options.userText ?? '');
  const english = (units: Unit[]): Unit[] => options.chinese !== true ? units
    : units.map(unit => !unit.rules.length && englishLine(text.slice(unit.start, unit.end)) ? { ...unit, rules: ['english-line'] } : unit);
  const first = unitsOf(text, active, true);
  if (!first.some(unit => unit.rules.length)) return { text, chars: 0, rules: [] };
  const units = english(first);
  const afterPlan = options.afterPlan === true;
  const kept = lastClean(text, units, afterPlan) || lastClean(text, english(unitsOf(text, active, false)), afterPlan);
  const rules = INTERNAL_WORD_RULES.filter(rule => units.some(unit => unit.rules.includes(rule)));
  return { text: kept, chars: Math.max(0, text.trim().length - kept.length), rules };
}

export interface OpeningGateOptions {
  /** This turn's opening marker (openingMarker). */
  marker: string;
  /** Where this turn's private tail begins in `text` (its first private marker), -1 while it has not. */
  tailAt(text: string): number;
  /** `text`, the start of what follows the marker (no leading blanks), may still turn into a private marker. */
  mayBeTail(text: string): boolean;
  /** The user's message this turn (words it holds do not count as the protocol's). */
  userText?: string;
  /** A Chinese chat (and not one asking for English): an English-only sentence inside a plan counts as part of it. */
  chinese?: boolean;
}

/**
 * Stands in front of the reply protocol's stream (MoodReplyProtocol): push() returns what goes on to the head filter and the tail
 * handling now, finish() what is left. Only what follows this turn's marker passes; see the top of this file. The result never
 * depends on where the stream was cut.
 */
export class OpeningGate {
  private phase: 'before' | 'check' | 'open' | 'pass' = 'before';
  /** Before the marker: everything so far. Right after it: what came after it while that is only blanks or a possible tail start. */
  private pending = '';
  private beforeText = '';
  /** In the reply: the end of the last chunk while it may be the start of this turn's marker (or its closing form). */
  private carry = '';
  private readonly closing: string;
  /** How the marker went (null while nothing decided it yet). */
  state: ReplyMarkerState | null = null;
  /** Characters in front of the marker that were dropped ('ok' only). */
  beforeChars = 0;
  /** What the forgotten-marker cut dropped (openingCut), by length and rule names. */
  cutChars = 0;
  rules: InternalWordRule[] = [];

  constructor(private readonly options: OpeningGateOptions) { this.closing = '</' + options.marker.slice(1); }

  push(text: string): string {
    if (!text) return '';
    if (this.phase === 'pass') return text;
    if (this.phase === 'open') return this.reply(text, false);
    if (this.phase === 'check') return this.check(text, false);
    this.pending += text;
    const raw = this.pending, open = raw.indexOf(this.options.marker), tail = this.options.tailAt(raw);
    if (open >= 0 && (tail < 0 || open < tail)) {
      this.beforeText = raw.slice(0, open);
      this.pending = '';
      this.phase = 'check';
      return this.check(raw.slice(open + this.options.marker.length), false);
    }
    if (tail >= 0) { this.pending = ''; return this.forgotten(raw.slice(0, tail), raw.slice(tail), 'missing'); }
    return '';
  }

  /**
   * The stream ended. `complete`: it ended as a finished reply. A turn that was stopped, superseded or failed before her words after
   * the marker began shows nothing of what it held: only text after this turn's marker is ever shown for it.
   */
  finish(complete = true): string {
    if (!complete && (this.phase === 'before' || this.phase === 'check')) {
      this.state = this.phase === 'check' ? 'empty' : OPENING_SHAPE.test(this.pending) ? 'foreign' : 'missing';
      this.pending = ''; this.beforeText = ''; this.phase = 'pass';
      return '';
    }
    if (this.phase === 'before') { const raw = this.pending; this.pending = ''; return this.forgotten(raw, '', 'missing'); }
    if (this.phase === 'check') return this.check('', true);
    if (this.phase === 'open') return this.reply('', true);
    return '';
  }

  /** The private tail began downstream: whatever the gate still holds belongs to it, as written. Nothing is held after this. */
  release(): string {
    const held = this.carry + this.pending;
    this.carry = ''; this.pending = '';
    this.phase = 'pass';
    return held;
  }

  /** Right behind the marker: blanks go, and a tail right there means nothing came after the marker. */
  private check(text: string, final: boolean): string {
    this.pending += text;
    const body = this.pending.replace(/^\s+/u, '');
    if (!body && !final) return '';
    if (body && !final && this.options.tailAt(body) !== 0 && this.options.mayBeTail(body)) return '';
    this.pending = '';
    if (!body || this.options.tailAt(body) === 0 || (final && this.options.mayBeTail(body))) return this.forgotten(this.beforeText, body, 'empty');
    this.state = 'ok';
    this.beforeChars = this.beforeText.trim().length;
    this.beforeText = '';
    this.phase = 'open';
    return this.reply(body, final);
  }

  /** In the reply: this turn's marker written again, or closed, is not shown. */
  private reply(text: string, final: boolean): string {
    let value = (this.carry + text).split(this.options.marker).join('').split(this.closing).join('');
    this.carry = '';
    for (let n = Math.min(value.length, this.closing.length - 1); n > 0; n--) {
      const end = value.slice(-n);
      if (!this.options.marker.startsWith(end) && !this.closing.startsWith(end)) continue;
      // At the very end a cut-off marker is dropped; a lone "<" (or "</", "<s") is ordinary text.
      if (final) { if (/^<\/?sh-/u.test(end)) value = value.slice(0, -n); }
      else { this.carry = end; value = value.slice(0, -n); }
      break;
    }
    return value;
  }

  /** No usable marker in front of the tail: the cut for a forgotten marker, then the text goes on (with its tail, if any). */
  private forgotten(visible: string, rest: string, state: ReplyMarkerState): string {
    this.phase = 'pass';
    this.state = state === 'missing' && OPENING_SHAPE.test(visible) ? 'foreign' : state;
    const cut = openingCut(visible, { userText: this.options.userText, chinese: this.options.chinese, afterPlan: state === 'empty' });
    this.beforeText = '';
    if (!cut.rules.length) return visible + rest;
    this.rules = cut.rules;
    this.cutChars = cut.chars;
    return cut.text + (cut.text && rest ? '\n' : '') + rest;
  }
}
