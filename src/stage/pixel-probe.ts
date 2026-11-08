/**
 * Click-through hit test, model half: "is she drawn under this pointer?".
 *
 * One small block of the frame she was just rendered into is read back without
 * stalling the frame: right after render the block is copied into a pixel-pack
 * buffer behind a fence (WebGL2), and the bytes are picked up on a later frame
 * once the GPU has signalled. Nothing is read unless a request is waiting, so a
 * pet that is not in click-through mode (or a pointer that is elsewhere) costs
 * nothing. See src/ui/pointer-passthrough.ts for who asks and how often.
 */
export interface StageAlpha {
  /** Highest alpha (0–255) within PROBE_INNER_RADIUS device px of the pointer. */
  inner: number;
  /** Highest alpha within PROBE_OUTER_RADIUS: a slightly wider hold, so her edge does not flicker. */
  outer: number;
}
export const PROBE_INNER_RADIUS = 1;
export const PROBE_OUTER_RADIUS = 4;
const SIDE = PROBE_OUTER_RADIUS * 2 + 1;
const BLOCK_BYTES = SIDE * SIDE * 4;
/** A read the GPU never signals (lost context, driver trouble) is dropped after this. */
export const PROBE_STALE_MS = 1000;

export type ProbeGl = Pick<WebGL2RenderingContext,
  'RGBA' | 'UNSIGNED_BYTE' | 'PIXEL_PACK_BUFFER' | 'STREAM_READ' | 'SYNC_GPU_COMMANDS_COMPLETE' | 'SYNC_STATUS' | 'SIGNALED'
  | 'createBuffer' | 'deleteBuffer' | 'bindBuffer' | 'bufferData' | 'readPixels' | 'fenceSync' | 'getSyncParameter'
  | 'deleteSync' | 'getBufferSubData' | 'isContextLost'>;
export interface ProbeCanvas {
  width: number;
  height: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  dataset?: Record<string, string | undefined>;
}
/** The device-pixel block around the pointer, in GL (bottom-left origin) coordinates. */
export interface ProbeBlock { x0: number; y0: number; w: number; h: number; px: number; py: number }

/** Maps a client-space point onto the canvas's drawing buffer; null when the point is not on it. */
export function probeBlock(canvas: ProbeCanvas, clientX: number, clientY: number): ProbeBlock | null {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0 && canvas.width > 0 && canvas.height > 0)) return null;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const px = Math.floor((clientX - rect.left) * canvas.width / rect.width);
  const top = Math.floor((clientY - rect.top) * canvas.height / rect.height);
  if (px < 0 || top < 0 || px >= canvas.width || top >= canvas.height) return null;
  const py = canvas.height - 1 - top;
  const x0 = Math.max(0, px - PROBE_OUTER_RADIUS), y0 = Math.max(0, py - PROBE_OUTER_RADIUS);
  const x1 = Math.min(canvas.width - 1, px + PROBE_OUTER_RADIUS), y1 = Math.min(canvas.height - 1, py + PROBE_OUTER_RADIUS);
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px, py };
}

/** Highest alpha near the centre and in the whole block, from RGBA rows read bottom-up. */
export function blockAlpha(block: ProbeBlock, rgba: Uint8Array): StageAlpha {
  let inner = 0, outer = 0;
  for (let row = 0; row < block.h; row++) {
    const dy = Math.abs(block.y0 + row - block.py);
    for (let column = 0; column < block.w; column++) {
      const alpha = rgba[(row * block.w + column) * 4 + 3];
      if (alpha > outer) outer = alpha;
      if (alpha > inner && dy <= PROBE_INNER_RADIUS && Math.abs(block.x0 + column - block.px) <= PROBE_INNER_RADIUS) inner = alpha;
    }
  }
  return { inner, outer };
}

type Resolve = (value: StageAlpha | null) => void;
interface Flight { block: ProbeBlock; resolve: Resolve; sync: WebGLSync; startedAt: number }

