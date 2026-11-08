import type { Bone, SkinnedMesh } from 'three';

// Asset-owner approved source profile283b9e02; public Gene0ef only.
// These are bounded engineering inputs, not visual/native/daily acceptance.
export interface DrowsyTargets { readonly head: 9; readonly brow: 68; readonly eye: 95 }
export function resolveDrowsyTargets(mesh: SkinnedMesh | undefined, head: Bone | undefined, verifiedGene: boolean): DrowsyTargets | null {
  if (verifiedGene !== true || !mesh || !head || mesh.skeleton?.bones[9] !== head || head.name !== '頭'
    || mesh.skeleton.bones.filter(bone => bone.name === '頭').length !== 1) return null;
  const dictionary = mesh.morphTargetDictionary, values = mesh.morphTargetInfluences;
  const base = mesh.geometry?.getAttribute('position'), targets = mesh.geometry?.morphAttributes.position;
  if (!dictionary || !values || values.length !== 184 || !base?.count || !targets || targets.length < 184) return null;
  const entries = Object.entries(dictionary);
  for (const [name, index] of [['困る', 68], ['じと目', 95], ['まばたき', 88], ['笑い', 89]] as const) {
    if (dictionary[name] !== index || entries.filter(([, value]) => value === index).length !== 1
      || targets[index]?.count !== base.count || !Number.isFinite(values[index])) return null;
  }
  // PMX vertex/panel identity comes from the host's exact audited content gate,
  // together with these fixed structural bindings; names alone never admit.
  return { head: 9, brow: 68, eye: 95 };
}

/**
 * I-024 (docs/claude/2026-11-04-i024-stage.md): the same drowsy face on any other model whose capability card has
 * 困的脸 on, through its own profile slots: troubled brows (`sad`) and half-lowered lids (`jitome`). Never Gene's raw
 * indices. A part the model lacks is skipped (-1); a half lid that is the blink morph itself is skipped too, so the
 * eyelid compositor stays the one writer of the blink. null: nothing to show.
 */
export interface ProfileDrowsyTargets { readonly brow: number; readonly eye: number }
export function profileDrowsyTargets(mesh: SkinnedMesh | undefined, head: Bone | undefined,
  slots: { sad: number; jitome: number; blink: number }): ProfileDrowsyTargets | null {
  if (!mesh || !head) return null;
  const count = mesh.morphTargetInfluences?.length ?? 0;
  const usable = (index: number) => Number.isInteger(index) && index >= 0 && index < count && Number.isFinite(mesh.morphTargetInfluences![index]);
  const brow = usable(slots.sad) && slots.sad !== slots.blink ? slots.sad : -1;
  const eye = usable(slots.jitome) && slots.jitome !== slots.blink && slots.jitome !== brow ? slots.jitome : -1;
  return brow < 0 && eye < 0 ? null : { brow, eye };
}
/**
 * I-038: the developer note when 困的脸 shows only part of itself on this model (another model, card on): which of its two
 * expressions it lacks, in the user's words. '' when both are there (or nothing to say).
 */
export function drowsyFaceGapNote(targets: ProfileDrowsyTargets | null): string {
  if (!targets || (targets.brow >= 0 && targets.eye >= 0)) return '';
  return `困的脸缺${targets.brow < 0 ? '皱眉表情：只做半闭眼' : '半闭眼表情：只做皱眉'}`;
}

export interface DrowsyContext {
  scope: string | null; verified: boolean; phase: string | null; F: number | null;
  headAllowed: boolean; browAllowed: boolean; eyeAllowed: boolean; finalClosure: number;
}
export interface DrowsyFrame { headX: number; brow: number; eyeShape: number; rawEye: number; active: boolean }
/**
 * R29c: a channel whose owner leaves (contact, music, a window/camera adjust,
 * an authored face, falling asleep) fades from the value it shows to zero over
 * this time, with zero speed at both ends, instead of vanishing in one frame.
 */
