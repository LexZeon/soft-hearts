/**
 * I-154 batch 7, row 43 预览 (docs/claude/2026-11-19-unbound-in-window.md): the control window's authoring previews on the window engine,
 * the old stage's flows (src/stage/mmd/previews.ts) with the same host receipts and the same checks, eased the window's way:
 *  - 个性化姿势 (previewBody): the host's binding (bind receipt, resolved binding checked against the preview) becomes the old stage's static
 *    pose (personalizePose: the reviewed Gene as authored, another model through the universal target), written as a figure overlay (after
 *    her feet, before physics) at strength × an eased weight. It comes in and goes out through a critically damped weight (never a frame's
 *    jump); "ready" is told to the host after the first rendered frame that shows it, as on the old stage;
 *  - 个性化眉眼 and 表情预览 (previewVisual): through the window's own behaviour-face player (window-motions.ts), which plays the authored cue
 *    with its own fades (resolved through resolveVisualPreview), or the expression composition (resolveExpressionPreview, validated) at an
 *    eased strength; "ready" when the player shows it.
 * The old stage's gates cancel a preview (and tell the host "stop"): hidden, a window or camera move, input focus, a touch, music, a chat
 * gesture, a picked pose or gesture (body), a picked face (visual); a preview that expires ends without a receipt. Ending eases out from
 * where it is. Only the control window's preview makes these (the stage is given the grants only there: preview-port.ts).
 */
import { type Bone, type SkinnedMesh } from 'three';
import { personalizePose, bodyMotionTarget, type BehaviorMotionPlayer, type PersonalizeStaticPose } from '../../stage';
import type { StageMotionRetarget } from '../../actions';
import { EXPRESSION_GENE_SHA, EXPRESSION_MASK, expressionStrength, isExpressionPreview, validateExpressionResource, type AuthoringPreview, type ExpressionResource } from '../../../shared/actions';
// The personal visuals and poses are written on the reviewed Gene: the same content pin and mask as the expressions (shared/stage/personalize-visual.ts
// VISUAL_GENE_SHA / VISUAL_MASK hold the same values; that page is not public: tests/unbound-window-preview.test.ts checks they agree).
const VISUAL_GENE_SHA = EXPRESSION_GENE_SHA, VISUAL_MASK = EXPRESSION_MASK;
import type { BodyPosePreview, VisualPreview } from '../../../shared/stage';
import type { MoodView } from '../../../shared/mood';
import type { WindowPreviewGrants } from './preview-port';

/** How long a preview may wait for its first shown frame before it is cancelled (the old stage's 6 s). */
export const PREVIEW_READY_MS = 6_000;
/** A preview eases out this long before the host's expiry (the player itself would cut at expiry). */
export const PREVIEW_EXPIRY_FADE_MS = 400;

/** How long a preview takes to come in or go out fully (s). A personal pose moves her arm tens of degrees: slower than that jumps. */
export const PREVIEW_EASE_S = 0.8;
const smootherstep = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (t * 6 - 15) + 10); };

/**
 * A weight toward 0 or 1 along a smootherstep (speed and acceleration start and end at zero: like key frames, no frame's step departs
 * from the last one by more than the curve's own bend). A change of target mid-way starts a new curve from where it is, over the share left.
 */
export class EasedWeight {
  value = 0;
  private from = 0; private to = 0; private t = 1; private span: number;
  constructor(private readonly seconds = PREVIEW_EASE_S) { this.span = seconds; }
  step(target: number, dt: number): number {
    // The span grows with the root of what is left, so the curve's bend (its acceleration) is the same for a full or a partial change.
    if (target !== this.to) { this.from = this.value; this.to = target; this.t = 0; this.span = Math.max(1e-3, this.seconds * Math.sqrt(Math.abs(target - this.value))); }
    if (this.t < 1) this.t = Math.min(1, this.t + (Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0) / this.span);
    this.value = this.from + (this.to - this.from) * smootherstep(this.t);
    return this.value;
  }
  reset(): void { this.value = this.from = this.to = 0; this.t = 1; }
}

/** What the previews read of the stage. */
export interface WindowPreviewStage {
  /** The control window's preview is drawn now (not disposed, shown, the page visible). */
  shown(): boolean;
  /** The loaded model as the stage holds it; null while none. */
  model(): { generation: number; url: string; mesh: SkinnedMesh; reviewed: boolean; retarget: StageMotionRetarget | null;
    rest: readonly { bone: Bone; quaternion: import('three').Quaternion }[] } | null;
  /** The settings' model url (a preview for another model is refused). */
  settingsUrl(): string;
  pendingModel(): Promise<void>;
  behavior(): BehaviorMotionPlayer | null;
  mood(): MoodView | null;
  /** The behaviour-face player's plan should be read again now (window-motions.ts update). */
  refresh(): void;
}

