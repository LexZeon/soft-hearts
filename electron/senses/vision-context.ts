/**
 * What she sees belongs to a vision context: the conversation (speech scope), her window on screen or held out in Unbound, the display
 * the screen frames come from, and the window that owns the camera. When it changes, everything she was shown goes (electron/wiring/
 * senses-look-wiring.ts clearVisionContext: look tickets, the warm Claude process's small frames, the kept camera frame, the renderer's
 * pending frames and chat view).
 *
 * 2026-11-21 (docs/claude/2026-11-21-warm-small-frames.md): the identity also carried her mood token, which rotates for reasons that have
 * nothing to do with seeing: her companion window hidden when she goes out into full-screen Unbound (electron/wiring/stage-cleanup-wiring.ts
 * its visibility step → mood.invalidate), and any gap of more than 5 s between mood ticks (electron/mood/mood.ts refresh). Each rotation
 * cleared the whole vision context, so the warm process holding ordinary small frames retired ("image") and the next reply started on a
 * fresh process (2.5–6 s instead of about 2 s), the first Unbound turn every time. Now a change of the mood token alone is a 'mood'
 * change: what belongs to her mood scope (her own looks under way, the authoring previews) is cancelled, what she was shown stays. Every
 * other change ('seeing') clears as before. Pure: no clock, no Electron.
 */
export interface VisionContextParts {
  /** The conversation's speech scope ('' while it is in transition). */
  speech: string;
  /** `${speech}:${mood token}` ('' while in transition): the scope the rest of the host reads. */
  scope: string;
  /** Her companion window is on screen, or held by Unbound. */
  visible: boolean;
  /** The display the screen frames come from (null: not on screen). */
  display: number | null;
  screen: boolean;
  camera: boolean;
  cameraOwner: string | null;
}

/** The identity of the context now: '' with no sense on (turning one on is not a change), else what decides seeing and her mood scope. */
export function visionContextKey(parts: VisionContextParts): string {
  if (!parts.screen && !parts.camera) return '';
  return JSON.stringify([[parts.speech, parts.visible, parts.screen ? parts.display : null, parts.camera ? parts.cameraOwner : null], parts.scope]);
}

/** The part of an identity that decides whether what she was shown may stay (everything but the mood scope). */
function seeingOf(key: string): string {
  try { const parsed: unknown = JSON.parse(key); return Array.isArray(parsed) ? JSON.stringify(parsed[0]) : key; } catch { return key; }
}
/** [speech, visible, screen display, camera owner] of an identity, or null when it is not one this module made. */
function partsOf(key: string): [unknown, unknown, unknown, unknown] | null {
  try { const parsed: unknown = JSON.parse(key); const head = Array.isArray(parsed) ? parsed[0] : null; return Array.isArray(head) && head.length === 4 ? head as [unknown, unknown, unknown, unknown] : null; } catch { return null; }
}

/**
 * 'none': nothing to do (the same, or there was no context before). 'mood': only her mood token rotated (her own looks under way stop;
 * the frames she was shown and the warm process stay). 'seeing': anything else changed (clear everything, as before). An identity this
 * module did not make counts as a seeing change.
 *
 * 2026-11-25 (only the user cutting in interrupts her): two more answers. 'grew': a source was turned on or added (nothing she was shown is stale: nothing is
 * cleared, so the conversation and her voice go on). 'off': the same conversation and window, but a source went off or moved (what she was shown must go, but not
 * in the middle of her reply: the caller waits for it). 'seeing' is what is left: another conversation or window, which is a switch.
 */
export type VisionContextChange = 'none' | 'mood' | 'grew' | 'off' | 'seeing';
export function visionContextChange(previous: string, next: string): VisionContextChange {
  if (!previous || previous === next) return 'none';
  if (next && seeingOf(previous) === seeingOf(next)) return 'mood';
  const before = partsOf(previous), after = next ? partsOf(next) : null;
  if (!before || (next && !after)) return 'seeing';
  if (!after) return 'off'; // every source went off
  if (before[0] !== after[0] || before[1] !== after[1]) return 'seeing';
  return (before[2] === null || before[2] === after[2]) && (before[3] === null || before[3] === after[3]) ? 'grew' : 'off';
}
