/**
 * A change of her motion layers while she is already shown (docs/claude/2026-11-15-unbound-own-model.md): the companion's pose picked or
 * cleared while she is in Unbound, or her default stand giving way to a picked pose. Without this the mixer jumped to the new clip
 * in one frame (Gene, stand ↔ none: 75–86° on one frame at 60 and 30 fps). The companion's own switch bridge (R29d,
 * src/stage/motion-transition.ts) carries the shown base pose to the new one over 300–1500 ms (sized by how far it has to go,
 * smootherstep: no jump in place, speed or acceleration).
 *
 * In her frame it sits right on the mixer (restore before the helper's update, frame right after it), below the residuals, her
 * feet's IK and the grants, which are all solved from the bridged pose, so it needs only the tracks that changed.
 */
import type { SkinnedMesh } from 'three';
import { MotionTransition, captureMotionPose, switchDurationMs } from '../stage/motion-transition';

export class ClipSwitchBridge {
  private readonly transition: MotionTransition;

  constructor(private readonly mesh: SkinnedMesh) { this.transition = new MotionTransition(mesh); }

  /** `apply` changes the clips (her residuals already taken off) and returns the property tracks whose source changed. */
  switch(apply: () => readonly string[]): void {
    const shown = captureMotionPose(this.mesh); // the base as last shown (mixer plus any bridge still running)
    this.transition.restore();
    const changed = apply();
    if (changed.length) this.transition.start(shown, changed, switchDurationMs);
  }
  /** Before the mixer's update. */
  restore(): void { this.transition.restore(); }
  /** Right after the mixer's update. */
  frame(delta: number): void { this.transition.frame(delta); }
  get active(): boolean { return this.transition.getState().active; }
  dispose(): void { this.transition.dispose(); }
}
