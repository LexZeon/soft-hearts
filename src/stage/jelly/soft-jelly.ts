/**
 * I-147 全身果冻, layer 3: soft-region vertex jelly (docs/claude/2026-11-17-whole-body-jelly.md).
 *
 * Belly, hips, thighs, upper arms, cheeks, and the chest on models whose physics has no chest bones (soft-regions.ts finds them
 * from the model's own skinning weights; no painted mask, no PMX change). Per region one 3D damped spring on the CPU (a few
 * numbers per frame): its drive is the acceleration of the region's point carried by its deform bone, so the soft part lags when
 * she starts moving and wobbles when she stops. The vertex shader (soft-shader.ts) pushes the region's vertices by the spring's
 * offset, masked by their skinning weights and a falloff from the region's centre.
 *
 * Bounded: the shown offset is maxOffset · size · tanh(|x| / (maxOffset · size)) — always under the bound, smooth everywhere; a
 * vertex in several regions is averaged, never summed past it. Fades in and out over FADE_SECONDS; a cut (a too-fast step or a
 * reset) gives no impulse. Off: no material is patched and no attribute is added; turning it off puts both back exactly.
 *
 * Step 5 (碰触, not built): a touch is one call on the same state, `impulse(region, velocity)` adding to that region's spring
 * velocity (the touched point's surface normal times how hard, within the same bound), after which the same spring brings it
 * back; holding is moving the spring's rest point to the hand and back on release, from what is shown (no jump).
 */
import { BufferAttribute, Matrix3, Matrix4, Vector3, type Bone, type SkinnedMesh } from 'three';
import { SOFT_DEFAULTS, SOFT_REGIONS, type SoftRegion, type SoftRegionTuning, type SoftTuning } from '../../../shared/stage/jelly-tuning';
import { MAX_SOFT_REGIONS, SLOTS, findSoftRegions, softRegionMap, type SoftRegionInfo, type SoftRegionMap } from './soft-regions';
import { JELLY_REGION_ATTRIBUTE, JELLY_WEIGHT_ATTRIBUTE, JellyMaterialPatch, jellyUniformsFor, type JellyUniforms } from './soft-shader';
import { FADE_SECONDS } from './follow-through';

const SUBSTEP = 1 / 240;
/** Step 5d: a press kicks the spring so its dent peaks at about this share of the region's cap (× the strength); holding moves the rest point at most this share; a touch fades in and out this fast. */
const TOUCH_KICK = 0.9, TOUCH_HOLD = 0.6, TOUCH_FADE_SECONDS = 0.15;
/** A touch lands on a region within this many of its radii from its centre. */
const TOUCH_REACH = 1.3;
const MAX_STEP_SECONDS = 0.25;

interface RegionState {
  info: SoftRegionInfo;
  x: Vector3; v: Vector3;
  point: Vector3; prevPoint: Vector3; hasPoint: boolean;
  velocity: Vector3; prevVelocity: Vector3; hasVelocity: boolean;
  fade: number;
  shown: Vector3;
}

export interface SoftState {
  active: boolean;
  gain: number;
  regions: number;
  /** Largest shown offset on the last frame, as a fraction of its region's size. */
  maxShown: number;
  /** Materials patched, and those whose shader had no place for it. */
  materials: number;
  unsupported: number;
  avgMs: number;
}

const m4 = new Matrix4(), m3 = new Matrix3(), v1 = new Vector3();

export class SoftJelly {
  readonly regions: SoftRegionInfo[];
  private map: SoftRegionMap | null = null;
  private readonly uniforms: JellyUniforms;
  private patch: JellyMaterialPatch | null = null;
  private readonly states: RegionState[];
  private tuning: SoftTuning | null = null;
  private gain = 0;
  private maxShown = 0;
  private cost = 0;
  /** Step 5d: the touch switch, whether a touch is still settling, how much of it shows, and the region held (its rest point, world). */
  private touch = { enabled: false, strength: 1 };
  private touching = false;
  private touchGain = 0;
  private held: { region: number; rest: Vector3 } | null = null;
  /** Scale for the cut detection: the distance between the shoulder joints (model units). */
  private readonly scale: number;

