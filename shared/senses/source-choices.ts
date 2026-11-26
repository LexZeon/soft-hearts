/**
 * I-190: the source menus as one object a window uses (no DOM: the app windows and the Unbound input box both use it) (the companion toolbar, the Unbound input box's senses panel): what each menu offers
 * and what a pick does. Microphone and camera come from this profile's stored lists (shared/senses/device-sources.ts, no IPC); the screen
 * from the host (an opaque id each way); the computer's sound is the one source Windows gives. A pick is never a switch: nothing here can
 * turn a sense on or off (tests/i190-source-pickers.test.ts and the mutation entries I190-*).
 */
import { DeviceSources } from './device-sources';
import { chooseSource, screenMenu, systemAudioMenu, type ScreenSourceMenuView, type ScreenSourceView, type SourceKind, type SourceMenuModel } from './source-picker';

/** The host calls a window has for the screen choice (window.desktop in the app windows; the Unbound input box's own preload). */
export interface ScreenSourceApi {
  screenSourceMenu(): Promise<ScreenSourceMenuView>;
  chooseScreenSource(id: string | null): Promise<ScreenSourceView | unknown>;
  onScreenSource?(callback: (view: ScreenSourceView) => void): () => void;
}
export interface SourceChoices {
  readonly devices: DeviceSources;
  menu(kind: SourceKind): Promise<SourceMenuModel>;
  choose(kind: SourceKind, id: string): Promise<void>;
  /** A choice made here or in another window, a device plugged in or out, the screen choice reset: redraw. */
  onChange(callback: () => void): () => void;
  dispose(): void;
}

export function createSourceChoices(api: ScreenSourceApi, devices: DeviceSources = new DeviceSources()): SourceChoices {
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* its own trouble */ } } };
  const stops = [devices.onChange(emit)];
  try { const stop = api.onScreenSource?.(() => emit()); if (stop) stops.push(stop); } catch { /* no screen events here */ }
  return {
    devices,
    menu: kind => kind === 'screen' ? api.screenSourceMenu().then(view => screenMenu(view), () => screenMenu(null))
      : kind === 'systemAudio' ? Promise.resolve(systemAudioMenu()) : devices.menu(kind),
    choose: (kind, id) => chooseSource(kind, id, {
      screen: source => api.chooseScreenSource(source),
      device: (which, name) => devices.choose(which, name),
    }),
    onChange: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    dispose: () => { for (const stop of stops.splice(0)) { try { stop(); } catch { /* gone */ } } listeners.clear(); devices.dispose(); },
  };
}
