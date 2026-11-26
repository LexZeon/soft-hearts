/**
 * I-154 follow-up, first slice (docs/claude/2026-11-20-unbound-full-shares.md): her face out in full-screen Unbound, from the same set the
 * companion window uses.
 *
 * The layers are the companion window's, unchanged (WindowFace: her mood's face, a pat by mood, the pinch, the snack mouth, thinking, the
 * speaking accents, the blush, the drowsy face; the tears' timeline; the eased lids and natural blinks of window-life.ts). What differs is
 * who else drives her: here a peek, her own life, a speech beat or an act may own her body, she may be walking, and nobody at all most of
 * the time. So her face never takes her body: every frame its goals are laid over whatever those owners last asked (face-goals.ts), and the
 * figure's springs carry the sum. A pat while she walks lifts her head into your hand as she goes; a pinch bends her neck over the gait.
 *
 *  - Owners hand their targets to `wrap(inner)` (main.ts wraps the idle layer's body with it); `frame()` lays her face over the last ones
 *    and hands the result on, every frame (an owner that rests says so once).
 *  - Her look: an owner that asks for one keeps it; otherwise only her face's own glance (thinking, the mood's small eye motions) becomes a
 *    look, and not while she walks (her walk looks where she goes). With no glance she has no target and looks where she faces (you).
 *  - Her lids: the larger of an owner's blink and her own (a pat's eased closure, tired lids, a natural blink every 3–7 s).
 *  - The snack mouth composes with the speaking mouth by the companion's rule (`mouthCompose`).
 *  - Batch H (docs/claude/2026-11-21-unbound-full-ACH.md): her procedural life (window-proc-life.ts, the window layer) adds to her face goals,
 *    so it stacks on whatever an owner asks (her own life small moves, her walk); it gives way to a peek, a pull, a touch (lifeGates).
 *  - Batch D (docs/claude/2026-11-21-unbound-full-D.md): who she looks at with pose sensing (out-gaze.ts, the companion's chooser) goes on top
 *    of her own look where no owner asks for one, her walk included (her eyes and head only; the coordinator lets go behind her); her
 *    look-at-you moments look at you (the viewer's eye, where pose says you sit); the 惊喜 / 害羞 show and the music nod ride procedural life
 *    (`show`, `beat`, set by out-senses.ts each frame). Each layer adds or yields by its declared gate, never by a special case here.
 * Pure apart from the three.js objects it is handed (no DOM): tests run it on the real frame loop.
 */
import type { AnimationClip, Bone, Camera, SkinnedMesh } from 'three';
import { type StageModelProfile, type LifeActivity } from '../../stage';
import { composeFeedMouth } from '../../../shared/behaviors/part-mix/mouth'; // I-175: the companion's feeding rule, kept in part-mix (I-176)
import type { BlushCalibration, MoodView } from '../../../shared/mood';
import type { ModelCapabilities } from '../../../shared/stage';
import type { MorphSlot } from '../../../shared/actions';
import { REST_TARGETS, asksForGaze, type PoseTargets } from '../motion/generator';
import type { IdleBody } from '../motion/unbound-idle';
import { WindowFace, type WindowFaceFrame } from '../window-mode/window-face';
import { faceBlocks, NO_FACE_BLOCKS, showCapabilitiesOf, slotBindings, windowFaceRig, type FaceBlocks, type WindowFaceRig } from '../window-mode/window-face-rig';
import { WindowBlushState, type WindowBlush } from '../window-mode/window-blush';
import { WINDOW_LOOK, WindowLife } from '../window-mode/window-life';
import { WindowCrying, windowTearsGate } from '../window-mode/window-tears';
import { NO_LIFE, WindowProceduralLife, withLife, type WindowLifeGates, type WindowLifeOut } from '../window-mode/window-proc-life';
import { eyeBones } from '../window-mode/window-model';
import type { LivelinessLib } from '../../stage';
import type { TouchFeedback } from '../../mood';
import { addRot, layFace } from './face-goals';
import { talkSignal } from '../../../shared/stage';
import type { StandardBody } from '../model/standard-body';
import { HerOutGaze, composeLook, glanceUnits, type OutGazeFrame } from './out-gaze';

