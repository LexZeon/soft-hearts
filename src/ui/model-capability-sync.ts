import { acceptCachedProfile, type ModelProfile } from '../../shared/model-profile';
import { deriveModelCapabilities, type HaikuMatches, type ModelCapabilities, type ModelCapabilityId } from '../../shared/model-capability';
import { modelAdaptation, type ModelAdaptation } from '../../shared/model-adaptation';
import {
  matchesWaiting, missingNeeds, recordChecked,
  type CapabilityPreviewRequest, type HaikuCandidates, type ModelCapabilityRecord, type ModelCapabilityUpdate, type ModelCapabilityView,
  type ModelCheckAskResult, type ModelCheckNames, type ModelCheckRequest,
} from '../../shared/model-capability-check';

export interface ModelCapabilitySyncApi {
  getModelCapabilities(): Promise<ModelCapabilityView>;
  askModelCapabilityNames(modelKey: string, request: ModelCheckRequest): Promise<ModelCheckAskResult>;
  saveModelCapabilityCheck(modelKey: string, matches: HaikuMatches): Promise<ModelCapabilityRecord>;
}
/** What the stage's profile offers the check (src/stage/model-profile.ts StageModelProfile). */
export interface CheckableModelProfile {
  /** The profile as the names found it (the card's labels and the check read this). */
  readonly namedProfile: ModelProfile | null;
  /** haiku's checked matches this load already filled into the stage's profile. */
  readonly fromHaiku: HaikuMatches;
  identity(): { vertices: number; bones: readonly string[]; morphs: readonly string[] } | null;
  checkNames(): ModelCheckNames | null;
  verifyHaikuCandidates(candidates: HaikuCandidates): HaikuMatches;
  releaseCheckInput(): void;
}
export interface ModelCapabilitySyncState {
  /** The model the host record belongs to (null: no model, or not matched to this stage's model yet). */
  modelKey: string | null;
  /** Where the character page writes the user's choices: the matched model, else the host's current one. */
  targetKey: string | null;
  card: ModelCapabilities | null;
  record: ModelCapabilityRecord | null;
  checking: boolean;
  /** This window's stage has a model profile. */
  loaded: boolean;
  /** haiku found parts this load of the stage does not use yet: they take effect the next time the model loads. */
  waitingForReload: boolean;
  /** T-213: her actions on this model (the stage's own pre-play rule), fingers left out, bones hanging elsewhere than in Gene. */
  adaptation: ModelAdaptation | null;
}
export interface ModelCapabilitySyncOptions {
  api: ModelCapabilitySyncApi;
  /** The stage's setModelCapabilities. */
  apply(card: ModelCapabilities | null): void;
  onChange?(state: ModelCapabilitySyncState): void;
  /** Waits before asking again when the host's profile copy has not arrived yet (it is written right after the stage builds it). */
  retryDelaysMs?: readonly number[];
  wait?(ms: number): Promise<void>;
}

/**
 * I-024 模型体检 in a window (both the pet and the control window's preview run one): when this window's stage builds a model
 * profile, read the host's record for that model, hand the stage its capability card (deriveModelCapabilities: the names'
 * profile, haiku's checked matches, the user's choices), and hand it again whenever any of them changes. The first time a
 * model loads in this check version, run the check: if a capability is missing, send ONLY this model's own part names and the
 * missing slots, check haiku's names on this mesh, report what passed. The host asks once per model; a failure changes nothing.
 * The stage uses haiku's parts from the next load on (the host sends them with the cached profile).
 */
