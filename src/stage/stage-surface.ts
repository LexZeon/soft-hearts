/**
 * I-154 / I-176 (docs/claude/2026-11-19-unbound-in-window.md, docs/claude/2026-11-23-i176-delete.md): what the windows' wiring uses of a
 * stage, and nothing else. One engine stands behind it since I-176 step 3: Unbound's engine in window mode (src/unbound/window-mode/
 * window-stage.ts; the old stage src/stage/MmdStage.ts is deleted). The type used to be derived from that old class; it is written out here
 * now, member by member. Every member is a feature the wiring reaches; a wiring change that needs a new stage member adds its name AND its
 * signature here, and the window stage is made to answer for it (it `implements StageSurface`).
 */
import type { PointerPosition } from '../../shared/stage/desktop-api';
import type { AppSettings, CameraConfig } from '../../shared/foundation/settings';
import type { StickerCapture } from '../../shared/cards';
import type { AuthoringPreview } from '../../shared/actions';
import type { BodyPosePreview } from '../../shared/stage/personalize-body';
import type { BlushCalibration, MoodView } from '../../shared/mood';
import type { ExpressionRecipe, ExpressionSupport, ModelCapabilities, ModelCapabilityId, ModelPhysicsSettings } from '../../shared/stage';
import type { MusicSettings } from '../../shared/senses';
import type { HandsStageCommand, RpsView } from '../../shared/initiative';
import type { SpeechBeatRelease } from '../../shared/behaviors/speech-beats/interface';
import type { PullMoodReading } from '../../shared/behaviors/pull/attitude';
import type { CheekRegion, MoodContact, ReactionStageResult } from '../mood';
import type { SpeakingSource } from '../voice';
import type { GiveStageCue, GiveStageOutcome, HandReachCue, HandReachState } from '../initiative';
import type { HandInput } from '../senses';
import type { StagePullHit } from './pull/stage-pull';
import type { PullStance } from './pull/pull-layer';
import type { MusicEnergySample } from './music-dance';
import type { musicPresence } from './music-presence';
import type { StagePixelProbe } from './pixel-probe';

export const STAGE_SURFACE_MEMBERS = [
  // settings, model, camera, visibility and framing
  'applySettings', 'setVisible', 'dispose', 'setCameraEditMode', 'frame', 'getFramingView', 'getInteractionRegion', 'pixelProbe',
  'setUserAway',
  // where she looks, speaking, typing and the gates
  'setPointer', 'setUserGaze', 'setSpeaking', 'setSpeechPreparing', 'speechFaceCue', 'setReplyThinking', 'setTyping', 'setBehaviorBlocked',
  'setBodyInputBlocked', 'speechBeat', 'speechBeatsRelease',
  // mood: her face, touch (pat, pinch, feeding), blush and tears, degradation
  'setMood', 'setMoodContact', 'invalidateMoodScope', 'getMoodDegradation', 'setBlushCalibration', 'getBlushSupport', 'previewBlush',
  'clearBlushPreview', 'expressionSupport', 'playExpression', 'playReaction', 'setProceduralLife', 'setSleepHabit',
  // pulling her
  'pullHit', 'pullStart', 'pullTo', 'pullEnd', 'setPullStance', 'pullStillAllowed', 'pullMood',
  // her actions, gestures, rock-paper-scissors, give, hands
  'playHerAction', 'setRps', 'startGive', 'takeGive', 'withdrawGive', 'giveAnchor', 'captureGivePicture', 'handInput', 'startHands',
  'handsCommand', 'handsState', 'handsAnchor', 'handsNear',
  // music
  'setMusicEnabled', 'setMusicSample', 'setMusicSettings', 'getMusicPresence', 'getMusicChoiceLine', 'setListenKindLine', 'rejudgeMusicNow',
  // physics, capabilities, previews and pictures
  'setPhysicsSettings', 'setModelCapabilities', 'previewCapability', 'previewVisual', 'cancelVisualPreview', 'previewBody',
  'cancelBodyPreview', 'cancelSurprisePreview', 'captureCharacterAvatar', 'captureCharacterStickerReference',
] as const;

export type StageSurfaceMember = (typeof STAGE_SURFACE_MEMBERS)[number];

