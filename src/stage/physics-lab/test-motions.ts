/**
 * 物理调参台: fixed test motions, written on the model's standard bones the way the companion's final pose would be (the lab writes them
 * after restore() and before the physics frame, the stage's order). Smooth everywhere (no step in position or velocity at a loop's
 * seam), so every jump the meter sees comes from the physics, not from the motion. Pure: bones in, no DOM, no Ammo.
 */
import { Euler, Quaternion, type Bone, type SkinnedMesh } from "three";

export const TEST_MOTIONS = ["rest", "headTurn", "nod", "wave", "steps", "dragStop"] as const;
export type TestMotion = typeof TEST_MOTIONS[number];

export const TEST_MOTION_LABELS: Readonly<Record<TestMotion, string>> = Object.freeze({
  rest: "静止", headTurn: "转头", nod: "点头", wave: "挥手", steps: "走几步", dragStop: "拖动后停下",
});

/** Loop length (seconds at speed 1). */
export const TEST_MOTION_PERIOD: Readonly<Record<TestMotion, number>> = Object.freeze({
  rest: 4, headTurn: 4, nod: 3, wave: 4, steps: 4, dragStop: 5,
});

/** The part of a loop (seconds, from..to) in which a motion holds still: jitter and settle time are measured there. */
export const TEST_MOTION_STILL: Readonly<Record<TestMotion, readonly [number, number] | null>> = Object.freeze({
  rest: [0, 4], headTurn: null, nod: null, wave: null, steps: null, dragStop: [1.0, 3.5],
});

/** Seconds the motion has held still at loop time `t` (seconds at speed 1), or null while it moves. */
export function stillFor(motion: TestMotion, t: number): number | null {
  const range = TEST_MOTION_STILL[motion], period = TEST_MOTION_PERIOD[motion];
  const inLoop = ((t % period) + period) % period;
  return range && inLoop >= range[0] && inLoop < range[1] ? inLoop - range[0] : null;
}

const names: Record<string, RegExp> = {
  center: /^(センター|center)$/iu, upper: /^(上半身|upper ?body|spine)$/iu, neck: /^(首|neck)$/iu, head: /^(頭|head)$/iu,
  rightArm: /^(右腕|right ?arm|upperarm[._ ]?r)$/iu, rightElbow: /^(右ひじ|右肘|right ?elbow|forearm[._ ]?r)$/iu,
};

export interface MotionRig {
  readonly bones: Partial<Record<keyof typeof names, Bone>>;
}

export function motionRig(mesh: SkinnedMesh): MotionRig {
  const bones: Partial<Record<keyof typeof names, Bone>> = {};
  for (const bone of mesh.skeleton.bones) {
    const name = bone.name.normalize("NFKC");
    for (const key of Object.keys(names) as (keyof typeof names)[]) if (!bones[key] && names[key].test(name)) bones[key] = bone;
  }
  return { bones };
}

/** 0→1→0 with zero slope at both ends (smooth at the loop seam). */
const bump = (x: number) => { const t = Math.min(1, Math.max(0, x)); return 0.5 - 0.5 * Math.cos(2 * Math.PI * t); };
/** 0→1 with zero slope at both ends. */
const ease = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

const euler = new Euler(), turn = new Quaternion();
function rotate(bone: Bone | undefined, x: number, y: number, z: number): void {
  if (!bone) return;
  turn.setFromEuler(euler.set(x, y, z, "YXZ"));
  bone.quaternion.multiply(turn);
}

/**
 * Writes one motion at time `t` (seconds, already scaled by the speed) on top of the current (restored) pose.
 * `scale` is the model's height unit (model units per 1.6 m figure; MMD figures are about 20 units tall).
 */
export function applyTestMotion(rig: MotionRig, motion: TestMotion, t: number, scale = 1): void {
  const period = TEST_MOTION_PERIOD[motion];
  const phase = ((t % period) + period) % period / period;
  const { bones } = rig;
  switch (motion) {
    case "rest": return;
    case "headTurn": {
      // Left, hold, right, hold: ±35°.
      const side = phase < 0.5 ? 1 : -1;
      rotate(bones.head, 0, side * 0.61 * bump(phase * 2 % 1), 0);
      return;
    }
    case "nod": rotate(bones.head, 0.38 * bump(phase), 0, 0); rotate(bones.neck, 0.12 * bump(phase), 0, 0); return;
    case "wave": {
      const up = bump(phase);
      rotate(bones.rightArm, 0, 0, 1.1 * up);
      rotate(bones.rightElbow, 0, -0.9 * up + 0.45 * up * Math.sin(phase * 2 * Math.PI * 6), 0);
      return;
    }
    case "steps": {
      const center = bones.center;
      if (center) {
        center.position.y += -0.25 * scale * bump(phase * 4 % 1);
        center.position.x += 0.35 * scale * Math.sin(phase * 2 * Math.PI);
        center.position.z += 1.2 * scale * bump(phase);
      }
      rotate(bones.upper, 0, 0.12 * Math.sin(phase * 4 * Math.PI), 0.04 * Math.sin(phase * 4 * Math.PI));
      return;
    }
    case "dragStop": {
      // A quick slide over 0.6 s that stops dead, a hold, then a slow return (the measured part is the stop).
      const seconds = phase * period;
      const out = seconds < 0.4 ? 0 : seconds < 1.0 ? ease((seconds - 0.4) / 0.6) : seconds < 3.5 ? 1 : 1 - ease((seconds - 3.5) / 1.5);
      if (bones.center) bones.center.position.x += 4 * scale * out;
      return;
    }
  }
}
