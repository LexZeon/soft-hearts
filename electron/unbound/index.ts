// Unbound (part 7), host side: the public page. Other parts and the wiring import Unbound only through this file (overhaul plan
// section 8; the layer check counts any other way in as debt). Files inside electron/unbound/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part unbound`). The
// entry and typing wiring (entry-wiring.ts, typing-wiring.ts) are wiring: electron/main.ts imports them directly.

// The Unbound window's host and where its page comes from (created by the wiring).
export { createUnboundHost, createUnboundStage, stageOf, unboundSource, type StageCharacterWiring } from './electron-host';
// I-209 step 3: the stage coordinator (each character her own full screen) and the first one's key on it.
export { CompanyStage, MAIN_KEY } from './company/stage';
export { UnboundHost } from './host';
// The read-aloud proof surface the wiring hands to the reply window.
export type { ReplyProofSurface } from './read-aloud';
// I-165: what her full-screen bubble reads of the reading plan (the wiring connects it) while it follows her voice.
export type { BubbleHoldPlan } from './bubble-hold';
export { applyReadPause, readPauseOf } from './bubble-hold';
// Whether a window was seen while she held it (the agent channel's wiring).
export { seenWhileHeld } from './held-window';
// Step 4: what she noticed of you while out (the interaction history the chat Claude is told), and her mood as movement reads it.
export { UnboundHistory, CONDENSE_SYSTEM, type HistoryPorts } from './history-host';
export { peekMoodFrom } from './peek';
export { CLOSE_SEQUENCE_CAPS, CloseBeatSequence, type CloseBeatGate, type CloseCutEvent } from './close-sequence'; // 2026-11-23 / I-203: her words wait only at the frames she placed
export { CLOSE_CUT_TIMING, CloseCutNotice } from './close-cut'; // I-203: an interrupted kiss / hug of her reply: one immediate turn with the facts, or the next chat turn
export { BeatSituation, beatCardOf, type BeatSituationReads } from './beat-situation'; // I-185: what she can do now, for her turn's marker words
// The small input box's 打电话 / 挂断 button: the port the voice wiring connects (docs/claude/2026-11-19-unbound-call-button.md).
export { inputCallPort } from './input-call';
// Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): the name her voice's facts are relayed under to her full-screen window.
export { SPEECH_FACE_RELAY } from './mood-bridge';
// Batch C: whose answer to one of her actions counts (out: her full-screen window's; at home: the companion window's), and her motions' ports.
export { herActionAnswerCounts, motionsOut, type UnboundMotionPorts } from './motion-bridge';
// Batch B: her games out here (猜拳, 递东西, 牵手): the game hosts' methods the initiative wiring connects (docs/claude/2026-11-21-unbound-full-BG.md).
export type { UnboundGamesPorts } from './games-bridge';
export { GameLineRelay, gameLineGuard, readGameLine } from './game-line'; // her game lines out in Unbound: held in her bubble, read by the companion window (2026-11-25)
export type { GameLinePorts } from './game-line';
// Batches D, F (docs/claude/2026-11-21-unbound-full-D.md): the names the wiring relays her senses under, and where her facts about them go.
export { SENSE_RELAY, type UnboundSensePorts } from './sense-bridge';
// I-209 step 1: the others on stage read the card store and the asset registry through these (electron/unbound/company/ports.ts).
export { companyPorts, type CompanyCardSource, type CompanyModelSource } from './company/ports';
// I-212: her hidden ⟪keep-place⟫ / ⟪clear-place⟫ in her reply to the user set or clear the default place (the chat turn's wiring reads them).
export { applyPlaceMark, type PlaceMarkRow } from './place-marks';
