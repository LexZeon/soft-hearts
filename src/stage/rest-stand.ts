// Her default stand in the companion window, either engine (docs/claude/2026-11-21-window-idle-pose.md; the rule is
// shared/actions/rest-stand.ts). The stage asks the host for the bundled stand only when no pose is picked; the answer is the
// registered asset (or null). A missing method, a failure or no answer within 5 s: null, and she stands as before (the procedural
// breathing idle); the next motion change asks again.
import { getMotionLayerAssets, withRestStand, type RestStandLayers } from '../../shared/actions';
import type { AppSettings, AssetRef } from '../../shared/foundation/settings';

export interface RestStandPort { getRestStand?(): Promise<AssetRef | null> }

const ASK_MS = 5_000;
const isAsset = (value: unknown): value is AssetRef => !!value && typeof value === 'object'
  && typeof (value as AssetRef).url === 'string' && !!(value as AssetRef).url && typeof (value as AssetRef).name === 'string';

/** The host's default stand, or null (never throws, never waits more than 5 s). */
export async function askRestStand(port: RestStandPort | null | undefined, timeoutMs = ASK_MS): Promise<AssetRef | null> {
  if (typeof port?.getRestStand !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([Promise.resolve().then(() => port.getRestStand!()),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    return isAsset(answer) ? answer : null;
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

/** The picked layers, with the default stand in the pose when none is picked (asked only then). */
export async function layersWithRestStand(layers: ReturnType<typeof getMotionLayerAssets>, legacy: boolean, port: RestStandPort | null | undefined): Promise<RestStandLayers> {
  return withRestStand(layers, legacy, layers.pose ? null : await askRestStand(port));
}

/** The companion's settings as her motion layers (getMotionLayerAssets; legacy without motionLayers), with the default stand. */
export function settingsLayersWithRestStand(settings: Pick<AppSettings, 'motion' | 'motionLayers'>, port: RestStandPort | null | undefined): Promise<RestStandLayers> {
  return layersWithRestStand(getMotionLayerAssets(settings), !settings.motionLayers, port);
}
