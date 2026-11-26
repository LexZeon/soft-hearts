// How a pretrial restart judges the app's quit (K7 "退出再打开", and every scenario that calls app.restart()).
// Why two budgets (2026-11-22, docs/claude/2026-11-22-k7-quit-hang.md): a quit has two parts. First the app's own part:
// before-quit / will-quit and every quit and flush step (electron/wiring/quit-wiring.ts), until the main process leaves its
// message loop and Node tears down. Under Playwright, Node then prints "Waiting for the debugger to disconnect..." on stderr
// (its inspector session is attached), so that line marks "the app's own quit finished". Then Electron/Chromium's own
// process teardown runs (its thread pool finishes the work that blocks shutdown). On an idle computer that takes ~0.2 s;
// while other heavy jobs fill the processors (full test suites, builds - even at below-normal priority) it took 10 s to more
// than 90 s, for a one-window Electron app with no code of ours as well. One 20 s budget for both made K7 fail on candidates
// whose quit was fine. The app's own part keeps its 20 s (a quit step that never lets go still fails here); the teardown
// gets its own, longer budget and its time is reported.
// Importing this module starts nothing.

/** The app's own quit (every before-quit / will-quit step and the flush) must finish within this. */
export const APP_QUIT_BUDGET_MS = 20_000;
/** After that, Electron's process teardown: slow only while the computer is busy; past this the run fails. */
export const TEARDOWN_BUDGET_MS = 180_000;
/** Teardown slower than this gets a note in the report (the computer was busy). */
export const SLOW_TEARDOWN_MS = 5_000;
/** Printed by Node when the main process's JavaScript has finished and its environment is torn down, with a debugger attached. */
export const APP_QUIT_DONE_LINE = 'Waiting for the debugger to disconnect...';

const defaultSleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/**
 * Quits through `quit()` and waits for `child` (the launched process) to end. Resolves
 * `{ code, signal, appQuitMs, teardownMs, sawQuitDone }`; throws when the app's own quit does not finish within `appBudgetMs`
 * or the process is still there `teardownBudgetMs` after it did. `sleep` and `now` are test seams.
 */
export async function awaitQuit({ child, quit, appBudgetMs = APP_QUIT_BUDGET_MS, teardownBudgetMs = TEARDOWN_BUDGET_MS, sleep = defaultSleep, now = Date.now }) {
  const start = now();
  let doneAt = null, tail = '';
  let markDone = () => {};
  const done = new Promise(resolve => { markDone = resolve; });
  const onData = chunk => {
    if (doneAt !== null) return;
    tail = (tail + String(chunk)).slice(-(APP_QUIT_DONE_LINE.length + 200)); // the line can arrive split across chunks
    if (tail.includes(APP_QUIT_DONE_LINE)) { doneAt = now(); markDone(); }
  };
  const stderr = child.stderr ?? null;
  stderr?.on('data', onData);
  let exitAt = null;
  const exited = new Promise(resolve => {
    if (child.exitCode !== null && child.exitCode !== undefined) { exitAt = now(); resolve({ code: child.exitCode, signal: child.signalCode ?? null }); return; }
    child.once('exit', (code, signal) => { exitAt = now(); resolve({ code, signal }); });
  });
  try {
    await Promise.resolve().then(quit).catch(() => {}); // the page goes away while answering
    const first = await Promise.race([exited, done.then(() => 'done'), sleep(Math.max(0, appBudgetMs - (now() - start))).then(() => null)]);
    if (first === null) throw new Error(`The app's own quit did not finish within ${Math.round(appBudgetMs / 1000)} s of quitting (its before-quit / will-quit steps are still running).`);
    const ended = first === 'done' ? await Promise.race([exited, sleep(teardownBudgetMs).then(() => null)]) : first;
    if (!ended) throw new Error(`The app finished its own quit in ${doneAt - start} ms, but Electron's process teardown had not ended ${Math.round(teardownBudgetMs / 1000)} s later.`);
    const ownEnd = doneAt ?? exitAt;
    return { code: ended.code, signal: ended.signal, appQuitMs: ownEnd - start, teardownMs: exitAt - ownEnd, sawQuitDone: doneAt !== null };
  } finally {
    stderr?.off?.('data', onData);
  }
}

/** One line for a report: how long the app's own quit and Electron's teardown took. */
export function describeQuit(ended) {
  const own = `应用自己的退出 ${ended.appQuitMs} ms`;
  if (!ended.sawQuitDone) return own;
  return `${own}，Electron 收尾 ${ended.teardownMs} ms${ended.teardownMs > SLOW_TEARDOWN_MS ? '（电脑忙时收尾慢，见 docs/claude/2026-11-22-k7-quit-hang.md）' : ''}`;
}
