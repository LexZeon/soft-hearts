import type { ProactiveOrigin } from '../foundation/chat';
import type { MemorySpeaker } from './speaker';

/** Private text archives. None of these records grant tools, file paths or media access. */
export interface MemoryScope {
  characterId: string;
  /** Host-computed non-secret provider identity; archives never cross this boundary implicitly. */
  providerScope: string;
}

/** One finished message of her current conversation, as the chat window shows it (C2/C3 continuity). */
export interface RecentChatMessage { role: 'user' | 'assistant'; content: string }
/**
 * C2/C3 (pretrial fixes 2026-11-03): what the chat window shows for the active character: the finished turns of her
 * current conversation, oldest first, bounded like the window's own history. Read from the existing chat memory.
 */
export interface RecentChat {
  characterId: string; messages: RecentChatMessage[];
  /**
   * 边说边演: the same turns as they are drawn (the chat page), with the ones that were only a performance as a grey line (`performed`). Only present
   * when there is such a turn; display only: never her words, never part of the history the next message carries.
   */
  shown?: RecentChatShown[];
  /**
   * 2026-11-25: whether she has ever opened with the user (an ordinary chat, or her greeting already shown), under any connection; absent when the
   * chat archive is off. Only a character for whom it is not true gets her greeting on a switch or a start (src/brain/greeting-gate.ts).
   */
  opened?: boolean;
}
/** One row of `RecentChat.shown`; `performed`: the grey line of a reply that was only a performance. */
/** `cut` (2026-11-23): the reply's words were cut short; `at` is where the quiet marker sits in `content`, `label` its words (shared/foundation/reply-cut.ts). Display only. */
export interface RecentChatShown { role: 'user' | 'assistant'; content: string; performed?: true; cut?: { at: number; label: string } }

export const MEMORY_CATEGORIES = ["日常", "工作/任务", "兴趣/共同活动", "关系/感受", "设定/偏好"] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];
export type MemoryMessageStatus = "streaming" | "complete" | "stopped" | "error" | "interrupted";
export interface MemoryMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  updatedAt: number;
  status: MemoryMessageStatus;
  /**
   * I-135: 'visitor' on a user message that someone other than the user sent (the face check said clearly not them). Absent = the user
   * (every older archive). Such a line stays in the archive and in her window, marked, but is never the user's words anywhere else.
   */
  speaker?: 'visitor';
  /**
   * I-209 step 2 (shared/memory/speaker.ts): the character who said this line. Every
   * line a character says is archived with it. Absent (every older archive): a user-role line is the user's (or the visitor's), an
   * assistant line the archive's own character's. Step 4 archives what another character said with hers.
   */
  by?: MemorySpeaker;
  /** I-209 step 4: on a stage line the user said to someone else on the full-screen stage (the one the user clicked), that one. */
  to?: MemorySpeaker;
}
export interface MemoryConfig {
  segmentGapMinutes: number;
  segmentTurns: number;
  baseWeight: number;
  maxWeight: number;
  mentionWindowHours: number;
  mentionGains: [number, number, number];
  weightHalfLifeDays: number;
  recallRecords: number;
  recallCharacters: number;
}
export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = Object.freeze({
  segmentGapMinutes: 15,
  segmentTurns: 10,
  baseWeight: 20,
  maxWeight: 100,
  mentionWindowHours: 24,
  mentionGains: [10, 5, 2] as [number, number, number],
  weightHalfLifeDays: 30,
  recallRecords: 3,
  recallCharacters: 3000,
});
export interface MemorySummary {
  id: string;
  title: string;
  tags: string[];
  category: MemoryCategory;
  createdAt: number;
  updatedAt: number;
  weight: number;
  messageCount: number;
  turnCount: number;
  sealed: boolean;
  continuationOf?: string;
  /** Present only on a host-authored assistant initiative, never a user statement. */
  origin?: ProactiveOrigin;
}
export interface MemoryListQuery {
  tag?: string;
  query?: string;
  offset?: number;
  limit?: number;
}
export interface MemoryPage {
  notice?: string;
  records: MemorySummary[];
  total: number;
  offset: number;
  limit: number;
  /** At most 200 available tags in the current scope. */
  tags: string[];
}
export interface MemoryReadQuery {
  messageOffset?: number;
  messageLimit?: number;
  textOffset?: number;
  textLimit?: number;
}
export interface MemoryMessagePage extends MemoryMessage {
  /** content is only this page; the complete original remains in the archive. */
  contentOffset: number;
  totalCharacters: number;
  nextTextOffset?: number;
}
export interface MemoryRecordPage extends MemorySummary {
  messages: MemoryMessagePage[];
  messageOffset: number;
  nextMessageOffset?: number;
}
export interface MemoryEdit {
  title?: string;
  tags?: string[];
  category?: MemoryCategory;
}
export interface MemoryTurnStart {
  id: string;
  userText: string;
  at: number;
  conversationId?: string;
  newTopic?: boolean;
  /** I-135: see MemoryMessage.speaker. */
  speaker?: 'visitor';
  /** I-209 step 2: who answers (her reply's MemoryMessage.by); unset: the store's speaker source for the scope's character. */
  by?: MemorySpeaker;
}
export interface MemoryTurnHandle {
  recordId: string;
  turnId: string;
}
export interface MemoryInitiative {
  id: string;
  text: string;
  at: number;
  origin: ProactiveOrigin;
  /** I-209 step 2: who said it (MemoryMessage.by); unset: the store's speaker source for the scope's character. */
  by?: MemorySpeaker;
}
/**
 * I-209 step 4: one line said on the full-screen stage while several were
 * there, archived into one character's own memory: something she heard (the user's line to another, another character's line) or her own
 * line on stage (a chime-in). One sealed record each; the same id twice keeps one.
 */
