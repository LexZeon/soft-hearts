/**
 * One canonical duration for a VMD source (R19 idle isolation check).
 *
 * VMD keyframes are integer frames at 30 fps. A source's duration is its last
 * frame index, which the VMD parser reports (`durationFrames`). Milliseconds
 * and seconds are derived from that integer by these functions only, so the
 * host recipe, the parser report, the loaded clip and the player state all hold
 * the identical double. MMDLoader's own clip duration comes from Float32
 * keyframe times (161 frames -> 5366.666793823242 ms instead of
 * 5366.666666666666 ms); it is replaced, never compared with a tolerance.
 */
export const VMD_FRAME_RATE = 30;

/** Canonical milliseconds of an integer frame count. */
export function vmdDurationMs(frames: number): number { return frames / VMD_FRAME_RATE * 1_000; }

/** Canonical clip seconds of canonical milliseconds. */
export function vmdDurationSeconds(durationMs: number): number { return durationMs / 1_000; }

/**
 * Gives a freshly loaded clip the parser-defined duration and returns its
 * canonical milliseconds. `durationFrames` must be the parser's integer report;
 * anything else leaves the clip untouched and returns NaN (never equal to a recipe).
 */
export function canonicalVmdClipDuration(clip: { duration: number }, durationFrames: number): number {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 0) return NaN;
  const durationMs = vmdDurationMs(durationFrames);
  clip.duration = vmdDurationSeconds(durationMs);
  return durationMs;
}
