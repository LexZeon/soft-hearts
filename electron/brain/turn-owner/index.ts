// I-209 step 2: every brain turn carries which character it belongs to (docs/claude/2026-11-24-i209-step2.md).
export { TurnOwners, companionChangeStops, ownerSpeechScope, switchStops } from './owners';
export type { OwnerReader, OwnerSeat, OwnersStopped } from './owners';
// I-209 step 3: her own card's persona for her turn.
export { ownHistory, ownerSettings } from './persona';
export { stageTurn } from './stage-turn';