export interface MemoryStageLine {
  id: string;
  text: string;
  at: number;
  role: "user" | "assistant";
  /** An assistant line: who said it (unset: the archive's own character). A user line: unset (the user). */
  by?: MemorySpeaker;
  /** A user line said to someone else on stage: that one. */
  to?: MemorySpeaker;
}
export interface MemoryRecall extends MemorySummary {
  excerpt: string;
}
export interface MemoryRecallOptions {
  maxRecords?: number;
  maxChars?: number;
  excludeRecordId?: string;
}
export interface MemoryMention {
  eventId: string;
  /** Same continuous recollection keeps this identity across turns and continuation records. */
  episodeId: string;
  at: number;
}
export interface MemoryRecallNote {
  eventId: string;
  at: number;
  excludeRecordId?: string;
  /** Host supplies only a record actually recalled in the preceding assistant reply. */
  confirmedRecordId?: string;
}

export function validateMemoryConfig(value: unknown): MemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("记忆参数格式不正确。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_MEMORY_CONFIG, key))) throw new Error("记忆参数包含未知字段。");
  const next = { ...DEFAULT_MEMORY_CONFIG, ...input } as MemoryConfig;
  const ranges: Record<Exclude<keyof MemoryConfig, "mentionGains">, [number, number]> = {
    segmentGapMinutes: [1, 1440], segmentTurns: [1, 100], baseWeight: [0, 100], maxWeight: [0, 100],
    mentionWindowHours: [1, 720], weightHalfLifeDays: [1, 3650], recallRecords: [0, 3], recallCharacters: [0, 3000],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const item = next[key as keyof MemoryConfig];
    if (typeof item !== "number" || !Number.isFinite(item) || item < minimum || item > maximum) throw new Error(`记忆参数 ${key} 超出试验范围。`);
  }
  if (![next.segmentTurns, next.recallRecords, next.recallCharacters].every(Number.isInteger)) throw new Error("记忆条数和字数必须为整数。");
  if (!Array.isArray(next.mentionGains) || next.mentionGains.length !== 3 || !next.mentionGains.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100)) throw new Error("记忆提及增量格式不正确。");
  if (next.baseWeight > next.maxWeight || next.mentionGains[0] < next.mentionGains[1] || next.mentionGains[1] < next.mentionGains[2]) throw new Error("记忆权重与递减顺序不正确。");
  return { ...next, mentionGains: [...next.mentionGains] };
}

export function memoryWeightAt(weight: number, updatedAt: number, now: number, config: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG }): number {
  const elapsed = Math.max(0, now - updatedAt);
  return Math.max(config.baseWeight, Math.min(config.maxWeight, config.baseWeight + (weight - config.baseWeight) * Math.pow(2, -elapsed / (config.weightHalfLifeDays * 86_400_000))));
}

