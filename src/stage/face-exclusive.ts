/**
 * T-215 嘴和眼睑的短暂独占 (docs/claude/2026-11-05-t215-face-exclusive.md; Codex's T-215 contract v1 in the bridge,
 * 研究成果/Codex/T-215/contract-v1.md). Plays a short morph-only face shape (鼓腮、撅嘴、眨一只眼、吐舌头) on a face
 * that many writers already compose.
 *
 * Why a module: every stage face writer writes by max (model-profile.ts writeProfiledMorph): lip-sync, feeding, the mood
 * mouth and smile, the natural blink and the eyelid compositor, procedural life, previews, the mixer's picked expression.
 * A face shape on vertices those morphs also move (Gene: cheekPuff and the five phonemes share 912 vertices, ウィンク
 * and まばたき 393, ウィンク and 笑い 396) cannot take that area by one more max write: whatever else is up keeps its
 * displacement on the same vertices, and a late writer cannot lower an earlier one.
 *
 * What it does: one short exclusive request per scope (`mouth`, `eyelids`; never the gaze: no bone is touched, the eyes
 * keep looking). The stage lets every writer write first (the gathered base B of this frame), then hands the influences
 * here ONCE, right before the display guard, and this writes the complete controlled vector of the request's conflict
 * group in one go:
 *     Y_i = (1 − w) · B_i + w · A_i          (i in the group; A_i = the clip, 0 for a group morph it does not name)
 *  - Conflict group: the clip's morphs plus every morph of this mesh whose displaced vertices meet theirs, from the
 *    geometry itself (not the names: a cheek shape still owns the phonemes it overlaps; the other eye's wink does not
 *    overlap, so it is not in the group).
 *  - w is ownership, never the clip's strength: smootherstep in over `enter`, out over the clip's last `exit` seconds,
 *    zero speed at both ends. While w = 1 nothing else shows on the group's vertices.
 *  - Cancel (a higher owner arrives: speech about to start, feeding, a picked expression, a held closure, or the scope
 *    changed): w is multiplied by a release r(τ) = 1 − smootherstep(τ / cancel). At the cancel instant r = 1 and r' = 0, so
 *    w and dw/dt carry on unchanged (no jump, no kink), and both reach 0 together. The clip keeps its own clock (it never
 *    freezes on the cancel frame) and B keeps running underneath (the live base, never a snapshot taken at the start), so
 *    the hand-over lands on whatever the higher owner shows by then. Already in its natural exit, the exit just goes on.
 *  - One lease per scope: busy while it shows and for FACE_EXCLUSIVE_COOLDOWN_S after; a request never queues. A different
 *    scope key (character, conversation) releases it; a hidden window or another mesh cuts it (nothing on screen).
 * With no request, frame() writes nothing and owned() is null: the stage's output is exactly what it was without this.
 *
 * Round 2 of the twitch. Two things
 * made the face drop its expression and snap it back around every small shape:
 *  - Ownership ran ahead of the clip. w reached 1 in 0.08 s (eyelids) / 0.2 s (mouth) while the wink's own keys take 0.2 s and
 *    the pout's 0.73 s to arrive: for a moment the base was gone and the shape not there yet (smile → neutral → pout). Now w also
 *    follows the clip's own progress P(t) (its tracks' sum against their peak; 1 from the first peak to the last): the base hands
 *    over at the clip's pace, like key frames, and comes back as the clip lets go. P is C1 (the keys' clamped Hermite), so
 *    w = E·P·r stays C1, and P = 1 in the hold: the hold is exactly the clip, as before.
 *  - The whole group was taken, also what lies outside the shape's own region: a bilateral smile-eye left BOTH eyes for a
 *    one-eyed wink. face-keep.ts keeps that outside part with morphs that leave the owned region alone (the other eye's own
 *    morph): each kept base morph i adds w·s·B_i to its partners. The owned region still shows only the shape (no double closure).
 */
import { KeyframeInterpolant } from './keyframe-interpolation';
import type { HerFaceScope } from '../../shared/actions';
import { FaceKeep, type KeepPart } from './face-keep';

