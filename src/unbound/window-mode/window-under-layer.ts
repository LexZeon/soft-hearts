/**
 * I-154 batch 6: what lies under her one-shot clips at the figure's mixer level (UnboundFigure.setMotionLayer), in the companion window:
 * her own life's held pose (row 33, window-her-life.ts) and the music dance (row 37, window-music.ts). The figure takes one motion layer;
 * this is it, with the clips of batch 5 (window-clips.ts) as the layer over it.
 *
 * Every frame (the figure calls these): restore() puts back the clips' writes, then its own (last written first) → beforeUpdate() (the
 * clips' automatic body motion weights) → the figure's mixer → frame(): the writers here, right over the mixer's pose, then the clips over
 * them → the figure's residuals (breath, the look, the idle's springs, the arm reach), the pull, her feet and IK, the grants, physics.
 * So whatever the figure adds rides on these writes; the user's pull and the games' arms are written after them and win; the clips' hand-
 * back bridge (batch 5) carries a gesture back onto this pose, not onto the bare mixer.
 *
 * The writes here are offsets the old stage writes at the same place (its program layer: the held pose's blend, the dance's small
 * rotations and the bounce); each writer eases itself (the held pose by its critically damped weight, the dance by its presence and its
 * release), so nothing here starts or stops in one frame. No allocation per frame once a bone has been seen.
 */
import { Euler, Quaternion, Vector3, type Bone } from 'three';
import type { FigureMotionLayer } from '../figure';

/** How a writer touches a bone: every write remembers it first, so it is put back before the next mixer update. */
export interface UnderPort {
  /** The old stage's program-layer blend: slerp toward `target` by `weight`. */
  blend(bone: Bone, target: Quaternion, weight: number): void;
  /** The old stage's rotateBone: post-multiplied in the bone's own frame (Euler YXZ, rad). */
  rotate(bone: Bone, x: number, y: number, z: number): void;
  /** Added to the bone's position (model units). */
  move(bone: Bone, dx: number, dy: number, dz: number): void;
}
export interface UnderWriter {
  write(port: UnderPort, delta: number): void;
  /** 0..1: how much of her arms it holds now (the figure keeps the arms it would lower itself up by as much). */
  readonly armsHeld: number;
}

interface Memo { quaternion: Quaternion; position: Vector3; held: boolean }

export class WindowUnderLayer implements FigureMotionLayer {
  private readonly memo = new Map<Bone, Memo>();
  private readonly euler = new Euler();
  private readonly turn = new Quaternion();
  private top: FigureMotionLayer | null = null;
  readonly port: UnderPort = {
    blend: (bone, target, weight) => { this.remember(bone); bone.quaternion.slerp(target, weight); },
    rotate: (bone, x, y, z) => {
      if (!x && !y && !z) return;
      this.remember(bone); bone.quaternion.multiply(this.turn.setFromEuler(this.euler.set(x, y, z, 'YXZ')));
    },
    move: (bone, dx, dy, dz) => { if (!dx && !dy && !dz) return; this.remember(bone); bone.position.x += dx; bone.position.y += dy; bone.position.z += dz; },
  };

  constructor(private readonly writers: readonly UnderWriter[]) {}

  /** The layer written over these (batch 5's clips), or null; returns this for the figure. */
  over(layer: FigureMotionLayer | null): this { this.top = layer; return this; }

  get armsHeld(): number {
    let held = this.top?.armsHeld ?? 0;
    for (const writer of this.writers) held = Math.max(held, writer.armsHeld);
    return Math.min(1, Math.max(0, held));
  }

  restore(): void {
    this.top?.restore();
    for (const [bone, memo] of this.memo) if (memo.held) { bone.quaternion.copy(memo.quaternion); bone.position.copy(memo.position); memo.held = false; }
  }

  beforeUpdate(delta: number): void { this.top?.beforeUpdate(delta); }

  frame(delta: number): void {
    for (const writer of this.writers) writer.write(this.port, delta);
    this.top?.frame(delta);
  }

  /** A model goes away: nothing of the last one is put back onto a new one. */
  forget(): void { this.memo.clear(); this.top = null; }

  private remember(bone: Bone): void {
    let memo = this.memo.get(bone);
    if (!memo) this.memo.set(bone, memo = { quaternion: new Quaternion(), position: new Vector3(), held: false });
    if (memo.held) return;
    memo.quaternion.copy(bone.quaternion); memo.position.copy(bone.position); memo.held = true;
  }
}
