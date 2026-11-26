// 身体动作 (part 12), window side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8). Files inside src/actions/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part actions`).
// Not here: MotionLibrary.ts (MotionLibraryControls) imports its stylesheet itself, so through this page every module that reaches it
// would stop loading in the node tests; only src/main.ts uses it, directly. motion-library.css is imported by MotionLibrary.ts.

// Previewing a motion on the stage from the motion library.
export { MotionPreviewSession } from './motion-preview';
// I-154: fitting library motions to a model that is not the reviewed Gene, for Unbound's engine in the companion window (src/unbound/window-mode/).
export { StageMotionRetarget } from './motion-retarget';
// I-154 batch 7: the fit check's stored scores and its scan in the control window's preview on that engine.
export { motionFitStorage, type MotionFitView } from './motion-retarget';
