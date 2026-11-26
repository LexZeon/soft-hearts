// I-209 step 4: on the full-screen stage everyone hears, everyone records, and the characters decide who answers (docs/claude/2026-11-24-i209-step4.md).
export { ChimeIn } from './chime-in';
export type { ChimeAskOutcome, ChimeInPorts, ChimeLineOutcome, ChimeRow } from './chime-in';
export { CHIME_RECENT, agoWords, chimeDecisionPrompt, chimeFactsBlock, chimeLinePrompt, clipPersona, historyText, parseChimeDecision, whoSaid } from './facts';
export type { ChimeFacts, ChimeLineInput, StageLine } from './facts';
export { StageHearing, heardId } from './hearing';
export type { HeardEvent, HearingPorts } from './hearing';
export { CHIME_DECISION_MODEL, chimeDecisionWithClaude, chimeLineWithClaude } from './model';
export { sharedSight } from './perceive';
export type { SightSource } from './perceive';
export { ChimeTurns } from './turns';
export type { ChimeTurnPorts } from './turns';
