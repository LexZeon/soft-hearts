/**
 * I-078 第 1 步: her pillow and small white desk. Original procedural geometry made here in code (no external asset, nothing
 * read from disk), sized from her own body by sleep-postures.ts (the pillow fills the gap from the floor to her head, the desk
 * top sits under her forearms).
 *
 * "Soft" without a physics solver (第 4 题): the pillow's top surface takes a dent where her head
 * rests; the dent's depth follows the head with a lightly under-damped spring, so when the head lifts or shifts the pillow
 * springs back with a small rebound. Both props fade in and out (opacity), never pop; hidden and their geometry kept while she
 * is awake, disposed with the model.
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial, type Object3D } from 'three';
import { SLEEP_BODY_KNOBS } from '../../shared/behaviors/sleep-body/knobs';

const PILLOW_GRID = 22;

/** A puffy pillow: top and bottom surfaces meeting at a seam, `width` × `depth`, `height` at the middle, its base at y = 0. */
export function pillowGeometry(width: number, depth: number, height: number): BufferGeometry {
  const n = PILLOW_GRID, side = (n + 1) * (n + 1), positions = new Float32Array(side * 2 * 3), indices: number[] = [];
  const puff = (u: number, v: number) => Math.pow(Math.max(0, 1 - Math.abs(u) ** 3.2), 0.42) * Math.pow(Math.max(0, 1 - Math.abs(v) ** 3.2), 0.42);
  for (let s = 0; s < 2; s++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const u = i / n * 2 - 1, v = j / n * 2 - 1, f = puff(u, v), at = (s * side + j * (n + 1) + i) * 3;
    positions[at] = u * width / 2 * (1 - 0.06 * f); positions[at + 1] = height * (0.5 + (s === 0 ? 0.5 : -0.5) * f); positions[at + 2] = v * depth / 2 * (1 - 0.06 * f);
  }
  for (let s = 0; s < 2; s++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = s * side + j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    if (s === 0) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.base = positions.slice();
  return geometry;
}

/**
 * Dent the pillow's top surface at (x, z) (pillow-local) by `depth` with a gaussian of width `radius`; depth 0 restores it.
 * Returns whether anything changed.
 */
export function dentPillow(geometry: BufferGeometry, x: number, z: number, depth: number, radius: number): boolean {
  const base = geometry.userData.base as Float32Array | undefined, attribute = geometry.getAttribute('position') as BufferAttribute | undefined;
  if (!base || !attribute) return false;
  const positions = attribute.array as Float32Array, side = (PILLOW_GRID + 1) * (PILLOW_GRID + 1), r2 = Math.max(1e-6, radius * radius * 2);
  let changed = false;
  for (let k = 0; k < side; k++) {
    const at = k * 3, dx = base[at] - x, dz = base[at + 2] - z;
    const y = base[at + 1] - Math.max(0, depth) * Math.exp(-(dx * dx + dz * dz) / r2);
    if (Math.abs(positions[at + 1] - y) > 1e-6) { positions[at + 1] = y; changed = true; }
  }
  if (changed) { attribute.needsUpdate = true; geometry.computeVertexNormals(); }
  return changed;
}

/** A small white low desk: a slab top and four legs, `width` (her left-right) × `depth`, top at `height`. */
export function deskGeometry(width: number, depth: number, height: number): BufferGeometry[] {
  const top = Math.max(0.05, height * 0.09), leg = Math.max(0.08, Math.min(width, depth) * 0.06);
  const slab = new BoxGeometry(width, top, depth); slab.translate(0, height - top / 2, 0);
  const legs = [-1, 1].flatMap(sx => [-1, 1].map(sz => {
    const g = new BoxGeometry(leg, height - top, leg);
    g.translate(sx * (width / 2 - leg * 1.4), (height - top) / 2, sz * (depth / 2 - leg * 1.4));
    return g;
  }));
  return [slab, ...legs];
}

export interface PropPlan {
  pillow?: { center: { x: number; y: number; z: number }; width: number; depth: number; height: number; yaw: number; sink: number };
  desk?: { center: { x: number; y: number; z: number }; width: number; depth: number; height: number; yaw: number };
}
export interface PropFrame {
  /** 0..1 shown. */
  pillow: number;
  desk: number;
  /** 0..1 how much her head presses now (1 = the planned sink), and the contact point's slide (pillow-local x, model units). */
  press: number;
  pressX: number;
}

/** Underdamped spring for the dent depth: the pillow rebounds a little when the head leaves (ζ ≈ 0.45). */
class Rebound {
  x = 0; v = 0;
  step(target: number, omega: number, dt: number): number {
    const zeta = 0.45, steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) { const a = omega * omega * (target - this.x) - 2 * zeta * omega * this.v; this.v += a * h; this.x += this.v * h; }
    return this.x;
  }
}

