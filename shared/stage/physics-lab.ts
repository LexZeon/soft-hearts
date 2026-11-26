/**
 * R01 物理调参台: the lab window's whole IPC surface (fixed `physics-lab:` channels, plain values). The page gets the current
 * model's asset URL (the same mmd-asset:// grant the companion uses, never a path), the companion's physics switches, and this model's saved
 * tuning; it can save or remove that tuning. The host decides which model (the active one) and keys it by content hash.
 */
import type { ModelPhysicsSettings } from './model-physics';
import type { ModelPhysicsTuning } from './physics-tuning';

export const PHYSICS_LAB_REQUESTS = Object.freeze({
  model: 'physics-lab:model',
  save: 'physics-lab:save',
  clear: 'physics-lab:clear',
} as const);

export const PHYSICS_LAB_EVENTS = Object.freeze({
  /** The active model or its tuning changed (another save, a model switch). */
  changed: 'physics-lab:changed',
} as const);

export interface PhysicsLabModel {
  /** The active model's mmd-asset:// URL, or null when no model is set. */
  modelUrl: string | null;
  /** The companion's switches and quality (without a tuning). */
  settings: ModelPhysicsSettings;
  /** This model's saved tuning, or null (the companion runs as without the lab). */
  tuning: ModelPhysicsTuning | null;
}

export interface PhysicsLabApi {
  getModel(): Promise<PhysicsLabModel>;
  /** "保存为这个模型的设置": validated and clamped on the host; returns what was stored. */
  save(tuning: ModelPhysicsTuning): Promise<ModelPhysicsTuning>;
  /** "恢复原样": true when a saved tuning was removed. */
  clear(): Promise<boolean>;
  onChanged(callback: () => void): () => void;
}

export const PHYSICS_LAB_API_KEYS = Object.freeze(['getModel', 'save', 'clear', 'onChanged'] as const);
