/**
 * 关应用也记（I-022）：上一次应用停在什么时候、关了多久、怎么关的。
 * 这里只有纯函数和格式；文件在 electron/app-session/（`<profile>/app-session.json` 和 `app-stop.json`，只有时间、角色编号和关法）。
 *
 * "关了多久"只在这里算一次（closedSpan）：体验记录"应用启动"那一行和她的困倦（关着的时间算休息，shared/behaviors/sleep-rhythm/）
 * 用同一个数。用墙上时间（进程重启以后单调时钟接不上）：倒退的时间不算（0，标 clockBack），多久都照实记；困倦那边再按自己的上限
 * （最多 24 小时）只算一部分。
 */

/** How the previous run ended: the tray's 退出, the control window's 退出, the quit switch (--soft-hearts-quit), shutdown or log off, anything else. */
export const APP_STOP_CAUSES = ['tray', 'controls', 'quit-request', 'session-end', 'other'] as const;
export type AppStopCause = (typeof APP_STOP_CAUSES)[number];
/** The journal's plain words for a cause (shared/journal.ts). */
export const APP_STOP_CAUSE_LABEL: Readonly<Record<AppStopCause, string>> = Object.freeze({
  tray: '托盘退出', controls: '控制窗口里退出', 'quit-request': '正常退出请求', 'session-end': '关机或注销', other: '其他',
});

/** Written when a run starts and again about once a minute while it runs (its last sign of life). */
export interface AppSessionRecord {
  readonly version: 1;
  readonly session: string;
  readonly startedAt: number;
  readonly aliveAt: number;
  /** The character on screen at the last sign of life (an id only). */
  readonly characterId: string | null;
}
/** Written once, synchronously, when that run begins to quit. A run that crashed or was killed never writes one. */
export interface AppStopRecord {
  readonly version: 1;
  readonly session: string;
  readonly stoppedAt: number;
  readonly cause: AppStopCause;
  readonly characterId: string | null;
}

/** What the next start knows about the previous run's end. */
export interface LastStop {
  /** When it stopped (wall ms): exact when it wrote its stop, else its last sign of life. */
  readonly at: number;
  /** How long the app was closed, now − at, never negative. When `exact` is false this is an upper bound (估的). */
  readonly closedMs: number;
  /** false: 上次没正常退出 (crashed, killed, power lost): `at` is its last sign of life, so `closedMs` is at most this. */
  readonly exact: boolean;
  /** How it quit (only when exact). */
  readonly cause: AppStopCause | null;
  /** The character on screen then (an id only). */
  readonly characterId: string | null;
  /** The computer's clock is earlier than `at` now: the closed time counts as 0. */
  readonly clockBack: boolean;
}

const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const CHARACTER = /^[A-Za-z0-9_-]{1,100}$/;
/** 2020-01-01: a time before this in a record is not a real one. */
const EARLIEST = 1_577_836_800_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const wall = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= EARLIEST && v <= 8.64e15;
const character = (v: unknown): string | null | undefined => v === null ? null : typeof v === 'string' && CHARACTER.test(v) ? v : undefined;

/** How long between two wall times: whole milliseconds, 0 when the clock went back (or a time cannot be read). */
export function closedSpan(fromWallMs: number, toWallMs: number): { ms: number; clockBack: boolean } {
  if (!Number.isFinite(fromWallMs) || !Number.isFinite(toWallMs)) return { ms: 0, clockBack: false };
  const raw = toWallMs - fromWallMs;
  return raw < 0 ? { ms: 0, clockBack: true } : { ms: Math.floor(raw), clockBack: false };
}

export function readAppSessionRecord(value: unknown): AppSessionRecord | null {
  if (!object(value) || value.version !== 1 || typeof value.session !== 'string' || !SESSION.test(value.session)
    || !wall(value.startedAt) || !wall(value.aliveAt) || value.aliveAt < value.startedAt) return null;
  const id = character(value.characterId);
  if (id === undefined) return null;
  return { version: 1, session: value.session, startedAt: value.startedAt, aliveAt: value.aliveAt, characterId: id };
}

export function readAppStopRecord(value: unknown): AppStopRecord | null {
  if (!object(value) || value.version !== 1 || typeof value.session !== 'string' || !SESSION.test(value.session)
    || !wall(value.stoppedAt) || !(APP_STOP_CAUSES as readonly unknown[]).includes(value.cause)) return null;
  const id = character(value.characterId);
  if (id === undefined) return null;
  return { version: 1, session: value.session, stoppedAt: value.stoppedAt, cause: value.cause as AppStopCause, characterId: id };
}

/**
 * The previous run's end from its two records, at `nowWallMs`. Its stop record (same session) → exact. No stop record for it →
 * 上次没正常退出, estimated from its last sign of life. Nothing readable → null (the first start that keeps these records).
 */
export function lastStopFrom(session: AppSessionRecord | null, stop: AppStopRecord | null, nowWallMs: number): LastStop | null {
  const clean = stop && (!session || stop.session === session.session) ? stop : null;
  if (clean) {
    const span = closedSpan(clean.stoppedAt, nowWallMs);
    return { at: clean.stoppedAt, closedMs: span.ms, exact: true, cause: clean.cause, characterId: clean.characterId, clockBack: span.clockBack };
  }
  if (!session) return null;
  const span = closedSpan(session.aliveAt, nowWallMs);
  return { at: session.aliveAt, closedMs: span.ms, exact: false, cause: null, characterId: session.characterId, clockBack: span.clockBack };
}
