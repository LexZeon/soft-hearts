// 正常退出开关 (2026-11-03, docs/claude/2026-11-03-graceful-quit.md).
// `"soft hearts next.exe" --soft-hearts-quit` asks the instance already running on the SAME profile to quit the way the
// tray's 退出 does: app.quit(), so before-quit saves mood, 熟悉度, her own life, her needs and the 体验记录 first.
// The asking process never loads the companion runtime, opens no window and, when nothing is running, starts nothing.
// No Electron import: electron/desktop-entry.ts and electron/main.ts wire it; tests drive it with a fake lock.
import path from 'node:path';
import { profileDirectoryFor, startupProfileOverride } from './profile';

export const QUIT_SWITCH = 'soft-hearts-quit';
/** Sent as the single-instance additionalData; Chromium may reorder or extend argv, this arrives as sent. */
export const QUIT_REQUEST: Readonly<{ softHeartsQuit: 1 }> = Object.freeze({ softHeartsQuit: 1 });
/** The asking process's exit code (scripts/experience/quit-app.mjs reads it). */
export const QUIT_EXIT = Object.freeze({ forwarded: 0, notRunning: 3, unavailable: 4 });
export type QuitOutcome = 'forwarded' | 'not-running' | 'unavailable';

export function hasQuitSwitch(argv: readonly string[]): boolean {
  return argv.some(value => typeof value === 'string' && value.toLowerCase() === `--${QUIT_SWITCH}`);
}

export function isQuitRequest(argv: readonly string[], additionalData?: unknown): boolean {
  const data = typeof additionalData === 'object' && additionalData !== null ? additionalData as { softHeartsQuit?: unknown } : null;
  return data?.softHeartsQuit === 1 || hasQuitSwitch(argv);
}

/**
 * What the running instance does with a second launch on its profile: quit (the same app.quit() as the tray's 退出) for
 * the quit switch or the older owner-bound stop switch (scripts/start-latest); otherwise show the controls as before.
 */
export function secondInstanceAction(input: { argv: readonly string[]; additionalData?: unknown; desktopOwner: string }): 'quit' | 'show' {
  if (isQuitRequest(input.argv, input.additionalData)) return 'quit';
  if (/^[a-f0-9]{24}$/i.test(input.desktopOwner) && input.argv.includes(`--soft-hearts-stop=${input.desktopOwner}`)) return 'quit';
  return 'show';
}

/**
 * main.ts's second-instance listener. `quit` is app.quit(), exactly what the tray's 退出 calls. It runs on the next turn:
 * Electron answers the asking process only after this listener returns, and if the app is already shutting down by
 * then it answers "not delivered", so the asking process would take the lock itself and report that nothing was
 * running (seen with a headless Electron 45 instance that quit inside the listener, 2026-11-03).
 */
export function onSecondInstance(input: { argv: readonly string[]; additionalData?: unknown; desktopOwner: string;
  quit: () => void; show: () => void; later?: (run: () => void) => void }): 'quit' | 'show' {
  const action = secondInstanceAction(input);
  if (action === 'quit') (input.later ?? (run => { setImmediate(run); }))(input.quit);
  else input.show();
  return action;
}

/**
 * The profile the asking process must lock: the one a normal startup of the same program with the same switches uses
 * (main.ts: installed channel profile, else --user-data-dir, else MMD_DESK_USER_DATA for source runs, else the
 * development folder). The single-instance lock is per profile, so the development switch can never reach the stable
 * instance and the stable switch never reaches a development one.
 */
export function quitTargetProfile(input: {
  appData: string;
  channel: { channel: string; profile: string } | null;
  userDataSwitch: string;
  packaged: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}): string {
  const override = startupProfileOverride(input.channel?.profile ?? input.userDataSwitch, input.packaged, input.environment);
  if (override && !path.isAbsolute(override)) throw new Error('The profile folder must be an absolute path.');
  return profileDirectoryFor(input.appData, override, input.channel?.channel === 'stable');
}

export interface QuitProcess {
  /** Throws when the program is not a verified installation or the switches name a profile it may not use. */
  profile: () => string;
  profileExists: (directory: string) => boolean;
  setProfile: (directory: string) => void;
  /** app.requestSingleInstanceLock(request): false when another instance holds this profile and was told. */
  requestLock: (request: typeof QUIT_REQUEST) => boolean;
  releaseLock: () => void;
}

/** The whole life of a `--soft-hearts-quit` process. It never starts the app, whatever happens. */
export function runQuitProcess(steps: QuitProcess): { outcome: QuitOutcome; exitCode: number; profile?: string; reason?: string } {
  let profile: string;
  try { profile = steps.profile(); }
  catch (error) { return { outcome: 'unavailable', exitCode: QUIT_EXIT.unavailable, reason: error instanceof Error ? error.message : String(error) }; }
  // A folder that does not exist has no instance, and taking the lock would leave a new folder behind, so nothing is
  // taken. (An explicit --user-data-dir folder is created by Chromium itself at startup; installed channels pass none.)
  if (!steps.profileExists(profile)) return { outcome: 'not-running', exitCode: QUIT_EXIT.notRunning, profile };
  steps.setProfile(profile);
  if (!steps.requestLock(QUIT_REQUEST)) return { outcome: 'forwarded', exitCode: QUIT_EXIT.forwarded, profile };
  steps.releaseLock(); // Nothing was running: give the lock back at once.
  return { outcome: 'not-running', exitCode: QUIT_EXIT.notRunning, profile };
}
