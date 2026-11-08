/**
 * I-006 第 1 步 "陪你做事", host side (docs/claude/2026-11-06-i006-step1.md): whether the user is at the keyboard and mouse, so she can go
 * quiet and do her own things while the user is absorbed.
 *
 * What it reads, once per second inside the mood tick that already exists (no timer of its own): how many seconds since the user last
 * touched the keyboard or mouse (Electron `powerMonitor.getSystemIdleTime()`), whether the screen is locked or the computer asleep, and
 * whether one of her own windows has the focus. It never learns which key, which window or where the pointer went.
 *
 * The switch 「知道你是不是在忙」 (privacy page; default ON, the user's answer of 2026-11-06 12:51). Off: nothing is read, not even once
 * (the lock and sleep events are ignored too), and her behaviour is exactly what it was. The only thing written to disk is that switch
 * (`<profile>/user-activity.json`, only when the user changes it): the state itself lives in memory (shared/behaviors/user-activity).
 *
 * This file imports no Electron: electron/user-activity-wiring.ts supplies `powerMonitor` and the windows, so tests drive it with a
 * fake clock and fake idle seconds.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { UserActivityTracker } from '../shared/behaviors/user-activity/track';
import { UNKNOWN_ACTIVITY, type UserActivityHost, type UserActivityPretend, type UserActivitySwitchView, type UserActivityView } from '../shared/behaviors/user-activity/interface';

export type PowerEventName = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume';
export interface UserActivityPorts {
  /** `<profile>` folder, or null (tests with no file: the switch lives in memory). */
  directory(): string | null;
  /** powerMonitor.getSystemIdleTime(): whole seconds since the last keyboard or mouse input. Called only while the switch is on. */
  idleSeconds(): number;
  /** One of her windows has the focus. */
  windowFocused(): boolean;
  /** powerMonitor.on; the host listens to nothing more than these four. */
  power?: { on(event: PowerEventName, listener: () => void): unknown };
  /** The switch changed: both windows hear it. */
  broadcast?(view: UserActivitySwitchView): void;
  clock?(): number;
  tracker?: UserActivityHost;
  write?: AtomicFileWriter;
}

type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;
const FILE = 'user-activity.json';

/** The switch alone. Default on; a missing file is the default, an unreadable one is left untouched and the default is used in memory. */
class SwitchStore {
  private value = true;
  private loaded: 'no' | 'ready' | 'blocked' = 'no';
  /** The user changed the switch before the saved value was read: their choice wins over the file (Codex X-338 window). */
  private touched = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: { file: () => string | null; write?: AtomicFileWriter }) {}

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) { this.loaded = 'ready'; return; }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; enabled?: unknown };
      if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.enabled !== 'boolean') throw new Error('Invalid user-activity file');
      if (!this.touched) this.value = raw.enabled;
      this.loaded = 'ready';
    } catch (error) {
      if (!this.touched) this.value = true;
      this.loaded = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }
  /**
   * Codex X-338: until the saved switch is known (a file to read and `load` not finished), nothing is followed or read. Otherwise a
   * switch saved off still took lock/sleep events in the first moments after launch (the default is on), and kept them after the load.
   * No file to read (no folder) is known at once.
   */
  get ready(): boolean { return this.loaded !== 'no' || this.touched || this.options.file() === null; }
  get enabled(): boolean { return this.value; }
  set(value: boolean): void {
    if (typeof value !== 'boolean') throw new Error('“知道你是不是在忙”的开关不正确。');
    // Codex X-339 E13: before the saved value is read, the file may hold the opposite of the in-memory default, so a switch to the
    // same value as the default is still saved (else the file's old value comes back after a restart).
    const unread = this.loaded === 'no';
    this.touched = true;
    if (this.value === value && !unread) return;
    this.value = value;
    const file = this.options.file();
    if (!file || this.loaded === 'blocked') return;
    const text = JSON.stringify({ version: 1, enabled: value });
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await (this.options.write ?? atomicWriteFile)(file, text); }).catch(() => {});
  }
  flush(): Promise<void> { return this.queue; }
}

