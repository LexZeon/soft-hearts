/**
 * Unbound v1 step 3 (docs/claude/2026-11-17-unbound-step3.md): where a call can be seen. A call ends when it can no longer be seen
 * (I-091: "the window leaves the screen"). At home that is the call's window and her companion window; while she is out in Unbound her
 * companion window is hidden only because she is out, and she is on the screen in Unbound instead, so the call goes on (the same rule
 * her senses already follow: electron/wiring/stage-window-wiring.ts onScreen). Electron-free; tests/unbound-call.test.ts.
 */
import type { VoiceCallOwner } from '../../../shared/voice/voice-call';

export interface CallSurfaceFacts {
  /** Her companion window is visible and not minimised. */
  pet: boolean;
  /** The control window is visible and not minimised. */
  controls: boolean;
  /** She is out in Unbound (her companion window hidden because of it). */
  held: boolean;
}

/** The call's window and she herself are on screen. */
export function callSurfaceShown(owner: VoiceCallOwner, facts: CallSurfaceFacts): boolean {
  const her = facts.pet || facts.held;
  return (owner === 'pet' ? her : facts.controls) && her;
}
