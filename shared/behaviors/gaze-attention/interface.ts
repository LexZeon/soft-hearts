/**
 * I-081: what the companion window gets from the host about where the user is (electron/senses/user-gaze.ts → window.desktop.userGaze()), and
 * the screen-interest words haiku's frame description may add. Numbers and closed words only; memory only on both sides.
 */
import { POSE_FACINGS, type PoseFacing } from '../../senses/pose-signals';
import type { UserGazePoint, UserTurn } from './geometry';
import { parseUserAttention, type UserAttention } from '../pose-uses/attention';

/** "屏幕上这会儿值不值得看" (watch-together's frame description, same call): lively = something exciting is playing; calm = something
 *  is playing, steadily; typing = the user is writing or typing; idle = a desktop or nothing much. */
export const SCREEN_INTERESTS = ['lively', 'calm', 'typing', 'idle'] as const;
export type ScreenInterest = typeof SCREEN_INTERESTS[number];
export const isScreenInterest = (value: unknown): value is ScreenInterest => typeof value === 'string' && (SCREEN_INTERESTS as readonly string[]).includes(value);

/** I-081 体验记录 'gaze': she started looking at you (you came / turned to her), stopped (you left, turned away, sensing off, she fell
 *  asleep), an eye contact that reached her mood, a shy look-away. Closed words only, never a position. */
export const GAZE_JOURNAL_EVENTS = ['start', 'stop', 'eye-contact', 'shy'] as const;
export type GazeJournalEvent = typeof GAZE_JOURNAL_EVENTS[number];
export const GAZE_JOURNAL_WHY = ['arrived', 'facing', 'left', 'turned', 'off', 'asleep'] as const;
export type GazeJournalWhy = typeof GAZE_JOURNAL_WHY[number];
export const GAZE_JOURNAL_REASON: Readonly<Record<GazeJournalEvent, string>> = {
  start: '她开始时不时看你', stop: '她不再看你那边了', 'eye-contact': '你们对视了一会儿，她心里暖了一点', shy: '和你对上眼，她害羞地躲开了一下',
};
export const GAZE_JOURNAL_WHY_WORDS: Readonly<Record<GazeJournalWhy, string>> = {
  arrived: '你来到电脑前', facing: '你转过来朝着她', left: '你离开了', turned: '你转开了', off: '姿势识别关了', asleep: '她睡着了',
};

export interface UserGazeReading {
  /** Pose sensing sees somebody (fresh signal). */
  readonly present: boolean;
  readonly facing: PoseFacing;
  /** 0..1, how much the user moves (the signal's energy). */
  readonly energy: number;
  /** Where the user is, in her window's pointer units (geometry.ts); null when not known. */
  readonly point: UserGazePoint | null;
  /** The latest screen interest while screen pictures are described (fresh), else null. */
  readonly screen: ScreenInterest | null;
  /** I-167: which way the user's head points (degrees; geometry.ts UserTurn); null or absent when not known. */
  readonly turn?: UserTurn | null;
  /** I-189 #1, #2: facing the screen, turned away or gone (sure, debounced on the host: electron/senses/pose-uses/host.ts) and for how long; absent: not known. */
  readonly attention?: UserAttention;
}

const num = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** The companion window's check of the host's answer (the preload hands it through unchanged): anything off is no reading. */
export function parseUserGazeReading(value: unknown): UserGazeReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.present !== 'boolean' || !(POSE_FACINGS as readonly unknown[]).includes(v.facing) || !num(v.energy, 0, 1)) return null;
  if (v.screen !== null && !isScreenInterest(v.screen)) return null;
  let point: UserGazePoint | null = null;
  if (v.point !== null) {
    const p = v.point as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object' || !num(p.x, -8, 8) || !num(p.y, -8, 8) || !num(p.dx, 0.05, 32) || !num(p.dy, 0.05, 32)) return null;
    point = { x: p.x, y: p.y, dx: p.dx, dy: p.dy };
  }
  // I-167: the head's direction, only with a point (absent in an older reading: not known).
  let turn: UserTurn | null = null;
  if (v.turn !== undefined && v.turn !== null) {
    const t = v.turn as Record<string, unknown>;
    if (!point || typeof t !== 'object' || Array.isArray(t) || !num(t.x, -90, 90) || !num(t.y, -90, 90)) return null;
    turn = { x: t.x, y: t.y };
  }
  // I-189: the attention reading (absent in an older reading); a malformed one refuses the whole reading.
  let attention: UserAttention | null = null;
  if (v.attention !== undefined) { attention = parseUserAttention(v.attention); if (!attention) return null; }
  return { present: v.present, facing: v.facing as PoseFacing, energy: v.energy, point, screen: (v.screen ?? null) as ScreenInterest | null, ...(turn ? { turn } : {}), ...(attention ? { attention } : {}) };
}
