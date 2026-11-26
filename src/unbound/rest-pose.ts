/**
 * Her pose clip in Unbound (docs/claude/2026-11-15-unbound-own-model.md): the companion's pose layer when it has one, else her default
 * stand (UnboundMotion.rest, the bundled stand pose the host offers; electron/unbound/source.ts withRestPose). It goes through the
 * same loader as any pose, so on a model that is not the reviewed Gene it gets the same motion fitting (StageMotionRetarget) as a
 * library motion in the companion. A picked pose that fails to load fails as before; the default stand failing only leaves her without
 * it (the arms-down residual and breath, as before this fix) and never stops her from coming out.
 *
 * I-174 item 4 (docs/claude/2026-11-21-i174-parity-fixes.md): one `isRestPose` for both stages. Before, the window counted a picked pose
 * that is the reviewed bundled stand (checked by its bytes) as rest, while full-screen counted only "no pose picked" as rest, so picking
 * stand.vmd by hand held her own motions back out in full-screen but not in the window.
 */
import { isDefaultPoseCandidateName } from '../stage';
import type { UnboundMotion } from '../../shared/unbound/scene';

export function loadPoseClip<T>(motion: UnboundMotion, load: (url: string) => Promise<T>): Promise<T | null> {
  if (motion.pose) return load(motion.pose);
  if (motion.rest) return load(motion.rest).catch(() => null);
  return Promise.resolve(null);
}

/** The file name at the end of a pose URL ('' when it is not a URL). */
function fileNameOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname).split('/').at(-1) ?? ''; } catch { return ''; }
}

/**
 * Is her pose "rest" (her default stand, not a picked pose that holds her own motions back)? True when nothing is picked (`picked` null:
 * the default stand or no pose at all) or `injected` (the pose is the default stand the host or the window put in); a picked pose is rest
 * only when it is the reviewed bundled stand, checked by its exact bytes (`reviewed`: src/stage/default-pose.ts isReviewedDefaultPose,
 * usually through a cache). The name is only a cheap prefilter; any failure of the check reads as "picked".
 */
export function isRestPose(pose: { picked: string | null; injected: boolean }, reviewed: (url: string) => Promise<boolean>): Promise<boolean> {
  if (pose.injected || !pose.picked) return Promise.resolve(true);
  if (!isDefaultPoseCandidateName(fileNameOf(pose.picked))) return Promise.resolve(false);
  try { return reviewed(pose.picked).then(value => value === true, () => false); } catch { return Promise.resolve(false); }
}
