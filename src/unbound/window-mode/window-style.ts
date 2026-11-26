/**
 * I-176 step 3: Unbound's engine is the only stage of the companion window and of the control window's preview (the old stage and its
 * switch 「桌宠用 Unbound 引擎（实验）」 are gone). What stays of the switch is the personal-feel strength, 0 (a true bypass) .. 1, the
 * slider in the control window's developer panel.
 *
 * Stored in this profile's page storage (localStorage, the same place the Unbound window keeps its quality tier). The slider writes it,
 * the companion window reads it once when it makes its stage and applies a change in place (the browser's `storage` event reaches every
 * other page of the profile; the page that wrote it is told by announceWindowStyle). Anything unreadable (private storage, a broken value)
 * reads as 0. A value saved by the removed switch (key `soft-hearts.window-engine.v1`, {on, style}) is read once as the strength when there
 * is no value of the new key yet, so a developer who had set one keeps it.
 */
export const WINDOW_STYLE_KEY = 'soft-hearts.window-style.v1';
/** The removed switch's key: only ever READ, for the strength it carried. */
export const LEGACY_WINDOW_ENGINE_KEY = 'soft-hearts.window-engine.v1';

const clampStyle = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The part of Storage this needs (tests pass a Map-backed one). */
export type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The strength as stored (`{"style":0.4}`), or 0. Never throws. */
export function parseWindowStyle(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length > 200) return 0;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? clampStyle((value as Record<string, unknown>).style) : 0;
  } catch { return 0; }
}

export function readWindowStyle(storage: ChoiceStorage | null | undefined): number {
  try {
    const own = storage?.getItem(WINDOW_STYLE_KEY) ?? null;
    return parseWindowStyle(own ?? storage?.getItem(LEGACY_WINDOW_ENGINE_KEY) ?? null);
  } catch { return 0; }
}

/** Saves the strength; false when the storage refused (the slider then shows what is really stored). */
export function writeWindowStyle(storage: ChoiceStorage | null | undefined, style: number): boolean {
  if (!storage) return false;
  try { storage.setItem(WINDOW_STYLE_KEY, JSON.stringify({ style: clampStyle(style) })); return true; } catch { return false; }
}

/** The page's own storage, or null where it cannot be had. */
export function pageStorage(): ChoiceStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * A page that made its stage with strength `started`: a change of the stored strength (from another page, or announced by this one) is
 * applied in place, once per distinct value. Returns the unsubscribe.
 */
export function watchWindowStyle(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, started: number, apply: (value: number) => void): () => void {
  let last = started;
  const listener = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key !== WINDOW_STYLE_KEY && key !== null) return; // null: the storage was cleared
    const next = parseWindowStyle((event as StorageEvent).newValue ?? null);
    if (next !== last) { last = next; apply(next); }
  };
  target.addEventListener('storage', listener);
  return () => target.removeEventListener('storage', listener);
}

/** The page that wrote the strength hears no `storage` event of its own: the slider tells this page with the same event shape. */
export function announceWindowStyle(target: Pick<Window, 'dispatchEvent'> | null | undefined, style: number): void {
  if (!target) return;
  const init = { key: WINDOW_STYLE_KEY, newValue: JSON.stringify({ style: clampStyle(style) }) };
  try {
    const event = typeof StorageEvent === 'function' ? new StorageEvent('storage', init) : Object.assign(new Event('storage'), init);
    target.dispatchEvent(event);
  } catch { /* nothing listens here: the companion window still hears the real one */ }
}
