// How the packaged smoke (scripts/smoke.mjs) judges the owned app's quit (2026-11-24, docs/claude/2026-11-24-quit-hang.md).
// A quit has two parts, as the pretrial's K7 found (scripts/lib/quit-watch.mjs, docs/claude/2026-11-22-k7-quit-hang.md):
// 1. The app's own part: app.quit() -> before-quit / will-quit, every quit and flush step (electron/wiring/quit-wiring.ts), the windows
//    close, Node's 'exit'. The smoke's old 8 s cap on "Playwright's close() resolved" was meant for this part and keeps it: a quit step
//    that never lets go, a window whose close is prevented or a flush that hangs still fails here.
// 2. Electron/Chromium's own process teardown after that. Idle it takes ~0.2 s. While other jobs fill the processors it took 8 s to
//    more than 12 s for every build tried (the candidates of 5f76c0d7-era and dc372b2d alike; threads in the main and renderer
//    processes sit "Ready" with no processor time, raising the processes' priority class does not help). It is reported, and gets its
//    own budget (the same 180 s as K7's), and the owned profile is removed only once every process of the app has ended.
// The owned app's process ids come from the smoke; whether one is still running is injected. Importing this module starts nothing.
import { TEARDOWN_BUDGET_MS as K7_TEARDOWN_BUDGET_MS } from './quit-watch.mjs';

/** The app's own quit must finish within this (the smoke's SDK-close cap before 2026-11-24, unchanged). */
export const APP_QUIT_CAP_MS = 8_000;
/** Electron's process teardown after the app's own quit: slow only while the computer is busy; past this the smoke fails. */
export const TEARDOWN_BUDGET_MS = K7_TEARDOWN_BUDGET_MS;
/** Teardown slower than this gets a line in the smoke's output (the computer was busy). */
export const SLOW_TEARDOWN_MS = 5_000;
/**
 * Hashing the frozen source and the package again at the end (smoke-isolation finishIdentity): ~3.3 s idle, 43 s with every core
 * busy (2026-11-24). Only a hang fails it; the time is reported.
 */
export const IDENTITY_CAP_MS = 120_000;
/** The whole cleanup's watchdog: the old 30 s for every other step, plus the teardown and the identity budgets. */
export const CLEANUP_BUDGET_MS = 30_000 + TEARDOWN_BUDGET_MS + IDENTITY_CAP_MS;
/** How often the smoke looks again while it waits. */
export const QUIT_POLL_MS = 100;

const defaultSleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** A failed quit says which part failed: 'app-quit' (ours) or 'teardown' (Electron's). */
export class QuitError extends Error {
  constructor(part, message) { super(message); this.part = part; }
}

/**
 * Asks the app to quit (`quit()`, which must return once asked, not once done) and waits for both parts. `ownQuitDone()` answers
 * whether the app's own quit has finished (the smoke: the marker file its main process writes on Node's 'exit'); `gone()` whether
 * the teardown is over (the smoke: every process of the app has ended and Playwright's own close has collected it).
 * `onOwnQuit()` runs once, when the app's own quit is seen done. Resolves `{ appQuitMs, teardownMs }`; throws a QuitError.
 * `sleep`, `now` and `pollMs` are test seams.
 */
export async function quitOwnedApp({ quit, ownQuitDone, gone, onOwnQuit = () => {}, appCapMs = APP_QUIT_CAP_MS, teardownBudgetMs = TEARDOWN_BUDGET_MS, sleep = defaultSleep, now = Date.now, pollMs = QUIT_POLL_MS }) {
  const start = now();
  await quit();
  let ownAt = null;
  for (;;) {
    if (await ownQuitDone()) { ownAt = now(); onOwnQuit(); break; }
    if (now() - start >= appCapMs) throw new QuitError('app-quit', `The app's own quit did not finish within ${Math.round(appCapMs / 1000)} s of app.quit() (a before-quit / will-quit step, a window close or a flush is still holding it).`);
    await sleep(pollMs);
  }
  for (;;) {
    if (await gone()) return { appQuitMs: ownAt - start, teardownMs: now() - ownAt };
    if (now() - ownAt >= teardownBudgetMs) throw new QuitError('teardown', `The app finished its own quit in ${ownAt - start} ms, but its processes were still listed ${Math.round(teardownBudgetMs / 1000)} s later (Electron's process teardown).`);
    await sleep(pollMs);
  }
}

/** Still running: on Windows `process.kill(pid, 0)` reads the exit code (endedTracker says why that is what the profile needs). */
export const processRunning = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; } };

/**
 * Runs inside the app's main process (Playwright's `instance.evaluate(askQuitWithMarker, file)`; self-contained, it is sent as text):
 * `file` is written on Node's 'exit' (the app's own quit is done), then app.quit() on the next turn, so the answer comes back first.
 */
export function askQuitWithMarker({ app }, file) {
  const fs = process.getBuiltinModule('node:fs');
  process.once('exit', () => { try { fs.writeFileSync(file, String(Date.now())); } catch { /* the smoke then waits for the process instead */ } });
  setImmediate(() => app.quit());
  return true;
}

/**
 * Playwright's own close() (it waits for the process and its pipes), started once: the smoke starts it when the app's own quit is
 * done, so it collects inside the teardown's budget. `done()` resolves true or throws its error.
 */
export function playwrightCollector(instance) {
  let closing = null, collected = false, failure = null;
  const start = () => (closing ??= Promise.resolve().then(() => instance.close()).then(() => { collected = true; }, error => { failure = error; collected = true; }));
  return { start, get collected() { return collected; }, async done() { await start(); if (failure) throw failure; return true; } };
}

/**
 * A `gone()` for quitOwnedApp: true once every pid in `pids` has ended. `running(pid)` answers whether that process is still running
 * (the smoke: `process.kill(pid, 0)`, which on Windows reads the exit code: a process whose exit code is set has no thread and no
 * open file left, so the owned profile can go, even while `tasklist` still lists it because someone holds a handle to it). A pid seen
 * ended once stays ended: the system may give the number to a new process while the others are still finishing.
 */
export function endedTracker(pids, running) {
  const ended = new Set();
  return () => {
    for (const pid of pids) if (!ended.has(pid) && !running(pid)) ended.add(pid);
    return pids.every(pid => ended.has(pid));
  };
}
