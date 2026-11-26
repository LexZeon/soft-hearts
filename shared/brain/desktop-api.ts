// 她的大脑：聊天 (brain): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { PetReplyLingerAnswer, StreamEvent } from '../brain';
import type { UserProfileExpected } from '../memory';
import type { ProviderConfig } from '../foundation/settings';
import type { Attachment, ChatMessage } from '../foundation/chat';
import type { PetReplyUpdate } from '../foundation/pet-reply';

export interface ChatRequest {
  id: string;
  messages: ChatMessage[];
  attachments: Attachment[];
  profile?: UserProfileExpected;
  /** Renderer wall-clock send time (Date.now()), used only for developer-mode latency timing. */
  sentAt?: number;
  /** 2026-11-22: where the window spent the time between sentAt and this request (ms each; timing only, shared/brain/send-drop/drop.ts). */
  waits?: import('./send-drop/drop').SendWaits;
  /**
   * 2026-11-23: the host's number of a line from her full-screen box (electron/unbound/say-ack.ts). The host sends it on only while the
   * line is still open: one the box already gave up on is refused, so a line goes out at most once and never after "没发出去".
   */
  line?: number;
  /**
   * F7 停停说说 (switch on only): the user spoke while her previous reply (`id`) had shown only `shown` characters in its bubbles.
   * A number, never text: the host takes the rest from its own copy of that reply.
   */
  pauseCut?: import('../brain').PauseTalkCut;
}
export interface ChatStarted { id: string; messages: ChatMessage[]; owner: 'controls' | 'pet';
  /** I-209 step 4: the name of the one answering when she is someone else on the full-screen stage (not the desktop companion). */
  speaker?: string;
  /** I-209 stage voice: her card id with `speaker`: the window reads this reply in her own voice. */
  speakerId?: string;
  /** Host-classified local control turn. It must preserve unrelated playback. */
  readoutControl?: true;
}

export interface BrainDesktopAPI {
  /** I-134 new chat: her greeting was just shown in a chat window. No text is sent; the host archives the card's own greeting (new chat on only). */
  rememberGreeting(): Promise<boolean>;
  newConversation(): Promise<void>;
  onChatReset(callback: () => void): () => void;
  /** #5: a 'complete' update answers with that reply's lifetime, decided by the host (shared/behaviors/reply-linger/). */
  updatePetReply(update: PetReplyUpdate): Promise<PetReplyLingerAnswer | void>;
  /** F7 说话节奏: each accepted reply's pace (its id, a multiplier for the bubbles after the first, shyness). Presentation only. */
  onReplyRhythm(callback: (pacing: import('../brain').ReplyRhythmPacing) => void): () => void;
  /** F7 停停说说: haiku's plan for one reply (its id, pauses after which sentences, where she waits for the user). Presentation only. */
  onPauseTalk(callback: (cue: import('../brain').PauseTalkCue) => void): () => void;
  /** "Chat is not available" panel (electron/brain/chat-availability-host.ts). None of these takes an argument. */
  getChatAvailability(): Promise<import('../brain').ChatAvailabilityView>;
  onChatAvailability(callback: (view: import('../brain').ChatAvailabilityView) => void): () => void;
  retryChatAvailability(): Promise<import('../brain').ChatAvailabilityView>;
  openClaudeHelp(): Promise<void>;
  openNetworkSettings(): Promise<void>;
  listModels(config: ProviderConfig): Promise<string[]>;
  chat(request: ChatRequest): Promise<void>;
  onChatStarted(callback: (chat: ChatStarted) => void): () => void;
  cancel(id: string): Promise<void>;
  onStream(callback: (event: StreamEvent) => void): () => void;
  /** F7, developer mode only, this run only: a slow reply's later system-voice sentences start after a short silence. Returns the new state. */
  setReplyRhythmVoiceTrial(on: boolean): Promise<boolean>;
  /** Chat settings card (R41): a tap on one of the host's own choices, or 「取消」. */
  chooseChatSetting(request: import('../brain').ChatSettingChoiceRequest): Promise<import('../brain').ChatSettingCardView | null>;
  onChatSettingCard(callback: (card: import('../brain').ChatSettingCardView) => void): () => void;
}