interface Timers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void; now(): number }
const REAL_TIMERS: Timers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() };

interface Pending { ready: boolean; reporting: boolean; resolve(ok: boolean): void; timer: unknown }

// ---- 个性化姿势 -------------------------------------------------------------------------------------------------------------------
interface BodyShown { overlay: PersonalizeStaticPose; bones: Bone[]; strength: number; weight: EasedWeight; target: number }

export class WindowBodyPreview {
  private ticket = 0;
  private pending: { id: string; token: string; ticket: number } | null = null;
  private active: (Pending & { value: BodyPosePreview; model: number; applied: boolean; shown: BodyShown }) | null = null;
  private fading: BodyShown[] = [];

  constructor(private readonly grants: WindowPreviewGrants, private readonly stage: WindowPreviewStage, private readonly timers: Timers = REAL_TIMERS) {}

  get busy(): boolean { return !!this.active || !!this.pending || this.fading.length > 0; }

  async start(view: BodyPosePreview): Promise<boolean> {
    this.cancel();
    const ticket = ++this.ticket;
    this.pending = { id: view.id, token: view.token, ticket };
    await this.stage.pendingModel();
    if (ticket !== this.ticket) return false;
    const model = this.stage.model();
    if (!this.stage.shown() || !model || !bodyMotionTarget(model.reviewed, model.retarget).supported || view.targetModelSha !== VISUAL_GENE_SHA
      || view.modelUrl !== model.url || view.modelUrl !== this.stage.settingsUrl() || view.expiresAt <= this.timers.now()) { this.pending = null; return false; }
    try {
      await this.grants.bodyPreviewReceipt({ phase: 'bind', id: view.id, token: view.token, stageGeneration: model.generation });
      const binding = await this.grants.resolveBodyPreview(view.id, view.token, model.generation);
      if (ticket !== this.ticket || this.stage.model()?.generation !== model.generation || this.stage.model()?.mesh !== model.mesh || binding.id !== view.bindingId
        || binding.sourceSha !== view.sourceSha || binding.mask !== view.mask || binding.targetModelSha !== view.targetModelSha || binding.qualifiedStrength !== view.strength) {
        if (this.pending?.ticket === ticket) this.pending = null;
        return false;
      }
      const overlay = personalizePose(model.mesh, binding.properties, model.rest, model.reviewed, model.retarget); // I-038: other models too
      const bones = model.mesh.skeleton.bones.filter(bone => overlay.hasBone(bone));
      let resolve!: (ok: boolean) => void;
      const result = new Promise<boolean>(done => { resolve = done; });
      this.pending = null;
      this.active = { value: structuredClone(view), model: model.generation, applied: false, ready: false, reporting: false, resolve,
        timer: this.timers.set(() => this.cancel(view.id, view.token), PREVIEW_READY_MS),
        shown: { overlay, bones, strength: Math.min(1, Math.max(0, view.strength)), weight: new EasedWeight(), target: 1 } };
      return await result;
    } catch { this.cancel(view.id, view.token); return false; }
  }

  /** The old stage's cancelBodyPreview: the matching preview (or any) ends; "stop" told unless the host asked; what shows eases out. */
  cancel(id?: string, token?: string, notify = true): void {
    const active = this.active;
    if (!active) {
      const pending = this.pending;
      if (id === undefined || (pending && pending.id === id && (token === undefined || pending.token === token))) { this.ticket++; this.pending = null; }
      return;
    }
    if ((id !== undefined && active.value.id !== id) || (token !== undefined && active.value.token !== token)) return;
    this.ticket++;
    this.active = null;
    this.timers.clear(active.timer); active.resolve(false);
    active.shown.target = 0; this.fading.push(active.shown);
    if (notify) void this.grants.bodyPreviewReceipt({ phase: 'stop', id: active.value.id, token: active.value.token, stageGeneration: active.model }).catch(() => {});
  }

  /** Each frame before her body's: the gates, the expiry, the weights. `blocked`: the old stage's body preview gates hold her now. */
  frame(dt: number, blocked: boolean): void {
    const active = this.active;
    if (active) {
      const model = this.stage.model();
      if (!model || model.generation !== active.model) { this.cancel(); this.dropAll(); }
      else if (active.value.expiresAt <= this.timers.now()) {
        this.active = null; this.timers.clear(active.timer); if (!active.ready) active.resolve(false); active.shown.target = 0; this.fading.push(active.shown);
      } else if (blocked) this.cancel();
    }
    if (this.active) this.active.shown.weight.step(1, dt);
    for (const shown of this.fading) shown.weight.step(0, dt);
    this.fading = this.fading.filter(shown => shown.weight.value > 0);
  }

