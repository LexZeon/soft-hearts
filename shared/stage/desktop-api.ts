// 舞台 (stage): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { EmojiId, EmojiSettings, ModelPhysicsSettings, ModelProfileCacheView } from '../stage';
import type { AppSettings, CameraConfig } from '../foundation/settings';
import type { WindowVisibilityState } from '../foundation/runtime-state';

export interface ModelPhysicsSettingsPatch {
  hair?: Partial<ModelPhysicsSettings['hair']>;
  chest?: Partial<ModelPhysicsSettings['chest']>;
  quality?: ModelPhysicsSettings['quality'];
}
export interface PointerPosition {
  x: number;
  y: number;
}
export type PetWindowOperation = 'move' | 'nw' | 'ne' | 'sw' | 'se';
/** Companion renderer's own drawing state, reported for developer diagnostics only. */
export interface PetPresentationSample {
  reason: 'startup' | 'restore';
  visibility: 'visible' | 'hidden' | 'prerender' | 'unknown';
  hostVisible: boolean;
  canvasWidth: number;
  canvasHeight: number;
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
  /** null when no WebGL canvas exists. */
  contextLost: boolean | null;
  /** An animation frame actually ran shortly after the probe started. */
  frameAdvanced: boolean;
}
/** Bounded developer log of companion window facts; never contains settings, paths or chat. */
export interface PetWindowDiagnosticEntry {
  /** Milliseconds since the host process started. */
  t: number;
  event: string;
  detail: Record<string, string | number | boolean | null>;
}
export interface PetWindowDiagnosticsView {
  enabled: boolean;
  entries: PetWindowDiagnosticEntry[];
}

