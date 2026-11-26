/**
 * I-212 item 10: her hidden
 * ⟪keep-place⟫ / ⟪clear-place⟫ (shared/unbound/her-position/marks.ts) take effect here, and only:
 *  - in her reply to a message the user just sent (`from: 'user'`; the typed / voice-input chat turn, whose last message is always the user's:
 *    electron/wiring/brain-chat-wiring.ts). Her own openings, a topic she brings up and any other reply of her own never set it ('own');
 *  - while she stands in full screen (out, her window shown);
 *  - at most once per reply (the first place marker; the rest are not read).
 * No dialog: it is two numbers about where she stands, nothing private; the full-screen panel shows the change the next time it opens and its
 * 「清除」 works as before. One journal row per marker read. No program reads the user's words for this: she decides.
 */
import { placeMarkOf, type PlaceMarkWord } from '../../shared/unbound/her-position';

export type PlaceMarkOutcome = 'done' | 'not-out' | 'refused';
export interface PlaceMarkRow { type: 'default-place'; action: 'keep' | 'clear'; outcome: PlaceMarkOutcome }
export interface PlaceMarkPorts {
  /** She stands in full screen now (out, her window shown). */
  out(): boolean;
  /** The place keeper's setHere (false: not kept: her height or her place is not known, or it is outside what may be kept). */
  setHere(): boolean;
  clear(): void;
  journal?(row: PlaceMarkRow): void;
}

/** Whose reply the markers came from: 'user' = her reply to the message the user just sent; 'own' = anything she said on her own. */
export type PlaceMarkFrom = 'user' | 'own';

/** Reads a finished reply's ⟪…⟫ bodies; returns what was done (null: no place marker, or not her reply to the user). */
export function applyPlaceMark(bodies: readonly string[] | null | undefined, from: PlaceMarkFrom, ports: PlaceMarkPorts): PlaceMarkRow | null {
  if (from !== 'user') return null;
  const word: PlaceMarkWord | null = placeMarkOf(bodies);
  if (!word) return null;
  const action = word === 'keep-place' ? 'keep' : 'clear';
  let outcome: PlaceMarkOutcome;
  try {
    if (!ports.out()) outcome = 'not-out';
    else if (action === 'keep') outcome = ports.setHere() ? 'done' : 'refused';
    else { ports.clear(); outcome = 'done'; }
  } catch { outcome = 'refused'; }
  const row: PlaceMarkRow = { type: 'default-place', action, outcome };
  try { ports.journal?.(row); } catch { /* the journal never stops a reply */ }
  return row;
}
