/**
 * 色块哨兵 (seen on her own model and on Gene).
 * A few vertices end up at the window's edges as huge flat triangles (hair grey, coat cream) while the rest of her stays put.
 * Physics, the blush/tears shaders and the model's own morphs are ruled out (docs/claude/2026-11-04-color-block.md), and an
 * isolated build did not show it in ~27,000 frames of pointer sweeps, hovering, stalls and shows, with every bone and morph weight sane.
 *
 * So the stage watches the picture itself. Every STRAY_INTERVAL_MS it reads back thin strips of the frame well outside where
 * her skinned bones say she can reach, without stalling the frame (a pixel-pack buffer behind a fence, as pixel-probe.ts).
 * Two hits in a row are a block: the stage looks at its own numbers (bones, morph weights), sends her geometry and bone
 * texture to the GPU again (and resets what it found bad), and the next sample says whether the block went away. Each block
 * is one report; one that stays is reported once and not re-sent for STRAY_RETRY_MS. Counts only, never pixels.
 * A block that stays while the stage's own numbers are fine is most likely part of the model itself (a wide skirt, long hair,
 * wings past the margins): her reach widens by STRAY_WIDEN_STEP each time. After STRAY_MAX_STAYED stays of any kind the watch
 * stops for this model, so nothing is re-sent or journaled over and over.
 */
import { Matrix4, Vector3, type Bone, type Camera, type DataTexture, type SkinnedMesh } from "three";

export interface StrayBox { minX: number; maxX: number; minY: number; maxY: number }
/** A strip of the drawing buffer, GL (bottom-left origin) device pixels; one row or one column. */
export interface StrayStrip { x: number; y: number; w: number; h: number }
export type StrayCause = { part: 'bone' | 'morph'; name: string } | { part: 'geometry'; name: 'geometry' } | { part: 'gpu'; name: 'gpu' };
export interface StrayReport {
  cause: StrayCause;
  /** Share of the sampled strip pixels that were drawn when the block was found (0–1). */
  drawn: number;
  /** The sample after the re-send was clean. */
  cleared: boolean;
}

export const STRAY_INTERVAL_MS = 400;
/** Alpha (0–255) above which a pixel counts as drawn; her soft edges and the blush stay inside the reach box anyway. */
export const STRAY_ALPHA = 16;
/** A hit needs this many drawn pixels and this share of the sampled ones. */
export const STRAY_MIN_PIXELS = 12;
export const STRAY_MIN_SHARE = 0.01;
export const STRAY_RETRY_MS = 10_000;
/** A strip is only taken where the gap between her reach and the window edge is at least this share of the window. */
export const STRAY_MIN_GAP = 0.06;
/** Reach beyond her skinned bones, as shares of the bones' larger side: hair above the head, sleeves and hair to the sides. */
export const STRAY_MARGIN = Object.freeze({ top: 0.35, side: 0.3, bottom: 0.2 });
/** A read the GPU never signals is dropped after this. */
export const STRAY_STALE_MS = 1000;
export const STRAY_WIDEN_STEP = 1.5;
export const STRAY_MAX_STAYED = 3;