export class StagePixelProbe {
  private queued: { x: number; y: number; resolve: Resolve } | null = null;
  private flight: Flight | null = null;
  private gl: ProbeGl | null = null;
  private buffer: WebGLBuffer | null = null;
  private readonly bytes = new Uint8Array(BLOCK_BYTES);
  /** Diagnostics: reads started, finished, dropped, and the longest afterRender call (ms). */
  readonly stats = { started: 0, finished: 0, dropped: 0, maxCallMs: 0, totalCallMs: 0 };
  constructor(private readonly clock: () => number = () => performance.now()) {}

  /**
   * Alpha under a client-space point on the next rendered frame(s); null if it could not be read. Only the newest request
   * is kept. `signal`: the asker no longer wants it (the pointer left): a request not yet submitted is withdrawn with
   * null and no read happens (Codex T-112 round 031); one already submitted finishes as usual and is ignored by the asker.
   */
  request(clientX: number, clientY: number, signal?: AbortSignal): Promise<StageAlpha | null> {
    this.queued?.resolve(null);
    this.queued = null;
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const queued = { x: clientX, y: clientY, resolve };
      this.queued = queued;
      signal?.addEventListener('abort', () => { if (this.queued === queued) { this.queued = null; resolve(null); } }, { once: true });
    });
  }

  get idle(): boolean { return !this.queued && !this.flight; }

  /** Called by the stage right after it rendered a frame to the canvas, inside the same task. */
  afterRender(gl: ProbeGl, canvas: ProbeCanvas): void {
    if (!this.queued && !this.flight) return;
    const started = this.clock();
    try {
      if (gl.isContextLost()) { this.cancel(); this.gl = null; this.buffer = null; return; }
      if (gl !== this.gl) { this.dropFlight(); this.dropBuffer(); this.gl = gl; }
      this.finish(gl, started);
      if (this.queued && !this.flight) this.start(gl, canvas, started);
    } catch {
      this.cancel();
    } finally {
      const spent = this.clock() - started;
      if (spent > this.stats.maxCallMs) this.stats.maxCallMs = spent;
      this.stats.totalCallMs += spent;
      // Smoke/diagnostic readout beside the stage's other canvas datasets; counts only, never pixels.
      if (canvas.dataset) canvas.dataset.pixelProbe = JSON.stringify(this.stats);
    }
  }

  /** Resolves everything waiting with null (not rendering, lost context, disposal). */
  cancel(): void {
    const queued = this.queued;
    this.queued = null;
    queued?.resolve(null);
    this.dropFlight();
  }

  private dropFlight(): void {
    const flight = this.flight;
    if (!flight) return;
    this.flight = null;
    this.stats.dropped++;
    try { this.gl?.deleteSync(flight.sync); } catch { /* lost context */ }
    flight.resolve(null);
  }

  dispose(): void { this.cancel(); this.dropBuffer(); this.gl = null; }

  private dropBuffer(): void {
    if (this.buffer && this.gl) try { this.gl.deleteBuffer(this.buffer); } catch { /* lost context */ }
    this.buffer = null;
  }

  private finish(gl: ProbeGl, now: number): void {
    const flight = this.flight;
    if (!flight) return;
    if (gl.getSyncParameter(flight.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
      if (now - flight.startedAt > PROBE_STALE_MS) { this.flight = null; this.stats.dropped++; gl.deleteSync(flight.sync); flight.resolve(null); }
      return;
    }
    this.flight = null;
    gl.deleteSync(flight.sync);
    const length = flight.block.w * flight.block.h * 4;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    try { gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.bytes, 0, length); }
    finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    this.stats.finished++;
    flight.resolve(blockAlpha(flight.block, this.bytes));
  }

  private start(gl: ProbeGl, canvas: ProbeCanvas, now: number): void {
    const queued = this.queued!;
    this.queued = null;
    const block = probeBlock(canvas, queued.x, queued.y);
    if (!block) { queued.resolve({ inner: 0, outer: 0 }); return; }
    if (!this.buffer) {
      this.buffer = gl.createBuffer();
      if (!this.buffer) { queued.resolve(null); return; }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, BLOCK_BYTES, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    try { gl.readPixels(block.x0, block.y0, block.w, block.h, gl.RGBA, gl.UNSIGNED_BYTE, 0); }
    finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) { queued.resolve(null); return; }
    this.stats.started++;
    this.flight = { block, resolve: queued.resolve, sync, startedAt: now };
  }
}
