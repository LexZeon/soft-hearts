// 设置和控制窗口框架 (part 1), window side: the public page. Other parts and the wiring import this part only through this file (overhaul
// plan section 8). Files inside src/settings/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part settings`). The two
// stylesheets (style.css, ui-language.css) are imported directly by src/main.ts.
// Not here: layout.ts (renderControls) and CompanionCommandChoices.ts import stylesheets themselves, so through this page every module
// that reaches it (src/initiative/TakeMeThere.ts) would stop loading in the node tests; only src/main.ts uses them, directly.

// The control window frame: navigation, layout, notices.
export { CONTROL_PAGE_TITLES, ControlNavigation } from './ControlNavigation';
export type { ControlNavigationLocation } from './ControlNavigation';
export { CONTROL_NAVIGATION, isNavigationGroup } from './control-navigation-state';
export type { ControlNavigationLeaf, ControlNavigationNode } from './control-navigation-state';
export { cameraRefusalAction, conciseFailure, NOTICE_ACTIONS, readingRefusalAction, voiceFailureAction, voiceRefusalAction, voiceUnheardLine } from './notice-policy';
export type { NoticeAction } from './notice-policy';
// Keeping edits made while a save is pending.
export { mergeSettings } from './settings-merge';
// A settings change made while a window is still starting is not lost (2026-11-25).
export { settingsStartup } from './startup-updates';
export type { SettingsStartup } from './startup-updates';
