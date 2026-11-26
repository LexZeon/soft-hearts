// I-166 看到的东西直接影响她说什么 (docs/claude/2026-11-21-i166-see-and-say.md): knobs, her hidden closer-look marker, and the words.
export { SEE_AND_SAY, type SeeAndSayKnobs } from './knobs';
export { LOOK_MARKER, LOOK_SENSES, LookMarkerFilter, stripLookMarkers, type LookMarkerChunk, type LookSense } from './marker';
export { CLOSER_MISSES, CLOSER_MISS_WORDS, CLOSER_RETRY_MISSES, CLOSER_OUTCOMES, CLOSER_OUTCOME_WORDS, CLOSER_WHYS, CLOSER_WHY_WORDS, LOOK_SENSE_WORDS, SEE_AND_SAY_EVENTS, SEE_AND_SAY_REASON, chatSelfLookWanted,
  closerLookNote, judgedSenses, seeAndSayLine, type CloserMiss, type CloserOutcome, type CloserWhy, type SeeAndSayEvent, type SeeingSenses } from './words';
