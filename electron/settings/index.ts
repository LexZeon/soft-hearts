// 设置和控制窗口框架 (part 1), host side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside electron/settings/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part settings`).
// This part was carved out of the old core (主干) on 2026-11-16 (docs/claude/2026-11-16-overhaul-parts-4.md). Keys stay in the host:
// the settings store encrypts them with the system's secure storage; this page only re-exports.

// The settings store, keys and what the windows may see of the settings.
export { publicSettings, resolveVoiceInputKey, SettingsStore } from './settings';
export type { SecretStorage } from './settings';
// Checking what arrives over IPC: settings, providers, chat requests, voice input, asset baselines.
export { preserveStaleAssetClears, validateAssetBaseline, validateChatRequest, validateProvider, validateSettings, validateVoiceInput } from './validation';
// Click-through keeps the user's setting; showing or hiding her never changes it (I-223).
export { clickThroughChange, noteClickThrough, rescueFromTray, toggledVisibility, trayRescue } from './click-through';
export type { ClickThroughJournal, ClickThroughVia } from './click-through';
// The interface language the user chose.
export { UiLanguageStore } from './ui-language';
export { applyFirstLanguageHint } from './first-language-hint'; // I-219: the first-install language hint
// Words in chat that change app settings: classifying them, the confirming turn, applying them.
export { classifyCompanionCommand, formatCompanionCommandReceipt } from './companion-command-intent';
export { createCommandDialogueTurn } from './companion-command-dialogue';
export { CompanionCommandHost } from './companion-command-host';
export type { CommandCommitResult, CompanionCommandTicket } from './companion-command-host';
