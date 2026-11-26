/**
 * The full-screen small panel's 「设为默认位置」 / 「清除」 on the host side. A click always answers:
 *  - kept: the look after, with the default place set;
 *  - not kept: the same look plus `refused` (why, in closed words), nothing saved; the panel says it in one plain line;
 *  and always one journal row ('default-place', action keep / clear, outcome in closed words), like her own ⟪keep-place⟫ (electron/unbound/place-marks.ts).
 * The first click on a screen that cannot keep her (pulled nearer than "only the face") used to change nothing and say nothing.
 * 2026-11-25: 已设 is said only after the write reached the disk (`persisted`); a write that failed is `not-saved`, said in
 * words and written in the journal, never a quiet 已设 that is gone after a restart.
 */
import type { DefaultPlaceLook, PlaceKeepRefusal } from '../../shared/unbound/life/place-record';
import type { PlaceKeepOutcome } from './place-keeper';

/** The part of the place keeper the panel uses (electron/unbound/place-keeper.ts). */
export interface PanelPlaces { look(): { set: boolean; here: boolean }; keepHere(walking?: boolean): PlaceKeepOutcome; clear(): void; persisted?(): Promise<boolean> }
export interface PanelPlaceRow { type: 'default-place'; action: 'keep' | 'clear'; outcome: 'done' | PlaceKeepRefusal }
export interface PanelPlacePorts {
  /** The place keeper of the one you talk with (null: no host). */
  places(): PanelPlaces | null;
  /** She is walking now (her life host runs a walk: its place is moving). */
  walking?(): boolean;
  journal?(row: PanelPlaceRow): void;
  /** The longest the panel waits for the disk (ms); absent: 3000 (the panel itself gives up on a click after 4 s). */
  writeWaitMs?: number;
}

const NONE: DefaultPlaceLook = { set: false, here: false };

export function panelPlace(ports: PanelPlacePorts): { look(): DefaultPlaceLook; set(on: boolean): Promise<DefaultPlaceLook> } {
  const row = (action: PanelPlaceRow['action'], outcome: PanelPlaceRow['outcome']) => { try { ports.journal?.({ type: 'default-place', action, outcome }); } catch { /* the journal never stops a click */ } };
  /** True when everything written reached the disk (a keeper without `persisted` writes nothing it can lose; a disk that does not answer in time counts as not written). */
  const onDisk = async (places: PanelPlaces): Promise<boolean> => {
    if (!places.persisted) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([places.persisted(), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ports.writeWaitMs ?? 3_000); timer.unref?.(); })]); } catch { return false; } finally { if (timer) clearTimeout(timer); }
  };
  return {
    look: () => { try { return ports.places()?.look() ?? NONE; } catch { return NONE; } },
    async set(on) {
      let places: PanelPlaces | null = null;
      try { places = ports.places(); } catch { /* none */ }
      if (!places) { row(on ? 'keep' : 'clear', 'not-out'); return { ...NONE, refused: 'not-out' }; }
      try {
        if (!on) {
          places.clear();
          const saved = await onDisk(places);
          row('clear', saved ? 'done' : 'not-saved');
          return { ...places.look(), refused: saved ? null : 'not-saved' };
        }
        let walking = false;
        try { walking = ports.walking?.() === true; } catch { /* unknown: not walking */ }
        const outcome = places.keepHere(walking);
        const saved = outcome !== 'kept' || await onDisk(places);
        const result: DefaultPlaceLook['refused'] = outcome === 'kept' ? (saved ? null : 'not-saved') : outcome;
        row('keep', result ?? 'done');
        return { ...places.look(), refused: result };
      } catch {
        row(on ? 'keep' : 'clear', 'not-out');
        return { ...NONE, refused: 'not-out' };
      }
    },
  };
}