  constructor(readonly mesh: SkinnedMesh, hasChestBones: boolean) {
    this.uniforms = jellyUniformsFor(mesh); // the mesh's one object, never a new one per touch (see jellyUniformsFor)
    this.regions = findSoftRegions(mesh, hasChestBones).slice(0, MAX_SOFT_REGIONS);
    this.states = this.regions.map(info => ({ info, x: new Vector3(), v: new Vector3(), point: new Vector3(), prevPoint: new Vector3(), hasPoint: false,
      velocity: new Vector3(), prevVelocity: new Vector3(), hasVelocity: false, fade: 0, shown: new Vector3() }));
    this.scale = Math.max(1e-3, ...this.regions.map(region => region.radius * 3));
    this.regions.forEach((region, r) => this.uniforms.shJellyCenter.value[r].fromArray(region.center));
  }

  /** Nothing shown and nothing to fade: no material or attribute is touched. */
  get idle(): boolean { return this.gain <= 0 && !this.tuning?.enabled && this.touchGain <= 0 && !this.touching; }

  configure(tuning: SoftTuning | null | undefined): void {
    this.tuning = tuning ? structuredClone(tuning) : this.tuning ? { ...this.tuning, enabled: false } : null;
  }

  /** Step 5d「碰了才软」: on or off, and how strong (0–2; clamped). Off ends a touch going on (it eases back). */
  configureTouch(enabled: boolean, strength = 1): void {
    this.touch = { enabled: enabled === true, strength: Number.isFinite(strength) ? Math.min(2, Math.max(0, strength)) : 1 };
    if (!this.touch.enabled) this.held = null;
  }

  /**
   * Step 5d: a press at `point` (world), pushing along `into` (world, unit; e.g. the camera's view direction): the region under it gets
   * one kick on its spring velocity, sized so the dent stays well inside the region's own cap. Returns the region's index, or -1 when
   * no soft region is there (or the switch is off).
   */
  press(point: Vector3, into: Vector3): number { return this.pressRegion(this.touch.enabled ? this.regionAt(point) : -1, into); }

  /** The same kick on a region known by its index (a pinch knows its cheek), or -1. */
  pressRegion(r: number, into: Vector3): number {
    const s = this.states[r];
    if (!s || !this.touch.enabled) return -1;
    const knobs = this.knobsOf(s), max = knobs.maxOffset * s.info.radius, omega = 2 * Math.PI * knobs.hz;
    s.v.addScaledVector(v1.copy(into).normalize(), TOUCH_KICK * this.touch.strength * max * omega);
    this.touching = true;
    return r;
  }

  /** Holding: the region's rest point moves by `offset` (world), at most TOUCH_HOLD of its cap; null lets go (it eases back from what shows). */
  hold(region: number, offset: Vector3 | null): void {
    const s = this.states[region];
    if (!s || !offset || !this.touch.enabled) { this.held = null; return; }
    const max = this.knobsOf(s).maxOffset * s.info.radius * TOUCH_HOLD * Math.min(1, this.touch.strength);
    this.held = { region, rest: (this.held?.region === region ? this.held.rest : new Vector3()).copy(offset) };
    if (this.held.rest.length() > max) this.held.rest.setLength(max);
    this.touching = true;
  }

  /** A cut: forget the motion history (no impulse); what is shown eases back by itself. */
  reset(): void { for (const s of this.states) { s.hasPoint = false; s.hasVelocity = false; } }

  /** Not on screen: clear the springs (the patch stays while the layer is on; the offsets are zero). */
  hide(): void {
    this.gain = 0; this.maxShown = 0; this.touchGain = 0; this.touching = false; this.held = null;
    for (const s of this.states) { s.x.set(0, 0, 0); s.v.set(0, 0, 0); s.fade = 0; s.hasPoint = false; s.hasVelocity = false; s.shown.set(0, 0, 0); }
    for (const offset of this.uniforms.shJellyOffset.value) offset.set(0, 0, 0);
    if (!this.tuning?.enabled) this.release();
  }

