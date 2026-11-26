/**
 * I-174 item 3 (docs/claude/2026-11-21-i174-parity-fixes.md): her own lines (the inner loop's, a line a touch asked for, her look's) are hard
 * to interrupt too, like her replies. The rule for who may
 * cut her off
 *
 * What happened: any pointer press or key anywhere on her window, and her mood leaving 'idle' (a touch makes it 'touched'), counted as "you
 * are interacting" and cancelled the line she was saying or about to show (dev journal 05:43:10.6Z: a 70-character line of hers cancelled with
 * no message from you, touch clicks around it).
 *
 * Now only a clear intent of yours ends a line she is saying: a new message (sending one), the stop button, a clear sentence or stop command in
 * a call (shared/behaviors/interrupt/judge.ts), or her surface going away (a tray hide, out of Unbound). A press, a touch, typing, a click
 * reaction or her mood moving do not; they still keep new lines from starting (her looks and offers not yet shown, the next opportunity).
 */
export type OwnLineCause = 'input' | 'touch' | 'mood' | 'message' | 'stop' | 'sentence' | 'surface';

/** This cause ends a line she is already saying (or showing). */
export function ownLineYields(cause: OwnLineCause): boolean {
  return cause === 'message' || cause === 'stop' || cause === 'sentence' || cause === 'surface';
}
