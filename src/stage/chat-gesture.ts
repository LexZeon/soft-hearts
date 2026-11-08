import { AnimationClip, Quaternion, type Bone, type Interpolant, type KeyframeTrack, type SkinnedMesh } from 'three';
import { RotationPath } from './rotation-path';

export interface ChatGesturePlay {
  id: string;
  clip: AnimationClip;
  strength: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}
export interface ChatGestureState {
  active: boolean;
  id: string | null;
  phase: 'idle' | 'playing' | 'fading';
  elapsedMs: number;
  durationMs: number;
  weight: number;
  trackNames: string[];
}
interface SampledTrack {
  name: string;
  bone: Bone;
  interpolant: Interpolant;
  base: Quaternion;
  applied: boolean;
  /** R29e: which way round from the live base to the sample, kept while the overlay shows. */
  path: RotationPath;
}
interface PlayingGesture {
  id: string;
  duration: number;
  elapsed: number;
  strength: number;
  fadeIn: number;
  fadeOut: number;
  tracks: SampledTrack[];
  cancelWeight: number | null;
  cancelElapsed: number;
  /** R29f: fade times still to be sized on the first frame shown (none were asked for). */
  sizeFades: boolean;
}

const MAX_CONSUMED_IDS = 128;
const CANCEL_SECONDS = 0.15;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** R29f: smootherstep (zero speed and acceleration at both ends; was smoothstep, whose acceleration steps at each end). */
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
/**
 * R29f: a gesture starts far from the base pose (an arm at the side rises ~40 deg to its first pose), and a fixed
 * 250 ms fade swung it there at ~270 deg/s. The fades are sized on the first frame shown by how far the overlay
 * moves the arm chain (degrees, times its strength), so the peak angular acceleration of smootherstep
 * (10/sqrt(3) · angle / T^2) stays near GESTURE_ACCELERATION, the R29c hand-off budget, within the bounds below.
 */
export const GESTURE_ACCELERATION = 300;
export const GESTURE_FADE_IN_S = Object.freeze({ min: 0.25, max: 0.9 });
export const GESTURE_FADE_OUT_S = Object.freeze({ min: 0.45, max: 0.9 });
const sizedFade = (angleDeg: number, bounds: { min: number; max: number }) =>
  clamp(Math.sqrt(10 / Math.sqrt(3) * Math.max(0, angleDeg) / GESTURE_ACCELERATION), bounds.min, bounds.max);
const finiteQuaternion = (value: Quaternion) => [value.x, value.y, value.z, value.w].every(Number.isFinite) && value.lengthSq() > 1e-12;
const fadeSeconds = (value: number | undefined, fallback: number, duration: number) =>
  Math.min(duration, (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback) / 1_000);

/** Exact bone-property allowlist, never a PropertyBinding path evaluator. */
export function isChatGestureTrack(name: string): boolean {
  const match = /^\.bones\[([^\]\[\u0000-\u001f]{1,128})\]\.quaternion$/.exec(name);
  if (!match) return false;
  const bone = match[1].normalize('NFKC').toLowerCase().split(/[:|]/).at(-1)!.replace(/[\s_.-]/g, '');
  return /^(?:上半身[1-3]?|(?:左|右)(?:肩|腕|ひじ|肘|手首))$/.test(bone) ||
    /^(?:(?:left|right|[lr])?(?:shoulder|upperarm|lowerarm|forearm|arm|elbow|wrist|hand)(?:left|right|[lr])?|(?:spine|chest|thorax)[1-3]?)$/.test(bone);
}

function validTrack(track: KeyframeTrack, duration: number): boolean {
  if (!isChatGestureTrack(track.name) || track.getValueSize() !== 4 || track.times.length < 1 || track.times.length > 100_000 ||
    track.values.length !== track.times.length * 4) return false;
  let previous = -Infinity;
  for (const time of track.times) {
    if (!Number.isFinite(time) || time < 0 || time < previous || time > duration + 1e-4) return false;
    previous = time;
  }
  for (let index = 0; index < track.values.length; index += 4) {
    let length = 0;
    for (let offset = 0; offset < 4; offset++) {
      const value = track.values[index + offset];
      if (!Number.isFinite(value)) return false;
      length += value * value;
    }
    if (Math.abs(length - 1) > 0.1) return false;
  }
  return true;
}

