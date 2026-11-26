// Her default stand on every stage (docs/claude/2026-11-21-window-idle-pose.md). When the companion has no pose layer (no motion
// picked, the pose cleared, or a newly loaded model, whose motion the host clears), she stands in the bundled stand pose (the
// bundled Gene's stand.vmd, which the host registers and hands out as `rest`), body tracks only (the layered, non-legacy mode, so it
// never owns her face); a picked gesture or expression layer stays. A picked pose always wins. Without a rest asset nothing changes.
//
// Full-screen Unbound has had this since 2026-11-15 (electron/unbound/source.ts withRestPose, on URLs); the companion window, with
// either engine, uses this one.
import type { AssetRef } from '../foundation/settings';
import type { MotionLayerAssets } from './motion-layers';

export interface RestStandLayers {
  layers: MotionLayerAssets;
  legacy: boolean;
  /** Her pose is the default stand (not a picked pose: the companion's rule for its reviewed default stand). */
  rest: boolean;
}

export function withRestStand(layers: MotionLayerAssets, legacy: boolean, rest: AssetRef | null | undefined): RestStandLayers {
  if (layers.pose || !rest) return { layers: { ...layers }, legacy, rest: false };
  // Legacy settings without a motion have no gesture or expression either (getMotionLayerAssets).
  return { layers: { pose: rest, gesture: legacy ? null : layers.gesture, expression: legacy ? null : layers.expression }, legacy: false, rest: true };
}
