/**
 * How main.ts ties the camera's 「姿势识别」 switch to local pose sensing, kept free of Electron so it can be tested.
 *
 * 2026-11-03 (user, stable build): "摄像头共享无法打开" — clicking the pet's camera button seemed to do nothing.
 * The packaged host was fine; the refusal only showed in the control window. Two rules follow:
 *  - the window that asked always gets a reason back (electron/runtime.ts → `cameraRefused`) and shows it;
 *  - if local sensing could not be built at all, 「姿势识别」 is refused as "unavailable".
 *
 * I-036 replaces the 2026-11-03
 * decision that pictures stay on this computer: the camera is now two independent switches, 「发图片」 (small pictures with each
 * message, no download) and 「姿势识别」 (this local sensing, which still never sends a picture). A refused 「姿势识别」 never turns
 * 「发图片」 on in its place; that one only the user turns on.
 */
import type { CameraRefusal } from '../../shared/contracts';
import type { CameraPolicy, MediaOwner } from '../runtime';

export interface CameraGateHost {
  cameraMode(): 'local' | 'share' | 'blocked';
  cameraBlocked(owner: MediaOwner): CameraRefusal;
}

export function poseCameraPolicy(host: () => CameraGateHost | null): CameraPolicy {
  return {
    mode: () => host()?.cameraMode() ?? 'blocked',
    blocked: owner => host()?.cameraBlocked(owner) ?? 'unavailable',
  };
}

/** Build the pose host without letting any failure stop the app; on failure 「姿势识别」 stays refused. */
export function buildPoseSensing<T>(create: () => T, report: (error: unknown) => void): T | null {
  try { return create(); } catch (error) { report(error); return null; }
}
