import { GLANCE_INTERVAL_MS, GLANCE_JPEG_QUALITY, glanceSize } from '../../shared/camera-glance';

/**
 * I-036 「发图片」, the camera owner window's half: while the switch is on and the user has not said
 * "别看", keep one small frame ready at the host. It draws one right away and then every GLANCE_INTERVAL_MS from the stream that
 * is already open, about 320×240 JPEG, and hands it over (electron/runtime.ts publishCamera keeps only the latest, in memory).
 * A message then carries that frame without waiting for the camera. Nothing is kept here: the canvas is cleared after each draw.
 */
export interface GlanceSamplerPorts {
  /** The open camera video (null: not ready). */
  video(): HTMLVideoElement | null;
  publish(dataUrl: string): Promise<void>;
  canvas?(): HTMLCanvasElement;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** One small JPEG of the video's current picture, or null (no picture yet). */
export function drawGlance(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  const size = glanceSize(video.videoWidth, video.videoHeight);
  if (!size.width || !size.height) return null;
  canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, size.width, size.height);
    return canvas.toDataURL('image/jpeg', GLANCE_JPEG_QUALITY);
  } finally { canvas.width = canvas.height = 1; }
}

export class GlanceSampler {
  private timer: unknown = null;
  private running = false;
  private busy = false;
  private canvas: HTMLCanvasElement | null = null;
  constructor(private readonly ports: GlanceSamplerPorts) {}

  get active(): boolean { return this.running; }

  /** On: draw now and keep drawing; off: stop at once (a draw in flight is not handed over). */
  sync(on: boolean): void {
    if (on === this.running) return;
    this.running = on;
    if (on) this.tick();
    else this.clear();
  }

  private tick(): void {
    if (!this.running) return;
    void this.sample();
    this.timer = (this.ports.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => this.tick(), GLANCE_INTERVAL_MS);
  }

  private async sample(): Promise<void> {
    const video = this.ports.video();
    if (!video || this.busy) return;
    this.busy = true;
    try {
      const canvas = this.canvas ??= this.ports.canvas?.() ?? document.createElement('canvas');
      const dataUrl = drawGlance(video, canvas);
      if (dataUrl && this.running) await this.ports.publish(dataUrl);
    } catch { /* the host refused it (switch changed, "别看"): the next tick tries again only while still on */ }
    finally { this.busy = false; }
  }

  private clear(): void {
    if (this.timer !== null) (this.ports.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}
