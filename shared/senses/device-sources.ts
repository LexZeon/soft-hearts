/**
 * I-190: the microphone and camera sources, as one store both windows (and the Unbound input box) read and write: the I-177 lists in this
 * profile's local storage (shared/voice/call-device-storage.ts). Choosing a microphone moves it to the top of the 「说」 list, so calls and
 * every other use of the microphone follow it; the camera has its own list in the same place. A `storage` event tells the other windows.
 *
 * Names only, owner names stripped; nothing here sends anything anywhere (no IPC). A window that cannot read the names (the Unbound input
 * box: it never gets the microphone) lists the names the companion window last saw plugged in. Browser objects come in as ports.
 */
import { CALL_DEVICES_STORAGE_KEY, localCallDeviceStorage, pickByPriority, stripDeviceName, type CallDeviceStorage, type DeviceInfo } from '../voice';
import { deviceMenu, promote, type SourceMenuModel } from './source-picker';

export type DeviceSourceKind = 'microphone' | 'camera';
export interface DeviceSourcePorts {
  /** The page's devices (microphones and cameras; names are blank until the page was once given one). */
  enumerate(): Promise<DeviceInfo[]>;
  storage: CallDeviceStorage;
  /** Another window changed the stored lists. Returns how to stop listening. */
  watch(callback: () => void): () => void;
  /** A device was plugged in or out. */
  deviceChange(callback: () => void): () => void;
}
export interface DeviceReading { microphones: string[]; cameras: string[]; known: boolean; devices: DeviceInfo[] }

const KIND = { microphone: 'audioinput', camera: 'videoinput' } as const;
const virtual = (id: string) => id === 'default' || id === 'communications';
function namesOf(devices: readonly DeviceInfo[], kind: DeviceInfo['kind']): string[] {
  return [...new Set(devices.filter(d => d.kind === kind && !virtual(d.deviceId)).map(d => stripDeviceName(d.label)).filter(Boolean))].slice(0, 24);
}

/** The browser's own pieces; null-safe outside a page (tests pass their own ports). */
export function browserDeviceSourcePorts(): DeviceSourcePorts {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  const page = typeof window === 'undefined' ? undefined : window;
  return {
    enumerate: async () => {
      const list = await media?.enumerateDevices?.() ?? [];
      return list.filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput' || d.kind === 'videoinput')
        .map(d => ({ kind: d.kind as DeviceInfo['kind'], deviceId: d.deviceId, groupId: d.groupId, label: d.label }));
    },
    storage: localCallDeviceStorage(),
    watch: callback => {
      const listener = (event: StorageEvent) => { if (event.key === CALL_DEVICES_STORAGE_KEY || event.key === null) callback(); };
      page?.addEventListener('storage', listener);
      return () => page?.removeEventListener('storage', listener);
    },
    deviceChange: callback => {
      media?.addEventListener?.('devicechange', callback);
      return () => media?.removeEventListener?.('devicechange', callback);
    },
  };
}

export class DeviceSources {
  private readonly listeners = new Set<() => void>();
  private readonly stops: Array<() => void> = [];
  constructor(private readonly ports: DeviceSourcePorts = browserDeviceSourcePorts()) {
    try { this.stops.push(ports.watch(() => this.emit())); } catch { /* no storage events here */ }
    try { this.stops.push(ports.deviceChange(() => { void this.read().then(() => this.emit(), () => {}); })); } catch { /* no device events here */ }
  }

  /** What is plugged in now. With names readable, they are written down for the windows that cannot read them. */
  async read(): Promise<DeviceReading> {
    let devices: DeviceInfo[] = [];
    try { devices = await this.ports.enumerate(); } catch { devices = []; }
    const known = devices.some(d => stripDeviceName(d.label) !== '');
    if (!known) {
      const plugged = this.ports.storage.load().plugged;
      return { microphones: plugged?.microphones ?? [], cameras: plugged?.cameras ?? [], known: false, devices };
    }
    const microphones = namesOf(devices, 'audioinput'), cameras = namesOf(devices, 'videoinput');
    const state = this.ports.storage.load();
    // A camera's names are blank until the page had the camera once; then the last names seen stay (never an empty list over a known one).
    const camerasKnown = devices.some(d => d.kind === 'videoinput' && stripDeviceName(d.label) !== '');
    const next = { microphones, cameras: camerasKnown ? cameras : state.plugged?.cameras ?? [] };
    if (JSON.stringify(next) !== JSON.stringify(state.plugged ?? null)) { state.plugged = next; this.ports.storage.save(state); }
    return { ...next, known: true, devices };
  }

  /** The stored priority list of one kind (empty: the system default). */
  order(kind: DeviceSourceKind): string[] {
    const prefs = this.ports.storage.load().prefs;
    return kind === 'microphone' ? prefs.inputOrder : prefs.cameraOrder ?? [];
  }

  /** The menu for one kind: "跟着系统默认" and the names plugged in now, the one in use checked. */
  async menu(kind: DeviceSourceKind): Promise<SourceMenuModel> {
    const reading = await this.read();
    return deviceMenu(kind, this.order(kind), kind === 'microphone' ? reading.microphones : reading.cameras, reading.known);
  }

  /** The user chose: that name first in its list (null: the list is emptied, the system default). Only this profile's storage changes. */
  choose(kind: DeviceSourceKind, name: string | null): void {
    const state = this.ports.storage.load();
    if (kind === 'microphone') state.prefs.inputOrder = promote(state.prefs.inputOrder, name);
    else { const order = promote(state.prefs.cameraOrder ?? [], name); if (order.length) state.prefs.cameraOrder = order; else delete state.prefs.cameraOrder; }
    this.ports.storage.save(state);
    this.emit();
  }

  /** The camera to open: the highest plugged-in entry of the camera list, or null (the system default, as before). */
  async cameraDeviceId(): Promise<string | null> {
    const order = this.order('camera');
    if (!order.length) return null;
    try { return pickByPriority(order, await this.ports.enumerate(), KIND.camera); } catch { return null; }
  }

  /** Something changed (a choice here, a choice in another window, a device plugged in or out). */
  onChange(callback: () => void): () => void { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }

  dispose(): void { for (const stop of this.stops.splice(0)) { try { stop(); } catch { /* gone */ } } this.listeners.clear(); }

  private emit(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* one listener's trouble is its own */ } } }
}
