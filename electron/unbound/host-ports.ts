/**
 * The Unbound host's ports and the window and IPC shapes it is handed (moved out of electron/unbound/host.ts unchanged, 2026-11-21, so the
 * host stays under the 40 KB file limit; host.ts re-exports them, so every import stays as it was).
 */
import type { FullscreenProbe } from './fullscreen-watch';
import type { PetPort, UnboundWindowPort } from './mode'; // no-pet-ok: the mode's port name for the companion window
import type { UnboundControlView, UnboundState } from '../../shared/unbound/scene';
import type { DisplayFacts, MonitorMeasurement, Rect } from '../../shared/unbound/world';
import type { UnboundSource } from './source';
import type { PeekPorts } from './peek';
import type { UnboundTouchReport } from '../../shared/unbound/typing';
import type { LifePorts } from './life';
import type { PlaceFilePort } from './place-keeper';
import type { CompanyPorts } from './company/host';
import type { UnboundMoodPorts } from './mood-bridge';
import type { UnboundGamesPorts } from './games-bridge';

export interface UnboundIpcEvent { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }
export interface UnboundIpcMain {
  handle(channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface UnboundWindowLike extends UnboundWindowPort {
  readonly webContents: { readonly id: number; readonly mainFrame?: unknown; send(channel: string, value: unknown): void; isDestroyed(): boolean };
  isVisible(): boolean;
  hide(): void;
  /** I-199: to the top of the always-on-top band once, without activation (electron/unbound/window.ts raiseUnboundWindow). */
  raise?(): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  setBounds(bounds: Rect): void;
  /** 'closed', or the page went away ('gone'). */
  onGone(callback: () => void): void;
}
/**
 * I-209 step 3: where one line of hers (a reply's bubble, her mouth) goes when several characters are on stage, each in her own full screen
 * (electron/unbound/company/stage.ts): her window, and her peek and life hear the cue. The host asks `speechTo`; null: its own window.
 */
export interface UnboundSpeechTarget {
  send(channel: string, value: unknown): void;
  cue(type: 'delta' | 'done' | 'error'): void;
}
export interface UnboundHostPorts {
  ipcMain: UnboundIpcMain;
  // no-pet-ok: the host's existing port names for the companion window (moved here unchanged)
  pet(): PetPort | null;
  petWanted(): boolean; // no-pet-ok: the existing port name
  developerMode(): boolean;
  source(): UnboundSource;
  /** Is the current model the reviewed bundled Gene (electron/main.ts verifyVisualGeneTarget)? */
  reviewed?(): Promise<boolean>;
  /** Her default stand when the companion has no pose layer: the bundled stand pose's asset URL (source.ts withRestPose); absent or null: none. */
  restPose?(): Promise<string | null>;
  display(): DisplayFacts;
  measure(): Promise<MonitorMeasurement[] | null>;
  /** Makes the window (hidden) at once and starts loading its page. */
  openWindow(bounds: Rect): { window: UnboundWindowLike; loaded: Promise<void> };
  fullscreen?: FullscreenProbe;
  /** U2: what the director reads (idle time, her sleep, a call, her mood…) and how it answers; absent: no peeks. */
  peek?: PeekPorts;
  /** Step 4: what her own life reads (electron/unbound/life.ts); absent: she only stands (and peeks, deciding alone). */
  life?: LifePorts;
  /** Step 4: where she last stood (`unbound-place.json`, electron/unbound/place-store.ts); absent: the default place each time. */
  savedPlace?: PlaceFilePort;
  /** 2026-11-23: the place the user set as her default (`unbound-default-place.json`); she starts there on every entry. Absent: none can be set. */
  defaultPlace?: PlaceFilePort & { clear(): void };
  /** I-209 step 1: the cards, the one you talk with, an extra's model (electron/unbound/company/host.ts); absent: nobody else can come out. */
  company?: CompanyPorts;
  /** Step 2: she was clicked (electron/unbound/typing.ts: one touch report, and the input box). */
  touch?(report: UnboundTouchReport): void;
  /** Step 5c: a pull's report as a touch (kind 'pull', place 'unbound'; electron/mood/touch/sink.ts reportTouch checks it). */
  pull?(report: Record<string, unknown>): void;
  /** Her mood view and a direct touch's mood input, as the companion window has them (electron/unbound/mood-bridge.ts); absent: refused. */
  mood?: UnboundMoodPorts;
  /** Batch B: the game hosts' methods (electron/unbound/games-bridge.ts), read when a request comes; absent: refused. */
  games?(): UnboundGamesPorts | undefined;
  /** How long a finished full-screen bubble with this whole text stays (ms): the companion window's decision (shared/behaviors/reply-linger/); absent: the page keeps it the longest. */
  lingerMs?(text: string): number;
  /** How long the page has to say where her head is (ms). */
  headTimeoutMs?: number;
  /** After she is back in the companion window: the host's settings sync. */
  restored(): void;
  publish(view: UnboundControlView): void;
  /** The normal way in (the control window's button) is on; false hides it (shared/foundation/channel-defaults.ts). Absent: on. */
  entryAllowed?(): boolean;
  /** Every change of state (after the host's own handling): the tray label, the permission bundle (electron/unbound/entry.ts). */
  modeChanged?(state: UnboundState): void;
  /** Preview runs only: a small window that shows the whole screen's view scaled ('fit'), instead of the work area. */
  preview?: { bounds: Rect };
  /** Entering: for the page to start (default 45 s), then without a forward step of its load (default 20 s), in all (default 90 s). */
  readyFirstMs?: number;
  readyTimeoutMs?: number;
  readyCapMs?: number;
  measureTimeoutMs?: number;
}

/** A promise or its fallback after `ms` (a rejection reads as the fallback too). */
export const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
