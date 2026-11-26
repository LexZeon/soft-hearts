/**
 * P1 舞台少画 (stage-pace.ts): how fast a few bones turn on screen, so motion nobody named (a sleep stir, a her-life
 * hand-off, hair still swinging after a turn) keeps the stage at full pace. Reads the bones' world matrices as the last
 * render left them (no matrix update of its own) and returns the fastest turn in °/s over the real time between two drawn
 * frames. No allocation per frame once the bone list is known.
 */
import { Matrix4, Quaternion, Vector3, type Object3D } from 'three';

const DEG = 180 / Math.PI;
/** A gap longer than this (s) is a restart, not a speed (hidden, a stall). */
const MAX_GAP = 0.25;

export class PaceMotionProbe {
  private bones: Object3D[] = [];
  private previous: Quaternion[] = [];
  private known = false;
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly m = new Matrix4();

  /** Fastest world turn (°/s) of `bones` since the last call `dt` seconds ago; 0 on the first call or after a restart. */
  measure(bones: readonly (Object3D | null | undefined)[], dt: number): number {
    if (!this.same(bones)) {
      this.bones = bones.filter((bone): bone is Object3D => !!bone);
      this.previous = this.bones.map(() => new Quaternion());
      this.known = false;
    }
    const valid = Number.isFinite(dt) && dt > 0 && dt <= MAX_GAP;
    let fastest = 0;
    for (let i = 0; i < this.bones.length; i++) {
      this.m.copy(this.bones[i].matrixWorld).decompose(this.p, this.q, this.s);
      if (this.known && valid) {
        const angle = this.q.angleTo(this.previous[i]) * DEG / dt;
        if (angle > fastest) fastest = angle;
      }
      this.previous[i].copy(this.q);
    }
    this.known = this.bones.length > 0;
    return valid ? fastest : 0;
  }

  /** Nothing drawn for a while: the next call has no history. */
  reset(): void { this.known = false; }

  private same(bones: readonly (Object3D | null | undefined)[]): boolean {
    let n = 0;
    for (const bone of bones) { if (!bone) continue; if (this.bones[n] !== bone) return false; n++; }
    return n === this.bones.length;
  }
}
