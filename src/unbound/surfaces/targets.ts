/**
 * Unbound U4, layer 2 for surfaces: a surface plan (shared/unbound/surfaces/plan.ts, numbers) → PoseTargets, the same goals the
 * peek's generator gives layer 3 (src/unbound/motion/generator.ts). Goals only: layer 3's springs make them move like a person
 * (eyes first, head, then the upper body), the gait walks her to the place, and the contact owner keeps her feet down.
 *
 * `into` is how far along the pose she is, 0 = standing at the place upright, 1 = fully in the pose (leaning out / leaning on):
 * the caller steps it over time (or sets it from a beat), the springs smooth the steps.
 */
import { REST_TARGETS, type PoseTargets } from '../motion/generator';
import type { PlanBase } from '../../../shared/unbound/surfaces/plan';

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const HEAD_KEEPS_UPRIGHT = 0.3;

export function surfaceTargets(plan: PlanBase & { kind: 'peek' | 'lean' | 'between' }, into: number, curiosity = 0.4): PoseTargets {
  const k = clamp01(into), lean = plan.pose.leanRad * k;
  // The torso roll's sign convention in layer 3 is checked in the preview (the head must move the way the plan says); +roll = toward her left = +x.
  const roll = lean;
  return {
    ...REST_TARGETS,
    place: { x: plan.stand.xM, z: -plan.stand.depthM },
    facing: { x: plan.gaze.x, z: plan.gaze.z },
    torso: { pitch: 0, yaw: 0, roll },
    neck: { pitch: 0, yaw: 0, roll: -roll * HEAD_KEEPS_UPRIGHT * 0.5 },
    head: { pitch: 0, yaw: 0, roll: -roll * HEAD_KEEPS_UPRIGHT * 0.5 },
    tiptoe: plan.pose.riseM > 0 ? clamp01(plan.pose.riseM / 0.08) * k : 0,
    face: { curious: curiosity * k, smile: 0, startle: 0 },
    tempo: 'calm',
  };
}
