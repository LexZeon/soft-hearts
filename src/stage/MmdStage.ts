import {
  AmbientLight,
  AnimationClip,
  type AnimationAction,
  Bone,
  Box3,
  DirectionalLight,
  Euler,
  GridHelper,
  LoadingManager,
  Material,
  MathUtils,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { MMDLoader } from "three/examples/jsm/loaders/MMDLoader.js";
import { LayeredMmdAnimation, type MotionLayerClips } from "./motion-layers";
import { MotionTransition, captureMotionPose, handOffToBase, switchDurationMs, withDerivedBones, type PoseRates } from './motion-transition';
import { getMotionLayerAssets } from "../../shared/motion-layers";
import { MusicDance, type MusicEnergySample } from "./music-dance";
import { MusicChoice, type MusicChoiceContext } from './music-choice';
import { MUSIC_AUDIBLE_RMS, musicPresence } from './music-presence';
import { MusicNod } from './music-nod';
import { MusicListenCue } from './music-listen';
import { MusicLikeness, likenessLine } from './music-likeness';
import { hasOwnedLayeredHeadTrack } from './music-head-ownership';
import { normalizeMusicSettings, type MusicSettings } from '../../shared/music-settings';
import type {
  AppSettings,
  AssetRef,
  CameraConfig,
  PointerPosition,
} from "../../shared/contracts";
import type { BodyMotionResource } from '../../shared/body-motion';
import { blinkWeight, clamp, damp, dampCritical, gazeTargets, relaxedArmRoll } from "./procedural";
import { CappedTextureLoader } from "./textures";
import { createVmdParser, parseVmdWith } from "./vmd";
import { withKeyframeInterpolation } from "./keyframe-interpolation";
import { PointerKeys } from "./pointer-keys";
import { motionFitStorage, StageMotionRetarget, type MotionFitView } from './motion-retarget';
import { CameraController, cameraBasis, normalizeCamera } from "./CameraController";
import { EMPTY_CONTACT, MoodFeedback, type MoodContact } from './mood-feedback';
import { selectBlushChannel, type BlushChannel } from './blush-channel';
import { ProceduralBlush, probeBlushAnchors, type BlushAnchors } from './procedural-blush';
import { CheekPinchMotion, type CheekPinchMotionFrame } from './cheek-pinch-feedback';
import { projectCheekRegions } from './cheek-pinch-region';
import type { CheekRegion } from '../ui/CheekPinch';
import { ProceduralTears, tearsSupport } from './procedural-tears';
import { CryingTimeline, type CryingFrame } from './crying-timeline';
import { DROWSY_PHASES, DrowsyExpression, drowsyFaceGapNote, profileDrowsyTargets, resolveDrowsyTargets, type DrowsyFrame } from './drowsy-expression';
import { DEFAULT_BLUSH_CALIBRATION, validateBlushCalibration, type BlushCalibration } from '../../shared/blush';
import { probeHeadContact, projectHeadContact, type HeadContactProfile } from './head-contact';
import { framingCamera, framingTopBand, isUnframedCamera } from './stage-framing';
import { requestModelProfileCache, StageModelProfile, writeProfiledMorph } from './model-profile';
import { canonicalVmdClipDuration } from '../../shared/vmd-duration';
import { ChatGesturePlayer, isChatGestureTrack } from './chat-gesture';
import { HerActionPlayer } from './her-action';
import { HER_ACTION_DETAILS, HER_ACTION_PART_NAMES, HER_ACTION_SPECS, fingerSide, herActionMissing, isHerActionCue, type HerActionCue, type HerActionMode, type HerActionSpec, type HerActionStatus } from '../../shared/her-actions';
import { FACE_EXCLUSIVE_BLINK_GAP_S, FACE_EXCLUSIVE_START_WAIT_S, FaceExclusive, faceTracksByName, faceWriteTracks, resolveFaceMorphs, type FaceScope } from './face-exclusive';
import { calibratedWeight, profileBoneState, profileFingerCount, profileFingerNames, type StandardBone } from '../../shared/model-profile';
import { smoothCapturedClip } from './capture-smoothing';
import { MotionGlitchWatch, type MotionGlitchReport } from './motion-glitch';
import { BlushSeen, type BlushStageState } from './blush-seen';
import { proceduralBlushDepth } from '../../shared/behaviors/blush/choose';
import { StrayPixelWatch, boneReach, inspectModel, resendModel, skinnedBones, type StrayReport } from './stray-pixels';
import { ColorBlockRecorder } from './color-block-log';
import { buildPhysicsRigPlan } from './physics-rig';
import type { MotionActivity } from '../../shared/journal';
import { isDefaultPoseCandidateName, isReviewedDefaultPose } from './default-pose';
import type { ChatGestureCue, ChatGestureResource } from '../../shared/chat-gesture';
import type { MoodView } from '../../shared/mood-runtime';
import { BEHAVIOR_EYE_SHAPES, BehaviorMotionPlayer } from './behavior-motion';
import { VISUAL_GENE_SHA, VISUAL_MASK, type VisualPreview } from '../../shared/personalize-visual';
import { isExpressionPreview, validateExpressionResource, type AuthoringPreview, type ExpressionResource } from '../../shared/expression-composition';
import type { BodyPosePreview } from '../../shared/personalize-body';
import type { BodyPosePresentation } from '../../shared/personalize-body-presentation';
import { PersonalizeStaticPose } from './personalize-static-pose';
import {SurpriseOverlay,surpriseSample,SURPRISE_DURATION_MS} from './surprise-preview-overlay';
import {playReactionCue,type ReactionStageResult} from './reaction-performers';
import {SURPRISE_CLIP_ID,SURPRISE_MODEL_SHA,SURPRISE_REVISION,SHY_CLIP_ID,SHY_REVISION,type ManualEmotionRecipe,type SurprisePreviewGrant} from '../../shared/surprise-preview';
import { expressionStrength as behaviorExpressionStrength } from '../../shared/behavior-motion';
import { BehaviorBodyPlayer } from './behavior-body';
import { bodyMotionTarget, universalTarget } from './universal-target';
import { clampStrength, showRequest } from './show-blend';
import { ShowClock } from './show-clock';
import { personalizePose } from './universal-pose';
import { BodyMotionController, type BodyStageGates } from './body-motion-controller';
import { LocalModelPhysics, probeModelPhysicsSupport } from './model-physics';
import type { AmmoModule } from './ammo-runtime';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings, type ModelPhysicsState, type ModelPhysicsSupport } from '../../shared/model-physics';
import { FatiguePresentation, NEUTRAL_FATIGUE_FRAME, type FatigueFrame } from './fatigue-presentation';
import { acceptStageFrame, FrameHeartbeat } from './frame-clock';
import { SpeakingSources, type SpeakingSource } from './speaking-sources';
import { StageContinuity, blinkRiderMorphs } from './stage-continuity';
import { EyelidCompositor, composeMouth, manualMouthRamp, yieldToManualMouth } from './channel-compositors';
import { ProceduralLife, lifeRig, type LifeActivity, type LifePort, type LifeRig } from './procedural-life';
import { PoseReactionStage, framesWholeBody, type PoseReactionPort } from './pose-reaction-stage';
import { SHOW_CLIP, SHOW_MS, showSupport, type ShowCapabilities } from './expression-show';
import { isExpressionRecipe, type ExpressionRecipe, type ExpressionSupport } from '../../shared/expression-preview';
import { ReplyThinking } from './reply-thinking';
import { HerLifeStage, herLifeStageLoader, readScreenPlace, type HerLifeMotionPort } from './her-life-stage';
import { herNeedVisibility } from '../../shared/her-needs';
import { RpsPerformance, rpsStageCue, type RpsPort } from './rps-performance';
import type { RpsView } from '../../shared/rps';
import { PRESENCE_FADE_IN_MS, PRESENCE_FADE_OUT_MS, PresenceFade } from './presence-fade';
import { StagePixelProbe } from './pixel-probe';
import { capabilityEnabled, deriveModelCapabilities, type ModelCapabilities, type ModelCapabilityId } from '../../shared/model-capability';
import { NEUTRAL_SLEEP_FRAME, SleepPose, type SleepPoseFrame } from './sleep-pose';
import { CapabilityPreviews, NO_CAPABILITY_PREVIEW, isModelCapabilityId, type CapabilityPreviewFrame } from './capability-preview';
import { hashSeed } from './life-noise';
import { readPoseReactionView } from '../../shared/pose-reactions';

export interface StageOptions {
  onSurprisePreviewState?: (state:'playing'|'partial'|'idle'|'unsupported')=>void;
  transparent?: boolean;
  onCameraChange?: (camera: CameraConfig) => void;
  onFramingStateChange?: () => void;
  onCameraEditChange?: (enabled: boolean) => void;
  onFaceAnchor?: (point: { x: number; y: number; visible: boolean; radius?: number; raisedHand?: { x: number; y: number; elbowX: number; elbowY: number } }) => void;
  onStatus?: (message: string) => void;
  onError?: (message: string) => void;
  onPhysicsState?: (state: ModelPhysicsState) => void;
  onMotionFit?: (view: MotionFitView | null) => void;
  /** Pet only: CSS px from the canvas top where UI reacts (the expanded toolbar and its reveal margin); framing keeps the model below it. */
  framingTop?: () => number;
  /** Pet only: the never-framed default camera is replaced by full framing as soon as a model is shown (P4). */
  frameUnframed?: boolean;
  /** 体验记录 (E2): her music tier changed (nothing, a nod, the dance) with the score that chose it. Told once per change. */
  onMusicTier?: (tier: 'none' | 'nod' | 'dance', score: number | null) => void;
  /** 动作跳变记录 (motion-glitch.ts): a guard catch or a physics kick, with what she was doing (pet window; the host journals it). */
  onMotionGlitch?: (glitch: MotionGlitchReport) => void;
  /** 体验记录: a new blush cue reached the stage; whether it could be shown (blush-seen.ts). */
  onBlushCue?: (stage: BlushStageState) => void;
  /** 体验记录: her first fade-in finished (app start -> she is there). */
  onFirstShown?: () => void;
  /** I-031 色块诊断日志 (color-block-log.ts, temporary): what the 色块哨兵 saw, with her last seconds (pet window; the host writes it). */
  onColorBlock?: (report: import('../../shared/color-block').ColorBlockReport) => void;
}

interface BoneSnapshot {
  bone: Bone;
  quaternion: Quaternion;
  position: Vector3;
}
interface MorphSnapshot {
  index: number;
  value: number;
}
const cameraSignature = (camera: CameraConfig) => [camera.yaw, camera.pitch, camera.distance, camera.targetX, camera.targetY, camera.targetZ ?? 0, camera.fov].join(",");

interface QaStandIdentity {
  model: number; motion: number; clip: object; action: object;
  clipId: string; time: number; weight: number;
}
interface QaStandFinger { name: string; position: number[]; quaternion: number[] }

/** Maintainer-only admission, exercised without a renderer by the narrow pure test. */
export class QaStableStandGate {
  private token: string | null = null;
  private bound: QaStandIdentity | null = null;
  private baseline: { frame: number; time: number; prepareCalls: number; fingers: QaStandFinger[] } | null = null;
  private failure: string | null = null;
  private frames = 0;
  private prepareCalls = 0;
  private prepareAttempts = 0;
  private firstPrepareFrame: number | null = null;
  private lastTime: number | null = null;

  scope(token: string, cue: boolean): void {
    if (this.token === null) this.token = token;
    if (!token || token !== this.token) this.invalidate('scope-changed');
    if (cue && this.prepareCalls === 0) this.invalidate('issued-before-prepare');
  }
  invalidate(reason: string): void {
    this.failure ??= reason;
    this.bound = null; this.baseline = null;
  }
  cancel(): void {
    if (this.baseline || this.prepareCalls) this.invalidate('cancelled');
  }
  validate(source: QaStandIdentity | null, bridge: boolean): boolean {
    if (this.failure || !this.baseline || !this.bound) return false;
    if (!source || bridge || source.model !== this.bound.model || source.motion !== this.bound.motion
      || source.clip !== this.bound.clip || source.action !== this.bound.action || source.clipId !== this.bound.clipId
      || !Number.isFinite(source.time) || source.time < 0 || !Number.isFinite(source.weight)
      || source.weight < 0 || source.weight > 1) {
      this.invalidate('source-or-bridge-changed'); return false;
    }
    // An authored loop may wrap the Action clock; it must never be reset here.
    this.lastTime = source.time;
    return true;
  }
  rendered(source: QaStandIdentity | null, bridge: boolean, busy: boolean, eligible: boolean, fingers: QaStandFinger[]): boolean {
    this.frames++;
    if (this.failure) return false;
    if (this.baseline) { this.validate(source, bridge); return false; }
    if (busy) { this.invalidate('pending-before-baseline'); return false; }
    if (!eligible || bridge || !source || this.token === null) return false;
    if (!Number.isFinite(source.time) || source.time < 0 || source.weight !== 1 || !source.clipId
      || fingers.length !== 2 || !['左人指１', '右人指１'].every(name => fingers.filter(f => f.name === name).length === 1)
      || fingers.some(f => f.position.length !== 3 || f.quaternion.length !== 4
        || ![...f.position, ...f.quaternion].every(Number.isFinite)
        || Math.abs(f.quaternion.reduce((sum, n) => sum + n * n, 0) - 1) > 1e-5)) {
      this.invalidate('invalid-baseline'); return false;
    }
    this.bound = { ...source };
    this.lastTime = source.time;
    this.baseline = { frame: this.frames, time: source.time, prepareCalls: this.prepareCalls,
      fingers: fingers.map(f => ({ name: f.name, position: [...f.position], quaternion: [...f.quaternion] })) };
    return true;
  }
  prepare(source: QaStandIdentity | null, bridge: boolean): boolean {
    this.prepareAttempts++;
    if (!this.validate(source, bridge) || this.prepareCalls !== 0) {
      this.invalidate('prepare-without-fresh-baseline'); return false;
    }
    this.prepareCalls++;
    this.firstPrepareFrame = this.frames;
    return true;
  }
  diagnostic() {
    return { status: this.failure ? 'failed' : this.baseline ? 'stable' : 'waiting', failure: this.failure,
      renderFrame: this.frames, prepareAttempts: this.prepareAttempts, prepareCalls: this.prepareCalls,
      firstPrepareFrame: this.firstPrepareFrame,
      baselineCapturedBeforeFirstPrepare: !!this.baseline && this.prepareCalls === 1,
      source: this.bound ? { model: this.bound.model, motion: this.bound.motion, clipId: this.bound.clipId,
        sha256: '42080246b98aaa8a5b98d1ecd73994cf42b2587f9c04c3ed7435cf859fef83aa', time: this.lastTime } : null,
      baseline: this.baseline ? { ...this.baseline, fingers: this.baseline.fingers.map(f => ({ ...f,
        position: [...f.position], quaternion: [...f.quaternion] })) } : null };
  }
}

/** R29d: one loadMotions result, kept so a changed fit check can re-judge it without reloading. */
interface MotionSelection {
  readonly generation: number;
  readonly mesh: SkinnedMesh;
  readonly assets: ReturnType<typeof getMotionLayerAssets>;
  readonly legacy: boolean;
  readonly reviewedDefault: boolean;
  readonly clips: MotionLayerClips;
}
const UNFIT_MOTION = '这个动作不适合当前模型';

