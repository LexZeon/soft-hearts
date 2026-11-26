import type { ChatMessage } from '../../shared/foundation/chat';
import { sessionText } from './claude-session-prompt';

/**
 * What a conversation's Claude process has been told, in the renderer's terms, and each turn's place in it (electron/brain/claude-session.ts
 * PersistentClaudeChat). Moved out of that file on 2026-11-21 (I-166, docs/claude/2026-11-21-i166-see-and-say.md) so it stays under its size
 * pin; the statements are the ones the class had. Nothing here talks to a process.
 */
export interface SessionLogTurn {
  replyId?: string;
  /** Its user message's index in `known`; its reply follows at `at + 1` when `output` is not empty. */
  at: number;
  user: string;
  /** What Claude wrote. */
  output: string;
  /** The host's CompanionSessionInput.shown until it has answered; `text` is its answer, the reply in `known`. */
  shown?: () => string | null | undefined;
  text?: string;
}
export interface SessionLog { known: ChatMessage[]; log: SessionLogTurn[] }

export function recordTurn(session: SessionLog, replyId: string | undefined, history: readonly ChatMessage[], current: ChatMessage, output: string,
  shown?: () => string | null | undefined): void {
  session.known.push(...history);
  session.log.push({ ...(replyId ? { replyId } : {}), at: session.known.length, user: current.content, output, ...(shown ? { shown } : {}) });
  session.known.push(current, ...(output ? [{ role: 'assistant' as const, content: output }] : []));
}

/**
 * Puts each finished reply into `known` as the app showed it (CompanionSessionInput.shown), before the next window is
 * lined up or a voice utterance regrouped. Claude keeps what it wrote in its own context (a cut draft included); the app
 * never sends `known` anywhere, so a cut draft cannot come back as something she said. A turn whose host has not
 * answered yet keeps Claude's output and is asked again next time; an answer is final.
 */
export function settleShownTurns(session: SessionLog): void {
  for (const turn of session.log) {
    if (!turn.shown) continue;
    let text: string | null | undefined;
    try { text = turn.shown(); } catch { text = null; }
    if (typeof text !== 'string') continue;
    delete turn.shown;
    if (!turn.output) continue;
    turn.text = text;
    session.known[turn.at + 1] = { role: 'assistant', content: text };
  }
}

/** PersistentClaudeChat.regroup's lining up (after it checked the session is idle): true when the turns were merged. */
export function regroupTurns(session: SessionLog, replyIds: readonly string[], shown: readonly ChatMessage[]): boolean {
  if (!replyIds.length || shown[0]?.role !== 'user' || shown.slice(1).some(message => message.role !== 'assistant')) return false;
  settleShownTurns(session);
  const turns = session.log.slice(-replyIds.length);
  if (turns.length !== replyIds.length || turns.some((turn, index) => !turn.replyId || turn.replyId !== replyIds[index])) return false;
  let at = turns[0].at;
  for (const turn of turns) { if (turn.at !== at) return false; at += turn.output ? 2 : 1; }
  if (at !== session.known.length) return false;
  if (shown[0].content !== turns.map(turn => turn.user).join('\n')) return false;
  const replies = turns.map(turn => sessionText(turn.text ?? turn.output)).filter(Boolean);
  const shownReplies = shown.slice(1).map(message => sessionText(message.content));
  if (shownReplies.length !== replies.length || shownReplies.some((reply, index) => reply !== replies[index])) return false;
  session.known.splice(turns[0].at, session.known.length - turns[0].at, ...shown.map(message => ({ role: message.role, content: message.content })));
  session.log.splice(session.log.length - turns.length, turns.length);
  return true;
}

/** The refused turn's partial reply (never shown) leaves the session's record, so the reply that replaces it is sent as new. */
export function forgetReplyOutput(session: SessionLog | null | undefined, replyId: string | undefined): void {
  const last = session?.log.at(-1);
  if (!session || !replyId || !last || last.replyId !== replyId || !last.output || session.known.length !== last.at + 2) return;
  session.known.pop();
  last.output = '';
  delete last.shown; delete last.text;
}

/**
 * I-166: the reply `replyId` is the newest turn and nothing was told after it (its reply, if any, is the last of `known`). A continuation of
 * it (her closer look) may be written to the same process; the app keeps the two as one reply, so the record stays one turn.
 */
export function continuable(session: SessionLog, replyId: string | undefined): boolean {
  const last = session.log.at(-1);
  return !!replyId && !!last && last.replyId === replyId && session.known.length === last.at + (last.output ? 2 : 1);
}

/**
 * I-166: what the continuation wrote joins that turn's reply: one turn, one reply in `known` (as the host will show and archive it; its
 * `shown` answer, read later, replaces it as for any reply). Claude's own context holds the private note in between, like a cut draft.
 */
export function extendReply(session: SessionLog, replyId: string | undefined, output: string): void {
  const last = session.log.at(-1);
  if (!output || !last || last.replyId !== replyId) return;
  last.output += output;
  session.known[last.at + 1] = { role: 'assistant', content: last.output };
  if (last.text !== undefined) delete last.text;
}
