/**
 * I-154 batch 6, row 33 她自己的生活 (docs/claude/2026-11-20-unbound-window-batch6.md): her own life in the companion window on Unbound's
 * engine. The host says what she is doing (MoodView.herLife, and a small need of hers: MoodView.herNeed); the companion's own performer
 * (src/stage/her-life-stage.ts HerLifeStage) runs unchanged and gives the same two things as on the old stage:
 *  1. an eased activity for procedural life (where she looks, a head tilt, her sway, the blink rhythm, a soft smile, 抬起头): it is the
 *     base the games' faces lay over (window-games.ts), then the reactions, then procedural life (window-proc-life.ts), whose output is
 *     goals the figure's springs carry;
 *  2. an optional held pose from a library motion (thinking: a hand to her chin; sleepy: a slumped upper body), written at the figure's
 *     mixer level (window-under-layer.ts) by the performer's own critically damped weight, so the figure's look, breath and idle ride on
 *     it, and the user's pull, the games' arms and batch 5's clips are written after it.
 *
 * Not the Unbound page's life (src/unbound/life/player.ts): that one is host-driven and walks her about the screen world; here she never
 * walks (window mode is 不走动) and stays inside the window. The host's grant for a held pose comes through host-ports.ts.
 *
 * The owners (windowHerLifeGates): the old stage's (the user here: typing, speech, a reply, a touch or a pull, a window or camera move, a
 * chat gesture, a show, music; a higher owner of her body: a picked pose or motion, an automatic body motion, her action, a stretch or
 * wave reaction; asleep), plus one of this window's: the game, an offer or her reach holding her arms also takes the held pose.
 */
import type { AnimationClip, SkinnedMesh } from 'three';
import type { HerLifeClipLoader, HerLifeStage, HerLifeStageGates, LifeActivity, LivelinessLib } from '../../stage';
import { herNeedVisibility, type MoodView } from '../../../shared/mood';
import type { HerLifeMotionResource } from '../../../shared/stage';
import type { UnderPort, UnderWriter } from './window-under-layer';

/** What this window adds to the old stage's owners of her own life. */
export interface WindowHerLifeExtras {
  /** A pose reaction's stretch or wave holds her shoulders (the old stage's poseReaction.holdsBody). */
  reactionHoldsBody: boolean;
  /** The game, an offer or her reach holds her arms (window-games.ts armsHeld; a pull is already the user here). */
  armsHeld: boolean;
}

/**
 * The old stage's gates for her own life on this window's state (`base`: window-motions.ts lifeGates, where the user here includes music
 * since batch 6), with the window's extras.
 */
export function windowHerLifeGates(base: HerLifeStageGates, extra: WindowHerLifeExtras): HerLifeStageGates {
  return {
    expressive: base.expressive,
    engaged: base.engaged,
    bodyOwned: base.bodyOwned || extra.reactionHoldsBody || extra.armsHeld,
    asleep: base.asleep,
    posture: base.posture,
  };
}

/**
 * The held pose's clip loader on this engine: the host's pinned grant (through the engine's port), the window's library clip loader (the
 * stage's VMD parser and this model's retarget), its fit check. Any refusal, or a model or conversation change while loading: no held pose
 * (the activity part stays), as on the old stage (her-life-stage.ts herLifeStageLoader, which reads window.desktop and so is not used here).
 */
export function windowHerLifeLoader(source: {
  mesh(): SkinnedMesh | null;
  token(): string | null;
  resolve(motionId: string, token: string): Promise<HerLifeMotionResource>;
  load(url: string, mesh: SkinnedMesh): Promise<AnimationClip>;
  unfit(sha256: string): boolean;
}): HerLifeClipLoader {
  return async id => {
    const mesh = source.mesh(), token = source.token();
    if (!mesh || !token) return null;
    const current = () => source.mesh() === mesh && source.token() === token;
    try {
      const resource = await source.resolve(id, token);
      if (!current() || resource?.motionId !== id || typeof resource.url !== 'string' || source.unfit(resource.sha256)) return null;
      const clip = await source.load(resource.url, mesh);
      return current() ? clip : null;
    } catch { return null; }
  };
}

export interface WindowHerLifeInput {
  /** Her mesh (a new one starts from neutral and drops the old clips); null: no model. */
  owner: object | null;
  view: MoodView | null;
  gates: HerLifeStageGates;
  /** Wall clock (ms), for a look-up's freshness. */
  nowMs: number;
}

export class WindowHerLife implements UnderWriter {
  private lib: Pick<LivelinessLib, 'HerLifeStage' | 'readScreenPlace'> | null = null;
  private performer: HerLifeStage | null = null;
  private loader: HerLifeClipLoader | null = null;
  private held = 0;

  /** `timing`: the performer's own (her-life-stage.ts HER_LIFE_TIMING) unless a test passes another (an instant one shows what easing is worth). */
  constructor(private readonly timing?: ConstructorParameters<LivelinessLib['HerLifeStage']>[1]) {}

  /** The performer's code (loaded on demand with procedural life: src/stage/index.ts loadLivelinessForEngine); until then: none. */
  load(lib: Pick<LivelinessLib, 'HerLifeStage' | 'readScreenPlace'>): void {
    if (this.lib) return;
    this.lib = lib;
    this.performer = new lib.HerLifeStage(id => this.loader ? this.loader(id) : Promise.resolve(null), this.timing);
  }
  /** This model's clip loader (windowHerLifeLoader), or null without a model. */
  setLoader(loader: HerLifeClipLoader | null): void { this.loader = loader; }
  get loaded(): boolean { return !!this.performer; }

  /** One frame, before the games' faces: her activity for procedural life (null: none, the base is neutral). */
  frame(delta: number, input: WindowHerLifeInput): LifeActivity | null {
    const performer = this.performer, lib = this.lib;
    if (!performer || !lib || !input.owner) { this.held = 0; return null; }
    const view = input.view;
    const activity = performer.frame(delta, { owner: input.owner, view: view?.herLife, need: view?.herNeed, nowMs: input.nowMs, gates: input.gates,
      // I-006 step 3: where her window is on its screen, only while she follows a video (the browser's own numbers; no sensing).
      screen: view?.herLife?.watch ? lib.readScreenPlace() : null,
      needVisibility: view?.herNeed ? herNeedVisibility(view.herNeed.mode, view.parameters?.weights, view.snapshot?.values) : 1 });
    const pose = performer.getState().pose;
    this.held = pose?.id === 'thinking' ? pose.weight : 0; // the hand at her chin holds her arms; the slump does not
    return activity;
  }

  /** The held pose at the mixer level (window-under-layer.ts), by the performer's own weight. */
  write(port: UnderPort): void { this.performer?.applyPose(port); }
  get armsHeld(): number { return this.held; }

  /** The performer's state (tests, the developer view), or null before it is loaded. */
  getState(): ReturnType<HerLifeStage['getState']> | null { return this.performer?.getState() ?? null; }
  /** The performer's own JSON readout (canvas data-her-life, window-readouts.ts), or null before it is loaded. */
  diagnostics(nowMs: number): string | null { return this.performer?.diagnostics(nowMs) ?? null; }
}
