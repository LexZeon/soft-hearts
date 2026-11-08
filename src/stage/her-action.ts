/**
 * 她的动作, stage side (shared/her-actions.ts; docs/claude/2026-11-04-codex-actions.md): one of Codex's one-shot clips as an
 * overlay on the live pose, never owning the mixer or its timeline. Per frame, like the chat gesture (chat-gesture.ts):
 *   restore() -> base helper.update(delta) -> procedural layers -> frame(delta, gate) -> later writers, the display guard.
 *
 * Two ways of composing (Codex's own split):
 *  - arms: the clip's local rotations are absolute (Gene's Stand at both ends). The live arm is blended toward them,
 *    base · (base⁻¹ · sample)^w, continuing the way round it went (R29e). The weight eases in and out by smootherstep over
 *    a time sized by how far the arm chain has to go (R29f), so a base that is not the Stand starts and ends smoothly too.
 *  - delta: head / neck / upper-body rotations that are identity at both ends; they are multiplied onto the live pose,
 *    base · slerp(1, sample, w), so gaze, breathing and the idle keep running underneath.
 * Grant children (付与, e.g. Gene's 手捩連 from 手捩) follow the written bones by delta: child ← child · g(before)⁻¹ · g(after)
 * (the same rule as rps-performance.ts), and are restored with them.
 *
 * Giving way (R29, "禁止只是不开始新的动作，不是定住"): `frame(…, { yield: true })` starts a hand-back that fades the
 * weight to zero by smootherstep over 0.3–0.8 s sized by the overlay's largest chain angle (R29d), while the clip keeps
 * running underneath. Only a model change or a hidden window cuts at once. Only bone quaternion tracks are used: the
 * loader's position tracks (all zero in these clips) and any morph track are ignored.
 */
import { Quaternion, type AnimationClip, type Bone, type Interpolant, type KeyframeTrack, type SkinnedMesh } from 'three';
import type { HerBodyMode as HerActionMode } from '../../shared/her-actions';
import { RotationPath } from './rotation-path';

/**
 * `durationS`: the clip's own length (default clip.duration). `rate` (0.5–1) plays it slower: every sample is taken at elapsed · rate,
 * so its peak angular acceleration scales by rate². `strength` (0–1) scales the whole overlay (for a delta, its amplitude).
 */
export interface HerActionPlay { id: string; clip: AnimationClip; mode: HerActionMode; durationS?: number; rate?: number; strength?: number }
export interface HerActionState {
  active: boolean;
  id: string | null;
  mode: HerActionMode | null;
  phase: 'idle' | 'playing' | 'fading' | 'yielding';
  elapsedMs: number;
  durationMs: number;
  weight: number;
  fadeInMs: number;
  fadeOutMs: number;
  yieldMs: number;
  trackNames: string[];
  grants: number;
}
interface SampledTrack { name: string; bone: Bone; interpolant: Interpolant; base: Quaternion; applied: boolean; path: RotationPath }
interface GrantFollow { child: Bone; parent: SampledTrack; ratio: number; base: Quaternion; applied: boolean }
interface Playing {
  /** duration and elapsed are playback seconds; the clip is sampled at elapsed · rate. */
  id: string; mode: HerActionMode; duration: number; elapsed: number; rate: number; strength: number; fadeIn: number; fadeOut: number; sized: boolean;
  tracks: SampledTrack[]; grants: GrantFollow[];
  yieldFrom: number | null; yieldElapsed: number; yieldDuration: number;
}

/** R29c/R29f hand-off budget: peak angular acceleration (°/s²) of a smootherstep weight over the chain angle. */
export const HER_ACTION_ACCELERATION = 300;
export const HER_ACTION_FADE_IN_S = Object.freeze({ min: 0.25, max: 0.9 });
export const HER_ACTION_FADE_OUT_S = Object.freeze({ min: 0.45, max: 0.9 });
/** R29d: giving way mid-action (a touch, the game, a picked motion…), sized by the overlay's chain angle. */
export const HER_ACTION_YIELD_S = Object.freeze({ min: 0.3, max: 0.8 });
const MAX_CONSUMED = 128;
const BONE_TRACK = /^\.bones\[([^\][\u0000-\u001f]{1,128})\]\.quaternion$/;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Smootherstep: zero speed and acceleration at both ends. */
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
const sized = (angleDeg: number, bounds: { min: number; max: number }) =>
  clamp(Math.sqrt(10 / Math.sqrt(3) * Math.max(0, angleDeg) / HER_ACTION_ACCELERATION), bounds.min, bounds.max);