export function createUserActivity(ports: UserActivityPorts) {
  const clock = () => { try { const value = (ports.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } };
  const store = new SwitchStore({ file: () => { const dir = ports.directory(); return dir ? path.join(dir, FILE) : null; }, write: ports.write });
  const tracker: UserActivityHost = ports.tracker ?? new UserActivityTracker();
  let locked = false, asleep = false;
  let lastIdle: { at: number; seconds: number } | null = null;
  // On: the switch is known (loaded) and on. Before the saved value is read, as when off, the host knows nothing at all.
  const on = () => store.ready && store.enabled;
  // The four system events are followed only while the switch is on: switched off, the host knows nothing at all.
  const follow = (event: PowerEventName, apply: () => void) => { try { ports.power?.on(event, () => { if (on()) apply(); }); } catch { /* No power events: lock and sleep are simply not known. */ } };
  follow('lock-screen', () => { locked = true; });
  follow('unlock-screen', () => { locked = false; });
  follow('suspend', () => { asleep = true; });
  follow('resume', () => { asleep = false; });

  const unknownNow = (): UserActivityView => { tracker.reset(); locked = false; asleep = false; return UNKNOWN_ACTIVITY; };
  const switchView = (): UserActivitySwitchView => ({ enabled: store.enabled });
  const setEnabled = (value: unknown): UserActivitySwitchView => {
    if (typeof value !== 'boolean') throw new Error('“知道你是不是在忙”的开关不正确。');
    store.set(value);
    if (!value) unknownNow();
    const next = switchView();
    try { ports.broadcast?.(next); } catch { /* A closed window misses one update. */ }
    return next;
  };

  return {
    store, tracker,
    /** Reads the saved switch; saved off clears anything known before (belt and braces: nothing is taken before it is ready). */
    load: async () => { await store.load(); if (!store.enabled) unknownNow(); },
    flush: () => store.flush(),
    /** The state now. Off (or not yet known): always 说不准. */
    view: (): UserActivityView => on() ? tracker.view(clock()) : UNKNOWN_ACTIVITY,
    /**
     * The existing one-second tick. Off: not one read. A pretended state (developer test command): not one read either, so a real-window
     * test never touches the real keyboard and mouse. A failed read is 说不准 and starts nothing.
     */
    tick: (now = clock()): UserActivityView => {
      lastIdle = null;
      if (!on()) return UNKNOWN_ACTIVITY;
      let idleSeconds: number | null = null;
      if (!tracker.pretending(now)) { try { idleSeconds = ports.idleSeconds(); } catch { idleSeconds = null; } }
      let focused = false;
      try { focused = ports.windowFocused() === true; } catch { focused = false; }
      if (typeof idleSeconds === 'number' && Number.isFinite(idleSeconds) && idleSeconds >= 0 && !locked && !asleep) lastIdle = { at: now, seconds: idleSeconds };
      return tracker.tick({ now, idleSeconds, locked, asleep, windowFocused: focused });
    },
    /**
     * I-006 step 3: the seconds since the last keyboard or mouse input as of the last tick, for "the browser has been in front while you
     * were away". null whenever it is not known: switch off, locked or asleep, a failed read, a pretended state, or an old reading.
     */
    idleSeconds: (now = clock()): number | null => on() && lastIdle && now >= lastIdle.at && now - lastIdle.at <= 5_000 ? lastIdle.seconds : null,
    /** Developer test command: pretend one state for a few minutes (false: the switch is off). */
    pretend: (kind: UserActivityPretend | null): boolean => {
      if (!on()) return false;
      tracker.pretend(kind, clock());
      return true;
    },
    setEnabled,
    switchView,
    register: (scopedHost: Register) => {
      scopedHost('getUserActivity', () => switchView(), false);
      // The switch: the control window only (隐私与设置); the agent channel calls the same operation.
      scopedHost('setUserActivity', (_sender, value) => setEnabled(value), true);
    },
  };
}
