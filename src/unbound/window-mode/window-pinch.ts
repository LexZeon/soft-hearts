/**
 * I-154 batch 3, row 22 捏脸: the companion's cheek pinch (src/mood/cheek-pinch-feedback.ts CheekPinchMotion) on Unbound's engine in the
 * companion window. The same layer with the same inputs (the pinch from the companion's own touch input, her mood, the card's strengths,
 * her picked pinch face), so she answers a pinch the way she does on the old stage: her head follows your fingers (turns, tilts, shifts),
 * her body a little more the farther you pull, and the face she picked for this pinch (a smile, a squint).
 *
 * What is different, on purpose: nothing here writes a bone. CheekPinchMotion's own critically damped springs (ω 18) already ease every
 * channel, and its frame becomes goals: the head's turn → the head goal, the body's turn → the upper body goal, the head's shift on screen
 * → a neck bend that carries her head the same way, the body's shift → her hips (lateral, vertical; she never walks here). The figure's
 * springs then carry those. So letting go eases back, a new pinch starts from where she is, and nothing can jump.
 * Pure: no DOM, no three.js objects.
 */
import { CheekPinchMotion, pinchFacePick, type MoodContact } from '../../mood';
import type { MoodView } from '../../../shared/mood';
import type { Rot } from '../motion/generator';

/**
 * How far her head moves per radian of neck bend, as a share of her height (measured on the bundled Gene in the window: a 0.2 rad neck roll
 * moves her head 6.9 px of a ~430 px figure): a head shift on screen becomes a neck bend of shift / this.
 */
export const PINCH_NECK_REACH = 0.08;

export interface WindowPinchFrame {
  head: Rot; torso: Rot; neck: Rot;
  /** Her hips (m, her frame: lateral + = her left = your right as she faces you; vertical + = up). */
  pelvis: { lateral: number; forward: number; vertical: number };
  /** The picked pinch face (0..1, after the card's expression strength): a smile and a squint. */
  smile: number; lids: number;
  /** Anything of the pinch still shows (held, or easing back): the idle and the drowsy face step aside, as the companion's do. */
  active: boolean;
}
const ZERO: Rot = Object.freeze({ pitch: 0, yaw: 0, roll: 0 }) as Rot;
export const NO_PINCH: Readonly<WindowPinchFrame> = Object.freeze({ head: ZERO, torso: ZERO, neck: ZERO, pelvis: Object.freeze({ lateral: 0, forward: 0, vertical: 0 }),
  smile: 0, lids: 0, active: false });

export class WindowPinch {
  private readonly motion = new CheekPinchMotion();
  /** The pinch layer's own frame and the input it was given (the developer readout, window-readouts.ts). */
  latest: Record<string, unknown> | null = null;

  /** Another conversation or character, a lost scope, another model: the old pinch is gone (what shows eases back through the figure's springs). */
  reset(): void { this.motion.reset(); this.latest = null; }

  /**
   * `heightM`: her height (m), for the shifts. Without a mood view she is not answered (the companion's animateCheekPinch needs one too);
   * a picked expression owns her face (`faceBlocked`: the pinch face is not shown, the head still follows), a picked head motion her head.
   */
  frame(dt: number, contact: MoodContact, view: MoodView | null, heightM: number, blocks: { face: boolean; head: boolean }): WindowPinchFrame {
    if (!view) { this.motion.reset(); this.latest = null; return NO_PINCH; }
    const s = view.snapshot, pinch = contact.pinch;
    const f = this.motion.frame(dt, pinch ?? { pinching: false, x: 0, y: 0, side: null }, {
      mood: s.primary, posture: s.intensity.posture, face: view.expressions ? s.intensity.expression : 0,
      playful: s.intensity.playful, sensitivity: view.parameters.sensitivity.O,
      pick: pinchFacePick(view.touchFace), // I-136: her face for this pinch is the pick from her mood numbers and character
    });
    this.latest = { ...f, pinching: pinch?.pinching ?? false, side: pinch?.side ?? null, inputX: pinch?.x ?? 0, inputY: pinch?.y ?? 0 };
    const active = Object.values(f).some(value => value !== 0);
    if (!active) return NO_PINCH;
    const h = Number.isFinite(heightM) && heightM > 0 ? heightM : 1.6, head = !blocks.head;
    // The head's shift on screen (right +, up +; height ratios) as a neck bend that carries it there (a roll to your right moves it right;
    // down is the chin a little down), and the head turns back by the same, so the shift reads as a shift and not as more tilt.
    const neckRoll = f.headOffsetX / PINCH_NECK_REACH, neckPitch = -f.headOffsetY / PINCH_NECK_REACH * 0.5;
    // The companion's local Euler (x pitch, y yaw, z roll) → the figure's goals (roll's sign as window-face.ts maps the mood's head).
    return {
      head: head ? { pitch: f.headX - neckPitch, yaw: f.headY, roll: -f.headZ - neckRoll } : ZERO,
      torso: { pitch: f.bodyX, yaw: f.bodyY, roll: -f.bodyZ },
      neck: head ? { pitch: neckPitch, yaw: 0, roll: neckRoll } : ZERO,
      pelvis: { lateral: f.bodyOffsetX * h, forward: 0, vertical: f.bodyOffsetY * h },
      smile: blocks.face ? 0 : f.smile, lids: blocks.face ? 0 : f.eyelids, active: true,
    };
  }
}
