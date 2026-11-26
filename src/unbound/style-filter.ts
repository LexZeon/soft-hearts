/**
 * Unbound U1 part 2: an optional softening of a motion's bones, per group (docs/claude/2026-11-12-unbound-u1-part2.md).
 *
 * Codex T-242 §4: keep good VMD crisp. So every group's weight is 0 by default, and at 0 this filter does not touch the bone at
 * all (a true bypass: the trajectory is the motion's own, frame for frame, not "a very stiff spring that is nearly the same").
 * With a weight above 0, the group's bones follow the motion through the group's second-order spring (MOTION_GROUPS) in
 * rotation-vector space (MMD local rotations are relative to an identity bind pose, so log(q) is the bone's rotation), and the
 * shown rotation is slerp(motion, followed, weight). A change of weight eases in and out (an eased spring), and the followers
 * start where the motion is on the first frame they are used, so turning a group on or off never pops.
 * Legs, feet and the root are never in a group: contacts belong to the contact owner (contact.ts), not to a filter.
 */
import { Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import { MOTION_GROUPS, Spring, expMap, type SpringGroup } from './dynamics';
import { figureBone } from './model/figure-bones';

const FINGERS = ['親指', '人指', '中指', '薬指', '小指'].flatMap(f => ['０', '１', '２', '３'].map(n => f + n));
export const STYLE_GROUP_BONES: Readonly<Record<Exclude<SpringGroup, 'pelvis'>, readonly string[]>> = Object.freeze({
  head: ['頭'],
  neck: ['首'],
  chest: ['上半身', '上半身2'],
  arms: ['左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首'],
  fingers: ['左', '右'].flatMap(side => FINGERS.map(name => side + name)),
});
export type StyleGroup = keyof typeof STYLE_GROUP_BONES;

interface Followed { bone: Bone; axes: [Spring, Spring, Spring] }
interface Group { weight: Spring; bones: Followed[]; started: boolean }
/** Below this the blend counts as off: the group is bypassed again. */
const OFF = 1e-4;

/** log(q) for a unit quaternion, shortest way (angle ≤ π). */
function logMap(q: Quaternion, out: Vector3): Vector3 {
  const sign = q.w < 0 ? -1 : 1, w = Math.min(1, q.w * sign);
  const angle = 2 * Math.acos(w), s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-9) return out.set(q.x * sign * 2, q.y * sign * 2, q.z * sign * 2);
  return out.set(q.x * sign / s * angle, q.y * sign / s * angle, q.z * sign / s * angle);
}

export class VmdStyleFilter {
  private readonly groups = new Map<StyleGroup, Group>();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();

  constructor(mesh: SkinnedMesh) {
    for (const [group, names] of Object.entries(STYLE_GROUP_BONES) as [StyleGroup, readonly string[]][]) {
      const spec = MOTION_GROUPS[group];
      const bones = names.map(name => figureBone(mesh, [name])).filter((bone): bone is Bone => !!bone)
        .map(bone => ({ bone, axes: [new Spring(spec), new Spring(spec), new Spring(spec)] as [Spring, Spring, Spring] }));
      this.groups.set(group, { weight: new Spring({ hz: 1.5, eased: true }, 0), bones, started: false });
    }
  }

  /** 0 (default) leaves the group's bones exactly as the motion has them; up to 1 shows the followed rotation. Eases there. */
  setWeight(group: StyleGroup, weight: number): void {
    const entry = this.groups.get(group);
    if (entry && Number.isFinite(weight)) entry.weight.target = Math.min(1, Math.max(0, weight));
  }
  /** Any group in use (or still easing out). */
  get active(): boolean {
    for (const entry of this.groups.values()) if (entry.weight.target > 0 || entry.weight.value > OFF) return true;
    return false;
  }

  /**
   * After the mixer, before any residual: `count` sub-steps of `h` (the caller's fixed sub-steps). A group that is off is not
   * touched at all. `changed(bone)` is called before a bone is written (the caller restores it with its residuals).
   */
  apply(count: number, h: number, changed: (bone: Bone) => void): void {
    for (const entry of this.groups.values()) {
      for (let i = 0; i < count; i++) entry.weight.advance(h);
      if (entry.weight.target === 0 && entry.weight.value <= OFF) { entry.weight.reset(0); entry.started = false; continue; }
      const weight = Math.min(1, Math.max(0, entry.weight.value));
      for (const followed of entry.bones) {
        logMap(followed.bone.quaternion, this.v);
        const [x, y, z] = followed.axes;
        if (!entry.started) { x.reset(this.v.x); y.reset(this.v.y); z.reset(this.v.z); }
        x.target = this.v.x; y.target = this.v.y; z.target = this.v.z;
        for (let i = 0; i < count; i++) { x.advance(h); y.advance(h); z.advance(h); }
        changed(followed.bone);
        expMap(this.v.set(x.value, y.value, z.value), this.q);
        followed.bone.quaternion.slerp(this.q, weight);
      }
      entry.started = true;
    }
  }
}