export type FaceScope = HerFaceScope;
export interface FaceTiming { readonly enter: number; readonly exit: number; readonly cancel: number }
/** Codex T-215 §1 first values: ownership in, natural exit, and the cancel hand-over (seconds). */
export const FACE_EXCLUSIVE_TIMING: Readonly<Record<FaceScope, FaceTiming>> = Object.freeze({
  mouth: Object.freeze({ enter: 0.2, exit: 0.25, cancel: 0.25 }),
  eyelids: Object.freeze({ enter: 0.08, exit: 0.12, cancel: 0.14 }),
});
/** After a face shape ends, the same scope takes no new one this soon (T-211 batch 006: at least 300 ms). */
export const FACE_EXCLUSIVE_COOLDOWN_S = 0.3;
/** A wink asked for while a natural blink is still closing starts once the blink has opened, if that is within this. */
export const FACE_EXCLUSIVE_START_WAIT_S = 0.45;
/** After an eyelid shape, the next natural blink waits at least this long (a wink is a blink: no double blink after it). */
export const FACE_EXCLUSIVE_BLINK_GAP_S = 0.6;
const SCOPES: readonly FaceScope[] = ['mouth', 'eyelids'];
const MAX_IDS = 64;
/** Squared vertex offset above which a morph displaces a vertex (model-profile.ts modelProfileInput uses the same). */
const DISPLACED = 1e-14;

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
/** Smootherstep: zero speed and acceleration at both ends (kept within [0, 1]: near 1 the polynomial can round a hair above). */
const smoother = (value: number) => { const t = clamp01(value); return Math.min(1, t * t * t * (t * (t * 6 - 15) + 10)); };

/** One morph track of the clip, resolved to this mesh: the index it writes and its keys (seconds, weights). */
export interface FaceTrackInput { index: number; times: ArrayLike<number>; values: ArrayLike<number> }
export interface FaceRequest {
  id: string;
  scope: FaceScope;
  /** The live scope key (character and conversation, as the eyelid compositor's); a change releases the request. */
  key: string;
  /** The clip's length in seconds (its last key). */
  duration: number;
  tracks: readonly FaceTrackInput[];
  /** Seconds before the clip starts (a natural blink still closing). The lease holds the scope from the request on. */
  delay?: number;
  /** Per-model calibration of a clip value for a morph (the model profile's scales); identity by default. */
  calibrate?: (index: number, value: number) => number;
}
export type FaceRefusal = 'busy' | 'invalid' | 'seen' | 'empty';
export interface FaceLeaseState {
  id: string; phase: 'waiting' | 'entering' | 'playing' | 'exiting' | 'releasing'; weight: number; rate: number;
  elapsedMs: number; durationMs: number; delayMs: number; group: number; targets: number[]; reason: string | null;
}
export interface FaceExclusiveState {
  mouth: FaceLeaseState | null; eyelids: FaceLeaseState | null;
  /** The last request that ended: its id, scope, how, and when (module clock, ms). */
  ended: { id: string; scope: FaceScope; how: 'completed' | 'released' | 'cut'; reason: string | null; atMs: number } | null;
}

/** The mesh parts the conflict group is read from (a Three SkinnedMesh; plain objects in tests). */
export interface FaceMesh {
  morphTargetInfluences?: number[];
  geometry?: {
    getAttribute(name: string): FaceAttribute | undefined;
    morphAttributes?: { position?: readonly FaceAttribute[] };
    morphTargetsRelative?: boolean;
  };
}
interface FaceAttribute { count: number; itemSize: number; getX(index: number): number; getY(index: number): number; getZ(index: number): number }

interface Track { index: number; slot: number; interpolant: KeyframeInterpolant }
interface Lease {
  id: string; scope: FaceScope; key: string; duration: number; delay: number; timing: FaceTiming;
  tracks: Track[]; group: number[]; target: Float64Array; calibrate: (index: number, value: number) => number;
  clock: number; releaseAt: number | null; reason: string | null; weight: number; rate: number;
  /** Round 2: the clip's own morphs (never kept, never partners), this frame's base, partners per base morph, everything written. */
  targets: number[]; own: Set<number>; base: Float64Array; keeps: Map<number, readonly KeepPart[]>; touched: Set<number>;
  /** Round 2: the clip's summed peak, and the first and last time it is reached (P = 1 between). */
  progress: { peak: number; first: number; last: number };
}

/**
 * Round 2: the clip's summed peak and when it is first and last reached, from its keys (evaluated through the stage's
 * interpolation, as P(t) reads them). Nothing above 0: P stays 1 (the old ownership).
 */
