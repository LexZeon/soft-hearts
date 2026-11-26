/**
 * I-154 follow-up, batch B (docs/claude/2026-11-21-unbound-full-BG.md): 猜拳, 递东西 and 牵手、拉钩、击掌 out in full-screen Unbound, from the
 * same set the companion window uses.
 *
 * The layer is the window's own (../window-mode/window-games.ts WindowGames: the old stage's three performers with their clocks; their arms
 * read as designs and handed to the engine's own arm reach, ArmReach 'aim'), unchanged. What is different out here:
 *  - the camera is the world camera (an off-axis frustum through the screen), and she may stand anywhere on her floor: the reach's "where
 *    your hand is" is the ray through your cursor met in front of her shoulder, as on the window; the anchors are projected through it;
 *  - her arms ride on whatever drives her body (her face lays the games' arms over the owners: face-goals.ts, hands from the face side);
 *  - her own life gives way while one is on (the page eases a running action out at once, the host's arbiter has 'play' one rank under a
 *    pull), so a walk brakes to a stop before her arm is up for long;
 *  - a pull still wins: it is written after the reach (figure.ts), and holding hands keeps her hand and arm for the hand (the shared gate,
 *    shared/behaviors/pull/gates.ts pullRefusal 'hand-busy'), as on the window;
 *  - no picture of her is taken here (送你一张图 is the companion window's; captureGivePicture answers null, so no card comes).
 * Pure of the DOM (out-play.ts mounts the companion window's overlays on the page and drives this as their stage).
 */
import { Vector3, type Bone, type Camera, type Object3D, type SkinnedMesh } from 'three';
import type { CollisionProxy } from '../../../shared/actions';
import type { HandsStageCommand } from '../../../shared/initiative';
import type { GiveStageCue, GiveStageOutcome, HandReachCue, HandReachState } from '../../initiative';
import type { RpsView } from '../../../shared/initiative';
import { WindowGames, type WindowGamesFrame } from '../window-mode/window-games';
import type { WindowFaceFrame } from '../window-mode/window-face';
import type { PoseTargets } from '../motion/generator';

/**
 * The games' arms and lean laid onto her face's goals out here: a side the games hold takes their arm (a beat's or an owner's hand on that
 * side hands over through the reach: down first, then the game's arm); the other side keeps her face's, else the owner's (a beat of hers
 * goes on with the free hand). The reach's lean is added to her upper body. Nothing of the games: the same object.
 */
export function withOutGames(face: WindowFaceFrame, games: WindowGamesFrame | null, owner: Pick<PoseTargets, 'hands'>): WindowFaceFrame {
  if (!games || (!games.hands.left && !games.hands.right && !games.torso.pitch && !games.torso.yaw)) return face;
  const side = (key: 'left' | 'right') => games.hands[key] ?? face.hands?.[key] ?? owner.hands?.[key] ?? null;
  return { ...face, hands: { left: side('left'), right: side('right') },
    torso: { pitch: face.torso.pitch + games.torso.pitch, yaw: face.torso.yaw + games.torso.yaw, roll: face.torso.roll + games.torso.roll } };
}

export interface GamesView { camera: Camera; width: number; height: number }
/** What the companion window's overlays call on their stage (src/initiative/RpsOverlay.ts, GiveOverlay.ts, HandsOverlay.ts). */
export interface GamesStage {
  setRps(view: RpsView | null): void;
  startGive(cue: GiveStageCue, onOutcome?: (id: string, outcome: GiveStageOutcome) => void): void;
  takeGive(): boolean;
  withdrawGive(outcome?: 'not-taken' | 'interrupted'): void;
  giveAnchor(): { x: number; y: number; r: number } | null;
  captureGivePicture(maxChars?: number): string | null;
  startHands(cue: HandReachCue): boolean;
  handsCommand(command: HandsStageCommand): void;
  handsAnchor(): { x: number; y: number; r: number } | null;
  handsState(): HandReachState | null;
  handsNear(): boolean;
  readonly handInput: WindowGames['hands']['input'];
}

const v = new Vector3();

export class HerOutGames {
  readonly games: WindowGames;
  private mesh: SkinnedMesh | null = null;
  private started = 0;
  /** Each start of a game, an offer or a reach (her own life gives way: out-page.ts). */
  onStart: (() => void) | null = null;

