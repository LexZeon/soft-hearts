/**
 * Unbound v1 step 4: what her free time may know about you (docs/claude/2026-11-17-unbound-step4.md「你在做什么」). Only signals
 * that are already on; nothing new is sensed, nothing is stored or sent. Each reading goes through one of these pure functions, so a
 * test pins what may pass and the mutation list (scripts/dev/mutations/unbound.json) breaks each gate once:
 *
 *   idle seconds and 「知道你是不是在忙」's state   → `userDoing` (busy / paused / away / unknown); locked or asleep reads as away
 *   the full-screen watcher                      → as it is (a boolean)
 *   the pose sensing the bundle opened            → pose-read.ts: present, facing, posture, wave, stretch with their confidence
 *                                                   bands; only while she is out and it is running
 *   the screen-sharing foreground reading         → `foregroundKind`: only the closed activity words, as typing / video / game / idle;
 *                                                   anything else (a program name, a window title) is not a word and gives null
 *   you talking, not to her (afternoon addition)   → `talkingToOthers`: only that it happened lately (the voiceprint said it was you,
 *                                                   no name, no call); never a word of it
 *   the computer's sound                           → `soundPlaying`: only the closed kind words music / show / talk
 */
import { SCREEN_ACTIVITIES, type ScreenActivity } from '../../senses';
import { readPose, type PoseRead } from './pose-read';

export type UserDoing = 'busy' | 'paused' | 'away' | 'unknown';
export type ForegroundKind = 'typing' | 'video' | 'game' | 'idle';
export const FOREGROUND_KINDS: readonly ForegroundKind[] = Object.freeze(['typing', 'video', 'game', 'idle']);

/** Everything her free time reads about you, once a second (memory only). */
export interface LifeSignals {
  /** Seconds since your last key or mouse input; null when not known (switch off, locked, asleep). */
  idleSeconds: number | null;
  doing: UserDoing;
  fullscreen: boolean;
  /** The camera's pose sensing sees somebody (true) or nobody (false); null when it is not running or she is not out. */
  someoneInFront: boolean | null;
  foreground: ForegroundKind | null;
  /** The camera's reading (pose-read.ts), only while she is out and it runs; null otherwise. */
  pose: PoseRead | null;
  /** You spoke lately, not to her (the fact only). */
  talkingToOthers: boolean;
  /** The computer is playing sound (music, a show, voices). */
  soundPlaying: boolean;
}
export const NO_SIGNALS: Readonly<LifeSignals> = Object.freeze({ idleSeconds: null, doing: 'unknown', fullscreen: false, someoneInFront: null, foreground: null,
  pose: null, talkingToOthers: false, soundPlaying: false });

/** No key or mouse for this long counts as paused (s); more than AWAY_S as away (nobody would see her). */
export const PAUSED_S = 60;
export const AWAY_S = 900;

const finiteIdle = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** 「知道你是不是在忙」's state ('busy' | 'pause' | 'away' | 'unknown') and the idle seconds → what you are doing. */
export function userDoing(state: unknown, idleSeconds: unknown): UserDoing {
  const idle = finiteIdle(idleSeconds);
  if (state === 'away') return 'away';
  if (idle === null) return state === 'busy' ? 'busy' : state === 'pause' ? 'paused' : 'unknown';
  if (idle >= AWAY_S) return 'away';
  return idle >= PAUSED_S ? 'paused' : 'busy';
}

/** Only `present` of a pose signal, only while she is out and the sensing runs (a null signal: not running). */
export function someoneInFront(out: boolean, signal: unknown): boolean | null {
  if (out !== true) return null;
  return readPose(signal)?.present ?? null;
}

/** The rough activity of the program in front (a closed word) → a kind. Not a word (a name, a title, anything else): null. */
export function foregroundKind(activity: unknown, idleSeconds: unknown): ForegroundKind | null {
  if (typeof activity !== 'string' || !(SCREEN_ACTIVITIES as readonly string[]).includes(activity)) return null;
  const word = activity as ScreenActivity, idle = finiteIdle(idleSeconds);
  if (word === 'video') return 'video';
  if (word === 'game') return 'game';
  if (word === 'code' || word === 'writing' || word === 'chat') return idle !== null && idle >= PAUSED_S ? 'idle' : 'typing';
  return idle !== null && idle >= PAUSED_S ? 'idle' : idle === null ? null : 'typing';
}

/** You talked, not to her, within this long (ms): she keeps quieter. */
export const TALKING_HOLD_MS = 20_000;
/** The last time the voiceprint passed your voice with no name and no call (ms) → whether that was lately. */
export function talkingToOthers(lastAt: unknown, now: number): boolean {
  return typeof lastAt === 'number' && Number.isFinite(lastAt) && now >= lastAt && now - lastAt < TALKING_HOLD_MS;
}
/** The computer's sound kind (shared/senses/listen-kind.ts words) → whether something plays. Anything else: no. */
export function soundPlaying(kind: unknown): boolean { return kind === 'music' || kind === 'show' || kind === 'talk'; }

/** The whole reading, built only from the listed fields (anything else in `raw` is dropped). Everything but the computer's own state needs her out. */
export function lifeSignals(raw: { idleSeconds?: unknown; state?: unknown; fullscreen?: unknown; out?: unknown; pose?: unknown; activity?: unknown;
  talkedAt?: unknown; sound?: unknown; now?: unknown }): LifeSignals {
  const idleSeconds = finiteIdle(raw.idleSeconds), out = raw.out === true;
  const now = typeof raw.now === 'number' && Number.isFinite(raw.now) ? raw.now : Date.now();
  const pose = out ? readPose(raw.pose) : null;
  return {
    idleSeconds,
    doing: userDoing(raw.state, idleSeconds),
    fullscreen: raw.fullscreen === true,
    someoneInFront: pose ? pose.present : null,
    foreground: out ? foregroundKind(raw.activity, idleSeconds) : null,
    pose,
    talkingToOthers: out && talkingToOthers(raw.talkedAt, now),
    soundPlaying: out && soundPlaying(raw.sound),
  };
}

/** Words for the developer panel (never a program name). */
export const DOING_WORDS: Readonly<Record<UserDoing, string>> = Object.freeze({ busy: '你在用电脑', paused: '你停下来了', away: '你离开了', unknown: '不知道你在做什么' });
export const FOREGROUND_WORDS: Readonly<Record<ForegroundKind, string>> = Object.freeze({ typing: '在打字', video: '在看视频', game: '在玩游戏', idle: '闲着' });
