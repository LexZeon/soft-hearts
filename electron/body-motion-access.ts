import { bodyIdentity, readBodyStageObservation, type BodyStageObservation,
  type BodyMotionCue, type BodyMotionPlan, type BodyMotionResource } from '../shared/body-motion';

export interface BodyModelIdentity { readonly path: string; readonly url: string }
interface BodyAccessView { readonly token: string; readonly expressions: boolean; readonly body?: BodyMotionPlan }
type ResolvedBody = Omit<BodyMotionResource, 'url'> & { readonly path: string };
export interface BodyMotionAccessDependencies {
  readonly authorizePet: (sender: number) => boolean;
  readonly visible: () => boolean;
  readonly generation: () => number;
  readonly model: () => BodyModelIdentity | null;
  readonly view: () => BodyAccessView;
  readonly prepare: (token: string, targetVerified: boolean, stage?: BodyStageObservation) => BodyMotionPlan;
  readonly observeStage?: (token: string, stage: BodyStageObservation) => boolean;
  readonly invalidateStage?: (token: string) => void;
  readonly cue: (cueId: string, token: string) => BodyMotionCue;
  readonly verifyModel: (model: BodyModelIdentity) => Promise<boolean>;
  readonly resolve: (cue: BodyMotionCue, stillCurrent: () => boolean) => Promise<ResolvedBody>;
  readonly register: (path: string) => Promise<{ readonly url: string }>;
}
const CLOSED: BodyMotionPlan = Object.freeze({ mode: 'closed', cue: null, reason: 'normal-pool-closed' });

/** Only this app's current pet main frame may enter via the scoped IPC owner. */
export class BodyMotionAccess {
  constructor(private readonly deps: BodyMotionAccessDependencies) {}

  private current(sender: number, token: string): BodyAccessView {
    if (!this.deps.authorizePet(sender) || !bodyIdentity(token)) throw new Error('身体动作请求来源未授权。');
    const view = this.deps.view();
    if (view.token !== token) throw new Error('身体动作作用域已失效。');
    return view;
  }

  async getPlan(sender: number, token: string, observation?: unknown): Promise<BodyMotionPlan> {
    const view = this.current(sender, token);
    // Closed production mode does not inspect files or prepare a candidate.
    if (!view.body || view.body.mode === 'closed') return view.body ?? CLOSED;
    let stage: BodyStageObservation | undefined;
    if (view.body.mode === 'idle-scheduler') {
      try { stage = readBodyStageObservation(observation); }
      catch (error) { this.deps.invalidateStage?.(token); throw error; }
      // The host records and revokes blocking observations before any await.
      if (this.deps.observeStage?.(token, stage) !== true) return this.current(sender, token).body ?? CLOSED;
    }
    const selected = this.deps.model(), model = selected ? Object.freeze({ path: selected.path, url: selected.url }) : null;
    const generation = this.deps.generation();
    if (!model || !this.deps.visible() || !view.expressions) return this.deps.prepare(token, false, stage);
    const supported = await this.deps.verifyModel(model);
    this.current(sender, token);
    this.checkModel(model, generation);
    // Concurrent reads converge on the host controller's atomic single-use prepare.
    return this.deps.prepare(token, supported && this.deps.visible(), stage);
  }

  async resolve(sender: number, cueId: string, token: string): Promise<BodyMotionResource> {
    this.current(sender, token);
    if (!bodyIdentity(cueId)) throw new Error('身体动作身份不合法。');
    const selected = this.deps.model(), model = selected ? Object.freeze({ path: selected.path, url: selected.url }) : null;
    const generation = this.deps.generation();
    if (!model) throw new Error('身体动作目标不可用。');
    const admitted = Object.freeze({ ...this.deps.cue(cueId, token) });
    const stillCurrent = () => {
      const view = this.current(sender, token);
      this.checkModel(model, generation);
      const current = this.deps.cue(cueId, token);
      if (!this.deps.visible() || !view.expressions || current.id !== admitted.id || current.token !== admitted.token
        || current.recipeId !== admitted.recipeId || current.at !== admitted.at || current.expiresAt !== admitted.expiresAt
        || current.durationMs !== admitted.durationMs || current.strength !== admitted.strength)
        throw new Error('身体动作已取消或被替换。');
      return true;
    };
    stillCurrent();
    if (!await this.deps.verifyModel(model)) throw new Error('身体动作目标不可用。'); // I-038: any read model; the stage judges each motion on it
    stillCurrent();
    const resource = await this.deps.resolve(Object.freeze({ ...admitted }), stillCurrent);
    stillCurrent();
    if (!await this.deps.verifyModel(model)) throw new Error('身体动作目标已改变。');
    stillCurrent();
    const asset = await this.deps.register(resource.path);
    stillCurrent();
    if (!await this.deps.verifyModel(model)) throw new Error('身体动作目标已改变。');
    stillCurrent();
    const { path: _localPath, ...metadata } = resource;
    return { ...metadata, url: asset.url };
  }

  private checkModel(model: BodyModelIdentity, generation: number): void {
    const current = this.deps.model();
    if (generation !== this.deps.generation() || current?.path !== model.path || current.url !== model.url)
      throw new Error('身体动作模型代次已失效。');
  }
}
