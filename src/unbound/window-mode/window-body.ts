/**
 * I-154 step 1: her body in the companion window, with Unbound's engine (docs/claude/2026-11-19-unbound-in-window.md). No DOM, no WebGL:
 * the stage (window-stage.ts) owns the canvas and the camera; this owns what moves, so the real frame loop can be measured in the
 * node tests at 60 and 30 fps (tests/unbound-window-engine.test.ts).
 *
 * One frame, in order: the window's own life (window-life.ts: gaze, blinks, a pat) hands its targets to Unbound's idle layer
 * (unbound-idle.ts), which lays the learned idle under them by weight and gives the figure one set of targets; her mouth is put
 * back; her frame (figure.ts: motion, personal-feel filter, gait and contact, springs, IK, physics); her mouth on top
 * (mouth.ts). She never walks here: the figure's place stays where it was made (window mode is "不走动").
 * Batch 2: her face (window-face.ts) comes in as goals: its lids and look go to the window's life, its head adds to the head goal, its
 * expression slots and named shapes go to the figure's eased slot springs (bound to this model's morphs by bindFace).
 */
import type { Bone } from 'three';
import type { MorphSlot } from '../../../shared/actions';
import type { UnboundFigure } from '../figure';
import { figureBone } from '../model/figure-bones';
import { UnboundMouth } from '../mouth';
import { UnboundIdleLayer, idleWanted } from '../motion/unbound-idle';
import type { LearnedIdle } from '../motion/learned-idle';
import { STYLE_GROUP_BONES, type StyleGroup } from '../style-filter';
import { WindowLife, type WindowLifeInput } from './window-life';
import type { StandardBody } from '../model/standard-body';
import type { WindowFaceFrame } from './window-face';
import { layFace } from '../her/face-goals';
import { composeFeedMouth } from '../../../shared/behaviors/part-mix/mouth'; // I-175: the companion's feeding rule, kept in part-mix (the old stage goes, I-176)
import { withLifeOverlay, type WindowLifeOverlay } from './window-arbiter';

export type WindowBodyInput = Omit<WindowLifeInput, 'dt' | 'face'> & {
  face?: WindowFaceFrame | null;
  /**
   * Batch 3 (row 35, 睡着的身体): a layer that writes her whole body after her feet are solved and before physics (the sleep body:
   * kneeling, lying down; window-sleep.ts). Every bone it touches goes through `remember` (put back before her next frame).
   */
  overlay?: ((remember: (bone: Bone) => void, delta: number) => void) | null;
  /** I-170: a talk signal is on this frame: the idle's own head calms (unbound-idle.ts; eased, with a linger). */
  talking?: boolean;
  /** I-174 item 1: her own small things from full-screen's arbiter and player (window-arbiter.ts): offsets over these goals, the idle's clock. */
  life?: WindowLifeOverlay | null;
};

const STYLE_GROUPS = Object.keys(STYLE_GROUP_BONES) as StyleGroup[];

export class WindowBody {
  readonly life: WindowLife;
  readonly idle: UnboundIdleLayer;
  readonly mouth: UnboundMouth | null;
  /** Her main bones (centre, upper body, head, arms), as the old stage watches them for its frame pace (window-pace.ts). */
  readonly paceBones: readonly (Bone | null)[];
  private styleValue = 0;

  /**
   * `standard`: a model that is not MMD (I-152 step 2, src/unbound/model/): the figure drives its standard skeleton, and each frame
   * ends by putting that pose and face onto the model (present). null for an MMD model (the figure drives its own bones).
   */
  constructor(readonly figure: UnboundFigure, makeIdle: (heightM: number) => Promise<LearnedIdle | null>, random: () => number = Math.random,
    readonly standard: StandardBody | null = null) {
    this.life = new WindowLife(random);
    this.idle = new UnboundIdleLayer(makeIdle);
    this.idle.attach(figure, figure.heightM);
    this.mouth = UnboundMouth.forMesh(figure.mesh);
    // ui-zh-ok: MMD bone names inside the model file, not interface text
    this.paceBones = [['センター', 'center'], ['上半身2', '上半身', 'spine'], ['頭', 'head'], ['左腕', 'LeftArm'], ['右腕', 'RightArm']].map(names => figureBone(figure.mesh, names));
  }

  /** The voice is sounding (a reply, any source). Her mouth follows it through the companion's hold and flap. `fillerShape`: a short sound of hers in a call sounds (its mouth scale), or null. */
  setSpeaking(on: boolean, fillerShape: number | null = null): void { this.mouth?.speaking(on); this.mouth?.fillerSound(fillerShape); }

  /** Unbound's personal-feel filter (0 = the motion exactly as authored .. 1); every group eases there, never pops. */
  setStyle(value: number): void {
    const next = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.styleValue = next;
    for (const group of STYLE_GROUPS) this.figure.styleFilter.setWeight(group, next);
  }
  get style(): number { return this.styleValue; }

  /** Batch 2: her expression slots bound to this model's own morphs (window-face-rig.ts slotBindings; -1 = none, never a guess). */
  bindFace(map: Partial<Record<MorphSlot, number>> | null): void { this.figure.setSlotMorphs(map); }

  frame(delta: number, input: WindowBodyInput, physicsDelta = delta): void {
    const figure = this.figure, face = input.face ?? null;
    // Her face's goals over the window's own life (head, upper body, neck and hips added; slots, named shapes, a beat's hands): the shared
    // rule both modes use (../her/face-goals.ts; full-screen lays them over whoever drives her there).
    const targets = { ...withLifeOverlay(layFace(this.life.frame({ ...input, dt: delta, face }), face), input.life), talking: input.talking === true };
    this.idle.wrap(figure).setPoseTargets(targets);
    this.idle.frame(delta, idleWanted({ performing: this.life.patted || face?.performing === true, walking: figure.walking, moving: figure.moving,
      stance: figure.report?.stance ?? 'both' }), input.life?.rate ?? 1);
    this.mouth?.restore();
    figure.setOverlay(input.overlay ?? null);
    figure.frame(delta, physicsDelta);
    // Row 23: a snack at her mouth composes with the speaking mouth (window-face.ts), by the companion's compositor.
    const feed = face?.mouth;
    this.mouth?.apply(delta, feed && (feed.value > 0 || feed.owner > 0) ? speaking => composeFeedMouth(speaking, feed.value, feed.owner) : null, figure); // I-175: on her face's base shape
    this.standard?.present(physicsDelta); // I-152 step 3: a VRM's springs step on the frame's real time, as the MMD physics does
  }

  /** Her first frame, before she is shown (the stage compiles the shaders on it): the figure at rest, onto the model. */
  settle(): void { this.figure.frame(0); this.standard?.present(); }

  dispose(): void { this.mouth?.reset(); this.figure.dispose(); this.standard?.dispose(); }
}

/**
 * The Unbound page next to this companion page, for reading the bundled idle (motion/bundled-idle.ts reads assets/bundled/ as seen from
 * the Unbound page and refuses any other page): the built companion page <app>/dist/index.html → <app>/dist/src/unbound/index.html;
 * the dev server's root → /src/unbound/index.html. Anything else: null (she gets the procedural idle).
 */
export function unboundPageBeside(petHref: string): string | null {
  let page: URL;
  try { page = new URL(petHref); } catch { return null; }
  if (page.protocol === 'file:' && /\/dist\/index\.html$/.test(page.pathname)) return new URL('src/unbound/index.html', new URL('./', page)).href;
  if (page.protocol === 'http:' && (page.pathname === '/' || page.pathname === '/index.html')) return new URL('/src/unbound/index.html', page).href;
  return null;
}
