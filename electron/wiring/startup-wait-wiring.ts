// I-182: reopening while the last instance is still quitting.
// The decision is electron/foundation/quit-wait/plan.ts (pure, tested with fakes); here are Electron, the files and the processes:
// - takeStartupLock: electron/main.ts's single-instance lock. Start, hand over to the running instance (today's behaviour), or wait.
// - waiting: this process moves its own Chromium data to a throw-away folder BEFORE the app is ready (it never touches the profile),
//   shows a small notice once ready, and when the quitting instance is gone starts a fresh launch with the same command line and exits.
//   After QUIT_WAIT.budgetMs it says so and exits without starting anything.
// - noteQuitStarted: the quit marker, written by the lock holder when its quit begins (its first before-quit; registered only by the
//   process that took the lock, before electron/main.ts registers wireQuit).
// - wireSecondInstance: the running instance's second-instance listener (正常退出开关, electron/graceful-quit.ts); while quitting it
//   neither reopens its windows nor quits again.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, BrowserWindow, nativeTheme, screen } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { currentUiLanguage } from '../../shared/foundation/ui-language';
import { QUIT_WAIT, QUIT_WAIT_COPY } from '../foundation/quit-wait/knobs';
import { clearQuitMarker, quitMarkerToWrite, readQuitMarker, runStartupLock, tasklistImage, waitForOldExit, windowsProcessPresent, writeQuitMarker,
  type QuitMarker } from '../foundation/quit-wait/plan';
import { onSecondInstance } from '../graceful-quit';
import { exiting } from './quit-wiring';

/** This process holds the profile lock (set once by takeStartupLock): only then may it write the quit marker. */
let holdsProfileLock = false;
const markerFiles = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync } as Parameters<typeof readQuitMarker>[0];
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

let imageChecks: Map<number, { at: number; same: boolean }> | undefined; // made on first use (no module-level side effects)
/**
 * Still there, as the same program. Elsewhere the pid decides. On Windows the exit code is set long before the process has ended
 * (windowsProcessPresent), so tasklist decides: every poll once the exit code is set, at most every 5 s while it still runs.
 */
function aliveAs(pid: number, image: string): boolean {
  let exitCodeSet = false;
  try { process.kill(pid, 0); } catch (error) { exitCodeSet = (error as NodeJS.ErrnoException).code !== 'EPERM'; }
  if (process.platform !== 'win32') return !exitCodeSet;
  imageChecks ??= new Map();
  const cached = imageChecks.get(pid);
  if (!exitCodeSet && cached && Date.now() - cached.at < 5_000) return cached.same;
  let listedImage: string | null | undefined; // undefined: tasklist unavailable or too slow; the exit code decides, the budget ends the wait
  try {
    const listed = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    if (listed.status === 0 && typeof listed.stdout === 'string') listedImage = tasklistImage(listed.stdout, pid);
  } catch { /* undefined */ }
  const same = windowsProcessPresent({ exitCodeSet, listedImage, image });
  imageChecks.set(pid, { at: Date.now(), same });
  return same;
}

/** electron/main.ts: `const hasLock = takeStartupLock(() => app.requestSingleInstanceLock());`, right after the profile is set. */
export function takeStartupLock(requestLock: () => boolean): boolean {
  const profile = app.getPath('userData');
  holdsProfileLock = runStartupLock({ requestLock, releaseLock: () => app.releaseSingleInstanceLock(), readMarker: () => readQuitMarker(markerFiles, profile),
    isAlive: aliveAs, now: Date.now, sleepSync, selfPid: process.pid }, {
    clearMarker: () => clearQuitMarker(markerFiles, profile),
    handOver: () => app.quit(),
    enterWaiting: (marker, startedAt) => waitThenRelaunch(profile, marker, startedAt),
  });
  if (holdsProfileLock) app.once('before-quit', noteQuitStarted);
  return holdsProfileLock;
}