const finite = (q: Quaternion) => [q.x, q.y, q.z, q.w].every(Number.isFinite) && q.lengthSq() > 1e-12;

function usableTrack(track: KeyframeTrack, duration: number): boolean {
  if (!BONE_TRACK.test(track.name) || track.getValueSize() !== 4 || track.times.length < 1 || track.times.length > 100_000
    || track.values.length !== track.times.length * 4) return false;
  let previous = -Infinity;
  for (const time of track.times) { if (!Number.isFinite(time) || time < previous || time < 0 || time > duration + 0.05) return false; previous = time; }
  for (let index = 0; index < track.values.length; index += 4) {
    const length = Math.hypot(track.values[index], track.values[index + 1], track.values[index + 2], track.values[index + 3]);
    if (!Number.isFinite(length) || Math.abs(length - 1) > 0.1) return false;
  }
  return true;
}

export class HerActionPlayer {
  private readonly bones = new Map<string, Bone>();
  private readonly grantsOf = new Map<Bone, { child: Bone; ratio: number }[]>();
  private readonly consumed = new Set<string>();
  private current: Playing | null = null;
  private weight = 0;
  private disposed = false;
  private readonly sample = new Quaternion();
  private readonly identity = new Quaternion();
  private readonly gBefore = new Quaternion();
  private readonly gAfter = new Quaternion();

  constructor(mesh: SkinnedMesh) {
    const ambiguous = new Set<string>();
    for (const bone of mesh.skeleton.bones) { if (this.bones.has(bone.name)) ambiguous.add(bone.name); else this.bones.set(bone.name, bone); }
    for (const name of ambiguous) this.bones.delete(name);
    const grants = (mesh.geometry?.userData?.MMD?.grants ?? []) as { index: number; parentIndex: number; ratio: number; affectRotation: boolean; isLocal: boolean }[];
    for (const grant of Array.isArray(grants) ? grants : []) {
      const child = mesh.skeleton.bones[grant?.index], parent = mesh.skeleton.bones[grant?.parentIndex];
      if (!child || !parent || child === parent || !grant.affectRotation || grant.isLocal || !Number.isFinite(grant.ratio)) continue;
      const list = this.grantsOf.get(parent) ?? [];
      list.push({ child, ratio: grant.ratio });
      this.grantsOf.set(parent, list);
    }
  }

  /** The bone-quaternion track names of `clip` this mesh would play (unique bone names only). */
  bindable(clip: AnimationClip, durationS = clip.duration): string[] {
    const out: string[] = [];
    for (const track of clip.tracks) {
      if (!usableTrack(track, durationS)) continue;
      const bone = this.bones.get(BONE_TRACK.exec(track.name)![1]);
      if (bone && !out.includes(track.name)) out.push(track.name);
    }
    return out;
  }

  /** Starts one action. Refused (false): disposed, an id seen before, nothing playable, or another action still showing. */
  play(input: HerActionPlay): boolean {
    if (this.disposed || typeof input.id !== 'string' || !input.id || input.id.length > 160 || this.consumed.has(input.id)) return false;
    this.consumed.add(input.id);
    if (this.consumed.size > MAX_CONSUMED) this.consumed.delete(this.consumed.values().next().value!);
    if (this.current) return false;
    const clip = input.clip, duration = input.durationS ?? clip?.duration;
    if (!clip || !Array.isArray(clip.tracks) || !Number.isFinite(duration) || duration! <= 0 || duration! > 30 || clip.tracks.length > 2_000
      || (input.mode !== 'arms' && input.mode !== 'delta')) return false;
    const tracks: SampledTrack[] = [], used = new Set<Bone>();
    for (const track of clip.tracks) {
      if (!usableTrack(track, duration!)) continue;
      const bone = this.bones.get(BONE_TRACK.exec(track.name)![1]);
      if (!bone || used.has(bone)) continue;
      try {
        // The track's own factory is kept (the stage's keyframe interpolation, MMD's Bézier curves).
        tracks.push({ name: track.name, bone, interpolant: track.createInterpolant(), base: new Quaternion(), applied: false, path: new RotationPath() });
        used.add(bone);
      } catch { /* an unreadable track binds nothing */ }
    }
    if (!tracks.length) return false;
    const grants: GrantFollow[] = [];
    for (const track of tracks) for (const grant of this.grantsOf.get(track.bone) ?? [])
      if (!used.has(grant.child)) grants.push({ child: grant.child, parent: track, ratio: grant.ratio, base: new Quaternion(), applied: false });
    const fade = input.mode === 'delta' ? 0.15 : HER_ACTION_FADE_IN_S.min;
    const rate = Number.isFinite(input.rate) ? clamp(input.rate!, 0.5, 1) : 1, strength = Number.isFinite(input.strength) ? clamp(input.strength!, 0, 1) : 1;
    const playback = duration! / rate;
    this.current = { id: input.id, mode: input.mode, duration: playback, elapsed: 0, rate, strength, fadeIn: Math.min(fade, playback / 2),
      fadeOut: Math.min(input.mode === 'delta' ? 0.15 : HER_ACTION_FADE_OUT_S.min, playback / 2), sized: input.mode === 'delta',
      tracks, grants, yieldFrom: null, yieldElapsed: 0, yieldDuration: HER_ACTION_YIELD_S.min };
    this.weight = 0;
    return true;
  }

