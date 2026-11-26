/**
 * I-159 E: the two near stations of a pull, worked out from the camera and her own body (no metre is
 * written down), and what a let-go there does.
 *
 *   face  the nearest she stays when you let go: her head (chin to crown) fits the window with a margin and takes at most FACE_FILL of its
 *         height, as in a video call. Her head is not on the window's middle line (the camera is at eye height, her head a little below),
 *         so how near she may come is set by the head still fitting, not only by its size.
 *   eyes  the nearest she can be pulled to: her eye the distance the peek brings it from the lens (the peek's own rule, peekDistance).
 *
 * Let go nearer than `gate` (halfway between the two): she does what she does when she comes to the lens (the host plays a peek: she
 * leans in, stares, blinks, backs off; any mouse move or key after a short buffer sends her back early) and then stands at `face`.
 * Let go between `gate` and `face`: she walks back to `face`. At `face` or farther: she stays (as before). Pure; the page wires it
 * (main.ts), the host plays the peek (electron/unbound/peek.ts pulledNear). Her own walks keep their range (SAVED_PLACE_RANGES).
 */
import { DEPTH_RANGE_M } from '../../shared/unbound/world';
import { peekDistance } from './director/peek-lens';
import { toHerFrame, type LensView } from './motion/lens-align';
import { eyeClearDistance, usableFace } from '../../shared/unbound/arrival'; // I-192: the no-clipping guard, the peek's own

/** How much of the window's height her head may take at the nearest, and the margin kept inside the window's edges. */
export const FACE_FILL = 0.8, FACE_MARGIN = 0.06;
/** The share of the screen's height her eye takes at the very nearest (the peek's own "about 0.5, the whole eye"). */
export const EYE_FILL = 0.5;
export { NEAR_ARM_MS } from '../../shared/unbound/pull'; // the buffer after a let-go near the lens (host and page share it)
/** She is let go "near enough to the lens" at this share of the way from `face` to `eyes`. */
export const GATE_SHARE = 0.5;

export interface NearBody {
  /** Her head's middle height above her floor and its radius (m): the HeadLocator's own measures (head bone + 5.5% of her height, 7.5%). */
  headY: number; headR: number;
  /** How far in front of her root her eyes are (m) and how big one is (null: unknown). */
  eyeForwardM: number; eyeSizeM: number | null;
  /** I-196: the nearest her eye may come to the lens so her nose, bangs and hair stay out of the camera (I-192's guard, as the peek keeps it); 0: not known. */
  clearM?: number;
}
export interface NearStations { faceDepthM: number; eyeDepthM: number; gateDepthM: number }

/** Her measures from the figure (null before her first measured frame). */
export interface NearSense {
  head: { x?: number; y: number; z?: number } | null;
  frame: { eyes: { left: { x?: number; y?: number; z: number }; right: { x?: number; y?: number; z: number } } } | null;
  eyeSizeM: number | null; root?: { x: number; z: number; heading: number }; face?: Parameters<typeof usableFace>[0];
}
export function nearBodyOf(figure: { heightM: number; sense: NearSense | null }): NearBody | null {
  const sense = figure.sense;
  if (!sense?.head || !(figure.heightM > 0)) return null;
  const eyeForwardM = sense.frame ? (sense.frame.eyes.left.z + sense.frame.eyes.right.z) / 2 : 0.07 * figure.heightM / 1.6;
  return { headY: sense.head.y + 0.055 * figure.heightM, headR: 0.075 * figure.heightM, eyeForwardM, eyeSizeM: sense.eyeSizeM, clearM: clearOf(sense) };
}

/** The guard's distance for the nearer of her two eyes (the peek's own sum: minimum clearance + how far her face reaches ahead of that eye + hair swing). */
function clearOf(sense: NearSense): number {
  const face = usableFace(sense.face), head = sense.head, root = sense.root;
  if (!face || !head || !root || !sense.frame || head.x === undefined || head.z === undefined) return 0;
  const h = toHerFrame({ x: head.x - root.x, y: head.y, z: head.z - root.z }, root.heading);
  let worst = 0;
  for (const e of [sense.frame.eyes.left, sense.frame.eyes.right]) if (e.x !== undefined && e.y !== undefined) worst = Math.max(worst, eyeClearDistance(face, { x: e.x - h.x, y: e.y - h.y, z: e.z - h.z }));
  return worst;
}

