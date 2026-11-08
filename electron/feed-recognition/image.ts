import { FEED_IMAGE_EDGE, FEED_IMAGE_QUALITY, FEED_IPC_MAX_EDGE, sniffImageFormat } from '../../shared/feed-recognition';

/**
 * I-019: the host's step for the one picture the pet window handed over. Electron's nativeImage decodes PNG and JPEG only
 * (measured 2026-11-03 on this machine: GIF, WebP and BMP come back empty), so the pet window decodes the dropped file
 * itself (the first frame of a GIF), and the narrow IPC accepts nothing but PNG / JPEG bytes. Here they are decoded again,
 * shrunk to a longest edge of FEED_IMAGE_EDGE and re-encoded as a fresh JPEG (no metadata survives). In memory only: nothing
 * is written to disk, and the bytes are dropped once the small model has looked.
 */
export interface FeedImageDecoded {
  width: number;
  height: number;
  resize(size: { width: number; height: number }): FeedImageDecoded;
  jpeg(quality: number): Uint8Array;
}
/** electron/feed-recognition/electron-wiring.ts gives nativeImage; tests give a fake. */
export type FeedImageCodec = (bytes: Uint8Array) => FeedImageDecoded | null;

export interface FeedImage { dataUrl: string; width: number; height: number; bytes: number }

/** The size that keeps the aspect ratio with the longest edge at most `edge` (never enlarged, never below 1 px). */
export function feedImageSize(width: number, height: number, edge = FEED_IMAGE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** null: not a PNG/JPEG by its first bytes, undecodable, empty or larger than the IPC allows. */
export function shrinkFeedImage(bytes: Uint8Array, codec: FeedImageCodec): FeedImage | null {
  const format = sniffImageFormat(bytes);
  if (format !== 'png' && format !== 'jpeg') return null;
  let decoded: FeedImageDecoded | null;
  try { decoded = codec(bytes); } catch { return null; }
  if (!decoded || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)
    || decoded.width < 1 || decoded.height < 1 || decoded.width > FEED_IPC_MAX_EDGE || decoded.height > FEED_IPC_MAX_EDGE) return null;
  const size = feedImageSize(decoded.width, decoded.height);
  let jpeg: Uint8Array;
  try {
    const shrunk = size.width === decoded.width && size.height === decoded.height ? decoded : decoded.resize(size);
    jpeg = shrunk.jpeg(FEED_IMAGE_QUALITY);
    if (!(jpeg instanceof Uint8Array) || sniffImageFormat(jpeg) !== 'jpeg') return null;
  } catch { return null; }
  return { dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`, width: size.width, height: size.height, bytes: jpeg.byteLength };
}
