/**
 * R29b: which renderer states gate the stage's automatic behaviour, and how.
 *
 * - Adjusting the presentation (camera edit, window move/resize, a controls
 *   preview) blocks automatic behaviour: setBehaviorBlocked.
 * - Click-through is not an adjustment.
 *   She keeps breathing, idling and dancing; touch is already off because the
 *   window ignores the mouse (canInteract excludes click-through).
 * - Typing (IME composition in the chat box) is not an adjustment. It only
 *   pauses NEW automatic behaviour (a chat gesture is consumed with its own
 *   fade, automatic body motion waits) while the living base keeps running:
 *   breathing, gaze and idle life, the music dance, face states. It used to be
 *   folded into the blocked gate, which suppressed the music dance and every
 *   idle-life primitive the moment the first IME keystroke arrived ("定住").
 */
export interface BehaviorGateInputs {
  cameraEditing: boolean;
  composing: boolean;
  windowInteraction: boolean;
  clickThrough: boolean;
  preview: boolean;
}
export interface BehaviorGateTarget {
  setBehaviorBlocked(blocked: boolean): void;
  setTyping(active: boolean): void;
}

export function applyBehaviorGates(stage: BehaviorGateTarget | null | undefined, inputs: BehaviorGateInputs): void {
  stage?.setBehaviorBlocked(inputs.cameraEditing || inputs.windowInteraction || inputs.preview);
  stage?.setTyping(inputs.composing);
}