export class ModelCapabilitySync {
  private generation = 0;
  private source: CheckableModelProfile | null = null;
  private modelKey: string | null = null;
  private targetKey: string | null = null;
  private record: ModelCapabilityRecord | null = null;
  private card: ModelCapabilities | null = null;
  private checking = false;
  private disposed = false;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly options: ModelCapabilitySyncOptions) {}

  get state(): ModelCapabilitySyncState {
    const profile = this.source?.namedProfile ?? null;
    // The same names and haiku matches as the card (derive below); the stage applies the same rule before it plays an action.
    const adaptation = profile ? modelAdaptation(profile, this.modelKey ? this.record?.haiku ?? {} : {}) : null;
    return { modelKey: this.modelKey, targetKey: this.targetKey, card: this.card, record: this.record ? structuredClone(this.record) : null,
      checking: this.checking, loaded: !!profile,
      waitingForReload: !!this.modelKey && !!this.source && matchesWaiting(this.record, this.source.fromHaiku), adaptation };
  }

  /**
   * The stage built a profile (src/stage/model-profile.ts onStageModelProfile), in the middle of its own load step: the stage
   * already dropped the old card itself, so nothing is sent to it until the host record is read.
   */
  profileBuilt(source: CheckableModelProfile): void {
    if (this.disposed) return;
    if (this.source !== source) this.source?.releaseCheckInput();
    const generation = ++this.generation;
    this.source = source; this.modelKey = this.targetKey = null; this.record = null; this.checking = false; this.card = null;
    this.notify();
    this.running = new Promise<void>(resolve => queueMicrotask(() => { this.attach(generation, source).catch(() => {}).finally(resolve); }));
  }

  /** Resolves once the latest model's record is read and its check (if any) has finished. */
  settled(): Promise<void> { return this.running; }

  /** The stage dropped its model (onMotionFit(null)): nothing is known until the next profile. */
  modelCleared(): void {
    if (this.disposed) return;
    this.generation++;
    this.source?.releaseCheckInput();
    this.source = null; this.modelKey = this.targetKey = null; this.record = null; this.checking = false; this.card = null;
    this.notify();
  }

  /** A host broadcast (desk:model-capabilities): the user's choice or a finished check, for whichever window did it. */
  receive(update: ModelCapabilityUpdate): void {
    if (this.disposed || !update || typeof update.modelKey !== 'string' || !this.source) return;
    if (update.modelKey !== (this.modelKey ?? this.targetKey)) return;
    this.record = structuredClone(update.record);
    this.push(this.derive());
  }

  dispose(): void { this.disposed = true; this.generation++; this.source?.releaseCheckInput(); this.source = null; }

  private derive(): ModelCapabilities | null {
    const profile = this.source?.namedProfile ?? null;
    if (!profile) return null;
    // haiku's matches count only once the record is matched to this stage's model (they could be another model's otherwise).
    return deriveModelCapabilities(profile, this.record?.choices ?? {}, this.modelKey ? this.record?.haiku ?? {} : {});
  }

  private notify(): void { try { this.options.onChange?.(this.state); } catch { /* The page repaints on the next change. */ } }

  private push(card: ModelCapabilities | null): void {
    this.card = card;
    try { this.options.apply(card); } catch { /* The stage keeps its previous card. */ }
    this.notify();
  }

  private async attach(generation: number, source: CheckableModelProfile): Promise<void> {
    const delays = this.options.retryDelaysMs ?? [400, 1500, 4000];
    const wait = this.options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const identity = source.identity();
    if (!source.namedProfile || !identity) { source.releaseCheckInput(); return; }
    let last: ModelCapabilityView | null = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt) await wait(delays[attempt - 1]);
      if (generation !== this.generation) return;
      let view: ModelCapabilityView;
      try { view = await this.options.api.getModelCapabilities(); } catch { continue; }
      if (generation !== this.generation) return;
      last = view;
      if (view.modelKey && acceptCachedProfile(view.profile, identity)) {
        this.modelKey = this.targetKey = view.modelKey; this.record = view.record;
        this.push(this.derive());
        break;
      }
    }
    if (generation !== this.generation) return;
    if (!this.modelKey) {
      // Not matched (the host has no profile copy for its model): the user's choices still apply; nothing is written.
      this.targetKey = last?.modelKey ?? null; this.record = last?.record ?? null;
      this.push(this.derive());
      source.releaseCheckInput();
      return;
    }
    if (recordChecked(this.record)) { source.releaseCheckInput(); return; }
    await this.check(generation, source, this.modelKey);
  }

  private async check(generation: number, source: CheckableModelProfile, modelKey: string): Promise<void> {
    this.checking = true; this.notify();
    try {
      const wanted = missingNeeds(source.namedProfile);
      let matches: HaikuMatches = {};
      if (wanted.morphs.length || wanted.bones.length) {
        const names = source.checkNames();
        if (!names) return;
        const answer = await this.options.api.askModelCapabilityNames(modelKey, { names, wanted });
        if (generation !== this.generation) return;
        if (answer.status === 'unavailable') return; // Claude cannot be asked now: the next load tries again.
        if (answer.candidates) matches = source.verifyHaikuCandidates(answer.candidates);
      }
      const record = await this.options.api.saveModelCapabilityCheck(modelKey, matches);
      if (generation !== this.generation) return;
      this.record = record;
    } catch { /* The card stays as the names found it; the next load checks again. */ }
    finally {
      if (generation === this.generation) { this.checking = false; source.releaseCheckInput(); this.push(this.derive()); }
    }
  }
}

/** The pet window answers 试一下 from the character page with its own stage (stage.previewCapability). */
export function bindCapabilityPreview(api: {
  onModelCapabilityPreview(callback: (request: CapabilityPreviewRequest) => void): () => void;
  reportModelCapabilityPreview(requestId: string, ok: boolean): Promise<void>;
}, stage: () => { previewCapability(id: ModelCapabilityId): boolean } | null | undefined): () => void {
  return api.onModelCapabilityPreview(request => {
    let ok = false;
    try { ok = stage()?.previewCapability(request.id) === true; } catch { ok = false; }
    void api.reportModelCapabilityPreview(request.requestId, ok).catch(() => {});
  });
}
