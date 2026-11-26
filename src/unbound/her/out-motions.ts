/**
 * Batch C (docs/claude/2026-11-21-unbound-full-ACH.md): her own motions out in full-screen Unbound, from the same set the companion window uses
 * (window-motions.ts, window-clips.ts: the same players, the same rules, not a copy): row 30 聊天手势 (a chat gesture the host grants for a reply),
 * row 31 她的动作 (one of her one-shot actions; a body action through the clip layer, a face shape through the face exclusive; every cue gets
 * her answer), row 32 自动身体动作 (the host's automatic body motion and behaviour faces).
 *
 * What differs out here, on purpose:
 *  - the figure's mixer level has ONE writer, as in the window (window-under-layer.ts with the clips over it), here wrapped in the walk mask
 *    (walk-mask.ts): while she walks her clips use her upper body only, and the automatic body motion does not start (a playing one is handed
 *    back through the clips' bridge, never cut);
 *  - who holds her: a pull, her walk back to the face station or a peek is "adjusting" (as a camera adjust in the window: what plays gives
 *    way, nothing new starts); a pat, a snack, a pinch, the pointer on her scalp are her direct contact, as in the window;
 *  - the host port is the Unbound window's own (electron/unbound/preload-api.ts): each request is taken only from the window she is shown in
 *    (electron/unbound/motion-bridge.ts), and her answer to an action counts only while she is out.
 * Pure apart from the three.js objects it is handed (no DOM): tests run it on the real frame loop.
 */
import type { AnimationClip, SkinnedMesh } from 'three';
import { isChatGestureTrack, type StageModelProfile } from '../../stage';
import type { StageMotionRetarget } from '../../actions';
import type { VmdDataTransform } from '../../foundation/vmd';
import type { MoodView } from '../../../shared/mood';
import type { BehaviorMotionResource, BodyMotionPlan, BodyMotionResource, BodyStageObservation, ChatGestureResource, HerActionOutcome,
  HerActionResource } from '../../../shared/actions';
import type { UnboundFigure } from '../figure';
import type { StandardBody } from '../model/standard-body';
import { standardFaceOf } from '../model/standard-face';
import { WindowMotions, type WindowMotionEnv } from '../window-mode/window-motions';
import { WindowUnderLayer, type UnderWriter } from '../window-mode/window-under-layer';
import { NO_MOTION_BLOCKS, motionBlocks, type FaceBlocks, type MotionBlocks } from '../window-mode/window-face-rig';
import type { WindowStageHost } from '../window-mode/host-ports';
import { WalkMask } from './walk-mask';

/** The page's requests her motions use (electron/unbound/preload-api.ts); absent: none of them plays (the page without a host). */
export interface HerMotionApi {
  resolveChatGesture?(cueId: string, token: string): Promise<ChatGestureResource>;
  resolveHerAction?(cueId: string): Promise<HerActionResource>;
  reportHerAction?(outcome: HerActionOutcome): Promise<void>;
  bodyPlan?(token: string, observation?: BodyStageObservation): Promise<BodyMotionPlan>;
  resolveBody?(cueId: string, token: string): Promise<BodyMotionResource>;
  resolveBehaviorMotion?(cueId: string, token: string): Promise<BehaviorMotionResource>;
  onHerAction?(callback: (cue: unknown) => void): () => void;
}

const refused = () => Promise.reject(new Error('Unbound 尚未接入这个动作。')); // ui-zh-ok: an internal refusal the motions catch, never shown
/** The engine's host port out of the Unbound window's api: the methods window-motions.ts calls, each bound; nothing else. */
export function herMotionHost(api: HerMotionApi | null, reviewed: () => boolean): WindowStageHost {
  return Object.freeze({
    isBehaviorModelSupported: async () => reviewed(),
    resolveChatGesture: (cueId: string, token: string) => api?.resolveChatGesture ? api.resolveChatGesture(cueId, token) : refused(),
    resolveHerAction: (cueId: string) => api?.resolveHerAction ? api.resolveHerAction(cueId) : refused(),
    reportHerAction: (outcome: HerActionOutcome) => api?.reportHerAction ? api.reportHerAction(outcome) : Promise.resolve(),
    getBehaviorBodyPlan: (token: string, observation?: BodyStageObservation) => api?.bodyPlan ? api.bodyPlan(token, observation) : refused(),
    resolveBehaviorBody: (cueId: string, token: string) => api?.resolveBody ? api.resolveBody(cueId, token) : refused(),
    resolveBehaviorMotion: (cueId: string, token: string) => api?.resolveBehaviorMotion ? api.resolveBehaviorMotion(cueId, token) : refused(),
    resolveHerLifeMotion: () => refused(), // batch E (her own life's held poses) is not out here yet
  }) as WindowStageHost;
}

/** What the page says about her now (the parts of WindowMotionEnv full-screen has). */
export interface HerMotionState {
  shown: boolean;
  /** A pull, her walk back to the face station, a peek. */
  adjusting: boolean;
  pulled: boolean;
  walking: boolean;
  /** Her touch input's feedback now (a hand on her scalp, a snack, a pinch, the pointer over her), or null. */
  contact: { contact?: boolean; feeding?: boolean; hover?: number; pinch?: { pinching?: boolean } | null } | null;
  speaking: boolean; preparing: boolean; thinking: boolean;
  /** Her lids held closed now (a pat's enjoyed closure, tired lids) and a natural blink in progress (0..1). */
  lidsHeld: number; blink: number;
  mouthOff: boolean; eyesOff: boolean;
  /** Batches D, F: a 惊喜 / 害羞 show is asked for or plays, a reaction to your pose plays, she dances (each a declared owner of the window's gates). */
  showing?: boolean; reacting?: boolean; music?: boolean;
  /** I-175: read-aloud off and her bubble is in the middle of a sentence (a closed-mouth shape waits for its end). */
  sentenceOpen?: boolean;
}

