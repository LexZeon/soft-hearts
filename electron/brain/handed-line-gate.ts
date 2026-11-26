/**
 * One truth for a line from her full-screen box (2026-11-23).
 *
 * The box hands its line to the control window, which sends it like its own chat box. Before, the box learned the line's fate only from the
 * control window's word after the send, and gave up after 20 s: it said "没发出去" and put the text back while the line was still on its
 * way, and the line went out later anyway (and again, when the user sent it a second time). Now the host itself decides, here, at the one
 * place every chat request passes (electron/wiring/brain-chat-wiring.ts 'chat'): a request that carries a line number (ChatRequest.line)
 * goes on only while that line is still open in the box's ledger (electron/unbound/say-ack.ts); the moment the request is accepted, the
 * line is sent. A line the box already took back is refused, so a line goes out at most once and never after "没发出去".
 *
 * The ledger lives in the Unbound part and registers itself here (setHandedLineGate); without it, a numbered request is refused (no
 * ledger: nobody handed that line out). Requests without a number (every chat box's own line) are not touched.
 */
import { HANDED_LINE_REFUSED } from '../../shared/brain';

export interface HandedLineGate {
  /** Whether this line may go out now (still open). Called once per request; a taken-back line is noted by the ledger as 'late'. */
  open(line: number): boolean;
  /** The request carrying it was accepted (its turn started): the line is sent. */
  sent(line: number): void;
  /** I-209 step 3 ("点谁和谁说"): the character this line was typed to (the one you clicked on stage); null: the first one (as before). */
  ownerOf?(line: number): string | null;
  /** I-209 step 3: whom a line without a number goes to now (voice input while several are on stage: the one you clicked last); null: the first one. */
  addressee?(): string | null;
}

let gate: HandedLineGate | null = null;

/** The Unbound part's ledger (electron/wiring/unbound-wiring.ts); null when it goes. */
export function setHandedLineGate(next: HandedLineGate | null): void { gate = next; }

/**
 * At the top of the chat handler, before anything else runs: throws (HANDED_LINE_REFUSED) when the request carries a line that may not go
 * out; otherwise returns what to call once the turn is accepted (null for an ordinary request). The handler is synchronous up to the
 * acceptance, so nothing can take the line back in between.
 */
export function admitHandedLine(line: number | undefined): (() => void) | null {
  if (line === undefined) return null;
  const ledger = gate;
  if (!ledger || !ledger.open(line)) throw new Error(HANDED_LINE_REFUSED);
  return () => { try { ledger.sent(line); } catch { /* the ledger never blocks a turn */ } };
}

/**
 * I-209 step 3: whose turn a request is. A line from the full-screen box goes to the character whose box it
 * was (the one you clicked); a request without a number goes to the one you clicked last while several are on stage. Null: the desktop
 * companion's turn, exactly as before (alone on stage, at home, or no ledger). Read before the turn is accepted (the ledger forgets the line then).
 */
export function turnOwnerFor(line: number | undefined): string | null {
  try { return (line !== undefined ? gate?.ownerOf?.(line) : gate?.addressee?.()) ?? null; } catch { return null; }
}
