// I-021 step 2 (docs/claude/2026-11-04-memory-notes.md): when the user speaks, look in the notes first — by name, place,
// shop, event and the note's own near words — and point at the original segment. Local string matching only: nothing on the
// reply path calls a model. What reaches the chat model is still the original excerpt (electron/memory.ts retrieve).
// Pure: no clock, no I/O.

import { hasExplicitRecallCue } from '../memory';
import type { MemoryNoteBody, MemoryNoteHint } from './interface';
import { MEMORY_NOTES_KNOBS, type MemoryNotesKnobs } from './knobs';
import { recallTitle } from './note';

/** Matching form: compatibility-normalized, lower case, no spaces, punctuation or symbols. */
export const squashText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const HAN = /^\p{Script=Han}+$/u;
const LATIN = /^[\p{Script=Latin}\p{N}]+$/u;

/** Words that point at nothing in particular; a note term that is only this never matches. */
export const VAGUE_TERMS = new Set(['日常', '聊天', '闲聊', '对话', '心情', '情绪', '用户', '角色', '她', '我', '你', '我们', '今天', '明天', '昨天',
  '最近', '事情', '东西', '时间', '一起', '生活', '感受', '这件事', '那件事', '计划', '打算', 'chat', 'daily']);
/** Two-character runs too common to count as half a word ("拉面店" → "拉面" counts, "今天" does not). */
const COMMON_PAIRS = new Set(['今天', '明天', '昨天', '我们', '你们', '他们', '一个', '什么', '怎么', '这个', '那个', '时候', '还是', '就是', '可以',
  '没有', '知道', '觉得', '现在', '已经', '一起', '一下', '有点', '新开', '开的', '的店', '去了', '一家', '一次']);
/** What follows "那家/那部/那个…" that names no thing ("那个人", "那个时候", "那件事"). */
const VAGUE_HEADS = new Set(['事', '人', '个', '天', '时', '时候', '次', '样', '种', '些', '边', '里', '会', '么', '是', '就', '我', '你', '他', '她',
  '的', '了', '吗', '呢', '啊', '吧', '也', '还', '都', '在', '说', '要', '想', '去', '有', '没', '好', '不']);

/** "那家店""那部电影""那次旅行": a thing from before, named by its head word. Only 那 (这 points at what is in front of you now). */
const POINTER = /那(?:家|间|座|所|部|本|首|只|位|个|款|场|条|张|台|辆|种|篇|集|期|门|项|份|顿|趟|次|回)(\p{Script=Han}{1,3})/gu;
/** Asking how a plan went. */
const FOLLOW_UP = /(?:去|来|回|做|买|见|吃|看|弄|办|考|搞|试|玩|写|交|约|聊)(?:了吗|了没|过了吗|过没|完了吗|好了吗|成了吗)|怎么样了|后来呢|后来怎么|结果呢|结果怎么|进展/u;
/** Talking about before, beyond shared/memory.ts hasExplicitRecallCue. */
const BEFORE = /那件事|那个事|那天|那回|上回|之前说|你说过|我说过|说过的|提过|跟你说的|和你说的/u;

export interface NoteQuery {
  readonly squashed: string;
  readonly cue: boolean;
  readonly followUp: boolean;
  /** What came after each "那家/那部…" (up to three characters). */
  readonly pointers: readonly string[];
}

/** Once per user message. Null for an empty one. */
export function prepareNoteQuery(text: string): NoteQuery | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const source = text.normalize('NFKC');
  return {
    squashed: squashText(source),
    cue: hasExplicitRecallCue(source) || BEFORE.test(source),
    followUp: FOLLOW_UP.test(source),
    pointers: [...source.matchAll(POINTER)].map(match => match[1]),
  };
}

interface NoteTerm { readonly key: string; readonly original: string; readonly kind: 'person' | 'thing' | 'tag' }
export interface PreparedNote {
  readonly title: string;
  readonly terms: readonly NoteTerm[];
  readonly plans: readonly string[];
}

/** Once per note (cached by the host until the note changes). */
export function prepareNote(note: MemoryNoteBody): PreparedNote {
  const terms: NoteTerm[] = [];
  const add = (original: string, kind: NoteTerm['kind']) => {
    const key = squashText(original);
    if (!key || VAGUE_TERMS.has(key) || terms.some(term => term.key === key)) return;
    if (LATIN.test(key) ? key.length < 3 : Array.from(key).length < 2) return;
    terms.push({ key, original: original.trim(), kind });
  };
  for (const person of note.people) add(person, 'person');
  for (const thing of note.things) add(thing, 'thing');
  for (const tag of note.tags) add(tag, 'tag');
  return { title: recallTitle(note), terms, plans: note.plans.map(squashText).filter(Boolean) };
}

/**
 * How much this note says the user's message is about its segment. Null when it is not enough: with a "talking about before"
 * cue the note needs knobs.recall.withCue, otherwise knobs.recall.withoutCue (so a passing "周末" alone brings nothing back).
 */
export function noteHint(query: NoteQuery, note: PreparedNote, knobs: MemoryNotesKnobs = MEMORY_NOTES_KNOBS): MemoryNoteHint | null {
  const k = knobs.recall;
  let score = 0, partial = 0;
  const matched = new Set<string>(), keys: string[] = [];
  for (const term of note.terms) {
    if (query.squashed.includes(term.key)) {
      score += term.kind === 'person' ? k.person : Array.from(term.key).length >= 3 ? k.longTerm : k.shortTerm;
      matched.add(term.original); keys.push(term.key);
      continue;
    }
    const chars = Array.from(term.key);
    if (term.kind === 'person' || chars.length < 3 || !HAN.test(term.key)) continue;
    const pairs = [chars.slice(0, 2).join(''), chars.slice(-2).join('')].filter(pair => !COMMON_PAIRS.has(pair));
    if (pairs.some(pair => query.squashed.includes(pair))) { partial += k.partial; matched.add(term.original); keys.push(term.key); }
  }
  score += Math.min(partial, k.partial * 2);
  let pointed = '';
  for (const capture of query.pointers) {
    const chars = Array.from(capture);
    for (let size = Math.min(3, chars.length); size >= 1 && !pointed; size--) {
      const head = chars.slice(0, size).join('');
      if (VAGUE_HEADS.has(head)) continue;
      const term = note.terms.find(item => item.kind !== 'person' && item.key.endsWith(head));
      if (term) { pointed = head; matched.add(term.original); keys.push(term.key); }
    }
    if (pointed) break;
  }
  if (pointed) score += k.pointer;
  const asksPlan = query.followUp && note.plans.length > 0;
  if (asksPlan) {
    score += k.followUp;
    if (note.plans.some(plan => [...keys, pointed].some(key => key && plan.includes(key)))) score += k.planHit;
  }
  if (score <= 0) return null;
  const cue = query.cue || !!pointed || asksPlan;
  if (score < (cue ? k.withCue : k.withoutCue)) return null;
  return { score, explicit: cue, terms: [...matched], title: note.title };
}
