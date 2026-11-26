/**
 * I-154 batch 6: her own life (row 33), music (row 37) and tears (row 25) in the companion window, composed in one place so the stage
 * (window-stage.ts) only wires it and the Gene tests run exactly this. Each piece is its own file: window-her-life.ts, window-music.ts,
 * window-tears.ts (with window-blush.ts painting the tears); the held pose and the dance are written at the figure's mixer level under
 * batch 5's clips (window-under-layer.ts).
 *
 * One frame, before the games: the music (her choice, the song reactions, who the dance yields to), then her own life's activity with its
 * owners (the old stage's gates on this window's state, window-motions.ts lifeGates, plus the window's: a stretch or wave reaction, the
 * games' arms). The activity goes to the games as their base; the nod and whether she dances go to procedural life. After her face: the
 * crying timeline and the tear surface.
 */
import type { AnimationClip, Bone, SkinnedMesh } from 'three';
import type { LifeActivity, StageOptions } from '../../stage';
import type { UnboundFigure, FigureMotionLayer } from '../figure';
import { figureBone } from '../model/figure-bones';
import type { HerLifeMotionResource } from '../../../shared/stage';
import type { MoodView } from '../../../shared/mood';
import { loadLibraryClip, type WindowMotionEnv } from './window-motions';
import type { WindowStageHost } from './host-ports';
import type { StageMotionRetarget } from '../../actions';
import type { VmdDataTransform } from '../../foundation/vmd';
import { WindowHerLife, windowHerLifeGates, windowHerLifeLoader } from './window-her-life';
import { WindowMusic, type WindowMusicEnv, type WindowMusicPorts } from './window-music';
import { WindowCrying } from './window-tears';
import { WindowUnderLayer } from './window-under-layer';
import type { WindowBlush } from './window-blush';
import type { WindowFace } from './window-face';

/**
 * The dance's owners from the same state as her motions' gates (the old stage's syncMusicSuppression inputs; the window adds a pull).
 * "A picked head motion" is her motions' own rule (window-motions.ts manualHead): the clip moves her head AND it is a picked pose or gesture.
 * Her default stand (the reviewed bundled pose the window plays when none is picked, since 2026-11-21) moves her head a little too; read as
 * a picked one it held the dance and the nod back for ever (2026-11-26, docs/claude/2026-11-26-window-dance.md).
 */
export function musicEnvOf(env: WindowMotionEnv): WindowMusicEnv {
  const b = env.blocks;
  return { view: env.view, shown: env.shown, speaking: env.speaking, adjusting: env.adjusting, behaviorBlocked: env.behaviorBlocked,
    touched: env.pat || env.feeding || env.pinch || env.hover || env.pulled, manualHead: b.head && (b.manualPose || b.manualGesture), asleep: env.asleep };
}

export interface WindowOwnLifeModel {
  figure: UnboundFigure;
  /** Batch 5's clips (window-motions.ts), written over the held pose and the dance. */
  clips: FigureMotionLayer | null;
  /** The host's grant for a held pose (host-ports.ts), this model's library clip loader and fit check. */
  resolve(motionId: string, token: string): Promise<HerLifeMotionResource>;
  load(url: string, mesh: SkinnedMesh): Promise<AnimationClip>;
  unfit(sha256: string): boolean;
  token(): string | null;
}

export interface WindowOwnLifeFrame {
  /** Her own life's activity: the games' base (null: none). */
  activity: LifeActivity | null;
  /** The nod and the listening look for procedural life, and whether the dance holds her. */
  music: { beat: { headX: number; headZ: number; bodyZ: number } | null; dancing: boolean };
}

/**
 * The stage's composition: the music's records and the card's taste and song memory are the stage options' (the old stage's own), the song
 * reactions perform on her speaking-accent layer, and the dance starting hands an automatic body motion back (`danceStarts`).
 */
export function windowOwnLifeFor(options: Pick<StageOptions, 'onMusicReaction' | 'onMusicTier' | 'onMusicVerdict' | 'musicTaste' | 'songMemory'>,
  face: Pick<WindowFace, 'musicFace' | 'hasSpeechFace'>, danceStarts: () => void): WindowOwnLife {
  return new WindowOwnLife({ face: () => face.musicFace(), hasFace: () => face.hasSpeechFace, told: (intent, scale) => options.onMusicReaction?.(intent, scale),
    tier: (tier, score) => options.onMusicTier?.(tier, score), verdict: flip => options.onMusicVerdict?.(flip), taste: () => options.musicTaste?.(),
    memory: () => options.songMemory, danceStarts });
}

export class WindowOwnLife {
  readonly herLife: WindowHerLife;
  readonly music: WindowMusic;
  readonly crying = new WindowCrying();
  private readonly under: WindowUnderLayer;
  private figure: UnboundFigure | null = null;

