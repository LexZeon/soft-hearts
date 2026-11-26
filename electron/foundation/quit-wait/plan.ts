// I-182: a launch that meets an instance which is still quitting
// waits for it to be fully gone instead of exiting silently ("点了没反应"). No Electron import: electron/wiring/startup-wait-wiring.ts
// gives the steps, tests/quit-wait.test.ts drives them with fakes.
//
// How a launch tells a running instance from a quitting one: the instance that holds the profile lock writes a small marker into its
// profile folder when its quit begins (quit-wiring markExiting): {pid, time, program, UI language}. It never removes it; the next
// instance that holds the lock clears it. A marker counts only while its pid is alive, the program behind that pid is the same, and it
// is younger than QUIT_WAIT.staleMs, so a crashed instance (dead pid) or a reused pid never makes a launch wait.
//
// The rule this keeps: two processes never use one profile folder. Electron gives the single-instance lock back when its quit event
// fires, before Chromium's own teardown (10–90 s on a busy computer), so even a launch that gets the lock does not start while the
// quitting instance is still alive; it gives the lock back and waits. A waiting launch moves its own Chromium data to a throw-away
// folder before the app is ready (the wiring), shows a small notice, and starts a fresh launch once the old process is gone.
import path from 'node:path';
import { QUIT_WAIT } from './knobs';

export const QUIT_MARKER_FILE = 'quitting.json';
const MAX_MARKER_BYTES = 4_096;
/** Clock skew allowed for a marker written "in the future" (a clock change while quitting). */
const FUTURE_SKEW_MS = 60_000;

export type QuitWaitLanguage = 'zh-CN' | 'en';
export interface QuitMarker { readonly pid: number; readonly at: number; readonly image: string; readonly lang: QuitWaitLanguage }
export type QuitWaitKnobs = { readonly [K in keyof typeof QUIT_WAIT]: number };

export function quitMarkerPath(profile: string): string { return path.join(profile, QUIT_MARKER_FILE); }

export function encodeQuitMarker(marker: QuitMarker): string {
  return JSON.stringify({ version: 1, state: 'quitting', pid: marker.pid, at: marker.at, image: marker.image, lang: marker.lang }) + '\n';
}

/** A marker read back, or null for anything that is not exactly one (a broken file never makes a launch wait). */
export function parseQuitMarker(text: string): QuitMarker | null {
  if (typeof text !== 'string' || text.length > MAX_MARKER_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.state !== 'quitting') return null;
  const { pid, at, image } = row;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  if (typeof image !== 'string' || !image || image.length > 260 || /[\\/\0]/.test(image)) return null;
  return { pid, at, image, lang: row.lang === 'en' ? 'en' : 'zh-CN' };
}

/** What the quitting instance writes, or null: only the instance that holds the profile lock may say "I am quitting" for it. */
export function quitMarkerToWrite(input: { holdsLock: boolean; pid: number; now: number; executable: string; lang: string }): QuitMarker | null {
  if (!input.holdsLock) return null;
  return { pid: input.pid, at: input.now, image: path.basename(input.executable), lang: input.lang === 'en' ? 'en' : 'zh-CN' };
}

export interface MarkerFiles {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; mode: number }): void;
  rmSync(file: string, options: { force: true }): void;
}
/** Synchronous and best effort: a quit never fails because the marker could not be written. */
export function writeQuitMarker(files: MarkerFiles, profile: string, marker: QuitMarker | null): boolean {
  if (!marker) return false;
  try { files.writeFileSync(quitMarkerPath(profile), encodeQuitMarker(marker), { encoding: 'utf8', mode: 0o600 }); return true; } catch { return false; }
}
export function readQuitMarker(files: MarkerFiles, profile: string): QuitMarker | null {
  try { return parseQuitMarker(files.readFileSync(quitMarkerPath(profile), 'utf8')); } catch { return null; }
}
export function clearQuitMarker(files: MarkerFiles, profile: string): void {
  try { files.rmSync(quitMarkerPath(profile), { force: true }); } catch { /* the next start tries again */ }
}

export interface QuitWaitClock { now(): number; selfPid: number; knobs?: Partial<QuitWaitKnobs> }
/** isAlive(pid, image): the process is running and (where the platform can tell) is the same program the marker names. */
export type AliveCheck = (pid: number, image: string) => boolean;

/** The instance that wrote this marker is still around (quitting, or stuck in Chromium's teardown). */
export function quittingInstance(marker: QuitMarker | null, clock: QuitWaitClock, isAlive: AliveCheck): boolean {
  if (!marker || marker.pid === clock.selfPid) return false;
  const age = clock.now() - marker.at;
  const staleMs = clock.knobs?.staleMs ?? QUIT_WAIT.staleMs;
  if (age > staleMs || age < -FUTURE_SKEW_MS) return false;
  return isAlive(marker.pid, marker.image);
}

export type StartupPlan =
  | { readonly kind: 'start' }
  | { readonly kind: 'hand-over' }
  | { readonly kind: 'wait'; readonly marker: QuitMarker; readonly startedAt: number };