  get active(): boolean { return !!this.current; }

  /** Puts back exactly what this player wrote last frame (grant children first, then the tracks). */
  restore(): void {
    const playing = this.current;
    if (!playing) return;
    for (const grant of playing.grants) if (grant.applied) { grant.child.quaternion.copy(grant.base); grant.applied = false; }
    for (const track of playing.tracks) if (track.applied) { track.bone.quaternion.copy(track.base); track.applied = false; }
  }

  /**
   * One frame on the live base. `yield`: a higher owner wants the body; the action hands back smoothly and ends.
   * `cut`: hidden window or a model going away; restored at once.
   */
  frame(deltaSeconds: number, gate: { yield: boolean; cut?: boolean }): HerActionState {
    if (this.disposed) return this.getState();
    this.restore();
    if (gate.cut) { this.stop(); return this.getState(); }
    const playing = this.current;
    if (!playing) return this.getState();
    const delta = Number.isFinite(deltaSeconds) && deltaSeconds >= 0 ? Math.min(deltaSeconds, 0.25) : 0;
    playing.elapsed = Math.min(playing.duration, playing.elapsed + delta);
    if (!playing.sized && delta > 0) this.sizeFades(playing);
    // Nothing shown yet: giving way is simply not starting.
    if (gate.yield && playing.yieldFrom === null && this.weight <= 1e-6) { this.stop(); return this.getState(); }
    if (gate.yield && playing.yieldFrom === null) {
      playing.yieldFrom = this.weight;
      playing.yieldDuration = sized(this.overlayAngleDeg(playing, this.weight), HER_ACTION_YIELD_S);
    }
    if (playing.yieldFrom !== null) playing.yieldElapsed += delta;
    if (playing.elapsed >= playing.duration - 1e-9 || (playing.yieldFrom !== null && playing.yieldElapsed >= playing.yieldDuration)) {
      this.stop(); return this.getState();
    }
    const incoming = playing.fadeIn > 0 ? smooth(playing.elapsed / playing.fadeIn) : 1;
    const outgoing = playing.fadeOut > 0 ? smooth((playing.duration - playing.elapsed) / playing.fadeOut) : 1;
    this.weight = playing.yieldFrom === null ? playing.strength * incoming * outgoing : playing.yieldFrom * (1 - smooth(playing.yieldElapsed / playing.yieldDuration));
    if (this.weight <= 0) { for (const track of playing.tracks) track.path.reset(); return this.getState(); }
    for (const track of playing.tracks) {
      try {
        if (!this.read(track, playing.elapsed * playing.rate) || !finite(track.bone.quaternion)) { track.path.reset(); continue; }
        track.base.copy(track.bone.quaternion);
        this.compose(playing.mode, track, this.weight, track.bone.quaternion);
        track.applied = true;
      } catch { /* one bad sample never blocks the other bones or the restore */ }
    }
    for (const grant of playing.grants) {
      if (!grant.parent.applied) continue;
      grant.base.copy(grant.child.quaternion);
      this.gBefore.copy(this.identity).slerp(grant.parent.base, grant.ratio).invert();
      this.gAfter.copy(this.identity).slerp(grant.parent.bone.quaternion, grant.ratio);
      grant.child.quaternion.multiply(this.gBefore).multiply(this.gAfter);
      grant.applied = true;
    }
    return this.getState();
  }