function progressOf(tracks: readonly Track[], duration: number): Lease['progress'] {
  const times = [...new Set(tracks.flatMap(track => Array.from(track.interpolant.parameterPositions as ArrayLike<number>)))]
    .filter(time => time >= 0 && time <= duration + 0.05).sort((a, b) => a - b);
  const sums = times.map(time => tracks.reduce((sum, track) => sum + clamp01((track.interpolant.evaluate(time) as unknown as ArrayLike<number>)[0]), 0));
  const peak = Math.max(0, ...sums);
  if (!(peak > 1e-9)) return { peak: 0, first: 0, last: 0 };
  const at = times.filter((_, k) => sums[k] >= peak * (1 - 1e-6));
  return { peak, first: at[0], last: at.at(-1)! };
}

/** The face writes of this module: exact (not max), remembered once per frame so the stage's restoreLayers undoes them. */
export function writeExactMorph(influences: number[], layers: { index: number; value: number }[], index: number, value: number): void {
  if (index < 0 || index >= influences.length || !Number.isFinite(value)) return;
  if (!layers.some(layer => layer.index === index)) layers.push({ index, value: influences[index] ?? 0 });
  influences[index] = value;
}

export class FaceExclusive {
  private readonly leases: Partial<Record<FaceScope, Lease>> = {};
  private readonly free: Record<FaceScope, number> = { mouth: -Infinity, eyelids: -Infinity };
  private readonly ids = new Set<string>();
  private readonly displacedCache = new Map<number, Int32Array>();
  private readonly groupCache = new Map<string, number[]>();
  private readonly keeper: FaceKeep;
  /** Groups owned this frame (followed, not judged, by the display guard); `tail`: one more frame after an end. */
  private ownedNow: number[] | null = null;
  private tail: number[] | null = null;
  private now = 0;
  private ended: FaceExclusiveState['ended'] = null;

  constructor(private readonly mesh: FaceMesh) {
    this.keeper = new FaceKeep(mesh, index => this.displaced(index));
    // Round 2: read every morph's moved vertices now, with the model load, not on the frame a first wink starts (Gene: ~20 ms
    // once here; the first keep search for the smile-eye then takes ~6 ms instead of ~17 ms).
    for (let index = 0; index < (mesh.morphTargetInfluences?.length ?? 0); index++) this.displaced(index);
  }

  /** This mesh's vertex indices that morph `index` displaces (cached; empty for a non-vertex morph). */
  displaced(index: number): Int32Array {
    const cached = this.displacedCache.get(index);
    if (cached) return cached;
    const geometry = this.mesh.geometry, base = geometry?.getAttribute('position'), target = geometry?.morphAttributes?.position?.[index];
    const out: number[] = [];
    if (base && target && base.itemSize === 3 && target.itemSize === 3 && target.count === base.count) {
      const relative = geometry?.morphTargetsRelative === true;
      for (let vertex = 0; vertex < base.count; vertex++) {
        const dx = target.getX(vertex) - (relative ? 0 : base.getX(vertex));
        const dy = target.getY(vertex) - (relative ? 0 : base.getY(vertex));
        const dz = target.getZ(vertex) - (relative ? 0 : base.getZ(vertex));
        if (dx * dx + dy * dy + dz * dz > DISPLACED) out.push(vertex);
      }
    }
    const result = Int32Array.from(out);
    this.displacedCache.set(index, result);
    return result;
  }

  /**
   * The morphs a request on `targets` must own: the targets and every morph of this mesh that displaces any vertex they
   * displace (sorted, cached). Read from the geometry once per set of targets.
   */
  conflictGroup(targets: readonly number[]): number[] {
    const count = this.mesh.morphTargetInfluences?.length ?? 0;
    const own = [...new Set(targets.filter(index => Number.isInteger(index) && index >= 0 && index < count))].sort((a, b) => a - b);
    const key = own.join(',');
    const cached = this.groupCache.get(key);
    if (cached) return cached;
    const geometry = this.mesh.geometry, base = geometry?.getAttribute('position'), morphs = geometry?.morphAttributes?.position ?? [];
    const relative = geometry?.morphTargetsRelative === true;
    const vertices = [...new Set(own.flatMap(index => [...this.displaced(index)]))];
    const group = new Set(own);
    if (base && vertices.length) for (let index = 0; index < Math.min(count, morphs.length); index++) {
      if (group.has(index)) continue;
      const target = morphs[index];
      if (!target || target.itemSize !== 3 || target.count !== base.count) continue;
      for (const vertex of vertices) {
        const dx = target.getX(vertex) - (relative ? 0 : base.getX(vertex));
        const dy = target.getY(vertex) - (relative ? 0 : base.getY(vertex));
        const dz = target.getZ(vertex) - (relative ? 0 : base.getZ(vertex));
        if (dx * dx + dy * dy + dz * dz > DISPLACED) { group.add(index); break; }
      }
    }
    const result = [...group].sort((a, b) => a - b);
    this.groupCache.set(key, result);
    return result;
  }

