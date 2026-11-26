// I-165 气泡跟着声音走: the knob and the pure state machine (README: shared/voice/README.md if present, else docs/claude/2026-11-20-bubble-follows-voice.md).
export { BUBBLE_FOLLOW_KNOBS, bubbleFollowMode } from './knobs';
export type { BubbleFollowKnobs, BubbleFollowMode } from './knobs';
export { BubbleFollow } from './follow';
export type { BubbleFollowRelease, BubbleHeardPhase } from './follow';
