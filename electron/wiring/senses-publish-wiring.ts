// 感知's mood-publish step (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md), moved from electron/main.ts unchanged:
// electron/wiring/mood-wiring.ts publishMood runs it in the order electron/main.ts gives wireMoodPublish (the wiring golden pins it).
// The line is the old one word for word: noteVisionUserActivity (感知's wire call provides it) is bound by wireSensesPublish, which
// electron/main.ts calls before wireMoodPublish.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { MoodView } from '../../shared/mood';

/** What the step reads that only electron/main.ts has (the part table gives it; called when the step runs). */
export interface SensesPublishNeeds {
  noteVisionUserActivity(): void;
}
let noteVisionUserActivity!: () => void;

export function wireSensesPublish(needs: SensesPublishNeeds): void {
  noteVisionUserActivity = () => needs.noteVisionUserActivity();
}

/** Mood publish step (感知): anything but idle counts as the user being with her. */
export function publishVisionActivity(view: MoodView): void {
  if (view.snapshot.phase !== 'idle') noteVisionUserActivity();
}
