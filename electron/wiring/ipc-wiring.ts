// The IPC guard (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md).
// host / scopedHost moved here from electron/main.ts unchanged: every desk: handler checks that the sender is one of our two windows,
// its main frame, and (controlOnly, the default) the control window. partIpc(part) hands a part the same two registrars; in strict mode
// (the only mode until step 7) it is exactly host / scopedHost.
// Only this file (and the window modules that own their own channels) imports ipcMain: tests/wiring-skeleton.test.ts checks it.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { ipcMain, type BrowserWindow } from 'electron';
import { PartOffError, partRunner } from './parts-wiring';

/** What the guard reads at each call: the app's windows and the control window. */
export interface IpcGuardPorts {
  windows(): BrowserWindow[];
  controls(): BrowserWindow | null;
}
/** The two registrars a part is handed: same signatures as host / scopedHost. */
export interface PartIpc {
  host(method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean): void;
  scopedHost(method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean): void;
}

let guardPorts: IpcGuardPorts | null = null;
/** Every desk: method a part registered so far (partIpc; overhaul step 7: a unit that did not start may have left its handlers out). */
let registered: Set<string> | null = null;

/** electron/main.ts calls this once, before the first handler is registered. */
export function wireIpc(ports: IpcGuardPorts): void { guardPorts = ports; }

function guardWindows(): BrowserWindow[] {
  if (!guardPorts) throw new Error('IPC guard is not wired.');
  return guardPorts.windows();
}
function guardControls(): BrowserWindow | null {
  if (!guardPorts) throw new Error('IPC guard is not wired.');
  return guardPorts.controls();
}

/** The registrar the agent channel's recorder wraps (electron/safety/agent-channel/bridge.ts recordAgentOperations). */
export function hostIpc(): typeof ipcMain { return ipcMain; }

export function host(
  method: string,
  operation: (...args: any[]) => unknown,
  controlOnly = true,
): void {
  scopedHost(method, (_sender, ...args) => operation(...args), controlOnly);
}
export function scopedHost(
  method: string,
  operation: (sender: number, ...args: any[]) => unknown,
  controlOnly = true,
): void {
  ipcMain.handle(`desk:${method}`, (event, ...args: unknown[]) => {
    const allowed = guardWindows().find(
      (win) => win.webContents.id === event.sender.id,
    );
    if (
      !allowed ||
      event.senderFrame !== event.sender.mainFrame ||
      (controlOnly && allowed !== guardControls())
    )
      throw new Error("请求来源未授权。");
    return operation(event.sender.id, ...args);
  });
}

/**
 * Overhaul step 7: a unit that did not start may never have registered its handlers; each of those answers PART_OFF instead of
 * "no handler" (registered after every part registered: electron/wiring/shell-wiring.ts registerQuit). Control window only, as the default.
 */
export function answerPartOff(part: string, methods: readonly string[]): void {
  for (const method of methods) answerOnePartOff(method, part);
}
/** One method a switched-off unit never registered: registered now through the part's registrar, which answers PART_OFF. */
function answerOnePartOff(method: string, part: string): void {
  if (!registered?.has(method)) partIpc(part).host(method, () => undefined);
}

// ---- IPC shells (overhaul step 8, docs/claude/2026-11-17-lazy-loading-step8.md) ------------------------------------------------------
// The windows start loading before the parts that do not draw have started (electron/main.ts's ready chain). A window's call then may come
// before its part registered its handler. openIpcShells puts one shell on ipcMain for every method of IPC_SHELL_METHODS before the windows
// load: a call that comes early waits in the shell. The parts register exactly as before (registerIPC, the agent channel's recorder around
// it, startUnbound): the registration reaches ipcMain.handle through the recorder, which records the real handler as before, and for a
// shelled method fills the shell instead of adding a second handler; the calls that waited then run through the real handler (its guard
// reads the sender then), in arrival order. closeIpcShells, after the last registration (registerQuit), puts ipcMain.handle back and
// removes the shells nothing filled: their waiting calls, and later ones, fail as Electron's own "no handler" would.

type IpcHandler = (event: any, ...args: any[]) => unknown;
interface IpcShell { handler: IpcHandler | null; waiting: { event: unknown; args: unknown[]; resolve(value: unknown): void; reject(error: unknown): void }[] }
let shells: Map<string, IpcShell> | null = null;
let restoreHandle: (() => void) | null = null;
/** The shells closeIpcShells found unfilled (methods), for the tests and the record. */
let unfilled: string[] = [];