  /** A request in this scope is showing (or still waiting to start). */
  active(scope: FaceScope): boolean { return !!this.leases[scope]; }
  /** A new request in this scope would be refused: one is showing, or the last one ended less than the cooldown ago. */
  busy(scope: FaceScope): boolean { return !!this.leases[scope] || this.now < this.free[scope]; }

  /** Grants the scope to one request, or says why not. Never queues; an id plays at most once. */
  request(input: FaceRequest): true | FaceRefusal {
    if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 160 || !SCOPES.includes(input.scope)
      || !Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 30 || !Array.isArray(input.tracks)) return 'invalid';
    if (this.ids.has(input.id)) return 'seen';
    if (this.busy(input.scope)) return 'busy';
    const count = this.mesh.morphTargetInfluences?.length ?? 0;
    const tracks: Track[] = [], targets: number[] = [];
    for (const track of input.tracks) {
      if (!track || !Number.isInteger(track.index) || track.index < 0 || track.index >= count) continue;
      const n = Math.min(track.times?.length ?? 0, track.values?.length ?? 0);
      if (n < 1) continue;
      const times = new Float32Array(n), values = new Float32Array(n);
      let previous = -Infinity, valid = true;
      for (let k = 0; k < n; k++) {
        const time = Number(track.times[k]), value = Number(track.values[k]);
        if (!Number.isFinite(time) || !Number.isFinite(value) || time < previous || time < 0 || time > input.duration + 0.05) { valid = false; break; }
        times[k] = previous = time; values[k] = value;
      }
      if (!valid) continue;
      tracks.push({ index: track.index, slot: -1, interpolant: new KeyframeInterpolant(times, values, 1, new Float64Array(1)) });
      targets.push(track.index);
    }
    if (!tracks.length) return 'empty';
    this.ids.add(input.id);
    if (this.ids.size > MAX_IDS) this.ids.delete(this.ids.values().next().value!);
    const group = this.conflictGroup(targets);
    for (const track of tracks) track.slot = group.indexOf(track.index);
    const delay = Number.isFinite(input.delay) ? Math.min(FACE_EXCLUSIVE_START_WAIT_S, Math.max(0, input.delay!)) : 0;
    const own = [...new Set(targets)].sort((a, b) => a - b);
    const lease: Lease = { id: input.id, scope: input.scope, key: String(input.key ?? ''), duration: input.duration, delay,
      timing: FACE_EXCLUSIVE_TIMING[input.scope], tracks, group, target: new Float64Array(group.length),
      calibrate: typeof input.calibrate === 'function' ? input.calibrate : (_index, value) => value,
      clock: 0, releaseAt: null, reason: null, weight: 0, rate: 0,
      targets: own, own: new Set(own), base: new Float64Array(group.length), keeps: new Map(), touched: new Set(group),
      progress: progressOf(tracks, input.duration) };
    this.leases[input.scope] = lease;
    // What shows now most likely needs keeping: read its partners from the geometry before the shape shows anything.
    const shown = this.mesh.morphTargetInfluences ?? [];
    for (const index of group) if (!lease.own.has(index) && (shown[index] ?? 0) > 0) this.keepOf(lease, index);
    return true;
  }

  /**
   * A higher owner wants the scope: hands it back from what shows now (weight and its speed carry on, then ease to zero
   * over the scope's cancel time). Not started yet: simply not started. In its natural exit already: that exit goes on.
   */
  cancel(scope: FaceScope, reason: string): void {
    const lease = this.leases[scope];
    if (!lease || lease.releaseAt !== null) return;
    const t = lease.clock - lease.delay;
    if (t <= 0) { this.end(lease, 'released', reason); return; } // nothing shown yet: simply not started
    if (t >= lease.duration - lease.timing.exit) { lease.reason ??= reason; return; }
    lease.releaseAt = lease.clock; lease.reason = reason;
  }

  /** Nothing on screen to hand back (hidden window, model going away): every request ends now. */
  cut(reason: string): void {
    for (const scope of SCOPES) { const lease = this.leases[scope]; if (lease) this.end(lease, 'cut', reason); }
    this.tail = null; this.ownedNow = null;
  }

  /** Seconds until the eyelid request (with a release in progress) is over; 0 when there is none. */
  lidHold(): number {
    const lease = this.leases.eyelids;
    if (!lease) return 0;
    const natural = lease.delay + lease.duration - lease.clock;
    return Math.max(0, lease.releaseAt === null ? natural : Math.min(natural, lease.releaseAt + lease.timing.cancel - lease.clock));
  }

  /**
   * One display frame, after every other face writer: advances the requests and writes each one's conflict group once.
   * `key`: the live scope key; `cancel`: a higher owner per scope this frame (its reason), handed back from what shows.
   */
  frame(delta: number, live: { key: string; cancel?: Partial<Record<FaceScope, string | null>> }, influences: number[] | undefined,
    layers: { index: number; value: number }[]): void {
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 0;
    this.now += dt;
    const owned = this.tail ? new Set(this.tail) : null;
    this.tail = null;
    let any = owned;
    for (const scope of SCOPES) {
      let lease = this.leases[scope];
      if (!lease) continue;
      if (lease.key !== String(live?.key ?? '')) this.cancel(scope, 'scope');
      const why = live?.cancel?.[scope];
      if (why) this.cancel(scope, why);
      lease = this.leases[scope];
      if (!lease) continue;
      lease.clock += dt;
      const t = lease.clock - lease.delay;
      const released = lease.releaseAt !== null && lease.clock - lease.releaseAt >= lease.timing.cancel;
      if (t >= lease.duration || released) {
        this.end(lease, released ? 'released' : 'completed', lease.reason);
        (any ??= new Set()); for (const index of lease.touched) any.add(index);
        this.tail = [...(this.tail ?? []), ...lease.touched];
        continue;
      }
      const weight = this.weight(lease);
      lease.rate = dt > 0 ? (weight - lease.weight) / dt : lease.rate;
      lease.weight = weight;
      const seen: Set<number> = (any ??= new Set());
      for (const index of lease.touched) seen.add(index);
      if (!influences || weight <= 0) continue;
      this.sample(lease, Math.min(Math.max(t, 0), lease.duration));
      for (let k = 0; k < lease.group.length; k++) {
        const index = lease.group[k], base = lease.base[k] = influences[index] ?? 0;
        // (1 − w)·B + w·A: exactly B at w = 0 and exactly A at w = 1 (no rounding below 0 or above the clip).
        writeExactMorph(influences, layers, index, (1 - weight) * base + weight * lease.target[k]);
      }
      // Round 2: what the group took outside the shape's own region comes back on partners that leave that region alone.
      let adds: Map<number, number> | null = null;
      for (let k = 0; k < lease.group.length; k++) {
        const index = lease.group[k], base = lease.base[k];
        if (!(base > 0) || lease.own.has(index)) continue;
        for (const part of this.keepOf(lease, index)) (adds ??= new Map()).set(part.index, (adds.get(part.index) ?? 0) + weight * part.scale * base);
      }
      if (adds) for (const [index, add] of adds) {
        writeExactMorph(influences, layers, index, Math.min(1, (influences[index] ?? 0) + add));
        lease.touched.add(index); seen.add(index);
      }
    }
    this.ownedNow = any ? [...any].sort((a, b) => a - b) : null;
  }

  /** The morphs this module wrote or is handing back this frame (the display guard follows them); null when idle. */
  owned(): readonly number[] | null { return this.ownedNow; }

  getState(): FaceExclusiveState {
    const view = (lease: Lease | undefined): FaceLeaseState | null => {
      if (!lease) return null;
      const t = lease.clock - lease.delay;
      const phase: FaceLeaseState['phase'] = t <= 0 ? 'waiting' : lease.releaseAt !== null ? 'releasing' : t < lease.timing.enter ? 'entering'
        : t > lease.duration - lease.timing.exit ? 'exiting' : 'playing';
      return { id: lease.id, phase, weight: lease.weight, rate: lease.rate, elapsedMs: Math.max(0, t) * 1_000, durationMs: lease.duration * 1_000,
        delayMs: lease.delay * 1_000, group: lease.group.length, targets: lease.tracks.map(track => track.index), reason: lease.reason };
    };
    return { mouth: view(this.leases.mouth), eyelids: view(this.leases.eyelids), ended: this.ended };
  }

  /** Round 2: the partners that keep base morph `index` outside this shape's region (face-keep.ts; cached per mesh). */
  private keepOf(lease: Lease, index: number): readonly KeepPart[] {
    let parts = lease.keeps.get(index);
    if (!parts) { parts = this.keeper.keep(lease.targets, index, lease.own); lease.keeps.set(index, parts); }
    return parts;
  }

  /** Round 2: how far the clip itself has arrived: its tracks' sum against their peak; 1 from the first peak to the last. */
  private progress(lease: Lease, t: number): number {
    const { peak, first, last } = lease.progress;
    if (!(peak > 0) || (t >= first && t <= last)) return 1;
    let sum = 0;
    for (const track of lease.tracks) sum += clamp01((track.interpolant.evaluate(t) as unknown as ArrayLike<number>)[0]);
    return clamp01(sum / peak);
  }

  /**
   * The ownership at the lease's clock: in and natural exit (smootherstep), times the clip's own progress (round 2: the base hands
   * over as the clip arrives, never ahead of it), times the release once cancelled.
   */
  private weight(lease: Lease): number {
    const t = lease.clock - lease.delay;
    if (t <= 0 || t >= lease.duration) return 0;
    const { enter, exit, cancel } = lease.timing;
    const envelope = smoother(t / enter) * smoother((lease.duration - t) / exit) * this.progress(lease, t);
    return lease.releaseAt === null ? envelope : envelope * (1 - smoother((lease.clock - lease.releaseAt) / cancel));
  }

  /** A at clip time t: each track at its own keys (the stage's keyframe interpolation), calibrated, 0 for the rest of the group. */
  private sample(lease: Lease, t: number): void {
    lease.target.fill(0);
    for (const track of lease.tracks) {
      if (track.slot < 0) continue;
      const raw = (track.interpolant.evaluate(t) as unknown as ArrayLike<number>)[0];
      const value = clamp01(lease.calibrate(track.index, clamp01(raw)));
      lease.target[track.slot] = Math.max(lease.target[track.slot], value);
    }
  }

  private end(lease: Lease, how: 'completed' | 'released' | 'cut', reason: string | null): void {
    if (this.leases[lease.scope] !== lease) return;
    delete this.leases[lease.scope];
    this.free[lease.scope] = this.now + FACE_EXCLUSIVE_COOLDOWN_S;
    this.ended = { id: lease.id, scope: lease.scope, how, reason, atMs: this.now * 1_000 };
  }
}

