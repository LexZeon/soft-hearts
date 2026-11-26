/**
 * The companion's motion layers as the window engine plays them (docs/claude/2026-11-21-window-idle-pose.md). No pose picked (no motion,
 * the pose cleared, or a newly loaded model, whose motion the host clears): her default stand, exactly as full-screen Unbound has had since
 * 2026-11-15 (electron/unbound/source.ts withRestPose). Before, the window showed the model's rest pose with only the arms-down residual
 * (arms spread down and out, elbows straight), while full-screen showed the stand. The default stand failing to load leaves her without it; a picked layer failing still fails the change.
 * Nothing here touches the DOM: tests/window-idle-pose.test.ts runs it with the real clips on the public Gene and a synthetic VRM.
 */
import type { AnimationClip } from 'three';
import { getMotionLayerAssets } from '../../../shared/actions';
import type { AppSettings, AssetRef } from '../../../shared/foundation/settings';
import { layersWithRestStand, type RestStandPort } from '../../stage';

export interface WindowMotionClips {
  clips: { pose: AnimationClip | null; gesture: AnimationClip | null; expression: AnimationClip | null };
  legacy: boolean;
  /** The pose is her default stand (not "a picked pose" for her own motions, as full-screen's rest). */
  rest: boolean;
  pose: AssetRef | null;
}

export async function windowMotionClips(settings: Pick<AppSettings, 'motion' | 'motionLayers'>, host: RestStandPort,
  load: (url: string) => Promise<AnimationClip>): Promise<WindowMotionClips> {
  const { layers, legacy, rest } = await layersWithRestStand(getMotionLayerAssets(settings), !settings.motionLayers, host);
  const urls = [layers.pose?.url, layers.gesture?.url, legacy ? undefined : layers.expression?.url];
  const [pose, gesture, expression] = await Promise.all(urls.map((url, layer) => url
    ? load(url).catch(error => { if (rest && layer === 0) return null; throw error; }) : Promise.resolve(null)));
  return { clips: { pose, gesture, expression }, legacy, rest, pose: layers.pose };
}