  /** The figure's overlay this frame (after her feet, before physics): the poses fading out, then the one showing. Null when none. */
  overlay(): ((remember: (bone: Bone) => void) => void) | null {
    const shows = [...this.fading, ...(this.active ? [this.active.shown] : [])].filter(shown => shown.weight.value > 0);
    if (!shows.length) return null;
    return remember => {
      for (const shown of shows) {
        for (const bone of shown.bones) remember(bone);
        const count = shown.overlay.apply(shown.strength * shown.weight.value, null, true);
        const values = shown.bones.map(bone => bone.quaternion.clone());
        shown.overlay.restore();
        shown.bones.forEach((bone, index) => bone.quaternion.copy(values[index]));
        if (shown === this.active?.shown && count > 0) this.active.applied = true;
      }
    };
  }

  /** After a rendered frame: the first frame that showed it is told to the host ("ready"), then the preview's promise resolves true. */
  afterRender(): void {
    const active = this.active;
    if (!active || !active.applied || active.ready || active.reporting || active.model !== this.stage.model()?.generation) return;
    active.reporting = true;
    void this.grants.bodyPreviewReceipt({ phase: 'ready', id: active.value.id, token: active.value.token, stageGeneration: active.model }).then(() => {
      if (this.active !== active) return;
      active.ready = true; this.timers.clear(active.timer); active.resolve(true);
    }).catch(() => this.cancel(active.value.id, active.value.token));
  }

  /** The model went or the window hid (nothing on screen to ease): everything goes now. */
  dropAll(): void { if (this.active || this.pending) this.cancel(); this.fading = []; }
}

// ---- 个性化眉眼, 表情预览 ---------------------------------------------------------------------------------------------------------
/** What the behaviour-face player plays instead of the mood's faces while a visual preview runs (window-motions.ts). */
export type VisualPreviewPlan =
  | { kind: 'cue'; token: string; plan: { state: unknown; reaction: unknown } }
  /** `strength`: the old stage's (0 without a mood: refused); `weight`: the eased share of it shown now. */
  | { kind: 'composition'; token: string; resource: ExpressionResource | null; strength: number; weight: number; fading: boolean };

export class WindowVisualPreview {
  private active: (Pending & { value: AuthoringPreview; model: number; resource?: ExpressionResource; weight: EasedWeight }) | null = null;
  /** An expression composition easing out (its token, its resource, its weight). */
  private fading: { token: string; resource: ExpressionResource; strength: number; weight: EasedWeight } | null = null;

  constructor(private readonly grants: WindowPreviewGrants, private readonly stage: WindowPreviewStage, private readonly timers: Timers = REAL_TIMERS) {}

  get busy(): boolean { return !!this.active || !!this.fading; }

  async start(view: AuthoringPreview): Promise<boolean> {
    this.cancel();
    await this.stage.pendingModel();
    const model = this.stage.model(), behavior = this.stage.behavior();
    if (!this.stage.shown() || !model || !behavior?.supported || (!isExpressionPreview(view) && view.scope !== 'personalize-visual-controls')
      || view.mask !== VISUAL_MASK || view.targetModelSha !== VISUAL_GENE_SHA || view.modelUrl !== model.url || view.modelUrl !== this.stage.settingsUrl()) return false;
    let resolve!: (ok: boolean) => void;
    const ready = new Promise<boolean>(done => { resolve = done; });
    const active: NonNullable<WindowVisualPreview['active']> = { value: structuredClone(view), model: model.generation, ready: false, reporting: false, resolve,
      weight: new EasedWeight(), timer: this.timers.set(() => this.cancel(view.id, view.token), PREVIEW_READY_MS) };
    this.active = active;
    try {
      await this.grants.visualPreviewReceipt({ phase: 'bind', id: view.id, token: view.token, stageGeneration: model.generation });
      if (this.active !== active || this.stage.model()?.generation !== model.generation) return false;
      if (isExpressionPreview(view)) {
        const resource = await this.grants.resolveExpressionPreview(view.id, view.token, model.generation);
        if (this.active !== active || this.stage.model()?.generation !== model.generation) return false;
        active.resource = validateExpressionResource(resource, view, model.generation);
      }
      this.stage.refresh();
      return await ready;
    } catch { this.cancel(view.id, view.token); return false; }
  }

  /** The player's grant for a cue: the preview's own (resolveVisualPreview) when it is this preview's cue; null otherwise. */
  resolveFor(cueId: string, token: string) {
    const active = this.active;
    return active && active.value.id === cueId && active.value.token === token ? this.grants.resolveVisualPreview(cueId, token, active.model) : null;
  }

