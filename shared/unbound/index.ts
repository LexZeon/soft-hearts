// Unbound (part 7), shared half: the public page. Other parts, the wiring and the contract import Unbound only through this file
// (overhaul plan section 8). Files inside shared/unbound/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part unbound`).

// What she senses in Unbound, built from the app's state (the wiring).
export { sensesFrom } from './senses';
// The control window's Unbound switch: its view and patch (wire types the contract names).
export type { UnboundControlPatch, UnboundControlView } from './scene';
// Batches D, F: while she is out, the companion window's facts of her full-screen kinds are not taken (each line once).
export { companionFactAllowed, type HerFactKind } from './sense-relay';
