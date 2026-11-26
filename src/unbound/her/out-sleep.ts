/**
 * I-154 follow-up, batch G (docs/claude/2026-11-21-unbound-full-BG.md): her sleep out in full-screen Unbound, the window's own two layers
 * (../window-mode/window-sleep.ts WindowSleep: the doze as goals, the sleep body as the figure's overlay), unchanged. What is different out
 * here, where she stands in the world:
 *  - the sleep body plans in her model's own space, seen from the world camera (window-sleep.ts `space`): the pose that keeps her head well
 *    in view is chosen from where she really stands, and her desk or pillow stands at world scale beside her, moving with her place;
 *  - she does not walk while she is down: while the sleep body holds her, her gait's goal is held where she is (her own life, a beat or a
 *    scene change cannot make a lying body slide), and her own life is told to give way;
 *  - the sleep body does not take her while she walks (it yields until she stands, then eases in), nor while she plays or is pulled;
 *  - where she stands the floor may be below the screen (near the screen the world camera does not see low enough for a desk or a pillow):
 *    once she is falling asleep and no pose fits from there, she walks farther back, toward the back of her room, and stops at the first
 *    place one fits (as far as SLEEP_SPOT.maxDepthM; none there either: she dozes standing where she got to);
 *  - once she is up again she walks back to her place (the scene's), if she is not there.
 * The host already keeps her own life and the peek away while she is asleep, and refuses a pull then (electron/unbound/life.ts,
 * peek.ts, host.ts). Pure of the DOM: out-page.ts wires it; tests run it on the real frame loop.
 */
import { Group, type Object3D, type PerspectiveCamera } from 'three';
import type { HerOutFace } from './out-face';
import type { MoodView } from '../../../shared/mood';
import type { LivelinessLib } from '../../stage';
import type { StandardBody } from '../model/standard-body';
import { standardSleepBones } from '../model/standard-face';
import { hasNeck, type WindowModelMeasure } from '../window-mode/window-model';
import { WindowSleep, type WindowSleepFrame } from '../window-mode/window-sleep';

/** The figure as her sleep needs it (UnboundFigure). */
export interface SleepFigure {
  readonly mesh: import('three').SkinnedMesh;
  readonly head: import('three').Bone | null;
  readonly rootM: { x: number; z: number };
  followTo(point: { x: number; z: number }): void;
  place(placement: { xM: number; depthM: number }): void;
}
export interface HerSleepInput {
  view: MoodView | null;
  /** The face's owners (window-face.ts owners()): the card's 能做睡姿, a picked head motion, a hand on her head or cheek, a touch. */
  owners: { sleepCapable: boolean; head: boolean; touched: boolean; contact: boolean };
  /** A pull, a walk back to the face station or a peek holds her. */
  adjusting: boolean;
  /** A game, an offer or her reach holds her arms (the sleep body yields; the game holds her head: the doze yields). */
  playing: boolean; gameHead: boolean;
  /** She walks (the sleep body waits until she stands). */
  walking: boolean;
  /** She speaks, waits for a reply, her face prepares an expression. */
  busy: boolean;
  camera: PerspectiveCamera; width: number; height: number;
  /** The world scene her desk or pillow stands in (null: none, the doze only). */
  scene: Object3D | null;
}

/** This frame's inputs from her face and the page (out-page.ts passes them; the frame-loop test passes the same). */
export function sleepInput(face: HerOutFace, view: MoodView | null, page: { adjusting: boolean; playing: boolean; gameHead: boolean; walking: boolean; speaking: boolean; thinking: boolean },
  world: { camera: PerspectiveCamera; width: number; height: number; scene: Object3D | null }): HerSleepInput {
  const owners = face.face.owners();
  return { view, owners, adjusting: page.adjusting, playing: page.playing, gameHead: page.gameHead, walking: page.walking,
    busy: page.speaking || page.thinking || face.face.preparing, camera: world.camera, width: world.width, height: world.height, scene: world.scene };
}

/** Where she goes to sleep when no pose fits where she stands: straight back, no farther than this (m); her walk's brake lookahead (s). */
export const SLEEP_SPOT = Object.freeze({ maxDepthM: 12, stopLookaheadS: 0.8 });
const DOWN_PHASES: ReadonlySet<string> = new Set(['falling-asleep', 'asleep', 'micro-awake']);

export class HerOutSleep {
  readonly sleep: WindowSleep;
  private figure: SleepFigure | null = null;
  /** While the sleep body holds her: where her gait's goal is held. */
  private hold: { x: number; z: number } | null = null;
  /** She is walking back to find a place where a sleep pose fits. */
  private seeking = false;
  /** Her place is owned by her sleep (held, or walking to a sleep spot) last frame: once that ends she walks back home. */
  private owned = false;
  private last: { input: HerSleepInput; frame: WindowSleepFrame } | null = null;
  private lastRoot: { x: number; z: number } | null = null;
  private velocity = { x: 0, z: 0 };
  private readonly noScene = new Group();

