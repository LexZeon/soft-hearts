/** Unbound U1: what the companion shows now, as the Unbound window may see it (asset URLs only; AssetRef.path never leaves the host). */
import { getMotionLayerAssets } from '../../shared/actions';
import type { AppSettings } from '../../shared/foundation/settings';
import type { ModelPhysicsSettings } from '../../shared/stage';
import type { UnboundMotion } from '../../shared/unbound/scene';

export interface UnboundSource { modelUrl: string | null; motion: UnboundMotion; breath: number; physics: ModelPhysicsSettings | null }

export function unboundSource(settings: Pick<AppSettings, 'model' | 'motion' | 'motionLayers' | 'pet'>, physics: ModelPhysicsSettings | null | undefined): UnboundSource {
  const layers = getMotionLayerAssets(settings);
  const breath = Number(settings.pet?.breath);
  return {
    modelUrl: settings.model?.url ?? null,
    motion: { pose: layers.pose?.url ?? null, gesture: layers.gesture?.url ?? null, expression: layers.expression?.url ?? null, legacy: !settings.motionLayers },
    breath: Number.isFinite(breath) ? Math.min(1, Math.max(0, breath)) : 0.5,
    physics: physics ?? null,
  };
}

/**
 * Her default stand (docs/claude/2026-11-15-unbound-own-model.md): when the companion has no pose layer (no motion picked, or the pose
 * cleared), Unbound would show the model's bind pose, standing stock still. The bundled stand pose (`rest`, the bundled Gene's
 * stand.vmd, registered by the host) is given as her pose instead, body tracks only (the layered, non-legacy mode, so it never
 * owns her face); a picked gesture or expression layer stays. A picked pose always wins. Without a rest URL nothing changes.
 */
export function withRestPose(motion: UnboundMotion, rest: string | null | undefined): UnboundMotion {
  if (motion.pose || !rest) return { ...motion };
  // Legacy settings without a motion have no gesture or expression either (getMotionLayerAssets).
  return { pose: null, gesture: motion.legacy ? null : motion.gesture, expression: motion.legacy ? null : motion.expression, legacy: false, rest };
}