/** The stage as the wiring sees it (both windows): Unbound's window engine, src/unbound/window-mode/window-stage.ts. */
export interface StageSurface {
  // settings, model, camera, visibility and framing
  applySettings(settings: AppSettings): Promise<void>;
  setVisible(visible: boolean): void;
  dispose(): void;
  setCameraEditMode(enabled: boolean): void;
  frame(preset: 'full' | 'portrait'): CameraConfig | null;
  getFramingView(): { modelGeneration: number; cameraRevision: number; modelUrl: string; ready: boolean; camera: CameraConfig };
  getInteractionRegion(): { x: number; y: number; radius: number; mouthX: number; mouthY: number; referenceWidth: number; mouthRadius: number; axisXX: number; axisXY: number; axisYX: number; axisYY: number; cheeks: CheekRegion[] } | null;
  readonly pixelProbe: StagePixelProbe;
  setUserAway(away: boolean): void;
  // where she looks, speaking, typing and the gates
  setPointer(pointer: PointerPosition): void;
  setUserGaze(value: unknown): void;
  setSpeaking(active: boolean, source?: SpeakingSource, shape?: number): void;
  setSpeechPreparing(active: boolean, source?: SpeakingSource): void;
  speechFaceCue(cue: unknown): void;
  setReplyThinking(key: string | null): void;
  setTyping(active: boolean): void;
  setBehaviorBlocked(blocked: boolean): void;
  setBodyInputBlocked(blocked: boolean): void;
  speechBeat(word: string, span?: boolean | 'line'): boolean;
  speechBeatsRelease(reason?: SpeechBeatRelease): void;
  // mood: her face, touch (pat, pinch, feeding), blush and tears, degradation
  setMood(view: MoodView): void;
  setMoodContact(contact: MoodContact): void;
  invalidateMoodScope(): void;
  getMoodDegradation(): string;
  setBlushCalibration(value: BlushCalibration, modelUrl: string): void;
  getBlushSupport(): string;
  previewBlush(value: BlushCalibration): void;
  clearBlushPreview(): void;
  expressionSupport(recipe: ExpressionRecipe): ExpressionSupport;
  playExpression(recipe: unknown, strength?: number): ExpressionSupport | null;
  playReaction(cue: unknown): ReactionStageResult;
  setProceduralLife(enabled: boolean): void;
  setSleepHabit(value: unknown): void;
  // pulling her
  pullHit(x: number, y: number): StagePullHit | null;
  pullStart(hit: StagePullHit): boolean;
  pullTo(x: number, y: number): void;
  pullEnd(): void;
  setPullStance(stance: PullStance | null): void;
  pullStillAllowed(group: StagePullHit['group']): boolean;
  pullMood(): PullMoodReading | null;
  // her actions, gestures, rock-paper-scissors, give, hands
  playHerAction(value: unknown): Promise<void>;
  setRps(view: RpsView | null): void;
  startGive(cue: GiveStageCue, onOutcome?: (id: string, outcome: GiveStageOutcome) => void): void;
  takeGive(): boolean;
  withdrawGive(outcome?: 'not-taken' | 'interrupted'): void;
  giveAnchor(): { x: number; y: number; r: number } | null;
  captureGivePicture(maxChars?: number): string | null;
  readonly handInput: HandInput;
  startHands(cue: HandReachCue): boolean;
  handsCommand(command: HandsStageCommand): void;
  handsState(): HandReachState | null;
  handsAnchor(): { x: number; y: number; r: number } | null;
  handsNear(): boolean;
  // music
  setMusicEnabled(enabled: boolean): void;
  setMusicSample(sample: MusicEnergySample): void;
  setMusicSettings(settings: Partial<MusicSettings>): void;
  getMusicPresence(): ReturnType<typeof musicPresence>;
  getMusicChoiceLine(): string;
  setListenKindLine(line: string): void;
  rejudgeMusicNow(): boolean;
  // physics, capabilities, previews and pictures
  setPhysicsSettings(settings: ModelPhysicsSettings): void;
  setModelCapabilities(card: ModelCapabilities | null): void;
  previewCapability(id: ModelCapabilityId): boolean;
  previewVisual(view: AuthoringPreview): Promise<boolean>;
  cancelVisualPreview(id?: string, token?: string, notify?: boolean): void;
  previewBody(view: BodyPosePreview): Promise<boolean>;
  cancelBodyPreview(id?: string, token?: string, notify?: boolean, inFrame?: boolean): void;
  cancelSurprisePreview(id?: string, inFrame?: boolean): void;
  captureCharacterAvatar(expectedUrl: string, side?: number): Promise<string>;
  captureCharacterStickerReference(expectedUrl: string): Promise<StickerCapture>;
}

/** The member list and the interface name the same members (one added to only one of them fails to compile). */
type Assert<T extends true> = T;
export type StageSurfaceListMatchesInterface = Assert<[Exclude<StageSurfaceMember, keyof StageSurface>, Exclude<keyof StageSurface, StageSurfaceMember>] extends [never, never] ? true : false>;
