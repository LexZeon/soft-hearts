// An Electron stand-in for booting electron/main.ts under node (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md).
// tests/helpers/app-stand-in/boot.ts maps the 'electron' module here; nothing real is created: no window, no tray, no process. What a
// test reads: the desk: handlers (ipcMain), what each window was sent, the error dialogs, whether the app quit, and a ready promise.
// Anything not written out below is an inert stand-in (a function that returns another stand-in), so a call the app makes that this
// file does not know never throws; what matters for the tests is written out.
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const STAND_IN = Symbol('stand-in');
/** An inert value: callable, constructible, every property another stand-in; never a thenable, '' as text, 0 as a number. */
function inert(label = 'stand-in'): any {
  const target = function () { /* inert */ };
  return new Proxy(target, {
    get(_t, key) {
      if (key === STAND_IN) return true;
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 0 : '');
      if (key === Symbol.iterator) return function* () { /* empty */ };
      if (key === 'toString' || key === 'valueOf') return () => '';
      if (key === 'on' || key === 'once' || key === 'off' || key === 'removeListener' || key === 'addListener' || key === 'removeAllListeners') return () => inert(label);
      return inert(`${label}.${String(key)}`);
    },
    apply() { return inert(label); },
    construct() { return inert(label) as object; },
  });
}
/** An object whose missing members are inert stand-ins. */
function standIn<T extends object>(known: T, label: string): T & Record<string, any> {
  return new Proxy(known, { get(t, key, r) { return key in t ? Reflect.get(t, key, r) : key === 'then' ? undefined : inert(`${label}.${String(key)}`); } }) as T & Record<string, any>;
}

export interface StandInState {
  readonly root: string;
  readonly handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  readonly sent: { window: 'controls' | 'pet' | 'other'; channel: string; args: unknown[] }[];
  readonly dialogs: { title: string; text: string }[];
  quit: boolean;
  ready: Promise<void>;
  readyResolve: () => void;
  readonly windows: FakeWindow[];
  /** Overhaul step 8: which windows started loading their page, in order. */
  readonly loaded: ('controls' | 'pet' | 'other')[];
  powerMonitor: EventEmitter & Record<string, any>;
}
const root = process.env.SOFT_HEARTS_STAND_IN_ROOT || path.join(os.tmpdir(), 'soft-hearts-stand-in');
let readyResolve!: () => void;
const ready = new Promise<void>(resolve => { readyResolve = resolve; });
export const standInState: StandInState = { root, handlers: new Map(), sent: [], dialogs: [], quit: false, ready, readyResolve, windows: [], loaded: [],
  powerMonitor: null as never };
(globalThis as Record<string, unknown>).__softHeartsStandIn = standInState;

