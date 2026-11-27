// 舞台：桌宠画面 (part 2), window side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8). Files inside src/stage/ import each other directly.
// What is here is what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part stage`), less these:
// - PetUI: it imports the brain, voice and senses pages, and files behind those pages import this one; through here it would close runtime import
//   cycles. Only src/main.ts (the wiring) uses it, directly from ./PetUI. (MmdStage, the old stage, was deleted in I-176 step 3.)
// - What only the Unbound window uses (eye-head, keyframe interpolation, model loading and physics, motion layers and transitions, the vmd
//   parser, the procedural blush, StageModelProfile, legacyMorphIndices, relaxedArmRoll): src/unbound/ imports them directly, so the
//   Unbound bundle does not take this page and what it re-exports.
// - vmd.ts and vmd-tracks.ts, which the host's motion track coverage (electron/) reads: imported directly, so the host bundle does not
//   take the window side.
// The stylesheets are imported directly by src/main.ts and src/settings/layout.ts.

// The companion window: popups, pointer pass-through, framing, the recovery signal and the presentation probe.
export { laterPopup } from './pet-popups';
export { installPetPointerPassthrough, PointerPassthrough, type PassthroughState, type PointTarget } from './pointer-passthrough';
export { PetFramingController } from './PetFraming';
export { ImmersiveNotice } from './ImmersiveNotice';
export { latchSignal } from './latched-signal';
export { checkPetPresentation } from './pet-presentation-probe';
export { PetWindowDiagnosticsPanel } from './PetWindowDiagnosticsPanel';
// Model capabilities, personalising body and look, the expression preview, the single-emoji controls, procedural life.
export { ModelCapabilityPanel } from './ModelCapabilityPanel';
export { bindCapabilityPreview, ModelCapabilitySync } from './model-capability-sync';
export { PersonalizeBodyControls } from './PersonalizeBodyControls';
export { PersonalizeVisualControls } from './PersonalizeVisualControls';
export { bindPreviewCardButtons, ExpressionPreviewButtons } from './ExpressionPreviewButtons';
export { SingleEmojiControls } from './SingleEmojiControls';
export { ProceduralLifeToggle } from './procedural-life-toggle';
export { onStageModelProfile } from './model-profile';
export { applyBehaviorGates } from './behavior-gates';
// Small stage helpers other parts' stage layers use: easing, noise, pointer keys, rotation paths, the pillow, blush anchors, life states.
export { clamp, damp, dampCritical, gazeTargets } from './procedural';
export { hashSeed, SeededRandom } from './life-noise';
export { PointerKeys } from './pointer-keys';
export { RotationPath } from './rotation-path';
export { pillowGeometry } from './sleep-props';
export type { BlushAnchors, BlushPoint } from './procedural-blush';
export type { LifeActivity } from './procedural-life';
export type { HerLifeStageGates } from './her-life-stage';
export type { StageOptions } from './stage-options';
// I-154 (docs/claude/2026-11-19-unbound-in-window.md): what Unbound's engine in the companion window (src/unbound/window-mode/) uses of the
// companion's stage: the stage surface both engines answer for, the camera and its framing, the click-through probe, the head contact, the
// lights and the model profile. The Unbound window itself still imports its few stage files directly (it does not take this page).
export { STAGE_SURFACE_MEMBERS } from './stage-surface';
export type { StageSurface, StageSurfaceMember } from './stage-surface';
export { CameraController, cameraBasis, normalizeCamera } from './CameraController';
export { requestCameraEdit } from './camera-edit-entry';
export { framingCamera, framingTopBand, isUnframedCamera } from './stage-framing';
export { StagePixelProbe, type StageAlpha } from './pixel-probe';
export { CONTEXT_RECOVERY, StageContextRecovery, type ContextRecoveryPorts, type ContextRecoveryTarget } from './context-recovery';
export { probeHeadContact, projectHeadContact } from './head-contact';
export { addStageLights } from './model-loading';
import { createModelLoadingManager } from './model-loading';
export { StageModelProfile, cheekAnchorsFrom, requestModelProfileCache } from './model-profile';
// 2026-11-27 (docs/claude/2026-11-27-model-checkup-not-saved.md): the check-up's one save after a model loads (the window engine's load step).
export { saveBuiltProfile, type ProfileSaveOutcome, type ProfileSavePort } from './model-profile-save';
// I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): a VRM for Unbound's engine, as it is (its arms not lowered: the engine's
// standard body does that), in its own chunk like the old stage's (the glTF loader and MToon load only for a VRM).
export type { LoadedModel, MorphBind } from './model-adapter/types';
export async function loadVrmForEngine(url: string): Promise<import('./model-adapter/types').LoadedModel> {
  const { loadVrmModel } = await import('./model-adapter/vrm');
  return loadVrmModel(url, { manager: createModelLoadingManager(), relaxArms: false });
}
// I-154 batch 1: the window engine's frame pace (P1 舞台少画, the old stage's own clock and tracker) and the hair and chest physics with its
// lazily loaded Ammo (only when a part is switched on).
export { acceptStageFrame, FrameHeartbeat } from './frame-clock';
export { AWAY_FPS, PACE_BODY_SPEED, PACE_PHYSICS_SPEED, StagePaceTracker, readStageFlags, stageDiagnosticsForced, type PaceReason } from './stage-pace';
export { PaceMotionProbe } from './pace-motion-probe';
export { buildPhysicsRigPlan, LocalModelPhysics, probeModelPhysicsSupport } from './model-physics';
// I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): a VRM's own spring bones (hair, coat, skirt), run after the pose transfer.
export { VrmSpringPhysics } from './vrm-spring/vrm-springs';
export type { AmmoModule } from './ammo-runtime';
// I-154 batch 2: her face on the window engine: the blush (painted on her face, or the model's own morph) and how a flush comes and goes,
// the tired lids and the drowsy face (the same layers and gates as the companion's own stage).
export { BlushFollow } from './blush-follow';
export { BlushSeen } from './blush-seen';
export type { BlushStageState } from './blush-seen';
export { selectBlushChannel } from './blush-channel';
export { ProceduralBlush, probeBlushAnchors } from './procedural-blush';
export { eyeMaterialPriority } from './blush-eye-names'; // I-164: a VRM's eye surface is named the same way (src/unbound/her/vrm-blush.ts)
export { EYE_HEAD_DEFAULTS } from './eye-head'; // I-164: the eye-head coordinator's soft limits, for a VRM's eye room (src/unbound/model/vrm-eye-room.ts)
export { FatiguePresentation, NEUTRAL_FATIGUE_FRAME } from './fatigue-presentation';
export type { FatigueFrame } from './fatigue-presentation';
export { DROWSY_PHASES, DrowsyExpression, drowsyFaceGapNote, profileDrowsyTargets, resolveDrowsyTargets } from './drowsy-expression';
export async function loadAmmoForEngine(): Promise<import('./ammo-runtime').AmmoModule> { return (await import('./ammo-runtime')).loadAmmo(); }
// I-154 batch 3: daily touch and liveliness on the window engine: the brow rule and the sleep pose (no other part behind them), and,
// loaded on demand, procedural life and the sleep body. Those two import the mood and initiative pages, whose files import this page:
// a static export here would close a runtime import cycle (continuous-expression.ts reads a mood constant while it loads).
export { composeBrows, composeMouth } from './channel-compositors';
export { NEUTRAL_SLEEP_FRAME, SleepPose } from './sleep-pose';
export type { SleepPoseFrame } from './sleep-pose';
export type { LifeRig, ProceduralLife } from './procedural-life';
export type { SleepBody, SleepMurmur } from './sleep-body';
// I-154 batch 5: her own motions on the window engine: the chat gesture, her actions' face shapes, automatic body motions and behaviour
// faces (the same players and controller as the companion's own stage), their hand-off bridge, the clip loader's interpolation, and the
// 惊喜 / 害羞 show's clock and support rules. None of these imports another part's page.
export { ChatGesturePlayer, isChatGestureTrack } from './chat-gesture';
export { MotionTransition, handoffDurationMs, type MotionPoseSnapshot, type PoseRates } from './motion-transition';
export { ShownRates } from './shown-rates';
export { BehaviorBodyPlayer } from './behavior-body';
export { BodyMotionController, type BodyStageGates } from './body-motion-controller';
export { BehaviorMotionPlayer } from './behavior-motion';
export { bodyMotionTarget, universalTarget } from './universal-target';
export { withKeyframeInterpolation } from './keyframe-interpolation';
export { isDefaultPoseCandidateName, isReviewedDefaultPose } from './default-pose';
export { askRestStand, layersWithRestStand, settingsLayersWithRestStand, type RestStandPort } from './rest-stand';
export { FACE_EXCLUSIVE_START_WAIT_S, FaceExclusive, faceTracksByName, faceWriteTracks, resolveFaceMorphs } from './face-exclusive';
export { SHOW_CLIP, SHOW_MS, showSupport, type ShowCapabilities } from './expression-show';
export { ShowClock } from './show-clock';
export { clampStrength, showRequest } from './show-blend';
// I-154 batch 7: the developer's diagnostics (动作跳变记录, 色块哨兵), 试一下 (capability previews) and the personal pose preview on the
// window engine. None of these imports another part's page.
export { MotionGlitchWatch, type MotionGlitchReport } from './motion-glitch';
export { StrayPixelWatch, boneReach, inspectModel, resendModel, skinnedBones, type StrayBox, type StrayReport } from './stray-pixels';
export { CapabilityPreviews, NO_CAPABILITY_PREVIEW, isModelCapabilityId, type CapabilityPreviewFrame } from './capability-preview';
export { personalizePose } from './universal-pose';
export type { PersonalizeStaticPose } from './personalize-static-pose';
export interface LivelinessLib {
  ProceduralLife: typeof import('./procedural-life').ProceduralLife;
  lifeRig: typeof import('./procedural-life').lifeRig;
  SleepBody: typeof import('./sleep-body').SleepBody;
  sleepBodyInput: typeof import('./sleep-body').sleepBodyInput;
  /** I-154 batch 6 (row 33 她自己的生活): the companion's own-life performer (it reads procedural life's look-up lift, hence on demand too). */
  HerLifeStage: typeof import('./her-life-stage').HerLifeStage;
  readScreenPlace: typeof import('./her-life-stage').readScreenPlace;
}
export async function loadLivelinessForEngine(): Promise<LivelinessLib> {
  const [life, sleep, herLife] = await Promise.all([import('./procedural-life'), import('./sleep-body'), import('./her-life-stage')]);
  return { ProceduralLife: life.ProceduralLife, lifeRig: life.lifeRig, SleepBody: sleep.SleepBody, sleepBodyInput: sleep.sleepBodyInput,
    HerLifeStage: herLife.HerLifeStage, readScreenPlace: herLife.readScreenPlace };
}
export type { HerLifeClipLoader, HerLifeMotionPort, HerLifeStage, HerLifeStageInput } from './her-life-stage';
/**
 * I-154 batch 6 (row 37): the companion's music performers for the window engine (what she hears, her choice, the dance and the nod, the
 * listening look, the song reactions), on demand: the song reactions read the voice page, whose files import this page.
 */