/** The window's motion environment for full-screen (exported for the test of each rule). */
export function fullMotionEnv(state: HerMotionState, view: MoodView | null, blocks: MotionBlocks): WindowMotionEnv {
  const contact = state.contact;
  return { shown: state.shown, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: state.adjusting,
    pat: contact?.contact === true, feeding: contact?.feeding === true, hover: (contact?.hover ?? 0) > 0, pinch: contact?.pinch?.pinching === true,
    pulled: state.pulled, asleep: view?.fatigue?.sleeping === true, rps: false, give: false, hands: false,
    speaking: state.speaking, preparing: state.preparing, thinking: state.thinking, view, blocks, showing: state.showing === true, reacting: state.reacting === true,
    lidsHeld: state.lidsHeld, blink: state.blink, mouthOff: state.mouthOff, eyesOff: state.eyesOff, walking: state.walking, music: state.music === true,
    sentenceOpen: state.sentenceOpen === true };
}

export interface HerMotionModel {
  figure: UnboundFigure; mesh: SkinnedMesh; reviewed: boolean; retarget: StageMotionRetarget | null; transform: VmdDataTransform | undefined;
  profile: StageModelProfile | null; standard: StandardBody | null;
}

const CLOSED_STATE: HerMotionState = Object.freeze({ shown: false, adjusting: false, pulled: false, walking: false, contact: null, speaking: false, preparing: false,
  thinking: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false });

export class HerOutMotions {
  readonly motions: WindowMotions;
  readonly mask = new WalkMask();
  /** The mixer level's one writer (the window's), its writers under the clips: batch F's dance (out-senses.ts). */
  private readonly under: WindowUnderLayer;
  private model: HerMotionModel | null = null;
  private view: MoodView | null = null;
  private blocks: MotionBlocks = NO_MOTION_BLOCKS;
  private state: HerMotionState = CLOSED_STATE;
  private wasShown = false;

  constructor(api: HerMotionApi | null, now: () => number = Date.now, under: readonly UnderWriter[] = []) {
    this.under = new WindowUnderLayer([...under]);
    this.motions = new WindowMotions(herMotionHost(api, () => this.model?.reviewed === true), () => fullMotionEnv(this.state, this.view, this.blocks), now);
    api?.onHerAction?.(cue => { void this.motions.playHerAction(cue); }); // her answer goes back through the same port (reportHerAction)
  }

  /** A model (still at rest) or none: the old one's clips stop at once (it is going away); this one gets the window's players, one writer at the mixer. */
  attach(model: HerMotionModel | null): void {
    this.model?.figure.setMotionLayer(null);
    this.mask.forget(); this.under.forget(); this.blocks = NO_MOTION_BLOCKS;
    this.model = model;
    this.motions.attach(model ? { figure: model.figure, mesh: model.mesh, reviewed: model.reviewed, retarget: model.retarget, transform: model.transform,
      profile: model.profile, standard: !!model.standard, standardFace: model.standard ? standardFaceOf(model.standard) : null } : null);
    if (model && this.motions.clips) model.figure.setMotionLayer(this.mask.over(this.under.over(this.motions.clips), model.mesh));
  }
  /**
   * The companion's motion layers (as the window): a picked pose or gesture holds her for her own motions. `rest`: her pose is the bundled stand
   * (no pose picked), which is not "a picked pose" (the companion's rule for its reviewed default stand).
   */
  setClips(clips: { pose: AnimationClip | null; gesture: AnimationClip | null }, rest: boolean, face: FaceBlocks | null): void {
    if (!this.model || !face) return;
    this.blocks = motionBlocks(clips, rest, face, isChatGestureTrack);
    this.motions.gatesChanged(true, this.blocks.chatGesture); // a motion change: an automatic one hands back, as in the window
  }
  setMood(view: MoodView | null): void { this.view = view; this.motions.setMood(view); }

  /** Each frame, before her body's frame: what holds her now; the walk mask follows her gait; the gates of what plays. */
  frame(state: HerMotionState): void {
    const walkingChanged = state.walking !== this.state.walking;
    this.state = state;
    this.mask.setWalking(state.walking);
    if (!state.shown) { if (this.wasShown) this.motions.notShown(); this.wasShown = false; return; }
    this.wasShown = true;
    if (walkingChanged && state.walking) this.motions.gatesChanged(true, false); // she starts walking: the automatic body motion hands back
    this.motions.frame();
  }
  /** After her body's frame (her mouth included): a face shape of hers writes over every other face writer. */
  afterBody(delta: number): void { if (this.state.shown) this.motions.afterBody(delta); }
  /** Something of hers is moving (the page draws at the full rate). */
  get moving(): boolean { return this.motions.moving; }
  /** The window's motion environment now (batches D, F: the reactions' and the dance's owners read the same one). */
  env(): WindowMotionEnv { return fullMotionEnv(this.state, this.view, this.blocks); }
  /** 0..1: how much of her arms her clips hold now. */
  get armsHeld(): number { return this.mask.armsHeld; }

  dispose(): void { this.attach(null); this.motions.dispose(); }
}
