// I-154 follow-up (docs/claude/2026-11-20-unbound-full-shares.md): "her on the Unbound engine", the one set both modes use.
//
// The companion window = this set + a fixed origin + the companion window's framing, inputs and its own permissions (../window-mode/).
// Full-screen Unbound = this set + walking, the world camera, the peek, the permission bundle and the Unbound inputs (../main.ts).
//
// What is shared today. The layers themselves still live where the window batches put them (../window-mode/window-face.ts and its
// neighbours): moving them is a mechanical step left for when no other task edits those files (the record lists the move). Both modes reach
// them through this page; a new layer for both goes here, not into either mode.
//  - face-goals.ts: how her face's goals lay over whoever drives her body (the window's own life, or a peek / her life / a beat / nobody).
//  - head-region.ts: her scalp, mouth and cheeks on screen for the touch input, through either camera.
//  - out-face.ts, out-touch.ts, out-page.ts: the first slice wired for full-screen (her face, touch-head by mood, pinch, the snack mouth).
export { layFace, addRot, type FaceGoals } from './face-goals';
export { headRegion, type HeadAt, type HeadContact, type HeadRegion, type HeadView } from './head-region';
export { HerOutFace, faceLook, glance, type HerFaceBody, type HerFaceEnv, type HerFaceModel, type HerFaceOut } from './out-face';
export { HerOutTouch, type HerMoodApi, type HerTouchPorts } from './out-touch';
export { herGazeDebug } from './gaze-debug'; // I-169: developer mode shows where she looks
export { HerOut, herTouchable, THINKING_MAX_MS, type HerOutApi, type HerOutPorts } from './out-page';
export { cardOf, heldUpdate, holdView, type CardProfile, type HeldRecord } from './model-card';
// The window batches' layers this set is made of (shared; they live in ../window-mode/ for now).
export { WindowFace, NEUTRAL_GAZE, type WindowFaceEnv, type WindowFaceFrame, type WindowFaceGaze } from '../window-mode/window-face';
export { windowFaceRig, slotBindings, faceBlocks, NO_FACE_BLOCKS, type WindowFaceRig } from '../window-mode/window-face-rig';
export { WindowBlushState, pinchCheeks, type WindowBlush } from '../window-mode/window-blush';
export { WindowLife, WINDOW_LOOK, WINDOW_BLINK, WINDOW_PAT } from '../window-mode/window-life';
export { WindowCrying, windowTearsGate } from '../window-mode/window-tears';
export { measureWindowModel, eyeBones, type WindowModelMeasure } from '../window-mode/window-model';
