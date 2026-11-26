// 她主动做的事 (part 8), window side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8). Files inside src/initiative/ import each other directly; stylesheets are imported by path (side effects, not this page).
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part initiative`).

// Feeding: the cue player and its choice, prefetch and decoding (the call reuses the decoder), the line, the snack, the speech pause.
export { ChosenFeedCues } from './feed-cue-choice';
export { decodeCue, FeedCuePlayer } from './feed-cue-player';
export { FeedCuePrefetch } from './feed-cue-prefetch';
export { FeedLinePresenter } from './feed-line';
export { FeedSnackClient } from './feed-snack';
export { FeedSpeechPause } from './feed-speech-pause';
// Giving and holding hands: the overlays (control window) and the stage layers (companion window).
export { GiveOverlay } from './GiveOverlay';
export { GivePerformance } from './give-performance';
export type { GivePort, GiveStageCue, GiveStageOutcome } from './give-performance';
export { renderGivePicture } from './give-picture';
export { HandsOverlay } from './HandsOverlay';
export { HandsStageLayer } from './hands-stage';
export type { HandReachCue, HandReachState } from './hand-reach';
// I-154 batch 4: the performers' arms as designs for the window engine's arm reach (src/unbound/window-mode/window-games.ts).
export type { PerformerArmAim, PerformerHandShape } from './arm-aim';
// Her own actions on the stage.
export { HerActionPlayer } from './her-action';
// Her folder panel and notes; the inner loop section of the mood panel.
export { HerFolderNotes, HerFolderPanel } from './HerFolderPanel';
export { defaultInnerLoopSource, InnerLoopSection } from './inner-loop-panel';
export type { InnerLoopPanelSource } from './inner-loop-panel';
// R20 task offers she makes.
export { ProactiveAgentOffer } from './ProactiveAgentOffer';
// Rock-paper-scissors: the overlay, the stage performance and its rig (the pose reactions reuse the rig and the min-jerk curve),
// and the ports for saying her lines.
export { petSayPorts, RpsOverlay } from './RpsOverlay';
export { alignTwo, buildRpsRig, MinJerk, RpsPerformance, rpsStageCue } from './rps-performance';
export type { RpsPort, RpsRig } from './rps-performance';
export type { RpsSayPorts } from './rps-speech';
export { shownRects } from './rps-layout'; // the boxes her bubbles take, so the buttons keep clear of them (companion window and full-screen Unbound page)
export type { LayoutRect } from './rps-layout';
// Looking at herself, and taking the user to a page.
export { SelfLookMark } from './SelfLookMark';
export { flashTarget, takeMeThereFocusElement, takeMeThereLeaf, TakeMeThereOffers } from './TakeMeThere';