// The face-shape lookup is shared with the model profile and the card (one rule): shared/foundation/face-morphs.ts.
export { resolveFaceMorphs, type FaceApproximation, type FaceMorphLookup, type FaceWrite } from '../../shared/senses';

/**
 * The request's tracks for these writes (resolveFaceMorphs): each write's clip keys onto its morph, times its gain. A write at
 * gain 1 hands over the clip's own key arrays untouched (Gene: exactly the T-215 tracks). Two writes on one morph (the clip's
 * "う" and the pucker standing in on it) are both kept; the face exclusive shows the larger at each instant, both continuous.
 */
export function faceWriteTracks(writes: readonly { from: string; index: number; gain: number }[],
  keys: ReadonlyMap<string, { times: number[]; values: number[] }>): FaceTrackInput[] {
  const out: FaceTrackInput[] = [];
  for (const write of writes) {
    const track = keys.get(write.from);
    if (!track) continue;
    out.push({ index: write.index, times: track.times, values: write.gain === 1 ? track.values : track.values.map(value => value * write.gain) });
  }
  return out;
}

/** The clip's morph keys by name (VMD morph frames as the stage's parser returns them): seconds and weights, sorted. */
export function faceTracksByName(frames: readonly { morphName: string; frameNum: number; weight: number }[]): Map<string, { times: number[]; values: number[] }> {
  const grouped = new Map<string, { frame: number; weight: number }[]>();
  for (const frame of frames ?? []) {
    if (!frame || typeof frame.morphName !== 'string' || !Number.isFinite(frame.frameNum) || !Number.isFinite(frame.weight)) continue;
    const list = grouped.get(frame.morphName) ?? [];
    list.push({ frame: frame.frameNum, weight: frame.weight });
    grouped.set(frame.morphName, list);
  }
  const out = new Map<string, { times: number[]; values: number[] }>();
  for (const [name, list] of grouped) {
    list.sort((a, b) => a.frame - b.frame);
    const times: number[] = [], values: number[] = [];
    for (const key of list) {
      // A repeated frame keeps its last key (MMD's own rule for duplicate keys).
      if (times.length && times.at(-1) === key.frame / 30) values[values.length - 1] = key.weight;
      else { times.push(key.frame / 30); values.push(key.weight); }
    }
    out.set(name, { times, values });
  }
  return out;
}