  constructor(random: () => number = Math.random) { this.sleep = new WindowSleep(null, random); }
  /** The sleep body's code (src/stage/sleep-body.ts), loaded on demand by the page; until then the doze only. */
  load(lib: Pick<LivelinessLib, 'SleepBody' | 'sleepBodyInput'>): void { this.sleep.load(lib); }
  setHabit(value: unknown): void { this.sleep.setHabit(value); }

  /** A new model (still at rest; `measure` taken before her figure was made): she starts upright on it. */
  attach(figure: SleepFigure | null, measure?: WindowModelMeasure, standard?: StandardBody | null): void {
    this.figure = figure; this.hold = null; this.seeking = false; this.owned = false; this.last = null; this.lastRoot = null;
    this.sleep.attach(figure && measure ? { mesh: figure.mesh, profile: measure.profile ?? (standard ? standardSleepBones(standard) : null), baseY: measure.bounds.baseY,
      hasNeck: hasNeck(figure.mesh, figure.head) } : null);
  }
  /** Her place is held now (the page does not hand her a new place while she is down). */
  get holdsPlace(): boolean { return this.hold !== null; }
  /** She is walking back to a place where a sleep pose fits (tests, the developer view). */
  get seekingSpot(): boolean { return this.seeking; }

  frame(dt: number, input: HerSleepInput): WindowSleepFrame {
    const figure = this.figure, view = input.view, o = input.owners;
    const frame = this.sleep.frame(dt, { view, capable: o.sleepCapable, headOwned: o.head || input.adjusting || input.gameHead,
      yielding: input.adjusting || input.playing || input.walking, touched: o.touched,
      busy: o.contact || input.busy || input.adjusting || (!!view && view.snapshot?.phase !== 'idle'),
      camera: input.camera, lift: 0, width: input.width, height: input.height, scene: input.scene ?? this.noScene, space: figure?.mesh });
    if (figure) {
      const root = figure.rootM, last = this.lastRoot;
      if (last && dt > 0) { const k = Math.min(1, dt / 0.15); this.velocity.x += ((root.x - last.x) / dt - this.velocity.x) * k; this.velocity.z += ((root.z - last.z) / dt - this.velocity.z) * k; }
      this.lastRoot = { ...root };
    }
    this.last = { input, frame };
    return frame;
  }

  /**
   * After the frame's owners and before her body's frame, the last word on her gait's goal this frame:
   *  - the sleep body holds her (`holding`): the goal stays where she is;
   *  - falling asleep with no pose that fits from here (the sleep body says so): she walks straight back, and brakes at the first place one
   *    fits; not while a pull, a peek or a game has her;
   *  - once neither (she is up again, or woke before she got there): she walks back to `home` (her place).
   * Returns whether her sleep owns her place now (her own life is told to give way then).
   */
  holdPlace(holding: boolean, home: { xM: number; depthM: number } | null): boolean {
    const figure = this.figure, last = this.last;
    if (!figure) { this.hold = null; this.seeking = false; this.owned = false; return false; }
    if (holding) {
      this.seeking = false;
      this.hold ??= { ...figure.rootM };
      figure.followTo(this.hold);
    } else {
      this.hold = null;
      const state = this.sleep.getState() as { noFit?: boolean; choice?: string } | null;
      const down = !!last && DOWN_PHASES.has(String(last.input.view?.fatigue?.phase ?? '')) && last.input.owners.sleepCapable;
      const free = !!last && !last.input.adjusting && !last.input.playing;
      const fits = state?.noFit === false && !!state.choice && state.choice !== 'stand';
      if (this.seeking && (!down || !free)) this.seeking = false;
      else if (this.seeking && fits) {
        this.seeking = false;
        const ahead = SLEEP_SPOT.stopLookaheadS, root = figure.rootM; // a brake just ahead along her way, never a turn back
        figure.followTo({ x: root.x + this.velocity.x * ahead, z: root.z + this.velocity.z * ahead });
      } else if (!this.seeking && down && free && state?.noFit === true && -figure.rootM.z < SLEEP_SPOT.maxDepthM - 0.25) this.seeking = true;
      if (this.seeking) figure.followTo({ x: figure.rootM.x, z: -SLEEP_SPOT.maxDepthM });
    }
    const owns = holding || this.seeking || (!!last && this.owned && this.stillDown());
    if (this.owned && !owns && home) figure.place(home);
    this.owned = owns;
    return owns;
  }

  /** Between braking at her sleep spot and the sleep body taking her: still hers (she is about to go down there). */
  private stillDown(): boolean {
    const last = this.last;
    return !!last && DOWN_PHASES.has(String(last.input.view?.fatigue?.phase ?? '')) && last.input.owners.sleepCapable && !last.input.adjusting && !last.input.playing;
  }
}
