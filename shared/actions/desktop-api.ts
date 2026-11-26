// 身体动作 (actions): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type {
  BehaviorMotionResource, BodyMotionPlan, BodyMotionResource, BodyStageObservation, ChatGestureResource, MotionDownloadProgress, MotionLayer,
  MotionLibraryStatus, MotionPackId, MotionTagPreferenceRequest, MotionTrackCoverageRequest, MotionTrackCoverageView, MotionWeightQuery,
  MotionWeightResults, MotionWeightSave, MotionWeightView,
} from '../actions';
import type { AppSettings, AssetRef } from '../foundation/settings';

export interface ActionsDesktopAPI {
  /** Universal skeleton step 1: the current model's library motion scores (content-hash keyed, part words and numbers only). Controls window. */
  saveMotionFits(modelKey: string, record: unknown): Promise<boolean>;
  resolveChatGesture(cueId: string, token: string): Promise<ChatGestureResource>;
  resolveBehaviorMotion(cueId: string, token: string): Promise<BehaviorMotionResource>;
  getBehaviorBodyPlan(token: string, observation?: BodyStageObservation): Promise<BodyMotionPlan>;
  resolveBehaviorBody(cueId: string, token: string): Promise<BodyMotionResource>;
  isBehaviorModelSupported(): Promise<boolean>;
  /** Her default stand when no pose is picked: the bundled stand pose's asset (src/stage/rest-stand.ts). Both windows. */
  getRestStand(): Promise<AssetRef | null>;
  selectAsset(kind: "model" | "motion", layer?: MotionLayer): Promise<AssetRef | null>;
  useBundledModel(): Promise<AppSettings>;
  getMotionLibrary(preferences?: MotionTagPreferenceRequest): Promise<MotionLibraryStatus>;
  motionTrackCoverageRead(request: MotionTrackCoverageRequest): Promise<MotionTrackCoverageView>;
  readMotionWeights(packId: MotionPackId, motionId: string): Promise<MotionWeightView>;
  invalidateMotionWeightSelection(packId: MotionPackId): Promise<void>;
  saveMotionWeights(request: MotionWeightSave): Promise<MotionWeightView>;
  searchMotionWeights(request: MotionWeightQuery): Promise<MotionWeightResults>;
  previewMotion(packId: MotionPackId, motionId: string): Promise<AssetRef>;
  installMotionPack(packId: MotionPackId, motionId: string, layer?: MotionLayer): Promise<AssetRef>;
  clearMotionLayer(layer: MotionLayer): Promise<AppSettings>;
  cancelMotionDownload(): Promise<void>;
  onMotionDownload(callback: (progress: MotionDownloadProgress) => void): () => void;
  /**
   * 她的动作 (T-211, shared/actions/her-actions.ts): the host sends a short-lived cue to every window's stage; a stage resolves only that
   * live cue to its one pinned VMD; only the companion window's answer (played, skipped and why) reaches the test note.
   */
  onHerAction(callback: (cue: import('../actions').HerActionCue) => void): () => void;
  resolveHerAction(cueId: string): Promise<import('../actions').HerActionResource>;
  reportHerAction(outcome: import('../actions').HerActionOutcome): Promise<void>;
}
