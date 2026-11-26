/**
 * I-154 batch 4: the stage members of rows 26 猜拳, 27 递东西 and 28 牵手、拉钩、击掌 for the Unbound window stage, between the to-do list
 * (not-yet.ts; since batch 6 the music members, window-stage-music.ts) and the stage (window-stage.ts), so the stage file stays small. The performers are in WindowGames (window-games.ts); this
 * answers the wiring's calls with the stage's camera and size, the old stage's way (src/stage/mmd/her-life.ts).
 */
import type { Bone, Camera, Scene, WebGLRenderer } from 'three';
import type { StageSurface } from '../../stage';
import { renderGivePicture } from '../../initiative';
import { WindowStageMusic } from './window-stage-music';
import type { WindowGames } from './window-games';

type S = StageSurface;

export abstract class WindowStageGames extends WindowStageMusic {
  protected abstract readonly games: WindowGames;
  /** The window's camera and size now, and whether she is shown (not disposed, the window shown, the page visible). */
  protected abstract gameView(): { camera: Camera; width: number; height: number; shown: boolean };
  /** What a picture of her is rendered with (her model's head, height and centre), or null without a model. */
  protected abstract pictureParts(): { renderer: WebGLRenderer; scene: Scene; camera: Camera; head: Bone | null; height: number; centerX: number } | null;

  /** I-087: the abstract "where your hand is" input (a pose source can replace the mouse). */
  get handInput(): S['handInput'] { return this.games.hands.input; }
  /** G1 猜拳: the host's game view (null when it is over); her arm and face ease in and out by themselves. */
  setRps(view: Parameters<S['setRps']>[0]): void { this.games.setRps(view ?? null); }
  /** I-086: an offer; `onOutcome` hears taken / not-taken / interrupted once (the overlay answers the host with it). */
  startGive(cue: Parameters<S['startGive']>[0], onOutcome?: Parameters<S['startGive']>[1]): void { this.games.startGive(cue, onOutcome); }
  takeGive(): boolean { return this.games.takeGive(); }
  withdrawGive(outcome: Parameters<S['withdrawGive']>[0] = 'interrupted'): void { this.games.withdrawGive(outcome); }
  giveAnchor(): ReturnType<S['giveAnchor']> { const v = this.gameView(); return this.games.giveAnchor(v.camera, v.width, v.height); }
  /** I-086 送你一张图: one frame of her as she is now (with what she holds), rendered here; never while hidden. Never the camera or the screen. */
  captureGivePicture(maxChars = 260_000): string | null {
    const parts = this.gameView().shown ? this.pictureParts() : null;
    if (!parts) return null;
    try { return renderGivePicture({ renderer: parts.renderer, scene: parts.scene, head: parts.head, height: parts.height, centerX: parts.centerX, hide: [], maxChars }); }
    finally { parts.renderer.render(parts.scene, parts.camera); }
  }
  /** I-087: she reaches toward your mouse; false while the game or an offer holds her arm. */
  startHands(cue: Parameters<S['startHands']>[0]): boolean { return this.games.startHands(cue); }
  handsCommand(command: Parameters<S['handsCommand']>[0]): void { this.games.handsCommand(command); }
  handsState(): ReturnType<S['handsState']> { return this.games.handsState(); }
  handsAnchor(): ReturnType<S['handsAnchor']> { const v = this.gameView(); return this.games.handsAnchor(v.camera, v.width, v.height); }
  handsNear(): boolean { return this.games.handsNear(this.gameView().camera); }
}
