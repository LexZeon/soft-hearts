/**
 * I-031 色块诊断日志, the stage's side (temporary).
 *
 * Every frame the pet stage writes a few numbers into fixed arrays (a ring of the last frames: frame time, head and eye turn,
 * the pointer, whether it is over her, physics, lost contexts; what she is doing every 100 ms). Nothing else happens until the
 * 色块哨兵 (stray-pixels.ts) tells this recorder about a block: then, inside the same task as the render, it copies the last
 * COLOR_BLOCK_WINDOW_MS of the ring, looks at her bones, morph weights and geometry, notes the GPU and the framing, and takes
 * a small picture of the 3D canvas alone (never the page: chat bubbles and the input are other elements). The sample after
 * the re-send adds whether it went away and a second picture, and the record goes to the host (electron/color-block-log.ts),
 * which checks it again and writes it outside every profile. A single hit that did not repeat goes as one short line of
 * numbers. Every step is guarded: the pet never notices a failure here.
 */
import { Vector3, type Camera, type SkinnedMesh } from 'three';
import {
  COLOR_BLOCK_FRAME_COLUMNS, COLOR_BLOCK_GAP_MS, COLOR_BLOCK_IMAGE_BYTES, COLOR_BLOCK_IMAGE_PREFIX, COLOR_BLOCK_IMAGE_WIDTH,
  COLOR_BLOCK_MAX_FRAMES, COLOR_BLOCK_MAX_RUNS, COLOR_BLOCK_NEAR_GAP_MS, COLOR_BLOCK_WINDOW_MS,
  type ColorBlockEnv, type ColorBlockEvent, type ColorBlockFrames, type ColorBlockInspect, type ColorBlockReport, type ColorBlockSample,
  type ColorBlockWatchStats,
} from '../../shared/color-block';
import { MOTION_ACTIVITIES, type MotionActivity } from '../../shared/journal';
import { brokenGeometry, type StrayCause, type StrayDiagnostics, type StrayReport, type StraySample } from './stray-pixels';

/** Ring size: COLOR_BLOCK_WINDOW_MS even at 200 frames a second. */
export const COLOR_BLOCK_RING = 1_024;
/** What she is doing and whether physics runs are read this often (they allocate; the per-frame numbers do not). */
export const COLOR_BLOCK_SLOW_MS = 100;
/** A block whose next sample never comes (the model changed) is sent without it after this long. */
export const COLOR_BLOCK_SETTLE_MS = 3_000;
/** A frame this slow counts as a stall in a near miss's dt line. */
export const COLOR_BLOCK_SLOW_FRAME_MS = 50;

/** The per-frame numbers the stage fills in (one object, reused). */
export interface ColorBlockFrameValues { headYaw: number; headPitch: number; eyeX: number; eyeY: number; pointerX: number; pointerY: number; pointerOver: boolean }
export interface ColorBlockScene { mesh: SkinnedMesh; height: number; camera: Camera; fps: number | null }
/** The 3D canvas (the renderer's own element). */
export interface ColorBlockGlCanvas {
  width: number; height: number; clientWidth?: number; clientHeight?: number;
  addEventListener?(type: string, listener: () => void): void;
}
export type ColorBlockGl = Pick<WebGL2RenderingContext, 'getExtension' | 'getParameter' | 'RENDERER' | 'VENDOR' | 'drawingBufferWidth' | 'drawingBufferHeight'>;
/** The small 2D canvas the picture is drawn on. */
export interface ColorBlockSnapshotCanvas {
  width: number; height: number;
  getContext(type: '2d'): { clearRect(x: number, y: number, w: number, h: number): void; drawImage(image: never, x: number, y: number, w: number, h: number): void } | null;
  toDataURL(type: string): string;
}
export interface ColorBlockDeps {
  send(report: ColorBlockReport): void;
  /** Fill in this frame's numbers. */
  read(out: ColorBlockFrameValues): void;
  /** Read at most every COLOR_BLOCK_SLOW_MS. */
  slow(): { activities: readonly MotionActivity[]; physics: boolean };
  scene(): ColorBlockScene | null;
  now?(): number;
  createCanvas?(): ColorBlockSnapshotCanvas;
  devicePixelRatio?(): number;
}