  /** The overlays' stage: the window's members, with the world camera and this window's size. */
  readonly stage: GamesStage;

  constructor(scene: Object3D | null, private readonly view: () => GamesView) {
    this.games = new WindowGames(scene);
    this.stage = this.makeStage();
  }

  /** A game, an offer or her reach still shows (her own life stays out; her learned idle steps aside). */
  get busy(): boolean { return this.games.busy; }
  /** Her hand is taken for holding hands (a press on her hand or arm is not a pull then: pullRefusal 'hand-busy'). */
  get handBusy(): boolean { return this.games.hands.active; }
  /** How many have started (tests). */
  get starts(): number { return this.started; }

  private makeStage(): GamesStage {
    const games = this.games;
    return {
      setRps: view => { const was = games.rpsActive; games.setRps(view ?? null); if (view && !was && view.phase !== 'invite' && view.phase !== 'aside') this.began(); },
      startGive: (cue, onOutcome) => { games.startGive(cue, onOutcome); this.began(); },
      takeGive: () => games.takeGive(),
      withdrawGive: outcome => games.withdrawGive(outcome ?? 'interrupted'),
      giveAnchor: () => { const view = this.view(); return games.giveAnchor(view.camera, view.width, view.height); },
      captureGivePicture: () => null, // 送你一张图 stays the companion window's (no picture of her leaves this page)
      startHands: cue => { const started = games.startHands(cue); if (started) this.began(); return started; },
      handsCommand: command => games.handsCommand(command),
      handsAnchor: () => { const view = this.view(); return games.handsAnchor(view.camera, view.width, view.height); },
      handsState: () => games.handsState(),
      handsNear: () => games.handsNear(this.view().camera),
      handInput: games.hands.input,
    };
  }

  /** A model was loaded (or none). */
  attach(mesh: SkinnedMesh | null): void { this.mesh = mesh; }

  /**
   * One frame, before her face is laid over the owners: the performers' clocks, their arms for the reach, their lean, their face (her
   * procedural life's activity, for whoever runs it). `pointer`: the cursor on this window (-1..1, y up), null when it is outside.
   */
  frame(delta: number, input: { pointer: { x: number; y: number } | null; proxy?: CollisionProxy | null }): WindowGamesFrame {
    return this.games.frame(delta, { mesh: this.mesh, pointer: input.pointer ?? { x: 0, y: 0 }, follow: !!input.pointer, camera: this.view().camera, proxy: input.proxy ?? null });
  }
  /** After her frame: the offer's prop in her hand, the click target on her hand. */
  after(): void { this.games.after(this.view().camera); }

  /** Her raised hand (wrist) and elbow on this window while she plays 猜拳 (the buttons sit below it), or undefined. */
  raisedHand(): { x: number; y: number; elbowX: number; elbowY: number } | undefined {
    const mesh = this.mesh;
    if (!mesh || !this.games.rpsActive) return undefined;
    // ui-zh-ok: the model's bone names (MMD; a VRM's standard skeleton uses them too)
    const wrist = bone(mesh, ['右手首', 'RightHand']), elbow = bone(mesh, ['右ひじ', 'RightLowerArm']), chest = bone(mesh, ['上半身2', '上半身', 'Chest', 'Spine']);
    if (!wrist || !elbow || !chest) return undefined;
    if (wrist.getWorldPosition(v).y < chest.getWorldPosition(new Vector3()).y) return undefined; // the arm is not up yet
    const w = this.screen(wrist), e = this.screen(elbow);
    return w && e ? { x: w.x, y: w.y, elbowX: e.x, elbowY: e.y } : undefined;
  }

  dispose(): void { this.games.dispose(); this.mesh = null; }

  private began(): void { this.started++; try { this.onStart?.(); } catch { /* the page's own */ } }
  private screen(target: Bone): { x: number; y: number } | null {
    const view = this.view();
    target.getWorldPosition(v).project(view.camera);
    if (![v.x, v.y].every(Number.isFinite) || v.z > 1) return null;
    return { x: (v.x + 1) / 2 * view.width, y: (1 - v.y) / 2 * view.height };
  }
}
const bone = (mesh: SkinnedMesh, names: readonly string[]) => mesh.skeleton.bones.find(b => names.includes(b.name)) ?? null;
