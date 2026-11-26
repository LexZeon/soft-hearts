/**
 * Starting and ending the brain's Claude Code processes without holding the main thread (section "聊天起 Claude 进程挪出主线程").
 *
 * Node's `spawn` creates the process synchronously on the calling thread, and so does `execFile` (taskkill.exe). In the app that thread is
 * Electron's main process, the UI thread every mouse event and window passes through: step 6 measured 31-660 ms per Claude Code start
 * (442 ms in one chat) and the companion window stopping for as long (400 vs 408 ms, 500 vs 513 ms). Every Claude Code process the brain
 * starts (the persistent chat process, its spares, the one-shot calls) is therefore started from one worker thread (off-main.ts), and
 * ended there too (taskkill /T /F on Windows, then a plain kill if it still has not closed, exactly as before). The main thread only posts
 * messages; what the process prints comes back as messages, in order.
 *
 * The one seam for a stand-in Claude Code: `launchClaude` (the app's way in) asks the hook on `globalThis[CLAUDE_LAUNCH_HOOK]` first, if
 * there is one, passing it the off-main launch to call. Only the maintainers' test harnesses install one, from outside, after launch (the
 * packaging smoke, the source smokes, the pretrial and the soak: it turns the inert placeholder's chat launch into their stand-in; the
 * pretrial's real mode only counts calls); unit tests pass their own `ClaudeLaunch` where a class takes one (ClaudeProcessOptions.spawn).
 * Without a hook it is the off-main launch. A hook can only be set from inside the main process, which can already do anything; the
 * windows cannot reach it. The app has no switch that installs one.
 *
 * No file in electron/brain names Node's child-process module on the main thread (tests/claude-launch-off-main.test.ts checks it);
 * off-main.ts names it only inside the worker's own program.
 */
import { OffMainClaudeLauncher } from './off-main';

/** Where a harness puts its launch hook (a sealed global, so a Playwright `electron.evaluate` can install it before any chat). */
export const CLAUDE_LAUNCH_HOOK = '__softHeartsClaudeLaunch';

/** The options the brain starts Claude Code with (always three pipes; what the smoke's interposer checks). */
export interface ClaudeLaunchOptions {
  cwd: string;
  shell: false;
  windowsHide: true;
  stdio: ['pipe', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
}
export interface ClaudeChildInput {
  write(text: string): boolean;
  end(text?: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  readonly destroyed: boolean;
  readonly writable: boolean;
}
export interface ClaudeChildOutput {
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
}
/** The part of a started Claude Code the brain uses: a real ChildProcess has it too (tests and measuring scripts tap real ones). */
export interface ClaudeChild {
  readonly stdin: ClaudeChildInput;
  readonly stdout: ClaudeChildOutput;
  readonly stderr: ClaudeChildOutput;
  /** Known once it has started (an off-main child: a moment after the launch returned). */
  readonly pid?: number | undefined;
  once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
  /** Ends it with its whole tree, off the main thread (an off-main child). Without it, terminateClaude does the same from outside. */
  terminate?(): void;
}
export type ClaudeLaunch = (file: string, args: readonly string[], options: ClaudeLaunchOptions) => ClaudeChild;
/** A harness's hook: what to start instead (or around) the app's launch; `launch` is the off-main launch. */
export type ClaudeLaunchHook = (file: string, args: readonly string[], options: ClaudeLaunchOptions, launch: ClaudeLaunch) => ClaudeChild;

let shared: OffMainClaudeLauncher | null = null;
const launcher = () => (shared ??= new OffMainClaudeLauncher());

/** Starts it from the worker thread. */
export const launchClaudeOffMain: ClaudeLaunch = (file, args, options) => launcher().launch(file, args, options);

/** The app's way to start Claude Code: a harness's hook if one is installed, otherwise the off-main launch. */
export const launchClaude: ClaudeLaunch = (file, args, options) => {
  const hook = (globalThis as Record<string, unknown>)[CLAUDE_LAUNCH_HOOK];
  return typeof hook === 'function' ? (hook as ClaudeLaunchHook)(file, args, options, launchClaudeOffMain) : launchClaudeOffMain(file, args, options);
};

/** taskkill /PID <pid> /T /F from the worker thread (Windows); resolves when it has ended. For a process this module did not start. */
export function taskkillOffMain(pid: number): Promise<void> { return launcher().taskkill(pid); }

/**
 * Quit: resolves true once the worker has acted on every start and end asked of it so far (taskkill started), false after `limitMs`.
 * Nothing started yet: true at once.
 */
export function claudeLaunchesSettled(limitMs: number): Promise<boolean> { return shared ? shared.settled(limitMs) : Promise.resolve(true); }
