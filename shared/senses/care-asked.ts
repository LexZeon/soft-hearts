/**
 * I-017 / real-chat finding 2: the same caring question, at most once per stretch of conversation.
 *
 * What she asks is read from her own finished reply with a cheap local table (no model call, so the first character is
 * untouched), kept as categories only (never text), and told back to her in one short line in the next turns' private
 * context, until the stretch ends (a new chat, or a long silence: CARE_STRETCH_GAP_MS). When the user raises that kind of
 * care themselves in a message, it is not listed for that turn: she may answer it.
 */

export const CARE_KINDS = ['吃饭', '休息睡觉', '累不累', '喝水', '身体', '心情', '今天过得怎样'] as const;
export type CareKind = (typeof CARE_KINDS)[number];

/** A stretch of conversation ends after this much silence (a knob; two hours). */
export const CARE_STRETCH_GAP_MS = 2 * 60 * 60 * 1000;

const KEYWORDS: Readonly<Record<CareKind, RegExp>> = {
  吃饭: /吃饭|吃了|吃过|没吃|饿|早饭|午饭|晚饭|早餐|午餐|晚餐|宵夜|夜宵|吃点|吃什么|用餐/u,
  休息睡觉: /睡|休息|熬夜|歇|早点躺|困不困|困了|眯一会/u,
  累不累: /累|疲|辛苦|撑得住|吃不消|倦/u,
  喝水: /喝水|喝点水|喝了水|口渴|补水|喝口水|热水/u,
  身体: /不舒服|头疼|头痛|感冒|生病|胃|身体|发烧|发热|疼|难受/u,
  心情: /心情|开心|难过|不开心|高兴|烦|还好吗|还好么|怎么了|没事吧|还好不|伤心|委屈/u,
  今天过得怎样: /今天.{0,4}(怎么样|如何|顺利|过得)|过得(怎么样|好吗|还好)|忙不忙|忙吗|忙完/u,
};

/** A sentence counts as a caring ask when it carries a question or a nudge, not just any mention. */
const ASK_SHAPE = /[?？]|(.)不\1|吗|么|呢|没有|了没|没呀|有没有|是不是|要不要|记得|别忘|早点|快去|去.{0,4}吧|该.{0,4}了|可别|不要太|别太|别硬撑/u;

/** Clauses of a reply; the last clause of a sentence carries the sentence's closing mark, so "吃了吗？" keeps its question mark. */
function clausesOf(text: string): string[] {
  const clauses: string[] = [];
  for (const sentence of text.match(/[^。！!？?\n]+[。！!？?]*/gu) ?? []) {
    const parts = sentence.split(/[，,；;、]/u).map(piece => piece.trim()).filter(Boolean);
    const closing = /[？?]+$/u.test(sentence) ? '？' : '';
    parts.forEach((part, index) => clauses.push(index === parts.length - 1 ? part + closing : part));
  }
  return clauses;
}

/** The kinds of care a reply of hers asks about (categories only): questions and nudges, not plain mentions. */
export function careKindsAsked(reply: string): CareKind[] {
  const found = new Set<CareKind>();
  for (const clause of clausesOf(reply))
    if (ASK_SHAPE.test(clause)) for (const kind of CARE_KINDS) if (KEYWORDS[kind].test(clause)) found.add(kind);
  return CARE_KINDS.filter(kind => found.has(kind));
}

/** The kinds of care a user message touches at all (a mention is enough: they raised it themselves). */
export function careKindsMentioned(userText: string): CareKind[] {
  return CARE_KINDS.filter(kind => KEYWORDS[kind].test(userText));
}

export function careAskedLine(kinds: readonly CareKind[]): string {
  return kinds.length ? `这段对话里你已经问过：${kinds.join('、')}。问过的不再问，除非用户自己又提起。` : '';
}

interface Stretch { at: number; counts: Map<CareKind, number> }

/** Per conversation: which kinds of care she has asked in the current stretch. Memory only; categories and counts, no text. */
export class CareAskedTracker {
  private readonly stretches = new Map<string, Stretch>();
  constructor(private readonly clock: () => number = Date.now, private readonly gapMs: number = CARE_STRETCH_GAP_MS) {}

  /** Her finished reply: remember which kinds she asked. */
  note(conversationId: string, reply: string): CareKind[] {
    const kinds = careKindsAsked(reply);
    if (!kinds.length) return kinds;
    const now = this.clock();
    let stretch = this.stretches.get(conversationId);
    if (!stretch || now - stretch.at > this.gapMs) { stretch = { at: now, counts: new Map() }; this.stretches.set(conversationId, stretch); }
    stretch.at = now;
    for (const kind of kinds) stretch.counts.set(kind, (stretch.counts.get(kind) ?? 0) + 1);
    if (this.stretches.size > 50) this.stretches.delete(this.stretches.keys().next().value as string);
    return kinds;
  }

  /** How many times she asked each kind in the current stretch (for the experience record and tests). */
  counts(conversationId: string): Partial<Record<CareKind, number>> {
    const stretch = this.stretches.get(conversationId);
    if (!stretch || this.clock() - stretch.at > this.gapMs) return {};
    return Object.fromEntries(stretch.counts);
  }

  /** The one line for this turn ('' when nothing is to be said). Kinds the user is raising in this very message are left out. */
  line(conversationId: string, userText: string): string {
    const counts = this.counts(conversationId);
    const raised = new Set(careKindsMentioned(userText));
    return careAskedLine(CARE_KINDS.filter(kind => counts[kind] && !raised.has(kind)));
  }
}
