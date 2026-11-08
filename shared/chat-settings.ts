// Chat settings card (R41 extension): plain data the host sends to the window that
// owns a chat reply, and the one request the renderer may send back (a tap). Nothing
// here grants authority; the host checks every tap against its own open proposal.
import type { AgentSettingId } from './agent-channel';

export type ChatSettingCardState =
  /** Buttons are live. */
  | 'open'
  /** A tap is being applied (or its confirmation dialog is open). */
  | 'busy'
  | 'applied' | 'unchanged' | 'cancelled' | 'denied' | 'expired' | 'failed';

export interface ChatSettingCardChoice {
  choiceId: string;
  /** Host label from the settings catalog, never model text. */
  label: string;
  /** The value Claude proposed. */
  proposed: boolean;
  /** The value at the time of the proposal. */
  current: boolean;
}

export interface ChatSettingCardView {
  kind: 'chat-setting-card';
  version: 1;
  proposalId: string;
  replyId: string;
  settingId: AgentSettingId;
  /** Catalog label, e.g. 朗读音量. */
  label: string;
  /** Labels of the value when proposed and of Claude's proposal. */
  current: string;
  proposed: string;
  /** Claude's short reason; plain text, may be empty. */
  reason: string;
  /**
   * I-025: host text saying what the proposed value does when the card's tap is the consent (download size and source, the
   * microphone). Never model text.
   */
  detail?: string;
  /** The change needs the existing confirmation dialog after the tap. */
  confirm: boolean;
  choices: ChatSettingCardChoice[];
  state: ChatSettingCardState;
  /** Host receipt after a tap or expiry; plain text. */
  message?: string;
}

export interface ChatSettingChoiceRequest { proposalId: string; choiceId: string }
/** The 「取消」 button's choice id. */
export const CHAT_SETTING_CANCEL = 'cancel';