const round = (value: number, digits = 4) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const finiteOr = (value: number, digits = 4) => Number.isFinite(value) ? round(value, digits) : 0;
const plainName = (name: string, fallback: string) => (String(name ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f\/:*?"<>|\\]/g, '').slice(0, 40)) || fallback;
const pngBytes = (url: string) => Math.floor((url.length - COLOR_BLOCK_IMAGE_PREFIX.length) * 3 / 4);

export class ColorBlockRecorder {
  readonly hooks: StrayDiagnostics;
  private readonly values: ColorBlockFrameValues = { headYaw: 0, headPitch: 0, eyeX: 0, eyeY: 0, pointerX: 0, pointerY: 0, pointerOver: false };
  private readonly t = new Float64Array(COLOR_BLOCK_RING);
  private readonly columns = { dtMs: new Float32Array(COLOR_BLOCK_RING), headYaw: new Float32Array(COLOR_BLOCK_RING), headPitch: new Float32Array(COLOR_BLOCK_RING),
    eyeX: new Float32Array(COLOR_BLOCK_RING), eyeY: new Float32Array(COLOR_BLOCK_RING), pointerX: new Float32Array(COLOR_BLOCK_RING), pointerY: new Float32Array(COLOR_BLOCK_RING) };
  private readonly flags = new Uint8Array(COLOR_BLOCK_RING);
  private readonly masks = new Uint16Array(COLOR_BLOCK_RING);
  private readonly lost = new Uint16Array(COLOR_BLOCK_RING);
  private head = 0;
  private count = 0;
  private slowAt = -Infinity;
  private mask = 0;
  private physics = false;
  private canvas: ColorBlockGlCanvas | null = null;
  private gl: ColorBlockGl | null = null;
  private gpu: { gl: ColorBlockGl; renderer: string; vendor: string } | null = null;
  private contextLost = 0;
  private contextRestored = 0;
  private snapCanvas: ColorBlockSnapshotCanvas | null = null;
  private pending: { event: ColorBlockEvent; at: number } | null = null;
  private lastBlockAt = -Infinity;
  private lastNearAt = -Infinity;
  /** Diagnostics for tests and the pretrial: events sent, skipped by the gap, failures swallowed. */
  readonly stats = { blocks: 0, nears: 0, skipped: 0, failures: 0 };

  constructor(private readonly deps: ColorBlockDeps) {
    this.hooks = {
      block: (sample, cause) => this.guard(() => this.block(sample, cause)),
      settled: (sample, report) => this.guard(() => this.settled(sample, report)),
      near: sample => this.guard(() => this.near(sample)),
    };
  }

  private now(): number { return this.deps.now ? this.deps.now() : performance.now(); }
  private guard(run: () => void): void { try { run(); } catch { this.stats.failures++; } }

  /** Right after the stage rendered a frame, before the sentinel reads it. No allocation beyond the fixed arrays. */
  frame(time: number, dtMs: number, canvas: ColorBlockGlCanvas, gl: ColorBlockGl | null): void {
    try {
      if (canvas !== this.canvas) {
        this.canvas = canvas;
        canvas.addEventListener?.('webglcontextlost', () => { this.contextLost++; });
        canvas.addEventListener?.('webglcontextrestored', () => { this.contextRestored++; });
      }
      this.gl = gl;
      if (time - this.slowAt >= COLOR_BLOCK_SLOW_MS || time < this.slowAt) {
        this.slowAt = time;
        const slow = this.deps.slow();
        let mask = 0;
        for (const name of slow.activities) { const index = MOTION_ACTIVITIES.indexOf(name); if (index >= 0) mask |= 1 << index; }
        this.mask = mask; this.physics = slow.physics === true;
      }
      const values = this.values;
      this.deps.read(values);
      const i = this.head;
      this.t[i] = time;
      this.columns.dtMs[i] = dtMs; this.columns.headYaw[i] = values.headYaw; this.columns.headPitch[i] = values.headPitch;
      this.columns.eyeX[i] = values.eyeX; this.columns.eyeY[i] = values.eyeY; this.columns.pointerX[i] = values.pointerX; this.columns.pointerY[i] = values.pointerY;
      this.flags[i] = (values.pointerOver ? 1 : 0) | (this.physics ? 2 : 0);
      this.masks[i] = this.mask;
      this.lost[i] = Math.min(65_535, this.contextLost);
      this.head = (i + 1) % COLOR_BLOCK_RING;
      if (this.count < COLOR_BLOCK_RING) this.count++;
      const pending = this.pending;
      if (pending && this.now() - pending.at > COLOR_BLOCK_SETTLE_MS) { this.pending = null; this.send(pending.event); }
    } catch { this.stats.failures++; }
  }

  private send(report: ColorBlockReport): void {
    if (report.kind === 'block') this.stats.blocks++; else this.stats.nears++;
    this.deps.send(report);
  }

  private block(sample: StraySample, cause: StrayCause): void {
    const now = this.now();
    if (this.pending) { const pending = this.pending; this.pending = null; this.send(pending.event); }
    if (now - this.lastBlockAt < COLOR_BLOCK_GAP_MS) { this.stats.skipped++; return; }
    this.lastBlockAt = now;
    const scene = this.deps.scene();
    const event: ColorBlockEvent = {
      kind: 'block', cause: { part: cause.part, name: cause.name } as ColorBlockEvent['cause'], cleared: null,
      found: sampleOf(sample), after: null, watch: statsOf(sample.stats),
      // The sentinel's own inspect already walked her geometry when it says gpu or geometry; not twice in the same frame.
      inspect: scene ? inspectDetails(scene.mesh, scene.height, cause.part === 'gpu' ? false : cause.part === 'geometry' ? true : undefined) : null,
      ...this.history(now), env: this.environment(scene),
      images: { found: this.snapshot(), after: null },
    };
    this.pending = { event, at: now };
  }

  private settled(sample: StraySample, report: StrayReport): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.event.cleared = report.cleared;
    pending.event.after = sampleOf(sample);
    pending.event.watch = statsOf(sample.stats);
    pending.event.images.after = this.snapshot();
    this.send(pending.event);
  }

  private near(sample: StraySample): void {
    const now = this.now();
    if (now - this.lastNearAt < COLOR_BLOCK_NEAR_GAP_MS) return;
    this.lastNearAt = now;
    let frames = 0, sum = 0, max = 0, slow = 0;
    this.each(now, index => {
      const dt = this.columns.dtMs[index];
      frames++; sum += dt; if (dt > max) max = dt; if (dt > COLOR_BLOCK_SLOW_FRAME_MS) slow++;
    });
    this.send({ kind: 'near', found: sampleOf(sample), watch: statsOf(sample.stats),
      dt: { frames, meanMs: frames ? round(sum / frames, 2) : 0, maxMs: round(max, 2), slowFrames: slow }, activities: namesOf(this.mask) });
  }

  /** Ring indexes of the frames within the window before `now`, oldest first (at most COLOR_BLOCK_MAX_FRAMES). */
  private each(now: number, visit: (index: number) => void): void {
    for (let k = Math.min(this.count, COLOR_BLOCK_MAX_FRAMES); k >= 1; k--) {
      const index = (this.head - k + COLOR_BLOCK_RING) % COLOR_BLOCK_RING;
      if (now - this.t[index] <= COLOR_BLOCK_WINDOW_MS) visit(index);
    }
  }

  private history(now: number): { frames: ColorBlockFrames; activities: ColorBlockEvent['activities'] } {
    const frames = Object.fromEntries(COLOR_BLOCK_FRAME_COLUMNS.map(column => [column, [] as number[]])) as unknown as ColorBlockFrames;
    const activities: ColorBlockEvent['activities'] = [];
    let previous = -1;
    this.each(now, index => {
      const atMs = round(this.t[index] - now, 1);
      frames.atMs.push(atMs);
      frames.dtMs.push(finiteOr(this.columns.dtMs[index], 2));
      frames.headYaw.push(finiteOr(this.columns.headYaw[index])); frames.headPitch.push(finiteOr(this.columns.headPitch[index]));
      frames.eyeX.push(finiteOr(this.columns.eyeX[index])); frames.eyeY.push(finiteOr(this.columns.eyeY[index]));
      frames.pointerX.push(finiteOr(this.columns.pointerX[index])); frames.pointerY.push(finiteOr(this.columns.pointerY[index]));
      frames.pointerOver.push(this.flags[index] & 1); frames.physics.push(this.flags[index] & 2 ? 1 : 0);
      frames.contextLost.push(this.lost[index]);
      const mask = this.masks[index];
      if (mask !== previous && activities.length < COLOR_BLOCK_MAX_RUNS) { activities.push({ atMs, names: namesOf(mask) }); previous = mask; }
    });
    return { frames, activities };
  }

  private environment(scene: ColorBlockScene | null): ColorBlockEnv {
    const gl = this.gl, canvas = this.canvas;
    let renderer = '', vendor = '';
    try {
      if (gl && this.gpu?.gl !== gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
        this.gpu = { gl, renderer: String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? ''),
          vendor: String(gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? '') };
      }
      if (this.gpu) ({ renderer, vendor } = this.gpu);
    } catch { /* unknown GPU */ }
    const camera = scene?.camera as (Camera & { fov?: number; zoom?: number; aspect?: number; position?: Vector3 }) | undefined;
    let distance: number | null = null;
    try {
      if (scene && camera?.position) {
        scene.mesh.getWorldPosition(point);
        const unit = Math.max(1e-6, Math.max(1, scene.height) * Math.abs(scene.mesh.getWorldScale(scale).y || 1));
        distance = round(camera.position.distanceTo(point) / unit, 3);
      }
    } catch { distance = null; }
    const number = (value: unknown, digits = 3) => typeof value === 'number' && Number.isFinite(value) ? round(value, digits) : null;
    let dpr = 1;
    try { dpr = this.deps.devicePixelRatio ? this.deps.devicePixelRatio() : (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1; } catch { dpr = 1; }
    return { renderer: renderer.slice(0, 200), vendor: vendor.slice(0, 200),
      bufferWidth: finiteOr(gl?.drawingBufferWidth ?? 0, 0), bufferHeight: finiteOr(gl?.drawingBufferHeight ?? 0, 0),
      canvasWidth: finiteOr(canvas?.clientWidth ?? 0, 0), canvasHeight: finiteOr(canvas?.clientHeight ?? 0, 0), dpr: finiteOr(dpr, 3),
      fov: number(camera?.fov), zoom: number(camera?.zoom), aspect: number(camera?.aspect), distance, fps: number(scene?.fps, 0),
      contextLost: this.contextLost, contextRestored: this.contextRestored };
  }

  /** A small PNG of the 3D canvas alone, drawn in the same task as its render (the buffer is not kept after it). */
  private snapshot(): string | null {
    const source = this.canvas;
    if (!source || !(source.width > 0 && source.height > 0)) return null;
    try {
      const canvas = this.snapCanvas ??= this.deps.createCanvas ? this.deps.createCanvas() : document.createElement('canvas') as unknown as ColorBlockSnapshotCanvas;
      for (const wide of [COLOR_BLOCK_IMAGE_WIDTH, 160, 96]) {
        const scaleBy = Math.min(1, wide / source.width, (wide * 2) / source.height);
        const width = Math.max(1, Math.round(source.width * scaleBy)), height = Math.max(1, Math.round(source.height * scaleBy));
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.clearRect(0, 0, width, height);
        context.drawImage(source as never, 0, 0, width, height);
        const url = canvas.toDataURL('image/png');
        if (typeof url === 'string' && url.startsWith(COLOR_BLOCK_IMAGE_PREFIX) && pngBytes(url) <= COLOR_BLOCK_IMAGE_BYTES) return url;
      }
    } catch { this.stats.failures++; }
    return null;
  }
}

const point = new Vector3(), origin = new Vector3(), scale = new Vector3();

function namesOf(mask: number): MotionActivity[] {
  const names: MotionActivity[] = [];
  MOTION_ACTIVITIES.forEach((name, index) => { if (mask & (1 << index)) names.push(name); });
  return names;
}

function statsOf(stats: StraySample['stats']): ColorBlockWatchStats {
  return { samples: stats.samples, hits: stats.hits, blocks: stats.blocks, cleared: stats.cleared, stayed: stats.stayed, widen: stats.widen, stopped: stats.stopped };
}

function sampleOf(sample: StraySample): ColorBlockSample {
  const reach = sample.reach;
  return { drawn: sample.total > 0 ? round(sample.drawn / sample.total) : 0, pixels: sample.drawn, total: sample.total,
    width: sample.width, height: sample.height, widen: sample.widen,
    reach: reach ? { minX: finiteOr(reach.minX, 1), maxX: finiteOr(reach.maxX, 1), minY: finiteOr(reach.minY, 1), maxY: finiteOr(reach.maxY, 1) } : null,
    strips: sample.strips.slice(0, 8).map(strip => ({ x: strip.x, y: strip.y, w: strip.w, h: strip.h, drawn: strip.drawn })) };
}

/**
 * Her own numbers right now, as far from normal as they go: the bone farthest from her root (model heights), the bone scale
 * farthest from 1, the morph weight farthest outside 0..1, and whether the CPU copy of her geometry is broken.
 */
export function inspectDetails(mesh: SkinnedMesh, height: number, geometryKnown?: boolean): ColorBlockInspect {
  mesh.getWorldPosition(origin);
  mesh.getWorldScale(scale);
  const worldScale = Math.abs(scale.y) > 0 ? Math.abs(scale.y) : 1, unit = Math.max(1, height) * worldScale;
  const bones = mesh.skeleton?.bones ?? [];
  let farthest: { index: number; value: number } | null = null, scaled: { index: number; value: number; scale: number } | null = null;
  bones.forEach((bone, index) => {
    const e = bone.matrixWorld.elements;
    const finite = e.every(Number.isFinite);
    const distance = finite ? Math.hypot(e[12] - origin.x, e[13] - origin.y, e[14] - origin.z) / unit : Infinity;
    if (!farthest || distance > farthest.value) farthest = { index, value: distance };
    for (const column of [0, 4, 8]) {
      const s = finite ? Math.hypot(e[column], e[column + 1], e[column + 2]) / worldScale : NaN;
      const off = Number.isFinite(s) && s > 0 ? Math.max(s, 1 / s) : Infinity;
      if (!scaled || off > scaled.value) scaled = { index, value: off, scale: s };
    }
  });
  const weights = mesh.morphTargetInfluences ?? [];
  let worst: { index: number; value: number; weight: number } | null = null;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    const off = !Number.isFinite(w) ? Infinity : w > 1 ? w : w < 0 ? 1 - w : w;
    if (!worst || off > worst.value) worst = { index: i, value: off, weight: w };
  }
  const morphName = (index: number) => Object.entries(mesh.morphTargetDictionary ?? {}).find(([, value]) => value === index)?.[0] ?? '';
  const far = farthest as { index: number; value: number } | null, sc = scaled as { index: number; value: number; scale: number } | null;
  let geometryBroken = geometryKnown ?? false;
  if (geometryKnown === undefined) try { geometryBroken = brokenGeometry(mesh, height); } catch { geometryBroken = false; }
  return {
    bones: bones.length, morphs: weights.length, modelHeight: finiteOr(height, 3),
    farthestBone: far ? { name: plainName(bones[far.index]?.name, `bone ${far.index}`), heights: Number.isFinite(far.value) ? round(far.value, 3) : null } : null,
    worstScale: sc ? { name: plainName(bones[sc.index]?.name, `bone ${sc.index}`), scale: Number.isFinite(sc.scale) ? round(sc.scale, 3) : null } : null,
    worstMorph: worst ? { name: plainName(morphName(worst.index), `morph ${worst.index}`), weight: Number.isFinite(worst.weight) ? round(worst.weight, 4) : null } : null,
    geometryBroken,
  };
}
