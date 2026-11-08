// Bounded shutdown for the Electron app a smoke launched itself. A failing or hung smoke
// must still close its own window: `instance.close()` can wait forever when the app's main
// process is blocked (e.g. behind Electron's uncaught-exception dialog), and an outer
// `timeout` that kills node leaves the Playwright-launched Electron running on the desktop.
// Only the process this smoke started (instance.process()) and its own children are ended.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ownChild = instance => { try { return instance?.process?.() ?? null; } catch { return null; } }; // throws once the connection is gone

/** Ends the smoke's own Electron process tree (an ElectronApplication or its ChildProcess). Never throws. */
export function killOwnElectron(target) {
  const child = typeof target?.process === 'function' ? ownChild(target) : target;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
    return true;
  } catch { return false; }
}

/** `instance.close()` bounded by `milliseconds`; on timeout or error the own process tree is ended. */
export async function closeElectron(instance, milliseconds = 10_000) {
  if (!instance) return { closed: true, killed: false };
  const child = ownChild(instance);
  let timer;
  try {
    await Promise.race([instance.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Electron close timed out after ${milliseconds} ms`)), milliseconds); })]);
    return { closed: true, killed: false };
  } catch (error) {
    return { closed: false, killed: killOwnElectron(child), error: String(error?.message ?? error) };
  } finally { clearTimeout(timer); }
}

/**
 * Whole-run deadline inside the smoke itself: on expiry the smoke's own Electron is ended and the
 * runner exits non-zero. `current()` returns the instance launched so far (or null). Returns a disarm function.
 */
export function armSmokeWatchdog(current, milliseconds, label = 'smoke') {
  const timer = setTimeout(() => {
    console.error(`${label}: watchdog expired after ${milliseconds} ms; ending its own Electron.`);
    killOwnElectron(current());
    process.exit(1);
  }, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}
