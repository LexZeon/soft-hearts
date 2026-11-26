/**
 * I-154 batch 7: what the Unbound window stage reads of itself, between what the wiring tells her (window-stage-inputs.ts) and the stage
 * (window-stage.ts), so the stage file stays a wiring file: the motion environment (who holds her now), her reactions' frame, and batch 7's
 * hooks for window-stage-previews.ts (试一下 with the stage's state, the control window's previews' view of the stage, the pictures' parts).
 * Moved out of window-stage.ts unchanged (behaviour unchanged); the stage keeps the fields, these read them.
 */
import type { Bone, Scene, WebGLRenderer } from 'three';
import type { AppSettings } from '../../../shared/foundation/settings';
import type { CollisionProxy } from '../../../shared/actions';
import { framesWholeBody } from '../../mood';
import { WindowStageInputs } from './window-stage-inputs';
import type { WindowCameraEdit } from './window-camera';
import type { WindowView } from './window-view';
import type { MotionBlocks } from './window-face-rig';
import type { WindowMotionEnv } from './window-motions';
import type { WindowBody } from './window-body';
import type { WindowLiveliness } from './window-liveliness';
import type { WindowStageTools } from './window-stage-tools';
import type { WindowPreviewStage } from './window-previews';

export abstract class WindowStageEnv extends WindowStageInputs {
  protected abstract readonly renderer: WebGLRenderer;
  protected abstract readonly scene: Scene;
  protected abstract readonly view: WindowView;
  protected abstract readonly cameraEdit: WindowCameraEdit;
  protected abstract readonly tools: WindowStageTools;
  protected abstract blocks: MotionBlocks;
  protected abstract lastLids: number;
  protected abstract proxy: CollisionProxy | null;
  protected abstract settings: AppSettings | null;
  protected abstract head: Bone | null;
  protected abstract modelGeneration: number;
  protected abstract pendingModel: Promise<void>;
  protected abstract presence: number;
  protected abstract firstShown: boolean;
  protected abstract loaded: ReturnType<WindowPreviewStage['model']>;
  /** Drawn now: shown by the host, the page visible, the window has a size. */
  protected abstract get visible(): boolean;

  // Batch 7 (window-stage-previews.ts): 试一下 with the stage's state now; the preview's view of the stage; the pictures' parts.
  protected startCapability(id: unknown): boolean {
    const body = this.body, env = this.motionEnv(), gates = this.motions.lifeGates(env), rig = this.faceRig, card = this.face.capabilities();
    return this.tools.start(id, body?.figure.mesh ?? null, { ready: !this.disposed && this.visible && !!body && this.presence > 0, card, faceBlocked: env.blocks.face,
      mouthBlocked: env.blocks.mouth, lids: rig?.slots.blink !== undefined, mouth: !!body?.mouth, mood: !!this.moodView, blush: !!this.blush.painter || this.face.blushMorph() >= 0,
      head: !!this.head, headOwned: env.blocks.head || env.pulled, drowsy: this.moodView?.expressions === true && !!rig?.drowsy && this.face.drowsyFaceAllowed(),
      tears: this.blush.painter?.tearsSupported === true, free: gates.expressive && !gates.engaged && !gates.asleep && !gates.bodyOwned && !env.rps && !env.give && !env.hands && !env.reacting });
  }
  protected authoring() { return this.tools.preview; }
  protected modelGenerationNow(): number { return this.modelGeneration; }
  protected previewWake(): void { this.pace.wake('expression'); }
  protected previewStage(): WindowPreviewStage {
    return { shown: () => !this.disposed && this.visible, model: () => this.loaded, settingsUrl: () => this.settings?.model?.url ?? '', pendingModel: () => this.pendingModel,
      behavior: () => this.motions.clips?.behavior ?? null, mood: () => this.moodView, refresh: () => this.motions.refreshFaces() };
  }
  protected async captureParts(url: string, generation: number, avatar: boolean) {
    await this.pendingModel;
    const grid = this.tools.preview?.grid;
    if (!grid || this.disposed || !this.visible || !this.body || this.presence <= 0 || (avatar && (!this.head || this.presence < 1)) || this.modelUrl !== url
      || generation !== this.modelGeneration || this.cameraEdit.interacting) return null;
    return { parts: { renderer: this.renderer, scene: this.scene, camera: this.view.camera, head: this.head, height: this.view.bounds.height, centerX: this.view.bounds.centerX, hide: [grid] },
      still: () => !this.disposed && this.modelGeneration === generation && this.modelUrl === url };
  }
  protected motionEnv(): WindowMotionEnv {
    const contact = this.contactNow, view = this.moodView, shown = this.visible && !this.disposed;
    return { shown, typing: this.typing, behaviorBlocked: this.behaviorBlocked, inputBlocked: this.inputBlocked, adjusting: this.cameraEdit?.interacting === true,
      pat: contact?.contact === true, feeding: contact?.feeding === true, hover: (contact?.hover ?? 0) > 0, pinch: contact?.pinch?.pinching === true,
      pulled: this.pull.engaged, asleep: this.lively.lastSleep?.performing === true, rps: this.games.rpsActive, give: this.games.giveActive, hands: this.games.hands.active,
      speaking: this.speechOwner.speaking(this.speakingSources.size > 0), preparing: this.face.preparing, thinking: this.face.thinkingActive, view, blocks: this.blocks,
      showing: this.reactions.showing, reacting: this.reactions.reacting, lidsHeld: this.lastLids, blink: this.body?.life.naturalBlink ?? 0,
      mouthOff: this.face.capabilities()?.mouth?.choice === 'off', eyesOff: this.face.capabilities()?.closeEyes?.choice === 'off', music: this.ownLife.music.moving,
      sentenceOpen: this.shownSentence.open(Date.now() / 1000) }; // I-175: read-aloud off, mid-sentence: a closed-mouth shape waits
  }
  /** Batch 5 (window-reactions.ts): her reactions to your pose and the show, for this frame of her liveliness. */
  protected reactionFrame(delta: number, body: WindowBody): NonNullable<Parameters<WindowLiveliness['frame']>[3]['reactions']> {
    const env = this.motionEnv(), bounds = this.view.bounds;
    return {
      activity: (base, sleepCue) => this.reactions.frame(delta, { owner: body.figure.mesh, pose: this.moodView?.pose ?? null, yawn: this.motions.yawnCue, sleepCue,
        gates: this.motions.lifeGates(env), game: env.rps, proxy: this.proxy, fullBody: framesWholeBody(this.settings?.camera, { height: bounds.height, baseY: bounds.baseY }),
        cover: cue => { void this.motions.playHerAction({ ...cue, action: 'cover-yawn' }); }, nowMs: Date.now(), wave: this.tools.capability.now.wave }, base),
      // The show's own gate (the old stage's): hidden, a window or camera move, a touch; typing never holds it.
      show: this.reactions.preview(), showBlocked: !env.shown || env.behaviorBlocked || env.adjusting || env.pat || env.feeding || env.pinch || env.hover || env.pulled,
      overlay: overlays(this.reactions.overlay(), this.tools.overlay()), // batch 7: a personal pose preview after a pose reaction
    };
  }
}

type Overlay = ((remember: (bone: Bone) => void) => void) | null;
/** Two figure overlays one after the other (either may be absent). */
const overlays = (a: Overlay, b: Overlay): Overlay => a && b ? remember => { a(remember); b(remember); } : a ?? b;
