// I-136 Unbound v1 step 5a 拉她, the companion window's report (preload `petTouch`; src/mood/pet-pull.ts sends it). Only the companion window, only
// while it is shown, and only the pull's own fields: anything else the page sends is dropped here, and parseTouchEvent (sink.ts) checks
// the words and clamps the numbers again. The host adds kind 'pull', the place 'pet' and its own time. Nothing new is sensed or sent:
// it says which part was pulled and how, like a click on her in Unbound (electron/unbound/typing.ts).
import { parseTouchEvent, type TouchEvent } from '../../../shared/mood/touch';

const FIELDS = ['part', 'side', 'strength', 'direction', 'heldMs', 'ended', 'response', 'steps'] as const;

/** The pull as a touch event, or null when it is not exactly one (an end is required: 'holding' or how it ended). */
export function petPullEvent(value: unknown, at: number): TouchEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const picked: Record<string, unknown> = { kind: 'pull', where: 'pet', at };
  for (const key of FIELDS) if (Object.hasOwn(raw, key)) picked[key] = raw[key];
  if (raw.side === undefined) picked.side = null;
  const event = parseTouchEvent(picked);
  return event && event.ended ? event : null;
}

export interface PetTouchWindow { webContents: { id: number }; isVisible(): boolean; isMinimized(): boolean }

/** The host handler: true when it was the shown companion window's own report and the brain side took it. */
export function acceptPetTouch(sender: number, pet: PetTouchWindow | null | undefined, value: unknown, report: (event: TouchEvent) => boolean, clock: () => number = Date.now): boolean {
  if (!pet || sender !== pet.webContents.id || !pet.isVisible() || pet.isMinimized()) return false;
  const event = petPullEvent(value, clock());
  return event ? report(event) : false;
}