  /** After the final pose (layer 2 included), before render. */
  update(dt: number): void {
    const started = performance.now();
    const on = this.tuning?.enabled === true && this.regions.length > 0;
    if (this.touching && !this.held && this.states.every(s => s.x.lengthSq() < 1e-12 * s.info.radius ** 2 && s.v.lengthSq() < 1e-10 * s.info.radius ** 2)) this.touching = false;
    const touchOn = this.touching && this.touch.enabled && this.regions.length > 0;
    if (!on && !touchOn && this.gain <= 0 && this.touchGain <= 0) { if (this.patch) this.release(); this.maxShown = 0; return; }
    if (!Number.isFinite(dt) || dt < 0) return;
    if (on || touchOn) this.install();
    if (dt > 0) this.gain = Math.min(1, Math.max(0, this.gain + (on ? dt : -dt) / FADE_SECONDS));
    if (dt > 0) this.touchGain = Math.min(1, Math.max(0, this.touchGain + (touchOn ? dt : -dt) / TOUCH_FADE_SECONDS));
    if (dt > MAX_STEP_SECONDS) this.reset();
    const step = Math.min(dt, MAX_STEP_SECONDS);
    this.mesh.updateWorldMatrix(true, false);
    m3.setFromMatrix4(m4.copy(this.mesh.matrixWorld)).invert();
    let shown = 0;
    this.states.forEach((s, r) => {
      const knobs = this.tuning?.regions[s.info.kind];
      const enabled = on && !!knobs && knobs.enabled;
      if (step > 0) s.fade = Math.min(1, Math.max(0, s.fade + (enabled ? step : -step) / FADE_SECONDS));
      // The body's motion drives the springs only while layer 3 itself is on; a touch alone moves only what was touched.
      this.drive(s, step, on ? knobs : undefined);
      const own = knobs ?? (this.touchGain > 0 ? SOFT_DEFAULTS[s.info.kind] : undefined);
      if (own && step > 0) this.integrate(s, step, own, this.held?.region === r ? this.held.rest : null);
      const max = (own?.maxOffset ?? 0) * s.info.radius, length = s.x.length(), amount = Math.max(this.gain * s.fade, this.touchGain);
      if (max > 0 && length > 1e-12 && amount > 0) s.shown.copy(s.x).multiplyScalar(amount * max * Math.tanh(length / max) / length);
      else s.shown.set(0, 0, 0);
      shown = Math.max(shown, s.shown.length() / s.info.radius);
      this.uniforms.shJellyOffset.value[r].copy(s.shown).applyMatrix3(m3);
      this.uniforms.shJellyShape.value[r].set(s.info.radius * (own?.radius ?? 1), own?.falloff ?? 1);
    });
    this.maxShown = shown;
    if (!on && !touchOn && this.gain <= 0 && this.touchGain <= 0) this.hide();
    this.cost = this.cost * 0.9 + (performance.now() - started) * 0.1;
  }

  getState(): SoftState {
    return { active: !this.idle, gain: this.gain, regions: this.regions.length, maxShown: this.maxShown,
      materials: this.patch?.count ?? 0, unsupported: this.patch?.unsupported ?? 0, avgMs: this.cost };
  }

  /** The per-vertex region slots (built once per model on first use). */
  regionMap(): SoftRegionMap { return this.map ??= softRegionMap(this.mesh, this.regions); }

  /** The offsets the shader gets this frame (mesh space), per region (tests read them). */
  shownOffsets(): Vector3[] { return this.uniforms.shJellyOffset.value.slice(0, this.regions.length).map(value => value.clone()); }
  uniformValues(): JellyUniforms { return this.uniforms; }

  dispose(): void { this.release(); this.tuning = null; this.gain = 0; }

  /** Adds the region slots to the geometry and patches the materials (the materials again each frame: other layers clone them). */
  private install(): void {
    const geometry = this.mesh.geometry;
    if (!geometry.getAttribute(JELLY_REGION_ATTRIBUTE)) {
      const map = this.regionMap();
      geometry.setAttribute(JELLY_REGION_ATTRIBUTE, new BufferAttribute(map.slotRegion, SLOTS));
      geometry.setAttribute(JELLY_WEIGHT_ATTRIBUTE, new BufferAttribute(map.slotWeight, SLOTS));
    }
    (this.patch ??= new JellyMaterialPatch(this.uniforms)).ensure(this.mesh.material);
  }

  /** Off: materials and geometry exactly as before the layer. */
  private release(): void {
    this.patch?.unpatch(); this.patch = null;
    const geometry = this.mesh.geometry;
    if (geometry.getAttribute(JELLY_REGION_ATTRIBUTE)) { geometry.deleteAttribute(JELLY_REGION_ATTRIBUTE); geometry.deleteAttribute(JELLY_WEIGHT_ATTRIBUTE); }
  }

