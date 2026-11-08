import { AnimationClip, LoopOnce, LoopRepeat, NormalAnimationBlendMode,
  type AnimationAction, type AnimationMixer, type KeyframeTrack, type SkinnedMesh } from 'three';

/** Candidate masks only. Their existence is not approval for a model or a use. */
export type BehaviorBodyMaskId = 'candidate-head-v1' | 'candidate-pose-v1';
export const BEHAVIOR_IDLE_BONES = Object.freeze([
  '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首',
  '下半身', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ',
] as const);
export const BEHAVIOR_BODY_MAX_STRENGTH = 0.3;
export const BEHAVIOR_BODY_DEFAULT_STRENGTH = 0.2;
const IDLE_BONES = new Set<string>(BEHAVIOR_IDLE_BONES);
const FADE_IN_SECONDS = 0.25;
const FADE_OUT_SECONDS = 0.45;
const MAX_CONSUMED = 128;
const EPSILON = 1e-8;

export interface BehaviorBodyDependencies {
  readonly mixer: AnimationMixer;
  /** Only the original Layered actions, excluding this temporary Action. */
  readonly baseActions: () => readonly AnimationAction[];
  /** restore helper pre-IK bones -> mutation -> finally save helper pre-IK bones. */
  readonly withBoneBindings: <T>(mutation: () => T) => T;
  /** Explicit candidate-only opt-in; default rejects partially overlapping bases. */
  readonly allowBaseProjection?: boolean;
  /**
   * I-038: the Gene (standard) name one of this model's bones stands for (src/stage/universal-target.ts), so a retargeted
   * motion's tracks (in the model's own names) meet the same masks. Absent: names are taken as they are (the reviewed Gene).
   */
  readonly standardName?: (boneName: string) => string | null;
}
export interface BehaviorBodyPlay {
  readonly id: string;
  readonly clip: AnimationClip;
  readonly maskId: BehaviorBodyMaskId;
  /** Must match the complete original source duration. No trim or speed change. */
  readonly durationMs: number;
  readonly strength?: number;
}
export type BehaviorBodyReason = 'idle' | 'playing' | 'stopped' | 'blocked' | 'invalid-source' | 'invalid-cue'
  | 'partial-base-overlap' | 'unsupported-base-blend' | 'base-fade' | 'base-rebound' | 'binding-error' | 'disposed';
export interface BehaviorBodyState {
  readonly active: boolean;
  readonly id: string | null;
  readonly maskId: BehaviorBodyMaskId | null;
  readonly reason: BehaviorBodyReason;
  readonly durationMs: number;
  readonly elapsedMs: number;
  readonly nextTimeMs: number;
  readonly weight: number;
  readonly trackNames: readonly string[];
  readonly blockedBaseProperties: readonly string[];
}
interface BaseWeight {
  readonly action: AnimationAction;
  readonly clip: AnimationClip;
  readonly properties: string;
  readonly original: number;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly timeScale: number;
  readonly partial: boolean;
  readonly projections: { action: AnimationAction; clip: AnimationClip; overlap: boolean }[];
  applied: number;
}
interface PlayingBody {
  readonly id: string;
  readonly maskId: BehaviorBodyMaskId;
  readonly clip: AnimationClip;
  readonly action: AnimationAction;
  readonly duration: number;
  /** The caller's canonical source duration (shared/vmd-duration.ts), reported as is; never re-derived from clip seconds. */
  readonly durationMs: number;
  readonly strength: number;
  readonly bases: readonly { action: AnimationAction; clip: AnimationClip; properties: string }[];
  readonly weights: readonly BaseWeight[];
  nextTime: number;
  weight: number;
}
// Pinned Three r170 fields. Public setEffectiveWeight() cancels scheduled fades;
// these fields let cancellation restore our attenuation without cancelling a
// newer external fade. An already scheduled base fade is never admitted.
interface WeightInternals {
  _weightInterpolant: unknown | null; _effectiveWeight: number;
  _timeScaleInterpolant: unknown | null; _startTime: number | null;
}
const internals = (action: AnimationAction) => action as AnimationAction & WeightInternals;
const smooth = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
const properties = (action: AnimationAction) => action.getClip().tracks.map(track => track.name).sort().join('\n');

