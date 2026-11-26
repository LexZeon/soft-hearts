// The shape of one chat turn as CompanionService.begin() hands it out (moved out of companion.ts for I-209 step 2, unchanged).
import type { MemoryScope } from '../../shared/memory';
import type { StreamEvent } from '../../shared/brain/stream-event';
import type { SpeechMood } from '../mood';
import type { SpeakOnlyTurnKind } from './speak-only/rules';
import type { SpeakOnlyOutcome } from './speak-only/judge-host';

export interface CompanionTurn {
  scope: MemoryScope;
  recordId: string;
  id: string;
  persona: string;
  /**
   * I-021 删除一致性, the late window (Codex T-222 E04): `persona` (this turn's, with whatever the host added after it) as it may
   * go out now. When the user took something back after the turn recalled its memories (a note deleted while the message
   * waited for the Claude process), only the memories still recalled stay (electron/memory/recall-late-check.ts). Read where the
   * message is written; with nothing taken back it returns `persona` itself.
   */
  withCurrentRecall(persona: string): string;
  push(type: StreamEvent['type'], text: string): void;
  /** Available only after successful delivery/archive in the still-current scope. */
  speechMood(): SpeechMood | null;
  /** True only after a valid ordinary protocol tail and successful current archive/delivery. */
  profileReplyAccepted?(): boolean;
  /** Bounded nonce-bound private proposal; only after this exact ordinary reply completes and archives. */
  textMemorialProposal?(): string | null;
  /** Raw nonce-bound settings proposal (electron/brain/chat-settings.ts); same lifetime rule as above. */
  settingProposal?(): string | null;
  /** I-050: the raw file block of her folder (electron/initiative/her-folder/); same lifetime rule as above. */
  herFileProposal?(): string | null;
  /**
   * 识图第 1 步: her completed reply offered to look closer at the shared screen ("要我凑近看看吗", read from what she said by
   * shared/senses/look-request.ts isLookOffer; no instruction or tail field, so the first token does not move). Same lifetime rule as above.
   */
  lookOffer?(): boolean;
  /** 熟悉度: the relationship lines for a session that opens with this turn (electron/memory/relationship/host.ts); '' when there are none. */
  relationshipOpening?: string;
  /** Changes when an open session must restart (the switch, the stage or the nickname changed). */
  relationshipTag?: string;
  /** Her diary's memes may ride along in the opening block. */
  relationshipMemes?: boolean;
  /**
   * After finish('complete'): true when the draft filter (electron/brain/reply-draft-guard.ts) removed the whole reply. The turn
   * was archived as an error and gave no mood update; the host fails the chat instead of showing an empty bubble.
   */
  emptyReply?(): boolean;
  /**
   * The reply exactly as it was shown, archived and handed to the voice (what the reply protocol let through), once finish()
   * has been called; null before, or when the window could not be given all of it. The conversation's Claude session records
   * this instead of what Claude wrote (electron/brain/claude-session.ts CompanionSessionInput.shown).
   */
  shownReply?(): string | null;
  /**
   * I-098 speak-only (electron/brain/speak-only/rules.ts): 'judge' when this turn asked for no state tail, 'tail' when speak-only is on but
   * the turn needed the tail as a carrier, null with speak-only off.
   */
  speakOnly?: SpeakOnlyTurnKind | null;
  /**
   * I-098: what the post-reply judge came to for this message (resolves once its answer was used or dropped); null when no judge was
   * asked (speak-only off, a tail turn, a reply that did not complete). For tests and the experiment; the app does not wait for it.
   */
  speakOnlyJudged?(): Promise<SpeakOnlyOutcome | null>;
  finish(status: 'complete' | 'stopped' | 'error'): Promise<void>;
}