/** Her reach in device pixels from projected bone positions (NDC x, y pairs); null when none is on a finite point. */
export function reachBox(ndc: ArrayLike<number>, width: number, height: number): StrayBox | null {
  if (!(width > 0 && height > 0)) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < ndc.length; i += 2) {
    const x = ndc[i], y = ndc[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const px = (x + 1) / 2 * width, py = (y + 1) / 2 * height;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  if (!(minX <= maxX && minY <= maxY)) return null;
  const size = Math.max(maxX - minX, maxY - minY, 1);
  return { minX: minX - size * STRAY_MARGIN.side, maxX: maxX + size * STRAY_MARGIN.side,
    minY: minY - size * STRAY_MARGIN.bottom, maxY: maxY + size * STRAY_MARGIN.top };
}

/**
 * Up to eight strips where the gap between her reach and a window edge is wide enough: one halfway across the gap and one
 * close to the edge itself (a block can sit only along the edge, Codex X-278 "贴边漏报").
 */
export function strayStrips(box: StrayBox, width: number, height: number): StrayStrip[] {
  if (!(width > 1 && height > 1)) return [];
  const strips: StrayStrip[] = [];
  const insetX = Math.max(1, Math.round(width * 0.02)), insetY = Math.max(1, Math.round(height * 0.02));
  const row = (y: number) => strips.push({ x: insetX, y: Math.round(y), w: Math.max(1, width - 2 * insetX), h: 1 });
  const column = (x: number) => strips.push({ x: Math.round(x), y: insetY, w: 1, h: Math.max(1, height - 2 * insetY) });
  // The edge strips sit on the outermost pixel line (Codex X-282: a block in the last 5 px was missed at a 2 % inset).
  if (height - box.maxY >= height * STRAY_MIN_GAP) { row(Math.min(height - 1, (Math.max(0, box.maxY) + height) / 2)); row(height - 1); }
  if (box.minY >= height * STRAY_MIN_GAP) { row(Math.max(0, Math.min(height, box.minY) / 2)); row(0); }
  if (box.minX >= width * STRAY_MIN_GAP) { column(Math.max(0, Math.min(width, box.minX) / 2)); column(0); }
  if (width - box.maxX >= width * STRAY_MIN_GAP) { column(Math.min(width - 1, (Math.max(0, box.maxX) + width) / 2)); column(width - 1); }
  return strips;
}

/** Drawn pixels among `length` RGBA pixels. */
export function drawnCount(rgba: Uint8Array, length: number, alpha = STRAY_ALPHA): number {
  let drawn = 0;
  for (let i = 0; i < length; i++) if (rgba[i * 4 + 3] > alpha) drawn++;
  return drawn;
}

export const isStrayHit = (drawn: number, total: number): boolean =>
  total > 0 && drawn >= STRAY_MIN_PIXELS && drawn / total >= STRAY_MIN_SHARE;

export type StrayGl = Pick<WebGL2RenderingContext,
  'RGBA' | 'UNSIGNED_BYTE' | 'PIXEL_PACK_BUFFER' | 'STREAM_READ' | 'SYNC_GPU_COMMANDS_COMPLETE' | 'SYNC_STATUS' | 'SIGNALED'
  | 'createBuffer' | 'deleteBuffer' | 'bindBuffer' | 'bufferData' | 'readPixels' | 'fenceSync' | 'getSyncParameter'
  | 'deleteSync' | 'getBufferSubData' | 'isContextLost'>;
export interface StrayCanvas { width: number; height: number; dataset?: Record<string, string | undefined> }

export interface StrayDeps {
  /** Where her skinned bones can reach right now (device pixels); null skips this sample. */
  reach(width: number, height: number): StrayBox | null;
  /** The stage's own numbers right now: the first bad bone or morph weight, else the GPU side. */
  inspect(): StrayCause;
  /** Send her to the GPU again and reset what `inspect` found bad. */
  recover(cause: StrayCause): void;
  report(report: StrayReport): void;
  now?(): number;
  /** I-031 色块诊断日志 (color-block-log.ts): told more about hits; whatever it does or throws, the watch behaves the same. */
  diagnostics?(): StrayDiagnostics | null | undefined;
}

/** A strip and how many of its pixels were drawn. */
export interface StrayStripHit extends StrayStrip { drawn: number }
/** One sample as the diagnostics see it: drawn of total, the strips that hit, her (widened) reach, the watch's counts. */
export interface StraySample {
  drawn: number; total: number; width: number; height: number; widen: number; reach: StrayBox | null;
  strips: StrayStripHit[]; stats: StrayPixelWatch['stats'];
}
export interface StrayDiagnostics {
  /** A single hit that did not repeat (told at the clean sample after it, with the hit's own sample). */
  near?(sample: StraySample): void;
  /** Two hits: a block. Told after `inspect` and before `recover`, inside the same task as the render (the canvas still shows it). */
  block?(sample: StraySample, cause: StrayCause): void;
  /** The sample after the re-send, right after `report`. */
  settled?(sample: StraySample, report: StrayReport): void;
}

interface Where { strips: StrayStrip[]; box: StrayBox | null; width: number; height: number }
interface Flight extends Where { total: number; sync: WebGLSync; startedAt: number }

export class StrayPixelWatch {
  private gl: StrayGl | null = null;
  private buffer: WebGLBuffer | null = null;
  private capacity = 0;
  private bytes = new Uint8Array(0);
  private flight: Flight | null = null;
  private nextAt = 0;
  private streak = 0;
  private holdUntil = 0;
  private pending: { cause: StrayCause; drawn: number } | null = null;
  /** Diagnostics (canvas dataset strayPixels): samples read, hits, blocks found, cleared, stayed; how far her reach is widened, stopped. */
  readonly stats = { samples: 0, hits: 0, blocks: 0, cleared: 0, stayed: 0, widen: 1, stopped: false };
  private quietStays = 0;

  constructor(private readonly deps: StrayDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : performance.now(); }

  /** Called by the stage right after it rendered a frame to the canvas, inside the same task. */
  afterRender(gl: StrayGl, canvas: StrayCanvas): void {
    const now = this.now();
    try {
      if (gl.isContextLost()) { this.drop(); this.gl = null; this.buffer = null; this.capacity = 0; return; }
      if (gl !== this.gl) { this.drop(); this.dropBuffer(); this.gl = gl; }
      this.finish(gl, now);
      if (!this.flight && now >= this.nextAt) { this.nextAt = now + STRAY_INTERVAL_MS; this.start(gl, canvas, now); }
    } catch {
      this.drop();
    } finally {
      if (canvas.dataset) canvas.dataset.strayPixels = JSON.stringify(this.stats);
    }
  }

  /** A sample's result (drawn of total); also the unit-test entry. `where` (the strips read) only feeds the diagnostics. */
  sample(drawn: number, total: number, where?: Where): void {
    const now = this.now(), hit = isStrayHit(drawn, total);
    this.stats.samples++;
    const diagnostics = this.diagnostics();
    if (this.pending) {
      const { cause, drawn: found } = this.pending;
      this.pending = null;
      this.streak = 0;
      if (hit) {
        this.stats.stayed++;
        this.holdUntil = now + STRAY_RETRY_MS;
        // Her own numbers were fine and a fresh copy shows the same: most likely the model really reaches there.
        if (cause.part === 'gpu') this.stats.widen = Math.round(this.stats.widen * STRAY_WIDEN_STEP * 1000) / 1000;
        // Whatever it was, a block that keeps staying is reported at most STRAY_MAX_STAYED times for this model (Codex X-282:
        // a broken CPU geometry was re-sent and journaled every ~10 s).
        if (++this.quietStays >= STRAY_MAX_STAYED) this.stats.stopped = true;
      } else this.stats.cleared++;
      const report = { cause, drawn: found, cleared: !hit };
      this.deps.report(report);
      if (diagnostics?.settled) this.tell(() => diagnostics.settled!(this.describe(drawn, total, where), report));
      return;
    }
    if (!hit) {
      const near = this.streak === 1 ? this.lastHit : null;
      this.streak = 0; this.lastHit = null;
      if (near && diagnostics?.near) this.tell(() => diagnostics.near!(near));
      return;
    }
    this.stats.hits++;
    if (++this.streak === 1 && diagnostics?.near) this.lastHit = this.tell(() => this.describe(drawn, total, where)) ?? null;
    if (this.streak < 2 || now < this.holdUntil) return;
    this.streak = 0; this.lastHit = null;
    this.stats.blocks++;
    const cause = this.deps.inspect();
    this.pending = { cause, drawn: drawn / total };
    if (diagnostics?.block) this.tell(() => diagnostics.block!(this.describe(drawn, total, where), cause));
    this.deps.recover(cause);
  }

  /** The model changed or went away: a half-found block belongs to the old one. */
  reset(): void {
    this.drop(); this.streak = 0; this.pending = null; this.holdUntil = 0; this.lastHit = null;
    this.quietStays = 0; this.stats.widen = 1; this.stats.stopped = false;
  }

  // I-031: the diagnostics only ever read; a throw there never changes what the watch does.
  private lastHit: StraySample | null = null;
  private diagnostics(): StrayDiagnostics | null {
    try { return this.deps.diagnostics?.() ?? null; } catch { return null; }
  }
  private tell<T>(run: () => T): T | undefined {
    try { return run(); } catch { return undefined; }
  }
  /** The sample with each strip's own drawn count (from the bytes of this very read). */
  private describe(drawn: number, total: number, where?: Where): StraySample {
    const strips: StrayStripHit[] = [];
    if (where) {
      let offset = 0;
      for (const strip of where.strips) {
        const length = strip.w * strip.h;
        strips.push({ ...strip, drawn: offset + length <= this.bytes.length / 4 ? drawnCount(this.bytes.subarray(offset * 4, (offset + length) * 4), length) : 0 });
        offset += length;
      }
    }
    return { drawn, total, width: where?.width ?? 0, height: where?.height ?? 0, widen: this.stats.widen, reach: where?.box ?? null,
      strips, stats: { ...this.stats } };
  }

  dispose(): void { this.reset(); this.dropBuffer(); this.gl = null; }

  private start(gl: StrayGl, canvas: StrayCanvas, now: number): void {
    if (this.stats.stopped) return;
    const width = canvas.width, height = canvas.height;
    const reach = this.deps.reach(width, height), widen = this.stats.widen;
    const box = reach && widen !== 1 ? { minX: (reach.minX + reach.maxX) / 2 - (reach.maxX - reach.minX) / 2 * widen,
      maxX: (reach.minX + reach.maxX) / 2 + (reach.maxX - reach.minX) / 2 * widen,
      minY: (reach.minY + reach.maxY) / 2 - (reach.maxY - reach.minY) / 2 * widen,
      maxY: (reach.minY + reach.maxY) / 2 + (reach.maxY - reach.minY) / 2 * widen } : reach;
    const strips = box ? strayStrips(box, width, height) : [];
    if (!strips.length) { this.streak = 0; return; }
    const total = strips.reduce((sum, strip) => sum + strip.w * strip.h, 0);
    if (!this.buffer || this.capacity < total * 4) {
      this.dropBuffer();
      this.buffer = gl.createBuffer();
      if (!this.buffer) return;
      this.capacity = total * 4;
      this.bytes = new Uint8Array(this.capacity);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.capacity, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    try {
      let offset = 0;
      for (const strip of strips) { gl.readPixels(strip.x, strip.y, strip.w, strip.h, gl.RGBA, gl.UNSIGNED_BYTE, offset); offset += strip.w * strip.h * 4; }
    } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) this.flight = { total, sync, startedAt: now, strips, box, width, height };
  }

  private finish(gl: StrayGl, now: number): void {
    const flight = this.flight;
    if (!flight) return;
    if (gl.getSyncParameter(flight.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
      if (now - flight.startedAt > STRAY_STALE_MS) this.drop();
      return;
    }
    this.flight = null;
    gl.deleteSync(flight.sync);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    try { gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.bytes, 0, flight.total * 4); }
    finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    this.sample(drawnCount(this.bytes, flight.total), flight.total, flight);
  }

  private drop(): void {
    const flight = this.flight;
    this.flight = null;
    if (flight) try { this.gl?.deleteSync(flight.sync); } catch { /* lost context */ }
  }

  private dropBuffer(): void {
    if (this.buffer && this.gl) try { this.gl.deleteBuffer(this.buffer); } catch { /* lost context */ }
    this.buffer = null;
    this.capacity = 0;
  }
}

// ---------------------------------------------------------------- the stage's side (three.js)

/** Bones farther than this many model heights from her root are not hers to reach with (a broken bone, an exploded helper). */
export const STRAY_BONE_REACH = 3;
/** inspect: a bone this far from her root, or scaled outside this range, is broken; so is a morph weight outside this range. */
export const STRAY_BONE_BROKEN = 4;
export const STRAY_SCALE_RANGE = Object.freeze([0.5, 2] as const);
export const STRAY_MORPH_RANGE = Object.freeze([-0.05, 1.6] as const);
/** inspect: a skinned bone counts as flown away past its own bind distance from her root plus this many model heights. */
export const STRAY_BONE_SLACK = 2;

/** Bones some vertex actually follows (IK targets and helpers left out), once per mesh. */
export function skinnedBones(mesh: SkinnedMesh): Bone[] {
  const index = mesh.geometry.getAttribute('skinIndex'), weight = mesh.geometry.getAttribute('skinWeight');
  if (!index || !weight) return [...mesh.skeleton.bones];
  const used = new Set<number>(), size = Math.min(index.itemSize, weight.itemSize);
  for (let i = 0; i < index.count; i++) for (let k = 0; k < size; k++) if (weight.getComponent(i, k) > 0) used.add(index.getComponent(i, k));
  return [...used].sort((a, b) => a - b).map(i => mesh.skeleton.bones[i]).filter((bone): bone is Bone => !!bone);
}

const point = new Vector3(), origin = new Vector3(), scale = new Vector3();
/** World size of one model unit and her root, for the distance checks. */
function frameOf(mesh: SkinnedMesh, height: number): { limit: (heights: number) => number; worldScale: number } {
  mesh.getWorldPosition(origin);
  mesh.getWorldScale(scale);
  const worldScale = Math.abs(scale.y) > 0 ? Math.abs(scale.y) : 1;
  return { limit: heights => heights * Math.max(1, height) * worldScale, worldScale };
}

/** Her reach on screen: the projected positions of her skinned bones that are still near her (device pixels). */
export function boneReach(mesh: SkinnedMesh, bones: readonly Bone[], camera: Camera, height: number, width: number, viewHeight: number,
  ndc: { value: Float32Array }): StrayBox | null {
  if (!bones.length) return null;
  if (ndc.value.length !== bones.length * 2) ndc.value = new Float32Array(bones.length * 2);
  const { limit } = frameOf(mesh, height), far = limit(STRAY_BONE_REACH);
  bones.forEach((bone, i) => {
    bone.getWorldPosition(point);
    const near = Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z) && point.distanceTo(origin) <= far;
    if (near) point.project(camera);
    ndc.value[i * 2] = near && point.z >= -1 && point.z <= 1 ? point.x : NaN;
    ndc.value[i * 2 + 1] = near && point.z >= -1 && point.z <= 1 ? point.y : NaN;
  });
  return reachBox(ndc.value, width, viewHeight);
}

