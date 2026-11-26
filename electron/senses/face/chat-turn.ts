/**
 * I-135 face check in chat (docs/claude/2026-11-15-i135-face-chat.md): what one chat turn takes from the face check.
 * Pure of Electron: main.ts hands in the parts. Never throws and never waits longer than the photo check's own bound
 * (knobs.schedule.photoTimeoutMs, 1.5 s); without a photo it does not wait at all (first-token speed).
 *
 * The user's rule (2026-11-15): only clearly-not-you counts; uncertain is the user. The verdicts already say so
 * (electron/senses/face/decision.ts), so this module just reads them.
 */
import { FACE_STRANGER_LINE } from '../../../shared/senses/face-check';

export interface FaceChatPort {
  host: { state(): 'you' | 'not-you'; strangerLine(): string | null };
  /** A camera picture about to be sent → the verdict to use for this turn (bounded; never throws). */
  checkPhoto(dataUrl: string | null | undefined): Promise<'you' | 'not-you'>;
}

export interface FaceTurn {
  /** The message of this turn was not said by the user. */
  visitor: boolean;
  /** Her one private line for this turn, or null (the user is there, or the face check is off). */
  line: string | null;
}

export const NO_FACE_TURN: FaceTurn = Object.freeze({ visitor: false, line: null });

/**
 * `photoDataUrl`: the camera picture this turn carries (one the user asked for or attached), or null. `strangerLine`: I-139's line
 * (shared/foundation/i139-texts.ts STRANGER_LINE) while its switch is on, which takes the place of the host's; absent, the host's line as before.
 */
export async function faceTurnFor(face: FaceChatPort | null | undefined, photoDataUrl: string | null | undefined, strangerLine?: string | null): Promise<FaceTurn> {
  if (!face) return NO_FACE_TURN;
  try {
    const verdict = photoDataUrl ? await face.checkPhoto(photoDataUrl) : face.host.state();
    if (verdict !== 'not-you') return NO_FACE_TURN;
    return { visitor: true, line: strangerLine || (face.host.strangerLine() ?? FACE_STRANGER_LINE) };
  } catch { return NO_FACE_TURN; } // uncertain counts as the user
}