/** The props of one model: built lazily from a plan, faded and dented each frame through `frame`. */
export class SleepProps {
  readonly group = new Group();
  private pillow: Mesh | null = null;
  private desk: Group | null = null;
  private pillowKey = '';
  private deskKey = '';
  private dent = new Rebound();
  private shown = { pillow: 0, desk: 0 };
  private readonly materials: MeshLambertMaterial[] = [];

  constructor(private readonly parent: Object3D) { this.group.name = 'sleep-props'; parent.add(this.group); }

  /** Place (and re-size) the props for a plan; same plan → nothing rebuilt. */
  place(plan: PropPlan): void {
    const p = plan.pillow;
    if (p) {
      const key = [p.width, p.depth, p.height].map(v => v.toFixed(3)).join(',');
      if (key !== this.pillowKey) {
        this.pillowKey = key;
        if (this.pillow) { this.group.remove(this.pillow); this.pillow.geometry.dispose(); }
        this.pillow = new Mesh(pillowGeometry(p.width, p.depth, p.height), this.material(0xf2f5fb));
        this.pillow.name = 'sleep-pillow'; this.pillow.renderOrder = 1;
        this.group.add(this.pillow);
      }
      this.pillow!.position.set(p.center.x, p.center.y, p.center.z); this.pillow!.rotation.set(0, p.yaw, 0);
      this.pillow!.userData.sink = p.sink;
    }
    const d = plan.desk;
    if (d) {
      const key = [d.width, d.depth, d.height].map(v => v.toFixed(3)).join(',');
      if (key !== this.deskKey) {
        this.deskKey = key;
        if (this.desk) { this.group.remove(this.desk); this.desk.children.forEach(child => (child as Mesh).geometry.dispose()); }
        this.desk = new Group(); this.desk.name = 'sleep-desk';
        const material = this.material(0xfbfbfa);
        for (const geometry of deskGeometry(d.width, d.depth, d.height)) { const mesh = new Mesh(geometry, material); mesh.renderOrder = 1; this.desk.add(mesh); }
        this.group.add(this.desk);
      }
      this.desk!.position.set(d.center.x, d.center.y, d.center.z); this.desk!.rotation.set(0, d.yaw, 0);
    }
  }

  private material(color: number): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, transparent: true, opacity: 0, depthWrite: true });
    this.materials.push(material);
    return material;
  }

  /** One frame: fade toward the wanted visibility (pillow / desk 0..1) and dent the pillow by the head's press. */
  frame(delta: number, want: { pillow: number; desk: number; press: number; pressX: number; pressZ?: number }): PropFrame {
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0, k = SLEEP_BODY_KNOBS.props;
    const rate = dt / Math.max(0.05, k.fadeSeconds);
    for (const key of ['pillow', 'desk'] as const) {
      const target = Math.min(1, Math.max(0, want[key]));
      const now = this.shown[key];
      // Smooth (eased) fade: the step shrinks near both ends.
      this.shown[key] = now < target ? Math.min(target, now + rate * (0.25 + Math.sin(Math.PI * Math.min(1, now)) * 1.2))
        : Math.max(target, now - rate * (0.25 + Math.sin(Math.PI * Math.min(1, now)) * 1.2));
    }
    const fade = (object: Object3D | null, value: number) => {
      if (!object) return;
      object.visible = value > 0.002;
      object.traverse(child => { const m = (child as Mesh).material as MeshLambertMaterial | undefined; if (m && 'opacity' in m) { m.opacity = value; m.transparent = value < 0.999; } });
    };
    fade(this.pillow, this.shown.pillow); fade(this.desk, this.shown.desk);
    const sink = (this.pillow?.userData.sink as number | undefined) ?? 0;
    const depth = this.dent.step(Math.max(0, want.press) * sink, k.rebound, dt);
    if (this.pillow && this.pillow.visible) {
      const r = sink / Math.max(1e-3, k.softness);
      dentPillow(this.pillow.geometry, want.pressX, want.pressZ ?? 0, depth, r * 0.9);
    }
    return { pillow: this.shown.pillow, desk: this.shown.desk, press: sink > 0 ? depth / sink : 0, pressX: want.pressX };
  }

  /** The props' corners in world space while shown (the stray-pixel sentinel's reach must include them). */
  corners(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const object of [this.pillow, this.desk]) {
      if (!object?.visible) continue;
      object.updateMatrixWorld(true);
      object.traverse(child => {
        const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
        if (!geometry) return;
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          const e = child.matrixWorld.elements;
          out.push({ x: e[0] * x + e[4] * y + e[8] * z + e[12], y: e[1] * x + e[5] * y + e[9] * z + e[13], z: e[2] * x + e[6] * y + e[10] * z + e[14] });
        }
      });
    }
    return out;
  }

  get state() { return { pillow: this.shown.pillow, desk: this.shown.desk, dent: this.dent.x }; }

  dispose(): void {
    this.parent.remove(this.group);
    this.pillow?.geometry.dispose();
    this.desk?.children.forEach(child => (child as Mesh).geometry.dispose());
    for (const m of this.materials) m.dispose();
    this.pillow = this.desk = null;
  }
}