export function isBehaviorBodyTrack(name: string, maskId: BehaviorBodyMaskId, standardName?: (boneName: string) => string | null): boolean {
  if (standardName) {
    const match = /^\.bones\[([^\]\[]+)\]\.(position|quaternion)$/.exec(name), standard = match ? standardName(match[1]) : null;
    if (!match || standard === null) return false;
    name = `.bones[${standard}].${match[2]}`;
  }
  if (maskId === 'candidate-head-v1') return name === '.bones[首].quaternion' || name === '.bones[頭].quaternion';
  if (maskId !== 'candidate-pose-v1') return false;
  const match = /^\.bones\[([^\]\[]+)\]\.(position|quaternion)$/.exec(name);
  return !!match && IDLE_BONES.has(match[1]);
}
function validTrack(track: KeyframeTrack, duration: number): boolean {
  const quaternion = track.name.endsWith('.quaternion'), size = quaternion ? 4 : 3;
  if (track.getValueSize() !== size || !track.times.length || track.times.length > 100_000
    || track.values.length !== size * track.times.length) return false;
  let previous = -Infinity;
  for (const time of track.times) {
    if (!Number.isFinite(time) || time < 0 || time < previous || time > duration + 1e-4) return false;
    previous = time;
  }
  for (let index = 0; index < track.values.length; index += size) {
    let length = 0;
    for (let offset = 0; offset < size; offset++) {
      const value = track.values[index + offset];
      if (!Number.isFinite(value)) return false;
      length += value * value;
    }
    if (quaternion && Math.abs(length - 1) > 0.1) return false;
  }
  return true;
}

/**
 * One recipe normal-blend Action on the supplied EXISTING MMD mixer. It runs
 * in mixer.update before the helper's original IK/grant pass; there is no second
 * mixer, solver or manually advanced Action. The stage must validate the host
 * lease/model, consume its ID and pass blocked===false explicitly each frame.
 *
 * The source clock begins when play succeeds. beforeUpdate predicts that source
 * Action's upcoming original elapsed time to set its envelope, then the caller
 * invokes helper.update(delta) exactly once. Base phase/timeScale never changes.
 * Mixed-property bases fail closed by default. Explicit allowBaseProjection may
 * project an ordinary indefinitely repeating base into overlap/nonoverlap Actions
 * on this SAME mixer, keeping its original Action scheduled at weight zero and
 * continuously advancing. Projection clips reuse original tracks/duration, and
 * their phase follows the original before each update. There is no source edit.
 * Future Stage wiring/model admission/continuous-use QA remains separate.
 * The stage must dispose this player BEFORE disposing its Layered owner. If its
 * binding guard has already become unavailable, teardown still drops all owned
 * Actions/refs and reports binding-error; the host must keep that stage stopped
 * until teardown/rebuild, because its old helper cache cannot then be certified.
 * The bounded consumed-ID cache complements (never replaces) current host leases.
 */
export class BehaviorBodyPlayer {
  private readonly consumed = new Set<string>();
  private current: PlayingBody | null = null;
  private reason: BehaviorBodyReason = 'idle';
  private blockedBaseProperties: string[] = [];
  private disposed = false;

  constructor(private readonly dependencies: BehaviorBodyDependencies) {}

