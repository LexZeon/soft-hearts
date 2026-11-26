/**
 * I-184 close moments (凑近看、亲亲、抱抱 in full-screen Unbound): the public page of the family. A later "抱抱" from chat or a speech
 * marker reuses the same chooser, plan and curves (README.md「以后接」).
 */
export { CLOSE_FRAME_KNOBS, CLOSE_MOMENT_KNOBS, CLOSE_MOMENT_KNOB_RANGES, type CloseMomentKnobs } from './knobs';
// I-203 frames: her let-go and pause in a held moment, the page's report of reaching one, the facts of an interrupted one.
export { HoldFrames, closeCutLine, closeCutParts, parseFrameBeatAsk, pauseSeconds, type CloseCutCause, type CloseCutFacts, type CloseCutFrame, type FrameBeatAsk } from './frames';
export {
  CLOSE_KINDS, CLOSE_BLOCK_WORDS, LABEL_WARMTH, NEUTRAL_TEMPERAMENT, CloseMomentHistory,
  chooseCloseMoment, closeBlock, closeChances, closeReading, closeScores, pickFrom,
  type CloseAct, type CloseBlock, type CloseCapped, type CloseChances, type CloseChoiceInput, type CloseGates, type CloseKind, type CloseReading,
  type CloseRecord, type CloseTemperament, type CloseVia,
} from './chooser';
export { AFTER_BEATS, AFTER_BEAT_WORDS, afterBeatChances, chooseAfterBeat, type AfterBeat } from './after-beat';
export { parseCloseMomentPlan, planCloseMoment, type CloseMomentPlan } from './plan';
export { PuckerGate, REST_CHANNELS, SETTLE_FADE_S, afterTargets, backChannels, backLength, leanChannels, settleChannels, tuckAt, tuckTiming, winkAt, type CloseChannels } from './timeline';
// I-203: her own choices on top of a kiss or a hug (pucker, tuck, blush): closed words, drawn from her mood when her words name none.
export { CLOSE_EXTRAS, chooseCloseExtras, closeExtraChances, parseCloseExtras, type CloseExtra } from './extras';
export { closeMissedLine, closeMomentLine, type CloseHappened, type CloseMissed } from './words';
export { parseDirectorPlan } from './director-plan';
// I-185: her reply's ⟦kiss⟧ / ⟦hug⟧ (chat.ts: the host's answer for full-screen; in-place.ts: the window's in-place one and the lighter hug).
export { CHAT_CLOSE_BLOCKS, CHAT_CLOSE_CALL_BLOCKS, chatCloseBlock, isChatCloseAnswer, parseCloseBeatAsk, type ChatCloseAnswer, type ChatCloseBlock, type ChatCloseKind, type CloseBeatAsk } from './chat';
// 2026-11-25 (16:26): her own hand reach never swallows a kiss / hug she wrote (it lets go); one journal row per one she wrote, once its fate is known.
export { CLOSE_BEAT_ENDS, CLOSE_BEAT_OUTCOMES, closeArmsOf, closeEndWhy, handYieldsTo, type CloseArms, type CloseBeatEnd, type CloseBeatFate, type CloseBeatOutcome, type CloseBeatWhy } from './chat';
export { IN_PLACE, InPlaceClose, NEUTRAL_READING, inPlacePlan, type InPlaceArms, type InPlaceFrame, type InPlacePhase } from './in-place';
