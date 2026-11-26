/**
 * I-175 step 2 (docs/claude/2026-11-22-i175-part-mixer.md; rules shared/behaviors/part-mix/closed-mouth.ts): her face actions on the mouth while
 * she speaks, in both Unbound stages (window-motions.ts is shared by the companion window and full-screen).
 *  - A pout talks through (1): asked while she speaks, it plays as the showcase's pout expression on her face (`talkingFace`), so
 *    the pucker is the base and lip-sync keeps opening on top (intent-layer.ts, mouth.ts); a pout already playing as a face shape when she
 *    starts to speak hands over to that expression for the rest of its time (the face shape gives way 'speech' as before, eased).
 *  - A cheek puff, a tongue out, a kiss need a closed mouth (3): asked while she speaks, the request waits in the queue and starts
 *    in the next pause (the held "she is speaking" off; read-aloud off: the sentence shown) or after the reading; not started within 3 s of
 *    the pause, dropped; a cancelled reply (`cancel`) drops what waits. The face exclusive still cancels it 'speech' if she speaks again, so
 *    her voice is never cut.
 * Pure: no DOM, no three.js (the face exclusive is passed in).
 */
import type { FaceExclusive } from '../../stage';
import { ClosedMouthQueue, mouthActionKind } from '../../../shared/behaviors/part-mix/closed-mouth';

type FaceRequest = Parameters<FaceExclusive['request']>[0];

/** A closed-mouth shape waiting for a pause: the request as it would have gone to the face exclusive, and the exclusive it was resolved on. */
export interface QueuedMouthShape { request: FaceRequest; face: FaceExclusive; played(): void }

export class MouthActions {
  readonly queue = new ClosedMouthQueue<QueuedMouthShape>();
  /** Her face's "show this expression now" (window-face.ts show): the talk-through pout. Set by the stage; null: a pout while speaking is busy. */
  talkingFace: ((name: string, holdS: number) => boolean) | null = null;
  /** The talk-through mouth shape playing as a face shape now (its id and when it would end, ms), to hand over when speech takes the mouth. */
  private lease: { id: string; action: string; endsAt: number } | null = null;

  kind(action: string): 'talk-through' | 'closed' | null { return mouthActionKind(action); }

  /** A pout while she speaks: plays as the expression for about its own length. false when the face cannot show it now. */
  talkThrough(action: string, durationS: number): boolean {
    if (this.kind(action) !== 'talk-through' || !this.talkingFace) return false;
    try { return this.talkingFace(action, Math.max(0.4, durationS - 0.6)); } catch { return false; }
  }

  /** A mouth face shape was granted the exclusive: remember a talk-through one (it hands over if speech starts while it plays). */
  granted(id: string, action: string, endsAt: number): void { this.lease = this.kind(action) === 'talk-through' ? { id, action, endsAt } : null; }

  /** The exclusive is about to cancel its mouth request for speech (`activeId`: the request playing): a talk-through one carries on as the expression. */
  speechTakes(activeId: string | null, nowMs: number): void {
    const lease = this.lease;
    if (!lease || lease.id !== activeId) return;
    this.lease = null;
    const left = (lease.endsAt - nowMs) / 1000;
    if (left > 0.3) this.talkThrough(lease.action, left + 0.6);
  }

  /** A cancelled reply, a new reply, a new conversation or model: nothing waiting plays. */
  cancel(): void { this.queue.cancel(); this.lease = null; }
}
