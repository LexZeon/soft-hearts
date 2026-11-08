/**
 * I-019, pet window: the one picture of the bite just accepted at her mouth goes to the host, and nothing else. Only while
 * the switch "喂食时让她认出是什么" is on (default on; off: she eats exactly as before and the picture never leaves this
 * window). The file is read here, its format checked by its first bytes (not its name or type), decoded by the browser (a
 * GIF gives its first frame), drawn on a white canvas no larger than FEED_PRESHRINK_EDGE and re-encoded as one JPEG: that,
 * and the bite's interaction session, are all the host gets. No name, no path, nothing written anywhere. Any failure is
 * silent: she has eaten, and the B06 "嗯" played as always.
 */
import { FEED_PRESHRINK_EDGE, FEED_SOURCE_MAX_BYTES, FEED_SOURCE_MAX_PIXELS, imageHeaderSize, sniffImageFormat, type FeedRecognitionView, type FeedSnackInput } from '../../shared/feed-recognition';

export interface FeedSnackApi {
  feedSnack?(input: FeedSnackInput): Promise<boolean>;
  getFeedRecognition?(): Promise<FeedRecognitionView>;
  onFeedRecognition?(callback: (view: FeedRecognitionView) => void): () => void;
}

/** The browser's decode and canvas, injectable for tests. */
export interface SnackImageDecoder {
  /** `size`: decode straight at this size (a large picture, its header gave the size), so the full picture never sits in memory. */
  decode(blob: Blob, size?: { width: number; height: number }): Promise<{ width: number; height: number; draw(target: SnackCanvasContext, width: number, height: number): void; close(): void }>;
  canvas(width: number, height: number): { context: SnackCanvasContext; jpeg(quality: number): Promise<Blob> };
}
export interface SnackCanvasContext { fillStyle: string | CanvasGradient | CanvasPattern; fillRect(x: number, y: number, w: number, h: number): void }

/** The longest edge at most `edge`, the aspect ratio kept, never enlarged. */
export function preshrinkSize(width: number, height: number, edge = FEED_PRESHRINK_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > edge)) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function browserSnackDecoder(): SnackImageDecoder {
  return {
    async decode(blob, size) {
      const bitmap = size ? await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }) : await createImageBitmap(blob);
      return { width: bitmap.width, height: bitmap.height, close: () => bitmap.close(),
        draw: (target, width, height) => (target as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, width, height) };
    },
    canvas(width, height) {
      if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
        if (!context) throw new Error('no canvas');
        return { context: context as unknown as SnackCanvasContext, jpeg: quality => canvas.convertToBlob({ type: 'image/jpeg', quality }) };
      }
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no canvas');
      return { context, jpeg: quality => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('no jpeg')), 'image/jpeg', quality)) };
    },
  };
}

/** The dropped file as one pre-shrunk JPEG, or null (not a supported picture by its bytes, too large, undecodable). */
export async function prepareSnackImage(file: Blob, decoder: SnackImageDecoder = browserSnackDecoder()): Promise<Uint8Array | null> {
  if (!file || !(file.size > 0) || file.size > FEED_SOURCE_MAX_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffImageFormat(bytes);
  if (!format) return null;
  const header = imageHeaderSize(bytes, format);
  if (header && header.width * header.height > FEED_SOURCE_MAX_PIXELS) return null;
  const shrunk = header ? preshrinkSize(header.width, header.height) : null;
  const hint = header && shrunk && Math.max(header.width, header.height) > FEED_PRESHRINK_EDGE ? shrunk : undefined;
  const image = await decoder.decode(new Blob([bytes], { type: `image/${format}` }), hint);
  try {
    if (!(image.width > 0) || !(image.height > 0)) return null;
    const size = preshrinkSize(image.width, image.height);
    const canvas = decoder.canvas(size.width, size.height);
    // A transparent PNG or GIF would turn black in a JPEG: she gets it on a white plate.
    canvas.context.fillStyle = '#ffffff';
    canvas.context.fillRect(0, 0, size.width, size.height);
    image.draw(canvas.context, size.width, size.height);
    const jpeg = new Uint8Array(await (await canvas.jpeg(0.9)).arrayBuffer());
    return sniffImageFormat(jpeg) === 'jpeg' ? jpeg : null;
  } finally { try { image.close(); } catch { /* Already released. */ } }
}

export class FeedSnackClient {
  /** Off until the host says (a switch turned off is never bypassed at startup); the host's default is on. */
  private enabled = false;
  private readonly unsubscribe: (() => void) | null;
  private disposed = false;
  constructor(private readonly api: FeedSnackApi, private readonly decoder: SnackImageDecoder = browserSnackDecoder()) {
    let off: (() => void) | null = null;
    try { off = api.onFeedRecognition?.(view => this.apply(view)) ?? null; } catch { off = null; }
    this.unsubscribe = off;
    void Promise.resolve().then(() => api.getFeedRecognition?.()).then(view => { if (view) this.apply(view); }, () => {});
  }

  get on(): boolean { return this.enabled; }

  /** After the bite was accepted (PetInteraction `onSnack`): hands the picture over, or does nothing. Never throws. */
  async send(file: Blob, sessionId: string): Promise<boolean> {
    if (this.disposed || !this.enabled || typeof this.api.feedSnack !== 'function') return false;
    try {
      const image = await prepareSnackImage(file, this.decoder);
      if (!image || this.disposed || !this.enabled) return false;
      return await this.api.feedSnack({ sessionId, image }) === true;
    } catch { return false; }
  }

  dispose(): void { this.disposed = true; try { this.unsubscribe?.(); } catch { /* Already gone. */ } }

  private apply(view: FeedRecognitionView): void { if (view && typeof view.enabled === 'boolean') this.enabled = view.enabled; }
}
