/**
 * I-190:
 * what each sense's source menu offers, in one place, for both windows that show one (the companion toolbar and the full-screen Unbound
 * input box's senses panel, docs/claude/2026-11-22-i190-source-pickers.md). Pure: no DOM, no storage, no IPC.
 *
 * - Microphone and camera: "跟着系统默认" first, then the devices plugged in now by their names (owner names already stripped by
 *   shared/voice/call-devices.ts stripDeviceName). The checked one is what the priority list picks now (the first plugged-in entry; none
 *   plugged in or an empty list: the default). Choosing one moves it to the top of the list; "跟着系统默认" empties it.
 * - Screen: "跟着系统默认" (the screen she is on, as before), then each screen and each other program's window, by an opaque id the host
 *   gave (desktopCapturer's "screen:N:M" / "window:N:M"); titles are shown on the user's own screen only.
 * - The computer's sound: Electron 45 on Windows offers only the whole system's loopback (`audio: 'loopback'`), so the menu says so.
 * Choosing a source never turns a sense on or off; the switches stay the user's (tests/i190-source-pickers.test.ts).
 */

export type SourceKind = 'microphone' | 'camera' | 'screen' | 'systemAudio';
export const SOURCE_KINDS: readonly SourceKind[] = Object.freeze(['microphone', 'camera', 'screen', 'systemAudio']);
/** The item id of "跟着系统默认" in every menu. */
export const FOLLOW_DEFAULT = 'default';

/** `own`: the label is the user's own text (a device or window name), shown as it is; else it is ours and translated. `number`: "屏幕 N". */
export interface SourceItem { id: string; label: string; checked: boolean; own?: boolean; number?: number }
export interface SourceMenuModel { kind: SourceKind; title: string; items: SourceItem[]; note?: string }

/** Chinese copy; the English is in shared/foundation/ui-copy.sources.en.ts (rendered through uiText). */
export const SOURCE_TEXT = Object.freeze({
  followDefault: '跟着系统默认',
  title: { microphone: '用哪个麦克风', camera: '用哪个摄像头', screen: '她看哪块屏幕', systemAudio: '听哪里的声音' } as Record<SourceKind, string>,
  caret: { microphone: '选麦克风', camera: '选摄像头', screen: '选屏幕或窗口', systemAudio: '选声音来源' } as Record<SourceKind, string>,
  namesLater: { microphone: '开过一次麦克风后，这里会列出设备的名字。', camera: '开过一次摄像头后，这里会列出设备的名字。' } as Record<'microphone' | 'camera', string>,
  poseDefault: '「姿势识别」在自己的小窗口里用摄像头，还是跟着系统默认。',
  wholeSystem: '电脑的全部声音',
  wholeSystemNote: 'Windows 上只能一起听整台电脑放出的声音，选不了单个程序。',
  screenFollowNote: '跟着系统默认：她所在的那块屏幕。',
  screenEmpty: '没读到屏幕和窗口的列表，过一会儿再点开看看。',
  windowGoneNote: '刚才选的窗口不在了，已回到跟着系统默认。',
});

const MAX_NAMES = 12;
const clean = (name: unknown): string => typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';

/** The device menu for the microphone or the camera. `plugged`: stripped names of the devices plugged in now; `known`: names could be read. */
export function deviceMenu(kind: 'microphone' | 'camera', order: readonly string[], plugged: readonly string[], known: boolean): SourceMenuModel {
  const names = [...new Set(plugged.map(clean).filter(Boolean))].slice(0, MAX_NAMES);
  const picked = order.map(clean).find(name => names.includes(name)) ?? null;
  const items: SourceItem[] = [{ id: FOLLOW_DEFAULT, label: SOURCE_TEXT.followDefault, checked: picked === null },
    ...names.map(name => ({ id: deviceItemId(name), label: name, checked: name === picked, own: true }))];
  const notes = [!known && !names.length ? SOURCE_TEXT.namesLater[kind] : '', kind === 'camera' ? SOURCE_TEXT.poseDefault : ''].filter(Boolean);
  return { kind, title: SOURCE_TEXT.title[kind], items, ...(notes.length ? { note: notes.join(' ') } : {}) };
}
/** Device item ids are the name itself behind a prefix (they never leave the window: shared by the menu and the store only). */
export const deviceItemId = (name: string): string => `name:${name}`;
export function deviceNameOf(id: string): string | null { return id.startsWith('name:') ? clean(id.slice(5)) || null : null; }