/** The body her face binds to (UnboundFigure): its slot morphs, its head, its height. */
export interface HerFaceBody { readonly head: Bone | null; readonly heightM: number; setSlotMorphs(map: Partial<Record<MorphSlot, number>> | null): void }
/** A model as loaded and measured at rest (window-model.ts measureWindowModel gives the profile and the painter). */
export interface HerFaceModel {
  body: HerFaceBody; mesh: SkinnedMesh; profile: StageModelProfile | null; painter: WindowBlush | null;
  /** The host said this is the reviewed Gene; `standard`: a VRM on the standard skeleton. */
  reviewed: boolean; standard: boolean; url: string;
  /** I-164 (docs/claude/2026-11-20-vrm-gaps.md): that VRM's standard body (its own card: blush, tears, tired lids, the drowsy face). */
  vrm?: StandardBody | null;
}
export interface HerFaceEnv {
  /** She is drawn now (the page visible, a model shown). */
  shown: boolean;
  /** A pull, a walk back to the face station or a peek holds her (the face's own motions step aside, as for a camera adjust). */
  adjusting: boolean;
  /** The held "she is speaking" (her mouth's hold) and any source saying she speaks now. */
  voiced: boolean; speaking: boolean;
  /** She is walking (no glance becomes a look then). */
  walking: boolean;
  /** Wall clock (ms): the host's reunion cue times are on it (tears). */
  nowMs: number;
  /** I-170: another talk signal the page has (you sent a line and she thinks, her reply arriving); absent: none. */
  talking?: boolean;
}
export interface HerFaceOut {
  /** The snack mouth composed with the speaking mouth (mouth.ts apply), or null. */
  mouth: ((speaking: number) => number) | null;
  /** A pat, a pinch: her learned idle steps aside (idleWanted's performing). */
  performing: boolean;
  /** What her face asked this frame (null without a model). */
  face: WindowFaceFrame | null;
}

/**
 * Batch H: who her procedural life gives way to out here (the window's owners): a touch, a picked expression or head motion, a peek, a pull or
 * her walk back to the face station ("adjusting", as a camera adjust in the window), speaking, tired past looking around. Her walk and her own
 * life's small moves are not owners: what they ask stacks with it.
 */
export function lifeGates(owners: ReturnType<WindowFace['owners']>, env: { adjusting: boolean; speaking: boolean; voiced: boolean }): WindowLifeGates {
  return { contact: owners.contact, face: owners.face, head: owners.head, mouth: owners.mouth, adjusting: env.adjusting, speaking: env.speaking || env.voiced,
    gazeAllowed: owners.gazeAllowed, fatigueFace: owners.fatigueFace };
}
/** Batch H: full-screen has no cursor to follow; her procedural life's look-at-you moments look straight out (at you). */
const NO_POINTER = Object.freeze({ x: 0, y: 0 });
/** A glance smaller than this (rad) is no look: she keeps looking where she faces. */
const LOOK_EPS = 1e-4;