let nextContentsId = 1;
class FakeContents extends EventEmitter {
  readonly id = nextContentsId++;
  readonly mainFrame = { url: '' };
  private destroyed = false;
  constructor(private readonly owner: FakeWindow) { super(); this.setMaxListeners(0); }
  send(channel: string, ...args: unknown[]): void { standInState.sent.push({ window: this.owner.role, channel, args }); }
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return 'file:///index.html'; }
  async loadURL(): Promise<void> { /* nothing loads */ }
  async loadFile(): Promise<void> { /* nothing loads */ }
  setWindowOpenHandler(): void { /* none */ }
  getOSProcessId(): number { return 0; }
  isLoading(): boolean { return false; }
  executeJavaScript(): Promise<unknown> { return Promise.resolve(undefined); }
  get session(): unknown { return session.defaultSession; }
}
export class FakeWindow extends EventEmitter {
  readonly webContents: FakeContents;
  readonly role: 'controls' | 'pet' | 'other';
  private bounds: { x: number; y: number; width: number; height: number };
  private visible = false; private destroyed = false; private minimized = false; private top = false;
  constructor(options: { width?: number; height?: number; x?: number; y?: number; transparent?: boolean } = {}) {
    super();
    this.setMaxListeners(0);
    this.role = options.transparent ? 'pet' : standInState.windows.some(w => w.role === 'controls') ? 'other' : 'controls';
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 400, height: options.height ?? 400 };
    this.webContents = new FakeContents(this);
    standInState.windows.push(this);
    return standIn(this, 'BrowserWindow') as this;
  }
  static getAllWindows(): FakeWindow[] { return standInState.windows.filter(w => !w.isDestroyed()); }
  static fromWebContents(contents: unknown): FakeWindow | null { return standInState.windows.find(w => w.webContents === contents) ?? null; }
  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }
  isFocused(): boolean { return false; }
  isAlwaysOnTop(): boolean { return this.top; }
  setAlwaysOnTop(value: boolean): void { this.top = value; }
  show(): void { this.visible = true; this.emit('show'); }
  showInactive(): void { this.show(); }
  hide(): void { this.visible = false; this.emit('hide'); }
  focus(): void { /* none */ }
  minimize(): void { this.minimized = true; this.emit('minimize'); }
  restore(): void { this.minimized = false; this.emit('restore'); }
  close(): void { this.emit('close', { preventDefault() { /* kept */ } }); }
  destroy(): void { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds }; }
  setBounds(next: Partial<FakeWindow['bounds']>): void { this.bounds = { ...this.bounds, ...next }; }
  getPosition(): [number, number] { return [this.bounds.x, this.bounds.y]; }
  setPosition(x: number, y: number): void { this.bounds = { ...this.bounds, x, y }; }
  getSize(): [number, number] { return [this.bounds.width, this.bounds.height]; }
  setSize(width: number, height: number): void { this.bounds = { ...this.bounds, width, height }; }
  getContentSize(): [number, number] { return this.getSize(); }
  setContentSize(width: number, height: number): void { this.setSize(width, height); }
  setIgnoreMouseEvents(): void { /* none */ }
  getNativeWindowHandle(): Buffer { return Buffer.alloc(8); }
  async loadURL(): Promise<void> { await fakeLoad(this); }
  async loadFile(): Promise<void> { await fakeLoad(this); }
}
/**
 * A window's page loading (overhaul step 8): what Electron tells while it loads, with nothing loaded: a new main-frame document at once, the
 * page finished after STAND_IN_LOAD_MS (default 40 ms, so while the ready chain still starts parts). __standInOnLoad (tests/helpers/app-stand-in/
 * run.ts) is told when the page "runs", as a renderer would start calling its handlers.
 */
async function fakeLoad(win: FakeWindow): Promise<void> {
  const contents = win.webContents;
  standInState.loaded.push(win.role);
  await new Promise(resolve => setTimeout(resolve, 0));
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'file:///index.html', preventDefault() { /* none */ } });
  contents.emit('did-start-loading');
  ((globalThis as Record<string, any>).__standInOnLoad as ((role: string, contents: unknown) => void) | undefined)?.(win.role, contents);
  await new Promise(resolve => setTimeout(resolve, Number(process.env.STAND_IN_LOAD_MS ?? 40)));
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
}

const appEvents = new EventEmitter();
appEvents.setMaxListeners(0);
const paths = new Map<string, string>([['appData', path.join(root, 'appData')], ['temp', path.join(root, 'temp')], ['home', path.join(root, 'home')],
  ['userData', path.join(root, 'appData', 'soft-hearts-claude-dev')], ['exe', process.execPath], ['logs', path.join(root, 'logs')], ['downloads', path.join(root, 'downloads')]]);