/** The new priority list after a choice: the chosen name first, the rest in their order; "跟着系统默认" (null) empties it. */
export function promote(order: readonly string[], name: string | null): string[] {
  const chosen = name === null ? '' : clean(name);
  if (!chosen) return [];
  return [chosen, ...order.map(clean).filter(entry => entry && entry !== chosen)].slice(0, 24);
}

/** The host's opaque screen source ids (desktopCapturer): "screen:<n>:<n>" or "window:<n>:<n>"; anything else is refused. */
const SOURCE_ID = /^(screen|window):\d{1,20}:\d{1,10}$/;
export function parseScreenSourceId(value: unknown): string | null { return typeof value === 'string' && SOURCE_ID.test(value) ? value : null; }
export const screenSourceKind = (id: string): 'screen' | 'window' => id.startsWith('window:') ? 'window' : 'screen';

/** `label`: a window's title (shown only in the user's own windows); a screen's is unused (screens are numbered in their order). */
export interface ScreenSourceEntry { id: string; kind: 'screen' | 'window'; label: string }
/** What the host tells the windows about the screen choice: the opaque id, or null for the default; `note` says why it changed by itself. */
export interface ScreenSourceView { choice: string | null; note?: string }
export interface ScreenSourceMenuView extends ScreenSourceView { entries: ScreenSourceEntry[] }

/** Screens are named by their order ("屏幕 1", "屏幕 2"); windows by their title. */
export function screenMenu(view: ScreenSourceMenuView | null): SourceMenuModel {
  const entries = (view?.entries ?? []).filter(entry => parseScreenSourceId(entry.id)).slice(0, 40);
  const choice = view?.choice && entries.some(entry => entry.id === view.choice) ? view.choice : null;
  const items: SourceItem[] = [{ id: FOLLOW_DEFAULT, label: SOURCE_TEXT.followDefault, checked: choice === null },
    ...entries.map((entry, index) => entry.kind === 'screen'
      ? { id: entry.id, label: '屏幕', checked: entry.id === choice, number: entries.slice(0, index + 1).filter(e => e.kind === 'screen').length }
      : { id: entry.id, label: clean(entry.label) || '没有标题的窗口', checked: entry.id === choice, own: !!clean(entry.label) })];
  const note = !view ? SOURCE_TEXT.screenEmpty : view.note ?? SOURCE_TEXT.screenFollowNote;
  return { kind: 'screen', title: SOURCE_TEXT.title.screen, items, note };
}

/** The one thing Electron offers for the computer's sound on Windows (`audio: 'loopback'`): the whole system, said honestly. */
export function systemAudioMenu(): SourceMenuModel {
  return { kind: 'systemAudio', title: SOURCE_TEXT.title.systemAudio, items: [{ id: 'loopback', label: SOURCE_TEXT.wholeSystem, checked: true }], note: SOURCE_TEXT.wholeSystemNote };
}

/** Where a choice goes. Only the screen's opaque id ever goes to the host; device names stay in this window's storage. */
export interface SourceChoicePorts {
  /** Host request (window.desktop.chooseScreenSource / the Unbound input box's): an opaque id or null. */
  screen(id: string | null): Promise<unknown>;
  /** The window's own store (localStorage): the device's name or null for the default. */
  device(kind: 'microphone' | 'camera', name: string | null): void;
}
/** A click on a menu item. Never a switch: nothing here can turn a sense on or off. */
export async function chooseSource(kind: SourceKind, id: string, ports: SourceChoicePorts): Promise<void> {
  if (kind === 'systemAudio') return; // one source only
  if (kind === 'screen') {
    const source = id === FOLLOW_DEFAULT ? null : parseScreenSourceId(id);
    if (source !== null || id === FOLLOW_DEFAULT) await ports.screen(source);
    return;
  }
  const name = id === FOLLOW_DEFAULT ? null : deviceNameOf(id);
  if (name !== null || id === FOLLOW_DEFAULT) ports.device(kind, name);
}
