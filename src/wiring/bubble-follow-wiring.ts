// Renderer wiring, I-165 气泡跟着声音走 (docs/claude/2026-11-20-bubble-follows-voice.md): this window's BubbleFollowView
// (src/voice/bubble-follow-view.ts), made the first time somebody asks (nothing here runs on import). Both windows feed it (the window
// reading the reply hears its voice; the other one hears it over the speech channel); only the companion window applies it, to its native
// reply bubble (its setVoiceCap). The control window's chat page always shows the whole reply at once.
import { BubbleFollowView } from '../voice';
import { bubbleFollowMode } from '../../shared/voice';
import { isPet } from './shell-wiring'; // no-pet-ok: the existing name of the companion window flag
import { petUI } from './pet-window-wiring'; // no-pet-ok: the existing names of the companion window's UI and its wiring file

let view: BubbleFollowView | null = null;

/** This window's view of how much of the reply being read her bubble may show. */
export function bubbleFollow(): BubbleFollowView {
  return view ??= new BubbleFollowView({
    now: () => performance.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    apply: (id, cap) => { if (isPet) petUI?.setVoiceCap(id, cap); }, // no-pet-ok: the companion window flag and its UI's existing name
    // Only the companion window holds text back; the control window's view never engages.
    mode: () => isPet ? bubbleFollowMode() : 'off', // no-pet-ok: the companion window flag
  });
}
