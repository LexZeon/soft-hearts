import type { AppSettings, AssetRef, AssetSaveBaseline } from "./contracts";

export type MotionLayer = "pose" | "gesture" | "expression";
export interface MotionLayerAssets {
  pose: AssetRef | null;
  gesture: AssetRef | null;
  expression: AssetRef | null;
}

export function isMotionLayer(value: unknown): value is MotionLayer {
  return value === "pose" || value === "gesture" || value === "expression";
}

/** A legacy full VMD continues to supply both body and expression until separated. */
export function getMotionLayerAssets(settings: Pick<AppSettings, "motion" | "motionLayers">): MotionLayerAssets {
  return {
    pose: settings.motion,
    gesture: settings.motionLayers?.gesture ?? null,
    expression: settings.motionLayers ? settings.motionLayers.expression : settings.motion,
  };
}

/** Explicit edits separate channels while retaining the legacy clip's facial content. */
export function withMotionLayer(settings: AppSettings, layer: MotionLayer, asset: AssetRef | null): AppSettings {
  const layers = getMotionLayerAssets(settings);
  layers[layer] = asset;
  return { ...settings, motion: layers.pose, motionLayers: { gesture: layers.gesture, expression: layers.expression } };
}

export function motionAssetBaseline(settings: Pick<AppSettings, "model" | "motion" | "motionLayers">): AssetSaveBaseline {
  return {
    model: settings.model?.path ?? null,
    motion: settings.motion?.path ?? null,
    ...(settings.motionLayers ? { motionLayers: {
      gesture: settings.motionLayers.gesture?.path ?? null,
      expression: settings.motionLayers.expression?.path ?? null,
    } } : {}),
  };
}