/** electron/main.ts, once, before the windows load: a shell for each method (desk:<method>). */
export function openIpcShells(methods: readonly string[]): void {
  if (shells) throw new Error('IPC shells are already open.');
  const open = new Map<string, IpcShell>();
  const target = ipcMain as unknown as { handle: (channel: string, handler: IpcHandler) => void };
  const own = Object.getOwnPropertyDescriptor(target, 'handle');
  const real = target.handle;
  for (const method of methods) {
    const shell: IpcShell = { handler: null, waiting: [] };
    open.set(`desk:${method}`, shell);
    real.call(target, `desk:${method}`, (event: unknown, ...args: unknown[]) =>
      shell.handler ? shell.handler(event, ...args) : new Promise((resolve, reject) => { shell.waiting.push({ event, args, resolve, reject }); }));
  }
  // What the recorder (and every registration) calls from now on: a shelled channel fills its shell, any other goes to ipcMain as before.
  Object.defineProperty(target, 'handle', { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: function (this: unknown, channel: string, handler: IpcHandler) {
    const shell = open.get(channel);
    if (!shell) return real.call(target, channel, handler);
    if (shell.handler) throw new Error(`Attempted to register a second handler for '${channel}'`);
    shell.handler = handler;
    const waiting = shell.waiting.splice(0);
    for (const call of waiting) { try { Promise.resolve(handler(call.event, ...call.args)).then(call.resolve, call.reject); } catch (error) { call.reject(error); } }
  } });
  restoreHandle = () => { if (own) Object.defineProperty(target, 'handle', own); else delete (target as { handle?: unknown }).handle; };
  shells = open;
}
/** After the last registration (registerQuit): ipcMain.handle as it was; a shell nothing filled is removed and its calls fail as "no handler". */
export function closeIpcShells(): void {
  const open = shells;
  if (!open) return;
  shells = null;
  restoreHandle?.();
  restoreHandle = null;
  unfilled = [];
  for (const [channel, shell] of open) {
    if (shell.handler) continue;
    unfilled.push(channel.slice(5));
    ipcMain.removeHandler(channel);
    for (const call of shell.waiting.splice(0)) call.reject(new Error(`No handler registered for '${channel}'`));
  }
}
/** Whether the shells are open (tests; the ready chain closes them once). */
export function ipcShellsOpen(): boolean { return shells !== null; }
/** The methods whose shell nothing filled by closeIpcShells (none, when the shell list is the app's handlers and every unit started). */
export function ipcShellsUnfilled(): readonly string[] { return unfilled; }

// ---- answered (step 8: the late-loaded control window's "its page is ready", electron/wiring/late-controls-wiring.ts) --------------------
let answeredListeners: Map<string, Set<(sender: number) => void>> | null = null;
/** Tells the listener the sender each time a part's handler for the method has answered (after its promise settles); returns the unsubscribe. */
export function onAnswered(method: string, listener: (sender: number) => void): () => void {
  const all = answeredListeners ??= new Map();
  const listeners = all.get(method) ?? new Set();
  all.set(method, listeners.add(listener));
  return () => { listeners.delete(listener); };
}
/** The answer, unchanged; with a listener for the method, the listeners hear the sender once it settled (a failure too). */
function answered<T>(method: string, sender: number, result: T): T {
  const listeners = answeredListeners?.get(method);
  if (!listeners?.size) return result;
  const tell = () => { for (const listener of [...listeners]) { try { listener(sender); } catch { /* a listener never changes the answer */ } } };
  Promise.resolve(result).then(tell, tell);
  return result;
}

/**
 * A part's registrars (plan section 3): host / scopedHost with the same guard, flags and errors. Step 7 (docs/claude/2026-11-17-isolation-step7.md):
 * after the guard, a handler of a unit the part runner switched off (the part's PartHandle `ipc` says which unit a method belongs to)
 * throws PartOffError (PART_OFF) instead of running; the agent channel reuses this same handler, so its operation fails the same way.
 * Strict mode never switches anything off, so nothing changes there.
 */
export function partIpc(part: string): PartIpc {
  const refuseWhenOff = (method: string) => {
    const runner = partRunner();
    const unit = runner?.unitOf(part, method);
    if (runner && unit && runner.isOff(part, unit)) throw new PartOffError(part, unit);
  };
  return {
    // Step 8: host is registered as scopedHost dropping the sender (what host is), so a method's answer can be told with its sender (onAnswered).
    host: (method, operation, controlOnly = true) => { (registered ??= new Set()).add(method); scopedHost(method, (sender: number, ...args: any[]) => { refuseWhenOff(method); return answered(method, sender, operation(...args)); }, controlOnly); },
    scopedHost: (method, operation, controlOnly = true) => { (registered ??= new Set()).add(method); scopedHost(method, (sender: number, ...args: any[]) => { refuseWhenOff(method); return answered(method, sender, operation(sender, ...args)); }, controlOnly); },
  };
}