  /** Hands back over the yield time (as if a higher owner arrived); `immediate` restores at once. */
  cancel({ immediate = false }: { immediate?: boolean } = {}): void {
    if (immediate || !this.current || this.weight <= 0) { this.restore(); this.stop(); return; }
    const playing = this.current;
    if (playing.yieldFrom === null) {
      playing.yieldFrom = this.weight;
      playing.yieldDuration = sized(this.overlayAngleDeg(playing, this.weight), HER_ACTION_YIELD_S);
    }
  }

  getState(): HerActionState {
    const playing = this.current;
    const phase: HerActionState['phase'] = !playing ? 'idle' : playing.yieldFrom !== null ? 'yielding'
      : playing.elapsed > playing.duration - playing.fadeOut ? 'fading' : 'playing';
    return { active: !!playing, id: playing?.id ?? null, mode: playing?.mode ?? null, phase,
      elapsedMs: (playing?.elapsed ?? 0) * 1_000, durationMs: (playing?.duration ?? 0) * 1_000, weight: this.weight,
      fadeInMs: (playing?.fadeIn ?? 0) * 1_000, fadeOutMs: (playing?.fadeOut ?? 0) * 1_000, yieldMs: playing?.yieldFrom != null ? playing.yieldDuration * 1_000 : 0,
      trackNames: playing?.tracks.map(track => track.name) ?? [], grants: playing?.grants.length ?? 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore(); this.stop(); this.disposed = true; this.consumed.clear(); this.bones.clear(); this.grantsOf.clear();
  }

  private stop(): void { this.current = null; this.weight = 0; }

  private read(track: SampledTrack, time: number): boolean {
    this.sample.fromArray(track.interpolant.evaluate(time) as unknown as number[]);
    return finite(this.sample);
  }

  /** base (already in `out`'s bone) composed with this frame's sample, by weight. */
  private compose(mode: HerActionMode, track: SampledTrack, weight: number, out: Quaternion): void {
    this.sample.normalize();
    if (mode === 'arms') { track.path.blend(track.base, this.sample, weight, out); return; }
    if (this.sample.w < 0) this.sample.set(-this.sample.x, -this.sample.y, -this.sample.z, -this.sample.w);
    const step = this.gAfter.copy(this.identity).slerp(this.sample, weight);
    out.copy(track.base).multiply(step).normalize();
  }

  /**
   * R29f: on the first frame with time, the fades are sized against the live base by the largest chain angle (degrees)
   * between the base and the clip's first and last poses (arms only; a delta is identity at both ends).
   */
  private sizeFades(playing: Playing): void {
    playing.sized = true;
    const local = new Map<Bone, [number, number]>(), base = new Quaternion();
    for (const track of playing.tracks) {
      try {
        base.copy(track.bone.quaternion).normalize();
        const at = (time: number) => this.read(track, time) ? base.angleTo(this.sample.normalize()) : 0;
        local.set(track.bone, [at(0), at(Math.max(0, (playing.duration - 1e-3) * playing.rate))]);
      } catch { /* an unreadable sample sizes nothing */ }
    }
    const start = this.chainMax(local, 0), end = this.chainMax(local, 1);
    playing.fadeIn = Math.min(playing.duration / 2, sized(start, HER_ACTION_FADE_IN_S));
    playing.fadeOut = Math.min(playing.duration / 2, sized(end, HER_ACTION_FADE_OUT_S));
  }

  /** How far the shown overlay sits from the base along its longest chain (degrees), at weight `weight`. */
  private overlayAngleDeg(playing: Playing, weight: number): number {
    const local = new Map<Bone, [number, number]>(), shown = new Quaternion(), base = new Quaternion();
    for (const track of playing.tracks) {
      try {
        if (!this.read(track, playing.elapsed * playing.rate)) continue;
        base.copy(track.bone.quaternion).normalize();
        this.compose(playing.mode, { ...track, base, path: new RotationPath() }, weight, shown);
        const angle = base.angleTo(shown.normalize());
        local.set(track.bone, [angle, angle]);
      } catch { /* skip */ }
    }
    return this.chainMax(local, 0);
  }

  private chainMax(local: Map<Bone, [number, number]>, end: 0 | 1): number {
    let best = 0;
    for (const bone of local.keys()) {
      let total = 0;
      for (let node: Bone | null = bone; node?.isBone; node = node.parent as Bone | null) total += local.get(node)?.[end] ?? 0;
      best = Math.max(best, total);
    }
    return best * 180 / Math.PI;
  }
}
