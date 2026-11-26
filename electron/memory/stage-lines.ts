/**
 * I-209 step 4: the chat memory's part for lines said on the full-screen stage while several were there. Kept out of memory.ts (which
 * may only shrink); the store calls these.
 *
 *  - A stage line is one sealed record in ONE character's archive: something she heard (the user's line to another one, another one's line)
 *    or her own line on stage (a chime-in). The same id in the same archive keeps one record (one archive per line per character).
 *  - The chat window (I-134) reads them with who said each one (`by`) and, for the user's line, to whom (`to`), so the history handed to
 *    Claude can name the speakers (electron/brain/long-chat/window.ts).
 *  - The store tells its listeners when a line was SAID in an archive (a finished reply, a host initiative, her own stage line) and when the
 *    user began a turn; what she merely heard is never told on (so a heard line never echoes into more archives).
 */
import type { ProactiveOrigin } from '../../shared/foundation/chat';
import type { MemoryMessage, MemoryScope, MemoryStageLine } from '../../shared/memory/memory';
import { validSpeaker, type MemorySpeaker } from '../../shared/memory/speaker';

/** The conversation id stage records carry (never a real conversation's: those are 'default', 'initiative' or a UUID). */
export const STAGE_CONVERSATION = 'stage';
/** A stage line is at most this long (as a host initiative). */
export const STAGE_LINE_MAX = 2000;

/** The input checked and bounded; throws on anything else. `by`/`to` that do not read are dropped (never someone else's name by mistake). */
export function checkStageLine(input: MemoryStageLine): MemoryStageLine {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !['id', 'text', 'at', 'role', 'by', 'to'].includes(field))) throw new Error('同框记录格式不正确。');
  const { id, text, at, role } = input;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('同框记录编号不正确。');
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('记忆时间必须为有效的毫秒时间。');
  if (role !== 'user' && role !== 'assistant') throw new Error('同框记录的说话人不正确。');
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > STAGE_LINE_MAX || text.includes('\0')) throw new Error('同框记录需要 1～2000 字符的文字。');
  const by = role === 'assistant' ? validSpeaker(input.by) : undefined, to = role === 'user' ? validSpeaker(input.to) : undefined;
  return { id, text, at, role, ...(by ? { by } : {}), ...(to ? { to } : {}) };
}

/** The one message of a stage record. */
export function stageMessage(line: MemoryStageLine, messageId: string, own: MemorySpeaker | undefined): MemoryMessage {
  const by = line.role === 'assistant' ? line.by ?? own : undefined;
  return { id: messageId, turnId: line.id, role: line.role, content: line.text, createdAt: line.at, updatedAt: line.at, status: 'complete',
    ...(by ? { by } : {}), ...(line.to ? { to: line.to } : {}) };
}

/** A stage record is sealed, has one complete message of at most STAGE_LINE_MAX characters, and keeps only speakers that read. */
export function stageRecordValid(record: { sealed: boolean; messages: MemoryMessage[] }): boolean {
  const message = record.messages[0];
  if (!record.sealed || record.messages.length !== 1 || !message || message.status !== 'complete' || Array.from(message.content ?? '').length > STAGE_LINE_MAX) return false;
  if (message.to !== undefined && (message.role !== 'user' || !validSpeaker(message.to))) delete message.to;
  return true;
}

/** One line of a chat window as the store gives it (electron/brain/long-chat/window.ts LongChatSourceMessage). */
export interface WindowLine {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  origin?: ProactiveOrigin;
  speaker?: 'visitor';
  /** A stage line: who said it (an assistant line) and to whom the user said it (a user line). */
  by?: MemorySpeaker;
  to?: MemorySpeaker;
  stage?: true;
}
interface WindowRecord { scopeKey: string; origin?: ProactiveOrigin; stage?: true; messages: MemoryMessage[] }

/**
 * Her archive's lines for the chat window (moved from MemoryStore.chatWindowSource, unchanged for ordinary turns and initiatives): ordinary
 * turns (the user's line and her finished or stopped reply), her initiatives, and (step 4) her stage lines with their speakers; by time.
 */
export function chatWindowLines(records: Iterable<WindowRecord>, key: string, conversation: boolean, excludeTurnId?: string,
  replyFor?: (turnId: string, content: string) => string | null, copy: <T>(value: T) => T = value => structuredClone(value)): WindowLine[] {
  const out: WindowLine[] = [];
  for (const record of records) {
    if (record.scopeKey !== key) continue;
    if (record.origin) {
      const line = record.messages.find(message => message.role === 'assistant' && message.status === 'complete' && message.content?.trim());
      if (line) out.push({ role: 'assistant', content: line.content, createdAt: line.createdAt, origin: copy(record.origin) });
      continue;
    }
    if (!conversation) continue;
    if (record.stage) {
      const line = record.messages[0];
      if (line?.content?.trim() && line.turnId !== excludeTurnId) out.push({ role: line.role, content: line.content, createdAt: line.createdAt, stage: true,
        ...(line.by ? { by: copy(line.by) } : {}), ...(line.to ? { to: copy(line.to) } : {}) });
      continue;
    }
    for (const user of record.messages) {
      if (user.role !== 'user' || !user.content?.trim() || user.turnId === excludeTurnId) continue;
      const reply = record.messages.find(message => message.role === 'assistant' && message.turnId === user.turnId);
      const said = reply && replyFor ? replyFor(user.turnId, reply.content ?? '') ?? reply.content : reply?.content;
      if (!reply || !said?.trim() || (reply.status !== 'complete' && reply.status !== 'stopped')) continue;
      out.push({ role: 'user', content: user.content, createdAt: user.createdAt, ...(user.speaker === 'visitor' ? { speaker: 'visitor' as const } : {}) }, { role: 'assistant', content: said, createdAt: Math.max(reply.createdAt, user.createdAt) });
    }
  }
  return out.map((message, index) => ({ message, index })).sort((a, b) => a.message.createdAt - b.message.createdAt || a.index - b.index).map(({ message }) => message);
}

/** What the store tells about lines in one character's archive (the chat memory only). */
export type StageLineEvent =
  /** The user began a turn with this character (her line is not said yet). */
  | { kind: 'begin'; scope: MemoryScope; turnId: string; at: number }
  /**
   * A line was said and archived in her own archive: her finished (or stopped) reply with the user's line it answered, a host initiative,
   * or her own stage line. `user` only for a reply (absent for a visitor's turn: a visitor's words are not passed on).
   */
  | { kind: 'said'; scope: MemoryScope; turnId: string; at: number; text: string; user?: { text: string; at: number } };

/** Tells each listener on its own; a throwing listener never changes what is archived or stops the others. */
export function tellStageLine(listeners: Iterable<(event: StageLineEvent) => void>, event: StageLineEvent): void {
  for (const listener of [...listeners]) { try { listener(event); } catch { /* a listener never changes what is archived */ } }
}
