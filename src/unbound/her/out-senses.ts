/**
 * I-154 follow-up, batches D and F (docs/claude/2026-11-21-unbound-full-D.md): her reactions to you, her shows, and music out in full-screen
 * Unbound, from the companion window's own layers. (music too; everything stacks except a pull and her walk, which take the dance).
 *
 *  - Her reactions to your pose (yawn, stretch, wave, the glance when you come) and the 惊喜 / 害羞 show: the window's WindowReactions as it is
 *    (src/unbound/window-mode/window-reactions.ts), on the mood view's pose reading (MoodView.pose: the host drops it the moment camera
 *    sensing stops), her own yawn (哈欠捂嘴) and her drowsy yawn or waking stretch (the sleep body) laid over it, giving way to the owners the
 *    window's do (WindowMotions.lifeGates on full-screen's own state). Its face and head ride procedural life's activity, its chest,
 *    shoulders and waving arm the figure's overlay (all upper body: while she walks it plays over her gait).
 *  - Music: the window's WindowMusic (her choice, the dance, the nod and listening look, the song reactions) on the samples the host relays
 *    only while 和她一起听's dance is on (fused as the companion window fuses its sources, AudioDanceFusion; the host's null is off at once,
 *    frames silent for MUSIC_STALL_GRACE_MS are off, a shorter stall is not: MusicHearing, docs/claude/2026-11-22-music-cut-every-10s.md).
 *    The dance is the mixer level's writer under her clips (out-motions.ts), and it yields to what the window's yields to plus her walk (a pull is a touch there): "禁止" only stops a new dance, the one running fades by its presence.
 *  - 2026-11-24 (docs/claude/2026-11-24-music-nod-window.md): the user's music settings (strength, "一直跟着跳") come from the host as the
 *    companion window's do, and what her body does to the sound (WindowMusic.presence: a nod or a dance only while it shows) goes back as
 *    the fact 'stage-state', so while she is out the next turn's line says what this body does.
 *  - Her facts about these go back on one request (herFact), the kinds the companion window would tell; the host takes them only from the
 *    window she is shown in and writes each line once.
 * Nothing here senses, stores or asks for anything new.
 */
import type { Bone, SkinnedMesh } from 'three';
import { AudioDanceFusion, MUSIC_STALL_GRACE_MS, MusicHearing } from '../../senses';
import { loadMusicForEngine, type HerLifeStageGates, type LifeActivity } from '../../stage';
import { normalizeMusicSettings, parseAudioDanceFrame } from '../../../shared/senses';
import { HER_STATE_REPORT_CHECK_MS, HerStateReporter } from '../../mood';
import type { CollisionProxy } from '../../../shared/actions';
import type { ExpressionRecipe, ExpressionSupport } from '../../../shared/stage';
import type { MoodView, PoseCoverCue } from '../../../shared/mood';
import type { HerFactKind } from '../../../shared/unbound/sense-relay';
import { WindowReactions } from '../window-mode/window-reactions';
import { WindowMusic, type WindowMusicEnv, type WindowMusicPorts } from '../window-mode/window-music';
import { musicEnvOf } from '../window-mode/window-own-life';
import type { WindowMotionEnv } from '../window-mode/window-motions';
import { figureBone } from '../model/figure-bones';
import type { UnboundFigure } from '../figure';

/** The page's requests these use (electron/unbound/sense-preload-api.ts); absent: none of it reaches her (the page without a host). */
export interface HerSenseApi {
  onUserGaze?(callback: (reading: unknown) => void): () => void;
  onDance?(callback: (frame: unknown) => void): () => void;
  onExpressionPreview?(callback: (recipe: unknown) => void): () => void;
  /** 2026-11-24: the user's music settings (strength, "一直跟着跳"), before the first music frame and on every change. */
  onMusicSettings?(callback: (settings: unknown) => void): () => void;
  herFact?(kind: HerFactKind, value: unknown): Promise<boolean>;
}
/**
 * Frames silent this long are off (ms). 2026-11-22: it was 250 ms (the companion window's refreshDance), and a host busy for longer than that
 * (the 一起看 screen frame every 10 s) reset her music recognizer each time; now the same stall grace as the window (MusicHearing).
 */
export const DANCE_FRESH_MS = MUSIC_STALL_GRACE_MS;

/** Who the dance yields to out here: the window's owners (a pull is a touch there) and her walk (batch F: no dance while she walks). */
export function outMusicEnv(env: WindowMotionEnv, walking: boolean): WindowMusicEnv { return { ...musicEnvOf(env), walking }; }

/** The show's own gate (the window's): hidden, a camera adjust (a peek, a pull, her walk back), a touch. */
export function showBlockedBy(env: WindowMotionEnv): boolean {
  return !env.shown || env.adjusting || env.pat || env.feeding || env.pinch || env.hover || env.pulled;
}

export interface HerSensesFrameInput {
  /** The window's motion environment now (out-motions.ts env()) and her mood view. */
  env: WindowMotionEnv; view: MoodView | null;
  walking: boolean;
  /** The games' face (the reactions lay over it), the 猜拳 holding her arm and face, her collision proxy. */
  base: LifeActivity | null; game: boolean; proxy: CollisionProxy | null;
  /** Her yawn (哈欠捂嘴, window-motions.ts) and the sleep body's own cue, the owners her own life gives way to. */
  yawn: { id: string; at: number } | null; sleepCue: (base: unknown, nowMs: number) => unknown | null; gates: HerLifeStageGates | null;
  /** The camera shows her whole body (a breather's yawn may bring the hand only then). */
  fullBody: boolean;
  /** 哈欠捂嘴 as her action (the host's live cue for a breather's yawn). */
  cover: (cue: PoseCoverCue) => void;
}
export interface HerSensesFrame {
  /** The activity procedural life reads (the reactions over the games' face). */
  activity: LifeActivity | null;
  show: { clip: string; elapsedMs: number; strength: number } | null; showBlocked: boolean;
  beat: { headX: number; headZ: number; bodyZ: number } | null; dancing: boolean;
  /** The reaction's chest, shoulders and waving arm (the figure's overlay), or null. */
  overlay: ((remember: (bone: Bone) => void) => void) | null;
}

