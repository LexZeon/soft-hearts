// Preview metrics of a peek (Codex T-246a metrics.md M2 / M5): command -> first visible motion, the hold's dwell, frame times in the
// close-up. Split out of main.ts 2026-11-18, no behaviour change.
import { Quaternion, type Bone } from 'three';
import type { PeekPhase } from '../../shared/unbound/director';

export class PeekMetrics {
  startedAt = 0;
  firstMotionMs: number | null = null;
  holds: number[] = [];
  holdSince = 0;
  closeFrameMs: number[] = [];
  eyeDistanceM: number | null = null;
  eyeOffM: number | null = null;
  phases: { phase: PeekPhase | null; at: number }[] = [];
  private startQuaternions: Quaternion[] = [];
  private startMorphs: number[] = [];

  /** A peek command was accepted: remember how her head and eyes and face stood. */
  start(bones: readonly Bone[], morphs: readonly number[]): void {
    this.startedAt = performance.now(); this.firstMotionMs = null; this.phases = [];
    this.startQuaternions.length = 0;
    for (const bone of bones) this.startQuaternions.push(bone.getWorldQuaternion(new Quaternion()));
    this.startMorphs = [...morphs];
  }

  /**
   * After her frame: the phase changes and the hold's dwell, the first visible motion after the command (head or an eye turned >= 1 degree,
   * or a face change of 0.03), and the close-up frame times. `bones` is read only while the first motion is still pending.
   */
  track(active: boolean, phase: PeekPhase | null, bones: () => readonly Bone[], influences: readonly number[], raw: number): void {
    const last = this.phases[this.phases.length - 1];
    if (active && last?.phase !== phase) {
      if (last?.phase === 'hold') this.holds.push((performance.now() - this.holdSince) / 1000);
      if (phase === 'hold') this.holdSince = performance.now();
      this.phases.push({ phase, at: Math.round(performance.now() - this.startedAt) });
    }
    if (active && this.firstMotionMs === null && this.startQuaternions.length) {
      const turned = bones().some((bone, i) => this.startQuaternions[i] && bone.getWorldQuaternion(new Quaternion()).angleTo(this.startQuaternions[i]) * 180 / Math.PI >= 1)
        || influences.some((value, i) => Math.abs(value - (this.startMorphs[i] ?? 0)) >= 0.03); // T-246a M5: a head or eye turn of 1°, or a face change of 0.03
      if (turned) this.firstMotionMs = performance.now() - this.startedAt;
    }
    if (phase === 'lean' || phase === 'hold') { this.closeFrameMs.push(raw * 1000); if (this.closeFrameMs.length > 2_000) this.closeFrameMs.splice(0, 1_000); }
  }
}
