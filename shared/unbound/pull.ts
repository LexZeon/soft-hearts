/**
 * Unbound v1 step 5c「拉她」: what the Unbound page tells the host about a pull (`unbound:pull`). Two shapes only:
 *   { phase: 'start' }                          a press became a pull: you own her now (the arbiter's 'pull'), her own things ease out;
 *   { phase: 'report', report, place? }         the session's "still holding" or its end (shared/behaviors/pull/session.ts), and
 *                                               where she stands if she walked along (her place then is that spot).
 * Only these fields are kept; the pull's own fields are checked again by shared/mood/touch.ts parseTouchEvent on the host.
 */
import type { PullReport, PullStanceOf } from '../stage';
import { placementAcross, type WorldView } from './world';
import { SAVED_PLACE_RANGES } from './life/place-record';
import { depthForSize, type ScreenFrame } from './screen-terms';

/** I-159 E: after a let-go near the lens, mouse moves and keys do not send her back for this long (ms): the hand is still leaving the mouse. */
export const NEAR_ARM_MS = 1_000;

export type UnboundPullMessage =
  | { phase: 'start' }
  | { phase: 'report'; report: Record<string, unknown>; place?: { xM: number; depthM: number }; /** I-159 E: let go at the eyes station: the host plays the peek, then she stands at `place` (the face station). */ near?: true;
    /** I-184: with `near`, how long she was held nearer than the gate before the let-go (ms): held long enough, she decides what to do. */ nearHeldMs?: number;
    /** I-196: a joystick or wheel pull of her body: a pull, never a touch (the host keeps her place and the day's account, and tells the touch brain nothing). */ stick?: true };

const FIELDS = ['part', 'side', 'strength', 'direction', 'heldMs', 'ended', 'response', 'steps'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The message, or null when it is not exactly one of the two. */
export function parseUnboundPull(value: unknown): UnboundPullMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.phase === 'start') return { phase: 'start' };
  if (raw.phase !== 'report' || !raw.report || typeof raw.report !== 'object' || Array.isArray(raw.report)) return null;
  const given = raw.report as Record<string, unknown>, report: Record<string, unknown> = {};
  for (const key of FIELDS) if (Object.hasOwn(given, key)) report[key] = given[key];
  const place = raw.place as Record<string, unknown> | undefined;
  const message: UnboundPullMessage = { phase: 'report', report };
  if (place && typeof place === 'object' && finite(place.xM) && finite(place.depthM)) message.place = { xM: place.xM, depthM: place.depthM };
  if (message.place && raw.near === true) message.near = true; // only with a place, and only a plain true
  if (message.near && finite(raw.nearHeldMs) && raw.nearHeldMs > 0) message.nearHeldMs = Math.min(600_000, raw.nearHeldMs); // I-184
  if (raw.stick === true) message.stick = true; // I-196
  return message;
}

/** The page's side: a report as the session made it. */
export const pullReportMessage = (report: PullReport, place?: { xM: number; depthM: number } | null, near = false, nearHeldMs = 0, stick = false): UnboundPullMessage =>
  ({ phase: 'report', report: { ...report }, ...(place ? { place: { ...place } } : {}), ...(place && near ? { near: true as const } : {}),
    ...(place && near && nearHeldMs > 0 ? { nearHeldMs } : {}), ...(stick ? { stick: true as const } : {}) });

/** The host's answer to a start, as the page reads it: anything odd is "no"; every number clamped. */
export interface UnboundPullAnswer { accepted: boolean; stance: PullStanceOf | null; sleepy: number }
export function parsePullAnswer(value: unknown): UnboundPullAnswer {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const accepted = raw.accepted === true, sleepy = finite(raw.sleepy) ? Math.min(1, Math.max(0, raw.sleepy)) : 0;
  const s = raw.stance && typeof raw.stance === 'object' ? raw.stance as Record<string, unknown> : null;
  const num = (v: unknown, min: number, max: number, fallback: number) => finite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const stance: PullStanceOf | null = s ? { willing: num(s.willing, 0, 1, 0.5), compliance: num(s.compliance, 0, 1, 1), pace: num(s.pace, 0.3, 1.5, 1),
    hesitateMs: num(s.hesitateMs, 0, 2000, 0), resist: num(s.resist, 0, 1, 0) } : null;
  return { accepted, stance: accepted ? stance : null, sleepy };
}

/**
 * I-212: the pull's own bounds on this screen for her height (m behind the screen): the saved-place range's sizes (0.771 near, 0.327 far: the
 * old 5 and 12.5 m on the reference laptop) converted by shared/unbound/screen-terms, so a pull reaches as far on any screen as it looks on that
 * laptop. Not known (no frame or height yet): the old metres. The hand-feel stays the pointer's on the screen (src/unbound/pull-input.ts).
 */
export function followDepthRange(frame: ScreenFrame | null | undefined, heightM: number | null | undefined): readonly [number, number] {
  const near = depthForSize(frame, heightM, SAVED_PLACE_RANGES.size[1]), far = depthForSize(frame, heightM, SAVED_PLACE_RANGES.size[0]);
  return near !== null && far !== null && near > 0 && far > near ? [near, far] : SAVED_PLACE_RANGES.depthM;
}

/**
 * I-155: a depth (m) she may walk to while pulled far or near: the far end is her saved-place range's (`range`, followDepthRange); I-159 E: the
 * near end is `nearM` (the eyes station, worked out from the camera and her body: src/unbound/pull-near.ts), or the saved range's own when it is
 * not known. Her own walks and saved places keep SAVED_PLACE_RANGES; only a pull may come nearer. NaN: not known, the middle.
 */
export function clampFollowDepth(depthM: number, nearM?: number | null, range: readonly [number, number] = SAVED_PLACE_RANGES.depthM): number {
  const [saved, hi] = range, lo = typeof nearM === 'number' && Number.isFinite(nearM) ? Math.min(saved, nearM) : saved;
  return Number.isNaN(depthM) ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, depthM));
}

/** Step 5c: a floor x (m) she may walk to while pulled: inside her stand range (5%–95% of the screen across, at her depth). */
export function clampFollowX(view: Pick<WorldView, 'screen' | 'viewerDistanceM'>, xM: number, depthM: number): number {
  const [lo, hi] = SAVED_PLACE_RANGES.across;
  const a = placementAcross(view, lo, depthM).xM, b = placementAcross(view, hi, depthM).xM;
  return Number.isFinite(xM) ? Math.min(Math.max(a, b), Math.max(Math.min(a, b), xM)) : (a + b) / 2;
}
