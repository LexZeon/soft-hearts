/**
 * 关应用也记（I-022）：这一次运行从什么时候开始、最后一次还在是什么时候、怎么停的。两个小文件在配置目录里，只有时间、
 * 一个随机的运行编号、角色编号和关法（shared/app-session.ts 的格式），不管体验记录开没开都写：困倦要靠它知道关了多久。
 *
 *  - `app-session.json`：启动时同步写一次，之后大约每分钟异步写一次"还在"（最后一次还在的时间，崩溃时拿它估）。
 *  - `app-stop.json`：开始退出的那一刻同步写一次（托盘"退出"、控制窗口"退出"、正常退出开关、关机或注销都走这里）。
 *    写不进去就算了：一次小文件写，失败被吞掉，绝不拦着退出、也不等任何东西。崩溃或被强制结束的那次没有这一份。
 *  - 下次启动时 begin() 先读这两份（同一个运行编号 → 正常退出，准确；没有 → 上次没正常退出，用最后一次还在的时间估一个上限），
 *    算出"关了多久"（只在这里算一次），再交给困倦（electron/fatigue-host.ts）和体验记录"应用启动"那一行，两边是同一个数。
 *
 * 两份文件分开写，所以还在半路的"还在"那次异步写永远盖不掉退出时同步写下的那一份。没有 Electron import：main.ts 接线，测试用临时目录。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_STOP_CAUSES, lastStopFrom, readAppSessionRecord, readAppStopRecord, type AppSessionRecord, type AppStopCause, type AppStopRecord,
  type LastStop } from '../../shared/app-session';

export const APP_SESSION_FILE = 'app-session.json';
export const APP_STOP_FILE = 'app-stop.json';
/** About once a minute: the crash estimate is at most this much too long. */
export const APP_SESSION_HEARTBEAT_MS = 60_000;
const MAX_RECORD_BYTES = 4096;

/** The few file operations it uses (tests replace them to make a write fail or hang). */
export interface AppSessionFs {
  /** The file's text, or null when it does not exist or cannot be read. */
  readNow(file: string): string | null;
  /** Synchronous, atomic (a temporary file, then a rename). */
  writeNow(file: string, text: string): void;
  /** Asynchronous, atomic. */
  write(file: string, text: string): Promise<void>;
}

export const nodeAppSessionFs: AppSessionFs = {
  readNow: file => {
    try { const text = readFileSync(file, 'utf8'); return text.length <= MAX_RECORD_BYTES ? text : null; } catch { return null; }
  },
  writeNow: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.now.tmp`;
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
  },
  write: async (file, text) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  },
};

export interface AppSessionOptions {
  /** The profile folder (null: nothing is read or written). */
  directory(): string | null;
  /** The character on screen now (an id), for the records. */
  characterId(): string | null;
  clock?(): number;
  fs?: AppSessionFs;
  heartbeatMs?: number;
  /** Runs `run` every `ms` until the returned function is called (tests drive it by hand). */
  every?(ms: number, run: () => void): () => void;
}

const parse = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };
const defaultEvery = (ms: number, run: () => void) => { const timer = setInterval(run, ms); timer.unref?.(); return () => clearInterval(timer); };

export class AppSessionHost {
  private readonly fs: AppSessionFs;
  private directory: string | null = null;
  private session: string | null = null;
  private startedAt = 0;
  private previous: LastStop | null = null;
  private noted: AppStopCause | null = null;
  private stoppedWith: AppStopCause | null = null;
  private cancelBeat: (() => void) | null = null;
  private beating: Promise<void> = Promise.resolve();
  /** The last write that failed ('begin' | 'beat' | 'stop'), for tests and the developer's eyes; never shown as an error. */
  failure: string | null = null;
  constructor(private readonly options: AppSessionOptions) { this.fs = options.fs ?? nodeAppSessionFs; }

  private now(): number { try { const value = (this.options.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } }
  private character(): string | null { try { const id = this.options.characterId(); return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null; } catch { return null; } }

  /**
   * Once per run, as early as the profile is known and before her fatigue wakes: reads how the previous run ended (exact or
   * estimated), then writes this run's start. Synchronous, two small files. Null: no previous record (or no profile).
   */
  begin(): LastStop | null {
    if (this.session) return this.previous;
    let directory: string | null = null;
    try { directory = this.options.directory(); } catch { directory = null; }
    if (!directory) return null;
    const now = this.now();
    this.directory = directory;
    this.previous = lastStopFrom(readAppSessionRecord(parse(this.fs.readNow(path.join(directory, APP_SESSION_FILE)))),
      readAppStopRecord(parse(this.fs.readNow(path.join(directory, APP_STOP_FILE)))), now);
    this.session = randomUUID();
    this.startedAt = now;
    this.writeSession(now, true);
    this.cancelBeat = (this.options.every ?? defaultEvery)(this.options.heartbeatMs ?? APP_SESSION_HEARTBEAT_MS, () => this.beat());
    return this.previous;
  }

  /** What begin() found (the same object, so the journal and her fatigue use one number). */
  lastStop(): LastStop | null { return this.previous; }

  /** How the coming quit was asked for (the tray, the control window, the quit switch); the first stop() uses it. */
  noteCause(cause: AppStopCause): void {
    if (!this.stoppedWith && (APP_STOP_CAUSES as readonly string[]).includes(cause)) this.noted = cause;
  }

  /** One "still here" (about once a minute). Asynchronous; a failure is only remembered. */
  beat(): void {
    if (!this.session || this.stoppedWith) return;
    this.writeSession(this.now(), false);
  }

  private writeSession(now: number, sync: boolean): void {
    if (!this.directory || !this.session) return;
    const record: AppSessionRecord = { version: 1, session: this.session, startedAt: this.startedAt, aliveAt: Math.max(this.startedAt, now), characterId: this.character() };
    const file = path.join(this.directory, APP_SESSION_FILE), text = JSON.stringify(record);
    if (sync) { try { this.fs.writeNow(file, text); } catch { this.failure = 'begin'; } return; }
    this.beating = this.beating.then(() => this.fs.write(file, text)).catch(() => { this.failure = 'beat'; });
  }

  /**
   * The quit has begun (before-quit, or the window's session-end on shutdown or log off): once, synchronously, writes when and how.
   * Later calls return the first cause and write nothing. Never throws and never waits. Returns the cause (also before begin(),
   * for the journal's quit line; then nothing is written).
   */
  stop(cause?: AppStopCause): AppStopCause {
    if (this.stoppedWith) return this.stoppedWith;
    const used: AppStopCause = cause && (APP_STOP_CAUSES as readonly string[]).includes(cause) ? cause : this.noted ?? 'other';
    this.stoppedWith = used;
    try { this.cancelBeat?.(); } catch { /* A timer that cannot be cleared only beats into a run that has stopped (beat() checks). */ }
    this.cancelBeat = null;
    if (this.directory && this.session) {
      const record: AppStopRecord = { version: 1, session: this.session, stoppedAt: this.now(), cause: used, characterId: this.character() };
      try { this.fs.writeNow(path.join(this.directory, APP_STOP_FILE), JSON.stringify(record)); } catch { this.failure = 'stop'; }
    }
    return used;
  }

  /** Waits for a "still here" write in flight (tests). */
  async settled(): Promise<void> { await this.beating; }
}