  /** What the player plays now instead of the mood's faces; null: the mood's own. */
  plan(): VisualPreviewPlan | null {
    const active = this.active, view = this.stage.mood();
    if (active && isExpressionPreview(active.value)) {
      return { kind: 'composition', token: active.value.token, resource: active.resource ?? null, fading: false,
        strength: view ? expressionStrength(view.snapshot) : 0, weight: active.weight.value };
    }
    if (active) {
      const legacy = active.value as VisualPreview, cue ={ ...legacy.cue, strength: Math.min(legacy.selection.strength, view ? expressionStrength(view.snapshot, legacy.cue.kind === 'reaction') : 0) };
      return { kind: 'cue', token: legacy.token, plan: { state: cue.kind === 'state' ? cue : null, reaction: cue.kind === 'reaction' ? cue : null } };
    }
    const fading = this.fading;
    if (fading) return { kind: 'composition', token: fading.token, resource: fading.resource, fading: true, strength: fading.strength, weight: fading.weight.value };
    return null;
  }

  /** The composition could not be applied (gates, model): the preview is cancelled, as on the old stage. */
  failed(): void {
    if (this.active) { this.active.weight.reset(); this.cancel(this.active.value.id, this.active.value.token); } // nothing was shown: nothing to ease out
    else if (this.fading) { this.fading = null; this.stage.behavior()?.stop(); }
  }

  cancel(id?: string, token?: string, notify = true): void {
    const active = this.active;
    if (!active || (id !== undefined && active.value.id !== id) || (token !== undefined && active.value.token !== token)) return;
    this.active = null;
    this.timers.clear(active.timer); active.resolve(false);
    this.endShown(active);
    if (notify) void this.grants.visualPreviewReceipt({ phase: 'stop', id: active.value.id, token: active.value.token, stageGeneration: active.model }).catch(() => {});
    this.stage.refresh();
  }

  private endShown(active: NonNullable<WindowVisualPreview['active']>): void {
    const view = this.stage.mood();
    if (isExpressionPreview(active.value) && active.resource && active.weight.value > 0)
      this.fading = { token: active.value.token, resource: active.resource, strength: view ? expressionStrength(view.snapshot) : 0, weight: active.weight };
  }

  /** Each frame before her body's: the expiry and the gates (`blocked`: the old stage's visual preview gates), the weights. */
  frame(dt: number, blocked: boolean): void {
    const active = this.active;
    if (active) {
      const expiresAt = isExpressionPreview(active.value) ? active.value.expiresAt : active.value.cue.expiresAt;
      if (this.stage.model()?.generation !== active.model || this.stage.model()?.url !== active.value.modelUrl) this.cancel();
      else if (expiresAt - PREVIEW_EXPIRY_FADE_MS <= this.timers.now()) {
        // The natural end keeps only the host's ready proof: no receipt, it cannot be resolved or replayed again.
        this.active = null; this.timers.clear(active.timer); if (!active.ready) active.resolve(false); this.endShown(active);
      } else if (blocked) this.cancel();
    }
    if (this.active) this.active.weight.step(1, dt);
    if (this.fading) { this.fading.weight.step(0, dt); if (this.fading.weight.value <= 0 || this.fading.resource.expiresAt <= this.timers.now()) { this.fading = null; this.stage.behavior()?.stop(); } }
    if (this.active || this.fading) this.stage.refresh();
  }

  /** After a rendered frame: the player shows this preview → "ready" to the host, then the promise resolves true. */
  afterRender(): void {
    const active = this.active, behavior = this.stage.behavior();
    if (!active || !behavior || active.ready || active.reporting || active.model !== this.stage.model()?.generation) return;
    if (isExpressionPreview(active.value)) {
      const applied = behavior.getCompositionState();
      if (applied.id !== active.value.id || applied.recipeId !== active.value.recipeId || !applied.propertyIndices.length) return;
    } else {
      const state = behavior.getState(), layer = active.value.cue.kind === 'state' ? state.state : state.reaction;
      if (!layer?.active || layer.id !== active.value.id || !layer.propertyIndices.length) return;
    }
    active.reporting = true;
    void this.grants.visualPreviewReceipt({ phase: 'ready', id: active.value.id, token: active.value.token, stageGeneration: active.model }).then(() => {
      if (this.active !== active) return;
      active.ready = true; this.timers.clear(active.timer); active.resolve(true);
    }).catch(() => this.cancel(active.value.id, active.value.token));
  }

  /** The model went or the window hid: everything goes now (nothing on screen to ease). */
  dropAll(): void { this.cancel(); if (this.fading) { this.fading = null; this.stage.behavior()?.stop(); } }
}