  /** `herLifeTiming`: tests only (an instant timing shows what the easing is worth). */
  constructor(musicPorts: WindowMusicPorts, herLifeTiming?: ConstructorParameters<typeof WindowHerLife>[0]) {
    this.herLife = new WindowHerLife(herLifeTiming);
    this.music = new WindowMusic(musicPorts);
    this.under = new WindowUnderLayer([this.herLife, this.music]);
  }

  /** A model (after her motions were attached: their clips go over this), or none. */
  attach(model: WindowOwnLifeModel | null): void {
    this.under.forget();
    this.figure?.setMotionLayer(null);
    this.figure = model?.figure ?? null;
    this.crying.stop();
    if (!model) { this.herLife.setLoader(null); this.music.attach(null); return; }
    const mesh = model.figure.mesh;
    this.herLife.setLoader(windowHerLifeLoader({ mesh: () => this.figure === model.figure ? mesh : null, token: () => model.token(),
      resolve: (id, token) => model.resolve(id, token), load: (url, owner) => model.load(url, owner), unfit: sha => model.unfit(sha) }));
    const bone = (names: string[]): Bone | null => figureBone(mesh, names);
    // ui-zh-ok: MMD bone names inside the model file, not interface text
    this.music.attach({ center: bone(['センター', 'center']), chest: bone(['上半身2', 'chest', '上半身']), head: model.figure.head, height: model.figure.heightUnits });
    model.figure.setMotionLayer(this.under.over(model.clips));
  }

  /**
   * The stage's model: the held pose's grant through the engine's port (host-ports.ts), this model's library clip loader with its retarget
   * transform, and its fit check (a motion the retarget hides for this skeleton is not held).
   */
  attachModel(figure: UnboundFigure, clips: FigureMotionLayer | null, host: Pick<WindowStageHost, 'resolveHerLifeMotion'>, token: () => string | null,
    transform: VmdDataTransform | undefined, retarget: Pick<StageMotionRetarget, 'fitOf'> | null): void {
    this.attach({ figure, clips, token, resolve: (id, t) => host.resolveHerLifeMotion(id, t), load: (url, owner) => loadLibraryClip(url, owner, transform),
      unfit: sha => retarget?.fitOf(sha)?.status === 'hidden' });
  }

  /** One frame, before the games (see the top). `env`: her motions' environment this frame; `lifeGates`: their gates of her own life. */
  frame(delta: number, input: { owner: object | null; env: WindowMotionEnv; lifeGates: Parameters<typeof windowHerLifeGates>[0]; reactionHoldsBody: boolean;
    armsHeld: boolean; nowMs: number }): WindowOwnLifeFrame {
    this.music.frame(delta, musicEnvOf(input.env));
    const activity = this.herLife.frame(delta, { owner: input.owner, view: input.env.view, nowMs: input.nowMs,
      gates: windowHerLifeGates(input.lifeGates, { reactionHoldsBody: input.reactionHoldsBody, armsHeld: input.armsHeld }) });
    return { activity, music: { beat: this.music.beat, dancing: this.music.moving } };
  }

  /** After her face: the crying timeline (its own gates) and the tear surface on her face (none without a painter: a VRM). */
  tears(delta: number, painter: WindowBlush | null, input: { view: MoodView | null; adjusting: boolean; faceBlocked: boolean; nowMs: number;
    preview?: { tears: number; tearsMs: number } }): void {
    const shown = this.crying.frame(delta, { view: input.view, visible: true, adjusting: input.adjusting, faceBlocked: input.faceBlocked,
      supported: painter?.tearsSupported === true, nowMs: input.nowMs });
    // Batch 7 (row 42 试一下 能流泪): the preview's own amount and clock, unless a real cry shows more (the old stage's rule).
    const preview = input.preview, previewShown = !!preview && preview.tears > shown.amount;
    painter?.updateTears(previewShown ? preview!.tears : shown.amount, previewShown ? preview!.tearsMs : shown.elapsedMs);
  }

  /** The window is not drawn: the music resets (nothing on screen), a running cry stops (the timeline's own rule: not visible). */
  notShown(painter: WindowBlush | null): void {
    this.music.notShown();
    if (this.crying.amount > 0) { this.crying.stop(); painter?.updateTears(0, 0); }
  }

  /** Something of these moves now (the frame pace stays full). */
  get moving(): boolean {
    const life = this.herLife.getState();
    // Her own life easing (its presence or a cross-fade) or a held pose shown; the dance or the nod; a cry.
    return this.music.active || this.music.moving || this.crying.amount > 0
      || (!!life && ((life.presence > 0 && (life.presence < 1 || life.blend < 1)) || (life.pose?.weight ?? 0) > 0 || life.lookUp > 0));
  }
}
