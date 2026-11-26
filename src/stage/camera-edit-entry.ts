/**
 * The 「调整镜头」 button's entry (both windows): ask the stage to start or stop camera editing, then check it really did, so a stage that
 * cannot (hidden, not ready, an engine without it) is never met with silence (2026-11-19: the Unbound window stage ignored it and the
 * button did nothing). Pure; the wiring passes the stage, the current state and the one place that says things to the user.
 */
import { uiText } from '../foundation/ui-language';

export const CAMERA_EDIT_UNAVAILABLE = '现在进不了镜头调整：桌宠没有显示，或模型还在准备。等她出现后再点一次。';

export function requestCameraEdit(stage: { setCameraEditMode(enabled: boolean): void }, editing: () => boolean, enabled: boolean | undefined, say: (message: string) => void): void {
  const want = enabled ?? !editing();
  try { stage.setCameraEditMode(want); } catch { say(uiText(CAMERA_EDIT_UNAVAILABLE)); return; }
  if (want && !editing()) say(uiText(CAMERA_EDIT_UNAVAILABLE));
}
