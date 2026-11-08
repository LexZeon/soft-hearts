import type { SkinnedMesh } from 'three';
import { buildPhysicsRigPlan } from './physics-rig';
import { BaseSourceWatch, PoseContinuity, type PoseContinuityState, type WatchedMixer } from './pose-continuity';

/**
 * Stage glue for the R29 display-continuity guard (see pose-continuity.ts).
 * The stage calls, per rendered frame and in this order:
 *   base(mixer, dt)        right after the mixer/helper update
 *   apply(dt, gap, bypass) after every writer, before local physics
 *   remove()               right after render
 * and reset(reason) for hard cuts (hide, character/scope change, preview start).
 *
 * Exclusions, decided once per mesh:
 * - every bone local physics can write (it runs after this guard and owns them);
 * - eye bones: gaze is Stage-owned and already damped, and authored eye darts
 *   in reaction clips are deliberately instant (a smoothed saccade looks floaty);
 * - the eyelid (blink) and mouth-open morphs: each has one dedicated compositor
 *   (eyelid: natural blink vs contact closure; mouth: feeding vs speech) that is
 *   continuous by construction, while natural blinks close in ~80 ms and
 *   lip-sync changes direction every few frames; any threshold that caught a
 *   snap there would also blunt every blink and syllable. A model with only
 *   per-eye blinks has its second eyelid morph passed as `linkedMorphs`.
 */
const EYE_BONE = /^(?:左目|右目|両目|左眼|右眼|両眼|lefteye|righteye|eyes|eye[_ .-]?[lr]|[lr][_ .-]?eye)$/iu;
export const EMPTY_CONTINUITY_STATE: PoseContinuityState = Object.freeze({ active: 0, maxAngleDeg: 0, maxPosition: 0, maxMorph: 0,
  jumps: 0, lastJump: null, resets: 0, lastReset: 'none', baseTrusted: false, properties: 0 }) as PoseContinuityState;

export function continuityExcludedBones(mesh: SkinnedMesh): number[] {
  const excluded = new Set<number>();
  try {
    const rig = buildPhysicsRigPlan(mesh);
    for (const index of [...rig.hair.dynamicBoneIndices, ...rig.chest.dynamicBoneIndices]) excluded.add(index);
  } catch { /* An unreadable rig grants physics nothing; all bones stay guarded. */ }
  mesh.skeleton.bones.forEach((bone: { name: string }, index: number) => { if (EYE_BONE.test(bone.name.normalize('NFKC'))) excluded.add(index); });
  return [...excluded].sort((a, b) => a - b);
}

/**
 * Pretrial 2026-11-03: the lid-shape morphs that give way to the natural blink as it closes (EyelidCompositor: eye smile and
 * half lid; procedural-life applyFace: wide eyes; behavior-motion.ts: its authored eye shapes) move at the blink's own speed
 * while it runs. `slots` are the model profile's (procedural-life LifeSlots), `eyeShapes` the authored eye-shape morph names.
 */
export function blinkRiderMorphs(mesh: SkinnedMesh, slots: Readonly<Record<string, number | undefined>> | null | undefined, eyeShapes: ReadonlySet<string>): number[] {
  const out = new Set<number>();
  for (const key of ['smileEyes', 'jitome', 'surprise']) { const index = slots?.[key]; if (typeof index === 'number' && Number.isInteger(index) && index >= 0) out.add(index); }
  for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) if (eyeShapes.has(name.normalize('NFKC'))) out.add(index);
  return [...out].sort((a, b) => a - b);
}

export class StageContinuity {
  private guard: PoseContinuity | null = null;
  private readonly watch = new BaseSourceWatch();
  private bypassed = false;

  /** Rebuilds for a new mesh or compositor owner; the first frame of a new guard passes through. */
  private ensure(mesh: SkinnedMesh, height: number, blinkIndex: number, mouthIndex: number, linkedMorphs: readonly number[]): PoseContinuity {
    const current = this.guard, linked = linkedMorphs.join(',');
    if (current && current.mesh === mesh && this.height === height && this.blink === blinkIndex && this.mouth === mouthIndex && this.linked === linked
      && this.bones === mesh.skeleton.bones.length && this.morphs === (mesh.morphTargetInfluences?.length ?? 0)) return current;
    this.guard?.remove();
    this.guard = new PoseContinuity(mesh as unknown as ConstructorParameters<typeof PoseContinuity>[0], {
      height, excludedBones: continuityExcludedBones(mesh), excludedMorphs: [blinkIndex, mouthIndex, ...linkedMorphs].filter(index => index >= 0),
    });
    this.height = height; this.blink = blinkIndex; this.mouth = mouthIndex; this.linked = linked;
    this.bones = mesh.skeleton.bones.length; this.morphs = mesh.morphTargetInfluences?.length ?? 0;
    this.watch.reset();
    return this.guard;
  }
  private height = 0; private blink = -1; private mouth = -1; private linked = ''; private bones = 0; private morphs = 0;

  /** Right after the mixer/helper update: (re)binds the mesh and snapshots its base pose. */
  base(mesh: SkinnedMesh | null, mixer: WatchedMixer | null | undefined, dt: number, height: number, blinkIndex: number, mouthIndex: number,
    linkedMorphs: readonly number[] = []): void {
    if (!mesh) { this.release(); return; }
    this.ensure(mesh, height, blinkIndex, mouthIndex, linkedMorphs).captureBase(this.watch.observe(mixer, dt));
  }

  /**
   * `bypass` (maintainer QA) shows the exact composed pose every frame and keeps no history. `ownedMorphs`: this frame's
   * morphs that belong to a dedicated owner continuous by construction (the lid shapes riding a natural blink, see
   * blinkRiderMorphs); followed, not judged.
   */
  apply(dt: number, gap: number, bypass: boolean, ownedMorphs: readonly number[] | null = null): void {
    const guard = this.guard;
    if (!guard) return;
    if (bypass) { if (!this.bypassed) guard.reset('bypass'); this.bypassed = true; return; }
    if (this.bypassed) { guard.reset('bypass-ended'); this.bypassed = false; }
    guard.apply(dt, gap, ownedMorphs);
  }

  /**
   * R29f: a lookup of the composed pose's own rate per track name (`.bones[名].quaternion` / `.position`), as the
   * guard measured it on the last rendered frame of this mesh (pose-continuity.ts rate); null for anything unknown.
   * A hand-off bridge (motion-transition.ts) starts from the shown pose at this speed instead of from rest.
   */
  rates(mesh: SkinnedMesh | null): (name: string) => number[] | null {
    const guard = this.guard;
    if (!guard || !mesh || guard.mesh !== (mesh as unknown)) return () => null;
    const index = new Map<string, number>(), ambiguous = new Set<string>();
    mesh.skeleton.bones.forEach((bone: { name: string }, i: number) => { if (index.has(bone.name)) ambiguous.add(bone.name); else index.set(bone.name, i); });
    return name => {
      const match = /^\.bones\[([^[\]]+)\]\.(quaternion|position)$/.exec(name);
      const i = match && !ambiguous.has(match[1]) ? index.get(match[1]) : undefined;
      return i === undefined ? null : guard.rate(i, match![2] as 'quaternion' | 'position');
    };
  }

  remove(): void { this.guard?.remove(); }
  reset(reason: string): void { this.guard?.reset(reason); this.watch.reset(); }
  release(): void { this.guard?.remove(); this.guard = null; this.watch.reset(); }
  getState(): PoseContinuityState { return this.guard?.getState() ?? EMPTY_CONTINUITY_STATE; }
}
