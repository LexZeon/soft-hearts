// 身体动作 (part 12), shared half: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/actions/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part actions`).
// The json tables (motion-catalog.json, motion-track-gene-structure.json, retarget-gene-source.json) are imported directly as data.

// The universal skeleton: standard bones, fingers, morph slots, named face shapes.
export { CORE_BONES, FINGER_JOINTS, FINGER_SLOTS, FINGER_WORDS, fingerPartOfName, FINGERS, fingerSlotSide, inHeads, isNamedFaceShape, MORPH_ALIASES, MORPH_SLOTS, NAMED_FACE_SHAPE_IDS, NAMED_FACE_SHAPES, normalizeProfileName, REFERENCE_AMPLITUDE, STANDARD_BONE_ALIASES, STANDARD_BONES, STANDARD_PARENTS, STANDARD_PART_WORDS, standardBoneOfName, standardParents, standardPartOfTrack, STRUCTURE_BONES, structureDifferences } from '../foundation/universal-skeleton';
export type { Finger, FingerPart, FingerSlot, MorphSlot, NamedFaceShape, SlotPolicy, StandardBone, StructureDifference, Vec3 } from '../foundation/universal-skeleton';
// Her actions (the named actions she can play, what each needs from a model).
export { fingerSide, HER_ACTION_DETAILS, HER_ACTION_PART_NAMES, HER_ACTION_SPECS, HER_ACTIONS, herActionMissing, herActionSupport, isHerActionCue } from './her-actions';
export type { HerActionCue, HerActionId, HerActionMode, HerActionOutcome, HerActionPlayResult, HerActionResource, HerActionSpec, HerActionStatus, HerActionSupport, HerBodyMode, HerFaceMorph, HerFaceScope } from './her-actions';
// Behaviour motion (faces and their bindings), recipes, body motion, idle motion.
export { BEHAVIOR_SEMANTICS, expressionStrength, isBehaviorFaceBindingId, isBehaviorSemantic, MAX_BEHAVIOR_CUE_AGE_MS, MAX_BEHAVIOR_CUE_LIFETIME_MS, MAX_BEHAVIOR_FACE_STRENGTH, selectBehaviorState } from './behavior-motion';
export type { BehaviorFaceBindingId, BehaviorMotionCue, BehaviorMotionPlan, BehaviorMotionResource, BehaviorSemantic } from './behavior-motion';
export { BEHAVIOR_RECIPES } from './behavior-recipes';
export { BODY_IDLE_REPORT_INTERVAL_MS, BODY_MOTION_REASONS, BODY_START_AGE_MS, bodyIdentity, isBodyMotionCue } from './body-motion';
export type { BodyMotionCue, BodyMotionPlan, BodyMotionResource, BodyStageObservation } from './body-motion';
export type { IdleMotionCandidate } from './idle-motion';
// Expressions: composing, editing and checking them.
export { editExpressionRecipe, EXPRESSION_GENE_SHA, EXPRESSION_MASK, EXPRESSION_MORPHS, expressionRecord, expressionResearchPrompt, generateExpressionRecipe, isExpressionPreview, parseExpressionStudy, validateExpressionRecipe, validateExpressionResource } from './expression-composition';
export type { AuthoringPreview, ExpressionDraftView, ExpressionEditRequest, ExpressionPatch, ExpressionPreview, ExpressionRecipe, ExpressionResearchRequest, ExpressionResource, ExpressionStudy } from './expression-composition';
// Gestures while chatting; requests in chat to breathe or dance.
export { isChatGestureIntent, selectChatGesture } from './chat-gesture';
export type { ChatGestureAppraisal, ChatGestureCue, ChatGestureIntent, ChatGestureResource } from './chat-gesture';
export { scanBreathRequest } from './breath-request';
export { scanDanceRequest } from './dance-request';
// The motion library: catalog types, layers, weights, track coverage, tag preferences, fits and retargeting, contact, durations.
export type { MotionCatalog, MotionDownloadFile, MotionDownloadProgress, MotionLibraryStatus, MotionPack, MotionPackId } from './motion-library';
export { getMotionLayerAssets, isMotionLayer, motionAssetBaseline, withMotionLayer } from './motion-layers';
export type { MotionLayer } from './motion-layers';
export { withRestStand } from './rest-stand';
export type { RestStandLayers } from './rest-stand';
export type { MotionWeightQuery, MotionWeightResults, MotionWeightSave, MotionWeightView } from './motion-weights';
export type { MotionTrackCoverageRequest, MotionTrackCoverageView } from './motion-track-coverage';
export type { MotionTagPreferenceRequest } from './r32/motion-tag-contracts';
export { acceptMotionFitRecord, MOTION_FIT_RECORD_VERSION, MOTION_SCORE_STAMP } from './motion-fit-record';
export type { MotionFitRecord } from './motion-fit-record';
export { adaptMotion } from './motion-fit';
export type { MotionFit, MotionFitStatus } from './motion-fit';
export { buildRetargetRig, LINEAR_INTERPOLATION, morphSlotRoute, planRetarget, RETARGET_ALGORITHM_VERSION, RETARGET_VERSION, retargetVmd, STANDARD_SOURCE_RIG } from './motion-retarget';
export type { RetargetPlan, RetargetRig, RigBone, VmdLike } from './motion-retarget';
export { contactFor } from './motion-contact';
export { canonicalVmdClipDuration, vmdDurationSeconds } from './vmd-duration';
// The collision proxy (her body's rough shape for contact).
export { acceptCollisionProxy, fitCollisionProxy, summarizeCollisionProxy } from '../foundation/collision-proxy';
export type { CollisionProxy, CollisionProxySummary, ProxySegment } from '../foundation/collision-proxy';
// Reading PMX text encodings (the asset protocol prepares models for the parser).
export { describePmxPreparation, PMX_HEADER_SNIFF_BYTES, pmxMayNeedPreparation, preparePmxForMmdParser, readPmxHeader } from '../foundation/pmx-text-encoding';
