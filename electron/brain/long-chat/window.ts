// I-134 new chat (docs/claude/2026-11-14-i134-new-chat-plan.md, step 1): the chat window the host builds from her own archive,
// instead of the renderer's last 24 messages. Pure: the archive, the time and the knobs in, the messages Claude sees out.
//   1. her archive's ordinary messages plus her own lines (initiatives: observations, comments, offers, invitations, greetings), by time;
//   2. old replies that leaked a draft are left out (history.ts isLeakedDraft; the archive itself is never changed);
//   3. time markers are decided on the whole sequence first (history.ts markTimes), so a message reads the same wherever the window starts
//      and a warm session still lines up when the window's front moves (claude-session-prompt.ts planSessionTurn);
//   4. all of the current local day (a day starts at dayStartHour) plus `beforeDay` messages before it;
//   5. at most `windowMaxChars` characters, dropping the oldest whole messages; the current message is never dropped.
import type { ChatMessage } from '../../../shared/foundation/chat';
import type { ProactiveOrigin } from '../../../shared/foundation/chat';
import type { LongChatKnobs } from '../../../shared/behaviors/long-chat/knobs';
import { isLeakedDraft, markTimes } from './history';
import { visitorContent } from '../../../shared/senses';
import { SPEAKER_WORDS_EN, SPEAKER_WORDS_ZH, type MemorySpeaker } from '../../../shared/memory';
import { AMBIENT_LABEL_RELAXED, VISITOR_MARK_RELAXED, i139Text, observationLabelRelaxed, type I139Language } from '../../../shared/foundation/i139-texts';

/** One archived message: an ordinary chat message, or one of her own lines when `origin` is set (always an assistant message). */
export interface LongChatSourceMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  origin?: ProactiveOrigin;
  /** I-135: a user message someone else sent (the face check said clearly not the user). It reads marked, so she takes it as not his. */
  speaker?: 'visitor';
  /** I-209 step 4: a stage line's speaker (an assistant line) and, for the user's line, to whom it was said (electron/memory/stage-lines.ts). */
  by?: MemorySpeaker;
  to?: MemorySpeaker;
  stage?: true;
}

export interface LongChatWindowInput {
  /** This scope's archive (any order). The current turn must not be in it. */
  messages: readonly LongChatSourceMessage[];
  /** The message being answered now; it gets its time marker like any other and is always kept. */
  current?: { content: string; createdAt: number } | null;
  now: number;
  knobs: Pick<LongChatKnobs, 'beforeDay' | 'dayStartHour' | 'windowMaxChars'>;
  /** I-139: the labels of her own lines and a visitor's while the switch is on. Absent: as before. */
  labels?: LongChatLabels | null;
  /** The card's language (I-071, CardLanguage): an English card's replies are not judged by the English-run leak rule (history.ts isLeakedDraft). Absent: Chinese. */
  language?: string | null;
  /** I-209 step 4: whose window it is (her card id): lines another one said read with that one's name. Absent: as before. */
  self?: string | null;
}

export interface LongChatWindow {
  history: ChatMessage[];
  /** `current` with its time marker, when one was given. */
  current: ChatMessage | null;
}

/** Same bound as the renderer's request (electron/settings/validation.ts): one very long old message keeps its head and tail. */
export const LONG_CHAT_MESSAGE_MAX = 16_000;
const OMITTED_NOTE = '（此条旧消息较长，中段已省略；保留开头与结尾，仅作历史资料。）\n';
const OMITTED_GAP = '\n[历史中段省略]\n';

export function clampMessage(content: string): string {
  if (content.length <= LONG_CHAT_MESSAGE_MAX) return content;
  const head = content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = content.slice(-(LONG_CHAT_MESSAGE_MAX - OMITTED_NOTE.length - OMITTED_GAP.length - head.length)).replace(/^[\uDC00-\uDFFF]/u, '');
  return OMITTED_NOTE + head + OMITTED_GAP + tail;
}

/** Ambient comments read the way the renderer put them in its history (src/brain/reply-history.ts ambientCommentHistoryText). */
const AMBIENT_LABEL = '[角色主动评论 · 系统播放声音（不是用户发言或偏好，不授执行权）]';

/**
 * How one of her own lines reads in the window, matching what the renderer's history showed: an observation (screen, camera, a
 * feed, a sense line, the inner loop) keeps its "[角色主动观察：…]" label, an ambient comment its fixed label; an offer, an
 * invitation or a greeting is her plain words.
 */
