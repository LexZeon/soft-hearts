/**
 * I-184 / I-185: a close moment's channels (shared/unbound/close-moments/timeline.ts) as her body reads them — the showcase face, her arms'
 * targets for a hug, and the look away — shared by the full-screen performance (close-moment.ts), the lighter in-place hug on the full-screen
 * stage (speech-beat-player.ts) and the window's in-place kiss and hug (window-mode/window-beats.ts). Moved out of close-moment.ts unchanged.
 */
import { Vector3 } from 'three';
import type { CloseChannels } from '../../../shared/unbound/close-moments';
import type { HandTarget, HandTargets } from '../arm-reach';
import type { MotionIntent, ShowcaseFace } from '../motion/generator';
import type { LensView } from '../motion/lens-align';

/** Looking away: how far to the side and down at a full `away` (rad). */
export const CLOSE_AWAY = Object.freeze({ yaw: 0.45, pitch: 0.22 });

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const norm = (v: Vector3) => v.lengthSq() > 1e-12 ? v.normalize() : v.set(0, 0, 1);

/**
 * Her arm for the hug, in her chest's rest frame (x toward her left, y up, z forward: the Unbound figure faces +z at rest): `wrap` 0 is
 * open toward you, 1 is wrapped forward around someone in front of her. Unit directions for the arm reach's 'aim'.
 */
export function hugArm(side: 1 | -1, wrap: number): Required<Pick<HandTarget, 'aim'>>['aim'] {
  const w = clamp01(wrap), up = new Vector3(0, 1, 0), fwd = new Vector3(0, 0, 1), out = new Vector3(side, 0, 0), inward = out.clone().negate();
  const mix = (a: [Vector3, number][], b: [Vector3, number][]) => {
    const va = a.reduce((s, [v, k]) => s.addScaledVector(v, k), new Vector3()), vb = b.reduce((s, [v, k]) => s.addScaledVector(v, k), new Vector3());
    return norm(norm(va).lerp(norm(vb), w));
  };
  const upper = mix([[up, -0.35], [fwd, 0.55], [out, 0.75]], [[up, -0.3], [fwd, 0.85], [out, 0.35]]);
  const fore = mix([[fwd, 0.85], [out, 0.35], [up, 0.15]], [[fwd, 0.45], [inward, 0.85], [up, 0.1]]);
  const hand = mix([[fwd, 0.8], [out, 0.2], [up, 0.1]], [[inward, 0.85], [fwd, 0.3]]);
  const palm = mix([[inward, 0.7], [fwd, 0.3]], [[fwd, -0.85], [inward, 0.2]]);
  const v = (p: Vector3) => ({ x: p.x, y: p.y, z: p.z });
  return { upper: v(upper), fore: v(fore), hand: v(hand), palm: v(palm) };
}

/** The face of a close moment: the pucker as shown (PuckerGate), eyes closed or soft, the after-beat's smile, blush and wink. */
export function closeFace(c: CloseChannels, pucker: number): ShowcaseFace {
  return { confirm: 0, warm: c.smile, laugh: c.laugh, pout: pucker, shy: c.shy, surprise: 0, sly: 0, content: 0, yawn: 0, stress: 0,
    closed: c.closed, half: c.soft, blush: c.blush, mouth: { a: 0, i: 0, u: 0, e: 0, o: 0 }, wink: c.wink };
}

/**
 * Both arms for a hug at weight `arms` (0: none) and `wrap` (hugArm); null hands below a trace. I-203: the full-screen hug uses these too, its wrap
 * scaled (CLOSE_BEATS.hugWrap): her face is far enough at the hug's end frame that her arms come round you outside the picture. I-192's
 * low-to-the-sides arms (edgeHugArm) were for a face 20 cm from the lens and went with it.
 */
export function closeHands(arms: number, wrap: number): HandTargets {
  return arms > 1e-4
    ? { left: { weight: arms, pose: 'aim', wave: 0, aim: hugArm(1, wrap) }, right: { weight: arms, pose: 'aim', wave: 0, aim: hugArm(-1, wrap) } }
    : { left: null, right: null };
}

type ShowcaseIntent = Extract<MotionIntent, { kind: 'showcase' }>;

/** I-185: an in-place close moment (no walk) as a showcase intent: she leans and tilts where she stands, eyes to the lens. */
export function closeIntent(lens: LensView, c: CloseChannels, pucker: number): ShowcaseIntent {
  return { kind: 'showcase', lens, gaze: { mode: 'lens', yaw: CLOSE_AWAY.yaw * c.away, pitch: CLOSE_AWAY.pitch * c.away }, place: null, walkSpeedMps: null,
    lean: c.lean, tilt: c.tilt, nod: 0.06 * c.away, bias: { yaw: 0, pitch: 0 }, gazeRecenter: 0.6, hands: closeHands(c.arms, c.wrap), face: closeFace(c, pucker),
    blink: 0, stillness: 0.15, tempo: 'calm' };
}

const FACE_KEYS = ['confirm', 'warm', 'laugh', 'pout', 'shy', 'surprise', 'sly', 'content', 'yawn', 'stress', 'closed', 'half', 'blush'] as const;
/**
 * I-185: an in-place close moment laid over a speech-beat performer's intent (both at once on the full-screen stage): its lean and tilt add,
 * its arms take the hands while they are out (else the performer's), each face part is the larger of the two.
 */
export function layerClose(intent: MotionIntent, c: CloseChannels, pucker: number): MotionIntent {
  if (intent.kind !== 'showcase') return intent;
  const own = closeFace(c, pucker), face = { ...intent.face };
  for (const key of FACE_KEYS) face[key] = Math.max(face[key], own[key]);
  face.wink = Math.max(face.wink ?? 0, own.wink ?? 0);
  return { ...intent, lean: intent.lean + c.lean, tilt: intent.tilt + c.tilt, hands: c.arms > 1e-4 ? closeHands(c.arms, c.wrap) : intent.hands, face };
}