export class HerOutFace {
  readonly face = new WindowFace();
  readonly blush = new WindowBlushState();
  /**
   * Batch H (docs/claude/2026-11-21-unbound-full-ACH.md): her procedural life (window-proc-life.ts, the window's layer): small gaze drifts and
   * saccades, a head tilt, her weight's sway, her continuous face, her blink rhythm. Its goals add to her face's, so they stack on whatever an
   * owner asks (her life's small moves included); its look only where nobody asks for one and she is not walking.
   */
  readonly procLife = new WindowProceduralLife();
  /** Batch B: the games' face this frame (her game face, a reach's look), the activity her procedural life lays over, as on the window. */
  activity: LifeActivity | null = null;
  /**
   * Batch D, F (out-senses.ts sets them each frame): the 惊喜 / 害羞 show for procedural life's preview channel and whether its own gate holds
   * it, the music nod and listening look, and whether the dance holds her (her procedural life's head and sway give way to it).
   */
  show: { clip: string; elapsedMs: number; strength: number } | null = null;
  showBlocked = false;
  beat: { headX: number; headZ: number; bodyZ: number } | null = null;
  dancing = false;
  /** Batch D: who she looks at with pose sensing (the companion's chooser; out-gaze.ts); its facts go to `gazeFact` (the host journals them once). */
  readonly gaze: HerOutGaze;
  gazeFact: ((event: unknown) => void) | null = null;
  /** Batch D: the world camera (the viewer's eye); null: no look at you (tests without a camera). */
  camera: Camera | null = null;
  /** Batch D: what the chooser said this frame (diagnostics and tests). */
  gazeOut: OutGazeFrame | null = null;
  private hasEyes = false;
  /** Batch H: what her procedural life asked last frame (diagnostics and tests). */
  lifeOut: WindowLifeOut = NO_LIFE;
  private readonly life: WindowLife;
  private readonly crying = new WindowCrying();
  private rig: WindowFaceRig | null = null;
  private model: HerFaceModel | null = null;
  private owner: PoseTargets = { ...REST_TARGETS };
  private pat = false;
  private view: MoodView | null = null;
  private wasShown = true;
  private contactNow: TouchFeedback | null = null;
  private lastLids = 0;

  constructor(random: () => number = Math.random) {
    this.life = new WindowLife(random);
    this.gaze = new HerOutGaze(event => this.gazeFact?.(event), random);
  }

  /** What owners drive (main.ts hands the idle layer's body): their targets stop here; `frame` lays her face over them and passes them on. */
  wrap(inner: IdleBody): IdleBody {
    return { get sense() { return inner.sense; }, get intentIdle() { return inner.intentIdle; }, setPoseTargets: targets => { this.owner = targets; } };
  }

  // ---- what the page tells it --------------------------------------------------------------------------------------------------
  /** A model loaded (or none): its slots, its painted blush; nothing of the last model's face carries over. */
  attach(model: HerFaceModel | null): void {
    this.blush.clear(); this.crying.stop();
    this.model = model;
    this.rig = model ? windowFaceRig(model.mesh, model.profile, model.reviewed && !model.standard, model.body.head, model.vrm ?? null) : null;
    this.hasEyes = !!model && (model.standard || eyeBones(model.mesh).length > 0);
    this.face.setCard(null); this.face.setBlocks(NO_FACE_BLOCKS);
    this.face.attach(this.rig);
    if (model) { this.blush.attach(model.painter); this.refreshBlush(); }
  }
  /** The companion's motion layers (the same as the window's): a picked expression owns her face, a picked head motion her head. */
  setClips(clips: { pose: AnimationClip | null; gesture: AnimationClip | null; expression: AnimationClip | null }, legacy: boolean): FaceBlocks | null {
    const model = this.model, rig = this.rig;
    if (!model || !rig) return null;
    const blocks = faceBlocks(clips, legacy, model.mesh, rig.slots.a ?? -1, model.body.head?.name ?? null);
    this.face.setBlocks(blocks);
    return blocks; // batch C: her own motions read what the picked motions hold too (out-motions.ts)
  }
  /** Batch D: what of a 惊喜 / 害羞 show this model can show (the window's rule: its face slots, head, eyes, blush), or null without a model. */
  showCapabilities(): ReturnType<typeof showCapabilitiesOf> | null {
    const model = this.model;
    if (!model || !this.rig) return null;
    return showCapabilitiesOf(this.rig, { head: !!model.body.head, upperBody: true, eyes: this.hasEyes, blush: !!this.blush.painter || this.face.blushMorph() >= 0 });
  }
  /** I-024: the model's capability card (null: derived from the profile, as the window does until the host's comes). */
  setCard(card: ModelCapabilities | null): void { this.face.setCard(card ?? null); this.refreshBlush(); }
  setMood(view: MoodView | null): void { this.view = view; this.face.setMood(view); }
  /** Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): the blush calibration for `url`; the painted blush is measured again with it (the window's rule). */
  setBlushCalibration(value: BlushCalibration, url: string): void {
    this.blush.setCalibration(value, url);
    if (this.model && url === this.model.url) this.refreshBlush(true);
  }
  /** Trusted scope loss: no view, nothing of it comes back; what shows eases away. */
  invalidate(): void { this.view = null; this.face.invalidate(); this.pat = false; this.contactNow = null; }
  /** The touch input's feedback (a hand on her scalp, a pinch, a snack near her mouth), or null when it ended. */
  setContact(contact: TouchFeedback | null): void { this.pat = contact?.contact === true; this.contactNow = contact ?? null; this.face.setContact(contact ?? null); }
  /** Batch C: what her motions read of her face now: the touch's feedback, the lids held closed last frame, a natural blink in progress. */
  get contact(): TouchFeedback | null { return this.contactNow; }
  get lids(): number { return this.lastLids; }
  get naturalBlink(): number { return this.life.naturalBlink; }
  setThinking(key: string | null): void { this.face.setThinking(key); }
  /** Batch H: her procedural life's code, loaded on demand (src/stage/index.ts loadLivelinessForEngine); until then: none. */
  loadLife(lib: Pick<LivelinessLib, 'ProceduralLife' | 'lifeRig'>): void { this.procLife.load(lib); }
  speechCue(cue: unknown): void { this.face.speechCue(cue); }