const words = [
  { category: "兴趣/共同活动", tag: "电影", pattern: /电影|影片|movie|film/i },
  { category: "兴趣/共同活动", tag: "音乐", pattern: /音乐|歌曲|听歌|music|song/i },
  { category: "兴趣/共同活动", tag: "游戏", pattern: /游戏|game|gaming/i },
  { category: "兴趣/共同活动", tag: "读书", pattern: /读书|小说|书籍|reading|book/i },
  { category: "工作/任务", tag: "工作", pattern: /工作|上班|加班|work|office/i },
  { category: "工作/任务", tag: "学习", pattern: /学习|考试|作业|study|exam/i },
  { category: "工作/任务", tag: "编程", pattern: /编程|代码|bug|coding|code/i },
  { category: "设定/偏好", tag: "角色设定", pattern: /角色卡|人设|角色设定|persona/i },
  { category: "设定/偏好", tag: "偏好", pattern: /我喜欢|我不喜欢|我的偏好|i (?:like|prefer|dislike)/i },
  { category: "关系/感受", tag: "感受", pattern: /难过|开心|担心|紧张|感受|sad|happy|worr/i },
  { category: "关系/感受", tag: "陪伴", pattern: /陪伴|想你|想念|miss you/i },
  { category: "日常", tag: "雨天", pattern: /下雨|雨天|rain/i },
  { category: "日常", tag: "吃饭", pattern: /吃饭|午饭|晚饭|早餐|dinner|lunch|breakfast/i },
] as const;
const genericTags = new Set<string>(words.map(item => item.tag));
export function isSpecificMemoryTag(tag: string): boolean { return tag !== "日常" && !genericTags.has(tag); }

/** Local, source-faithful fallback; no background model call or invented summary. */
export function deriveMemoryMetadata(text: string, knownTags: string[] = []): Required<MemoryEdit> {
  const compact = text.replace(/\s+/gu, " ").trim();
  const title = Array.from(compact).slice(0, 20).join("") || "聊天片段";
  const named = [...text.matchAll(/《([^》\n]{1,40})》|#([\p{L}\p{N}_-]{2,30})/gu)].map(match => (match[1] ?? match[2]).trim());
  const reused = knownTags.filter(tag => tag.length >= 2 && text.toLocaleLowerCase().includes(tag.toLocaleLowerCase()));
  const matched = words.filter(item => item.pattern.test(text));
  const tags = [...new Set([...named, ...reused, ...matched.map(item => item.tag)])].slice(0, 5);
  if (!tags.length) {
    const lexical = text.match(/[A-Za-z][A-Za-z0-9_-]{2,24}/g)?.filter(word => !/^(the|and|that|this|with|have|about|what|hello|please)$/i.test(word));
    if (lexical?.length) tags.push(...[...new Set(lexical)].slice(0, 3));
    else tags.push("日常");
  }
  return { title, tags, category: matched[0]?.category ?? "日常" };
}

export function isMemoryTopicChange(text: string): boolean {
  return /换个话题|聊点别的|说点别的|新话题|另外一个话题|change (?:the )?subject|another topic|switch topics/i.test(text);
}
export function hasExplicitRecallCue(text: string): boolean {
  return /还记得|记不记得|上次|那次|以前.*(?:聊|说|一起)|之前.*(?:聊|说|一起)|remember|last time|we (?:talked|discussed)|that time|the other day|how did .{1,40} go|how was .{1,40} (?:going|go)|you told me|i told you|do you recall/i.test(text);
}
const LATIN_TAG = /^[a-z0-9][a-z0-9 '-]*$/;
/** A plain English tag matches whole words only ("cat" must not be found in "education"); a plural "s"/"es" still counts. Any other tag is a substring match as before. */
function tagInText(lower: string, tag: string): boolean {
  if (!LATIN_TAG.test(tag)) return lower.includes(tag);
  return new RegExp(`(?<![a-z0-9])${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?(?![a-z0-9])`).test(lower);
}
export function memoryRecallMatch(text: string, record: Pick<MemorySummary, "title" | "tags">): { score: number; explicit: boolean } {
  const lower = text.toLocaleLowerCase();
  const matches = record.tags.filter(tag => tagInText(lower, tag.toLocaleLowerCase()) || words.some(item => item.tag === tag && item.pattern.test(text)));
  const titleMatch = record.title.length >= 4 && lower.includes(record.title.toLocaleLowerCase());
  const specificMatch = matches.some(tag => !genericTags.has(tag) && tag !== "日常" && tag.length >= 3);
  const score = (titleMatch ? 10 : 0) + matches.reduce((sum, tag) => sum + (genericTags.has(tag) ? 1 : 4), 0);
  return { score, explicit: hasExplicitRecallCue(text) && (titleMatch || specificMatch || matches.length >= 2) };
}