  play(input: BehaviorBodyPlay): boolean {
    if (this.disposed) return false;
    if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.id) || this.consumed.has(input.id)) return false;
    this.consumed.add(input.id);
    if (this.consumed.size > MAX_CONSUMED) this.consumed.delete(this.consumed.values().next().value!);
    const source = input.clip, strength = input.strength ?? BEHAVIOR_BODY_DEFAULT_STRENGTH;
    if (!(source instanceof AnimationClip) || source.blendMode !== NormalAnimationBlendMode
      || !Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 30 || source.tracks.length > 2_000
      || !Number.isFinite(input.durationMs) || Math.abs(input.durationMs / 1_000 - source.duration) > 1e-4
      || !Number.isFinite(strength) || strength <= 0 || strength > BEHAVIOR_BODY_MAX_STRENGTH
      || !['candidate-head-v1', 'candidate-pose-v1'].includes(input.maskId)) return this.reject('invalid-source');
    const tracks = source.tracks.filter(track => isBehaviorBodyTrack(track.name, input.maskId, this.dependencies.standardName));
    const names = new Set(tracks.map(track => track.name));
    const root = this.dependencies.mixer.getRoot() as SkinnedMesh;
    const bones = root.skeleton?.bones ?? [];
    if (!tracks.length || names.size !== tracks.length || tracks.some(track => !validTrack(track, source.duration)
      || bones.filter(bone => bone.name === /^\.bones\[([^\]]+)\]/.exec(track.name)![1]).length !== 1))
      return this.reject('invalid-source');

    this.stop();
    let bases: AnimationAction[];
    try { bases = [...this.dependencies.baseActions()]; } catch { return this.reject('binding-error'); }
    if (new Set(bases).size !== bases.length || bases.some(action => action.getMixer() !== this.dependencies.mixer))
      return this.reject('base-rebound');
    const weights: BaseWeight[] = [];
    this.blockedBaseProperties = [];
    for (const action of bases) {
      const baseTracks = action.getClip().tracks.map(track => track.name);
      if (!baseTracks.some(name => names.has(name))) continue;
      const outside = baseTracks.filter(name => !names.has(name));
      if (outside.length && this.dependencies.allowBaseProjection !== true) {
        this.blockedBaseProperties = [...new Set(outside)]; return this.reject('partial-base-overlap');
      }
      if (action.blendMode !== NormalAnimationBlendMode) return this.reject('unsupported-base-blend');
      if (internals(action)._weightInterpolant !== null || !Number.isFinite(action.weight) || action.weight < 0
        || !Number.isFinite(action.getEffectiveWeight()) || Math.abs(action.weight - action.getEffectiveWeight()) > EPSILON)
        return this.reject('base-fade');
      if (!action.isScheduled() || !action.enabled || action.paused || !Number.isFinite(action.timeScale) || action.timeScale <= 0
        || action.loop !== LoopRepeat || action.repetitions !== Infinity || internals(action)._timeScaleInterpolant !== null
        || internals(action)._startTime !== null) return this.reject('unsupported-base-blend');
      weights.push({ action, clip: action.getClip(), properties: properties(action), original: action.getEffectiveWeight(),
        enabled: action.enabled, paused: action.paused, timeScale: action.timeScale,
        partial: outside.length > 0, projections: [], applied: action.getEffectiveWeight() });
    }
    const clip = new AnimationClip(`behavior-body:${input.id}`, source.duration, tracks, source.blendMode);
    let action: AnimationAction | null = null;
    try {
      this.dependencies.withBoneBindings(() => {
        for (const saved of weights) {
          if (!saved.partial) continue;
          for (const overlap of [false, true]) {
            const projected = new AnimationClip(`behavior-base:${input.id}:${saved.clip.uuid}:${overlap ? 'overlap' : 'rest'}`,
              saved.clip.duration, saved.clip.tracks.filter(track => names.has(track.name) === overlap), saved.clip.blendMode);
            const projectedAction = this.dependencies.mixer.clipAction(projected);
            saved.projections.push({ clip: projected, action: projectedAction, overlap });
            projectedAction.setLoop(LoopRepeat, Infinity);
            projectedAction.time = saved.action.time;
            projectedAction.setEffectiveTimeScale(saved.timeScale);
            projectedAction.setEffectiveWeight(saved.original).play();
          }
          saved.action.setEffectiveWeight(0); saved.applied = 0;
        }
        action = this.dependencies.mixer.clipAction(clip);
        action.setLoop(LoopOnce, 1); action.clampWhenFinished = false;
        action.setEffectiveWeight(0); action.play();
      });
    } catch {
      const cleanup = () => {
        action?.stop(); this.dependencies.mixer.uncacheAction(clip);
        let currentBases: readonly AnimationAction[];
        try { currentBases = this.dependencies.baseActions(); } catch { currentBases = []; }
        for (const saved of weights) {
          if (currentBases.includes(saved.action) && saved.action.getClip() === saved.clip && saved.action.isScheduled()
            && Math.abs(saved.action.weight - saved.applied) <= EPSILON) {
            saved.action.weight = saved.original; internals(saved.action)._effectiveWeight = saved.action.enabled ? saved.original : 0;
          }
          for (const projection of saved.projections) { projection.action.stop(); this.dependencies.mixer.uncacheAction(projection.clip); }
        }
      };
      try { this.dependencies.withBoneBindings(cleanup); } catch { cleanup(); }
      return this.reject('binding-error');
    }
    this.current = { id: input.id, maskId: input.maskId, clip, action: action!, duration: source.duration, durationMs: input.durationMs,
      strength, bases: bases.map(base => ({ action: base, clip: base.getClip(), properties: properties(base) })), weights, nextTime: 0, weight: 0 };
    this.reason = 'playing';
    return true;
  }

  beforeUpdate(deltaSeconds: number, blocked: boolean): BehaviorBodyState {
    if (this.disposed) return this.getState();
    if (blocked !== false) { this.stop('blocked'); return this.getState(); }
    const playing = this.current;
    if (!playing) return this.getState();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || this.dependencies.mixer.timeScale !== 1
      || playing.action.timeScale !== 1 || !playing.action.enabled || playing.action.paused) {
      this.stop('blocked'); return this.getState();
    }
    let bases: readonly AnimationAction[];
    try { bases = this.dependencies.baseActions(); } catch { this.stop('base-rebound'); return this.getState(); }
    if (bases.length !== playing.bases.length || bases.some(action => !playing.bases.some(saved => saved.action === action))
      || playing.bases.some(saved => saved.action.getClip() !== saved.clip || properties(saved.action) !== saved.properties)
      || playing.weights.some(saved => !saved.action.isScheduled() || saved.action.enabled !== saved.enabled
        || saved.action.paused !== saved.paused || saved.action.timeScale !== saved.timeScale || saved.action.loop !== LoopRepeat
        || saved.action.repetitions !== Infinity || internals(saved.action)._timeScaleInterpolant !== null || internals(saved.action)._startTime !== null)) {
      this.stop('base-rebound'); return this.getState();
    }
    if (playing.weights.some(saved => internals(saved.action)._weightInterpolant !== null
      || Math.abs(saved.action.weight - saved.applied) > EPSILON
      || Math.abs(saved.action.getEffectiveWeight() - saved.applied) > EPSILON)) {
      this.stop('base-fade'); return this.getState();
    }
    const nextTime = playing.action.time + deltaSeconds;
    if (!Number.isFinite(nextTime) || nextTime >= playing.duration - 1e-9) {
      // Zero-weight endpoint is removed before the caller's helper/mixer update.
      this.stop(); return this.getState();
    }
    playing.nextTime = nextTime;
    const incoming = smooth(nextTime / Math.min(FADE_IN_SECONDS, playing.duration));
    const outgoing = smooth((playing.duration - nextTime) / Math.min(FADE_OUT_SECONDS, playing.duration));
    playing.weight = playing.strength * incoming * outgoing;
    for (const saved of playing.weights) {
      if (saved.partial) {
        for (const projection of saved.projections) {
          // Synchronize only our projection, never the original Action phase.
          projection.action.time = saved.action.time;
          projection.action.setEffectiveTimeScale(saved.timeScale);
          projection.action.setEffectiveWeight(saved.original * (projection.overlap ? 1 - playing.weight : 1));
        }
      } else {
        saved.applied = saved.original * (1 - playing.weight);
        saved.action.setEffectiveWeight(saved.applied);
      }
    }
    playing.action.setEffectiveWeight(playing.weight);
    return this.getState();
  }

  stop(reason: BehaviorBodyReason = 'stopped'): void {
    const playing = this.current;
    if (playing) {
      let currentBases: readonly AnimationAction[];
      try { currentBases = this.dependencies.baseActions(); } catch { currentBases = []; }
      const cleanup = () => {
        for (const saved of playing.weights) {
          // Do not cancel a newer external fade while restoring our attenuation.
          // A removed/expired original is obsolete; never resurrect or reweight it.
          if (currentBases.includes(saved.action) && saved.action.getClip() === saved.clip && saved.action.isScheduled()
            && Math.abs(saved.action.weight - saved.applied) <= EPSILON) {
            saved.action.weight = saved.original;
            internals(saved.action)._effectiveWeight = saved.action.enabled ? saved.original : 0;
          }
          for (const projection of saved.projections) {
            projection.action.stop(); this.dependencies.mixer.uncacheAction(projection.clip);
          }
        }
        playing.action.stop();
        this.dependencies.mixer.uncacheAction(playing.clip);
      };
      try { this.dependencies.withBoneBindings(cleanup); }
      catch {
        try { cleanup(); } finally { reason = 'binding-error'; }
      } finally { this.current = null; }
    }
    this.reason = reason;
  }

  getState(): BehaviorBodyState {
    const playing = this.current;
    return Object.freeze({ active: !!playing, id: playing?.id ?? null, maskId: playing?.maskId ?? null,
      reason: this.reason, durationMs: playing?.durationMs ?? 0, elapsedMs: (playing?.action.time ?? 0) * 1_000,
      nextTimeMs: (playing?.nextTime ?? 0) * 1_000, weight: playing?.weight ?? 0,
      trackNames: Object.freeze(playing?.clip.tracks.map(track => track.name) ?? []),
      blockedBaseProperties: Object.freeze([...this.blockedBaseProperties]) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop('disposed'); this.disposed = true; this.consumed.clear();
  }
  private reject(reason: BehaviorBodyReason): false { this.reason = reason; return false; }
}
