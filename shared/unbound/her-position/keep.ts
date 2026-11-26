/**
 * I-205b: the spot she chose in her own reply (a go-word, written while she reads the chat) outranks the life arbiter's
 * own place changes (the busy zone, home, paused, wandering) for a while. Walking itself stays rule-based (no model call). Pure.
 */
import { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';

/** When the window of a spot she just chose ends (ms); `now` is when the walk started (or when she found she already stood there). */
export function chosenSpotUntil(now: number, knobs: HerPositionKnobs = HER_POSITION_KNOBS): number {
  return now + Math.max(0, knobs.chosenSpotMinutes) * 60_000;
}

/** The window is still open. */
export function chosenSpotOpen(until: number | null | undefined, now: number): boolean {
  return typeof until === 'number' && Number.isFinite(until) && now < until;
}
