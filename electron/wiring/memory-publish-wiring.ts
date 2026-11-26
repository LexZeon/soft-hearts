// 记忆's mood-publish step (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md), moved from electron/main.ts unchanged:
// electron/wiring/mood-wiring.ts publishMood runs it in the order electron/main.ts gives wireMoodPublish (the wiring golden pins it).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { textMemorialHost } from './memory-wiring';

/** Mood publish step (记忆): text memorials follow her. */
export function publishMemorials(): void {
  textMemorialHost?.sync();
}