  /** The region's point as its deform bone carries it (world), and the change of its velocity as an impulse on the spring. */
  /** The region's knobs from the lab's tuning, or the starting values (a touch works without a saved tuning). */
  private knobsOf(s: RegionState): SoftRegionTuning { return this.tuning?.regions[s.info.kind] ?? SOFT_DEFAULTS[s.info.kind as SoftRegion]; }

  /** The soft region a world point is on (nearest centre within TOUCH_REACH radii), or -1. */
  regionAt(point: Vector3): number {
    let best = -1, distance = Infinity;
    this.states.forEach((s, r) => {
      const bone = this.mesh.skeleton.bones[s.info.driver] as Bone | undefined, inverse = this.mesh.skeleton.boneInverses[s.info.driver];
      if (!bone || !inverse) return;
      bone.updateWorldMatrix(true, false);
      const centre = v1.fromArray(s.info.center).applyMatrix4(m4.copy(bone.matrixWorld).multiply(inverse).multiply(this.mesh.bindMatrix));
      const d = centre.distanceTo(point) / (s.info.radius * this.knobsOf(s).radius);
      if (d <= TOUCH_REACH && d < distance) { distance = d; best = r; }
    });
    return best;
  }

  /** For the lab and tests: whether a touch is still showing, and the region held. */
  touchState(): { enabled: boolean; touching: boolean; gain: number; held: number | null } {
    return { enabled: this.touch.enabled, touching: this.touching, gain: this.touchGain, held: this.held?.region ?? null };
  }

  private drive(s: RegionState, dt: number, knobs: SoftRegionTuning | undefined): void {
    const bone = this.mesh.skeleton.bones[s.info.driver] as Bone | undefined, inverse = this.mesh.skeleton.boneInverses[s.info.driver];
    if (!bone || !inverse) return;
    bone.updateWorldMatrix(true, false);
    s.point.fromArray(s.info.center).applyMatrix4(m4.copy(bone.matrixWorld).multiply(inverse).multiply(this.mesh.bindMatrix));
    if (s.hasPoint && dt > 0) {
      s.velocity.copy(s.point).sub(s.prevPoint).divideScalar(dt);
      if (!Number.isFinite(s.velocity.x + s.velocity.y + s.velocity.z) || s.velocity.length() > 20 * this.scale) s.hasVelocity = false; // a cut
      else {
        if (s.hasVelocity && knobs) {
          v1.copy(s.velocity).sub(s.prevVelocity).multiplyScalar(knobs.gain);
          const size = v1.length(), limit = 10 * this.scale;
          if (size > limit) v1.multiplyScalar(limit / size);
          s.v.sub(v1);
        }
        s.prevVelocity.copy(s.velocity); s.hasVelocity = true;
      }
    }
    if (dt > 0 || !s.hasPoint) { s.prevPoint.copy(s.point); s.hasPoint = true; }
  }

  private integrate(s: RegionState, dt: number, knobs: SoftRegionTuning, rest: Vector3 | null = null): void {
    const rx = rest?.x ?? 0, ry = rest?.y ?? 0, rz = rest?.z ?? 0;
    const omega = 2 * Math.PI * knobs.hz, k = omega * omega, c = 2 * knobs.damping * omega;
    const count = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-9)), h = dt / count;
    for (let i = 0; i < count; i++) {
      s.v.x += (-k * (s.x.x - rx) - c * s.v.x) * h; s.v.y += (-k * (s.x.y - ry) - c * s.v.y) * h; s.v.z += (-k * (s.x.z - rz) - c * s.v.z) * h;
      s.x.addScaledVector(s.v, h);
    }
    const max = knobs.maxOffset * s.info.radius, limit = Math.max(1e-9, 2 * max), length = s.x.length();
    if (max <= 0) { s.x.set(0, 0, 0); s.v.set(0, 0, 0); }
    else if (length > limit) {
      s.x.multiplyScalar(limit / length);
      const outward = s.v.dot(v1.copy(s.x).normalize());
      if (outward > 0) s.v.addScaledVector(v1, -outward);
    }
  }
}

/** For the lab and tests: which soft regions a kind has on this model. */
export function softRegionKinds(regions: readonly SoftRegionInfo[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of SOFT_REGIONS) out[kind] = regions.filter(region => region.kind === kind).length;
  return out;
}