  // ---- every frame ------------------------------------------------------------------------------------------------------------
  /**
   * Her face's goals laid over the owners' last targets, handed to `inner` (the idle layer's body). `compose` adds what else of the shared set
   * rides on her face's goals this frame (batch B: the games' arms and lean; batch G: her sleep), before they are laid over the owners.
   */
  frame(delta: number, inner: IdleBody, env: HerFaceEnv, compose?: (face: WindowFaceFrame, owner: PoseTargets) => WindowFaceFrame): HerFaceOut {
    const model = this.model;
    if (!env.shown) { this.notShown(); inner.setPoseTargets(this.owner); this.gazeOut = null; return { mouth: null, performing: false, face: null }; }
    this.wasShown = true;
    if (!model) { inner.setPoseTargets(this.owner); return { mouth: null, performing: false, face: null }; }
    // Batch H: her procedural life first (its blush goes into her face's), then her face; its goals added to her face's (the window's withLife).
    const owners = this.face.owners(), talking = env.speaking || env.voiced;
    // I-170: talking (her idle head calms: procedural life here, the learned idle through the targets below; eased, with a linger).
    const talk = talkSignal({ speaking: talking, thinking: this.face.thinkingActive, preparing: this.face.preparing, reply: env.talking });
    // Batch D: where you are and who she looks at (before procedural life: its look-at-you moments look at you).
    const sense = inner.sense, gaze = this.gazeOut = this.camera ? this.gaze.frame({ dt: delta, allowed: owners.gazeAllowed, thinking: this.face.thinkingActive, speaking: talking,
      mood: this.view, head: sense?.head ?? null, heading: sense?.root.heading ?? 0, camera: this.camera }) : null;
    const life = this.lifeOut = this.procLife.frame(delta, { owner: model.mesh, rig: this.rig, view: this.view, pointer: NO_POINTER, breath: 0.5, hasEyes: this.hasEyes, activity: this.activity,
      mouthBusy: talking || owners.feeding, gates: { ...lifeGates(owners, env), music: this.dancing, talking: talk }, show: this.show, showBlocked: this.showBlocked, beat: this.beat });
    const own = withLife(this.face.frame(delta, { shown: true, adjusting: env.adjusting, voiced: env.voiced, speaking: env.speaking, heightM: model.body.heightM, lifeBlush: life.blush }), life,
      gaze ? glanceUnits(gaze.toUser) : null);
    const f = compose ? compose(own, this.owner) : own;
    this.lastLids = f.lids;
    const lids = this.life.frame({ dt: delta, pointer: null, eyes: null, follow: false, pat: this.pat,
      face: { lids: f.lids, softLids: f.softLids, blink: f.blink, ownsPat: f.ownsPat, gaze: f.gaze }, nextBlink: () => this.procLife.nextBlink() });
    const owner = this.owner, laid = layFace(owner, f);
    laid.talking = talk;
    laid.blink = Math.max(owner.blink, lids.blink);
    // No mood view yet: the window's simple pat (a small smile, the head lifting into the hand).
    if (!f.ownsPat) { laid.head = addRot(laid.head, lids.head); laid.face = { curious: owner.face.curious, smile: Math.max(owner.face.smile, lids.face.smile), startle: owner.face.startle }; }
    let look = faceLook(owner, f.gaze, env.walking);
    if (gaze && !asksForGaze(owner)) look = composeLook(look, gaze); // batch D: the chooser on top of her own look; an owner's look wins
    if (look) laid.eyes = look;
    inner.setPoseTargets(laid);
    // 脸红 and 眼泪 (painted on her face material; window-blush.ts owns it, tears wrap the blush).
    this.blush.painter?.update(f.blushPath === 'painted' ? f.blush : 0, f.blushSize);
    const cry = this.crying.frame(delta, { view: this.view, visible: true, adjusting: env.adjusting, faceBlocked: this.face.owners().face,
      supported: this.blush.painter?.tearsSupported === true, nowMs: env.nowMs });
    this.blush.painter?.updateTears(cry.amount, cry.elapsedMs);
    const feed = f.mouth;
    return { mouth: feed && (feed.value > 0 || feed.owner > 0) ? speaking => composeFeedMouth(speaking, feed.value, feed.owner) : null,
      performing: this.life.patted || f.performing === true, face: f };
  }

