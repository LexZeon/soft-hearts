/**
 * R01 / Codex T-251: a physics output is bounded as two parts, its slowly tracked rest value (the authored preload: a bust that rests
 * pushed off its bone or turned on it) and the motion around that rest. Bounding the raw value relative to the animated pose instead
 * let a large rest value use up the range, so the part sat on the bound and every bit of motion was clipped away ("几乎不动").
 * At rest inside the bound the result is exactly the raw value (it looks as before). Pure: no Ammo, no bones.
 */
import { Quaternion, Vector3 } from "three";

const IDENTITY = new Quaternion();
const restPart = new Quaternion(), swingPart = new Quaternion(), restOffset = new Vector3();

/**
 * Turns `value` toward identity until its angle is at most `cap` (in place).
 * T-251: never `value.slerpQuaternions(IDENTITY, value, t)`: three copies IDENTITY into `value` first, so the slerp ran from identity
 * to identity and every rotation past the bound became no rotation at all (hair swinging past 0.7 rad snapped back to the pose).
 */
export function capAngle(value: Quaternion, cap: number): Quaternion {
  const angle = IDENTITY.angleTo(value);
  return angle > cap ? value.slerp(IDENTITY, 1 - cap / angle) : value;
}

/**
 * The bounded output for a raw solver value and the rest value it is tracked around: the rest bounded to `cap`, then the swing
 * (raw relative to rest) bounded to `cap` on top. Quaternions compose as rest × swing; offsets add.
 */
export function boundAroundRest(raw: Quaternion, rest: Quaternion, cap: number, out: Quaternion): Quaternion;
export function boundAroundRest(raw: Vector3, rest: Vector3, cap: number, out: Vector3): Vector3;
export function boundAroundRest(raw: Quaternion | Vector3, rest: Quaternion | Vector3, cap: number, out: Quaternion | Vector3): Quaternion | Vector3 {
  if (out instanceof Vector3) {
    restOffset.copy(rest as Vector3).clampLength(0, cap);
    return out.copy(raw as Vector3).sub(rest as Vector3).clampLength(0, cap).add(restOffset);
  }
  swingPart.copy(rest as Quaternion).invert().multiply(raw as Quaternion).normalize();
  capAngle(swingPart, cap);
  capAngle(restPart.copy(rest as Quaternion), cap);
  return out.copy(restPart).multiply(swingPart).normalize();
}
