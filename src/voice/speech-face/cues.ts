/**
 * I-073 part 3: the facts the voice output (or, with reading aloud off, the bubble) tells the stage. The type and its check live in
 * shared/voice/speech-face-cue.ts since 2026-11-21 (the host checks a cue with the same rule before relaying it to her full-screen
 * Unbound window, docs/claude/2026-11-21-unbound-full-ACH.md); this keeps the old import path.
 */
export { sanitizeSpeechFaceCue, turnOf, type SpeechFaceCue } from '../../../shared/voice/speech-face-cue';
