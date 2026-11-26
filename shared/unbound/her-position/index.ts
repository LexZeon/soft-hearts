/** I-193 / I-211 / I-212: where she stands as a line for her turn, and her "go where" words (the public page of the part, README.md). */
export { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';
export { herPosition, herPositionLine, type HerPosition, type HerPositionFacts, type HerPositionLanguage, type HerRange, type HerSide } from './words';
export { SEEN_WORDS, herSeen, type HerSeen, type HerSeenView } from './seen';
export { PLACE_MARK_WORDS, placeMarkOf, placeMarkWordsLine, type PlaceMarkWord } from './marks';
export { GO_TARGET_MAX, GO_WORDS, goTargetOf, isGoBeatAnswer, isGoWord, parseGoBeatAsk, type GoBeatAnswer, type GoBeatAsk, type GoTarget, type GoWord } from './ask';
export { GO_WAIT_MS, goBlock, interruptsGoWalk, type GoBlock, type GoGates } from './gates';
export { GO_ACROSS, GO_SIZE, alreadyThere, goDecide, goSpot, nearestGoSize, type GoDrives, type GoInput, type GoResult } from './go';
export { chosenSpotOpen, chosenSpotUntil } from './keep';
export { CHEST_UP_SHARE, chestUpDepthM, comeNearSize, type NearSize, type NearFrom } from './near';
export { firstWaistUpSize } from './first';
export { farthestWalkSize, nearTable, nearestWalkSize, type NearRow, type NearTable } from './reach';
export { GO_OUTCOME_RULES, GoOutcomes, type GoOutcome } from './outcome';
export { goOutcomeLine, screenFactsLine } from './screen-facts';
export { GO_STAY_WHYS, PLACE_MOVE_BY, goStayWhyOfBlock, goStayedRow, goWentRow, metresBetween, placeMovedRow, type GoStayWhy, type LifeJournalRow, type PlaceMoveBy } from './journal';