/** MMD-only rendering boundary. Camera angles are degrees; distance/target use MMD units. */
export class MmdStage {
  private framingCamera: CameraConfig | null = null;
  private framingRevision = 0;
  private readonly scene = new Scene();
  private readonly renderer: WebGLRenderer;
  private readonly camera = new PerspectiveCamera(32, 1, 0.1, 3000);
  private readonly controls: CameraController;
  private readonly resizeObserver: ResizeObserver;
  private readonly grid: GridHelper | null;
  private settings?: AppSettings;
  private mesh: SkinnedMesh | null = null;
  private animation: LayeredMmdAnimation | null = null;
  private motionTransition: MotionTransition | null = null;
  /** R29 display bridge for every hand-off nobody wrapped in motionTransition. */
  private continuity?: StageContinuity;
  /** C2 换成她: the model on stage fades out (still moving), the next one fades in once posed (presence-fade.ts). */
  private presence?: PresenceFade;
  private readonly blushSeen = new BlushSeen();
  private firstShown = false;
  private presenceShown = '';
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  /** R29/B05: the one eyelid writer (natural blink vs contact/cheek/fatigue closure). */
  private eyelidCompositor?: EyelidCompositor;
  /** Procedural life (procedural-life.ts): generated breath, gaze, tilt, sway, blink rhythm; developer toggle, default on. */
  private life: ProceduralLife<Bone> | null = new ProceduralLife<Bone>();
  private lifeEnabled = true;
  private lifeRig: LifeRig<Bone> | null = null;
  /** X1 (reply-thinking.ts): created by the first setReplyThinking. */
  private replyThinking?: ReplyThinking;
  /** 她自己的生活 (her-life-stage.ts): MoodView.herLife as procedural-life offsets and an optional held library pose. */
  private herLife?: HerLifeStage;
  private herLifePort?: HerLifeMotionPort;
  /** G1 猜拳 (rps-performance.ts): her raised hand, the count strokes, the hand shape and her face. */
  private rps?: RpsPerformance;
  private rpsPort?: RpsPort;
  /** P1 第二阶段 (pose-reaction-stage.ts): her attention to the user and the yawn / stretch / wave she caught or her own stretch. */
  private poseReaction?: PoseReactionStage;
  private poseReactionPort?: PoseReactionPort;
  /** I-006: the owners of her body other than a pose reaction (her own life's bodyOwned adds the reaction's stretch or wave). */
  private poseBodyOwners = false;
  private readonly lifePort: LifePort<Bone> = { rotate: (bone, x, y, z) => this.rotateBone(bone, x, y, z), head: (x, y, z) => this.rotateAutomaticHead(x, y, z), morph: (index, weight) => this.applyMorph(index, weight) };
  private modelUrl = "";
  private motionUrl = "";
  private pendingMotion: Promise<void> = Promise.resolve();
  private readonly motionClips = new Map<string, Promise<AnimationClip>>();
  /**
   * R29d: the selected layers as loaded (the user's choice) and what is
   * committed of them on this model: a library motion the fit check hides here
   * is held, not played, and comes back when the check or the model changes.
   */
  private motionSelection?: MotionSelection | null;
  private committedLayers?: MotionLayerClips | null;
  private heldLayers?: string[];
  /** R29d: sha256 of a selected layer's bytes (by asset URL) when the fit check knows it as a library motion. */
  private layerShas?: Map<string, string>;
  private modelGeneration = 0;
  private motionGeneration = 0;
  private settingsGeneration = 0;
  private disposed = false;
  private hostVisible = true;
  private previewSuspended = false;
  /** Click-through hit test: her alpha under the pointer, read after render only when asked (pixel-probe.ts). */
  readonly pixelProbe = new StagePixelProbe();
  private frameId = 0;
  private previousFrame = 0;
  private frameDue = 0;
  // Render eligibility survives a settings update resetting the frame clock.
  private hasRenderedModel = false;
  private elapsed = 0;
  private fatiguePresentation = new FatiguePresentation();
  private fatigueFrame: FatigueFrame = NEUTRAL_FATIGUE_FRAME;
  private lastSettingsCamera = "";
  private pointer = { x: 0, y: 0 };
  private gaze = { x: 0, y: 0 };
  /** R29d: the head gaze follows critically damped (procedural.ts dampCritical); its own velocity. */
  private gazeVelocity?: { x: number; y: number };
  /** R29f: cursor readings as keyframes for the gaze (pointer-keys.ts). */
  private pointerKeys?: PointerKeys;
  private eyeGaze = { x: 0, y: 0 };
  private speaking = false;
  private speakingSources?: SpeakingSources;
  private frameHeartbeat?: FrameHeartbeat;
  /** True while the dance is on (the R15 motion). Whether she dances at all is her choice (M1) unless "让她一直跟着跳" is on. */
  private musicEnabled = false;
  private readonly musicDance = new MusicDance();
  /** M1: music is audible and allowed (what the audio path reports), and her choice about it. Created when the music settings arrive; absent = the original R15 path. */
  private musicHearing = false;
  /** I-017: when the last loud sample came (performance.now ms), for the state the pet window reports. */
  private musicLoudAt = -Infinity;
  private musicChoice?: MusicChoice;
  /** The last music tier told to onMusicTier (体验记录). */
  private reportedMusicTier: 'none' | 'nod' | 'dance' = 'none';
  private musicNod?: MusicNod;
  /** R18: the one "she heard it" look per audible song (music-listen.ts), and the side it tilts to next. */
  private musicListen?: MusicListenCue;
  private musicListenSide = 1;
  /** I-016: the fast "is it music" layer (music-likeness.ts) on every capture sample, and the host's slower verdict for the developer line. */
  private musicLikeness?: MusicLikeness;
  private listenKindLine = '';
  private musicBeat?: { headX: number; headZ: number; bodyZ: number };
  private musicSettings = normalizeMusicSettings(undefined);
  private musicManualHeadBlocked = false;
  private musicCameraEditing = false;
  private musicSuppressed = false;
  private musicBlockReason: string | null = null;
  private musicSignal: { sample: MusicEnergySample; active: boolean; pulse: boolean; strength: number } | null = null;
  private musicFrameSerial = 0;
  private musicPose = { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 };
  private readonly musicPoint = new Vector3();
  private readonly moodFeedback = new MoodFeedback();
  private cheekMotion = new CheekPinchMotion();
  private cheekAnchors: BlushAnchors | null = null;
  private moodView: MoodView | null = null;
  private moodContact: MoodContact = { ...EMPTY_CONTACT };
  private moodFaceBlocked = false;
  private moodMouthBlocked = false;
  /** R29d/X-089: eased ownership of the mouth by a selected expression with mouth tracks (channel-compositors.ts). */
  private manualMouth = 0;
  private moodHeadBlocked = false;
  private naturalBlink = 0;
  private finalEyeClosure = 0;
  private drowsyExpression?: DrowsyExpression;
  private drowsySuppressed = false;
  /** I-024: the half-lid morph the drowsy face writes this frame (Gene 95, else the profile's jitome slot; -1 none). */
  private drowsyEyeIndex = -1;
  private drowsyPendingSettings = 0;
  private smileIndex = -1;
  private sadIndex = -1;
  private blushChannel: BlushChannel | null = null;
  private proceduralBlush: ProceduralBlush | null = null;
  /** I-024: the card set from outside (the host: the user's choices, haiku's matches) for the model shown now; null: none. */
  private modelCapabilities: ModelCapabilities | null = null;
  /** I-024: the card the stage derives itself from its own model profile while none was set from outside (cached per profile). */
  private derivedCapabilities: { profile: object; card: ModelCapabilities } | null = null;
  /** I-024: a non-Gene model's own blush morph (profile shy slot), shown instead of the procedural blush when its card has 能脸红 on. */
  private cardBlush: BlushChannel | null = null;
  /** I-024 睡姿 (sleep-pose.ts): its own additive layer on the profile's neck and head, only while the card has it on. */
  private sleepPose?: SleepPose;
  private sleepFrame: SleepPoseFrame = NEUTRAL_SLEEP_FRAME;
  /** Phase lag the slower sleep breath gave the legacy breath sine (s); 0 until she first sleeps, so nothing else changes. */
  private breathLag = 0;
  /** I-024 "试一下" (capability-preview.ts): this frame's amounts. */
  private capabilityPreviews?: CapabilityPreviews;
  private capabilityPreview: CapabilityPreviewFrame = NO_CAPABILITY_PREVIEW;
  private proceduralTears: ProceduralTears | null = null;
  private cryingTimeline = new CryingTimeline();
  private cryingFrame: CryingFrame | null = null;
  private tearsVerifiedGene = false;
  private tearsAnchorsProbed = false;
  private tearsAnchors: BlushAnchors | null = null;
  private tearsReason = '泪水定位尚未就绪';
  private blushSupport = '红晕定位尚未就绪';
  private blushCalibration: BlushCalibration = structuredClone(DEFAULT_BLUSH_CALIBRATION);
  private blushCalibrationModelUrl = '';
  private blushPreviewUntil = 0;
  private blushPreviewing = false;
  private headContactProfile: HeadContactProfile | null = null;
  /** Adaptation layer step 1: semantic morph slots, calibration and measured face points (model-profile.ts). */
  private modelProfile: StageModelProfile | null = null;
  /** Adaptation layer step 2: library VMDs retargeted from Gene and fit-checked per model (motion-retarget.ts). */
  private motionRetarget: StageMotionRetarget | null = null;
  private chatGesturePlayer: ChatGesturePlayer | null = null;
  private chatGestureGeneration = 0;
  private chatGestureBlocked = false;
  private chatGestureBlockReason: 'manual-gesture' | 'manual-pose' | 'motion-loading' | null = null;
  private readonly chatGestureIds = new Set<string>();
  private readonly chatGestureClips = new Map<string, Promise<AnimationClip>>();
  private readonly defaultPoseChecks = new Map<string, Promise<boolean>>();
  private chatGestureResource: ChatGestureResource | null = null;
  private chatGestureError = '';
  /** 她的动作 (her-action.ts, T-211): one of Codex's one-shot actions from a test command; null without a model. */
  private herAction: HerActionPlayer | null = null;
  private herActionIds?: Set<string>;
  private herActionClips?: Map<string, Promise<AnimationClip>>;
  private herActionGeneration = 0;
  private herActionInfo: { cueId: string; action: string; status: HerActionStatus; missing: string[]; detail: string; sha256: string | null } | null = null;
  /** 她的动作 with a companion (哈欠捂嘴): the P1 yawn offered as one local cue on the same clock (poseReactionView). */
  private herActionYawn: { id: string; at: number } | null = null;
  /** T-215 嘴和眼睑的短暂独占 (face-exclusive.ts): the face actions' one writer per mesh; null without a model. */
  private faceExclusive: FaceExclusive | null = null;
  private faceActionGeneration = 0;
  private faceActionClips?: Map<string, Promise<{ morphs: readonly { morphName: string; frameNum: number; weight: number }[] }>>;
  /** Speech about to start (the voice output is loading), per window; performance.now() of the report, 0 when not. */
  private speechPrepare?: { local: number; remote: number };
  /** The eyelid compositor's held closure last frame (a touch, a pinch, drowsy lids): an eyelid face shape gives way to it. */
  private lidHeld = 0;
  /** Speech meeting a mouth face shape (performance.now() ms): when it was prepared, when it sounded, when the mouth was clear. */
  private faceSpeech: { id: string; prepareAt: number | null; speakingAt: number | null; clearAt: number | null; releasedBy: string | null; weightAtSound: number | null } | null = null;
  private behaviorMotion: BehaviorMotionPlayer | null = null;
  private visualPreview: { value:AuthoringPreview; resource?:ExpressionResource; model:number; ready:boolean; reporting:boolean;
    resolve:(ready:boolean)=>void; timer:ReturnType<typeof setTimeout> } | null = null;
  private bodyPreview: { value:BodyPosePreview; model:number; overlay:PersonalizeStaticPose; ready:boolean; reporting:boolean;
    applied:boolean; resolve:(ready:boolean)=>void; timer:ReturnType<typeof setTimeout> } | null = null;
  private bodyPreviewGeneration = 0;
  private surprisePending:{ticket:number;id:string|null}|null=null;
  private surprisePreview:{view:SurprisePreviewGrant;model:number;overlay:SurpriseOverlay;start:number|null;status:'playing'|'partial'}|null=null;
  /** E1 惊喜 / 害羞 on any model (expression-show.ts): the recipe, its clock (frame time of its first frame; `clock` maps the time since then to the show's own, X-343) and when it was asked for. */
  private expressionShow: { recipe: ExpressionRecipe; mesh: object; start: number | null; requestedAt: number; strength: number; clock: ShowClock } | null = null;
  private bodyPreviewPending: {id:string;token:string;ticket:number}|null = null;
  private bodyPersonalize: { cue:BodyPosePresentation; token:string; model:number; overlay:PersonalizeStaticPose } | null = null;
  private headFrameClaim:PersonalizeStaticPose|null=null;
  private deferredAutoHead:[number,number,number][]=[];
  private readonly bodyPersonalizeConsumed = new Set<string>();
  private bodyMotion: BodyMotionController | null = null;
  private readonly bodyConsumedIds = new Set<string>();
  private bodyTargetSupported = false;
  private bodyReady = false;
  private qaStandGate: QaStableStandGate | null = null;
  private qaStandCommit: { model: number; motion: number; mesh: SkinnedMesh; animation: LayeredMmdAnimation;
    clip: AnimationClip; action: AnimationAction } | null = null;
  private bodyManualPose = false;
  private bodyManualGesture = false;
  private bodyDynamicPose = false;
  private bodyCameraEditing = false;
  private bodyWaitingForReply = false;
  private bodyInputBlocked = false;
  private behaviorBlocked = false;
  private typing = false;
  private physicsSettings = normalizeModelPhysicsSettings(undefined);
  private localPhysics: LocalModelPhysics | null = null;
  private lastPhysicsRelease: ReturnType<LocalModelPhysics['getState']> | null = null;
  private physicsSupport: ModelPhysicsSupport | null = null;
  private physicsGeneration = 0;
  private physicsPending: Promise<void> | null = null;
  private physicsError = '';
  private physicsSignature = '';
  private mouth = 0;
  private nextBlink = 2.5;
  private blinkStart = -10;
  private boneLayers: BoneSnapshot[] = [];
  private morphLayers: MorphSnapshot[] = [];
  private restPose: BoneSnapshot[] = [];
  private blinkIndex = -1;
  private mouthIndex = -1;
  private head?: Bone;
  private eyes: Bone[] = [];
  private chest?: Bone;
  private center?: Bone;
  private arms: { bone: Bone; roll: number }[] = [];
  private height = 20;
  private width = 12;
  private centerX = 0;
  private baseY = 0;
  private pendingModel: Promise<void> = Promise.resolve();
  private readonly rotation = new Euler();
  private readonly offset = new Quaternion();
  private readonly facePoint = new Vector3();
  private readonly gazeOrigin = new Vector3();
  private readonly eyePoint = new Vector3();
  private lastFaceAnchor = -Infinity;
  private readonly onVisibility = () => {
    this.reconcileVisibility();
  };
  private reconcileVisibility(): void {
    if (this.disposed) return;
    this.previousFrame = 0;
    const visible = this.hostVisible && !document.hidden;
    if (!visible) {
      this.cancelVisualPreview();
      this.cancelBodyPreview();
      this.cancelPersonalizeBody();
      this.withdrawDrowsyExpression();
      this.stopTears(true);
      this.cancelBodyMotion(true);
      this.physicsGeneration = (this.physicsGeneration ?? 0) + 1;
      this.physicsPending = null;
      this.localPhysics?.setVisible(false);
      this.resetMusicPresentation();
      this.hasRenderedModel = false;
      this.motionTransition?.dispose(); this.motionTransition = null;
      this.continuity?.reset('hidden');
      this.behaviorMotion?.stop();
      this.herAction?.cancel({ immediate: true }); // hidden: nothing on screen to hand back
      this.faceExclusive?.cut('hidden'); // T-215: a face shape nobody saw is not shown later
      this.cancelChatGesture();
      if (this.moodContact?.pinch) {
        this.localPhysics?.restore(); this.behaviorMotion?.restore(); this.herAction?.restore(); this.chatGesturePlayer?.restore(); this.restoreLayers();
        this.cheekMotion?.reset(); this.moodContact = { ...EMPTY_CONTACT };
      }
      this.blushPreviewUntil = 0;
      this.capabilityPreviews?.clear(); this.capabilityPreview = NO_CAPABILITY_PREVIEW; // I-024: a 试一下 is not resumed later
      this.proceduralBlush?.update(0, 0, this.camera);
      if (this.options.transparent) this.options.onFaceAnchor?.({ x: 0, y: 0, visible: false });
      this.controls.setEnabled(false);
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    } else if (!this.frameId) {
      this.frameId = requestAnimationFrame(this.tick);
    }
    if (visible) {
      this.rebuildTears();
      this.localPhysics?.setVisible(true);
      void this.ensureLocalPhysics();
    }
    this.renderPhysicsDiagnostics();
    if (this.options.transparent) return;
    if (!visible) {
      if (this.previewSuspended) return;
      this.previewSuspended = true;
      this.settingsGeneration++;
      this.modelGeneration++;
      this.motionGeneration++;
      this.clearModel();
      this.modelUrl = this.motionUrl = "";
      this.pendingModel = Promise.resolve();
      this.renderer.renderLists.dispose();
      this.renderer.clear();
      this.options.onStatus?.("预览已暂停 · 重开窗口自动恢复");
    } else if (this.previewSuspended) {
      this.previewSuspended = false;
      if (this.settings) void this.applySettings(this.settings);
    }
  }
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.cancelSurprisePreview();
    this.stopTears(true);
    this.options.onError?.("显卡上下文已丢失，请重新打开窗口恢复模型。");
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly options: StageOptions = {},
  ) {
    this.renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = SRGBColorSpace;
    // The control panel supplies its own dark gradient; pet and preview share transparent output.
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = "mmd-canvas";
    this.renderer.domElement.style.cssText =
      "display:block;width:100%;height:100%;touch-action:none;";
    container.append(this.renderer.domElement);
    this.scene.add(new AmbientLight(0xffffff, 1.1));
    const key = new DirectionalLight(0xfff2e6, 1.6);
    key.position.set(7, 25, 20);
    this.scene.add(key);
    const fill = new DirectionalLight(0xcddcff, 0.35);
    fill.position.set(-15, 10, -8);
    this.scene.add(fill);
    this.grid = options.transparent
      ? null
      : new GridHelper(60, 30, 0x344452, 0x263440);
    if (this.grid) this.scene.add(this.grid);
    this.camera.position.set(0, 10, 30);
    const initial: CameraConfig = { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 };
    this.controls = new CameraController(this.renderer.domElement, initial, camera => {
      this.setCamera(camera);
      this.options.onCameraChange?.(camera);
    }, enabled => {
      this.bodyCameraEditing = enabled;
      this.musicCameraEditing = enabled;
      if (enabled) this.cancelBodyMotion();
      this.syncMusicSuppression();
      this.options.onCameraEditChange?.(enabled);
    }, () => this.frame('full'));
    this.setCamera(initial);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.onContextLost,
    );
    this.resize();
    this.frameId = requestAnimationFrame(this.tick);
    this.reconcileVisibility();
  }

  /** Explicit controls-only, model-canvas reference. No desktop/media capture,
   * camera edit, animation advancement or persistent rendering state. */
  async captureCharacterStickerReference(expectedUrl:string):Promise<import('../../shared/character-sticker').StickerCapture>{
    const generation=this.modelGeneration;await this.pendingModel;
    if(this.options.transparent||this.disposed||!this.hostVisible||document.hidden||!this.mesh||this.modelUrl!==expectedUrl||generation!==this.modelGeneration||!this.hasRenderedModel||this.controls.interacting)throw Error('当前模型预览还不能作为参考，请等待载入并结束镜头调整。');
    const input=this.renderer.domElement;if(!input.width||!input.height)throw Error('模型预览没有可见尺寸。');
    const image=document.createElement('canvas'),scale=Math.min(1,1024/input.width,1024/input.height);
    image.width=Math.max(1,Math.floor(input.width*scale));image.height=Math.max(1,Math.floor(input.height*scale));
    const context=image.getContext('2d');if(!context)throw Error('模型参考暂不可用。');const gridVisible=this.grid?.visible;
    try{if(this.grid)this.grid.visible=false;this.renderer.render(this.scene,this.camera);context.drawImage(input,0,0,image.width,image.height);const png=image.toDataURL('image/png');if(this.disposed||this.modelGeneration!==generation||this.modelUrl!==expectedUrl)throw Error('模型已经变化。');return{png,modelUrl:expectedUrl,loadGeneration:generation};}
    finally{if(this.grid&&gridVisible!==undefined)this.grid.visible=gridVisible;if(!this.disposed)this.renderer.render(this.scene,this.camera);image.width=image.height=0;}
  }

  /**
   * C2 角色页: a small half-body picture of her as she stands in the control window's preview now, for her card.
   * Controls only; one extra render with a temporary camera (the user's camera, animation and settings are
   * untouched). The PNG stays on this computer (electron/character-avatars.ts).
   */
  async captureCharacterAvatar(expectedUrl: string, side = 192): Promise<string> {
    const generation = this.modelGeneration; await this.pendingModel;
    if (this.options.transparent || this.disposed || !this.hostVisible || document.hidden || !this.mesh || !this.head || this.modelUrl !== expectedUrl
      || generation !== this.modelGeneration || !this.hasRenderedModel || this.controls.interacting || (this.presence?.value ?? 1) < 1)
      throw Error('模型预览还没准备好，稍后再截头像。');
    const input = this.renderer.domElement, width = input.width, height = input.height;
    if (!width || !height) throw Error('模型预览没有可见尺寸。');
    const head = this.head.getWorldPosition(new Vector3());
    // Half body: from a little above the head to about the chest, centred; square crop of the canvas.
    const top = head.y + this.height * 0.09, bottom = head.y - this.height * 0.3, span = top - bottom, crop = Math.min(width, height);
    const camera = new PerspectiveCamera(26, width / height, 0.1, Math.max(3000, this.height * 50));
    const visible = span * height / crop, distance = visible / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
    camera.position.set(this.centerX, (top + bottom) / 2, head.z + distance);
    camera.lookAt(this.centerX, (top + bottom) / 2, head.z);
    camera.updateMatrixWorld(true);
    const image = document.createElement('canvas'); image.width = image.height = side;
    const context = image.getContext('2d'); if (!context) throw Error('头像暂时截不了。');
    const gridVisible = this.grid?.visible;
    try {
      if (this.grid) this.grid.visible = false;
      this.renderer.render(this.scene, camera);
      context.drawImage(input, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, side, side);
      const png = image.toDataURL('image/png');
      if (this.disposed || this.modelGeneration !== generation || this.modelUrl !== expectedUrl) throw Error('模型已经变化。');
      return png;
    } finally {
      if (this.grid && gridVisible !== undefined) this.grid.visible = gridVisible;
      if (!this.disposed) this.renderer.render(this.scene, this.camera);
      image.width = image.height = 0;
    }
  }

  async applySettings(settings: AppSettings): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.settingsGeneration;
    this.drowsyPendingSettings = generation;
    try {
    this.settings = settings;
    if (!this.options.transparent && (!this.hostVisible || document.hidden)) {
      this.reconcileVisibility();
      return;
    }
    const cameraKey = cameraSignature(settings.camera);
    const modelUrl = settings.model?.url ?? "";
    if (cameraKey !== this.lastSettingsCamera && !this.controls.interacting) {
      this.setCamera(settings.camera);
      // Same model already shown: frame it in this task, so the default crop is never drawn.
      // A model about to change is framed by loadModel() with its own bounds instead.
      if (modelUrl === this.modelUrl) this.frameIfUnframed();
    }
    if (modelUrl !== this.modelUrl) {
      this.modelUrl = modelUrl;
      this.pendingModel = this.loadModel(modelUrl);
    }
    await this.pendingModel;
    if (
      this.disposed ||
      generation !== this.settingsGeneration ||
      modelUrl !== this.modelUrl
    )
      return;
    const layers = getMotionLayerAssets(settings);
    const legacy = !settings.motionLayers;
    const motionUrl = JSON.stringify([legacy, layers.pose?.url, layers.gesture?.url, layers.expression?.url]);
    if (motionUrl !== this.motionUrl) {
      this.motionUrl = motionUrl;
      this.pendingMotion = this.loadMotions(layers, legacy);
    }
    await this.pendingMotion;
    // C2: her pose and motions are in place; the new model fades in from here.
    if (!this.disposed && generation === this.settingsGeneration && modelUrl === this.modelUrl) this.revealModel();
    } finally {
      if (this.drowsyPendingSettings === generation) this.drowsyPendingSettings = 0;
    }
  }

  setPointer(pointer: PointerPosition): void {
    this.pointer.x = clamp(pointer.x, -1, 1);
    this.pointer.y = clamp(pointer.y, -1, 1);
  }

  setSpeaking(active: boolean, source: SpeakingSource = 'local'): void {
    this.speaking = (this.speakingSources ??= new SpeakingSources()).set(source, active);
    // T-215: the first sound owns the mouth; a mouth face shape still up hands it back from what shows (no wait, no cut).
    if (this.speaking) this.faceGivesWayToSpeech('speaking');
    this.syncMusicSuppression();
    this.updateBodyMotion();
  }

  /**
   * T-215: speech is about to start (the voice output began loading: synthesis, the device), or no longer (idle, error),
   * from this window or the other one. A mouth face shape starts handing back now, so it is out of the way by the first
   * sound when the engine takes longer than its release; while prepared, no new one starts. Only a flag and the hand-back:
   * nothing here waits, and the sound itself never waits for the face.
   */
  setSpeechPreparing(active: boolean, source: SpeakingSource = 'local'): void {
    const prepare = this.speechPrepare ??= { local: 0, remote: 0 }, key = source === 'remote' ? 'remote' : 'local';
    prepare[key] = active === true ? Math.max(1, performance.now()) : 0;
    if (active === true) this.faceGivesWayToSpeech('prepare');
  }
  /** Prepared within the last 15 s (a lost "idle" never holds the mouth for long). */
  private speechPreparing(): boolean {
    const prepare = this.speechPrepare, now = performance.now();
    return !!prepare && ((prepare.local > 0 && now - prepare.local < 15_000) || (prepare.remote > 0 && now - prepare.remote < 15_000));
  }
  private faceGivesWayToSpeech(how: 'prepare' | 'speaking'): void {
    const face = this.faceExclusive, mouth = face?.getState().mouth, at = performance.now();
    if (mouth && this.faceSpeech?.id !== mouth.id) this.faceSpeech = { id: mouth.id, prepareAt: null, speakingAt: null, clearAt: null, releasedBy: null, weightAtSound: null };
    const record = this.faceSpeech;
    // Diagnostics only (pretrial reads them): the first sound after a prepared hand-back is still that shape's story.
    if (record && (mouth?.id === record.id || (how === 'speaking' && record.prepareAt !== null && at - record.prepareAt < 15_000))) {
      if (how === 'prepare') record.prepareAt ??= at;
      else if (record.speakingAt === null) { record.speakingAt = at; record.weightAtSound = mouth?.id === record.id ? mouth.weight : 0; }
      if (mouth) record.releasedBy ??= how;
      this.renderFaceDiagnostics();
    }
    if (mouth) face!.cancel('mouth', 'speech');
  }

  /** Developer comparison toggle "程序化小动作与表情": off fades back to the legacy breath, gaze and blink. */
  setProceduralLife(enabled: boolean): void { this.lifeEnabled = enabled === true; }

  /** X1: the accepted reply still waiting for its first word (src/ui/reply-thinking.ts), or null to release. Presentation only. */
  setReplyThinking(key: string | null): void {
    if (key === null && !this.replyThinking) return;
    (this.replyThinking ??= new ReplyThinking()).set(key);
  }

  /** The existing reply lifecycle supplies this local presentation gate only. */
  setBodyWaitingForReply(active: boolean): void {
    this.bodyWaitingForReply = active;
    this.updateBodyMotion();
  }
  /** Narrow new-body gate; ordinary face/M004 presentation is unchanged. */
  setBodyInputBlocked(blocked: boolean): void {
    this.bodyInputBlocked = blocked;
    if (blocked) this.cancelBodyMotion();
    this.updateBodyMotion();
  }

  /** Host-owned presentation choices, independent of cards and legacy settings. */
  setPhysicsSettings(settings: ModelPhysicsSettings): void {
    if (this.disposed) return;
    const previous = this.physicsSettings ?? normalizeModelPhysicsSettings(undefined);
    this.physicsSettings = normalizeModelPhysicsSettings(settings, previous);
    if (previous.hair.enabled !== this.physicsSettings.hair.enabled || previous.chest.enabled !== this.physicsSettings.chest.enabled) {
      this.physicsGeneration = (this.physicsGeneration ?? 0) + 1;
      this.physicsPending = null;
      this.physicsError = '';
    }
    this.localPhysics?.configure(this.physicsSettings);
    void this.ensureLocalPhysics();
    this.renderPhysicsDiagnostics();
  }

  getPhysicsState(): ModelPhysicsState {
    if (this.localPhysics) return this.localPhysics.getState();
    const settings = this.physicsSettings ?? normalizeModelPhysicsSettings(undefined);
    const unavailable = { supported: false, bones: 0, bodies: 0, reason: '载入模型后显示支持情况' };
    const support = this.physicsSupport ?? { hair: unavailable, chest: unavailable };
    const requested = settings.hair.enabled || settings.chest.enabled;
    const supported = (settings.hair.enabled && support.hair.supported) || (settings.chest.enabled && support.chest.supported);
    return {
      support: structuredClone(support), enabled: { hair: settings.hair.enabled, chest: settings.chest.enabled },
      running: false, quality: settings.quality, bodyCount: 0, constraintCount: 0, steps: 0, liveObjects: 0, avgStepMs: 0,
      status: this.disposed ? 'disposed' : this.physicsError ? 'error' : !this.mesh || !requested ? 'off'
        : !this.hostVisible || document.hidden ? 'hidden' : !supported ? 'unsupported' : 'ready',
    };
  }

  private physicsWanted(): boolean {
    const settings = this.physicsSettings;
    return !!settings && !!this.mesh && this.options?.transparent === true && !this.disposed
      && this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0
      && ((settings.hair.enabled && settings.hair.strength > 0 && !!this.physicsSupport?.hair.supported)
        || (settings.chest.enabled && settings.chest.strength > 0 && !!this.physicsSupport?.chest.supported));
  }

  /** Kept lazy so ordinary preview/off never initializes a second WASM module. */
  private async loadPhysicsRuntime(): Promise<AmmoModule> {
    return (await import('./ammo-runtime')).loadAmmo();
  }

  private ensureLocalPhysics(): Promise<void> {
    if (this.localPhysics || this.physicsPending || this.physicsError || !this.physicsWanted()) return this.physicsPending ?? Promise.resolve();
    const mesh = this.mesh!, generation = this.physicsGeneration ?? 0;
    const pending: Promise<void> = this.loadPhysicsRuntime().then(ammo => {
      if (this.mesh !== mesh || generation !== (this.physicsGeneration ?? 0) || !this.physicsWanted()) return;
      // No native world is allocated until frame() sees the final base pose.
      this.localPhysics = new LocalModelPhysics(mesh, ammo, this.physicsSettings);
    }).catch(() => {
      if (!this.disposed && this.mesh === mesh && generation === (this.physicsGeneration ?? 0)) {
        this.physicsError = '本地物理组件未能启动，请关闭效果后重试';
      }
    }).finally(() => {
      if (this.physicsPending === pending) this.physicsPending = null;
      this.renderPhysicsDiagnostics();
    });
    this.physicsPending = pending;
    return pending;
  }

  private publishPhysicsState(): void {
    const state = this.getPhysicsState();
    const status = state.running && (state.status === 'ready' || state.status === 'running') ? 'running' : state.status;
    const signature = JSON.stringify([state.support, state.enabled, state.quality, status]);
    if (signature === this.physicsSignature) return;
    this.physicsSignature = signature;
    this.options?.onPhysicsState?.(state);
  }

  private renderPhysicsDiagnostics(): void {
    const canvas = this.renderer?.domElement;
    if (canvas) canvas.dataset.modelPhysics = JSON.stringify({ ...this.getPhysicsState(),
      previewOnly: this.options?.transparent !== true, error: this.physicsError ?? '',
      parts: this.localPhysics?.getDiagnostics(this.camera, { width: this.container.clientWidth, height: this.container.clientHeight }) ?? null,
      lastPhysicsRelease: this.lastPhysicsRelease ?? null });
    this.publishPhysicsState();
  }

  /**
   * I-024 (docs/claude/2026-11-04-i024-model-check-plan.md): this model's capability card (shared/model-capability.ts), from its
   * profile, haiku's matches and the user's choices. The stage turns eyelids, blush and the sleep pose on only from it (the
   * reviewed Gene keeps its reviewed amounts). null: not known yet (nothing new turned on).
   *
   * Every new thing follows capabilityEnabled(card, id) and the profile's own indices (a slot the stage cannot see keeps
   * the old path): 能闭眼 the drowsy eyelids, 能脸红 the model's own blush morph instead of the procedural one, 能做睡姿
   * the sleep-pose layer, 困的脸 the drowsy face on its own sad/jitome slots, 能流泪 the tears surface (only where the
   * face anchors were found). The reviewed Gene keeps its reviewed eyelids, drowsy face, tears and procedural blush; only
   * an explicit 关 turns them off there. The card is for the model shown now: a model change drops it (send it again once the
   * new model is loaded); null, or none yet: the stage derives one from its own profile (no user choices, no haiku).
   */
  setModelCapabilities(card: ModelCapabilities | null): void {
    const before = this.blushMode(), tearsBefore = JSON.stringify(this.tearsGate());
    this.modelCapabilities = card ?? null;
    this.cardBlush = this.resolveCardBlush();
    if (!this.mesh || !this.head || this.disposed) return;
    // Tears wrap the blush materials: a blush rebuild unwinds and rebuilds both; otherwise only the tears follow the card.
    if (this.blushMode() !== before) this.rebuildBlush();
    else if (JSON.stringify(this.tearsGate()) !== tearsBefore) { this.proceduralTears?.dispose(); this.proceduralTears = null; this.rebuildTears(); }
  }
  /**
   * I-024 "试一下" on the character page: show this capability once on the pet (eyes closed ~1.5 s, a blush ~2 s, あ
   * ~0.6 s, the sleep pose ~3 s then waking, one small wave). false: the card says this model cannot, or the stage
   * cannot show it now (no model yet, hidden, a picked expression or motion owns that part). Everything goes back.
   */
  previewCapability(id: ModelCapabilityId): boolean {
    if (!isModelCapabilityId(id) || this.disposed || !this.mesh || !this.hostVisible || (typeof document !== 'undefined' && document.hidden)
      || !this.hasRenderedModel || !capabilityEnabled(this.capabilities(), id)) return false;
    const previews = this.capabilityPreviews ??= new CapabilityPreviews();
    if (previews.showing(id)) return true;
    if (!this.capabilityPreviewPossible(id)) return false;
    return previews.start(id, this.elapsed ?? 0, this.mesh);
  }
  private capabilityPreviewPossible(id: ModelCapabilityId): boolean {
    switch (id) {
      case 'closeEyes': return this.blinkIndex >= 0 && !this.moodFaceBlocked;
      case 'mouth': return this.mouthIndex >= 0 && !this.moodMouthBlocked;
      case 'blush': return !!this.moodView && !this.moodFaceBlocked && (!!this.proceduralBlush || !!this.shownBlushChannel());
      case 'sleepPose': return !!this.head && !this.sleepHeadOwned();
      case 'drowsyFace': return this.moodView?.expressions === true && !this.moodFaceBlocked && this.drowsyFaceAllowed() && this.drowsyTargetsFound();
      case 'tears': return !!this.moodView && !this.moodFaceBlocked && this.proceduralTears?.getState().supported === true;
      case 'gesture': {
        // The pose-reaction wave starts only when she is free for it (pose-reaction-stage.ts free()).
        const gates = this.herLife?.gates;
        return !!gates && gates.expressive && !gates.engaged && !gates.asleep && !gates.bodyOwned && !this.rps?.active && !this.poseReaction?.reacting;
      }
    }
    return false;
  }
  /**
   * I-024: the card in use. The one set from outside wins; until then the stage derives one from its own model profile
   * (deriveModelCapabilities: no user choices, no haiku), so the new presentation works without the host. No profile: null.
   */
  private capabilities(): ModelCapabilities | null {
    if (this.modelCapabilities) return this.modelCapabilities;
    const profile = this.modelProfile?.profile;
    if (!profile) return null;
    if (this.derivedCapabilities?.profile !== profile) this.derivedCapabilities = { profile, card: deriveModelCapabilities(profile) };
    return this.derivedCapabilities.card;
  }  /** I-024: 'off' (the user turned 能脸红 off), 'card' (the model's own blush morph) or 'default' (procedural, else the old channel). */
  private blushMode(): string { return this.blushOff() ? 'off' : this.cardBlush ? `card:${this.cardBlush.index}` : 'default'; }
  private blushOff(): boolean { return this.capabilities()?.blush?.choice === 'off'; }
  private resolveCardBlush(): BlushChannel | null {
    if (this.tearsVerifiedGene === true || !capabilityEnabled(this.capabilities(), 'blush')) return null;
    const entry = this.modelProfile?.profile?.morphs?.shy, count = this.mesh?.morphTargetInfluences?.length ?? 0;
    return entry && Number.isInteger(entry.index) && entry.index >= 0 && entry.index < count ? { index: entry.index, name: entry.name ?? 'shy' } : null;
  }
  /** The blush morph this frame writes (none while 能脸红 is off). */
  private shownBlushChannel(): BlushChannel | null { return this.blushOff() ? null : this.cardBlush ?? this.blushChannel ?? null; }
  /** I-024 疲倦眼皮: the reviewed Gene unless 能闭眼 is off; another model only when its card has it on and it has a blink morph. */
  private fatigueEyelidsAllowed(): boolean {
    if (this.tearsVerifiedGene === true) return this.capabilities()?.closeEyes?.choice !== 'off';
    return capabilityEnabled(this.capabilities(), 'closeEyes') && this.blinkIndex >= 0;
  }
  /** I-024 困的脸: the reviewed Gene unless it is off; another model only when its card has it on. */
  private drowsyFaceAllowed(): boolean {
    if (this.tearsVerifiedGene === true) return this.capabilities()?.drowsyFace?.choice !== 'off';
    return capabilityEnabled(this.capabilities(), 'drowsyFace');
  }
  private drowsyTargetsFound(): boolean {
    return this.tearsVerifiedGene === true ? !!resolveDrowsyTargets(this.mesh ?? undefined, this.head, true)
      : !!profileDrowsyTargets(this.mesh ?? undefined, this.head, { sad: this.sadIndex, jitome: this.modelProfile?.profile?.morphs?.jitome?.index ?? -1, blink: this.blinkIndex });
  }
  /** I-024 流泪: who may place tears (gene: the reviewed Gene with its cover material; card: another model, same anchor gates); reason when off by choice. */
  private tearsGate(): { gene: boolean; card: boolean; reason: string | null } {
    const off = this.capabilities()?.tears?.choice === 'off', gene = this.tearsVerifiedGene === true;
    return { gene: gene && !off, card: !gene && capabilityEnabled(this.capabilities(), 'tears'), reason: off ? this.capabilityNote('tears', '流泪', '') : null };
  }
  /** Eyelid closure the previews ask for: 试一下 能闭眼, and the eyes of the sleep preview when the model can close them. */
  private previewClosure(): number {
    const preview = this.capabilityPreview ?? NO_CAPABILITY_PREVIEW;
    return Math.max(preview.closure, capabilityEnabled(this.capabilities(), 'closeEyes') ? preview.sleepEyes : 0);
  }
  private sleepNeck(): Bone | undefined {
    const neck = this.modelProfile?.bone?.('neck') ?? this.findBone(['首', 'neck', 'Neck']);
    return neck && neck !== this.head ? neck : undefined;
  }
  /** A higher owner of her head: a picked motion that moves it, an automatic body motion, music, the game, a head claim, a preview. */
  private sleepHeadOwned(): boolean {
    const owns = (bone: Bone | undefined) => !!bone && this.bodyMotion?.ownsProperty(`.bones[${bone.name}].quaternion`) === true;
    return (this.moodHeadBlocked === true && (this.bodyManualPose === true || this.bodyManualGesture === true))
      || owns(this.head) || owns(this.sleepNeck()) || this.musicEnabled === true || this.musicDance?.getState().releasing === true
      || this.rps?.active === true || !!this.headFrameClaim
      || !!(this.visualPreview || this.bodyPreview || this.surprisePreview || this.expressionShow);
  }
  /** I-024 睡姿: one frame of the layer (the fatigue phase, or the 试一下 override); applied by applySleepPose. */
  private frameSleepPose(delta: number, preview: boolean): SleepPoseFrame {
    const view = this.moodView;
    const allowed = !!this.mesh && !!this.head && capabilityEnabled(this.capabilities(), 'sleepPose') && !this.sleepHeadOwned()
      && (preview || (view?.expressions === true && (view.snapshot?.intensity?.posture ?? 0) > 0));
    this.sleepFrame = (this.sleepPose ??= new SleepPose()).frame(delta, { owner: this.mesh, phase: preview ? 'asleep' : view?.fatigue?.phase ?? null,
      allowed, rate: preview ? 2 : 1, side: hashSeed(view?.characterId ?? '') & 1 ? -1 : 1 });
    return this.sleepFrame;
  }
  /** Neck and head offsets through the program layer (remembered, restored next frame); the head through the automatic-head path. */
  private applySleepPose(sleep: SleepPoseFrame): void {
    if (!sleep.active || !(sleep.amount > 0)) return;
    const neck = this.sleepNeck();
    if (neck) this.rotateBone(neck, sleep.neckX, 0, sleep.neckZ);
    // No separate neck: the head takes the neck's share too.
    this.rotateAutomaticHead(sleep.headX + (neck ? 0 : sleep.neckX), 0, sleep.headZ + (neck ? 0 : sleep.neckZ));
  }
  private sleepPoseState(): string {
    const entry = this.capabilities()?.sleepPose;
    return !entry ? 'no-card' : entry.choice === 'off' ? 'user-off' : !entry.enabled ? 'not-detected'
      : (this.sleepFrame?.amount ?? 0) > 0 ? 'shown' : this.sleepHeadOwned() ? 'yielding' : 'on';
  }
  /** I-024 gesture preview: the pose-reaction wave offered as one cue over what the host sent. */
  private poseReactionView(): unknown {
    const wave = this.capabilityPreview?.wave;
    const yawn = this.herActionYawn;
    if (yawn && Date.now() - yawn.at > 1_000) this.herActionYawn = null; // taken on its first frame (once per id); then the host view again
    if (!wave && this.herActionYawn) {
      // 她的动作 哈欠捂嘴: the P1 yawn as one local cue over what the host sent; the reaction's own owners decide (it yields like a yawn).
      const real = readPoseReactionView(this.moodView?.pose);
      return { attention: real?.attention ?? 0, boost: real?.boost ?? 1, cue: { id: this.herActionYawn.id, kind: 'yawn', source: 'own', at: this.herActionYawn.at, strength: 1 } };
    }
    if (!wave) return this.moodView?.pose;
    const real = readPoseReactionView(this.moodView?.pose);
    return { attention: real?.attention ?? 0, boost: real?.boost ?? 1, cue: { id: wave.id, kind: 'wave', source: 'own', at: wave.at, strength: 1 } };
  }
  /** Developer note (getMoodDegradation): why a card-driven feature is not shown. */
  private capabilityNote(id: ModelCapabilityId, what: string, kept: string): string {
    const entry = this.capabilities()?.[id];
    if (!entry) return `${what}按模型体检卡打开；体检卡还没到，${kept}`;
    if (entry.choice === 'off') return `角色页关了"${({ closeEyes: '能闭眼', blush: '能脸红', mouth: '有口型', sleepPose: '能做睡姿', gesture: '能做手势', drowsyFace: '困的脸', tears: '能流泪' } as const)[id]}"：${what}不开`;
    if (!entry.detected) return `模型体检没找到${({ closeEyes: '眨眼部位', blush: '脸红表情', mouth: '口型', sleepPose: '脖子和头骨', gesture: '手臂骨骼', drowsyFace: '半闭眼或皱眉表情', tears: '双眼骨骼' } as const)[id]}：${what}不开，${kept}`;
    return '';
  }

  /** Trusted host scope loss; no replacement view, source-clock reset or replay. */
  invalidateMoodScope(): void {
    if (this.disposed) return;
    this.cancelBodyPreview();
    this.cancelPersonalizeBody();
    this.withdrawDrowsyExpression();
    this.localPhysics?.restore();
    this.motionTransition?.dispose(); this.motionTransition = null;
    this.behaviorMotion?.restore();
    this.herAction?.restore(); this.chatGesturePlayer?.restore();
    this.restoreLayers();
    this.moodView = null;
    this.moodContact = { ...EMPTY_CONTACT };
    this.cancelBodyMotion(true);
    // The body owner's binding-removal hook can reattach physics at dt=0.
    // Restore it again before cancelling the remaining inner presentation.
    this.localPhysics?.restore();
    this.chatGestureGeneration++;
    this.chatGesturePlayer?.cancel({ immediate: true });
    this.herActionGeneration++; this.herAction?.cancel({ immediate: true });
    this.faceActionGeneration++; this.faceExclusive?.cut('scope-lost'); this.lidHeld = 0;
    this.behaviorMotion?.stop();
    this.moodFeedback.reset();
    // X-089: without a mood view the stage shows the natural blink, not the compositor's output;
    // a closure it still held for this scope must not come back in the next one.
    this.eyelidCompositor?.reset();
    this.fatiguePresentation?.reset(); this.fatigueFrame = NEUTRAL_FATIGUE_FRAME;
    this.sleepPose?.reset(); this.sleepFrame = NEUTRAL_SLEEP_FRAME; // I-024: upright with the open eyes, at dt=0
    this.cheekMotion?.reset();
    this.blushPreviewUntil = 0; this.blushPreviewing = false;
    this.proceduralBlush?.update(0, 0, this.camera);
    this.stopTears(false);
    this.syncMusicSuppression(true);
    // Re-evaluate the retained manual/base actions at their existing times.
    this.animation?.helper.update(0);
    this.animateIdle(0);
    this.localPhysics?.frame(0);
    if (this.renderer?.domElement) this.renderer.domElement.dataset.fatigue = JSON.stringify({ phase: 'inactive',
      ...NEUTRAL_FATIGUE_FRAME, automaticSleepPose: 'inactive' });
  }

  /** G1 猜拳: the host's game view (null when it is over); the layer eases in and out by itself. */
  setRps(view: RpsView | null): void { (this.rps ??= new RpsPerformance()).cue(rpsStageCue(view)); }

  setMood(view: MoodView): void {
    const contextChanged = !!this.moodView && (this.moodView.characterId !== view.characterId || this.moodView.token !== view.token);
    // X-321: a face shape still waiting on its resource or its VMD belongs to the old conversation; it never starts in the
    // new one (as after invalidateMoodScope). One already holding the mouth or the lids hands back by itself (the key changes).
    // The same for a body action still loading; one already playing finishes (it is short and eases out by itself).
    if (contextChanged) { this.faceActionGeneration = (this.faceActionGeneration ?? 0) + 1; this.herActionGeneration++; }
    if (this.moodView && this.moodView.characterId !== view.characterId) { this.continuity?.reset('character-changed'); this.sleepPose?.reset(); }
    if (this.moodView && this.moodView.characterId !== view.characterId) this.replyThinking?.set(null); // X1: released from what is shown
    if(view.gesture){this.cancelBodyPreview();this.cancelPersonalizeBody();}
    // R29c: sleep phases, gestures and authored faces release the drowsy profile by its own fade (drowsyFrame).
    if (contextChanged || !view.expressions || !Number.isFinite(view.fatigue?.F)) this.withdrawDrowsyExpression();
    if (this.moodView && (this.moodView.characterId !== view.characterId || this.moodView.token !== view.token || (this.moodView.expressions && !view.expressions))) {
      this.cancelBodyPreview();
      this.cancelPersonalizeBody();
      this.cancelBodyMotion(true);
      this.localPhysics?.restore();
      this.motionTransition?.dispose(); this.motionTransition = null;
      this.cancelChatGesture();
      this.behaviorMotion?.stop();
      this.restoreLayers();
      this.moodFeedback.reset();
      this.fatiguePresentation?.reset(); this.fatigueFrame = NEUTRAL_FATIGUE_FRAME;
      if (contextChanged) { this.cheekMotion?.reset(); this.moodContact = { ...EMPTY_CONTACT }; }
      this.blushPreviewUntil = 0;
      this.proceduralBlush?.update(0, 0, this.camera);
      this.stopTears(false);
    }
    if (!view.gesture && this.moodView?.gesture) this.cancelChatGesture(true);
    this.moodView = view;
    this.updatePersonalizeBody(view);
    this.updateTears(0);
    this.updateBodyMotion();
    this.updateBehaviorMotion();
    if (view.gesture) void this.playChatGesture(view.gesture, view.token);
    this.localPhysics?.frame(0);
  }
  setMoodContact(contact: MoodContact): void {
    this.moodContact = { ...contact };
    if(contact.contact||contact.feeding||contact.pinch?.pinching||(contact.hover??0)>0){this.cancelBodyPreview();this.cancelPersonalizeBody();}
    this.syncMusicSuppression();
    if (contact.contact || contact.feeding || contact.pinch?.pinching || (contact.hover ?? 0) > 0) this.cancelBodyMotion();
    this.updateBodyMotion();
    this.updateBehaviorMotion();
    if (contact.contact || contact.feeding || (contact.hover ?? 0) > 0) this.cancelChatGesture(true);
  }
  /** Reuses the application's existing window/input ownership, not another mode. */
  setBehaviorBlocked(blocked: boolean): void {
    if (this.behaviorBlocked === blocked) return;
    this.behaviorBlocked = blocked;
    if (blocked) this.stopTears(false);
    this.syncMusicSuppression();
    if (blocked) this.cancelBodyMotion();
    this.updateBodyMotion();
    if (blocked) this.cancelChatGesture(true);
    this.updateBehaviorMotion();
  }
  /** R29b typing (behavior-gates.ts): pauses only NEW automatic behaviour; the living base keeps running. */
  setTyping(active: boolean): void {
    if (this.typing === active) return;
    this.typing = active;
    if (active) { this.cancelBodyMotion(); this.cancelChatGesture(true); }
    this.updateBodyMotion();
  }
  /** Sample the existing layer at dt=0; do not replace its spring with a timer. */
  private hasCheekPresentationResidual(): boolean {
    const frame = this.cheekMotion?.frame(0, { pinching: false, x: 0, y: 0, side: null }, {
      posture: 0, face: 0, playful: 0, mood: '', sensitivity: 0,
    });
    return !!frame && Object.values(frame).some(value => value !== 0);
  }
  private bodyGates(): BodyStageGates {
    const qa = this.qaStandScope();
    return {
      ready: this.bodyReady && !!this.mesh && !!this.animation
        && (!qa || qa.validate(this.qaStandIdentity(), this.motionTransition?.getState().active === true)),
      enabled: !!this.moodView?.expressions && (this.moodView?.snapshot.intensity?.posture ?? 0) > 0,
      visible: !this.disposed && this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0,
      manualPose: this.bodyManualPose, manualGesture: this.bodyManualGesture, manualExpression: this.moodFaceBlocked,
      // Reviewed Stand contains a small authored head motion too. Its exact
      // content-qualified background is blended by the same-mixer projection;
      // it must not be mistaken for an independently selected manual head layer.
      manualHead: this.moodHeadBlocked && (this.bodyManualPose || this.bodyManualGesture), dynamicPose: this.bodyDynamicPose,
      cameraOrWindow: this.behaviorBlocked || this.bodyCameraEditing || this.controls.interacting,
      inputBlocked: this.behaviorBlocked || this.bodyInputBlocked || this.typing,
      directContact: this.moodContact.contact || this.moodContact.feeding || this.moodContact.pinch?.pinching === true || this.hasCheekPresentationResidual() || (this.moodContact.hover ?? 0) > 0
        || !!this.moodView && this.moodView.snapshot.phase !== 'idle',
      music: this.musicEnabled || this.musicDance?.getState().releasing === true, speaking: this.speaking, waitingForReply: this.bodyWaitingForReply,
      // 她的动作 is the same tier as a chat gesture for the body owners (automatic body motions, previews, procedural sway);
      // her own life counts it as a body owner instead (frameHerLife), so a face-only yawn or glance may still run with it.
      chatGesture: !!this.chatGesturePlayer?.getState().active || !!this.moodView?.gesture || this.herAction?.active === true,
    };
  }
  private qaStandScope(): QaStableStandGate | null {
    const plan = this.moodView?.body;
    if (this.options?.transparent !== true || plan?.mode !== 'maintainer-qa') return null;
    // This optional QA owner is created only at its real scope entry. Ordinary
    // cancellation must neither require it nor allocate one. Never rearm it.
    const gate = this.qaStandGate ?? (this.qaStandGate = new QaStableStandGate());
    gate.scope(this.moodView!.token, !!plan.cue);
    return gate;
  }
  private qaStandIdentity(): QaStandIdentity | null {
    const commit = this.qaStandCommit;
    if (!commit || !this.bodyTargetSupported || !this.bodyReady || this.mesh !== commit.mesh
      || this.animation !== commit.animation || this.modelGeneration !== commit.model || this.motionGeneration !== commit.motion) return null;
    const times = commit.animation.getLayerTimes();
    const actions = commit.animation.getBehaviorBodyBindings().baseActions();
    const timeScale = commit.action.getEffectiveTimeScale();
    if (times.pose === null || times.gesture !== null || times.expression !== null
      || actions.length !== 1 || actions[0] !== commit.action || commit.action.getClip() !== commit.clip
      || !commit.action.enabled || commit.action.paused || !Number.isFinite(timeScale) || timeScale <= 0) return null;
    return { model: commit.model, motion: commit.motion, clip: commit.clip, action: commit.action,
      clipId: commit.clip.uuid, time: commit.action.time, weight: commit.action.getEffectiveWeight() };
  }
  private captureQaStandAfterRender(): void {
    const qa = this.qaStandScope();
    if (!qa) return;
    const gates = this.bodyGates(), state = this.bodyMotion?.getState();
    const eligible = this.moodView?.body?.reason === 'qa-ready' && gates.enabled && gates.visible
      && !gates.manualPose && !gates.manualGesture && !gates.manualExpression && !gates.manualHead && !gates.dynamicPose
      && !gates.cameraOrWindow && !gates.inputBlocked && !gates.directContact && !gates.music
      && !gates.waitingForReply && !gates.chatGesture && !gates.speaking;
    const captured = qa.rendered(this.qaStandIdentity(), this.motionTransition?.getState().active === true,
      !!state?.pending || !!state?.active || !!state?.cueId, eligible,
      this.mesh?.skeleton.bones.filter(bone => bone.name === '左人指１' || bone.name === '右人指１')
        .map(bone => ({ name: bone.name, position: bone.position.toArray(), quaternion: bone.quaternion.toArray() })) ?? []);
    // The baseline is from this completed normal render, before the sole natural
    // controller prepare. No new timer, IPC, helper tick or source-clock reset.
    if (captured) this.updateBodyMotion();
    else if (qa.diagnostic().status === 'failed') this.bodyMotion?.cancel();
  }
  private updateBodyMotion(): void {
    // The two new IPCs belong solely to the trusted pet main frame. Controls
    // keep their original preview/face/M004 behaviour and never call them.
    if (this.options?.transparent !== true || !this.bodyReady || !this.mesh || !this.animation) return;
    if (!this.bodyMotion) {
      const animation = this.animation, target = bodyMotionTarget(this.bodyTargetSupported, this.motionRetarget); // I-038: any model the retarget maps
      this.bodyMotion = new BodyMotionController(this.mesh, {
        targetSupported: target.supported,
        consumedIds: this.bodyConsumedIds,
        player: new BehaviorBodyPlayer({ ...animation.getBehaviorBodyBindings({ allowBaseProjection: true }), standardName: target.standardName }),
        getPlan: (token, observation) => {
          const qa = this.qaStandScope();
          if (qa && !qa.prepare(this.qaStandIdentity(), this.motionTransition?.getState().active === true))
            return Promise.reject(new Error('QA Stand baseline admission failed.'));
          return window.desktop.getBehaviorBodyPlan(token, observation);
        },
        resolve: (cueId, token) => window.desktop.resolveBehaviorBody(cueId, token),
        load: (resource, mesh) => this.loadBodyMotionClip(resource, mesh),
        mutate: <T>(mutation: () => T): T => {
          this.localPhysics?.restore();
          this.motionTransition?.restore();
          this.restorePersonalizeBody();
          this.behaviorMotion?.restore();
          this.herAction?.restore(); this.chatGesturePlayer?.restore();
          this.restoreLayers();
          try { return mutation(); }
          finally {
            // Binding removal between capped ticks must rebuild the helper's
            // present base and outer display target without advancing a clock.
            if (this.animation === animation) animation.helper.update(0);
            this.motionTransition?.frame(0); this.localPhysics?.frame(0);
          }
        },
        // R29c: a revoked motion hands the shown pose back to the running base instead of snapping.
        release: (tracks, stop) => { this.motionTransition = handOffToBase(this.mesh, this.hasRenderedModel, this.motionTransition, this.localPhysics, tracks, stop, this.poseRates()); },
      });
    }
    this.bodyMotion.update(this.moodView?.body, this.moodView?.token ?? '', this.bodyGates());
    this.renderBodyDiagnostics();
  }
  /** `immediate` only where nothing is shown or the scope ends (hide, not rendering, scope/context change). */
  private cancelBodyMotion(immediate = false): void {
    const ownedQa = this.qaStandGate;
    if (ownedQa) ownedQa.cancel();
    this.bodyMotion?.cancel(immediate);
    this.renderBodyDiagnostics();
  }
  private renderBodyDiagnostics(): void {
    if (!this.renderer?.domElement) return;
    const state = this.bodyMotion?.getState() ?? { active: false, pending: false, mode: 'closed' };
    const qa = this.bodyTargetSupported && state.mode === 'maintainer-qa';
    const qaGate = this.qaStandScope();
    const sampleNames = new Set(['首', '頭', '上半身', '左腕', '右腕', '左人指１', '右人指１']);
    this.renderer.domElement.dataset.bodyMotion = JSON.stringify({ ...state,
      ...(qaGate ? { stableStand: qaGate.diagnostic() } : {}),
      ...(qa ? { baseTimes: this.animation?.getLayerTimes(), samples: this.mesh?.skeleton.bones
        .filter(bone => sampleNames.has(bone.name)).map(bone => ({ name: bone.name,
          quaternion: bone.quaternion.toArray(), position: bone.position.toArray() })) ?? [] } : {}),
    });
  }
  private updateBehaviorMotion(inFrame = false): void {
    if (!this.behaviorMotion) return;
    // Event callbacks may stop an inner layer between ticks. Restore the outer
    // display bridge first, then rebuild its target at the same progress.
    if (!inFrame) { this.localPhysics?.restore(); this.motionTransition?.restore(); this.restorePersonalizeBody(); }
    let preview=this.visualPreview;
    if(preview&&(preview.model!==this.modelGeneration||preview.value.modelUrl!==this.modelUrl)){
      this.cancelVisualPreview();preview=null;
    }
    if(preview&&(isExpressionPreview(preview.value)?preview.value.expiresAt:preview.value.cue.expiresAt)<=Date.now()){
      // Natural one-shot end retains only host ready proof; it cannot resolve/replay an expired cue.
      this.visualPreview=null;clearTimeout(preview.timer);if(!preview.ready)preview.resolve(false);preview=null;
    }
    const legacy=preview&&!isExpressionPreview(preview.value)?preview.value:null;
    const previewCue=legacy?{...legacy.cue,strength:Math.min(legacy.selection.strength,this.moodView?behaviorExpressionStrength(this.moodView.snapshot,legacy.cue.kind==='reaction'):0)}:null;
    if(preview)this.behaviorMotion.consumeSuppressed(this.moodView?.behavior??null);
    const plan=previewCue?{state:previewCue.kind==='state'?previewCue:null,reaction:previewCue.kind==='reaction'?previewCue:null}:this.moodView?.behavior??null;
    const gates = {
      enabled: !!this.moodView?.expressions && (this.moodView?.snapshot.intensity.expression ?? 0) > 0,
      visible: !this.disposed && this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0,
      faceBlocked: this.moodFaceBlocked,
      directContact: this.moodContact.contact || this.moodContact.feeding || (this.moodContact.hover ?? 0) > 0,
      windowAdjusting: this.behaviorBlocked,
      cameraAdjusting: this.controls.interacting,
      protectedMorphIndices: [this.blinkIndex, this.mouthIndex, this.shownBlushChannel()?.index ?? -1],
      // The existing sampler attenuates its eyes using this ONE final closure budget.
      naturalBlink: this.finalEyeClosure ?? this.naturalBlink,
    };
    if(preview&&isExpressionPreview(preview.value)){
      if(preview.resource){
        if(!this.behaviorMotion.setComposition(preview.resource,preview.value.token,gates,this.moodView?behaviorExpressionStrength(this.moodView.snapshot):0)){
          this.cancelVisualPreview(preview.value.id,preview.value.token);
        }
      }else this.behaviorMotion.stop();
    }else this.behaviorMotion.update(plan,preview?.value.token??this.moodView?.token??'',gates);
    if (!inFrame) { this.motionTransition?.frame(0); this.localPhysics?.frame(0); }
  }
  /** Dedicated controls scope; uses the SAME audited sampler and its original compositing gates. */
  async previewVisual(view:AuthoringPreview):Promise<boolean>{
    this.cancelSurprisePreview();this.cancelVisualPreview();await this.pendingModel;
    if(this.disposed||this.options?.transparent===true||!this.hostVisible||document.hidden||!this.mesh||!this.behaviorMotion?.supported
      ||(!isExpressionPreview(view)&&view.scope!=='personalize-visual-controls')||view.mask!==VISUAL_MASK||view.targetModelSha!==VISUAL_GENE_SHA
      ||view.modelUrl!==this.modelUrl||view.modelUrl!==this.settings?.model?.url)return false;
    const model=this.modelGeneration;
    let resolve!:(ready:boolean)=>void;const ready=new Promise<boolean>(done=>{resolve=done;});
    const active:NonNullable<MmdStage['visualPreview']>={value:structuredClone(view),model,ready:false,reporting:false,resolve,timer:setTimeout(()=>this.cancelVisualPreview(view.id,view.token),6_000)};
    this.visualPreview=active;this.continuity?.reset('preview');
    try{
      await window.desktop.visualPreviewReceipt({phase:'bind',id:view.id,token:view.token,stageGeneration:model});
      if(this.visualPreview!==active||this.modelGeneration!==model||this.disposed)return false;
      if(isExpressionPreview(view)){
        const resource=await window.desktop.resolveExpressionPreview(view.id,view.token,model);
        if(this.visualPreview!==active||this.modelGeneration!==model||this.disposed)return false;
        active.resource=validateExpressionResource(resource,view,model);
      }
      this.updateBehaviorMotion();return await ready;
    }catch{this.cancelVisualPreview(view.id,view.token);return false;}
  }
  cancelVisualPreview(id?:string,token?:string,notify=true):void{
    const active=this.visualPreview;if(!active||(id!==undefined&&active.value.id!==id)||(token!==undefined&&active.value.token!==token))return;
    this.localPhysics?.restore();this.motionTransition?.restore();this.restorePersonalizeBody();this.visualPreview=null;
    this.behaviorMotion?.stop();clearTimeout(active.timer);active.resolve(false);
    if(notify)void window.desktop.visualPreviewReceipt({phase:'stop',id:active.value.id,token:active.value.token,stageGeneration:active.model}).catch(()=>{});
    this.motionTransition?.frame(0);this.localPhysics?.frame(0);
  }
  private acknowledgeVisualFrame():void{
    const active=this.visualPreview;if(!active||active.ready||active.reporting||active.model!==this.modelGeneration)return;
    const state=this.behaviorMotion?.getState(),layer=isExpressionPreview(active.value)?null:active.value.cue.kind==='state'?state?.state:state?.reaction;
    if(isExpressionPreview(active.value)){
      const applied=this.behaviorMotion?.getCompositionState();if(applied?.id!==active.value.id||applied.recipeId!==active.value.recipeId||!applied.propertyIndices.length)return;
    }else{
    if(!layer?.active||layer.id!==active.value.id||!layer.propertyIndices.length)return;
    }
    active.reporting=true;
    void window.desktop.visualPreviewReceipt({phase:'ready',id:active.value.id,token:active.value.token,stageGeneration:active.model}).then(()=>{
      if(this.visualPreview!==active||this.disposed||active.model!==this.modelGeneration)return;
      active.ready=true;clearTimeout(active.timer);active.resolve(true);
    }).catch(()=>this.cancelVisualPreview(active.value.id,active.value.token));
  }
  /** The existing controls preview generation owns this one host-resolved manual clip. */
  async previewSurprise(recipe:ManualEmotionRecipe='surprise'):Promise<boolean>{
    if(recipe!=='surprise'&&recipe!=='shy')return false;
    if(this.mesh&&!this.bodyTargetSupported)return this.playExpression(recipe)?.usable===true; // I-038: other models get the universal show (shy-show.ts)
    this.cancelBodyPreview();this.cancelVisualPreview();
    const ticket=++this.bodyPreviewGeneration;this.surprisePending={ticket,id:null};
    let view:SurprisePreviewGrant|null=null;
    try{
      view=recipe==='surprise'?await window.desktop.beginSurprisePreview():await window.desktop.beginSurprisePreview('shy');
      if(ticket!==this.bodyPreviewGeneration){void window.desktop.stopSurprisePreview(view.id).catch(()=>{});return false;}
      this.surprisePending={ticket,id:view.id};await this.pendingModel;
      if(ticket!==this.bodyPreviewGeneration){void window.desktop.stopSurprisePreview(view.id).catch(()=>{});return false;}
      if(this.disposed||this.options.transparent===true||!this.hostVisible||document.hidden||!this.mesh||!this.bodyTargetSupported
        ||view.clipId!==(recipe==='shy'?SHY_CLIP_ID:SURPRISE_CLIP_ID)||view.revision!==(recipe==='shy'?SHY_REVISION:SURPRISE_REVISION)||view.targetModelSha!==SURPRISE_MODEL_SHA
        ||view.modelUrl!==this.modelUrl||view.modelUrl!==this.settings?.model?.url||view.expiresAt<=Date.now())throw Error('目标模型或预览已改变。');
      const model=this.modelGeneration,mesh=this.mesh,grant=await window.desktop.resolveSurprisePreview(view.id,model);
      if(ticket!==this.bodyPreviewGeneration||this.modelGeneration!==model||this.mesh!==mesh||this.disposed
        ||grant.id!==view.id||grant.clipId!==view.clipId||grant.revision!==view.revision||grant.targetModelSha!==view.targetModelSha
        ||grant.modelUrl!==view.modelUrl||grant.expiresAt!==view.expiresAt){void window.desktop.stopSurprisePreview(view.id).catch(()=>{});return false;}
      this.surprisePending=null;this.surprisePreview={view,model,overlay:new SurpriseOverlay(mesh,true,this.behaviorMotion?.supported===true,view.clipId),start:null,status:'playing'};this.continuity?.reset('preview');
      this.options.onSurprisePreviewState?.('playing');return true;
    }catch{
      if(view)void window.desktop.stopSurprisePreview(view.id).catch(()=>{});
      if(ticket===this.bodyPreviewGeneration){this.surprisePending=null;this.options.onSurprisePreviewState?.('unsupported');}
      return false;
    }
  }
  cancelSurprisePreview(id?:string,inFrame=false):void{
    const active=this.surprisePreview,pending=this.surprisePending;
    if(!active&&!pending)return;
    if(id!==undefined&&active?.view.id!==id&&pending?.id!==id)return;
    this.bodyPreviewGeneration++;
    if(active&&!inFrame){this.localPhysics?.restore();this.motionTransition?.restore();active.overlay.restore();}
    this.surprisePreview=null;this.surprisePending=null;
    void window.desktop.stopSurprisePreview(active?.view.id??pending?.id??undefined).catch(()=>{});
    this.options.onSurprisePreviewState?.('idle');
    if(active&&!inFrame){this.motionTransition?.frame(0);this.localPhysics?.frame(0);}
  }
  /** Another owner animates this bone this frame (a transition, body motion, chat gesture, a body preview or a picked pose/gesture layer). */
  private previewBoneOwned(property:string,bone:Bone|undefined):boolean{
    const animation=this.animation;
    return !!(this.motionTransition?.ownsProperty(property)||this.bodyMotion?.ownsProperty(property)
      ||this.chatGesturePlayer?.getState().trackNames.includes(property)
      ||this.herAction?.getState().trackNames.includes(property)
      ||this.bodyPreview?.overlay.hasBone(bone)||this.bodyPersonalize?.overlay.hasBone(bone)
      ||(this.bodyManualPose&&animation?.hasLayerProperty('pose',property))
      ||(this.bodyManualGesture&&animation?.hasLayerProperty('gesture',property)));
  }
  /** E1: what this model can show of a recipe (the buttons grey out only when nothing can). */
  expressionSupport(recipe:ExpressionRecipe):ExpressionSupport{
    if(!this.mesh||this.disposed)return showSupport(recipe,null);
    if(this.lifeEnabled===false)return {...showSupport(recipe,null),reason:'开发者面板里的“程序化小动作与表情”关着，打开后才能预览。'};
    const rig=this.lifeRig,slot=(value:number|undefined)=>typeof value==='number'&&value>=0;
    const capabilities:ShowCapabilities={head:!!this.head,upperBody:!!rig?.upperBody,eyes:this.eyes.length>0,lids:this.blinkIndex>=0,
      browUp:slot(rig?.slots.browUp),browSad:slot(rig?.slots.sad),eyeWide:slot(rig?.slots.surprise),smileEyes:slot(rig?.slots.smileEyes),
      mouthSmile:slot(rig?.slots.mouthSmile),mouthOpen:slot(rig?.slots.mouthOpen),blush:!!this.proceduralBlush||!!this.shownBlushChannel()};
    return showSupport(recipe,capabilities);
  }
  /**
   * E1: plays 惊喜 / 害羞 on this stage now, on whatever model is loaded (missing parts are skipped). It replaces the old
   * Gene-only preview and a show already running. Null for anything but the two recipes.
   */
  playExpression(recipe:unknown,strength?:number):ExpressionSupport|null{
    if(!isExpressionRecipe(recipe)||this.disposed)return null;
    const support=this.expressionSupport(recipe);
    if(!support.usable||!this.mesh)return support;
    if(this.surprisePreview||this.surprisePending)this.cancelSurprisePreview();
    const show=this.expressionShow,s=clampStrength(strength),wall=show?.start==null?0:this.previousFrame-show.start; // I-038 / I-037 (show-blend.ts): a repeat while it holds keeps it going; X-343 (show-clock.ts): and holds it a full show from now
    if(show?.mesh===this.mesh&&showRequest({recipe:show.recipe,elapsedMs:show.clock.at(wall)},recipe)==='keep'){show.strength=Math.max(show.strength,s);show.clock.extend(wall);return support;}
    this.expressionShow={recipe,mesh:this.mesh,start:null,requestedAt:performance.now(),strength:s,clock:new ShowClock(recipe)};
    return support;
  }
  /** I-037 新的反应方式: one reaction cue from the host (src/stage/reaction-performers.ts decides; never restarts a running show). */
  playReaction(cue:unknown):ReactionStageResult{
    if(this.disposed)return 'unsupported';
    return playReactionCue(cue,{showingOther:()=>!!(this.surprisePreview||this.surprisePending||this.visualPreview||this.bodyPreview||this.bodyPersonalize),
      playExpression:(recipe,strength)=>this.playExpression(recipe,strength)});
  }
  /** E1: the show's clock and its bones (head turn/tilt, upper body, eyes) under the same owners as the old preview. */
  private frameExpressionShow(time:number):void{
    const show=this.expressionShow;
    if(show&&(show.mesh!==this.mesh||show.start===null&&performance.now()-show.requestedAt>3_000||show.start!==null&&show.clock.at(time-show.start)>=SHOW_MS[show.recipe]))this.expressionShow=null;
    // The old Gene preview applies its own additions (frameSurprisePreview); otherwise a show (or its fade) applies here.
    if(this.surprisePreview||!this.life)return;
    const head=this.head,body=this.lifeRig?.upperBody;
    this.life.applyPreview(this.lifePort,head,this.eyes,!!head&&!this.previewBoneOwned(`.bones[${head.name}].quaternion`,head),!this.moodFaceBlocked,
      body,!!body&&!this.previewBoneOwned(`.bones[${body.name}].quaternion`,body));
  }
  private frameSurprisePreview(time:number):void{
    const active=this.surprisePreview;if(!active)return;
    if(active.model!==this.modelGeneration||active.view.modelUrl!==this.modelUrl||active.view.expiresAt<=Date.now()
      ||!this.hostVisible||document.hidden||this.disposed){this.cancelSurprisePreview(active.view.id,true);return;}
    active.start??=time;const elapsed=time-active.start;
    if(elapsed<0||elapsed>=SURPRISE_DURATION_MS){this.cancelSurprisePreview(active.view.id,true);return;}
    const sample=surpriseSample(elapsed,active.view.clipId);if(!sample)return;
    const gate=this.bodyGates(),blocked=!gate.visible||gate.cameraOrWindow||gate.inputBlocked||gate.directContact;
    const owned=(property:string,bone:Bone|undefined)=>this.previewBoneOwned(property,bone);
    const faceHeld=(index:number)=>{
      const property=`.morphTargetInfluences[${index}]`;
      return this.moodFaceBlocked||index===this.blinkIndex||index===this.mouthIndex||index===this.shownBlushChannel()?.index
        ||!!(this.motionTransition?.ownsProperty(property)||this.animation?.hasLayerProperty('expression',property));
    };
    const head=this.mesh?.skeleton.bones[9],torso=this.mesh?.skeleton.bones[5];
    const result=active.overlay.apply(elapsed,{brow:!blocked&&!faceHeld(84),eye:!blocked&&!faceHeld(94),
      head:!blocked&&!owned('.bones[頭].quaternion',head),torso:!blocked&&!owned('.bones[上半身].quaternion',torso),
      naturalBlink:this.finalEyeClosure??this.naturalBlink});
    // Model-agnostic additions (preview-performance.ts): head pitch/turn and lowered eyes under the same gates; face parts went through the compositors.
    this.life?.applyPreview(this.lifePort,this.head,this.eyes,!blocked&&!!this.head&&!owned(`.bones[${this.head.name}].quaternion`,this.head),!blocked);
    const wanted=[sample.brow_raise,sample.eye_wide,sample.head_z_degrees,sample.torso_z_degrees].filter(x=>x!==0).length;
    const state=wanted>result.morphs.length+result.bones.length?'partial':'playing';
    if(state!==active.status){active.status=state;this.options.onSurprisePreviewState?.(state);}
  }
  /** Resolve the host-owned binding, then require a rendered frame of this exact overlay. */
  async previewBody(view:BodyPosePreview):Promise<boolean>{
    this.cancelBodyPreview();const ticket=++this.bodyPreviewGeneration;
    this.bodyPreviewPending={id:view.id,token:view.token,ticket};await this.pendingModel;
    if(ticket!==this.bodyPreviewGeneration)return false;
    if(this.disposed||this.options?.transparent===true||!this.hostVisible||document.hidden||!this.mesh||!bodyMotionTarget(this.bodyTargetSupported,this.motionRetarget).supported
      ||view.targetModelSha!==VISUAL_GENE_SHA||view.modelUrl!==this.modelUrl||view.modelUrl!==this.settings?.model?.url
      ||view.expiresAt<=Date.now()){this.bodyPreviewPending=null;return false;}
    const model=this.modelGeneration, mesh=this.mesh;
    try{
      await window.desktop.bodyPreviewReceipt({phase:'bind',id:view.id,token:view.token,stageGeneration:model});
      const binding=await window.desktop.resolveBodyPreview(view.id,view.token,model);
      if(this.disposed||ticket!==this.bodyPreviewGeneration||this.modelGeneration!==model||this.mesh!==mesh||binding.id!==view.bindingId
        ||binding.sourceSha!==view.sourceSha||binding.mask!==view.mask||binding.targetModelSha!==view.targetModelSha||binding.qualifiedStrength!==view.strength){
        if(this.bodyPreviewPending?.ticket===ticket)this.bodyPreviewPending=null;return false;
      }
      const overlay=personalizePose(mesh,binding.properties,this.restPose,this.bodyTargetSupported,this.motionRetarget); // I-038: mapped onto other models
      let resolve!:(ready:boolean)=>void;const result=new Promise<boolean>(done=>{resolve=done;});
      const active={value:structuredClone(view),model,overlay,ready:false,reporting:false,applied:false,resolve,
        timer:setTimeout(()=>this.cancelBodyPreview(view.id,view.token),6_000)};
      this.bodyPreviewPending=null;this.bodyPreview=active;this.continuity?.reset('preview');return await result;
    }catch{this.cancelBodyPreview(view.id,view.token);return false;}
  }
  cancelBodyPreview(id?:string,token?:string,notify=true,inFrame=false):void{
    if(id===undefined)this.cancelSurprisePreview(undefined,inFrame);
    const active=this.bodyPreview;
    if(!active){const pending=this.bodyPreviewPending;
      if(id===undefined||(pending&&pending.id===id&&(token===undefined||pending.token===token))){this.bodyPreviewGeneration++;this.bodyPreviewPending=null;}
      return;
    }
    if((id!==undefined&&active.value.id!==id)||(token!==undefined&&active.value.token!==token))return;
    this.bodyPreviewGeneration++;
    if(!inFrame){this.localPhysics?.restore();this.motionTransition?.restore();active.overlay.restore();}
    this.bodyPreview=null;
    clearTimeout(active.timer);active.resolve(false);
    if(notify)void window.desktop.bodyPreviewReceipt({phase:'stop',id:active.value.id,token:active.value.token,stageGeneration:active.model}).catch(()=>{});
    if(!inFrame){this.motionTransition?.frame(0);this.localPhysics?.frame(0);}
  }
  private frameBodyPreview():boolean{
    const active=this.bodyPreview;if(!active)return false;
    if(active.model!==this.modelGeneration){this.cancelBodyPreview(undefined,undefined,true,true);return false;}
    if(active.value.expiresAt<=Date.now()){
      this.bodyPreview=null;clearTimeout(active.timer);if(!active.ready)active.resolve(false);return false;
    }
    const gate=this.bodyGates();
    if(!gate.visible||gate.manualPose||gate.manualGesture||gate.dynamicPose||gate.cameraOrWindow||gate.inputBlocked
      ||gate.directContact||gate.music||gate.chatGesture){this.cancelBodyPreview(undefined,undefined,true,true);return false;}
    const headApplied=!!this.headFrameClaim&&active.overlay===this.headFrameClaim&&this.currentHeadClaim()===this.headFrameClaim;
    const count=active.overlay.apply(active.value.strength,headApplied?null:this.head,this.torsoContributionAllowed());active.applied=active.applied||count>0;
    return headApplied;
  }
  private acknowledgeBodyFrame():void{
    const active=this.bodyPreview;if(!active||!active.applied||active.ready||active.reporting||active.model!==this.modelGeneration)return;
    active.reporting=true;void window.desktop.bodyPreviewReceipt({phase:'ready',id:active.value.id,token:active.value.token,stageGeneration:active.model}).then(()=>{
      if(this.bodyPreview!==active||this.disposed||active.model!==this.modelGeneration)return;
      active.ready=true;clearTimeout(active.timer);active.resolve(true);
    }).catch(()=>this.cancelBodyPreview(active.value.id,active.value.token));
  }
  private restorePersonalizeBody():void{
    this.surprisePreview?.overlay.restore();
    this.bodyPreview?.overlay.restore();this.bodyPersonalize?.overlay.restore();
  }
  private restoreTorsoForMotionCapture():void {
    if(this.surprisePreview){this.motionTransition?.restore();this.surprisePreview.overlay.restore();}
    // The new current-base delta must not be captured into a transition bridge;
    // retain the established display capture semantics of static arms/head.
    this.bodyPersonalize?.overlay.restoreCurrentTorso();this.bodyPreview?.overlay.restoreCurrentTorso();
  }
  private cancelPersonalizeBody(inFrame=false):void{
    const active=this.bodyPersonalize;if(!active)return;
    if(!inFrame){this.localPhysics?.restore();this.motionTransition?.restore();active.overlay.restore();}
    this.bodyPersonalize=null;
    if(!inFrame){this.motionTransition?.frame(0);this.localPhysics?.frame(0);}
  }
  private updatePersonalizeBody(view:MoodView):void{
    const cue=view.bodyPose,active=this.bodyPersonalize;
    if(active&&(!cue||active.cue.cueId!==cue.cueId||active.token!==view.token||active.model!==this.modelGeneration))this.cancelPersonalizeBody();
    if(!cue||this.bodyPersonalize?.cue.cueId===cue.cueId||this.bodyPersonalizeConsumed.has(cue.cueId))return;
    this.bodyPersonalizeConsumed.add(cue.cueId);
    if(this.bodyPersonalizeConsumed.size>128)this.bodyPersonalizeConsumed.delete(this.bodyPersonalizeConsumed.values().next().value!);
    if(this.options?.transparent!==true||!this.mesh||!bodyMotionTarget(this.bodyTargetSupported,this.motionRetarget).supported||!this.animation||!view.expressions
      ||cue.modelUrl!==this.modelUrl||cue.binding.targetModelSha!==VISUAL_GENE_SHA||cue.binding.qualifiedStrength!==cue.strength||cue.expiresAt<=Date.now())return;
    const gate=this.bodyGates(),body=this.bodyMotion?.getState();
    if(!gate.visible||gate.manualPose||gate.manualGesture||gate.dynamicPose||gate.cameraOrWindow||gate.inputBlocked
      ||gate.directContact||gate.music||gate.chatGesture||body?.active||body?.pending)return;
    try{this.bodyPersonalize={cue:structuredClone(cue),token:view.token,model:this.modelGeneration,
      overlay:personalizePose(this.mesh,cue.binding.properties,this.restPose,this.bodyTargetSupported,this.motionRetarget)};}catch{/* unsupported binding stays closed */}
  }
  private framePersonalizeBody():boolean{
    const active=this.bodyPersonalize;if(!active)return false;
    const gate=this.bodyGates(),body=this.bodyMotion?.getState();
    if(active.model!==this.modelGeneration||active.cue.expiresAt<=Date.now()||!gate.visible||!gate.enabled
      ||gate.manualPose||gate.manualGesture||gate.dynamicPose||gate.cameraOrWindow||gate.inputBlocked||gate.directContact
      ||gate.music||gate.chatGesture||body?.active||body?.pending){this.cancelPersonalizeBody(true);return false;}
    const headApplied=!!this.headFrameClaim&&active.overlay===this.headFrameClaim&&this.currentHeadClaim()===this.headFrameClaim;
    active.overlay.apply(active.cue.strength,headApplied?null:this.head,this.torsoContributionAllowed());
    return headApplied;
  }
  /** Only the exact torso quaternion bridge or a real contact fallback excludes this delta. */
  private torsoContributionAllowed():boolean {
    if(this.motionTransition?.ownsProperty?.('.bones[上半身].quaternion'))return false;
    const fallback=!this.center&&this.chest&&this.chest===this.mesh?.skeleton.bones[5];
    return !(fallback&&(this.moodContact?.pinch?.pinching||this.hasCheekPresentationResidual()));
  }
  /** The exact live overlay and gates used again before application; never a draft or prior-frame flag. */
  private currentHeadClaim():PersonalizeStaticPose|null {
    if(!this.head||!this.hostVisible||document.hidden||this.disposed||this.motionTransition?.ownsProperty(`.bones[${this.head.name}].quaternion`))return null;
    const gate=this.bodyGates();
    if(!gate.visible||gate.manualPose||gate.manualGesture||gate.dynamicPose||gate.cameraOrWindow||gate.inputBlocked||gate.directContact||gate.music||gate.chatGesture)return null;
    const preview=this.bodyPreview;
    if(preview&&preview.model===this.modelGeneration&&preview.value.expiresAt>Date.now()&&preview.overlay.hasBone(this.head))return preview.overlay;
    const active=this.bodyPersonalize,body=this.bodyMotion?.getState();
    if(active&&active.model===this.modelGeneration&&active.token===this.moodView?.token&&active.cue.expiresAt>Date.now()&&gate.enabled
      &&!body?.active&&!body?.pending&&active.overlay.hasBone(this.head))return active.overlay;
    return null;
  }
  private rotateAutomaticHead(x:number,y:number,z:number):void {
    if(this.headFrameClaim)this.deferredAutoHead.push([x,y,z]);else this.rotateBone(this.head,x,y,z);
  }
  private settleHeadFrameClaim(applied:boolean):void {
    if(this.headFrameClaim&&!applied){
      this.headFrameClaim=null;
      for(const [x,y,z] of this.deferredAutoHead)this.rotateBone(this.head,x,y,z);
    }
    this.deferredAutoHead=[];
  }
  private cancelChatGesture(smooth = false): void {
    this.localPhysics?.restore();
    if(this.surprisePreview){this.motionTransition?.restore();this.surprisePreview.overlay.restore();}
    const state = this.chatGesturePlayer?.getState();
    // Outer bridge first, then the gesture's own overlay (restore order).
    const stop = () => {
      if (state?.active) this.motionTransition?.restore();
      this.chatGestureGeneration++;
      this.chatGesturePlayer?.cancel({ immediate: true });
    };
    // R29d: a smooth cancel is the same hand-off as a revoked body motion (motion-transition.ts handOffToBase):
    // from what is shown back to the base, over the gesture's tracks and the bones the helper derives from them,
    // for a time sized by the correction (it was a fixed 300 ms over the tracks alone).
    if (smooth && state?.active) this.motionTransition = handOffToBase(this.mesh, this.hasRenderedModel, this.motionTransition, this.localPhysics, state.trackNames, stop, this.poseRates());
    else { stop(); this.localPhysics?.frame(0); }
  }
  private async playChatGesture(cue: ChatGestureCue, token: string): Promise<void> {
    if (this.chatGestureIds.has(cue.id)) return;
    this.chatGestureIds.add(cue.id);
    this.cancelBodyMotion();
    if (this.chatGestureIds.size > 256) this.chatGestureIds.delete(this.chatGestureIds.values().next().value!);
    const mesh = this.mesh, player = this.chatGesturePlayer, generation = ++this.chatGestureGeneration;
    const allowed = () => !this.disposed && this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0 && !this.behaviorBlocked && !this.typing && !this.controls.interacting && this.mesh === mesh
      && this.chatGestureGeneration === generation && this.moodView?.token === token && this.moodView.gesture?.id === cue.id
      && this.moodView.expressions && this.moodView.snapshot.intensity.posture > 0 && !this.chatGestureBlocked
      && !this.moodContact.contact && !this.moodContact.feeding && !(this.moodContact.hover! > 0) && Date.now() < cue.expiresAt
      && !this.herAction?.active; // 她的动作 showing: this gesture is dropped, not queued
    if (!mesh || !player || !allowed() || Date.now() - cue.at > 1_500) return;
    try {
      const resource = await window.desktop.resolveChatGesture(cue.id, token);
      if (!allowed()) return;
      let pending = this.chatGestureClips.get(resource.sha256);
      if (!pending) {
        const loader = withKeyframeInterpolation(new MMDLoader()); loader.parser = createVmdParser(undefined, this.motionRetarget?.transform);
        pending = new Promise<AnimationClip>((resolve, reject) => loader.loadAnimation(resource.url, mesh, value => {
          // Pretrial 2026-11-03: the captured gestures' frame-to-frame jitter is low-passed once, in memory (capture-smoothing.ts).
          const clip = value as AnimationClip; clip.duration = resource.durationMs / 1000; smoothCapturedClip(clip, isChatGestureTrack); resolve(clip);
        }, undefined, reject));
        this.chatGestureClips.set(resource.sha256, pending);
        void pending.catch(() => { if (this.chatGestureClips.get(resource.sha256) === pending) this.chatGestureClips.delete(resource.sha256); });
      }
      const clip = await pending;
      if (!allowed() || Date.now() - cue.at > 1_500) return;
      if (this.motionUnfit(resource.sha256)) { this.chatGestureError = UNFIT_MOTION; return; }
      this.chatGestureResource = resource; this.chatGestureError = '';
      if (!player.play({ id: cue.id, clip, strength: cue.strength })) {
        this.cancelChatGesture(true);
        this.chatGestureError = '当前模型没有可播放的会话上身轨道，本轮保留原动作';
      }
    } catch {
      if (allowed()) this.chatGestureError = '会话手势未能载入，本轮保持原动作';
    }
  }
  /**
   * 她的动作 (T-211, her-action.ts): a host cue from a test command, played once on this model. A model without a required
   * part (shared/her-actions.ts) skips it; so does a motion the fit check hides on this model, or a moment when a higher owner
   * holds her (a touch, the game, music, a picked motion, a preview, a window move). The pet window tells the host what happened.
   */
  async playHerAction(value: unknown): Promise<void> {
    if (!isHerActionCue(value) || this.disposed || Date.now() > value.expiresAt) return;
    const cue = value, ids = (this.herActionIds ??= new Set());
    if (ids.has(cue.id)) return;
    ids.add(cue.id);
    if (ids.size > 64) ids.delete(ids.values().next().value!);
    const spec = HER_ACTION_SPECS[cue.action];
    let sha256: string | null = null;
    const report = (status: HerActionStatus, missing: string[] = [], detail = '') => {
      this.herActionInfo = { cueId: cue.id, action: cue.action, status, missing, detail, sha256 };
      if (this.options.transparent) void window.desktop.reportHerAction?.({ cueId: cue.id, status, missing, detail })?.catch?.(() => {});
    };
    // T-215: a face shape goes to the face exclusive (its own lease on the mouth or the eyelids), never the body player.
    if (spec.mode === 'face') { await this.playFaceAction(cue, spec, report, value => { sha256 = value; }); return; }
    const mesh = this.mesh, player = this.herAction, generation = ++this.herActionGeneration, scopeKey = this.faceScopeKey();
    if (!mesh || !player) { report('failed', [], HER_ACTION_DETAILS.noModel); return; }
    // X-321 follow-up: like a face shape, a body action starts only in the character and conversation it arrived in.
    const stale = () => this.disposed || this.mesh !== mesh || this.herAction !== player || this.herActionGeneration !== generation
      || this.faceScopeKey() !== scopeKey || Date.now() > cue.expiresAt;
    // T-213: the same rule as the character page (shared/her-actions.ts herActionSupport): a bone a clip track can bind, and
    // the profile's finger joints; then, once loaded, the tracks that really bound.
    const profile = this.modelProfile?.profile ?? null;
    const has = (slot: StandardBone) => { const state = profileBoneState(profile, slot); return state === true ? !!this.modelProfile?.bone(slot) : state; };
    const before = herActionMissing(spec, has, undefined, profileFingerCount(profile));
    if (before.length) { report('missing', before); return; }
    const busy = this.herActionBusy(spec.mode);
    if (busy) { report('busy', [], busy); return; }
    try {
      const resource = await window.desktop.resolveHerAction(cue.id);
      if (stale()) return;
      if (resource?.action !== cue.action || resource.sha256 !== spec.sha256 || typeof resource.url !== 'string') { report('failed', [], HER_ACTION_DETAILS.resource); return; }
      sha256 = resource.sha256;
      const clips = (this.herActionClips ??= new Map()), key = `${this.modelGeneration}:${resource.sha256}`;
      let pending = clips.get(key);
      if (!pending) {
        // The stage's own loader: keyframe interpolation (R29f) and, on a model that is not the reviewed Gene, the retarget.
        const loader = withKeyframeInterpolation(new MMDLoader()); loader.parser = createVmdParser(undefined, this.motionRetarget?.transform);
        pending = new Promise<AnimationClip>((resolve, reject) => loader.loadAnimation(resource.url, mesh, clip => {
          (clip as AnimationClip).duration = spec.durationFrames / 30; resolve(clip as AnimationClip);
        }, undefined, reject));
        clips.set(key, pending);
        void pending.catch(() => { if (clips.get(key) === pending) clips.delete(key); });
      }
      const clip = await pending;
      if (stale()) return;
      if (this.motionUnfit(resource.sha256)) {
        // T-213: say which part when the fit check held it back because this skeleton hangs a body part elsewhere.
        const structure = this.motionRetarget?.fitOf(resource.sha256)?.issues.some(issue => issue.startsWith('structure:')) === true;
        const parts = structure ? (this.motionRetarget?.plan?.structure ?? []).map(row => HER_ACTION_PART_NAMES[row.bone] ?? row.bone) : [];
        report('unfit', parts, parts.length ? HER_ACTION_DETAILS.structure : UNFIT_MOTION); return;
      }
      const names = new Set(player.bindable(clip, spec.durationFrames / 30));
      const bound = (slot: StandardBone) => { const bone = this.modelProfile?.bone(slot); return !!bone && names.has(`.bones[${bone.name}].quaternion`); };
      const fingers = { left: 0, right: 0 }, joints = profileFingerNames(profile);
      for (const name of names) { const side = joints.get(/^\.bones\[(.+)\]\.quaternion$/.exec(name)?.[1] ?? ''); if (side) fingers[side]++; }
      const after = herActionMissing(spec, has, bound, fingers);
      if (after.length) { report('missing', after); return; }
      const still = this.herActionBusy(spec.mode);
      if (still) { report('busy', [], still); return; }
      // One upper-body overlay at a time: a chat gesture in flight hands back first (R29d), then the action fades in over it.
      if (this.chatGesturePlayer?.getState().active) this.cancelChatGesture(true);
      if (!player.play({ id: cue.id, clip, mode: spec.mode, durationS: spec.durationFrames / 30, rate: spec.rate, strength: spec.strength })) { report('failed', [], HER_ACTION_DETAILS.noTracks); return; }
      // 哈欠捂嘴: the hand is Codex's; the yawn itself (mouth, lids, chin) is the existing P1 one, started on the same clock.
      if (spec.companion === 'yawn') this.herActionYawn = { id: `yawn-${cue.id.slice(0, 60)}`, at: Date.now() };
      report('played');
    } catch {
      if (!stale()) report('failed', [], HER_ACTION_DETAILS.load);
    }
  }
  /**
   * T-215 face actions (鼓腮、撅嘴、眨一只眼、吐舌头): Codex's morph-only clips through the face exclusive. The model must
   * have the required morphs (the profile's vertex-checked slots, else the names; a shape that moves no vertex counts as
   * missing) and the card must not have that part off; the mouth or the eyelids must be free of a higher owner (speech,
   * feeding, a touch, a picked expression, a held closure, a preview, a reaction). A wink asked for during a natural blink
   * starts as soon as the blink has opened again (if that is within FACE_EXCLUSIVE_START_WAIT_S).
   */
  private async playFaceAction(cue: HerActionCue, spec: HerActionSpec, report: (status: HerActionStatus, missing?: string[], detail?: string) => void,
    pinned: (sha256: string) => void): Promise<void> {
    const face = this.faceExclusive, mesh = this.mesh, generation = this.faceActionGeneration = (this.faceActionGeneration ?? 0) + 1, faceSpec = spec.face!;
    if (!mesh || !face) { report('failed', [], HER_ACTION_DETAILS.noModel); return; }
    // X-321: the cue belongs to the character and conversation it arrived in; after either await it starts only there.
    const key = this.faceScopeKey();
    const stale = () => this.disposed || this.mesh !== mesh || this.faceExclusive !== face || this.faceActionGeneration !== generation
      || this.faceScopeKey() !== key || Date.now() > cue.expiresAt;
    const scope = faceSpec.scope;
    if (this.capabilities()?.[scope === 'mouth' ? 'mouth' : 'closeEyes']?.choice === 'off') {
      report('failed', [], scope === 'mouth' ? HER_ACTION_DETAILS.mouthOff : HER_ACTION_DETAILS.eyesOff); return;
    }
    const profile = this.modelProfile?.profile ?? null;
    const resolved = resolveFaceMorphs(faceSpec, { names: mesh.morphTargetDictionary, count: mesh.morphTargetInfluences?.length ?? 0,
      slot: slot => profile ? profile.morphs[slot]?.index ?? -1 : null, displaces: index => face.displaced(index).length > 0 });
    if (resolved.missing.length) { report('missing', resolved.missing); return; }
    const busy = this.faceActionBusy(scope);
    if (busy) { report('busy', [], busy); return; }
    try {
      const resource = await window.desktop.resolveHerAction(cue.id);
      if (stale()) return;
      if (resource?.action !== cue.action || resource.sha256 !== spec.sha256 || typeof resource.url !== 'string') { report('failed', [], HER_ACTION_DETAILS.resource); return; }
      pinned(resource.sha256);
      const clips = (this.faceActionClips ??= new Map());
      let pending = clips.get(resource.sha256);
      if (!pending) {
        // Morph keys only (the stage's VMD parser; no clip is built and nothing binds to the mixer).
        const loader = new MMDLoader() as unknown as { parser: object; loadVMD(url: string, onLoad: (vmd: never) => void, onProgress?: unknown, onError?: (error: unknown) => void): void };
        loader.parser = createVmdParser();
        pending = new Promise((resolve, reject) => loader.loadVMD(resource.url, resolve, undefined, reject));
        clips.set(resource.sha256, pending);
        void pending.catch(() => { if (clips.get(resource.sha256) === pending) clips.delete(resource.sha256); });
      }
      const vmd = await pending;
      if (stale()) return;
      // Skeleton step 2: the writes include stand-ins (撅嘴 from "う", 眨一只眼 with the other eye) when the model lacks the shape.
      const tracks = faceWriteTracks(resolved.writes, faceTracksByName(vmd.morphs ?? []));
      if (!tracks.length) { report('failed', [], HER_ACTION_DETAILS.noTracks); return; }
      const still = this.faceActionBusy(scope);
      if (still) { report('busy', [], still); return; }
      const delay = scope === 'eyelids' ? this.blinkRemaining() : 0;
      if (delay > FACE_EXCLUSIVE_START_WAIT_S) { report('busy', [], HER_ACTION_DETAILS.blinking); return; }
      const scales = this.modelProfile?.scales;
      const granted = face.request({ id: cue.id, scope, key, duration: spec.durationFrames / 30, tracks, delay,
        calibrate: (index, value) => calibratedWeight(scales, index, value) });
      if (granted === true) report('played', [], resolved.approximations.length ? HER_ACTION_DETAILS.approximate : '');
      else report(granted === 'busy' ? 'busy' : 'failed', [], granted === 'busy' ? HER_ACTION_DETAILS.previousFace : HER_ACTION_DETAILS.noTracks);
    } catch {
      if (!stale()) report('failed', [], HER_ACTION_DETAILS.load);
    }
  }
  /** Who holds the mouth or the eyelids above a face shape, in the note's words (empty: free). Never queued. */
  private faceActionBusy(scope: FaceScope): string {
    const contact = this.moodContact;
    if (!this.hostVisible || document.hidden || !(this.container?.clientWidth > 0) || !(this.container?.clientHeight > 0)) return HER_ACTION_DETAILS.hidden;
    if (contact.contact || contact.feeding || contact.pinch?.pinching === true) return HER_ACTION_DETAILS.contact;
    if (this.moodFaceBlocked || this.moodMouthBlocked) return HER_ACTION_DETAILS.manualFace;
    if (this.rps?.active) return HER_ACTION_DETAILS.game;
    if (this.faceHigherPreview()) return HER_ACTION_DETAILS.preview;
    if (this.poseReaction?.reacting) return HER_ACTION_DETAILS.reaction;
    if (scope === 'mouth' && (this.speaking || this.speechPreparing())) return HER_ACTION_DETAILS.speaking;
    if (scope === 'eyelids' && (this.lidHeld > 0.02 || this.moodView?.fatigue?.sleeping === true || (this.sleepFrame?.blink ?? 0) > 0)) return HER_ACTION_DETAILS.eyesClosed;
    if (this.faceExclusive?.busy(scope)) return HER_ACTION_DETAILS.previousFace;
    return '';
  }
  /** A preview that writes her face (expression show, surprise, an authored preview, 试一下). */
  private faceHigherPreview(): boolean {
    const preview = this.capabilityPreview ?? NO_CAPABILITY_PREVIEW;
    return !!(this.surprisePreview || this.expressionShow || this.visualPreview) || preview.mouth > 0 || preview.closure > 0 || preview.sleepEyes > 0;
  }
  /** The face exclusive's scope key: the character and the conversation (as the eyelid compositor's). */
  private faceScopeKey(): string { return `${this.moodView?.characterId ?? ''}\u0000${this.moodView?.token ?? ''}`; }
  /** Seconds until the natural blink in progress (both pulses of a double blink) has opened again; 0 when none. */
  private blinkRemaining(): number {
    if (!((this.naturalBlink ?? 0) > 0)) return 0;
    const life = this.life?.active ? this.life : null, since = (this.elapsed ?? 0) - (this.blinkStart ?? 0), step = 1 / 120;
    let last = 0;
    for (let t = 0; t <= 1; t += step) if ((life ? life.blinkWeight(since + t) : blinkWeight(since + t)) > 0) last = t + step;
    return last;
  }
  /**
   * One frame of the face exclusive, after every other face writer and before the display guard: a higher owner that
   * arrived makes a shape hand back (speech, feeding, a touch, a picked expression, a held closure, a preview), then the
   * shape's conflict group is written once. Idle (no request): only its clock moves; nothing is written.
   */
  private frameFaceExclusive(delta: number): void {
    const face = this.faceExclusive;
    if (!face) return;
    const live = face.active('mouth') || face.active('eyelids');
    let cancel: Partial<Record<FaceScope, string | null>> | undefined;
    if (live) {
      const contact = this.moodContact, manual = this.moodFaceBlocked || this.moodMouthBlocked, preview = this.faceHigherPreview();
      cancel = {
        mouth: this.speaking || this.speechPreparing() ? 'speech' : contact.feeding ? 'feeding' : manual ? 'manual' : preview ? 'preview' : null,
        eyelids: this.lidHeld > 0.02 || contact.contact || contact.pinch?.pinching === true ? 'closure' : manual ? 'manual' : preview ? 'preview'
          : this.moodView?.fatigue?.sleeping === true ? 'sleep' : null,
      };
    }
    const watched = live && this.faceSpeech?.clearAt === null && face.getState().mouth?.id === this.faceSpeech.id;
    face.frame(delta, { key: this.faceScopeKey(), cancel }, this.mesh?.morphTargetInfluences, this.morphLayers);
    if (watched && !face.active('mouth') && this.faceSpeech) this.faceSpeech.clearAt = performance.now();
    if (live || face.owned()) this.renderFaceDiagnostics();
  }
  /** Developer and pretrial reads: the face exclusive's leases, the last one that ended, and speech meeting a mouth shape. */
  private renderFaceDiagnostics(): void {
    if (this.renderer?.domElement && this.faceExclusive) this.renderer.domElement.dataset.faceExclusive = JSON.stringify({ ...this.faceExclusive.getState(), speech: this.faceSpeech });
  }
  /** Who holds her now, in the note's words (empty: free). A higher owner wins; the action does not queue. */
  private herActionBusy(mode: HerActionMode): string {
    const contact = this.moodContact;
    if (!this.hostVisible || document.hidden || !(this.container?.clientWidth > 0) || !(this.container?.clientHeight > 0)) return HER_ACTION_DETAILS.hidden;
    if (contact.contact || contact.feeding || contact.pinch?.pinching === true || (contact.hover ?? 0) > 0) return HER_ACTION_DETAILS.contact;
    if (this.behaviorBlocked || this.controls.interacting) return HER_ACTION_DETAILS.adjusting;
    if (this.rps?.active) return HER_ACTION_DETAILS.game;
    if (this.musicEnabled || this.musicDance?.getState().releasing === true) return HER_ACTION_DETAILS.music;
    if (mode === 'arms' ? this.chatGestureBlocked : this.moodHeadBlocked && (this.bodyManualPose || this.bodyManualGesture)) return HER_ACTION_DETAILS.manual;
    if (this.bodyPreview || this.bodyPersonalize || this.surprisePreview || this.expressionShow || this.visualPreview) return HER_ACTION_DETAILS.preview;
    if (this.herAction?.active) return HER_ACTION_DETAILS.previous;
    return '';
  }
  /** One frame of the action, after the chat gesture: a higher owner arriving makes it hand back (never a cut on screen). */
  private frameHerAction(delta: number): void {
    const player = this.herAction;
    if (!player?.active) return;
    const mode = player.getState().mode ?? 'arms', contact = this.moodContact;
    const yielding = contact.contact || contact.feeding || contact.pinch?.pinching === true || (contact.hover ?? 0) > 0
      || this.behaviorBlocked || this.controls.interacting || this.rps?.active === true || this.musicEnabled
      || (mode === 'arms' ? this.chatGestureBlocked : this.moodHeadBlocked && (this.bodyManualPose || this.bodyManualGesture))
      || !!(this.bodyPreview || this.bodyPersonalize || this.surprisePreview || this.expressionShow || this.visualPreview);
    player.frame(delta, { yield: yielding, cut: !this.hostVisible || document.hidden });
  }
  getBlushSupport(): string { return this.blushSupport; }
  setBlushCalibration(value: BlushCalibration, modelUrl: string): void {
    this.blushCalibration = validateBlushCalibration(value); this.blushCalibrationModelUrl = modelUrl;
    this.blushPreviewUntil = 0; this.blushPreviewing = false;
    if (modelUrl === this.modelUrl) this.rebuildBlush();
  }
  /** A local visual inspection only; it never enters host interaction or reward state. */
  previewBlush(value: BlushCalibration): void {
    if (!this.mesh || !this.head || !this.moodView?.expressions || !this.moodView.parameters.blush.enabled || this.moodFaceBlocked) return;
    this.rebuildBlush(validateBlushCalibration(value));
    this.blushPreviewUntil = performance.now() + 3_000; this.blushPreviewing = true;
  }
  clearBlushPreview(): void {
    this.blushPreviewUntil = 0;
    if (this.blushPreviewing) { this.blushPreviewing = false; this.rebuildBlush(); }
  }
  private rebuildBlush(override?: BlushCalibration): void {
    // Tear materials wrap blush materials: unwind the outer owner first.
    this.proceduralTears?.dispose(); this.proceduralTears = null;
    this.proceduralBlush?.dispose(); this.proceduralBlush = null;
    if (!override) this.cheekAnchors = null;
    if (!this.mesh || !this.head) { this.blushSupport = '红晕需要可识别头骨与双眼参考点'; return; }
    const calibration = override ?? (this.blushCalibrationModelUrl === this.modelUrl ? this.blushCalibration : DEFAULT_BLUSH_CALIBRATION);
    // Adaptation always probes the bind/rest reference. Sampling the currently
    // animated head would freeze its temporary rotation into the cheek anchors.
    const mesh = this.mesh;
    const current = mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
    const morphs = mesh.morphTargetInfluences?.slice();
    const probe = (() => {
      try {
        for (const state of this.restPose) { state.bone.quaternion.copy(state.quaternion); state.bone.position.copy(state.position); }
        mesh.morphTargetInfluences?.fill(0); mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
        if (!this.tearsAnchorsProbed) {
          this.tearsAnchorsProbed = true;
          const tearsProbe = probeBlushAnchors(mesh, this.head, this.eyes, this.findBone(['口', 'あご', '顎', 'jaw', 'Jaw', 'mouth']), DEFAULT_BLUSH_CALIBRATION);
          this.tearsAnchors = tearsProbe.anchors;
          this.tearsReason = this.tearsGate().reason ?? tearsSupport(this.tearsAnchors, this.tearsGate().gene, this.tearsGate().card).reason;
        }
        return probeBlushAnchors(mesh, this.head, this.eyes, this.findBone(['口', 'あご', '顎', 'jaw', 'Jaw', 'mouth']), calibration, this.modelProfile?.mouthLocal);
      } finally {
        for (const state of current) { state.bone.quaternion.copy(state.quaternion); state.bone.position.copy(state.position); }
        if (morphs && mesh.morphTargetInfluences) for (let index = 0; index < morphs.length; index++) mesh.morphTargetInfluences[index] = morphs[index];
        mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
      }
    })();
    this.blushSupport = probe.reason;
    if (!override) this.cheekAnchors = probe.anchors ?? this.modelProfile?.cheekAnchors ?? null; // pinch region still works when no blush can be placed
    // I-024: a card-chosen own blush morph (non-Gene) or 能脸红 off leaves no procedural blush; the anchors above still serve the pinch region.
    if (probe.supported && probe.anchors && !this.cardBlush && !this.blushOff()) {
      const effect = new ProceduralBlush(this.head, probe.anchors, this.mesh);
      const state = effect.getState();
      if (state.supported) this.proceduralBlush = effect;
      else { this.blushSupport = state.reason; effect.dispose(); }
    }
    this.rebuildTears();
  }
  private rebuildTears(): void {
    if (this.proceduralTears || !this.mesh || !this.head || !this.hostVisible || (typeof document !== 'undefined' && document.hidden)) return;
    // I-024: the reviewed Gene unless 能流泪 is off; another model when its card has it on and the face anchors were found.
    const gate = this.tearsGate();
    const support = gate.reason !== null ? { supported: false, reason: gate.reason } : tearsSupport(this.tearsAnchors ?? null, gate.gene, gate.card);
    this.tearsReason = support.reason;
    if (!support.supported || !this.tearsAnchors) return;
    const effect = new ProceduralTears(this.head, this.tearsAnchors, this.mesh, gate.gene, gate.card);
    this.tearsReason = effect.getState().reason;
    if (effect.getState().supported) this.proceduralTears = effect;
    else effect.dispose();
    if (this.cryingFrame) this.proceduralTears?.update(this.cryingFrame.amount, this.cryingFrame.elapsedMs);
  }
  private updateTears(delta: number): void {
    const view = this.moodView;
    if (!view) { this.stopTears(false); return; }
    const effect = this.proceduralTears;
    if (effect && !effect.getState().supported) {
      this.tearsReason = effect.getState().reason; effect.dispose(); this.proceduralTears = null;
    }
    this.cryingTimeline ??= new CryingTimeline();
    this.cryingFrame = this.cryingTimeline.update({ characterId: view.characterId, token: view.token, nowMs: Date.now(), snapshot: view.snapshot,
      durationMs: view.parameters.longing.cryDurationMs, reunionMs: view.parameters.interaction.reunionMs, expressionIntensity: view.snapshot.intensity.expression,
      allowed: view.expressions && !this.behaviorBlocked && !this.controls?.interacting,
      visible: !this.disposed && this.hostVisible && !(typeof document !== 'undefined' && document.hidden) && this.container.clientWidth > 0 && this.container.clientHeight > 0,
      supported: this.proceduralTears?.getState().supported === true, faceBlocked: this.moodFaceBlocked }, delta);
    // I-024 试一下 能流泪: the preview's own amount and clock, unless a real cry shows more.
    const preview = this.capabilityPreview ?? NO_CAPABILITY_PREVIEW, previewShown = preview.tears > this.cryingFrame.amount;
    this.proceduralTears?.update(previewShown ? preview.tears : this.cryingFrame.amount, previewShown ? preview.tearsMs : this.cryingFrame.elapsedMs);
    if (this.renderer?.domElement) this.renderer.domElement.dataset.crying = JSON.stringify({ ...this.cryingFrame, preview: previewShown,
      support: this.tearsReason, surface: this.proceduralTears?.getState() ?? null });
  }
  private stopTears(release: boolean): void {
    this.cryingTimeline?.cancel(); this.cryingFrame = null;
    this.proceduralTears?.update(0, 0);
    if (release) { this.proceduralTears?.dispose(); this.proceduralTears = null; }
    if (this.renderer?.domElement) this.renderer.domElement.dataset.crying = JSON.stringify({ phase: 'idle', amount: 0, support: this.tearsReason, surface: this.proceduralTears?.getState() ?? null });
  }
  getMoodDegradation(): string {
    return [!this.head ? '当前模型缺少可识别头骨' : '', this.moodHeadBlocked ? '手选头部动作保持播放，自动情绪姿态让位；直接 rua 附加仍保留' : '',
      this.moodFaceBlocked ? '手选表情优先，自动面部让位' : this.smileIndex < 0 ? '未识别到笑意 morph，使用眼神和姿态' : '',
      this.blushOff() ? this.capabilityNote('blush', '脸红', '')
        : this.cardBlush ? '脸红用模型自身的脸红表情（模型体检卡）；大小调节仅用于程序红晕'
        : this.proceduralBlush ? this.blushSupport : this.blushChannel ? `${this.blushSupport}；暂用模型自身脸红，大小调节仅用于程序红晕` : this.blushSupport,
      this.chatGestureBlocked ? this.chatGestureBlockReason === 'motion-loading' ? '动作加载期间暂停聊天动作'
        : this.chatGestureBlockReason === 'manual-gesture' ? '手选手势优先，聊天动作暂时让位'
        : '当前身体动作占用上身，聊天动作暂时让位；选择兼容待机后可恢复' : '',
      this.chatGestureError,
        this.behaviorMotion && !this.behaviorMotion.supported ? '新增眉眼动作仅适配已审核 Gene；当前保留程序表情' : '',
      // I-024: the drowsy lids and the sleep pose follow the model's capability card (the reviewed Gene keeps its reviewed lids).
      this.moodView?.fatigue?.sleeping && !capabilityEnabled(this.capabilities(), 'sleepPose') ? this.capabilityNote('sleepPose', '睡姿', '当前保留原姿态') : '',
      this.moodView?.fatigue && !this.fatigueEyelidsAllowed()
        ? (capabilityEnabled(this.capabilities(), 'closeEyes') ? '体检卡的眨眼部位舞台还用不上：疲倦眼皮不开' : this.capabilityNote('closeEyes', '疲倦眼皮', '当前模型保留原表情')) : '',
      this.moodView?.fatigue?.phase === 'drowsy' && !this.drowsyFaceAllowed() ? this.capabilityNote('drowsyFace', '困的脸', '当前保留原表情')
        : this.moodView?.fatigue?.phase === 'drowsy' && this.tearsVerifiedGene !== true ? drowsyFaceGapNote(profileDrowsyTargets(this.mesh ?? undefined, this.head, // I-038
          { sad: this.sadIndex, jitome: this.modelProfile?.profile?.morphs?.jitome?.index ?? -1, blink: this.blinkIndex })) : '',
      this.tearsReason ?? '泪水定位尚未就绪'].filter(Boolean).join('；');
  }
  getInteractionRegion(): { x: number; y: number; radius: number; mouthX: number; mouthY: number; referenceWidth: number; mouthRadius: number; axisXX: number; axisXY: number; axisYX: number; axisYY: number; cheeks: CheekRegion[] } | null {
    if (!this.mesh || !this.head || !this.hostVisible || this.controls.interacting) return null;
    const forehead = new Vector3(0, this.height * 0.035, this.height * 0.02);
    this.head.localToWorld(forehead);
    const distance = Math.max(0.1, this.camera.position.distanceTo(forehead));
    const radius = clamp(this.height * 0.07 * this.container.clientHeight / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2) * distance), 12, this.container.clientWidth * 0.3);
    const mouth = this.modelProfile?.mouthLocal?.clone() ?? new Vector3(0, -this.height * 0.01, this.height * 0.05); // measured on non-Gene models
    this.head.localToWorld(mouth);
    mouth.project(this.camera);
    this.headContactProfile ??= probeHeadContact(this.mesh, this.head, this.eyes, this.height, this.modelProfile?.contactEyes);
    const scalp = projectHeadContact(this.headContactProfile, this.head, this.camera, this.container.clientWidth, this.container.clientHeight);
    if (!scalp) return null;
    const calibration = this.blushCalibrationModelUrl === this.modelUrl ? this.blushCalibration : DEFAULT_BLUSH_CALIBRATION;
    const reviewedCheeks = this.tearsVerifiedGene === true && (Object.keys(DEFAULT_BLUSH_CALIBRATION) as (keyof BlushCalibration)[])
      .every(key => calibration[key] === DEFAULT_BLUSH_CALIBRATION[key]);
    const cheeks = projectCheekRegions(this.cheekAnchors ?? null, this.head, this.camera, this.container.clientWidth, this.container.clientHeight, radius * 2, reviewedCheeks);
    const region = { ...scalp, radius, referenceWidth: radius * 2, mouthRadius: radius * 0.7, cheeks,
      mouthX: (mouth.x + 1) * this.container.clientWidth / 2, mouthY: (1 - mouth.y) * this.container.clientHeight / 2 };
    // A read-only projection also makes isolated real-renderer checks reproducible.
    this.renderer.domElement.dataset.interactionRegion = JSON.stringify(region);
    return region;
  }

  /**
   * Music is audible and allowed (the audio switch). Since M1 that only means she hears it: whether she
   * moves is her choice (music-choice.ts). Without that choice object (the music settings not received,
   * or "让她一直跟着跳" on) it is exactly the original R15 call.
   */
  setMusicEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.musicHearing = enabled;
    if (!enabled) this.musicLikeness?.reset();
    if (!this.musicChoice) { this.setDanceOn(enabled); return; }
    this.musicChoice.setHearing(enabled);
    this.applyMusicTier();
  }

  /** The R15 dance switch, as it always was. */
  private setDanceOn(enabled: boolean): void {
    if (this.disposed || this.musicEnabled === enabled) return;
    this.musicEnabled = enabled;
    if (enabled) this.cancelBodyMotion();
    this.musicSignal = null;
    if (enabled) this.musicDance.resume();
    else this.musicDance.stop();
    this.syncMusicSuppression();
    // Keep the displayed frame intact between ticks. The normal outer restore
    // and advancing base pose will receive the short exit on the next frame.
    this.updateBodyMotion();
  }

  setMusicSample(sample: MusicEnergySample): void {
    if (this.disposed || !this.mesh) return;
    this.musicChoice?.noteLevel(sample.rms); // R18: whether sound is actually coming in (the capture runs in silence too)
    (this.musicLikeness ??= new MusicLikeness()).update(sample); // I-016: and whether it is music
    if (sample.rms >= MUSIC_AUDIBLE_RMS) this.musicLoudAt = performance.now();
    if (!this.musicEnabled) { if (this.musicNod?.active) this.musicNod.update(sample); return; }
    this.syncMusicSuppression();
    const beat = this.musicDance.update(sample);
    if (!this.musicSuppressed) this.musicSignal = { sample: { ...sample }, ...beat };
  }

  setMusicSettings(settings: Partial<MusicSettings>): void {
    this.musicSettings = normalizeMusicSettings(settings, this.musicSettings);
    // M1: "让她一直跟着跳" (default off) is the way back to the original R15 behaviour; otherwise she chooses.
    const always = this.musicSettings.alwaysDance === true;
    if (!this.musicChoice) {
      if (always) return;
      // First time: start from "always" with what she hears now, so a dance already running carries on and is judged on the next frame.
      const created = new MusicChoice();
      created.setAlways(true); created.setHearing(this.musicHearing);
      this.musicChoice = created;
    }
    this.musicChoice.setAlways(always);
    this.applyMusicTier();
  }

  /** Her choice for this frame, applied: the dance (R15), the light nod (R18 small motion) or nothing. */
  private applyMusicTier(): void {
    const choice = this.musicChoice;
    if (!choice) return;
    const tier = choice.tier;
    (this.musicNod ??= new MusicNod()).setActive(tier === 'nod');
    this.setDanceOn(tier === 'dance');
    if (tier !== this.reportedMusicTier) {
      this.reportedMusicTier = tier;
      try { this.options.onMusicTier?.(tier, choice.isAlways ? null : choice.getState().score); } catch { /* A record never changes the dance. */ }
    }
  }

  /** Once per frame, before procedural life: she judges (new song, a few seconds in, every so often) and her tier is applied. */
  private frameMusicChoice(delta: number): void {
    const choice = this.musicChoice;
    if (!choice) return;
    // I-016: only what she recognizes as music is danced or nodded to; the beat analysis runs on underneath (music-dance.ts setHeld).
    // With the capture off the hold stays as it was: the dance's own R15 exit takes it away.
    const music = this.musicHearing && this.musicLikeness?.music === true;
    choice.noteMusic(music); if (this.musicHearing) { this.musicDance.setHeld(!music); this.musicNod?.setHeld(!music); }
    if (choice.isAlways) { choice.frame(delta); return; }
    const view = this.moodView, weights = view?.parameters?.weights, fatigue = view?.fatigue;
    const context: MusicChoiceContext = {
      playfulWeight: weights?.playful ?? 1, cautiousWeight: weights?.cautious ?? 1, playfulIntensity: view?.snapshot?.intensity?.playful ?? 50,
      mood: view?.snapshot?.primary, fatigue: fatigue ? { phase: fatigue.phase, F: fatigue.F, sleeping: fatigue.sleeping } : null, activity: view?.herLife?.activity,
      scope: view ? `${view.characterId}|${view.token}` : '', request: view?.danceRequest ?? null, nowMs: Date.now(), expressive: view ? view.expressions === true : true,
    };
    choice.frame(delta, context);
    if (choice.takeListenCue()) { this.musicListenSide = -this.musicListenSide; (this.musicListen ??= new MusicListenCue()).start(this.musicListenSide); }
    this.musicNod?.setSuppressed(this.speaking === true);
    this.applyMusicTier();
  }

  /** The nod's offsets for procedural life this frame, or null when she is not nodding (nothing added, nothing allocated). */
  private frameMusicNod(delta: number): { headX: number; headZ: number; bodyZ: number } | null {
    const nod = this.musicNod;
    const nodding = nod && nod.busy ? nod.frame(delta, this.musicSettings?.strength ?? 0.7) : null;
    // R18: the listening look rides on the same input (same owners, yields and clamps), added to the nod when both show.
    const listen = this.musicListen?.active ? this.musicListen.frame(delta, this.musicSettings?.strength ?? 0.7) : null;
    if (!listen) return nodding;
    const beat = this.musicBeat ??= { headX: 0, headZ: 0, bodyZ: 0 };
    beat.headX = (nodding?.headX ?? 0) + listen.headX; beat.headZ = (nodding?.headZ ?? 0) + listen.headZ; beat.bodyZ = nodding?.bodyZ ?? 0;
    return beat;
  }

  /** I-017: what her body is doing to the sound right now (src/stage/music-presence.ts); read-only, reported to the host. */
  getMusicPresence(): ReturnType<typeof musicPresence> {
    return musicPresence({ hearing: this.musicHearing, choice: this.musicChoice, danceOn: this.musicEnabled, sinceLoudS: (performance.now() - this.musicLoudAt) / 1000,
      music: this.musicLikeness?.music === true, beat: this.musicLikeness?.score ?? 0 }); // I-016
  }

  /** Developer panel line: her want to dance, the tier it gives and why; I-016: is it music here, and the host's kind (developer mode only). */
  getMusicChoiceLine(): string {
    return this.moodView?.developerMode && this.musicChoice ? [this.musicChoice.getState().line, this.musicHearing ? likenessLine(this.musicLikeness?.getState()) : '', this.listenKindLine].filter(Boolean).join(' ｜ ') : '';
  }
  /** I-016: the host's listen kind for the developer line (src/ui/listen-kind-panel.ts); '' clears it. */
  setListenKindLine(line: string): void { this.listenKindLine = typeof line === 'string' ? line.slice(0, 200) : ''; }

  /** Developer test command ("测试：重新判一次想不想跳"): she judges again at the next frame. False: no music, or "一直跟着跳". */
  rejudgeMusicNow(): boolean { return this.musicChoice?.rejudgeNow() ?? false; }

  /** Observe ownership both on incoming samples and on every display frame. */
  private syncMusicSuppression(inFrame = false): void {
    if (!this.musicDance) return;
    const contact = this.moodContact;
    // M006 contributes this optional contact-scoped field when its module is
    // merged. It grants no new interaction and only makes music yield.
    const pinching = (contact as (MoodContact & { pinch?: { pinching?: boolean } }) | undefined)?.pinch?.pinching === true;
    const reason = this.disposed ? 'disposed'
      : this.hostVisible === false || (typeof document !== 'undefined' && document.hidden) ? 'hidden'
      : this.speaking ? 'speech'
      : this.musicCameraEditing || this.controls?.interacting ? 'camera'
      : this.behaviorBlocked ? 'window-or-input'
      : contact?.contact || contact?.feeding || contact?.prepared || pinching || (contact?.hover ?? 0) > 0 || this.moodFeedback?.patHolding ? 'direct-interaction'
      : this.musicManualHeadBlocked ? 'manual-head'
      : !this.musicEnabled ? 'disabled' : null;
    const blocked = reason !== null && reason !== 'disabled';
    // R29b: only hide/dispose cut the dance; every other owner takes over by the dance's own yield fade (music-dance.ts).
    if ((reason === 'hidden' || reason === 'disposed') && this.musicBlockReason !== reason) {
      if (!inFrame) { this.localPhysics?.restore(); this.motionTransition?.restore(); this.restorePersonalizeBody(); }
      this.resetMusicPresentation();
      if (!inFrame) { this.motionTransition?.frame(0); this.localPhysics?.frame(0); }
    }
    this.musicDance.setSuppressed(blocked);
    if (blocked) this.musicSignal = null;
    this.musicSuppressed = blocked;
    this.musicBlockReason = reason;
  }

  private resetMusicPresentation(): void {
    this.musicDance?.reset();
    this.musicNod?.reset();
    this.musicListen?.reset();
    this.musicPose = { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 };
    this.musicSignal = null;
  }

  setCameraEditMode(enabled: boolean): void {
    if (enabled) this.stopTears(false);
    this.bodyCameraEditing = enabled;
    if (enabled) this.cancelBodyMotion();
    this.controls.setEnabled(enabled && !this.disposed && this.hostVisible && !document.hidden);
  }

  /** Electron native hide/show is authoritative on platforms without Page Visibility updates. */
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    if(!visible){this.cancelVisualPreview();this.cancelBodyPreview();this.cancelPersonalizeBody();}
    this.hostVisible = visible;
    if (!visible) { this.localPhysics?.setVisible(false); this.motionTransition?.dispose(); this.motionTransition = null; }
    this.reconcileVisibility();
  }

  getFramingView() {
    return { modelGeneration: this.modelGeneration, cameraRevision: this.framingRevision,
      modelUrl: this.settings?.model?.url ?? '', ready: !this.disposed && !!this.mesh,
      camera: structuredClone(this.framingCamera ?? { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 }) };
  }
  frame(preset: "full" | "portrait"): CameraConfig | null {
    if (!this.mesh || this.disposed) return null;
    // P4: the model stays below the toolbar band so the crown pat region is reachable (stage-framing.ts).
    let reserved = 0;
    try { reserved = this.options.framingTop?.() ?? 0; } catch { reserved = 0; }
    const next = framingCamera(preset, { height: this.height, width: this.width, baseY: this.baseY, centerX: this.centerX }, {
      aspect: this.camera.aspect || 1, fov: this.settings?.camera.fov ?? 32,
      topBand: framingTopBand(this.container.clientHeight, reserved),
    });
    this.setCamera(next);
    this.options.onCameraChange?.(this.framingCamera!);
    return structuredClone(this.framingCamera!);
  }
  /** Pet: replace the never-framed default camera with full framing (saved through onCameraChange). */
  private frameIfUnframed(): void {
    if (this.options.frameUnframed && this.mesh && !this.disposed && this.framingCamera && isUnframedCamera(this.framingCamera)) this.frame('full');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
    this.presence?.settle();
    this.modelGeneration++;
    this.motionGeneration++;
    this.settingsGeneration++;
    cancelAnimationFrame(this.frameId);
    this.pixelProbe?.dispose();
    this.strayPixels?.dispose();
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.onContextLost,
    );
    this.controls.dispose();
    this.moodFeedback.reset();
    this.clearModel();
    if (this.grid) {
      this.grid.geometry.dispose();
      for (const material of this.materials(this.grid.material))
        material.dispose();
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private setCamera(config: CameraConfig): void {
    this.cancelBodyMotion();
    const next = normalizeCamera(config);
    const framingChanged = !this.framingCamera || cameraSignature(next) !== cameraSignature(this.framingCamera);
    this.framingCamera = structuredClone(next);
    if (framingChanged) this.framingRevision++;
    this.lastSettingsCamera = cameraSignature(next);
    this.controls.setCamera(next);
    const { forward } = cameraBasis(next);
    this.camera.position.set(
      next.targetX - forward.x * next.distance,
      next.targetY - forward.y * next.distance,
      (next.targetZ ?? 0) - forward.z * next.distance,
    );
    this.camera.lookAt(next.targetX, next.targetY, next.targetZ ?? 0);
    this.camera.fov = next.fov;
    this.camera.updateProjectionMatrix();
    if (framingChanged) this.options.onFramingStateChange?.();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (!this.disposed && this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0) this.rebuildTears();
    else this.stopTears(true);
    this.localPhysics?.setVisible(this.hostVisible && !document.hidden && this.container.clientWidth > 0 && this.container.clientHeight > 0);
    void this.ensureLocalPhysics();
    this.renderPhysicsDiagnostics();
    // Resizing clears the WebGL drawing buffer. Present the same scene now;
    // the FPS cap must not leave a transparent gap until the next animation tick.
    if (!this.disposed && this.hostVisible && !document.hidden) this.renderer.render(this.scene, this.camera);
  }

  private async loadModel(url: string): Promise<void> {
    const generation = ++this.modelGeneration;
    this.motionGeneration++;
    this.motionUrl = "";
    // C2: the model on stage fades out while she keeps moving; only then is she taken off the stage.
    await this.fadeOutModel();
    if (this.disposed || generation !== this.modelGeneration) return;
    this.clearModel();
    if (!url) {
      this.options.onStatus?.("请选择 PMX / PMD 模型");
      this.revealModel();
      return;
    }
    this.options.onStatus?.("正在加载模型与纹理…");
    const manager = new LoadingManager();
    manager.addHandler(
      /\.(?:png|jpe?g|bmp|gif|webp|sph|spa)(?:[?#].*)?$/i,
      new CappedTextureLoader(manager),
    );
    let resourcesReady = false;
    let resourceFailed = false;
    manager.onLoad = () => {
      resourcesReady = true;
      if (!this.disposed && generation === this.modelGeneration && this.mesh && !this.motionUrl) {
        this.options.onStatus?.(
          resourceFailed ? "模型已载入 · 部分纹理缺失" : "模型已就绪",
        );
      }
    };
    // PMX texture paths may use Windows separators and relative Japanese/Chinese names.
    manager.setURLModifier((resource) => resource.replace(/\\/g, "/"));
    manager.onError = (resource) => {
      resourceFailed = true;
      if (!this.disposed && generation === this.modelGeneration)
        this.options.onError?.(`资源加载失败：${resource.split("/").pop()}`);
    };
    const loader = new MMDLoader(manager);
    try {
      const mesh = await new Promise<SkinnedMesh>((resolve, reject) =>
        loader.load(url, resolve, undefined, reject),
      );
      const current = () => !this.disposed && generation === this.modelGeneration && this.modelUrl === url;
      if (!current()) { this.disposeMesh(mesh); return; }
      let targetSupported = false;
      const profileCache = requestModelProfileCache(window.desktop, url);
      try { targetSupported = await window.desktop.isBehaviorModelSupported() === true; } catch { /* Unknown targets keep the existing presentation. */ }
      const cachedProfile = await profileCache;
      if (!current()) {
        this.disposeMesh(mesh);
        return;
      }
      this.mesh = mesh;
      this.tearsVerifiedGene = targetSupported;
      this.bodyTargetSupported = targetSupported;
      this.chatGesturePlayer = new ChatGesturePlayer(mesh);
      this.herAction?.dispose(); this.herAction = new HerActionPlayer(mesh); this.herActionClips?.clear();
      this.faceExclusive?.cut('model'); this.faceExclusive = new FaceExclusive(mesh); this.faceActionClips?.clear();
      this.behaviorMotion = new BehaviorMotionPlayer(mesh, {
        targetSupported, universal: () => this.mesh === mesh ? universalTarget(this.motionRetarget) : null, // I-038
        resolve: (cueId, token) => this.visualPreview?.value.id===cueId&&this.visualPreview.value.token===token
          ?window.desktop.resolveVisualPreview(cueId,token,this.modelGeneration):window.desktop.resolveBehaviorMotion(cueId, token),
        load: (resource, target) => {
          const loader = withKeyframeInterpolation(new MMDLoader()); loader.parser = createVmdParser(undefined, this.motionRetarget?.transform);
          return new Promise<AnimationClip>((resolve, reject) => loader.loadAnimation(resource.url, target, value => {
            // R29d: a face motion the fit check hides on this model is refused (the motion library's wording).
            if (this.motionUnfit(resource.sha256)) { reject(new Error('这个动作不适合当前模型')); return; }
            const clip = value as AnimationClip; clip.duration = resource.durationMs / 1000; resolve(clip);
          }, undefined, reject));
        },
        // R29d: a cached clip whose motion the fit check hides on this model is not started either.
        suits: sha256 => !this.motionUnfit(sha256),
      });
      mesh.frustumCulled = false; // Skinned MMD bounds do not follow VMD automatically.
      this.scene.add(mesh);
      // C2: applySettings reveals her once her motions are in; this only covers a settings pass that never gets there.
      if (this.revealTimer) clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => { this.revealTimer = null; if (!this.disposed && generation === this.modelGeneration) this.revealModel(); }, 3000);
      (this.revealTimer as { unref?: () => void }).unref?.();
      this.restPose = mesh.skeleton.bones.map((bone) => ({
        bone,
        quaternion: bone.quaternion.clone(),
        position: bone.position.clone(),
      }));
      const bounds = new Box3().setFromObject(mesh);
      this.height = Math.max(1, bounds.max.y - bounds.min.y);
      this.width = Math.max(1, bounds.max.x - bounds.min.x);
      this.centerX = (bounds.min.x + bounds.max.x) / 2;
      this.baseY = bounds.min.y;
      if (this.grid) this.grid.position.y = this.baseY - 0.03;
      const profile = this.modelProfile = new StageModelProfile(mesh, { reviewed: targetSupported, cached: cachedProfile?.profile });
      this.head = this.findBone(["頭", "head", "Head"]) ?? profile.bone('head');
      this.eyes = [
        this.findBone(["左目", "左眼", "LeftEye", "left_eye", "eye_L", "eye_l"]) ?? profile.bone('eyeLeft'),
        this.findBone(["右目", "右眼", "RightEye", "right_eye", "eye_R", "eye_r"]) ?? profile.bone('eyeRight'),
      ].filter((bone): bone is Bone => !!bone);
      if (!this.eyes.length) {
        const both = this.findBone(["両目", "Eyes", "eyes"]);
        if (both?.children.some(child => child instanceof Bone)) this.eyes = [both];
      }
      profile.attachHead(this.head);
      this.headContactProfile = this.head ? probeHeadContact(mesh, this.head, this.eyes, this.height, profile.contactEyes) : null;
      this.chest = this.findBone([
        "上半身2",
        "上半身",
        "spine",
        "Spine",
        "Chest",
      ]);
      this.center = this.findBone(["センター", "全ての親", "center", "Center"]);
      this.lifeRig = lifeRig(mesh, profile, this.chest);
      this.arms = [];
      for (const aliases of [
        ["左腕", "LeftArm", "left_arm"],
        ["右腕", "RightArm", "right_arm"],
      ]) {
        const bone = this.findBone(aliases);
        const child = bone?.children.find((node) => node instanceof Bone) as
          Bone | undefined;
        if (bone && child)
          this.arms.push({
            bone,
            roll: relaxedArmRoll(child.position.x, child.position.y),
          });
      }
      const dictionary = mesh.morphTargetDictionary ?? {};
      ({ blink: this.blinkIndex, mouth: this.mouthIndex, smile: this.smileIndex, sad: this.sadIndex } = profile.indices);
      if (profile.fresh && cachedProfile) void window.desktop.saveModelProfile?.(cachedProfile.modelKey, profile.profile)?.catch(() => {});
      if (this.renderer?.domElement?.dataset) this.renderer.domElement.dataset.modelProfile = JSON.stringify(profile.summary);
      const retarget: StageMotionRetarget = this.motionRetarget = new StageMotionRetarget(mesh, profile.profile, { reviewed: targetSupported, ...motionFitStorage(cachedProfile, window.desktop), onChange: view => {
        if (this.motionRetarget === retarget) this.motionFitChanged(view);
      } });
      retarget.announce();
      if (!this.options.transparent && retarget.plan) void retarget.scan({ resolve: (packId, motionId) => window.desktop.previewMotion(packId, motionId).then(asset => asset.url),
        read: url => fetch(url).then(response => response.arrayBuffer()), parse: buffer => parseVmdWith(buffer, retarget.transform), current: () => this.motionRetarget === retarget && !this.disposed });
      this.blushChannel = selectBlushChannel(dictionary, mesh.geometry);
      this.cardBlush = this.resolveCardBlush(); // I-024: before the procedural blush is (or is not) built
      this.rebuildBlush();
      this.physicsSupport = probeModelPhysicsSupport(mesh);
      this.physicsError = '';
      this.renderPhysicsDiagnostics();
      void this.ensureLocalPhysics();
      // Same task as scene.add(mesh): a fresh profile's default camera is never drawn on the model.
      this.frameIfUnframed();
      this.options.onFramingStateChange?.();
      this.options.onStatus?.(
        resourcesReady
          ? resourceFailed
            ? "模型已载入 · 部分纹理缺失"
            : "模型已就绪"
          : "模型已载入 · 纹理加载中…",
      );
    } catch (error) {
      if (!this.disposed && generation === this.modelGeneration) {
        this.options.onError?.(`模型加载失败：${this.errorMessage(error)}`);
        this.options.onStatus?.("模型未加载");
        this.revealModel(); // Nothing of her is there; the stage itself (grid, empty state) shows again.
      }
    }
  }

  /** C2: fade the shown model out (bounded wait: a hidden window never holds the switch). */
  private async fadeOutModel(): Promise<void> {
    const presence = this.presence ??= new PresenceFade();
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
    if (!this.mesh || !this.hasRenderedModel) { presence.set(0); return; } // Nothing shown: the next model fades in.
    presence.fadeTo(0, PRESENCE_FADE_OUT_MS);
    await Promise.race([presence.whenDone(), new Promise<void>(resolve => setTimeout(resolve, PRESENCE_FADE_OUT_MS + 250))]);
    presence.settle();
  }
  /** C2: the new model is posed (or nothing loaded): fade in. A safety timer reveals her even if motions never come. */
  private revealModel(): void {
    const presence = this.presence ??= new PresenceFade();
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
    if (presence.target < 1) presence.fadeTo(1, PRESENCE_FADE_IN_MS);
  }
  /** One frame of the presence fade, applied to the canvas only when it changes. */
  private framePresence(delta: number): void {
    const value = this.presence ? this.presence.frame(delta) : 1;
    if (value >= 1 && this.presence && this.hasRenderedModel && !this.firstShown) { this.firstShown = true; this.options?.onFirstShown?.(); } // 体验记录: first fade-in done
    const shown = value >= 1 ? '' : value.toFixed(4);
    if (shown === this.presenceShown) return;
    this.presenceShown = shown;
    const style = (this.renderer?.domElement as HTMLCanvasElement | undefined)?.style;
    if (style) style.opacity = shown;
    if (this.renderer?.domElement?.dataset) this.renderer.domElement.dataset.presence = shown || '1';
  }

  private async loadMotions(assets: ReturnType<typeof getMotionLayerAssets>, legacy: boolean): Promise<void> {
    this.cancelSurprisePreview();
    this.cancelBodyMotion(); this.bodyReady = false;
    this.qaStandCommit = null;
    this.stopTears(false);
    this.musicManualHeadBlocked = true;
    this.syncMusicSuppression();
    this.cancelChatGesture(true);
    this.chatGestureBlocked = true;
    this.chatGestureBlockReason = 'motion-loading';
    const generation = ++this.motionGeneration;
    const mesh = this.mesh;
    if (!mesh) return;
    if (!assets.pose && !assets.gesture && !assets.expression) {
      this.clearMotionSmooth();
      this.animation ??= new LayeredMmdAnimation(mesh);
      this.bodyManualPose = this.bodyManualGesture = this.bodyDynamicPose = false;
      this.bodyReady = true; this.updateBodyMotion();
      this.options.onStatus?.("模型已就绪 · 平滑呼吸待机");
      return;
    }
    this.options.onStatus?.("正在加载 VMD 动作…");
    try {
      const load = (url?: string): Promise<AnimationClip | null> => {
        if (!url) return Promise.resolve(null);
        let pending = this.motionClips.get(url);
        if (!pending) {
          const loader = withKeyframeInterpolation(new MMDLoader());
          let sourceDuration = 0;
          // R29d: the retarget hook also says which library motion the bytes were, so the layer can be judged by its fit.
          const retarget = this.motionRetarget;
          loader.parser = createVmdParser(report => { sourceDuration = report.durationFrames / 30; },
            retarget?.transformFor(sha256 => (this.layerShas ??= new Map()).set(url, sha256)) ?? retarget?.transform);
          pending = new Promise<AnimationClip>((resolve, reject) => loader.loadAnimation(
            url, mesh, value => {
              const clip = value as AnimationClip;
              // Keep the authored timeline, including default-only clips.
              clip.duration = Math.max(clip.duration, sourceDuration, 1 / 30);
              resolve(clip);
            }, undefined, reject,
          ));
          this.motionClips.set(url, pending);
          const captured = pending;
          void pending.catch(() => { if (this.motionClips.get(url) === captured) this.motionClips.delete(url); });
        }
        return pending;
      };
      const [pose, gesture, expression] = await Promise.all([
        load(assets.pose?.url), load(assets.gesture?.url), legacy ? Promise.resolve(null) : load(assets.expression?.url),
      ]);
      let reviewedDefault = false;
      if (assets.pose && isDefaultPoseCandidateName(assets.pose.name)) {
        let check = this.defaultPoseChecks.get(assets.pose.url);
        if (!check) {
          check = isReviewedDefaultPose(assets.pose.url); this.defaultPoseChecks.set(assets.pose.url, check);
          if (this.defaultPoseChecks.size > 8) this.defaultPoseChecks.delete(this.defaultPoseChecks.keys().next().value!);
        }
        reviewedDefault = await check;
      }
      if (
        this.disposed ||
        generation !== this.motionGeneration ||
        this.mesh !== mesh
      )
        return;
      const selection: MotionSelection = { generation, mesh, assets, legacy, reviewedDefault, clips: { pose, gesture, expression } };
      this.motionSelection = selection;
      this.commitMotionLayers(selection);
      const retained = new Set([assets.pose?.url, assets.gesture?.url, assets.expression?.url]);
      for (const url of this.motionClips.keys()) if (!retained.has(url)) { this.motionClips.delete(url); this.layerShas?.delete(url); }
      this.bodyReady = true; this.updateBodyMotion();
      this.localPhysics?.frame(0);
      this.reportMotionStatus(legacy);
    } catch (error) {
      if (!this.disposed && generation === this.motionGeneration)
        this.options.onError?.(`动作加载失败：${this.errorMessage(error)}`);
    }
  }

  /** R29d: a selected or granted motion whose library entry the fit check hides on this model. */
  private motionUnfit(sha256: string | null | undefined): boolean {
    return !!sha256 && this.motionRetarget?.fitOf(sha256)?.status === 'hidden';
  }
  /** The loaded layers that suit this model; a hidden library motion is held (null here, still selected). */
  private fittedLayers(selection: MotionSelection): MotionLayerClips {
    const { clips, assets } = selection;
    const fit = (clip: AnimationClip | null, asset: AssetRef | null | undefined) =>
      clip && !(asset && this.motionUnfit(this.layerShas?.get(asset.url))) ? clip : null;
    return { pose: fit(clips.pose, assets.pose), gesture: fit(clips.gesture, assets.gesture), expression: fit(clips.expression, assets.expression) };
  }

  /**
   * Commits the selected layers that suit this model (R29d; unfit ones are
   * held) and derives the ownership flags from what actually plays. The switch
   * is a hand-off from what is shown: the bridge covers the changed tracks and
   * the bones the MMD helper derives from them (grant children, IK links), for
   * a time sized by the correction, like a revoked body motion (R29c).
   */
  private commitMotionLayers(selection: MotionSelection): void {
    const { mesh, assets, legacy, reviewedDefault, generation } = selection;
    const { pose, gesture, expression } = this.fittedLayers(selection);
    this.committedLayers = { pose, gesture, expression };
    this.heldLayers = (['pose', 'gesture', 'expression'] as const).filter(layer => !!selection.clips[layer] && !this.committedLayers![layer]);
    this.localPhysics?.restore();
    this.restoreTorsoForMotionCapture();
    const previous = this.hasRenderedModel ? captureMotionPose(mesh) : null;
    this.motionTransition?.restore();
    this.restorePersonalizeBody();
    this.behaviorMotion?.restore();
    this.herAction?.restore(); this.chatGesturePlayer?.restore();
    this.restoreLayers();
    this.animation ??= new LayeredMmdAnimation(mesh);
    this.cancelBodyMotion();
    const affected = this.animation.setClips({ pose, gesture, expression } satisfies MotionLayerClips, { legacy });
    // Reuse the completed pinned-content check, then bind that source to the
    // actual committed pose Action. No filename-only qualification or URL in diagnostics.
    if (reviewedDefault && assets.pose?.name === 'stand.vmd'
      && decodeURIComponent(new URL(assets.pose.url).pathname).split('/').at(-1) === 'stand.vmd'
      && pose && !gesture && !expression && this.bodyTargetSupported) {
      const actions = this.animation.getBehaviorBodyBindings().baseActions();
      const action = actions.length === 1 ? actions[0] : null, clip = action?.getClip();
      if (action && clip && clip.tracks.length > 0 && clip.tracks.every(track => pose.tracks.includes(track)))
        this.qaStandCommit = { model: this.modelGeneration, motion: generation, mesh, animation: this.animation, clip, action };
    }
    if (previous && affected.length) {
      this.motionTransition ??= new MotionTransition(mesh);
      this.motionTransition.start(previous, withDerivedBones(mesh, affected), switchDurationMs, this.poseRates());
      this.motionTransition.frame(0);
    }
    this.chatGestureBlocked = Boolean(gesture) || (!reviewedDefault && Boolean(pose?.tracks.some(track => {
      if (!isChatGestureTrack(track.name) || track.times.length < 2) return false;
      const width = track.getValueSize();
      for (let index = width; index < track.values.length; index++) if (Math.abs(track.values[index] - track.values[index % width]) > 0.0001) return true;
      return false;
    })));
    this.chatGestureBlockReason = gesture ? 'manual-gesture' : this.chatGestureBlocked ? 'manual-pose' : null;
    this.bodyManualPose = Boolean(pose) && !reviewedDefault;
    this.bodyManualGesture = Boolean(gesture);
    this.bodyDynamicPose = !reviewedDefault && this.chatGestureBlocked;
    const facial = legacy ? pose : expression;
    this.moodFaceBlocked = !!facial?.tracks.some(track => /^\.morphTargetInfluences\[/.test(track.name) || /(?:目|眼|口|眉|jaw|eye|lip)/i.test(track.name));
    const mouthIndices = new Set([this.mouthIndex]);
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
      if (/^(?:あ|い|う|え|お|ん|a|i|u|e|o|aa|ih|ou|ee|oh)$/i.test(name.normalize('NFKC')) || /(?:口|唇|あご|顎|jaw|mouth|lip)/i.test(name)) mouthIndices.add(index);
    }
    this.moodMouthBlocked = !!facial?.tracks.some(track => {
      const morph = /^\.morphTargetInfluences\[(\d+)\]$/.exec(track.name);
      return morph ? mouthIndices.has(Number(morph[1])) : /(?:口|唇|あご|顎|jaw|mouth|lip)/i.test(track.name);
    });
    const headName = this.head?.name;
    const headRestPosition = this.restPose.find(state => state.bone === this.head)?.position;
    this.musicManualHeadBlocked = hasOwnedLayeredHeadTrack({ pose, gesture, expression }, headName, headRestPosition, { legacy, reviewedDefault });
    this.syncMusicSuppression();
    this.moodHeadBlocked = !!headName && [pose, gesture].some(clip => clip?.tracks.some(track => {
      if (!track.name.startsWith(`.bones[${headName}]`) || track.times.length < 2) return false;
      const width = track.getValueSize();
      for (let i = width; i < track.values.length; i++) if (Math.abs(track.values[i] - track.values[i % width]) > 0.0001) return true;
      return false;
    }));
  }

  /** Status line: a held layer reuses the motion library's wording; `data-motion-held` names the held layers. */
  private reportMotionStatus(legacy: boolean): void {
    const held = this.heldLayers ?? [];
    if (this.renderer?.domElement?.dataset) this.renderer.domElement.dataset.motionHeld = JSON.stringify(held);
    this.options.onStatus?.(held.length ? UNFIT_MOTION : legacy ? "VMD 播放中 · 轻量模式" : "VMD 播放中 · 身体 / 手势 / 表情独立");
  }

  /**
   * R29d: the fit check changed (a motion was parsed on this model, the
   * controls-window scan moved on). Re-judge what is loaded now: a selected
   * layer, the automatic body motion, the face motion and the chat gesture.
   * Whatever plays and no longer suits the model is handed back smoothly
   * (never stopped in one frame); a held layer that suits again comes back.
   */
  private motionFitChanged(view: MotionFitView): void {
    if (this.renderer?.domElement?.dataset) this.renderer.domElement.dataset.motionFit = JSON.stringify(view.summary);
    this.options.onMotionFit?.(view);
    if (this.disposed) return;
    this.refitMotionLayers();
    const body = this.bodyMotion?.getState();
    if (body?.active && this.motionUnfit(body.sha256)) this.cancelBodyMotion();
    this.behaviorMotion?.recheck();
    if (this.chatGesturePlayer?.getState().active && this.motionUnfit(this.chatGestureResource?.sha256)) this.cancelChatGesture(true);
    if (this.herAction?.active && this.motionUnfit(this.herActionInfo?.sha256)) this.herAction.cancel(); // hands back over its yield time
  }
  private refitMotionLayers(): void {
    const selection = this.motionSelection, committed = this.committedLayers;
    if (!selection || !committed || selection.mesh !== this.mesh || selection.generation !== this.motionGeneration || !this.animation) return;
    const next = this.fittedLayers(selection);
    if (next.pose === committed.pose && next.gesture === committed.gesture && next.expression === committed.expression) return;
    this.cancelSurprisePreview();
    this.cancelChatGesture(true);
    this.qaStandCommit = null;
    this.commitMotionLayers(selection);
    this.updateBodyMotion();
    this.localPhysics?.frame(0);
    this.reportMotionStatus(selection.legacy);
  }
  /** Automatic body motion bytes through the Stage's loader; a motion the fit check hides on this model is refused (R29d). */
  private loadBodyMotionClip(resource: BodyMotionResource, mesh: SkinnedMesh): Promise<AnimationClip> {
    const loader = withKeyframeInterpolation(new MMDLoader()); let sourceFrames = -1;
    loader.parser = createVmdParser(report => { sourceFrames = report.durationFrames; }, this.motionRetarget?.transform);
    return new Promise<AnimationClip>((resolve, reject) => loader.loadAnimation(resource.url, mesh, value => {
      const clip = value as AnimationClip;
      if (this.motionUnfit(resource.sha256)) { reject(new Error(UNFIT_MOTION)); return; }
      // R19: the parser's frames/30 is the one duration on both sides, not MMDLoader's Float32 keyframe time.
      if (canonicalVmdClipDuration(clip, sourceFrames) !== resource.durationMs) { reject(new Error('Body source duration mismatch.')); return; }
      resolve(clip);
    }, undefined, reject));
  }

  private clearMotionSmooth(): void {
    this.cancelBodyMotion();
    this.motionSelection = null; this.committedLayers = { pose: null, gesture: null, expression: null }; this.heldLayers = [];
    if (this.renderer?.domElement?.dataset) this.renderer.domElement.dataset.motionHeld = '[]';
    if (!this.mesh || !this.animation || !this.hasRenderedModel) { this.stopMotion(); return; }
    this.localPhysics?.restore();
    this.restoreTorsoForMotionCapture();
    const previous = captureMotionPose(this.mesh);
    this.motionTransition?.restore();
    this.restorePersonalizeBody();
    this.behaviorMotion?.restore();
    this.herAction?.restore(); this.chatGesturePlayer?.restore();
    this.restoreLayers();
    const affected = this.animation.setClips({ pose: null, gesture: null, expression: null });
    this.motionClips.clear(); this.layerShas?.clear(); this.chatGestureBlocked = false; this.chatGestureBlockReason = null;
    this.musicManualHeadBlocked = false;
    this.syncMusicSuppression();
    this.moodFaceBlocked = this.moodMouthBlocked = this.moodHeadBlocked = false;
    if (affected.length) {
      // R29d: like a switch, the bridge covers grant and IK bones and is sized by the correction.
      this.motionTransition ??= new MotionTransition(this.mesh);
      this.motionTransition.start(previous, withDerivedBones(this.mesh, affected), switchDurationMs, this.poseRates());
      this.motionTransition.frame(0);
    }
    this.localPhysics?.frame(0);
  }

  private stopMotion(): void {
    this.cancelBodyPreview();
    this.cancelPersonalizeBody();
    this.bodyReady = false;
    this.bodyMotion?.dispose(); this.bodyMotion = null;
    this.localPhysics?.restore();
    this.motionTransition?.dispose(); this.motionTransition = null;
    this.behaviorMotion?.restore();
    this.cancelChatGesture(); this.chatGestureBlocked = false; this.chatGestureBlockReason = null;
    this.herAction?.cancel({ immediate: true }); // the base it sat on is going away
    this.restoreLayers();
    this.animation?.dispose();
    this.animation = null;
    this.motionClips.clear(); this.layerShas?.clear();
    this.motionSelection = this.committedLayers = null; this.heldLayers = [];
    this.musicManualHeadBlocked = false;
    this.syncMusicSuppression();
    this.moodFaceBlocked = this.moodMouthBlocked = this.moodHeadBlocked = false;
    for (const state of this.restPose) {
      state.bone.quaternion.copy(state.quaternion);
      state.bone.position.copy(state.position);
    }
    if (this.mesh?.morphTargetInfluences)
      this.mesh.morphTargetInfluences.fill(0);
    this.localPhysics?.frame(0);
  }

  /**
   * Pretrial 2026-11-03: while a natural blink runs (and on the frame it ends), the lid shapes that give way to it move at its
   * speed; the display guard follows them instead of catching them (stage-continuity.ts blinkRiderMorphs). Cached per rig.
   */
  private blinkRiders(): readonly number[] | null {
    const blinking = (this.naturalBlink ?? 0) > 0 || (this.lastNaturalBlink ?? 0) > 0;
    this.lastNaturalBlink = this.naturalBlink ?? 0;
    if (!blinking || !this.mesh) return null;
    if (this.blinkRiderCache?.mesh !== this.mesh || this.blinkRiderCache.rig !== this.lifeRig)
      this.blinkRiderCache = { mesh: this.mesh, rig: this.lifeRig, morphs: blinkRiderMorphs(this.mesh, this.lifeRig?.slots as unknown as Record<string, number> | undefined, BEHAVIOR_EYE_SHAPES) };
    return this.blinkRiderCache.morphs;
  }
  private lastNaturalBlink = 0;
  private blinkRiderCache: { mesh: SkinnedMesh; rig: LifeRig<Bone> | null; morphs: number[] } | null = null;

  /** 动作跳变记录: the physics-owned output bones of the parts that are on and running (cached per mesh), or null. */
  private physicsOutputBones(): readonly number[] | null {
    const mesh = this.mesh, physics = this.localPhysics;
    if (!mesh || !physics || physics.getState().running !== true) { this.motionGlitches?.forgetPhysics(); return null; }
    if (this.physicsBoneCache?.mesh !== mesh) {
      let plan: ReturnType<typeof buildPhysicsRigPlan> | null = null;
      try { plan = buildPhysicsRigPlan(mesh); } catch { plan = null; }
      this.physicsBoneCache = { mesh, hair: plan?.hair.outputBoneIndices ?? [], chest: plan?.chest.outputBoneIndices ?? [], both: [], key: '' };
    }
    const cache = this.physicsBoneCache, settings = this.physicsSettings, key = `${settings?.hair.enabled === true}|${settings?.chest.enabled === true}`;
    if (cache.key !== key) { cache.key = key; cache.both = [...(settings?.hair.enabled ? cache.hair : []), ...(settings?.chest.enabled ? cache.chest : [])]; }
    return cache.both;
  }
  private physicsBoneCache: { mesh: SkinnedMesh; hair: readonly number[]; chest: readonly number[]; both: number[]; key: string } | null = null;
  private motionGlitches?: MotionGlitchWatch;
  /** 色块哨兵 (stray-pixels.ts): her picture far outside her bones' reach is checked, re-sent to the GPU and reported. */
  private strayPixels?: StrayPixelWatch;
  private strayBones: { mesh: SkinnedMesh; bones: Bone[] } | null = null;
  private readonly strayNdc = { value: new Float32Array(0) };
  private colorBlocks?: ColorBlockRecorder;
  /** What she is doing this frame, for a glitch line (closed names; idle when none). */
  private motionActivities(): MotionActivity[] {
    const out: MotionActivity[] = [], contact = this.moodContact;
    if (this.chatGesturePlayer?.getState().active) out.push('chat-gesture');
    if (this.herAction?.active) out.push('her-action');
    if (this.speaking) out.push('speaking');
    if (contact?.contact || (contact?.hover ?? 0) > 0) out.push('pat');
    if (contact?.feeding) out.push('feed');
    if (this.musicEnabled) out.push('music');
    if (this.moodView?.herLife?.activity && this.moodView.herLife.activity !== 'company') out.push('her-life');
    if (this.expressionShow || this.surprisePreview || this.visualPreview || this.bodyPreview) out.push('expression-preview');
    if (this.rps?.active) out.push('rps');
    if (this.poseReaction?.reacting) out.push('pose');
    if (this.bodyMotion?.getState().active) out.push('body-motion');
    if (this.motionTransition?.getState().active) out.push('transition');
    return out.length ? out : ['idle'];
  }

  /** R29f: the shown pose's own speed per track at the last rendered frame, for a hand-off bridge (stage-continuity.ts rates). */
  private poseRates(): PoseRates { return this.hasRenderedModel ? (this.continuity?.rates(this.mesh) ?? (() => null)) : () => null; }

  private readonly tick = (time: number): void => this.frameTick(time);
  /** One display frame. Reply/speech state never decides it (R24); see frame-clock. */
  private frameTick(time: number): void {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.tick);
    const frame = acceptStageFrame(this.previousFrame, time, this.settings?.pet.fps, { hostVisible: this.hostVisible,
      documentHidden: document.hidden, width: this.container.clientWidth, height: this.container.clientHeight }, this.frameDue);
    (this.frameHeartbeat ??= new FrameHeartbeat()).record(frame, time);
    this.previousFrame = frame.previous; this.frameDue = frame.due; // R29f: the cap's own schedule (frame-clock.ts)
    if (this.renderer?.domElement) this.renderer.domElement.dataset.frameClock = JSON.stringify({ ...this.frameHeartbeat.getState(),
      speaking: this.speaking, waitingForReply: this.bodyWaitingForReply, inputBlocked: this.bodyInputBlocked });
    if (!frame.render && frame.reason === 'throttled') return;
    if (!frame.render) {
      this.cancelVisualPreview();
      this.cancelBodyPreview();
      this.cancelPersonalizeBody();
      this.cancelBodyMotion(true);
      this.localPhysics?.setVisible(false);
      this.stopTears(true);
      this.motionTransition?.restore();
      this.continuity?.reset('not-rendering');
      this.replyThinking?.hide();
      this.capabilityPreviews?.clear(); // I-024: a 试一下 nobody saw is not played later
      this.behaviorMotion?.stop();
      this.cancelChatGesture();
      this.previousFrame = 0;
      this.hasRenderedModel = false;
      this.presence?.settle(); // Not on screen: a fade in progress simply arrives (C2).
      this.renderPhysicsDiagnostics();
      return;
    }
    // Animation stays bounded, while physics must see a real stall so its
    // anchor/velocity reset can run instead of treating it as an ordinary tick.
    const { delta, physicsDelta } = frame;
    this.elapsed += delta;
    this.localPhysics?.restore();
    this.motionTransition?.restore();
    this.restorePersonalizeBody();
    this.behaviorMotion?.restore();
    this.herAction?.restore(); this.chatGesturePlayer?.restore();
    this.restoreLayers();
    this.bodyMotion?.beforeUpdate(delta, Date.now(), this.bodyGates());
    this.animation?.helper.update(delta);
    (this.continuity ??= new StageContinuity()).base(this.mesh, this.mesh ? this.animation?.helper.objects.get(this.mesh)?.mixer : null, delta, this.height, this.blinkIndex, this.mouthIndex, this.modelProfile?.linkedMorphs);
    this.headFrameClaim=this.currentHeadClaim();this.deferredAutoHead=[];
    this.rps?.frame(delta, this.mesh, this.modelProfile?.profile?.collision);
    this.frameMusicChoice(delta);
    this.frameLife(delta, time);
    this.frameThinking(delta);
    this.animateIdle(delta);
    this.chatGesturePlayer?.frame(delta, { blocked: this.behaviorBlocked || this.typing || this.controls.interacting || this.chatGestureBlocked || !this.moodView?.expressions || this.moodView.snapshot.intensity.posture === 0 || this.moodContact.contact || this.moodContact.feeding || (this.moodContact.hover ?? 0) > 0 });
    this.frameHerAction(delta);
    this.updateTears(delta);
    this.animateMood(delta);
    this.animateMusic(delta);
    this.updateBehaviorMotion(true);
    this.behaviorMotion?.frame(delta);
    let headApplied=false;
    try {
      headApplied=this.frameBodyPreview();
      headApplied=this.framePersonalizeBody()||headApplied;
    } finally {
      this.settleHeadFrameClaim(headApplied);
      this.headFrameClaim=null;
    }
    this.rps?.applyPose(this.rpsPort ??= { remember: bone => this.rememberBone(bone) });
    this.poseReaction?.applyPose(this.poseReactionPort ??= { remember: bone => this.rememberBone(bone), rotate: (bone, x, y, z) => this.rotateBone(bone, x, y, z) });
    this.frameSurprisePreview(time);
    this.frameExpressionShow(time);
    this.motionTransition?.frame(delta);
    // T-215: every face writer has written; a face shape's conflict group is written once, over all of them.
    this.frameFaceExclusive(delta);
    // Display bridge, then physics on the final anchors; the bridge is withdrawn right after render.
    // The face shape's group is continuous by construction (face-exclusive.ts; tests/face-exclusive*.test.ts): followed, not judged.
    const riders = this.blinkRiders(), faceOwned = this.faceExclusive?.owned();
    this.continuity?.apply(delta, frame.rearmed ? Infinity : physicsDelta, this.moodView?.body?.mode === 'maintainer-qa', faceOwned ? [...riders ?? [], ...faceOwned] : riders);
    this.localPhysics?.setVisible(true);
    this.localPhysics?.frame(physicsDelta);
    if (this.options.onMotionGlitch) (this.motionGlitches ??= new MotionGlitchWatch(glitch => this.options.onMotionGlitch?.(glitch)))
      .physics(this.mesh, this.physicsOutputBones(), () => this.motionActivities(), this.settings?.pet.fps ?? null, physicsDelta * 1000);
    this.controls.update(delta);
    this.framePresence(delta);
    this.renderer.render(this.scene, this.camera);
    if (this.pixelProbe && !this.pixelProbe.idle) this.pixelProbe.afterRender(this.renderer.getContext() as WebGL2RenderingContext, this.renderer.domElement);
    this.continuity?.remove();
    // 色块哨兵: the control window's grid is drawn outside her reach on purpose, so not while it shows.
    if (this.mesh && this.strayBones?.mesh !== this.mesh) { this.strayBones = { mesh: this.mesh, bones: skinnedBones(this.mesh) }; this.strayPixels?.reset(); }
    // I-031 色块诊断日志 (color-block-log.ts, temporary; pet only): her last frames into fixed arrays, read when the sentinel finds a block.
    if (this.options.onColorBlock && this.mesh && typeof this.renderer.getContext === "function") (this.colorBlocks ??= new ColorBlockRecorder({
      send: report => this.options.onColorBlock?.(report),
      read: out => { out.headYaw = this.gaze.x; out.headPitch = this.gaze.y; out.eyeX = this.eyeGaze.x; out.eyeY = this.eyeGaze.y; out.pointerX = this.pointer.x; out.pointerY = this.pointer.y;
        out.pointerOver = (this.moodContact.hover ?? 0) > 0 || this.moodContact.contact === true; },
      slow: () => ({ activities: this.motionActivities(), physics: this.localPhysics?.getState().running === true }),
      scene: () => this.mesh ? { mesh: this.mesh, height: this.height, camera: this.camera, fps: this.settings?.pet.fps ?? null } : null,
    })).frame(time, physicsDelta * 1000, this.renderer.domElement, this.renderer.getContext());
    if (this.mesh && !this.grid?.visible && typeof this.renderer.getContext === "function") (this.strayPixels ??= new StrayPixelWatch({
      reach: (width, height) => this.strayReach(width, height),
      inspect: () => this.mesh ? inspectModel(this.mesh, this.height, this.strayBones?.bones) : { part: 'gpu', name: 'gpu' },
      recover: cause => { if (this.mesh) resendModel(this.mesh, cause); },
      report: report => this.strayReport(report),
      diagnostics: () => this.colorBlocks?.hooks,
    })).afterRender(this.renderer.getContext() as WebGL2RenderingContext, this.renderer.domElement);
    this.hasRenderedModel = this.mesh !== null;
    this.acknowledgeVisualFrame();
    this.acknowledgeBodyFrame();
    this.captureQaStandAfterRender();
    this.renderPhysicsDiagnostics();
    this.renderer.domElement.dataset.motionTransition = JSON.stringify({ ...(this.motionTransition?.getState() ?? { active: false, elapsedMs: 0, durationMs: 400, weight: 1 }), layerTimes: this.animation?.getLayerTimes() ?? { pose: null, gesture: null, expression: null } });
    const continuityState = this.continuity?.getState() ?? null;
    this.renderer.domElement.dataset.poseContinuity = JSON.stringify(continuityState);
    this.motionGlitches?.guard(this.mesh, continuityState, () => this.motionActivities(), this.settings?.pet.fps ?? null, physicsDelta * 1000);
    if (this.life) this.renderer.domElement.dataset.proceduralLife = this.life.diagnostics(time);
    this.renderMusicDiagnostics();
    this.renderer.domElement.dataset.behaviorMotion = JSON.stringify(this.behaviorMotion?.getState() ?? null);
    // G1: while the game layer shows (developer and pretrial reads); 'null' once it has gone.
    if (this.rps?.active || (this.renderer.domElement.dataset.rps ?? 'null') !== 'null') this.renderer.domElement.dataset.rps = this.rps?.active ? JSON.stringify(this.rps.getState()) : 'null';
    this.renderBodyDiagnostics();
    this.renderer.domElement.dataset.chatGesture = JSON.stringify({ ...this.chatGesturePlayer?.getState(), intent: this.chatGestureResource?.intent ?? null, packId: this.chatGestureResource?.packId ?? null, motionId: this.chatGestureResource?.motionId ?? null, sha256: this.chatGestureResource?.sha256 ?? null, blocked: this.chatGestureBlocked, blockedReason: this.chatGestureBlockReason, error: this.chatGestureError,
      baseTime: this.mesh && this.animation ? this.animation.helper.objects.get(this.mesh)?.mixer?.time ?? null : null,
      arms: this.moodView?.developerMode ? this.mesh?.skeleton.bones.filter(bone => isChatGestureTrack(`.bones[${bone.name}].quaternion`)).slice(0, 16).map(bone => [bone.name, bone.quaternion.toArray()]) ?? [] : [] });
    // 她的动作: what plays and the last answer (developer and pretrial reads); 'null' once both are gone.
    if (this.herAction?.active || this.herActionInfo) this.renderer.domElement.dataset.herAction = JSON.stringify({ ...this.herAction?.getState(), trackNames: undefined,
      tracks: this.herAction?.getState().trackNames.length ?? 0, last: this.herActionInfo });
    this.reportFaceAnchor(time);
  }

  /** Feeds procedural life this frame's owners (gates it already computes); its outputs are read by the writers below. */
  private frameLife(delta: number, time: number): void {
    const life = this.life; if (!life) return;
    const view = this.moodView, gates = this.bodyGates(), body = this.bodyMotion?.getState(), preview = this.surprisePreview, start = preview?.start ?? time;
    // E1 (expression-show.ts): a show on its own clock; typing never blocks it (only hidden, a window/camera move, a pat or a snack).
    const show = preview ? null : this.expressionShow;
    if (show) show.start ??= time;
    const herActivity = this.frameHerLife(delta, gates, !!(body?.active || body?.pending), !!(this.visualPreview || this.bodyPreview || preview || show));
    const activity = this.framePoseReaction(delta, this.rps ? this.rps.activity(herActivity) : herActivity); // G1: her game face over her own activity; P1 reactions on top
    life.frame(delta, { enabled: this.lifeEnabled !== false, owner: this.mesh, seedKey: view?.characterId ?? '', rig: this.lifeRig, mood: view?.snapshot, fatigue: view?.fatigue,
      pointerX: this.pointer.x, pointerY: this.pointer.y, breathStrength: clamp(this.settings?.pet.breath ?? 0.5, 0, 1), hasEyes: this.eyes.length > 0, blush: view?.parameters.blush,
      previewClip: preview?.view.clipId ?? (show ? SHOW_CLIP[show.recipe] : null), previewElapsedMs: show ? show.clock.at(time - (show.start ?? time)) : time - start, previewStrength: show?.strength,
      previewBlocked: !gates.visible || gates.cameraOrWindow || (show ? false : gates.inputBlocked) || gates.directContact,
      activity, beat: this.frameMusicNod(delta), gates: { expressive: view?.expressions === true, contact: gates.directContact, manualPose: gates.manualPose, manualGesture: gates.manualGesture,
        // Pretrial 2026-11-03: a picked motion that moves the head owns it; the reviewed Stand's small authored head motion is a
        // compatible background (as for body motions, bodyGates().manualHead), not a reason to drop every small head motion.
        manualHead: gates.manualHead, manualExpression: this.moodFaceBlocked, manualMouth: this.moodMouthBlocked, chatGesture: gates.chatGesture, music: gates.music,
        bodyMotion: !!(body?.active || body?.pending), headOwned: !!this.head && !!this.bodyMotion?.ownsProperty(`.bones[${this.head.name}].quaternion`),
        authoredFace: !!view?.behavior?.state || !!view?.behavior?.reaction || this.behaviorMotion?.getState().active === true,
        preview: !!(this.visualPreview || this.bodyPreview || preview || show), adjusting: gates.cameraOrWindow, speaking: this.speaking, gazeAllowed: this.fatigueFrame?.gazeAllowed !== false,
        fatigueFace: (this.fatigueFrame?.eyelids ?? 0) > 0.01 || this.drowsyExpression?.active === true } });
  }

  /** 她自己的生活 (her-life-stage.ts): her own activity gives way while the user is here and to every higher owner. */
  private frameHerLife(delta: number, gates: BodyStageGates, bodyMotion: boolean, preview: boolean) {
    const view = this.moodView, phase = view?.fatigue?.phase;
    const herLife = this.herLife ??= new HerLifeStage(herLifeStageLoader({ mesh: () => this.mesh, token: () => this.moodView?.token ?? null,
      transform: () => this.motionRetarget?.transform, unfit: sha => this.motionUnfit(sha) }));
    // A focused but idle chat box is not the user being here (it often stays focused); composing, a reply, a touch are.
    // 她的动作 holds her body (her held pose and the body reactions give way) but is not the user being here: a yawn or a glance
    // still may run, so 哈欠捂嘴's own yawn can play with the hand.
    const chatGesture = !!this.chatGesturePlayer?.getState().active || !!view?.gesture;
    const activity = herLife.frame(delta, { owner: this.mesh, view: view?.herLife, need: view?.herNeed, nowMs: Date.now(), screen: view?.herLife?.watch ? readScreenPlace() : null, // I-006 step 3: only while she follows the screen
      needVisibility: view?.herNeed ? herNeedVisibility(view.herNeed.mode, view.parameters?.weights, view.snapshot?.values) : 1, gates: { expressive: view?.expressions === true,
      engaged: this.typing || this.speaking || this.bodyWaitingForReply || this.replyThinking?.active === true || gates.directContact || gates.cameraOrWindow
        || gates.music || chatGesture || preview,
      bodyOwned: (this.poseBodyOwners = gates.manualPose || gates.manualGesture || gates.dynamicPose || gates.manualHead || bodyMotion || this.herAction?.active === true)
        || this.poseReaction?.holdsBody === true, // I-006: her held pose (a hand on her chin) gives way while a stretch or wave moves her shoulders
      asleep: view?.fatigue?.sleeping === true || phase === 'falling-asleep' || phase === 'asleep' || phase === 'micro-awake',
      posture: view?.snapshot.intensity.posture ?? 0 } });
    if (this.renderer?.domElement) this.renderer.domElement.dataset.herLife = herLife.diagnostics(performance.now());
    return activity;
  }

  /** P1 第二阶段 (pose-reaction-stage.ts): what she does about the local pose signals, giving way to the owners her own life gives way to. */
  private framePoseReaction(delta: number, base: LifeActivity | null): LifeActivity | null {
    const view = this.poseReactionView(); // the host's view, or the I-024 试一下 wave over it
    if (!view && !this.poseReaction?.active) return base;
    const reaction = this.poseReaction ??= new PoseReactionStage();
    const lifeGates = this.herLife?.gates ?? null; // its own stretch counts for her held pose only, never against itself
    const activity = reaction.frame(delta, { owner: this.mesh, view, nowMs: Date.now(), game: !!this.rps?.active,
      gates: lifeGates?.bodyOwned && !this.poseBodyOwners ? { ...lifeGates, bodyOwned: false } : lifeGates,
      proxy: this.modelProfile?.profile?.collision,
      // I-006 第 2 步: a breather's yawn is 哈欠捂嘴 only when the camera shows her whole body (the hand would cover her face in a half-body one).
      fullBody: framesWholeBody(this.framingCamera, { height: this.height, baseY: this.baseY }), cover: cue => { void this.playHerAction({ ...cue, action: 'cover-yawn' }); } }, base);
    if (this.renderer?.domElement) this.renderer.domElement.dataset.poseReaction = reaction.diagnostics(performance.now());
    return activity;
  }

  /** X1 (reply-thinking.ts): the waiting channel gives way to the owners procedural life yields to, by its own smooth release. */
  private frameThinking(delta: number): void {
    const thinking = this.replyThinking; if (!thinking) return;
    const view = this.moodView, contact = this.moodContact, s = view?.snapshot;
    const shown = view?.expressions === true && s?.phase === 'idle' && !this.speaking && !this.behaviorBlocked && !this.bodyCameraEditing && !this.controls.interacting
      && !this.visualPreview && !this.bodyPreview && !this.surprisePreview && !this.expressionShow && !contact.contact && !contact.feeding && contact.pinch?.pinching !== true
      && !((contact.hover ?? 0) > 0) && this.fatigueFrame?.gazeAllowed !== false && view.fatigue?.sleeping !== true;
    const headOwned = this.moodHeadBlocked || this.musicEnabled || this.musicDance?.getState().releasing === true || this.drowsyExpression?.active === true
      || (!!this.head && this.bodyMotion?.ownsProperty(`.bones[${this.head.name}].quaternion`) === true);
    thinking.frame(delta, { owner: this.mesh, character: view ? { seedKey: view.characterId, weights: view.parameters?.weights, intensity: s?.intensity, companion: s?.companion } : null,
      gates: { head: shown && !headOwned, gaze: shown && !this.moodFaceBlocked, face: shown && !this.moodFaceBlocked && !((this.fatigueFrame?.eyelids ?? 0) > 0.01) } });
    const canvas = this.renderer?.domElement;
    if (canvas && (thinking.active || canvas.dataset.replyThinking !== 'null')) canvas.dataset.replyThinking = thinking.active ? JSON.stringify(thinking.getState()) : 'null';
  }

  private reportFaceAnchor(time: number): void {
    if (!this.options.transparent || !this.options.onFaceAnchor || time - this.lastFaceAnchor < 100) return;
    this.lastFaceAnchor = time;
    if (!this.mesh) { this.options.onFaceAnchor({ x: 0, y: 0, visible: false }); return; }
    if (this.head) {
      // MMD has no standard mouth bone; use a small lower-head offset near the lips.
      this.facePoint.set(0, -this.height * 0.01, this.height * 0.05);
      this.head.localToWorld(this.facePoint);
    } else this.facePoint.set(this.centerX, this.baseY + this.height * 0.82, 0);
    const distance = this.camera.position.distanceTo(this.facePoint);
    const radius = clamp(this.height * 0.09 * this.container.clientHeight / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2) * Math.max(0.1, distance)), 20, this.container.clientWidth * 0.48);
    this.facePoint.project(this.camera);
    const visible = Number.isFinite(this.facePoint.x) && Number.isFinite(this.facePoint.y) && this.facePoint.z >= -1 && this.facePoint.z <= 1 && Math.abs(this.facePoint.x) <= 1 && Math.abs(this.facePoint.y) <= 1;
    // G1: while her hand is up for the game, where it is on screen, so the buttons sit clear of the arm (RpsOverlay.place).
    const arm = visible ? this.rps?.raisedArm() : null;
    const screen = (point: Vector3) => { point.project(this.camera); return [(point.x + 1) * this.container.clientWidth / 2, (1 - point.y) * this.container.clientHeight / 2]; };
    const [handX, handY] = arm ? screen(arm.wrist) : [NaN, NaN], [elbowX, elbowY] = arm ? screen(arm.elbow) : [NaN, NaN];
    this.options.onFaceAnchor({
      x: visible ? (this.facePoint.x + 1) * this.container.clientWidth / 2 : 0,
      y: visible ? (1 - this.facePoint.y) * this.container.clientHeight / 2 : 0,
      visible,
      radius,
      ...([handX, handY, elbowX, elbowY].every(Number.isFinite) ? { raisedHand: { x: handX, y: handY, elbowX, elbowY } } : {}),
    });
  }

  private animateIdle(delta: number): void {
    if (!this.mesh) return;
    this.fatiguePresentation ??= new FatiguePresentation();
    this.fatigueFrame = this.fatiguePresentation.frame(this.moodView?.fatigue, delta, {
      verifiedGene: this.tearsVerifiedGene === true, eyelids: this.fatigueEyelidsAllowed(), expressions: this.moodView?.expressions === true,
      faceBlocked: this.moodFaceBlocked, contact: this.moodContact?.contact === true || this.moodContact?.pinch?.pinching === true,
    });
    const fatigue = this.fatigueFrame;
    // I-024: this frame's 试一下 amounts and the sleep-pose layer (its own layer; lighter, slower breath while asleep).
    const preview = this.capabilityPreview = (this.capabilityPreviews ??= new CapabilityPreviews()).frame(this.elapsed ?? 0, this.mesh);
    const sleep = this.frameSleepPose(delta, preview.sleep);
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0;
    this.breathLag = (this.breathLag ?? 0) + dt * (1 - sleep.breathRate);
    const strength = clamp(this.settings?.pet.breath ?? 0.5, 0, 1);
    const legacyBreath = Math.sin((this.elapsed - (this.breathLag ?? 0)) * Math.PI * 0.48), life = this.life?.active ? this.life : null;
    const breath = (life ? life.mixBreath(legacyBreath) : legacyBreath) * strength * sleep.breathScale;
    const committed = this.animation?.getLayerTimes?.();
    const idleArms = committed ? committed.pose === null && committed.gesture === null
      : !this.animation || (!this.settings?.motion && !this.settings?.motionLayers?.gesture);
    if (idleArms)
      for (const arm of this.arms)
        if (!this.bodyMotion?.ownsProperty(`.bones[${arm.bone.name}].quaternion`)) this.rotateBone(arm.bone, 0, 0, arm.roll);
    if (!this.chest || !this.bodyMotion?.ownsProperty(`.bones[${this.chest.name}].quaternion`)) this.rotateBone(this.chest, breath * 0.012, 0, 0);
    if (this.center) {
      this.rememberBone(this.center);
      this.center.position.y += breath * this.height * 0.0015;
    }
    life?.applyBody(this.lifePort);
    this.herLife?.applyPose(this.herLifePort ??= { blend: (bone, target, weight) => { this.rememberBone(bone); bone.quaternion.slerp(target, weight); } });
    this.replyThinking?.applyHead(this.lifePort);
    const follow = (this.settings?.pet.followMouse ?? true) && fatigue.gazeAllowed;
    // Compare the screen cursor with the projected eyes, not the window's center.
    this.gazeOrigin.set(0, 0, 0);
    if (this.eyes.length) {
      for (const eye of this.eyes) this.gazeOrigin.add(eye.getWorldPosition(this.eyePoint));
      this.gazeOrigin.divideScalar(this.eyes.length).project(this.camera);
    } else if (this.head) {
      this.head.getWorldPosition(this.gazeOrigin).project(this.camera);
    }
    const originX = Number.isFinite(this.gazeOrigin.x) ? this.gazeOrigin.x : 0;
    const originY = Number.isFinite(this.gazeOrigin.y) ? this.gazeOrigin.y : 0;
    // Procedural gaze only offsets this target (drift, saccades) or pulls it toward the user; the split, damping and fatigue stay here.
    // R29f: the 100 ms cursor readings as keyframes (pointer-keys.ts): a steady cursor gives the eyes and head a steady speed.
    const pointer = (this.pointerKeys ??= new PointerKeys()).frame(delta, this.pointer.x, this.pointer.y);
    const rawX = follow ? pointer.x - originX : 0, rawY = follow ? pointer.y - originY : 0, look = life?.out, think = this.replyThinking?.out;
    // X1: while she waits for a reply her thinking gaze takes over the pointer's pull (life's drift stays on top).
    const pull = (look ? (1 - look.gazeBlend) * look.pointerFollow : 1) * (think ? 1 - think.gazeBlend : 1);
    const target = gazeTargets(rawX * pull + (look?.gazeX ?? 0) + (think?.gazeX ?? 0), rawY * pull + (look?.gazeY ?? 0) + (think?.gazeY ?? 0), this.eyes.length > 0);
    // R29d: the head meets a new gaze target (an idle saccade, a look-away, a pointer jump) from rest and speeds up,
    // instead of starting at full speed; same lag behind a moving pointer as the old first-order rate 5.
    const gazeVelocity = (this.gazeVelocity ??= { x: 0, y: 0 });
    this.gaze.x = dampCritical(this.gaze.x, target.headX * fatigue.gazeStrength, 10 * fatigue.gazeResponse, delta, gazeVelocity, 'x');
    this.gaze.y = dampCritical(this.gaze.y, target.headY * fatigue.gazeStrength, 10 * fatigue.gazeResponse, delta, gazeVelocity, 'y');
    const gazeScale = 1 - (this.moodFeedback?.attentionWeight ?? 0);
    if (!this.head || !this.bodyMotion?.ownsProperty(`.bones[${this.head.name}].quaternion`))
      this.rotateAutomaticHead(-this.gaze.y * gazeScale, this.gaze.x * gazeScale, 0);
    this.applySleepPose(sleep);
    this.eyeGaze.x = damp(this.eyeGaze.x, target.eyeX * fatigue.gazeStrength, 12 * fatigue.gazeResponse, delta);
    this.eyeGaze.y = damp(this.eyeGaze.y, target.eyeY * fatigue.gazeStrength, 12 * fatigue.gazeResponse, delta);
    for (const eye of this.eyes) this.rotateBone(eye, -this.eyeGaze.y, this.eyeGaze.x, 0);
    // T-215: while an eyelid face shape (a wink) holds the lids, no natural blink starts; the next one comes a while after
    // it (a wink is a blink: one due meanwhile is not made up for by a second blink right after).
    const lidHold = this.faceExclusive?.lidHold() ?? 0;
    if (lidHold > 0) this.nextBlink = Math.max(this.nextBlink ?? 0, this.elapsed + lidHold + FACE_EXCLUSIVE_BLINK_GAP_S);
    if (this.elapsed >= this.nextBlink) {
      this.blinkStart = this.elapsed;
      this.nextBlink = this.elapsed + (life ? life.beginBlink() : 3.2 + Math.random() * 3.8);
    }
    this.naturalBlink = life ? life.blinkWeight(this.elapsed - this.blinkStart) : blinkWeight(this.elapsed - this.blinkStart);
    this.finalEyeClosure = this.naturalBlink;
    // The wake blink is the natural blink's turn: the next natural one waits.
    if (sleep.blink > 0) this.nextBlink = Math.max(this.nextBlink ?? 0, this.elapsed + 1);
    if (!this.moodView && !this.moodFaceBlocked) this.applyMorph(this.blinkIndex, Math.max(this.naturalBlink, this.previewClosure(), sleep.blink));
    const mouthTarget = Math.max(this.speaking
      ? 0.23 + Math.abs(Math.sin(this.elapsed * 12)) * 0.45
      : 0, preview.mouth);
    this.mouth = damp(this.mouth, mouthTarget, 16, delta);
    if (!this.moodView) { // with a mood view the mouth compositor (animateMood) writes it
      this.manualMouth = manualMouthRamp(this.manualMouth ?? 0, this.moodMouthBlocked === true, delta);
      this.applyMorph(this.mouthIndex, yieldToManualMouth(this.mouth, this.manualMouth));
    }
    if (this.renderer?.domElement) this.renderer.domElement.dataset.fatigue = JSON.stringify({ phase: this.moodView?.fatigue?.phase ?? 'inactive',
      ...fatigue, automaticSleepPose: this.sleepPoseState(), sleepPose: sleep.active ? { amount: sleep.amount, depth: sleep.depth, weight: sleep.weight, blink: sleep.blink } : null,
      capabilityPreview: this.capabilityPreviews?.active ? preview : null });
  }

  private strayReach(width: number, height: number) {
    const mesh = this.mesh;
    if (!mesh) return null;
    if (this.strayBones?.mesh !== mesh) return null; // the frame hook resets the watch on a new mesh before it reads anything
    return boneReach(mesh, this.strayBones.bones, this.camera, this.height, width, height, this.strayNdc);
  }

  private strayReport(report: StrayReport): void {
    this.options.onMotionGlitch?.({ kind: 'block', part: report.cause.part, name: report.cause.name, size: report.drawn, cleared: report.cleared,
      activities: this.motionActivities(), fps: this.settings?.pet.fps ?? null, frameMs: null });
  }

  private rememberBone(bone: Bone): void {
    if (!this.boneLayers.some((state) => state.bone === bone))
      this.boneLayers.push({
        bone,
        quaternion: bone.quaternion.clone(),
        position: bone.position.clone(),
      });
  }

  private animateMood(delta: number): void {
    if (!this.mesh || !this.moodView) return;
    if (this.proceduralBlush && !this.proceduralBlush.getState().supported) {
      this.proceduralTears?.dispose(); this.proceduralTears = null;
      this.blushSupport = this.proceduralBlush.getState().reason;
      this.proceduralBlush.dispose(); this.proceduralBlush = null;
      this.rebuildTears();
    }
    const s = this.moodView.snapshot;
    const contact = this.moodContact.pinch ? { ...this.moodContact, contact: false, hover: 0 } : this.moodContact;
    const frame = this.moodFeedback.frame(delta, contact, { mood: s.primary, companion: s.companion, phase: s.phase,
      expressive: this.moodView.expressions, face: s.intensity.expression, posture: s.intensity.posture,
      gaze: this.moodView.fatigue?.sleeping ? 0 : s.intensity.gaze, playful: s.companion === 'playful' ? s.intensity.playful : 0,
      context: s.context, trend: s.trend, fast: s.fast, event: s.event, blush: s.blush,
      fastThreshold: this.moodView.parameters.fastThreshold, trendResponse: this.moodView.parameters.evidence.trend,
      attention: s.cue?.kind === 'look' || s.cue?.kind === 'motion', gesture: this.moodView.idleGesture, feed: this.moodView.feedCue,
      responding: !!s.cue && s.cue.kind !== 'speech' }, this.moodFaceBlocked,
      !this.moodView.fatigue?.sleeping && !this.moodHeadBlocked && (!this.head || !this.bodyMotion?.ownsProperty(`.bones[${this.head.name}].quaternion`)), this.moodMouthBlocked);
    const size = this.moodView.parameters.blush.size;
    const preview = this.blushPreviewUntil > performance.now() && this.moodView.expressions && this.moodView.parameters.blush.enabled && !this.moodFaceBlocked;
    if (this.blushPreviewing && !preview) { this.blushPreviewing = false; this.rebuildBlush(); }
    const look = this.life?.active ? this.life.out : null; // R36 continuous expression (procedural-life.ts)
    const blushAmount = Math.max(size === 0 ? 0 : preview ? this.moodView.parameters.blush.intensity / 100 : Math.max(frame.blush, this.moodFaceBlocked ? 0 : look?.blush ?? 0),
      this.blushOff() ? 0 : this.capabilityPreview?.blush ?? 0); // I-024 试一下 能脸红
    this.proceduralBlush?.update(proceduralBlushDepth(blushAmount), size, this.camera); // painted blush: the light end lifted (shared/behaviors/blush knobs)
    if (this.options?.onBlushCue) { // 体验记录: a new blush cue reached the stage; could it be shown (told once per cue)
      const seen = this.blushSeen.observe(s.blush?.id, { path: this.proceduralBlush ? 'procedural' : this.shownBlushChannel() ? 'morph' : 'none', faceBlocked: this.moodFaceBlocked, off: this.blushOff(), size });
      if (seen) this.options.onBlushCue!(seen);
    }
    if (!this.head || !this.bodyMotion?.ownsProperty(`.bones[${this.head.name}].quaternion`))
      this.rotateAutomaticHead(frame.headX, frame.headY, frame.headZ);
    const cheek = this.animateCheekPinch(delta);
    // I-024: the 试一下 closure joins the fatigue request; the wake blink is a soft closure (it never suppresses the natural blink).
    const lids = (this.eyelidCompositor ??= new EyelidCompositor()).frame(delta, { contact: frame.eyelids, cheek: cheek?.eyelids ?? 0,
      fatigue: Math.max(this.fatigueFrame?.eyelids ?? 0, this.previewClosure()), naturalBlink: this.naturalBlink ?? 0,
      soft: Math.max(look?.lidSoft ?? 0, this.replyThinking?.out.lidSoft ?? 0, this.sleepFrame?.blink ?? 0), smileEyes: look?.smileEyes, jitome: look?.jitome },
      this.mesh, `${this.moodView.characterId}\u0000${this.moodView.token}`);
    this.finalEyeClosure = lids.closure;
    this.lidHeld = lids.held; // T-215: an eyelid face shape gives way to a held closure
    const residual = !!cheek && Object.values(cheek).some(value => typeof value === 'number' && value !== 0);
    const drowsy = this.drowsyFrame(delta, frame.smile, frame.sadness, this.finalEyeClosure, residual);
    this.rotateAutomaticHead(drowsy.headX, 0, 0);
    if (!this.moodFaceBlocked) {
      for (const eye of this.eyes) this.rotateBone(eye, frame.eyePitch, frame.eyeYaw, 0);
      this.applyMorph(this.smileIndex, Math.max(frame.smile, cheek?.smile ?? 0));
      const blushMorph = this.proceduralBlush ? null : this.shownBlushChannel();
      if (blushMorph) this.applyMorph(blushMorph.index, blushAmount);
      if (lids.held > 0.02) this.nextBlink = Math.max(this.nextBlink ?? 0, (this.elapsed ?? 0) + 1.2);
      this.applyMorph(this.blinkIndex, lids.blink);
      this.applyMorph(this.sadIndex, Math.max(frame.sadness, drowsy.brow));
      if (drowsy.eyeShape > 0 && (this.drowsyEyeIndex ?? -1) >= 0) this.applyMorph(this.drowsyEyeIndex, drowsy.eyeShape);
      if (look) this.life?.applyFace(this.lifePort, lids, frame.mouthOwner);
    }
    // B06: a snack at the mouth beats lip-sync; X-089: a selected mouth beats both (they step aside by an eased ramp).
    this.manualMouth = manualMouthRamp(this.manualMouth ?? 0, this.moodMouthBlocked === true, delta);
    this.applyMorph(this.mouthIndex, yieldToManualMouth(composeMouth(this.mouth, frame.mouth, frame.mouthOwner), this.manualMouth));
    this.renderer.domElement.dataset.moodFeedback = JSON.stringify({ phase: s.phase, primary: s.primary, companion: s.companion, head: [frame.headX, frame.headY, frame.headZ], hover: this.moodContact.hover ?? 0, contact: frame.contact, activeContact: this.moodContact.contact, eyelids: frame.eyelids, blink: this.blinkIndex >= 0 ? this.mesh.morphTargetInfluences?.[this.blinkIndex] ?? 0 : 0, smile: frame.smile, mouth: frame.mouth, blush: blushAmount, blushSize: size, blushPath: this.proceduralBlush ? 'procedural' : this.shownBlushChannel() ? 'morph' : 'none', blushChannel: this.shownBlushChannel()?.name ?? null, blushSource: this.cardBlush ? 'card' : null, blushSupport: this.blushSupport, blushMaterial: this.moodView.developerMode ? this.proceduralBlush?.getState() ?? null : null, eventPositive: frame.eventPositive, eventNegative: frame.eventNegative, faceBlocked: this.moodFaceBlocked, mouthBlocked: this.moodMouthBlocked, headBlocked: this.moodHeadBlocked });
    this.getInteractionRegion();
  }

  private drowsyFrame(delta: number, smile: number, sadness: number, closure: number, cheekResidual: boolean): DrowsyFrame {
    // I-024: 试一下 困的脸 holds the drowsy phase for a moment (then the face eases back out by itself).
    const preview = this.capabilityPreview?.drowsy === true;
    const view = this.moodView, phase = preview ? 'drowsy' : view?.fatigue?.phase, strength = preview ? 0.9 : view?.fatigue?.F;
    this.drowsyEyeIndex = -1;
    // This optional feature has no display-environment dependency when its
    // exact content/host scope is unsupported. Preserve the legacy presenter.
    // I-024: the reviewed Gene unless 困的脸 is off; another model only when its card has it on (through its profile slots).
    if (!this.drowsyFaceAllowed() || view?.expressions !== true
      || typeof view.characterId !== 'string' || !view.characterId || typeof view.token !== 'string' || !view.token
      || !Number.isFinite(delta) || typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1
      || !DROWSY_PHASES.includes(phase ?? '')
      || (phase !== 'drowsy' && !this.drowsyExpression?.active)) {
      this.drowsyExpression?.reset();
      return { headX: 0, brow: 0, eyeShape: 0, rawEye: 0, active: false };
    }
    const gene = this.tearsVerifiedGene === true;
    // Gene: its audited fixed structure (困る 68, じと目 95). Any other model: its own sad / jitome slots, never Gene's indices.
    const reviewed = gene ? resolveDrowsyTargets(this.mesh ?? undefined, this.head, true) : null;
    const targets = gene ? (reviewed ? { brow: reviewed.brow as number, eye: reviewed.eye as number } : null)
      : profileDrowsyTargets(this.mesh ?? undefined, this.head, { sad: this.sadIndex, jitome: this.modelProfile?.profile?.morphs?.jitome?.index ?? -1, blink: this.blinkIndex });
    if (!targets) {
      this.drowsyExpression?.reset();
      return { headX: 0, brow: 0, eyeShape: 0, rawEye: 0, active: false };
    }
    const contact = this.moodContact;
    const visible = !this.disposed && this.hostVisible && !(typeof document !== 'undefined' && document.hidden) && this.container.clientWidth > 0 && this.container.clientHeight > 0;
    const permission = !!targets && (gene ? this.blinkIndex === 88 && this.smileIndex === 89 && this.sadIndex === 68 : targets.brow === this.sadIndex || targets.brow < 0)
      && visible && !!view?.expressions && !this.drowsySuppressed;
    const influences = this.mesh?.morphTargetInfluences, smileShown = gene ? influences?.[89] ?? 0 : this.smileIndex >= 0 ? influences?.[this.smileIndex] ?? 0 : 0;
    // R29c: contact, a window/camera adjust or a pending settings apply make every channel fade out (never a one-frame cut).
    const direct = !!contact && (contact.contact || contact.feeding || contact.pinch?.pinching === true || (contact.hover ?? 0) > 0) || cheekResidual
      || this.behaviorBlocked || this.bodyCameraEditing || this.controls.interacting || !!this.drowsyPendingSettings;
    const authored = this.behaviorMotion?.getState();
    const authoredFace = !!view?.behavior?.state || !!view?.behavior?.reaction || authored?.active === true
      || authored?.state.pending === true || authored?.reaction.pending === true;
    const face = !this.moodFaceBlocked && !direct && !authoredFace && (view?.snapshot.intensity.expression ?? 0) > 0;
    const head = !this.moodHeadBlocked && !this.bodyManualPose && !this.bodyManualGesture && !this.bodyDynamicPose
      && !direct && !this.bodyMotion?.ownsProperty(`.bones[${this.head?.name}].quaternion`)
      && !this.chatGesturePlayer?.getState().active && !view?.gesture && !this.musicEnabled && !this.musicDance?.getState().releasing
      && (view?.snapshot.intensity.posture ?? 0) > 0;
    this.drowsyExpression ??= new DrowsyExpression();
    const frame = this.drowsyExpression.frame(delta, {
      scope: view ? JSON.stringify([view.characterId, view.token, this.modelGeneration ?? 0]) : null,
      verified: permission, phase: phase ?? null, F: strength ?? null,
      headAllowed: head, browAllowed: face && targets.brow >= 0 && sadness === 0 && (influences?.[targets.brow] ?? 0) === 0,
      eyeAllowed: face && targets.eye >= 0 && smile === 0 && smileShown === 0,
      finalClosure: closure,
    });
    this.drowsyEyeIndex = targets.eye;
    if (this.renderer?.domElement) this.renderer.domElement.dataset.drowsyExpression = JSON.stringify({
      supported: !!targets, active: frame.active, headX: frame.headX, brow: frame.brow, eyeShape: frame.eyeShape, finalClosure: closure,
      source: gene ? 'reviewed-gene' : 'model-card', preview,
      reason: !permission ? 'scope-or-display-owner' : direct ? 'contact-or-adjusting' : authoredFace ? 'authored-face-priority' : 'bounded-drowsy-profile',
    });
    return frame;
  }

  /** Event-time withdrawal: outer layers first, with NO extra helper update. */
  private withdrawDrowsyExpression(): void {
    if (!this.drowsyExpression?.active || !this.mesh) { this.drowsyExpression?.reset(); return; }
    this.localPhysics?.restore();
    this.motionTransition?.restore();
    this.restorePersonalizeBody();
    this.behaviorMotion?.restore();
    this.herAction?.restore(); this.chatGesturePlayer?.restore();
    this.restoreLayers();
    this.drowsyExpression.reset();
    this.drowsySuppressed = true;
    try {
      // Restored current base/manual pose is retained; all clocks keep phase.
      this.animateIdle(0); this.animateMood(0); this.animateMusic(0);
      this.behaviorMotion?.frame(0); this.motionTransition?.frame(0); this.localPhysics?.frame(0);
    } finally { this.drowsySuppressed = false; }
  }

  private animateCheekPinch(delta: number): CheekPinchMotionFrame | null {
    if (!this.mesh || !this.moodView) return null;
    this.cheekMotion ??= new CheekPinchMotion();
    const s = this.moodView.snapshot, pinch = this.moodContact.pinch;
    const frame = this.cheekMotion.frame(delta, pinch ?? { pinching: false, x: 0, y: 0, side: null }, {
      mood: s.primary, posture: s.intensity.posture, face: this.moodView.expressions ? s.intensity.expression : 0,
      playful: s.intensity.playful, sensitivity: this.moodView.parameters.sensitivity.O,
    });
    const body = this.center ?? this.chest;
    this.rotateBone(body, frame.bodyX, frame.bodyY, frame.bodyZ);
    this.moveBoneOnScreen(body, frame.bodyOffsetX, frame.bodyOffsetY);
    this.rotateAutomaticHead(frame.headX, frame.headY, frame.headZ);
    this.moveBoneOnScreen(this.head, frame.headOffsetX, frame.headOffsetY);
    this.renderer.domElement.dataset.cheekPinch = JSON.stringify({ ...frame, pinching: pinch?.pinching ?? false, side: pinch?.side ?? null, inputX: pinch?.x ?? 0, inputY: pinch?.y ?? 0 });
    return frame;
  }

  /** Screen-plane displacement converted through each bone's actual parent. */
  private moveBoneOnScreen(bone: Bone | undefined, x: number, y: number): void {
    if (!bone?.parent || (!x && !y)) return;
    this.camera.updateWorldMatrix(true, false); bone.parent.updateWorldMatrix(true, false);
    const displacement = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(x * this.height)
      .addScaledVector(new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1), y * this.height);
    const origin = bone.parent.getWorldPosition(new Vector3());
    const local = bone.parent.worldToLocal(origin.add(displacement));
    this.rememberBone(bone); bone.position.add(local);
  }

  private animateMusic(delta: number): void {
    if (!this.mesh || !this.musicDance) return;
    this.syncMusicSuppression(true);
    if (!this.musicEnabled && !this.musicDance.getState().releasing) return;
    // A yielding dance keeps running underneath and hands its share over (R29b); fully yielded, it writes nothing.
    const dance = this.musicDance.frame(delta, this.musicSettings?.strength ?? 0.7);
    this.musicPose = dance;
    if ((!this.musicEnabled && !this.musicDance.getState().releasing) || (this.musicSuppressed && !this.musicDance.getState().presence)) return;
    // A bounded, temporary body offset leaves the selected VMD and facial channel intact.
    if (this.center) {
      this.rememberBone(this.center);
      this.center.position.y += this.height * dance.bounce;
    }
    this.rotateBone(this.center, 0, 0, dance.sway);
    this.rotateBone(this.chest, 0, 0, dance.chestRoll + (this.center ? 0 : dance.sway));
    this.rotateAutomaticHead(dance.headPitch, 0, dance.headRoll);
  }

  private renderMusicDiagnostics(): void {
    this.musicFrameSerial = (this.musicFrameSerial ?? 0) + 1;
    let pointDip: { x: number; y: number } | null = null;
    if (this.head && this.camera && this.container && this.musicPoint) {
      this.musicPoint.set(0, this.height * 0.04, this.height * 0.03);
      this.head.localToWorld(this.musicPoint).project(this.camera);
      if (Number.isFinite(this.musicPoint.x) && Number.isFinite(this.musicPoint.y) && Math.abs(this.musicPoint.x) <= 1
        && Math.abs(this.musicPoint.y) <= 1 && this.musicPoint.z >= -1 && this.musicPoint.z <= 1)
        pointDip = { x: (this.musicPoint.x + 1) * this.container.clientWidth / 2, y: (1 - this.musicPoint.y) * this.container.clientHeight / 2 };
    }
    this.renderer.domElement.dataset.musicDance = JSON.stringify({ enabled: this.musicEnabled, frameSerial: this.musicFrameSerial,
      modelGeneration: this.modelGeneration, modelReady: !!this.mesh,
      strength: this.musicSettings?.strength ?? 0.7, blockedReason: this.musicBlockReason ?? null, signal: this.musicSignal ?? null,
      engine: this.musicDance?.getState() ?? null,
      ...(this.musicChoice ? { choice: this.musicChoice.getState(), nod: this.musicNod?.getState() ?? null, listen: this.musicListen?.getState() ?? null } : {}),
      pose: this.musicSuppressed ? { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 } : this.musicPose,
      headQuaternion: this.head?.quaternion.toArray() ?? null,
      chestQuaternion: this.chest?.quaternion.toArray() ?? null, centerPosition: this.center?.position.toArray() ?? null, pointDip });
  }

  private rotateBone(
    bone: Bone | undefined,
    x: number,
    y: number,
    z: number,
  ): void {
    if (!bone) return;
    this.rememberBone(bone);
    this.rotation.set(x, y, z, "YXZ");
    this.offset.setFromEuler(this.rotation);
    bone.quaternion.multiply(this.offset);
  }

  private applyMorph(index: number, weight: number): void {
    // Calibrated per model by its profile (identity for the reviewed Gene), clamped to [0, 1].
    writeProfiledMorph(this.mesh?.morphTargetInfluences, this.morphLayers, this.modelProfile, index, weight);
  }

  private restoreLayers(): void {
    for (const state of this.boneLayers) {
      state.bone.quaternion.copy(state.quaternion);
      state.bone.position.copy(state.position);
    }
    const influences = this.mesh?.morphTargetInfluences;
    if (influences)
      for (const state of this.morphLayers)
        influences[state.index] = state.value;
    this.boneLayers.length = 0;
    this.morphLayers.length = 0;
  }

  private clearModel(): void {
    this.cancelVisualPreview();
    this.cancelBodyPreview();
    this.cancelPersonalizeBody();
    this.withdrawDrowsyExpression();
    this.finalEyeClosure = 0;
    const ownedQa = this.qaStandGate;
    if (ownedQa) ownedQa.cancel();
    this.qaStandCommit = null;
    this.bodyReady = false; this.bodyTargetSupported = false;
    this.bodyMotion?.dispose(); this.bodyMotion = null;
    this.physicsGeneration = (this.physicsGeneration ?? 0) + 1;
    this.physicsPending = null;
    if (this.localPhysics) {
      this.localPhysics.dispose();
      // One bounded, path-free snapshot makes old-model cleanup observable
      // even after its controller and render resources have been released.
      this.lastPhysicsRelease = this.localPhysics.getState();
      this.localPhysics = null;
    }
    this.resetMusicPresentation();
    this.musicManualHeadBlocked = false;
    this.physicsSupport = null;
    this.physicsError = '';
    this.hasRenderedModel = false;
    this.motionTransition?.restore();
    this.continuity?.release();
    this.restorePersonalizeBody();
    this.behaviorMotion?.dispose(); this.behaviorMotion = null;
    this.cancelChatGesture(); this.chatGesturePlayer?.dispose(); this.chatGesturePlayer = null;
    this.herActionGeneration++; this.herAction?.dispose(); this.herAction = null; this.herActionClips?.clear();
    this.faceActionGeneration++; this.faceExclusive?.cut('model'); this.faceExclusive = null; this.faceActionClips?.clear(); this.faceSpeech = null;
    this.chatGestureClips.clear(); this.chatGestureResource = null; this.chatGestureError = '';
    this.chatGestureBlocked = false; this.chatGestureBlockReason = null;
    this.defaultPoseChecks?.clear();
    this.stopTears(true);
    this.tearsVerifiedGene = false; this.tearsAnchorsProbed = false; this.tearsAnchors = null;
    this.tearsReason = '泪水定位尚未就绪';
    this.proceduralBlush?.dispose(); this.proceduralBlush = null;
    this.blushPreviewUntil = 0; this.blushPreviewing = false;
    this.blushSupport = '红晕定位尚未就绪';
    this.lastFaceAnchor = -Infinity;
    if (this.options.transparent) this.options.onFaceAnchor?.({ x: 0, y: 0, visible: false });
    this.stopMotion();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.disposeMesh(this.mesh);
    }
    this.mesh = null;
    this.options.onFramingStateChange?.();
    this.restPose = [];
    this.head = this.chest = this.center = undefined;
    this.lifeRig = null;
    this.headContactProfile = null;
    this.cheekAnchors = null;
    this.eyes = [];
    this.gaze.x = this.gaze.y = this.eyeGaze.x = this.eyeGaze.y = 0;
    if (this.gazeVelocity) this.gazeVelocity.x = this.gazeVelocity.y = 0;
    this.arms = [];
    this.blinkIndex = this.mouthIndex = -1;
    this.smileIndex = this.sadIndex = -1;
    this.modelProfile = null; if (this.renderer?.domElement?.dataset) delete this.renderer.domElement.dataset.modelProfile;
    this.motionRetarget = null; if (this.renderer?.domElement?.dataset) delete this.renderer.domElement.dataset.motionFit; this.options.onMotionFit?.(null);
    this.blushChannel = null;
    this.cardBlush = null;
    // I-024: a card belongs to the model it was set for; the next model starts from its own derived card until the host sends one.
    this.modelCapabilities = null; this.derivedCapabilities = null;
    this.sleepPose?.reset(); this.sleepFrame = NEUTRAL_SLEEP_FRAME;
    this.capabilityPreviews?.clear(); this.capabilityPreview = NO_CAPABILITY_PREVIEW;
    this.moodContact = { ...EMPTY_CONTACT };
    this.moodFeedback.reset();
    this.cheekMotion?.reset();
    this.renderPhysicsDiagnostics();
  }

  private disposeMesh(mesh: SkinnedMesh): void {
    mesh.geometry.dispose();
    const textures = new Set<Texture>();
    for (const material of this.materials(mesh.material)) {
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
      const uniforms = (
        material as Material & { uniforms?: Record<string, { value: unknown }> }
      ).uniforms;
      if (uniforms)
        for (const uniform of Object.values(uniforms))
          if (uniform.value instanceof Texture) textures.add(uniform.value);
      material.dispose();
    }
    for (const texture of textures) {
      texture.dispose();
      const image = texture.image;
      if (image instanceof HTMLCanvasElement) image.width = image.height = 1;
      texture.image = null;
    }
    mesh.skeleton.dispose();
  }

  private materials(material: Material | Material[]): Material[] {
    return Array.isArray(material) ? material : [material];
  }
  private findBone(aliases: string[]): Bone | undefined {
    return this.mesh?.skeleton.bones.find((bone) =>
      aliases.includes(bone.name),
    );
  }
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
