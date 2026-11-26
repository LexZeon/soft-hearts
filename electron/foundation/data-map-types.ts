// Types of the data map's rows (split out of data-map.ts 2026-11-18 so the row tables and the index stay small; no behaviour change).
// The table is in data-map.ts (index) and data-map-rows-*.ts; data-map.ts says what it is and what the privacy actions do with it.
import type { RecycleItemKind } from '../../shared/foundation/recycle-bin';

/** Whose data a row is. */
export type DataScope =
  | 'character'             // one per character (her id)
  | 'character-connection'  // one per character and chat connection (the profile scope)
  | 'global'                // one for the whole profile
  | 'outside-profile';      // not under the profile directory at all

/** (a) Deleting a character with "同时删除她的记忆" ticked. */
export type CharacterForgetPolicy =
  | 'delete'          // cleared by forgetCharacterMemories through the registry (CharacterForgetRegistry)
  | 'follows'         // leaves together with the row named in `follows` (derived data, or removed inside that row's clear)
  | 'with-card'       // goes whenever the card is deleted, ticked or not
  | 'keep-confirmed'  // kept on purpose, the user confirmed it (C2: text memorials and her own mood stay)
  | 'keep'            // kept: not her memory of the user (settings, her own state, the app's records)
  | 'pending';        // 待用户定: left behind today; see the record for the recommendation

/** (b) "允许记录" turned off (the same callback also runs, for rows with `diaryCleared`, when the user clears the diary). */
export type RecordingOffPolicy =
  | 'delete'          // cleared through the recording-off registry (RecordingOffRegistry)
  | 'by-switch'       // deleted by the profile store itself when the switch goes off (UserProfileStore.setEnabled)
  | 'stops-new'       // nothing new is written; what is there stays
  | 'unaffected'      // the switch has nothing to do with it
  | 'pending';        // 待用户定

/** (c) The agent channel's delete_memories (parts chat / profile, into the recycle bin). */
export type AgentDeletePolicy =
  | 'recycle'           // moved into the recycle bin, can be put back
  | 'rides-chat'        // goes into the chat part's bin entry and comes back with it
  | 'follows'           // leaves with a part (derived, or removed inside the part's store)
  | 'deleted-for-good'  // removed for good when the profile part is deleted (not kept in the bin): a gap, see the record
  | 'rides-profile'     // goes into the profile part's bin entry and comes back with it (I-144)
  | 'own-tool'          // the agent channel has a separate tool for it
  | 'untouched';

/**
 * I-144 回收站: what a deletion that goes through the recycle bin does with the row.
 *  - 'take': the row's data for the character (or connection) is captured whole into the bin entry and removed; putting the entry back
 *    writes it back as it was. Each 'take' row has a capture, a remove and a restore in the recycle registry
 *    (electron/memory/recycle-wiring.ts, typed from the rows: a 'take' row without all three does not compile).
 *  - 'skip': deleted but never kept in the bin, for the reason in `recycleWhy`.
 *  - 'items': I-144b, only single things (or one clear) deleted in its own panel go into the bin (`recycleItems`); deleting a character
 *    leaves the row alone (text memorials stay, C2) or it is not any character's (the Claude assistant).
 *  - 'stays': no deletion removes it, so there is nothing to keep.
 * I-144b (every single deletion goes into the bin first): `recycleItems` names the entry kinds a panel's single
 * deletion (or clear) of the row makes; each kind has its restore in electron/memory/recycle/items-wiring.ts (typed from these rows: a kind no
 * row names, or a row's kind without a restore, does not compile).
 */
export type RecyclePolicy = 'take' | 'items' | 'skip' | 'stays';

/** (d) Character card export. */
export type CardExportPolicy = 'included' | 'never';
/** (f) Diagnostics. */
export type DiagnosticsPolicy = 'never' | 'numbers';

export interface DataStoreRow {
  readonly id: string;
  /** Chinese, for the user. */
  readonly label: string;
  /** What it holds, in a few words (never contents). */
  readonly holds: string;
  /** Path patterns relative to the profile directory (`*` = any name inside one folder level, `**` = anything below); for an
   *  outside-profile row, where it is, in words. */
  readonly paths: readonly string[];
  readonly scope: DataScope;
  /** Something about the user, or her memory of the user. */
  readonly holdsUserData: boolean;
  /** I-144: whether the recycle bin keeps it (收 / 不收). */
  readonly recycle: RecyclePolicy;
  /** I-144b: the single-deletion entry kinds that take something from this row (see RecyclePolicy). */
  readonly recycleItems?: readonly RecycleItemKind[];
  /** For 'skip': why the bin does not keep it (Chinese, for the user). */
  readonly recycleWhy?: string;
  readonly characterForget: CharacterForgetPolicy;
  /** For 'follows': the row whose clear removes this one too. */
  readonly follows?: string;
  readonly recordingOff: RecordingOffPolicy;
  /** Also cleared when the user clears the shown diary (UserProfileManagement 'diary-cleared'). */
  readonly diaryCleared?: boolean;
  readonly agentDelete: AgentDeletePolicy;
  readonly cardExport: CardExportPolicy;
  /** In scripts/experience/backup-profile.mjs's copy. */
  readonly backup: boolean;
  readonly diagnostics: DiagnosticsPolicy;
  /** Code that owns it. */
  readonly owner: string;
  readonly note?: string;
}
