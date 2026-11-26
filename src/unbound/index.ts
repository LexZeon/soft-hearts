// Unbound (part 7), window side: the public page. Other parts and the wiring import Unbound only through this file (overhaul plan
// section 8). Files inside src/unbound/ import each other directly; the Unbound window's own pages (index.html -> main.ts,
// input.html -> input.ts, showcase/) are separate entries of the build, not imported.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part unbound`).

// The control window's way in: the 「让她出来 / 回到小窗」 button and the Unbound switch (used by the mood companion panel).
export { UnboundEntryButton } from './unbound-entry-button';
export { UnboundSwitch } from './control-switch';
export type { UnboundControlApi } from './control-switch';