export const DROWSY_RELEASE_SECONDS = 0.35;
/** Phases the profile may show in; the sleep phases only release what is already shown. */
export const DROWSY_PHASES: readonly string[] = Object.freeze(['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake']);
const SLEEP_PHASES: readonly string[] = DROWSY_PHASES.slice(3);
const neutral = (): DrowsyFrame => ({ headX: 0, brow: 0, eyeShape: 0, rawEye: 0, active: false });
const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const smoothstep = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const HEAD = 0, BROW = 1, EYE = 2;
export class DrowsyExpression {
  private scope: string | null = null;
  private head = 0; private brow = 0; private eye = 0;
  /** Per channel (head, brow, eye): the value shown when its owner left, and seconds into that release (-1: none). */
  private readonly releaseFrom = new Float64Array(3);
  private readonly releaseTime = new Float64Array(3).fill(-1);
  get active(): boolean { return this.head !== 0 || this.brow !== 0 || this.eye !== 0; }
  /** Whether any channel is fading out after losing its owner (diagnostics). */
  get releasing(): boolean { return this.releaseTime[HEAD] >= 0 || this.releaseTime[BROW] >= 0 || this.releaseTime[EYE] >= 0; }
  /** Hard clear (hidden, scope or model change, invalid input): no fade, nothing carried over. */
  reset(): void { this.scope = null; this.head = this.brow = this.eye = 0; this.releaseTime.fill(-1); this.releaseFrom.fill(0); }
  frame(delta: number, context: DrowsyContext): DrowsyFrame {
    if (!Number.isFinite(delta) || context.verified !== true || typeof context.scope !== 'string' || !context.scope.length
      || !unit(context.F) || !unit(context.finalClosure) || !DROWSY_PHASES.includes(context.phase ?? '')) {
      this.reset(); return neutral();
    }
    if (this.scope !== context.scope) { this.reset(); this.scope = context.scope; }
    const dt = Math.max(0, Math.min(.1, delta)), strength = context.phase === 'drowsy' ? context.F : 0;
    const sleeping = SLEEP_PHASES.includes(context.phase!);
    this.head = this.channel(HEAD, this.head, .018 * strength, !sleeping && context.headAllowed === true, dt);
    this.brow = this.channel(BROW, this.brow, .06 * strength, !sleeping && context.browAllowed === true, dt);
    this.eye = this.channel(EYE, this.eye, .12 * strength, !sleeping && context.eyeAllowed === true, dt);
    // Safety mask is after raw smoothing on EVERY frame, including dt=0: the
    // final eyelid closure (natural blink included) keeps priority over the eye shape, fading or not.
    return { headX: this.head, brow: this.brow, eyeShape: this.eye * (1 - context.finalClosure), rawEye: this.eye, active: this.active };
  }
  /** Owned: ease toward the target. Not owned: fade from the shown value to zero (smoothstep), then stay out. */
  private channel(index: number, current: number, target: number, allowed: boolean, dt: number): number {
    if (allowed) {
      // Owner back mid-release: continue from what is shown, no restart.
      this.releaseTime[index] = -1;
      const tau = Math.abs(target) > Math.abs(current) ? .35 : .5;
      const next = current + (target - current) * (1 - Math.exp(-dt / tau));
      return Math.abs(next) <= Number.EPSILON ? 0 : next;
    }
    if (current === 0) { this.releaseTime[index] = -1; return 0; }
    if (this.releaseTime[index] < 0) { this.releaseFrom[index] = current; this.releaseTime[index] = 0; }
    const time = this.releaseTime[index] = Math.min(DROWSY_RELEASE_SECONDS, this.releaseTime[index] + dt);
    const next = this.releaseFrom[index] * (1 - smoothstep(time / DROWSY_RELEASE_SECONDS));
    if (time >= DROWSY_RELEASE_SECONDS || Math.abs(next) <= Number.EPSILON) { this.releaseTime[index] = -1; return 0; }
    return next;
  }
}
