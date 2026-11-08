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
          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const context = canvas.getContext("2d");
          if (context) {
            context.imageSmoothingQuality = "high";
            context.drawImage(image, 0, 0, size.width, size.height);
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