  /** Not drawn (the page hidden): the accents and the thinking look are dropped (nothing replays later), a running cry stops. */
  private notShown(): void {
    if (!this.wasShown) return;
    this.wasShown = false;
    this.face.hide(); this.pat = false; this.gaze.forget();
    if (this.crying.amount > 0) { this.crying.stop(); this.blush.painter?.updateTears(0, 0); }
  }

  /** The blush follows the card: painted, her own morph, or none; the slots bound to this model's morphs; who may cry. */
  private refreshBlush(force = false): void {
    const model = this.model, rig = this.rig;
    if (!model || !rig) return;
    this.blush.refresh(this.face, morph => model.body.setSlotMorphs(slotBindings(rig, morph)), model.url, force);
    this.blush.painter?.setTearsGate(windowTearsGate(rig.reviewed, this.face.capabilities()));
  }
}

/** Her face's look out here: none when an owner asks for its own (a peek at the lens, her life's look at you) or while she walks. */
export function faceLook(owner: PoseTargets, gaze: WindowFaceFrame['gaze'], walking: boolean): { yaw: number; pitch: number } | null {
  if (asksForGaze(owner) || walking) return null;
  return glance(gaze);
}

/** Her face's own glance as a look (the window's gains), or null when it is none (asleep, or too small to be one). */
export function glance(gaze: WindowFaceFrame['gaze']): { yaw: number; pitch: number } | null {
  if (!gaze.allowed) return null;
  const strength = Math.min(1, Math.max(0, Number.isFinite(gaze.strength) ? gaze.strength : 1));
  const yaw = clamp(fin(gaze.x) * WINDOW_LOOK.yawPerUnit * strength + fin(gaze.eyeYaw), WINDOW_LOOK.maxYaw);
  const pitch = clamp(-fin(gaze.y) * WINDOW_LOOK.pitchPerUnit * strength + fin(gaze.eyePitch), WINDOW_LOOK.maxPitch);
  return Math.abs(yaw) + Math.abs(pitch) > LOOK_EPS ? { yaw, pitch } : null;
}
const fin = (value: number) => Number.isFinite(value) ? value : 0;
const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
