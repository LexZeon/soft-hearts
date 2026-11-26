// 设置和控制窗口框架 (part 1), shared half: the public page. Other parts, the wiring and the contract import this part only through this
// file (overhaul plan section 8). Files inside shared/settings/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part settings`).
// defaults.ts holds CLAUDE_MODEL_ALIASES, one of the brain-interface places (docs/claude/brain-interface.md).

// The default settings and the Claude model aliases offered in the model field.
export { CLAUDE_MODEL_ALIASES, DEFAULT_SETTINGS } from '../foundation/defaults';
// The capability table and its handbook (what the settings assistant and the agent channel can read and change).
export { CAPABILITIES } from './capabilities';
export type { CapabilityEntry } from './capabilities';
export { handbookCategory, handbookIndex, isCapabilityCategory } from './capability-handbook';
// Companion commands: the wire types.
export type { CompanionCommandAction, CompanionCommandChoiceRequest, CompanionCommandIntentInput, CompanionCommandView } from './companion-commands';
