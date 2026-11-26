// The I-139 texts moved to shared/foundation/i139-texts.ts (wiring rewrite step 1, docs/claude/2026-11-16-wiring-steps-0-2.md).
// This one type re-export stays so electron/brain/claude.ts (the companion chat's Claude call, kept byte for byte through the
// rewrite) still compiles unchanged. New code imports from the foundation file.
export type { I139Language } from '../foundation/i139-texts';