const partName = (name: string, fallback: string) => (name.normalize('NFKC').replace(/[\u0000-\u001f\u007f\/:*?"<>|]/g, '').slice(0, 40)) || fallback;

const bindDistances = new WeakMap<SkinnedMesh, Float32Array>();
/** Each bone's distance from her root in the bind pose (model units), once per mesh. */
function bindDistance(mesh: SkinnedMesh): Float32Array {
  let distances = bindDistances.get(mesh);
  if (!distances) {
    const inverse = new Matrix4();
    distances = new Float32Array(mesh.skeleton.bones.length);
    mesh.skeleton.boneInverses.forEach((boneInverse, i) => {
      const e = inverse.copy(boneInverse).invert().elements;
      distances![i] = Number.isFinite(e[12] + e[13] + e[14]) ? Math.hypot(e[12], e[13], e[14]) : 0;
    });
    bindDistances.set(mesh, distances);
  }
  return distances;
}

/**
 * The stage's own numbers right now: the first broken bone (not finite, far away, scaled), then morph weight, then the CPU copy
 * of her geometry (a rest position or morph offset not finite or far outside her: re-sending cannot help, the copy itself is
 * bad, Codex X-278); only when all of these are fine is it the GPU side.
 * Only bones some vertex follows are judged, each against its own bind distance from her root plus STRAY_BONE_SLACK model
 * heights (I-031's real-window check: a Gene cloak helper bone sits 4.088 heights out at rest and was blamed for every block,
 * which also snapped her skeleton to the bind pose).
 */
export function inspectModel(mesh: SkinnedMesh, height: number, bones: readonly Bone[] = skinnedBones(mesh)): StrayCause {
  const { worldScale } = frameOf(mesh, height), distances = bindDistance(mesh), slack = STRAY_BONE_SLACK * Math.max(1, height);
  for (const bone of bones) {
    const e = bone.matrixWorld.elements, index = mesh.skeleton.bones.indexOf(bone);
    let broken = !e.every(Number.isFinite);
    if (!broken) {
      point.set(e[12], e[13], e[14]);
      mesh.worldToLocal(point);
      broken = !(point.length() <= (distances[index] ?? 0) + slack);
    }
    if (!broken) for (const column of [0, 4, 8]) {
      const s = Math.hypot(e[column], e[column + 1], e[column + 2]) / worldScale;
      if (!(s >= STRAY_SCALE_RANGE[0] && s <= STRAY_SCALE_RANGE[1])) { broken = true; break; }
    }
    if (broken) return { part: 'bone', name: partName(bone.name, `bone ${index}`) };
  }
  const weights = mesh.morphTargetInfluences ?? [];
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (Number.isFinite(w) && w >= STRAY_MORPH_RANGE[0] && w <= STRAY_MORPH_RANGE[1]) continue;
    const name = Object.entries(mesh.morphTargetDictionary ?? {}).find(([, index]) => index === i)?.[0] ?? '';
    return { part: 'morph', name: partName(name, `morph ${i}`) };
  }
  if (brokenGeometry(mesh, height)) return { part: 'geometry', name: 'geometry' };
  return { part: 'gpu', name: 'gpu' };
}

/** A rest position or morph offset that is not finite or lies farther than STRAY_BONE_BROKEN model heights out (model units). */
export function brokenGeometry(mesh: SkinnedMesh, height: number): boolean {
  const far = STRAY_BONE_BROKEN * Math.max(1, height);
  const attributes = [mesh.geometry.getAttribute('position'), ...(mesh.geometry.morphAttributes.position ?? [])];
  for (const attribute of attributes) {
    const values = (attribute as { array?: ArrayLike<number> } | undefined)?.array;
    if (!values) continue;
    for (let i = 0; i < values.length; i++) { const v = values[i]; if (!(v > -far && v < far)) return true; }
  }
  return false;
}

/**
 * Sends her to the GPU again: the geometry's buffers and morph texture and the bone texture are rebuilt from the CPU copies on
 * the next render (three's dispose listeners). A broken morph weight goes back to 0; a broken bone puts the skeleton back in its
 * bind pose (this frame's writers set their bones again on the next one).
 */
export function resendModel(mesh: SkinnedMesh, cause: StrayCause): void {
  if (cause.part === 'geometry') return; // the CPU copy itself is bad: re-sending would copy it again (Codex X-282)
  if (cause.part === 'morph') {
    const weights = mesh.morphTargetInfluences ?? [];
    for (let i = 0; i < weights.length; i++) if (!(Number.isFinite(weights[i]) && weights[i] >= STRAY_MORPH_RANGE[0] && weights[i] <= STRAY_MORPH_RANGE[1])) weights[i] = 0;
  }
  if (cause.part === 'bone') { mesh.skeleton.pose(); mesh.updateMatrixWorld(true); }
  mesh.geometry.dispose();
  const skeleton = mesh.skeleton as SkinnedMesh['skeleton'] & { boneTexture: DataTexture | null };
  skeleton.boneTexture?.dispose();
  skeleton.boneTexture = null;
}
