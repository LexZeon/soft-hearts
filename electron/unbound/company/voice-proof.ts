/**
 * I-209 stage voice: one voice reads for
 * everyone on stage, and it reads only what is proven on screen (docs/claude/2026-11-15-unbound-read-aloud.md: 说出来的必须是已经显示出来的).
 * The proof the voice reads is the first host's (`replySurface()` is `unbound.readAloud`): every line of the stage is sent from there, the
 * bubble of someone else's line only goes to HER window (stage.ts speechTo). So her page's "painted" report must reach that proof too: before
 * this, it reached her own host's proof, which never held a bubble, and was refused, so nothing of hers could ever be proven.
 *
 * Each page proves only the lines the stage sent to its own window (`mine`): the first one's page no longer proves a line that went to
 * someone else's window, and hers never proves another one's. A report still has to pass everything the proof checks (that bubble id, a
 * revision the host sent, exactly the text sent at it, newer than the last, the bubble can be seen). Alone on stage every line is the
 * first one's, so nothing changes there.
 */
import type { UnboundHost } from '../host';

type Prove = (value: unknown) => boolean;
const lineOf = (value: unknown): string | null => { const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined; return typeof id === 'string' ? id : null; };
const only = (prove: Prove, mine: (lineId: string) => boolean): Prove => value => {
  const id = lineOf(value);
  try { return id !== null && mine(id) && prove(value); } catch { return false; }
};

/** The first one's page proves only her own lines; returns the proof's own check (what every other page's report goes through). */
export function firstBubbleProof(first: Pick<UnboundHost, 'readAloud'>, mine: (lineId: string) => boolean): Prove {
  const proof = first.readAloud, own: Prove = proof.report.bind(proof);
  proof.report = only(own, mine);
  return own;
}

/** Her page's paint reports for her own lines count for the proof the stage's one voice reads (the first host's). */
export function shareBubbleProof(her: Pick<UnboundHost, 'readAloud'>, prove: Prove, mine: (lineId: string) => boolean): void {
  her.readAloud.report = only(prove, mine);
}