export interface StageDesktopAPI {
  reportPetFramingState(state: import('../stage').PetFramingState): Promise<void>;
  beginPetFraming(id: string): Promise<boolean>;
  completePetFraming(report: import('../stage').PetFramingReport): Promise<boolean>;
  noteManualCameraChange(): Promise<void>;
  onPetFramingRequest(callback: (request: import('../stage').PetFramingRequest) => void): () => void;
  /** Model profile cache for the current model (content-hash keyed, local only). */
  getModelProfile(): Promise<ModelProfileCacheView>;
  saveModelProfile(modelKey: string, profile: unknown): Promise<boolean>;
  /**
   * I-024 模型体检 (shared/stage/model-capability-check.ts): the current model's record (content-hash keyed, local only) and its cached
   * profile so a page can tell the record is its stage's model. Asking sends haiku only this model's own part names, once per model.
   */
  getModelCapabilities(): Promise<import('../stage').ModelCapabilityView>;
  askModelCapabilityNames(modelKey: string, request: import('../stage').ModelCheckRequest): Promise<import('../stage').ModelCheckAskResult>;
  saveModelCapabilityCheck(modelKey: string, matches: import('../stage').HaikuMatches): Promise<import('../stage').ModelCapabilityRecord>;
  /** Control window only: the user's on/off on the character page (null: follow what was detected). */
  setModelCapabilityChoice(modelKey: string, id: import('../stage').ModelCapabilityId, choice: import('../stage').CapabilityChoice): Promise<import('../stage').ModelCapabilityRecord>;
  onModelCapabilities(callback: (update: import('../stage').ModelCapabilityUpdate) => void): () => void;
  /** Control window only: 试一下 on the companion; the companion's stage answers through reportModelCapabilityPreview. */
  previewModelCapability(id: import('../stage').ModelCapabilityId): Promise<import('../stage').CapabilityPreviewResult>;
  onModelCapabilityPreview(callback: (request: import('../stage').CapabilityPreviewRequest) => void): () => void;
  reportModelCapabilityPreview(requestId: string, ok: boolean): Promise<void>;
  /** 她自己的生活: the pinned library motion of her current state only (electron/stage/her-life/motion-resource.ts). */
  resolveHerLifeMotion(motionId: string, token: string): Promise<import('../stage').HerLifeMotionResource>;
  getVisualAuthoring(id:string):Promise<import('../stage').VisualAuthoringState>;
  chooseVisualMaterial(id:string,revision:number):Promise<import('../stage').VisualAuthoringState>;
  researchVisual(request:import('../stage').VisualResearchRequest):Promise<import('../stage').VisualAuthoringState>;
  researchExpression(request:import('../actions').ExpressionResearchRequest):Promise<import('../stage').VisualAuthoringState>;
  editExpression(request:import('../actions').ExpressionEditRequest):Promise<import('../stage').VisualAuthoringState>;
  previewExpression(id:string,revision:number):Promise<import('../actions').ExpressionPreview>;
  resolveExpressionPreview(id:string,token:string,generation:number):Promise<import('../actions').ExpressionResource>;
  previewVisualBinding(id:string,revision:number,selection:import('../stage').VisualSelection):Promise<import('../stage').VisualPreview>;
  visualPreviewReceipt(request:import('../stage').VisualPreviewReceipt):Promise<void>;
  resolveVisualPreview(id:string,token:string,stageGeneration:number):Promise<import('../actions').BehaviorMotionResource>;
  saveVisualBehavior(request:import('../stage').VisualSaveRequest):Promise<import('../stage').VisualAuthoringState>;
  changeVisualBehavior(request:import('../stage').VisualChangeRequest):Promise<import('../stage').VisualAuthoringState>;
  cancelVisualAuthoring(id:string):Promise<void>;
  onVisualPreviewCancelled(callback:(value:{id:string;token:string})=>void):()=>void;
  getBodyAuthoring(id:string):Promise<import('../stage').BodyVisualState>;
  chooseBodyMaterial(id:string,revision:number):Promise<import('../stage').BodyVisualState>;
  researchBody(request:import('../stage').BodyVisualResearchRequest):Promise<import('../stage').BodyVisualState>;
  discardBodyAdvice(id:string,revision:number):Promise<void>;
  consumeBodyAdvice(id:string,revision:number,candidateId:string,side?:'left'|'right'|'both'|'head'|'torso'|'all'):Promise<import('../stage').BodyAdviceFill>;
  previewBodyBinding(id:string,revision:number,selection:import('../stage').BodyPoseSelection):Promise<import('../stage').BodyPosePreview>;
  previewFixedBodyBinding(id:string,revision:number,selection:import('../stage').BodyPoseSelection):Promise<import('../stage').BodyPosePreview>;
  bodyPreviewReceipt(request:import('../stage').BodyPoseReceipt):Promise<void>;
  resolveBodyPreview(id:string,token:string,stageGeneration:number):Promise<import('../stage').BodyPoseBinding>;
  saveBodyBehavior(request:import('../stage').BodyPoseSaveRequest):Promise<import('../stage').BodyVisualState>;
  changeBodyBehavior(request:import('../stage').BodyPoseChangeRequest):Promise<import('../stage').BodyVisualState>;
  cancelBodyAuthoring(id:string):Promise<void>;
  onBodyPreviewCancelled(callback:(value:{id:string;token:string})=>void):()=>void;
  getWindowVisibility(): Promise<WindowVisibilityState>;
  onWindowVisibility(callback: (state: WindowVisibilityState) => void): () => void;
  setPetVisible(visible: boolean): Promise<AppSettings>;
  setPetAlwaysOnTop(enabled: boolean): Promise<AppSettings>;
  getModelPhysicsSettings(): Promise<ModelPhysicsSettings>;
  getSingleEmojiSettings(): Promise<EmojiSettings>;
  setSingleEmojiSettings(settings: EmojiSettings): Promise<EmojiSettings>;
  previewSingleEmoji(id: EmojiId): Promise<boolean>;
  onSingleEmojiSettings(callback: (settings: EmojiSettings) => void): () => void;
  setModelPhysicsSettings(settings: ModelPhysicsSettingsPatch): Promise<ModelPhysicsSettings>;
  onModelPhysicsSettings(callback: (settings: ModelPhysicsSettings) => void): () => void;
  /** R01 物理调参台: opens the developer lab window (control window, developer mode only). */
  openPhysicsLab(): Promise<boolean>;
  savePetView(view: { camera?: CameraConfig; scale?: number }): Promise<AppSettings>;
  recoverPet(): Promise<AppSettings>;
  onPetRecovered(callback: () => void): () => void;
  /** Controls only; entries stay empty unless developer diagnostics are on. */
  getPetWindowDiagnostics(): Promise<PetWindowDiagnosticsView>;
  /** Companion only; diagnostic report, never a command. */
  reportPetPresentation(sample: PetPresentationSample): Promise<void>;
  setPetWindowOperation(operation: PetWindowOperation | null): Promise<void>;
  /** Companion only, click-through: take the mouse while the pointer is over her or a visible control. Resolves whether the window now receives it. */
  setPetPointerInput(receive: boolean): Promise<boolean>;
  pointer(): Promise<PointerPosition>;
  /** I-031 色块诊断日志 (temporary, companion window only): a block or near miss of the 色块哨兵; the host checks it again and writes it outside every profile. */
  noteColorBlock(value: import('../stage').ColorBlockReport): Promise<boolean>;
  /**
   * E1 惊喜 / 害羞 previews on any model (docs/claude/2026-11-03-e1-r18-fixes.md): either window asks for one closed recipe; the host
   * sends it to every window's stage (the companion first of all), which plays it on whatever model it has, skipping missing parts.
   */
  playExpressionPreview(recipe: import('../stage').ExpressionRecipe): Promise<import('../stage').ExpressionPreviewResult>;
  onExpressionPreview(callback: (recipe: import('../stage').ExpressionRecipe) => void): () => void;
}
