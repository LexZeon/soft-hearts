// 身体动作 (part 12), host side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside electron/actions/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part actions`).
// This part was carved out of the old core (主干) on 2026-11-16 (docs/claude/2026-11-16-overhaul-parts-4.md). Pose, gesture and
// expression stay separate channels; nothing here changes PMX or VMD bytes.

// The motion library, its weights, fits, tags and track coverage.
export { MotionLibrary } from './motion-library';
export { MotionWeightStore } from './motion-weights';
export { MotionFitStore } from './motion-fit-store';
export { unverifiedCatalogHostSnapshot } from './motion-tag-consumer';
export { MotionTrackCoverageHost } from './motion-track-coverage';
// Body motion (automatic small movements) and behaviour motion (faces and recipes): controllers, bindings, start-up profile, access.
export { BodyMotionController } from './body-motion';
export type { BodyMotionHostGates } from './body-motion';
export { resolveBodyMotionResource } from './body-motion-bindings';
export { selectBodyStartupProfile } from './body-motion-qa';
export { BodyMotionAccess } from './body-motion-access';
export { BehaviorMotionController } from './behavior-motion';
export type { BehaviorBindingSource } from './behavior-motion';
export { resolveBehaviorMotionResource } from './behavior-motion-bindings';
// Gestures while chatting, and her own actions.
export { chatGestureDurationMs, resolveChatGestureResource } from './chat-gesture';
export { HerActionHost } from './her-action-host';
