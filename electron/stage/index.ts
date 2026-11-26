// 舞台：桌宠画面 (part 2), host side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside electron/stage/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part stage`).
// single-emoji-preload.ts is its own bundle entry (the single-emoji window's preload) and is not here.
// single-emoji-window.ts is not here: it loads electron's BrowserWindow, ipcMain and screen at import time, which the node tests' electron
// stub does not have (every test reaching this page failed to load); only electron/main.ts uses it, directly.

// The companion window: placement, size and recovery, staying on top, dragging, pointer input, the window settings, restoring after a restart.
export { initialPetPosition } from './pet-placement';
export { fittedPetScale, petRecovery, petViewSettings, scaledPetBounds, sizedPetBounds } from './pet-view';
export { applyPetTopmost, PET_TOPMOST_LEVEL, PetTopmostGuard, raisePet } from './pet-topmost'; // no-pet-ok: the existing module and names (raisePet added for I-199)
export { PetWindowDrag } from './pet-window-drag';
export { PetPointerInput } from './pet-pointer-input';
export { applyPetWindowSettings, keepPetInWorkArea } from './pet-window-settings';
export { PetPresentation } from './pet-restore';
export { PetFramingHost } from './pet-framing';
export { CompanionStepAside, protectedRegion, shownWindowRect } from './companion-step-aside'; // T-253: stepping aside from the control window's input area
// Her own life (what she is doing today) and the motions it may play.
export { HerLifeHost } from './her-life/host';
export { herLifeMotionAllowed, resolveHerLifeMotionResource } from './her-life/motion-resource';
// The model: capabilities and their previews, physics settings, the profile cache.
export { CapabilityPreviewRelay, ModelCapabilityHost } from './model-capability-host';
export { ModelCapabilityStore } from './model-capability-store';
export { ModelPhysicsSettingsStore } from './model-physics-settings';
export { ModelProfileStore } from './model-profile-store';
// Personalising her body and look, and the expression preview.
export { PersonalizeBodyAuthoring } from './personalize-body-authoring';
export { PersonalizeBodyStore } from './personalize-body-store';
export { bodyBindingForProfile } from './personalize-body-tweak';
export { PersonalizeVisualAuthoring } from './personalize-visual-authoring';
export { relayExpressionPreview } from './expression-preview-host';
// The single-emoji window.
export { registerSingleEmojiControls } from './single-emoji-controls-host';
export { SingleEmojiCues } from './single-emoji-cues';
export { EmojiSettingsStore } from './single-emoji-settings';
