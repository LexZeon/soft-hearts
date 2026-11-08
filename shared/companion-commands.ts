// R41: fixed product actions. These data types grant no authority.
export type CompanionBooleanActionId = 'pet.set-always-on-top' | 'pet.set-visible' | 'pet.set-follow-mouse';
export type CompanionCommandActionId = CompanionBooleanActionId | 'voice.set-volume' | 'voice.stop-readout' | 'pet.frame' | 'pet.set-breath';
export type CompanionCommandAction =
  /** Integer percent, or true to retain the already-positive exact current strength. */
  | { actionId: 'pet.set-breath'; parameters: { value: number | true } }
  | { actionId: 'pet.frame'; parameters: { value: 'full' | 'portrait' } }
  | { actionId: CompanionBooleanActionId; parameters: { value: boolean } }
  /** Absolute integer percent, validated by the host before conversion to [0,1]. */
  | { actionId: 'voice.set-volume'; parameters: { value: number } }
  | { actionId: 'voice.stop-readout'; parameters: { value: true } };

export interface CompanionCommandIntentInput {
  requestId: string;
  contextId: string;
  text: string;
  currentValue: boolean;
  /** Host-observed current visibility intent, required before classifying visibility.
   * This is distinct from native visibility and grants no action authority. */
  currentVisible?: boolean;
  /** Host's saved mouse-follow setting; required to classify this fixed setting domain. */
  currentFollowMouse?: boolean;
  /** Actual host-saved numeric breathing strength, never a new enable field. */
  currentBreath?: number;
  /** Current host-saved readout volume in [0,1], not a media or playback grant. */
  currentReadoutVolume?: number;
}

export type CompanionCommandCandidate =
  | { kind: 'none' }
  | { kind: 'explicit'; action: CompanionCommandAction }
  | { kind: 'clarify'; prompt: string; choices: Array<{ label: string; action: CompanionCommandAction }> };

export type CompanionCommandStatus =
  | 'saved' | 'unchanged' | 'stopped' | 'no-current' | 'cancelled' | 'expired' | 'conflict' | 'rejected' | 'failed';

export interface CompanionCommandReceipt {
  /** Absent only for legacy topmost receipts. Other fixed domains identify their action. */
  actionId?: CompanionCommandActionId;
  requestId: string;
  revision: number;
  status: CompanionCommandStatus;
  persistence: 'saved' | 'unchanged' | 'not-committed' | 'unknown';
  presentation: 'applied' | 'failed' | 'not-requested' | 'unknown';
  /** Transient readout cancellation only; never persistence or physical audibility. */
  effect?: 'stopped' | 'no-current' | 'unknown';
  /** Boolean setting, voice integer percent, pet.set-breath actual strength [0,1], or framing preset. */
  value?: boolean | number | 'full' | 'portrait';
  /** Actual visibility observation; mouse-follow setting receipts must omit this field. */
  nativeValue?: boolean;
  message: string;
}

export interface CompanionCommandView {
  requestId: string;
  owner: 'controls' | 'pet';
  revision: number;
  prompt: string;
  choices: Array<{ choiceId: string; label: string }>;
  receipt?: CompanionCommandReceipt;
}

export interface CompanionCommandChoiceRequest {
  requestId: string;
  choiceId: string;
}
