import type { ChatMessage } from '../../shared/foundation/chat';
import type { LanguageProfile } from '../../shared/cards';
import type { FirstCharReuse } from '../../shared/brain/journal-entries';
import type { ClaudeTask } from './claude';
import type { OnceLine, OpeningMemory, RelaxedChat } from './i139-chat';
import type { CallGlanceMark } from './call-glances';

/**
 * The types of the conversation-scoped Claude chat (electron/brain/claude-session.ts re-exports them). Moved out of that file on
 * 2026-11-19 (I-161 A) so it stays under its size pin; the declarations are unchanged.
 */

/** What the ordinary chat handler knows about this turn's conversation. */
export interface CompanionSessionInput {
  /** Accepted conversation identity (character, provider, conversation, generation). */
  key: string;
  /** I-209 step 2: whose turn this is (her card id); the session pool runs it in her slot. Unset: the desktop companion's. */
  owner?: string;
  /** The character persona as configured, before this turn's context was added. */
  basePersona: string;
  /** This turn's composed persona (fixed persona + mood, memories, protocol, ...). */
  persona: string;
  /** 熟悉度: the relationship lines that sit inside `persona`; sent with a session's opening message only (claude-session-prompt.ts withoutOpeningContext). */
  openingContext?: string;
  /**
   * Changes when those lines changed in a way she must hear (switch, stage, nickname). Not a restart (2026-11-25): the warm process
   * stays, and the next follow-up carries the lines once (claude-session.ts relationTag).
   */
  openingKey?: string;
  /** The renderer's history window; the last message is the current user message. */
  messages: readonly ChatMessage[];
  language?: LanguageProfile | null;
  /** Read once, at dispatch (user profile / visual data leases). */
  data?: () => string | null | undefined;
  /**
   * What the app showed of this turn's reply, once the turn has finished (null or undefined before): the bubble, the
   * archive and the chat window's history all keep exactly this text, after the reply protocol cut an internal draft,
   * repaired garbled text or dropped a leading "<br>" run (electron/mood/mood-chat.ts). The session's record of the reply then
   * holds it instead of what Claude wrote, so the next window, built from what was shown, continues the same process
   * (docs/claude/2026-11-04-session-continuity-after-filter.md). Only the host that ran the turn can say it; unset, the
   * record keeps Claude's own output and a reply the protocol changed opens a fresh session, as before.
   */
  shown?: () => string | null | undefined;
  /**
   * I-134 new chat: her own page about the user (the lead's note module). Goes into a session's opening message only, after the
   * persona and the relationship lines; not part of the session key, so a rewritten note takes effect from the next opening.
   */
  openingNote?: string | null;
  /**
   * I-139 (electron/brain/i139-chat.ts): present only while the switch is on: the card's name and language for the opening's layers, her
   * note's relaxed header and the follow-up header. Absent: every message as before.
   */
  relaxed?: RelaxedChat | null;
  /** I-139 layer 2 (A3 supplies it): goes into a session's opening message only, like openingNote. Default null. */
  openingMemory?: OpeningMemory;
  /**
   * I-139: the lines of this turn's context (exactly as they are in `persona`) that a process needs to hear only on its first turn and
   * when they change (perception, 三方互通). Read once at dispatch, right after `persona`. Kept per process: a new process hears them all.
   */
  onceLines?: () => readonly OnceLine[];
}

/**
 * I-134 new chat, step 4 (used only while PersistentClaudeOptions.longChat is on): what to do when Claude refuses this turn or
 * answers with nothing. `visible`: whether the window already shows any of the reply (then it is kept and the turn completes);
 * otherwise, while `current` (same turn, not stopped, same conversation), one immediate per-message retry with `prompt` (the
 * renderer's short window, no long window, no note) streams into the same turn. `noted` gets the category for the incident log.
 */
export interface RefusalFallback {
  prompt(): string;
  visible?(): boolean;
  current(): boolean;
  noted?(kind: 'refusal-fallback' | 'refusal-kept'): void;
}
/** `callGlance`: I-161 A, set only by the voice host for a call segment (electron/brain/call-glances.ts); typed chat never sets it. */
export type CompanionClaudeTask = ClaudeTask & { replyId?: string; session?: CompanionSessionInput; refusalFallback?: RefusalFallback; callGlance?: CallGlanceMark };

/** Optional per-turn hooks (R33 continuous voice). */
export interface ClaudeTurnControl {
  /**
   * The user message is in a conversation-scoped Claude process and its reply
   * is being generated; `supersede` asks Claude Code to stop it early (see
   * ClaudeChatProcess.supersede). Never called on the per-message path, where
   * stopping would lose the context the next message needs.
   */
  started?(supersede: () => boolean): void;
}
/** How a chat turn ended: `output` is every text delta delivered; `superseded` when supersede() stopped it early. */
export interface ClaudeTurnOutcome { superseded: boolean; output: string }

export interface ClaudeTimingInfo {
  mode: 'persistent' | 'per-message';
  /** cold: spawned for this turn; prewarmed: spawned earlier, first turn on it; warm: reused after a turn. */
  process: 'cold' | 'prewarmed' | 'warm';
  /** 1-based turn number inside this Claude process (0 for per-message). */
  sessionTurn: number;
  /** First-char measuring (2026-11-09): characters of the message written for this turn, and what this process had counted before it (its budget's count). Numbers only. */
  inputChars?: number;
  sessionChars?: number;
  /** 2026-11-12 (docs/claude/2026-11-12-warm-reuse-fix.md): why this turn did or did not continue the process before it, and whether it carries a picture (which retires the process after it). */
  reuse?: FirstCharReuse;
  image?: boolean;
}
/** Developer latency hooks (electron/brain/reply-latency.ts). Never receives text. */
export interface ClaudeTimingObserver {
  dispatched(replyId: string, info: ClaudeTimingInfo): void;
  /** `model`: the model id Claude Code's init event reported for this turn's process (diagnostic only; absent when none). */
  firstDelta(replyId: string, model?: string): void;
}
