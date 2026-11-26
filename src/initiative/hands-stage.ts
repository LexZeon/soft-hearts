/**
 * I-087 牵手、拉钩、击掌 on the stage: the reach (hand-reach.ts) and its abstract input (hand-input.ts) as one layer, so
 * src/stage/MmdStage.ts only adds wiring. The stage gives it the latest cursor reading (the same 100 ms reading the gaze follows) and
 * whether 跟随鼠标 is on; a pose source can replace the mouse (`input.use`) without anything else changing.
 */
import type { Bone, Camera, SkinnedMesh } from 'three';
import type { LifeActivity } from '../stage';
import { HandInput } from '../senses';
import { HandReach, type HandReachCue, type HandReachState } from './hand-reach';
import type { HandsStageCommand } from '../../shared/behaviors/hands/session';

export class HandsStageLayer {
  readonly input = new HandInput();
  readonly reach = new HandReach();

  get active(): boolean { return this.reach.active; }

  /** One display frame, before the writers: the reading of "where your hand is" and the reach's own clocks. */
  frame(delta: number, owner: SkinnedMesh | null, pointer: Readonly<{ x: number; y: number }> | null, follow: boolean): void {
    this.reach.frame(delta, owner, this.input.frame(pointer, follow));
  }

  applyPose(port: { remember(bone: Bone): void }, camera: Camera | null): void { this.reach.applyPose(port, camera); }
  activity(base: LifeActivity | null): LifeActivity | null { return this.reach.activity(base); }

  start(cue: HandReachCue): void { this.reach.start(cue); }
  command(command: HandsStageCommand): void {
    if (command === 'hold') this.reach.hold();
    else if (command === 'touch') this.reach.touch();
    else if (command === 'squeeze') this.reach.squeeze();
    else this.reach.release();
  }
  anchor(camera: Camera | null, width: number, height: number) { return this.reach.anchor(camera, width, height); }
  near(camera: Camera | null, owner: SkinnedMesh | null): boolean { return this.reach.near(this.input.read(), camera, owner); }
  state(): HandReachState { return this.reach.getState(); }
}
