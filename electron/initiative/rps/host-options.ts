import type { FatiguePhase } from '../../../shared/mood';
import type { HerLifeActivity } from '../../../shared/stage';
import type { MoodParameters, MoodSnapshot, MoodValues } from '../../../shared/foundation/mood';
import type { RPS_TIMING, RpsFace, RpsHand, RpsInputSource, RpsUnreadWhy, RpsView } from '../../../shared/initiative/rps';
import type { RpsMatchEnd } from '../../../shared/initiative/rps-match';
import type { RouterVerdict, RouterDecision } from '../../../shared/brain';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import type { InteractionBudget } from '../../../shared/behaviors/interaction-budget/interface';
import type { RpsStore } from './store';
import type { RpsVoiceOptions } from './voice';

// G1 猜拳: the host's options and the shapes it hands out (moved out of host.ts on 2026-11-25 so that file stays under 40 KB; nothing changed).
/** The active character as the host sees it at one moment. */
export interface RpsCharacterState {
  id: string;
  /** compileCharacterPersona(card): her words are asked with it. */
  persona: string;
  parameters: MoodParameters;
  snapshot: Pick<MoodSnapshot, 'primary' | 'values'>;
  fatigue: FatiguePhase | null | undefined;
  /** 她自己的生活: what she is doing now, and its chat words ("想事情"). */
  herLife: HerLifeActivity | null | undefined;
  herLifeChat?: string;
}
export interface RpsTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface RpsHostOptions {
  store: RpsStore;
  character(): RpsCharacterState | null;
  /** The companion window is shown (a hidden companion never starts or keeps a game). */
  visible(): boolean;
  /** The user profile's "允许记录" for the current scope: only then are the user's hands kept. */
  recording(): boolean;
  localDate(ms: number): string;
  publish(view: RpsView | null): void;
  /** The existing mood event when a match ends (electron/mood/mood.ts: a positive chat event with its own topic, so repeats fade). */
  mood(event: { id: string; delta: Partial<MoodValues>; reason: string }, characterId: string): void;
  /** A chat turn is in flight: the mood event waits (a chat event in between would cost that reply its appraisal). */
  chatBusy(): boolean;
  /** Her voice is still reading a reply (either voice): a game she agreed to starts after she finishes. Omitted: never. */
  speaking?(): boolean;
  /** She turns to the user (her-life). */
  interacted?(characterId: string): void;
  /** Her words at a moment of the game: the small model's one short call (electron/initiative/rps/voice.ts). Omitted: only remembered lines. */
  quick?: RpsVoiceOptions['quick'];
  available?(): boolean;
  /** Her language habits for the active card (personalize-language context), or ''. */
  language?(): string;
  /** The active card's language (cardLanguageOf): an English card's game lines are English. Absent: Chinese. */
  speechLanguage?(): CardLanguage;
  /**
   * A line is about to be shown with id `sayId`: freeze its voice style now (mood and persona, as for her other lines),
   * so the Bailian voice reads it like the rest of what she says.
   */
  speechStyle?(sayId: string): void;
  /** The camera gesture input is on (not yet: point 7 chose MediaPipe for later). Default: clicks only. */
  cameraInput?(): boolean;
  clock?: () => number;
  random?: () => number;
  /** Whether she speaks and which remembered line: its own stream, so it never shifts her sealed picks. */
  voiceRandom?: () => number;
  nonce?: () => string;
  createId?: () => string;
  timers?: RpsTimers;
  timing?: Partial<typeof RPS_TIMING>;
  /** 体验记录 (shared/memory/journal.ts "rps"): invitations, answers and each match's numbers (never the hands, never her words). */
  journal?(characterId: string, entry: RpsJournalEntry): void;
  /**
   * I-023 haiku 调度台 (electron/brain/module-router/): haiku's reading of message `requestId` for 猜拳, asked once her reply is done
   * (it ran in parallel with Opus). Only for a message the local words did not recognise (nor as a refusal). Omitted: local words only.
   */
  routed?(requestId: string): Promise<RouterVerdict>;
  /** I-023: who decided for this message and what she did (the developer panel's "为什么"). */
  decided?(requestId: string, decision: RouterDecision): void;
  /**
   * I-010 互动余额 (electron/initiative/interaction-budget/host.ts), read each time it is needed: when she may invite again is counted in the
   * user's interactions since her last invitation and the last game (not 2 hours, 1 hour and 2 a day); whether she says something in
   * a game is pressed by the budget's room (not by "lines today"), and a line she says spends from it. Omitted or null: the old rules.
   */
  budget?(): Pick<InteractionBudget, 'credit' | 'room' | 'spend' | 'interactionsSince' | 'againAfter'> | null;
}

/** One 猜拳 moment for the 体验记录: counts only. */
export interface RpsJournalEntry {
  event: 'invite' | 'accept' | 'decline' | 'expired' | 'start' | 'result' | 'line-unread';
  /** line-unread: why one of her game lines was not read aloud (closed words). */
  unread?: RpsUnreadWhy;
  origin?: 'her' | 'user'; rounds?: number; herWins?: number; userWins?: number; draws?: number; result?: 'her' | 'user' | 'none'; end?: RpsMatchEnd;
  /** How many lines she said in that match. */
  spoke?: number;
}

