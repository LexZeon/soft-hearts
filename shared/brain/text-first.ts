/**
 * I-085 第 3 步 文字为主，细看才附图 (option B:
 * "选 B（我推荐）：她的第一个字每句快约 0.9 秒，语音通话也更快；代价是她平时看到的是一句总结，细节少一点。可以"). The pure parts: when she takes a closer look on her own while watching together, and the
 * experience journal's one row per chat turn (closed words only). Which frames a turn carries is electron/senses/look-attachments.ts; the
 * words she is told are shared/brain/perception-rule.ts.
 *
 * Read and write (handbook/how-we-work.md "心情相关的事"): reads D 好奇 against the card's baseline (shared/initiative/self-look.ts
 * riseAboveBaseline); writes nothing. Not a loop: a closer look only changes what one turn carries.
 */
import { TEXT_FIRST_KNOBS, type TextFirstKnobs } from '../behaviors/text-first/knobs';

/** The latest screen description of 和她一起看 (electron/senses/watch-notes/session.ts sight): when its frame was taken, and whether it said anything. */
export interface WatchSight { at: number; clear: boolean }

export interface CuriousLookInput {
  /** D 好奇 above the card's baseline, 0–1 (null: her mood is not known — no closer look). */
  curiosity: number | null;
  /** The latest description (null: none yet). */
  sight: WatchSight | null;
  now: number;
  /** Her last closer look (null: none yet). */
  lastAt: number | null;
}

/**
 * She very much wants a closer look at the shared screen: curious enough, the latest description is stale or said nothing, and her
 * last closer look was at least `cooldownMs` ago. Only asked while 和她一起看 is on and no "别看" holds (electron/senses/look-attachments.ts).
 */
export function curiousCloserLook(input: CuriousLookInput, knobs: TextFirstKnobs = TEXT_FIRST_KNOBS): boolean {
  const k = knobs.curious;
  if (k.enabled !== true || typeof input.curiosity !== 'number' || !Number.isFinite(input.curiosity) || input.curiosity < k.minRise) return false;
  if (input.lastAt !== null && input.now >= input.lastAt && input.now - input.lastAt < k.cooldownMs) return false;
  const sight = input.sight;
  return !sight || !sight.clear || input.now - sight.at >= k.staleMs;
}

// ---------------------------------------------------------------- the experience journal (closed words only)

/** What one sense gave her on a chat turn: a picture, a text line (a description or her own look), nothing, or nothing because of a "别看". */
export const LOOK_TURN_CARRIES = ['frame', 'text', 'none', 'held'] as const;
export type LookTurnCarry = (typeof LOOK_TURN_CARRIES)[number];
/** Why a picture went: the user asked (words), asked about their looks, pressed a button (or attached one by hand), said yes to her offer, she was curious. */
export const LOOK_TURN_WHYS = ['asked', 'appearance', 'button', 'offer', 'curious'] as const;
export type LookTurnWhy = (typeof LOOK_TURN_WHYS)[number];

/** How a frame was asked for, as electron/senses/look-attachments.ts TurnFrames reports it. */
export type FrameVia = 'button' | 'words' | 'offer' | 'appearance' | 'curious' | 'photo';

export interface LookTurnFacts {
  /** 和她一起看 is on (screen sharing and 一起听's words). */
  watching: boolean;
  /** A "别看" holds the screen (electron/senses/look-turns.ts refusedIn). */
  screenHeld: boolean;
  /** The screen picture this turn carries and how it came (null: none). */
  screenFrame: FrameVia | null;
  /** The turn carries the watch timeline's descriptions (or the I-047 block). */
  watchText: boolean;
  /** 「发图片」 is on. */
  cameraOn: boolean;
  /** A "别看" holds the camera. */
  cameraHeld: boolean;
  /** The clear camera picture this turn carries and how it came (null: none). */
  cameraFrame: FrameVia | null;
  /** Her own recent look's line went with this turn. */
  selfText: boolean;
}

export interface LookTurnRow { screen?: LookTurnCarry; camera?: LookTurnCarry; why?: LookTurnWhy }

const WHY: Readonly<Record<FrameVia, LookTurnWhy>> = { words: 'asked', appearance: 'appearance', button: 'button', photo: 'button', offer: 'offer', curious: 'curious' };

function carry(frame: FrameVia | null, held: boolean, text: boolean): LookTurnCarry {
  return frame ? 'frame' : held ? 'held' : text ? 'text' : 'none';
}

/** The row for one chat turn, or null when neither 和她一起看 nor 「发图片」 is on (no row then). `why` is the picture's reason, the screen's first. */
export function lookTurnRow(facts: LookTurnFacts): LookTurnRow | null {
  if (!facts.watching && !facts.cameraOn) return null;
  const row: LookTurnRow = {};
  if (facts.watching) row.screen = carry(facts.screenFrame, facts.screenHeld, facts.watchText);
  if (facts.cameraOn) row.camera = carry(facts.cameraFrame, facts.cameraHeld, facts.selfText);
  const via = (facts.watching ? facts.screenFrame : null) ?? (facts.cameraOn ? facts.cameraFrame : null);
  if (via) row.why = WHY[via];
  return row;
}

export const LOOK_TURN_CARRY_WORDS: Readonly<Record<LookTurnCarry, string>> = { frame: '附了画面', text: '用文字', none: '什么都没有', held: '你说过别看' };
export const LOOK_TURN_WHY_WORDS: Readonly<Record<LookTurnWhy, string>> = {
  asked: '你叫她看的', appearance: '你问到自己的样子', button: '你点了按钮', offer: '她问要不要看，你说好', curious: '她好奇凑近看了一眼',
};
export const LOOK_TURN_SENSE_WORDS = { screen: '一起看', camera: '摄像头' } as const;