export interface StartupLockSteps extends QuitWaitClock {
  /** app.requestSingleInstanceLock(): false when another process holds the profile (a running one is told and shows itself). */
  requestLock(): boolean;
  releaseLock(): void;
  readMarker(): QuitMarker | null;
  isAlive: AliveCheck;
  /** Blocks the main thread (before the app is ready nothing else may run on the profile anyway). */
  sleepSync(ms: number): void;
}

/** Synchronous, before the app is ready: start now, hand over to the running instance, or wait for the quitting one. */
export function planStartup(steps: StartupLockSteps): StartupPlan {
  const graceMs = steps.knobs?.graceMs ?? QUIT_WAIT.graceMs;
  const pollMs = Math.max(10, steps.knobs?.pollMs ?? QUIT_WAIT.pollMs);
  const startedAt = steps.now();
  let locked = steps.requestLock();
  const first = steps.readMarker();
  if (!first || !quittingInstance(first, steps, steps.isAlive)) {
    if (locked) return { kind: 'start' };
    // The lock is held and nobody is quitting: a running instance was told and shows itself. A marker whose writer is gone means it
    // finished between the two calls: ask once more.
    if (first && first.pid !== steps.selfPid && steps.requestLock()) return { kind: 'start' };
    return { kind: 'hand-over' };
  }
  let marker: QuitMarker = first;
  // Quietly give the quitting instance a moment (idle, its teardown takes ~0.2 s): no notice, no relaunch.
  while (steps.now() - startedAt < graceMs) {
    steps.sleepSync(Math.min(pollMs, Math.max(1, graceMs - (steps.now() - startedAt))));
    const current = steps.readMarker();
    if (current && quittingInstance(current, steps, steps.isAlive)) { marker = current; continue; }
    // Gone: start if the lock is ours (or can be had now); otherwise someone else has started and was told.
    if (!locked) locked = steps.requestLock();
    return locked ? { kind: 'start' } : { kind: 'hand-over' };
  }
  // Still there. Even a lock we got goes back: the old process may still hold the profile's files until it is gone.
  if (locked) steps.releaseLock();
  return { kind: 'wait', marker, startedAt };
}

export interface StartupActions {
  /** The lock is ours: clear the last instance's marker (only now, after the lock). */
  clearMarker(): void;
  /** Today's behaviour for a running instance: exit (it was told and shows itself). */
  handOver(): void;
  /** Move this process off the profile and wait for the quitting instance (the wiring's waiter). */
  enterWaiting(marker: QuitMarker, startedAt: number): void;
}
/** main.ts's hasLock: true only when this process holds the lock and nobody else is on the profile. */
export function runStartupLock(steps: StartupLockSteps, actions: StartupActions): boolean {
  const plan = planStartup(steps);
  if (plan.kind === 'start') { actions.clearMarker(); return true; }
  if (plan.kind === 'hand-over') { actions.handOver(); return false; }
  actions.enterWaiting(plan.marker, plan.startedAt);
  return false;
}

export interface WaitSteps extends QuitWaitClock {
  /** When the launch began (planStartup's startedAt): the budget counts from there. */
  startedAt: number;
  readMarker(): QuitMarker | null;
  isAlive: AliveCheck;
  sleep(ms: number): Promise<void>;
}
/** After the app is ready (the notice is up): 'gone' as soon as the quitting instance is, 'timeout' after QUIT_WAIT.budgetMs. */
export async function waitForOldExit(steps: WaitSteps): Promise<'gone' | 'timeout'> {
  const budgetMs = steps.knobs?.budgetMs ?? QUIT_WAIT.budgetMs;
  const pollMs = Math.max(10, steps.knobs?.pollMs ?? QUIT_WAIT.pollMs);
  for (;;) {
    // A newer marker (another instance started and is quitting too) is waited for the same way; no marker, or a dead writer: gone.
    if (!quittingInstance(steps.readMarker(), steps, steps.isAlive)) return 'gone';
    const left = budgetMs - (steps.now() - steps.startedAt);
    if (left <= 0) return 'timeout';
    await steps.sleep(Math.min(pollMs, left));
  }
}

/**
 * Windows: is the process still there? `process.kill(pid, 0)` only reads the exit code, which is set as soon as the process starts
 * ending; its threads and Chromium's child processes can go on for tens of seconds (real check 2026-11-22 under load: exit code at
 * +80 s, children until +117 s, the process itself until +157 s). tasklist lists it until it has really ended, and names the program,
 * so a pid another program reused does not count. `listedImage` undefined: tasklist could not be asked (the exit code decides).
 */
export function windowsProcessPresent(input: { exitCodeSet: boolean; listedImage: string | null | undefined; image: string }): boolean {
  if (input.listedImage === undefined) return !input.exitCodeSet;
  return input.listedImage !== null && input.listedImage.toLowerCase() === input.image.toLowerCase();
}

/** The image name in `tasklist /FI "PID eq N" /FO CSV /NH` output, or null when no such process is listed. */
export function tasklistImage(stdout: string, pid: number): string | null {
  for (const line of String(stdout).split(/\r?\n/)) {
    const cells = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (cells && Number(cells[2]) === pid) return cells[1];
  }
  return null;
}
