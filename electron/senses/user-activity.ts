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
 * This file imports no Electron: electron/senses/user-activity-wiring.ts supplies `powerMonitor` and the windows, so tests drive it with a
 * fake clock and fake idle seconds.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { UserActivityTracker } from '../../shared/behaviors/user-activity/track';
import { PresenceJudge } from '../../shared/behaviors/user-activity/presence';
import { parseScreenLook } from '../../shared/behaviors/user-activity/screen-look';
import { USER_ACTIVITY_KNOBS } from '../../shared/behaviors/user-activity/knobs';
import {
  STAGE_AWAY_IDLE_SECONDS, UNKNOWN_ACTIVITY, type PresenceContext, type PresencePretend, type PresenceView, type ScreenLook, type UserActivityHost, type UserActivityPretend,
  type UserActivitySwitchView, type UserActivityView,
} from '../../shared/behaviors/user-activity/interface';

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
  /**
   * I-066 你现在方便吗 (shared/behaviors/user-activity/presence.ts). All optional; absent = not known.
   *  - lastInteractionAt: the user's last chat or touch with her (switch off: the only thing that counts as present);
   *  - person: the local camera (P1) sees somebody (true) / nobody (false), only while its sensing runs;
   *  - screen: the opt-in screen look. `on` is the user's own screen-sharing switch (and no "别看" holding): off, no look ever;
   *    `capture` one downscaled frame (memory only); `ask` the small model's answer for it (electron/senses/user-activity-look.ts).
   *  - looked: one closed journal line per look (the category or 'failed'; never the picture or any words).
   */
  lastInteractionAt?(): number | null;
  person?(): boolean | null;
  screen?: { on(): boolean; capture(signal: AbortSignal): Promise<string | null>; ask(picture: string, signal: AbortSignal): Promise<string> };
  looked?(verdict: ScreenLook | 'failed'): void;
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
  const judge = new PresenceJudge();
  let looking: AbortController | null = null, lookStarted = 0, lookToken = 0;
  let locked = false, asleep = false;
  /** Overhaul step 7: the stage's away pace (the switch view's `away`), told to the windows when it changes. */
  let stageAway = false;
  let lastIdle: { at: number; seconds: number } | null = null;
  // On: the switch is known (loaded) and on. Before the saved value is read, as when off, the host knows nothing at all.
  const on = () => store.ready && store.enabled;
  // The four system events are followed only while the switch is on: switched off, the host knows nothing at all.
  const follow = (event: PowerEventName, apply: () => void) => { try { ports.power?.on(event, () => { if (on()) apply(); }); } catch { /* No power events: lock and sleep are simply not known. */ } };
  follow('lock-screen', () => { locked = true; });
  follow('unlock-screen', () => { locked = false; });
  follow('suspend', () => { asleep = true; });
  follow('resume', () => { asleep = false; });

  const unknownNow = (): UserActivityView => { tracker.reset(); judge.reset(); looking?.abort(); looking = null; locked = false; asleep = false; return UNKNOWN_ACTIVITY; };
  const read = <T>(get: (() => T) | undefined, fallback: T): T => { try { return get ? get() : fallback; } catch { return fallback; } };
  const screenOn = () => !!ports.screen && read(() => ports.screen!.on() === true, false);
  /** Screen sharing off (or "别看", or Claude unavailable): the verdict and a look in flight go at once. */
  const dropScreen = () => { looking?.abort(); looking = null; judge.forgetScreen(); };
  const presenceContext = (): PresenceContext => {
    const at = read(ports.lastInteractionAt, null), person = read(ports.person, null), sharing = screenOn();
    if (!sharing && (judge.verdict(clock()) !== null || judge.lookInFlight())) dropScreen();
    return { switchOn: on(), lastInteractionAt: typeof at === 'number' && Number.isFinite(at) ? at : null,
      activity: on() ? tracker.view(clock()) : null, person: person === true || person === false ? person : null, screenOn: sharing };
  };
  const presence = (now = clock()): PresenceView => judge.judge(now, presenceContext());
  /** One screen look, in the background; the verdict lands in the judgment (cached), the picture is dropped right after. */
  const askLook = (now = clock()): boolean => {
    const screen = ports.screen;
    if (!screen) return false;
    const token = judge.beginLook(now, presenceContext());
    if (token === null) return false;
    const controller = new AbortController();
    looking = controller; lookStarted = now; lookToken = token; // the one-second tick aborts it after look.timeoutSec (no timer of its own)
    void (async () => {
      let verdict: ScreenLook | null = null;
      try {
        let picture: string | null = await screen.capture(controller.signal);
        if (picture && !controller.signal.aborted && screenOn()) {
          const answer = await screen.ask(picture, controller.signal);
          picture = null;
          verdict = controller.signal.aborted ? null : parseScreenLook(answer);
        }
      } catch { verdict = null; }
      if (looking !== controller) return; // switched off or sharing ended meanwhile: dropped
      looking = null;
      judge.endLook(token, verdict, clock());
      try { ports.looked?.(verdict ?? 'failed'); } catch { /* The journal never changes the judgment. */ }
    })();
    return true;
  };
  const switchView = (): UserActivitySwitchView => (stageAway ? { enabled: store.enabled, away: true } : { enabled: store.enabled });
  const noteStageAway = (away: boolean) => {
    if (away === stageAway) return;
    stageAway = away;
    try { ports.broadcast?.(switchView()); } catch { /* A closed window misses one update. */ }
  };
  const setEnabled = (value: unknown): UserActivitySwitchView => {
    if (typeof value !== 'boolean') throw new Error('“知道你是不是在忙”的开关不正确。');
    store.set(value);
    if (!value) { unknownNow(); stageAway = false; }
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
      // I-066: a screen look that takes too long is dropped here, on the existing second (failed: counted, no verdict).
      if (looking && now - lookStarted > USER_ACTIVITY_KNOBS.presence.look.timeoutSec * 1000) {
        looking.abort(); looking = null;
        judge.endLook(lookToken, null, now);
        try { ports.looked?.('failed'); } catch { /* The journal never changes the judgment. */ }
      }
      if (!on()) { noteStageAway(false); return UNKNOWN_ACTIVITY; }
      let idleSeconds: number | null = null;
      if (!tracker.pretending(now) && !judge.pretending(now)) { try { idleSeconds = ports.idleSeconds(); } catch { idleSeconds = null; } }
      let focused = false;
      try { focused = ports.windowFocused() === true; } catch { focused = false; }
      if (typeof idleSeconds === 'number' && Number.isFinite(idleSeconds) && idleSeconds >= 0 && !locked && !asleep) lastIdle = { at: now, seconds: idleSeconds };
      const sample = { now, idleSeconds, locked, asleep, windowFocused: focused };
      // Overhaul step 7: the stage's away pace: no input for two minutes, the screen locked or the computer asleep (powerMonitor only).
      noteStageAway(locked || asleep || (typeof idleSeconds === 'number' && Number.isFinite(idleSeconds) && idleSeconds >= STAGE_AWAY_IDLE_SECONDS));
      // I-066: the same reading feeds 你现在方便吗 (and the local camera's "somebody in front", when it runs).
      const person = read(ports.person, null);
      judge.tick(sample, person === true || person === false ? person : null);
      return tracker.tick(sample);
    },
    /** I-066 你现在方便吗: the one shared judgment (presence / interrupt / source). Switch off: only her recent interactions count. */
    presence,
    /** I-066: the judgment wants a screen look (sharing on, unsure, within the hourly count): start one in the background. */
    askLook,
    /** I-066: screen sharing turned off (or "别看"): the verdict and a look in flight are dropped at once. */
    screenChanged: (sharing: boolean) => { if (!sharing) dropScreen(); },
    /** Developer view and tests: the looks in the past hour and the fresh verdict (a category, never a picture). */
    lookView: (now = clock()) => ({ looks: judge.looksInLastHour(now), verdict: judge.verdict(now), inFlight: judge.lookInFlight() }),
    /**
     * I-006 step 3: the seconds since the last keyboard or mouse input as of the last tick, for "the browser has been in front while you
     * were away". null whenever it is not known: switch off, locked or asleep, a failed read, a pretended state, or an old reading.
     */
    idleSeconds: (now = clock()): number | null => on() && lastIdle && now >= lastIdle.at && now - lastIdle.at <= 5_000 ? lastIdle.seconds : null,
    /** Developer test command: pretend one state for a few minutes (false: the switch is off). */
    pretend: (kind: UserActivityPretend | PresencePretend | null): boolean => {
      if (!on()) return false;
      const now = clock();
      // I-066: 假装我不在 / 回来了 / 在开会 live in the presence judgment; the busy state stops pretending meanwhile (and the reverse).
      if (kind === 'away' || kind === 'back' || kind === 'meeting') { tracker.pretend(null, now); judge.pretend(kind, now); }
      else { judge.pretend(null, now); tracker.pretend(kind, now); }
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