export interface MusicLib {
  MusicChoice: typeof import('./music-choice').MusicChoice;
  MusicDance: typeof import('./music-dance').MusicDance;
  MusicNod: typeof import('./music-nod').MusicNod;
  MusicListenCue: typeof import('./music-listen').MusicListenCue;
  MusicLikeness: typeof import('./music-likeness').MusicLikeness;
  likenessLine: typeof import('./music-likeness').likenessLine;
  MusicReactStage: typeof import('./music-react/stage').MusicReactStage;
  musicPresence: typeof import('./music-presence').musicPresence;
  MUSIC_AUDIBLE_RMS: number;
}
export async function loadMusicForEngine(): Promise<MusicLib> {
  const [choice, dance, nod, listen, likeness, react, presence] = await Promise.all([import('./music-choice'), import('./music-dance'), import('./music-nod'),
    import('./music-listen'), import('./music-likeness'), import('./music-react/stage'), import('./music-presence')]);
  return { MusicChoice: choice.MusicChoice, MusicDance: dance.MusicDance, MusicNod: nod.MusicNod, MusicListenCue: listen.MusicListenCue,
    MusicLikeness: likeness.MusicLikeness, likenessLine: likeness.likenessLine, MusicReactStage: react.MusicReactStage, musicPresence: presence.musicPresence,
    MUSIC_AUDIBLE_RMS: presence.MUSIC_AUDIBLE_RMS };
}
export type { MusicEnergySample, MusicDancePose } from './music-dance';
export type { MusicNodOffsets } from './music-nod';
export type { MusicPresence } from './music-presence';
export type { MusicChoiceContext } from './music-choice';
export type { MusicVerdictFlip } from './music-likeness';
export type { SongMemoryPort } from './music-react/stage';