/** The lock holder's first before-quit: "this instance is quitting", in its own profile folder. Synchronous, best effort. */
export function noteQuitStarted(): void {
  writeQuitMarker(markerFiles, app.getPath('userData'), quitMarkerToWrite({ holdsLock: holdsProfileLock, pid: process.pid, now: Date.now(),
    executable: process.execPath, lang: currentUiLanguage() }));
}

/** electron/main.ts, where its second-instance listener was: 正常退出开关, or show the controls; nothing while quitting. */
export function wireSecondInstance(needs: { quit(): void; show(): void }): void {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    onSecondInstance({ argv, additionalData, desktopOwner: app.commandLine.getSwitchValue('soft-hearts-desktop'), quitting: exiting,
      quit: needs.quit, show: needs.show });
  });
}

/** The throw-away folder for a waiting launch's own Chromium data; older ones whose process is gone are removed. */
function waitingFolder(): string {
  const root = path.join(app.getPath('temp'), 'soft-hearts-wait');
  try {
    for (const name of fs.readdirSync(root)) {
      const pid = Number(name);
      if (!/^\d{1,10}$/.test(name) || pid === process.pid) continue;
      try { process.kill(pid, 0); continue; } catch { /* gone */ }
      const folder = path.join(root, name);
      try { if (fs.lstatSync(folder).isDirectory()) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* still ending: next time */ }
    }
  } catch { /* first use, or a folder still in use */ }
  return path.join(root, String(process.pid));
}

function waitThenRelaunch(profile: string, marker: QuitMarker, startedAt: number): void {
  // Before the app is ready: from here this process's Chromium never opens the profile folder.
  const own = waitingFolder();
  app.setPath('userData', own);
  app.setPath('sessionData', own);
  const relaunch = { executable: process.execPath, args: process.argv.slice(1), cwd: process.cwd() };
  const copy = QUIT_WAIT_COPY[marker.lang] ?? QUIT_WAIT_COPY['zh-CN'];
  void (async () => {
    await app.whenReady();
    const notice = showNotice(copy.waiting);
    const outcome = await waitForOldExit({ startedAt, readMarker: () => readQuitMarker(markerFiles, profile), isAlive: aliveAs, now: Date.now, sleep,
      selfPid: process.pid });
    if (outcome === 'gone') {
      // A fresh launch takes the lock and the profile the normal way (and hands over if someone else got there first).
      spawn(relaunch.executable, relaunch.args, { cwd: relaunch.cwd, detached: true, stdio: 'ignore' }).unref();
      app.exit(0);
      return;
    }
    notice.say(copy.gaveUp);
    await sleep(QUIT_WAIT.giveUpNoticeMs);
    app.exit(0);
  })().catch((error: unknown) => {
    console.error('The waiting launch failed: ' + (error instanceof Error ? error.message : 'unknown error').slice(0, 300));
    app.exit(1);
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const noticePage = (text: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>soft hearts</title><style>`
  + ':root{color-scheme:light dark;--bg:#fff7f3;--fg:#5b4a48}@media (prefers-color-scheme:dark){:root{--bg:#2b2523;--fg:#f3e6e2}}'
  + 'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px "Microsoft YaHei UI","Segoe UI",sans-serif;'
  + 'display:flex;align-items:center;justify-content:center;user-select:none;cursor:default}</style></head><body>'
  + escapeHtml(text) + '</body></html>';

/** A small window in the corner: no frame, never takes focus, no scripts, nothing to click. */
function showNotice(text: string): { say(text: string): void } {
  const width = 300, height = 56;
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({ width, height, x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, closable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2523' : '#fff7f3', title: 'soft hearts',
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => { event.preventDefault(); });
  const load = (line: string) => { void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(noticePage(line))).catch(() => undefined); };
  load(text);
  win.showInactive(); // at once, in the page's own colour: on a busy computer the first paint can take seconds
  return { say: load };
}