export class HerOutSenses {
  readonly reactions = new WindowReactions();
  readonly music: WindowMusic;
  private readonly fusion = new AudioDanceFusion();
  private readonly hearing: MusicHearing;
  private owner: SkinnedMesh | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  /** 2026-11-24: what her body does to the sound, told to the host as the companion window tells it (once a second at most, on change). */
  private readonly reporter: HerStateReporter | null;
  private reportedAt = -Infinity;

  /** `support`: what of a show this model can show (out-page.ts from her face's slots); `now`: a test's monotonic clock (ms). */
  constructor(private readonly api: HerSenseApi | null, private readonly support: (recipe: ExpressionRecipe) => ExpressionSupport,
    face: { musicFace(): ReturnType<WindowMusicPorts['face']>; readonly hasSpeechFace: boolean }, danceStarts: () => void, private readonly now: () => number = () => performance.now()) {
    const fact = (kind: HerFactKind, value: unknown) => { void api?.herFact?.(kind, value).catch(() => {}); };
    this.music = new WindowMusic({ face: () => face.musicFace(), hasFace: () => face.hasSpeechFace, danceStarts,
      told: (intent, scale) => fact('music-reaction', scale === 1 ? { intent } : { intent, scale }), tier: (tier, score) => fact('music-tier', { tier, score }),
      verdict: flip => fact('music-verdict', flip), now });
    this.hearing = new MusicHearing({ now, enabled: on => { this.music.setEnabled(on); if (!on) this.fusion.clear(); } }, DANCE_FRESH_MS); // ticked each frame
    this.music.setSettings({}); // her own choice to dance (M1), as the companion window before its settings come
    void loadMusicForEngine().then(lib => this.music.load(lib), () => { /* no music then */ });
    // 2026-11-24: the user's settings (the host sends them before the first frame), and what her body does told back (the companion window's report).
    if (api?.onMusicSettings) this.unsubscribe.push(api.onMusicSettings(value => this.music.setSettings(normalizeMusicSettings(value))));
    this.reporter = api?.herFact ? new HerStateReporter({ read: () => this.music.presence(), send: report => api.herFact!('stage-state', report) }) : null;
    if (api?.onDance) this.unsubscribe.push(api.onDance(frame => this.dance(frame)));
    if (api?.onExpressionPreview) this.unsubscribe.push(api.onExpressionPreview(recipe => { this.playExpression(recipe); }));
  }

  /** Her model (still at rest) or none: a new owner drops what played; the dance's bones. */
  attach(figure: UnboundFigure | null): void {
    this.reactions.reset();
    this.owner = figure?.mesh ?? null;
    if (!figure) { this.music.attach(null); return; }
    const mesh = figure.mesh, bone = (names: string[]) => figureBone(mesh, names);
    // ui-zh-ok: MMD bone names inside the model file, not interface text
    this.music.attach({ center: bone(['センター', 'center']), chest: bone(['上半身2', 'chest', '上半身']), head: figure.head, height: figure.heightUnits });
  }

  /** 惊喜 / 害羞 now on her model (the preview buttons; a later reaction cue the same way). */
  playExpression(recipe: unknown, strength?: number): ExpressionSupport | null {
    return this.reactions.playExpression(recipe, strength, this.support, this.owner);
  }

  /** One frame from the host: a sample while a source's dance is on, or null (the dance went off: stop at once). */
  dance(value: unknown): void {
    if (value === null) { this.stopHearing(); return; }
    const frame = parseAudioDanceFrame(value);
    if (!frame?.sample) return;
    this.fusion.push(frame.source, frame.sample, this.now());
    this.hearing.frame();
  }
  private stopHearing(): void { this.hearing.stop(); this.fusion.clear(); }

  /** One frame, before her face: the music (her choice, who the dance yields to), then the reactions and the show for procedural life. */
  frame(delta: number, input: HerSensesFrameInput): HerSensesFrame {
    const now = this.now();
    this.hearing.tick(); // a stall shorter than DANCE_FRESH_MS keeps her hearing; longer, she heard nothing
    const fused = this.hearing.hearing ? this.fusion.read(now) : null;
    if (fused) this.music.setSample(fused.sample);
    if (input.env.shown) this.music.frame(delta, outMusicEnv(input.env, input.walking)); else this.music.notShown();
    if (this.reporter && now - this.reportedAt >= HER_STATE_REPORT_CHECK_MS) { this.reportedAt = now; this.reporter.tick(); }
    const activity = this.reactions.frame(delta, { owner: this.owner, pose: input.view?.pose ?? null, yawn: input.yawn, sleepCue: input.sleepCue, gates: input.gates,
      game: input.game, proxy: input.proxy, fullBody: input.fullBody, cover: cue => input.cover(cue), nowMs: Date.now() }, input.base);
    return { activity, show: this.reactions.preview(), showBlocked: showBlockedBy(input.env), beat: this.music.beat, dancing: this.music.moving,
      overlay: this.reactions.overlay() };
  }

  /** Something of these moves (the page draws at the full rate). */
  get moving(): boolean { return this.reactions.active || this.reactions.showing || this.music.active || this.music.moving; }

  dispose(): void { for (const off of this.unsubscribe.splice(0)) { try { off(); } catch { /* gone */ } } this.stopHearing(); this.music.dispose(); this.reactions.reset(); }
}