/** The near stations (depth behind the screen, m; world z = −depth) for her body and the camera's view. */
export function nearStations(lens: LensView, body: NearBody): NearStations | null {
  const perM = lens.heightPerM, az = -lens.axis.z;
  if (!perM || !(perM > 0) || !(az > 1e-6)) return null;
  const slope = lens.axis.y / az, dy = body.headY - lens.camera.y, half = 0.5 * perM * (1 - FACE_MARGIN);
  // |dy − slope·a| + r ≤ half·a  (the head inside the window at distance a from the eye), and 2r ≤ FACE_FILL·perM·a (not more than the fill).
  const above = half + slope > 1e-9 ? (dy + body.headR) / (half + slope) : Infinity, below = half - slope > 1e-9 ? (body.headR - dy) / (half - slope) : Infinity;
  const aFace = Math.max(above, below, 2 * body.headR / (FACE_FILL * perM));
  const aEyes = Math.max(peekDistance({ eyeFill: EYE_FILL, eyeDistanceM: 0.11 }, body.eyeSizeM, lens), body.clearM ?? 0) + body.eyeForwardM;
  if (!Number.isFinite(aFace) || !Number.isFinite(aEyes)) return null;
  const faceDepthM = Math.max(DEPTH_RANGE_M[0], aFace - lens.camera.z);
  const eyeDepthM = Math.min(aEyes - lens.camera.z, faceDepthM - 0.3);
  return { faceDepthM, eyeDepthM, gateDepthM: faceDepthM + (eyeDepthM - faceDepthM) * GATE_SHARE };
}

/** What letting go at `depthM` does: stay (face or farther), walk back to face, or the peek (nearer than the gate). */
export type NearOutcome = 'stay' | 'face' | 'eyes';
export function nearOutcome(depthM: number, stations: NearStations | null): NearOutcome {
  if (!stations || !Number.isFinite(depthM) || depthM >= stations.faceDepthM) return 'stay';
  return depthM < stations.gateDepthM ? 'eyes' : 'face';
}

/** The nearest depth a pull may reach (her far end is the saved-place range's, clampFollowDepth in shared/unbound/pull.ts). */
export const pullNearLimit = (stations: NearStations | null, fallbackM: number): number => stations ? stations.eyeDepthM : fallbackM;

/**
 * After a let-go nearer than `face`: the page keeps the scene's place from teleporting her (she is not where the place says yet) until
 * she stands at the face station. 'face': she walks there. 'eyes': the host's peek comes (a command, then the peek walks her to its
 * home, the face place); if it never comes (refused, host gone) she walks to the face station herself after WAIT_MS.
 */
export const NEAR_WAIT_MS = 2_500, NEAR_MAX_MS = 40_000;
export class NearReturn {
  private point: { x: number; z: number } | null = null;
  private waitsForPeek = false;
  private sawPeek = false;
  private since = 0;
  get busy(): boolean { return this.point !== null; }
  begin(outcome: 'face' | 'eyes', point: { x: number; z: number }, now: number): void {
    this.point = { ...point }; this.waitsForPeek = outcome === 'eyes'; this.sawPeek = false; this.since = now;
  }
  cancel(): void { this.point = null; }
  /** Every frame. `walkTo` sends her to a point (the gait walks, never faster than her pace). */
  frame(now: number, root: { x: number; z: number }, moving: boolean, peekActive: boolean, walkTo: (point: { x: number; z: number }) => void): void {
    const point = this.point;
    if (!point) return;
    if (now - this.since > NEAR_MAX_MS) { this.point = null; return; }
    if (this.waitsForPeek) {
      if (peekActive) { this.sawPeek = true; return; }
      if (this.sawPeek) { this.point = null; return; } // the peek is over: it left her at its home, the face place
      if (now - this.since < NEAR_WAIT_MS) return;
      this.waitsForPeek = false; // no peek came: she walks back herself
      walkTo(point);
      return;
    }
    if (!moving && Math.hypot(root.x - point.x, root.z - point.z) < 0.05) this.point = null;
  }
}
