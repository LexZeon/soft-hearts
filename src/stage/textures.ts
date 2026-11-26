import { Cache, Texture, TextureLoader } from "three";

export const MAX_TEXTURE_SIZE = 1024;

/** Bound GPU/decoded texture cost while preserving aspect ratio and small toon maps. */
export function fitTextureSize(
  width: number,
  height: number,
  limit = MAX_TEXTURE_SIZE,
): { width: number; height: number } {
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The resized copy of a texture image, or null. Its 2D canvas is kept in ordinary memory (`willReadFrequently`): Chromium may otherwise
 * put a 2D canvas on the graphics card, and a graphics driver reset (GPU process crash) then wipes it, so when the WebGL context came
 * back her textures were uploaded again from blank canvases and she was drawn fully transparent (measured 2026-11-22 in the full-screen
 * Unbound page: 17 092 covered pixels before a GPU crash, 0 after; with the textures taken off, 17 054; docs/claude/2026-11-22-gpu-reset.md).
 */
export function resizedTextureCanvas(image: CanvasImageSource, size: { width: number; height: number },
  doc: Pick<Document, "createElement"> = document): HTMLCanvasElement | null {
  const canvas = doc.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, size.width, size.height);
  return canvas;
}

/** Resize within the image completion callback, before the renderer can upload the source. */
export class CappedTextureLoader extends TextureLoader {
  override load(
    url: string,
    onLoad?: (texture: Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): Texture {
    return super.load(
      url,
      (texture) => {
        const image = texture.image as HTMLImageElement;
        const size = fitTextureSize(image.width, image.height);
        if (size.width !== image.width || size.height !== image.height) {
          const canvas = resizedTextureCanvas(image, size);
          if (canvas) {
            texture.image = canvas;
            texture.needsUpdate = true;
            // Cache is off by default; preserve images if a host opts into shared caching.
            if (!Cache.enabled) image.removeAttribute("src");
          }
        }
        onLoad?.(texture);
      },
      onProgress,
      onError,
    );
  }
}