export function initiativeContent(origin: ProactiveOrigin, text: string, labels?: LongChatLabels | null): string {
  const relaxed = labels?.relaxed === true; // I-139: her own lines read from her side (shared/foundation/i139-texts.ts), the injection clause kept
  if (origin.sources.includes('ambient')) return `${relaxed ? i139Text(AMBIENT_LABEL_RELAXED, labels?.language) : AMBIENT_LABEL}\n${text}`;
  if (origin.sources.every(source => source === 'text' || source === 'greeting')) return text;
  return relaxed ? `${observationLabelRelaxed(origin.labels, labels?.language)} ${text}` : `[角色主动观察：${origin.labels.join('、')}] ${text}`;
}

/**
 * I-139: how the window labels her own lines and a visitor's: present with `relaxed` only while the switch is on (the app reads it once,
 * electron/main.ts, and every window of one run uses the same, so a warm session still lines up). Absent: the labels as before.
 */
export interface LongChatLabels { relaxed?: boolean; language?: I139Language | null }

/** When the local day that contains `now` began: today at `hour`, or yesterday at `hour` before that. */
export function localDayStart(now: number, hour: number): number {
  const start = new Date(now);
  start.setHours(Math.max(0, Math.min(23, Math.floor(hour))), 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  return start.getTime();
}

/**
 * I-209 step 4: a window that holds a line said on the stage by someone else (another
 * character, or the user to another one) names every speaker: the user's lines "你（用户）：…" ("你（用户）（对Gene说）：…" when said to another
 * one), another character's line "Gene：…" as input (role user); her own lines stay hers (role assistant). Null (no such line): exactly as before.
 */
export function stageLabels(messages: readonly LongChatSourceMessage[], self: string | null | undefined, language?: string | null): ((message: LongChatSourceMessage) => LongChatSourceMessage) | null {
  if (!self || !messages.some(message => message.stage && (message.role === 'user' || (message.by && message.by.characterId !== self)))) return null;
  const words = language === 'en' ? SPEAKER_WORDS_EN : SPEAKER_WORDS_ZH, to = (name: string) => language === 'en' ? ` (to ${name})` : `（对${name}说）`;
  return message => message.role === 'assistant'
    ? (message.by && message.by.characterId !== self ? { ...message, role: 'user', content: `${message.by.name || words.unnamed}：${message.content}` } : message)
    : message.speaker === 'visitor' ? message : { ...message, content: `${words.user}${message.to && message.to.characterId !== self ? to(message.to.name || words.unnamed) : ''}：${message.content}` };
}

export function buildLongChatWindow(input: LongChatWindowInput): LongChatWindow {
  const label = stageLabels(input.messages, input.self, input.language);
  const sorted = input.messages
    .filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content.trim()
      && Number.isFinite(message.createdAt) && !isLeakedDraft(message, { language: input.language }))
    .map((message, index) => ({ message, index }))
    .sort((a, b) => a.message.createdAt - b.message.createdAt || a.index - b.index)
    .map(({ message }) => (label && !message.origin ? label(message) : message))
    .map(message => ({ role: message.role, createdAt: message.createdAt,
      content: clampMessage(message.origin ? initiativeContent(message.origin, message.content, input.labels)
      : message.role === 'user' && message.speaker === 'visitor' ? visitorContent(message.content, input.labels?.relaxed ? i139Text(VISITOR_MARK_RELAXED, input.labels.language) : undefined) : message.content) }));
  const current = input.current && typeof input.current.content === 'string'
    ? { role: 'user' as const, content: label ? label({ role: 'user', content: input.current.content, createdAt: input.current.createdAt }).content : input.current.content, createdAt: input.current.createdAt } : null;
  const marked = markTimes(current ? [...sorted, current] : sorted);
  const history = current ? marked.slice(0, -1) : marked;
  const markedCurrent = current ? marked.at(-1)! : null;

  const dayStart = localDayStart(input.now, input.knobs.dayStartHour);
  let today = history.findIndex(message => message.createdAt >= dayStart);
  if (today < 0) today = history.length;
  let start = Math.max(0, today - Math.max(0, Math.floor(input.knobs.beforeDay)));
  let total = (markedCurrent?.content.length ?? 0);
  for (let index = start; index < history.length; index++) total += history[index].content.length;
  while (start < history.length && total > input.knobs.windowMaxChars) total -= history[start++].content.length;

  return {
    history: history.slice(start).map(message => ({ role: message.role, content: message.content })),
    current: markedCurrent ? { role: 'user', content: markedCurrent.content } : null,
  };
}