/**
 * A one-shot FK overlay on the current base, without owning its mixer or timeline.
 * Per frame: restore() -> base helper.update(delta) -> frame(delta, gate) -> idle/face.
 * Only curated chest/shoulder/arm/elbow/wrist rotations are sampled. The original
 * track factory is retained, including MMDLoader's authored Bezier interpolation.
 */
export class ChatGesturePlayer {
  private readonly bones = new Map<string, Bone>();
  private readonly consumed = new Set<string>();
  private readonly target = new Quaternion();
  private current: PlayingGesture | null = null;
  private weight = 0;
  private disposed = false;

  constructor(mesh: SkinnedMesh) {
    const ambiguous = new Set<string>();
    for (const bone of mesh.skeleton.bones) {
      if (this.bones.has(bone.name)) ambiguous.add(bone.name);
      else this.bones.set(bone.name, bone);
    }
    for (const name of ambiguous) this.bones.delete(name);
  }

  /** An attempted cue is consumed even if its clip/strength cannot be played. */
  play(input: ChatGesturePlay): boolean {
    if (this.disposed || typeof input.id !== 'string' || !input.id || input.id.length > 160 || this.consumed.has(input.id)) return false;
    this.consumed.add(input.id);
    if (this.consumed.size > MAX_CONSUMED_IDS) this.consumed.delete(this.consumed.values().next().value!);
    const strength = Number.isFinite(input.strength) ? clamp(input.strength, 0, 0.7) : 0;
    const clip = input.clip;
    if (!strength || !(clip instanceof AnimationClip) || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 30 || clip.tracks.length > 2_000) return false;
    const tracks: SampledTrack[] = [], used = new Set<Bone>();
    for (const track of clip.tracks) {
      if (!validTrack(track, clip.duration)) continue;
      const name = /^\.bones\[([^\]]+)\]\.quaternion$/.exec(track.name)![1];
      const bone = this.bones.get(name);
      if (!bone || used.has(bone)) continue;
      try {
        // Do not clone/rebuild tracks: that would lose MMD's custom factory.
        const interpolant = track.createInterpolant();
        tracks.push({ name: track.name, bone, interpolant, base: new Quaternion(), applied: false, path: new RotationPath() });
        used.add(bone);
      } catch { /* An invalid track cannot leave a partial binding on the model. */ }
    }
    if (!tracks.length) return false;
    this.cancel();
    this.current = { id: input.id, duration: clip.duration, elapsed: 0, strength,
      fadeIn: fadeSeconds(input.fadeInMs, 250, clip.duration), fadeOut: fadeSeconds(input.fadeOutMs, 450, clip.duration),
      tracks, cancelWeight: null, cancelElapsed: 0, sizeFades: input.fadeInMs === undefined && input.fadeOutMs === undefined };
    return true;
  }

  /** Undo only this player's last overlay before advancing the real base mixer. */
  restore(): void {
    for (const track of this.current?.tracks ?? []) {
      if (!track.applied) continue;
      track.bone.quaternion.copy(track.base); track.applied = false;
    }
  }

  frame(deltaSeconds: number, { blocked }: { blocked: boolean }): ChatGestureState {
    if (blocked || this.disposed) { this.cancel(); return this.getState(); }
    // Idempotent if called twice without a base update: never compound an overlay.
    this.restore();
    const playing = this.current;
    if (!playing) return this.getState();
    const delta = Number.isFinite(deltaSeconds) && deltaSeconds >= 0 ? deltaSeconds : 0;
    playing.elapsed = Math.min(playing.duration, playing.elapsed + delta);
    if (playing.cancelWeight !== null) playing.cancelElapsed = Math.min(CANCEL_SECONDS, playing.cancelElapsed + delta);
    if (playing.elapsed >= playing.duration - 1e-9 || playing.cancelElapsed >= CANCEL_SECONDS) {
      this.cancel(); return this.getState();
    }
    if (playing.sizeFades && delta > 0) this.sizeFades(playing);
    const incoming = playing.fadeIn ? smooth(playing.elapsed / playing.fadeIn) : 1;
    const outgoing = playing.fadeOut ? smooth((playing.duration - playing.elapsed) / playing.fadeOut) : 1;
    this.weight = playing.cancelWeight === null ? playing.strength * incoming * outgoing
      : playing.cancelWeight * (1 - smooth(playing.cancelElapsed / CANCEL_SECONDS));
    // R29e: not shown, so the way round is open again (the base alone is on screen).
    if (this.weight <= 0) { for (const track of playing.tracks) track.path.reset(); return this.getState(); }
    for (const track of playing.tracks) {
      try {
        const values = track.interpolant.evaluate(playing.elapsed);
        this.target.fromArray(values);
        if (!finiteQuaternion(this.target) || !finiteQuaternion(track.bone.quaternion)) { track.path.reset(); continue; }
        track.base.copy(track.bone.quaternion);
        // base * (base^-1 * sample)^weight, continuing the way round it went last frame: a base and
        // sample that drift through a half turn apart do not flip the overlay (was a fresh shortest slerp).
        track.path.blend(track.base, this.target, this.weight, track.bone.quaternion);
        track.applied = true;
      } catch { /* A sampling failure cannot prevent other bones/base restoration. */ }
    }
    return this.getState();
  }

  /**
   * R29f: on the first frame with time, against the live base: the largest chain angle (degrees) between the base and
   * the gesture's first and last sample, times the strength, sets the fade-in and fade-out (sizedFade).
   */
  private sizeFades(playing: PlayingGesture): void {
    playing.sizeFades = false;
    const local = new Map<Bone, [number, number]>();
    const sample = new Quaternion(), base = new Quaternion();
    for (const track of playing.tracks) {
      try {
        base.copy(track.bone.quaternion).normalize();
        const at = (time: number) => { sample.fromArray(track.interpolant.evaluate(time)); return finiteQuaternion(sample) ? base.angleTo(sample.normalize()) : 0; };
        local.set(track.bone, [at(0), at(Math.max(0, playing.duration - 1e-3))]);
      } catch { /* An unreadable sample does not size anything. */ }
    }
    const along = (bone: Bone, end: 0 | 1): number => {
      let total = 0;
      for (let node: Bone | null = bone; node?.isBone; node = node.parent as Bone | null) total += local.get(node)?.[end] ?? 0;
      return total;
    };
    let start = 0, end = 0;
    for (const bone of local.keys()) { start = Math.max(start, along(bone, 0)); end = Math.max(end, along(bone, 1)); }
    const degrees = 180 / Math.PI * playing.strength;
    playing.fadeIn = Math.min(playing.duration / 2, sizedFade(start * degrees, GESTURE_FADE_IN_S));
    playing.fadeOut = Math.min(playing.duration / 2, sizedFade(end * degrees, GESTURE_FADE_OUT_S));
  }

  cancel({ immediate = true }: { immediate?: boolean } = {}): void {
    if (!immediate && this.current && this.weight > 0) {
      if (this.current.cancelWeight === null) { this.current.cancelWeight = this.weight; this.current.cancelElapsed = 0; }
      return;
    }
    this.restore(); this.current = null; this.weight = 0;
  }

  getState(): ChatGestureState {
    const playing = this.current;
    return { active: !!playing, id: playing?.id ?? null,
      phase: !playing ? 'idle' : playing.cancelWeight !== null || playing.elapsed > playing.duration - playing.fadeOut ? 'fading' : 'playing',
      elapsedMs: (playing?.elapsed ?? 0) * 1_000, durationMs: (playing?.duration ?? 0) * 1_000,
      weight: this.weight, trackNames: playing?.tracks.map(track => track.name) ?? [] };
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel(); this.disposed = true; this.consumed.clear(); this.bones.clear();
  }
}
