/**
 * I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): the library's motions (VMD, authored on Gene) onto the standard
 * skeleton, through the app's own motion conversion (shared/actions/motion-retarget.ts): the standard skeleton has Gene's names and
 * Gene's hierarchy, so the conversion only does what proportions and rest pose ask for: the arms aligned by direction (a VRM's T
 * pose is no obstacle), each hand and finger by its rest frame, the translations scaled by leg length. Faces map slot to slot with
 * ratio 1 ("按比例": a weight is that much of the model's own expression). A library motion whose hands touch gets the same contact
 * fit as on any other model (adaptMotion). Any other VMD (the user's own) is converted the same way without that fit.
 */
import { sha256Hex } from '../../../shared/foundation/sha256-sync';
import { STANDARD_POSE, type FingerSlot, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import { adaptMotion, contactFor, planRetarget, retargetVmd, STANDARD_SOURCE_RIG, type RetargetPlan, type RetargetRig, type VmdLike } from '../../../shared/actions';
import type { StandardBoneSpec, StandardMorphSpec } from './standard-skeleton';

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** The standard skeleton as the conversion's target rig (positions in model units, proportions from its joints). */
export function standardRetargetRig(specs: readonly StandardBoneSpec[], morphs: readonly StandardMorphSpec[], heightUnits: number): RetargetRig {
  const slots: Partial<Record<StandardBone, number>> = {}, fingers: Partial<Record<FingerSlot, number>> = {};
  specs.forEach((spec, i) => { if (spec.slot) slots[spec.slot] = i; if (spec.finger) fingers[spec.finger] = i; });
  const p = (slot: StandardBone) => slots[slot] !== undefined ? specs[slots[slot]!].position : null;
  const chain = (parts: StandardBone[]) => {
    const points = parts.map(p);
    if (points.some(point => !point)) return null;
    let length = 0;
    for (let i = 1; i < points.length; i++) length += points[i]!.distanceTo(points[i - 1]!);
    return length;
  };
  const mean = (values: (number | null)[]) => { const ok = values.filter((v): v is number => v !== null); return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null; };
  const head = p('head'), neck = p('neck');
  const morphSlots: RetargetRig['morphSlots'] = {};
  for (const morph of morphs) {
    if (!morph.slot) continue; // I-164: a named face shape is no slot (no library motion routes into it by slot)
    const source = STANDARD_POSE.morphSlots[morph.slot];
    // Only the slot's own name routes a motion's morph track (the extra cue names stand for the same expression).
    if (source && source.name === morph.name) morphSlots[morph.slot] = { name: morph.name, amplitude: source.amplitude, policy: source.policy };
  }
  const left = p('armLeft'), right = p('armRight');
  return {
    key: `standard-body:${sha256Hex(new TextEncoder().encode(JSON.stringify(specs.map(spec => [spec.name, spec.parent, spec.position.toArray().map(round)]))))}`,
    bones: specs.map(spec => ({ name: spec.name, parent: spec.parent, position: spec.position.toArray().map(round) as [number, number, number] })),
    slots, fingers,
    height: heightUnits,
    legLength: mean([chain(['legLeft', 'kneeLeft', 'ankleLeft']), chain(['legRight', 'kneeRight', 'ankleRight'])]),
    armLength: mean([chain(['armLeft', 'elbowLeft', 'wristLeft']), chain(['armRight', 'elbowRight', 'wristRight'])]),
    shoulderWidth: left && right ? Math.abs(left.x - right.x) : null,
    // From the joints only (no face mesh is read): about the neck-to-head span the standard pose has (Gene: 2.87 for 1.5).
    headSize: head && neck ? Math.max(heightUnits * 0.08, head.distanceTo(neck) * (STANDARD_POSE.headSize / 1.5)) : heightUnits * 0.15,
    morphSlots, morphNames: morphs.map(morph => morph.name), collision: null,
  };
}

const LIMIT = 96;
/** The parser hook for every VMD on this standard body (catalog motions cached by content). */
export class StandardMotionRetarget {
  readonly plan: RetargetPlan;
  private readonly cache = new Map<string, VmdLike>();
  constructor(readonly rig: RetargetRig) { this.plan = planRetarget(STANDARD_SOURCE_RIG, rig); }

  readonly transform = <T extends VmdLike>(vmd: T, buffer: ArrayBuffer): T => {
    let sha = '';
    try { sha = sha256Hex(buffer); } catch { sha = ''; }
    const hit = sha ? this.cache.get(sha) : undefined;
    if (hit) return hit as T;
    const contact = sha ? contactFor(sha) : null;
    const out = contact ? adaptMotion(vmd, this.plan, { contact }).vmd : retargetVmd(vmd, this.plan).vmd;
    if (sha) { this.cache.set(sha, out); while (this.cache.size > LIMIT) this.cache.delete(this.cache.keys().next().value!); }
    return out;
  };
}