const switches = new Map<string, string>([['user-data-dir', path.join(root, 'profile')]]);
export const app = standIn({
  isPackaged: false,
  name: 'soft hearts',
  commandLine: standIn({ getSwitchValue: (name: string) => switches.get(name) ?? '', hasSwitch: (name: string) => switches.has(name), appendSwitch: (name: string, value = '') => { switches.set(name, value); } }, 'commandLine'),
  getPath: (name: string) => paths.get(name) ?? path.join(root, name),
  setPath: (name: string, value: string) => { paths.set(name, value); },
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-stand-in',
  getLocale: () => 'zh-CN',
  getSystemLocale: () => 'zh-CN',
  getPreferredSystemLanguages: () => ['zh-CN'],
  setName: () => undefined, setAppUserModelId: () => undefined,
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve().then(() => { standInState.readyResolve(); }),
  isReady: () => true,
  on: (event: string, fn: (...args: any[]) => void) => { appEvents.on(event, fn); return app; },
  once: (event: string, fn: (...args: any[]) => void) => { appEvents.once(event, fn); return app; },
  emit: (event: string, ...args: unknown[]) => appEvents.emit(event, ...args),
  quit: () => { standInState.quit = true; },
  exit: () => { standInState.quit = true; },
  focus: () => undefined,
  getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => undefined,
}, 'app');
export const BrowserWindow = FakeWindow;
export const ipcMain = standIn({
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
    if (standInState.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    standInState.handlers.set(channel, fn);
  },
  removeHandler: (channel: string) => { standInState.handlers.delete(channel); },
  on: () => ipcMain, once: () => ipcMain, removeListener: () => ipcMain, removeAllListeners: () => ipcMain,
}, 'ipcMain');
export const dialog = standIn({
  showErrorBox: (title: string, text: string) => { standInState.dialogs.push({ title, text }); },
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
}, 'dialog');
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1,
  size: { width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1040 }, rotation: 0, internal: true };
export const screen = standIn(Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => display, getAllDisplays: () => [display], getDisplayMatching: () => display, getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 10, y: 10 }), dipToScreenPoint: (p: unknown) => p, screenToDipPoint: (p: unknown) => p,
}), 'screen');
export const safeStorage = standIn({
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`stand-in:${text}`, 'utf8'),
  decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^stand-in:/, ''),
}, 'safeStorage');
export const protocol = standIn({ registerSchemesAsPrivileged: () => undefined, handle: () => undefined, unhandle: () => undefined }, 'protocol');
export const net = standIn({ fetch: async () => new Response('', { status: 404 }) }, 'net');
const powerEvents = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0, getSystemIdleState: () => 'active', isOnBatteryPower: () => false });
standInState.powerMonitor = standIn(powerEvents, 'powerMonitor') as never;
export const powerMonitor = standInState.powerMonitor;
export const session = standIn({ defaultSession: inert('session.defaultSession') }, 'session');
export const globalShortcut = standIn({ register: () => true, unregister: () => undefined, unregisterAll: () => undefined, isRegistered: () => false }, 'globalShortcut');
export const shell = standIn({ openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined }, 'shell');
export const nativeImage = inert('nativeImage');
export const Tray = class extends EventEmitter { constructor(..._args: unknown[]) { super(); } setToolTip(): void { /* none */ } setContextMenu(): void { /* none */ } setImage(): void { /* none */ } destroy(): void { /* none */ } isDestroyed(): boolean { return false; } displayBalloon(): void { /* none */ } };
export const Menu = standIn({ buildFromTemplate: () => inert('menu'), setApplicationMenu: () => undefined }, 'Menu');
export const desktopCapturer = standIn({ getSources: async () => [] }, 'desktopCapturer');
/** No worker ever starts: a fork answers nothing (the senses and memory workers wait, as when their model files are missing). */
export const utilityProcess = standIn({ fork: () => Object.assign(new EventEmitter(), { postMessage() { /* none */ }, kill() { return true; }, pid: 0 }) }, 'utilityProcess');
export const MessageChannelMain = inert('MessageChannelMain');
export const contextBridge = inert('contextBridge');
export const ipcRenderer = inert('ipcRenderer');
export const clipboard = inert('clipboard');
export const nativeTheme = standIn(Object.assign(new EventEmitter(), { shouldUseDarkColors: false }), 'nativeTheme');
export const systemPreferences = inert('systemPreferences');
export const webContents = standIn({ getAllWebContents: () => standInState.windows.map(w => w.webContents), fromId: (id: number) => standInState.windows.find(w => w.webContents.id === id)?.webContents ?? null }, 'webContents');
export default { app, BrowserWindow, ipcMain, dialog, screen, safeStorage, protocol, net, powerMonitor, session, globalShortcut, shell, nativeImage, Tray, Menu,
  desktopCapturer, utilityProcess, MessageChannelMain, contextBridge, ipcRenderer, clipboard, nativeTheme, systemPreferences, webContents };
