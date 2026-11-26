/**
 * I-177's device lists as stored in this profile's local storage (moved out of src/voice/voice-call/call-mic.ts for I-190, which re-exports
 * them): the 「说」 and 「听」 priority lists, I-190's camera list, the device sets seen, the answers. Both app windows and the Unbound input box
 * load pages from the same origin in the default session, so they read and write the same copy (a `storage` event tells the others).
 * Every read and write is guarded: a page works without storage. Names only (owner names stripped); never a device id.
 */
import type { CallDeviceVerdict } from './call-devices';

/** I-190: `cameraOrder` is the camera's priority list (the toolbar's and the Unbound panel's camera menu; absent = the system default). */
export interface CallDevicePrefs { inputOrder: string[]; outputOrder: string[]; hintOff: boolean; cameraOrder?: string[] }
interface SeenSet { inputs: string[]; outputs: string[] }
export interface CallDeviceState {
  prefs: CallDevicePrefs;
  /** Device sets that have been seen (stripped names), newest last, at most MAX_CALL_DEVICE_SETS. */
  seen: Record<string, SeenSet>;
  /** Sets whose suggestion the user answered 不换. */
  declined: string[];
  /** Sets Claude was already asked about (one ask per set, ever, whatever came back). */
  asked: string[];
  /** The verdicts Claude gave, by set. */
  verdicts: Record<string, CallDeviceVerdict>;
  hintDay: string | null;
  /** I-190: the stripped names plugged in now, as the companion window last read them (the Unbound input box lists these; it cannot read devices). */
  plugged?: { microphones: string[]; cameras: string[] };
}
export const MAX_CALL_DEVICE_SETS = 8;
export const emptyCallDeviceState = (): CallDeviceState => ({ prefs: { inputOrder: [], outputOrder: [], hintOff: false }, seen: {}, declined: [], asked: [], verdicts: {}, hintDay: null });

export interface CallDeviceStorage { load(): CallDeviceState; save(state: CallDeviceState): void }
/** I-190: the key other windows watch (a `storage` event when the companion or the Unbound input box changes a list). */
export const CALL_DEVICES_STORAGE_KEY = 'softhearts.callDevices.v1';
export const deviceNames = (x: unknown): string[] => Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, 24).map(s => s.slice(0, 80)) : [];
const MAX_SETS = MAX_CALL_DEVICE_SETS, names = deviceNames;
/** Browser storage for this profile, every read and write guarded: the page works without it. */
export function localCallDeviceStorage(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): CallDeviceStorage {
  return {
    load() {
      try {
        const v = JSON.parse(storage?.getItem(CALL_DEVICES_STORAGE_KEY) ?? 'null') as Partial<CallDeviceState> | null;
        if (!v || typeof v !== 'object') return emptyCallDeviceState();
        const state = emptyCallDeviceState();
        state.prefs = { inputOrder: names(v.prefs?.inputOrder), outputOrder: names(v.prefs?.outputOrder), hintOff: v.prefs?.hintOff === true };
        const cameras = names(v.prefs?.cameraOrder); if (cameras.length) state.prefs.cameraOrder = cameras;
        if (v.plugged && typeof v.plugged === 'object') state.plugged = { microphones: names(v.plugged.microphones), cameras: names(v.plugged.cameras) };
        for (const [key, set] of Object.entries(v.seen ?? {}).slice(0, MAX_SETS)) state.seen[key] = { inputs: names(set?.inputs), outputs: names(set?.outputs) };
        state.declined = names(v.declined); state.asked = names(v.asked);
        for (const [key, verdict] of Object.entries(v.verdicts ?? {}).slice(0, MAX_SETS)) if (verdict && typeof verdict === 'object') state.verdicts[key] = verdict as CallDeviceVerdict;
        state.hintDay = typeof v.hintDay === 'string' ? v.hintDay.slice(0, 10) : null;
        return state;
      } catch { return emptyCallDeviceState(); }
    },
    save(state) { try { storage?.setItem(CALL_DEVICES_STORAGE_KEY, JSON.stringify(state)); } catch { /* the page works without storage */ } },
  };
}
