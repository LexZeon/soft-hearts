/**
 * I-209 step 4: what a character on the full-screen stage is told when she decides whether to answer a line, and when she says her line.
 *
 * FACTS ONLY (handbook/how-we-work.md 「提示不是锁」 1–8): who is on stage, who said what just now (and to whom the user said it), how many
 * lines in a row came without the user, how long since the user last spoke, whether the user looks busy or away. No "该停了", no rule about
 * how long to go on, no recognition words: who is addressed is the user's click ("点谁和谁说"), the rest is hers. Only the answer's shape is
 * asked for. Pure: no clock, no Electron, no Claude.
 */

/** One line said on stage. `speaker`: her card id, null for the user. `to`: the card the user clicked for this line (a user line only). */
export interface StageLine { id: string; speaker: string | null; text: string; at: number; to?: string | null }

/** What one character is told (from her side). */
export interface ChimeFacts {
  /** Her card id and name. */
  self: string;
  selfName: string;
  /** Everyone on stage now (her too), with names, in stage order. */
  present: readonly { id: string; name: string }[];
  /** The last lines on stage, oldest first (at most CHIME_RECENT). */
  recent: readonly StageLine[];
  /** Lines said on stage since the user's last line (her reply to the user counts as one). */
  streak: number;
  /** Milliseconds since the user last spoke on stage; null: not on stage since it opened. */
  sinceUserMs: number | null;
  /** The existing user signals: true only when known (null and false say nothing). */
  userBusy: boolean | null;
  userAway: boolean | null;
}

export const CHIME_RECENT = 6;
/** A line in the facts is at most this long (the line itself is in her archive whole). */
const LINE_MAX = 300;

const clip = (text: string) => { const chars = Array.from(text.replace(/\s+/gu, ' ').trim()); return chars.length > LINE_MAX ? chars.slice(0, LINE_MAX).join('') + '…' : chars.join(''); };
const nameOf = (facts: ChimeFacts, id: string | null | undefined) => facts.present.find(person => person.id === id)?.name || '另一位角色';

/** "大约 3 分钟前" / "不到一分钟前". */
export function agoWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到一分钟前';
  if (minutes < 60) return `大约 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return `大约 ${hours} 小时前`;
}

/** Who said a line, from her side: "你（用户）对 Gene 说" / "你（用户）对你说" / "你自己" / "Gene". */
export function whoSaid(facts: ChimeFacts, line: StageLine): string {
  if (line.speaker === null) return line.to && line.to !== facts.self ? `你（用户）对${nameOf(facts, line.to)}说` : '你（用户）对你说';
  return line.speaker === facts.self ? '你自己' : nameOf(facts, line.speaker);
}

/** The facts block (the same in the decision and in her line). */
export function chimeFactsBlock(facts: ChimeFacts): string {
  const others = facts.present.filter(person => person.id !== facts.self).map(person => person.name || '另一位角色');
  const lines = [
    '【此刻】（应用给你的事实，不是谁说的话）',
    `- 你是${facts.selfName || '你自己'}。台上现在还有：${others.join('、') || '没有别人'}。`,
    '- 刚才台上的话（从早到晚）：',
    ...facts.recent.slice(-CHIME_RECENT).map(line => `  · ${whoSaid(facts, line)}：${clip(line.text)}`),
    `- 用户上一句之后，台上接着说了 ${Math.max(0, Math.floor(facts.streak))} 句。`,
    ...(facts.sinceUserMs === null ? [] : [`- 用户上一次开口：${agoWords(facts.sinceUserMs)}。`]),
    ...(facts.userAway === true ? ['- 用户现在看起来不在电脑前。'] : facts.userBusy === true ? ['- 用户现在看起来在忙。'] : []),
  ];
  return lines.join('\n');
}

/** The decision (one haiku call): her card's persona summary as context, the facts, the answer's shape. */
export function chimeDecisionPrompt(persona: string, facts: ChimeFacts): string {
  return [
    clipPersona(persona),
    chimeFactsBlock(facts),
    ['【回答】', '现在开不开口接话，由你自己定。', '只输出一个 JSON 对象：{"speak":true} 或 {"speak":false}，没有别的字。'].join('\n'),
  ].filter(Boolean).join('\n\n');
}

/** The persona as context for the decision: its first part (the decision is small; her whole card goes into her line). */
export function clipPersona(persona: string): string {
  const chars = Array.from(String(persona ?? '').trim());
  return chars.length > 1200 ? chars.slice(0, 1200).join('') + '…' : chars.join('');
}

/** Reads the decision: true only for a clear {"speak":true}; anything else (broken, missing) is no. */
export function parseChimeDecision(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  const objects = raw.match(/\{[^{}]*\}/gu);
  if (!objects) return false;
  try { const data = JSON.parse(objects[objects.length - 1]!); return !!data && typeof data === 'object' && !Array.isArray(data) && data.speak === true; } catch { return false; }
}

export interface ChimeLineInput { persona: string; language?: string; mood?: string; history?: string; facts: ChimeFacts; sight?: string }

/** Her line (one call with her chat model): who she is, how she feels, what was said on stage lately, the facts. Whether and what: hers. */
export function chimeLinePrompt(input: ChimeLineInput): string {
  return [
    input.persona.trim(),
    (input.language ?? '').trim(),
    (input.mood ?? '').trim(),
    (input.history ?? '').trim() ? `【台上之前的话】\n${(input.history ?? '').trim()}` : '',
    (input.sight ?? '').trim(),
    chimeFactsBlock(input.facts),
    ['【怎么说】', '- 说不说、说多少、怎么说，都由你定；不想说时 text 留空。',
      '只输出一个 JSON 对象，只有 text 一个字段，不想说时是 {"text":""}。没有其他字段、解释或代码块。'].join('\n'),
  ].filter(Boolean).join('\n\n');
}

/** Her archive's window as plain lines for her line's prompt (the window already names the speakers; her own lines read as hers). */
export function historyText(messages: readonly { role: 'user' | 'assistant'; content: string }[], selfName: string, max = 12): string {
  return messages.slice(-max).map(message => message.role === 'assistant' ? `${selfName || '你自己'}（你自己）：${clip(message.content)}` : clip(message.content)).join('\n');
}
