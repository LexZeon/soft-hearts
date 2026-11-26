// 她主动做的事 (part 8), host side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8; the layer check counts any other way in as debt). Files inside electron/initiative/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part initiative`).
// The part's wiring modules (give/, hands/, impulse/, rps/, self-look/ wiring.ts, her-folder/keepsake-wiring.ts) are wiring:
// electron/main.ts imports them directly. electron/brain/opening-host.ts belongs to 大脑 and stays outside this folder.

// Her inner loop: the host the wiring creates, the loop (test commands drive it), who owns a mood cue, the claim view.
export { createInnerLoopHost } from './inner-loop/host';
export { InnerLoop } from './inner-loop/inner-loop';
export { claimedView } from './inner-loop/claim';
export type { MoodCueOwner } from './inner-loop/claim';
// The small model call several parts share (one quick line from Claude, the inner loop's model) and the warm line reactions use.
export { INNER_LOOP_MODEL, quickLineWithClaude } from './inner-loop/model';
export type { InnerLoopStream } from './inner-loop/model';
export { WARM_LINE_DEFAULTS, WarmLine } from './inner-loop/warm-line';
export type { WarmLineOptions } from './inner-loop/warm-line';
// Whether she may start talking on her own, and the interaction budget (I-010) chat spends from.
export { ProactiveSpeechGate } from './proactive-speech-gate';
export { InteractionBudgetHost, openingBudget } from './interaction-budget/host';
export type { InteractionBudgetHostOptions } from './interaction-budget/host';
// Her folder, rock-paper-scissors, the surprise preview, taking the user to a page, and the R20 task offers she makes.
export { HerFolderHost } from './her-folder/host';
export { RpsHost } from './rps/host';
export type { RpsJournalEntry } from './rps/host';
export { SurprisePreviewHost } from './surprise-preview-host';
export { TakeMeThere } from './take-me-there';
export type { TakeMeThereTurn } from './take-me-there';
export { buildR20OfferPrompt } from './r20-offer-dialogue';
export { R20ProactiveOffers } from './r20-proactive-offer';
export { MomentHost } from './moments/host'; // I-188 她认出的时刻
export type { MomentClaim, MomentHostPorts, MomentJournalRow } from './moments/host';
export { MomentStateStore } from './moments/state-store';
export { ReminderStore } from './moments/reminder-store';
export { AlarmStore } from './moments/alarm-store'; // I-195 her own alarms (the same file as the reminders)
export { AlarmSwitch } from './moments/alarm-switch';
export { HerAlarms } from './moments/alarms';
