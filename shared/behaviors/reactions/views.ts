/**
 * I-037: what the control window and the agent channel see of 新的反应方式 (electron/reactions/wiring.ts makes them). Numbers,
 * ids and fixed labels only.
 */
import type { DispositionId, Dispositions } from './dispositions';

/** The switch in 隐私与设置 and today's haiku calls. */
export interface ReactionSwitchView {
  readonly enabled: boolean;
  /** False while it still follows the channel's default (development: on, stable: off). */
  readonly chosen: boolean;
  readonly defaultEnabled: boolean;
  readonly today: number;
  readonly cap: number;
  readonly base: number;
  readonly perChat: number;
  readonly max: number;
}

/** The current character's six 反应倾向 (角色页 sliders, set_reaction_dispositions). */
export interface ReactionDispositionsView {
  /** Null: no character yet. */
  readonly characterId: string | null;
  readonly values: Dispositions | null;
  /** False: nothing stored for this character; `values` are derived from its card. */
  readonly stored: boolean;
  /** What its card gives (the 「按角色卡」 button goes back to these). */
  readonly derived: Dispositions | null;
  readonly items: readonly { readonly id: DispositionId; readonly label: string; readonly hint: string }[];
}

/** `desk:reactions`: both, after either changed. */
export interface ReactionsBroadcast { readonly switch: ReactionSwitchView; readonly dispositions: ReactionDispositionsView }
