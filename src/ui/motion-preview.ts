import type { AppSettings, AssetRef } from "../../shared/contracts";
import type { CatalogMotion, MotionPackId } from "../../shared/motion-library";
import { getMotionLayerAssets, withMotionLayer, type MotionLayer } from "../../shared/motion-layers";

export interface MotionPreviewState {
  phase: "idle" | "loading" | "playing";
  packId?: MotionPackId;
  motionId?: string;
  name?: string;
  layer?: MotionLayer;
  local?: 'surprise';
}

export interface MotionPreviewDependencies {
  getSettings(): AppSettings;
  load(packId: MotionPackId, motionId: string): Promise<AssetRef>;
  apply(settings: AppSettings): Promise<void>;
  onState(state: MotionPreviewState): void;
}

interface PreviewAnchor {
  model: string;
  layers: string;
}

function savedLayers(settings: AppSettings): string {
  const layers = getMotionLayerAssets(settings);
  return JSON.stringify([Boolean(settings.motionLayers), layers.pose?.path ?? null,
    layers.gesture?.path ?? null, layers.expression?.path ?? null]);
}

/** A temporary control-window layer. It never saves or broadcasts a model or motion choice. */
export class MotionPreviewSession {
  private generation = 0;
  private disposed = false;
  private anchor: PreviewAnchor | null = null;
  private asset: AssetRef | null = null;
  private layer: MotionLayer = "pose";
  private currentState: MotionPreviewState = { phase: "idle" };
  private applyQueue: Promise<void> = Promise.resolve();
  private localCancel:(()=>void)|null=null;

  constructor(private readonly dependencies: MotionPreviewDependencies) {}

  get state(): MotionPreviewState {
    return { ...this.currentState };
  }

  async start(packId: MotionPackId, motion: CatalogMotion, layer: MotionLayer = "pose"): Promise<boolean> {
    if (this.disposed) return false;
    if(this.localCancel)this.invalidate();
    const initial = this.dependencies.getSettings();
    if (!initial.model) {
      this.invalidate();
      throw new Error("请先载入模型，再预览动作。");
    }
    const token = ++this.generation;
    const anchor: PreviewAnchor = {
      model: initial.model.path,
      layers: savedLayers(initial),
    };
    this.anchor = anchor;
    this.layer = layer;
    const selected = { packId, motionId: motion.id, name: motion.name, layer };
    this.publish({ phase: "loading", ...selected });
    try {
      const loaded = await this.dependencies.load(packId, motion.id);
      if (!this.isCurrent(token, anchor)) return this.discard(token);
      await this.enqueue(async () => {
        if (!this.isCurrent(token, anchor)) return;
        // Clearing first also restarts a repeated preview of the exact same VMD URL.
        this.asset = null;
        await this.dependencies.apply(withMotionLayer(this.dependencies.getSettings(), layer, null));
        if (!this.isCurrent(token, anchor)) return;
        this.asset = structuredClone(loaded);
        await this.dependencies.apply(withMotionLayer(this.dependencies.getSettings(), layer, this.asset));
      });
      if (!this.isCurrent(token, anchor)) return this.discard(token);
      this.publish({ phase: "playing", ...selected });
      return true;
    } catch (error) {
      // A later selection/stop/model change owns the UI now, including its error state.
      if (!this.isCurrent(token, anchor)) return this.discard(token);
      const recovery = this.invalidate();
      try {
        await this.enqueue(async () => {
          if (!this.disposed && recovery === this.generation)
            await this.dependencies.apply(this.dependencies.getSettings());
        });
      } catch {
        // Keep the original load/playback failure as the actionable UI error.
      }
      if (this.disposed || recovery !== this.generation) return false;
      throw error;
    }
  }

  /** Reuse this controls preview owner; local clips do not replace a VMD layer or save settings. */
  async startLocal(start:()=>Promise<boolean>,cancel:()=>void,name='原创惊喜试作'):Promise<boolean>{
    if(this.disposed)return false;
    if(this.currentState.phase!=='idle'||this.anchor||this.asset)await this.stop();
    if(this.disposed)return false;
    const settings=this.dependencies.getSettings();
    if(!settings.model)throw Error('请先载入模型，再预览动作。');
    const token=++this.generation,anchor:PreviewAnchor={model:settings.model.path,layers:savedLayers(settings)};
    this.anchor=anchor;this.localCancel=cancel;this.publish({phase:'loading',local:'surprise',name});
    try{
      const ok=await start();
      if(!this.isCurrent(token,anchor))return false;
      if(!ok){this.invalidate();return false;}
      this.publish({phase:'playing',local:'surprise',name});return true;
    }catch(error){if(this.isCurrent(token,anchor))this.invalidate();throw error;}
  }

  finishLocal():void {if(this.localCancel)this.invalidate();}

  async stop(): Promise<void> {
    if (this.disposed) return;
    if(this.localCancel){this.invalidate();await this.applyQueue;return;}
    if (this.currentState.phase === "idle" && !this.anchor && !this.asset) {
      // A first stop or failure may already have queued the saved-motion restore.
      // Repeated stops must wait for it, rather than invalidate its generation.
      await this.applyQueue;
      return;
    }
    const token = this.invalidate();
    await this.enqueue(async () => {
      if (!this.disposed && token === this.generation)
        await this.dependencies.apply(this.dependencies.getSettings());
    });
  }

  /** Apply current settings while replacing just the selected control-window channel. */
  view(settings: AppSettings): AppSettings {
    if (this.disposed || !this.anchor) return settings;
    if (!this.matches(settings, this.anchor)) {
      this.invalidate();
      return settings;
    }
    return this.asset ? withMotionLayer(settings, this.layer, this.asset) : settings;
  }

  dispose(): void {
    if(this.localCancel)this.invalidate();
    this.disposed = true;
    this.generation++;
    this.anchor = null;
    this.asset = null;
    this.currentState = { phase: "idle" };
  }

  private matches(settings: AppSettings, anchor: PreviewAnchor): boolean {
    return settings.model?.path === anchor.model && savedLayers(settings) === anchor.layers;
  }

  private isCurrent(token: number, anchor: PreviewAnchor): boolean {
    return !this.disposed && token === this.generation && this.anchor === anchor &&
      this.matches(this.dependencies.getSettings(), anchor);
  }

  private discard(token: number): false {
    if (!this.disposed && token === this.generation) this.invalidate();
    return false;
  }

  private invalidate(): number {
    const token = ++this.generation;
    const localCancel=this.localCancel;this.localCancel=null;
    this.anchor = null;
    this.asset = null;
    if (this.currentState.phase !== "idle") this.publish({ phase: "idle" });
    localCancel?.();
    return token;
  }

  private publish(state: MotionPreviewState): void {
    this.currentState = state;
    this.dependencies.onState({ ...state });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.applyQueue.then(operation, operation);
    this.applyQueue = pending.catch(() => {});
    return pending;
  }
}
